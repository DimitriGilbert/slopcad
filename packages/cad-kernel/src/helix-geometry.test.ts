/**
 * The helix geometry module's tests (Phase 40): the parametrization's
 * exactness (points, handedness, taper, start angle), the validation
 * battery's codes, the screw-solid volume's closed forms (the derived
 * Jacobian integral), the inverse-screw membership, and the deterministic
 * station rule the byte-determinism pins ride on.
 */

import { describe, expect, it } from "vitest";
import { angle, length } from "@slopcad/cad-core";

import { KERNEL_ERROR_CODES, type ProfileSegmentInput } from "./contract";
import {
  helixHeightAt,
  helixPointAt,
  helixProfilePolygon,
  helixRadiusAt,
  helixScrewContains,
  helixScrewVolume,
  helixStations,
  helixSweptAngle,
  helixSweepProblem,
  helixTransportPoint,
  helixTurnsOverlap,
  helixUntaperedLocalBounds,
  type CanonicalHelixSpine,
} from "./helix-geometry";

/** A rectangle in meridian coords (u ∈ [u0, u0+w], v ∈ [v0, v0+h]). */
function rectangle(
  u0: number,
  v0: number,
  w: number,
  h: number,
): readonly ProfileSegmentInput[] {
  return [
    { kind: "line", start: [u0, v0], end: [u0 + w, v0] },
    { kind: "line", start: [u0 + w, v0], end: [u0 + w, v0 + h] },
    { kind: "line", start: [u0 + w, v0 + h], end: [u0, v0 + h] },
    { kind: "line", start: [u0, v0 + h], end: [u0, v0] },
  ];
}

const RIGHT_3_TURNS: CanonicalHelixSpine = {
  radiusMm: 10,
  pitchMm: 4,
  turns: 3,
  handedness: 1,
  startAngleRad: 0,
  taperMm: 0,
};

describe("helix parametrization", () => {
  it("places the spine points exactly: p(t) = R·r̂(θ₀+H·2π·turns·t) + pitch·turns·t·ẑ", () => {
    expect(helixPointAt(RIGHT_3_TURNS, 0)).toEqual([10, 0, 0]);
    // A quarter into the FIRST turn: θ = π/2, z = pitch/4 = 1.
    const quarter = helixPointAt(RIGHT_3_TURNS, 1 / 12);
    expect(quarter[0]).toBeCloseTo(0, 12);
    expect(quarter[1]).toBeCloseTo(10, 12);
    expect(quarter[2]).toBeCloseTo(1, 12);
    // The end: 3 full turns, height pitch·turns = 12, back at θ = 6π ≡ 0.
    const end = helixPointAt(RIGHT_3_TURNS, 1);
    expect(end[0]).toBeCloseTo(10, 12);
    expect(end[1]).toBeCloseTo(0, 12);
    expect(end[2]).toBeCloseTo(12, 12);
    expect(helixSweptAngle(RIGHT_3_TURNS)).toBeCloseTo(6 * Math.PI, 12);
    expect(helixHeightAt(RIGHT_3_TURNS, 1)).toBe(12);
    expect(helixRadiusAt(RIGHT_3_TURNS, 0.5)).toBe(10);
  });

  it("carries handedness on the angular term only", () => {
    const left: CanonicalHelixSpine = { ...RIGHT_3_TURNS, handedness: -1 };
    // Both advance along +z identically...
    expect(helixHeightAt(left, 1)).toBe(12);
    // ...but wind opposite ways: at t = 1/12 the left helix sits at θ = −π/2.
    const point = helixPointAt(left, 1 / 12);
    expect(point[0]).toBeCloseTo(0, 12);
    expect(point[1]).toBeCloseTo(-10, 12);
    expect(helixSweptAngle(left)).toBeCloseTo(-6 * Math.PI, 12);
  });

  it("applies the taper linearly and the start angle as a rigid phase", () => {
    const tapered: CanonicalHelixSpine = {
      ...RIGHT_3_TURNS,
      taperMm: 2,
      startAngleRad: Math.PI / 2,
    };
    expect(helixRadiusAt(tapered, 0)).toBe(10);
    expect(helixRadiusAt(tapered, 0.5)).toBe(11);
    expect(helixRadiusAt(tapered, 1)).toBe(12);
    // The start point sits at θ₀ = π/2.
    const start = helixPointAt(tapered, 0);
    expect(start[0]).toBeCloseTo(0, 12);
    expect(start[1]).toBeCloseTo(10, 12);
    // The transport keeps the meridian attachment: the profile point
    // (u, v) rides at radius R(t) + u, height h(t) + v, angle θ(t).
    const carried = helixTransportPoint(tapered, 1, 2, 0.5);
    const θ = Math.PI / 2 + 3 * Math.PI; // θ(0.5) = θ₀ + H·2π·turns·0.5
    expect(carried[0]).toBeCloseTo((11 + 1) * Math.cos(θ), 12);
    expect(carried[1]).toBeCloseTo((11 + 1) * Math.sin(θ), 12);
    expect(carried[2]).toBeCloseTo(8, 12);
  });

  it("derives the flat spiral from pitch 0 + taper (and declines the circle)", () => {
    const spiral: CanonicalHelixSpine = {
      ...RIGHT_3_TURNS,
      pitchMm: 0,
      taperMm: 5,
    };
    expect(helixHeightAt(spiral, 1)).toBe(0);
    expect(helixRadiusAt(spiral, 1)).toBe(15);
    expect(helixSweepProblem(rectangle(0, -0.5, 2, 1), spiral)).toBeNull();
    const circle: CanonicalHelixSpine = { ...RIGHT_3_TURNS, pitchMm: 0 };
    const problem = helixSweepProblem(rectangle(0, -0.5, 2, 1), circle);
    expect(problem?.code).toBe(KERNEL_ERROR_CODES.invalidHelix);
  });
});

