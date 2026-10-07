# Registry

The Phase 33 distribution model: three source registries author
shadcn-style items; `shadcn build` emits byte-reproducible artifacts; an
external consumer installs them with the ordinary shadcn CLI over
loopback HTTP — the identical code path a published registry would use.
Nothing is on npm (owner decree); nothing is published anywhere.

## The three source registries

| Registry                                | Items                                                                                                                                                                                                                                       |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/ui/registry.json`             | the flat shadcn primitives (the chat-flavored `bubble`/`message`/`message-scroller` among them), Formedible, the `cad-*` component set including `cad-configuration-panel`, and the `plate-workbench` and `agent-chat-panel` example blocks |
| `packages/cad-components/registry.json` | `component-contract`, `component-kernel`, `cad-component`, `context-kernel`, `nema17-mount`, `arduino-mount`, `enclosure`, the `nema17-assembly-example` block, the `parametric-cad-viewer` block                                           |
| `apps/web/registry.json`                | the 8 headless tools: 4 inspection (`bounds`, `distance`, `mass-properties`, `radius`) + `datum` + 3 feature (`extrude`, `revolve`, `hole`)                                                                                                 |

The table names categories, not totals — items ship over time and hard
counts go stale. `pnpm registry:validate` is the mechanical source of
truth for the exact item set.

## The pipeline

```bash
pnpm registry:build       # shadcn build × 3 → packages/ui/public/r/ + merged index
pnpm registry:validate    # shadcn registry validate × 3 + the repo's own validator:
                          #   no monorepo-internal dependencies, artifacts byte-fresh
pnpm registry:regenerate  # the whole proof, from nothing:
                          #   rebuild → validate → reset fixtures/cad-consumer
                          #   (rm node_modules, installed src/, lockfile) →
                          #   filtered install → shadcn add every category →
                          #   check-types → build → Playwright smoke
```

The consumer registers the namespace in `components.json`:
`"@slopcad": "http://127.0.0.1:46219/{name}.json"`. Items declare their
`@slopcad/*` registry dependencies, so one `shadcn add` pulls the whole
closure — installing `plate-workbench` brings the viewport, the panels,
Formedible, and the primitives.

## The not-on-npm stand-in

The installed item sources import the public CAD packages, which are not
published. The reference consumer therefore:

1. pre-declares them as `file:` links
   (`"@slopcad/cad-core": "file:../../packages/cad-core"`, …);
2. registers them in its tiny `pnpm-workspace.yaml` so the packages'
   internal `workspace:*`/`catalog:` protocols resolve locally;
3. pins `react`/`react-dom`/`three` to the monorepo's exact versions and
   dedupes them in `vite.config.ts` — the kernel's branded opaque types
   are nominal, and two module identities would break them;
4. installs filtered (`pnpm install --filter .`) so the shared packages'
   `node_modules` stay owned by the monorepo.

Real published packages would need none of this; the fixture documents
it in `fixtures/cad-consumer/README.md`.

## The parametric viewer block

`parametric-cad-viewer` (authored in `packages/cad-components`, final
phase) is one installable answer to "a component that draws the part and
the Formedible for the variables": the CAD viewport on the left, the
parameter panel's edit-mode Formedible form on the right.

```tsx
import { ParametricCadViewer } from "@/cad/viewer/parametric-cad-viewer";

<ParametricCadViewer
  nativeText={nativeDocumentText}
  bodies={[{ bodyId, tessellation }]} // your kernel's tessellate() output
  rebuild={async ({ document }) => rederiveBodies(document)}
/>;
```

- `nativeText` — the part's native document text, parsed by the format's
  own full parser; its parameters become the form's fields.
- `bodies` — the part's tessellated bodies (`null` while your kernel
  works). The block projects them through the public cad-core projection
  path and frames a deterministic home camera from the part's own bounds
  (or your `camera` prop).
- Edits — every applied edit commits a real `parameter.set` transaction
  over a real public `createCadStore`: the domain's single interpreter
  re-evaluates expressions and dependents. `onDocumentChange` emits the
  edited session's canonical native text; `rebuild` receives it and
  returns fresh tessellations, which the block re-renders (stale rebuilds
  are dropped, rejected ones surface verbatim in the status region).

**The honest capability boundary:** the block renders and edits; it does
not evaluate geometry. The native format's feature graph is
host-interpreted (the workbench's worker-backed engine), and no public
package exposes that evaluation — so re-derivation after an edit is the
consumer's side of the loop (`rebuild`, or `onDocumentChange` with your
own scheduling). Without `rebuild` the block is emit-only: parameter
edits update the document and fire the callback, and the rendered
geometry stays at the tessellations you supplied — no faked re-drive.
Bring your own kernel (the main-thread Manifold kernel the
`plate-workbench` block drives is one documented path).

The pure half (`parametric-viewer-core`: parse, summary, projection,
camera framing, re-serialization) is React-free and unit-tested in
`@slopcad/cad-components`; the composition is a thin TSX over that core
plus the two registry items it declares as dependencies
(`@slopcad/cad-viewport`, `@slopcad/cad-parameter-panel`).

## Provenance

The regenerate script is the single source of truth for what "the
registry works" means — this guide's commands are its commands, and the
clean-consumer proof in [installation.md](installation.md) is its
execution log.
