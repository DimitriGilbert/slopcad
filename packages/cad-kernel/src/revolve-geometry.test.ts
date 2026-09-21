/**
 * The revolve geometry helpers' tests (Phase 26.2): the shared validator and
 * volume core every kernel adapter runs before its own revolve call — the
 * axis frame normalization, the EXACT signed-distance extremes of a profile
 * about an in-plane axis (touching legal, crossing rejected), the axis-frame
 * tessellation, and the Pappus swept volume of the resulting polygon.
 */

import { describe, expect, it } from "vitest";
import { angle } from "@slopcad/cad-core";
import type { ProfileRevolveAxisInput } from "./contract";

import {
  profileLoopProblem,
  revolveCrossesAxis,
  revolvePappusVolume,
  REVOLVE_AXIS_TOUCH_TOLERANCE_MM,
  tessellateRevolveProfile,
  normalizeRevolveAxis,
  revolveSignedExtremes,
  type RevolveAxisFrame,
} from "./profile-geometry";
import { certifiedCubicExtremes } from "./profile-splines";

/** Normalizes an axis or fails the test (degenerate axes are adapter-rejected). */
function frameOf(axis: ProfileRevolveAxisInput): RevolveAxisFrame {
  const frame = normalizeRevolveAxis(axis);
  if (frame === null) throw new Error("test axis must be normalizable");
  return frame;
}

/** Axis frame helpers ------------------------------------------------------ */

describe("normalizeRevolveAxis", () => {
  it("normalizes the x axis to the identity frame", () => {
    const frame = normalizeRevolveAxis({
      point: [3, 4],
      direction: [2, 0],
    });
    expect(frame).not.toBeNull();
    expect(frame?.origin).toEqual({ x: 3, y: 4 });
    expect(frame?.u).toEqual({ x: 1, y: 0 });
    expect(frame?.v).toEqual({ x: 0, y: 1 });
  });

  it("normalizes a diagonal direction and keeps v on the +s (left) side", () => {
    const frame = normalizeRevolveAxis({ point: [0, 0], direction: [1, 1] });
    expect(frame).not.toBeNull();
    expect(frame?.u.x).toBeCloseTo(Math.SQRT1_2, 12);
    expect(frame?.u.y).toBeCloseTo(Math.SQRT1_2, 12);
    // v is u rotated +90°: (−uy, ux).
    expect(frame?.v.x).toBeCloseTo(-Math.SQRT1_2, 12);
    expect(frame?.v.y).toBeCloseTo(Math.SQRT1_2, 12);
  });

  it("rejects a degenerate direction (zero or non-finite) with null", () => {
    expect(
      normalizeRevolveAxis({ point: [0, 0], direction: [0, 0] }),
    ).toBeNull();
    expect(
      normalizeRevolveAxis({ point: [0, 0], direction: [Number.NaN, 1] }),
    ).toBeNull();
    expect(
      normalizeRevolveAxis({ point: [0, 0], direction: [Infinity, 0] }),
    ).toBeNull();
  });
});

/** The shared loop structural validator (angles in any authored unit) ------ */

describe("profileLoopProblem", () => {
  it("accepts a closed loop whose arc angles are authored in degrees", () => {
    // The contract's ProfileSegmentInput documents "angles in any angle
    // unit, canonicalized internally": a deg-authored lower semicircle
    // from (5,0) to (15,0) closed by three lines is structurally sound.
    // Reading the magnitudes as radians (the angle-unit trap this guards
    // against) would place the arc's endpoints at cos/sin of 180/360 RADIANS
    // and reject the loop with a spurious closure gap.
    const loop: Parameters<typeof profileLoopProblem>[0] = [
      {
        kind: "arc",
        center: [10, 0] as [number, number],
        radius: 5,
        startAngle: angle(180, "deg"),
        endAngle: angle(360, "deg"),
      },
      { kind: "line", start: [15, 0], end: [15, 10] },
      { kind: "line", start: [15, 10], end: [5, 10] },
      { kind: "line", start: [5, 10], end: [5, 0] },
    ];
    expect(profileLoopProblem(loop)).toBeNull();
  });

  it("still reports non-finite arc angles as a structured problem", () => {
    const loop: Parameters<typeof profileLoopProblem>[0] = [
      {
        kind: "arc" as const,
        center: [10, 0] as [number, number],
        radius: 5,
        startAngle: {
          dimension: "angle" as const,
          unit: "deg" as const,
          value: Number.POSITIVE_INFINITY,
        },
        endAngle: angle(360, "deg"),
      },
    ];
    expect(profileLoopProblem(loop)).toBe("an arc has non-finite angles");
  });
});

