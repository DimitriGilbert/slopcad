/**
 * The owned steady-state solver (Phase 65a, law S2's "a solver you
 * own"): Jacobi-preconditioned conjugate gradients over the assembled
 * FVM system — zero dependencies, fixed-order float64 arithmetic
 * (sequential dot products, one deterministic code path), so identical
 * systems solve to bitwise-identical fields. The convergence discipline
 * the roadmap demands is the whole contract:
 *
 * - **Residual-driven** — the stop test is the L∞ PRECONDITIONED row
 *   residual (each active row's imbalance divided by its diagonal, in
 *   kelvin), recomputed every iteration; a solve reports the residual
 *   it stopped at.
 * - **Iteration caps decline loudly** — exhausting `maxIterations`
 *   without reaching `toleranceK` fails with `sim/solver-unconverged`
 *   naming the iteration count, the frozen residual, and the tolerance;
 *   a non-finite residual declines the same way. Never a fabricated
 *   converged field.
 *
 * Why CG over Gauss–Seidel/SOR: the assembled matrix is symmetric
 * positive definite (a self-adjoint elliptic operator with half-cell
 * Dirichlet / Robin boundaries — the same property that made SOR
 * safe), and voxel conduction problems are exactly CG's regime — the
 * conditioning is dominated by the cell-count and conductivity-contrast
 * factors under which SOR's spectral radius approaches one (measured:
 * a 343-cell stove shell needed 143k SOR sweeps; CG needs tens), while
 * CG's √κ iteration scaling with the Jacobi preconditioner stays flat.
 *
 * The capacity argument is the transient door: the implicit
 * backward-Euler march adds ρcV/dt to each row's diagonal and
 * ρcV/dt·Tⁿ to its source without mutating the assembled system, so one
 * assembly serves every step of a fixed-coefficient march. Rows with a
 * non-positive diagonal (an insulated cell in a radiation-off problem:
 * no conductance, no capacity) are EXCLUDED from the iteration and hold
 * their value — a posture that must never carry a steady result: the
 * run door's anchor analysis refuses, PER CONNECTED COMPONENT over
 * positive conductance, any problem where a component touches no
 * temperature anchor (the held rows would fabricate a converged field),
 * and the transient march always carries capacity, so every row the
 * report relies on is iterated. The exclusion is closed under coupling
 * (a row coupled by a positive conductance has that conductance on its
 * own diagonal); a caller bypassing the run door and handing the solver
 * an unanchored system gets the held-row posture, pinned by the
 * solver's own test.
 */

import {
  type SimError,
  SIM_ERROR_CODES,
  type SimParseResult,
  simError,
  simFail,
  simOk,
} from "@slopcad/sim-core";
import type { AssembledThermalSystem } from "./system";

/** The solver discipline's knobs, all validated at the problem door. */
export interface ThermalSolverOptions {
  /** The L∞ preconditioned row residual the solve must reach, K. */
  readonly toleranceK: number;
  /** The hard iteration cap — exhausting it declines loudly. */
  readonly maxIterations: number;
}

/** The implicit march's per-row capacity contributions (ρcV/dt terms). */
export interface ThermalSolverCapacity {
  /** Per-cell diagonal addition, W/K (ρcV/dt). */
  readonly diagonalWPerK: Float64Array;
  /** Per-cell source addition, W (ρcV/dt · Tⁿ). */
  readonly sourceW: Float64Array;
}

/** What a converged solve reports about its own discipline. */
export interface ThermalSolverOutcome {
  readonly iterations: number;
  readonly residualK: number;
}

