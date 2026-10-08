/**
 * The real 2D flow engine behind the Phase 61 `SimEngine` contract
 * (Phase 63c): the deterministic LBM adapter that turns a compiled flow
 * problem into a run — the `fake-kernel` → real-kernel transition the
 * 61b fake engine was staged for. One `run` call:
 *
 * 1. **Consumes the compiled problem** — the 63c geometry-aware compile's
 *    occupancy slice becomes the lattice mask
 *    (`lbmSolidMaskFromGrid`, the documented node interpretation), the
 *    compiled conditions become the four face specs, the compiled
 *    fluid/regime/snapshot-hash ride through, and the compile's run
 *    controls set the budget, the averaging window, and the
 *    grid-convergence flag.
 * 2. **Runs with cooperative cancellation** — one macrotask yield per
 *    step (the contract's documented cancellation window; a conforming
 *    engine never catches the host's callback throws), progress after
 *    every step, and a field-chunk PREVIEW round every
 *    {@link LBM_PREVIEW_INTERVAL_STEPS} steps plus one at the final
 *    step. The preview decimation is step-counted against the recorded
 *    `kernel.lbm2d.referenceGrid.stepBatchMs` budget: one preview round
 *    costs about one budgeted ten-step batch at the reference grid, so
 *    interactive rates hold where the roadmap demands them. The preview
 *    publishes the DOCUMENT-SPACE speed block — the same block, bitwise,
 *    the finalized result carries — split into protocol chunks.
 * 3. **Finalizes to a `SimResult`** — through the 63b report assembly
 *    (`lbmRunSimResult`): the S9 regime wiring, the snapshot-hash
 *    provenance, the lift/drag histories, the window means, the mean and
 *    RMS-fluctuation velocity fields, and — when the scenario flagged
 *    it — the factor-2 grid-convergence self-check, whose drift joins
 *    the summary as dimensionless quantities so the trust indicator
 *    survives persistence.
 *
 * Determinism is the whole stance (law S2): no clock reads, no
 * randomness, a fixed emission schedule — the same compiled problem
 * produces the bitwise-identical result and the identical notification
 * stream every time, pinned over the node worker channel by test.
 */

import {
  type SimEngine,
  type SimEngineFieldChunk,
  type SimEngineProgress,
  type SimEngineRequest,
  createFakeSimEngine,
  type SimError,
  SIM_ERROR_CODES,
  SIM_FLOW_DEFAULT_STEP_BUDGET,
  type SimParseResult,
  type SimResult,
  type SimResultFieldBlock,
  type SimScenarioKind,
  type SolverSimField,
  simError,
  simFail,
  simOk,
  splitSimFieldBlock,
  projectSimResult,
} from "@slopcad/sim-core";

import { LbmMomentAccumulator, type LbmFieldMoments } from "./averaging";
import {
  type LbmConvergenceRungView,
  type LbmGridConvergenceReport,
  LBM_GRID_CONVERGENCE_REFINEMENT,
  lbmConvergenceRungProblem,
  lbmGridConvergenceDrift,
} from "./convergence";
import { lbmSolidMaskFromGrid } from "./occupancy";
import { type LbmRunReport, type LbmRunWindow, lbmRunSimResult } from "./run";
import {
  type LbmStepper,
  type LbmStepperConfig,
  type LbmFaceSpec,
  createLbmStepper,
} from "./stepper";

/** The real engine's stable id (the worker host's engine-selection key). */
export const LBM_SIM_ENGINE_ID = "lbm2d-cpu-reference";

/**
 * The streaming-preview interval: one preview round every this many
 * steps. Decimation chosen against the recorded perf budget
 * (`kernel.lbm2d.referenceGrid.stepBatchMs`, 10 steps ≈ 240 ms median /
 * 750 ms budget at the 512×256 reference grid) — one round costs about
 * one budgeted batch, the interactive-rate cadence the roadmap pins.
 */
export const LBM_PREVIEW_INTERVAL_STEPS = 10;

/**
 * The values-per-chunk ceiling a preview round splits its block into —
 * the protocol's framing knob, sized so one chunk stays a small message
 * at reference grids.
 */
export const LBM_PREVIEW_CHUNK_MAX_VALUES = 16384;

/** The scenario kinds the real engine solves (the 2D wind tunnel). */
const SUPPORTED_KINDS: readonly SimScenarioKind[] = ["flow"];

/** The four lateral faces the 2D slice consumes, by their compiled names. */
type LateralFace = "xMin" | "xMax" | "yMin" | "yMax";

