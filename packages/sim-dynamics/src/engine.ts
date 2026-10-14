/**
 * The TS reference dynamics kernel (Phase 67a, law S2): Featherstone-
 * style articulated-body dynamics over the document's `JOINT_KINDS`,
 * in WORLD-ALIGNED spatial algebra — the formulation this package
 * fully owns and pins. The solver choices, stated:
 *
 * - **Mass matrix**: the composite-rigid-body sum in its plainest form
 *   — per-body Jacobians `J_b` (the world-frame motion subspace columns
 *   of every ancestor joint, shifted to the body origin) with
 *   `M = Σ_b J_bᵀ I_b J_b` (rotor inertias on their drive diagonals).
 *   Correctness over cleverness at assembly scale; the classic
 *   body-frame CRBA recursion buys constants this oracle does not need.
 * - **Bias forces**: the d'Alembert inertial wrench in the moving-origin
 *   gauge (`dAlembertWrench` below) — the exact time derivative of each
 *   body's spatial momentum at the classical acceleration pair, applied
 *   identically in the generalized-force and reaction passes —
 *   cross-checked by the conservation fixtures (any inconsistency with
 *   the Jacobian formulation would surface there as energy drift).
 * - **Gravity**: a body force, first-class — the compiled scenario
 *   vector mapped to `[h × g; m·g]` wrenches at every body origin; the
 *   control's external loads share the same applied-force term.
 * - **Friction**: force-limited constraints with emergent slip inside
 *   the step's velocity solve (`./friction`) — the §7.10 ruling.
 * - **Loop closure**: the restated LM machinery (`./loop-closure`).
 * - **Integration**: semi-implicit (velocity-level solve, positions at
 *   the new rates), first-order Lie–Euler on rotations (the ball/free
 *   rotation vectors integrate component-wise; the orientation is the
 *   exact exponential of the vector — exact for fixed-axis rotation).
 *   The fixtures state the audit tolerances of this order honestly.
 *
 * Zero external dependencies, bitwise deterministic (S2), runnable in
 * plain vitest node env (S5's CPU oracle).
 */

import {
  type SimError,
  SIM_ERROR_CODES,
  type SimParseResult,
  simError,
  simFail,
  simOk,
} from "@slopcad/sim-core";
import type {
  DynamicsBuildInput,
  DynamicsControl,
  DynamicsEngine,
  DynamicsEnergyState,
  DynamicsJointDofState,
  DynamicsJointState,
  DynamicsMomentumState,
  DynamicsOccurrenceState,
  DynamicsStepResult,
  DynamicsSystem,
} from "./contract";

import {
  type CompiledJoint,
  type CompiledMechanism,
  compileMechanism,
} from "./door";
import { dissipatedPowerW, solveVelocityCone } from "./friction";
import {
  type JointDofLayout,
  jointDofFlavors,
  jointFreeRotation,
  jointFreeTranslation,
  jointRelativeAngularVelocity,
} from "./joints";
import {
  LOOP_BAUMGARTE_BETA,
  LOOP_CLOSURE_TOLERANCE,
  LOOP_FD_STEP,
  type LoopJointConstraint,
  type LoopRowDual,
  type PoseView,
  loopReactionWrench,
  loopRowsAndDuals,
  projectLoops,
  projectLoopVelocities,
  worstResidual,
} from "./loop-closure";
import {
  motorElectricalPowerW,
  motorRotorInertiaKgM2,
  motorTorqueNPerM,
} from "./motor";
import { mechanismTopology } from "./topology";
import {
  type Mat3,
  type SpatialForce,
  type SpatialInertia,
  type Vec3,
  add3,
  cross3,
  dot3,
  mulMat3,
  mulMat3Vec,
  mulSpatialInertia,
  rotateSpatialInertia,
  scale3,
  shiftForceTo,
  shiftMotionTo,
  sub3,
  transposeMat3,
  wrapRotationVector,
} from "./spatial";

/** The reference engine's stable id (the worker host's routing key). */
export const DYNAMICS_REFERENCE_ENGINE_ID =
  "dynamics-featherstone-cpu-reference";

const IDENTITY: Mat3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];
const ZERO3: Vec3 = [0, 0, 0];

/** One tree joint's solver-space node (a wire joint or a free root). */
interface TreeJoint {
  readonly id: string;
  /** The wire joint's compiled index; −1 for a synthetic free root. */
  readonly wireIndex: number;
  readonly layout: JointDofLayout;
  readonly dofOffset: number;
  readonly dofCount: number;
  readonly childBody: number;
  readonly parentBody: number;
  /** The anchor offset o (parent-local, SI); zero for free roots. */
  readonly origin: Vec3;
  /** B's rotation (anchor-local): the child's zero-station frame. */
  readonly bRotation: Mat3;
  /** B's translation (anchor-local, SI). */
  readonly bTranslation: Vec3;
  readonly viscous: number;
  readonly frictionLoss: number;
  /** The rotor inertia folded onto the drive diagonal (0 when no motor). */
  readonly rotorInertia: number;
  /** The drive DOF (local index) when a motor rides this joint. */
  readonly driveDof: number | undefined;
}

/** One body's per-pass kinematic state (world-aligned, at the body origin). */
interface FkBody {
  readonly r: Mat3;
  readonly t: Vec3;
  readonly ang: Vec3;
  readonly lin: Vec3;
  readonly alphaBias: Vec3;
  readonly aBias: Vec3;
  /** Jacobian columns (per global DOF) at the body origin. */
  readonly jAng: readonly Vec3[];
  readonly jLin: readonly Vec3[];
  readonly inertiaWorld: SpatialInertia;
}

/** One closing-loop joint's runtime node. */
interface LoopRuntime {
  readonly constraint: LoopJointConstraint;
  readonly wireIndex: number;
}

/** The reference system: the compiled mechanism plus the full kernel state. */
interface ReferenceSystem {
  readonly compiled: CompiledMechanism;
  readonly treeJoints: readonly TreeJoint[];
  /** Body indices, parents before children (ties by input order). */
  readonly order: readonly number[];
  /** Per body: its tree joint's index (−1 for grounded roots). */
  readonly bodyJoint: readonly number[];
  readonly loops: readonly LoopRuntime[];
  readonly gravity: Vec3;
  readonly dofCount: number;
  q: number[];
  qd: number[];
  warmVelocities: number[];
  warmForces: number[];
  warmMultipliers: number[];
  /** Per WIRE joint accumulators (indexed by compiled joint order). */
  readonly dissipatedJ: number[];
  readonly motorWorkJ: number[];
  readonly electricalWorkJ: number[];
  externalWorkJ: number;
  timeS: number;
}

