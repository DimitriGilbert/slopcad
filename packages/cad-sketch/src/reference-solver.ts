/**
 * The reference sketch solver: deterministic Gauss-Newton least squares over
 * the compiled constraint system — the SolveSpace approach in miniature.
 *
 * Method: iterative Gauss-Newton on the residual vector. Each iteration
 * solves the rank-aware normal equations `(JᵀJ)δ = −Jᵀr` by Gaussian
 * elimination with partial pivoting; directions whose pivots vanish are
 * unconstrained and receive a zero step, so parameters nothing moves keep
 * their drawn values and the iteration never drifts along directions the
 * constraint Jacobian does not span (the CAD convention: solve what you can,
 * report the remaining degrees of freedom). Globally minimum displacement is
 * not guaranteed — a rank-deficient step resolves onto whichever directions
 * elimination pivots on first. A backtracking line search halves the step up
 * to 20 times when a full step would increase the residual energy, which
 * keeps the iteration stable on tangency and arc residuals.
 *
 * Initialization: the entities' stored parameters, verbatim — no randomness,
 * no clock, no heuristics. Determinism is pinned: identical inputs produce
 * bitwise-identical solved parameters, diagnostics, and DoF counts, across
 * calls and solver instances.
 *
 * Tolerances (all documented constants below): convergence when the residual
 * RMS is at or below 1e-9 (mm for dimensional rows, dimensionless for
 * angles, mm² for the quadratic parallelism/perpendicularity rows — the
 * quadratic rows are effectively stricter at model scale); iteration cap
 * 128; stagnation when the step norm falls below 1e-14; Jacobian rank and
 * normal-matrix pivots judged at 1e-10/1e-12 relative to the largest
 * pivot/diagonal.
 *
 * Failure classification: a system that converges is ranked (DoF = free
 * parameters − rank) and its dependent rows reported as redundant warnings.
 * A system that stalls at a least-squares minimum with residual above
 * tolerance is inconsistent; it is classified by leave-one-out re-solves —
 * dropping any single constraint that makes the system solvable marks the
 * conflicting set (`sketch/constraints-conflicting`); when no single removal
 * helps, the infeasibility is distributed and reported as
 * `sketch/constraints-unsatisfiable`. Hitting the iteration cap before
 * stalling is `sketch/solver-not-converged`.
 *
 * Honest limitation: this is a local method. A solvable system initialized
 * far from any of its solutions can stall at a distant local minimum of the
 * residual energy and be reported as conflicting or unsatisfiable even
 * though a solution exists elsewhere; fixtures and callers should initialize
 * sketches near their intended solved shape (as interactive sketching does).
 */

import type { SketchConstraint } from "./constraints";
import type { SketchDiagnostic } from "./diagnostics";
import type { SketchEntity } from "./entities";
import type { ResidualRow } from "./residuals";
import type {
  SketchSolveResult,
  SketchSolver,
  SolvedSketchParameters,
} from "./solver";
import type { SketchConstraintId } from "./sketch-ids";

import { circumcircleOf } from "./entities";
import {
  dependentRowFlags,
  rankOf,
  solveLeastSquaresStep,
} from "./solver-math";
import {
  ParameterLayout,
  compileConstraintSystem,
  packInitialParameters,
  solvedArcSweepIsDegenerate,
  unpackSolvedParameters,
} from "./residuals";
import { SKETCH_DIAGNOSTIC_CODES } from "./diagnostics";

/** Identifier of this solver implementation. */
export const REFERENCE_SKETCH_SOLVER_ID = "reference-gauss-newton";

/** Residual RMS (mm-equivalent) at or below which a system is converged. */
export const REFERENCE_SOLVER_CONVERGENCE_TOLERANCE = 1e-9;

/** Maximum Gauss-Newton iterations per solve. */
export const REFERENCE_SOLVER_MAX_ITERATIONS = 128;

/** Maximum backtracking halvings of a step that raises the energy. */
export const REFERENCE_SOLVER_MAX_BACKTRACK = 20;