/** One rung's stepped outcome — the fields the report and drift consume. */
interface SteppedRung {
  readonly stepper: LbmStepper;
  readonly moments: LbmFieldMoments;
  readonly window: LbmRunWindow | null;
  readonly meanDragNPerM: number | null;
  readonly meanLiftNPerM: number | null;
}

/** The window means, accumulated exactly as the 63b driver accumulates them. */
function windowMeans(
  stepper: LbmStepper,
  averagingStartStep: number,
): Pick<SteppedRung, "window" | "meanDragNPerM" | "meanLiftNPerM"> {
  const histories = stepper.forceState().history;
  const dragSamples = histories[0]?.samples ?? [];
  const liftSamples = histories[1]?.samples ?? [];
  if (stepper.step < averagingStartStep) {
    return { window: null, meanDragNPerM: null, meanLiftNPerM: null };
  }
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
  return {
    window: {
      fromStep: averagingStartStep,
      toStep: stepper.step,
      sampleCount: count,
    },
    meanDragNPerM: count > 0 ? dragSum / count : null,
    meanLiftNPerM: count > 0 ? liftSum / count : null,
  };
}

/** What one stepped run wants to emit between steps. */
interface EmissionChannels {
  /** Progress emission (absent on the headless refined rung). */
  readonly onProgress?: (progress: SimEngineProgress) => void;
  /** Field-chunk emission (absent on the headless refined rung). */
  readonly onFieldChunk?: (chunk: SimEngineFieldChunk) => void;
  /** The progress steps continue from (the coarse rung's budget). */
  readonly progressBase: number;
  /** The total the progress reports (the ladder's whole budget). */
  readonly progressTotal: number;
  /** Whether preview rounds publish (the streaming show). */
  readonly preview: boolean;
}

/** The document-space preview block of the current speed field. */
function previewBlock(
  stepper: LbmStepper,
): SimParseResult<SimResultFieldBlock, SimError> {
  const speed = stepper.solverFields().find((field) => field.id === "speed");
  if (speed === undefined) {
    return simFail(
      simError(
        SIM_ERROR_CODES.scenarioInvalid,
        "The stepper's solver fields did not carry the speed field the preview publishes.",
        stepper.meta,
      ),
    );
  }
  const projected = projectSimResult({ scalars: [], fields: [speed] });
  if (!projected.ok) return projected;
  const block = projected.value.fields[0];
  if (block === undefined) {
    return simFail(
      simError(
        SIM_ERROR_CODES.scenarioInvalid,
        "The S4 projection returned no block for the preview's speed field.",
        speed,
      ),
    );
  }
  return simOk(block);
}

/** Publishes one preview round: the speed block, split into protocol chunks. */
function publishPreview(
  stepper: LbmStepper,
  onFieldChunk: (chunk: SimEngineFieldChunk) => void,
): void {
  const block = previewBlock(stepper);
  if (!block.ok) return; // The finalize path declines on the same problem.
  const chunkCount = Math.max(
    1,
    Math.ceil(block.value.values.length / LBM_PREVIEW_CHUNK_MAX_VALUES),
  );
  for (const chunk of splitSimFieldBlock(block.value, chunkCount)) {
    onFieldChunk(chunk);
  }
}

/**
 * Steps one run to its budget with the streaming discipline: a macrotask
 * yield per step (the cooperative cancellation window), progress after
 * every step, preview rounds on the interval and at the final step, and
 * the averaging accumulation inside the window. The 63a stepper owns all
 * arithmetic — this loop only drives it and reads it out.
 */
async function streamStepper(
  config: LbmStepperConfig,
  stepBudget: number,
  averagingStartStep: number,
  channels: EmissionChannels,
): Promise<SimParseResult<SteppedRung, SimError>> {
  const created = createLbmStepper(config);
  if (!created.ok) return created;
  const stepper = created.value;
  const accumulator = new LbmMomentAccumulator(
    stepper.meta.nx,
    stepper.meta.ny,
  );
  const publishable = channels.preview && channels.onFieldChunk !== undefined;
  for (let step = 1; step <= stepBudget; step += 1) {
    // The cooperative window: the yield lets a cancel message cross the
    // channel, and the next emission's throw unwinds this loop — a
    // conforming engine does not catch it.
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
    stepper.advance();
    if (stepper.diverged) break;
    channels.onProgress?.({
      step: channels.progressBase + stepper.step,
      totalSteps: channels.progressTotal,
    });
    if (
      publishable &&
      (step % LBM_PREVIEW_INTERVAL_STEPS === 0 || step === stepBudget)
    ) {
      publishPreview(stepper, channels.onFieldChunk);
    }
    if (step >= averagingStartStep) {
      const snapshot = stepper.snapshotLattice();
      accumulator.accumulate(snapshot.ux, snapshot.uy);
    }
  }
  const means = windowMeans(stepper, averagingStartStep);
  return simOk({
    stepper,
    moments: accumulator.moments(),
    ...means,
  });
}

