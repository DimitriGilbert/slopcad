/**
 * The transient march (Phase 65a): the cell-centred enthalpy form of
 * the same FVM balance — ρc·V·dT/dt equals the assembled fluxes — in
 * the two schemes the roadmap names, both stability-disciplined:
 *
 * - **EXPLICIT** (forward Euler). The internal timestep comes from the
 *   row-sum stability criterion over the CURRENT state,
 *   dt ≤ safety·min_P ρc·V_P / Σ G_P — the aggregated Fourier/lumped
 *   limit, safety-factored (default 0.5) so the monotone band is
 *   respected with margin. Σ G_P is the row sum of the SAME assembled
 *   matrix the frozen-field step multiplies, every boundary
 *   conductance counted ONCE: in "full" mode the radiation conductance
 *   in that row is the assembled tangent slope 4εσT³·A at the pre-step
 *   state (the tangent passes through its own point, so explicit
 *   full-mode radiation is evaluation, not lagging); in "linearized"
 *   mode it is the fixed secant the assembly carries. No second
 *   stiffness term is added on top — the stability row and the update
 *   row are the same row, stated once. Each sample interval subdivides into a FIXED number
 *   of uniform substeps (recomputed per interval from that interval's
 *   start state — deterministic), so an authored `timeStepS` can only
 *   shrink the internal dt, never push it past the criterion.
 * - **IMPLICIT** (backward Euler). Unconditionally stable: the capacity
 *   ρcV/dt joins the diagonal, the old field joins the source, and the
 *   per-step system is solved by the same solver discipline
 *   (preconditioned CG, warm-started from the old field); "full"-mode
 *   radiation Picard-iterates within the step. The march's dt defaults
 *   to the sample interval and subdivides the same way when authored
 *   smaller.
 *
 * Energy conservation is BY CONSTRUCTION: every substep's algebra is
 * the balance, so the cumulative ledger (Σ dt·in − Σ dt·out = Σ ρcV·ΔT)
 * closes to floating-point roundoff — the audit's exactness (exact in
 * the "off" and "full" modes; the linearized mode's enclosure net
 * carries its own small linearization residual, like every other
 * linearized term). A
 * non-finite field value is the divergence sentinel: the march freezes
 * at its last completed sample and reports itself (`sim/run-diverged`
 * at the persistence seam), never a fabricated completion.
 */

import {
  type SimError,
  SIM_ERROR_CODES,
  type SimHistorySeries,
  type SimParseResult,
  simError,
  simFail,
  simOk,
} from "@slopcad/sim-core";
import type { ThermalProblem } from "./system";

import { assembleThermalSystem } from "./system";
import {
  type ThermalSolverCapacity,
  type ThermalSolverOptions,
  solveThermalSystem,
} from "./solver";
import { thermalBoundaryFluxLedger } from "./audit";

/** The transient mode's spec. */
export interface ThermalTransientSpec {
  readonly kind: "transient";
  readonly scheme: "explicit" | "implicit";
  /** The physical end time, s — an integer multiple of the sample interval. */
  readonly durationS: number;
  /** The history/field sampling cadence, s. */
  readonly sampleIntervalS: number;
  /** The uniform initial field, K. */
  readonly initialTemperatureK: number;
  /**
   * The requested march timestep, s. Implicit: the substep ceiling
   * (default: the sample interval). Explicit: a ceiling BELOW the
   * stability criterion — an author may buy accuracy, never instability.
   */
  readonly timeStepS?: number;
  /** The explicit safety factor on the stability timestep, (0, 1] (default 0.5). */
  readonly stabilitySafetyFactor?: number;
  /** The implicit solve's residual tolerance per step, K (default 1e-10). */
  readonly toleranceK?: number;
  /** The solver iteration cap per solve (default 20_000). */
  readonly maxIterations?: number;
  /** The implicit full-radiation Picard tolerance per step, K (default 1e-8). */
  readonly picardToleranceK?: number;
  /** The Picard cap per step (default 100). */
  readonly maxOuterIterations?: number;
}

/** The transient spec's resolved knobs (defaults applied). */
export interface ResolvedThermalTransientSpec {
  readonly scheme: "explicit" | "implicit";
  readonly sampleCount: number;
  readonly sampleIntervalS: number;
  readonly durationS: number;
  readonly initialTemperatureK: number;
  readonly timeStepS?: number;
  readonly stabilitySafetyFactor: number;
  readonly toleranceK: number;
  readonly maxIterations: number;
  readonly picardToleranceK: number;
  readonly maxOuterIterations: number;
}

