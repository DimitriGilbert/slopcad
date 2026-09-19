import { defineConfig } from "@playwright/test";

/**
 * Phase 32 component-preview e2e harness — the phase-level browser gate.
 * Same discipline as the render harness: it boots the REAL production
 * build (TanStack Start via `vite build` + nitro node-server) so the
 * tested bytes are the shipped bytes, under SwiftShader software WebGL,
 * fixed 1280×720 viewport, DPR 1, one worker (rAF starvation discipline),
 * video on. Run via `pnpm test:components`.
 */

const PORT = 3008;
const baseURL =
  process.env.COMPONENTS_E2E_BASE_URL ?? `http://localhost:${PORT}`;

export default defineConfig({
  testDir: "e2e-components",
  timeout: 60_000,
  expect: {
    timeout: 10_000,
  },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [
    ["list"],
    ["html", { open: "never", outputFolder: "playwright-report/components" }],
    [
      "./e2e-worker/video-artifact-reporter.ts",
      { outputFolder: "e2e-artifacts/components" },
    ],
  ],
  outputDir: "test-results/components",
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
