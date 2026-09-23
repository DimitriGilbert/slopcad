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
`loft`, `helix`, `thread`, `fillet`, `chamfer`, `shell`,
`patternLinear`, `patternCircular`, `patternFeature`, `patternPath`,
`patternFace`, `mirror`, `hole`, `rib`, `scale`, `thicken`, `split`,
`moveFace`, `replaceFace`, `deleteFace` — each kind documents its input
contract in the `core-bridge.ts` header.

## Patterns and mirror (Phase 26.8/26.9; completion Phase 43)

Patterns are FEATURE-LEVEL COMPOSITION, never kernel operations: the
bridge issues one `transform` per copy and one `union` at the end, so
every kernel that translates and unions runs every pattern.

- `patternLinear` — one target, count + spacing, and a direction: an
  ANGLE parameter (counter-clockwise in the world XY plane), a DATUM
  AXIS input (the resolved axis's full 3D direction — Phase 43's
  generalization), or a SKETCH input (the resolved open chain's
  end−start direction, sketch `(x, y)` → world `(x, 0, z)`).
- `patternCircular` — count copies at `i·Δ` about a world axis or a
  resolved DATUM AXIS. Rotations need the `transformRotation`
  capability: the bridge gates BEFORE any call, so a rotation-less
  kernel refuses structurally instead of silently stacking copies.
- `patternFeature` (Phase 43) — the FEATURE RANGE: one or more
  feature/body inputs repeated as ONE group, over asymmetric
  direction+count+spacing LEG triples (greedily parsed: legs read
  (angle, dimensionless, length); the trailing dimensionless
  parameters are SKIP ordinals naming instances that drop out of the
  union). `parameter.set` on any leg number or skip ordinal re-drives
  the whole arrangement.