describe("helix validation battery", () => {
  const loop = rectangle(0, -0.75, 2, 1.5);

  it("accepts the canonical non-overlapping fixture", () => {
    expect(helixSweepProblem(loop, RIGHT_3_TURNS)).toBeNull();
    expect(helixTurnsOverlap(loop, RIGHT_3_TURNS)).toBe(false);
  });

  it("rejects the degenerate spines with the shared codes", () => {
    expect(
      helixSweepProblem(loop, { ...RIGHT_3_TURNS, radiusMm: 0 })?.code,
    ).toBe(KERNEL_ERROR_CODES.invalidLength);
    expect(
      helixSweepProblem(loop, { ...RIGHT_3_TURNS, pitchMm: -1 })?.code,
    ).toBe(KERNEL_ERROR_CODES.invalidHelix);
    expect(helixSweepProblem(loop, { ...RIGHT_3_TURNS, turns: 0 })?.code).toBe(
      KERNEL_ERROR_CODES.invalidHelix,
    );
    expect(
      helixSweepProblem(loop, { ...RIGHT_3_TURNS, taperMm: -11 })?.code,
    ).toBe(KERNEL_ERROR_CODES.invalidHelix);
  });

  it("rejects a profile that crosses the axis (touching stays legal)", () => {
    const crossing = rectangle(-12, -0.75, 2, 1.5);
    const problem = helixSweepProblem(crossing, RIGHT_3_TURNS);
    expect(problem?.code).toBe(KERNEL_ERROR_CODES.profileAxisCrossing);
    const touching = rectangle(-10, -0.75, 2, 1.5);
    expect(helixSweepProblem(touching, RIGHT_3_TURNS)).toBeNull();
  });

  it("flags turn overlap exactly at the axial-extent boundary", () => {
    // One pitch of axial extent at two turns: touching, not overlapping.
    expect(
      helixTurnsOverlap(rectangle(0, -2, 2, 4), {
        ...RIGHT_3_TURNS,
        pitchMm: 4,
      }),
    ).toBe(false);
    expect(
      helixTurnsOverlap(rectangle(0, -2.1, 2, 4.2), {
        ...RIGHT_3_TURNS,
        pitchMm: 4,
      }),
    ).toBe(true);
    // A single turn never overlaps.
    expect(
      helixTurnsOverlap(rectangle(0, -10, 2, 20), {
        ...RIGHT_3_TURNS,
        turns: 1,
        pitchMm: 4,
      }),
    ).toBe(false);
  });
});

