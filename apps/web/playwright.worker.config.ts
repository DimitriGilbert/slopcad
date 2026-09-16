import { defineConfig } from "@playwright/test";

/**
 * Phase 10 worker-integration e2e harness — the phase-level browser gate.
 * Like the spike harness, this boots the REAL production build (TanStack
 * Start via `vite build` + nitro node-server) so the spec exercises the
 * actual bundling path — the Manifold worker entry, its pinned WASM asset,
 * and the web transport adapter inside the Vite-built app. Same discipline
 * as the spike (SwiftShader flags and fixed viewport inherited for
 * consistency; this fixture renders no WebGL), separate entry: the spike
 * island and its config are untouched. Kept OUT of `pnpm verify` — run via
 * `pnpm test:worker`.
 */

const PORT = 3003;
const baseURL = process.env.WORKER_E2E_BASE_URL ?? `http://localhost:${PORT}`;

export default defineConfig({
  testDir: "e2e-worker",
  timeout: 60_000,
  expect: {
    timeout: 10_000,
  },
  fullyParallel: false,
  retries: 0,
  reporter: [
    ["list"],
    ["html", { open: "never", outputFolder: "playwright-report/worker" }],
    ["./e2e-worker/video-artifact-reporter.ts"],
  ],
  outputDir: "test-results/worker",
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
  webServer: {
    command: `pnpm build && PORT=${PORT} node --env-file-if-exists=.env .output/server/index.mjs`,
    url: baseURL,
    timeout: 300_000,
    reuseExistingServer: false,
  },
});