/** The window-averaged velocity moment fields, S4-ready (mm/s labels, SI values). */
function averagingFields(
  run: SteppedRung,
  config: LbmStepperConfig,
): readonly SolverSimField[] {
  const moments = run.moments;
  if (moments.count === 0) return [];
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

/** The rung view the drift computation consumes, built from a stepped rung. */
function convergenceRungView(
  run: SteppedRung,
  solid: Uint8Array,
): SimParseResult<LbmConvergenceRungView, SimError> {
  if (
    run.window === null ||
    run.meanDragNPerM === null ||
    run.meanLiftNPerM === null
  ) {
    return simFail(
      simError(
        SIM_ERROR_CODES.scenarioInvalid,
        "The grid-convergence self-check needs window-mean forces and moments from both rungs; the averaging window produced none.",
        run.window,
      ),
    );
  }
  const stepper = run.stepper;
  return simOk({
    facts: {
      nx: stepper.meta.nx,
      ny: stepper.meta.ny,
      cellSizeM: stepper.meta.units.cellSizeM,
      completedSteps: stepper.step,
      physicalDurationS: stepper.step * stepper.meta.units.timeStepS,
      averagingWindowSteps: run.window.sampleCount,
    },
    solid,
    meanVelocityXLattice: run.moments.meanX,
    meanVelocityYLattice: run.moments.meanY,
    meanDragNPerM: run.meanDragNPerM,
    meanLiftNPerM: run.meanLiftNPerM,
  });
}

/** The compiled problem's face mapping, declined loudly where the 2D kernel refuses. */
interface MappedFaces {
  readonly specs: Pick<LbmStepperConfig, "west" | "east" | "south" | "north">;
  readonly characteristicVelocityMPerS: number;
  readonly referencePressurePa: number;
}

function mapFaces(
  request: SimEngineRequest,
): SimParseResult<MappedFaces, SimError> {
  const refuse = (
    message: string,
    at: unknown,
  ): SimParseResult<never, SimError> =>
    simFail(simError(SIM_ERROR_CODES.scenarioInvalid, message, at));
  const specs: Record<LateralFace, LbmFaceSpec | undefined> = {
    xMin: undefined,
    xMax: undefined,
    yMin: undefined,
    yMax: undefined,
  };
  let inletSpeed = 0;
  let outletPressure: number | undefined;
  for (const condition of request.compiled.conditions) {
    const face = condition.face;
    if (face === "zMin" || face === "zMax") {
      return refuse(
        `A condition on the "${face}" face is outside the 2D wind tunnel's slice — the kernel consumes the four lateral faces (xMin, xMax, yMin, yMax) of the slice plane.`,
        condition,
      );
    }
    switch (condition.kind) {
      case "velocity-inlet": {
        const velocity = condition.velocityMPerS;
        if (velocity === undefined) {
          return refuse(
            "A compiled velocity-inlet condition carried no velocity vector.",
            condition,
          );
        }
        const [vx, vy] = [velocity[0] ?? 0, velocity[1] ?? 0];
        specs[face] = { kind: "velocity-inlet", velocityMPerS: [vx, vy] };
        inletSpeed = Math.max(inletSpeed, Math.sqrt(vx * vx + vy * vy));
        break;
      }
      case "pressure-outlet": {
        if (condition.pressurePa === undefined) {
          return refuse(
            "A compiled pressure-outlet condition carried no pressure.",
            condition,
          );
        }
        specs[face] = {
          kind: "pressure-outlet",
          pressurePa: condition.pressurePa,
        };
        outletPressure = condition.pressurePa;
        break;
      }
      case "wall":
        specs[face] = { kind: "wall", slip: condition.slip === true };
        break;
      case "symmetry":
        specs[face] = { kind: "symmetry" };
        break;
      default:
        return refuse(
          `A "${condition.kind}" condition cannot ride the 2D flow kernel (it consumes velocity-inlet, pressure-outlet, wall, and symmetry).`,
          condition,
        );
    }
  }
  if (inletSpeed <= 0) {
    return refuse(
      "A 2D wind-tunnel scenario needs at least one velocity-inlet on a lateral face — the characteristic velocity the lattice units derive from.",
      request.compiled.conditions,
    );
  }
  // The documented defaults for absent faces: convective outflow on the
  // outflow side, no-slip walls on the periphery — the wind-tunnel shape.
  const spec = (face: LateralFace, fallback: LbmFaceSpec) => {
    const authored = specs[face];
    return authored === undefined ? fallback : authored;
  };
  return simOk({
    specs: {
      west: spec("xMin", { kind: "wall", slip: false }),
      east: spec("xMax", { kind: "convective-outflow" }),
      south: spec("yMin", { kind: "wall", slip: false }),
      north: spec("yMax", { kind: "wall", slip: false }),
    },
    characteristicVelocityMPerS: inletSpeed,
    referencePressurePa: outletPressure ?? 0,
  });
}

/** Attaches the convergence drift to the finalized summary, as quantities. */
function withConvergenceQuantities(
  result: SimResult,
  convergence: LbmGridConvergenceReport,
): SimResult {
  const quantities = [...result.summary.quantities];
  quantities.push({
    name: "grid-convergence-drag-drift",
    value: convergence.dragDrift.relative,
    unit: "1",
  });
  quantities.push({
    name: "grid-convergence-lift-drift",
    value: convergence.liftDrift.relative,
    unit: "1",
  });
  quantities.push({
    name: "grid-convergence-field-l2-drift",
    value: convergence.fieldDrift.l2Relative,
    unit: "1",
  });
  return {
    ...result,
    summary: { ...result.summary, quantities },
  };
}

async function runLbmEngine(
  request: SimEngineRequest,
  onProgress?: (progress: SimEngineProgress) => void,
  onFieldChunk?: (chunk: SimEngineFieldChunk) => void,
): Promise<SimParseResult<SimResult, SimError>> {
  const compiled = request.compiled;
  if (!SUPPORTED_KINDS.includes(compiled.kind)) {
    return simFail(
      simError(
        SIM_ERROR_CODES.scenarioKindUnsupported,
        `The 2D reference flow engine does not solve the "${compiled.kind}" scenario kind (it solves flow; thermal stays the fake engine's, structural is Phase 69's carve).`,
        compiled.kind,
      ),
    );
  }
  if (compiled.backend === "gpu") {
    return simFail(
      simError(
        SIM_ERROR_CODES.backendUnavailable,
        'The scenario prefers the "gpu" backend; the CPU reference kernel is the only provider until Phase 64\'s WGSL engine and its feature-detect fallback exist, and a GPU-preferred scenario declines loudly instead of silently falling back.',
        compiled.backend,
      ),
    );
  }
  const slice = compiled.occupancySlice;
  if (slice === undefined) {
    return simFail(
      simError(
        SIM_ERROR_CODES.geometryUnavailable,
        "A flow run needs the scenario's voxelized body slice: compile with the bodies' tessellation (the geometry-aware compile door), and this engine refuses to fabricate an empty tunnel.",
        compiled.name,
      ),
    );
  }
  const mask = lbmSolidMaskFromGrid(slice);
  if (!mask.ok) return mask;
  const faces = mapFaces(request);
  if (!faces.ok) return faces;
  const origin = slice.originM;
  const config: LbmStepperConfig = {
    mask: mask.value,
    fluid: compiled.fluid,
    cellSizeM: compiled.cellSizeM,
    characteristicVelocityMPerS: faces.value.characteristicVelocityMPerS,
    originM: [origin[0] ?? 0, origin[1] ?? 0],
    referencePressurePa: faces.value.referencePressurePa,
    ...faces.value.specs,
  };
  const stepBudget = compiled.run?.stepBudget ?? SIM_FLOW_DEFAULT_STEP_BUDGET;
  const averagingStartStep =
    compiled.run?.averagingStartStep ?? Math.max(1, Math.ceil(stepBudget / 2));
  const gridConvergence = compiled.run?.gridConvergence === true;

  const coarse = await streamStepper(config, stepBudget, averagingStartStep, {
    ...(onProgress === undefined ? {} : { onProgress }),
    ...(onFieldChunk === undefined ? {} : { onFieldChunk }),
    progressBase: 0,
    progressTotal: gridConvergence
      ? stepBudget * (1 + LBM_GRID_CONVERGENCE_REFINEMENT)
      : stepBudget,
    preview: true,
  });
  if (!coarse.ok) return coarse;
  const run = coarse.value;
  const stepper = run.stepper;

  const report: LbmRunReport = {
    scenarioName: compiled.name,
    scenarioSnapshotHash: compiled.scenarioSnapshotHash,
    regime: compiled.regime,
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
      window: run.window,
      meanDragNPerM: run.meanDragNPerM,
      meanLiftNPerM: run.meanLiftNPerM,
    },
    histories: stepper.forceState().history,
    fields: stepper.diverged
      ? []
      : [...stepper.solverFields(), ...averagingFields(run, config)],
  };
  // A diverged run reports itself and skips the self-check: a blown-up
  // run has no trust indicator to compute (the 63b driver's own rule).
  const base = lbmRunSimResult(report);
  if (!base.ok) return base;
  if (stepper.diverged || !gridConvergence) return base;

  // The grid-convergence self-check: the same scenario at a factor-2
  // refinement with exactly twice the budget and window (matched
  // physical time — the unit closure halves dt when dx halves), driven
  // headless with progress continuing monotonically so the ledger's
  // committed steps never regress.
  const refinedSlice = compiled.occupancySliceRefined;
  if (refinedSlice === undefined) {
    return simFail(
      simError(
        SIM_ERROR_CODES.geometryUnavailable,
        "The scenario flags the grid-convergence self-check, but the compiled problem carries no refined occupancy slice (the geometry-aware compile voxelizes the factor-2 rung when the flag is set).",
        compiled.name,
      ),
    );
  }
  const refinedMask = lbmSolidMaskFromGrid(refinedSlice);
  if (!refinedMask.ok) return refinedMask;
  const fine = await streamStepper(
    {
      ...config,
      mask: refinedMask.value,
      cellSizeM: config.cellSizeM / LBM_GRID_CONVERGENCE_REFINEMENT,
    },
    stepBudget * LBM_GRID_CONVERGENCE_REFINEMENT,
    averagingStartStep * LBM_GRID_CONVERGENCE_REFINEMENT,
    {
      ...(onProgress === undefined ? {} : { onProgress }),
      progressBase: stepBudget,
      progressTotal: stepBudget * (1 + LBM_GRID_CONVERGENCE_REFINEMENT),
      preview: false,
    },
  );
  if (!fine.ok) return fine;
  if (fine.value.stepper.diverged) {
    return simFail(
      simError(
        SIM_ERROR_CODES.runDiverged,
        "The grid-convergence self-check's refined rung diverged: the ladder measures numerical drift, never a blow-up's debris, and the self-check declines rather than diff against a frozen fine solution.",
        { fineSteps: fine.value.stepper.step },
      ),
    );
  }
  const coarseView = convergenceRungView(run, mask.value.solid);
  if (!coarseView.ok) return coarseView;
  const fineView = convergenceRungView(fine.value, refinedMask.value.solid);
  if (!fineView.ok) return fineView;
  const coarseProblem = lbmConvergenceRungProblem(coarseView.value);
  if (coarseProblem !== undefined) return simFail(coarseProblem);
  const fineProblem = lbmConvergenceRungProblem(fineView.value);
  if (fineProblem !== undefined) return simFail(fineProblem);
  const drift = lbmGridConvergenceDrift(
    coarseView.value,
    fineView.value,
    stepper.meta.units.latticeVelocity,
  );
  if (!drift.ok) return drift;
  return simOk(withConvergenceQuantities(base.value, drift.value));
}

