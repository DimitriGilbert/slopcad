/**
 * Cross-compatibility pins against `@slopcad/cad-core` (Phase 67a): the
 * sim-dynamics restatements are only honest while they stay pinned to
 * the document model — the joint vocabulary (same members, same
 * order), the additive friction fields through the true document
 * serialize→parse round trip, the exponential map BITWISE against the
 * mate solver's rotation-vector map, the door declining what cad-core
 * declines, and the motor door agreeing with sim-core's scenario
 * compile. The cad-core import is dev-only: it appears in no runtime
 * graph of sim-dynamics, exactly as the sim-core vocabulary pins do.
 */

import {
  addBody,
  addDocumentMotor,
  addJoint,
  addOccurrence,
  createDocument,
  createDocumentId,
  createJointId,
  createOccurrenceId,
  IDENTITY_PLACEMENT_TRANSFORM,
  JOINT_KINDS,
  MATE_MAX_ITERATIONS,
  MATE_RESIDUAL_TOLERANCE,
  rotationVectorToMatrix,
  serializeCadDocument,
  solveAssemblyMates,
  type DocumentJoint,
  type PlacementTransform,
} from "@slopcad/cad-core";
import { compileSimScenario } from "@slopcad/sim-core";
import { describe, expect, it } from "vitest";
import type { DoorJointKind } from "./door";

import { compileMechanism } from "./door";
import { mustBuild, mustStep, pendulumBuild } from "./fixtures";
import { DYNAMICS_JOINT_KINDS, auxiliaryBasis, jointDofLayout } from "./joints";
import {
  LOOP_CLOSURE_TOLERANCE,
  LOOP_LM_MAX_ITERATIONS,
  loopRowsAndDuals,
  worstResidual,
} from "./loop-closure";
import {
  IDENTITY_MAT3,
  expRotation,
  mulMat3,
  mulMat3Vec,
  type Vec3,
  rotationAboutUnitAxis,
  sub3,
} from "./spatial";

describe("the joint vocabulary pin", () => {
  it("restates cad-core's JOINT_KINDS exactly (members and order)", () => {
    expect(DYNAMICS_JOINT_KINDS.slice(0, JOINT_KINDS.length)).toEqual([
      ...JOINT_KINDS,
    ]);
    // `free` is the kernel-internal root joint and never crosses the wire.
    expect(DYNAMICS_JOINT_KINDS).toHaveLength(JOINT_KINDS.length + 1);
    expect(DYNAMICS_JOINT_KINDS[DYNAMICS_JOINT_KINDS.length - 1]).toBe("free");
  });
});