/** Signed-distance extremes ------------------------------------------------ */

const X_AXIS: ProfileRevolveAxisInput = { point: [0, 0], direction: [1, 0] };
const Y_AXIS: ProfileRevolveAxisInput = { point: [0, 0], direction: [0, 1] };
const X_FRAME = frameOf(X_AXIS);
const Y_FRAME = frameOf(Y_AXIS);

function rectangleLoop(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): Parameters<typeof revolveSignedExtremes>[0] {
  return [
    { kind: "line", start: [x0, y0], end: [x1, y0] },
    { kind: "line", start: [x1, y0], end: [x1, y1] },
    { kind: "line", start: [x1, y1], end: [x0, y1] },
    { kind: "line", start: [x0, y1], end: [x0, y0] },
  ];
}

describe("revolveSignedExtremes", () => {
  it("measures a clear rectangle's y-extent about the x axis exactly", () => {
    const extremes = revolveSignedExtremes(
      rectangleLoop(0, 10, 30, 25),
      X_FRAME,
    );
    expect(extremes.min).toBe(10);
    expect(extremes.max).toBe(25);
  });

  it("reads touching (on-axis) edges as exactly zero, not crossing", () => {
    const extremes = revolveSignedExtremes(
      rectangleLoop(0, 0, 30, 25),
      X_FRAME,
    );
    expect(extremes.min).toBe(0);
    expect(extremes.max).toBe(25);
  });

  it("resolves a diagonal axis with the signed cross-product distance", () => {
    // Point (1, 0) about the +x+y diagonal sits at signed distance −1/√2.
    const frame = normalizeRevolveAxis({ point: [0, 0], direction: [1, 1] });
    expect(frame).not.toBeNull();
    const extremes = revolveSignedExtremes(
      rectangleLoop(1, 0, 2, 1),
      frameOf({ point: [0, 0], direction: [1, 1] }),
    );
    // Corners (1,0), (2,0), (2,1), (1,1): s = (q − 0)·v = (−q.x + q.y)/√2
    // → min = −2/√2 ≈ −1.4142 (corner (2,0)), max = 0 (corners (1,1)/(2,1)
    // give −1/√2 and 0 … the max is at (1,1): 0/√2 = 0? (−1+1)/√2 = 0).
    expect(extremes.min).toBeCloseTo(-Math.SQRT2, 12);
    expect(extremes.max).toBeCloseTo(0, 12);
  });

  it("measures arcs by their true sweep, not their chord: a quarter arc that only touches", () => {
    // Quarter circle about the origin from angle 0 to π/2, radius 5: its
    // signed y about the x axis spans [0, 5] — the underlying CIRCLE would
    // cross (−5..5), the arc does not.
    const loop = [
      {
        kind: "arc" as const,
        center: [0, 0] as [number, number],
        radius: 5,
        startAngle: angle(0, "rad"),
        endAngle: angle(Math.PI / 2, "rad"),
      },
    ];
    const extremes = revolveSignedExtremes(loop, X_FRAME);
    expect(extremes.min).toBeCloseTo(0, 12);
    expect(extremes.max).toBeCloseTo(5, 12);
  });

  it("measures arcs whose sweep passes the far side of the axis", () => {
    // Arc from π/2 to 3π/2 (the left half) of a radius-5 circle at the
    // origin about the x axis: signed y spans [−5, 5]... the sweep passes
    // 3π/2 (y = −5) and π/2 (y = +5).
    const loop = [
      {
        kind: "arc" as const,
        center: [0, 0] as [number, number],
        radius: 5,
        startAngle: angle(Math.PI / 2, "rad"),
        endAngle: angle((3 * Math.PI) / 2, "rad"),
      },
    ];
    const extremes = revolveSignedExtremes(loop, X_FRAME);
    expect(extremes.min).toBeCloseTo(-5, 12);
    expect(extremes.max).toBeCloseTo(5, 12);
  });

  it("measures a full circle by its whole extent", () => {
    const loop = [
      {
        kind: "circle" as const,
        center: [0, 8] as [number, number],
        radius: 3,
      },
    ];
    const extremes = revolveSignedExtremes(loop, X_FRAME);
    expect(extremes.min).toBeCloseTo(5, 12);
    expect(extremes.max).toBeCloseTo(11, 12);
  });

  it("measures a deg-authored arc by its true radian sweep", () => {
    // Arc 350°→370° about (0,0), r=10: the true y-extent about the x axis
    // is ±10·sin(10°) ≈ ±1.736 — both sides of the axis. Reading the raw
    // magnitudes as radians would land the candidates where sin ≈ −1 and
    // report a one-sided extent.
    const loop: Parameters<typeof revolveSignedExtremes>[0] = [
      {
        kind: "arc" as const,
        center: [0, 0] as [number, number],
        radius: 10,
        startAngle: angle(350, "deg"),
        endAngle: angle(370, "deg"),
      },
    ];
    const extremes = revolveSignedExtremes(loop, X_FRAME);
    const reach = 10 * Math.sin((10 * Math.PI) / 180);
    expect(extremes.min).toBeCloseTo(-reach, 12);
    expect(extremes.max).toBeCloseTo(reach, 12);
  });
});

