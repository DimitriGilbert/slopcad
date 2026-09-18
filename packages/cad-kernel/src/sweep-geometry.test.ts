/**
 * Sweep-geometry helper tests (Phase 26.3): the path battery's structured
 * taxonomy (structure, self-intersection, the per-arc bend-axis crossing),
 * the piece decomposition's fixed-binormal stations, and the Pappus-exact
 * swept volume — the shared math every implementing kernel runs and the
 * fake kernel measures by.
 */

import { describe, expect, it } from "vitest";
import { angle } from "@slopcad/cad-core";
import type { ProfileSegmentInput, SweepPathSegmentInput } from "./contract";

import {
  decomposeSweepPath,
  polygonMomentU,
  polygonSignedArea,
  sweepAnalyticVolume,
  sweepArcStation,
  sweepPathChordPoints,
  sweepPathClosed,
  sweepPathProblem,
  sweepPathSelfIntersects,
  sweepPieceStations,
  sweepProfileArcAxisCrossing,
  tessellateProfileLoop,
} from "./profile-geometry";

/** A CCW rectangle loop (u ∈ [x0, x0+w], v ∈ [y0, y0+h]). */
function rectangleLoop(
  x0: number,
  y0: number,
  w: number,
  h: number,
): readonly ProfileSegmentInput[] {
  return [
    { kind: "line", start: [x0, y0], end: [x0 + w, y0] },
    { kind: "line", start: [x0 + w, y0], end: [x0 + w, y0 + h] },
    { kind: "line", start: [x0 + w, y0 + h], end: [x0, y0 + h] },
    { kind: "line", start: [x0, y0 + h], end: [x0, y0] },
  ];
}

/** The canonical quarter-arc bend: CCW, radius 30, from the origin along +z. */
function quarterArcPath(): readonly SweepPathSegmentInput[] {
  return [
    {
      kind: "arc",
      center: [-30, 0],
      radius: 30,
      startAngle: angle(0),
      endAngle: angle(Math.PI / 2),
    },
  ];
}

/** A valid G1 chain: 20 up, quarter bend left, 20 on in −x. */
function chainedPath(): readonly SweepPathSegmentInput[] {
  return [
    { kind: "line", start: [0, 0], end: [0, 20] },
    {
      kind: "arc",
      center: [-30, 20],
      radius: 30,
      startAngle: angle(0),
      endAngle: angle(Math.PI / 2),
    },
    { kind: "line", start: [-30, 50], end: [-50, 50] },
  ];
}