describe("the friction fields through the document round trip", () => {
  it("carries the additive fields from addJoint to the dynamics door", () => {
    let document = createDocument(createDocumentId("doc_dyn_pin"));
    const base = addBody(document, { name: "Base" });
    if (!base.ok) throw new Error(base.error.message);
    document = base.value.document;
    const lid = addBody(document, { name: "Lid" });
    if (!lid.ok) throw new Error(lid.error.message);
    document = lid.value.document;
    const baseOccurrence = addOccurrence(document, {
      name: "Base occurrence",
      source: { kind: "body", bodyId: base.value.body.id },
    });
    if (!baseOccurrence.ok) throw new Error(baseOccurrence.error.message);
    document = baseOccurrence.value.document;
    const lidOccurrence = addOccurrence(document, {
      name: "Lid occurrence",
      source: { kind: "body", bodyId: lid.value.body.id },
    });
    if (!lidOccurrence.ok) throw new Error(lidOccurrence.error.message);
    document = lidOccurrence.value.document;
    const joint = addJoint(document, {
      name: "Damped hinge",
      kind: "revolute",
      baseOccurrenceId: baseOccurrence.value.occurrence.id,
      occurrenceId: lidOccurrence.value.occurrence.id,
      frame: { origin: [0, 0, 0], axis: [0, 0, 1] },
      viscousDampingNPerMSPerRad: 0.002,
      frictionLossNPerM: 0.05,
    });
    if (!joint.ok) throw new Error(joint.error.message);
    const wire = JSON.parse(
      JSON.stringify(serializeCadDocument(joint.value.document)),
    ) as { joints?: readonly unknown[] };
    const compiled = compileMechanism({
      occurrences: [
        {
          id: baseOccurrence.value.occurrence.id,
          placement: {
            rotation: [1, 0, 0, 0, 1, 0, 0, 0, 1],
            translation: [0, 0, 0],
          },
        },
        {
          id: lidOccurrence.value.occurrence.id,
          placement: {
            rotation: [1, 0, 0, 0, 1, 0, 0, 0, 1],
            translation: [0, 0, 0],
          },
        },
      ],
      joints: [wire.joints?.[0]],
      masses: [
        {
          occurrenceId: baseOccurrence.value.occurrence.id,
          massGrams: 1000,
          centerOfGravityMm: [0, 0, 0],
        },
        {
          occurrenceId: lidOccurrence.value.occurrence.id,
          massGrams: 500,
          centerOfGravityMm: [80, 0, 0],
        },
      ],
      grounded: [baseOccurrence.value.occurrence.id],
      gravityMPerS2: [0, -9.80665, 0],
    });
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    expect(compiled.value.joints[0]?.viscousDamping).toBe(0.002);
    expect(compiled.value.joints[0]?.frictionLoss).toBe(0.05);
    // The joint endpoints survived the id round trip.
    expect(compiled.value.joints[0]?.baseId).toBe(
      baseOccurrence.value.occurrence.id,
    );
    expect(compiled.value.joints[0]?.movedId).toBe(
      lidOccurrence.value.occurrence.id,
    );
  });

  it("declines the joint wire cad-core declines (negative friction)", () => {
    const compiled = compileMechanism({
      occurrences: [
        {
          id: "a",
          placement: {
            rotation: [1, 0, 0, 0, 1, 0, 0, 0, 1],
            translation: [0, 0, 0],
          },
        },
        {
          id: "b",
          placement: {
            rotation: [1, 0, 0, 0, 1, 0, 0, 0, 1],
            translation: [0, 0, 0],
          },
        },
      ],
      joints: [
        {
          id: "j",
          name: "J",
          kind: "revolute",
          baseOccurrenceId: "a",
          occurrenceId: "b",
          frame: { origin: [0, 0, 0], axis: [0, 0, 1] },
          frictionLossNPerM: -1,
        },
      ],
      masses: [
        { occurrenceId: "a", massGrams: 1000, centerOfGravityMm: [0, 0, 0] },
        { occurrenceId: "b", massGrams: 500, centerOfGravityMm: [80, 0, 0] },
      ],
      grounded: ["a"],
      gravityMPerS2: [0, -9.80665, 0],
    });
    expect(compiled.ok).toBe(false);
    if (compiled.ok) return;
    expect(compiled.error.code).toBe("sim/mechanism-invalid");
  });
});

describe("the exponential-map bitwise pin", () => {
  it("matches the mate solver's rotation-vector map bitwise", () => {
    const vectors: readonly (readonly [number, number, number])[] = [
      [0, 0, 0],
      [0, 0, 0.5],
      [1e-9, 0, 0],
      [0.3, -0.8, 0.5],
      [2.5, 0.1, -1.4],
      [-3.1, 2.2, 0.05],
    ];
    for (const vector of vectors) {
      const own = expRotation(vector);
      const theirs = rotationVectorToMatrix(vector);
      expect([...own]).toEqual([...theirs]);
    }
  });
});