function refuse(message: string, at: unknown): SimParseResult<never, SimError> {
  return simFail(simError(SIM_ERROR_CODES.mechanismInvalid, message, at));
}

/** Creates the Phase 67a reference engine (the oracle behind the contract). */
export function createReferenceDynamicsEngine(): DynamicsEngine {
  return {
    id: DYNAMICS_REFERENCE_ENGINE_ID,
    build: buildReferenceSystem,
  };
}

function buildReferenceSystem(
  input: DynamicsBuildInput,
): SimParseResult<DynamicsSystem, SimError> {
  const compiled = compileMechanism(input);
  if (!compiled.ok) return compiled;
  const mechanism = compiled.value;

  // --- Topology: the shared split (tree edges vs closing loops),
  // deterministic by wire order — `./topology`.
  const topology = mechanismTopology(mechanism.bodies, mechanism.joints);
  const pending = topology.nodes;
  const loopWire = topology.loopWire;
  const order = topology.order;
  const bodyIndexOf = new Map<string, number>();
  mechanism.bodies.forEach((body, index) => bodyIndexOf.set(body.id, index));

  const bodyJoint = new Array<number>(mechanism.bodies.length).fill(-1);
  const treeJoints: TreeJoint[] = [];
  let dofOffset = 0;
  for (const node of pending) {
    const body = mechanism.bodies[node.child];
    const parentBody =
      node.parent >= 0 ? mechanism.bodies[node.parent] : undefined;
    if (body === undefined) {
      throw new Error("Unreachable: tree children are validated bodies.");
    }
    const wire: CompiledJoint | undefined =
      node.wireIndex >= 0 ? mechanism.joints[node.wireIndex] : undefined;
    const layout: JointDofLayout =
      wire === undefined
        ? {
            kind: "free",
            rotational: [
              [1, 0, 0],
              [0, 1, 0],
              [0, 0, 1],
            ],
            translational: [
              [1, 0, 0],
              [0, 1, 0],
              [0, 0, 1],
            ],
          }
        : wire.layout;
    const dofCount = layout.rotational.length + layout.translational.length;
    // B: the child's zero-station frame relative to the joint anchor —
    // base-local for wire joints (the mates.ts conjugation), world for
    // free roots (the anchor is the world origin).
    let bRotation: Mat3;
    let bTranslation: Vec3;
    let origin: Vec3;
    if (wire === undefined || parentBody === undefined) {
      bRotation = body.initialR;
      bTranslation = body.initialT;
      origin = ZERO3;
    } else {
      const toParentLocal = transposeMat3(parentBody.initialR);
      bRotation = mulMat3(toParentLocal, body.initialR);
      bTranslation = sub3(
        mulMat3Vec(toParentLocal, sub3(body.initialT, parentBody.initialT)),
        wire.origin ?? ZERO3,
      );
      origin = wire.origin ?? ZERO3;
    }
    const motorWire = mechanism.motors.find(
      (entry) => entry.jointId === wire?.id,
    );
    if (
      motorWire !== undefined &&
      wire !== undefined &&
      loopWire.includes(node.wireIndex)
    ) {
      return refuse(
        `The motor rides joint "${motorWire.jointId}", which closes a loop; a motor drives a tree joint.`,
        motorWire.jointId,
      );
    }
    const driveDof =
      motorWire !== undefined && layout.rotational.length === 1 ? 0 : undefined;
    treeJoints.push({
      id: wire === undefined ? `${body.id}::free` : wire.id,
      wireIndex: node.wireIndex,
      layout,
      dofOffset,
      dofCount,
      childBody: node.child,
      parentBody: node.parent,
      origin,
      bRotation,
      bTranslation,
      viscous: wire?.viscousDamping ?? 0,
      frictionLoss: wire?.frictionLoss ?? 0,
      rotorInertia:
        motorWire !== undefined ? motorRotorInertiaKgM2(motorWire.motor) : 0,
      driveDof,
    });
    bodyJoint[node.child] = treeJoints.length - 1;
    dofOffset += dofCount;
  }
  const dofCount = dofOffset;

  // --- Loop constraints (wire order) --------------------------------------
  const loops: LoopRuntime[] = loopWire.map((wireIndex) => {
    const wire = mechanism.joints[wireIndex];
    if (wire === undefined) {
      throw new Error("Unreachable: loop wire indices are joint indices.");
    }
    const base = bodyIndexOf.get(wire.baseId);
    const moved = bodyIndexOf.get(wire.movedId);
    if (base === undefined || moved === undefined) {
      throw new Error("Unreachable: the door validated loop endpoints.");
    }
    return {
      constraint: {
        id: wire.id,
        kind: wire.kind,
        baseBodyIndex: base,
        movedBodyIndex: moved,
        origin: wire.origin ?? ZERO3,
        axis: wire.axis,
        layout: wire.layout,
      } satisfies LoopJointConstraint,
      wireIndex,
    };
  });
  // --- Closing joints with friction fields: declined loudly -----------
  // The step's friction discipline is defined on TREE-joint DOFs: a
  // per-DOF viscous diagonal plus per-DOF Coulomb cones in the velocity
  // solve. Honest velocity-level friction on a closing joint would be
  // cone constraints on the joint's GRANTED motion — the relative
  // twist across the two bodies projected on the loop rows' orthogonal
  // complement — which is not a generalized coordinate of the tree and
  // which this kernel's cone solve does not carry. The physics
  // treatment is therefore refusal, never a silent drop (the
  // motor-on-loop ruling), stated here where the topology is known.
  for (const loop of loops) {
    const wire = mechanism.joints[loop.wireIndex];
    if (wire === undefined) continue;
    if (wire.viscousDamping > 0 || wire.frictionLoss > 0) {
      return refuse(
        `Joint "${wire.id}" closes a loop and carries friction fields; this kernel owns velocity-level friction cones on tree-joint DOFs only (cone constraints on a closing joint's relative twist are not carried) — declined, never silently dropped.`,
        {
          jointId: wire.id,
          viscousDamping: wire.viscousDamping,
          frictionLoss: wire.frictionLoss,
        },
      );
    }
  }
  const system: ReferenceSystem = {
    compiled: mechanism,
    treeJoints,
    order,
    bodyJoint,
    loops,
    gravity: mechanism.gravityMPerS2,
    dofCount,
    q: new Array<number>(dofCount).fill(0),
    qd: new Array<number>(dofCount).fill(0),
    warmVelocities: new Array<number>(dofCount).fill(0),
    warmForces: new Array<number>(dofCount).fill(0),
    warmMultipliers: [],
    dissipatedJ: new Array<number>(mechanism.joints.length).fill(0),
    motorWorkJ: new Array<number>(mechanism.joints.length).fill(0),
    electricalWorkJ: new Array<number>(mechanism.joints.length).fill(0),
    externalWorkJ: 0,
    timeS: 0,
  };
  for (const joint of treeJoints) {
    if (joint.wireIndex < 0) continue;
    const wire = mechanism.joints[joint.wireIndex];
    if (wire === undefined) continue;
    for (let k = 0; k < joint.dofCount; k += 1) {
      system.qd[joint.dofOffset + k] = wire.initialRates[k] ?? 0;
    }
  }
  // Free roots carry their initial rates by the documented synthetic id.
  for (const joint of treeJoints) {
    if (joint.wireIndex >= 0) continue;
    const body = mechanism.bodies[joint.childBody];
    if (body === undefined) continue;
    const rates = input.initialJointRates?.find(
      (entry) => entry.jointId === `${body.id}::free`,
    )?.rates;
    if (rates === undefined) continue;
    for (let k = 0; k < joint.dofCount && k < rates.length; k += 1) {
      system.qd[joint.dofOffset + k] = rates[k] ?? 0;
    }
  }
  system.warmVelocities = [...system.qd];

  // --- The initial loop closure: project once; decline if it cannot hold.
  system.warmMultipliers = new Array<number>(countLoopRows(system)).fill(0);
  if (loops.length > 0) {
    const initialRows = allLoopRows(system, system.q);
    if (worstResidual(initialRows) > LOOP_CLOSURE_TOLERANCE) {
      const projected = projectLoops(loopProjectionView(system), system.q);
      if (projected.residual > LOOP_CLOSURE_TOLERANCE) {
        return simFail(
          simError(
            SIM_ERROR_CODES.loopUnresolved,
            `The mechanism's closed loop does not close at the initial placement (worst residual ${projected.residual.toExponential(3)} m|rad after ${String(projected.iterations)} projection iterations); solve the mates first.`,
            { residual: projected.residual },
          ),
        );
      }
      system.q = [...projected.q];
    }
  }

  // --- The degeneracy check: every rotational DOF must carry inertia ---
  // at the initial configuration. A point mass on its own rotation axis
  // (a tensor-less free root, a point mass centred on a hinge) leaves
  // the mass-matrix diagonal zero — the honest decline named in the
  // door's point-mass stance, never a hidden regularizer.
  const initialFk = forwardPass(system, system.q, system.qd);
  const initialMass = assembleMass(system, initialFk);
  for (const joint of treeJoints) {
    for (let k = 0; k < joint.layout.rotational.length; k += 1) {
      const column = joint.dofOffset + k;
      const diagonal = initialMass[column]?.[column] ?? 0;
      if (!(diagonal > 1e-12)) {
        return refuse(
          `Joint "${joint.id}" rotates a mass distribution with zero inertia about its axis at the initial configuration — the door's point-mass stance: author an inertia tensor for the rotating body.`,
          { jointId: joint.id, dof: k },
        );
      }
    }
  }

  return simOk({
    bodyCount: mechanism.bodies.length,
    dofCount,
    loopJointCount: loops.length,
    step: (control) => stepReferenceSystem(system, control),
  });
}

