/**
 * The run driver (Phase 63b): the flow run-orchestration layer over the
 * validated 63a kernel. One call — {@link runLbmScenario} — takes a
 * compiled 2D flow scenario (SI at the door, the 63a stepper config,
 * plus the run's own scenario fields: the fixed step budget, the
 * averaging window, the per-scenario grid-convergence flag) and
 * produces the completed run report:
 *
 * - the lift/drag HISTORIES, verbatim from the 63a momentum-exchange
 *   force series (one drag and one lift sample per completed step);
 * - post-hoc TIME AVERAGING of resolved unsteady runs — mean and RMS
 *   fluctuation fields accumulated as second moments DURING the
 *   averaging window (deterministic Welford passes, `./averaging`),
 *   law S9's turbulence answer, emitted as solver fields the Phase 62
 *   overlay path consumes through the S4 projection;
 * - REGIME HONESTY wiring: the summary carries the sim-core S9 numbers
 *   (Re/Ma/Pr plus the advisory qualitative flags) — the compile
 *   boundary's report rides through when the run is compile-fed, and a
 *   standalone scenario gets the SAME numbers from the SAME sim-core
 *   functions here. Flags are honesty markers, never gates: a
 *   turbulence-dominated or compressibility-affected run PROCEEDS
 *   (risk S16; the thresholds and their sources live in sim-core's
 *   `SIM_REGIME_THRESHOLDS`);
 * - the GRID-CONVERGENCE SELF-CHECK (`./convergence`): when the
 *   scenario flags it, the same scenario also runs at a factor-2
 *   refinement with exactly twice the budget and window (matched
 *   physical time, structural through the unit closure) and the drift
 *   report joins the run report — advisory, direction stated;
 * - the scenario-snapshot hash: the compile boundary's run-time content
 *   hash rides through when provided; a standalone scenario hashes its
 *   own canonical JSON view through the same sim-core hasher, so every
 *   report carries the provenance the run-comparison surface keys on.
 *
 * Determinism is the whole layer's stance (law S2): no clock, no
 * randomness, no iteration-order variance — the same scenario and
 * budget produce bitwise-identical summary numbers, histories, and
 * fields, pinned by test. A run whose kernel diverges reports itself:
 * `diverged: true`, the histories up to the freeze, no fields — and
 * {@link lbmRunSimResult} persists it as a FAILED result with the
 * `sim/run-diverged` code, never as a fabricated completed one.
 */

import {
  type SimError,
  SIM_ERROR_CODES,
  SIM_RESULT_SUMMARY_VERSION,
  type SimHistorySeries,
  type SimParseResult,
  type SimRegimeReport,
  type SimResult,
  type SolverSimField,
  type SolverSimScalar,
  simError,
  simFail,
  simMach,
  simOk,
  simPrandtl,
  simRegimeReport,
  simReynolds,
  simScenarioSnapshotHash,
  projectSimResult,
} from "@slopcad/sim-core";

import { LbmMomentAccumulator, type LbmFieldMoments } from "./averaging";
import {
  type LbmConvergenceRungFacts,
  type LbmConvergenceRungView,
  type LbmGridConvergenceReport,
  LBM_GRID_CONVERGENCE_REFINEMENT,
  lbmConvergenceRungProblem,
  lbmGridConvergenceDrift,
} from "./convergence";
import { type LbmSolidMask } from "./state";
import {
  type LbmStepper,
  type LbmStepperConfig,
  createLbmStepper,
} from "./stepper";

/** The averaging window spec: opens at `startStep` and runs to the budget. */
export interface LbmRunAveragingSpec {
  /** The first COMPLETED step inside the window (≥ 1). */
  readonly startStep: number;
}

/**
 * The per-scenario grid-convergence self-check flag: the refined
 * occupancy at half the cell size (the Phase 62 re-voxelization of the
 * same bodies) — the ladder's second rung.
 */
export interface LbmGridConvergenceSpec {
  readonly refinedMask: LbmSolidMask;
}

/**
 * A compiled 2D flow scenario in solver space: the 63a stepper config
 * (SI at its door) plus the run's own fields — the fixed step budget
 * from the scenario record, the optional averaging window, the optional
 * grid-convergence flag, and the compile-boundary provenance (snapshot
 * hash, S9 regime report) when the run is compile-fed.
 */
