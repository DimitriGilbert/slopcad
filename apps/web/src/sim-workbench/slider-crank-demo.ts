/**
 * The slider-crank demo's fixture data (ROADMAP-SIM Phase 67c): the
 * document the `/workbench-sim` page renders in SLIDER-CRANK mode —
 * the cad-jsx demo bodies (`@slopcad/docs-examples`'s
 * `cadjsx/slider-crank`) compiled and folded over a fresh document,
 * PLUS the mechanism itself as document records: four OCCURRENCES
 * (the base plate, the crank, the rod, the piston — placed at the
 * exactly-closed θ = 0 configuration), four JOINT records (the crank
 * main bearing and the crank pin as tree revolutes, the piston line as
 * a tree slider, the wrist pin as the CLOSING loop revolute), and the
 * demo motor record the scenario selects (the §7.9 `motors` section
 * precedent).
 *
 * Everything here is FIXTURE DATA in the 62c sense (the fan demo's
 * discipline): the mechanism dimensions, the mass twin, the friction
 * fields, the march budget, and the motor are authored numbers the
 * page's dynamics form defaults restate — the honest demo scale stated
 * once. The mass twin is the ANALYTIC twin (slender links at steel
 * density over the authored boxes): the mechanism run must be
 * deterministic and tessellation-independent, so the masses author as
 * data rather than deriving from the rendered grid — the same analytic
 * stance the fan demo's motor-load pairing takes.
 */

import {
  addDocumentMotor,
  addDocumentSimulation,
  addJoint,
  addOccurrence,
  applySessionTransaction,
  createDocument,
  createDocumentId,
  createSession,
  parseBodyId,
  parseJointId,
  parseMotorId,
  parseOccurrenceId,
  resolveAssemblyInstances,
  type BodyId,
  type CadDocument,
  type DocumentJoint,
  type OccurrenceId,
  type SimScenarioDraft,
} from "@slopcad/cad-core";
import type { SimMechanismWire } from "@slopcad/sim-core";
import { compileModel } from "@slopcad/cad-jsx";
import {
  SliderCrankModel,
  SLIDER_CRANK,
} from "@slopcad/docs-examples/cadjsx/slider-crank";

/** The slider-crank demo document's id. */
export const SLIDER_DEMO_DOCUMENT_ID = "doc_workbench_sim_slider";

/** The demo motor record's id (the scenario's selection), minted once. */
const parsedDemoMotorId = parseMotorId("mot_slider-demo");
if (!parsedDemoMotorId.ok) {
  throw new Error(
    `The demo motor id is invalid: ${parsedDemoMotorId.error.message}`,
  );
}
export const SLIDER_DEMO_MOTOR_ID = parsedDemoMotorId.value;

/** One fixed branded id or the fixture bug reported immediately. */
function fixedId<T>(
  parsed:
    | { readonly ok: true; readonly value: T }
    | { readonly ok: false; readonly error: { readonly message: string } },
  what: string,
): T {
  if (!parsed.ok) {
    throw new Error(`The ${what} id is invalid: ${parsed.error.message}`);
  }
  return parsed.value;
}

function bodyIdOf(raw: string, what: string): BodyId {
  return fixedId(parseBodyId(raw), `${what} body`);
}

export const SLIDER_OCCURRENCE_IDS = {
  base: fixedId(parseOccurrenceId("occ_slider-base"), "base occurrence"),
  crank: fixedId(parseOccurrenceId("occ_slider-crank"), "crank occurrence"),
  rod: fixedId(parseOccurrenceId("occ_slider-rod"), "rod occurrence"),
  piston: fixedId(parseOccurrenceId("occ_slider-piston"), "piston occurrence"),
} as const;
export const SLIDER_JOINT_IDS = {
  crank: fixedId(parseJointId("jnt_slider-crank"), "crank joint"),
  conrod: fixedId(parseJointId("jnt_slider-conrod"), "conrod joint"),
  slide: fixedId(parseJointId("jnt_slider-slide"), "slide joint"),
  wrist: fixedId(parseJointId("jnt_slider-wrist"), "wrist joint"),
} as const;