- `patternPath` (Phase 43) — one target, one sketch path (the sweep's
  `paths` seam; the chain's local `(x, z)` rides the world XZ plane),
  count + spacing (arc length) + orientation (1 fixed, 2
  tangent-follow — the latter gated on `transformRotation`).
  `@slopcad/cad-kernel`'s `path-geometry` walk (`sweepPathStationAt`)
  is the one source of the stations.
- `patternFace` (Phase 43) — one target whose own FACE bounds the grid:
  a face REFERENCE (the fillet battery's resolution), the plane through
  the datum seam, and two leg triples; grid points outside the face's
  TESSELLATED boundary drop out (the synthetic-face discipline), and a
  grid that places fewer than two points declines structurally.
- `mirror` — the direct `kernel.mirror` call a reflection's negative
  determinant forces. The datum-plane form (Phase 39) carries an
  optional MERGE parameter (Phase 43): `1`/absent keeps the standalone
  reflection, `2` unions it with the original — the symmetric-part
  route. `planDatumMirror` is the one source of the reflection recipe
  (the direct world-axis mirror or the composed oblique chain), shared
  by the bridge and the workbench's worker scene.

The workbench authors the pattern editor (legs + skips, Formedible),
the path pattern, and the datum-plane mirror with its merge option;
`parameter.set` re-drives each through regeneration.

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

## Helix and thread (Phase 40)

`helix` carries one sketch input (the MERIDIAN profile — sketch
`(x, y)` become the helix's `(radial, axial)` offsets from the spine's
start point, the sweep path-mapping precedent; the sketch's workplane
does not carry), six parameter inputs in declared order (radius LENGTH,
pitch LENGTH, turns DIMENSIONLESS, handedness DIMENSIONLESS ±1, start
angle ANGLE, taper LENGTH — the taper is the total signed radius change),
and an optional datum axis input (Phase 39 reuse: the spine runs on the
datum's resolved line; without one, the world +z axis through the
origin). The kernel contract's `helixSweep` builds the screw solid —
the meridian transport (rotation about the spine axis by the swept
angle, plus the start-point translation) is drift-free by construction,
and the exact volume is `2π·turns·A·d̄` with `A` the profile area and
`d̄` its centroid radius (plus `taper/2` on tapered spines). Kernels
without the `helix` capability (Manifold, JSCAD) refuse at the bridge
gate; the fake kernel's analytic model declines OVERLAPPING turns (a
profile axial extent beyond one pitch over multiple turns) with the
structured `kernel/helix-turn-overlap` rather than overcounting.

```ts
// feature: {
//   kind: "helix",
//   inputs: [sketch profile, p radius, p pitch, p turns, p handedness,
//            p startAngle, p taper, datum axis?],
//   outputs: [body],
// }
```

`thread` carries one feature/body input (the target), five parameter
inputs in declared order (major diameter LENGTH, pitch LENGTH, thread
length LENGTH, mode DIMENSIONLESS 1 external / 2 internal / 3 cosmetic,
handedness DIMENSIONLESS ±1), and the axis — a datum axis input or a
DIMENSIONLESS world-axis selector (1 = X, 2 = Y, 3 = Z, the hole
precedent). The real modes compose `planThreadCut`'s shared ISO tool
(the ISO 68-1 basic profile derived from the pitch: depth `5H/8`,
widths `7P/8`/`P/4` external and `3P/4`/`P/8` internal, flanks at
30°) through `helixSweep` + subtract, entering through the target's +
face along the axis — model the NOMINAL major diameter and thread it,
the shop convention. The ISO metric table
(`ISO_METRIC_THREAD_TABLE`: designation, major diameter, pitch, tap
drill `d − P`) feeds the workbench form's picker; the specification
persists as plain parameters, so `parameter.set` re-drives the thread.
A cut that removes nothing refuses (the hole's no-op guard), and the
COSMETIC mode passes the target through unchanged — annotation data,
no geometry, every kernel.

```ts
// feature: {
//   kind: "thread",
//   inputs: [feature target, p major, p pitch, p length, p mode,
//            p handedness, p axis | datum axis],
//   outputs: [body],
// }
```

## Feature richness (Phase 41)

Five more kinds ride the same bridge:

- `extrude`'s optional THIRD input — an ANGLE parameter, the draft taper.
  Positive tapers narrow the walls away from the sketch plane; the
  cross-sections are the loop's MITER inset (probed equal to OCCT's
  `BRepOffsetAPI_DraftAngle` to 15 digits, concave loops included, so
  every kernel builds the same solid). Gated on `extrudeTaper`
  (Manifold declines — its top-scale is a different solid); the kernel
  battery `kernel/invalid-taper` refuses angles at/past ±90° and tapers
  whose far inset collapses the loop.
- `rib` — one target (feature/body), one sketch (the closed
  cross-section in its own workplane), one thickness LENGTH: the profile
  extrudes by half the thickness on EACH side of its plane and unions
  with the target. A union that added nothing (the profile lies inside
  the target) refuses as a structured no-op — the hole guard, inverted.
  Open-profile extend-to-next-face ribbing is structurally out of scope:
  no contract op exposes the surface raycast an extension needs.
- `scale` — one target, one dimensionless factor: the direct
  `transform` call with the uniform `scale` field (volume ×f³, bounds
  ×f, both hand-derivable). Gated on `transformScale`; non-uniform
  scaling is out until a binding grows a general transform.
- `thicken` — one target, one thickness LENGTH: the CLOSED hollow
  (`kernel.thicken`), the shell feature's complement — uniform walls
  around a sealed interior void. Gated on `thicken` (Manifold and JSCAD
  decline; the fake kernel's analytic subset covers pristine box and
  sphere leaves).
- `split` — one target, one datum PLANE, one side selector (`+1` keeps
  the normal's side, `−1` the opposite): the covering-box cut
  (`planSplitCut`, shared verbatim with the workbench's worker scene)
  rides `extrude` + `subtract`, so every kernel splits. The measured
  post-condition refuses a split that removed nothing or everything.

Each has its workbench command and Formedible form (Draft, Rib, Scale,
Thicken, Split) and re-drives through `parameter.set` on its numbers.

## The local face operations (Phase 44)

Three direct-manipulation kinds over the persistent FACE reference
vocabulary (the fillet/shell resolution battery — one target, exactly
one face reference):

- `moveFace` — one target, one FACE reference, two parameters in order:
  axis (DIMENSIONLESS 1 = X, 2 = Y, 3 = Z) and distance (LENGTH,
  signed). The draft-free local move: the face translates rigidly and
  the neighbours extend or retract; the volume changes by the swept
  prism `A·(n̂·d⃗)` exactly on OCCT. Gated on `localFaceOps`.
- `replaceFace` — one target, one FACE reference, one datum PLANE: the
  solid re-closes at the plane. A parallel plane moves the face to its
  station (extend or shrink); an oblique plane cuts the far half-space
  away (shrink only — the kept side holds the target's volume
  centroid). Gated on `localFaceOps`.
- `deleteFace` — one target, one FACE reference, one DIMENSIONLESS heal
  flag (1 extends the neighbours to close the gap, 0 leaves it open).
  PROBED OUT on every current kernel (the sewn-minus-one shell and
  `ShapeFix_Solid`'s close are both invalid on the OCCT binding — see
  `docs/architecture/occt-prespike-findings.md`): the kind is honest
  surface, its submission surfaces the structured refusal verbatim.

The `translate` kind also grows an OPTIONAL rotation pair (Phase 44's
move-body completion): two further parameters, axis (1|2|3) and angle —
the contract `transform`'s own rotation, applied about the world-origin
axis before the translation, gated on `transformRotation`. Absent pair
= the plain translation, unchanged.

## The surface features (Phases 48–49)

Sheet bodies (the `body.create` command's `kind: "sheet"` marker) are
OPEN shells — they measure area and bounds, tessellate, and render BOTH
sides (`openShell` → DoubleSide), and every solid-consuming operation
declines them structurally. The bridge interprets one sheet-building
profile kind and the Phase 49 surface family (all OCCT-only, gated on
the `sheets` + `surfaceOps` capability pair; other kernels answer the
structured unsupported before any geometry):

- `extrude-surface` (Phase 48) — a sketch profile swept into an open
  wall set (one sketch input, one signed distance parameter).
- `create-sheet` — a DATUM plane input, one DIMENSIONALLESS kind index
  into `SHEET_SURFACE_KINDS` (plane 0, cylinder 1, cone 2, sphere 3,
  torus 4), and the kind's own parameters (the plane kind: u/v bounds).
- `trim-surface` — target SHEET, tool SHEET, keepInside (1 keeps the
  tool's region, 0 cuts it away).
- `thicken-surface` — sheet, thickness LENGTH, side (`+1`/`−1` along
  the faces' carried normals); the product is a CLOSED solid.
- `knit-surface` — two or more body operands, sewing tolerance LENGTH
  (a boundary-consistent knit closes into a solid).
- `offset-surface` — sheet, signed distance LENGTH.

The workbench's surface tab authors the family (toolbar verbs on the
wide tier, the command menu everywhere), and the sheet scene executes
the document's LAST surface feature through the worker matrix
(`solid.createSheet` + `sheet.trim`/`sheet.thicken`/`sheet.knit`/
`sheet.offset`) — an open sheet settles at volume 0 with its area in
the measurement, the thicken solid at its analytic volume.

## Body management (Phase 44)

Body records carry two display flags — `visible` (default true) and
`isolated` (default false) — mutated by the `body.update` command (a
PARTIAL update: only the carried fields change, so rename, visibility,
and isolation each ride their own undoable command):

```ts
doc = applyCommand(doc, {
  type: "body.update",
  id: B_BOSS,
  visible: false, // hide; isolated: true isolates
}).value;
```

The flags serialize additively (emitted only when non-default, so
flagless documents resave byte-identically) and feed the renderer
projection filter (`filterProjectionByBodyDisplay`): hidden bodies
drop, and when ANY body is isolated only the isolated bodies render.
The workbench's model tree carries the affordances — the visibility
eye, the isolation crosshair, and rename (a Formedible form).

## The structured hole (Phase 42)

The flat five-parameter hole grew a TYPE-DIRECTED sibling — one feature,
one type, many positions. A hole feature whose FIRST parameter is a
DIMENSIONLESS value rides the structured form (the flat form's first
parameter is the LENGTH diameter — the dimension is the dispatch, so
the forms never reinterpret each other):

- `type` (1 straight, 2 counterbore, 3 countersink, 4 taper,
  5 threaded) selects the parameter schema — the ordered role list
  `structuredHoleRoles(type, …)` that the feature's parameter inputs
  follow: the type's own dimensions, then `positionX`/`positionY`
  (absent when a SKETCH input carries the positions) and the world
  `axis` selector (absent when a DATUM AXIS input carries the axis).
- Conventions (documented in `hole-specification.ts`, the one source
  both the bridge and the worker scene compose from): DEPTH is the full
  axial extent to the drill TIP point; the tip angle is INCLUDED
  (180° = flat, extent `(d/2)/tan(θ/2)`); blind vs through stays the
  one-distance rule (`depth ≥ extent` drills through, overshooting past
  both faces); a counterbore is entry-measured; a countersink is the
  entry cone to its rim diameter at its included angle; a taper
  narrows from its entry diameter and its through verdict is geometric
  (walls that close first cut a blind taper); a threaded hole drills
  the ISO BASIC MINOR `d₁ = d − 2·(5H/8)` and cuts the Phase 40 ISO
  ridge (the table's tap-drill column is shop advice the picker shows,
  not the modeled pilot).
- The tool is ONE revolved MERIDIAN per position (a straight-edge
  polygon touching the revolve axis) plus, for the threaded type, the
  Phase 40 ridge sweep — `revolve` + `subtract` everywhere (every
  kernel), `helixSweep` for threaded (the `helix` capability: OCCT and
  the fake kernel; Manifold and JSCAD decline the feature structurally
  before any geometry).
- POSITIONS: a sketch input whose POINT entities are the hole centres
  (drawn with the sketch editor's point tool), read as in-plane
  coordinates — one feature, many holes. The sketch's own workplane
  placement does not carry (the sweep path seam's simplification).
- Hole SERIES at assembly level are deferred to assemblies (Phase 52).

```ts
// feature: {
//   kind: "hole",
//   inputs: [
//     feature target,
//     p type, p diameter, p depth, p tipAngle, p cboreDiameter,
//     p cboreDepth, p positionX, p positionY, p axis, // the type's roles
//     sketch positions?, // the point entities — many holes
//     datum axis?,       // parallel drilling along a datum axis
//   ],
//   outputs: [body],
// }
```

The workbench's hole dialog (Formedible) is schema-driven from the same
role lists — the ISO designation picker (Phase 40's table) fills the
threaded type's numbers, the positions picker chooses the parameter
position or a sketch's points, and the preview ghost draws the planned
entry footprint over the settled scene (a pure overlay, never a
dispatch). The composed cut's post-condition is unchanged: a cut that
removed nothing refuses (`hole/no-op`).

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