/** The transient defaults, stated once. */
export const THERMAL_TRANSIENT_DEFAULTS = Object.freeze({
  stabilitySafetyFactor: 0.5,
  toleranceK: 1e-10,
  maxIterations: 20_000,
  picardToleranceK: 1e-8,
  maxOuterIterations: 100,
});

/** The transient histories' series names and unit (the flow package's precedent). */
export const THERMAL_HISTORY_SERIES_NAMES = [
  "temperature-max",
  "temperature-mean",
  "temperature-min",
] as const;

export const THERMAL_HISTORY_UNIT = "K";

/** What the transient march reports about its own discipline. */
export interface ThermalTransientOutcome {
  readonly kind: "transient";
  readonly scheme: "explicit" | "implicit";
  readonly temperatureK: Float64Array;
  /** Samples INCLUDING t = 0 (the histories' length). */
  readonly samples: number;
  /** The total march substeps taken (frozen on divergence). */
  readonly internalSteps: number;
  /** The last interval's internal timestep, s. */
  readonly timeStepS: number;
  /** The completed physical time, s (frozen on divergence). */
  readonly physicalDurationS: number;
  readonly diverged: boolean;
  readonly histories: readonly SimHistorySeries[];
  /** The cumulative energy ledger (the conservation audit, J). */
  readonly cumulative: {
    readonly energyInJ: number;
    readonly energyOutJ: number;
    readonly storedJ: number;
    /** energyInJ − energyOutJ − storedJ ≈ 0 — the closure, measured. */
    readonly closureJ: number;
  };
}

/** Validates and defaults a transient spec (the problem door's shared check). */
export function resolveThermalTransientSpec(
  spec: ThermalTransientSpec,
): SimParseResult<ResolvedThermalTransientSpec, SimError> {
  const refuse = (
    message: string,
    at: unknown,
  ): SimParseResult<never, SimError> =>
    simFail(simError(SIM_ERROR_CODES.scenarioInvalid, message, at));
  if (spec.scheme !== "explicit" && spec.scheme !== "implicit") {
    return refuse(
      `A transient march's scheme must be "explicit" or "implicit", received ${String(spec.scheme)}.`,
      spec.scheme,
    );
  }
  for (const [name, value] of [
    ["duration", spec.durationS],
    ["sample interval", spec.sampleIntervalS],
    ["initial temperature", spec.initialTemperatureK],
  ] as const) {
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
      return refuse(
        `A transient march's ${name} must be a positive finite value, received ${String(value)}.`,
        value,
      );
    }
  }
  const intervals = spec.durationS / spec.sampleIntervalS;
  const sampleCount = Math.round(intervals);
  if (
    sampleCount < 1 ||
    Math.abs(sampleCount * spec.sampleIntervalS - spec.durationS) >
      1e-9 * spec.durationS
  ) {
    return refuse(
      `A transient march's duration (${String(spec.durationS)} s) must be an integer multiple of its sample interval (${String(spec.sampleIntervalS)} s) so every sample lands on the cadence.`,
      { durationS: spec.durationS, sampleIntervalS: spec.sampleIntervalS },
    );
  }
  if (
    spec.timeStepS !== undefined &&
    (typeof spec.timeStepS !== "number" ||
      !Number.isFinite(spec.timeStepS) ||
      spec.timeStepS <= 0)
  ) {
    return refuse(
      `A transient march's requested timestep must be positive finite seconds when present, received ${String(spec.timeStepS)}.`,
      spec.timeStepS,
    );
  }
  const stabilitySafetyFactor =
    spec.stabilitySafetyFactor ??
    THERMAL_TRANSIENT_DEFAULTS.stabilitySafetyFactor;
  if (
    typeof stabilitySafetyFactor !== "number" ||
    !Number.isFinite(stabilitySafetyFactor) ||
    stabilitySafetyFactor <= 0 ||
    stabilitySafetyFactor > 1
  ) {
    return refuse(
      `An explicit march's stability safety factor must lie in (0, 1], received ${String(stabilitySafetyFactor)} — the row-sum criterion is the exact limit, and the discipline keeps a margin below it.`,
      spec.stabilitySafetyFactor,
    );
  }
  const toleranceK = spec.toleranceK ?? THERMAL_TRANSIENT_DEFAULTS.toleranceK;
  const maxIterations =
    spec.maxIterations ?? THERMAL_TRANSIENT_DEFAULTS.maxIterations;
  const picardToleranceK =
    spec.picardToleranceK ?? THERMAL_TRANSIENT_DEFAULTS.picardToleranceK;
  const maxOuterIterations =
    spec.maxOuterIterations ?? THERMAL_TRANSIENT_DEFAULTS.maxOuterIterations;
  if (!Number.isFinite(toleranceK) || toleranceK <= 0) {
    return refuse(
      `A transient march's tolerance must be positive finite kelvin, received ${String(toleranceK)}.`,
      spec.toleranceK,
    );
  }
  if (!Number.isInteger(maxIterations) || maxIterations < 1) {
    return refuse(
      `A transient march's solver iteration cap must be a positive integer, received ${String(maxIterations)}.`,
      spec.maxIterations,
    );
  }
  if (!Number.isFinite(picardToleranceK) || picardToleranceK <= 0) {
    return refuse(
      `A transient march's Picard tolerance must be positive finite kelvin, received ${String(picardToleranceK)}.`,
      spec.picardToleranceK,
    );
  }
  if (!Number.isInteger(maxOuterIterations) || maxOuterIterations < 1) {
    return refuse(
      `A transient march's Picard cap must be a positive integer, received ${String(maxOuterIterations)}.`,
      spec.maxOuterIterations,
    );
  }
  return simOk(
    Object.freeze({
      scheme: spec.scheme,
      sampleCount,
      sampleIntervalS: spec.sampleIntervalS,
      durationS: spec.durationS,
      initialTemperatureK: spec.initialTemperatureK,
      ...(spec.timeStepS === undefined ? {} : { timeStepS: spec.timeStepS }),
      stabilitySafetyFactor,
      toleranceK,
      maxIterations,
      picardToleranceK,
      maxOuterIterations,
    }),
  );
}

