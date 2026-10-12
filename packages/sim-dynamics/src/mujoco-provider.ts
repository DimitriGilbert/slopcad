/**
 * The MuJoCo provider behind the 67a `DynamicsEngine` contract (Phase
 * 67b, §7.2's ruling: the best engine — performance and solver quality
 * — as the OPT-IN provider, the TS reference kernel staying the default
 * oracle). The provider compiles the SAME document wire forms through
 * the SAME door (`compileMechanism` — one validation site), renders the
 * deterministic MJCF (`./mujoco-model`), steps MuJoCo's official wasm
 * build, and projects the result back through the contract — results as
 * data, no second read-back channel.
 *
 * ## The state round-trip (pinned by the suite)
 *
 * The provider keeps OUR canonical state — `q`/`qd` in each joint's
 * pinned DOF order — as a mirror beside MuJoCo's own: the build WRITES
 * the initial mirror into `qpos`/`qvel` (per-kind conversions in
 * {@link writeMirrorToMujoco}: axis kinds 1:1 through the element
 * permutation, ball quaternions conjugated by the zero-station
 * rotation B, free roots re-referenced from the world anchor), every
 * step evolves MuJoCo and READS the mirror back
 * ({@link readMujocoToMirror}). {@link probeMujocoState} exposes the
 * write→read pair for verification: a station written from our state
 * and read back must be the identity (pinned), and the FK at written
 * stations is pinned against the mates' chain composition per kind.
 *
 * ## Semantics bands, stated honestly (never silently)
 *
 * - **Loops**: MuJoCo closes cycles with SOFT equality constraints
 *   (`connect`/`weld` pairs) held to the solver's tolerance — not the
 *   reference's LM projection to 1e-9 m. The provider REPORTS the
 *   worst equality residual each step as the loop joints'
 *   `loopResidual` and OMITS the loop reaction wrench (the reference's
 *   multiplier view has no direct MuJoCo counterpart — re-deriving it
 *   from the sparse `efc` rows is declined as fabrication, not hidden).
 *   The cross-tolerance matrix bands the observable gap.
 * - **Dissipation**: the viscous term is exact (`−d·q̇`); the Coulomb
 *   force is read from `qfrc_constraint` at the DOF — the friction
 *   share when only friction constraints act (every friction-bearing
 *   fixture), lumping closure forces when loops and friction coexist.
 * - **Integrator**: MuJoCo's Euler (semi-implicit, implicit damping,
 *   frictionloss as a force-limited constraint) — measured to reproduce
 *   the reference kernel's spin-down arithmetic exactly at printed
 *   precision, which is what makes the near-free friction mapping
 *   tight.
 * - **Determinism**: run-to-run bitwise on one binary and platform
 *   (single-threaded wasm, no randomness); NOT portable across MuJoCo
 *   versions or FP regimes — the dependency is version-pinned and the
 *   provider is tolerance-validated against the oracle, never
 *   bit-asserted (law S5).
 */

import type { MainModule, MjData, MjModel } from "mujoco";
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
  compileMjcf,
  loadMujocoWasm,
  liveView,
  mujocoNameToId,
  mujocoObjIds,
  readNumbers,
  writeNumbers,
} from "./mujoco-bindings";
import {
  type MjcfJointChannel,
  buildMjcf,
  mat3FromQuat,
  quatFromMat3,
  rotationVectorFromMat3,
} from "./mujoco-model";
import { type CompiledMechanism, compileMechanism } from "./door";
import { jointDofFlavors } from "./joints";
import {
  LOOP_CLOSURE_TOLERANCE,
  loopRowsAndDuals,
  worstResidual,
} from "./loop-closure";
import { motorElectricalPowerW, motorTorqueNPerM } from "./motor";
import {
  addMat3,
  type Mat3,
  type Vec3,
  add3,
  cross3,
  expRotation,
  mulMat3,
  mulMat3Vec,
  scale3,
  scaleMat3,
  sub3,
  transposeMat3,
} from "./spatial";
import { type MechanismTopology, mechanismTopology } from "./topology";

/** The MuJoCo provider's stable id (the factory seam's routing key). */
export const DYNAMICS_MUJOCO_ENGINE_ID = "dynamics-mujoco-wasm";

/**
 * Creates the MuJoCo provider (async: the wasm module loads once per
 * process). A wasm environment failure declines as
 * `sim/backend-unavailable` — never a silent reference to another
 * engine.
 */
export async function createMujocoDynamicsEngine(): Promise<
  SimParseResult<DynamicsEngine, SimError>
> {
  try {
    const module = await loadMujocoWasm();
    return simOk({
      id: DYNAMICS_MUJOCO_ENGINE_ID,
      build: (input) => buildMujocoSystem(module, input),
    });
  } catch (cause) {
    return simFail(
      simError(
        SIM_ERROR_CODES.backendUnavailable,
        `The MuJoCo wasm backend is unavailable: ${cause instanceof Error ? cause.message : String(cause)}`,
        cause,
      ),
    );
  }
}

// ---------------------------------------------------------------------------
// Runtime state
// ---------------------------------------------------------------------------

/** One tree joint's resolved runtime (element addresses in MJCF order). */
interface JointRuntime {
  readonly channel: MjcfJointChannel;
  readonly qposAdr: readonly number[];
  readonly dofAdr: readonly number[];
  readonly mjBodyId: number;
  readonly mjParentBodyId: number;
  readonly dofOffset: number;
  readonly viscous: number;
  readonly driveActuator: number | undefined;
}