export interface LbmRunScenario {
  readonly name: string;
  readonly stepper: LbmStepperConfig;
  /** The fixed step budget — a scenario field, never a runtime knob. */
  readonly stepBudget: number;
  /** The characteristic length the S9 numbers are formed with, m. */
  readonly characteristicLengthM: number;
  readonly averaging?: LbmRunAveragingSpec;
  readonly gridConvergence?: LbmGridConvergenceSpec;
  /** The compile boundary's run-time scenario hash, when compile-fed. */
  readonly scenarioSnapshotHash?: string;
  /**
   * The compile boundary's S9 report, when compile-fed. A standalone
   * scenario omits it and the driver computes the SAME numbers from the
   * SAME sim-core functions (one source of truth for the thresholds).
   */
  readonly regime?: SimRegimeReport;
}

/** The averaging window the report's means cover (steps inclusive). */
export interface LbmRunWindow {
  readonly fromStep: number;
  readonly toStep: number;
  readonly sampleCount: number;
}

/** The windowed force means (SI, N per metre of depth) plus the window. */
export interface LbmRunForceSummary {
  readonly window: LbmRunWindow | null;
  readonly meanDragNPerM: number | null;
  readonly meanLiftNPerM: number | null;
}

/** The immutable run facts every report carries (the S9/summary inputs). */
export interface LbmRunGridFacts {
  readonly nx: number;
  readonly ny: number;
  readonly cellSizeM: number;
  readonly timeStepS: number;
}

/** One completed (or honestly diverged) run, as the persistence seam consumes it. */
export interface LbmRunReport {
  readonly scenarioName: string;
  readonly scenarioSnapshotHash: string;
  readonly regime: SimRegimeReport;
  /** The completed step count (frozen early on divergence). */
  readonly steps: number;
  readonly diverged: boolean;
  readonly grid: LbmRunGridFacts;
  readonly physicalDurationS: number;
  readonly forces: LbmRunForceSummary;
  /** The 63a force series: one drag and one lift sample per completed step. */
  readonly histories: readonly SimHistorySeries[];
  /**
   * The final instantaneous solver fields, plus — when the run averaged —
   * the mean and RMS-fluctuation velocity fields (S4-ready, float32
   * storage honesty). Empty on a diverged run: no fabricated fields.
   */
  readonly fields: readonly SolverSimField[];
  /** Present when the scenario flagged the grid-convergence self-check. */
  readonly convergence?: LbmGridConvergenceReport;
  /**
   * Which backend executed the run (Phase 64b's honest marker): the
   * engine that assembled this report stamps it, so the persisted
   * summary records the kernel that RAN — distinct from the scenario's
   * backend preference (a gpu-preferred fallback run stamps "cpu").
   * Absent on reports no engine stamped.
   */
  readonly servedBackend?: "cpu" | "gpu";
}

/** The default snapshot identity: the driver's canonical view of the scenario. */
function runScenarioIdentity(scenario: LbmRunScenario): unknown {
  const { mask, ...stepperRest } = scenario.stepper;
  return {
    name: scenario.name,
    stepBudget: scenario.stepBudget,
    characteristicLengthM: scenario.characteristicLengthM,
    ...(scenario.averaging === undefined
      ? {}
      : { averaging: scenario.averaging }),
    stepper: {
      ...stepperRest,
      mask: {
        nx: mask.nx,
        ny: mask.ny,
        solid: Array.from(mask.solid),
      },
    },
  };
}

/** The S9 numbers, computed exactly as the compile boundary computes them. */
function standaloneRegime(
  scenario: LbmRunScenario,
): SimParseResult<SimRegimeReport, SimError> {
  const fluid = scenario.stepper.fluid;
  const speed = scenario.stepper.characteristicVelocityMPerS;
  const length = scenario.characteristicLengthM;
  const problems: string[] = [];
  if (!Number.isFinite(speed) || speed <= 0) {
    problems.push("characteristic velocity");
  }
  if (!Number.isFinite(length) || length <= 0) {
    problems.push("characteristic length");
  }
  if (problems.length > 0) {
    return simFail(
      simError(
        SIM_ERROR_CODES.scenarioInvalid,
        `A run scenario's ${problems.join(" and ")} must be positive finite SI values for the S9 regime numbers.`,
        { speed, length },
      ),
    );
  }
  return simOk(
    simRegimeReport({
      reynolds: simReynolds(
        fluid.densityKgPerM3,
        speed,
        length,
        fluid.dynamicViscosityPaS,
      ),
      mach: simMach(speed, fluid.speedOfSoundMPerS),
      prandtl: simPrandtl(
        fluid.dynamicViscosityPaS,
        fluid.specificHeatJPerKgK,
        fluid.thermalConductivityWPerMK,
      ),
    }),
  );
}

