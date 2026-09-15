# Dependency Map — slopcad

_Established 2026-09-15 (Phases 1 + 1.5). This is the authoritative allowed-import map for the CAD layers that follow._

## Current workspace graph

```text
apps/web
  ├── @slopcad/api ──┬── @slopcad/auth ──┬── @slopcad/db ── @slopcad/env
  │                 └── @slopcad/db     └── @slopcad/env
  ├── @slopcad/auth
  ├── @slopcad/env
  └── @slopcad/ui (via tsconfig paths @slopcad/ui/*)

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