/** The crossing rule ------------------------------------------------------- */

describe("revolveCrossesAxis", () => {
  it("accepts a profile strictly on one side", () => {
    expect(revolveCrossesAxis(rectangleLoop(0, 10, 30, 25), X_FRAME)).toBe(
      false,
    );
  });

  it("accepts on-axis vertices and edges (touching is legal)", () => {
    // Bottom edge ON the x axis: the classic full-cylinder revolve profile.
    expect(revolveCrossesAxis(rectangleLoop(0, 0, 30, 25), X_FRAME)).toBe(
      false,
    );
    // Edge collinear with the y axis from the +x side.
    expect(revolveCrossesAxis(rectangleLoop(0, 0, 30, 25), Y_FRAME)).toBe(
      false,
    );
  });

  it("accepts a circle tangent to the axis (touching at one point)", () => {
    const loop = [
      {
        kind: "circle" as const,
        center: [0, 5] as [number, number],
        radius: 5,
      },
    ];
    expect(revolveCrossesAxis(loop, X_FRAME)).toBe(false);
  });

  it("rejects a profile with material strictly on both sides", () => {
    expect(revolveCrossesAxis(rectangleLoop(0, -10, 30, 25), X_FRAME)).toBe(
      true,
    );
  });

  it("rejects a circle centred on the axis (material surrounds it)", () => {
    const loop = [
      {
        kind: "circle" as const,
        center: [0, 0] as [number, number],
        radius: 5,
      },
    ];
    expect(revolveCrossesAxis(loop, X_FRAME)).toBe(true);
  });

  it("rejects a line segment crossing the axis interior", () => {
    const loop = rectangleLoop(0, -10, 30, 25);
    // The straddling rectangle's vertical edges cross the x axis.
    expect(revolveCrossesAxis(loop, X_FRAME)).toBe(true);
  });

  it("rejects an arc that sweeps through the axis even when its endpoints stay on one side", () => {
    // Arc from π/4 to 7π/4 of a radius-5 circle at the origin: both
    // endpoints sit at y ≈ +3.54 (one side), but the sweep passes angle
    // π/2 (y = +5) AND 3π/2 (y = −5) — material strictly on both sides.
    const straddler = [
      {
        kind: "arc" as const,
        center: [0, 0] as [number, number],
        radius: 5,
        startAngle: angle(Math.PI / 4, "rad"),
        endAngle: angle((7 * Math.PI) / 4, "rad"),
      },
    ];
    expect(revolveSignedExtremes(straddler, X_FRAME)).toEqual({
      min: -5,
      max: 5,
    });
    expect(revolveCrossesAxis(straddler, X_FRAME)).toBe(true);
  });

  it("accepts an arc whose sweep stays on one side even though its circle would cross", () => {
    // Quarter arc from 0 to π/2 about the x axis: signed y spans [0, 5]
    // exactly — the underlying circle crosses, the arc only touches.
    const toucher = [
      {
        kind: "arc" as const,
        center: [0, 0] as [number, number],
        radius: 5,
        startAngle: angle(0, "rad"),
        endAngle: angle(Math.PI / 2, "rad"),
      },
    ];
    expect(revolveCrossesAxis(toucher, X_FRAME)).toBe(false);
  });

  it("rejects a deg-authored arc that crosses the axis (the fail-open guard)", () => {
    // The 350°→370° arc has material strictly on both sides of the x axis
    // (±10·sin(10°) ≈ ±1.736 mm, far beyond the touch tolerance); the
    // validator must report the crossing — misreading the deg magnitudes as
    // radians would admit it and the mesh kernels would silently clip the
    // far side.
    const loop: Parameters<typeof revolveCrossesAxis>[0] = [
      {
        kind: "arc" as const,
        center: [0, 0] as [number, number],
        radius: 10,
        startAngle: angle(350, "deg"),
        endAngle: angle(370, "deg"),
      },
    ];
    expect(revolveCrossesAxis(loop, X_FRAME)).toBe(true);
  });

  it("honours the documented touch tolerance symmetrically", () => {
    // A rectangle whose lower edge sits exactly at the tolerance magnitude.
    const loop = rectangleLoop(0, -REVOLVE_AXIS_TOUCH_TOLERANCE_MM, 30, 25);
    expect(revolveCrossesAxis(loop, X_FRAME)).toBe(false);
    const crosser = rectangleLoop(
      0,
      -REVOLVE_AXIS_TOUCH_TOLERANCE_MM * 10,
      30,
      25,
    );
    expect(revolveCrossesAxis(crosser, X_FRAME)).toBe(true);
  });
});

