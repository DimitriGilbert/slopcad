# Selection

Selection is **session data, not document data** — it has no transaction
history, and the native format has no field that could carry it. The
model lives in cad-core's `selection.ts`.

## References

- **Stable references** survive regenerations: `{ kind: "body", bodyId }`,
  `{ kind: "feature", featureId }`, `{ kind: "solid", bodyId }`
  (`STABLE_SELECTION_KINDS`).
- **Synthetic references** address the current geometry: a synthetic
  face, edge, or vertex of a body's topology at one regeneration
  (`SYNTHETIC_SELECTION_KINDS`). They die with that regeneration —
  `beginRegeneration` advances the identity and stale synthetic
  references fail structurally, which is the Phase 12 transience rule.

## The state machine

```ts
import {
  createSelectionState,
  pickSelection,
  hoverSelection,
  clearSelection,
  selectionReferenceKey,
} from "@slopcad/cad-core";

let selection = createSelectionState(0); // regeneration identity
selection = pickSelection(
  selection,
  { kind: "body", bodyId: PLATE_BODY },
  { additive: false }, // single mode replaces…
).value; // …multi mode toggles
const hovered = hoverSelection(selection, {
  kind: "body",
  bodyId: PLATE_BODY,
}).value;
selectionReferenceKey(hovered.selected[0]!); // "body|body_plate" — stable key
```

Serialize with `serializeSelectionState` / `parseSelectionState` (the
wire form the R3F picking layer speaks).

## Persistent topology references

Synthetic references are transient by design; persistent selection needs
the Phase 22 layer (`persistent-reference.ts` + the OCCT kernel's
`topologySnapshot`):

- `mintTopologyReference` / `resolveTopologyReference` /
  `repairTopologyReference` — a reference carries an identity payload
  (the OCCT shape hash), a body-relative geometric descriptor, and
  provenance; after a regeneration it resolves, repairs, or reports
  invalidity (`REFERENCE_VALIDITY_STATES`, `REFERENCE_REPAIR_STRATEGIES`)
  with tolerances pinned by constants
  (`REFERENCE_POSITION_TOLERANCE_MM`, `REFERENCE_MEASURE_RELATIVE_TOLERANCE`).
- Only the OpenCascade backend declares `persistentTopology: true` —
  its BREP carries `TopoDS` identities. The full decision record is
  `docs/architecture/adr-persistent-references.md`.

Document reference records persist through `addDocumentReference` (the
`reference.create` command), and the topology-addressed features
(fillet/chamfer/shell) consume them through the executor's topology view.

## The runnable example

`packages/docs-examples/src/core/projection.ts` drives the machine — a
single-mode body pick, a toggled feature pick (on then off), and a
hover; the suite pins the surviving selection key
`"body|body_guide_plate"`.
