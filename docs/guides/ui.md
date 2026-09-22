# UI

`@slopcad/ui` is the shadcn-style component package: the CAD workbench
components plus the shadcn primitives they compose with (button, card,
dialog, command, field, select, …) and the Formedible schema-driven form
renderer. It is consumed as source (`exports` point at `./src/*`), and
every CAD component is ALSO a registry item an external app installs
with the shadcn CLI.

## The CAD components

| Item                                                                | What it is                                                                                                                                                                              |
| ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cad-viewport`                                                      | the deterministic R3F scene + picking + overlay plumbing, with the Phase 45 passthrough props (`userCamera`, `onUserCamera`, `displayMode`) typed off the scene's own component surface |
| `cad-toolbar`                                                       | the tool palette, mirrored from the store's tool surface                                                                                                                                |
| `cad-model-tree`                                                    | the document's bodies/features timeline                                                                                                                                                 |
| `cad-parameter-panel`                                               | Formedible parameter editing (documents AND component contracts)                                                                                                                        |
| `cad-command-menu`                                                  | the command palette                                                                                                                                                                     |
| `cad-io-dialog`                                                     | import/export affordances (host wires `@slopcad/cad-io`)                                                                                                                                |
| `cad-property-panel`                                                | per-selection properties                                                                                                                                                                |
| `cad-sketch-canvas` / `cad-sketch-inspector` / `cad-sketch-toolbar` | the sketch editing surface                                                                                                                                                              |
| `cad-status-bar`                                                    | regeneration/selection status                                                                                                                                                           |

All of them are prop-driven over the store's mirrored state — mount
`CadProvider` (from `@slopcad/cad-react`) and read the hooks
(`useCadDocument`, `useCadParameters`, `useCadSelection`,
`useCadTools`, `useCadHistory`, `useCadModel`). The workbench
(`apps/web/src/cad-workbench/`) is the reference composition; the
registry's `plate-workbench` example block composes the same components
for consumers.

## Installing into an external app

```bash
pnpm exec shadcn add "@slopcad/cad-viewport" "@slopcad/cad-toolbar" \
  "@slopcad/cad-model-tree" "@slopcad/cad-parameter-panel" -y --overwrite
```

with the `@slopcad` namespace pointing at the registry artifacts (the
full walkthrough, including the `file:` package links and peer pins the
install needs today, is [registry.md](registry.md) and
[installation.md](installation.md)). The installed files are the proof:
`fixtures/cad-consumer` deletes and reinstalls all of them from scratch
in the `registry:regenerate` gate.

## Forms

Every form in the repo is Formedible (`packages/ui/src/components/formedible`)
— a schema-driven renderer over TanStack Form. The parameter panel and
the sketch inspector are config objects (schema + field list), not
hand-rolled TSX; extending them means adding fields to a list.

## Gates

Component-level: `packages/ui`'s vitest suite. Browser:
`pnpm test:components` (12 registry component previews) and the workbench
suites. The `/docs` page uses the viewport and badge primitives live.