/** Step L2 norm below which the iteration counts as stalled at a minimum. */
export const REFERENCE_SOLVER_STAGNATION_TOLERANCE = 1e-14;

/** Relative pivot tolerance for Jacobian rank (DoF) counting. */
export const REFERENCE_SOLVER_RANK_TOLERANCE = 1e-10;

/** Relative pivot tolerance inside the normal-equations step solve. */
export const REFERENCE_SOLVER_PIVOT_TOLERANCE = 1e-12;

interface Evaluation {
  readonly residuals: number[];
  readonly gradients: ReadonlyMap<number, number>[];
  readonly rms: number;
}

function evaluateRows(
  rows: readonly ResidualRow[],
  parameters: readonly number[],
): Evaluation {
  const residuals: number[] = [];
  const gradients: ReadonlyMap<number, number>[] = [];
  let energy = 0;
  for (const row of rows) {
    const { value, grad } = row.evaluate(parameters);
    residuals.push(value);
    gradients.push(grad);
    energy += value * value;
  }
  return { residuals, gradients, rms: Math.sqrt(energy) };
}

function stepNorm(step: readonly number[]): number {
  let sum = 0;
  for (const value of step) sum += value * value;
  return Math.sqrt(sum);
}

/** Strips the columns of pinned entities from a sparse gradient. */
function stripFixed(
  grad: ReadonlyMap<number, number>,
  fixedSlots: ReadonlySet<number>,
): Map<number, number> {
  if (fixedSlots.size === 0) return new Map(grad);
  const stripped = new Map<number, number>();
  for (const [slot, coeff] of grad) {
    if (!fixedSlots.has(slot)) stripped.set(slot, coeff);
  }
  return stripped;
}

function denseJacobian(
  gradients: readonly ReadonlyMap<number, number>[],
  parameterCount: number,
): number[][] {
  const jacobian: number[][] = [];
  for (const grad of gradients) {
    const row = new Array<number>(parameterCount).fill(0);
    for (const [slot, coeff] of grad) row[slot] = coeff;
    jacobian.push(row);
  }
  return jacobian;
}

type GaussNewtonExit = "converged" | "stalled" | "max-iterations";

interface GaussNewtonResult {
  readonly parameters: number[];
  readonly rms: number;
  readonly exit: GaussNewtonExit;
}

function gaussNewton(
  rows: readonly ResidualRow[],
  initial: readonly number[],
  parameterCount: number,
  fixedSlots: ReadonlySet<number>,
): GaussNewtonResult {
  const parameters = [...initial];
  let evaluation = evaluateRows(rows, parameters);
  if (evaluation.rms <= REFERENCE_SOLVER_CONVERGENCE_TOLERANCE) {
    return { parameters, rms: evaluation.rms, exit: "converged" };
  }
  for (
    let iteration = 0;
    iteration < REFERENCE_SOLVER_MAX_ITERATIONS;
    iteration += 1
  ) {
    const gradients = evaluation.gradients.map((grad) =>
      stripFixed(grad, fixedSlots),
    );
    const { step } = solveLeastSquaresStep(
      gradients,
      evaluation.residuals,
      parameterCount,
      REFERENCE_SOLVER_PIVOT_TOLERANCE,
    );
    const norm = stepNorm(step);
    if (norm <= REFERENCE_SOLVER_STAGNATION_TOLERANCE) {
      return { parameters, rms: evaluation.rms, exit: "stalled" };
    }
    let accepted = false;
    let scale = 1;
    for (
      let backtrack = 0;
      backtrack <= REFERENCE_SOLVER_MAX_BACKTRACK;
      backtrack += 1
    ) {
      const candidate = parameters.map(
        (value, index) => value + scale * (step[index] ?? 0),
      );
      const candidateEvaluation = evaluateRows(rows, candidate);
      if (candidateEvaluation.rms < evaluation.rms) {
        parameters.splice(0, parameters.length, ...candidate);
        evaluation = candidateEvaluation;
        accepted = true;
        break;
      }
      scale /= 2;
    }
    if (!accepted) {
      return { parameters, rms: evaluation.rms, exit: "stalled" };
    }
    if (evaluation.rms <= REFERENCE_SOLVER_CONVERGENCE_TOLERANCE) {
      return { parameters, rms: evaluation.rms, exit: "converged" };
    }
  }
  return { parameters, rms: evaluation.rms, exit: "max-iterations" };
}

