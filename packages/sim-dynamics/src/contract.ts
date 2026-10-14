/**
 * The `DynamicsEngine` contract (Phase 67a, ROADMAP-SIM §4/§5): the
 * provider seam mechanism dynamics solves behind — an own deterministic
 * TypeScript reference kernel (this package, the S2/S5 oracle) today,
 * the MuJoCo wasm provider (Phase 67b) mapped onto the SAME semantics
 * tomorrow. PURE TYPES ONLY, exactly the `SimEngine` discipline: the
 * contract owns the shapes and the units stance, never a solver.
 *
 * ## The semantics the contract pins
 *
 * - **build → step/control**: {@link DynamicsEngine.build} compiles one
 *   mechanism (world-placed occurrences, serialized joint records,
 *   per-occurrence mass properties, optional per-joint motors) into a
 *   stateful {@link DynamicsSystem}; `step` advances ONE time step
 *   under a {@link DynamicsControl} and returns the FULL state as data
 *   ({@link DynamicsStepResult}) — placements, rates, joint reactions,
 *   friction and motor state, energies, momenta. There is no second
 *   read-back channel: the step result IS the observation.
 * - **Gravity is a body force, first-class**: the build carries the
 *   SI gravity vector (the Phase 61 scenario's `gravityMPerS2` —
 *   self-weight is honest), the kernel maps it to per-body spatial
 *   forces, and Phase 69's structural loads share the same term through
 *   the control's external loads.
 * - **Friction is part of `step`, never a post-pass**: the additive
 *   joint-record fields (viscous damping, Coulomb friction loss) enter
 *   the velocity solve as force-limited constraints with emergent slip;
 *   the dissipated power and cumulative work per joint are RESULT data.
 * - **State-deterministic**: same build + same control sequence →
 *   bitwise-identical results (law S2); a provider that cannot honor
 *   this states so in its own documentation, never silently.
 *
 * ## Units (law S4)
 *
 * The door consumes DOCUMENT wire forms (placements in mm, mass in
 * grams, COG in world mm, motor records in authored datasheet units)
 * and the kernel runs pure SI (m, kg, s, rad, N, N·m, W, J). The step
 * result projects placements back to document millimetres (rotation
 * matrix + translation mm) beside the SI quantities — every quantity's
 * unit is named in its field.
 */

import type {
  CompiledSimMotor,
  SimError,
  SimParseResult,
} from "@slopcad/sim-core";
import type { DofFlavor, DynamicsJointKind } from "./joints";

/** One occurrence's resolved world placement, document millimetres (wire form). */
export interface DynamicsOccurrenceWire {
  readonly id: string;
  /**
   * The world placement the assembly resolver (or mate solve) produced:
   * a 9-number row-major rotation and a translation in mm. This is the
   * host-resolved form of the document's occurrence placements — the
   * same shape `solveAssemblyMates` returns and `PlacedBodyInstance`
   * carries.
   */
  readonly placement: {
    readonly rotation: readonly number[];
    readonly translation: readonly [number, number, number];
  };
}

/**
 * One occurrence's mass properties at the door: the document-mass
 * aggregate's products (mass in grams, the mass-weighted WORLD centre
 * of gravity in mm) plus the optional rotational tensor the host
 * measures. An ABSENT tensor models the occurrence as a POINT MASS at
 * its COG — exact for translation, zero rotational resistance about
 * the COG (stated, never hidden): a caller meaning to rotate a body
 * meaningfully authors the tensor.
 */
export interface DynamicsMassWire {
  readonly occurrenceId: string;
  /** Mass in grams (positive finite — the mass aggregate's own unit). */
  readonly massGrams: number;
  /** The world COG in mm (the aggregate's mass-weighted centroid). */
  readonly centerOfGravityMm: readonly [number, number, number];
  /**
   * The rotational inertia about the COG, kg·m², as a 9-number
   * row-major 3×3 in the OCCURRENCE-LOCAL axes (the door rotates it to
   * world); absent = point mass. Must be symmetric positive
   * semidefinite when present.
   */
  readonly inertiaTensorKgM2?: readonly number[];
}

/** One motor riding one joint: the serialized motor record + the joint it drives. */
export interface DynamicsMotorWire {
  readonly jointId: string;
  /**
   * The CANONICAL SERIALIZED motor record (`DocumentMotorRecord` wire
   * form); the door compiles it through sim-core's `compileSimMotor` —
   * the one authored-datasheet → SI motor conversion site in the stack.
   */
  readonly motor: unknown;
}