/** One stepped single run — the shared core of the coarse and fine rungs. */
interface SteppedRun {
  readonly stepper: LbmStepper;
  readonly mask: LbmSolidMask;
  readonly moments: LbmFieldMoments | null;
  readonly window: LbmRunWindow | null;
  readonly meanDragNPerM: number | null;
  readonly meanLiftNPerM: number | null;
}

function stepSingleRun(
  config: LbmStepperConfig,
  stepBudget: number,
  averagingStartStep: number | null,
): SimParseResult<SteppedRun, SimError> {
  const created = createLbmStepper(config);
  if (!created.ok) return created;
  const stepper = created.value;
  const accumulator =
    averagingStartStep === null
      ? null
      : new LbmMomentAccumulator(stepper.meta.nx, stepper.meta.ny);
  const windowStart = averagingStartStep;
  for (let step = 1; step <= stepBudget; step += 1) {
    stepper.advance();
    if (stepper.diverged) break;
    if (accumulator !== null && windowStart !== null && step >= windowStart) {
      const snapshot = stepper.snapshotLattice();
      accumulator.accumulate(snapshot.ux, snapshot.uy);
    }
  }
  const histories = stepper.forceState().history;
  const dragSamples = histories[0]?.samples ?? [];
  const liftSamples = histories[1]?.samples ?? [];
  let window: LbmRunWindow | null = null;
  let meanDragNPerM: number | null = null;
  let meanLiftNPerM: number | null = null;
  if (averagingStartStep !== null && stepper.step >= averagingStartStep) {
    // Samples are 0-based per COMPLETED step: the window [startStep, step]
    // is samples[startStep − 1 … step − 1], accumulated in fixed order.
    let dragSum = 0;
    let liftSum = 0;
    let count = 0;
    for (let index = averagingStartStep - 1; index < stepper.step; index += 1) {
      dragSum += dragSamples[index] ?? 0;
      liftSum += liftSamples[index] ?? 0;
      count += 1;
    }
    window = {
      fromStep: averagingStartStep,
      toStep: stepper.step,
      sampleCount: count,
    };
    if (count > 0) {
      meanDragNPerM = dragSum / count;
      meanLiftNPerM = liftSum / count;
    }
  }
  return simOk({
    stepper,
    mask: config.mask,
    moments: accumulator === null ? null : accumulator.moments(),
    window,
    meanDragNPerM,
    meanLiftNPerM,
  });
}

/** The window-averaged velocity moment fields, S4-ready (mm/s labels, SI values). */
function averagingFields(
  run: SteppedRun,
  config: LbmStepperConfig,
): readonly SolverSimField[] {
  const moments = run.moments;
  if (moments === null || moments.count === 0) return [];
  const stepper = run.stepper;
  const nx = stepper.meta.nx;
  const ny = stepper.meta.ny;
  const dx = stepper.meta.units.cellSizeM;
  const velocityFactor = stepper.meta.units.velocityFactor;
  const originM = config.originM ?? [0, 0];
  const geometry = {
    extent: [nx, ny, 1] as const,
    originM: [originM[0] ?? 0, originM[1] ?? 0, 0] as const,
    spacingM: [dx, dx, dx] as const,
    dataType: "float32" as const,
  };
  const meanX: number[] = [];
  const meanY: number[] = [];
  const fluctuationX: number[] = [];
  const fluctuationY: number[] = [];
  for (let index = 0; index < nx * ny; index += 1) {
    meanX.push((moments.meanX[index] ?? 0) * velocityFactor);
    meanY.push((moments.meanY[index] ?? 0) * velocityFactor);
    fluctuationX.push(
      Math.sqrt(moments.varianceX[index] ?? 0) * velocityFactor,
    );
    fluctuationY.push(
      Math.sqrt(moments.varianceY[index] ?? 0) * velocityFactor,
    );
  }
  return [
    {
      id: "mean-velocity-x",
      unit: "mm/s",
      dimension: "velocity",
      values: meanX,
      ...geometry,
    },
    {
      id: "mean-velocity-y",
      unit: "mm/s",
      dimension: "velocity",
      values: meanY,
      ...geometry,
    },
    {
      id: "fluctuation-velocity-x",
      unit: "mm/s",
      dimension: "velocity",
      values: fluctuationX,
      ...geometry,
    },
    {
      id: "fluctuation-velocity-y",
      unit: "mm/s",
      dimension: "velocity",
      values: fluctuationY,
      ...geometry,
    },
  ];
}

