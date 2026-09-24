import { defineConfig } from "@playwright/test";

/**
 * The session harness (`pnpm test:session`) — ONE user, ONE browser
 * context, the WHOLE program walked in order like a real working session:
 * every command-menu surface, every dialog flow, every route, every
 * import/export and every honest decline, on the production build under
 * the determinism setup (SwiftShader, fixed 1280×720, DPR 1, one worker).
 *
 * The stages share ONE context (worker-scoped fixture + serial mode), so
 * state carries forward — the signed-in session, the cookie jar, and a
 * document that grows through the modeling stages. The final stage is the
 * coverage gate: it compares the session's recorded surfaces against the
 * Phase 60 command-surface checklist (the spine) and the planned route
 * list, and FAILS if any available path went untested.
 *
 * VIDEO: on by default (the workbench harness's always-on precedent —
 * the video encoder is what keeps the demand frames scheduled under
 * SwiftShader headless). One whole-session video for the single context.
 * `SESSION_VIDEO=0` opts out for timing comparisons; the camera-series
 * stages deliver in either mode — their slow frame waits are the
 * documented ledger finding (see the collectDownloads docblock).
 *
 * Kept OUT of `pnpm verify` — run via `pnpm test:session`, or through the
 * root `pnpm test:fast` orchestrator (which exports SLOPCAD_E2E_SHARED_URL
 * so this config skips its own build + boot).
 */

const PORT = 3212;
// The shared-server fast path (root `pnpm test:fast`): the orchestrator
// exports SLOPCAD_E2E_SHARED_URL when ONE pre-built server serves every
// harness — no per-config rebuild, no per-config boot.
const sharedURL = process.env.SLOPCAD_E2E_SHARED_URL;
const baseURL =
  sharedURL ?? process.env.SESSION_E2E_BASE_URL ?? `http://localhost:${PORT}`;

// Video ON is the DEFAULT, and it is a rendering primitive here, not a
// luxury: under SwiftShader headless the R3F demand frames only stay
// scheduled while the video encoder pumps the compositor (the workbench
// harness's recorded reason for its always-on video). The camera-series
// stages' slow frame waits are a LEDGER finding, not an encoder one —
// `data-rendered-frames` never advances in this habitat, video on or off
// (see the collectDownloads docblock: output correct, per-frame 10s
// degrade) — so `SESSION_VIDEO=0` opts out for timing comparisons only.
const videoOn = process.env.SESSION_VIDEO !== "0";

export default defineConfig({
  testDir: "e2e-session",
  // THE HARD CAP: no stage, step, or custom wait may exceed 30 seconds.
  // A stage that legitimately needs more is a design defect (wrong gate,
  // wrong server habitat) or a real perf finding — it fails loudly here,
  // never in a minutes-scale burn.
  timeout: 30_000,
  expect: {
    timeout: 10_000,
  },
  fullyParallel: false,
  // One worker IS the session: serial mode + the worker-scoped page
  // fixture keep one context across every stage, in order.
  workers: 1,
  retries: 0,
  reporter: [
    ["list"],
    ["html", { open: "never", outputFolder: "playwright-report/session" }],
  ],
  outputDir: "test-results/session",
  use: {
    baseURL,
    viewport: { width: 1280, height: 720 },
    deviceScaleFactor: 1,
    // A missing surface fails FAST with its evidence — never a dead-locator
    // burn against the stage's whole budget.
    actionTimeout: 10_000,
    navigationTimeout: 20_000,
    video: videoOn ? { mode: "on", size: { width: 1280, height: 720 } } : "off",
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    launchOptions: {
      args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
    },
  },
  ...(sharedURL || process.env.SESSION_E2E_BASE_URL
    ? {}
    : {
        webServer: {
          // Solo-run wiring, the projects harness's discipline: the
          // committed migrations first (the session's projects stage
          // persists through them), then the production build and server
          // with BETTER_AUTH_URL matching the harness port.
          command: `pnpm --filter @slopcad/db db:migrate && pnpm build && PORT=${PORT} BETTER_AUTH_URL=${baseURL} node --env-file-if-exists=.env .output/server/index.mjs`,
          url: baseURL,
          timeout: 300_000,
          reuseExistingServer: false,
        },
      }),
});
