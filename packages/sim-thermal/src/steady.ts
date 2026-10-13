/**
 * The steady solve (Phase 65a): the implicit equilibrium the roadmap's
 * §7.12 ruling demands — a stove's walls settle at a real temperature
 * because every loss channel is present. Structure:
 *
 * 1. an OUTER Picard loop that re-assembles the radiation state (every
 *    full-mode tangent boundary and every enclosure's T_enc) at the
 *    current iterate — the tangent form converges monotonically where
 *    naive source lagging would oscillate (radiation-dominated
 *    boundaries), and its fixed point satisfies the EXACT quartic;
 * 2. an INNER solve of the assembled linear system to the residual
 *    tolerance (`./solver`, preconditioned CG), warm-started from the
 *    iterate;
 * 3. outer convergence when the iterate stops moving
 *    (max |ΔT| ≤ picardToleranceK) — pure-conduction and fixed-linearized
 *    problems exit on the second outer iteration (the re-assembled
 *    system is identical and the warm start is already at its solution);
 *    the caps decline loudly (`sim/solver-unconverged` for the inner
 *    discipline, the same code for an outer cap that never settles).
 *
 * At the fixed point of "full" mode the balance holds with the EXACT
 * Stefan–Boltzmann law evaluated at the converged field — the property
 * the enclosed-heat-source fixture and the energy audit pin.
 */

import {
  type SimError,
  SIM_ERROR_CODES,
  type SimParseResult,
  simError,
  simFail,
  simOk,
} from "@slopcad/sim-core";
import type { ThermalProblem } from "./system";

import { assembleThermalSystem } from "./system";
import {
  type ThermalSolverOptions,
  solveThermalSystem,
  thermalSolverOptionsProblem,
} from "./solver";

/** The steady mode's spec (the knobs beyond the problem's physics). */
export interface ThermalSteadySpec {
  readonly kind: "steady";
  /**
   * The uniform field the iteration starts from, K (default 293.15).
   * Affects only the iteration path in "full" mode — and, honestly
   * stated, the linearized mode's FIXED radiation coefficient when the
   * radiation reference is left to default from it.
   */
  readonly initialTemperatureK?: number;
  /** The solver residual tolerance, K (default 1e-10). */
  readonly toleranceK?: number;
  /** The solver iteration cap (default 20_000) — exhausting it declines loudly. */
  readonly maxIterations?: number;
  /** The outer Picard convergence, max |ΔT| between outer iterates, K (default 1e-8). */
  readonly picardToleranceK?: number;
  /** The outer Picard cap (default 500) — exhausting it declines loudly. */
  readonly maxOuterIterations?: number;
}

/** What the steady solve reports about its own discipline. */
export interface ThermalSteadyOutcome {
  readonly kind: "steady";
  readonly temperatureK: Float64Array;
  /** Total solver iterations across every outer iteration. */
  readonly iterations: number;
  readonly outerIterations: number;
  /** The final inner residual, K. */
  readonly residualK: number;
  /** The final outer iterate step, K. */
  readonly outerStepK: number;
}

/** The steady spec's resolved knobs (one shape, defaults applied). */
export interface ResolvedThermalSteadySpec {
  readonly initialTemperatureK: number;
  readonly toleranceK: number;
  readonly maxIterations: number;
  readonly picardToleranceK: number;
  readonly maxOuterIterations: number;
}

/** The steady defaults, stated once. */
export const THERMAL_STEADY_DEFAULTS = Object.freeze({
  initialTemperatureK: 293.15,
  toleranceK: 1e-10,
  maxIterations: 20_000,
  picardToleranceK: 1e-8,
  maxOuterIterations: 500,
});

