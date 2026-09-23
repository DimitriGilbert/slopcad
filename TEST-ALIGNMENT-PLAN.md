# Test & Quality Alignment Plan — slopcad

_Established 2026-09-15 as Phase 1.5 of the orchestrated development plan (baseline executed in the same pass)._

- **Project:** `slopcad` (`/home/didi/workspace/slopcad`)
- **Fleet synthesis:** [`../.test-alignment-audit/synthesis-decisions.md`](../.test-alignment-audit/synthesis-decisions.md) — the single source of D1–D7 decisions this plan adopts
- **Donor repos studied for this baseline** (patterns ported from, with sources):
  - **LearnABee** — `createTestConfig()` factory in `packages/config` (`packages/config/vitest/base.ts`), colocated `*.test.ts(x)` layout, `import/order`-clean imports, Playwright against the app with `trace: "on-first-retry"`
  - **solard** — per-package `src/test-setup.ts` with `SKIP_ENV_VALIDATION` + the `TEST FORBIDS LIVE NETWORK` fetch guard; `createInMemoryDb()` applying committed migrations to an ephemeral temp-file libsql database (unique file per call — libsql pools `:memory:` connections)
  - **dns-sdk** — per-package `test` / `test:coverage` scripts aggregated by a turbo `test` task; `check-types` on every package
  - **stationio** — uniform `"test": "vitest run"` + `vitest: "catalog:"` wiring; TESTING-style documentation with a suites table and fixture policy
  - **launch-mommy / ideadump** — the quality pipeline: istanbul coverage `json` reporter → `crap-score` per package → jscpd (report-only) → single-file `scripts/quality-report.mjs` HTML aggregator writing `reports/quality/index.html`; `jscpd.config.json` canonical config (`minLines: 8`, `minTokens: 80`, `exitCode: 0`)

**State in one line:** a fresh Better-T-Stack repo that had zero tests, zero lint, zero Playwright, zero CI (deliberate — D5) now runs a six-package vitest suite (14 tests) plus a two-test Playwright smoke suite, behind a root `pnpm verify` gate (check-types → lint → test → build) and a report-only quality pipeline (coverage → CRAP → duplication → HTML dashboard).

---

## 1. Adopted decisions (D1–D7)

| Decision                 | Status            | How it lands here                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ------------------------ | ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **D1 — runner & layout** | Adopted           | Vitest v4 (`catalog: ^4.1.11`), colocated `src/**/*.test.ts(x)`, `createTestConfig()` factory in `@slopcad/config` (`packages/config/vitest/base.ts`). Node env by default; jsdom only where React/DOM is under test (component tests) — currently `apps/web`, `packages/ui`, `packages/cad-r3f`, `packages/cad-react`. Root `pnpm test` via a turbo `test` task; per-package `test` / `test:coverage`.                                                        |
| **D2 — coverage**        | Adopted (state 3) | `@vitest/coverage-istanbul`, reporters `text + json + html`, report-only — zero-test baseline. Thresholds come later: measure, set `lines` = measured − 5, ratchet +5, never lower. Generated-file exclusion (`*.gen.ts`, migrations, `*.sql`) baked into the shared factory once.                                                                                                                                                                             |
| **D3 — lint & format**   | Adopted           | ESLint 9 flat config at root + typescript-eslint `recommendedTypeChecked` with `projectService`, `eslint-plugin-react-hooks` (web/ui), `eslint-plugin-import` `import/order` (two blocks: external/workspace, then local), `@typescript-eslint/consistent-type-imports`. Prettier 3, defaults (codebase is double-quote + semicolons — zero churn). Per-package `lint` scripts; the previously dead turbo `lint` task is live. Zero errors, zero suppressions. |
| **D4 — quality metrics** | Adopted           | `pnpm quality` = coverage → `crap-score` per package (CRAP ≥ 30 flagged) → jscpd (report-only, `exitCode: 0` by explicit config) → `scripts/quality-report.mjs` HTML dashboard at `reports/quality/index.html`. `knip` via `pnpm quality:knip` (report-only, not chained — this repo will publish packages, so knip findings are required input later).                                                                                                        |
| **D5 — no CI by design** | Adopted           | No `.github/workflows`, none will be created. The gate is the root headless entrypoint `pnpm verify` (check-types → lint → test → build), run by the owner and by implementer/validator agents at every phase boundary.                                                                                                                                                                                                                                        |
| **D6 — shared config**   | Donor-shaped      | `@dg/config` is not published; the preset lives in this repo's `packages/config` (built as the donor shape).                                                                                                                                                                                                                                                                                                                                                   |
| **D7 — hooks policy**    | Adopted           | Local gates run by the owner/agents are the only authoritative gate. No git hooks installed. AGENTS.md states the policy.                                                                                                                                                                                                                                                                                                                                      |

