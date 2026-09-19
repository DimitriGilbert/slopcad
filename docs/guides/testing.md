# Testing

Testing here is findings-first and hermetic: no live network (a runtime
fetch guard in the unit setups), no real database (`createInMemoryDb()`
applies committed migrations to an ephemeral temp-file libsql database),
no env validation at import time (`SKIP_ENV_VALIDATION=1`). The policy
record is `TEST-ALIGNMENT-PLAN.md`; the baseline measurements are
`docs/architecture/testing-baseline.md`.

## The unit layer (Vitest)

Runner: Vitest 4, tests colocated as `src/**/*.test.ts(x)`, one config
per package through the shared `createTestConfig()` factory
(`packages/config/vitest/base.ts`) — node by default, jsdom for React
suites. Run everything with `pnpm test` (through turbo), one package
with `pnpm --filter <name> test`.

The kernel-specific tools every suite uses:

- `defineKernelContractSuite` (`@slopcad/cad-kernel/contract-suite`) —
  the shared battery any conforming kernel runs; capability-aware
  assertions branch on the declared flags.
- Semantic assertions (`@slopcad/cad-kernel`): `assertVolumeClose`,
  `assertAreaClose`, `assertBoundsEqual`, `assertBoundsContain`,
  `assertTessellationValid`, `expectKernelFailure`,
  `unwrapKernelResult`.
- Projection assertions (`@slopcad/cad-core`): `assertPositionsClose`,
  `assertCameraClose`, `assertProjectionValid` — the render suite's
  building blocks.
- `createInMemoryDb()` (`@slopcad/db`) — migrations applied to an
  ephemeral database, never a live one.
- Fixtures as data: `manifold-fixtures`/`occt-fixtures`/`jscad-fixtures`
  (the shared semantic shapes), `sketch-fixtures` (the solver's
  diagnostic vocabulary pinned by example), committed STEP/IGES files.

The docs examples are tested the same way:
`packages/docs-examples`' suite RUNS every guide example and asserts the
documented outcomes (64 tests at the time of writing, including the
47-test contract suite over a custom adapter).

## The browser layer (Playwright)

Every browser gate boots the REAL production build (`vite build` + nitro
node-server) under software WebGL (`--use-angle=swiftshader
--enable-unsafe-swiftshader`), fixed viewport 1280×720, DPR 1 — so the
tested bytes are the shipped bytes and screenshots are byte-stable:

| Command                | Suite             | Covers                                                                                                                                                                                                                                                                                                                                                   |
| ---------------------- | ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm test:e2e`        | `e2e/`            | the app smoke                                                                                                                                                                                                                                                                                                                                            |
| `pnpm test:render`     | `e2e-render/`     | the deterministic scene, selection, tools, workbench, IO, sketch — 87 tests, byte-stable screenshots                                                                                                                                                                                                                                                     |
| `pnpm test:worker`     | `e2e-worker/`     | the Manifold and OCCT worker fixtures                                                                                                                                                                                                                                                                                                                    |
| `pnpm test:workbench`  | `e2e-workbench/`  | the complete workbench suite                                                                                                                                                                                                                                                                                                                             |
| `pnpm test:a11y`       | a11y config       | keyboard and screen-reader access                                                                                                                                                                                                                                                                                                                        |
| `pnpm test:projects`   | projects config   | project/document persistence                                                                                                                                                                                                                                                                                                                             |
| `pnpm test:components` | components config | registry component previews                                                                                                                                                                                                                                                                                                                              |
| `pnpm test:perf`       | perf config       | performance budgets (`budgets.json` — never lower a budget)                                                                                                                                                                                                                                                                                              |
| `pnpm test:docs`       | `e2e-docs/`       | the `/docs` documentation application                                                                                                                                                                                                                                                                                                                    |
| `pnpm test:matrix`     | `e2e-matrix/`     | the browser compatibility matrix — core workbench workflows on Chromium + Firefox + WebKit (Firefox runs the DOM battery; its render-stamp battery carries the visible reasoned skip: headless Firefox has no WebGL on the reference machine). WebKit needs the one-time user-space `pnpm webkit:deps` on hosts without libjpeg8/ICU 74 system packages. |

All browser suites are outside `pnpm verify` by design — they build the
app first.

## The compatibility and release gates

Three more local gates complete the release hardening (Phase 35):

- **Native document compatibility** —
  `packages/cad-core/src/native-compatibility.test.ts` (inside
  `pnpm test`): every committed `packages/cad-core/fixtures/*.native.json`
  enrolls automatically in the battery — format stamp, structural
  validation, byte-identical round trips, deterministic serialization,
  full transaction-log replay to every persisted intermediate state,
  undo/redo cycle to the head, and migration no-op at the current
  version, plus the migration registry's contiguity invariant.
- **Registry consumer matrix** — `pnpm registry:matrix`: the full consumer
  reinstalled from scratch with the four registry categories requested in
  REVERSED order (dependency resolution is order-independent) and the
  minimal consumer (`fixtures/cad-consumer-minimal`) installed with just
  one UI component + one CAD component; both gate on install → typecheck
  → build → browser smoke.
- **Clean checkout** — `pnpm clean:verify`: exports the exact working
  tree (stage → `git write-tree` → `git archive`, no commit needed) into
  a temp directory and runs the whole battery there — install from the
  committed lockfile, the documented contributor `.env` step, fresh
  database migrations, check-types, lint, format:check, unit, build, the
  e2e smoke (on its own dev port, never a live one), registry build +
  validation, and the full consumer reinstall + build. Nothing
  developer-local or generated is required.

## The one gate

```bash
pnpm run verify    # check-types → lint → format:check → test → build
```

Before declaring any work done, run it (and the browser suites you
touched). Full suites only; a passing subset is not a green gate.
