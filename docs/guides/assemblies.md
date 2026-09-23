# Assemblies

Phase 50: every `CadDocument` IS an assembly root. Component occurrences
(`document.occurrences`) place a **source** — a body of the same document,
another document, or a registry component — into the tree, with a
**placement** and a **BOM structure flag**. The shape decision
(assembly-as-document vs assembly-as-section) is the assembly ADR's
(`docs/architecture/adr-assemblies-structure.md`); the short version: the
persistence layer already stores documents as opaque native payloads, so
reusing the document as the assembly unit reuses identity, versioning, and
the whole tree vocabulary instead of inventing a second one.

```ts
import {
  addBody,
  addOccurrence,
  createDocument,
  resolveAssemblyInstances,
} from "@slopcad/cad-core";

let document = createDocument(createDocumentId("doc_arm"));
document = addBody(document, { name: "Base" }).value.document;
document = addOccurrence(document, {
  name: "Motor mount",
  source: { kind: "body", bodyId: baseId },
  placement: {
    kind: "datum", // anchor to a document datum (any kind resolves to a frame)
    datumId,
    translation: [0, 0, 12], // applied IN the anchor frame
  },
  bomFlag: "purchased", // or "phantom" (wire-absent default = "default")
}).value.document;

const resolution = resolveAssemblyInstances(document, {
  // Host seams: cad-core never imports the persistence layer or the
  // component registry; unresolved sources are structured failures.
  document: (id) => loadDocumentFromApi(id),
  component: (id) => componentBodyIds(id),
});
resolution.instances; // placed leaf bodies: path, bodyId, transform, bomFlags
```

## Instance paths and composition order (fixed)

An occurrence **path** is the chain of occurrence ids from the root
document to a leaf, OUTERMOST FIRST. The world transform is the
composition in path order — `world = M(path[0]) ∘ M(path[1]) ∘ …` — a
property of the path, never of traversal state, so identical paths compose
identically everywhere (the determinism Phases 51-53 stand on). Cycles and
paths past `ASSEMBLY_INSTANCE_DEPTH_LIMIT` (16) are structured
`assembly/*` failures.

Placement resolve: `identity` passes through; `offset` translates; `datum`
anchors to a datum's frame (a `cSys` is canonical; axis/point/plane
anchors resolve to frames with documented free axes). Topology-dependent
datum definitions need the executor's topology seam —
`resolveOccurrencePlacementFromFrames` is the pre-resolved entry point.

## Staleness (project-local first)

`computeAssemblyStaleness(revisions, assemblyId)` derives staleness from
host-supplied save revisions with one rule: an assembly is stale iff any
TRANSITIVE source's revision is newer. Pure, cycle-safe, no clocks.

## Rendering

Placed instances ride the projection as DATA: `occurrencePath` +
`occurrenceTransform` on the render object (absent for direct body
renders, so existing projections serialize byte-identically). The soup
stays the source body's (shared verbatim); `bounds` are the exact
WORLD-space AABB; the renderer applies the transform as its mesh matrix.
The tree (`CadModelTree`) renders the host-derived occurrence section with
BOM/stale chips via its `assembly` prop.

## Native format

Occurrences persist in the additive `occurrences` section with the
`occurrence` id counter (emitted only when non-zero/non-empty, so
occurrence-free documents stay byte-identical). The envelope stamp is v4;
the v3→v4 migration is the identity (content-additive — the datum
precedent). BOM tables are Phase 53; mates and interference are Phase 51;
patterns and exploded views are Phase 52 — all three address geometry
through occurrence paths, the vocabulary this phase pins.

## Patterns, mirror components, explode, motion (Phase 52)

**Component patterns** resolve a seed placement into generated placements:
`resolveLinearOccurrencePattern` (unit direction, count, spacing) and
`resolveCircularOccurrencePattern` (datum axis line, count, angle step,
right-hand rule) are pure arithmetic — the caller stamps the results as
ordinary occurrences through `addOccurrence`, so the tree, resolution, and
format never grow. A count ceiling (`OCCURRENCE_PATTERN_INSTANCE_LIMIT`,
mirroring the hole position limit) keeps a stray count out of the renderer.
**Path-driven patterns are declined** (`assembly/pattern-path-unsupported`,
capability `ASSEMBLY_PATTERN_CAPABILITIES.pathDriven = false`): a resolved
path-curve source along occurrences does not exist yet.

**Mirror components** mirror the PLACEMENT only:
`resolveMirroredOccurrencePlacement` reflects the seed's position across the
datum plane and composes the orientation with the reflection through a local
z-flip that keeps the transform rigid (det +1) — the instance sits at the
mirrored spot with its handedness PRESERVED. Mirrored GEOMETRY (the
enantiomorph a kernel mirror op would produce) is a structured decline
(`assembly/mirror-geometry-unsupported`, capability
`mirroredGeometry = false`) until a kernel binding is probed.

**Exploded views** store an `AssemblyExplodeState`: explicit per-path
offsets (unit direction + mm) plus an optional radial auto-explode rule;
explicit entries win. `serializeExplodeState`/`parseExplodeState` is the
deterministic round-trip (byte-identical canonical JSON). Playback is the
scrub: `applyExplodeState` maps factor t ∈ [0, 1] (clamped, linear) to each
instance's exploded transform — identical (state, t) frames are
bitwise-identical, so the animation is parameter-driven by construction.

**Motion basics** stage WITHOUT the Phase 51 mate solver. An
`AssemblyMotionJoint` pins one occurrence to an axis (revolute degrees /
slider millimetres) with hard limits; `applyMotionJoint` maps the parameter
to the occurrence's local transform, clamping into the limits — the limit
fixtures' subject. `probeMotionClearance` samples stations across the
limits and measures the bounding-box distance between two occurrences — a
CONSERVATIVE floor (positive proves clearance; non-positive flags the
station for Phase 51's exact boolean interference check, which owns the
exact verdict). Joint-driven DRAG is declined
(`assembly/motion-drag-pending-mates`, capability `dragDriven = false`)
until the mate solver's remaining-DOF propagation exists; the joint
record's axis/limits vocabulary is deliberately the solver's shape, so the
records compose when it lands.

Phase 52 disclosure: its exploded-view offsets and joint-motion stations
persist beside the document as their own records — session-scoped until
the envelope grows to carry them, and that envelope growth is deferred.
