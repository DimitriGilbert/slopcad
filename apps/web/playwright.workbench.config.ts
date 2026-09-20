import { defineConfig } from "@playwright/test";

/**
 * Phase 28 complete-workbench workflow e2e harness. Same discipline as the
 * render harness: it boots the REAL production build (TanStack Start via
 * `vite build` + nitro node-server) so the tested bytes are the shipped
 * bytes, reuses the determinism setup — SwiftShader software WebGL, fixed
 * 1280×720 viewport, DPR 1 — and records VIDEO for every workflow, copied
 * to `e2e-artifacts/workbench/` at run end (the video-artifact reporter).
 * Kept OUT of `pnpm verify` — run via `pnpm test:workbench`.
 */

const PORT = 3205;
const baseURL =
  process.env.WORKBENCH_E2E_BASE_URL ?? `http://localhost:${PORT}`;

export default defineConfig({
  testDir: "e2e-workbench",
  timeout: 120_000,
  expect: {
    timeout: 15_000,
  },
  fullyParallel: false,
  // One worker, always: a second worker's load starves rAF under
  // SwiftShader + video encoding, leaving R3F demand frames unscheduled
  // (the render harness's documented reason, verbatim).
  workers: 1,
  retries: 0,
  reporter: [
    ["list"],
    ["html", { open: "never", outputFolder: "playwright-report/workbench" }],
    [
      "./e2e-worker/video-artifact-reporter.ts",
      { outputFolder: "e2e-artifacts/workbench" },
    ],
  ],
  outputDir: "test-results/workbench",
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
