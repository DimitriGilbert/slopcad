/**
 * The slider-crank demo's fixture test (Phase 67c): the demo document
 * carries the mechanism as document records — the four placed
 * occurrences, the four joint records (the wrist pin CLOSING the
 * loop), the demo motor — and the mechanism wire derived from it
 * COMPILES through the real dynamics door and SOLVES one closed step:
 * the exact pairing discipline the fan demo's fixture keeps between
 * the demo motor and the demo geometry as either evolves.
 */

import { describe, expect, it } from "vitest";
import { createDynamicsEngine } from "@slopcad/sim-dynamics";
import { serializeSimScenario, addDocumentSimulation } from "@slopcad/cad-core";

import {
  SLIDER_DEMO_MOTOR_ID,
  SLIDER_JOINT_IDS,
  SLIDER_OCCURRENCE_IDS,
  addSliderCrankDemoScenario,
  sliderCrankDemoDocument,
  sliderCrankDemoScenarioDraft,
  sliderCrankMechanismWire,
} from "./slider-crank-demo";

describe("the slider-crank demo fixture", () => {
  it("the demo document carries the occurrences, joints, and motor", () => {
    const document = sliderCrankDemoDocument();
    expect(document.occurrences.map((occurrence) => occurrence.id)).toEqual([
      SLIDER_OCCURRENCE_IDS.base,
      SLIDER_OCCURRENCE_IDS.crank,
      SLIDER_OCCURRENCE_IDS.rod,
      SLIDER_OCCURRENCE_IDS.piston,
    ]);
    expect(document.joints.map((joint) => joint.id)).toEqual([
      SLIDER_JOINT_IDS.crank,
      SLIDER_JOINT_IDS.conrod,
      SLIDER_JOINT_IDS.slide,
      SLIDER_JOINT_IDS.wrist,
    ]);
    // The friction fields ride the tree revolutes only — the closing
    // wrist pin carries none (the kernel's loud decline posture).
    for (const joint of document.joints) {
      if (joint.id === SLIDER_JOINT_IDS.wrist) {
        expect(joint.viscousDampingNPerMSPerRad).toBeUndefined();
        expect(joint.frictionLossNPerM).toBeUndefined();
      } else if (joint.kind === "revolute") {
        expect(joint.viscousDampingNPerMSPerRad).toBeDefined();
        expect(joint.frictionLossNPerM).toBeDefined();
      }
    }
    expect(document.motors.map((motor) => motor.id)).toContain(
      SLIDER_DEMO_MOTOR_ID,
    );
  });

  it("the mechanism wire compiles through the real dynamics door", async () => {
    const document = sliderCrankDemoDocument();
    const wire = sliderCrankMechanismWire(document);
    expect(wire.occurrences).toHaveLength(4);
    expect(wire.joints).toHaveLength(4);
    expect(wire.masses).toHaveLength(4);
    expect(wire.grounded).toEqual([SLIDER_OCCURRENCE_IDS.base]);
    const engine = await createDynamicsEngine();
    if (!engine.ok) throw new Error(engine.error.message);
    // The wire arrays cross to the door's typed input as the trust-
    // boundary handoff the dynamics engine performs (the door
    // re-validates every field of every entry — its own stance).
    const built = engine.value.build({
      occurrences: wire.occurrences as Parameters<
        typeof engine.value.build
      >[0]["occurrences"],
      joints: wire.joints,
      masses: wire.masses as Parameters<typeof engine.value.build>[0]["masses"],
      ...(wire.grounded === undefined ? {} : { grounded: wire.grounded }),
      gravityMPerS2: [0, -9.80665, 0],
      motors: [
        {
          jointId: SLIDER_JOINT_IDS.crank,
          motor: document.motors.find(
            (motor) => motor.id === SLIDER_DEMO_MOTOR_ID,
          ),
        },
      ],
    });
    expect(built.ok).toBe(true);
    if (!built.ok) throw new Error(built.error.message);
    // Planar 1-DOF by Grübler: the built system's TREE carries 3 drive
    // DOFs (crank revolute + conrod revolute + slide) and ONE closing
    // loop joint (the wrist pin) whose two constraints remove two of
    // them — the classic single mechanism DOF the march integrates.
    expect(built.value.bodyCount).toBe(4);
    expect(built.value.loopJointCount).toBe(1);
    expect(built.value.dofCount).toBe(3);
    const stepped = built.value.step({ timeStepS: 0.001 });
    expect(stepped.ok).toBe(true);
    if (!stepped.ok) throw new Error(stepped.error.message);
    expect(stepped.value.solver.loopResidual).toBeLessThan(1e-9);
  });

  it("the demo scenario applies over the demo document", () => {
    const document = sliderCrankDemoDocument();
    const withScenario = addSliderCrankDemoScenario(document);
    expect(withScenario.scenarioName).toBe("slider-crank");
    const scenario = document.simulations.length;
    expect(scenario).toBe(0);
    const added = addSliderCrankDemoScenario(document);
    expect(added.document.simulations).toHaveLength(1);
    // The serialized record round-trips through the document wire.
    const addedScenario = added.document.simulations[0];
    if (addedScenario === undefined) {
      throw new Error("the scenario add produced no simulations row");
    }
    const serialized = serializeSimScenario(addedScenario);
    expect(serialized.kind).toBe("dynamics");
    expect(serialized.dynamics?.timeStepS).toBe(0.001);
    expect(serialized.dynamics?.durationS).toBe(2);
    expect(serialized.dynamics?.sampleIntervalS).toBe(0.04);
    expect(serialized.motorId).toBe(SLIDER_DEMO_MOTOR_ID);
  });

  it("the draft carries no provider (the reference default)", () => {
    const draft = sliderCrankDemoScenarioDraft();
    expect(draft.dynamics?.provider).toBeUndefined();
    const document = sliderCrankDemoDocument();
    const added = addDocumentSimulation(document, draft);
    expect(added.ok).toBe(true);
  });
});