/** The deterministic 2D reference flow engine (law S2's CPU oracle adapter). */
export function createLbmSimEngine(): SimEngine {
  return {
    id: LBM_SIM_ENGINE_ID,
    supportedKinds: SUPPORTED_KINDS,
    backend: "cpu",
    run: (request, onProgress, onFieldChunk) =>
      runLbmEngine(request, onProgress, onFieldChunk),
  };
}

/**
 * The default hosted engine (Phase 63c's engine selection): the real 2D
 * flow engine for flow scenarios, the 61b fake engine for thermal (until
 * Phase 65's real thermal solver lands), and `structural` declined by
 * neither engine's kind list — the Phase 69 carve, exactly as the
 * contract demands. Worker hosts that want the fake engine everywhere
 * (the 61b test truths) keep hosting it directly.
 */
export function createDefaultSimEngine(): SimEngine {
  const lbm = createLbmSimEngine();
  const fake = createFakeSimEngine();
  return {
    id: "default-routed-sim",
    supportedKinds: [...lbm.supportedKinds, ...fake.supportedKinds],
    backend: "cpu",
    run: (request, onProgress, onFieldChunk) => {
      const engine = lbm.supportedKinds.includes(request.compiled.kind)
        ? lbm
        : fake;
      return engine.run(request, onProgress, onFieldChunk);
    },
  };
}
