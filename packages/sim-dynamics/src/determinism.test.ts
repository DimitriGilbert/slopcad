/**
 * TS-kernel determinism (Phase 67a, law S2): two fresh engines over an
 * identical build and control sequence produce BITWISE-identical step
 * results — no tolerance, string equality on the full observation.
 */

import { describe, expect, it } from "vitest";

import { motorDragBuild, pendulumBuild } from "./fixtures";
import { createReferenceDynamicsEngine } from "./engine";

describe("TS-kernel determinism (bitwise)", () => {
  it("reproduces every step result of a friction pendulum bitwise", () => {
    const build = pendulumBuild({
      lengthM: 0.5,
      massKg: 1,
      theta0: 0.7,
      viscous: 0.01,
      frictionLoss: 0.02,
    });
    const run = (): string[] => {
      const system = createReferenceDynamicsEngine().build(build);
      if (!system.ok) throw new Error(system.error.message);
      const frames: string[] = [];
      for (let index = 0; index < 200; index += 1) {
        const step = system.value.step({ timeStepS: 0.001 });
        if (!step.ok) throw new Error(step.error.message);
        frames.push(JSON.stringify(step.value));
      }
      return frames;
    };
    const first = run();
    const second = run();
    expect(second.length).toBe(first.length);
    for (const [index, frame] of first.entries()) {
      expect(second[index]).toBe(frame);
    }
  });

  it("reproduces the motor-driven run bitwise including the motor state", () => {
    const build = motorDragBuild({
      inertiaKgM2: 0.02,
      viscous: 0.005,
      motor: {
        id: "mtr_det",
        name: "Determinism motor",
        kind: "dc-brushed",
        stallTorqueMNm: 100,
        noLoadSpeedRpm: 6000,
        nominalVoltageV: 12,
        rotorInertiaKgM2: 0.004,
      },
    });
    const run = (): string => {
      const system = createReferenceDynamicsEngine().build(build);
      if (!system.ok) throw new Error(system.error.message);
      let last = "";
      for (let index = 0; index < 300; index += 1) {
        const step = system.value.step({ timeStepS: 0.001 });
        if (!step.ok) throw new Error(step.error.message);
        last = JSON.stringify(step.value);
      }
      return last;
    };
    expect(run()).toBe(run());
  });
});