describe("the motor door agreement with sim-core's scenario compile", () => {
  it("compiles the same record to the same SI torque view", () => {
    let document = createDocument(createDocumentId("doc_motor_pin"));
    const body = addBody(document, { name: "Fan" });
    if (!body.ok) throw new Error(body.error.message);
    document = body.value.document;
    const motor = addDocumentMotor(document, {
      name: "Fan drive",
      kind: "dc-brushed",
      stallTorqueMNm: 120,
      noLoadSpeedRpm: 5000,
      nominalVoltageV: 24,
      rotorInertiaKgM2: 0.002,
    });
    if (!motor.ok) throw new Error(motor.error.message);
    const wire = JSON.parse(
      JSON.stringify(serializeCadDocument(motor.value.document)),
    ) as { motors?: readonly unknown[] };
    const motorWire = wire.motors?.[0];
    if (motorWire === undefined) throw new Error("the motor did not serialize");
    // The dynamics door path: compileMechanism carries the motor through
    // sim-core's compileSimMotor.
    const compiled = compileMechanism({
      occurrences: [
        {
          id: "base",
          placement: {
            rotation: [1, 0, 0, 0, 1, 0, 0, 0, 1],
            translation: [0, 0, 0],
          },
        },
        {
          id: "rotor",
          placement: {
            rotation: [1, 0, 0, 0, 1, 0, 0, 0, 1],
            translation: [0, 0, 0],
          },
        },
      ],
      joints: [
        {
          id: "jnt_drive",
          name: "Drive",
          kind: "revolute",
          baseOccurrenceId: "base",
          occurrenceId: "rotor",
          frame: { origin: [0, 0, 0], axis: [0, 0, 1] },
        },
      ],
      masses: [
        { occurrenceId: "base", massGrams: 1000, centerOfGravityMm: [0, 0, 0] },
        {
          occurrenceId: "rotor",
          massGrams: 500,
          centerOfGravityMm: [0, 0, 0],
          inertiaTensorKgM2: [0.001, 0, 0, 0, 0.001, 0, 0, 0, 0.001],
        },
      ],
      grounded: ["base"],
      gravityMPerS2: [0, 0, 0],
      motors: [{ jointId: "jnt_drive", motor: motorWire }],
    });
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    const doorMotor = compiled.value.motors[0]?.motor;
    expect(doorMotor?.kind).toBe("dc-brushed");
    if (doorMotor?.kind !== "dc-brushed") return;
    // The scenario-compile path over the SAME record: motor values agree.
    const scenario = compileSimScenario({
      scenario: {
        id: "sim_pin",
        name: "Pin",
        kind: "flow",
        domain: {
          kind: "explicit",
          min: [-100, -100, -100],
          max: [100, 100, 100],
          resolutionMm: 10,
        },
        conditions: [
          {
            kind: "velocity-inlet",
            face: "xMin",
            speedMPerS: 1,
            direction: [1, 0, 0],
          },
        ],
        fluid: "air",
        materials: [],
        motorId: motor.value.motor.id,
      },
      motor: motorWire,
    });
    expect(scenario.ok).toBe(true);
    if (!scenario.ok) return;
    const scenarioMotor = scenario.value.motor;
    if (scenarioMotor === undefined || scenarioMotor.kind === "tabulated")
      return;
    expect(doorMotor.stallTorqueNPerM).toBe(scenarioMotor.stallTorqueNPerM);
    expect(doorMotor.noLoadSpeedRadPerS).toBe(scenarioMotor.noLoadSpeedRadPerS);
    expect(doorMotor.ktNPerA).toBe(scenarioMotor.ktNPerA);
  });
});

describe("the kernel against the mate-solver pose convention", () => {
  it("keeps the pendulum's zero station at the authored placement", () => {
    // The mates' conjugation: the joint's zero station reproduces the
    // moved body's INITIAL placement exactly — the kernel's FK at q = 0
    // must agree (the pose convention the loop rows and the motion
    // algebra both ride on).
    const system = mustBuild(
      pendulumBuild({ lengthM: 0.5, massKg: 1, theta0: 0.1 }),
    );
    const step = mustStep(system, { timeStepS: 0.000001 });
    const rod = step.occurrences.find((occurrence) => occurrence.id === "rod");
    expect(rod).toBeDefined();
    if (!rod) return;
    // After a vanishing step the rod's origin still sits at the joint
    // anchor (its frame origin = the pivot); its COG rides at L.
    expect(rod.translationMm[0]).toBeCloseTo(0, 6);
    expect(rod.translationMm[1]).toBeCloseTo(0, 6);
    expect(rod.centerOfGravityMm[0]).toBeCloseTo(0.5 * Math.sin(0.1) * 1000, 3);
    expect(rod.centerOfGravityMm[1]).toBeCloseTo(
      -0.5 * Math.cos(0.1) * 1000,
      3,
    );
  });
});

