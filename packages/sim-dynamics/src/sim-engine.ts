/**
 * The dynamics engine behind the Phase 61 `SimEngine` contract (Phase
 * 67c, the sim-flow/sim-thermal adapter precedent): ONE `run` call
 * turns a COMPILED dynamics scenario into a persisted-shape
 * {@link SimResult}:
 *
 * 1. **Consumes the compiled problem** — the 67c compile's
 *    `dynamics` product: the mechanism wire (document space) walks
 *    through this package's own door (`compileMechanism`, the one
 *    document→SI site), the gravity vector is the Phase 61 scenario's
 *    own (`gravityMPerS2` — self-weight is honest), and the selected
 *    motor record rides the stance's joint through the door's motor
 *    wire (the one datasheet→SI site, never double-converted).
 * 2. **Runs the stepped march** — the 67a reference kernel by default
 *    (the S2/S5 oracle); the 67b MuJoCo provider behind the SAME
 *    contract when the stance opts in, declining loudly
 *    (`sim/backend-unavailable`) when its wasm cannot load, never
 *    silently falling back. The quasi-static load couplings evaluate
 *    per step (`./loads`) into the control's gravity-sharing loads
 *    term and joint efforts.
 * 3. **Emits** — progress at the sampling cadence plus the final step
 *    (the notifications are the cooperative cancellation window, one
 *    macrotask yield per cadence), and ONE final preview round: the
 *    per-joint dissipated-power history as a document-space field
 *    block split into protocol chunks, bitwise the block the
 *    finalized result carries (the thermal engine's one-committed-round
 *    discipline — the 67a kernel is a whole-step API, so the streaming
 *    cadence is per-sample, stated here honestly rather than faked
 *    per-step).
 * 4. **Finalizes** — per-joint dissipated power and dissipated work as
 *    PROJECTED QUANTITIES (machine-readable, Phase 70 objective
 *    material), the energy ledger facts as history series (kinetic,
 *    potential, dissipated, motor work, external work, the conserved
 *    audit), per-joint position/rate histories (the assembly-motion
 *    surface's animation data), and the motor's operating history.
 *    Law S9 states NOTHING here — the empty regime report the compile
 *    computed rides verbatim (no dishonest Re/Pr claims on a mechanism
 *    run).
 *
 * Determinism is the whole stance (law S2): no clock reads, no
 * randomness, a fixed emission schedule — the same compiled problem
 * produces the bitwise-identical result and notification stream every
 * time.
 */

import {
  type CompiledSimDynamics,
  type SimEngine,
  type SimEngineFieldChunk,
  type SimEngineProgress,
  type SimEngineRequest,
  type SimError,
  SIM_ERROR_CODES,
  type SimHistorySeries,
  type SimParseResult,
  type SimResult,
  type SimResultSummary,
  SIM_RESULT_SUMMARY_VERSION,
  type SimScenarioKind,
  simError,
  simFail,
  simOk,
  splitSimFieldBlock,
} from "@slopcad/sim-core";
import type {
  DynamicsBuildInput,
  DynamicsControl,
  DynamicsOccurrenceWire,
  DynamicsStepResult,
} from "./contract";

import { createDynamicsEngine } from "./engine-select";
import {
  compileDynamicsLoads,
  type CompiledDynamicsLoadSeries,
  evaluateDynamicsLoads,
} from "./loads";

/** The dynamics engine's stable id (the worker host's routing key). */
export const DYNAMICS_SIM_ENGINE_ID = "dynamics-featherstone-cpu-reference";

/** The scenario kinds this engine solves. */
export const DYNAMICS_SUPPORTED_KINDS: readonly SimScenarioKind[] = [
  "dynamics",
];

/**
 * The values-per-chunk ceiling a preview round splits its block into —
 * the flow/thermal engines' framing knob, restated so every domain
 * frames identically.
 */
export const DYNAMICS_PREVIEW_CHUNK_MAX_VALUES = 16384;

/**
 * The preview field's id — the per-joint dissipated-power history
 * (extent [joints, samples, 1], watts).
 */
export const DYNAMICS_DISSIPATION_FIELD_ID = "dissipated-power";

const refuse = (
  code: (typeof SIM_ERROR_CODES)[keyof typeof SIM_ERROR_CODES],
  message: string,
  at: unknown,
): SimParseResult<never, SimError> => simFail(simError(code, message, at));

/** One macrotask turn — the cooperative cancellation window. */
function yieldOnce(): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
}

/**
 * The mechanism wire's occurrence entries, narrowed for the door. The
 * sim-core compile gate already checked the arrays' shape; the door
 * re-validates EVERY field of every entry (its own documented stance),
 * so this claim is a trust-boundary handoff, not a guess.
 */
