import { defineConfig } from "@playwright/test";

/**
 * Phase 1.6 architecture spike — NON-PRODUCTION e2e harness.
 * Unlike the smoke config, this boots the REAL production build (TanStack
 * Start via `vite build` + nitro node-server) so the spike exercises the
 * actual bundling path (manifold WASM inside the Vite-built worker).
 * Reuses the Phase 1.5 determinism setup: SwiftShader software WebGL, fixed
 * viewport, DPR 1. Kept OUT of `pnpm verify` — run via `pnpm test:spike`.
 */

const PORT = 3202;
// The shared-server fast path (root `pnpm test:fast`): the orchestrator
// exports SLOPCAD_E2E_SHARED_URL when ONE pre-built server serves every
// harness — no per-config rebuild, no per-config boot.
const sharedURL = process.env.SLOPCAD_E2E_SHARED_URL;
const baseURL =
  sharedURL ?? process.env.SPIKE_BASE_URL ?? `http://localhost:${PORT}`;

export default defineConfig({
  testDir: "e2e-spike",
  timeout: 60_000,
  expect: {
    timeout: 10_000,
  },
  fullyParallel: false,
  retries: 0,
  reporter: [
    ["list"],
    ["html", { open: "never", outputFolder: "playwright-report/spike" }],
  ],
  outputDir: "test-results/spike",
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
