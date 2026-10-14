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
 *
 * Phase 64a extends the module with the BACKEND ROUTER: the shared
 * mapping lives in `./engine-shared` (consumed by this engine and the
 * WGSL provider engine alike), and `createDefaultSimEngine` gained the
 * device-source option — a gpu-preferred flow scenario routes to the
 * WGSL provider (`./engine-gpu`) when the feature detect finds a
 * device, and falls back to this CPU oracle otherwise. The CPU engine
 * itself still declines a DIRECT gpu-preferred call loudly: the
 * fallback is the router's documented job, never a silent one.
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
import { createThermalSimEngine } from "@slopcad/sim-thermal";

import { LbmMomentAccumulator, type LbmFieldMoments } from "./averaging";
import {
  LBM_GRID_CONVERGENCE_REFINEMENT,
  lbmConvergenceRungProblem,
  lbmGridConvergenceDrift,
} from "./convergence";
import { createChtSimEngine } from "./engine-cht";
import { createFlow3dSimEngine } from "./engine-3d";
import { runWgslLbmEngine } from "./engine-gpu";
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
import {
  type WgslDevice,
  type WgslDeviceSource,
  requestWebGpuDevice,
} from "./gpu-device";
import { lbmSolidMaskFromGrid } from "./occupancy";
import { type LbmRunReport, type LbmRunWindow, lbmRunSimResult } from "./run";
import {
  type LbmStepper,
  type LbmStepperConfig,
  createLbmStepper,
} from "./stepper";

/** The real engine's stable id (the worker host's engine-selection key). */
export const LBM_SIM_ENGINE_ID = "lbm2d-cpu-reference";

export {
  LBM_PREVIEW_CHUNK_MAX_VALUES,
  LBM_PREVIEW_INTERVAL_STEPS,
} from "./engine-shared";

/** One rung's stepped outcome — the fields the report and drift consume. */
interface SteppedRung {
  readonly stepper: LbmStepper;
  readonly moments: LbmFieldMoments;
  readonly window: LbmRunWindow | null;
  readonly meanDragNPerM: number | null;
  readonly meanLiftNPerM: number | null;
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
      lbmPublishPreview(stepper.solverFields(), channels.onFieldChunk);
    }
    if (step >= averagingStartStep) {
      const snapshot = stepper.snapshotLattice();
      accumulator.accumulate(snapshot.ux, snapshot.uy);
    }
  }
  return simOk({
    stepper,
    moments: accumulator.moments(),
    ...lbmWindowMeans(
      stepper.forceState().history,
      stepper.step,
      averagingStartStep,
    ),
  });
}

