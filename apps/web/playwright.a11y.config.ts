import { defineConfig } from "@playwright/test";

/**
 * Phase 30 accessibility workflow e2e harness. Same discipline as the
 * workbench harness: it boots the REAL production build (TanStack Start
 * via `vite build` + nitro node-server) so the tested bytes are the
 * shipped bytes, reuses the determinism setup (fixed 1280×720 viewport,
 * DPR 1, one worker), and runs the keyboard-only journey, the focus-order
 * assertions, the error-state accessibility checks, and the seven-state
 * visual baselines on the EVERGREEN TRIO of browsers — minus WebKit,
 * which this machine cannot run (see the decline note at the bottom).
 *
 * Kept OUT of `pnpm verify` — run via `pnpm test:a11y`.
 */

const PORT = 3007;
const baseURL = process.env.A11Y_E2E_BASE_URL ?? `http://localhost:${PORT}`;

export default defineConfig({
  testDir: "e2e-a11y",
  timeout: 120_000,
  expect: {
    timeout: 15_000,
  },
  fullyParallel: false,
  // One worker per browser project, never two concurrent: a second
  // worker's load starves rAF under software WebGL, leaving R3F demand
  // frames unscheduled (the render harness's documented reason, verbatim).
  workers: 1,
  retries: 0,
  reporter: [
    ["list"],
    ["html", { open: "never", outputFolder: "playwright-report/a11y" }],
    [
      "./e2e-worker/video-artifact-reporter.ts",
      { outputFolder: "e2e-artifacts/a11y" },
    ],
  ],
  outputDir: "test-results/a11y",
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
    // Reuse a running server like the smoke harness does: the a11y
    // assertions ride the DOM, not the boot path (the boot-sensitive
    // suites keep reuseExistingServer: false).
    reuseExistingServer: true,
  },
});

/*
 * WebKit decline (Phase 30, this machine): Playwright's WebKit 26.6
 * (webkit-2359) cannot launch here. The download and the icu soname gap
 * resolve, but the bundled WPE MiniBrowser then fails with:
 *
 *   MiniBrowser: error while loading shared libraries: libjpeg.so.8:
 *   cannot open shared object file
 *   → after a libjpeg.so.8 shim: version `LIBJPEG_8.0' not found
 *     (required by .../minibrowser-wpe/lib/libWPEWebKit-2.0.so.1)
 *
 * The host has no libjpeg v8-ABI library (Fedora ships libjpeg.so.62
 * only), plus no gstreamer1-libav, and the session has no sudo (and no
 * cmake) to provide them. Re-add a `webkit` project with the same shape
 * as `firefox` above once those system packages exist; the specs are
 * browser-agnostic and need no changes.
 */
