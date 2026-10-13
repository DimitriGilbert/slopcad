# Testing Baseline — slopcad

_Established 2026-09-15 (Phase 1.5). Full policy and donor provenance: [`TEST-ALIGNMENT-PLAN.md`](../../TEST-ALIGNMENT-PLAN.md)._

## What exists

- **Unit/integration:** Vitest v4 in all six test-bearing packages (`apps/web`, `packages/{ui,api,auth,db,env}`), colocated `src/**/*.test.ts(x)`, shared `createTestConfig()` factory in `packages/config/vitest/base.ts`. 14 tests, all green.
- **E2E:** Playwright (Chromium) in `apps/web/e2e/` — deterministic config: software WebGL (SwiftShader) via `--use-angle=swiftshader --enable-unsafe-swiftshader`, viewport 1280×720, DPR 1, `video: "on"`, `screenshot: "only-on-failure"` (+ explicit screenshots to `e2e-artifacts/`), `trace: "on-first-retry"`, `webServer` reuses an existing dev server on 3201 or boots one. 2 smoke tests green.
  - _2026-09-28 update:_ the browser e2e is now the session harness (`pnpm test:session`, `apps/web/e2e-session/`) — one serial user session with a self-verifying coverage gate; the per-feature fleet above (and the `pnpm test:fast` orchestrator) is deprecated but kept runnable for per-harness granularity.
- **Gates:** root `pnpm verify` = check-types → lint → format:check → test → build. `pnpm test:e2e` separate (needs a browser).
- **Quality (report-only):** `pnpm quality` → per-package istanbul coverage → CRAP (≥ 30 flagged) → jscpd duplication → `reports/quality/index.html`. `pnpm quality:knip` for dead-code/export drift.
- **No CI, ever** (fleet policy D5). Local gates run by owner/agents.

## Evidence semantics (settled)

Screenshots and videos are inspectable artifacts validators check for existence/duration; trace archives are produced on failure; content review is human and optional. Geometry correctness in later CAD phases is proven by semantic numeric assertions (serialized projection + camera, tolerance-compared); pixel screenshots cover UI chrome and composed scenes only.

## Conventions for new packages

Every new package is born with: a `vitest.config.ts` using the factory, a `src/test-setup.ts` when env/network guards apply, `check-types` / `test` / `test:coverage` / `lint` scripts, catalog-pinned devDeps, and at least one real seed test. No `passWithNoTests`, no tautological assertions, no fake-green runners.