describe("sweepPathProblem (structural path battery)", () => {
  it("accepts the canonical fixtures", () => {
    expect(
      sweepPathProblem([{ kind: "line", start: [0, 0], end: [0, 40] }]),
    ).toBeNull();
    expect(sweepPathProblem(quarterArcPath())).toBeNull();
    expect(sweepPathProblem(chainedPath())).toBeNull();
  });

  it("rejects an empty path", () => {
    expect(sweepPathProblem([])).toContain("empty");
  });

  it("rejects a path that does not start at the local origin", () => {
    const problem = sweepPathProblem([
      { kind: "line", start: [5, 0], end: [5, 40] },
    ]);
    expect(problem).toContain("start at the local origin");
  });

  it("rejects an oblique initial tangent (the perpendicular-attachment rule)", () => {
    const problem = sweepPathProblem([
      { kind: "line", start: [0, 0], end: [10, 40] },
    ]);
    expect(problem).toContain("perpendicular-attachment");
  });

  it("rejects an arc whose initial tangent is not +z", () => {
    // A CCW arc through the origin with start angle π/4 (the centre sits
    // opposite the start point): tangent (−sin, cos) at π/4 is oblique.
    const offset = 30 * Math.cos(Math.PI / 4);
    const problem = sweepPathProblem([
      {
        kind: "arc",
        center: [-offset, -offset],
        radius: 30,
        startAngle: angle(Math.PI / 4),
        endAngle: angle(Math.PI / 2 + Math.PI / 4),
      },
    ]);
    expect(problem).toContain("perpendicular-attachment");
  });

  it("accepts the mirrored clockwise arc (start angle π, tangent +z)", () => {
    expect(
      sweepPathProblem([
        {
          kind: "arc",
          center: [30, 0],
          radius: 30,
          startAngle: angle(Math.PI),
          endAngle: angle(Math.PI / 2),
        },
      ]),
    ).toBeNull();
  });

  it("rejects degenerate segments: zero-length line, zero radius, zero sweep, over-full sweep", () => {
    expect(
      sweepPathProblem([{ kind: "line", start: [0, 0], end: [0, 0] }]),
    ).toContain("degenerate");
    expect(
      sweepPathProblem([
        {
          kind: "arc",
          center: [-30, 0],
          radius: 0,
          startAngle: angle(0),
          endAngle: angle(Math.PI / 2),
        },
      ]),
    ).toContain("degenerate");
    expect(
      sweepPathProblem([
        {
          kind: "arc",
          center: [-30, 0],
          radius: 30,
          startAngle: angle(0.5),
          endAngle: angle(0.5),
        },
      ]),
    ).toContain("degenerate");
    expect(
      sweepPathProblem([
        {
          kind: "arc",
          center: [-30, 0],
          radius: 30,
          startAngle: angle(0),
          endAngle: angle(Math.PI * 2 + 0.5),
        },
      ]),
    ).toContain("degenerate");
  });

  it("rejects a gap in the chain", () => {
    const problem = sweepPathProblem([
      { kind: "line", start: [0, 0], end: [0, 20] },
      { kind: "line", start: [0, 25], end: [0, 40] },
    ]);
    expect(problem).toContain("does not continue");
  });

  it("rejects a tangent kink at a joint", () => {
    const problem = sweepPathProblem([
      { kind: "line", start: [0, 0], end: [0, 20] },
      { kind: "line", start: [0, 20], end: [20, 20] },
    ]);
    expect(problem).toContain("tangent discontinuity");
  });

  it("rejects a closed ring whose wrap joint kinks", () => {
    // G1 through every interior joint, closing on the origin with the
    // final tangent +x against the first tangent +z.
    const problem = sweepPathProblem([
      { kind: "line", start: [0, 0], end: [0, 40] },
      {
        kind: "arc",
        center: [-10, 40],
        radius: 10,
        startAngle: angle(0),
        endAngle: angle(Math.PI),
      },
      { kind: "line", start: [-20, 40], end: [-20, 10] },
      {
        kind: "arc",
        center: [-10, 10],
        radius: 10,
        startAngle: angle(Math.PI),
        endAngle: angle((3 * Math.PI) / 2),
      },
      { kind: "line", start: [-10, 0], end: [0, 0] },
    ]);
    expect(problem).toContain("closure joint");
  });
});

describe("sweepPathClosed", () => {
  it("marks the full-circle arc and returning chains, not open ones", () => {
    expect(
      sweepPathClosed([
        {
          kind: "arc",
          center: [-30, 0],
          radius: 30,
          startAngle: angle(0),
          endAngle: angle(Math.PI * 2),
        },
      ]),
    ).toBe(true);
    expect(sweepPathClosed(quarterArcPath())).toBe(false);
    expect(
      sweepPathClosed([
        { kind: "line", start: [0, 0], end: [0, 40] },
        { kind: "line", start: [0, 40], end: [0, 0] },
      ]),
    ).toBe(true);
  });
});

describe("sweepPathSelfIntersects (chord-polyline crossing)", () => {
  it("accepts the canonical fixtures", () => {
    expect(sweepPathSelfIntersects(chainedPath())).toBe(false);
    expect(sweepPathSelfIntersects(quarterArcPath())).toBe(false);
    expect(
      sweepPathSelfIntersects([
        {
          kind: "arc",
          center: [-30, 0],
          radius: 30,
          startAngle: angle(0),
          endAngle: angle(Math.PI * 2),
        },
      ]),
    ).toBe(false);
  });

  it("detects a G1 horseshoe whose return leg crosses the entry leg", () => {
    expect(
      sweepPathSelfIntersects([
        { kind: "line", start: [0, 0], end: [0, 40] },
        {
          kind: "arc",
          center: [-15, 40],
          radius: 15,
          startAngle: angle(0),
          endAngle: angle(Math.PI),
        },
        { kind: "line", start: [-30, 40], end: [-30, 20] },
        {
          kind: "arc",
          center: [-15, 20],
          radius: 15,
          startAngle: angle(Math.PI),
          endAngle: angle((3 * Math.PI) / 2),
        },
        { kind: "line", start: [-15, 5], end: [15, 5] },
      ]),
    ).toBe(true);
  });

  it("detects collinear overlap away from shared endpoints", () => {
    expect(
      sweepPathSelfIntersects([
        { kind: "line", start: [0, 0], end: [0, 40] },
        { kind: "line", start: [0, 40], end: [0, 10] },
        { kind: "line", start: [0, 10], end: [0, 30] },
      ]),
    ).toBe(true);
  });
});

