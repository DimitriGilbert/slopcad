# Dependency Map — slopcad

_Established 2026-09-15 (Phases 1 + 1.5). This is the authoritative allowed-import map for the CAD layers that follow._

## Current workspace graph

_Graph regenerated 2026-10-06 from `apps/web/package.json` (16 workspace dependencies + `@slopcad/config` as devDependency); runtime `dependencies` only — per-package devDependencies (e.g. kernel backends exercised by test suites) are omitted — and transitive names are abbreviated (`@slopcad/<name>`)._

```text
apps/web
  ├── @slopcad/api ──────────────── auth, cad-core, db, env
  ├── @slopcad/auth ─────────────── db, env
  ├── @slopcad/db ───────────────── env
  ├── @slopcad/env
  ├── @slopcad/ui (via tsconfig paths @slopcad/ui/*)
  │     └── cad-core, cad-kernel, cad-kernel-manifold, cad-r3f, cad-react
  ├── @slopcad/cad-core
  ├── @slopcad/cad-kernel ───────── cad-core
  ├── @slopcad/cad-kernel-manifold ── cad-core, cad-kernel
  ├── @slopcad/cad-kernel-occt ──── cad-core, cad-kernel
  ├── @slopcad/cad-react ────────── cad-core
  ├── @slopcad/cad-r3f ──────────── cad-core, cad-react
  ├── @slopcad/cad-sketch ───────── cad-core
  ├── @slopcad/cad-io ───────────── cad-core, cad-kernel, cad-sketch
  ├── @slopcad/cad-jsx ──────────── cad-core
  ├── @slopcad/cad-components ───── cad-core, cad-kernel, cad-react
  └── @slopcad/docs-examples ────── cad-components, cad-core, cad-io, cad-jsx, cad-jscad,
                                   cad-kernel, cad-kernel-manifold, cad-kernel-occt,
                                   cad-react, cad-sketch

packages/config — devDependency of every package (tsconfig base, vitest factory)
```

All workspace packages are consumed as **source** (`exports` point at `./src/*.ts`); there is no dist build between them. `turbo` tasks: `build` (web only), `check-types`, `lint`, `test`, `test:coverage` — all cross-package tasks run through the turbo graph.

## Rules the CAD packages must follow (from the development plan)

```text
cad-core        → no React, no Three.js/R3F, no DOM, no kernel, no database
cad-kernel      → may depend on cad-core; never React/UI
cad-kernel-*    → kernel abstraction + the kernel runtime only
cad-react       → cad-core only
cad-r3f         → cad-react + cad-core + Three/R3F
packages/ui     → public React/R3F APIs only; never kernel internals
no CAD package  → @slopcad/db, @slopcad/auth, @slopcad/api, or the app
```

Forbidden (architectural review required on any violation): `core → React/UI`, `kernel → React`, `UI → kernel internals`, `renderer → document implementation details`.

## Test/quality dependency surface (Phase 1.5)

Root: eslint 9 stack (`@eslint/js`, `typescript-eslint`, `eslint-plugin-import`, `eslint-plugin-react-hooks`), `prettier`, `knip`, `jscpd`, `crap-score`. Catalog: `vitest ^4`, `@vitest/coverage-istanbul ^4`, `jsdom ^30`, `@testing-library/{react,dom}`; `apps/web` additionally carries `@playwright/test`. Quality tools are **root-only** — packages never depend on them directly.