/** The per-cell capacity ρcV the march divides by (J/K). */
export function thermalCellCapacityJPerK(
  problem: ThermalProblem,
): Float64Array {
  const cellCount = problem.grid.nx * problem.grid.ny * problem.grid.nz;
  const capacity = new Float64Array(cellCount);
  for (let cell = 0; cell < cellCount; cell += 1) {
    if (problem.grid.solid[cell] !== 1) continue;
    const rhoC = problem.volumetricHeatCapacityJPerM3K[cell] ?? Number.NaN;
    capacity[cell] = rhoC * problem.grid.cellVolumeM3;
  }
  return capacity;
}

/**
 * The explicit scheme's stability timestep at a field state: the
 * row-sum criterion min_P ρcV_P/Σ G_P × the safety factor, where Σ G_P
 * is the per-cell row sum of the system assembled AT that state — the
 * exact conductance set the frozen-field forward-Euler step multiplies,
 * with every boundary conductance (radiation included) counted ONCE:
 * the full mode's assembled tangent slope 4εσT³·A, or the linearized
 * mode's fixed secant, at every radiating face. Nothing is added on
 * top: the stability row and the update row are the same row.
 */
export function thermalExplicitStabilityTimeStepS(
  problem: ThermalProblem,
  temperatureK: Float64Array,
  capacityJPerK: Float64Array,
  safetyFactor: number,
): number {
  const { grid } = problem;
  const cellCount = grid.nx * grid.ny * grid.nz;
  const system = assembleThermalSystem(problem, { iterateK: temperatureK });
  let limit = Number.POSITIVE_INFINITY;
  for (let cell = 0; cell < cellCount; cell += 1) {
    if (grid.solid[cell] !== 1) continue;
    let rowSum = 0;
    for (let direction = 0; direction < 6; direction += 1) {
      rowSum += system.faceG[cell * 6 + direction] ?? 0;
    }
    const capacity = capacityJPerK[cell] ?? Number.NaN;
    if (!(capacity > 0) || !(rowSum > 0)) continue;
    const cellLimit = capacity / rowSum;
    if (cellLimit < limit) limit = cellLimit;
  }
  if (!Number.isFinite(limit)) {
    // Nothing couples any cell (a fully insulated solid): any timestep
    // is stable; the sample interval bounds it.
    return Number.POSITIVE_INFINITY;
  }
  return safetyFactor * limit;
}

