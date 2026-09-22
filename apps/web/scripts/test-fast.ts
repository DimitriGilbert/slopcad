/**
 * The fast full-suite path (`pnpm test:fast` at the root): ONE production
 * build, ONE server on ONE port, every Playwright harness pointed at it
 * and run CONCURRENTLY — instead of eleven sequential harnesses each
 * rebuilding `.output` and booting its own server (~30 min → minutes).
 *
 * Shape:
 *
 *   1. port check + committed migrations (the projects harness's needs)
 *   2. ONE `turbo run build --filter=web` (turbo-cached: a warm cache
 *      replays `.output` in ms; no homegrown rebuild logic)
 *   3. boot `.output/server/index.mjs` on the booked shared port with
 *      BETTER_AUTH_URL matching (the projects harness's wiring)
 *   4. run all eleven `playwright.<name>.config.ts` harnesses at once,
 *      each with SLOPCAD_E2E_SHARED_URL set — the configs skip their own
 *      webServer entirely on that flag (no per-config rebuilds mid-run)
 *   5. browsers first, units after: the root `pnpm test` unit suites
 *      (turbo-cached) launch only once the last browser harness exits,
 *      off the SwiftShader/video core fight
 *
 * Every harness keeps its own test-results/, playwright-report/, trace and
 * video artifact dirs — nothing about the individual `pnpm test:<name>`
 * commands changes; this orchestrator only removes the eleven redundant
 * builds and boots. Server port booked in the port-book ledger
 * (`slopcad e2e-shared`), never 3001.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { createServer } from "node:net";

const webDir = fileURLToPath(new URL("..", import.meta.url));
const rootDir = fileURLToPath(new URL("../../..", import.meta.url));

const PORT = Number(process.env.SHARED_E2E_PORT ?? 8008);
const SHARED_URL = `http://localhost:${PORT}`;

const HARNESS: ReadonlyArray<{
  readonly name: string;
  readonly config: string;
}> = [
  { name: "smoke", config: "playwright.config.ts" },
  { name: "spike", config: "playwright.spike.config.ts" },
  { name: "worker", config: "playwright.worker.config.ts" },
  { name: "render", config: "playwright.render.config.ts" },
  { name: "workbench", config: "playwright.workbench.config.ts" },
  { name: "a11y", config: "playwright.a11y.config.ts" },
  { name: "components", config: "playwright.components.config.ts" },
  { name: "projects", config: "playwright.projects.config.ts" },
  { name: "matrix", config: "playwright.matrix.config.ts" },
  { name: "docs", config: "playwright.docs.config.ts" },
];

/**
 * The perf harness runs FIRST and ALONE: its budgets (`e2e-perf/budgets.json`,
 * untouchable) gate real latencies, and under the ten concurrent SwiftShader
 * harnesses every budget blows 2-3x from pure CPU contention (measured:
 * wasmBoot 87 ms vs 40 ms budget, firstSettle 708 ms vs 450 ms). A quiet
 * machine is a precondition of the measurement, not an optimization.
 */
const PERF = { name: "perf", config: "playwright.perf.config.ts" } as const;

interface ChildResult {
  readonly name: string;
  readonly code: number | null;
  readonly seconds: number;
  readonly output: string;
}

const liveChildren = new Set<ChildProcess>();

/** True when something already listens on the shared port. */
function portBusy(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once("error", () => resolve(true));
    probe.once("listening", () => probe.close(() => resolve(false)));
    probe.listen(port, "localhost");
  });
}

async function urlUp(url: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.status < 500) return true;
    } catch {
      // not up yet
    }
    await delay(250);
  }
  return false;
}

