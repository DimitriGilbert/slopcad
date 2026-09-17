/**
 * The solver-neutral sketch-solving contract.
 *
 * A solver consumes entities and constraints (already in workplane
 * coordinates — the workplane itself is not the solver's concern) and returns
 * solved parameter values plus structured diagnostics. Nothing about *how* a
 * solver works may leak into this contract: no iteration counts, no linear
 * algebra, no solver-specific error types — only the parameter outcome, the
 * degrees-of-freedom count, and `sketch/*` diagnostics. Implementations must
 * be pure and deterministic: identical inputs produce bitwise-identical
 * results across calls and instances.
 *
 * Result semantics (the CAD convention):
 *
 * - `"solved"` — the constraint system holds exactly at the returned
 *   parameters and has zero remaining degrees of freedom. Consistent
 *   redundant constraints do not downgrade this status; they are reported as
 *   `sketch/constraints-redundant` warnings alongside it.
 * - `"under-constrained"` — the constraints are consistent and satisfied at
 *   the returned parameters, but degrees of freedom remain (surfaced as
 *   `dof`). The solver solves what it can: parameters no constraint moves
 *   keep their drawn values, and the iteration never steps along directions
 *   the constraint Jacobian does not span. It does not promise the globally
 *   minimum-displacement consistent state — a rank-deficient step resolves
 *   onto whichever directions elimination pivots on first.
 * - `"failed"` — no consistent solution was reached. The diagnostic
 *   distinguishes why: `sketch/constraint-reference-malformed` for references
 *   that do not resolve against the entity list (or are of incompatible
 *   kinds), `sketch/constraints-conflicting` when dropping a single
 *   constraint would make the system solvable (an incompatible pair, an
 *   over-constrained dimension), `sketch/constraints-unsatisfiable` when no
 *   single removal resolves it (a deeper geometric infeasibility), and
 *   `sketch/solver-not-converged` when the numeric process gave up before it
 *   could classify the system.
 */

import type { SketchConstraint } from "./constraints";
import type { SketchDiagnostic } from "./diagnostics";
import type { SketchEntity } from "./entities";
import type { SketchEntityId } from "./sketch-ids";

/**
 * Solved parameter values for one entity, mirroring its parametric form:
 * point `(x, y)`; line `(x1, y1, x2, y2)`; circle `(cx, cy, radius)`; arc
 * `(cx, cy, radius, startAngle, endAngle)` with angles in [0, 2π). A
 * rectangle carries no parameters of its own — its shape is its four edge
 * lines, each of which appears in the list.
 */
export type SolvedEntityParameters =
  | {
      readonly id: SketchEntityId;
      readonly kind: "point";
      readonly x: number;
      readonly y: number;
    }
  | {
      readonly id: SketchEntityId;
      readonly kind: "line";
      readonly x1: number;
      readonly y1: number;
      readonly x2: number;
      readonly y2: number;
    }
  | {
      readonly id: SketchEntityId;
      readonly kind: "circle";
      readonly cx: number;
      readonly cy: number;
      readonly radius: number;
    }
  | {
      readonly id: SketchEntityId;
      readonly kind: "arc";
      readonly cx: number;
      readonly cy: number;
      readonly radius: number;
      readonly startAngle: number;
      readonly endAngle: number;
    }
  | { readonly id: SketchEntityId; readonly kind: "rectangle" };

/** Solved parameters for every entity, in the entity order given to the solver. */
export interface SolvedSketchParameters {
  readonly entities: readonly SolvedEntityParameters[];
}

/** Indexes solved parameters by entity id; rectangles included, parameters empty. */
export function solvedEntityParametersById(
  parameters: SolvedSketchParameters,
): ReadonlyMap<SketchEntityId, SolvedEntityParameters> {
  return new Map(parameters.entities.map((entity) => [entity.id, entity]));
}

/** The outcome of a solve. */
export type SketchSolveResult =
  | {
      readonly status: "solved";
      readonly parameters: SolvedSketchParameters;
      readonly dof: 0;
      readonly diagnostics: readonly SketchDiagnostic[];
    }
  | {
      readonly status: "under-constrained";
      readonly parameters: SolvedSketchParameters;
      readonly dof: number;
      readonly diagnostics: readonly SketchDiagnostic[];
    }
  | {
      readonly status: "failed";
      readonly diagnostics: readonly SketchDiagnostic[];
    };

/**
 * A sketch constraint solver. `id` names the implementation (for diagnostics
 * and tests); `solve` is pure — implementations keep no state between calls.
 */
export interface SketchSolver {
  readonly id: string;
  solve(
    entities: readonly SketchEntity[],
    constraints: readonly SketchConstraint[],
  ): SketchSolveResult;
}
