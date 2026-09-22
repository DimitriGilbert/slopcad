import { describe, expect, it } from "vitest";
import { angle } from "@slopcad/cad-core";

import {
  insetPolygon,
  polygonSelfIntersects,
  taperInsetDistanceMm,
  taperedExtrudeProblem,
} from "./taper-geometry";
import { polygonSignedArea, type ProfilePoint2 } from "./profile-geometry";

const square = (size: number): ProfilePoint2[] => [
  { x: 0, y: 0 },
  { x: size, y: 0 },
  { x: size, y: size },
  { x: 0, y: size },
];

/** The CCW L the OCCT DraftAngle probe agreed with (A0 = 500, P0 = 100). */
const L_LOOP: ProfilePoint2[] = [
  { x: 0, y: 0 },
  { x: 30, y: 0 },
  { x: 30, y: 20 },
  { x: 10, y: 20 },
  { x: 10, y: 10 },
  { x: 0, y: 10 },
];

describe("insetPolygon", () => {
  it("insets a square to the concentric smaller square", () => {
    const inset = insetPolygon(square(10), 2);
    expect(inset).not.toBeNull();
    expect(polygonSignedArea(inset ?? [])).toBeCloseTo(36, 12);
  });

  it("expands on a negative distance (the widening draft)", () => {
    const outset = insetPolygon(square(10), -2);
    expect(outset).not.toBeNull();
    expect(polygonSignedArea(outset ?? [])).toBeCloseTo(196, 12);
  });

  it("keeps the L-loop's edge-parallel inset areas on the Steiner quadratic", () => {
    // A(d) = A0 − P0·d + κ·d², κ = Σ cot(θi/2) over interior angles: the L
    // carries five convex π/2 corners and one concave 3π/2 corner, κ = 4.
    const area0 = 500;
    const perimeter0 = 100;
    const cornerSum = 4;
    for (const d of [0.5, 1, 2.5]) {
      const inset = insetPolygon(L_LOOP, d);
      expect(inset).not.toBeNull();
      const expected = area0 - perimeter0 * d + cornerSum * d * d;
      expect(polygonSignedArea(inset ?? [])).toBeCloseTo(expected, 9);
    }
  });

  it("degenerates to null past the collapse (an edge reaches zero length)", () => {
    // The square's shortest inset lifetime is size/2 = 5.
    expect(insetPolygon(square(10), 5)).toBeNull();
    expect(insetPolygon(square(10), 6)).toBeNull();
  });
});

describe("polygonSelfIntersects", () => {
  it("accepts simple polygons and rejects crossed ones", () => {
    expect(polygonSelfIntersects(square(4))).toBe(false);
    expect(
      polygonSelfIntersects([
        { x: 0, y: 0 },
        { x: 10, y: 0 },
        { x: 0, y: 10 },
        { x: 10, y: 10 },
      ]),
    ).toBe(true);
  });
});

describe("taperInsetDistanceMm", () => {
  it("is height·tan(taper), converting angle units", () => {
    expect(taperInsetDistanceMm(10, angle(5, "deg"))).toBeCloseTo(
      10 * Math.tan((5 * Math.PI) / 180),
      12,
    );
    expect(taperInsetDistanceMm(10, angle(0.1, "rad"))).toBeCloseTo(
      10 * Math.tan(0.1),
      12,
    );
  });

  it("is null outside the ±π/2 domain", () => {
    expect(taperInsetDistanceMm(10, angle(Math.PI / 2))).toBeNull();
    expect(taperInsetDistanceMm(10, angle(-Math.PI / 2))).toBeNull();
    expect(taperInsetDistanceMm(10, angle(Math.PI))).toBeNull();
  });
});

describe("taperedExtrudeProblem", () => {
  const lineLoop = [
    {
      kind: "line" as const,
      start: [0, 0] as const,
      end: [30, 0] as const,
    },
    {
      kind: "line" as const,
      start: [30, 0] as const,
      end: [30, 20] as const,
    },
    {
      kind: "line" as const,
      start: [30, 20] as const,
      end: [0, 20] as const,
    },
    {
      kind: "line" as const,
      start: [0, 20] as const,
      end: [0, 0] as const,
    },
  ];

  it("accepts the healthy drafts (positive, negative, zero) with no problem", () => {
    expect(taperedExtrudeProblem(lineLoop, 10, angle(0))).toBeNull();
    expect(taperedExtrudeProblem(lineLoop, 10, angle(5, "deg"))).toBeNull();
    expect(taperedExtrudeProblem(lineLoop, 10, angle(-5, "deg"))).toBeNull();
  });

  it("rejects the angle domain and the collapsing inset with the shared code", () => {
    expect(taperedExtrudeProblem(lineLoop, 10, angle(Math.PI / 2))?.code).toBe(
      "kernel/invalid-taper",
    );
    // tan(84.3°) ≈ 10 → H ≈ 100 mm collapses the 20 mm-deep rectangle.
    expect(taperedExtrudeProblem(lineLoop, 10, angle(84.3, "deg"))?.code).toBe(
      "kernel/invalid-taper",
    );
  });

  it("accepts curved loops (the chord polygon carries the battery)", () => {
    const circleLoop = [
      { kind: "circle" as const, center: [0, 0] as const, radius: 10 },
    ];
    expect(taperedExtrudeProblem(circleLoop, 10, angle(5, "deg"))).toBeNull();
    expect(taperedExtrudeProblem(circleLoop, 10, angle(89, "deg"))?.code).toBe(
      "kernel/invalid-taper",
    );
  });
});
