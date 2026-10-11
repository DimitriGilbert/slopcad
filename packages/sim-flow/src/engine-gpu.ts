/**
 * The WGSL provider engine (Phase 64a): the D2Q9 GPU provider behind
 * the Phase 61 `SimEngine` contract. The run shape is the CPU
 * reference engine's own (`./engine`), executed by the WGSL stepper
 * (`./wgsl-stepper`) over the narrow device seam — the mapping,
 * preview publication, window means, averaging fields, report
 * assembly, and the factor-2 grid-convergence ladder are all the
 * SHARED `./engine-shared` code, so a gpu-preferred run and its cpu
 * twin differ only in the stepper that executes them. That is the
 * entire premise of the S5 oracle-vs-GPU tolerance harness
 * (`./gpu-oracle-harness`): identical orchestration, two kernels,
 * bounded difference.
 *
 * Honest differences from the CPU engine, all documented and all
 * gated by the tolerance harness rather than bit-asserted:
 *
 * - the kernel arithmetic is f32 (the CPU computes macroscopic and
 *   collision terms in f64 before the f32 store);
 * - the divergence sentinel is discovered at readback boundaries —
 *   the shader freezes itself the moment it trips, but the host
 *   learns at the preview cadence (the status readback rides the
 *   preview round's readback) instead of synchronously per step;
 * - the force-history impulses are reduced on device in a fixed
 *   deterministic order (`./wgsl-shader`'s two-stage reduction), then
 *   converted to SI once at readback.
 *
 * This engine never declines a flow scenario for its backend: the
 * ROUTER (`createDefaultSimEngine`) owns feature detection and the
 * graceful CPU fallback — a device in hand means the provider runs.
 */

import {
  type SimEngine,
  type SimEngineFieldChunk,
  type SimEngineProgress,
  type SimEngineRequest,
  type SimError,
  SIM_ERROR_CODES,
  SIM_FLOW_DEFAULT_STEP_BUDGET,
  type SimParseResult,
  type SimResult,
  simError,
  simFail,
  simOk,
} from "@slopcad/sim-core";
import type { LbmFieldMoments } from "./averaging";
import type { WgslDevice } from "./gpu-device";
import type { LbmStepperConfig } from "./stepper";

import {
  LBM_GRID_CONVERGENCE_REFINEMENT,
  lbmConvergenceRungProblem,
  lbmGridConvergenceDrift,
} from "./convergence";
import {
  LBM_PREVIEW_INTERVAL_STEPS,
  LBM_SUPPORTED_KINDS,
  lbmAveragingFields,
  lbmPublishPreview,
  lbmRungView,
  lbmWindowMeans,
  mapFaces,
  withConvergenceQuantities,
} from "./engine-shared";
import { lbmSolidMaskFromGrid } from "./occupancy";
import { type LbmRunReport, type LbmRunWindow, lbmRunSimResult } from "./run";
import { type WgslLbmStepper, createWgslLbmStepper } from "./wgsl-stepper";

/** The WGSL provider engine's stable id (the worker host's engine-selection key). */
export const LBM_WGSL_SIM_ENGINE_ID = "lbm2d-wgsl-provider";

/** One stepped GPU rung's outcome — the fields the report and drift consume. */
interface WgslSteppedRung {
  readonly stepper: WgslLbmStepper;
  readonly moments: LbmFieldMoments;
  readonly forces: Awaited<ReturnType<WgslLbmStepper["forceState"]>>;
  readonly window: LbmRunWindow | null;
  readonly meanDragNPerM: number | null;
  readonly meanLiftNPerM: number | null;
}

/** What one stepped run wants to emit between steps (the CPU engine's shape). */
interface EmissionChannels {
  readonly onProgress?: (progress: SimEngineProgress) => void;
  readonly onFieldChunk?: (chunk: SimEngineFieldChunk) => void;
  readonly progressBase: number;
  readonly progressTotal: number;
  readonly preview: boolean;
}

/**
 * Steps one GPU run to its budget with the streaming discipline: a
 * macrotask yield per step (the cooperative cancellation window), the
 * fixed seven-pass submit per step, progress after every step, preview
 * rounds on the interval and at the final step (each riding one
 * status + solver-field readback), and the GPU-side Welford moments
 * accumulating inside the window. Divergence breaks the loop at the
 * readback boundary that discovers it; the final sync truncates the
 * rung to the first diverged step.
 */
async function streamWgslStepper(
  config: LbmStepperConfig,
  device: WgslDevice,
  stepBudget: number,
  averagingStartStep: number,
  channels: EmissionChannels,
): Promise<SimParseResult<WgslSteppedRung, SimError>> {
  const created = await createWgslLbmStepper(config, device, {
    stepCapacity: stepBudget,
    averagingStartStep,
  });
  if (!created.ok) return created;
  const stepper = created.value;
  const publish = channels.onFieldChunk;
  const publishable = channels.preview && publish !== undefined;
  for (let step = 1; step <= stepBudget; step += 1) {
    // The cooperative window: the yield lets a cancel message cross the
    // channel, and the next emission's throw unwinds this loop — a
    // conforming engine does not catch it.
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
    stepper.advance();
    channels.onProgress?.({
      step: channels.progressBase + step,
      totalSteps: channels.progressTotal,
    });
    if (
      publishable &&
      publish !== undefined &&
      (step % LBM_PREVIEW_INTERVAL_STEPS === 0 || step === stepBudget)
    ) {
      // The divergence checkpoint rides the preview round's readback:
      // the shader already froze itself; the host learns here.
      await stepper.syncStatus();
      if (stepper.diverged) break;
      lbmPublishPreview(await stepper.solverFields(), publish);
    }
  }
  await stepper.syncStatus();
  const forces = await stepper.forceState();
  const moments = await stepper.moments();
  return simOk({
    stepper,
    moments,
    forces,
    ...lbmWindowMeans(forces.history, stepper.step, averagingStartStep),
  });
}

