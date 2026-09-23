# ADR: Assembly structure — assembly-as-document, occurrences as an additive collection

Phase 50 (Assemblies I). Status: accepted. Governs Phases 51-53.

## Decision

**Every `CadDocument` IS an assembly root.** Component occurrences are a
first-class additive document collection (`occurrences`) — the same
persistence class as sketches, references, datums, and sections — and a
**sub-assembly is another document referenced as an occurrence source**.
There is no separate "assembly document kind": a document with zero
occurrences is a plain part document; a document with occurrences is an
assembly of them; both are the same shape on every wire.

An occurrence carries:

- a **source** — `{ kind: "body", bodyId }` (a body of the same document),
  `{ kind: "document", documentId }` (another document, addressed by the
  persistence layer's document id — an opaque string to cad-core, resolved
  by the host through the `@slopcad/api` documents router), or
  `{ kind: "component", componentId }` (a registry component — likewise
  opaque, resolved by the host through `@slopcad/cad-components`);
- a **placement** — anchored to a document datum (any datum kind resolves
  to a frame; `cSys` is the canonical anchor) plus an optional translation
  applied in the anchor's frame, or identity, or a bare offset. Numeric
  today, parameter-driven transitively through the datum system (a datum
  defined from parameters moves every occurrence anchored to it); literal
  expression indirection is deferred until a phase needs it;
- a **BOM structure flag** — `default` (absent on the wire), `phantom`,
  or `purchased`. Data only; BOM tables are Phase 53 (drawings).

## Why (the persistence shape decides)

The persistence layer (Phase 31) stores each document as an owned row
whose saves are immutable native-format versions of one opaque payload.
That shape makes assembly-as-document free and assembly-as-section costly:

- **No schema change, no migration, no kind column.** A document holding
  occurrences persists exactly like any other document; the native format
  is the only gate (v3 → v4, content-additive, identity migration — the
  datum precedent: an old reader would silently drop the standalone
  `occurrences` section and the `occurrence` id counter, so the envelope
  stamp is the reader's gate).
- **Cross-document sources already have an address.** The documents
  router's ids are stable, project-scoped, and versioned; an occurrence
  pins the source document by that id, and revision tracking rides the
  existing save-version machinery (stale propagation compares revisions
  supplied by the host — project-local first, per the roadmap).
- **A "section" assembly would have needed a second nesting concept** —
  groups inside one document — whose placed rendering, instance paths,
  and cross-document links would each be novel machinery. Reusing the
  document as the assembly unit reuses identity, naming, persistence,
  versioning, and the whole tree vocabulary instead.

## Instance paths and composition order (fixed by this ADR)

An **occurrence path** is the chain of occurrence ids from the root
document to a leaf: `[occ_a, occ_b, …]`, outermost first. A placed
instance's world transform is the **composition of each hop's resolved
placement in path order** — `world = M(path[0]) ∘ M(path[1]) ∘ …` — i.e.
the leaf's geometry is moved by the leaf placement first, then each
ancestor's, outermost applied last. The order is a property of the path,
never of traversal state, so identical paths compose identically in every
kernel, process, and session (the determinism Phase 51's solver and
Phase 52's animation scrub both stand on).

Regeneration: an occurrence's geometry IS its source's regenerated output
— resolution never re-executes features; it walks sources (document
resolvers supplied by the host), copies provenance, and composes
transforms. Cycles (a document transitively containing itself) and
excessive depth are structured `assembly/*` failures, never recursion
blowups.

## Consequences

- `cad-core` stays persistence-agnostic: document ids and component ids
  in sources are opaque validated strings; resolution runs through host
  supplied resolver seams (the datum topology-seam pattern).
- The projection carries placements as DATA (`occurrencePath` +
  `occurrenceTransform` on the render object, additive, absent for direct
  body renders); the renderer applies them as its scene-node matrix. The
  object's `bounds` are the WORLD-space AABB (exact: the corner-transform
  AABB of the local bounds under a rigid transform).
- BOM flags ride occurrences now, are rendered as tree chips now, and are
  consumed by drawing tables later (Phase 53) — no second BOM model.
- Mates/joints (51), patterns/explode/motion (52), and BOM tables (53)
  address geometry through occurrence paths — the path vocabulary here is
  their only dependency on this phase.