describe("sweepProfileArcAxisCrossing (the tight-bend pinch)", () => {
  it("rejects a section wider than the bend radius", () => {
    const crossing = sweepProfileArcAxisCrossing(
      rectangleLoop(-35, -2, 40, 4),
      quarterArcPath(),
    );
    expect(crossing).not.toBeNull();
    expect(crossing?.uAxis).toBe(-30);
    expect(crossing?.min).toBeLessThan(-30);
    expect(crossing?.max).toBeGreaterThan(-30);
  });

  it("allows touching and fully-mirrored sections", () => {
    // Touching: the section's inner edge lies exactly on the axis.
    expect(
      sweepProfileArcAxisCrossing(
        rectangleLoop(-30, -2, 35, 4),
        quarterArcPath(),
      ),
    ).toBeNull();
    // Fully beyond the axis (the mirrored tube): one-sided, legal.
    expect(
      sweepProfileArcAxisCrossing(
        rectangleLoop(-40, -2, 5, 4),
        quarterArcPath(),
      ),
    ).toBeNull();
  });

  it("checks the clockwise bend against its +u axis", () => {
    const crossing = sweepProfileArcAxisCrossing(rectangleLoop(25, -2, 40, 4), [
      {
        kind: "arc",
        center: [30, 0],
        radius: 30,
        startAngle: angle(Math.PI),
        endAngle: angle(Math.PI / 2),
      },
    ]);
    expect(crossing).not.toBeNull();
    expect(crossing?.uAxis).toBe(30);
  });
});

describe("decomposeSweepPath and the station frames", () => {
  it("decomposes a chain into pieces with the fixed-binormal frames", () => {
    const pieces = decomposeSweepPath(chainedPath());
    expect(pieces).toHaveLength(3);
    const [line, arc, tail] = pieces;
    if (line?.kind !== "line") throw new Error("expected a line piece");
    // Initial tangent +z: e1 = rot−90(t) = +x.
    expect(line.e1.x).toBeCloseTo(1, 12);
    expect(line.e1.z).toBeCloseTo(0, 12);
    expect(line.length).toBeCloseTo(20, 12);
    if (arc?.kind !== "arc") throw new Error("expected an arc piece");
    expect(arc.sweep).toBeCloseTo(Math.PI / 2, 12);
    const first = sweepPieceStations(arc)[0];
    // The arc's first station sits at the joint, e1 still +x (G1).
    expect(first?.position.x).toBeCloseTo(0, 9);
    expect(first?.position.z).toBeCloseTo(20, 9);
    expect(first?.e1.x).toBeCloseTo(1, 9);
    if (tail?.kind !== "line") throw new Error("expected a tail piece");
    // After the quarter bend the tangent is −x, so e1 = rot−90((−1,0)) = +z.
    expect(tail.e1.x).toBeCloseTo(0, 12);
    expect(tail.e1.z).toBeCloseTo(1, 12);
  });

  it("subdivides arc stations at the shared deflection", () => {
    const pieces = decomposeSweepPath(quarterArcPath());
    const arc = pieces[0];
    if (arc?.kind !== "arc") throw new Error("expected an arc piece");
    const stations = sweepPieceStations(arc);
    // ceil((π/2)/0.1) = 16 intervals → 17 stations.
    expect(stations).toHaveLength(17);
    const last = stations[stations.length - 1];
    // The bend ends at the arc's π/2 point (−30, 30) heading −x, so the
    // rotated e1 (rot−90 of the tangent) points +z.
    expect(last?.position.x).toBeCloseTo(-30, 9);
    expect(last?.position.z).toBeCloseTo(30, 9);
    expect(last?.e1.x).toBeCloseTo(0, 9);
    expect(last?.e1.z).toBeCloseTo(1, 9);
  });

  it("mirrors the clockwise arc's stations", () => {
    const stations = decomposeSweepPath([
      {
        kind: "arc",
        center: [30, 0],
        radius: 30,
        startAngle: angle(Math.PI),
        endAngle: angle(Math.PI / 2),
      },
    ]).flatMap((piece) => sweepPieceStations(piece));
    const first = stations[0];
    const last = stations[stations.length - 1];
    // Starts at the origin with e1 = +x; ends at (30, 30) heading +x, so
    // the mirrored e1 (rot−90 of the tangent) points −z.
    expect(first?.position.x).toBeCloseTo(0, 9);
    expect(first?.position.z).toBeCloseTo(0, 9);
    expect(first?.e1.x).toBeCloseTo(1, 9);
    expect(last?.position.x).toBeCloseTo(30, 9);
    expect(last?.position.z).toBeCloseTo(30, 9);
    expect(last?.e1.x).toBeCloseTo(0, 9);
    expect(last?.e1.z).toBeCloseTo(-1, 9);
  });

  it("tessellates the path's chord points along the chain", () => {
    const points = sweepPathChordPoints([
      { kind: "line", start: [0, 0], end: [0, 20] },
    ]);
    expect(points).toEqual([
      { x: 0, z: 0 },
      { x: 0, z: 20 },
    ]);
  });
});

