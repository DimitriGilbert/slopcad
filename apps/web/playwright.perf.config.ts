import { defineConfig } from "@playwright/test";

/**
 * Phase 29 performance-benchmark harness — the phase-level perf gate. Same
 * boot discipline as the render/workbench harnesses: it boots the REAL
 * production build (TanStack Start via `vite build` + nitro node-server)
 * so the measured bytes are the shipped bytes, and reuses the determinism
 * setup (SwiftShader software WebGL, fixed 1280×720 viewport, DPR 1).
 *
 * One deliberate deviation, documented here and in the phase docs: video
 * and trace recording are OFF in this harness (the others record video for
 * workflow evidence). Video encoding competes with the very timings this
 * harness measures — every published number would carry encoder load that
 * production browsing does not. Evidence here is the machine-readable
 * results JSON (`e2e-artifacts/perf/perf-results.json`), not video.
 *
 * Kept OUT of `pnpm verify` — run via `pnpm test:perf` (see the docs' wiring
 * decision and its stability evidence).
 */

const PORT = 3206;
// The shared-server fast path (root `pnpm test:fast`): the orchestrator
// exports SLOPCAD_E2E_SHARED_URL when ONE pre-built server serves every
// harness — no per-config rebuild, no per-config boot.
const sharedURL = process.env.SLOPCAD_E2E_SHARED_URL;
const baseURL =
  sharedURL ?? process.env.PERF_E2E_BASE_URL ?? `http://localhost:${PORT}`;

export default defineConfig({
  globalSetup: "./e2e-perf/global-setup.ts",
  testDir: "e2e-perf",
  timeout: 180_000,
  expect: {
    timeout: 10_000,
  },
  fullyParallel: false,
  // One worker, always: parallel pages would contend for the CPU the
  // timings measure (the render harness's documented reason, verbatim).
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  outputDir: "test-results/perf",
  use: {
    baseURL,
    viewport: { width: 1280, height: 720 },
    deviceScaleFactor: 1,
    screenshot: "only-on-failure",
    launchOptions: {
      args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
    },
  },
  ...(sharedURL
    ? {}
    : {
        webServer: {
          command: `pnpm build && PORT=${PORT} node --env-file-if-exists=.env .output/server/index.mjs`,
          url: baseURL,
          timeout: 300_000,
          reuseExistingServer: false,
        },
      }),
});
