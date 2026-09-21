# Features

Features are the parametric heart: a `FeatureRecord` in the document
declares a `kind`, typed `inputs` (references to bodies, parameters,
features, or reference records), and `outputs` (bodies it produces).
Regeneration interprets the records against a kernel; the document
records intent, the kernel produces geometry.

## Authoring

```ts
doc = addFeature(doc, {
  id: F_HOLE,
  kind: "hole",
  inputs: [
    { kind: "feature", id: F_BOX }, // the upstream solid
    { kind: "parameter", id: pDiameter }, // hole diameter (length)
    { kind: "parameter", id: pDepth }, // blind depth (length)
    { kind: "parameter", id: pX },
    { kind: "parameter", id: pY },
    { kind: "parameter", id: pAxis }, // dimensionless axis selector (1|2|3)
  ],
  outputs: [B_HOLED],
}).value.document;
```

The bridge vocabulary is `BRIDGE_FEATURE_KINDS` (`@slopcad/cad-kernel`'s
`core-bridge`): `box`, `sphere`, `cylinder`, `cone`, `union`,
`subtract`, `intersect`, `translate`, `extrude`, `revolve`, `sweep`,
`loft`, `fillet`, `chamfer`, `shell`, `patternLinear`,
`patternCircular`, `mirror`, `hole` — each kind documents its input
contract in the `core-bridge.ts` header.

## Sweep and loft (Phase 38)

`sweep` carries two sketch inputs — the profile first, the path second —
and no dimension parameters (the path determines the extent). The profile
resolves like an extrude's; the path resolves through the executor
context's optional `paths` resolver, mapping the sketch's chain onto the
kernel contract's local XZ plane by coordinate identity (sketch
`(x, y)` → path `(x, z)`): the path must START at the sketch origin and
rise along +y (the profile plane's normal). A kernel that does not
declare the `sweep` capability (Manifold) refuses at the bridge gate
before any resolution.

```ts
const bridge = createKernelFeatureExecutor(kernel, {
  document,
  bodies: new Map(),
  profiles, // (sketchId) => { loop, placement }
  paths, // (sketchId) => { path } — cad-sketch's resolveSweepPath behind it
});
// feature: { kind: "sweep", inputs: [sketch profile, sketch path], outputs: [body] }
```

`loft` carries N section sketch inputs plus N length parameters (each
section's station z, matched by declared position; the order IS the loft
direction). All sections must resolve on the FIRST section's workplane
frame; the kernel's own battery judges member validity, vertex-count
compatibility, and strictly increasing stations. Kernels without the
`loft` capability decline at the gate the same way; the workbench
surfaces both declines as the structured
`kernel/unsupported-operation` on its error surface.

## Transactions, undo, redo

Features and parameters change through commands — the vocabulary is
`CAD_COMMAND_TYPES` (`parameter.set`, `parameter.create`,
`feature.create`, `feature.update`, `feature.delete`, `feature.reorder`,
`body.create`, `sketch.create`, `reference.create`) — committed as
atomic `CadTransaction`s through a session:

```ts
import {
  createSession,
  applySessionTransaction,
  undoSession,
  redoSession,
  canUndo,
} from "@slopcad/cad-core";

let session = createSession(doc);
session = applySessionTransaction(session, { commands: [/* … */] }).value;
const undone = undoSession(session).value; // every command lands or nothing does
const back = redoSession(undone).value;
```

The history keeps a snapshot per commit; the native format persists the
log AND the state (see [native-files.md](native-files.md)).

## Regeneration

`regenerate({ features, states, suppressed, execute, rollbackPoint? })`
walks features in dependency order (`featureEvaluationOrder`), skipping
suppressed ones and parking everything after the rollback marker. The
executor comes from `createKernelFeatureExecutor(kernel, { document,
bodies, profiles })` — one bridge per run, one kernel per bridge. States
move through `valid | stale | failed | suppressed` (`FEATURE_REGENERATION_STATES`);
after a parameter edit, `documentChangeInvalidations(prev, next)` plus
`markStale` mark exactly the affected features, and the next run passes
the prior solids through the context's `bodies` so untouched features
keep their geometry. `featureTimeline` renders the joined view the UI's
timeline strip shows.

## The runnable example

`packages/docs-examples/src/kernel/features.ts` builds the box → hole
document, runs it over a real kernel (volume 6000 − π·4²·4 mm³), edits
the hole diameter 8 → 10 through `parameter.set`, stale-marks, re-runs,
and reports both volumes and the executed feature ids — the asserted
proof that the edit re-executed only what it touched.
`src/core/history.ts` is the transaction/undo/redo half.