/** Runs one child to completion, echoing its tail (full text on failure). */
function run(
  name: string,
  command: string,
  args: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ChildResult> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    const note = (chunk: Buffer): void => {
      output += chunk.toString();
    };
    child.stdout.on("data", note);
    child.stderr.on("data", note);
    child.once("error", reject);
    child.once("close", (code) => {
      liveChildren.delete(child);
      const seconds = (Date.now() - started) / 1000;
      const lines = output.trimEnd().split("\n");
      const tail = code === 0 ? lines.slice(-15) : lines;
      if (tail.length > 0) {
        console.log(`--- [${name}] ${code === 0 ? "tail" : "full output"} ---`);
        for (const line of tail) console.log(`[${name}] ${line}`);
      }
      console.log(`[${name}] exited ${String(code)} after ${String(seconds)}s`);
      resolve({ name, code, seconds, output });
    });
    liveChildren.add(child);
  });
}

async function main(): Promise<void> {
  const started = Date.now();
  if (await portBusy(PORT)) {
    throw new Error(
      `Port ${String(PORT)} is already listening — stop whatever owns it (or set SHARED_E2E_PORT) before pnpm test:fast.`,
    );
  }

  // Committed migrations first (the projects harness's persistence wiring),
  // then the ONE build — through turbo, so a warm cache replays `.output`
  // instead of re-running vite (turbo.json's build outputs include
  // `.output/**`; no homegrown rebuild logic bypassing the cache).
  const migrations = await run(
    "db:migrate",
    "pnpm",
    ["--filter", "@slopcad/db", "db:migrate"],
    webDir,
  );
  if (migrations.code !== 0) throw new Error("db:migrate failed");

  const build = run(
    "build",
    "pnpm",
    ["exec", "turbo", "run", "build", "--filter=web"],
    rootDir,
  );

  const server = spawn(
    "node",
    ["--env-file-if-exists=.env", ".output/server/index.mjs"],
    {
      cwd: webDir,
      env: { ...process.env, PORT: String(PORT), BETTER_AUTH_URL: SHARED_URL },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let serverLog = "";
  server.stdout.on("data", (chunk: Buffer) => {
    serverLog += chunk.toString();
  });
  server.stderr.on("data", (chunk: Buffer) => {
    serverLog += chunk.toString();
  });
  liveChildren.add(server);

  const built = await build;
  if (built.code !== 0) throw new Error("build failed");
  if (!(await urlUp(SHARED_URL, 120_000))) {
    throw new Error(`server did not come up on ${SHARED_URL}\n${serverLog}`);
  }
  console.log(
    `[server] up on ${SHARED_URL}; perf first (alone), then ${String(HARNESS.length)} harnesses concurrently`,
  );

  // Perf exclusively: it measures real latencies against budgets that only
  // hold on a quiet machine (see PERF above).
  const perfResult = await run(
    PERF.name,
    "pnpm",
    ["exec", "playwright", "test", "-c", PERF.config],
    webDir,
    { ...process.env, SLOPCAD_E2E_SHARED_URL: SHARED_URL },
  );

  // Browsers first, units after: the ten SwiftShader+video harnesses own
  // the machine's cores while they run, so the unit suites (node-only,
  // ~35 s cold, turbo-cached warm) launch only once the last browser
  // harness has exited — off the core fight, not inside it.
  const harnesses = await Promise.all(
    HARNESS.map(({ name, config }) =>
      run(name, "pnpm", ["exec", "playwright", "test", "-c", config], webDir, {
        ...process.env,
        SLOPCAD_E2E_SHARED_URL: SHARED_URL,
      }),
    ),
  );

  const units = await run("units", "pnpm", ["test"], rootDir);

  server.kill("SIGTERM");

  console.log("\n=== test:fast summary ===");
  const results = [perfResult, ...harnesses, units];

  console.log("\n=== test:fast summary ===");
  for (const result of results) {
    console.log(
      `${result.code === 0 ? "PASS" : "FAIL"}  ${result.name.padEnd(12)} ${String(result.seconds)}s`,
    );
  }
  console.log(`total wall clock: ${String((Date.now() - started) / 1000)}s`);
  if (results.some((result) => result.code !== 0)) {
    process.exitCode = 1;
  }
}

main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(() => {
    for (const child of liveChildren) {
      if (child.exitCode === null) child.kill("SIGKILL");
    }
  });