describe("the loop rows against cad-core's mate solve", () => {
  // The loop-closure module's claim, made true here: cad-core's
  // `solveAssemblyMates` drives each joint kind's rows (the same rows
  // `loopRowsAndDuals` restates in SI) to its zero station — this
  // projection must ACCEPT those poses, keep accepting along every
  // granted motion (the rows vanish for every configuration the joint
  // allows), and reject violations — and the LM discipline's constants
  // stay pinned to the mate solver's own.
  const OCC_BASE = createOccurrenceId("occ_loop_base");
  const OCC_MOVED = createOccurrenceId("occ_loop_moved");
  const FRAME_ORIGIN_MM: readonly [number, number, number] = [20, 10, 5];
  const FRAME_AXIS: readonly [number, number, number] = [0.3, 0.1, 0.94];
  const MOVED_INITIAL_ROTATION = rotationVectorToMatrix([0.21, -0.33, 0.12]);
  const MOVED_INITIAL_TRANSLATION_MM: readonly [number, number, number] = [
    14, -6, 33,
  ];

  const unitAxis = (): Vec3 => {
    const length = Math.hypot(FRAME_AXIS[0], FRAME_AXIS[1], FRAME_AXIS[2]);
    return [
      FRAME_AXIS[0] / length,
      FRAME_AXIS[1] / length,
      FRAME_AXIS[2] / length,
    ];
  };

  /** One kind's wire joint record, in the document's own shape. */
  const wireJointOf = (kind: DoorJointKind): DocumentJoint => ({
    id: createJointId(`jnt_loop_${kind}`),
    name: `Loop ${kind}`,
    kind,
    baseOccurrenceId: OCC_BASE,
    occurrenceId: OCC_MOVED,
    ...(kind === "rigid"
      ? {}
      : {
          frame: {
            origin: [...FRAME_ORIGIN_MM] as [number, number, number],
            ...(kind === "ball"
              ? {}
              : { axis: [...FRAME_AXIS] as [number, number, number] }),
          },
        }),
  });

  /** Runs the mate solve; returns the moved body's solved zero-station pose. */
  const solvedStation = (kind: DoorJointKind): PlacementTransform => {
    const result = solveAssemblyMates({
      occurrences: [OCC_BASE, OCC_MOVED],
      grounded: [OCC_BASE],
      mates: [],
      joints: [wireJointOf(kind)],
      initial: new Map([
        [OCC_BASE, IDENTITY_PLACEMENT_TRANSFORM],
        [
          OCC_MOVED,
          {
            rotation: MOVED_INITIAL_ROTATION,
            translation: [...MOVED_INITIAL_TRANSLATION_MM] as [
              number,
              number,
              number,
            ],
          },
        ],
      ]),
      anchors: new Map(),
    });
    expect(result.status).not.toBe("conflicting");
    expect(result.residual).toBeLessThanOrEqual(MATE_RESIDUAL_TOLERANCE);
    const solved = result.transforms.get(OCC_MOVED);
    if (solved === undefined) throw new Error("the mate solve moved nothing");
    return solved;
  };

  /** The restated loop rows (SI) of one kind at a moved pose (mm wire). */
  const ourRows = (
    kind: DoorJointKind,
    moved: PlacementTransform,
  ): readonly number[] => {
    const axis = unitAxis();
    const [e1, e2] = auxiliaryBasis(axis);
    const { rows } = loopRowsAndDuals(
      {
        id: `jnt_loop_${kind}`,
        kind,
        baseBodyIndex: 0,
        movedBodyIndex: 1,
        origin:
          kind === "rigid"
            ? ([0, 0, 0] as const)
            : ([
                FRAME_ORIGIN_MM[0] / 1000,
                FRAME_ORIGIN_MM[1] / 1000,
                FRAME_ORIGIN_MM[2] / 1000,
              ] as const),
        axis: kind === "rigid" || kind === "ball" ? undefined : axis,
        layout: jointDofLayout(kind, axis, e1, e2),
      },
      { r: IDENTITY_MAT3, t: [0, 0, 0] },
      {
        r: moved.rotation,
        t: [
          moved.translation[0] / 1000,
          moved.translation[1] / 1000,
          moved.translation[2] / 1000,
        ],
      },
    );
    return rows;
  };

  /** Rotates a pose about a world axis THROUGH the joint anchor (mm wire). */
  const rollPose = (
    pose: PlacementTransform,
    axis: Vec3,
    angle: number,
  ): PlacementTransform => {
    const rotation = rotationAboutUnitAxis(axis, angle);
    const anchor: Vec3 = [
      FRAME_ORIGIN_MM[0] / 1000,
      FRAME_ORIGIN_MM[1] / 1000,
      FRAME_ORIGIN_MM[2] / 1000,
    ];
    const around = sub3(
      [
        pose.translation[0] / 1000,
        pose.translation[1] / 1000,
        pose.translation[2] / 1000,
      ],
      anchor,
    );
    const rotated = mulMat3Vec(rotation, around);
    return {
      rotation: mulMat3(rotation, pose.rotation),
      translation: [
        (anchor[0] + rotated[0]) * 1000,
        (anchor[1] + rotated[1]) * 1000,
        (anchor[2] + rotated[2]) * 1000,
      ],
    };
  };

  /** Translates a pose by a world vector in metres (mm wire out). */
  const slidePose = (
    pose: PlacementTransform,
    direction: Vec3,
    meters: number,
  ): PlacementTransform => ({
    rotation: pose.rotation,
    translation: [
      pose.translation[0] + direction[0] * meters * 1000,
      pose.translation[1] + direction[1] * meters * 1000,
      pose.translation[2] + direction[2] * meters * 1000,
    ],
  });

  /** One granted motion of a kind applied to its solved pose. */
  const grantedPose = (
    kind: DoorJointKind,
    solved: PlacementTransform,
  ): PlacementTransform => {
    const axis = unitAxis();
    const [e1, e2] = auxiliaryBasis(axis);
    switch (kind) {
      case "rigid":
        return solved;
      case "revolute":
        return rollPose(solved, axis, 0.7);
      case "slider":
        return slidePose(solved, axis, 0.03);
      case "cylindrical":
        return slidePose(rollPose(solved, axis, 0.5), axis, 0.02);
      case "planar":
        return rollPose(
          slidePose(slidePose(solved, e1, 0.02), e2, -0.015),
          axis,
          0.4,
        );
      case "ball": {
        const vector: readonly [number, number, number] = [0.3, -0.2, 0.5];
        const length = Math.hypot(vector[0], vector[1], vector[2]);
        return rollPose(
          solved,
          [vector[0] / length, vector[1] / length, vector[2] / length],
          length,
        );
      }
    }
  };

  it("accepts the mate solve's zero stations, holds granted motion, rejects violations", () => {
    const kinds: readonly DoorJointKind[] = [
      "rigid",
      "revolute",
      "slider",
      "cylindrical",
      "planar",
      "ball",
    ];
    for (const kind of kinds) {
      const solved = solvedStation(kind);
      // The mate solver's zero station is closed under OUR rows too —
      // the same constraint, restated (linear rows in metres: the mate
      // residual's 1e-9 mm tolerance is 1e-12 m here).
      expect(worstResidual(ourRows(kind, solved))).toBeLessThan(
        LOOP_CLOSURE_TOLERANCE,
      );
      // Every GRANTED motion keeps the rows at zero (they measure only
      // violation; a false row here would fight the joint's motion).
      expect(
        worstResidual(ourRows(kind, grantedPose(kind, solved))),
      ).toBeLessThan(LOOP_CLOSURE_TOLERANCE);
      // A violation along a constrained direction is detected: the
      // planar normal for planar (its in-plane e1 is granted), e1 for
      // the rest.
      const axis = unitAxis();
      const [e1] = auxiliaryBasis(axis);
      const violationDirection = kind === "planar" ? axis : e1;
      const violated = slidePose(solved, violationDirection, 1e-6);
      expect(worstResidual(ourRows(kind, violated))).toBeGreaterThan(
        LOOP_CLOSURE_TOLERANCE,
      );
    }
  });

  it("pins the LM discipline constants to the mate solver's", () => {
    expect(LOOP_LM_MAX_ITERATIONS).toBe(MATE_MAX_ITERATIONS);
    // The closure tolerance is NOT the mate residual tolerance restated
    // in SI: the mate tolerance is 1e-9 mm, whose metre restatement is
    // 1e-12 m, while the dynamics closure holds 1e-9 m — 1000× looser
    // in SI terms, deliberately (dynamics closures are held inside the
    // step by Baumgarte stabilization plus projection, where a
    // nanometre band is already far below integration meaning; the mate
    // solver's tighter band is the document's persisted placement
    // truth). The two CONSTANTS pin to the same number, 1e-9, each in
    // its own unit — a coincidence of units, not parity, stated here so
    // a future change of either constant trips this pin consciously.
    expect(LOOP_CLOSURE_TOLERANCE).toBe(MATE_RESIDUAL_TOLERANCE);
    // And the units gap itself is pinned: expressed in the same unit
    // (metres), the dynamics band is exactly the mm→m factor above the
    // mate band (1e-9 m against 1e-12 m).
    expect(
      LOOP_CLOSURE_TOLERANCE / (MATE_RESIDUAL_TOLERANCE / 1000),
    ).toBeCloseTo(1000, 9);
  });
});