/** The provider's stateful step context. */
interface MujocoState {
  readonly module: MainModule;
  readonly model: MjModel;
  readonly data: MjData;
  readonly mechanism: CompiledMechanism;
  readonly topology: MechanismTopology;
  readonly runtimes: readonly JointRuntime[];
  readonly objIds: {
    readonly body: number;
    readonly joint: number;
    readonly actuator: number;
  };
  readonly bodyIds: readonly number[];
  q: number[];
  qd: number[];
  readonly dissipatedJ: number[];
  readonly motorWorkJ: number[];
  readonly electricalWorkJ: number[];
  externalWorkJ: number;
  timeS: number;
}

function refuse(message: string, at: unknown): SimParseResult<never, SimError> {
  return simFail(simError(SIM_ERROR_CODES.mechanismInvalid, message, at));
}

// ---------------------------------------------------------------------------
// The build
// ---------------------------------------------------------------------------

function prepareMujocoState(
  module: MainModule,
  input: DynamicsBuildInput,
): SimParseResult<{ state: MujocoState }, SimError> {
  const compiled = compileMechanism(input);
  if (!compiled.ok) return compiled;
  const mechanism = compiled.value;
  const topology = mechanismTopology(mechanism.bodies, mechanism.joints);

  // --- Parity refusals with the reference kernel's build -------------
  for (const wireIndex of topology.loopWire) {
    const wire = mechanism.joints[wireIndex];
    if (wire === undefined) continue;
    if (mechanism.motors.some((entry) => entry.jointId === wire.id)) {
      return refuse(
        `The motor rides joint "${wire.id}", which closes a loop; a motor drives a tree joint.`,
        wire.id,
      );
    }
    if (wire.viscousDamping > 0 || wire.frictionLoss > 0) {
      return refuse(
        `Joint "${wire.id}" closes a loop and carries friction fields; MuJoCo hangs damping and frictionloss on joint DOFs, and a closing joint contributes none — declined, never silently dropped.`,
        {
          jointId: wire.id,
          viscousDamping: wire.viscousDamping,
          frictionLoss: wire.frictionLoss,
        },
      );
    }
  }

  // --- The initial closure: this provider REQUIRES a closed initial
  // placement (the reference projects at build; MuJoCo's equalities
  // would pin the initial offset forever). Declined loudly.
  if (topology.loopWire.length > 0) {
    const rows: number[] = [];
    for (const wireIndex of topology.loopWire) {
      const wire = mechanism.joints[wireIndex];
      if (wire === undefined) continue;
      const base = mechanism.bodies.findIndex((b) => b.id === wire.baseId);
      const moved = mechanism.bodies.findIndex((b) => b.id === wire.movedId);
      const baseBody = base >= 0 ? mechanism.bodies[base] : undefined;
      const movedBody = moved >= 0 ? mechanism.bodies[moved] : undefined;
      if (baseBody === undefined || movedBody === undefined) continue;
      rows.push(
        ...loopRowsAndDuals(
          {
            id: wire.id,
            kind: wire.kind,
            baseBodyIndex: base,
            movedBodyIndex: moved,
            origin: wire.origin ?? [0, 0, 0],
            axis: wire.axis,
            layout: wire.layout,
          },
          { r: baseBody.initialR, t: baseBody.initialT },
          { r: movedBody.initialR, t: movedBody.initialT },
        ).rows,
      );
    }
    const residual = worstResidual(rows);
    if (residual > LOOP_CLOSURE_TOLERANCE) {
      return simFail(
        simError(
          SIM_ERROR_CODES.loopUnresolved,
          `The mechanism's closed loop does not close at the initial placement (worst residual ${residual.toExponential(3)} m|rad); the MuJoCo provider requires a solved initial placement (solve the mates first) — it does not project.`,
          { residual },
        ),
      );
    }
  }

  const mjcf = buildMjcf(mechanism, topology);
  const loaded = compileMjcf(module, mjcf.xml);
  if (!loaded.ok) return loaded;
  const { model, data } = loaded.value;

  // --- Address resolution (by name — id-order independent) -----------
  const objIds = mujocoObjIds(module);
  const runtimes: JointRuntime[] = [];
  let dofOffset = 0;
  for (const channel of mjcf.joints) {
    const ourBodyIndex = mechanism.bodies.findIndex((body) =>
      channel.wireIndex < 0
        ? `${body.id}::free` === channel.ourId
        : body.id === mechanism.joints[channel.wireIndex]?.movedId,
    );
    const node = topology.nodes.find((n) => n.child === ourBodyIndex);
    if (ourBodyIndex < 0 || node === undefined) {
      return refuse(
        `The joint "${channel.ourId}" lost its body in the compiled MuJoCo model — declined loudly.`,
        channel.ourId,
      );
    }
    const qposAdr: number[] = [];
    const dofAdr: number[] = [];
    for (const name of channel.elementNames) {
      const jid = mujocoNameToId(module, objIds.joint, model, name);
      if (jid < 0) {
        return refuse(
          `The compiled MuJoCo model lost joint "${name}" — declined loudly.`,
          name,
        );
      }
      qposAdr.push(readNumbers(model.jnt_qposadr, jid, 1)[0] ?? 0);
      dofAdr.push(readNumbers(model.jnt_dofadr, jid, 1)[0] ?? 0);
    }
    const wire =
      channel.wireIndex >= 0 ? mechanism.joints[channel.wireIndex] : undefined;
    const motorEntry = mechanism.motors.find(
      (entry) => entry.jointId === channel.ourId,
    );
    const actuatorId =
      motorEntry !== undefined
        ? mujocoNameToId(module, objIds.actuator, model, channel.ourId)
        : -1;
    const mjBodyId = mujocoNameToId(
      module,
      objIds.body,
      model,
      mechanism.bodies[ourBodyIndex]?.id ?? "",
    );
    runtimes.push({
      channel,
      qposAdr,
      dofAdr,
      mjBodyId,
      mjParentBodyId:
        node.parent >= 0
          ? mujocoNameToId(
              module,
              objIds.body,
              model,
              mechanism.bodies[node.parent]?.id ?? "",
            )
          : -1,
      dofOffset,
      viscous: wire?.viscousDamping ?? 0,
      driveActuator: actuatorId >= 0 ? actuatorId : undefined,
    });
    dofOffset +=
      channel.layout.rotational.length + channel.layout.translational.length;
  }
  const dofCount = dofOffset;
  const bodyIds = mechanism.bodies.map((body) =>
    mujocoNameToId(module, objIds.body, model, body.id),
  );

  // --- The mirror state ------------------------------------------------
  const state: MujocoState = {
    module,
    model,
    data,
    mechanism,
    topology,
    runtimes,
    objIds,
    bodyIds,
    q: new Array<number>(dofCount).fill(0),
    qd: new Array<number>(dofCount).fill(0),
    dissipatedJ: new Array<number>(mechanism.joints.length).fill(0),
    motorWorkJ: new Array<number>(mechanism.joints.length).fill(0),
    electricalWorkJ: new Array<number>(mechanism.joints.length).fill(0),
    externalWorkJ: 0,
    timeS: 0,
  };
  const applyRates = (jointId: string, rates: readonly number[]): void => {
    const runtime = runtimes.find((r) => r.channel.ourId === jointId);
    if (runtime === undefined) return;
    for (let k = 0; k < rates.length; k += 1) {
      state.qd[runtime.dofOffset + k] = rates[k] ?? 0;
    }
  };
  for (const wire of mechanism.joints) {
    if (wire.initialRates.length > 0) applyRates(wire.id, wire.initialRates);
  }
  for (const entry of input.initialJointRates ?? []) {
    if (entry.jointId.endsWith("::free"))
      applyRates(entry.jointId, entry.rates);
  }

  // The kinematics refresh around the initial write: `mj_step1`
  // populates xquat at qpos0 first (the ball/free rate conversions
  // read it), then the written state is refreshed for the first step.
  module.mj_step1(model, data);
  module.mj_step1(model, data);
  writeMirrorToMujoco(state);
  module.mj_step1(model, data);
  return simOk({ state });
}

