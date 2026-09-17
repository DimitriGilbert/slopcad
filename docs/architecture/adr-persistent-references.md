# ADR: Persistent References and Topology Identity

- **Date**: 2026-09-15
- **Phase**: 22 (Persistent References and Topology Identity)
- **Status**: Accepted
- **Probes**: `packages/cad-kernel-occt/src/topology-identity.test.ts` (identity experiments), `packages/cad-kernel-occt/src/reference-resolution.test.ts` (end-to-end resolution/repair), `packages/cad-core/src/persistent-reference.test.ts` (model semantics)

## Context

Phase 21 gave slopcad a real BREP kernel: OCCT's `TopoDS` faces, edges, and
vertices survive every operation, so the plan's persistent references —
selections and feature inputs that address topology and survive
regenerations — became buildable. The plan requires references to feature,
body, solid, face, edge, and vertex; five explicit validity states (valid,
missing, ambiguous, invalid, repaired); provenance through the feature
graph; bounded repair; and the hard rule that an ambiguous reference may
never silently resolve to one entity. Manifold stays in the picture with
`persistentTopology: false` — its topology is synthesized per regeneration
(the Phase 12 stance).

The open question was what "topology identity" actually IS on OCCT. The
pre-spike (§4) noted `ReplicadShapeHasher.HashCode` (TShape + location,
orientation ignored) as the obvious identity and flagged persistent naming
as OCCT's classic weakness. This ADR's identity strategy is grounded in
committed experiments, not in that assumption.

## The experiments and what they proved

All findings are pinned by tests in
`packages/cad-kernel-occt/src/topology-identity.test.ts`, executed against
the pinned `replicad-opencascadejs@1.1.0` (OCCT 8.0) single-thread build,
one WASM runtime per context (the regeneration setting).

| # | Change class | Face-hash outcome | Geometry outcome |
| --- | --- | --- | --- |
| a | Rebuild the same feature graph (fresh builds, same process) | **0 of 7 hashes survive** — a completely disjoint set | Area and centroid sequences **bitwise equal**, same exploration order |
| a' | Primitive rebuild, one dimension changed (30 → 31 mm) | 0 of 6 survive | Unchanged faces keep their areas exactly |
| b | Harmless translate of the whole body (+5 mm in x) | 0 of 7 survive (location participates in the hash) | Areas bitwise equal; every centroid shifted by **exactly** the translation vector |
| c | Topology-preserving boolean re-run | 0 of 7 survive | Areas bitwise equal |
| d | Topology-CHANGING boolean (a wall subtract splitting the top face), same process | **3 of 7 survive** — exactly the untouched faces keep their TShape identity; the 4 touched faces' hashes vanish; 11 fresh faces get fresh hashes | Untouched faces' measures unchanged |
| e | BREP/STEP round trip (serialization) | 0 of 7 survive | Areas preserved to ~3e-16 relative; **exploration order NOT preserved** |
| e' | Cross-process import (the committed `plate-with-hole.brep` fixture, written by another process) | 0 of 7 survive | Areas equal within 1e-12; order not stable |
| f | Symmetric split (two equal-area top halves) | Distinct hashes | Equal areas, mirrored centroids — geometric twins |
| g | One TShape carried twice in a compound | The **same hash appears twice** | Identical measures — a true identity collision |
| j | Edge exploration of one solid | Every edge hash appears **exactly twice** (30 occurrences, 15 distinct) — once per adjacent face, orientation ignored | — |

The decisive facts:

1. **`HashCode` is allocation-address-derived.** Every rebuild — identical
   graph, identical process, identical op sequence — produces a disjoint
   hash set (a). Kernel identity is a *within-regeneration* identity. It
   survives only along a live kernel lineage: the untouched faces of an
   incremental boolean keep it (d), which dies at the next rebuild anyway
   (a) and never survives serialization (e, e').
2. **Geometry is the only cross-regeneration carrier.** Measures are
   bitwise-reproducible across rebuilds (a), rigid translations shift
   positions exactly (b), and serialization preserves them to ~1e-15 (e).
3. **Real ambiguities exist.** Geometric twins with equal measures (f) and
   identical-identity duplicates (g, j) both occur; a resolver must report
   them, never guess.

## Decision

### 1. Identity strategy: two coordinated payloads, never a kernel handle

A persistent face/edge/vertex reference (cad-core
`persistent-reference.ts`) carries:

- an **identity payload** — opaque data (`kernelId`, `schema`, `data`)
  that only the resolving kernel interprets; for OCCT, schema
  `occt-shape-hash-v1` with `data.hash` = `ReplicadShapeHasher.HashCode`.
  Grounded in fact 1, this payload resolves exactly along a live lineage
  (experiment d) and is expected to die at every rebuild;
- a **geometric descriptor** — the kind's primary measure (area / length /
  positioned point) plus **dual-anchored** positions: absolute AND relative
  to the body's centre of mass. Grounded in fact 2 and the change classes:
  absolute positions survive topology changes elsewhere in the body (an
  untouched face does not move), body-relative positions survive rigid
  moves of the whole body, and no single anchoring survives both.

Feature, body, and solid references need none of this: they address stable
document ids (`feat_…`, `body_…`) that survive regenerations by the
document model's construction. No raw kernel handle (`TopoDS_Shape`,
solid tag, pointer) ever crosses the public surface.

### 2. Validity states as data, transitions as a table

Every reference carries its validity record (state, regeneration, ordinal /
candidates / reason / repair record). Transitions run through
`applyReferenceValidity`, which enforces:

- `valid | missing | ambiguous` re-measure freely at each resolution;
- `repaired` is reachable only from `missing` (repair) or `ambiguous`
  (explicit disambiguation) — a valid reference is never silently
  "repaired"; its identity must die first, visibly;
