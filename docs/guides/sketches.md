# Sketches

`@slopcad/cad-sketch` is the 2D parametric domain: workplanes, entities,
constraints, serialization, and a solver-neutral solving contract with a
deterministic reference implementation. It depends only on cad-core.

## Workplanes

A `Workplane` is an origin plus an orthonormal x/y basis
(`createWorkplane`, with `xyWorkplane()` and `frontWorkplane()`
presets; `orthonormalizeWorkplane` repairs near-miss input).
`workplaneToWorld` / `worldToWorkplane` map points; the tolerances are
pinned (`WORKPLANE_ORTHONORMALITY_TOLERANCE`,
`WORKPLANE_DIRECTION_EPSILON`). `workplaneToPlacement` turns a
workplane into the kernel placement (`workplane-placement.ts`) that
extrude/revolve features consume.

## Entities

Point, line, circle, arc, rectangle — and, since Phase 36, ellipse,
elliptical arc, spline, regular polygon, and slot — each with a
`create*Entity` builder that validates coordinates and freezes the result:

```ts
import { createSketchEntityId, createLineEntity } from "@slopcad/cad-sketch";
const ab = createLineEntity(
  createSketchEntityId("skent_ab"),
  { x: 0, y: 0 },
  { x: 50, y: 0 },
);
```

Every entity documents its solver unknowns (the module docs of
`entities.ts`): an ellipse is `(cx, cy, radiusX, radiusY, rotation)` —
5 dof; an elliptical arc adds the parametric sweep (7); a spline carries
2 dof per stored point; a regular polygon is `(cx, cy, radius, rotation)`
— 4 dof, its `sides`/`fit` discrete; a slot is 5 dof (straight) or 7
(arc3, its centerline an arc through three points). Polygons and slots
resolve to their EXACT constituent primitives in profiles (n lines; cap
arcs, offset arcs, and tangent lines); ellipses and splines keep their
native segment kinds.

Construction entities (`options.construction`) stay out of geometry;
`fixed` points anchor solutions.

## Sketches and serialization

`createSketch(workplane, entities, constraints)` validates integrity
(entity/constraint cross-references); `serializeSketch` /
`parseSketch` round-trip exactly (parse-the-serialize output → identical
JSON — the suite pins it; `SKETCH_FORMAT_VERSION = 2`). Inside a
document, a sketch persists through the `sketch.create` command; the
native document's v1→v2 migration carries old embedded sketches forward
(the growth is additive — see [native-files.md](native-files.md)).

## Profiles

`resolveExtrudeProfile(entities)` resolves the entities into exactly one
closed loop — the loop an `extrude` feature consumes; several disjoint
loops fail `sketch/profile-multiple-loops` (selecting among them is an
interaction decision, not a silent default). `resolveProfileLoops` is
the multi-loop resolver; `profileLoopSignedArea` is measured on the
resolution walk. Since Phase 36: a full ellipse resolves to its own
closed loop (area exactly πab — Green's theorem in closed form);
elliptical arcs and splines chain by endpoint adjacency, the spline's
area carried by its chord form within the documented deflection band
(`SKETCH_PROFILE_DEFLECTIONS` — the fixed tessellation table every
curved kind resolves through, vertices on the true curves). The
self-intersection battery covers the tessellated kinds through their
chord polylines. `entityPolyline(entity)` exposes the same
deflection-disciplined boundary to renderers and hit-testers.

## Solving

`createReferenceSketchSolver()` is the deterministic reference
implementation of the `SketchSolver` contract (`solve(entities,
constraints)` → solved / under-constrained with `dof` / failed with
diagnostics). `applySolvedParameters(sketch, parameters)` writes a
solution back onto the sketch's entities. See
[constraints.md](constraints.md).

## The runnable example

`packages/docs-examples/src/sketch/sketch.ts`: a triangle solved from
under-constrained (12 dof reported) to fully constrained (0 dof),
serialized round-trip exact, and resolved to a 3-segment profile with
Heron-checkable signed area (600 mm² for the 50/30/40 triangle).