function buildMujocoSystem(
  module: MainModule,
  input: DynamicsBuildInput,
): SimParseResult<DynamicsSystem, SimError> {
  const prepared = prepareMujocoState(module, input);
  if (!prepared.ok) return prepared;
  const state = prepared.value.state;
  const { mechanism, topology } = state;
  return simOk({
    bodyCount: mechanism.bodies.length,
    dofCount: state.q.length,
    loopJointCount: topology.loopWire.length,
    step: (control) => stepMujoco(state, control),
  });
}

// ---------------------------------------------------------------------------
// The state round-trip (mirror ↔ MuJoCo)
// ---------------------------------------------------------------------------

/** The body's current world rotation from MuJoCo's refreshed `xquat`. */
function currentRotation(state: MujocoState, mjBodyId: number): Mat3 {
  if (mjBodyId < 0) {
    return [1, 0, 0, 0, 1, 0, 0, 0, 1];
  }
  const q4 = readNumbers(state.data.xquat, mjBodyId * 4, 4);
  return mat3FromQuat([q4[0] ?? 1, q4[1] ?? 0, q4[2] ?? 0, q4[3] ?? 0]);
}

/** Writes the mirror state into MuJoCo `qpos`/`qvel` (the write half of the round-trip). */
export function writeMirrorToMujoco(state: MujocoState): void {
  for (const runtime of state.runtimes) {
    const channel = runtime.channel;
    const dofCount =
      channel.layout.rotational.length + channel.layout.translational.length;
    const qj = state.q.slice(runtime.dofOffset, runtime.dofOffset + dofCount);
    const qdj = state.qd.slice(runtime.dofOffset, runtime.dofOffset + dofCount);
    if (channel.layout.kind === "ball") {
      const b = channel.ballB ?? [1, 0, 0, 0, 1, 0, 0, 0, 1];
      const rFree = expRotation([qj[0] ?? 0, qj[1] ?? 0, qj[2] ?? 0]);
      const rBall = mulMat3(transposeMat3(b), mulMat3(rFree, b));
      writeNumbers(
        state.data.qpos,
        runtime.qposAdr[0] ?? 0,
        quatFromMat3(rBall),
      );
      const omega: Vec3 = [qdj[0] ?? 0, qdj[1] ?? 0, qdj[2] ?? 0];
      const rChild = currentRotation(state, runtime.mjBodyId);
      const rBase = currentRotation(state, runtime.mjParentBodyId);
      const world = mulMat3Vec(rBase, omega);
      writeNumbers(
        state.data.qvel,
        runtime.dofAdr[0] ?? 0,
        mulMat3Vec(transposeMat3(rChild), world),
      );
      continue;
    }
    if (channel.layout.kind === "free") {
      const initial = channel.freeInitial;
      if (initial === undefined) {
        throw new Error(
          "Unreachable: free channels carry their initial frame.",
        );
      }
      const rFree = expRotation([qj[0] ?? 0, qj[1] ?? 0, qj[2] ?? 0]);
      const translation: Vec3 = [qj[3] ?? 0, qj[4] ?? 0, qj[5] ?? 0];
      const pos = add3(translation, mulMat3Vec(rFree, initial.t));
      const quat = quatFromMat3(mulMat3(rFree, initial.r));
      writeNumbers(state.data.qpos, runtime.qposAdr[0] ?? 0, [...pos, ...quat]);
      const omega: Vec3 = [qdj[0] ?? 0, qdj[1] ?? 0, qdj[2] ?? 0];
      const rate: Vec3 = [qdj[3] ?? 0, qdj[4] ?? 0, qdj[5] ?? 0];
      const rChild = currentRotation(state, runtime.mjBodyId);
      const lin = add3(rate, cross3(omega, mulMat3Vec(rFree, initial.t)));
      writeNumbers(state.data.qvel, runtime.dofAdr[0] ?? 0, [
        ...lin,
        ...mulMat3Vec(transposeMat3(rChild), omega),
      ]);
      continue;
    }
    for (let k = 0; k < channel.elementOfDof.length; k += 1) {
      const element = channel.elementOfDof[k] ?? 0;
      writeNumbers(state.data.qpos, runtime.qposAdr[element] ?? 0, [
        qj[k] ?? 0,
      ]);
      writeNumbers(state.data.qvel, runtime.dofAdr[element] ?? 0, [
        qdj[k] ?? 0,
      ]);
    }
  }
}

