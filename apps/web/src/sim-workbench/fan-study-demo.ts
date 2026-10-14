/**
 * The most-efficient-fan study demo's fixture data (ROADMAP-SIM Phase
 * 70, the named deliverable — the §7.9 motor ruling's payoff): the 66
 * fan-in-tube substrate (`./fan-demo`'s document — its `boreRadius`
 * parameter IS the geometry gene) CO-OPTIMIZED with the motor record as
 * a discrete gene, evolved against the Phase 66 operating-point summary
 * the Phase 70 engine projects — AIRFLOW PER ELECTRICAL WATT at the
 * found operating point (maximize; the motor in the loop makes it the
 * system objective). The demo document gains ONE study motor beside the
 * fan demo's own — a torquey twin whose line crosses the paddle rotor's
 * load curve at a different operating point — so the discrete gene has
 * a real choice (`fanWorkbenchDocument` adds it to the working document
 * on the fan preset's LOAD path, BEFORE the study form maps — a fresh
 * fan document carries one motor, and the form's mapper refuses a
 * discrete gene with fewer than two choices).
 *
 * Everything here is FIXTURE DATA in the 62c sense: the genome (the
 * bore on a 0.5 mm lattice, the motor pair), the objective, and the
 * e2e-sized budget (population 4 × generations 2 = 8 MRF sweeps at the
 * coarse-first step budget 90 — the roadmap's cost mitigation; the
 * resolution-ladder and multi-seed caveats are the guide's).
 */

import {
  addDocumentMotor,
  type CadDocument,
  createParameterId,
  parseMotorId,
  type SimScenarioDraft,
  type SimStudyInput,
} from "@slopcad/cad-core";

import {
  FAN_DEMO_MOTOR_ID,
  fanDemoDocument,
  fanDemoScenarioDraft,
} from "./fan-demo";

/** The study motor's id, minted once (the discrete gene's second choice). */
const parsedStudyMotorId = parseMotorId("mot_study-torquey");
if (!parsedStudyMotorId.ok) {
  throw new Error(
    `The study motor id is invalid: ${parsedStudyMotorId.error.message}`,
  );
}
export const FAN_STUDY_MOTOR_ID = parsedStudyMotorId.value;

/**
 * The torquey study motor: double the demo motor's stall torque at a
 * lower no-load speed — a different operating point, the honest gene
 * choice (tuned beside the demo motor's own line, the `./fan-demo`
 * discipline).
 */
const FAN_STUDY_MOTOR_INPUT = {
  name: "study torquey motor",
  kind: "dc-brushed" as const,
  stallTorqueMNm: 8e-6,
  noLoadSpeedRpm: 25,
  nominalVoltageV: 12,
} as const;

/** The study demo's authored numbers — the form defaults' single source. */
export const FAN_STUDY_DEMO = {
  /** The geometry gene: the bore on a 0.5 mm lattice inside the duct wall. */
  boreMin: 8,
  boreMax: 12,
  boreStep: 0.5,
  /** The coarse-first sweep budget per candidate (the demo's 120 − 25%). */
  stepBudget: 90,
  /** The e2e-sized budget (8 sweeps, deterministic seed). */
  population: 4,
  generations: 2,
  seed: 11,
} as const;

/** The fan genome's parameter id (the cad-jsx model's own bore). */
export const FAN_STUDY_GENES = {
  boreRadius: createParameterId("param_bore-radius"),
} as const;

/** The study motor's record numbers, keyed by field (the test's twin). */
export const FAN_STUDY_MOTOR_NUMBERS = {
  stallTorqueMNm: FAN_STUDY_MOTOR_INPUT.stallTorqueMNm,
  noLoadSpeedRpm: FAN_STUDY_MOTOR_INPUT.noLoadSpeedRpm,
  nominalVoltageV: FAN_STUDY_MOTOR_INPUT.nominalVoltageV,
} as const;

/**
 * Adds the study motor to a document when it is missing (the preset
 * load path's own record add — the demo document's motor section grows
 * by exactly this record, nothing else).
 */
export function ensureFanStudyMotor(document: CadDocument): {
  readonly document: CadDocument;
} {
  if (document.motors.some((motor) => motor.id === FAN_STUDY_MOTOR_ID)) {
    return { document };
  }
  const added = addDocumentMotor(document, {
    id: FAN_STUDY_MOTOR_ID,
    ...FAN_STUDY_MOTOR_INPUT,
  });
  if (!added.ok) {
    throw new Error(
      `The study motor record did not apply: ${added.error.message}`,
    );
  }
  return { document: added.value.document };
}

/**
 * The fan preset's WORKING document: the fresh fan demo document (one
 * motor) with the study motor ensured — the derivation the workbench
 * page's demo-model switch loads and the study form then maps, so the
 * discrete motor gene's two choices exist BEFORE any submit (the one
 * source the page and the ordering tests share).
 */
export function fanWorkbenchDocument(): CadDocument {
  return ensureFanStudyMotor(fanDemoDocument()).document;
}

/** The study demo's fan scenario — the demo stance at the coarse budget. */
export function fanStudyScenarioDraft(): SimScenarioDraft {
  const demo = fanDemoScenarioDraft();
  return {
    ...demo,
    name: "fan-study",
    stepBudget: FAN_STUDY_DEMO.stepBudget,
  };
}

/** The study demo's authored fields: the bore + motor co-optimization. */
export function fanStudyInput(
  scenarioId: SimStudyInput["scenarioId"],
): SimStudyInput {
  return {
    name: "most-efficient-fan",
    scenarioId,
    genes: [
      {
        kind: "parameter",
        parameterId: FAN_STUDY_GENES.boreRadius,
        valueKind: "decimal",
        min: FAN_STUDY_DEMO.boreMin,
        max: FAN_STUDY_DEMO.boreMax,
        step: FAN_STUDY_DEMO.boreStep,
      },
      {
        kind: "discrete",
        recordKind: "motor",
        choices: [FAN_DEMO_MOTOR_ID, FAN_STUDY_MOTOR_ID],
      },
    ],
    objectives: [
      { quantity: "airflow-per-electrical-watt", direction: "maximize" },
    ],
    population: FAN_STUDY_DEMO.population,
    generations: FAN_STUDY_DEMO.generations,
    seed: FAN_STUDY_DEMO.seed,
  };
}