/** Validates and defaults a steady spec (the problem door's shared check). */
export function resolveThermalSteadySpec(
  spec: ThermalSteadySpec,
): SimParseResult<ResolvedThermalSteadySpec, SimError> {
  const initialTemperatureK =
    spec.initialTemperatureK ?? THERMAL_STEADY_DEFAULTS.initialTemperatureK;
  const toleranceK = spec.toleranceK ?? THERMAL_STEADY_DEFAULTS.toleranceK;
  const maxIterations =
    spec.maxIterations ?? THERMAL_STEADY_DEFAULTS.maxIterations;
  const picardToleranceK =
    spec.picardToleranceK ?? THERMAL_STEADY_DEFAULTS.picardToleranceK;
  const maxOuterIterations =
    spec.maxOuterIterations ?? THERMAL_STEADY_DEFAULTS.maxOuterIterations;
  if (!Number.isFinite(initialTemperatureK) || initialTemperatureK <= 0) {
    return simFail(
      simError(
        SIM_ERROR_CODES.scenarioInvalid,
        `A steady solve's initial temperature must be positive finite kelvin, received ${String(initialTemperatureK)}.`,
        spec.initialTemperatureK,
      ),
    );
  }
  const solverProblem = thermalSolverOptionsProblem({
    toleranceK,
    maxIterations,
  });
  if (solverProblem !== undefined) return simFail(solverProblem);
  if (!Number.isFinite(picardToleranceK) || picardToleranceK <= 0) {
    return simFail(
      simError(
        SIM_ERROR_CODES.scenarioInvalid,
        `A steady solve's Picard tolerance must be positive finite kelvin, received ${String(picardToleranceK)}.`,
        spec.picardToleranceK,
      ),
    );
  }
  if (!Number.isInteger(maxOuterIterations) || maxOuterIterations < 1) {
    return simFail(
      simError(
        SIM_ERROR_CODES.scenarioInvalid,
        `A steady solve's Picard iteration cap must be a positive integer, received ${String(maxOuterIterations)}.`,
        spec.maxOuterIterations,
      ),
    );
  }
  return simOk(
    Object.freeze({
      initialTemperatureK,
      toleranceK,
      maxIterations,
      picardToleranceK,
      maxOuterIterations,
    }),
  );
}

/**
 * Solves the steady equilibrium: the outer Picard loop over radiation
 * lagging, the inner solve to residual (preconditioned CG), loud
 * declines on either cap.
 * Deterministic — the same problem and spec produce the
 * bitwise-identical field, iteration counts, and residuals every time.
 */
export function solveThermalSteady(
  problem: ThermalProblem,
  spec: ResolvedThermalSteadySpec,
): SimParseResult<ThermalSteadyOutcome, SimError> {
  const cellCount = problem.grid.nx * problem.grid.ny * problem.grid.nz;
  const temperatureK = new Float64Array(cellCount).fill(
    spec.initialTemperatureK,
  );
  const previous = new Float64Array(cellCount);
  const solverOptions: ThermalSolverOptions = {
    toleranceK: spec.toleranceK,
    maxIterations: spec.maxIterations,
  };
  let totalIterations = 0;
  let outerIterations = 0;
  let residualK = Number.POSITIVE_INFINITY;
  let outerStepK = Number.POSITIVE_INFINITY;
  for (
    let iteration = 1;
    iteration <= spec.maxOuterIterations;
    iteration += 1
  ) {
    previous.set(temperatureK);
    const system = assembleThermalSystem(problem, { iterateK: previous });
    const solved = solveThermalSystem(
      system,
      temperatureK,
      undefined,
      solverOptions,
    );
    if (!solved.ok) return solved;
    totalIterations += solved.value.iterations;
    residualK = solved.value.residualK;
    outerIterations = iteration;
    let step = 0;
    for (let cell = 0; cell < cellCount; cell += 1) {
      if (problem.grid.solid[cell] !== 1) continue;
      const delta = Math.abs((temperatureK[cell] ?? 0) - (previous[cell] ?? 0));
      if (delta > step) step = delta;
    }
    outerStepK = step;
    if (step <= spec.picardToleranceK) {
      return simOk({
        kind: "steady",
        temperatureK,
        iterations: totalIterations,
        outerIterations,
        residualK,
        outerStepK,
      });
    }
  }
  return simFail(
    simError(
      SIM_ERROR_CODES.solverUnconverged,
      `The steady Picard loop exhausted its ${String(spec.maxOuterIterations)}-iteration cap at outer step ${String(outerStepK)} K against the ${String(spec.picardToleranceK)} K tolerance; the lagged radiation never settled, and the discipline declines instead of fabricating an equilibrium.`,
      { outerIterations, outerStepK, picardToleranceK: spec.picardToleranceK },
    ),
  );
}