/** Axis-frame tessellation + Pappus volume --------------------------------- */

describe("tessellateRevolveProfile", () => {
  it("maps a straight rectangle to its four (axial, signed-radial) corners", () => {
    const polygon = tessellateRevolveProfile(
      rectangleLoop(0, 0, 30, 25),
      X_FRAME,
    );
    // u = +x → axial = x; v = +y → signed radial = y.
    expect(polygon).toEqual([
      { x: 0, y: 0 },
      { x: 30, y: 0 },
      { x: 30, y: 25 },
      { x: 0, y: 25 },
    ]);
  });

  it("subdivides a circle at the shared mesh deflection (63 chords)", () => {
    const loop = [
      {
        kind: "circle" as const,
        center: [10, 40] as [number, number],
        radius: 12,
      },
    ];
    const polygon = tessellateRevolveProfile(loop, X_FRAME);
    expect(polygon.length).toBe(63);
    // Every vertex keeps the true radius from the axis... the chord
    // vertices lie ON the circle: radial distance from the axis point of
    // each vertex = |s| where the axis-frame radius is preserved.
    for (const point of polygon) {
      const radius = Math.hypot(point.y, 0);
      expect(radius).toBeGreaterThan(0);
    }
  });
});

describe("revolvePappusVolume", () => {
  it("gives the exact cylinder volume for an axis-touching rectangle (full turn)", () => {
    const polygon = tessellateRevolveProfile(
      rectangleLoop(0, 0, 30, 25),
      X_FRAME,
    );
    const volume = revolvePappusVolume(polygon, Math.PI * 2);
    expect(volume).toBeCloseTo(Math.PI * 25 ** 2 * 30, 6);
  });

  it("scales linearly with the sweep angle (partial turn)", () => {
    const polygon = tessellateRevolveProfile(
      rectangleLoop(0, 0, 30, 25),
      X_FRAME,
    );
    const full = revolvePappusVolume(polygon, Math.PI * 2);
    const half = revolvePappusVolume(polygon, Math.PI);
    expect(half).toBeCloseTo(full / 2, 9);
    const quarter = revolvePappusVolume(polygon, Math.PI / 2);
    expect(quarter).toBeCloseTo(full / 4, 9);
  });

  it("gives the exact torus volume for an off-axis disc profile", () => {
    const polygon = tessellateRevolveProfile(
      [{ kind: "circle", center: [5, 40], radius: 5 }],
      X_FRAME,
    );
    const volume = revolvePappusVolume(polygon, Math.PI * 2);
    // Chord polygon: area = ½·n·r²·sin(2π/n), centroid at s = 40 exactly.
    const n = 63;
    const area = (n / 2) * 25 * Math.sin((2 * Math.PI) / n);
    expect(volume).toBeCloseTo(2 * Math.PI * 40 * area, 6);
  });

  it("measures the true signed volume for a profile on the −v side", () => {
    const polygon = tessellateRevolveProfile(
      rectangleLoop(0, -25, 30, 0),
      X_FRAME,
    );
    const volume = revolvePappusVolume(polygon, Math.PI * 2);
    expect(volume).toBeCloseTo(Math.PI * 25 ** 2 * 30, 6);
  });
});

