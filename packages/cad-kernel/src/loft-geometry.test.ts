/**
 * Loft geometry helper tests (Phase 26.4): the shared collection battery
 * (`loftSectionsProblem` — member validity, station ordering, vertex-count
 * compatibility — each mapped to its structured code), the CCW
 * normalization (`loftSectionPolygons`), the linear morph
 * (`morphPolygons`), and the Simpson/prismoidal volume identities
 * (`loftAnalyticVolume`): a constant morph is the prism, similar
 * concentric polygons give the frustum value `h/3·(B₁+B₂+√(B₁B₂))`, the
 * twisted square's closed form `(1+2cos²(π/8))/3·a²h`, and signed mid-span
 * honesty for adversarial twists.
 */

import { describe, expect, it } from "vitest";
import { length } from "@slopcad/cad-core";

import { KERNEL_ERROR_CODES, type ProfileLoftSectionInput } from "./contract";
import {
  loftAnalyticVolume,
  loftSectionPolygons,
  loftSectionsProblem,
  loftStations,
  morphPolygons,
  polygonSignedArea,
  type ProfilePoint2,
} from "./profile-geometry";

/**
 * The fixture sections' chord polygons, dense for the type checker
 * (section arrays are literals; the validator guarantees their shape).
 */
function fixturePolygons(
  sections: readonly ProfileLoftSectionInput[],
): readonly (readonly ProfilePoint2[])[] {
  const out: (readonly ProfilePoint2[])[] = [];
  for (const polygon of loftSectionPolygons(sections)) {
    if (polygon === undefined) {
      throw new Error("Invariant violation: fixture sections are dense.");
    }
    out.push(polygon);
  }
  return out;
}

/** A centred CCW square section of the given side. */
function squareSection(side: number, z: number): ProfileLoftSectionInput {
  const h = side / 2;
  return {
    loop: [
      { kind: "line", start: [h, h], end: [-h, h] },
      { kind: "line", start: [-h, h], end: [-h, -h] },
      { kind: "line", start: [-h, -h], end: [h, -h] },
      { kind: "line", start: [h, -h], end: [h, h] },
    ],
    z: length(z),
  };
}

/** The square rotated 45° about the origin (the diamond), CCW from top. */
function diamondSection(side: number, z: number): ProfileLoftSectionInput {
  const r = (side / 2) * Math.SQRT2;
  return {
    loop: [
      { kind: "line", start: [0, r], end: [-r, 0] },
      { kind: "line", start: [-r, 0], end: [0, -r] },
      { kind: "line", start: [0, -r], end: [r, 0] },
      { kind: "line", start: [r, 0], end: [0, r] },
    ],
    z: length(z),
  };
}

