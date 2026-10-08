/**
 * Public entry of `@slopcad/sim-flow`, the LBM domain package
 * (ROADMAP-SIM Phases 63a/63b): the D2Q9 reference kernel — lattice,
 * unit closure, SoA state, BGK/TRT collision, push streaming with
 * full-way bounce-back, the real boundary-condition set (Zou/He velocity
 * and pressure, convective outflow, walls, symmetry), momentum-exchange
 * force integration, and the deterministic stepper that drives them all
 * — plus the 63b run-orchestration layer over it: the run driver (fixed
 * step budgets, force histories, post-hoc mean/fluctuation time
 * averaging as law S9's turbulence answer, the S9 regime wiring, the
 * scenario-snapshot-hash provenance, SimResult assembly) and the
 * factor-2 grid-convergence self-check. Phase 63c adds the ENGINE
 * ADAPTER (`./engine`): the real 2D flow engine behind the Phase 61
 * `SimEngine` contract — compiled problem (with the 63c geometry-aware
 * compile's occupancy slice) → streamed run → finalized SimResult — and
 * the routed default engine that serves flow with it and thermal with
 * the fake engine. The package depends on
 * `@slopcad/sim-core` alone at runtime — no React, no DOM, no node APIs
 * in the runtime entry (law S2), which is what makes the CPU
 * oracle the test truth (law S5). The node-only hosting modules
 * (`./engine-worker.node`, `./engine-node-channel`) are deliberately
 * subpath-only, the sim-core precedent.
 *
 * The SoA layout (`./d2q9`, `./state`) is the shared memory contract
 * the Phase 64 WGSL provider mirrors buffer-for-buffer.
 */

export {
  D2Q9_CS2,
  D2Q9_OPPOSITE,
  D2Q9_Q,
  D2Q9_VELOCITIES,
  D2Q9_WEIGHTS,
  d2q9Equilibrium,
  d2q9EquilibriumEven,
  d2q9EquilibriumOdd,
  d2q9FillEquilibrium,
} from "./d2q9";
export {
  LBM_DEFAULT_LATTICE_VELOCITY,
  LBM_MAX_LATTICE_VELOCITY,
  LBM_TAU_PLUS_MAX,
  LBM_TAU_PLUS_MIN,
  type LbmUnitSystem,
  type LbmUnitSystemInputs,
  lbmUnitSystem,
} from "./lattice-units";
export {
  type LbmSolidMask,
  type LbmState,
  createLbmState,
  lbmComputeMacroscopic,
  lbmReflectSolids,
  lbmTotalMomentum,
} from "./state";
export {
  LBM_DEFAULT_MAGIC_LAMBDA,
  LBM_MAGIC_LAMBDA_MAX,
  type LbmCollisionModel,
  type LbmRelaxationRates,
  lbmCollide,
  lbmCollisionModelProblem,
  lbmRelaxationRates,
} from "./relaxation";
export { lbmStream, lbmSwap } from "./streaming";
export {
  LBM_FACE_ORDER,
  LBM_FACES,
  type LbmFace,
  type LbmFaceCondition,
  type LbmFaceMomentumLedger,
  lbmApplyFaceConditions,
} from "./boundaries";
export { lbmSolidMask, lbmSolidMaskFromGrid } from "./occupancy";
export {
  LBM_FORCE_SERIES_NAMES,
  LBM_FORCE_UNIT,
  LbmForceAccumulator,
} from "./forces";
export {
  type LbmFaceSpec,
  type LbmLatticeSnapshot,
  type LbmMomentumBookkeeping,
  type LbmRunMeta,
  type LbmSISnapshot,
  type LbmStepper,
  type LbmStepperConfig,
  createLbmStepper,
} from "./stepper";
export { type LbmFieldMoments, LbmMomentAccumulator } from "./averaging";
export {
  LBM_GRID_CONVERGENCE_DIRECTION,
  LBM_GRID_CONVERGENCE_REFINEMENT,
  type LbmConvergenceRungFacts,
  type LbmConvergenceRungView,
  type LbmFieldDrift,
  type LbmForceDrift,
  type LbmGridConvergenceReport,
  lbmConvergenceRungProblem,
  lbmGridConvergenceDrift,
} from "./convergence";
export {
  type LbmGridConvergenceSpec,
  type LbmRunAveragingSpec,
  type LbmRunForceSummary,
  type LbmRunGridFacts,
  type LbmRunReport,
  type LbmRunScenario,
  type LbmRunWindow,
  lbmRunSimResult,
  runLbmScenario,
} from "./run";
export {
  LBM_PREVIEW_CHUNK_MAX_VALUES,
  LBM_PREVIEW_INTERVAL_STEPS,
  LBM_SIM_ENGINE_ID,
  createDefaultSimEngine,
  createLbmSimEngine,
} from "./engine";