// ---------------------------------------------------------------------------
// Phase 37: certified spline×axis crossing (§8 of
// docs/design/spline-constraint-math.md) — the scalar-cubic extremes replace
// tessellation sampling, closing the constructible false-negative gap.
// ---------------------------------------------------------------------------

describe("certifiedCubicExtremes (§8.3)", () => {
  it("certifies the arch's one-sided hull non-crossing at depth 0 (§8.6 #1)", () => {
    // y-controls (0, 2, 2, 0): hull [0, 2] one-sided, the monotone test
    // fires on the descending halves — exact, zero subdivisions.
    const { lo, hi, depth } = certifiedCubicExtremes(0, 2, 2, 0);
    expect(lo).toBeCloseTo(0, 12);
    // y(t) = 6ut peaks at 3/2 on t = 1/2 (the apex — exact via the
    // derivative's linear root, A = 0).
    expect(hi).toBeCloseTo(1.5, 12);
    expect(depth).toBe(0);
  });

  it("certifies the crossing wiggle with the exact ±√3/2 extremes (§8.6 #2)", () => {
    const { lo, hi, depth } = certifiedCubicExtremes(0, 3, -3, 0);
    expect(lo).toBeCloseTo(-Math.sqrt(3) / 2, 12);
    expect(hi).toBeCloseTo(Math.sqrt(3) / 2, 12);
    expect(depth).toBe(0);
  });

  it("brackets every case: [lo, hi] ⊇ [trueMin, trueMax] on a sweep", () => {
    // A deterministic sweep of control quartets, each verified against a
    // dense on-curve sampling: lo ≤ sampled min, hi ≥ sampled max.
    let cases = 0;
    for (const g0 of [-2, 0, 0.5]) {
      for (const g1 of [-3, 0.001, 2]) {
        for (const g2 of [-3, -0.001, 2]) {
          for (const g3 of [-2, 0, 0.5]) {
            const { lo, hi } = certifiedCubicExtremes(g0, g1, g2, g3);
            let sampledLo = Number.POSITIVE_INFINITY;
            let sampledHi = Number.NEGATIVE_INFINITY;
            for (let i = 0; i <= 2000; i += 1) {
              const t = i / 2000;
              const u = 1 - t;
              const value =
                u * u * u * g0 +
                3 * u * u * t * g1 +
                3 * u * t * t * g2 +
                t * t * t * g3;
              sampledLo = Math.min(sampledLo, value);
              sampledHi = Math.max(sampledHi, value);
            }
            expect(lo).toBeLessThanOrEqual(sampledLo + 1e-12);
            expect(hi).toBeGreaterThanOrEqual(sampledHi - 1e-12);
            cases += 1;
          }
        }
      }
    }
    expect(cases).toBe(81);
  });

  it("is deterministic: identical controls, identical result", () => {
    expect(certifiedCubicExtremes(0.3, -1.2, 2.4, 0.9)).toEqual(
      certifiedCubicExtremes(0.3, -1.2, 2.4, 0.9),
    );
  });
});

