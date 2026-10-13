/**
 * The owned linear solver (Phase 69a, law S2's "a solver you own" — the
 * `@slopcad/sim-thermal` `./solver` precedent): Jacobi-preconditioned
 * conjugate gradients over the assembled reduced stiffness system, zero
 * dependencies, fixed-order float64 arithmetic (sequential dot
 * products, one deterministic code path), so identical systems solve to
 * bitwise-identical displacement fields.
 *
 * ## Why Jacobi-CG (documented choice)
 *
 * The reduced voxel-stiffness matrix is symmetric positive definite
 * (full-integration hexes over positive-definite elasticity, Dirichlet
 * rows removed exactly), which is CG's contract. Jacobi (diagonal)
 * preconditioning removes the E-scale disparity of mixed materials for
 * one diagonal look-up per dof — the same choice the Phase 65
 * conduction solve made and validated; heavier AMG machinery is the
 * provider path (the §9 MFEM note's fidelity ladder), not the
 * reference kernel's. Voxel FEM conditioning grows like the
 * cells-per-direction squared, so CG's √κ iteration scaling keeps the
 * reference fixtures in the hundreds-to-thousands-of-iterations band at
 * small grids — measured and stated by the run report.
 *
 * ## The convergence discipline (loud caps, never fabricated results)
 *
 * The stop test is the RELATIVE residual ‖r‖₂/‖f‖₂ (absolute ‖r‖₂ when
 * the load is zero — a zero-load system converges at u = 0 without
 * iterating). Exhausting `maxIterations` without reaching `tolerance`
 * declines with `sim/solver-unconverged` naming the iteration count,
 * the frozen residual, and the tolerance; a non-finite residual or
 * inner product declines the same way; a non-positive CG curvature (a
 * breakdown on a matrix that left the SPD band — the singular-posture
 * case a fixture-starved scenario produces) declines immediately.
 * Never a fabricated converged field.
 */

import {
  type SimError,
  SIM_ERROR_CODES,
  type SimParseResult,
  simError,
  simFail,
  simOk,
} from "@slopcad/sim-core";
import type { AssembledStructuralSystem } from "./system";

/** The solver discipline's knobs, validated at the problem door. */
export interface StructuralSolverOptions {
  /** The relative residual (‖r‖₂/‖f‖₂) the solve must reach. */
  readonly tolerance: number;
  /** The hard iteration cap — exhausting it declines loudly. */
  readonly maxIterations: number;
}

/** What a converged solve reports about its own discipline. */
export interface StructuralSolverOutcome {
  readonly iterations: number;
  /** The residual the solve stopped at, in the discipline's norm. */
  readonly relativeResidual: number;
}

/**
 * The default relative residual — tight enough that the projection's
 * float64 fields carry solver error far below their own round-off.
 */
export const STRUCTURAL_SOLVE_DEFAULT_TOLERANCE = 1e-10;

/** The default iteration cap — loud, generous for reference grids. */
export const STRUCTURAL_SOLVE_DEFAULT_MAX_ITERATIONS = 50_000;

export const STRUCTURAL_SOLVE_DEFAULTS: StructuralSolverOptions = Object.freeze(
  {
    tolerance: STRUCTURAL_SOLVE_DEFAULT_TOLERANCE,
    maxIterations: STRUCTURAL_SOLVE_DEFAULT_MAX_ITERATIONS,
  },
);

/** Validates the discipline's knobs (the problem door's shared check). */
export function structuralSolverOptionsProblem(
  options: StructuralSolverOptions,
): SimError | undefined {
  if (
    typeof options.tolerance !== "number" ||
    !Number.isFinite(options.tolerance) ||
    options.tolerance <= 0
  ) {
    return simError(
      SIM_ERROR_CODES.scenarioInvalid,
      `The solver tolerance must be a positive finite relative residual, received ${String(options.tolerance)}.`,
      options.tolerance,
    );
  }
  if (!Number.isInteger(options.maxIterations) || options.maxIterations < 1) {
    return simError(
      SIM_ERROR_CODES.scenarioInvalid,
      `The solver's iteration cap must be a positive integer, received ${String(options.maxIterations)}.`,
      options.maxIterations,
    );
  }
  return undefined;
}

/** The CSR matrix–vector product y = A·x (rows in index order). */
function applyMatrix(
  system: AssembledStructuralSystem,
  x: Float64Array,
  y: Float64Array,
): void {
  for (let row = 0; row < system.freeDofCount; row += 1) {
    let value = 0;
    for (
      let slot = system.rowPtr[row] ?? 0;
      slot < (system.rowPtr[row + 1] ?? 0);
      slot += 1
    ) {
      value +=
        (system.values[slot] ?? 0) * (x[system.colIndex[slot] ?? 0] ?? 0);
    }
    y[row] = value;
  }
}

/**
 * Solves the reduced system to relative-residual convergence, returning
 * the free-dof displacement vector. Deterministic end to end; declines
 * loudly on the iteration cap, a non-finite state, or a non-positive CG
 * curvature.
 */
export function solveStructuralSystem(
  system: AssembledStructuralSystem,
  options: StructuralSolverOptions,
): SimParseResult<
  {
    readonly displacementFree: Float64Array;
    readonly outcome: StructuralSolverOutcome;
  },
  SimError