## 2. Deviations from synthesis (justified, not silent)

1. **Coverage provider is `istanbul`, not `v8`** — the fleet D2 exception applies: slopcad runs the launch-mommy CRAP pipeline, whose `crap-score` consumes istanbul-format `coverage-final.json`. Donor-proven end to end here.
2. **Per-package vitest configs + turbo `test` task, not a root workspace-projects config** — D1 suggests the LearnABee root-projects shape for ≥6 packages, but the CRAP pipeline needs one `coverage-final.json` per package, which the turbo/per-package shape provides (launch-mommy/stationio/dns-sdk donor shape).
3. **No Renovate config** — absent from every donor repo in practice (verified: LearnABee, solard, dns-sdk, stationio, context-builder, launch-mommy, ideadump). Not added; revisit if the fleet publishes its org preset.
4. **`.nvmrc` (`24`) added** — no donor has one, but the plan pins Node ≥ 22 LTS and the current runtime is 24.
5. **`apps/web/src/routeTree.gen.ts` is committed** (un-ignored) — it is generated by dev/build; committing it keeps `check-types` green on a fresh clone with no build step first (required by the local-gate model). Never hand-edit it.
6. **`only-throw-error` allows throwing `Redirect`** — TanStack Router's `throw redirect(...)` control-flow pattern; a rule-level type allowance (`allow: ["Redirect"]`), not a suppression comment.
7. **Vendored Formedible source (`packages/ui/src/components/formedible/**`) lints under a scoped tier** — full recommended rules, `import/order`, Prettier and the complete typecheck apply, but not the type-_aware_ ruleset (upstream internals intentionally template ReactNode unions and carry `any` seams). Our own code keeps the full strict set.
8. **Initial drizzle migration generated and committed** (`packages/db/src/migrations/0000_*.sql`) — `createInMemoryDb()` applies committed migrations; tests never hit a real database.

## 3. Where the suites are

| Package         | Entry points                                    | What they cover                                                                                                                                                        |
| --------------- | ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/env`  | `src/server.test.ts`                            | Server env validation: valid pass-through, missing secret rejected with a structured error, `SKIP_ENV_VALIDATION` raw passthrough                                      |
| `packages/db`   | `src/index.test.ts`                             | `createInMemoryDb()` migration application; user round-trip through the drizzle schema; unique-email constraint                                                        |
| `packages/api`  | `src/routers/index.test.ts`                     | `healthCheck` resolves for anonymous callers; `privateData` rejects as `UNAUTHORIZED`                                                                                  |
| `packages/auth` | `src/index.test.ts`                             | Sign-up → session round-trip through the migrated temp-file database; unknown-user sign-in rejects `401 UNAUTHORIZED`                                                  |
| `packages/ui`   | `src/components/button.test.tsx`                | Button renders and forwards props; variant classes apply; native disable (Base UI primitives)                                                                          |
| `packages/ui`   | `src/components/formedible/formedible.test.tsx` | Formedible renders a form from a config object (labelled inputs), surfaces zod schema errors on invalid submit, delivers typed values to the configured submit handler |
| `apps/web`      | `src/components/sign-in-form.test.tsx` (jsdom)  | Sign-in form renders heading + labelled fields + submit; field values flow through form state and surface the zod validation error                                     |
| `apps/web`      | `e2e/smoke.spec.ts` (Playwright, Chromium)      | Home renders shell + tRPC health check reaches a terminal state; login switches sign-up ↔ sign-in and accepts input                                                    |

**Fixture policy:** no test touches a real database, the network (fetch is stubbed to throw in web/api setups), or a persistent file — databases are ephemeral temp files with migrations applied, network-shaped code fails loudly.

## 4. Evidence pipeline (proven 2026-09-15)

```text
pnpm test           → 14 tests green across 6 packages
pnpm verify         → check-types 7/7 · lint 7/7 (0 errors, 0 suppressions) · test · build
pnpm quality        → per-package coverage-final.json · reports/crap/*.json+html ·
                     reports/jscpd/* (3 clones, 4.85%) · reports/quality/index.html
pnpm test:e2e       → 2 passed under software WebGL (SwiftShader), DPR 1, fixed viewport
evidence artifacts  → apps/web/e2e-artifacts/{home,login}.png · test-results/**/video.webm ·
                     trace.zip on failure