/** What {@link DynamicsEngine.build} consumes: one mechanism, wire forms in. */
export interface DynamicsBuildInput {
  /** Every occurrence of the mechanism, in document order. */
  readonly occurrences: readonly DynamicsOccurrenceWire[];
  /** The serialized joint records (`DocumentJoint` canonical JSON), in document order. */
  readonly joints: readonly unknown[];
  /** Every occurrence's mass properties (one entry per occurrence). */
  readonly masses: readonly DynamicsMassWire[];
  /** Occurrences welded to ground (the mate solver's vocabulary); absent = none. */
  readonly grounded?: readonly string[];
  /**
   * The gravity vector, m/s² — FIRST-CLASS: the Phase 61 scenario's
   * vector mapped to per-body spatial forces inside the kernel.
   */
  readonly gravityMPerS2: readonly [number, number, number];
  /** Motors riding joints (at most one per joint). */
  readonly motors?: readonly DynamicsMotorWire[];
  /**
   * Initial generalized rates per joint, in the joint's pinned DOF
   * order (rad/s and m/s); absent joints start at rest.
   */
  readonly initialJointRates?: readonly {
    readonly jointId: string;
    readonly rates: readonly number[];
  }[];
}

/** One external load on one body (the Phase 69 shared term's shape). */
export interface DynamicsLoad {
  readonly occurrenceId: string;
  /** The force, N, world components. */
  readonly forceN: readonly [number, number, number];
  /** The application point, world metres; absent = the body's COG. */
  readonly atWorldPointM?: readonly [number, number, number];
}

/** One direct effort on one joint's drive DOF. */
export interface DynamicsJointEffort {
  readonly jointId: string;
  /** N·m on a rotational drive joint (revolute/cylindrical), N on a slider. */
  readonly effort: number;
}

/** What one step consumes. */
export interface DynamicsControl {
  /** The time step, s (positive finite). */
  readonly timeStepS: number;
  /** External loads this step (world forces at world points). */
  readonly loads?: readonly DynamicsLoad[];
  /** Direct joint efforts this step. */
  readonly jointEfforts?: readonly DynamicsJointEffort[];
}

/** One joint DOF's full state after a step (SI; the unit follows the flavour). */
export interface DynamicsJointDofState {
  readonly flavor: DofFlavor;
  /** rad (rotational) | m (translational). */
  readonly position: number;
  /** rad/s | m/s. */
  readonly rate: number;
  /** rad/s² | m/s². */
  readonly acceleration: number;
  /** The Coulomb friction force this step (N·m | N), sign opposing the motion. */
  readonly coulombForce: number;
  /** The viscous force this step (N·m | N): −d·q̇. */
  readonly viscousForce: number;
  /** Instantaneous dissipated power, W: d·q̇² + |Coulomb·q̇| (≥ 0). */
  readonly dissipatedPowerW: number;
  /** Cumulative dissipated work since build, J. */
  readonly dissipatedWorkJ: number;
}

/**
 * The reaction across one joint: the spatial force the joint transmits
 * from its base side to its child side, AT the joint origin, world
 * components — including gravity's contribution (the honest bearing
 * load). Loop joints carry the multiplier wrench of the closure solve
 * (documented as such by the kernel).
 */
export interface DynamicsJointReaction {
  readonly forceN: readonly [number, number, number];
  readonly torqueNPerM: readonly [number, number, number];
}

/** The motor's state after a step (the 61 motor record riding the joint). */
export interface DynamicsMotorState {
  readonly jointId: string;
  /** The drive DOF's rate, rad/s. */
  readonly speedRadPerS: number;
  /** The torque delivered at that speed, N·m. */
  readonly torqueNPerM: number;
  /** Mechanical power delivered to the joint, W (τ·ω). */
  readonly mechanicalPowerW: number;
  /** Cumulative mechanical work delivered, J. */
  readonly mechanicalWorkJ: number;
  /** Electrical draw, W (analytic kinds: V·T/Kt); absent for tabulated. */
  readonly electricalPowerW?: number;
  /** Cumulative electrical energy, J; absent for tabulated. */
  readonly electricalWorkJ?: number;
}

