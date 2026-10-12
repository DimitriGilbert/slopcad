/**
 * The mechanism-motion surface's tests (Phase 67c): the pure
 * derivation over a completed dynamics run — the joint histories
 * drive `applyMotionJoint` (the assembly-motion surface's own
 * function, degrees on the revolute, millimetres on the slider) and
 * the poses follow the slider-crank closure (the rod's far end
 * meeting the piston's pin on the centreline at every sample) — and
 * the panel renders the scrub surface deterministically.
 */

import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { SimResult } from "@slopcad/sim-core";

import { MechanismMotionPanel, mechanismMotionOf } from "./mechanism-motion";
import { SLIDER_DEMO, SLIDER_JOINT_IDS } from "./slider-crank-demo";

afterEach(cleanup);

/** The closure relation: the piston pin's x at a crank angle, mm. */
function pistonPinXMm(crankAngleRad: number): number {
  const r = SLIDER_DEMO.crankRadiusMm;
  const l = SLIDER_DEMO.rodLengthMm;
  return (
    r * Math.cos(crankAngleRad) +
    Math.sqrt(Math.max(0, l * l - r * r * Math.sin(crankAngleRad) ** 2))
  );
}

/** A result shaped like the dynamics engine's histories. */
function motionResult(): SimResult {
  const times: number[] = [];
  const crank: number[] = [];
  const conrod: number[] = [];
  const slide: number[] = [];
  const r = SLIDER_DEMO.crankRadiusMm / 1000;
  const l = SLIDER_DEMO.rodLengthMm / 1000;
  for (let index = 0; index < 8; index += 1) {
    const theta = (index / 8) * 2 * Math.PI * 0.75;
    times.push(index * 0.04);
    crank.push(theta);
    // The conrod's relative angle: the closure's rod angle minus θ.
    const pinX = r * Math.cos(theta);
    const pinY = r * Math.sin(theta);
    const pistonX =
      r * Math.cos(theta) +
      Math.sqrt(Math.max(0, l * l - r * r * Math.sin(theta) ** 2));
    const rodAngle = Math.atan2(-pinY, pistonX - pinX);
    conrod.push(rodAngle - theta);
    slide.push(pistonX - (r + l));
  }
  return {
    summary: {
      schemaVersion: 1,
      scenarioSnapshotHash: "motion-test",
      status: "completed",
      regime: { qualitative: [] },
      quantities: [],
    },
    fields: [],
    histories: [
      { name: "time", unit: "s", samples: times },
      {
        name: `joint:${String(SLIDER_JOINT_IDS.crank)}:dof0:position`,
        unit: "rad",
        samples: crank,
      },
      {
        name: `joint:${String(SLIDER_JOINT_IDS.conrod)}:dof0:position`,
        unit: "rad",
        samples: conrod,
      },
      {
        name: `joint:${String(SLIDER_JOINT_IDS.slide)}:dof0:position`,
        unit: "m",
        samples: slide,
      },
    ],
  };
}

describe("the mechanism-motion derivation", () => {
  it("derives one pose per sample, the rod meeting the piston pin", () => {
    const motion = mechanismMotionOf(motionResult());
    if (motion === null) throw new Error("the motion derivation declined");
    expect(motion.poses).toHaveLength(8);
    // The ROD's far edge midpoint (corners 1 and 2 sit at the far end)
    // must meet the PISTON's centreline position at every sample —
    // the closure the assembly-motion composition preserves.
    for (const [index, pose] of motion.poses.entries()) {
      const rodFar = ((pose.rod[1]?.[0] ?? 0) + (pose.rod[2]?.[0] ?? 0)) / 2;
      const rodFarY = ((pose.rod[1]?.[1] ?? 0) + (pose.rod[2]?.[1] ?? 0)) / 2;
      const crankAngle = motion.crankAngleRad[index] ?? 0;
      // Back to world mm from the panel's pixels.
      const worldX = (rodFar - 30) / 1.8;
      const worldY = (75 - rodFarY) / 1.8;
      expect(Math.abs(worldY)).toBeLessThan(1e-6);
      expect(Math.abs(worldX - pistonPinXMm(crankAngle))).toBeLessThan(1e-6);
    }
  });

  it("declines a result without the joint histories", () => {
    const result = motionResult();
    const stripped: SimResult = {
      ...result,
      histories: result.histories.filter((series) => series.name !== "time"),
    };
    expect(mechanismMotionOf(stripped)).toBeNull();
  });
});

describe("the mechanism-motion panel", () => {
  it("renders the scrub surface deterministically", () => {
    const motion = mechanismMotionOf(motionResult());
    if (motion === null) throw new Error("the motion derivation declined");
    const rendered = render(<MechanismMotionPanel motion={motion} />);
    const svg = rendered.getByTestId("workbench-sim-mechanism-motion");
    expect(svg).toBeDefined();
    const surface = rendered.container.querySelector("svg");
    if (surface === null) throw new Error("the panel carries no svg");
    expect(surface.getAttribute("data-sim-motion-sample")).toBe("0");
    expect(surface.getAttribute("data-sim-motion-samples")).toBe("8");
    const scrub = rendered.getByTestId("workbench-sim-motion-scrub");
    fireEvent.change(scrub, { target: { value: "5" } });
    expect(surface.getAttribute("data-sim-motion-sample")).toBe("5");
    const crankDeg = Number(
      surface.getAttribute("data-sim-motion-crank-deg") ?? "0",
    );
    expect(crankDeg).toBeCloseTo(
      ((motion.crankAngleRad[5] ?? 0) * 180) / Math.PI,
      3,
    );
    // Scrubbing back is deterministic (the same sample, the same pose).
    fireEvent.change(scrub, { target: { value: "0" } });
    expect(surface.getAttribute("data-sim-motion-sample")).toBe("0");
  });
});