/** The parameter width of one entity inside the solved vector. */
function entityParameterWidth(entity: SketchEntity): number {
  switch (entity.kind) {
    case "point":
      return 2;
    case "line":
      return 4;
    case "circle":
      return 3;
    case "arc":
      return 5;
    case "ellipse":
      return 5;
    case "ellipticalArc":
      return 7;
    case "spline":
      return 2 * entity.points.length;
    case "polygon":
      return 4;
    case "slot":
      return entity.variant === "arc3" ? 7 : 5;
    case "rectangle":
      return 0;
  }
}

function solvedParametersAreFinite(
  entities: readonly SketchEntity[],
  parameters: readonly number[],
): boolean {
  let slot = 0;
  for (const entity of entities) {
    const width = entityParameterWidth(entity);
    for (let offset = 0; offset < width; offset += 1) {
      const value = parameters[slot + offset];
      if (value === undefined || !Number.isFinite(value)) return false;
    }
    // Radii must stay physical (positive) for circles and arcs, and an
    // arc's forward sweep must stay away from 0 and 2π — a collapsed or
    // near-full-circle sweep is degenerate (mirrors the entity invariant).
    if (entity.kind === "circle" || entity.kind === "arc") {
      const radius = parameters[slot + 2];
      if (radius === undefined || !(radius > 0)) return false;
    }
    if (entity.kind === "arc") {
      const startAngle = parameters[slot + 3];
      const endAngle = parameters[slot + 4];
      if (
        startAngle === undefined ||
        endAngle === undefined ||
        solvedArcSweepIsDegenerate(startAngle, endAngle)
      ) {
        return false;
      }
    }
    // The Phase 36 entities carry the same class of physicality: positive
    // semi-axes/radii, non-degenerate parametric sweeps, and — for the
    // arc3 slot — a centerline whose circumcircle still exists and still
    // clears the cap radius.
    if (entity.kind === "ellipse" || entity.kind === "ellipticalArc") {
      const radiusX = parameters[slot + 2];
      const radiusY = parameters[slot + 3];
      if (radiusX === undefined || radiusY === undefined) return false;
      if (!(radiusX > 0) || !(radiusY > 0)) return false;
    }
    if (entity.kind === "ellipticalArc") {
      const startAngle = parameters[slot + 5];
      const endAngle = parameters[slot + 6];
      if (
        startAngle === undefined ||
        endAngle === undefined ||
        solvedArcSweepIsDegenerate(startAngle, endAngle)
      ) {
        return false;
      }
    }
    if (entity.kind === "polygon") {
      const radius = parameters[slot + 2];
      if (radius === undefined || !(radius > 0)) return false;
    }
    if (entity.kind === "slot") {
      const radiusSlot = entity.variant === "arc3" ? 6 : 4;
      const radius = parameters[slot + radiusSlot];
      if (radius === undefined || !(radius > 0)) return false;
      if (entity.variant === "arc3") {
        const x1 = parameters[slot];
        const y1 = parameters[slot + 1];
        const x2 = parameters[slot + 2];
        const y2 = parameters[slot + 3];
        const x3 = parameters[slot + 4];
        const y3 = parameters[slot + 5];
        if (
          x1 === undefined ||
          y1 === undefined ||
          x2 === undefined ||
          y2 === undefined ||
          x3 === undefined ||
          y3 === undefined
        ) {
          return false;
        }
        const circumcircle = circumcircleOf(
          { x: x1, y: y1 },
          { x: x2, y: y2 },
          { x: x3, y: y3 },
        );
        if (circumcircle === null || !(circumcircle.radius > radius)) {
          return false;
        }
      }
    }
    slot += width;
  }
  return true;
}