/**
 * The demo motor: a DC brushed motor whose line drives the crank at
 * demo-friendly speeds — the SAME 61 motor abstraction the Phase 66
 * fan record rides (one vocabulary across the domains).
 */
const SLIDER_DEMO_MOTOR_INPUT = {
  name: "slider demo motor",
  kind: "dc-brushed" as const,
  /** The stall torque, mN·m (the datasheet unit the S4 door converts). */
  stallTorqueMNm: 80,
  /** The no-load speed, rpm. */
  noLoadSpeedRpm: 1500,
  /** The nominal voltage, V. */
  nominalVoltageV: 12,
  /** The rotor inertia, kg·m² (direct drive, no gear ratio authored). */
  rotorInertiaKgM2: 0.0004,
} as const;

/** The demo's authored numbers — the form defaults' single source. */
export const SLIDER_DEMO = {
  ...SLIDER_CRANK,
  /** The links' authored friction (the 67a additive joint fields). */
  viscousDampingNPerMSPerRad: 0.002,
  frictionLossNPerM: 0.004,
  /** The integration time step, s (the honest march resolution). */
  timeStepS: 0.001,
  /** The march's physical duration, s (an integer number of steps). */
  durationS: 2,
  /** The history sampling cadence, s (an integer number of steps). */
  sampleIntervalS: 0.04,
} as const;

/** One mass-twin entry: the door's wire shape (grams, world mm, kg·m²). */
interface MassTwinEntry {
  readonly occurrenceId: OccurrenceId;
  readonly massGrams: number;
  readonly centerOfGravityMm: readonly [number, number, number];
  readonly inertiaTensorKgM2: readonly number[];
}

/**
 * The mass twin (the analytic stance this module header states): the
 * four bodies' masses, world COGs, and inertia tensors at θ = 0 —
 * steel at 7.85 g/cm³ over the authored boxes, slender-rod bending
 * inertias about each link's own COG. kg·m² on the tensor (the door's
 * unit), grams on the mass, mm on the COG.
 */
function sliderDemoMasses(): readonly MassTwinEntry[] {
  const densityGPerMm3 = 7.85e-3;
  const link = (
    occurrenceId: OccurrenceId,
    massGrams: number,
    lengthM: number,
    cogXMm: number,
  ): MassTwinEntry => {
    const massKg = massGrams / 1000;
    // The slender rod about its OWN COG: I = m·L²/12 (isotropic on the
    // bending and polar axes alike). The wire's tensor is the
    // COG-frame value — the dynamics door applies the parallel-axis
    // shift from the COG to the joint itself, so authoring the end
    // inertia (m·L²/3) here would double-shift it.
    const inertia = (massKg * lengthM * lengthM) / 12;
    return {
      occurrenceId,
      massGrams,
      centerOfGravityMm: [cogXMm, 0, 0],
      inertiaTensorKgM2: [inertia, 0, 0, 0, inertia, 0, 0, 0, inertia],
    };
  };
  const crankBox = SLIDER_DEMO.crankRadiusMm * 12 * SLIDER_DEMO.linkThicknessMm;
  const rodBox =
    SLIDER_DEMO.rodLengthMm * 10 * (SLIDER_DEMO.linkThicknessMm - 1);
  const pistonBox =
    2 *
    SLIDER_DEMO.pistonHalfXMm *
    2 *
    SLIDER_DEMO.pistonHalfYMm *
    SLIDER_DEMO.pistonThicknessMm;
  const baseBox = 150 * 60 * 4;
  return [
    link(SLIDER_OCCURRENCE_IDS.base, baseBox * densityGPerMm3, 0.15, 65),
    link(
      SLIDER_OCCURRENCE_IDS.crank,
      crankBox * densityGPerMm3,
      SLIDER_DEMO.crankRadiusMm / 1000,
      SLIDER_DEMO.crankRadiusMm / 2,
    ),
    link(
      SLIDER_OCCURRENCE_IDS.rod,
      rodBox * densityGPerMm3,
      SLIDER_DEMO.rodLengthMm / 1000,
      SLIDER_DEMO.crankRadiusMm + SLIDER_DEMO.rodLengthMm / 2,
    ),
    link(
      SLIDER_OCCURRENCE_IDS.piston,
      pistonBox * densityGPerMm3,
      (2 * SLIDER_DEMO.pistonHalfXMm) / 1000,
      SLIDER_DEMO.crankRadiusMm + SLIDER_DEMO.rodLengthMm,
    ),
  ];
}

