/**
 * The session harness's webServer supervisor (PLAN-AGENT-CHAT Phase 6,
 * B1): boots the loopback agent-fixture server and the REAL production
 * server as one supervised tree so Playwright's single `webServer`
 * command yields both, with deterministic teardown for both.
 *
 * The supervisor (this file) owns the agent env wiring the walk depends
 * on — everything the REAL production code reads, pointed at the loopback
 * fixture, never at the outside network:
 *
 * - `MODEL_CATALOG_URL` → the fixture's trimmed models.dev JSON, so the
 *   catalog refresh exercises the real fetch/filter/insert path;
 * - `OPENAI_COMPATIBLE_BASE_URL` + `OPENAI_COMPATIBLE_KEY` → the fixture's
 *   scripted OpenAI-compatible endpoint, so the server relay (D2) calls
 *   the loopback with the ENV key — the walk proves the browser-stored
 *   user key never crosses;
 * - `AGENT_SERVER_AI_ALLOW_ALL=1` (D13) — the harness posture covering the
 *   runtime-created session user (no per-user row seeding, B1).
 *
 * Signal semantics: SIGTERM/SIGINT tear the production child down first
 * (graceful), then close the fixture server, then exit. The production
 * server exiting on its own ends the supervisor with its exit code.
 *
 * Run (from apps/web, the playwright webServer cwd):
 * `node --env-file-if-exists=.env --import tsx e2e-session/scripts/session-webserver.ts`
 * — the env file supplies DATABASE_URL & friends exactly as the unsupervised
 * chain did; PORT and BETTER_AUTH_URL arrive from the harness config.
 */

import { spawn } from "node:child_process";

import { startAgentLoopbackServer } from "./agent-loopback-server.ts";

/** The fixture server's loopback port (the spec's default must agree). */
const FIXTURE_PORT = Number(process.env.AGENT_FIXTURE_PORT ?? 3213);

/** The production server entry the unsupervised chain ran. */
const SERVER_ENTRY = ".output/server/index.mjs";

function main(): void {
  void run();
}

async function run(): Promise<void> {
  if (!Number.isInteger(FIXTURE_PORT) || FIXTURE_PORT <= 0) {
    console.error("session-webserver: AGENT_FIXTURE_PORT is not a valid port");
    process.exitCode = 1;
    return;
  }
  const fixture = await startAgentLoopbackServer({ port: FIXTURE_PORT });
  console.log(
    `[session-webserver] agent fixture server on http://127.0.0.1:${String(FIXTURE_PORT)}`,
  );

  const child = spawn(process.execPath, [SERVER_ENTRY], {
    env: {
      ...process.env,
      AGENT_SERVER_AI_ALLOW_ALL: "1",
      MODEL_CATALOG_URL: `http://127.0.0.1:${String(FIXTURE_PORT)}/api.json`,
      OPENAI_COMPATIBLE_BASE_URL: `http://127.0.0.1:${String(FIXTURE_PORT)}/v1`,
      OPENAI_COMPATIBLE_KEY: "fixture-env-key",
    },
    stdio: "inherit",
  });

  let shuttingDown = false;
  const shutdown = (signal: NodeJS.Signals, code: number): void => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    child.kill(signal);
    child.once("exit", () => {
      void fixture.close().finally(() => {
        process.exit(code);
      });
    });
    // A child that ignores the graceful signal still ends the tree.
    const force = setTimeout(() => {
      child.kill("SIGKILL");
    }, 5_000);
    force.unref();
  };
  process.on("SIGTERM", () => {
    shutdown("SIGTERM", 0);
  });
  process.on("SIGINT", () => {
    shutdown("SIGINT", 130);
  });

  child.on("exit", (code, signal) => {
    if (shuttingDown) {
      return;
    }
    // The production server died on its own: end the whole webServer with
    // its verdict so Playwright fails loudly instead of hanging on a port.
    void fixture.close().finally(() => {
      process.exit(code ?? (signal !== null ? 1 : 0));
    });
  });
}

main();