function explicitConstraintIds(
  constraints: readonly SketchConstraint[],
): SketchConstraintId[] {
  return constraints.map((constraint) => constraint.id);
}

function notConvergedDiagnostic(message: string): SketchDiagnostic {
  return {
    severity: "error",
    code: SKETCH_DIAGNOSTIC_CODES.solverNotConverged,
    message,
  };
}

/**
 * Creates the reference solver. The instance is stateless; every solve runs
 * to completion with no memory of previous calls.
 */
export function createReferenceSketchSolver(): SketchSolver {
  return {
    id: REFERENCE_SKETCH_SOLVER_ID,
    solve(
      entities: readonly SketchEntity[],
      constraints: readonly SketchConstraint[],
    ): SketchSolveResult {
      const compiled = compileConstraintSystem(entities, constraints);
      if ("diagnostics" in compiled) {
        return { status: "failed", diagnostics: compiled.diagnostics };
      }
      const rows = compiled.rows;
      const layout = new ParameterLayout(entities);
      const fixedSlots = new Set<number>();
      for (const entity of entities) {
        if (!entity.fixed) continue;
        const slots = layout.slotsOf(entity.id);
        if (slots === undefined) continue;
        for (const slot of slots.offsets) fixedSlots.add(slot);
      }
      const initial = packInitialParameters(entities);
      const result = gaussNewton(
        rows,
        initial,
        layout.parameterCount,
        fixedSlots,
      );
      if (result.exit === "max-iterations") {
        return {
          status: "failed",
          diagnostics: [
            notConvergedDiagnostic(
              `The solver reached its ${REFERENCE_SOLVER_MAX_ITERATIONS}-iteration cap with residual RMS ${result.rms.toExponential(3)} mm above the ${REFERENCE_SOLVER_CONVERGENCE_TOLERANCE} tolerance without stalling, so the system could not be classified.`,
            ),
          ],
        };
      }
      if (!solvedParametersAreFinite(entities, result.parameters)) {
        return {
          status: "failed",
          diagnostics: [
            notConvergedDiagnostic(
              "The iteration diverged to non-finite or non-physical parameters (a radius at or below zero, or an arc whose sweep collapses to zero or a near-full circle).",
            ),
          ],
        };
      }
      if (result.rms <= REFERENCE_SOLVER_CONVERGENCE_TOLERANCE) {
        return convergedResult(
          entities,
          rows,
          layout,
          fixedSlots,
          result.parameters,
        );
      }
      return classifyFailure(
        constraints,
        rows,
        layout,
        fixedSlots,
        initial,
        result.rms,
      );
    },
  };
}

