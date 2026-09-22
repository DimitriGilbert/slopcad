import { describe, expect, it } from "vitest";
import type { SerializedCurve } from "@slopcad/cad-core";

import {
  CURVE_EQUATION_STATIONS,
  canonicalizeCurve,
  curveBounds,
  curveLength,
  curvePointAt,
  curvePolyline,
  curveStations,
  evaluateWire,
  parallelTransportFrames,
  wireG1FailureIndex,
} from "./curve-geometry";
import { createFakeKernel } from "./fake-kernel";

const interpolated: SerializedCurve = {
  kind: "interpolated-spline",
  points: [
    [0, 0, 0],
    [10, 0, 0],
    [10, 10, 5],
  ],
};

const helix: SerializedCurve = {
  kind: "helix",
  radius: { dimension: "length", unit: "mm", value: 6 },
  pitch: { dimension: "length", unit: "mm", value: 4 },
  turns: 2.5,
  handedness: 1,
  startAngle: { dimension: "angle", unit: "rad", value: 0 },
};

const equation: SerializedCurve = {
  kind: "equation",
  tMin: 0,
  tMax: 1,
  x: "10mm * t",
  y: "0mm",
  z: "10mm * (1 - t)",
};

describe("curve geometry", () => {
  it("passes an interpolated spline through its declared points exactly (round-trip)", () => {
    const canonical = canonicalizeCurve(interpolated);
    if (!canonical.ok) {
      throw new Error("the round-trip witness must canonicalize");
    }
    const knots = curveStations(canonical.value).filter((t) =>
      Number.isInteger(t),
    );
    for (const [index, knot] of knots.entries()) {
      const declared = interpolated.points[index];
      const point = curvePointAt(canonical.value, knot);
      if (declared === undefined) continue;
      expect(point[0]).toBeCloseTo(declared[0], 9);
      expect(point[1]).toBeCloseTo(declared[1], 9);
      expect(point[2]).toBeCloseTo(declared[2], 9);
    }
  });

  it("keeps a control spline strictly inside its control hull", () => {
    const control: SerializedCurve = {
      kind: "control-spline",
      points: [
        [0, 0, 0],
        [10, 0, 0],
        [10, 10, 0],
        [20, 10, 0],
      ],
    };
    const canonical = canonicalizeCurve(control);
    expect(canonical.ok).toBe(true);
    if (!canonical.ok) return;
    const polyline = curvePolyline(canonical.value);
    for (const point of polyline) {
      expect(point[0]).toBeGreaterThanOrEqual(0);
      expect(point[0]).toBeLessThanOrEqual(20);
      expect(point[1]).toBeGreaterThanOrEqual(0);
      expect(point[1]).toBeLessThanOrEqual(10);
    }
  });

  it("answers the untapered helix length in closed form", () => {
    const canonical = canonicalizeCurve(helix);
    if (!canonical.ok) {
      throw new Error("the length witness must canonicalize");
    }
    // L = turns·√((2πR)² + pitch²) = 2.5·√((12π)² + 16)
    const expected = 2.5 * Math.sqrt((12 * Math.PI) ** 2 + 16);
    expect(curveLength(canonical.value)).toBeCloseTo(expected, 9);
    const bounds = curveBounds(canonical.value);
    expect(bounds.max[2]).toBeCloseTo(10, 9);
  });

  it("walks an equation curve at its fixed station count", () => {
    const canonical = canonicalizeCurve(equation);
    expect(canonical.ok).toBe(true);
    if (!canonical.ok) return;
    const polyline = curvePolyline(canonical.value);
    expect(polyline.length).toBe(CURVE_EQUATION_STATIONS + 1);
    expect(polyline[0]).toEqual([0, 0, 10]);
    expect(polyline[polyline.length - 1]).toEqual([10, 0, 0]);
  });

  it("flags a kinked polyline and passes a smooth one (the generalized G1 battery)", () => {
    const smoothCanonical = canonicalizeCurve(helix);
    if (!smoothCanonical.ok) {
      throw new Error("the G1 witness must canonicalize");
    }
    const smooth = curvePolyline(smoothCanonical.value);
    expect(wireG1FailureIndex(smooth)).toBeNull();
    const kinked: readonly (readonly [number, number, number])[] = [
      [0, 0, 0],
      [5, 0, 0],
      [5, 0, 1],
      [5, 5, 1],
    ];
    expect(wireG1FailureIndex(kinked)).not.toBeNull();
  });

  it("parallel-transports a straight path with a constant frame (the planar equivalence)", () => {
    const frames = parallelTransportFrames([
      [0, 0, 0],
      [0, 0, 5],
      [0, 0, 10],
    ]);
    expect(frames.length).toBe(3);
    const first = frames[0];
    const last = frames[frames.length - 1];
    if (first === undefined || last === undefined) return;
    for (let axis = 0; axis < 3; axis += 1) {
      const normalA = first.normal[axis];
      const normalB = last.normal[axis];
      const binormalA = first.binormal[axis];
      const binormalB = last.binormal[axis];
      if (
        normalA === undefined ||
        normalB === undefined ||
        binormalA === undefined ||
        binormalB === undefined
      ) {
        continue;
      }
      expect(normalA).toBeCloseTo(normalB, 9);
      expect(binormalA).toBeCloseTo(binormalB, 9);
    }
  });
});

describe("the wire operation", () => {
  it("evaluates a deterministic wire and rejects a degenerate payload", () => {
    const outcome = evaluateWire(helix);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.wire.polyline.length).toBeGreaterThan(2);
    expect(outcome.wire.length).toBeGreaterThan(0);
    const degenerate = evaluateWire({
      kind: "helix",
      radius: { dimension: "length", unit: "mm", value: 0 },
      pitch: { dimension: "length", unit: "mm", value: 0 },
      turns: 1,
      handedness: 1,
      startAngle: { dimension: "angle", unit: "rad", value: 0 },
    });
    expect(degenerate.ok).toBe(false);
    if (!degenerate.ok) expect(degenerate.code).toBe("kernel/invalid-profile");
  });

  it("answers the identical value the shared pure evaluation computes", () => {
    const fake = createFakeKernel();
    const viaKernel = fake.wire(interpolated);
    const viaHelper = evaluateWire(interpolated);
    expect(viaKernel.ok).toBe(true);
    expect(viaHelper.ok).toBe(true);
    if (!viaKernel.ok || !viaHelper.ok) return;
    expect(viaKernel.value).toEqual(viaHelper.wire);
  });
});
