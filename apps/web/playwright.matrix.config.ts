import { defineConfig } from "@playwright/test";

/**
 * Phase 35.3 browser compatibility matrix: the CORE workbench workflows
 * across the FEASIBLE engine matrix on this machine —
 *
 *   chromium  — SwiftShader software WebGL (the render harness's setup)
 *   webkit    — WPE WebKit with its own software WebGL (works headlessly;
 *               made runnable user-space by `pnpm webkit:deps`, which
 *               overturned the Phase 30 libjpeg/icu decline)
 *   firefox   — headless Firefox has NO WebGL on this host (no GPU, no
 *               Xvfb, no sudo to provide one): it runs the DOM-level
 *               battery (workflows.spec.ts) and skips ONLY the
 *               render-stamp battery, with a visible, reasoned skip
 *
 * Same discipline as the workbench harness: the REAL production build,
 * fixed 1280×720 viewport, DPR 1, one worker (concurrent workers starve
 * rAF under software WebGL + video encoding), video evidence per engine
 * copied to `e2e-artifacts/matrix/`. Kept OUT of `pnpm verify` — run via
 * `pnpm test:matrix`.
 */

const PORT = 3210;
const baseURL = process.env.MATRIX_E2E_BASE_URL ?? `http://localhost:${PORT}`;

// WebKit's remaining host check (gstreamer1.0-libav — media codecs) is not
// needed for DOM/WebGL automation; the user-space deps script + this skip
// make the engine drivable without sudo. Scoped to this suite only.
process.env.PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS ??= "1";

export default defineConfig({
  testDir: "e2e-matrix",
  timeout: 120_000,
  expect: {
    timeout: 15_000,
  },
  fullyParallel: false,
  // One worker, always (the workbench harness's documented reason, verbatim
  // in intent): concurrent engines starve rAF under software WebGL.
  workers: 1,
  retries: 0,
  reporter: [
    ["list"],
    ["html", { open: "never", outputFolder: "playwright-report/matrix" }],
    [
      "./e2e-worker/video-artifact-reporter",
      { outputFolder: "e2e-artifacts/matrix" },
    ],
  ],
  outputDir: "test-results/matrix",
  projects: [
    {
      name: "chromium",
      use: {
        browserName: "chromium",
        launchOptions: {
          args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
        },
      },
    },
    {
      name: "firefox",
      use: {
        browserName: "firefox",
      },
    },
    {
      name: "webkit",
      use: {
        browserName: "webkit",
      },
    },
  ],
  use: {
    baseURL,
    viewport: { width: 1280, height: 720 },
    deviceScaleFactor: 1,
    video: "on",
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  webServer: {
    command: `pnpm build && PORT=${PORT} node --env-file-if-exists=.env .output/server/index.mjs`,
    url: baseURL,
    timeout: 300_000,
    reuseExistingServer: false,
  },
});
