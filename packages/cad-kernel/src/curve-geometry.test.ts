import { describe, expect, it } from "vitest";
import type { SerializedCurve } from "@slopcad/cad-core";

import {
  CURVE_EQUATION_STATIONS,
  CURVE_STATIONS_PER_SPAN,
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

describe("the control-spline station/domain agreement (the tail-duplication defect)", () => {
  const controlSpine: SerializedCurve = {
    kind: "control-spline",
    points: [
      [0, 0, 0],
      [10, 0, 2],
      [20, 0, 6],
      [30, 0, 12],
      [40, 0, 20],
      [50, 0, 30],
    ],
  };

  it("walks the B-spline domain exactly: (poles−3) spans, no duplicate stations", () => {
    const canonical = canonicalizeCurve(controlSpine);
    expect(canonical.ok).toBe(true);
    if (!canonical.ok) return;
    // Six poles → three B-spline spans → 3·8 + 1 = 25 stations over
    // [0, 3] — the domain `curvePointAt` clamps to. Walking poles−1 spans
    // instead clamped every station past the domain end onto the same
    // terminal point (16 duplicate tail stations, zero-length chords).
    const stations = curveStations(canonical.value);
    expect(stations.length).toBe((6 - 3) * CURVE_STATIONS_PER_SPAN + 1);
    expect(stations[stations.length - 1]).toBe(6 - 3);
    for (let index = 1; index < stations.length; index += 1) {
      expect(stations[index]).toBeGreaterThan(stations[index - 1] ?? -Infinity);
    }
  });

  it("carries no zero-length chords: every station point differs from the previous", () => {
    const canonical = canonicalizeCurve(controlSpine);
    if (!canonical.ok) {
      throw new Error("the chord witness must canonicalize");
    }
    const polyline = curvePolyline(canonical.value);
    expect(polyline.length).toBe((6 - 3) * CURVE_STATIONS_PER_SPAN + 1);
    for (let index = 1; index < polyline.length; index += 1) {
      const previous = polyline[index - 1];
      const current = polyline[index];
      if (previous === undefined || current === undefined) continue;
      const chord = Math.sqrt(
        (current[0] - previous[0]) ** 2 +
          (current[1] - previous[1]) ** 2 +
          (current[2] - previous[2]) ** 2,
      );
      expect(chord).toBeGreaterThan(1e-9);
    }
    // The smooth spine passes the G1 battery the duplicated tail used to
    // false-flag through the zero-chord normalizeAxis fallback.
    expect(wireG1FailureIndex(polyline)).toBeNull();
  });
});

describe("parallel-transport shape dependence (the origin-independence pins)", () => {
  /** Builds a helix's station polyline once. */
  function helixPolyline(): readonly (readonly [number, number, number])[] {
    const canonical = canonicalizeCurve(helix);
    if (!canonical.ok) {
      throw new Error("the helix witness must canonicalize");
    }
    return curvePolyline(canonical.value);
  }

  it("translates the whole path without moving the frames (dot ≥ 0.9999 element-wise)", () => {
    const original = helixPolyline();
    const translated = original.map(
      (point) => [point[0] + 1000, point[1] + 1000, point[2] + 1000] as const,
    );
    const framesA = parallelTransportFrames(original);
    const framesB = parallelTransportFrames(translated);
    expect(framesA.length).toBe(framesB.length);
    for (let index = 0; index < framesA.length; index += 1) {
      const a = framesA[index];
      const b = framesB[index];
      if (a === undefined || b === undefined) continue;
      for (let axis = 0; axis < 3; axis += 1) {
        const normalDot =
          (a.normal[0] ?? 0) * (b.normal[0] ?? 0) +
          (a.normal[1] ?? 0) * (b.normal[1] ?? 0) +
          (a.normal[2] ?? 0) * (b.normal[2] ?? 0);
        const binormalDot =
          (a.binormal[0] ?? 0) * (b.binormal[0] ?? 0) +
          (a.binormal[1] ?? 0) * (b.binormal[1] ?? 0) +
          (a.binormal[2] ?? 0) * (b.binormal[2] ?? 0);
        expect(normalDot).toBeGreaterThanOrEqual(0.9999);
        expect(binormalDot).toBeGreaterThanOrEqual(0.9999);
        expect(a.normal[axis]).toBeCloseTo(b.normal[axis] ?? 0, 9);
        expect(a.binormal[axis]).toBeCloseTo(b.binormal[axis] ?? 0, 9);
      }
    }
  });

  it("keeps a straight path's normal constant however far the path sits from the origin", () => {
    // A straight +x run offset to y = 100: the absolute-point reflection
    // form tilted the normal every step here (the point sums [x_i + x_i+1,
    // 200, 0] are not perpendicular to the initial normal ŷ); the frame
    // depends only on the path's shape, and a straight path transports
    // nothing.
    const frames = parallelTransportFrames([
      [0, 100, 0],
      [5, 100, 0],
      [10, 100, 0],
      [15, 100, 0],
    ]);
    expect(frames.length).toBe(4);
    for (const frame of frames) {
      expect(frame.normal[0]).toBeCloseTo(0, 9);
      expect(frame.normal[1]).toBeCloseTo(1, 9);
      expect(frame.normal[2]).toBeCloseTo(0, 9);
    }
  });

  it("keeps a curved planar path's frame component on the path-plane normal constant", () => {
    // A quarter arc in the XZ plane (y = 0): the initial-frame rule seats
    // `normal` on the path plane's normal ŷ (the least-aligned world axis
    // of any in-plane start tangent that is not exactly x̂/ẑ), and
    // parallel transport never rotates a planar path's frame about its
    // tangent — the NORMAL stays constant. It is the normal, not the
    // binormal, that carries the fixed direction.
    const arc: (readonly [number, number, number])[] = [];
    const radius = 30;
    const steps = 24;
    for (let index = 0; index <= steps; index += 1) {
      const angle = (Math.PI / 2) * (index / steps);
      arc.push([radius * Math.sin(angle), 0, radius * (1 - Math.cos(angle))]);
    }
    const frames = parallelTransportFrames(arc);
    expect(frames.length).toBe(steps + 1);
    for (const frame of frames) {
      expect(frame.normal[0]).toBeCloseTo(0, 9);
      expect(frame.normal[1]).toBeCloseTo(1, 9);
      expect(frame.normal[2]).toBeCloseTo(0, 9);
    }
    // The one special start — a first chord EXACTLY along +z, the planar
    // sweep's canonical attachment — seats the plane normal on `binormal`
    // instead (the initial-frame tie picks x̂): the same fixed world
    // direction ŷ under the other field's name, which is why the planar
    // XZ sweep and the embedded 3D wire sweep the identical solid.
    const leadZ: (readonly [number, number, number])[] = [
      [0, 0, 0],
      [0, 0, 5],
    ];
    for (let index = 1; index <= steps; index += 1) {
      const angle = (Math.PI / 2) * (index / steps);
      leadZ.push([
        radius * (1 - Math.cos(angle)),
        0,
        5 + radius * Math.sin(angle),
      ]);
    }
    const framesZ = parallelTransportFrames(leadZ);
    for (const frame of framesZ) {
      expect(frame.binormal[0]).toBeCloseTo(0, 9);
      expect(frame.binormal[1]).toBeCloseTo(1, 9);
      expect(frame.binormal[2]).toBeCloseTo(0, 9);
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