describe("sweepAnalyticVolume (the Pappus decomposition)", () => {
  it("computes the polygon's u-moment exactly", () => {
    // The unit square [0,1]²: ∫u dA = 1/2.
    const square = tessellateProfileLoop(rectangleLoop(0, 0, 1, 1));
    expect(polygonMomentU(square)).toBeCloseTo(0.5, 12);
    expect(polygonSignedArea(square)).toBeCloseTo(1, 12);
  });

  it("straight paths are Cavalieri prisms: V = A·L", () => {
    const polygon = tessellateProfileLoop(rectangleLoop(-3, -2, 6, 4));
    const pieces = decomposeSweepPath([
      { kind: "line", start: [0, 0], end: [0, 40] },
    ]);
    expect(sweepAnalyticVolume(polygon, pieces)).toBeCloseTo(24 * 40, 9);
  });

  it("arc paths are Pappus revolutions: V = θ·d̄·A, offset profiles included", () => {
    const centered = tessellateProfileLoop(rectangleLoop(-3, -2, 6, 4));
    expect(
      sweepAnalyticVolume(centered, decomposeSweepPath(quarterArcPath())),
    ).toBeCloseTo((Math.PI / 2) * 30 * 24, 9);
    // The centroid moved 2 mm toward the outside: d̄ = 32.
    const offset = tessellateProfileLoop(rectangleLoop(-1, -2, 6, 4));
    expect(
      sweepAnalyticVolume(offset, decomposeSweepPath(quarterArcPath())),
    ).toBeCloseTo((Math.PI / 2) * 32 * 24, 9);
  });

  it("clockwise arcs subtract the offset: d̄ = |ū − R|", () => {
    // Centroid at u = 2, right bend of radius 30: d̄ = 28.
    const polygon = tessellateProfileLoop(rectangleLoop(1, -2, 2, 4));
    const pieces = decomposeSweepPath([
      {
        kind: "arc",
        center: [30, 0],
        radius: 30,
        startAngle: angle(Math.PI),
        endAngle: angle(Math.PI / 2),
      },
    ]);
    expect(sweepAnalyticVolume(polygon, pieces)).toBeCloseTo(
      (Math.PI / 2) * 28 * 8,
      9,
    );
  });

  it("sums the chain: Cavalieri + Pappus + Cavalieri", () => {
    const polygon = tessellateProfileLoop(rectangleLoop(-3, -2, 6, 4));
    expect(
      sweepAnalyticVolume(polygon, decomposeSweepPath(chainedPath())),
    ).toBeCloseTo(24 * 20 + (Math.PI / 2) * 30 * 24 + 24 * 20, 9);
  });

  it("the closed ring is the full torus: V = 2π·R·A", () => {
    const polygon = tessellateProfileLoop(rectangleLoop(-3, -2, 6, 4));
    const pieces = decomposeSweepPath([
      {
        kind: "arc",
        center: [-30, 0],
        radius: 30,
        startAngle: angle(0),
        endAngle: angle(Math.PI * 2),
      },
    ]);
    expect(sweepAnalyticVolume(polygon, pieces)).toBeCloseTo(
      Math.PI * 2 * 30 * 24,
      9,
    );
  });

  it("arc stations expose the travel frame directly", () => {
    const arc = decomposeSweepPath(quarterArcPath())[0];
    if (arc?.kind !== "arc") throw new Error("expected an arc piece");
    const quarter = sweepArcStation(arc, 1);
    expect(quarter.position.x).toBeCloseTo(-30, 9);
    expect(quarter.position.z).toBeCloseTo(30, 9);
  });
});