function wireOccurrences(
  entries: readonly unknown[],
): readonly DynamicsOccurrenceWire[] {
  return entries as readonly DynamicsOccurrenceWire[];
}

interface JointSampleChannel {
  readonly jointId: string;
  readonly tree: boolean;
  readonly positions: number[][];
  readonly rates: number[][];
  readonly dissipatedPower: number[];
  readonly dissipatedWork: number[];
}

/** The run's collected sample state (the histories' material). */
interface DynamicsRunCollector {
  readonly times: number[];
  readonly joints: JointSampleChannel[];
  readonly kineticJ: number[];
  readonly potentialJ: number[];
  readonly dissipatedJ: number[];
  readonly motorWorkJ: number[];
  readonly externalWorkJ: number[];
  readonly auditJ: number[];
  readonly motorSpeed: number[];
  readonly motorTorque: number[];
  readonly loopResidual: number[];
}

function newCollector(
  joints: readonly DynamicsStepResult["joints"][number][],
): DynamicsRunCollector {
  const channels: JointSampleChannel[] = joints.map((joint) => ({
    jointId: joint.id,
    tree: joint.tree,
    positions: joint.dofs.map(() => []),
    rates: joint.dofs.map(() => []),
    dissipatedPower: [],
    dissipatedWork: [],
  }));
  return {
    times: [],
    joints: channels,
    kineticJ: [],
    potentialJ: [],
    dissipatedJ: [],
    motorWorkJ: [],
    externalWorkJ: [],
    auditJ: [],
    motorSpeed: [],
    motorTorque: [],
    loopResidual: [],
  };
}

function recordSample(
  collector: DynamicsRunCollector,
  timeS: number,
  state: DynamicsStepResult,
): void {
  collector.times.push(timeS);
  for (const channel of collector.joints) {
    const joint = state.joints.find((entry) => entry.id === channel.jointId);
    if (joint === undefined) continue;
    const power = joint.dofs.reduce(
      (sum, dof) => sum + dof.dissipatedPowerW,
      0,
    );
    const work = joint.dofs.reduce((sum, dof) => sum + dof.dissipatedWorkJ, 0);
    channel.dissipatedPower.push(power);
    channel.dissipatedWork.push(work);
    for (const [dof, slot] of channel.positions.entries()) {
      const dofState = joint.dofs[dof];
      slot.push(dofState?.position ?? 0);
      channel.rates[dof]?.push(dofState?.rate ?? 0);
    }
  }
  collector.kineticJ.push(state.energy.kineticJ);
  collector.potentialJ.push(state.energy.gravitationalPotentialJ);
  collector.dissipatedJ.push(state.energy.dissipatedJ);
  collector.motorWorkJ.push(state.energy.motorWorkJ);
  collector.externalWorkJ.push(state.energy.externalWorkJ);
  collector.auditJ.push(state.energy.auditJ);
  const motorJoint = state.joints.find((joint) => joint.motor !== undefined);
  collector.motorSpeed.push(motorJoint?.motor?.speedRadPerS ?? 0);
  collector.motorTorque.push(motorJoint?.motor?.torqueNPerM ?? 0);
  collector.loopResidual.push(state.solver.loopResidual);
}

/**
 * The per-joint dissipated-power history as a document-space field
 * block: extent [joints, samples, 1], values in watts, x-fastest (the
 * sample axis). Origin and spacing are unit-indexed — the block is a
 * HISTORY grid (joint × sample), not a spatial one, and says so by its
 * extent semantics alone.
 */
function dissipationBlockOf(
  collector: DynamicsRunCollector,
): SimEngineFieldChunk[] {
  const sampleCount = collector.times.length;
  const jointCount = collector.joints.length;
  if (sampleCount === 0 || jointCount === 0) return [];
  const values: number[] = [];
  for (let sample = 0; sample < sampleCount; sample += 1) {
    for (let joint = 0; joint < jointCount; joint += 1) {
      values.push(collector.joints[joint]?.dissipatedPower[sample] ?? 0);
    }
  }
  const block = {
    id: DYNAMICS_DISSIPATION_FIELD_ID,
    unit: "W",
    extent: [jointCount, sampleCount, 1] as const,
    originMm: [0, 0, 0] as const,
    spacingMm: [1, 1, 1] as const,
    dataType: "float64" as const,
    values,
  };
  const chunkCount = Math.max(
    1,
    Math.ceil(values.length / DYNAMICS_PREVIEW_CHUNK_MAX_VALUES),
  );
  return [...splitSimFieldBlock(block, chunkCount)];
}