describe("loftSectionsProblem (the collection battery)", () => {
  it("accepts a sound collection and reports its stations", () => {
    const sections = [squareSection(10, 0), squareSection(5, 20)];
    expect(loftSectionsProblem(sections)).toBeNull();
    expect(loftStations(sections)).toEqual([0, 20]);
  });

  it("rejects fewer than two sections with the operand-count code", () => {
    const problem = loftSectionsProblem([]);
    expect(problem?.code).toBe(KERNEL_ERROR_CODES.invalidOperands);
    const single = loftSectionsProblem([squareSection(10, 0)]);
    expect(single?.code).toBe(KERNEL_ERROR_CODES.invalidOperands);
  });

  it("rejects an invalid member with kernel/invalid-profile, naming the 1-based index", () => {
    const problem = loftSectionsProblem([
      squareSection(10, 0),
      {
        ...squareSection(10, 10),
        loop: squareSection(10, 10).loop.slice(0, 3),
      },
    ]);
    expect(problem?.code).toBe(KERNEL_ERROR_CODES.invalidProfile);
    expect(problem?.message).toContain("section 2");
  });

  it("rejects a zero-area member with kernel/invalid-profile", () => {
    const problem = loftSectionsProblem([
      squareSection(10, 0),
      {
        loop: [
          { kind: "line", start: [0, 0], end: [10, 0] },
          { kind: "line", start: [10, 0], end: [20, 0] },
          { kind: "line", start: [20, 0], end: [10, 0] },
          { kind: "line", start: [10, 0], end: [0, 0] },
        ],
        z: length(10),
      },
    ]);
    expect(problem?.code).toBe(KERNEL_ERROR_CODES.invalidProfile);
  });

  it("rejects non-increasing stations with kernel/loft-unordered-stations", () => {
    const equalZ = loftSectionsProblem([
      squareSection(10, 5),
      squareSection(10, 5),
    ]);
    expect(equalZ?.code).toBe(KERNEL_ERROR_CODES.loftUnorderedStations);
    expect(equalZ?.message).toContain("strictly increase");
    const foldBack = loftSectionsProblem([
      squareSection(10, 10),
      squareSection(10, 5),
    ]);
    expect(foldBack?.code).toBe(KERNEL_ERROR_CODES.loftUnorderedStations);
  });

  it("rejects mismatched chord vertex counts with kernel/loft-incompatible-profiles", () => {
    const problem = loftSectionsProblem([
      squareSection(10, 0),
      { loop: [{ kind: "circle", center: [0, 0], radius: 5 }], z: length(10) },
    ]);
    expect(problem?.code).toBe(KERNEL_ERROR_CODES.loftIncompatibleProfiles);
    expect(problem?.message).toContain("4 for section 1");
    expect(problem?.message).toContain("63 for section 2");
  });

  it("normalizes every section CCW independently (winding is not a rule)", () => {
    // The same square walked clockwise: each segment's endpoints swapped
    // and the segment order reversed (a valid closed loop, CW winding).
    const ccw = squareSection(10, 0).loop;
    const cwLoop = [...ccw]
      .reverse()
      .map((segment) =>
        segment.kind === "line"
          ? { ...segment, start: segment.end, end: segment.start }
          : segment,
      );
    const cw: ProfileLoftSectionInput = { loop: cwLoop, z: length(0) };
    expect(loftSectionsProblem([cw, squareSection(10, 10)])).toBeNull();
    const polygons = loftSectionPolygons([cw, squareSection(10, 10)]);
    for (const polygon of polygons) {
      expect(polygonSignedArea(polygon)).toBeGreaterThan(0);
    }
    // The same square, same area — though the reversed authoring re-phases
    // the starting vertex, which is the documented index-correspondence
    // behaviour: the loop's own parameterization defines the morph's phase.
    expect(polygonSignedArea(polygons[0] ?? [])).toBeCloseTo(
      polygonSignedArea(polygons[1] ?? []),
      12,
    );
  });
});

describe("morphPolygons and loftAnalyticVolume (the Simpson model)", () => {
  it("blends corresponding vertices linearly", () => {
    const a = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
    ];
    const b = [
      { x: 4, y: 4 },
      { x: 6, y: 8 },
    ];
    expect(morphPolygons(a, b, 0)).toEqual(a);
    expect(morphPolygons(a, b, 1)).toEqual(b);
    expect(morphPolygons(a, b, 0.5)).toEqual([
      { x: 2, y: 2 },
      { x: 8, y: 4 },
    ]);
  });

  it("gives identical sections the prism volume exactly (the extrude identity)", () => {
    const polygons = [
      ...fixturePolygons([squareSection(10, 0)]),
      ...fixturePolygons([squareSection(10, 40)]),
    ];
    expect(loftAnalyticVolume(polygons, [0, 40])).toBeCloseTo(100 * 40, 12);
  });

  it("gives similar concentric sections the frustum value h/3·(B₁+B₂+√(B₁B₂))", () => {
    const polygons = [
      ...fixturePolygons([squareSection(10, 0)]),
      ...fixturePolygons([squareSection(5, 10)]),
    ];
    const frustum = (10 / 3) * (100 + 25 + Math.sqrt(100 * 25));
    expect(loftAnalyticVolume(polygons, [0, 10])).toBeCloseTo(frustum, 10);
  });

  it("gives the twisted square its closed form (1+2cos²(π/8))/3·a²h", () => {
    const polygons = [
      ...fixturePolygons([squareSection(10, 0)]),
      ...fixturePolygons([diamondSection(10, 10)]),
    ];
    const simpson =
      (10 / 6) * (100 + 4 * 100 * Math.cos(Math.PI / 8) ** 2 + 100);
    // (1+2cos²(π/8))/3·100·10 ≡ the Simpson sum over the quadratic area.
    expect(((1 + 2 * Math.cos(Math.PI / 8) ** 2) / 3) * 100 * 10).toBeCloseTo(
      simpson,
      10,
    );
    expect(loftAnalyticVolume(polygons, [0, 10])).toBeCloseTo(simpson, 10);
  });

  it("sums piecewise over multi-station spans", () => {
    const sections = [
      squareSection(10, 0),
      squareSection(10, 10),
      squareSection(5, 20),
    ];
    const polygons = loftSectionPolygons(sections);
    const piecewise = 100 * 10 + (10 / 6) * (100 + 4 * 56.25 + 25);
    expect(loftAnalyticVolume(polygons, loftStations(sections))).toBeCloseTo(
      piecewise,
      10,
    );
  });
});
