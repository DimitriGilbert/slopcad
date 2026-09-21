# Constraints

Constraints are the sketch's parametric intent — pure data records
binding entities and points, consumed by any `SketchSolver`. The
vocabulary lives in `@slopcad/cad-sketch`'s `constraints.ts`.

## The kinds

`SKETCH_CONSTRAINT_KINDS` (each with a `create*Constraint` builder):

- **Geometric:** coincident, horizontal, vertical, parallel,
  perpendicular, tangent (`TANGENT_VARIANTS`: external | internal),
  midpoint, equal, symmetry — one kind whose two builders mirror about a
  point target (`createSymmetryAboutPointConstraint`) or about a line
  (`createSymmetryAboutLineConstraint`). Phase 36 added pointOnEntity (a
  point on a line/circle/arc/ellipse/spline curve — arcs participate as
  their full circles, the tangency convention), collinear (two lines on
  one infinite line, 2 equations), and the point-pair alignments
  horizontalPair / verticalPair (two point targets share y / x). Phase 37
  added pointOnTangent (a point on the line through a spline's end along
  that end's tangent — "collinear with the end tangent") and widened the
  operand kinds below.
- **Dimensional** (`DIMENSIONAL_CONSTRAINT_KINDS`): distance, radius,
  diameter, angle — each carrying a dimensional value — plus the Phase 36
  signed axis dimensions distanceX / distanceY
  (`x_second − x_first = value`, any finite mm, negative and zero
  included). radius/diameter also dimension polygons (the authored
  radius — circumradius or inradius per the fit) and slots (the cap
  radius).

### Spline operands (Phase 36 pinned the subset; Phase 37 closed it)

Spline entities accept point-target constraints on their `start`/`end`
(the curve passes through both), `pointOnEntity` onto them (a
frozen-parameter projection onto the tessellated chord form — see
`spline-math.ts`), the `fixed` pin, and the Phase 37 additions:

- **tangent(line, spline)** — ANYWHERE tangency: one equation, the
  contact eliminated at a per-evaluation stationary anchor (codimension
  1, exactly like line↔circle). **tangent(spline, spline)** — a G1
  joint: `first.end` coincides with `second.start` AND the end/start
  tangents share direction (3 equations). Anywhere spline↔spline
  tangency needs constraint-owned auxiliary solver unknowns and stays a
  staged design (see `docs/design/spline-constraint-math.md` §1.6).
- **parallel / perpendicular / angle** with a line↔spline pair — the row
  addresses the spline's END tangent (the `at` operand on the
  constraint, `"start" | "end"`, default `"end"`); direction-only, the
  line↔line convention. Full "meets" semantics composes these with a
  contact row, the layering the line↔line kinds already imply.
- **equal(line | spline, line | spline)** — equal endpoint chords: a
  spline counts the distance between its first and last stored points
  (the same notion `equal` uses for line lengths).
- **pointOnTangent(point, spline, at?)** — the point lies on the line
  through the spline's end along that end's tangent (1 equation, mm).

Still declined at validation with `sketch/constraint-unsupported`, never
a silent mis-solve: radius/diameter (a spline has no radius parameter),
collinear (its meaningful spline reading is `pointOnTangent`), and
horizontal/vertical (single-line kinds).

### Composite operands (Phase 37)

`pointOnEntity` also accepts **polygons** (the boundary perimeter — a
stateless per-evaluation min over the edges; the argmin constituent's
gradient is the row's, Danskin-style) and **straight slots** (the
stadium boundary — two edge segments plus two gated semicircular caps).
The arc3 slot variant stays outside the subset until the straight-slot
row has fixture coverage.

Points are addressed by `pointTarget(entityId, "start" | "end" |
"center")` — constraints bind to an entity's endpoint or a point's
centre, never to raw coordinates:

```ts
import {
  createDistanceConstraint,
  createHorizontalConstraint,
  createCoincidentConstraint,
  pointTarget,
  length,
} from "@slopcad/cad-sketch";

createHorizontalConstraint(cid("h"), ab);
createDistanceConstraint(
  cid("len"),
  pointTarget(ab, "start"),
  pointTarget(ab, "end"),
  length(50),
);
createCoincidentConstraint(
  cid("join"),
  pointTarget(ab, "end"),
  pointTarget(bc, "start"),
);
```

`validateConstraintReferences` checks that every referenced entity
exists — `createSketch` runs it, so an orphan constraint never enters a
sketch.

## Solving

`createReferenceSketchSolver().solve(entities, constraints)` returns:

- `solved` — `dof: 0`, solved parameters per entity;
- `under-constrained` — the honest remaining `dof` count and the best
  solution so far;
- `failed` — structured `sketch/*` diagnostics (redundant,
  conflicting, unsatisfiable — the fixtures `redundantConstraintSketch`,
  `conflictingDimensionsSketch`, `unsatisfiableChainSketch` pin each).

The solver's knobs are pinned constants (`REFERENCE_SOLVER_MAX_ITERATIONS`,
convergence/rank/pivot/stagnation tolerances). `applySolvedParameters`
writes a solution back; `solvedEntityParametersById` indexes it.

## A fully constrained triangle, by count

Three lines carry 12 dof. Four coincidences close the loop onto a fixed
anchor point (−8), horizontal (−1), three distances (−3) — 0 dof. That
is exactly the composition in the runnable example
(`packages/docs-examples/src/sketch/sketch.ts`), and the solver agrees:
12 → 0.