describe("the door's mass-property and placement contracts", () => {
  const buildWith = (
    rotation: readonly number[],
    inertiaTensorKgM2?: readonly number[],
  ): ReturnType<typeof compileMechanism> =>
    compileMechanism({
      occurrences: [
        {
          id: "a",
          placement: { rotation, translation: [0, 0, 0] },
        },
      ],
      joints: [],
      masses: [
        {
          occurrenceId: "a",
          massGrams: 1000,
          centerOfGravityMm: [0, 0, 0],
          ...(inertiaTensorKgM2 === undefined ? {} : { inertiaTensorKgM2 }),
        },
      ],
      gravityMPerS2: [0, 0, 0],
    });

  it("declines an indefinite inertia tensor with positive diagonals", () => {
    // Symmetric, positive diagonals, but the 2×2 principal minor
    // Ixx·Iyy − Ixy² < 0 (eigenvalues 0.03, −0.01, 0.01): a mass
    // distribution never carries a negative principal inertia — the
    // diagonal-only check would let this through.
    const compiled = buildWith(
      [1, 0, 0, 0, 1, 0, 0, 0, 1],
      [0.01, 0.02, 0, 0.02, 0.01, 0, 0, 0, 0.01],
    );
    expect(compiled.ok).toBe(false);
    if (compiled.ok) return;
    expect(compiled.error.code).toBe("sim/mechanism-invalid");
    expect(compiled.error.message).toContain("positive semidefinite");
  });

  it("accepts a singular PSD tensor (a point-mass rotor's zero eigenvalues)", () => {
    const compiled = buildWith(
      [1, 0, 0, 0, 1, 0, 0, 0, 1],
      [0, 0, 0, 0, 0, 0, 0, 0, 0.01],
    );
    expect(compiled.ok).toBe(true);
  });

  it("declines a reflection as a placement rotation (det = −1)", () => {
    // Orthonormal columns, but det = −1: a placement is a PROPER
    // rotation — orthonormality alone would admit the mirror.
    const compiled = buildWith([-1, 0, 0, 0, 1, 0, 0, 0, 1]);
    expect(compiled.ok).toBe(false);
    if (compiled.ok) return;
    expect(compiled.error.code).toBe("sim/mechanism-invalid");
    expect(compiled.error.message).toContain("orthonormal");
  });
});
