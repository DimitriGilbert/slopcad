/**
 * The mapping layer BOTH flow engines share (Phase 64a's extraction from
 * `./engine`): the compiled problem's conditions → the four lateral face
 * specs, the streaming-preview publication, the force-window means, the
 * averaging-field projection, the convergence-rung facts, and the
 * convergence-drift attachment to a finalized summary. The CPU
 * reference engine and the WGSL provider engine consume the SAME
 * mapping — one source of truth for what a compiled 2D flow scenario
 * means and how a stepped run is reported, so a gpu-preferred run and
 * its cpu twin differ only in the stepper that executes them (exactly
 * what the S5 oracle harness diffs).
 */

import {
  type SimEngineFieldChunk,
  type SimEngineRequest,
  type SimError,
  SIM_ERROR_CODES,
  type SimHistorySeries,
  type SimParseResult,
  type SimResult,
  type SimScenarioKind,
  type SolverSimField,
  projectSimResult,
  simError,
  simFail,
  simOk,
  splitSimFieldBlock,
} from "@slopcad/sim-core";
import type { LbmFieldMoments } from "./averaging";
import type {
  LbmConvergenceRungFacts,
  LbmConvergenceRungView,
  LbmGridConvergenceReport,
} from "./convergence";
import type { LbmRunMeta, LbmStepperConfig } from "./stepper";
import type { LbmRunWindow } from "./run";

/** The four lateral faces the 2D slice consumes, by their compiled names. */
export type LateralFace = "xMin" | "xMax" | "yMin" | "yMax";

/** The scenario kinds both 2D flow engines solve (the wind tunnel). */
export const LBM_SUPPORTED_KINDS: readonly SimScenarioKind[] = ["flow"];

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

/** The compiled problem's face mapping, declined loudly where the 2D kernel refuses. */
export interface MappedFaces {
  readonly specs: Pick<LbmStepperConfig, "west" | "east" | "south" | "north">;
  readonly characteristicVelocityMPerS: number;
  readonly referencePressurePa: number;
}

/**
 * Maps a compiled problem's conditions onto the four lateral face specs,
 * refusing the inputs the shared 2D kernel contract cannot honor: z-face
 * conditions (outside the slice), non-flow condition kinds, and tunnels
 * without a velocity inlet (the characteristic velocity the lattice
 * units derive from). Absent faces take the documented wind-tunnel
 * defaults: convective outflow on the outflow side, no-slip walls on
 * the periphery.
 */