function convergedResult(
  entities: readonly SketchEntity[],
  rows: readonly ResidualRow[],
  layout: ParameterLayout,
  fixedSlots: ReadonlySet<number>,
  parameters: readonly number[],
): SketchSolveResult {
  const evaluation = evaluateRows(rows, parameters);
  const strippedGradients = evaluation.gradients.map((grad) =>
    stripFixed(grad, fixedSlots),
  );
  const jacobian = denseJacobian(strippedGradients, layout.parameterCount);
  const rank = rankOf(jacobian, REFERENCE_SOLVER_RANK_TOLERANCE);
  const freeParameters = layout.parameterCount - fixedSlots.size;
  const dof = freeParameters - rank;
  const diagnostics: SketchDiagnostic[] = [];
  if (rows.length > rank) {
    const flags = dependentRowFlags(jacobian, REFERENCE_SOLVER_RANK_TOLERANCE);
    const redundantOrigins = flags
      .map((dependent, index) => (dependent ? rows[index] : undefined))
      .filter((row): row is ResidualRow => row !== undefined);
    if (redundantOrigins.length > 0) {
      const constraintIds = redundantOrigins
        .filter((row) => row.origin.type === "explicit")
        .map((row) => row.origin.id);
      const entityIds = redundantOrigins
        .filter((row) => row.origin.type === "implicit")
        .map((row) => row.origin.id);
      const [firstConstraint] = constraintIds;
      const [firstEntity] = entityIds;
      const location =
        firstConstraint !== undefined
          ? {
              primary: firstConstraint,
              related: [...constraintIds.slice(1), ...entityIds],
            }
          : firstEntity !== undefined
            ? { primary: firstEntity, related: entityIds.slice(1) }
            : undefined;
      diagnostics.push({
        severity: "warning",
        code: SKETCH_DIAGNOSTIC_CODES.constraintsRedundant,
        message: `${redundantOrigins.length} constraint equation${redundantOrigins.length === 1 ? " is" : "s are"} linear combinations of the others; the system solves exactly, but the redundant constraints should be removed.`,
        ...(location === undefined ? {} : { location }),
        data: { redundantEquations: redundantOrigins.length },
      });
    }
  }
  const solved: SolvedSketchParameters = unpackSolvedParameters(
    entities,
    parameters,
    layout,
  );
  if (dof === 0) {
    return { status: "solved", parameters: solved, dof: 0, diagnostics };
  }
  diagnostics.push({
    severity: "info",
    code: SKETCH_DIAGNOSTIC_CODES.underConstrained,
    message: `The constraints are consistent and satisfied, but ${dof} degree${dof === 1 ? "" : "s"} of freedom remain; parameters no constraint moves keep their drawn values.`,
  });
  return { status: "under-constrained", parameters: solved, dof, diagnostics };
}

function classifyFailure(
  constraints: readonly SketchConstraint[],
  rows: readonly ResidualRow[],
  layout: ParameterLayout,
  fixedSlots: ReadonlySet<number>,
  initial: readonly number[],
  rms: number,
): SketchSolveResult {
  // Leave-one-out over explicit constraints: a removal that makes the
  // remainder solvable identifies an incompatible constraint.
  const removable: SketchConstraintId[] = [];
  for (const candidate of constraints) {
    const remaining = rows.filter(
      (row) =>
        !(row.origin.type === "explicit" && row.origin.id === candidate.id),
    );
    const attempt = gaussNewton(
      remaining,
      initial,
      layout.parameterCount,
      fixedSlots,
    );
    if (attempt.rms <= REFERENCE_SOLVER_CONVERGENCE_TOLERANCE) {
      removable.push(candidate.id);
    }
  }
  const [firstRemovable] = removable;
  if (firstRemovable !== undefined) {
    return {
      status: "failed",
      diagnostics: [
        {
          severity: "error",
          code: SKETCH_DIAGNOSTIC_CODES.constraintsConflicting,
          message: `The constraints conflict: residual RMS is stuck at ${rms.toExponential(3)} mm above the ${REFERENCE_SOLVER_CONVERGENCE_TOLERANCE} tolerance, and removing any of ${removable.length} constraint${removable.length === 1 ? "" : "s"} makes the system solvable.`,
          location: {
            primary: firstRemovable,
            related: removable.slice(1),
          },
          data: { conflictingCount: removable.length },
        },
      ],
    };
  }
  const allIds = explicitConstraintIds(constraints);
  const [firstId] = allIds;
  return {
    status: "failed",
    diagnostics: [
      {
        severity: "error",
        code: SKETCH_DIAGNOSTIC_CODES.constraintsUnsatisfiable,
        message: `The constraints are jointly unsatisfiable: residual RMS is stuck at ${rms.toExponential(3)} mm above the ${REFERENCE_SOLVER_CONVERGENCE_TOLERANCE} tolerance, and no single constraint removal makes the system solvable.`,
        ...(firstId !== undefined
          ? { location: { primary: firstId, related: allIds.slice(1) } }
          : {}),
        data: { constraintCount: allIds.length },
      },
    ],
  };
}
