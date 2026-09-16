# CAD consumer fixture (Phase 16)

An EXTERNAL consumer project: a fresh Vite + React 19 + Tailwind v4 app that
is **not** a member of the monorepo workspace. It installs the four CAD
components (viewport, toolbar, model tree, parameter panel) exactly the way
an external consumer would — through the shadcn CLI, from the **locally
generated registry artifacts** in `packages/ui/public/r`. Nothing is
published to any remote registry or npm; publishing happens only if the
owner explicitly decides.

## Layout

- `src/App.tsx` — the composed CAD usage: the four installed components
  around one real provider store (`createCadStore` + `CadProvider`).
- `src/cad/consumer-document.ts` — the consumer's own parametric document
  (plate body, `holeDiameter`, translate feature, expression-driven
  `volumeHint`), built through the public `@slopcad/cad-react` API.
- `src/cad/plate-geometry.ts` — real geometry on the main thread: the
  Manifold kernel (WASM) builds the plate (box minus bore, translated),
  `projectTessellation` + `createRenderProjection` produce the projection
  the installed `CadViewport` draws. Panel edits produce a new document, a
  new build, and a new settled frame.
- `src/lib/utils.ts` — the consumer-owned `cn` helper (as `shadcn init`
  would create; the registry items do not ship it).
- `src/components/**` — INSTALLED by the shadcn CLI from the local
  artifacts (gitignored? no — they are the proof; the regenerate script
  deletes and reinstalls them from scratch).
- `components.json` — consumer aliases plus the `@slopcad` registry
  namespace pointing at `http://127.0.0.1:46219/{name}.json`.

## How the install works

1. `packages/ui` defines the source-oriented registry (`registry.json`,
   21 items). `shadcn build` emits one JSON artifact per item into
   `packages/ui/public/r/`.
2. This fixture registers the namespace in `components.json`:
   `"@slopcad": "http://127.0.0.1:46219/{name}.json"`.
3. `shadcn add @slopcad/cad-viewport @slopcad/cad-toolbar @slopcad/cad-model-tree @slopcad/cad-parameter-panel`
   resolves the items AND their `@slopcad/*` registry dependencies (button,
   the primitives, the whole `formedible` subsystem) over loopback HTTP —
   the identical code path a real remote registry would use.
4. npm dependencies declared by the items (`cn`, `@base-ui/react`,
   `@tanstack/react-form`, …) install from npm. The `@slopcad/cad-*`
   packages are NOT on npm (owner decree): the fixture pre-declares them as
   `file:` links to the workspace packages, and the CLI's installer skips
   dependencies already present in the consumer's manifest.

### Why the fixture is its own tiny workspace

The linked CAD packages' manifests use pnpm's `workspace:*` and `catalog:`
protocols internally (they are workspace members of the MONOREPO). The
fixture's `pnpm-workspace.yaml` registers them as members by path and
mirrors the catalog entries they reference, so those protocols resolve
locally — the stand-in for real published packages, which would need none
of this. The install is FILTERED (`pnpm install --filter .`) so the shared
packages' `node_modules` stay owned by the monorepo install.

### Peer-version discipline

The linked sources resolve `react`/`three` peers through the monorepo's
node_modules while the fixture installs its own copies, so the fixture pins
`react`/`react-dom` to the same exact versions and `vite.config.ts` dedupes
`react`, `react-dom`, `three`, and `@react-three/fiber` — one module
instance per package in the bundle.

## Commands

```bash
# one-shot, from the repo root: rebuild registry + reinstall fixture + gates
bash scripts/cad-registry-regenerate.sh

# manual steps
pnpm install --filter .        # fixture dependencies
pnpm exec shadcn add ...       # (with the artifacts served on 127.0.0.1:46219)
pnpm check-types               # gate 1
pnpm build                     # gate 2 (tsc --noEmit && vite build)
pnpm smoke                     # gate 3: Playwright, software WebGL
```

The smoke test drives the real session: kernel build settles the viewport,
the toolbar mirrors the four tools, the tree mirrors the document, a panel
edit (`holeDiameter` 8 → 12, Apply) produces a new build and a new settled
frame, and a full-page screenshot is written to
`e2e-artifacts/smoke.png`.
