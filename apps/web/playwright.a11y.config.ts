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

const PORT = 3207;
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
 * WebKit (historical note, Phase 30 → overturned in Phase 35): Playwright's
 * WebKit could not launch here — the bundled WPE MiniBrowser died on
 * `libjpeg.so.8: LIBJPEG_8.0 not found` (Fedora ships libjpeg.so.62 only),
 * and the Phase 30 icu soname shims failed symbol lookup once libjpeg was
 * satisfied. Phase 35 overturned the decline WITHOUT sudo: real Ubuntu
 * `libjpeg8` (turbo, 8-ABI) and `libicu74` packages extracted user-space
 * into the browser bundle's own lib dirs (`pnpm webkit:deps`), plus
 * PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS for the unused
 * gstreamer1.0-libav media-codec check. WebKit now drives DOM AND software
 * WebGL headlessly — the browser compatibility matrix
 * (`pnpm test:matrix`, playwright.matrix.config.ts) runs the core
 * workbench workflows on all three engines. This a11y harness keeps its
 * chromium + firefox baseline (37+1skip) unchanged; a webkit project here
 * would need only the same shape as `firefox` above.
 */
