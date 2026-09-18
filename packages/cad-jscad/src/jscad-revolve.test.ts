/**
 * JSCAD adapter's revolve-specific tests (Phase 26.2): the probe-backed
 * behaviors the shared contract suite cannot pin per kernel — the measured
 * inscribed-chord band of the 63-segment rotate-extrude (partial sweeps
 * carry the library's proportional segment scaling), the sweep-start
 * convention rebased onto the contract's axis frame, and the silent-capping
 * honesty: `extrudeRotate`'s only overflow behaviour caps points beyond the
 * axis, so the crossing rejection must run BEFORE the library.
 */

import { describe, expect, it } from "vitest";
import { angle, length } from "@slopcad/cad-core";
import { type GeometryKernel, KERNEL_ERROR_CODES } from "@slopcad/cad-kernel";
import {
  assertBoundsEqual,
  assertVolumeClose,
  expectKernelFailure,
  unwrapKernelResult,
} from "@slopcad/cad-kernel/test-utils";

import { createJscadKernel } from "./jscad-kernel";

const kernel: GeometryKernel = createJscadKernel();

const identityPlacement = {
  rotation: { axis: [0, 0, 1] as const, angle: angle(0) },
  translation: { x: length(0), y: length(0), z: length(0) },
};

function touchingRectangleRevolve(
  sweepRad: number,
): Parameters<GeometryKernel["revolve"]>[0] {
  return {
    loop: [
      { kind: "line", start: [0, 0], end: [30, 0] },
      { kind: "line", start: [30, 0], end: [30, 25] },
      { kind: "line", start: [30, 25], end: [0, 25] },
      { kind: "line", start: [0, 25], end: [0, 0] },
    ],
    axis: { point: [0, 0], direction: [1, 0] },
    angle: angle(sweepRad, "rad"),
    placement: identityPlacement,
  };
}

describe("jscad revolve", () => {
  it("deviates from the analytic cylinder by at most the documented chord band (measured ≈0.166%)", () => {
    const solid = unwrapKernelResult(
      kernel.revolve(touchingRectangleRevolve(Math.PI * 2)),
      "full revolve",
    );
    const analytic = Math.PI * 25 ** 2 * 30;
    const measured = unwrapKernelResult(kernel.volume(solid), "volume");
    // Probed at the 63-segment resolution: 58807.259 vs 58904.862 — the
    // same inscribed-chord band the extrude path documents.
    assertVolumeClose(measured, analytic, 0.003);
    expect(measured).toBeLessThan(analytic);
    expect(measured).toBeGreaterThan(analytic * 0.998);
  });

  it("sweeps the quarter turn into the +v/+w quadrant with the Pappus volume", () => {
    const solid = unwrapKernelResult(
      kernel.revolve(touchingRectangleRevolve(Math.PI / 2)),
      "quarter revolve",
    );
    assertVolumeClose(
      unwrapKernelResult(kernel.volume(solid), "quarter volume"),
      (Math.PI * 25 ** 2 * 30) / 4,
      0.003,
    );
    assertBoundsEqual(
      unwrapKernelResult(kernel.bounds(solid), "quarter bounds"),
      { min: [0, 0, 0], max: [30, 25, 25] },
      1e-6,
    );
  });

  it("half-turn volume is the full turn's half within the chord band", () => {
    const full = unwrapKernelResult(
      kernel.volume(
        unwrapKernelResult(
          kernel.revolve(touchingRectangleRevolve(Math.PI * 2)),
          "full",
        ),
      ),
      "full volume",
    );
    const half = unwrapKernelResult(
      kernel.volume(
        unwrapKernelResult(
          kernel.revolve(touchingRectangleRevolve(Math.PI)),
          "half",
        ),
      ),
      "half volume",
    );
    expect(Math.abs(half - full / 2) / (full / 2)).toBeLessThan(0.003);
  });

  it("places the revolution: rotation about the world origin first, translation second", () => {
    const solid = unwrapKernelResult(
      kernel.revolve({
        loop: touchingRectangleRevolve(Math.PI * 2).loop,
        axis: { point: [0, 0], direction: [1, 0] },
        angle: angle(Math.PI * 2, "rad"),
        placement: {
          rotation: { axis: [0, 0, 1], angle: angle(Math.PI / 2) },
          translation: { x: length(5), y: length(5), z: length(0) },
        },
      }),
      "placed revolve",
    );
    assertBoundsEqual(
      unwrapKernelResult(kernel.bounds(solid), "placed bounds"),
      { min: [-20, 5, -25], max: [30, 35, 25] },
      0.05,
    );
  });

  it("rejects a crossing profile with the structured code BEFORE JSCAD can silently cap it", () => {
    // extrudeRotate's overflow='cap' would clamp the negative-radial half
    // onto the axis without any diagnostic (probed in the library source);
    // the shared validator must reject it first.
    const failure = expectKernelFailure(
      kernel.revolve({
        loop: [
          { kind: "line", start: [0, -10], end: [30, -10] },
          { kind: "line", start: [30, -10], end: [30, 25] },
          { kind: "line", start: [30, 25], end: [0, 25] },
          { kind: "line", start: [0, 25], end: [0, -10] },
        ],
        axis: { point: [0, 0], direction: [1, 0] },
        angle: angle(Math.PI * 2, "rad"),
        placement: identityPlacement,
      }),
      KERNEL_ERROR_CODES.profileAxisCrossing,
      "crossing revolve",
    );
    expect(failure.message).toContain("crosses");
  });
});
