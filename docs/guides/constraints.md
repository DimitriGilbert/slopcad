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
  (`createSymmetryAboutLineConstraint`). Phase 36 adds pointOnEntity (a
  point on a line/circle/arc/ellipse/spline curve — arcs participate as
  their full circles, the tangency convention), collinear (two lines on
  one infinite line, 2 equations), and the point-pair alignments
  horizontalPair / verticalPair (two point targets share y / x).
- **Dimensional** (`DIMENSIONAL_CONSTRAINT_KINDS`): distance, radius,
  diameter, angle — each carrying a dimensional value — plus the Phase 36
  signed axis dimensions distanceX / distanceY
  (`x_second − x_first = value`, any finite mm, negative and zero
  included). radius/diameter also dimension polygons (the authored
  radius — circumradius or inradius per the fit) and slots (the cap
  radius).

### The spline scope (Phase 36's pinned honesty)

Spline entities accept point-target constraints on their `start`/`end`
(the curve passes through both), `pointOnEntity` onto them (a
frozen-parameter projection onto the tessellated chord form — see
`spline-math.ts`), and the `fixed` pin. Every other constraint kind
with a spline operand — tangency, equality, parallelism,
perpendicularity, angle, radius/diameter — declines at validation with
`sketch/constraint-unsupported`, never a silent mis-solve.

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