/** Validates the run scenario's own fields (the stepper validates its config). */
function runScenarioProblem(scenario: LbmRunScenario): SimError | undefined {
  if (typeof scenario.name !== "string" || scenario.name.length === 0) {
    return simError(
      SIM_ERROR_CODES.scenarioInvalid,
      "A run scenario must carry a non-empty name.",
      scenario.name,
    );
  }
  if (!Number.isInteger(scenario.stepBudget) || scenario.stepBudget < 1) {
    return simError(
      SIM_ERROR_CODES.scenarioInvalid,
      `A run scenario's step budget must be a positive integer, received ${String(scenario.stepBudget)}.`,
      scenario.stepBudget,
    );
  }
  if (
    !Number.isFinite(scenario.characteristicLengthM) ||
    scenario.characteristicLengthM <= 0
  ) {
    return simError(
      SIM_ERROR_CODES.scenarioInvalid,
      `A run scenario's characteristic length must be a positive finite number of metres, received ${String(scenario.characteristicLengthM)}.`,
      scenario.characteristicLengthM,
    );
  }
  if (
    scenario.scenarioSnapshotHash !== undefined &&
    (typeof scenario.scenarioSnapshotHash !== "string" ||
      scenario.scenarioSnapshotHash.length === 0)
  ) {
    return simError(
      SIM_ERROR_CODES.scenarioInvalid,
      "A run scenario's compile-fed snapshot hash must be a non-empty string.",
      scenario.scenarioSnapshotHash,
    );
  }
  if (scenario.averaging !== undefined) {
    const start = scenario.averaging.startStep;
    if (
      !Number.isInteger(start) ||
      start < 1 ||
      start > scenario.stepBudget - 1
    ) {
      return simError(
        SIM_ERROR_CODES.scenarioInvalid,
        `An averaging window must open at an integer step in [1, ${String(scenario.stepBudget - 1)}] so at least two samples accumulate, received ${String(start)}.`,
        start,
      );
    }
  }
  if (scenario.gridConvergence !== undefined) {
    const coarse = scenario.stepper.mask;
    const refined = scenario.gridConvergence.refinedMask;
    if (
      refined.nx !== coarse.nx * LBM_GRID_CONVERGENCE_REFINEMENT ||
      refined.ny !== coarse.ny * LBM_GRID_CONVERGENCE_REFINEMENT
    ) {
      return simError(
        SIM_ERROR_CODES.scenarioInvalid,
        `The grid-convergence self-check needs the refined mask at exactly factor ${String(LBM_GRID_CONVERGENCE_REFINEMENT)} (${String(coarse.nx * LBM_GRID_CONVERGENCE_REFINEMENT)}×${String(coarse.ny * LBM_GRID_CONVERGENCE_REFINEMENT)} for a ${String(coarse.nx)}×${String(coarse.ny)} ladder), received ${String(refined.nx)}×${String(refined.ny)}.`,
        { coarse: [coarse.nx, coarse.ny], refined: [refined.nx, refined.ny] },
      );
    }
    if (scenario.averaging === undefined) {
      return simError(
        SIM_ERROR_CODES.scenarioInvalid,
        "The grid-convergence self-check compares window-mean quantities at matched physical time: the scenario must also carry an averaging window.",
        scenario.gridConvergence,
      );
    }
  }
  return undefined;
}

/** Builds the refined rung's stepper config — the resolution-ladder step. */
function refinedStepperConfig(
  config: LbmStepperConfig,
  refinedMask: LbmSolidMask,
): LbmStepperConfig {
  return {
    ...config,
    mask: refinedMask,
    cellSizeM: config.cellSizeM / LBM_GRID_CONVERGENCE_REFINEMENT,
  };
}

