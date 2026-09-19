import { defineConfig } from "@playwright/test";

/**
 * Phase 34 documentation-application e2e harness — the browser gate for
 * the /docs page and its live examples. Same discipline as the render and
 * worker harnesses: it boots the REAL production build (TanStack Start
 * via `vite build` + nitro node-server) so the tested bytes are the
 * shipped bytes — including the Manifold WASM asset the page's in-process
 * kernel boots — with the repo's determinism setup (SwiftShader software
 * WebGL, fixed 1280×720 viewport, DPR 1). Kept OUT of `pnpm verify` —
 * run via `pnpm test:docs`.
 */

const PORT = 3011;
const baseURL = process.env.DOCS_E2E_BASE_URL ?? `http://localhost:${PORT}`;

export default defineConfig({
  testDir: "e2e-docs",
  timeout: 90_000,
  expect: {
    timeout: 15_000,
  },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [
    ["list"],
    ["html", { open: "never", outputFolder: "playwright-report/docs" }],
  ],
  outputDir: "test-results/docs",
  use: {
    baseURL,
    viewport: { width: 1280, height: 720 },
    deviceScaleFactor: 1,
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