export function mapFaces(
  request: SimEngineRequest,
): SimParseResult<MappedFaces, SimError> {
  const refuse = (
    message: string,
    at: unknown,
  ): SimParseResult<never, SimError> =>
    simFail(simError(SIM_ERROR_CODES.scenarioInvalid, message, at));
  const specs: Record<LateralFace, LbmStepperConfig["west"] | undefined> = {
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
  const spec = (face: LateralFace, fallback: LbmStepperConfig["west"]) => {
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

/** The window means over a completed force-history pair. */
export interface LbmForceWindowMeans {
  readonly window: LbmRunWindow | null;
  readonly meanDragNPerM: number | null;
  readonly meanLiftNPerM: number | null;
}

/**
 * The averaging-window force means, accumulated exactly as the run
 * drivers accumulate them: samples are 0-based per COMPLETED step, so
 * the window [startStep, step] is samples[startStep − 1 … step − 1],
 * summed in fixed order.
 */
export function lbmWindowMeans(
  histories: readonly SimHistorySeries[],
  completedSteps: number,
  averagingStartStep: number,
): LbmForceWindowMeans {
  const dragSamples = histories[0]?.samples ?? [];
  const liftSamples = histories[1]?.samples ?? [];
  if (completedSteps < averagingStartStep) {
    return { window: null, meanDragNPerM: null, meanLiftNPerM: null };
  }
  let dragSum = 0;
  let liftSum = 0;
  let count = 0;
  for (let index = averagingStartStep - 1; index < completedSteps; index += 1) {
    dragSum += dragSamples[index] ?? 0;
    liftSum += liftSamples[index] ?? 0;
    count += 1;
  }
  return {
    window: {
      fromStep: averagingStartStep,
      toStep: completedSteps,
      sampleCount: count,
    },
    meanDragNPerM: count > 0 ? dragSum / count : null,
    meanLiftNPerM: count > 0 ? liftSum / count : null,
  };
}

/** The grid facts the averaging-field projection needs (SI, from the run's meta). */
export interface LbmAveragingGrid {
  readonly nx: number;
  readonly ny: number;
  readonly cellSizeM: number;
  readonly velocityFactor: number;
  readonly originM: readonly [number, number];
}

/**
 * The window-averaged velocity moment fields, S4-ready (mm/s labels,
 * SI values) — the mean and RMS-fluctuation pair law S9 answers
 * resolved unsteady runs with.
 */
export function lbmAveragingFields(
  moments: LbmFieldMoments,
  grid: LbmAveragingGrid,
): readonly SolverSimField[] {
  if (moments.count === 0) return [];
  const { nx, ny } = grid;
  const geometry = {
    extent: [nx, ny, 1] as const,
    originM: [grid.originM[0] ?? 0, grid.originM[1] ?? 0, 0] as const,
    spacingM: [grid.cellSizeM, grid.cellSizeM, grid.cellSizeM] as const,
    dataType: "float32" as const,
  };
  const meanX: number[] = [];
  const meanY: number[] = [];
  const fluctuationX: number[] = [];
  const fluctuationY: number[] = [];
  for (let index = 0; index < nx * ny; index += 1) {
    meanX.push((moments.meanX[index] ?? 0) * grid.velocityFactor);
    meanY.push((moments.meanY[index] ?? 0) * grid.velocityFactor);
    fluctuationX.push(
      Math.sqrt(moments.varianceX[index] ?? 0) * grid.velocityFactor,
    );
    fluctuationY.push(
      Math.sqrt(moments.varianceY[index] ?? 0) * grid.velocityFactor,
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

/**
 * Publishes one preview round: the DOCUMENT-SPACE speed block, split
 * into protocol chunks. Best-effort by the contract's own posture — a
 * solver-field set without the speed field publishes nothing, and the
 * finalize path declines on the same problem.
 */
export function lbmPublishPreview(
  fields: readonly SolverSimField[],
  onFieldChunk: (chunk: SimEngineFieldChunk) => void,
): void {
  const speed = fields.find((field) => field.id === "speed");
  if (speed === undefined) return;
  const projected = projectSimResult({ scalars: [], fields: [speed] });
  if (!projected.ok) return;
  const block = projected.value.fields[0];
  if (block === undefined) return;
  const chunkCount = Math.max(
    1,
    Math.ceil(block.values.length / LBM_PREVIEW_CHUNK_MAX_VALUES),
  );
  for (const chunk of splitSimFieldBlock(block, chunkCount)) {
    onFieldChunk(chunk);
  }
}

/**
 * The convergence rung's facts from a stepped run's meta — the shared
 * assembly both engines' ladders feed the drift computation with.
 */
export function lbmRungFacts(
  meta: LbmRunMeta,
  completedSteps: number,
  averagingWindowSteps: number,
): LbmConvergenceRungFacts {
  return {
    nx: meta.nx,
    ny: meta.ny,
    cellSizeM: meta.units.cellSizeM,
    completedSteps,
    physicalDurationS: completedSteps * meta.units.timeStepS,
    averagingWindowSteps,
  };
}

/** One stepped run's convergence-relevant outcome (either engine's shape). */
export interface LbmRungSolution {
  readonly meta: LbmRunMeta;
  readonly completedSteps: number;
  /** The rung's occupancy mask (nx·ny values, x-fastest). */
  readonly solid: Uint8Array;
  readonly moments: LbmFieldMoments;
  readonly window: LbmRunWindow | null;
  readonly meanDragNPerM: number | null;
  readonly meanLiftNPerM: number | null;
}

/**
 * The rung view the drift computation consumes, declined loudly when
 * the averaging window produced nothing to compare.
 */
export function lbmRungView(
  run: LbmRungSolution,
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
  return simOk({
    facts: lbmRungFacts(run.meta, run.completedSteps, run.window.sampleCount),
    solid: run.solid,
    meanVelocityXLattice: run.moments.meanX,
    meanVelocityYLattice: run.moments.meanY,
    meanDragNPerM: run.meanDragNPerM,
    meanLiftNPerM: run.meanLiftNPerM,
  });
}

/** Attaches the convergence drift to the finalized summary, as quantities. */
export function withConvergenceQuantities(
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
