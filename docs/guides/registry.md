# Registry

The Phase 33 distribution model: three source registries author
shadcn-style items; `shadcn build` emits byte-reproducible artifacts; an
external consumer installs them with the ordinary shadcn CLI over
loopback HTTP — the identical code path a published registry would use.
Nothing is on npm (owner decree); nothing is published anywhere.

## The three source registries

| Registry                                | Items                                                                                                                                                          |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/ui/registry.json`             | 16 shadcn primitives, Formedible, the 11 `cad-*` components, the `plate-workbench` example block                                                               |
| `packages/cad-components/registry.json` | `component-contract`, `component-kernel`, `cad-component`, `context-kernel`, `nema17-mount`, `arduino-mount`, `enclosure`, the `nema17-assembly-example` block |
| `apps/web/registry.json`                | the 7 headless tools: 4 inspection (`bounds`, `distance`, `mass-properties`, `radius`) + 3 feature (`extrude`, `revolve`, `hole`)                              |

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

## Provenance

The regenerate script is the single source of truth for what "the
registry works" means — this guide's commands are its commands, and the
clean-consumer proof in [installation.md](installation.md) is its
execution log.