/**
 * The demo document: the slider-crank bodies as occurrences joined by
 * the mechanism's joint records, plus the demo motor record. Pure and
 * deterministic (the compile walk and every add are), computed once
 * per call site — the sim-demo-body precedent.
 */
export function sliderCrankDemoDocument(): CadDocument {
  const compiled = compileModel(SliderCrankModel());
  if (!compiled.ok) {
    throw new Error(
      `The slider-crank model failed to compile: ${compiled.error.code}: ${compiled.error.message}`,
    );
  }
  const applied = applySessionTransaction(
    createSession(createDocument(createDocumentId(SLIDER_DEMO_DOCUMENT_ID))),
    compiled.value,
  );
  if (!applied.ok) {
    throw new Error(
      `The slider-crank transaction did not apply to a fresh document: ${applied.error.message}`,
    );
  }
  let document = applied.value.document;
  const at = (
    id: OccurrenceId,
    name: string,
    bodyId: BodyId,
    translation: readonly [number, number, number],
  ): void => {
    const placed = addOccurrence(document, {
      id,
      name,
      source: { kind: "body", bodyId },
      placement: { kind: "offset", translation },
    });
    if (!placed.ok) {
      throw new Error(
        `The ${name} occurrence did not apply: ${placed.error.message}`,
      );
    }
    document = placed.value.document;
  };
  at(
    SLIDER_OCCURRENCE_IDS.base,
    "base plate",
    bodyIdOf("body_base", "base"),
    [0, 0, 0],
  );
  at(
    SLIDER_OCCURRENCE_IDS.crank,
    "crank",
    bodyIdOf("body_crank", "crank"),
    [0, 0, 0],
  );
  at(SLIDER_OCCURRENCE_IDS.rod, "connecting rod", bodyIdOf("body_rod", "rod"), [
    SLIDER_DEMO.crankRadiusMm,
    0,
    0,
  ]);
  at(
    SLIDER_OCCURRENCE_IDS.piston,
    "piston",
    bodyIdOf("body_piston", "piston"),
    [SLIDER_DEMO.crankRadiusMm + SLIDER_DEMO.rodLengthMm, 0, 0],
  );

  const friction = {
    viscousDampingNPerMSPerRad: SLIDER_DEMO.viscousDampingNPerMSPerRad,
    frictionLossNPerM: SLIDER_DEMO.frictionLossNPerM,
  };
  const join = (input: Parameters<typeof addJoint>[1], what: string): void => {
    const joined = addJoint(document, input);
    if (!joined.ok) {
      throw new Error(`The ${what} did not apply: ${joined.error.message}`);
    }
    document = joined.value.document;
  };
  join(
    {
      id: SLIDER_JOINT_IDS.crank,
      name: "Crank main bearing",
      kind: "revolute",
      baseOccurrenceId: SLIDER_OCCURRENCE_IDS.base,
      occurrenceId: SLIDER_OCCURRENCE_IDS.crank,
      frame: { origin: [0, 0, 0], axis: [0, 0, 1] },
      ...friction,
    },
    "crank main bearing",
  );
  join(
    {
      id: SLIDER_JOINT_IDS.conrod,
      name: "Crank pin",
      kind: "revolute",
      baseOccurrenceId: SLIDER_OCCURRENCE_IDS.crank,
      occurrenceId: SLIDER_OCCURRENCE_IDS.rod,
      frame: { origin: [SLIDER_DEMO.crankRadiusMm, 0, 0], axis: [0, 0, 1] },
      ...friction,
    },
    "crank pin",
  );
  join(
    {
      id: SLIDER_JOINT_IDS.slide,
      name: "Piston line",
      kind: "slider",
      baseOccurrenceId: SLIDER_OCCURRENCE_IDS.base,
      occurrenceId: SLIDER_OCCURRENCE_IDS.piston,
      frame: {
        origin: [SLIDER_DEMO.crankRadiusMm + SLIDER_DEMO.rodLengthMm, 0, 0],
        axis: [1, 0, 0],
      },
    },
    "piston line",
  );
  // The wrist pin CLOSES THE LOOP: the piston already has its tree
  // parent (the slider), and the kernel declines friction on a closing
  // joint loudly — the record authors none, the stated posture.
  join(
    {
      id: SLIDER_JOINT_IDS.wrist,
      name: "Wrist pin",
      kind: "revolute",
      baseOccurrenceId: SLIDER_OCCURRENCE_IDS.rod,
      occurrenceId: SLIDER_OCCURRENCE_IDS.piston,
      frame: { origin: [SLIDER_DEMO.rodLengthMm, 0, 0], axis: [0, 0, 1] },
    },
    "wrist pin",
  );

  const withMotor = addDocumentMotor(document, {
    id: SLIDER_DEMO_MOTOR_ID,
    ...SLIDER_DEMO_MOTOR_INPUT,
  });
  if (!withMotor.ok) {
    throw new Error(
      `The demo motor record did not apply: ${withMotor.error.message}`,
    );
  }
  return withMotor.value.document;
}