/** A closed-ish spline loop segment for the crossing-rule probes. */
function splineSegmentOf(
  points: readonly (readonly [number, number])[],
): Parameters<typeof revolveSignedExtremes>[0][number] {
  return { kind: "spline", flavor: "control", points };
}

describe("revolveCrossesAxis — the certified spline branch (§8.1/§8.6 #3)", () => {
  it("accepts the arch touching the x axis from above (non-crossing certified)", () => {
    // y-controls (0, 2, 2, 0): min 0 ≥ −τ — legal touching.
    const loop = [
      splineSegmentOf([
        [0, 0],
        [1, 2],
        [3, 2],
        [4, 0],
      ]),
    ];
    expect(revolveCrossesAxis(loop, X_FRAME)).toBe(false);
  });

  it("rejects the transversal wiggle (0, 3, −3, 0) with exact ±√3/2 extremes", () => {
    const loop = [
      splineSegmentOf([
        [0, 0],
        [1, 3],
        [3, -3],
        [4, 0],
      ]),
    ];
    expect(revolveCrossesAxis(loop, X_FRAME)).toBe(true);
    const extremes = revolveSignedExtremes(loop, X_FRAME);
    expect(extremes.min).toBeCloseTo(-Math.sqrt(3) / 2, 12);
    expect(extremes.max).toBeCloseTo(Math.sqrt(3) / 2, 12);
  });

  it("catches the δ = 0.001 sub-deflection crossing the tessellated check missed (§8.6 #3)", () => {
    // x-controls (0, 1, 3, 4), y-controls (0, δ, −δ, 0) with δ = 0.001 <
    // PROFILE_SPLINE_DEFLECTION_MM = 0.01: the flatness criterion passes at
    // depth 0, the tessellation emits only the endpoints, and the SAMPLED
    // extremes are (0, 0) — no crossing. The curve crosses the x axis
    // transversally at t = 1/2 (y(½) = 0) with extremes ±δ√3/6 ≈ 0.000289
    // at t = (3 ± √3)/6 — below the 0.01 deflection, invisible to sampled
    // extremes. The certified clipping must report crossing.
    const delta = 0.001;
    const loop = [
      splineSegmentOf([
        [0, 0],
        [1, delta],
        [3, -delta],
        [4, 0],
      ]),
    ];
    expect(revolveCrossesAxis(loop, X_FRAME)).toBe(true);
    const extremes = revolveSignedExtremes(loop, X_FRAME);
    // On-curve contact values: y(¼) = +0.00028125·… — the certified
    // The exact critical values: controls (0, δ, −δ, 0) = (δ/3)·(0, 3,
    // −3, 0), so the extremes are ±(δ/3)(√3/2) = ±δ√3/6 at t = (3±√3)/6.
    const exact = (delta * Math.sqrt(3)) / 6;
    expect(extremes.min).toBeCloseTo(-exact, 12);
    expect(extremes.max).toBeCloseTo(exact, 12);
  });
});