/** Reads MuJoCo `qpos`/`qvel` back into the mirror (the read half of the round-trip). */
export function readMujocoToMirror(state: MujocoState): void {
  for (const runtime of state.runtimes) {
    const channel = runtime.channel;
    if (channel.layout.kind === "ball") {
      const b = channel.ballB ?? [1, 0, 0, 0, 1, 0, 0, 0, 1];
      const q4 = readNumbers(state.data.qpos, runtime.qposAdr[0] ?? 0, 4);
      const rBall = mat3FromQuat([
        q4[0] ?? 1,
        q4[1] ?? 0,
        q4[2] ?? 0,
        q4[3] ?? 0,
      ]);
      const rFree = mulMat3(b, mulMat3(rBall, transposeMat3(b)));
      const phi = rotationVectorFromMat3(rFree);
      const w = readNumbers(state.data.qvel, runtime.dofAdr[0] ?? 0, 3);
      const rChild = currentRotation(state, runtime.mjBodyId);
      const rBase = currentRotation(state, runtime.mjParentBodyId);
      const omega = mulMat3Vec(
        rBase,
        mulMat3Vec(rChild, [w[0] ?? 0, w[1] ?? 0, w[2] ?? 0]),
      );
      for (let k = 0; k < 3; k += 1) {
        state.q[runtime.dofOffset + k] = phi[k] ?? 0;
        state.qd[runtime.dofOffset + k] = omega[k] ?? 0;
      }
      continue;
    }
    if (channel.layout.kind === "free") {
      const initial = channel.freeInitial;
      if (initial === undefined) {
        throw new Error(
          "Unreachable: free channels carry their initial frame.",
        );
      }
      const q7 = readNumbers(state.data.qpos, runtime.qposAdr[0] ?? 0, 7);
      const rChild = mat3FromQuat([
        q7[3] ?? 1,
        q7[4] ?? 0,
        q7[5] ?? 0,
        q7[6] ?? 0,
      ]);
      const rFree = mulMat3(rChild, transposeMat3(initial.r));
      const phi = rotationVectorFromMat3(rFree);
      const v6 = readNumbers(state.data.qvel, runtime.dofAdr[0] ?? 0, 6);
      const omega = mulMat3Vec(rChild, [v6[3] ?? 0, v6[4] ?? 0, v6[5] ?? 0]);
      const lin: Vec3 = [v6[0] ?? 0, v6[1] ?? 0, v6[2] ?? 0];
      const rate = sub3(lin, cross3(omega, mulMat3Vec(rFree, initial.t)));
      // Our station: t = r + R_free·t₀ → r = t − R_free·t₀ (the origin's
      // world position from qpos, un-referenced from the world anchor).
      const station = sub3(
        [q7[0] ?? 0, q7[1] ?? 0, q7[2] ?? 0],
        mulMat3Vec(rFree, initial.t),
      );
      for (let k = 0; k < 3; k += 1) {
        state.q[runtime.dofOffset + k] = phi[k] ?? 0;
        state.qd[runtime.dofOffset + k] = omega[k] ?? 0;
        state.q[runtime.dofOffset + 3 + k] = station[k] ?? 0;
        state.qd[runtime.dofOffset + 3 + k] = rate[k] ?? 0;
      }
      continue;
    }
    for (let k = 0; k < channel.elementOfDof.length; k += 1) {
      const element = channel.elementOfDof[k] ?? 0;
      state.q[runtime.dofOffset + k] =
        readNumbers(state.data.qpos, runtime.qposAdr[element] ?? 0, 1)[0] ?? 0;
      state.qd[runtime.dofOffset + k] =
        readNumbers(state.data.qvel, runtime.dofAdr[element] ?? 0, 1)[0] ?? 0;
    }
  }
}