function historiesOf(collector: DynamicsRunCollector): SimHistorySeries[] {
  const histories: SimHistorySeries[] = [];
  const push = (
    name: string,
    unit: string,
    samples: readonly number[],
  ): void => {
    histories.push({ name, unit, samples: [...samples] });
  };
  push("time", "s", collector.times);
  for (const channel of collector.joints) {
    if (!channel.tree) continue;
    for (const [dof, slots] of channel.positions.entries()) {
      if (slots.length === 0) continue;
      push(
        `joint:${channel.jointId}:dof${String(dof)}:position`,
        "rad | m",
        slots,
      );
      push(
        `joint:${channel.jointId}:dof${String(dof)}:rate`,
        "rad/s | m/s",
        channel.rates[dof] ?? [],
      );
    }
    push(
      `joint:${channel.jointId}:dissipated-power`,
      "W",
      channel.dissipatedPower,
    );
    push(
      `joint:${channel.jointId}:dissipated-work`,
      "J",
      channel.dissipatedWork,
    );
  }
  push("energy:kinetic", "J", collector.kineticJ);
  push("energy:gravitational-potential", "J", collector.potentialJ);
  push("energy:dissipated", "J", collector.dissipatedJ);
  push("energy:motor-work", "J", collector.motorWorkJ);
  push("energy:external-work", "J", collector.externalWorkJ);
  push("energy:audit", "J", collector.auditJ);
  push("motor:speed", "rad/s", collector.motorSpeed);
  push("motor:torque", "N·m", collector.motorTorque);
  push("solver:loop-residual", "m | rad", collector.loopResidual);
  return histories;
}