/** The rung view the drift computation consumes, built from a stepped run. */
function convergenceRungView(
  run: SteppedRun,
  window: LbmRunWindow,
  meanDragNPerM: number,
  meanLiftNPerM: number,
  moments: LbmFieldMoments,
): LbmConvergenceRungView {
  const stepper = run.stepper;
  const facts: LbmConvergenceRungFacts = {
    nx: stepper.meta.nx,
    ny: stepper.meta.ny,
    cellSizeM: stepper.meta.units.cellSizeM,
    completedSteps: stepper.step,
    physicalDurationS: stepper.step * stepper.meta.units.timeStepS,
    averagingWindowSteps: window.sampleCount,
  };
  return {
    facts,
    solid: run.mask.solid,
    meanVelocityXLattice: moments.meanX,
    meanVelocityYLattice: moments.meanY,
    meanDragNPerM,
    meanLiftNPerM,
  };
}

/**
 * Runs one compiled 2D flow scenario to its fixed step budget: the
 * stepped run, its force histories, the optional averaging window's
 * mean/fluctuation fields, the S9 regime wiring, the snapshot-hash
 * provenance, and — when flagged — the factor-2 grid-convergence
 * self-check. Deterministic: the same scenario produces the
 * bitwise-identical report every time (pinned by test).
 */
export function runLbmScenario(
  scenario: LbmRunScenario,
): SimParseResult<LbmRunReport, SimError> {
  const problem = runScenarioProblem(scenario);
  if (problem !== undefined) return simFail(problem);
  let regime: SimRegimeReport;
  if (scenario.regime !== undefined) {
    regime = scenario.regime;
  } else {
    const computed = standaloneRegime(scenario);
    if (!computed.ok) return computed;
    regime = computed.value;
  }
  let snapshotHash: string;
  if (scenario.scenarioSnapshotHash !== undefined) {
    snapshotHash = scenario.scenarioSnapshotHash;
  } else {
    const hashed = simScenarioSnapshotHash(runScenarioIdentity(scenario));
    if (!hashed.ok) return hashed;
    snapshotHash = hashed.value;
  }

  const averagingStart = scenario.averaging?.startStep ?? null;
  const run = stepSingleRun(
    scenario.stepper,
    scenario.stepBudget,
    averagingStart,
  );
  if (!run.ok) return run;
  const stepped = run.value;
  const stepper = stepped.stepper;

  const histories = stepper.forceState().history;
  const report: LbmRunReport = {
    scenarioName: scenario.name,
    scenarioSnapshotHash: snapshotHash,
    regime,
    steps: stepper.step,
    diverged: stepper.diverged,
    grid: {
      nx: stepper.meta.nx,
      ny: stepper.meta.ny,
      cellSizeM: stepper.meta.units.cellSizeM,
      timeStepS: stepper.meta.units.timeStepS,
    },
    physicalDurationS: stepper.step * stepper.meta.units.timeStepS,
    forces: {
      window: stepped.window,
      meanDragNPerM: stepped.meanDragNPerM,
      meanLiftNPerM: stepped.meanLiftNPerM,
    },
    histories,
    fields: stepper.diverged
      ? []
      : [
          ...stepper.solverFields(),
          ...averagingFields(stepped, scenario.stepper),
        ],
  };
  // A diverged run reports itself and skips the self-check: a blown-up
  // run has no trust indicator to compute, and the failed status says so.
  if (stepper.diverged) return simOk(report);

  // The grid-convergence self-check: the same scenario at a factor-2
  // refinement, exactly twice the budget and window (matched physical
  // time — the unit closure halves dt when dx halves), drift reported.
  // A fine rung that cannot run (its τ⁺ leaves the stability band, its
  // outlet density goes non-positive, …) declines the whole run loudly,
  // naming the rung: the scenario asked for the check, and silently
  // dropping it would be the fabricated trust the flag exists to avoid.
  if (
    scenario.gridConvergence !== undefined &&
    scenario.averaging !== undefined
  ) {
    const fineRun = stepSingleRun(
      refinedStepperConfig(
        scenario.stepper,
        scenario.gridConvergence.refinedMask,
      ),
      scenario.stepBudget * LBM_GRID_CONVERGENCE_REFINEMENT,
      scenario.averaging.startStep * LBM_GRID_CONVERGENCE_REFINEMENT,
    );
    if (!fineRun.ok) return fineRun;
    const fine = fineRun.value;
    if (fine.stepper.diverged) {
      return simFail(
        simError(
          SIM_ERROR_CODES.runDiverged,
          "The grid-convergence self-check's refined rung diverged: the ladder measures numerical drift, never a blow-up's debris, and the self-check declines rather than diff against a frozen fine solution.",
          { fineSteps: fine.stepper.step },
        ),
      );
    }
    if (
      stepped.window === null ||
      fine.window === null ||
      stepped.moments === null ||
      fine.moments === null ||
      stepped.meanDragNPerM === null ||
      stepped.meanLiftNPerM === null ||
      fine.meanDragNPerM === null ||
      fine.meanLiftNPerM === null
    ) {
      return simFail(
        simError(
          SIM_ERROR_CODES.scenarioInvalid,
          "The grid-convergence self-check needs window-mean forces and moments from both rungs; the averaging window produced none.",
          scenario.averaging,
        ),
      );
    }
    const coarseView = convergenceRungView(
      stepped,
      stepped.window,
      stepped.meanDragNPerM,
      stepped.meanLiftNPerM,
      stepped.moments,
    );
    const fineView = convergenceRungView(
      fine,
      fine.window,
      fine.meanDragNPerM,
      fine.meanLiftNPerM,
      fine.moments,
    );
    const coarseProblem = lbmConvergenceRungProblem(coarseView);
    if (coarseProblem !== undefined) return simFail(coarseProblem);
    const fineProblem = lbmConvergenceRungProblem(fineView);
    if (fineProblem !== undefined) return simFail(fineProblem);
    const drift = lbmGridConvergenceDrift(
      coarseView,
      fineView,
      stepper.meta.units.latticeVelocity,
    );
    if (!drift.ok) return drift;
    return simOk({ ...report, convergence: drift.value });
  }
  return simOk(report);
}

