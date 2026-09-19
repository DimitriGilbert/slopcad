# Public API Audit — Phase 35.1

_Established 2026-09-19 (Phase 35), the release-hardening audit of every
workspace package's public surface. Method and evidence are mechanical and
reproducible from this branch; the verdicts summarize them._

## Method

The public surface of a workspace package is what crosses its boundary:

1. its `src/index.ts` barrel (the `.` export), and
2. the wildcard subpaths of its export map (`"./*": "./src/*.ts"` — every
   CAD package, and `@slopcad/ui`'s `./components/*` + `./lib/*`).

The audit enumerated every barrel export with the TypeScript compiler API
(values and types, `export *` chains resolved — `cad-react` re-exports
cad-core wholesale), then cross-referenced each name against:

- every other workspace package (production, test, and e2e code, including
  `apps/web`'s Playwright suites and `fixtures/cad-consumer`'s installed
  sources),
- `packages/docs-examples` (the runnable documented examples), and
- `docs/` (the Phase 34 guides — the documented surface).

Barrel files themselves were excluded from "usage" (a barrel trivially
mentions every name it re-exports). `pnpm quality:knip` was run as
corroborating evidence — noting that the CAD packages are absent from
`knip.json`'s entry list (the config predates them), so knip's silence
there is absence-of-audit, not cleanliness; this audit covered them
directly.

## Export inventory (barrels)

| Package                        | Exports                                  | Verdict                                        |
| ------------------------------ | ---------------------------------------- | ---------------------------------------------- |
| `@slopcad/cad-core`            | 553                                      | coherent; 3 accidental exports removed (below) |
| `@slopcad/cad-kernel`          | 257                                      | coherent                                       |
| `@slopcad/cad-kernel-manifold` | 15                                       | coherent                                       |
| `@slopcad/cad-kernel-occt`     | 53                                       | coherent                                       |
| `@slopcad/cad-jscad`           | 10                                       | coherent                                       |
| `@slopcad/cad-r3f`             | 57                                       | coherent                                       |
| `@slopcad/cad-react`           | 591 (= cad-core's 553 + 38 own)          | coherent                                       |
| `@slopcad/cad-sketch`          | 177                                      | coherent; 1 accidental export removed (below)  |
| `@slopcad/cad-io`              | 59                                       | coherent                                       |
| `@slopcad/cad-components`      | 60                                       | coherent                                       |
| `@slopcad/api`                 | 4                                        | coherent (tRPC appRouter + procedures)         |
| `@slopcad/auth`                | 2                                        | coherent                                       |
| `@slopcad/db`                  | 4                                        | coherent                                       |
| `@slopcad/ui`                  | 131 across public components/lib modules | coherent — see registry note                   |

Enumeration epoch: **post-audit-removals** — every count above is
re-derived from the barrels as they stand _after_ the four accidental
exports in the next section were removed (cad-core 553, cad-react 591,
cad-sketch 177; the pre-removal enumeration had been 556 / 594 / 178,
differing by exactly the 3 + 1 removed exports). A future re-counter
should compare against this epoch, not the pre-removal numbers.

"Coherent" means: every export either (a) is consumed outside its defining
module by production sibling code, another workspace package, the app, the
e2e suites, or the consumer fixture; (b) is consumed by the package's own
colocated suite (the repo's dogfooding convention — tests import from
`./index`); (c) appears in the signature of a public function/component
(union members, `Serialized*` wire types, hook API types, prop types —
removing these would break consumers' ability to name what the API
returns/accepts); (d) is contract vocabulary following a documented
convention (the `*_ERROR_CODES` tables behind the stable
`ParseResult`/`<format>/<cause>` failure convention, guard twins of
exported string-literal unions, CRUD symmetry like `remove*` for every
`add*`, and companion constants of exported unions); or (e) is a documented
family (the guides document families with wildcards where each member is
not named individually — e.g. `CAD_SCENE_*` in guides/r3f.md).

### Registry note for `@slopcad/ui`

The shadcn primitives in `packages/ui/src/components` (Card, Dialog, Select,
Tooltip, the formedible subsystem, …) are consumed primarily through the
**registry artifacts** (`packages/ui/registry.json` → `shadcn build` →
`packages/ui/public/r/**`), not through workspace imports — the Phase 33
inversion. `pnpm registry:validate` enforces that their item sources carry
no monorepo-internal dependencies, and `pnpm registry:regenerate` proves the
install path end to end in the external consumer fixture. Their surface is
therefore judged against the registry, not the workspace import graph.

## Accidental exports removed (with evidence)

Four exports had **no consumer anywhere** (not sibling production modules,
not the package's own tests, not other packages, not the app or e2e suites,
not the consumer fixture), **no documentation reference**, and **no
contract role** (not signature-required, not a guard twin, not CRUD
symmetry, not a documented family). Each was made module-private and removed
from its barrel; both affected packages' suites pass unchanged
(cad-core 746/746, cad-sketch 124/124, typechecks clean — the mechanical
proof nothing depended on them):

| Export                  | Package    | Was                                                                                          | Why accidental                                                                                                                                                                                                      |
| ----------------------- | ---------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bodyBoundsCenter`      | cad-core   | `tool-rotate.ts` internal helper (rotate-tool bounds-center math), re-exported by the barrel | used only inside `tool-rotate.ts`; undocumented                                                                                                                                                                     |
| `sweptAngleAboutZ`      | cad-core   | `tool-rotate.ts` internal helper (rotate-tool angle math)                                    | used only inside `tool-rotate.ts`; undocumented                                                                                                                                                                     |
| `surfaceOfRenderObject` | cad-core   | `distance.ts` internal step of `measureEntityOfReference`/`measureEntityOfSnapshotEntity`    | used only inside `distance.ts`; undocumented                                                                                                                                                                        |
| `profileSegmentSweep`   | cad-sketch | `profile.ts` internal step of loop resolution                                                | used only inside `profile.ts`; its doc comment claimed "exposed for kernel adapters", but the boundary map forbids kernel adapters from importing cad-sketch — architecturally impossible consumer, stale rationale |

## Package boundary verdict — HOLDS

The production import graph was scanned file-by-file (imports and dynamic
`import()`s, production code distinguished from test code) against the
allowed-import map of [dependency-map.md](dependency-map.md) and
[guides/package-boundaries.md](../guides/package-boundaries.md). The
measured production edges:

```text
cad-core             (no external imports)
cad-kernel           cad-core, node:worker_threads, vitest (contract-suite only)
cad-kernel-manifold  cad-core, cad-kernel, manifold-3d, node:worker_threads
cad-kernel-occt      cad-core, cad-kernel, replicad-opencascadejs, occt-import-js,
                     node:worker_threads
cad-jscad            cad-core, cad-kernel, @jscad/modeling
cad-react            cad-core, react (peer)
cad-r3f              cad-core, cad-react, react/three/@react-three/fiber (peers)
cad-sketch           cad-core
cad-io               cad-core, cad-kernel, node:zlib (3MF deflate import)
cad-components       cad-core, cad-kernel (+ jscad/manifold via kernel-cases, below)
```

Zero violations in production code. Three documented, deliberate exceptions
live inside `src/` (all declared as devDependencies, all excluded from the
runtime barrel):

- `cad-kernel/contract-suite.ts` imports `vitest` — the shared conformance
  suite is test tooling; the barrel comment documents importing it from the
  `./contract-suite` subpath instead.
- `cad-components/kernel-cases.ts` imports `@slopcad/cad-kernel-manifold`
  and `@slopcad/cad-jscad` — the backend case list for the colocated
  suites; its header documents "not exported from the package index".
- Test files import backend kernel packages (devDependencies) in
  cad-components, cad-io, and cad-kernel-occt's cross-kernel equivalence
  suite — the multi-kernel proofs the plan requires.

No CAD package imports `@slopcad/db`, `@slopcad/auth`, `@slopcad/api`,
`@slopcad/ui`, or the app. `packages/ui`'s production imports reach only
public renderer surfaces (cad-r3f, cad-react, cad-kernel,
cad-kernel-manifold) — no kernel internals.

## Kernel-implementation-type-leak verdict — CLEAN

No Manifold, OpenCascade, or JSCAD type is nameable through any public
barrel:

- `cad-kernel-manifold`'s `ManifoldRuntime` and `cad-kernel-occt`'s
  `OcctRuntime` are **branded opaque**: the payload
  (`ManifoldToplevel` / `OpenCascadeInstance`) sits behind a
  module-private `RUNTIME_BRAND` symbol that is deliberately NOT re-exported
  from either index, so consumers can pass handles around but cannot
  construct, read, or name the kernel object inside. (Type-level nuance,
  recorded honestly: the brand payload's declaration means a consumer's
  typecheck must be able to resolve `manifold-3d`/`replicad-opencascadejs`
  type declarations when it names `ManifoldRuntime` itself — a declaration
  graph reference, not a value-level leak; no kernel object ever crosses
  the surface.)
- `cad-jscad`'s surface is kernel-neutral solids/measurements only; its
  barrel exports no `@jscad/modeling` type.
- Geometry crosses kernel boundaries exclusively as the kernel-neutral
  `Tessellation`/`KernelBounds`/mass-property shapes of the
  `@slopcad/cad-kernel` contract.

## React-leak-into-cad-core verdict — CLEAN

- Zero `react` imports in `packages/cad-core/src` (production or test;
  measured by the import-graph scan), zero `.tsx` files, and no react
  dependency of any kind in its manifest.
- The guarantee is not just audited but **mechanically pinned** by
  `packages/cad-core/src/headless.test.ts`: it greps the source tree for
  React/renderer imports and executes the full session/tools surface
  headless in plain Node. The audit re-verified both properties.
- The apparent `document.`/`window.`-style matches in cad-core sources are
  the `CadDocument` domain variable, not the DOM global (cad-core runs in
  the node vitest environment without jsdom — the suites would fail
  otherwise).

## Stability model (the "unstable APIs" answer)

Nothing is published; every package is `private: true` at version `0.0.0`,
so the honest statement is: **the entire surface is pre-1.0 and unpublished,
and no compatibility promise has been made to any external consumer yet.**
Inside that, the audit found no ad-hoc experimental markers; stability is
carried by explicit, forward-only versioned contracts:

| Contract                          | Constant                        | Version |
| --------------------------------- | ------------------------------- | ------- |
| Document substrate format         | `CAD_DOCUMENT_FORMAT_VERSION`   | 1       |
| Native parametric document format | `CAD_NATIVE_FORMAT_VERSION`     | 1       |
| Render projection wire format     | `CAD_PROJECTION_FORMAT_VERSION` | 1       |
| Worker message protocol           | `WORKER_PROTOCOL_VERSION`       | 1       |
| Sketch format                     | `SKETCH_FORMAT_VERSION`         | 1       |
| Component contract (registry)     | `COMPONENT_CONTRACT_VERSION`    | "1.0"   |

Each has a forward-only migration path (`native-migration.ts`'s registry —
empty by design until real old-shape documents exist; the migration
mechanism is proven by injected synthetic migrations in its suite). The
stability conventions that hold across the surface: failure codes are
stable `<domain>/<cause>` strings (`*_ERROR_CODES` tables are the contract),
error classes are structured (not thrown strings), and serialization is
deterministic (pinned byte-identical by the golden fixtures and the
render suite). The one surface labeled with a weight rather than a promise
is the OCCT adapter — deliberately optional (a ~22 MB WASM binding with a
100 MB heap floor; nothing in the app graph pulls it until a caller chooses
the `opencascade` backend).

## Wildcard subpath surface (recorded judgment)

The `./*` export maps make every module under `src/` importable by
subpath. This is a deliberate design (source-consumed workspace packages;
the barrels' own comments direct kernel implementers to subpaths like
`./contract-suite` and `./node-worker-channel`, and the app consumes
`@slopcad/cad-kernel-occt/occt-worker.web` this way). The audit records the
consequence honestly: the **contract surface is the barrel** (and the
documented subpaths the guides name); other subpaths exist but are not
documented API and may change without notice — the guides are the
reference, per docs/README.md's rule that the code and guides disagree ⇒
the guide is fixed.

## Cross-reference against the Phase 34 guides

Every guide was scanned for the API names it documents; the guide-named
APIs all exist and are exported (checked-types). Conversely, primary-surface
APIs are guide-covered (foundations, geometry, rendering/interaction, data
exchange, sketching, distribution, engineering — the docs/README.md topic
map), with family-level documentation (`CAD_SCENE_*`, `*_ERROR_CODES`,
`Serialized*`) covering the vocabulary members. The `pnpm test:docs` gate
(14 tests) pins the docs app renders the runnable examples; the
docs-examples suite executes every example the guides state outcomes for.
Public API matches the documented surface.