// ---------------------------------------------------------------------------
// Forward kinematics (poses, velocities, bias accelerations, Jacobians)
// ---------------------------------------------------------------------------

/** Positions only (the loop rows' evaluation). */
function posesAt(system: ReferenceSystem, q: readonly number[]): PoseView[] {
  const zeroRates = new Array<number>(system.dofCount).fill(0);
  return forwardPass(system, q, zeroRates).map((state) => ({
    r: state.r,
    t: state.t,
  }));
}

function forwardPass(
  system: ReferenceSystem,
  q: readonly number[],
  qd: readonly number[],
): FkBody[] {
  const states = new Array<FkBody | undefined>(system.compiled.bodies.length);
  for (const bodyIndex of system.order) {
    const body = system.compiled.bodies[bodyIndex];
    if (body === undefined) continue;
    const jointIndex = system.bodyJoint[bodyIndex] ?? -1;
    if (jointIndex < 0) {
      // A grounded root: fixed at its placement, no DOF, no motion.
      states[bodyIndex] = {
        r: body.initialR,
        t: body.initialT,
        ang: ZERO3,
        lin: ZERO3,
        alphaBias: ZERO3,
        aBias: ZERO3,
        jAng: new Array<Vec3>(system.dofCount).fill(ZERO3),
        jLin: new Array<Vec3>(system.dofCount).fill(ZERO3),
        inertiaWorld: body.inertiaWorld,
      };
      continue;
    }
    const joint = system.treeJoints[jointIndex];
    if (joint === undefined) continue;
    const layout = joint.layout;
    const qj = q.slice(joint.dofOffset, joint.dofOffset + joint.dofCount);
    const qdj = qd.slice(joint.dofOffset, joint.dofOffset + joint.dofCount);
    const freeRotation = jointFreeRotation(layout, qj);
    const freeTranslation = jointFreeTranslation(layout, qj);
    const parent = joint.parentBody >= 0 ? states[joint.parentBody] : undefined;
    const anchorR: Mat3 = parent === undefined ? IDENTITY : parent.r;
    const anchorT: Vec3 = parent === undefined ? ZERO3 : parent.t;
    const relativeR = mulMat3(freeRotation, joint.bRotation);
    // p_rel = o + r_free + R_free·b — the mates' conjugation T(o)∘Free∘B.
    const relativeT = add3(
      joint.origin,
      add3(freeTranslation, mulMat3Vec(freeRotation, joint.bTranslation)),
    );
    const r = mulMat3(anchorR, relativeR);
    const t = add3(anchorT, mulMat3Vec(anchorR, relativeT));
    const pbWorld = mulMat3Vec(
      anchorR,
      mulMat3Vec(freeRotation, joint.bTranslation),
    );
    const omegaRel = mulMat3Vec(
      anchorR,
      jointRelativeAngularVelocity(layout, qdj),
    );
    const transRateLocal: [number, number, number] = [0, 0, 0];
    for (let k = 0; k < layout.translational.length; k += 1) {
      const dir = layout.translational[k];
      const rate = qdj[layout.rotational.length + k] ?? 0;
      transRateLocal[0] += (dir?.[0] ?? 0) * rate;
      transRateLocal[1] += (dir?.[1] ?? 0) * rate;
      transRateLocal[2] += (dir?.[2] ?? 0) * rate;
    }
    const vrelLin = add3(
      mulMat3Vec(anchorR, transRateLocal),
      cross3(omegaRel, pbWorld),
    );
    const parentAng = parent === undefined ? ZERO3 : parent.ang;
    const parentLin = parent === undefined ? ZERO3 : parent.lin;
    const ang = add3(parentAng, omegaRel);
    const offset = sub3(t, anchorT);
    const lin = add3(parentLin, add3(cross3(parentAng, offset), vrelLin));
    // The Jacobian: the parent's columns shifted to this origin, then
    // the joint's own columns (rotational at the anchor point, shifted
    // here; translational direction as-is).
    const jAng: Vec3[] = [];
    const jLin: Vec3[] = [];
    for (let k = 0; k < system.dofCount; k += 1) {
      const parentColAng = parent?.jAng[k];
      const parentColLin = parent?.jLin[k];
      if (parentColAng === undefined || parentColLin === undefined) {
        jAng.push(ZERO3);
        jLin.push(ZERO3);
        continue;
      }
      jAng.push(parentColAng);
      jLin.push(add3(parentColLin, cross3(parentColAng, offset)));
    }
    for (let k = 0; k < layout.rotational.length; k += 1) {
      const axisWorld = mulMat3Vec(anchorR, layout.rotational[k] ?? ZERO3);
      const column = joint.dofOffset + k;
      jAng[column] = axisWorld;
      // The rotation's velocity contribution to the child's origin is
      // Ω×pb — the offset carried THROUGH the free rotation (the
      // translation DOFs carry their own R_A·dir columns; using the
      // anchor-to-origin offset instead would double-count them on
      // cylindrical, planar, and free joints).
      jLin[column] = cross3(axisWorld, pbWorld);
    }
    for (let k = 0; k < layout.translational.length; k += 1) {
      const dirWorld = mulMat3Vec(anchorR, layout.translational[k] ?? ZERO3);
      const column = joint.dofOffset + layout.rotational.length + k;
      jAng[column] = ZERO3;
      jLin[column] = dirWorld;
    }
    // Bias accelerations (q̈ = 0): the exact velocity-product recursion.
    const parentAlpha = parent === undefined ? ZERO3 : parent.alphaBias;
    const parentABias = parent === undefined ? ZERO3 : parent.aBias;
    const alphaBias = add3(parentAlpha, cross3(parentAng, omegaRel));
    const aBias = add3(
      parentABias,
      add3(
        cross3(parentAlpha, offset),
        add3(
          cross3(parentAng, sub3(lin, parentLin)),
          add3(
            cross3(parentAng, vrelLin),
            cross3(omegaRel, cross3(omegaRel, pbWorld)),
          ),
        ),
      ),
    );
    states[bodyIndex] = {
      r,
      t,
      ang,
      lin,
      alphaBias,
      aBias,
      jAng,
      jLin,
      inertiaWorld: rotateSpatialInertia(body.inertiaLocal, r),
    };
  }
  return states.map((state) => {
    if (state === undefined) {
      throw new Error("Unreachable: the topological order visits every body.");
    }
    return state;
  });
}