/**
 * Assembles the persistence-fit {@link SimResult}: the summary (schema
 * version, snapshot hash, status, the S9 regime fields, the projected
 * quantities with explicit units), the projected field blocks, and the
 * force histories. A diverged run persists as a FAILED result carrying
 * `sim/run-diverged` — fields and quantities withheld, histories kept
 * as the honest record of what happened before the freeze.
 */
export function lbmRunSimResult(
  report: LbmRunReport,
): SimParseResult<SimResult, SimError> {
  const scalars: SolverSimScalar[] = [];
  if (!report.diverged) {
    scalars.push({
      name: "steps",
      dimension: "dimensionless",
      value: report.steps,
    });
    scalars.push({
      name: "physical-duration",
      dimension: "time",
      value: report.physicalDurationS,
    });
    if (report.forces.meanDragNPerM !== null) {
      scalars.push({
        name: "mean-drag-force",
        dimension: "force",
        value: report.forces.meanDragNPerM,
      });
    }
    if (report.forces.meanLiftNPerM !== null) {
      scalars.push({
        name: "mean-lift-force",
        dimension: "force",
        value: report.forces.meanLiftNPerM,
      });
    }
  }
  const projected = projectSimResult({
    scalars,
    fields: report.diverged ? [] : report.fields,
  });
  if (!projected.ok) return projected;
  const divergedMessage = `The kernel's divergence sentinel froze the run at step ${String(report.steps)} of ${String(report.scenarioName)}'s budget; no fields or quantities are reported for a blown-up run.`;
  return simOk({
    summary: {
      schemaVersion: SIM_RESULT_SUMMARY_VERSION,
      scenarioSnapshotHash: report.scenarioSnapshotHash,
      status: report.diverged ? "failed" : "completed",
      regime: report.regime,
      quantities: projected.value.scalars,
      ...(report.servedBackend === undefined
        ? {}
        : { servedBackend: report.servedBackend }),
      ...(report.diverged
        ? {
            failureCode: SIM_ERROR_CODES.runDiverged,
            failureMessage: divergedMessage,
          }
        : {}),
    },
    fields: projected.value.fields,
    histories: report.histories,
  });
}
