import { defineConfig } from "@playwright/test";

/**
 * The tutorial harness (`pnpm tutorial:record`) — the teaching twin of the
 * session harness: the same production boot (committed migrations → build →
 * nitro server), the same determinism setup (SwiftShader, fixed 1280×720,
 * DPR 1, one worker, serial), but every UI interaction is driven at HUMAN
 * pace through a visible cursor overlay so the recorded video teaches:
 * where things are, what to click, what to change, and why. The chapters'
 * narration cues are timestamped against the recording and land in
 * `docs/tutorials/` (captions + chapter tracks + the committed cut list)
 * via `e2e-tutorial/tutorial-reporter.ts`.
 *
 * Kept OUT of `pnpm verify` — run via `pnpm --filter web tutorial:record`.
 */

const PORT = 3214;
const baseURL = process.env.TUTORIAL_E2E_BASE_URL ?? `http://localhost:${PORT}`;

export default defineConfig({
  testDir: "e2e-tutorial",
  // The session's per-stage cap, kept as the floor; chapters legitimately
  // need more than machine pace allows (every cue is held for reading), so
  // each chapter test raises its own budget explicitly — the session's own
  // series stages set the precedent (s11b/s11c).
  timeout: 30_000,
  expect: {
    timeout: 10_000,
  },
  fullyParallel: false,
  // One worker IS the tutorial: serial mode + the worker-scoped page
  // fixture keep one context — and one master video — across every chapter.
  workers: 1,
  retries: 0,
  reporter: [
    ["list"],
    ["html", { open: "never", outputFolder: "playwright-report/tutorial" }],
    ["./e2e-tutorial/tutorial-reporter.ts"],
  ],
  outputDir: "test-results/tutorial",
  use: {
    baseURL,
    viewport: { width: 1280, height: 720 },
    deviceScaleFactor: 1,
    actionTimeout: 10_000,
    navigationTimeout: 20_000,
    // The fixture-built context records its own video (the config's
    // `use.video` never reaches it — the session harness's recorded note);
    // this stays on for the knob parity with the session and as the
    // render-primitive it is under SwiftShader headless.
    video: "on",
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    launchOptions: {
      args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
    },
  },
  webServer: {
    // The session harness's boot discipline: the committed migrations
    // first, then the production build and server with BETTER_AUTH_URL
    // matching the harness port.
    command: `pnpm --filter @slopcad/db db:migrate && pnpm build && PORT=${PORT} BETTER_AUTH_URL=${baseURL} node --env-file-if-exists=.env .output/server/index.mjs`,
    url: baseURL,
    timeout: 300_000,
    reuseExistingServer: false,
  },
});