describe("the exact screw volume", () => {
  it("derives the rectangle's Pappus-form value V = 2π·turns·A·d̄", () => {
    // A = 3, ū = 1, d̄ = 11: V = 2π·3·3·11 = 198π.
    const polygon = helixProfilePolygon(rectangle(0, -0.75, 2, 1.5));
    expect(helixScrewVolume(polygon, RIGHT_3_TURNS)).toBeCloseTo(
      2 * Math.PI * 3 * 3 * 11,
      9,
    );
  });

  it("adds the taper's mean-radius shift taper/2 and not the taper rate", () => {
    const polygon = helixProfilePolygon(rectangle(0, -0.75, 2, 1.5));
    const tapered = { ...RIGHT_3_TURNS, taperMm: 2 };
    // V = 2π·3·3·(11 + 1): the Jacobian's R(t) integrates to R̄ = 11.
    expect(helixScrewVolume(polygon, tapered)).toBeCloseTo(
      2 * Math.PI * 3 * 3 * 12,
      9,
    );
  });

  it("is winding-invariant (the moment divides by the signed area)", () => {
    const ccw = helixProfilePolygon(rectangle(0, -0.75, 2, 1.5));
    const cw = [...ccw].reverse();
    expect(helixScrewVolume(cw, RIGHT_3_TURNS)).toBeCloseTo(
      helixScrewVolume(ccw, RIGHT_3_TURNS),
      9,
    );
  });
});

describe("the inverse-screw membership", () => {
  const polygon = helixProfilePolygon(rectangle(0, -0.75, 2, 1.5));
  const spine: CanonicalHelixSpine = {
    radiusMm: 10,
    pitchMm: 4,
    turns: 3,
    handedness: 1,
    startAngleRad: 0,
    taperMm: 0,
  };

  it("classifies the carried material exactly across turns", () => {
    // The transported profile point (u=1, v=0) at t = 0: radius 11, angle
    // 0, height 0 — and again one pitch up at the same angle.
    expect(helixScrewContains(polygon, spine, 11, 0, 0, 1e-9)).toBe(true);
    expect(helixScrewContains(polygon, spine, 11, 0, 4, 1e-9)).toBe(true);
    // Halfway between turns at the same angle: the material sits one half
    // pitch off — v = 2 is outside the profile's v-extent ±0.75.
    expect(helixScrewContains(polygon, spine, 11, 0, 2, 1e-9)).toBe(false);
    // Off the radial band.
    expect(helixScrewContains(polygon, spine, 13, 0, 0, 1e-9)).toBe(false);
    // Past the swept height.
    expect(helixScrewContains(polygon, spine, 11, 0, 13, 1e-9)).toBe(false);
    // Before the start.
    expect(helixScrewContains(polygon, spine, 11, 0, -1, 1e-9)).toBe(false);
  });

  it("follows the screw constant: rotate by ψ, translate by (pitch/2π)·ψ", () => {
    // A point at angle φ is material iff the same radius at angle 0 is
    // material at height ζ − (pitch/2π)·φ (the screw reduction).
    const φ = 1.234;
    const κ = 4 / (2 * Math.PI);
    for (const [radius, height] of [
      [11, 0.2],
      [10.5, -0.6],
      [12, 0],
    ] as const) {
      expect(helixScrewContains(polygon, spine, radius, φ, height, 1e-9)).toBe(
        helixScrewContains(polygon, spine, radius, 0, height - κ * φ, 1e-9),
      );
    }
  });
});