/** One joint's full state after a step. */
export interface DynamicsJointState {
  readonly id: string;
  readonly kind: DynamicsJointKind;
  /** Whether the joint is a tree edge (true) or a closing loop constraint (false). */
  readonly tree: boolean;
  /** The DOF states in the pinned order; empty for rigid and loop joints. */
  readonly dofs: readonly DynamicsJointDofState[];
  /** The reaction wrench (tree joints: RNEA-exact; loop joints: the closure multipliers). */
  readonly reaction?: DynamicsJointReaction;
  /** The motor riding this joint, when one does. */
  readonly motor?: DynamicsMotorState;
  /** Loop joints only: the worst residual row (m | rad) after closure. */
  readonly loopResidual?: number;
}

/** One occurrence's world state after a step (placements in document mm). */
export interface DynamicsOccurrenceState {
  readonly id: string;
  /** 9-number row-major world rotation. */
  readonly rotation: readonly number[];
  /** The world translation, mm. */
  readonly translationMm: readonly [number, number, number];
  /** The world COG, mm. */
  readonly centerOfGravityMm: readonly [number, number, number];
  /** The world angular velocity, rad/s. */
  readonly angularVelocityRadPerS: readonly [number, number, number];
  /** The world velocity of the occurrence's origin point, m/s. */
  readonly linearVelocityMPerS: readonly [number, number, number];
}

/** The energy ledger after a step (the conservation audit's material). */
export interface DynamicsEnergyState {
  readonly kineticJ: number;
  /** −Σ m·g·c over the bodies (absolute, world-origin referenced). */
  readonly gravitationalPotentialJ: number;
  /** Cumulative friction dissipation, J. */
  readonly dissipatedJ: number;
  /** Cumulative work done BY motors ON the mechanism, J. */
  readonly motorWorkJ: number;
  /** Cumulative work done BY external loads ON the mechanism, J. */
  readonly externalWorkJ: number;
  /**
   * KE + PE − motorWork − externalWork + dissipated: conserved by the
   * physics (its drift is the integrator's, stated by the audit
   * fixtures, never hidden).
   */
  readonly auditJ: number;
}

/** The mechanism's momenta about the world origin after a step. */
export interface DynamicsMomentumState {
  readonly linearKgMPerS: readonly [number, number, number];
  readonly angularKgM2PerS: readonly [number, number, number];
}

/** Solver telemetry after a step (machine-readable, deterministic). */
export interface DynamicsSolverState {
  /** The friction/constraint cone iterations consumed (pinned cap). */
  readonly coneIterations: number;
  /** The worst |loop residual| after position closure (m | rad); 0 with no loops. */
  readonly loopResidual: number;
}

/** The full observation one step returns — results as data (S7-shaped). */
export interface DynamicsStepResult {
  /** Accumulated simulation time, s. */
  readonly timeS: number;
  readonly occurrences: readonly DynamicsOccurrenceState[];
  readonly joints: readonly DynamicsJointState[];
  readonly energy: DynamicsEnergyState;
  readonly momentum: DynamicsMomentumState;
  readonly solver: DynamicsSolverState;
}

/**
 * A compiled, stateful mechanism. One {@link DynamicsSystem.step} call
 * advances one time step and returns the state as data; the sequence of
 * step results is the run. Deterministic by law S2: an identical build
 * plus an identical control sequence produces bitwise-identical
 * results.
 */
export interface DynamicsSystem {
  /** The mechanism's body (occurrence) count. */
  readonly bodyCount: number;
  /** The tree's total generalized DOF count. */
  readonly dofCount: number;
  /** The closing-loop joint count (0 for a pure tree). */
  readonly loopJointCount: number;
  step(control: DynamicsControl): SimParseResult<DynamicsStepResult, SimError>;
}

/**
 * One solver behind the mechanism-dynamics provider seam. The reference
 * kernel is synchronous (plain TS arithmetic, no worker hop); the
 * async/worker seam is the `SimEngine` layer above it, exactly as the
 * geometry kernel's sync contract sits under its worker transport.
 */
export interface DynamicsEngine {
  /** The engine's stable id (e.g. "dynamics-featherstone-cpu-reference"). */
  readonly id: string;
  build(input: DynamicsBuildInput): SimParseResult<DynamicsSystem, SimError>;
}

/** The motor view the kernel consumes (sim-core's compiled SI form, verbatim). */
export type DynamicsCompiledMotor = CompiledSimMotor;
