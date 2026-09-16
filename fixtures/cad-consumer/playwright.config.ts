import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  timeout: 120_000,
  fullyParallel: false,
  workers: 1,
  retries: 1,
  reporter: [["list"]],
  use: {
    ...devices["Desktop Chrome"],
    headless: true,
    viewport: { width: 1440, height: 900 },
    launchOptions: {
      args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
    },
    screenshot: "only-on-failure",
    video: "off",
  },
  outputDir: "./e2e-artifacts",
  webServer: {
    command: "pnpm exec vite preview --port 46220 --strictPort",
    port: 46220,
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
