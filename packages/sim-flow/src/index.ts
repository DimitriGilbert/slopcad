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
 * the routed default engine that serves flow with it (its 63c thermal
 * route went to the fake engine until Phase 65c retired it for the
 * real conduction/CHT engines). The package depends on
 * `@slopcad/sim-core` alone at runtime — no React, no DOM, no node APIs
 * in the runtime entry (law S2), which is what makes the CPU
 * oracle the test truth (law S5). The node-only hosting modules
 * (`./engine-worker.node`, `./engine-node-channel`) are deliberately
 * subpath-only, the sim-core precedent.
 *
 * The SoA layout (`./d2q9`, `./state`) is the shared memory contract
 * the Phase 64 WGSL provider mirrors buffer-for-buffer.
 *
 * Phase 64a adds the WGSL COMPUTE PROVIDER surface: the narrow
 * WebGPU device abstraction with its honest feature detect
 * (`./gpu-device`, `requestWebGpuDevice`), the generated shader
 * module and its layout helpers (`./wgsl-shader`), the provider
 * stepper (`./wgsl-stepper`), the provider engine and the routed
 * default engine's gpu-preference fallback (`./engine-gpu`,
 * `./engine`), and the S5 oracle-vs-GPU tolerance harness
 * (`./gpu-oracle-harness`) — tolerances recorded as data, the matrix
 * skipping loudly where no WebGPU device exists. The node-side fake
 * device (`./wgsl-fake-device`) is subpath-imported by the tests, the
 * sim-core node-hosting precedent.
 *
 * Phase 66a adds the D3Q19 3D KERNEL beside the 2D one: the lattice
 * and its SoA layout contract (`./d3q19`), the CPU 3D oracle
 * (`./state-3d`, `./streaming-3d`, `./relaxation-3d`,
 * `./boundaries-3d`, `./forces-3d`, `./stepper-3d` — BGK/TRT,
 * full-way bounce-back on the Phase 62 voxelizer's native 3D output,
 * momentum-exchange forces in three components, the exact momentum
 * audit, the 3D unit closure `./lattice-units-3d`, the occupancy door
 * `./occupancy-3d`), the WGSL 3D provider (`./wgsl-shader-3d`,
 * `./wgsl-stepper-3d` — the 64a seven-pass decomposition and
 * no-atomics force reduction carried over, on the REUSED
 * `./gpu-device` seam), and the S5 3D tolerance harness
 * (`./gpu-oracle-3d-harness`). The engine adapter and run
 * orchestration for 3D scenarios are 66b's carve (rotating machinery
 * shapes them); this package's 66a surface is the kernel-and-provider
 * layer they will drive.
 *
 * Phase 66b adds ROTATING MACHINERY over that kernel (CPU-oracle-only
 * this phase; the WGSL provider declines rotation-marked configs
 * loudly): the shared rotation vocabulary (`./rotation-3d`), MRF —
 * the honest steady-fan default (`./mrf-3d`: the frozen rotor as the
 * exact one-Coriolis lab-variable form — Guo frame forces through
 * `./relaxation-3d`'s forcing seam over a raw, exactly conservative
 * interface exchange — with the exact extended momentum audit),
 * resolved rotation — the immersed moving-boundary showcase
 * (`./resolved-rotation-3d`: per-step rotor advance, fresh/covered
 * node conversion, wall-velocity bounce-back at link midpoints),
 * torque integration about an axis (`./torque-3d`, over
 * `./state-3d`'s boundary-link sink seam), the shared readouts
 * (`./readout-3d`), the operating-point solve (`./operating-point`),
 * and the fan analysis — the MRF ω-ladder load curve with the Phase 67
 * friction seam, the motor-in-the-loop operating point, the
 * performance read, BPF, and the S9 fan Re guidance line (`./fan-3d`).
 *
 * Phase 66c adds the ENGINE + PRODUCT ROUTING over both: the 3D flow
 * engine behind the Phase 61 contract (`./engine-3d` — the static 3D
 * door on the 66a stepper, the MRF fixed-rpm and motor-driven
 * operating-point doors, the resolved-rotation showcase, each streamed
 * per law S6 and each routed loudly through `./engine`'s default
 * engine), the flow scenario's additive 3D stance at the cad-core
 * record boundary, and the compile door's 3D branch (sim-core's
 * `compile-geometry`: the full-3D occupancy grid + the SI rotation
 * products + the cut-cell decline).
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
  type LbmBuoyancyConfig,
  type LbmForceField,
  lbmBuoyancyForceLattice,
  lbmBuoyancyProblem,
  lbmForceFieldTotal,
} from "./buoyancy";
export {
  CHT_HISTORY_SERIES,
  CHT_SCALAR_SAFETY_DEFAULT,
  CHT_SOLID_DEFAULTS,
  type ChtEnergyLedger,
  type ChtRunReport,
  type ChtScenario,
  runChtScenario,
} from "./cht";
export {
  type LbmThermalFaceCondition,
  type LbmThermalScalar,
  type LbmThermalScalarConfig,
  createLbmThermalScalar,
  lbmInterfaceConductanceWPerMK,
} from "./thermal-scalar";
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
  type DefaultSimEngineOptions,
} from "./engine";
export {
  FLOW3D_LADDER_FRACTIONS,
  LBM3D_SIM_ENGINE_ID,
  LBM3D_SUPPORTED_KINDS,
  createFlow3dSimEngine,
} from "./engine-3d";
export {
  CHT_SIM_ENGINE_ID,
  CHT_SUPPORTED_KINDS,
  chtRunSimResult,
  createChtSimEngine,
} from "./engine-cht";
export { LBM_WGSL_SIM_ENGINE_ID, createWgslSimEngine } from "./engine-gpu";
export {
  type LateralFace,
  LBM_SUPPORTED_KINDS,
  type MappedFaces,
  mapFaces,
} from "./engine-shared";
export {
  type WgslBindGroup,
  type WgslBindGroupEntry,
  type WgslBuffer,
  type WgslBufferUsage,
  type WgslCommandBuffer,
  type WgslCommandEncoder,
  type WgslComputePass,
  type WgslComputePipeline,
  type WgslDevice,
  type WgslDeviceSource,
  type WgslQueue,
  requestWebGpuDevice,
} from "./gpu-device";
export {
  GPU_ORACLE_MATRIX,
  GPU_ORACLE_TOLERANCES,
  type GpuFieldDelta,
  type GpuForceDelta,
  type GpuOracleCase,
  type GpuOracleCaseReport,
  type GpuOracleTolerances,
  gpuFieldDelta,
  gpuForceDelta,
  gpuOracleSkipReason,
  gpuOracleViolations,
  runGpuOracleCase,
} from "./gpu-oracle-harness";
export {
  WGSL_BINDINGS,
  WGSL_COLLISION_KINDS,
  WGSL_D2Q9_COMPUTE,
  WGSL_ENTRY_POINTS,
  WGSL_FACE_KINDS,
  WGSL_MAX_NODES,
  WGSL_RUN_PARAMS_BYTE_LENGTH,
  WGSL_STATUS_INDEXES,
  WGSL_STEP_PARAMS_BYTE_LENGTH,
  WGSL_WORKGROUP_SIZE,
  type WgslFaceParams,
  type WgslRunParams,
  type WgslStepParams,
  wgslDirectionByteOffset,
  wgslEncodeRunParams,
  wgslEncodeStepParams,
  wgslPackDistributions,
  wgslPackMask,
  wgslPackStatus,
  wgslReductionShape,
  wgslUnpackDistributions,
} from "./wgsl-shader";
export {
  type WgslLbmStepper,
  type WgslStepperOptions,
  createWgslLbmStepper,
} from "./wgsl-stepper";
export {
  D3Q19_CS2,
  D3Q19_OPPOSITE,
  D3Q19_Q,
  D3Q19_VELOCITIES,
  D3Q19_WEIGHTS,
  d3q19Equilibrium,
  d3q19EquilibriumEven,
  d3q19EquilibriumOdd,
  d3q19FillEquilibrium,
} from "./d3q19";
export {
  type Lbm3dSolidMask,
  type Lbm3dState,
  createLbm3dState,
  lbm3dComputeMacroscopic,
  lbm3dReflectSolids,
  lbm3dTotalMomentum,
} from "./state-3d";
export { lbm3dStream, lbm3dSwap } from "./streaming-3d";
export { lbm3dCollide } from "./relaxation-3d";
export { type Lbm3dUnitSystem, lbm3dUnitSystem } from "./lattice-units-3d";
export {
  LBM3D_FACE_ORDER,
  LBM3D_FACES,
  type Lbm3dFace,
  type Lbm3dFaceCondition,
  type Lbm3dFaceMomentumLedger,
  lbm3dApplyFaceConditions,
} from "./boundaries-3d";
export { lbm3dSolidMask, lbm3dSolidMaskFromGrid } from "./occupancy-3d";
export {
  LBM3D_FORCE_SERIES_NAMES,
  LBM3D_FORCE_UNIT,
  Lbm3dForceAccumulator,
} from "./forces-3d";
export {
  type Lbm3dFaceSpec,
  type Lbm3dLatticeSnapshot,
  type Lbm3dMomentumBookkeeping,
  type Lbm3dRunMeta,
  type Lbm3dSISnapshot,
  type Lbm3dStepper,
  type Lbm3dStepperConfig,
  createLbm3dStepper,
} from "./stepper-3d";
export {
  GPU_ORACLE_3D_MATRIX,
  GPU_ORACLE_3D_TOLERANCES,
  type GpuOracle3dCase,
  type GpuOracle3dCaseReport,
  gpuOracle3dSkipReason,
  gpuOracle3dViolations,
  runGpuOracle3dCase,
} from "./gpu-oracle-3d-harness";
export {
  WGSL3D_BINDINGS,
  WGSL3D_COLLISION_KINDS,
  WGSL3D_ENTRY_POINTS,
  WGSL3D_FACE_KINDS,
  WGSL3D_MAX_NODES,
  WGSL3D_RUN_PARAMS_BYTE_LENGTH,
  WGSL3D_STATUS_INDEXES,
  WGSL3D_STEP_PARAMS_BYTE_LENGTH,
  WGSL3D_WORKGROUP_SIZE,
  WGSL_D3Q19_COMPUTE,
  type Wgsl3dFaceParams,
  type Wgsl3dRunParams,
  type Wgsl3dStepParams,
  wgsl3dDirectionByteOffset,
  wgsl3dEncodeRunParams,
  wgsl3dEncodeStepParams,
  wgsl3dPackDistributions,
  wgsl3dPackMask,
  wgsl3dPackStatus,
  wgsl3dReductionShape,
  wgsl3dUnpackDistributions,
} from "./wgsl-shader-3d";
export {
  type Wgsl3dStepper,
  type Wgsl3dStepperOptions,
  createWgsl3dStepper,
} from "./wgsl-stepper-3d";
export {
  LBM3D_ROTATION_KINDS,
  type Lbm3dRotationAxis,
  type Lbm3dRotationAxisSpec,
  type Lbm3dRotationKind,
  type Lbm3dRotationMarker,
  lbm3dCompileAxis,
  lbm3dOmegaLattice,
  lbm3dPerpendicularRadius,
  lbm3dStepsPerRevolution,
} from "./rotation-3d";
export {
  LBM3D_TORQUE_SERIES_NAME,
  LBM3D_TORQUE_UNIT,
  Lbm3dTorqueAccumulator,
  type Lbm3dTorqueLedger,
  lbm3dMrfRotorTorqueSink,
  lbm3dRotatingWallTorqueSink,
  lbm3dStaticWallTorqueSink,
} from "./torque-3d";
export {
  type Lbm3dMacroscopicFields,
  type Lbm3dVelocityShift,
  lbm3dLatticeSnapshotOf,
  lbm3dMacroscopicOf,
  lbm3dSISnapshotOf,
  lbm3dSolverFieldsOf,
} from "./readout-3d";
export { type Lbm3dGuoForcing } from "./relaxation-3d";
export {
  type Lbm3dMrfBookkeeping,
  type Lbm3dMrfConfig,
  type Lbm3dMrfMeta,
  type Lbm3dMrfStepper,
  createMrf3dStepper,
  mrfCylindricalZone,
  mrfCylindricalZonePredicate,
} from "./mrf-3d";
export {
  type Lbm3dResolvedRotationConfig,
  type Lbm3dResolvedRotationMeta,
  type Lbm3dResolvedRotationStepper,
  createResolvedRotation3dStepper,
} from "./resolved-rotation-3d";
export {
  type FanOperatingPointSolve,
  type OperatingPointCandidate,
  type TorqueSpeedSample,
  bladePassFrequencyHz,
  intersectMotorLoadCurve,
  loadTorqueAt,
  loadTorqueSlope,
  motorTorqueAt,
  motorTorqueSlope,
  rpmOf,
  solveOperatingPoint,
  validatedLoadCurve,
} from "./operating-point";
export {
  FAN_DEFAULT_PLANE_EXTRACTION,
  FAN_LOW_REYNOLDS_ADVISORY,
  type FanAnalysisConfig,
  type FanLoadCurve,
  type FanLoadCurveSweepOptions,
  type FanOperatingPointResult,
  type FanPerformance,
  type FanPlaneExtraction,
  type FanPowers,
  type FanRegimeHonesty,
  analyzeFanOperatingPoint,
  extractFanPerformance,
  runFanLoadCurveSweep,
} from "./fan-3d";