/**
 * Marches the transient to its duration: samples the history triple at
 * every interval boundary (t = 0 included), accumulates the cumulative
 * energy ledger substep by substep (the by-construction conservation),
 * and freezes at the divergence sentinel. Deterministic — the same
 * problem and spec produce the bitwise-identical march every time.
 */
export function marchThermalTransient(
  problem: ThermalProblem,
  spec: ResolvedThermalTransientSpec,
): SimParseResult<ThermalTransientOutcome, SimError> {
  const cellCount = problem.grid.nx * problem.grid.ny * problem.grid.nz;
  const temperatureK = new Float64Array(cellCount).fill(
    spec.initialTemperatureK,
  );
  const capacity = thermalCellCapacityJPerK(problem);
  for (let cell = 0; cell < cellCount; cell += 1) {
    const cellCapacity = capacity[cell] ?? Number.NaN;
    if (problem.grid.solid[cell] === 1 && !(cellCapacity > 0)) {
      return simFail(
        simError(
          SIM_ERROR_CODES.scenarioInvalid,
          "The transient march needs ρc on every solid cell; a material record without specific heat cannot march, and the door declines instead of fabricating a capacity.",
          cell,
        ),
      );
    }
  }

  const maxima: number[] = [];
  const means: number[] = [];
  const minima: number[] = [];
  const sample = (): void => {
    let max = Number.NEGATIVE_INFINITY;
    let min = Number.POSITIVE_INFINITY;
    let sum = 0;
    let count = 0;
    for (let cell = 0; cell < cellCount; cell += 1) {
      if (problem.grid.solid[cell] !== 1) continue;
      const value = temperatureK[cell] ?? 0;
      if (value > max) max = value;
      if (value < min) min = value;
      sum += value;
      count += 1;
    }
    maxima.push(max);
    means.push(count > 0 ? sum / count : spec.initialTemperatureK);
    minima.push(min);
  };
  sample();

  let internalSteps = 0;
  let physicalDurationS = 0;
  let diverged = false;
  let lastTimeStepS = spec.sampleIntervalS;
  let energyInJ = 0;
  let energyOutJ = 0;
  const solverOptions: ThermalSolverOptions = {
    toleranceK: spec.toleranceK,
    maxIterations: spec.maxIterations,
  };

  for (let interval = 0; interval < spec.sampleCount; interval += 1) {
    if (diverged) break;
    const remaining = spec.sampleIntervalS;
    let substeps: number;
    if (spec.scheme === "explicit") {
      const stable = thermalExplicitStabilityTimeStepS(
        problem,
        temperatureK,
        capacity,
        spec.stabilitySafetyFactor,
      );
      const ceiling =
        spec.timeStepS === undefined
          ? stable
          : Math.min(spec.timeStepS, stable);
      substeps = Math.max(1, Math.ceil(remaining / ceiling));
    } else {
      const requested = spec.timeStepS ?? spec.sampleIntervalS;
      substeps = Math.max(1, Math.ceil(remaining / requested));
    }
    const dt = remaining / substeps;
    lastTimeStepS = dt;

    for (let substep = 0; substep < substeps && !diverged; substep += 1) {
      if (spec.scheme === "explicit") {
        // The ledger AT the pre-step state: forward Euler's fluxes ARE
        // this state's balance, so conservation closes exactly.
        const ledger = thermalBoundaryFluxLedger({
          problem,
          temperatureK,
        });
        energyInJ +=
          dt * (ledger.sourceW + ledger.neumannInW + ledger.dirichletNetW);
        energyOutJ += dt * (ledger.convectionOutW + ledger.radiationOutW);
        const system = assembleThermalSystem(problem, {
          iterateK: temperatureK,
        });
        // Forward Euler reads the FROZEN pre-step field only — a Jacobi
        // update from a snapshot, never in-place Gauss–Seidel reads of
        // already-cooled neighbours (that would fabricate extra loss).
        const frozen = Float64Array.from(temperatureK);
        for (let cell = 0; cell < cellCount; cell += 1) {
          if (problem.grid.solid[cell] !== 1) continue;
          let flux = system.sourceW[cell] ?? 0;
          for (let direction = 0; direction < 6; direction += 1) {
            const slot = cell * 6 + direction;
            const conductance = system.faceG[slot] ?? 0;
            if (conductance === 0) continue;
            const neighbour = system.faceNeighbor[slot] ?? -1;
            flux +=
              conductance *
              ((neighbour >= 0
                ? (frozen[neighbour] ?? 0)
                : (system.faceRefT[slot] ?? 0)) -
                (frozen[cell] ?? 0));
          }
          temperatureK[cell] =
            (frozen[cell] ?? 0) + (dt * flux) / (capacity[cell] ?? 1);
        }
        physicalDurationS += dt;
        internalSteps += 1;
        if (!fieldIsFinite(temperatureK, problem.grid.solid)) {
          diverged = true;
        }
      } else {
        const previous = Float64Array.from(temperatureK);
        const solverCapacity: ThermalSolverCapacity = {
          diagonalWPerK: new Float64Array(cellCount).map(
            (_, cell) => (capacity[cell] ?? 0) / dt,
          ),
          sourceW: new Float64Array(cellCount).map(
            (_, cell) => ((capacity[cell] ?? 0) / dt) * (previous[cell] ?? 0),
          ),
        };
        for (
          let iteration = 1;
          iteration <= spec.maxOuterIterations;
          iteration += 1
        ) {
          const lagged = Float64Array.from(temperatureK);
          const system = assembleThermalSystem(problem, { iterateK: lagged });
          const solved = solveThermalSystem(
            system,
            temperatureK,
            solverCapacity,
            solverOptions,
          );
          if (!solved.ok) return solved;
          let step = 0;
          for (let cell = 0; cell < cellCount; cell += 1) {
            if (problem.grid.solid[cell] !== 1) continue;
            const delta = Math.abs(
              (temperatureK[cell] ?? 0) - (lagged[cell] ?? 0),
            );
            if (delta > step) step = delta;
          }
          if (step <= spec.picardToleranceK) break;
          if (iteration === spec.maxOuterIterations) {
            return simFail(
              simError(
                SIM_ERROR_CODES.solverUnconverged,
                `The implicit march's per-step Picard loop exhausted its ${String(spec.maxOuterIterations)}-iteration cap; the lagged radiation never settled within the step, and the discipline declines instead of fabricating it.`,
                { step: interval + 1, iteration },
              ),
            );
          }
        }
        physicalDurationS += dt;
        internalSteps += 1;
        if (!fieldIsFinite(temperatureK, problem.grid.solid)) {
          diverged = true;
        }
        if (!diverged) {
          // Backward Euler's balance holds at the POST-step state to
          // solver tolerance — the ledger closes on it.
          const ledger = thermalBoundaryFluxLedger({
            problem,
            temperatureK,
          });
          energyInJ +=
            dt * (ledger.sourceW + ledger.neumannInW + ledger.dirichletNetW);
          energyOutJ += dt * (ledger.convectionOutW + ledger.radiationOutW);
        }
      }
    }
    if (!diverged) sample();
  }

  let storedJ = 0;
  for (let cell = 0; cell < cellCount; cell += 1) {
    if (problem.grid.solid[cell] !== 1) continue;
    storedJ +=
      (capacity[cell] ?? 0) *
      ((temperatureK[cell] ?? 0) - spec.initialTemperatureK);
  }
  const histories: SimHistorySeries[] = [
    {
      name: THERMAL_HISTORY_SERIES_NAMES[0] ?? "temperature-max",
      unit: THERMAL_HISTORY_UNIT,
      samples: maxima,
    },
    {
      name: THERMAL_HISTORY_SERIES_NAMES[1] ?? "temperature-mean",
      unit: THERMAL_HISTORY_UNIT,
      samples: means,
    },
    {
      name: THERMAL_HISTORY_SERIES_NAMES[2] ?? "temperature-min",
      unit: THERMAL_HISTORY_UNIT,
      samples: minima,
    },
  ];
  return simOk({
    kind: "transient",
    scheme: spec.scheme,
    temperatureK,
    samples: maxima.length,
    internalSteps,
    timeStepS: lastTimeStepS,
    physicalDurationS,
    diverged,
    histories,
    cumulative: {
      energyInJ,
      energyOutJ,
      storedJ,
      closureJ: energyInJ - energyOutJ - storedJ,
    },
  });
}

function fieldIsFinite(field: Float64Array, solid: Uint8Array): boolean {
  for (let cell = 0; cell < field.length; cell += 1) {
    if (solid[cell] === 1 && !Number.isFinite(field[cell] ?? 0)) {
      return false;
    }
  }
  return true;
}
