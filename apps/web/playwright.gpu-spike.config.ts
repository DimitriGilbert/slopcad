import { defineConfig } from "@playwright/test";

/**
 * Phase 64b WebGPU spike harness — the S5 GPU door. Same boot
 * discipline as the perf/spike harnesses (the REAL production build
 * via `vite build` + nitro node-server) plus the WebGPU launch door
 * the Phase 64b spike validated on this machine: `--enable-unsafe-webgpu`
 * alongside the sanctioned SwiftShader-era flags. On headless Linux
 * this exposes Dawn's SwiftShader (software) adapter — the honest
 * device class this harness runs against; the findings doc
 * (`docs/architecture/wgsl-prespike-findings.md`) records what that
 * means for the numbers. A host without any WebGPU device makes the
 * `/sim-gpu` fixture record the LOUD skip and this suite FAILS on it —
 * the spike door never silently passes (law S5).
 *
 * Kept OUT of `pnpm verify` — run via `pnpm test:gpu-spike`.
 */

const PORT = 3215;
const sharedURL = process.env.SLOPCAD_E2E_SHARED_URL;
const baseURL =
  sharedURL ?? process.env.GPU_SPIKE_E2E_BASE_URL ?? `http://localhost:${PORT}`;

export default defineConfig({
  testDir: "e2e-gpu-spike",
  timeout: 120_000,
  expect: {
    timeout: 10_000,
  },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [
    ["list"],
    ["html", { open: "never", outputFolder: "playwright-report/gpu-spike" }],
  ],
  outputDir: "test-results/gpu-spike",
  use: {
    baseURL,
    viewport: { width: 1280, height: 720 },
    deviceScaleFactor: 1,
    screenshot: "only-on-failure",
    launchOptions: {
      args: [
        "--use-angle=swiftshader",
        "--enable-unsafe-swiftshader",
        "--enable-unsafe-webgpu",
      ],
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
