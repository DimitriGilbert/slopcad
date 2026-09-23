import { defineConfig } from "@playwright/test";

const PORT = 3201;
// The shared-server fast path (root `pnpm test:fast`): the orchestrator
// exports SLOPCAD_E2E_SHARED_URL when ONE pre-built server serves every
// harness — no per-config rebuild, no per-config boot.
const sharedURL = process.env.SLOPCAD_E2E_SHARED_URL;
const baseURL =
  sharedURL ?? process.env.E2E_BASE_URL ?? `http://localhost:${PORT}`;

// Contention-aware wall clock (the recorded CPU-starvation flake class):
// under the orchestrator's 10-way harness load the same SwiftShader+wasm
// work takes multiples of its quiet-machine time, so the recorded
// curve-authoring-class smoke timeouts were starvation, not product
// regressions. When the orchestrator exports
// SLOPCAD_E2E_HARNESS_CONCURRENCY (the count of concurrently launched
// browser harnesses), the per-test and expect wall-clock budgets scale by
// a measured, capped factor. The conditions themselves are untouched —
// every assertion must still hold, it just gets proportional time to
// hold under measured contention. Solo runs (the adjudication path) and
// CI-less local `pnpm test:smoke` runs leave the variable unset and run
// at the quiet-machine budgets exactly as before.
const concurrency = Number(process.env.SLOPCAD_E2E_HARNESS_CONCURRENCY ?? "1");
const contentionFactor =
  Number.isFinite(concurrency) && concurrency > 1
    ? Math.min(1 + (concurrency - 1) * 0.25, 3)
    : 1;

export default defineConfig({
  testDir: "e2e",
  timeout: Math.round(30_000 * contentionFactor),
  expect: {
    timeout: Math.round(5_000 * contentionFactor),
  },
  fullyParallel: true,
  retries: 1,
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL,
    viewport: { width: 1280, height: 720 },
    deviceScaleFactor: 1,
    video: "on",
    screenshot: "only-on-failure",
    trace: "on-first-retry",
    launchOptions: {
      args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
    },
  },
  ...(sharedURL
    ? {}
    : {
        webServer: {
          command: "pnpm dev",
          url: baseURL,
          timeout: 120_000,
          reuseExistingServer: true,
        },
      }),
});