/** Runs one compiled flow scenario on the WGSL provider (the router's GPU path). */
export async function runWgslLbmEngine(
  request: SimEngineRequest,
  device: WgslDevice,
  onProgress?: (progress: SimEngineProgress) => void,
  onFieldChunk?: (chunk: SimEngineFieldChunk) => void,
): Promise<SimParseResult<SimResult, SimError>> {
  const compiled = request.compiled;
  if (!LBM_SUPPORTED_KINDS.includes(compiled.kind)) {
    return simFail(
      simError(
        SIM_ERROR_CODES.scenarioKindUnsupported,
        `The WGSL flow provider does not solve the "${compiled.kind}" scenario kind (it solves flow only; thermal is served by the real conduction/CHT engines on the CPU path through the routed default engine, and structural is Phase 69's carve).`,
        compiled.kind,
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

  const coarse = await streamWgslStepper(
    config,
    device,
    stepBudget,
    averagingStartStep,
    {
      ...(onProgress === undefined ? {} : { onProgress }),
      ...(onFieldChunk === undefined ? {} : { onFieldChunk }),
      progressBase: 0,
      progressTotal: gridConvergence
        ? stepBudget * (1 + LBM_GRID_CONVERGENCE_REFINEMENT)
        : stepBudget,
      preview: true,
    },
  );
  if (!coarse.ok) return coarse;

  const run = coarse.value;
  const stepper = run.stepper;
  let fine: WgslSteppedRung | undefined;
  try {
    const report: LbmRunReport = {
      scenarioName: compiled.name,
      scenarioSnapshotHash: compiled.scenarioSnapshotHash,
      regime: compiled.regime,
      // The honest backend record (Phase 64b): the WGSL provider
      // executed this run — the router only gets here with a device.
      servedBackend: "gpu",
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
      histories: run.forces.history,
      fields: stepper.diverged
        ? []
        : [
            ...(await stepper.solverFields()),
            ...lbmAveragingFields(run.moments, {
              nx: stepper.meta.nx,
              ny: stepper.meta.ny,
              cellSizeM: stepper.meta.units.cellSizeM,
              velocityFactor: stepper.meta.units.velocityFactor,
              originM: config.originM ?? [0, 0],
            }),
          ],
    };
    // A diverged run reports itself and skips the self-check: a blown-up
    // run has no trust indicator to compute (the CPU engine's own rule).
    const base = lbmRunSimResult(report);
    if (!base.ok) return base;
    if (stepper.diverged || !gridConvergence) return base;

    // The grid-convergence self-check on the provider: the refined rung
    // through the same GPU path, exactly twice the budget and window
    // (matched physical time — the unit closure halves dt when dx
    // halves), headless with progress continuing monotonically.
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
    const fineRun = await streamWgslStepper(
      {
        ...config,
        mask: refinedMask.value,
        cellSizeM: config.cellSizeM / LBM_GRID_CONVERGENCE_REFINEMENT,
      },
      device,
      stepBudget * LBM_GRID_CONVERGENCE_REFINEMENT,
      averagingStartStep * LBM_GRID_CONVERGENCE_REFINEMENT,
      {
        ...(onProgress === undefined ? {} : { onProgress }),
        progressBase: stepBudget,
        progressTotal: stepBudget * (1 + LBM_GRID_CONVERGENCE_REFINEMENT),
        preview: false,
      },
    );
    if (!fineRun.ok) return fineRun;
    fine = fineRun.value;
    if (fine.stepper.diverged) {
      return simFail(
        simError(
          SIM_ERROR_CODES.runDiverged,
          "The grid-convergence self-check's refined rung diverged: the ladder measures numerical drift, never a blow-up's debris, and the self-check declines rather than diff against a frozen fine solution.",
          { fineSteps: fine.stepper.step },
        ),
      );
    }
    const coarseView = lbmRungView({
      meta: stepper.meta,
      completedSteps: stepper.step,
      solid: mask.value.solid,
      moments: run.moments,
      window: run.window,
      meanDragNPerM: run.meanDragNPerM,
      meanLiftNPerM: run.meanLiftNPerM,
    });
    if (!coarseView.ok) return coarseView;
    const fineView = lbmRungView({
      meta: fine.stepper.meta,
      completedSteps: fine.stepper.step,
      solid: refinedMask.value.solid,
      moments: fine.moments,
      window: fine.window,
      meanDragNPerM: fine.meanDragNPerM,
      meanLiftNPerM: fine.meanLiftNPerM,
    });
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
  } finally {
    if (fine !== undefined) fine.stepper.destroy();
    stepper.destroy();
  }
}

/**
 * The WGSL provider as a direct `SimEngine` — for hosts and tests that
 * hold a device and want the provider without the router's fallback
 * (the routed default engine remains the user-facing door).
 */
export function createWgslSimEngine(device: WgslDevice): SimEngine {
  return {
    id: LBM_WGSL_SIM_ENGINE_ID,
    supportedKinds: [...LBM_SUPPORTED_KINDS],
    backend: "gpu",
    run: (request, onProgress, onFieldChunk) =>
      runWgslLbmEngine(request, device, onProgress, onFieldChunk),
  };
}