/** Validates the discipline's knobs (the problem door's shared check). */
export function thermalSolverOptionsProblem(
  options: ThermalSolverOptions,
): SimError | undefined {
  if (
    typeof options.toleranceK !== "number" ||
    !Number.isFinite(options.toleranceK) ||
    options.toleranceK <= 0
  ) {
    return simError(
      SIM_ERROR_CODES.scenarioInvalid,
      `The solver tolerance must be a positive finite number of kelvin, received ${String(options.toleranceK)}.`,
      options.toleranceK,
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

/**
 * Solves the system to residual convergence, mutating `temperatureK`
 * in place (warm starts welcome — the steady Picard loop and every
 * implicit step reuse the field). Deterministic end to end; declines
 * loudly on the iteration cap, a non-finite state, or a negative
 * CG curvature (a breakdown on a matrix that left the SPD band).
 */
export function solveThermalSystem(
  system: AssembledThermalSystem,
  temperatureK: Float64Array,
  capacity: ThermalSolverCapacity | undefined,
  options: ThermalSolverOptions,
): SimParseResult<ThermalSolverOutcome, SimError> {
  const optionsProblem = thermalSolverOptionsProblem(options);
  if (optionsProblem !== undefined) return simFail(optionsProblem);
  const { solid, faceG, faceNeighbor, faceRefT, sourceW, diagonalBaseWPerK } =
    system;

  // The active rows: solid cells with a positive total diagonal. The
  // excluded rows hold their value (no coupling reaches them — a
  // positive face conductance puts itself on both rows' diagonals). The
  // run door's per-component anchor analysis keeps this branch
  // unreachable from a steady run (every component touches an anchor,
  // and an anchor's conductance lands on some row of the component);
  // the transient march's capacity keeps it unreachable there.
  const active: number[] = [];
  const diagonal = new Float64Array(system.cellCount);
  const inverseDiagonal = new Float64Array(system.cellCount);
  for (let cell = 0; cell < system.cellCount; cell += 1) {
    if (solid[cell] !== 1) continue;
    const value =
      (diagonalBaseWPerK[cell] ?? 0) +
      (capacity === undefined ? 0 : (capacity.diagonalWPerK[cell] ?? 0));
    if (value <= 0) continue;
    diagonal[cell] = value;
    inverseDiagonal[cell] = 1 / value;
    active.push(cell);
  }
  if (active.length === 0) {
    return simOk({ iterations: 0, residualK: 0 });
  }

  // The residual r = b − A·x, with b = source + capacitySource +
  // Σ G·T_ref over boundary faces and (A·x)_P = diag·x_P − Σ G·x_N over
  // interior faces — the exact quantity the iteration drives to zero.
  const residual = new Float64Array(system.cellCount);
  const applyMatrix = (x: Float64Array, out: Float64Array): void => {
    for (const cell of active) {
      let value = (diagonal[cell] ?? 0) * (x[cell] ?? 0);
      for (let direction = 0; direction < 6; direction += 1) {
        const slot = cell * 6 + direction;
        const conductance = faceG[slot] ?? 0;
        if (conductance === 0) continue;
        const neighbour = faceNeighbor[slot] ?? -1;
        if (neighbour >= 0) {
          value -= conductance * (x[neighbour] ?? 0);
        }
      }
      out[cell] = value;
    }
  };
  const computeResidual = (x: Float64Array): void => {
    for (const cell of active) {
      let value = (sourceW[cell] ?? 0) - (diagonal[cell] ?? 0) * (x[cell] ?? 0);
      if (capacity !== undefined) {
        value += capacity.sourceW[cell] ?? 0;
      }
      for (let direction = 0; direction < 6; direction += 1) {
        const slot = cell * 6 + direction;
        const conductance = faceG[slot] ?? 0;
        if (conductance === 0) continue;
        const neighbour = faceNeighbor[slot] ?? -1;
        value +=
          conductance *
          (neighbour >= 0 ? (x[neighbour] ?? 0) : (faceRefT[slot] ?? 0));
      }
      residual[cell] = value;
    }
  };

  computeResidual(temperatureK);
  const preconditionedInfinityNorm = (): number => {
    let worst = 0;
    for (const cell of active) {
      const normalized = Math.abs(
        (residual[cell] ?? 0) * (inverseDiagonal[cell] ?? 1),
      );
      if (normalized > worst) worst = normalized;
    }
    return worst;
  };
  const decline = (
    message: string,
    at: unknown,
  ): SimParseResult<never, SimError> =>
    simFail(simError(SIM_ERROR_CODES.solverUnconverged, message, at));

  let residualK = preconditionedInfinityNorm();
  if (!Number.isFinite(residualK)) {
    return decline(
      "The solver's residual went non-finite before its first iteration; the discipline declines instead of fabricating a field.",
      { residualK },
    );
  }
  // A warm start already at the tolerance is a converged solve — CG on
  // a zero residual has no direction (p = 0), so this exit is required
  // before the curvature guard, not an optimization.
  if (residualK <= options.toleranceK) {
    return simOk({ iterations: 0, residualK });
  }

  // Preconditioned CG state (all reductions sequential, index order).
  const z = new Float64Array(system.cellCount);
  const p = new Float64Array(system.cellCount);
  const ap = new Float64Array(system.cellCount);
  let rhoPrevious = 0;
  for (const cell of active) {
    z[cell] = (residual[cell] ?? 0) * (inverseDiagonal[cell] ?? 1);
    p[cell] = z[cell] ?? 0;
    rhoPrevious += (residual[cell] ?? 0) * (z[cell] ?? 0);
  }
  if (!Number.isFinite(rhoPrevious)) {
    return decline(
      "The solver's preconditioned inner product went non-finite; the discipline declines instead of fabricating a field.",
      { rhoPrevious },
    );
  }

  for (let iteration = 1; iteration <= options.maxIterations; iteration += 1) {
    applyMatrix(p, ap);
    let pAp = 0;
    for (const cell of active) {
      pAp += (p[cell] ?? 0) * (ap[cell] ?? 0);
    }
    if (!Number.isFinite(pAp)) {
      return decline(
        `The solver's CG curvature went non-finite at iteration ${String(iteration)}; the discipline declines instead of fabricating a field.`,
        { iteration },
      );
    }
    if (pAp <= 0) {
      return decline(
        `The solver's CG curvature turned non-positive at iteration ${String(iteration)} — the system left the SPD band it was assembled for; the discipline declines instead of fabricating a field.`,
        { iteration, pAp },
      );
    }
    const alpha = rhoPrevious / pAp;
    for (const cell of active) {
      temperatureK[cell] = (temperatureK[cell] ?? 0) + alpha * (p[cell] ?? 0);
      residual[cell] = (residual[cell] ?? 0) - alpha * (ap[cell] ?? 0);
    }
    residualK = preconditionedInfinityNorm();
    if (!Number.isFinite(residualK)) {
      return decline(
        `The solver's residual went non-finite at iteration ${String(iteration)}; the discipline declines instead of fabricating a field.`,
        { iteration, residualK },
      );
    }
    if (residualK <= options.toleranceK) {
      return simOk({ iterations: iteration, residualK });
    }
    let rho = 0;
    for (const cell of active) {
      z[cell] = (residual[cell] ?? 0) * (inverseDiagonal[cell] ?? 1);
      rho += (residual[cell] ?? 0) * (z[cell] ?? 0);
    }
    if (!Number.isFinite(rho)) {
      return decline(
        `The solver's preconditioned inner product went non-finite at iteration ${String(iteration)}; the discipline declines instead of fabricating a field.`,
        { iteration },
      );
    }
    const beta = rho / rhoPrevious;
    for (const cell of active) {
      p[cell] = (z[cell] ?? 0) + beta * (p[cell] ?? 0);
    }
    rhoPrevious = rho;
  }
  return decline(
    `The solver exhausted its ${String(options.maxIterations)}-iteration cap at residual ${String(residualK)} K against the ${String(options.toleranceK)} K tolerance; the discipline declines loudly instead of fabricating a converged field.`,
    {
      iterations: options.maxIterations,
      residualK,
      toleranceK: options.toleranceK,
    },
  );
}