/** The canonical serialized wire of one joint record (the door's keys). */
function jointWireOf(joint: DocumentJoint): Record<string, unknown> {
  return {
    id: joint.id,
    name: joint.name,
    kind: joint.kind,
    baseOccurrenceId: joint.baseOccurrenceId,
    occurrenceId: joint.occurrenceId,
    ...(joint.frame === undefined
      ? {}
      : {
          frame: {
            origin: [...joint.frame.origin],
            ...(joint.frame.axis === undefined
              ? {}
              : { axis: [...joint.frame.axis] }),
          },
        }),
    ...(joint.viscousDampingNPerMSPerRad === undefined
      ? {}
      : { viscousDampingNPerMSPerRad: joint.viscousDampingNPerMSPerRad }),
    ...(joint.frictionLossNPerM === undefined
      ? {}
      : { frictionLossNPerM: joint.frictionLossNPerM }),
  };
}

/**
 * The demo mechanism wire (the compile's `mechanism` seam): the
 * document's resolved occurrence placements, the serialized joint
 * records, the mass twin, and the grounded base — the exact
 * `DynamicsBuildInput` document half. Pure over the document.
 */
export function sliderCrankMechanismWire(
  document: CadDocument,
): SimMechanismWire {
  const resolution = resolveAssemblyInstances(document);
  if (!resolution.ok) {
    throw new Error(
      `The slider-crank occurrences did not resolve: ${resolution.error.message}`,
    );
  }
  const occurrences = resolution.instances.map((instance) => ({
    id: instance.path[0] as string,
    placement: {
      rotation: [...instance.transform.rotation],
      translation: [...instance.transform.translation] as [
        number,
        number,
        number,
      ],
    },
  }));
  return {
    occurrences,
    joints: document.joints.map(jointWireOf),
    masses: sliderDemoMasses(),
    grounded: [SLIDER_OCCURRENCE_IDS.base],
  };
}

/** The demo scenario draft — the dynamics form's defaults, one source. */
export function sliderCrankDemoScenarioDraft(): SimScenarioDraft {
  return {
    name: "slider-crank",
    kind: "dynamics",
    domain: {
      kind: "explicit",
      min: [-20, -40, -12],
      max: [150, 40, 12],
      resolutionMm: 2,
    },
    conditions: [],
    fluid: "air",
    dynamics: {
      timeStepS: SLIDER_DEMO.timeStepS,
      durationS: SLIDER_DEMO.durationS,
      sampleIntervalS: SLIDER_DEMO.sampleIntervalS,
      motorJointId: SLIDER_JOINT_IDS.crank,
    },
    motorId: SLIDER_DEMO_MOTOR_ID,
  };
}

/** Adds the demo scenario to a document (the page's boot convenience). */
export function addSliderCrankDemoScenario(document: CadDocument): {
  readonly document: CadDocument;
  readonly scenarioName: string;
} {
  const added = addDocumentSimulation(document, sliderCrankDemoScenarioDraft());
  if (!added.ok) {
    throw new Error(
      `The demo dynamics scenario did not apply: ${added.error.message}`,
    );
  }
  return {
    document: added.value.document,
    scenarioName: added.value.scenario.name,
  };
}
