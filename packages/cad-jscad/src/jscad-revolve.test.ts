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

  it("keeps a legal touching profile's quarter turn on the +v side when the touch vertex rounds to −ε", () => {
    // Oblique axis [1,1] through the origin: a vertex authored at decimal
    // coordinates (0.1 + 0.2, 0.3) reads signed radial −5.6e-17 — legal
    // touching under REVOLVE_AXIS_TOUCH_TOLERANCE_MM, but below an exact
    // `>= 0` side test, which would append the π-rotated −v placement and
    // put the quarter turn at z ∈ [−10, 0] instead of [0, 10].
    const r = Math.SQRT1_2;
    const u: readonly [number, number] = [r, r];
    const v: readonly [number, number] = [-r, r];
    const along = (
      p: readonly [number, number],
      q: readonly [number, number],
      k: number,
    ): [number, number] => [p[0] + k * q[0], p[1] + k * q[1]];
    const p1: readonly [number, number] = [0.1 + 0.2, 0.3];
    const p2 = along(p1, u, 20);
    const p3 = along(p2, v, 10);
    const p4 = along(p1, v, 10);
    const solid = unwrapKernelResult(
      kernel.revolve({
        loop: [
          { kind: "line", start: p1, end: p2 },
          { kind: "line", start: p2, end: p3 },
          { kind: "line", start: p3, end: p4 },
          { kind: "line", start: p4, end: p1 },
        ],
        axis: { point: [0, 0], direction: [1, 1] },
        angle: angle(Math.PI / 2, "rad"),
        placement: identityPlacement,
      }),
      "touching quarter revolve",
    );
    // Straight-line profile: the Pappus value is exact (200 mm² at centroid
    // distance 5 mm, swept π/2), within the rotate-extrude segment band.
    assertVolumeClose(
      unwrapKernelResult(kernel.volume(solid), "quarter volume"),
      200 * 5 * (Math.PI / 2),
      0.003,
    );
    const bounds = unwrapKernelResult(kernel.bounds(solid), "quarter bounds");
    expect(bounds.min[2]).toBeGreaterThanOrEqual(-1e-6);
    expect(bounds.max[2]).toBeGreaterThan(9);
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
