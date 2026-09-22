/**
 * The path-geometry walk's tests (Phase 43): analytic stations over the
 * sweep contract's line/arc chains — lengths, points, tangents, the
 * signed-sweep direction rule, and the clamped beyond-the-end walk.
 */

import { describe, expect, it } from "vitest";
import { angle } from "@slopcad/cad-core";
import type { SweepPathSegmentInput } from "./contract";

import { sweepPathStationAt, sweepPathTotalLength } from "./path-geometry";

const rad = (value: number) => angle(value, "rad");

/** Two-decimal comparison of a station's point and tangent. */
function expectClose(
  actual: readonly number[],
  expected: readonly number[],
  epsilon = 1e-12,
): void {
  expect(actual).toHaveLength(expected.length);
  for (let i = 0; i < expected.length; i += 1) {
    expect(Math.abs((actual[i] ?? 0) - (expected[i] ?? 0))).toBeLessThan(
      epsilon,
    );
  }
}

describe("sweepPathTotalLength", () => {
  it("sums a line chain: two 10 mm spans walking the diagonal", () => {
    const path: SweepPathSegmentInput[] = [
      { kind: "line", start: [0, 0], end: [6, 8] },
      { kind: "line", start: [6, 8], end: [6, 18] },
    ];
    expect(sweepPathTotalLength(path)).toBe(20);
  });

  it("measures an arc by its signed sweep's magnitude: r·|Δθ|", () => {
    const path: SweepPathSegmentInput[] = [
      {
        kind: "arc",
        center: [0, 10],
        radius: 10,
        startAngle: rad(Math.PI / 2),
        endAngle: rad(Math.PI),
      },
    ];
    expect(sweepPathTotalLength(path)).toBeCloseTo(10 * (Math.PI / 2), 12);
  });

  it("walks a negative (clockwise) sweep through the same magnitude", () => {
    const path: SweepPathSegmentInput[] = [
      {
        kind: "arc",
        center: [0, 10],
        radius: 10,
        startAngle: rad(Math.PI),
        endAngle: rad(Math.PI / 2),
      },
    ];
    expect(sweepPathTotalLength(path)).toBeCloseTo(10 * (Math.PI / 2), 12);
  });

  it("answers 0 for the empty chain", () => {
    expect(sweepPathTotalLength([])).toBe(0);
  });
});

describe("sweepPathStationAt: lines", () => {
  it("stations the vertical first span at s = 0, 5, 10", () => {
    const path: SweepPathSegmentInput[] = [
      { kind: "line", start: [0, 0], end: [0, 10] },
      { kind: "line", start: [0, 10], end: [10, 10] },
    ];
    expectClose(sweepPathStationAt(path, 0).point, [0, 0]);
    expectClose(sweepPathStationAt(path, 0).tangent, [0, 1]);
    expectClose(sweepPathStationAt(path, 5).point, [0, 5]);
    expectClose(sweepPathStationAt(path, 10).point, [0, 10]);
    // The joint answers the OUTGOING segment's tangent: +x.
    expectClose(sweepPathStationAt(path, 10).tangent, [1, 0]);
    expectClose(sweepPathStationAt(path, 15).point, [5, 10]);
  });

  it("stations along a diagonal line by its unit vector", () => {
    const path: SweepPathSegmentInput[] = [
      { kind: "line", start: [0, 0], end: [3, 4] },
    ];
    expectClose(sweepPathStationAt(path, 5).point, [3, 4]);
    expectClose(sweepPathStationAt(path, 2.5).point, [1.5, 2]);
    expectClose(sweepPathStationAt(path, 2.5).tangent, [0.6, 0.8]);
  });

  it("clamps beyond the end to the final station", () => {
    const path: SweepPathSegmentInput[] = [
      { kind: "line", start: [0, 0], end: [0, 10] },
    ];
    expectClose(sweepPathStationAt(path, 100).point, [0, 10]);
    expectClose(sweepPathStationAt(path, 100).tangent, [0, 1]);
    expectClose(sweepPathStationAt(path, -5).point, [0, 0]);
  });
});

describe("sweepPathStationAt: arcs", () => {
  it("stations a quarter turn counter-clockwise from +z to −x", () => {
    // The arc from θ = π/2 (top of the circle) to θ = π: the traveller at
    // θ = π/2 sits at (0, 10) with tangent (−1, 0) (counter-clockwise).
    const path: SweepPathSegmentInput[] = [
      {
        kind: "arc",
        center: [0, 0],
        radius: 10,
        startAngle: rad(Math.PI / 2),
        endAngle: rad(Math.PI),
      },
    ];
    const quarter = sweepPathStationAt(path, 0);
    expectClose(quarter.point, [0, 10]);
    expectClose(quarter.tangent, [-1, 0]);
    const half = sweepPathStationAt(path, 10 * (Math.PI / 4));
    expectClose(half.point, [
      10 * Math.cos((3 * Math.PI) / 4),
      10 * Math.sin((3 * Math.PI) / 4),
    ]);
    expectClose(half.tangent, [
      -Math.sin((3 * Math.PI) / 4),
      Math.cos((3 * Math.PI) / 4),
    ]);
    const end = sweepPathStationAt(path, 10 * (Math.PI / 2));
    expectClose(end.point, [-10, 0]);
    expectClose(end.tangent, [0, -1]);
  });

  it("reverses the tangent on a clockwise (negative) sweep", () => {
    const path: SweepPathSegmentInput[] = [
      {
        kind: "arc",
        center: [0, 0],
        radius: 10,
        startAngle: rad(Math.PI / 2),
        endAngle: rad(0),
      },
    ];
    const start = sweepPathStationAt(path, 0);
    expectClose(start.point, [0, 10]);
    expectClose(start.tangent, [1, 0]);
    const mid = sweepPathStationAt(path, 10 * (Math.PI / 4));
    expectClose(mid.point, [
      10 * Math.cos(Math.PI / 4),
      10 * Math.sin(Math.PI / 4),
    ]);
  });

  it("continues the walk across a line-into-arc joint", () => {
    // The sweep contract's canonical bend: 10 mm straight up, then the
    // quarter turn bending toward −x (positive sweep about the centre at
    // (−10, 10)): the traveller at (0, 10) heading +z.
    const path: SweepPathSegmentInput[] = [
      { kind: "line", start: [0, 0], end: [0, 10] },
      {
        kind: "arc",
        center: [-10, 10],
        radius: 10,
        startAngle: rad(0),
        endAngle: rad(Math.PI / 2),
      },
    ];
    // θ = 0 about (−10, 10): the point (0, 10), tangent (0, 1) — G1 with
    // the line's end, the joint the contract's rule pins.
    const joint = sweepPathStationAt(path, 10);
    expectClose(joint.point, [0, 10]);
    expectClose(joint.tangent, [0, 1]);
    const quarter = sweepPathStationAt(path, 10 + 10 * (Math.PI / 4));
    expectClose(quarter.point, [
      -10 + 10 * Math.cos(Math.PI / 4),
      10 + 10 * Math.sin(Math.PI / 4),
    ]);
    const end = sweepPathStationAt(path, 10 + 10 * (Math.PI / 2));
    expectClose(end.point, [-10, 20]);
    expectClose(end.tangent, [-1, 0]);
  });
});