```

Trace-proof reproduction (2026-09-15): add a temporary spec whose expectation
fails, run `pnpm test:e2e` — the retry directory
`test-results/<test>-retry1/trace.zip` appears (open with
`pnpm exec playwright show-trace`); delete the temporary spec and the suite is
green again. Artifacts are gitignored runtime evidence, so the config intent
plus this procedure is the verifiable record.

Video semantics: validators verify artifact existence and duration; content review is human and optional.

## 5. Fleet Definition of Done — status

| #   | DoD item                                                                            | Status                                                                                                              |
| --- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| 1   | Root-level headless test command documented in AGENTS.md                            | Done — `pnpm test`                                                                                                  |
| 2   | Headless verification entrypoint (typecheck + test + lint in one local command)     | Done — `pnpm verify`                                                                                                |
| 3   | Coverage measured & reported; thresholds per policy                                 | Reported; thresholds deferred to the ratchet step (state 3 → state 2 once suites grow)                              |
| 4   | Lint installed, zero errors, wired into the entrypoint; dead turbo `lint` task live | Done                                                                                                                |
| 5   | AGENTS.md Testing section matches reality                                           | Done                                                                                                                |
| 6   | Dead scaffold test deps removed or used                                             | Done — `@testing-library/*` + `jsdom` in `apps/web` are used by the sign-in-form test; `packages/ui` gained its own |
| 7   | Renovate one-liner                                                                  | Not adopted (deviation 3)                                                                                           |
| 8   | Quality-report script runnable locally, report-only                                 | Done — `pnpm quality`, `pnpm quality:knip`                                                                          |
| 9   | Nothing satisfied by a fake pass                                                    | Done — no `passWithNoTests`, no `echo` runners, no tautologies                                                      |

---

## 6. Phase 60 epoch note (2026-09-23)

The plan's structures are unchanged at the Phase 60 hardening epoch (tip
`8e5de07`, everything through the importers); what moved is scale. The
six-package vitest baseline of 14 tests became per-package suites across
the whole CAD workspace (run `pnpm test` — turbo prints each package's
tally; the phase floors to never shrink below: cad-core 1051, web 381,
cad-io 192, occt 423, cad-sketch 297, ui 147, api 14), and the browser
batteries grew from the two-test smoke harness to the full
`pnpm test:fast` fleet (one production build, one booked shared port,
eleven concurrent Playwright harnesses) whose `e2e-workbench` harness now
also carries the Phase 60 command-surface audit
(`apps/web/e2e-workbench/command-surface.spec.ts` + its generated
checklist, kept closed against `ROADMAP-CAD-PARITY.md` by
`pnpm audit:command-surface`). The D1–D7 decisions, the deviations, and
the no-CI gate model all stand as written above; `pnpm verify` remains
the single headless quality gate.
