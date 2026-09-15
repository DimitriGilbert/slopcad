import { defineConfig } from "@playwright/test";

const PORT = 3001;
const baseURL = process.env.E2E_BASE_URL ?? `http://localhost:${PORT}`;

export default defineConfig({
  testDir: "e2e",
  timeout: 30_000,
  expect: {
    timeout: 5_000,
  },
  fullyParallel: true,
  retries: 1,
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL,
    viewport: { width: 1280, height: 720 },
    deviceScaleFactor: 1,
    video: "on",
    screenshot: "only-on-failure",
    trace: "on-first-retry",
    launchOptions: {
      args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
    },
  },
  webServer: {
    command: "pnpm dev",
    url: baseURL,
    timeout: 120_000,
    reuseExistingServer: true,
  },
});
