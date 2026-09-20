/**
 * The render-gate wrapper: runs the byte-determinism suite and retries
 * ONCE when the failure is INFRASTRUCTURE, never when it is a real
 * byte/behavior mismatch.
 *
 * Why this exists: the suite boots one production nitro server per run
 * (`webServer` in playwright.render.config.ts, `reuseExistingServer:
 * false`, `retries: 0` by design — a Playwright retry must never mask a
 * real determinism flake). That single unsupervised server has been
 * observed dying mid-run under memory pressure, cascading instant
 * ERR_CONNECTION_REFUSED failures across the remaining tests. Those are
 * harness deaths, not scene-determinism failures — every test that
 * actually executed still compared real bytes. This wrapper captures the
 * run transcript, retries once only on the infrastructure signature, and
 * reports both runs so a retry is never silent.
 *
 * Usage: `pnpm test:render:gate`. Exit codes: 0 green (first or second
 * run), 1 a real failure stands (no infra signature, or the retry failed).
 */
import { spawn } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";

const LOG = "/tmp/render-gate-run-1.log";
const INFRA_SIGNATURES = [
  "ERR_CONNECTION_REFUSED",
  "ECONNREFUSED",
  "net::ERR_ABORTED",
  "net::ERR_SOCKET_NOT_CONNECTED",
  "fetch failed",
  "socket hang up",
  "read ECONNRESET",
  "EADDRINUSE",
  "address already in use",
  "Port already in use",
];

/**
 * A second infra class: Playwright's own artifact collection (trace,
 * video, attachment copy into test-results/) dying with ENOENT after a
 * test body succeeded. The ENOENT alone is NOT a signature — a real test
 * could legitimately log one — so the class requires the ENOENT to
 * co-occur with the artifact directory in the transcript. It has never
 * been a byte mismatch.
 */
function artifactCollectionDeath(transcript) {
  return transcript.includes("ENOENT") && transcript.includes("test-results");
}

function run(label, logPath) {
  return new Promise((resolve) => {
    console.log(`\n[render-gate] === ${label} ===`);
    rmSync(logPath, { force: true });
    const child = spawn("pnpm", ["test:render"], {
      cwd: process.cwd(),
      shell: true,
    });
    let transcript = "";
    const capture = (chunk) => {
      const text = String(chunk);
      transcript += text;
      process.stdout.write(text);
    };
    child.stdout.on("data", capture);
    child.stderr.on("data", capture);
    child.on("close", (code) => {
      writeFileSync(logPath, transcript);
      resolve({ code: code ?? 1, transcript });
    });
  });
}

function infraSignatures(transcript) {
  return INFRA_SIGNATURES.filter((signature) => transcript.includes(signature));
}

const first = await run("run 1", LOG);

if (first.code === 0) {
  console.log("\n[render-gate] run 1 green. Final.");
  process.exit(0);
}

const signatures = infraSignatures(first.transcript);
const connectionDeaths = (
  first.transcript.match(/ERR_CONNECTION_REFUSED/g) ?? []
).length;
const artifactDeath = artifactCollectionDeath(first.transcript);

if (signatures.length === 0 && !artifactDeath) {
  console.log(
    "\n[render-gate] run 1 failed WITHOUT an infrastructure signature — " +
      "this is a real byte/behavior failure. No retry (a retry must never " +
      "mask a determinism flake). Failing.",
  );
  process.exit(1);
}

console.log(
  `\n[render-gate] run 1 failed with infrastructure signatures ` +
    `(${[...signatures, ...(artifactDeath ? ["ENOENT in artifact collection"] : [])].join(", ")}; ` +
    `ERR_CONNECTION_REFUSED x${String(connectionDeaths)}). ` +
    "The single unsupervised webServer likely died mid-run. " +
    "Retrying ONCE on a fresh server — this retry is reported, not silent.",
);

const second = await run(
  "run 2 — infra retry, final",
  "/tmp/render-gate-run-2.log",
);
console.log(
  second.code === 0
    ? "\n[render-gate] run 2 green. RECOVERED: run 1 was a harness death " +
        "(every byte test that executed in run 1 compared real bytes); " +
        "run 2 is a complete clean pass and final."
    : "\n[render-gate] run 2 failed after the infra retry — treat as a real " +
        "gate failure.",
);
process.exit(second.code === 0 ? 0 : 1);