- `invalid` is terminal — structural breaks end a reference; a successor
  must be minted deliberately.

### 3. Resolution protocol: document + kernel-capability gated

`TopologyView` is the interface a kernel implements (cad-core defines it;
`cad-kernel-occt` ships the OCCT implementation over
`OcctKernel.topologySnapshot`). `resolveDocumentReference` checks the body
and provenance first (`invalid`/`body-absent`, `invalid`/`provenance-broken`),
then resolves against the view's snapshot: one identity match → `valid`;
several → `ambiguous` with every candidate (fact 3 — the compound case g);
none → `missing`; a foreign kernel or unknown schema → terminal `invalid`;
a non-persistent kernel → `invalid`/`kernel-transient-topology`.

**The unified Manifold stance:** a `persistentTopology: false` kernel is
reported honestly — its references were never persistent, and
`transientSelectionOf` maps a resolved persistent reference into the Phase
12 synthetic selection reference (`{ kind, bodyId, regeneration, index }`),
the one-regeneration-valid form the transient model already enforces. One
reference model unifies both kernels; cad-core stays kernel-free.

### 4. Provenance

`referenceProvenance` derives the feature-graph path that produced the
owning body: the producing feature plus its upstream feature ancestors, in
`featureEvaluationOrder`. Imported bodies (STEP/BREP provenance) carry the
empty path, intact by definition. Two features producing one body is a
structured refusal (`reference/provenance-ambiguous`) — the document model
does not forbid shared outputs, so the ambiguity is reported rather than
guessed.

### 5. Bounded, explicit repair

`repairTopologyReference` re-anchors a `missing` reference with two
deterministic, ordered strategies:

1. `provenance-identity` — one same-kind entity of the re-executed
   provenance path's snapshot carries an equal identity payload (the
   lineage case, experiment d);
2. `geometric-reattach` — the narrowing chain over the current snapshot:
   primary measure within 1e-9 relative first, then the dual-anchoring
   position rule (absolute OR body-relative within 1e-6 mm) to distinguish
   equal-measure candidates.

Repair refuses to guess: zero candidates → the reference stays `missing`
(explicit invalidation); several → `reference/repair-ambiguous` with the
candidates. A successful repair rewrites the payloads and records
old → new anchors in the validity record. Ambiguity is resolved only by the
caller, explicitly (`disambiguateTopologyReference`, strategy
`disambiguated`).

**The equal-area-twin trap, addressed.** During implementation the strict
matcher was found to refuse the untouched bottom face after a split (the
body centroid drifts, moving every body-relative position), while an
area-only shortcut happily re-anchored a destroyed top face onto its
equal-area bottom twin — the forbidden wrong-entity resolution. The
dual-anchoring rule (absolute OR relative) resolves exactly this pair of
cases: the untouched face matches absolutely, the rigidly-moved body
matches relatively, and the destroyed face matches neither. Both cases are
pinned by tests in both packages.

### 6. Repair bounds

- Measures: 1e-9 relative (measured: bitwise across rebuilds, ~3e-16 across
  serialization — three orders of magnitude of margin).
- Positions: 1e-6 mm absolute per component (measured: exact shifts under
  translation, bitwise across rebuilds).
- Scope: one deterministic heuristic chain, no search, no optimization —
  the same inputs always produce the same repair.

## Rejected alternatives

- **OCCT shape hashes as the persistent identity** (the pre-spike's
  candidate): ruled out by experiment a — the hash is
  allocation-address-derived and dies at every rebuild. It is kept exactly
  where it works: same-lineage resolution and within-snapshot identity.
- **Exploration ordinal as the identity** (stable face ordering): ruled out
  by experiments e/e' — order is not preserved across serialization (and
  there is no reason to believe it across kernel versions). Ordinals are
  per-snapshot coordinates only.
- **OCCT's `Generated`/`Modified`/`IsDeleted` histories as the provenance
  mechanism**: operation-local — the builders (and their histories) are
  freed when each kernel op returns, and the experiments show nothing
  survives a rebuild to correlate against. Provenance lives in the
  document's feature graph instead, where it is stable data.
- **A topological-naming/naming-graph scheme** (the OneCAD-style
  persistent-naming layer): the experiments show the substrate such a
  scheme would sit on (stable kernel identity across regenerations) does
  not exist in this binding, and building naming on top of geometric
  matching would re-derive the heuristic this ADR already adopts — without
  the honesty of explicit validity states. Deferred until a kernel offers
  stable identity to name with.
- **Body-relative-only positions** (the first implementation): drifts when
  any topology change moves the body's centre of mass, refusing repair for
  untouched faces. **Absolute-only positions**: moves with every rigid
  transform. Dual anchoring covers both harmless-change classes.
- **Silent best-effort re-resolution** (snap a missing reference to the
  nearest candidate): rejected categorically — it is the ambiguity rule
  violated by another name.

## Consequences

- Reference validity after a rebuild is *expected* to be `missing` →
  `repaired` for surviving entities: repair is the normal path, explicit
  and recorded, not an error state.
- The identity payload's schema (`occt-shape-hash-v1`) is versioned per
  kernel; an OCCT binding upgrade that changes hashing is a
  `schema-unknown` event for stale references, terminal by design.
- Snapshots carry body-relative measures, so a topology change elsewhere in
  the body invalidates relative positions for all faces — accepted: the
  absolute anchoring still matches untouched entities, and the split face
  correctly refuses.
- Manifold-era documents (Phase 12 synthetic selections) remain fully
  valid: the transient model is one stance of the unified reference model,
  not a legacy path.