// ---------------------------------------------------------------------------
// The step
// ---------------------------------------------------------------------------

function stepMujoco(
  state: MujocoState,
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
  const { module, model, data, mechanism } = state;
  model.opt.timestep = dt;

  // ---- Zero last step's forces, then apply this step's ---------------
  for (const body of mechanism.bodies) {
    writeNumbers(data.body(body.id).xfrc_applied, 0, [0, 0, 0, 0, 0, 0]);
  }
  const qfrc = liveView(data.qfrc_applied);
  for (let index = 0; index < qfrc.length; index += 1) {
    qfrc[index] = 0;
  }

  const loadWrenches = new Map<number, { force: Vec3; torque: Vec3 }>();
  for (const load of control.loads ?? []) {
    const index = mechanism.bodies.findIndex((b) => b.id === load.occurrenceId);
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
    const forceV: Vec3 = [force[0] ?? 0, force[1] ?? 0, force[2] ?? 0];
    // MuJoCo applies xfrc at the body CoM: shift the point load's moment.
    const cog = readNumbers(data.xipos, (state.bodyIds[index] ?? 0) * 3, 3);
    const cogV: Vec3 = [cog[0] ?? 0, cog[1] ?? 0, cog[2] ?? 0];
    const point = load.atWorldPointM;
    const pointV: Vec3 =
      Array.isArray(point) && point.length === 3
        ? [point[0] ?? 0, point[1] ?? 0, point[2] ?? 0]
        : cogV;
    const torque = cross3(sub3(pointV, cogV), forceV);
    const current = loadWrenches.get(index);
    loadWrenches.set(index, {
      force: current ? add3(current.force, forceV) : forceV,
      torque: current ? add3(current.torque, torque) : torque,
    });
  }
  for (const [index, wrench] of loadWrenches) {
    const body = mechanism.bodies[index];
    if (body === undefined) continue;
    writeNumbers(data.body(body.id).xfrc_applied, 0, [
      ...wrench.force,
      ...wrench.torque,
    ]);
  }

  for (const entry of control.jointEfforts ?? []) {
    const runtime = state.runtimes.find(
      (candidate) => candidate.channel.ourId === entry.jointId,
    );
    if (
      runtime === undefined ||
      typeof entry.effort !== "number" ||
      !Number.isFinite(entry.effort)
    ) {
      return refuse(
        "A step's effort must be a finite number on a tree joint of the mechanism.",
        entry,
      );
    }
    const kind = runtime.channel.layout.kind;
    if (kind !== "revolute" && kind !== "cylindrical" && kind !== "slider") {
      return refuse(
        `An effort rides a revolute, cylindrical, or slider joint; joint "${runtime.channel.ourId}" is ${kind}.`,
        runtime.channel.ourId,
      );
    }
    const element = runtime.channel.elementOfDof[0] ?? 0;
    const adr = runtime.dofAdr[element] ?? 0;
    qfrc[adr] = (qfrc[adr] ?? 0) + entry.effort;
  }

  // Motors: the 61 record evaluated at the PRE-step drive rate (the
  // reference kernel's stance), delivered as MuJoCo ctrl (gear = 1).
  const motorTorques = new Map<
    string,
    { torque: number; rateColumn: number }
  >();
  const ctrl = liveView(data.ctrl);
  const preRates = [...state.qd];
  for (const runtime of state.runtimes) {
    if (runtime.driveActuator === undefined) continue;
    const motor = mechanism.motors.find(
      (entry) => entry.jointId === runtime.channel.ourId,
    );
    if (motor === undefined) continue;
    const rate = preRates[runtime.dofOffset] ?? 0;
    const torque = motorTorqueNPerM(motor.motor, rate);
    ctrl[runtime.driveActuator] = torque;
    motorTorques.set(runtime.channel.ourId, {
      torque,
      rateColumn: runtime.dofOffset,
    });
  }

  // ---- Step, refresh, read back ---------------------------------------
  module.mj_step(model, data);
  module.mj_step1(model, data);
  module.mj_energyPos(model, data);
  module.mj_energyVel(model, data);
  readMujocoToMirror(state);
  const accelerations = state.qd.map(
    (rate, k) => (rate - (preRates[k] ?? 0)) / dt,
  );
  state.timeS += dt;

  // ---- Accumulators ----------------------------------------------------
  const coulombAt = (dofAdr: number): number =>
    readNumbers(data.qfrc_constraint, dofAdr, 1)[0] ?? 0;
  for (const runtime of state.runtimes) {
    if (runtime.channel.wireIndex < 0) continue;
    let power = 0;
    for (let k = 0; k < runtime.channel.elementOfDof.length; k += 1) {
      const element = runtime.channel.elementOfDof[k] ?? 0;
      const rate = state.qd[runtime.dofOffset + k] ?? 0;
      const coulomb = coulombAt(runtime.dofAdr[element] ?? 0);
      power += runtime.viscous * rate * rate + Math.abs(coulomb * rate);
    }
    state.dissipatedJ[runtime.channel.wireIndex] =
      (state.dissipatedJ[runtime.channel.wireIndex] ?? 0) + power * dt;
  }
  for (const [jointId, entry] of motorTorques) {
    const runtime = state.runtimes.find(
      (candidate) => candidate.channel.ourId === jointId,
    );
    if (runtime === undefined || runtime.channel.wireIndex < 0) continue;
    const mechanical = entry.torque * (state.qd[entry.rateColumn] ?? 0);
    state.motorWorkJ[runtime.channel.wireIndex] =
      (state.motorWorkJ[runtime.channel.wireIndex] ?? 0) + mechanical * dt;
    const motor = mechanism.motors.find((m) => m.jointId === jointId);
    if (motor === undefined) continue;
    const electrical = motorElectricalPowerW(motor.motor, entry.torque);
    if (electrical !== undefined) {
      state.electricalWorkJ[runtime.channel.wireIndex] =
        (state.electricalWorkJ[runtime.channel.wireIndex] ?? 0) +
        electrical * dt;
    }
  }
  for (const load of control.loads ?? []) {
    const index = mechanism.bodies.findIndex((b) => b.id === load.occurrenceId);
    if (index < 0 || !Array.isArray(load.forceN)) continue;
    const cog = readNumbers(data.xipos, (state.bodyIds[index] ?? 0) * 3, 3);
    const cvel = readNumbers(data.cvel, (state.bodyIds[index] ?? 0) * 6, 6);
    const omega: Vec3 = [cvel[0] ?? 0, cvel[1] ?? 0, cvel[2] ?? 0];
    const vCom: Vec3 = [cvel[3] ?? 0, cvel[4] ?? 0, cvel[5] ?? 0];
    const cogV: Vec3 = [cog[0] ?? 0, cog[1] ?? 0, cog[2] ?? 0];
    const point = load.atWorldPointM;
    const pointV: Vec3 =
      Array.isArray(point) && point.length === 3
        ? [point[0] ?? 0, point[1] ?? 0, point[2] ?? 0]
        : cogV;
    const vPoint = add3(vCom, cross3(omega, sub3(pointV, cogV)));
    state.externalWorkJ +=
      ((load.forceN[0] ?? 0) * vPoint[0] +
        (load.forceN[1] ?? 0) * vPoint[1] +
        (load.forceN[2] ?? 0) * vPoint[2]) *
      dt;
  }

  // ---- Reactions (tree joints: cfrc_int shifted to the joint anchor) --
  module.mj_rnePostConstraint(model, data);

  // ---- Result assembly ---------------------------------------------------
  const occurrences: DynamicsOccurrenceState[] = mechanism.bodies.map(
    (body, index) => {
      const mjBody = state.bodyIds[index] ?? 0;
      const pos = readNumbers(data.xpos, mjBody * 3, 3);
      const quat = readNumbers(data.xquat, mjBody * 4, 4);
      const cog = readNumbers(data.xipos, mjBody * 3, 3);
      const cvel = readNumbers(data.cvel, mjBody * 6, 6);
      const omega: Vec3 = [cvel[0] ?? 0, cvel[1] ?? 0, cvel[2] ?? 0];
      const vCom: Vec3 = [cvel[3] ?? 0, cvel[4] ?? 0, cvel[5] ?? 0];
      const origin: Vec3 = [pos[0] ?? 0, pos[1] ?? 0, pos[2] ?? 0];
      const cogV: Vec3 = [cog[0] ?? 0, cog[1] ?? 0, cog[2] ?? 0];
      const vOrigin = add3(vCom, cross3(omega, sub3(origin, cogV)));
      return {
        id: body.id,
        rotation: mat3FromQuat([
          quat[0] ?? 1,
          quat[1] ?? 0,
          quat[2] ?? 0,
          quat[3] ?? 0,
        ]),
        translationMm: [origin[0] * 1000, origin[1] * 1000, origin[2] * 1000],
        centerOfGravityMm: [cogV[0] * 1000, cogV[1] * 1000, cogV[2] * 1000],
        angularVelocityRadPerS: omega,
        linearVelocityMPerS: vOrigin,
      };
    },
  );

  const equalityResidual = worstEqualityResidual(state);
  const joints: DynamicsJointState[] = [];
  for (const runtime of state.runtimes) {
    const channel = runtime.channel;
    const flavors = jointDofFlavors(channel.layout);
    const dofCount =
      channel.layout.rotational.length + channel.layout.translational.length;
    const dofs: DynamicsJointDofState[] = [];
    for (let k = 0; k < dofCount; k += 1) {
      const element = channel.elementOfDof[k] ?? 0;
      const rate = state.qd[runtime.dofOffset + k] ?? 0;
      const coulomb =
        channel.elementOfDof.length > 0
          ? coulombAt(runtime.dofAdr[element] ?? 0)
          : 0;
      dofs.push({
        flavor: flavors[k] ?? "rotational",
        position: state.q[runtime.dofOffset + k] ?? 0,
        rate,
        acceleration: accelerations[runtime.dofOffset + k] ?? 0,
        coulombForce: coulomb,
        viscousForce: -runtime.viscous * rate,
        dissipatedPowerW:
          runtime.viscous * rate * rate + Math.abs(coulomb * rate),
        dissipatedWorkJ:
          channel.wireIndex >= 0
            ? (state.dissipatedJ[channel.wireIndex] ?? 0)
            : 0,
      });
    }
    let reaction: DynamicsJointState["reaction"];
    if (channel.wireIndex >= 0) {
      const wire = mechanism.joints[channel.wireIndex];
      if (wire !== undefined && runtime.mjBodyId >= 0) {
        const cog = readNumbers(data.xipos, runtime.mjBodyId * 3, 3);
        const parentPos =
          runtime.mjParentBodyId >= 0
            ? readNumbers(data.xpos, runtime.mjParentBodyId * 3, 3)
            : [0, 0, 0];
        const parentR = currentRotation(state, runtime.mjParentBodyId);
        const anchor = add3(
          [parentPos[0] ?? 0, parentPos[1] ?? 0, parentPos[2] ?? 0],
          mulMat3Vec(parentR, wire.origin ?? [0, 0, 0]),
        );
        const wrench = readNumbers(data.cfrc_int, runtime.mjBodyId * 6, 6);
        const cogV: Vec3 = [cog[0] ?? 0, cog[1] ?? 0, cog[2] ?? 0];
        const frc: Vec3 = [wrench[3] ?? 0, wrench[4] ?? 0, wrench[5] ?? 0];
        const mom: Vec3 = [wrench[0] ?? 0, wrench[1] ?? 0, wrench[2] ?? 0];
        reaction = {
          forceN: frc,
          torqueNPerM: add3(mom, cross3(frc, sub3(anchor, cogV))),
        };
      }
    }
    let motorState: DynamicsJointState["motor"];
    const motorEntry = motorTorques.get(channel.ourId);
    if (motorEntry !== undefined && channel.wireIndex >= 0) {
      const motor = mechanism.motors.find((m) => m.jointId === channel.ourId);
      if (motor !== undefined) {
        const rate = state.qd[runtime.dofOffset] ?? 0;
        const mechanical = motorEntry.torque * rate;
        const electrical = motorElectricalPowerW(
          motor.motor,
          motorEntry.torque,
        );
        motorState = {
          jointId: channel.ourId,
          speedRadPerS: rate,
          torqueNPerM: motorEntry.torque,
          mechanicalPowerW: mechanical,
          mechanicalWorkJ: state.motorWorkJ[channel.wireIndex] ?? 0,
          ...(electrical === undefined
            ? {}
            : {
                electricalPowerW: electrical,
                electricalWorkJ: state.electricalWorkJ[channel.wireIndex] ?? 0,
              }),
        };
      }
    }
    joints.push({
      id: channel.ourId,
      kind: channel.layout.kind,
      tree: true,
      dofs,
      ...(reaction === undefined ? {} : { reaction }),
      ...(motorState === undefined ? {} : { motor: motorState }),
    });
  }
  for (const wireIndex of topologyLoopWire(state)) {
    const wire = mechanism.joints[wireIndex];
    if (wire === undefined) continue;
    joints.push({
      id: wire.id,
      kind: wire.kind,
      tree: false,
      dofs: [],
      loopResidual: equalityResidual,
    });
  }

  // ---- Energies and momenta ---------------------------------------------
  const energyValues = readNumbers(data.energy, 0, 2);
  const dissipatedTotal = state.dissipatedJ.reduce((sum, v) => sum + v, 0);
  const motorWorkTotal = state.motorWorkJ.reduce((sum, v) => sum + v, 0);
  const energy: DynamicsEnergyState = {
    kineticJ: energyValues[1] ?? 0,
    gravitationalPotentialJ: energyValues[0] ?? 0,
    dissipatedJ: dissipatedTotal,
    motorWorkJ: motorWorkTotal,
    externalWorkJ: state.externalWorkJ,
    auditJ:
      (energyValues[1] ?? 0) +
      (energyValues[0] ?? 0) -
      motorWorkTotal -
      state.externalWorkJ +
      dissipatedTotal,
  };

  let lx = 0;
  let ly = 0;
  let lz = 0;
  let ax = 0;
  let ay = 0;
  let az = 0;
  mechanism.bodies.forEach((body, index) => {
    const mjBody = state.bodyIds[index] ?? 0;
    const cog = readNumbers(data.xipos, mjBody * 3, 3);
    const cvel = readNumbers(data.cvel, mjBody * 6, 6);
    const omega: Vec3 = [cvel[0] ?? 0, cvel[1] ?? 0, cvel[2] ?? 0];
    const vCom: Vec3 = [cvel[3] ?? 0, cvel[4] ?? 0, cvel[5] ?? 0];
    const m = body.inertiaLocal.m;
    const linear: Vec3 = [m * vCom[0], m * vCom[1], m * vCom[2]];
    lx += linear[0];
    ly += linear[1];
    lz += linear[2];
    // The angular momentum about the world origin: r_cog × p plus the
    // COG-centred spin (the origin-frame I₀ parallel-axis-folds the
    // COG offset; un-folding it here keeps the reference's definition).
    const r = currentRotation(state, mjBody);
    const cogLocal = scale3(body.inertiaLocal.h, 1 / body.inertiaLocal.m);
    const cog2 =
      cogLocal[0] * cogLocal[0] +
      cogLocal[1] * cogLocal[1] +
      cogLocal[2] * cogLocal[2];
    const kernel: Mat3 = [
      cog2 - cogLocal[0] * cogLocal[0],
      -cogLocal[0] * cogLocal[1],
      -cogLocal[0] * cogLocal[2],
      -cogLocal[1] * cogLocal[0],
      cog2 - cogLocal[1] * cogLocal[1],
      -cogLocal[1] * cogLocal[2],
      -cogLocal[2] * cogLocal[0],
      -cogLocal[2] * cogLocal[1],
      cog2 - cogLocal[2] * cogLocal[2],
    ];
    const iCogWorld = mulMat3(
      r,
      mulMat3(
        addMat3(body.inertiaLocal.i0, scaleMat3(kernel, -body.inertiaLocal.m)),
        transposeMat3(r),
      ),
    );
    const spin = mulMat3Vec(iCogWorld, omega);
    const about = cross3([cog[0] ?? 0, cog[1] ?? 0, cog[2] ?? 0], linear);
    ax += about[0] + spin[0];
    ay += about[1] + spin[1];
    az += about[2] + spin[2];
  });
  const momentum: DynamicsMomentumState = {
    linearKgMPerS: [lx, ly, lz],
    angularKgM2PerS: [ax, ay, az],
  };

  return simOk({
    timeS: state.timeS,
    occurrences,
    joints,
    energy,
    momentum,
    solver: {
      coneIterations: asFiniteNumber(
        (data as { solver_niter?: unknown }).solver_niter,
        0,
      ),
      loopResidual: equalityResidual,
    },
  });
}

