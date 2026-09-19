# CAD consumer fixture (Phases 16 + 33)

An EXTERNAL consumer project: a fresh Vite + React 19 + Tailwind v4 app that
is **not** a member of the monorepo workspace. It installs EVERY registry
category (CAD UI components, parametric CAD components, examples, headless
tools) exactly the way an external consumer would — through the shadcn CLI,
from the **locally generated registry artifacts** in `packages/ui/public/r`.
Nothing is published to any remote registry or npm; publishing happens only
if the owner explicitly decides.

## Layout

- `src/App.tsx` — the consumer's page: the installed `PlateWorkbench`
  example (33.3, itself composed of the CAD UI components of 33.1), the
  consumer-authored NEMA 17 component preview (33.2 render proof), and the
  installed headless tools summary (33.4).
- `src/consumer/component-preview.tsx` — the consumer's own usage of the
  installed component-contract/kernel/component files: the NEMA 17 mount
  built through `directComponentKernel` over the Manifold kernel,
  projected, rendered by the installed `CadViewport`; the installed
  `CadParameterPanel` (Formedible) edits the component's OWN contract
  parameters in prop mode; every edit rebuilds real geometry. The
  installed `nema17-assembly-example` runs alongside for its measured
  total.
- `src/consumer/tool-usage.ts` — imports the seven installed headless
  tools and invokes each inspection tool once (honest null semantics),
  keeping the feature tools type- and bundle-checked.
- `src/lib/utils.ts` — the consumer-owned `cn` helper (as `shadcn init`
  would create; the registry items do not ship it).
- `src/components/**`, `src/cad/**`, `src/examples/**` — INSTALLED by the
  shadcn CLI from the local artifacts (they are the proof; the regenerate
  script deletes and reinstalls them from scratch).
- `components.json` — consumer aliases plus the `@slopcad` registry
  namespace pointing at `http://127.0.0.1:46219/{name}.json`.

## How the install works

1. Three source registries author the items (Formedible-style per-package
   authoring): `packages/ui/registry.json` (UI components + the
   plate-workbench example), `packages/cad-components/registry.json` (the
   contract, the kernel adapters, the three parametric components, the
   assembly-study example), and `apps/web/registry.json` (the headless
   workbench tools). `scripts/registry-build.sh` runs `shadcn build` for
   each into `packages/ui/public/r/` and merges the union index
   (`scripts/registry-index.mjs`).
2. This fixture registers the namespace in `components.json`:
   `"@slopcad": "http://127.0.0.1:46219/{name}.json"`.
3. `shadcn add @slopcad/<item>` resolves the items AND their
   `@slopcad/*` registry dependencies over loopback HTTP — the identical
   code path a real remote registry would use. Item `target` fields remap
   the authored sources into the consumer's `src/cad/**` layout.
4. npm dependencies declared by the items (`cn`, `@base-ui/react`,
   `@tanstack/react-form`, `manifold-3d`, …) install from npm. The
   `@slopcad/cad-*` packages are NOT on npm (owner decree): the fixture
   pre-declares them as `file:` links to the workspace packages, and the
   CLI's installer skips dependencies already present in the consumer's
   manifest.

### Why the fixture is its own tiny workspace

The linked CAD packages' manifests use pnpm's `workspace:*` and `catalog:`
protocols internally (they are workspace members of the MONOREPO). The
fixture's `pnpm-workspace.yaml` registers them as members by path and
mirrors the catalog entries they reference, so those protocols resolve
locally — the stand-in for real published packages, which would need none
of this. The install is FILTERED (`pnpm install --filter .`) so the shared
packages' `node_modules` stay owned by the monorepo install. The tsconfig
additionally pins `@slopcad/cad-kernel` (and its `/opaque` deep import) to
one module tree: the file: copies and the workspace-member symlinks are two
module identities, and the kernel's branded opaque types are nominal.

### Peer-version discipline

The linked sources resolve `react`/`three` peers through the monorepo's
node_modules while the fixture installs its own copies, so the fixture pins
`react`/`react-dom` to the same exact versions and `vite.config.ts` dedupes
`react`, `react-dom`, `three`, and `@react-three/fiber` — one module
instance per package in the bundle.

## Commands

```bash
# one-shot, from the repo root: rebuild all registries + reinstall fixture + gates
pnpm registry:regenerate          # = bash scripts/cad-registry-regenerate.sh

# registry-only commands
pnpm registry:build               # build all three source registries + merge index
pnpm registry:validate            # source + artifact validation (no workspace refs, byte-fresh)

# manual steps inside the fixture
pnpm install --filter .           # fixture dependencies
pnpm exec shadcn add ...          # (with the artifacts served on 127.0.0.1:46219)
pnpm check-types                  # gate 1
pnpm build                        # gate 2 (tsc --noEmit && vite build)
pnpm smoke                        # gate 3: Playwright, software WebGL
```

The smoke test drives the real session end to end: the kernel build
settles the workbench viewport, the toolbar mirrors the four tools, the
tree mirrors the document, a panel edit (`holeDiameter` 8 → 12, Apply)
produces a new build and a new settled frame; the component preview
builds the NEMA 17 mount, settles, and a contract edit (`plateSizeMm`
46 → 52, Rebuild) changes the measured volume; the tools list renders
with a real outcome per tool. Full-page screenshots are written to
`e2e-artifacts/` (`smoke.png` byte-stable across runs; the mid-test
captures share the canvas fractional-position nondeterminism documented
since Phase 32).
