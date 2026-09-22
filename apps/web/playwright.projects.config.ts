import { defineConfig } from "@playwright/test";

/**
 * Phase 31 project-workflow e2e harness. Same discipline as the workbench
 * harness: it boots the REAL production build (TanStack Start via
 * `vite build` + nitro node-server) so the tested bytes are the shipped
 * bytes, reuses the determinism setup — SwiftShader software WebGL, fixed
 * 1280×720 viewport, DPR 1, one worker — and records VIDEO for the
 * workflow, copied to `e2e-artifacts/projects/` at run end (the
 * video-artifact reporter).
 *
 * Persistence-specific webServer wiring, kept inside the harness command:
 * the committed migrations are applied to the local database first (the
 * repo's `db:migrate` script against `apps/web/.env`'s DATABASE_URL), and
 * `BETTER_AUTH_URL` is overridden to the harness port — real env beats
 * `--env-file`, so Better Auth's base URL and trusted origins match the
 * server the browser actually talks to. Kept OUT of `pnpm verify` — run
 * via `pnpm test:projects`.
 */

const PORT = 3209;
// The shared-server fast path (root `pnpm test:fast`): the orchestrator
// exports SLOPCAD_E2E_SHARED_URL when ONE pre-built server serves every
// harness — no per-config rebuild, no per-config boot.
const sharedURL = process.env.SLOPCAD_E2E_SHARED_URL;
const baseURL =
  sharedURL ?? process.env.PROJECTS_E2E_BASE_URL ?? `http://localhost:${PORT}`;

export default defineConfig({
  testDir: "e2e-projects",
  timeout: 120_000,
  expect: {
    timeout: 15_000,
  },
  fullyParallel: false,
  // One worker, always: the workflow owns one seeded identity and the
  // workbench's rAF settle discipline requires an uncontended main thread
  // under SwiftShader + video encoding (the render harness's reason).
  workers: 1,
  retries: 0,
  reporter: [
    ["list"],
    ["html", { open: "never", outputFolder: "playwright-report/projects" }],
    [
      "./e2e-worker/video-artifact-reporter.ts",
      { outputFolder: "e2e-artifacts/projects" },
    ],
  ],
  outputDir: "test-results/projects",
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
  ...(sharedURL
    ? {}
    : {
        webServer: {
          command: `pnpm --filter @slopcad/db db:migrate && pnpm build && PORT=${PORT} BETTER_AUTH_URL=${baseURL} node --env-file-if-exists=.env .output/server/index.mjs`,
          url: baseURL,
          timeout: 300_000,
          reuseExistingServer: false,
        },
      }),
});