/** The loop wire indices through the state (topology's own). */
function topologyLoopWire(state: MujocoState): readonly number[] {
  return state.topology.loopWire;
}

/** The worst |equality residual| (m) over the model's equality rows — 0 with none. */
function worstEqualityResidual(state: MujocoState): number {
  const nefc = state.data.nefc;
  const types = readNumbers(state.data.efc_type, 0, nefc);
  const positions = readNumbers(state.data.efc_pos, 0, nefc);
  let worst = 0;
  for (let row = 0; row < nefc; row += 1) {
    // mjCNSTR_EQUALITY = 0 — only equality rows are loop closure.
    if ((types[row] ?? 0) !== 0) continue;
    worst = Math.max(worst, Math.abs(positions[row] ?? 0));
  }
  return worst;
}

/** Narrows a bindings scalar to a finite number. */
function asFiniteNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

// ---------------------------------------------------------------------------
// The state probe (the round-trip's verification entry)
// ---------------------------------------------------------------------------

/** A station written into the probe: `q`/`qd` in the pinned DOF order. */
export interface MujocoProbeStation {
  /** The full wire build input (the door validates it). */
  readonly input: DynamicsBuildInput;
  /** Our generalized positions per the provider's pinned DOF order. */
  readonly q: readonly number[];
  /** Our generalized rates per the provider's pinned DOF order. */
  readonly qd: readonly number[];
}

