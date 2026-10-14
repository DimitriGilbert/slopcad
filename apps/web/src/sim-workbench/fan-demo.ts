/**
 * The fan-in-a-tube demo's fixture data (ROADMAP-SIM Phase 66c): the
 * document the `/workbench-sim` page renders in FAN mode — the cad-jsx
 * demo body (`@slopcad/docs-examples`'s `cadjsx/fan-in-tube`) compiled
 * and folded over a fresh document, PLUS the demo motor record the
 * motor-driven scenario selects (the §7.9 `motors` section precedent:
 * the record is document data, the scenario references it by id).
 *
 * Everything here is FIXTURE DATA in the 62c sense: the domain, the
 * resolution, the inlet, the shaft axis, and the motor are authored
 * numbers the page's fan form defaults restate — the honest demo scale
 * stated once. The numbers are tuned together against the TESSELLATED
 * body (the analytic twin alone under-predicts the staircase's
 * blockage): at 2 mm voxels, real air, the 0.01 m/s duct velocity, and
 * the 3D engine's 0.03 lattice velocity (its documented damping
 * choice), the closure's dt (≈6 ms) keeps the 40 rpm-class shaft
 * inside the rotating doors' low-Mach ceilings and the rungs stable —
 * the guide's resolution-guidance section documents the coupling.
 */

import {
  addDocumentMotor,
  addDocumentSimulation,
  applySessionTransaction,
  createDocument,
  createDocumentId,
  createSession,
  parseMotorId,
  type CadDocument,
  type SimScenarioDraft,
} from "@slopcad/cad-core";
import { compileModel } from "@slopcad/cad-jsx";
import {
  FanInTubeModel,
  FAN_IN_TUBE,
} from "@slopcad/docs-examples/cadjsx/fan-in-tube";

/** The fan demo document's id. */
export const FAN_DEMO_DOCUMENT_ID = "doc_workbench_sim_fan";

/** The demo motor record's id (the scenario's selection), minted once. */
const parsedDemoMotorId = parseMotorId("mot_fan-demo");
if (!parsedDemoMotorId.ok) {
  throw new Error(
    `The demo motor id is invalid: ${parsedDemoMotorId.error.message}`,
  );
}
export const FAN_DEMO_MOTOR_ID = parsedDemoMotorId.value;

/**
 * The demo motor: a small DC brushed motor whose torque-speed line
 * crosses the paddle rotor's load curve inside the engine's ω ladder —
 * tuned at authoring time against the analytic twin of the
 * tessellated demo body (the `./fan-demo` test's measurement), so the
 * motor-driven demo FINDS its operating point instead of declining.
 */
const FAN_DEMO_MOTOR_INPUT = {
  name: "fan demo motor",
  kind: "dc-brushed" as const,
  /** The stall torque, mN·m (the datasheet unit the S4 door converts). */
  stallTorqueMNm: 4e-6,
  /** The no-load speed, rpm. */
  noLoadSpeedRpm: 40,
  /** The nominal voltage, V. */
  nominalVoltageV: 12,
} as const;

/** The demo motor's record numbers, keyed by field (the test's compiled twin). */
export const FAN_DEMO_MOTOR_NUMBERS = {
  stallTorqueMNm: FAN_DEMO_MOTOR_INPUT.stallTorqueMNm,
  noLoadSpeedRpm: FAN_DEMO_MOTOR_INPUT.noLoadSpeedRpm,
  nominalVoltageV: FAN_DEMO_MOTOR_INPUT.nominalVoltageV,
} as const;

/** The fan demo's authored numbers — the form defaults' single source. */
export const FAN_DEMO = {
  /** The explicit voxelization domain around the tube, mm. */
  domainMinMm: [-17, -17, -4] as const,
  domainMaxMm: [17, 17, 40] as const,
  /** The voxel resolution, mm (the honest staircase scale — see the guide). */
  resolutionMm: 2,
  /** The inlet speed at the zMin face, m/s (the characteristic velocity). */
  inletSpeedMPerS: 0.01,
  /** The shaft axis: the tube's centreline at the rotor's mid-plane, mm. */
  axisPointMm: [0, 0, FAN_IN_TUBE.rotorZ] as const,
  axisDirection: [0, 0, 1] as const,
  /** The rotating zone's radius, mm — the cylinder enclosing the rotor. */
  zoneRadiusMm: 7.5,
  /** The authored blade count (BPF arithmetic). */
  bladeCount: FAN_IN_TUBE.bladeCount,
  /** The sweep's step budget per rung (the averaging window is half). */
  stepBudget: 120,
} as const;

/**
 * The demo document: the fan-in-tube body plus the demo motor record.
 * Pure and deterministic (the compile walk and the two adds both are),
 * computed once per call site — the sim-demo-body precedent.
 */
export function fanDemoDocument(): CadDocument {
  const compiled = compileModel(FanInTubeModel());
  if (!compiled.ok) {
    throw new Error(
      `The fan-in-tube model failed to compile: ${compiled.error.code}: ${compiled.error.message}`,
    );
  }
  const applied = applySessionTransaction(
    createSession(createDocument(createDocumentId(FAN_DEMO_DOCUMENT_ID))),
    compiled.value,
  );
  if (!applied.ok) {
    throw new Error(
      `The fan-in-tube transaction did not apply to a fresh document: ${applied.error.message}`,
    );
  }
  const withMotor = addDocumentMotor(applied.value.document, {
    id: FAN_DEMO_MOTOR_ID,
    ...FAN_DEMO_MOTOR_INPUT,
  });
  if (!withMotor.ok) {
    throw new Error(
      `The demo motor record did not apply: ${withMotor.error.message}`,
    );
  }
  return withMotor.value.document;
}

/** The demo scenario draft — the fan form's defaults, one source. */
export function fanDemoScenarioDraft(): SimScenarioDraft {
  return {
    name: "fan-in-tube",
    kind: "flow",
    domain: {
      kind: "explicit",
      min: [...FAN_DEMO.domainMinMm],
      max: [...FAN_DEMO.domainMaxMm],
      resolutionMm: FAN_DEMO.resolutionMm,
    },
    conditions: [
      {
        kind: "velocity-inlet",
        face: "zMin",
        speedMPerS: FAN_DEMO.inletSpeedMPerS,
        direction: [0, 0, 1],
      },
    ],
    fluid: "air",
    stepBudget: FAN_DEMO.stepBudget,
    flow3d: {
      rotation: {
        kind: "mrf",
        axisPointMm: [...FAN_DEMO.axisPointMm],
        axisDirection: [...FAN_DEMO.axisDirection],
        zoneRadiusMm: FAN_DEMO.zoneRadiusMm,
        rpmMode: "motor",
        bladeCount: FAN_DEMO.bladeCount,
      },
    },
    motorId: FAN_DEMO_MOTOR_ID,
  };
}

/** Adds the demo scenario to a document (the page's boot convenience). */
export function addFanDemoScenario(document: CadDocument): {
  readonly document: CadDocument;
  readonly scenarioName: string;
} {
  const added = addDocumentSimulation(document, fanDemoScenarioDraft());
  if (!added.ok) {
    throw new Error(
      `The demo fan scenario did not apply: ${added.error.message}`,
    );
  }
  return {
    document: added.value.document,
    scenarioName: added.value.scenario.name,
  };
}