// ---------------------------------------------------------------------------
// The step
// ---------------------------------------------------------------------------

function stepReferenceSystem(
  system: ReferenceSystem,
  control: DynamicsControl,
): SimParseResult<DynamicsStepResult, SimError> {
  if (
    typeof control.timeStepS !== "number" ||
    !Number.isFinite(control.timeStepS) ||
    control.timeStepS <= 0
  ) {
    return refuse(
      "A step's time step must be a positive finite number of seconds.",
      control.timeStepS,
    );
  }
  const dt = control.timeStepS;
  const bodies = system.compiled.bodies;

  // ---- The forward pass and the mass matrix ------------------------------
  const fk = forwardPass(system, system.q, system.qd);
  const mass = assembleMass(system, fk);

  // ---- External loads: world wrenches at each body's origin --------------
  const appliedWrench: SpatialForce[] = bodies.map(() => ({
    mom: ZERO3,
    frc: ZERO3,
  }));
  for (const load of control.loads ?? []) {
    const index = bodies.findIndex((body) => body.id === load.occurrenceId);
    if (index < 0) {
      return refuse(
        `A step's load addresses occurrence "${String(load.occurrenceId)}", which is not part of the mechanism.`,
        load,
      );
    }
    const force = load.forceN;
    if (
      !Array.isArray(force) ||
      force.length !== 3 ||
      !force.every(
        (value) => typeof value === "number" && Number.isFinite(value),
      )
    ) {
      return refuse(
        "A load's force must be three finite world components.",
        force,
      );
    }
    const state = fk[index];
    if (state === undefined) {
      throw new Error("Unreachable: the load's body resolved above.");
    }
    const point = load.atWorldPointM;
    const pointWorld: Vec3 =
      Array.isArray(point) && point.length === 3
        ? [point[0] ?? 0, point[1] ?? 0, point[2] ?? 0]
        : worldCog(state);
    const wrench = shiftForceTo(
      { mom: ZERO3, frc: [force[0] ?? 0, force[1] ?? 0, force[2] ?? 0] },
      pointWorld,
      state.t,
    );
    const current = appliedWrench[index];
    if (current !== undefined) {
      appliedWrench[index] = {
        mom: add3(current.mom, wrench.mom),
        frc: add3(current.frc, wrench.frc),
      };
    }
  }

  // ---- Joint efforts ------------------------------------------------------
  const effort = new Array<number>(system.dofCount).fill(0);
  for (const entry of control.jointEfforts ?? []) {
    const joint = system.treeJoints.find(
      (candidate) => candidate.id === entry.jointId,
    );
    if (
      joint === undefined ||
      typeof entry.effort !== "number" ||
      !Number.isFinite(entry.effort)
    ) {
      return refuse(
        "A step's effort must be a finite number on a tree joint of the mechanism.",
        entry,
      );
    }
    const flavor =
      joint.layout.kind === "revolute" || joint.layout.kind === "cylindrical"
        ? "rotational"
        : joint.layout.kind === "slider"
          ? "translational"
          : undefined;
    if (flavor === undefined) {
      return refuse(
        `An effort rides a revolute, cylindrical, or slider joint; joint "${joint.id}" is ${joint.layout.kind}.`,
        joint.id,
      );
    }
    const column =
      flavor === "rotational"
        ? joint.dofOffset
        : joint.dofOffset + joint.layout.rotational.length;
    effort[column] = (effort[column] ?? 0) + entry.effort;
  }

  // ---- Generalized forces: −bias + gravity + loads + efforts + motors ----
  const applied = new Array<number>(system.dofCount).fill(0);
  for (const [index, state] of fk.entries()) {
    const netForce = dAlembertWrench(
      state.inertiaWorld,
      state.alphaBias,
      state.aBias,
      state.ang,
    );
    const gravityForce = gravityWrench(state.inertiaWorld, system.gravity);
    const load = appliedWrench[index] ?? { mom: ZERO3, frc: ZERO3 };
    for (let k = 0; k < system.dofCount; k += 1) {
      const columnAng = state.jAng[k];
      const columnLin = state.jLin[k];
      if (columnAng === undefined || columnLin === undefined) continue;
      let sum = applied[k] ?? 0;
      sum -= dot3(columnAng, netForce.mom) + dot3(columnLin, netForce.frc);
      sum +=
        dot3(columnAng, gravityForce.mom) + dot3(columnLin, gravityForce.frc);
      sum += dot3(columnAng, load.mom) + dot3(columnLin, load.frc);
      applied[k] = sum;
    }
  }
  for (let k = 0; k < system.dofCount; k += 1) {
    applied[k] = (applied[k] ?? 0) + (effort[k] ?? 0);
  }
  const motorTorqueByColumn = new Map<
    number,
    { joint: TreeJoint; torque: number }
  >();
  for (const joint of system.treeJoints) {
    if (joint.driveDof === undefined || joint.wireIndex < 0) continue;
    const motor = system.compiled.motors.find(
      (entry) => entry.jointId === joint.id,
    );
    if (motor === undefined) continue;
    const column = joint.dofOffset + joint.driveDof;
    const torque = motorTorqueNPerM(motor.motor, system.qd[column] ?? 0);
    applied[column] = (applied[column] ?? 0) + torque;
    motorTorqueByColumn.set(column, { joint, torque });
  }

  // ---- Loop equality rows: FD Jacobian and the Baumgarte targets ---------
  // Structurally-redundant rows (zero velocity gradient — e.g. the
  // out-of-plane rows of a planar loop) are DROPPED from the equality
  // set so the KKT stays full-rank; they stay in the position
  // projection's least-squares objective, which their (regularized)
  // damped normal equations handle by design. Threshold pinned.
  const ZERO_GRADIENT_ROW_TOLERANCE = 1e-9;
  const constraintRows: number[][] = [];
  const constraintTargets: number[] = [];
  const loopDuals: LoopRowDual[][] = [];
  const droppedRowOfJoint = new Map<number, Set<number>>();
  if (system.loops.length > 0) {
    const rowsNow = allLoopRows(system, system.q);
    const jacobian = loopJacobian(system, system.q);
    const poses = posesAt(system, system.q);
    let rowOffset = 0;
    system.loops.forEach((loop, loopIndex) => {
      const base = poses[loop.constraint.baseBodyIndex];
      const moved = poses[loop.constraint.movedBodyIndex];
      const full =
        base !== undefined && moved !== undefined
          ? loopRowsAndDuals(loop.constraint, base, moved)
          : { rows: [], duals: [] };
      loopDuals.push([...full.duals]);
      const dropped = new Set<number>();
      for (let r = 0; r < full.duals.length; r += 1) {
        const globalRow = rowOffset + r;
        const gradient = jacobian[globalRow] ?? [];
        const norm = gradient.reduce((sum, value) => sum + value * value, 0);
        if (norm < ZERO_GRADIENT_ROW_TOLERANCE) {
          dropped.add(r);
          continue;
        }
        constraintRows.push(gradient);
        constraintTargets.push(
          (-LOOP_BAUMGARTE_BETA / dt) * (rowsNow[globalRow] ?? 0),
        );
      }
      if (dropped.size > 0) droppedRowOfJoint.set(loopIndex, dropped);
      rowOffset += full.duals.length;
    });
  }

  // ---- The velocity solve: implicit viscous diagonal + friction cone -----
  const viscousDiag = new Array<number>(system.dofCount).fill(0);
  for (const joint of system.treeJoints) {
    for (let k = 0; k < joint.dofCount; k += 1) {
      viscousDiag[joint.dofOffset + k] = joint.viscous;
    }
  }
  const dampedMass = mass.map((row, i) =>
    row.map((value, j) => value + (i === j ? dt * (viscousDiag[i] ?? 0) : 0)),
  );
  const limits = new Array<number>(system.dofCount).fill(0);
  for (const joint of system.treeJoints) {
    for (let k = 0; k < joint.dofCount; k += 1) {
      limits[joint.dofOffset + k] = joint.frictionLoss;
    }
  }
  const rhs = new Array<number>(system.dofCount).fill(0);
  for (let i = 0; i < system.dofCount; i += 1) {
    let mOmega = 0;
    for (let j = 0; j < system.dofCount; j += 1) {
      mOmega += (mass[i]?.[j] ?? 0) * (system.qd[j] ?? 0);
    }
    rhs[i] = mOmega + dt * (applied[i] ?? 0);
  }
  // The equality set's size is state-deterministic; re-size the warm
  // start when the filtered row count changed (a fresh zero start).
  if (system.warmMultipliers.length !== constraintRows.length) {
    system.warmMultipliers = new Array<number>(constraintRows.length).fill(0);
  }
  const solution = solveVelocityCone({
    mass: dampedMass,
    rhs,
    dt,
    limits,
    constraintRows,
    constraintTargets,
    warmVelocities: system.warmVelocities,
    warmForces: system.warmForces,
    warmMultipliers: system.warmMultipliers,
  });
  if (solution === undefined) {
    return simFail(
      simError(
        SIM_ERROR_CODES.mechanismInvalid,
        "The step's mass matrix is singular at this configuration — the mechanism's mass distribution is degenerate (a point-mass body on its own rotation axis?); author an inertia tensor.",
        { dofCount: system.dofCount },
      ),
    );
  }
  const nextRates = [...solution.velocities];
  const accelerations = nextRates.map(
    (rate, k) => (rate - (system.qd[k] ?? 0)) / dt,
  );
  system.warmVelocities = [...nextRates];
  system.warmForces = [...solution.coulombForces];
  system.warmMultipliers = [...solution.multipliers];

  // ---- Integrate positions (Lie–Euler; wrap the rotation vectors) --------
  const nextQ = system.q.map((value, k) => value + (nextRates[k] ?? 0) * dt);
  for (const joint of system.treeJoints) {
    if (joint.layout.rotational.length !== 3) continue;
    const base = joint.dofOffset;
    const wrapped = wrapRotationVector([
      nextQ[base] ?? 0,
      nextQ[base + 1] ?? 0,
      nextQ[base + 2] ?? 0,
    ]);
    nextQ[base] = wrapped[0];
    nextQ[base + 1] = wrapped[1];
    nextQ[base + 2] = wrapped[2];
  }

  // ---- Loop position closure + velocity projection ------------------------
  let loopResidual = 0;
  if (system.loops.length > 0) {
    const rowsAfter = allLoopRows(system, nextQ);
    if (worstResidual(rowsAfter) > LOOP_CLOSURE_TOLERANCE) {
      const projected = projectLoops(loopProjectionView(system), nextQ);
      if (projected.residual > LOOP_CLOSURE_TOLERANCE) {
        return simFail(
          simError(
            SIM_ERROR_CODES.loopUnresolved,
            `The closed loop did not close this step (worst residual ${projected.residual.toExponential(3)} m|rad after ${String(projected.iterations)} projection iterations).`,
            { residual: projected.residual },
          ),
        );
      }
      for (let k = 0; k < nextQ.length; k += 1) {
        nextQ[k] = projected.q[k] ?? nextQ[k] ?? 0;
      }
      const corrected = projectLoopVelocities(constraintRows, nextRates);
      for (let k = 0; k < nextRates.length; k += 1) {
        nextRates[k] = corrected[k] ?? nextRates[k] ?? 0;
      }
    }
    loopResidual = worstResidual(allLoopRows(system, nextQ));
  }
  system.q = nextQ;
  system.qd = nextRates;
  system.timeS += dt;

  // ---- Post-state FK (results, energies, momenta) -------------------------
  const post = forwardPass(system, system.q, system.qd);

  // ---- Accumulators: dissipation, motor work, external work --------------
  for (const joint of system.treeJoints) {
    if (joint.wireIndex < 0) continue;
    let power = 0;
    for (let k = 0; k < joint.dofCount; k += 1) {
      const column = joint.dofOffset + k;
      const rate = nextRates[column] ?? 0;
      const coulomb = solution.coulombForces[column] ?? 0;
      power += dissipatedPowerW(joint.viscous, rate, coulomb);
    }
    system.dissipatedJ[joint.wireIndex] =
      (system.dissipatedJ[joint.wireIndex] ?? 0) + power * dt;
  }
  for (const [column, entry] of motorTorqueByColumn) {
    if (entry.joint.wireIndex < 0) continue;
    const mechanical = entry.torque * (nextRates[column] ?? 0);
    system.motorWorkJ[entry.joint.wireIndex] =
      (system.motorWorkJ[entry.joint.wireIndex] ?? 0) + mechanical * dt;
    const motor = system.compiled.motors.find(
      (candidate) => candidate.jointId === entry.joint.id,
    );
    if (motor === undefined) continue;
    const electrical = motorElectricalPowerW(motor.motor, entry.torque);
    if (electrical !== undefined) {
      system.electricalWorkJ[entry.joint.wireIndex] =
        (system.electricalWorkJ[entry.joint.wireIndex] ?? 0) + electrical * dt;
    }
  }
  for (const load of control.loads ?? []) {
    const index = bodies.findIndex((body) => body.id === load.occurrenceId);
    const state = post[index];
    if (state === undefined || !Array.isArray(load.forceN)) continue;
    const point = load.atWorldPointM;
    const pointWorld: Vec3 =
      Array.isArray(point) && point.length === 3
        ? [point[0] ?? 0, point[1] ?? 0, point[2] ?? 0]
        : worldCog(state);
    const pointVelocity = shiftMotionTo(
      { ang: state.ang, lin: state.lin },
      state.t,
      pointWorld,
    );
    system.externalWorkJ +=
      dot3(
        [load.forceN[0] ?? 0, load.forceN[1] ?? 0, load.forceN[2] ?? 0],
        pointVelocity.lin,
      ) * dt;
  }

  // ---- Reactions: subtree force accumulation with the solved acceleration
  const netForces: SpatialForce[] = fk.map((state, index) => {
    const accAng: [number, number, number] = [
      state.alphaBias[0],
      state.alphaBias[1],
      state.alphaBias[2],
    ];
    const accLin: [number, number, number] = [
      state.aBias[0],
      state.aBias[1],
      state.aBias[2],
    ];
    for (let k = 0; k < system.dofCount; k += 1) {
      const a = accelerations[k] ?? 0;
      const colAng = state.jAng[k];
      const colLin = state.jLin[k];
      if (colAng === undefined || colLin === undefined) continue;
      accAng[0] += colAng[0] * a;
      accAng[1] += colAng[1] * a;
      accAng[2] += colAng[2] * a;
      accLin[0] += colLin[0] * a;
      accLin[1] += colLin[1] * a;
      accLin[2] += colLin[2] * a;
    }
    const inertialWrench = dAlembertWrench(
      state.inertiaWorld,
      accAng,
      accLin,
      state.ang,
    );
    const appliedHere = appliedWrench[index] ?? { mom: ZERO3, frc: ZERO3 };
    const gravityForce = gravityWrench(state.inertiaWorld, system.gravity);
    return subForce(inertialWrench, addForce(gravityForce, appliedHere));
  });
  const subtreeAt = new Array<SpatialForce | undefined>(bodies.length);
  for (let position = system.order.length - 1; position >= 0; position -= 1) {
    const here = system.order[position];
    const hereState = here === undefined ? undefined : fk[here];
    if (here === undefined || hereState === undefined) continue;
    let total = netForces[here] ?? { mom: ZERO3, frc: ZERO3 };
    for (const [childIndex, jointIndex] of system.bodyJoint.entries()) {
      if (jointIndex < 0) continue;
      const joint = system.treeJoints[jointIndex];
      if (joint === undefined || joint.parentBody !== here) continue;
      const childSub = subtreeAt[childIndex];
      const childState = fk[childIndex];
      if (childSub === undefined || childState === undefined) continue;
      total = addForce(
        total,
        shiftForceTo(childSub, childState.t, hereState.t),
      );
    }
    subtreeAt[here] = total;
  }

  // ---- Result assembly -----------------------------------------------------
  const occurrences: DynamicsOccurrenceState[] = post.map((state, index) => {
    const cog = worldCog(state);
    return {
      id: bodies[index]?.id ?? String(index),
      rotation: [...state.r],
      translationMm: [state.t[0] * 1000, state.t[1] * 1000, state.t[2] * 1000],
      centerOfGravityMm: [cog[0] * 1000, cog[1] * 1000, cog[2] * 1000],
      angularVelocityRadPerS: [...state.ang],
      linearVelocityMPerS: [...state.lin],
    };
  });

  const joints: DynamicsJointState[] = [];
  for (const joint of system.treeJoints) {
    const flavors = jointDofFlavors(joint.layout);
    const cumulative =
      joint.wireIndex >= 0 ? system.dissipatedJ[joint.wireIndex] : 0;
    const dofs: DynamicsJointDofState[] = [];
    for (let k = 0; k < joint.dofCount; k += 1) {
      const column = joint.dofOffset + k;
      const rate = system.qd[column] ?? 0;
      const coulomb = solution.coulombForces[column] ?? 0;
      const power = dissipatedPowerW(joint.viscous, rate, coulomb);
      dofs.push({
        flavor: flavors[k] ?? "rotational",
        position: system.q[column] ?? 0,
        rate,
        acceleration: accelerations[column] ?? 0,
        coulombForce: coulomb,
        viscousForce: -joint.viscous * rate,
        dissipatedPowerW: power,
        dissipatedWorkJ: joint.wireIndex >= 0 ? (cumulative ?? 0) : 0,
      });
    }
    let reaction: DynamicsJointState["reaction"];
    const childState = fk[joint.childBody];
    const subtree = subtreeAt[joint.childBody];
    if (childState !== undefined && subtree !== undefined) {
      const anchorT =
        joint.parentBody >= 0 ? (fk[joint.parentBody]?.t ?? ZERO3) : ZERO3;
      const anchorR =
        joint.parentBody >= 0
          ? (fk[joint.parentBody]?.r ?? IDENTITY)
          : IDENTITY;
      const jointOriginWorld = add3(anchorT, mulMat3Vec(anchorR, joint.origin));
      const wrench = shiftForceTo(subtree, childState.t, jointOriginWorld);
      reaction = {
        forceN: [...wrench.frc],
        torqueNPerM: [...wrench.mom],
      };
    }
    let motorState: DynamicsJointState["motor"];
    if (joint.driveDof !== undefined && joint.wireIndex >= 0) {
      const column = joint.dofOffset + joint.driveDof;
      const entry = motorTorqueByColumn.get(column);
      const motor = system.compiled.motors.find(
        (candidate) => candidate.jointId === joint.id,
      );
      if (entry !== undefined && motor !== undefined) {
        const rate = system.qd[column] ?? 0;
        const mechanical = entry.torque * rate;
        const electrical = motorElectricalPowerW(motor.motor, entry.torque);
        motorState = {
          jointId: joint.id,
          speedRadPerS: rate,
          torqueNPerM: entry.torque,
          mechanicalPowerW: mechanical,
          mechanicalWorkJ: system.motorWorkJ[joint.wireIndex] ?? 0,
          ...(electrical === undefined
            ? {}
            : {
                electricalPowerW: electrical,
                electricalWorkJ: system.electricalWorkJ[joint.wireIndex] ?? 0,
              }),
        };
      }
    }
    joints.push({
      id: joint.id,
      kind: joint.layout.kind,
      tree: true,
      dofs,
      ...(reaction === undefined ? {} : { reaction }),
      ...(motorState === undefined ? {} : { motor: motorState }),
    });
  }
  let multiplierOffset = 0;
  system.loops.forEach((loop, loopIndex) => {
    const duals = loopDuals[loopIndex] ?? [];
    const dropped = droppedRowOfJoint.get(loopIndex) ?? new Set<number>();
    // The kept rows' multipliers in this joint's row order (dropped rows
    // carry no multiplier — they entered no equality).
    const own: number[] = [];
    for (let r = 0; r < duals.length; r += 1) {
      if (dropped.has(r)) {
        own.push(0);
        continue;
      }
      own.push(solution.multipliers[multiplierOffset] ?? 0);
      multiplierOffset += 1;
    }
    const wrench = loopReactionWrench(duals, own);
    joints.push({
      id: loop.constraint.id,
      kind: loop.constraint.kind,
      tree: false,
      dofs: [],
      reaction: {
        forceN: [...wrench.forceN],
        torqueNPerM: [...wrench.torqueNPerM],
      },
      loopResidual,
    });
  });

  let kineticJ = 0;
  let potentialJ = 0;
  for (const state of post) {
    const momentum = mulSpatialInertia(state.inertiaWorld, {
      ang: state.ang,
      lin: state.lin,
    });
    kineticJ +=
      0.5 * (dot3(state.ang, momentum.mom) + dot3(state.lin, momentum.frc));
    // PE = −m·g·c_world with c_world = t + h/m — the full world first
    // moment (the origin's mass term cannot be dropped).
    potentialJ -= dot3(
      system.gravity,
      add3(scale3(state.t, state.inertiaWorld.m), state.inertiaWorld.h),
    );
  }
  const dissipatedTotal = system.dissipatedJ.reduce(
    (sum, value) => sum + value,
    0,
  );
  const motorWorkTotal = system.motorWorkJ.reduce(
    (sum, value) => sum + value,
    0,
  );
  const energy: DynamicsEnergyState = {
    kineticJ,
    gravitationalPotentialJ: potentialJ,
    dissipatedJ: dissipatedTotal,
    motorWorkJ: motorWorkTotal,
    externalWorkJ: system.externalWorkJ,
    auditJ:
      kineticJ +
      potentialJ -
      motorWorkTotal -
      system.externalWorkJ +
      dissipatedTotal,
  };

  let linearX = 0;
  let linearY = 0;
  let linearZ = 0;
  let angularX = 0;
  let angularY = 0;
  let angularZ = 0;
  for (const state of post) {
    const bodyMomentum = mulSpatialInertia(state.inertiaWorld, {
      ang: state.ang,
      lin: state.lin,
    });
    linearX += bodyMomentum.frc[0];
    linearY += bodyMomentum.frc[1];
    linearZ += bodyMomentum.frc[2];
    const aboutOrigin = shiftForceTo(bodyMomentum, state.t, ZERO3);
    angularX += aboutOrigin.mom[0];
    angularY += aboutOrigin.mom[1];
    angularZ += aboutOrigin.mom[2];
  }
  const momentum: DynamicsMomentumState = {
    linearKgMPerS: [linearX, linearY, linearZ],
    angularKgM2PerS: [angularX, angularY, angularZ],
  };

  return simOk({
    timeS: system.timeS,
    occurrences,
    joints,
    energy,
    momentum,
    solver: {
      coneIterations: solution.iterations,
      loopResidual,
    },
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** M = Σ_b Jᵀ I J, plus rotor inertias on their drive diagonals. */
function assembleMass(
  system: ReferenceSystem,
  fk: readonly FkBody[],
): number[][] {
  const n = system.dofCount;
  const mass: number[][] = [];
  for (let i = 0; i < n; i += 1) {
    mass.push(new Array<number>(n).fill(0));
  }
  for (const state of fk) {
    const responses: SpatialForce[] = [];
    for (let k = 0; k < n; k += 1) {
      responses.push(
        mulSpatialInertia(state.inertiaWorld, {
          ang: state.jAng[k] ?? ZERO3,
          lin: state.jLin[k] ?? ZERO3,
        }),
      );
    }
    for (let i = 0; i < n; i += 1) {
      const angI = state.jAng[i] ?? ZERO3;
      const linI = state.jLin[i] ?? ZERO3;
      const massRow = mass[i];
      if (massRow === undefined) continue;
      for (let j = 0; j < n; j += 1) {
        const response = responses[j];
        if (response === undefined) continue;
        massRow[j] =
          (massRow[j] ?? 0) +
          dot3(angI, response.mom) +
          dot3(linI, response.frc);
      }
    }
  }
  for (const joint of system.treeJoints) {
    if (joint.rotorInertia === 0 || joint.driveDof === undefined) continue;
    const column = joint.dofOffset + joint.driveDof;
    const row = mass[column];
    if (row !== undefined) {
      row[column] = (row[column] ?? 0) + joint.rotorInertia;
    }
  }
  return mass;
}

/** The gravity wrench of a body at its origin: `[h × g; m·g]`. */
function gravityWrench(I: SpatialInertia, g: Vec3): SpatialForce {
  return { mom: cross3(I.h, g), frc: scale3(g, I.m) };
}

/**
 * The d'Alembert inertial wrench of one body about its own MOVING
 * (body-fixed) origin in the world-aligned gauge — the exact time
 * derivative of the body's spatial momentum `I·v` evaluated at the
 * CLASSICAL acceleration pair (α, a_O) of the origin:
 *
 *   `[I₀·α + h × a_O + ω × (I₀·ω);  m·a_O + α × h + ω × (ω × h)]`.
 *
 * Plugging the classical pair straight into the moving-frame product
 * `I·a + v ×* (I·v)` carries the spurious pair `[ω×(h×v_O); m·ω×v_O]`
 * whenever ω×v_O ≠ 0 (a spatial acceleration's linear part is
 * `a_O − ω×v_O`, not `a_O`) — an O(1) model error that surfaces as
 * dt-independent momentum drift. The form above is its exact
 * cancellation, equal to `I·a_spatial + v ×* (I·v) + [v_O×p; 0]` with
 * `a_spatial.lin = a_O − ω×v_O` and `p` the linear momentum; both the
 * generalized-force and the reaction passes consume it.
 */
function dAlembertWrench(
  inertia: SpatialInertia,
  alpha: Vec3,
  aOrigin: Vec3,
  omega: Vec3,
): SpatialForce {
  return {
    mom: add3(
      add3(mulMat3Vec(inertia.i0, alpha), cross3(inertia.h, aOrigin)),
      cross3(omega, mulMat3Vec(inertia.i0, omega)),
    ),
    frc: add3(
      add3(scale3(aOrigin, inertia.m), cross3(alpha, inertia.h)),
      cross3(omega, cross3(omega, inertia.h)),
    ),
  };
}

function addForce(a: SpatialForce, b: SpatialForce): SpatialForce {
  return { mom: add3(a.mom, b.mom), frc: add3(a.frc, b.frc) };
}

function subForce(a: SpatialForce, b: SpatialForce): SpatialForce {
  return { mom: sub3(a.mom, b.mom), frc: sub3(a.frc, b.frc) };
}

/** The body's world COG: `t + h/m` (h already world-aligned). */
function worldCog(state: FkBody): Vec3 {
  return add3(state.t, scale3(state.inertiaWorld.h, 1 / state.inertiaWorld.m));
}

/** All loop joints' residual rows, concatenated in wire order. */
function allLoopRows(system: ReferenceSystem, q: readonly number[]): number[] {
  const poses = posesAt(system, q);
  const rows: number[] = [];
  for (const loop of system.loops) {
    const base = poses[loop.constraint.baseBodyIndex];
    const moved = poses[loop.constraint.movedBodyIndex];
    if (base === undefined || moved === undefined) continue;
    rows.push(...loopRowsAndDuals(loop.constraint, base, moved).rows);
  }
  return rows;
}

function countLoopRows(system: ReferenceSystem): number {
  return allLoopRows(system, system.q).length;
}

function loopProjectionView(system: ReferenceSystem): {
  rowsAt: (q: readonly number[]) => readonly number[];
  applyDelta: (
    q: readonly number[],
    delta: readonly number[],
  ) => readonly number[];
} {
  return {
    rowsAt: (q) => allLoopRows(system, q),
    applyDelta: (q, delta) =>
      q.map((value, index) => value + (delta[index] ?? 0)),
  };
}

/** The loop rows' FD Jacobian (∂rows/∂q, rows × ndof) over the tangent update. */
function loopJacobian(
  system: ReferenceSystem,
  q: readonly number[],
): number[][] {
  const base = allLoopRows(system, q);
  const jacobian: number[][] = Array.from({ length: base.length }, () =>
    new Array<number>(system.dofCount).fill(0),
  );
  for (let k = 0; k < system.dofCount; k += 1) {
    const perturbed = [...q];
    perturbed[k] = (perturbed[k] ?? 0) + LOOP_FD_STEP;
    const rows = allLoopRows(system, perturbed);
    for (let m = 0; m < base.length; m += 1) {
      const row = jacobian[m];
      if (row !== undefined) {
        row[k] = ((rows[m] ?? 0) - (base[m] ?? 0)) / LOOP_FD_STEP;
      }
    }
  }
  return jacobian;
}