/** The probe's outcome: the read-back state plus MuJoCo's poses at the station. */
export interface MujocoProbeOutcome {
  /** The state read back after the write (the round-trip's read half). */
  readonly q: readonly number[];
  readonly qd: readonly number[];
  /** The MuJoCo world placements at the station (mm, our projection). */
  readonly poses: readonly {
    readonly id: string;
    readonly rotation: readonly number[];
    readonly translationMm: readonly [number, number, number];
  }[];
}

/**
 * Writes one station of OUR state into a freshly built MuJoCo system
 * and reads it back — the round-trip pin (identity expected: exact for
 * axis kinds, wrap-exact through the quaternion↔vector conversions for
 * ball/free). The returned poses are MuJoCo's forward kinematics AT
 * the station — the per-kind mapping pin's material. A verification
 * and future state-import surface, never a solver path.
 */
export async function probeMujocoState(
  station: MujocoProbeStation,
): Promise<SimParseResult<MujocoProbeOutcome, SimError>> {
  let module: MainModule;
  try {
    module = await loadMujocoWasm();
  } catch (cause) {
    return simFail(
      simError(
        SIM_ERROR_CODES.backendUnavailable,
        `The MuJoCo wasm backend is unavailable: ${cause instanceof Error ? cause.message : String(cause)}`,
        cause,
      ),
    );
  }
  const prepared = prepareMujocoState(module, station.input);
  if (!prepared.ok) return prepared;
  const state = prepared.value.state;
  for (let index = 0; index < state.q.length; index += 1) {
    state.q[index] = station.q[index] ?? 0;
    state.qd[index] = station.qd[index] ?? 0;
  }
  state.module.mj_step1(state.model, state.data);
  writeMirrorToMujoco(state);
  state.module.mj_step1(state.model, state.data);
  readMujocoToMirror(state);
  const poses = state.mechanism.bodies.map((body, index) => {
    const mjBody = state.bodyIds[index] ?? 0;
    const pos = readNumbers(state.data.xpos, mjBody * 3, 3);
    const quat = readNumbers(state.data.xquat, mjBody * 4, 4);
    return {
      id: body.id,
      rotation: mat3FromQuat([
        quat[0] ?? 1,
        quat[1] ?? 0,
        quat[2] ?? 0,
        quat[3] ?? 0,
      ]),
      translationMm: [
        (pos[0] ?? 0) * 1000,
        (pos[1] ?? 0) * 1000,
        (pos[2] ?? 0) * 1000,
      ] as [number, number, number],
    };
  });
  return simOk({ q: [...state.q], qd: [...state.qd], poses });
}
