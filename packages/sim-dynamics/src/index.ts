/**
 * Public entry of `@slopcad/sim-dynamics`, the mechanism-dynamics
 * domain package (ROADMAP-SIM Phase 67a): the `DynamicsEngine`
 * contract (pure types — the provider seam MuJoCo lands behind at
 * 67b), the document→solver wire door (S4's document half —
 * occurrences, serialized joint records with the additive friction
 * fields, mass properties, motor records), the world-aligned spatial
 * algebra, and the own TS reference kernel — Featherstone-style
 * articulated-body dynamics over `JOINT_KINDS` with gravity as a
 * first-class body force, friction as force-limited constraints with
 * emergent slip inside `step` (the §7.10 ruling), per-joint dissipated
 * power/work as result data, the 61 motor abstraction (rotor inertia +
 * torque curve → ω(t)), and loop closure through the restated LM
 * machinery. The package depends on `@slopcad/sim-core` alone at
 * runtime — no React, no DOM, no node APIs (law S2), which is what
 * makes this CPU kernel the test truth (law S5). The MuJoCo provider
 * (67b) and the UI/engine routing (67c) are later phases behind this
 * same contract.
 */

export {
  type DofFlavor,
  DYNAMICS_JOINT_KINDS,
  type DynamicsJointKind,
  jointDofCount,
  jointDofFlavors,
  jointDofLayout,
  jointFreeRotation,
  jointFreeTranslation,
  jointRelativeAngularVelocity,
} from "./joints";
export {
  type CompiledBody,
  type CompiledJoint,
  type CompiledMechanism,
  type CompiledMotorAssignment,
  type DoorJointKind,
  compileMechanism,
} from "./door";
export {
  type DynamicsBuildInput,
  type DynamicsCompiledMotor,
  type DynamicsControl,
  type DynamicsEngine,
  type DynamicsEnergyState,
  type DynamicsJointDofState,
  type DynamicsJointEffort,
  type DynamicsJointReaction,
  type DynamicsJointState,
  type DynamicsLoad,
  type DynamicsMassWire,
  type DynamicsMomentumState,
  type DynamicsMotorState,
  type DynamicsMotorWire,
  type DynamicsOccurrenceState,
  type DynamicsOccurrenceWire,
  type DynamicsSolverState,
  type DynamicsStepResult,
  type DynamicsSystem,
} from "./contract";
export {
  CONE_OUTER_ITERATIONS,
  FRICTION_PGS_SWEEPS,
  type VelocityConeSolution,
  dissipatedPowerW,
  solveKkt,
  solveDense,
  solveVelocityCone,
} from "./friction";
export {
  LOOP_BAUMGARTE_BETA,
  LOOP_CLOSURE_TOLERANCE,
  LOOP_FD_STEP,
  LOOP_LM_MAX_ITERATIONS,
  type LoopJointConstraint,
  type LoopProjectionOutcome,
  type LoopRowDual,
  type PoseView,
  loopReactionWrench,
  loopRowsAndDuals,
  projectLoops,
  projectLoopVelocities,
  worstResidual,
} from "./loop-closure";
export {
  DYNAMICS_REFERENCE_ENGINE_ID,
  createReferenceDynamicsEngine,
} from "./engine";
export {
  type DynamicsEngineChoice,
  DEFAULT_DYNAMICS_ENGINE,
  createDynamicsEngine,
} from "./engine-select";
export {
  type CompiledDynamicsLoadSeries,
  type DynamicsLoadControlTerms,
  compileDynamicsLoads,
  emptyDynamicsLoadTerms,
  evaluateDynamicsLoads,
} from "./loads";
export {
  DYNAMICS_DISSIPATION_FIELD_ID,
  DYNAMICS_PREVIEW_CHUNK_MAX_VALUES,
  DYNAMICS_SIM_ENGINE_ID,
  DYNAMICS_SUPPORTED_KINDS,
  createDynamicsSimEngine,
} from "./sim-engine";
export type { MechanismTopology, TreeTopologyNode } from "./topology";
export { mechanismTopology } from "./topology";
export {
  DYNAMICS_MUJOCO_ENGINE_ID,
  type MujocoProbeOutcome,
  type MujocoProbeStation,
  createMujocoDynamicsEngine,
  probeMujocoState,
} from "./mujoco-provider";
export {
  MJCF_INERTIA_FLOOR_KG_M2,
  MJCF_LOOP_AXIS_SAMPLE_M,
  MJCF_LOOP_SOLREF_DAMPRATIO,
  MJCF_LOOP_SOLREF_TIMECONST,
  type MjcfDocument,
  type MjcfJointChannel,
  type MjcfLoopChannel,
  type MjcfMotorChannel,
  buildMjcf,
  mat3FromQuat,
  mjcfNumber,
  quatFromMat3,
  rotationVectorFromMat3,
} from "./mujoco-model";
export {
  isAnalyticMotor,
  isTabulatedMotor,
  motorElectricalPowerW,
  motorRotorInertiaKgM2,
  motorTorqueNPerM,
} from "./motor";
export {
  type Mat3,
  type SpatialForce,
  type SpatialInertia,
  type SpatialMotion,
  type SpatialTransform,
  type Vec3,
  add3,
  addMat3,
  addSpatialForce,
  addSpatialInertia,
  addSpatialMotion,
  composeTransforms,
  cross3,
  dot3,
  expRotation,
  forceCross,
  IDENTITY_MAT3,
  IDENTITY_TRANSFORM,
  motionCross,
  mulMat3,
  mulMat3Vec,
  mulSpatialInertia,
  neg3,
  norm3,
  rotateSpatialInertia,
  rotationAboutUnitAxis,
  scale3,
  scaleMat3,
  shiftForceTo,
  shiftMotionTo,
  shiftSpatialInertia,
  skewMat3,
  spatialInertiaAboutOrigin,
  sub3,
  transposeMat3,
  translationTransform,
  wrapRotationVector,
} from "./spatial";