> {
  const optionsProblem = structuralSolverOptionsProblem(options);
  if (optionsProblem !== undefined) return simFail(optionsProblem);
  const decline = (
    message: string,
    at: unknown,
  ): SimParseResult<never, SimError> =>
    simFail(simError(SIM_ERROR_CODES.solverUnconverged, message, at));

  const n = system.freeDofCount;
  const b = system.forceFree;
  // The Jacobi preconditioner's diagonal: the CSR diagonal entry.
  const inverseDiagonal = new Float64Array(n);
  for (let row = 0; row < n; row += 1) {
    let diagonal = 0;
    for (
      let slot = system.rowPtr[row] ?? 0;
      slot < (system.rowPtr[row + 1] ?? 0);
      slot += 1
    ) {
      if ((system.colIndex[slot] ?? -1) === row) {
        diagonal = system.values[slot] ?? 0;
        break;
      }
    }
    if (!(diagonal > 0)) {
      return decline(
        `Row ${String(row)} of the reduced system carries a non-positive diagonal — the matrix left the SPD band the CG discipline requires (a fixture-starved or disconnected structure is singular, and the solver declines instead of iterating on a null space).`,
        { row, diagonal },
      );
    }
    inverseDiagonal[row] = 1 / diagonal;
  }

  const displacement = new Float64Array(n);
  let bNorm = 0;
  for (let row = 0; row < n; row += 1) {
    bNorm += (b[row] ?? 0) * (b[row] ?? 0);
  }
  bNorm = Math.sqrt(bNorm);
  if (!Number.isFinite(bNorm)) {
    return decline(
      "The load vector's norm went non-finite before the first iteration; the discipline declines instead of fabricating a field.",
      { bNorm },
    );
  }
  if (bNorm === 0) {
    // Zero load: the equilibrium is u = 0, no iteration needed.
    return simOk({
      displacementFree: displacement,
      outcome: { iterations: 0, relativeResidual: 0 },
    });
  }

  // r = b − A·0 = b.
  const residual = Float64Array.from(b);
  const z = new Float64Array(n);
  const p = new Float64Array(n);
  const ap = new Float64Array(n);
  let rhoPrevious = 0;
  for (let row = 0; row < n; row += 1) {
    z[row] = (residual[row] ?? 0) * (inverseDiagonal[row] ?? 1);
    p[row] = z[row] ?? 0;
    rhoPrevious += (residual[row] ?? 0) * (z[row] ?? 0);
  }
  if (!Number.isFinite(rhoPrevious)) {
    return decline(
      "The solver's preconditioned inner product went non-finite; the discipline declines instead of fabricating a field.",
      { rhoPrevious },
    );
  }
  const residualNorm = (): number => {
    let value = 0;
    for (let row = 0; row < n; row += 1) {
      value += (residual[row] ?? 0) * (residual[row] ?? 0);
    }
    return Math.sqrt(value) / bNorm;
  };
  let relative = residualNorm();
  if (relative <= options.tolerance) {
    return simOk({
      displacementFree: displacement,
      outcome: { iterations: 0, relativeResidual: relative },
    });
  }

  for (let iteration = 1; iteration <= options.maxIterations; iteration += 1) {
    applyMatrix(system, p, ap);
    let pAp = 0;
    for (let row = 0; row < n; row += 1) {
      pAp += (p[row] ?? 0) * (ap[row] ?? 0);
    }
    if (!Number.isFinite(pAp)) {
      return decline(
        `The solver's CG curvature went non-finite at iteration ${String(iteration)}; the discipline declines instead of fabricating a field.`,
        { iteration },
      );
    }
    if (pAp <= 0) {
      return decline(
        `The solver's CG curvature turned non-positive at iteration ${String(iteration)} — the system left the SPD band it was assembled for (a singular or fixture-starved structure); the discipline declines instead of fabricating a field.`,
        { iteration, pAp },
      );
    }
    const alpha = rhoPrevious / pAp;
    for (let row = 0; row < n; row += 1) {
      displacement[row] = (displacement[row] ?? 0) + alpha * (p[row] ?? 0);
      residual[row] = (residual[row] ?? 0) - alpha * (ap[row] ?? 0);
    }
    relative = residualNorm();
    if (!Number.isFinite(relative)) {
      return decline(
        `The solver's residual went non-finite at iteration ${String(iteration)}; the discipline declines instead of fabricating a field.`,
        { iteration, relative },
      );
    }
    if (relative <= options.tolerance) {
      return simOk({
        displacementFree: displacement,
        outcome: { iterations: iteration, relativeResidual: relative },
      });
    }
    let rho = 0;
    for (let row = 0; row < n; row += 1) {
      z[row] = (residual[row] ?? 0) * (inverseDiagonal[row] ?? 1);
      rho += (residual[row] ?? 0) * (z[row] ?? 0);
    }
    if (!Number.isFinite(rho)) {
      return decline(
        `The solver's preconditioned inner product went non-finite at iteration ${String(iteration)}; the discipline declines instead of fabricating a field.`,
        { iteration },
      );
    }
    const beta = rho / rhoPrevious;
    for (let row = 0; row < n; row += 1) {
      p[row] = (z[row] ?? 0) + beta * (p[row] ?? 0);
    }
    rhoPrevious = rho;
  }
  return decline(
    `The solver exhausted its ${String(options.maxIterations)}-iteration cap at relative residual ${String(relative)} against the ${String(options.tolerance)} tolerance; the discipline declines loudly instead of fabricating a converged field.`,
    {
      iterations: options.maxIterations,
      relativeResidual: relative,
      tolerance: options.tolerance,
    },
  );
}