describe("bounds and stations", () => {
  it("bounds the untapered screw solid exactly", () => {
    const polygon = helixProfilePolygon(rectangle(0, -0.75, 2, 1.5));
    const bounds = helixUntaperedLocalBounds(polygon, RIGHT_3_TURNS);
    expect(bounds.min).toEqual([-12, -12, -0.75]);
    expect(bounds.max).toEqual([12, 12, 12.75]);
    // A partial sweep (half a turn from θ₀ = 0): x spans [0, 12]... the
    // angular interval [0, π] crosses both cos extremes at 0 and π.
    const half = helixUntaperedLocalBounds(polygon, {
      ...RIGHT_3_TURNS,
      turns: 0.5,
    });
    expect(half.max[0]).toBeCloseTo(12, 9);
    expect(half.min[0]).toBeCloseTo(-12, 9);
    expect(half.max[1]).toBeCloseTo(12, 9);
    expect(half.min[1]).toBeCloseTo(0, 9);
  });

  it("stations the spine at the shared deflection, deterministically", () => {
    const stations = helixStations(RIGHT_3_TURNS);
    expect(stations.length).toBe(Math.ceil((6 * Math.PI) / 0.1) + 1);
    expect(stations[0]).toBe(0);
    expect(stations[stations.length - 1]).toBeCloseTo(1, 12);
    expect(helixStations(RIGHT_3_TURNS)).toEqual(stations);
  });

  it("converges quadratically when the station rule halves (the ruled band the fixtures pin)", () => {
    // The fixtures pin the ruled-station volume at sin(Δθ)/Δθ of the exact
    // screw value, Δθ the station step the shared rule yields on the
    // fixture spine. The pin's trust rests on the band CONVERGING: the
    // deficit 1 − sin(Δθ)/Δθ is Δθ²/6 to leading order, so doubling the
    // station count (halving the rule) quarters the deficit — the
    // convergence check the contract's OCCT coverage note cites, run here
    // on the fixture's own station arithmetic and exact volume.
    const polygon = helixProfilePolygon(rectangle(0, -0.75, 2, 1.5));
    const exact = helixScrewVolume(polygon, RIGHT_3_TURNS);
    const stations = helixStations(RIGHT_3_TURNS);
    const intervals = stations.length - 1;
    const step = Math.abs(helixSweptAngle(RIGHT_3_TURNS)) / intervals;
    // The doubled station count halves the step.
    expect(step).toBeGreaterThan(0);
    expect(step).toBeLessThanOrEqual(0.1);
    const band = (angleStep: number) => Math.sin(angleStep) / angleStep;
    const atRule = exact * band(step);
    const atDoubledStations = exact * band(step / 2);
    // Monotone approach from below the exact screw volume.
    expect(atRule).toBeLessThan(atDoubledStations);
    expect(atDoubledStations).toBeLessThan(exact);
    // The deficit QUARTERS under rule halving (second-order convergence),
    // within the derived O(Δθ⁴) slack 4·(1 ± 3·Δθ²/80).
    const deficitRatio = (exact - atRule) / (exact - atDoubledStations);
    expect(deficitRatio).toBeCloseTo(4, 2);
    expect(Math.abs(deficitRatio - 4)).toBeLessThan(
      (4 * (3 * step * step)) / 80 + 1e-9,
    );
  });
});

describe("dimensional round trip", () => {
  it("accepts any length/angle units through the adapters' canonicalization", () => {
    // The contract's dimensional spine canonicalizes through valueIn; the
    // canonical form the battery consumes is what the adapters build. The
    // 2 cm radius and 0.4 cm pitch equal the 10 mm / 4 mm fixture.
    const radius = length(2, "cm");
    const pitch = length(0.4, "cm");
    const startAngle = angle(90, "deg");
    expect(radius.value).toBe(2);
    expect(pitch.value).toBe(0.4);
    expect(startAngle.value).toBe(90);
  });
});
