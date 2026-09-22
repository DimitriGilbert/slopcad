import { defineConfig } from "@playwright/test";

/**
 * Phase 11.3 deterministic-scene e2e harness — the phase-level browser gate.
 * Same discipline as the spike and worker harnesses: it boots the REAL
 * production build (TanStack Start via `vite build` + nitro node-server) so
 * the tested bytes are the shipped bytes, and reuses the Phase 1.5
 * determinism setup — SwiftShader software WebGL, fixed 1280×720 viewport,
 * DPR 1, video on for the model creation/update workflow. Kept OUT of
 * `pnpm verify` — run via `pnpm test:render`.
 */

const PORT = 3204;
// The shared-server fast path (root `pnpm test:fast`): the orchestrator
// exports SLOPCAD_E2E_SHARED_URL when ONE pre-built server serves every
// harness — no per-config rebuild, no per-config boot.
const sharedURL = process.env.SLOPCAD_E2E_SHARED_URL;
const baseURL =
  sharedURL ?? process.env.RENDER_E2E_BASE_URL ?? `http://localhost:${PORT}`;

export default defineConfig({
  testDir: "e2e-render",
  timeout: 60_000,
  expect: {
    timeout: 10_000,
  },
  fullyParallel: false,
  // One worker, always: fullyParallel:false still runs the two spec files in
  // parallel workers, and that second worker's load starves rAF under
  // SwiftShader + video encoding, leaving R3F demand frames unscheduled.
  workers: 1,
  retries: 0,
  reporter: [
    ["list"],
    ["html", { open: "never", outputFolder: "playwright-report/render" }],
    [
      "./e2e-worker/video-artifact-reporter.ts",
      { outputFolder: "e2e-artifacts/render" },
    ],
  ],
  outputDir: "test-results/render",
  use: {
    baseURL,
    viewport: { width: 1280, height: 720 },
    deviceScaleFactor: 1,
    video: "on",
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
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