async function runLbmEngine(
  request: SimEngineRequest,
  onProgress?: (progress: SimEngineProgress) => void,
  onFieldChunk?: (chunk: SimEngineFieldChunk) => void,
): Promise<SimParseResult<SimResult, SimError>> {
  const compiled = request.compiled;
  if (!LBM_SUPPORTED_KINDS.includes(compiled.kind)) {
    return simFail(
      simError(
        SIM_ERROR_CODES.scenarioKindUnsupported,
        `The 2D reference flow engine does not solve the "${compiled.kind}" scenario kind (it solves flow only; thermal is served by the real conduction/CHT engines and structural by the structural engine through the routed default engine).`,
        compiled.kind,
      ),
    );
  }
  if (compiled.backend === "gpu") {
    return simFail(
      simError(
        SIM_ERROR_CODES.backendUnavailable,
        'The scenario prefers the "gpu" backend; the CPU reference engine runs it only through the ROUTED default engine (createDefaultSimEngine), which feature-detects WebGPU, serves the WGSL provider when a device exists, and falls back to this CPU oracle — a direct CPU-engine call declines loudly instead of silently falling back.',
        compiled.backend,
      ),
    );
  }
  if (compiled.flow3d !== undefined) {
    return simFail(
      simError(
        SIM_ERROR_CODES.geometryUnavailable,
        "This flow scenario carries a 3D stance (flow3d compile products): the 2D wind tunnel serves slice-authored scenarios only, and the 3D reference engine owns this one — the routed default engine routes it; a direct 2D-engine call declines loudly instead of silently running a slice of a 3D-authored scenario.",
        compiled.name,
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
    // The honest backend record (Phase 64b): the CPU oracle executed
    // this run — including the router's gpu-preference fallback, which
    // rewrites the preference and hands the run to this engine.
    servedBackend: "cpu",
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
      : [
          ...stepper.solverFields(),
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
    meta: fine.value.stepper.meta,
    completedSteps: fine.value.stepper.step,
    solid: refinedMask.value.solid,
    moments: fine.value.moments,
    window: fine.value.window,
    meanDragNPerM: fine.value.meanDragNPerM,
    meanLiftNPerM: fine.value.meanLiftNPerM,
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
}

/** The deterministic 2D reference flow engine (law S2's CPU oracle adapter). */
export function createLbmSimEngine(): SimEngine {
  return {
    id: LBM_SIM_ENGINE_ID,
    supportedKinds: LBM_SUPPORTED_KINDS,
    backend: "cpu",
    run: (request, onProgress, onFieldChunk) =>
      runLbmEngine(request, onProgress, onFieldChunk),
  };
}

/**
 * The default hosted engine (Phase 63c's engine selection, extended at
 * Phase 64a with the backend router and at Phase 65c with the REAL
 * thermal routing — the 63c fake-engine thermal route retires): the
 * real 2D flow engine for flow scenarios, the REAL thermal engines for
 * thermal scenarios (the coupled conjugate march when the scenario
 * flags `cht`, the sealed conduction engine otherwise — the split is
 * exactly where the solvers live: the coupled march is this package's
 * `./cht`, the conduction solve is `@slopcad/sim-thermal`'s); the
 * structural kind lives with its own engine (`@slopcad/sim-structural`,
 * routed at the workbench's worker entry — Phase 69), and this router
 * declines it, exactly as the contract demands.
 *
 * The backend routing (Phase 64a, requirement 2): a GPU-PREFERRED flow
 * scenario goes to the WGSL provider when the device source finds a
 * WebGPU device, and falls back GRACEFULLY to the CPU oracle when it
 * does not — the Phase 63 decline promoted into the router. The
 * fallback runs the scenario's CPU twin (the compiled request with its
 * backend preference marked consumed), the exact twin the S5 oracle
 * harness diffs against the GPU run. Device detection happens once per
 * engine instance (memoized) — deterministic routing for the engine's
 * lifetime. The declared backend stays "cpu": the CPU oracle is the
 * floor this engine guarantees even on GPU-less hosts, the honest
 * capability statement. Worker hosts that want the fake engine
 * everywhere (the 61b test truths) keep hosting it directly.
 */
export interface DefaultSimEngineOptions {
  /**
   * The WebGPU device source the router consults for gpu-preferred
   * flow scenarios — the feature-detection seam (default: the honest
   * `navigator.gpu` request path). Hosts and tests inject their own.
   */
  readonly deviceSource?: WgslDeviceSource;
}

export function createDefaultSimEngine(
  options?: DefaultSimEngineOptions,
): SimEngine {
  const lbm = createLbmSimEngine();
  const lbm3d = createFlow3dSimEngine();
  const thermalConduction = createThermalSimEngine();
  const thermalCoupled = createChtSimEngine();
  const deviceSource = options?.deviceSource ?? requestWebGpuDevice;
  let detectionResolved = false;
  let detectedDevice: WgslDevice | undefined;
  const detectDevice = async (): Promise<WgslDevice | undefined> => {
    if (!detectionResolved) {
      detectedDevice = await deviceSource();
      detectionResolved = true;
    }
    return detectedDevice;
  };
  return {
    id: "default-routed-sim",
    supportedKinds: [
      ...new Set([
        ...lbm.supportedKinds,
        ...lbm3d.supportedKinds,
        ...thermalConduction.supportedKinds,
        ...thermalCoupled.supportedKinds,
      ]),
    ],
    backend: "cpu",
    run: async (request, onProgress, onFieldChunk) => {
      const kind = request.compiled.kind;
      if (kind === "thermal") {
        // The thermal stance routing (Phase 65c): the coupled march when
        // the compiled scenario flags it (the compile door already
        // declined a coupled stance with no fluid domain to convect
        // through), the sealed conduction solve otherwise.
        return (
          request.compiled.thermal?.cht === true
            ? thermalCoupled
            : thermalConduction
        ).run(request, onProgress, onFieldChunk);
      }
      if (!LBM_SUPPORTED_KINDS.includes(kind)) {
        return simFail(
          simError(
            SIM_ERROR_CODES.scenarioKindUnsupported,
            `The routed default engine does not solve the "${kind}" scenario kind (it solves flow and thermal; structural is served by the structural engine routed at the workbench's worker entry).`,
            kind,
          ),
        );
      }
      // The 3D stance routing (Phase 66c): a flow scenario carrying
      // flow3d compile products goes to the 3D reference engine — the
      // gpu preference is CONSUMED there (no WGSL provider engine
      // adapter is routed for 3D yet; the CPU oracle serves, the
      // summary's servedBackend records it — the router's documented
      // CPU floor, never a fabricated GPU claim).
      if (request.compiled.flow3d !== undefined) {
        return lbm3d.run(
          { compiled: { ...request.compiled, backend: "cpu" } },
          onProgress,
          onFieldChunk,
        );
      }
      if (request.compiled.backend === "gpu") {
        const device = await detectDevice();
        if (device !== undefined) {
          return runWgslLbmEngine(request, device, onProgress, onFieldChunk);
        }
        return lbm.run(
          { compiled: { ...request.compiled, backend: "cpu" } },
          onProgress,
          onFieldChunk,
        );
      }
      return lbm.run(request, onProgress, onFieldChunk);
    },
  };
}