async function runDynamicsEngine(
  request: SimEngineRequest,
  onProgress?: (progress: SimEngineProgress) => void,
  onFieldChunk?: (chunk: SimEngineFieldChunk) => void,
): Promise<SimParseResult<SimResult, SimError>> {
  const compiled = request.compiled;
  if (!DYNAMICS_SUPPORTED_KINDS.includes(compiled.kind)) {
    return refuse(
      SIM_ERROR_CODES.scenarioKindUnsupported,
      `The dynamics engine does not solve the "${compiled.kind}" scenario kind (it solves dynamics; structural is Phase 69's carve).`,
      compiled.kind,
    );
  }
  if (compiled.backend === "gpu") {
    return refuse(
      SIM_ERROR_CODES.backendUnavailable,
      'The scenario prefers the "gpu" backend, but the dynamics domain ships the CPU reference kernel and the CPU MuJoCo wasm provider — there is no GPU provider to route to, and the engine declines the preference loudly instead of silently ignoring it.',
      compiled.backend,
    );
  }
  const dynamics: CompiledSimDynamics | undefined = compiled.dynamics;
  if (dynamics === undefined) {
    return refuse(
      SIM_ERROR_CODES.scenarioInvalid,
      "A dynamics run needs the compile's mechanism products: compile with the document's mechanism wire (occurrences, joints, mass properties, grounded ids) through the geometry-aware compile door.",
      compiled.name,
    );
  }
  const loads = compileDynamicsLoads(dynamics.loads);
  if (!loads.ok) {
    return refuse(SIM_ERROR_CODES.mechanismInvalid, loads.message, loads.at);
  }
  const series: readonly CompiledDynamicsLoadSeries[] = loads.series;

  const buildInput: DynamicsBuildInput = {
    occurrences: wireOccurrences(dynamics.mechanism.occurrences),
    joints: dynamics.mechanism.joints,
    masses: dynamics.mechanism.masses as DynamicsBuildInput["masses"],
    ...(dynamics.mechanism.grounded === undefined
      ? {}
      : { grounded: dynamics.mechanism.grounded }),
    gravityMPerS2: compiled.gravityMPerS2,
    ...(dynamics.motorJointId === undefined || dynamics.motorWire === undefined
      ? {}
      : {
          motors: [
            { jointId: dynamics.motorJointId, motor: dynamics.motorWire },
          ],
        }),
  };

  // The engine selection (the 67b factory seam): the reference kernel
  // resolves immediately; MuJoCo loads its wasm once and declines
  // loudly when the environment cannot run it.
  const engineForRun = await createDynamicsEngine(dynamics.provider);
  if (!engineForRun.ok) return engineForRun;
  const built = engineForRun.value.build(buildInput);
  if (!built.ok) return built;

  const steps = Math.round(dynamics.durationS / dynamics.timeStepS);
  const cadence = Math.round(dynamics.sampleIntervalS / dynamics.timeStepS);
  let collector: DynamicsRunCollector | null = null;
  let finalState: DynamicsStepResult | undefined;
  for (let step = 1; step <= steps; step += 1) {
    const time = step * dynamics.timeStepS;
    // The load couplings evaluate at the step's END time (the value the
    // step integrates under — the semi-implicit stance, stated).
    const terms = evaluateDynamicsLoads(series, time);
    const control: DynamicsControl = {
      timeStepS: dynamics.timeStepS,
      ...(terms.loads.length === 0 ? {} : { loads: terms.loads }),
      ...(terms.jointEfforts.length === 0
        ? {}
        : { jointEfforts: terms.jointEfforts }),
    };
    const stepped = built.value.step(control);
    if (!stepped.ok) return stepped;
    finalState = stepped.value;
    if (collector === null) collector = newCollector(stepped.value.joints);
    const sampled = step % cadence === 0 || step === steps;
    if (!sampled) continue;
    recordSample(collector, time, stepped.value);
    await yieldOnce();
    onProgress?.({ step, totalSteps: steps });
  }
  if (collector === null || finalState === undefined) {
    return refuse(
      SIM_ERROR_CODES.scenarioInvalid,
      "A dynamics march must carry at least one step (the stance's duration and time step declared none).",
      dynamics,
    );
  }
  onProgress?.({ step: steps, totalSteps: steps });

  // The one committed preview round: the dissipation block, chunked.
  if (onFieldChunk !== undefined) {
    for (const chunk of dissipationBlockOf(collector)) {
      onFieldChunk(chunk);
    }
  }

  // The projected quantities: per-joint dissipated power and work (the
  // Phase 70 objective material), the totals, and the loop closure.
  const quantities: {
    readonly name: string;
    readonly value: number;
    readonly unit: string;
  }[] = [];
  for (const channel of collector.joints) {
    const finalPower = channel.dissipatedPower.at(-1) ?? 0;
    const totalWork = channel.dissipatedWork.at(-1) ?? 0;
    quantities.push({
      name: `joint-${channel.jointId}-dissipated-power`,
      value: finalPower,
      unit: "W",
    });
    quantities.push({
      name: `joint-${channel.jointId}-dissipated-work`,
      value: totalWork,
      unit: "J",
    });
  }
  quantities.push({
    name: "dissipated-work-total",
    value: finalState.energy.dissipatedJ,
    unit: "J",
  });
  quantities.push({
    name: "motor-work-total",
    value: finalState.energy.motorWorkJ,
    unit: "J",
  });
  quantities.push({
    name: "external-work-total",
    value: finalState.energy.externalWorkJ,
    unit: "J",
  });
  // The conserved-audit TOTAL (KE + PE − motor work − external work +
  // dissipated), the energy:audit history's final sample — not the drift:
  // drift is audit(t) − audit(0) and equals this only when the initial
  // state carried zero energy. Consumers wanting drift pair this with
  // the run's initial energy (the conservation fixtures' computation).
  quantities.push({
    name: "energy-audit-total",
    value: finalState.energy.auditJ,
    unit: "J",
  });
  const worstLoop = Math.max(...collector.loopResidual, 0);
  quantities.push({
    name: "loop-residual-worst",
    value: worstLoop,
    unit: "m | rad",
  });
  const motorJoint = finalState.joints.find(
    (joint) => joint.motor !== undefined,
  );
  if (motorJoint?.motor !== undefined) {
    quantities.push({
      name: "motor-speed-final",
      value: motorJoint.motor.speedRadPerS,
      unit: "rad/s",
    });
    quantities.push({
      name: "motor-torque-final",
      value: motorJoint.motor.torqueNPerM,
      unit: "N·m",
    });
  }

  const summary: SimResultSummary = {
    schemaVersion: SIM_RESULT_SUMMARY_VERSION,
    scenarioSnapshotHash: compiled.scenarioSnapshotHash,
    status: "completed",
    regime: compiled.regime,
    quantities,
    servedBackend: "cpu",
  };
  const result: SimResult = {
    summary,
    fields: [],
    histories: historiesOf(collector),
  };
  return simOk(result);
}

/** The deterministic dynamics engine (law S2's CPU oracle adapter). */
export function createDynamicsSimEngine(): SimEngine {
  return {
    id: DYNAMICS_SIM_ENGINE_ID,
    supportedKinds: DYNAMICS_SUPPORTED_KINDS,
    backend: "cpu",
    run: (request, onProgress, onFieldChunk) =>
      runDynamicsEngine(request, onProgress, onFieldChunk),
  };
}
