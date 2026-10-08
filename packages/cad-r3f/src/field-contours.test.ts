/**
 * Phase 62b iso-contour coverage: marching squares against analytic
 * fields (a linear ramp's contour is a straight coordinate line; a radial
 * bowl's contour lies on its circle), the saddle rule pinned by hand on
 * both diagonal families × both center sides, thresholds outside the
 * range emitting nothing, and the loud-refusal cases.
 */

import type * as THREE from "three";
import { describe, expect, it } from "vitest";

import { CAD_FIELD_COLORMAP_VIRIDIS, fieldColorRamp } from "./field-colormaps";
import { decodedFieldGrid } from "./field-grid";
import { buildFieldContourGeometry } from "./field-contours";
import { CUBE_LATTICE, scalarFieldBlock } from "./field-fixtures";

/** The tests' fixed color scale. */
const SCALE = { colormap: CAD_FIELD_COLORMAP_VIRIDIS } as const;

/** Reads the contour positions as [x, y, z] triples. */
function contourPoints(
  geometry: THREE.BufferGeometry,
): [number, number, number][] {
  const position = geometry.getAttribute("position");
  const points: [number, number, number][] = [];
  for (let index = 0; index < position.count; index += 1) {
    points.push([
      position.getX(index),
      position.getY(index),
      position.getZ(index),
    ]);
  }
  return points;
}

describe("buildFieldContourGeometry", () => {
  it("a linear ramp's contour is the straight coordinate line", () => {
    const grid = decodedFieldGrid(
      scalarFieldBlock("ramp", CUBE_LATTICE, (x) => x, "mm"),
    );
    const geometry = buildFieldContourGeometry(
      grid,
      { slice: { axis: "z", positionMm: 0 }, thresholds: [2.5] },
      SCALE,
    );
    const points = contourPoints(geometry);
    // One segment per in-plane cell row crossing x = 2.5: 4 segments,
    // 8 endpoints, every one exactly on the line.
    expect(points).toHaveLength(8);
    for (const [x, y, z] of points) {
      expect(x).toBe(2.5);
      expect(y).toBeGreaterThanOrEqual(0);
      expect(y).toBeLessThanOrEqual(4);
      expect(z).toBe(0);
    }
    // The deterministic emission order: bottom-then-top per cell, cells
    // x-fastest — segment k runs from y = k to y = k + 1.
    expect(points[0]).toEqual([2.5, 0, 0]);
    expect(points[1]).toEqual([2.5, 1, 0]);
    expect(points[6]).toEqual([2.5, 3, 0]);
    expect(points[7]).toEqual([2.5, 4, 0]);
  });

  it("a radial bowl's contour lies on its circle", () => {
    const lattice = {
      shape: [21, 21, 1] as const,
      originMm: [-10, -10, 0] as const,
      spacingMm: [1, 1, 1] as const,
    };
    const grid = decodedFieldGrid(
      scalarFieldBlock(
        "bowl",
        lattice,
        (x, y) => Math.sqrt(x * x + y * y),
        "mm",
      ),
    );
    const geometry = buildFieldContourGeometry(
      grid,
      { slice: { axis: "z", positionMm: 0 }, thresholds: [5] },
      SCALE,
    );
    const points = contourPoints(geometry);
    expect(points.length).toBeGreaterThan(8);
    for (const [x, y] of points) {
      const radius = Math.sqrt(x * x + y * y);
      // Segment endpoints interpolate linearly across 1 mm cells: the
      // chord of a circle of radius 5 sits within a quarter-cell of it.
      expect(Math.abs(radius - 5)).toBeLessThan(0.25 + 1e-9);
    }
  });

  it("thresholds outside the slice's range emit nothing", () => {
    const grid = decodedFieldGrid(
      scalarFieldBlock("ramp", CUBE_LATTICE, (x) => x, "mm"),
    );
    for (const threshold of [-1, 4.5]) {
      const geometry = buildFieldContourGeometry(
        grid,
        { slice: { axis: "z", positionMm: 0 }, thresholds: [threshold] },
        SCALE,
      );
      expect(geometry.getAttribute("position").count).toBe(0);
      expect(geometry.getAttribute("color").count).toBe(0);
    }
  });

  it("a threshold exactly at a node value rides the >= convention", () => {
    // f = x with threshold 2: every corner with x >= 2 is inside, so the
    // crossings sit ON the x = 2 nodes (interpolation fraction 0).
    const grid = decodedFieldGrid(
      scalarFieldBlock("ramp", CUBE_LATTICE, (x) => x, "mm"),
    );
    const geometry = buildFieldContourGeometry(
      grid,
      { slice: { axis: "z", positionMm: 0 }, thresholds: [2] },
      SCALE,
    );
    const points = contourPoints(geometry);
    expect(points).toHaveLength(8);
    for (const [x] of points) {
      expect(x).toBe(2);
    }
  });

  it("paints both endpoints of every segment the threshold's color", () => {
    const grid = decodedFieldGrid(
      scalarFieldBlock("ramp", CUBE_LATTICE, (x) => x, "mm"),
    );
    const geometry = buildFieldContourGeometry(
      grid,
      { slice: { axis: "z", positionMm: 0 }, thresholds: [2.5] },
      SCALE,
    );
    const color = geometry.getAttribute("color");
    const ramp = fieldColorRamp(SCALE, grid.range);
    const expected = ramp(2.5);
    // The attribute write quantizes to float32 — the fround wrapping.
    const fround = [
      Math.fround(expected[0]),
      Math.fround(expected[1]),
      Math.fround(expected[2]),
    ];
    for (let index = 0; index < color.count; index += 1) {
      expect([color.getX(index), color.getY(index), color.getZ(index)]).toEqual(
        fround,
      );
    }
  });

  it("is deterministic: identical inputs build identical buffers", () => {
    const grid = decodedFieldGrid(
      scalarFieldBlock("bowl", CUBE_LATTICE, (x, y) => x * x + y * y, "mm^2"),
    );
    const build = (): THREE.BufferGeometry =>
      buildFieldContourGeometry(
        grid,
        { slice: { axis: "z", positionMm: 0 }, thresholds: [2, 4, 8] },
        SCALE,
      );
    expect([...build().getAttribute("position").array]).toEqual([
      ...build().getAttribute("position").array,
    ]);
    expect([...build().getAttribute("color").array]).toEqual([
      ...build().getAttribute("color").array,
    ]);
  });

  it("refuses a non-finite threshold or plane position", () => {
    const grid = decodedFieldGrid(
      scalarFieldBlock("ramp", CUBE_LATTICE, (x) => x, "mm"),
    );
    expect(() =>
      buildFieldContourGeometry(
        grid,
        { slice: { axis: "z", positionMm: 0 }, thresholds: [Number.NaN] },
        SCALE,
      ),
    ).toThrow(RangeError);
    expect(() =>
      buildFieldContourGeometry(
        grid,
        {
          slice: { axis: "z", positionMm: Number.POSITIVE_INFINITY },
          thresholds: [1],
        },
        SCALE,
      ),
    ).toThrow(RangeError);
  });
});

describe("the saddle rule (diagonal + center disambiguation)", () => {
  /** A one-cell field: the 2×2×1 lattice's four corner values, pinned. */
  const saddleGrid = (c00: number, c10: number, c01: number, c11: number) =>
    decodedFieldGrid({
      id: "saddle",
      extent: [2, 2, 1],
      originMm: [0, 0, 0],
      spacingMm: [1, 1, 1],
      dataType: "float64",
      values: [c00, c10, c01, c11],
    });

  it("inside diagonal c00–c11 with the center inside connects through the middle", () => {
    // Corners 4, 0, 0, 4 around threshold 1.5: the c00–c11 diagonal is
    // inside and the corner mean 2 is above the threshold, so the
    // bilinear region runs c00–center–c11 and the segments isolate the
    // OUTSIDE corners — (bottom, right) around c10 and (left, top)
    // around c01. The 4→0 edges cross at fraction 0.625, the 0→4 edges
    // at 0.375.
    const geometry = buildFieldContourGeometry(
      saddleGrid(4, 0, 0, 4),
      { slice: { axis: "z", positionMm: 0 }, thresholds: [1.5] },
      SCALE,
    );
    expect(contourPoints(geometry)).toEqual([
      [0.625, 0, 0],
      [1, 0.375, 0],
      [0, 0.625, 0],
      [0.375, 1, 0],
    ]);
  });

  it("inside diagonal c00–c11 with the center outside splits into two lobes", () => {
    // Corners 2, 0, 0, 2 around threshold 1.5: the same inside diagonal,
    // but the corner mean 1 is below the threshold, so the bilinear
    // region is two lobes at c00 and c11 and the segments isolate the
    // INSIDE corners — (bottom, left) around c00 and (right, top)
    // around c11 — fractions 0.25 on the 2→0 edges, 0.75 on the 0→2.
    const geometry = buildFieldContourGeometry(
      saddleGrid(2, 0, 0, 2),
      { slice: { axis: "z", positionMm: 0 }, thresholds: [1.5] },
      SCALE,
    );
    expect(contourPoints(geometry)).toEqual([
      [0.25, 0, 0],
      [0, 0.25, 0],
      [1, 0.75, 0],
      [0.75, 1, 0],
    ]);
  });

  it("inside diagonal c10–c01 with the center inside connects through the middle", () => {
    // Corners 0, 3, 3, 1 around threshold 1.5: the c10–c01 diagonal is
    // inside and the corner mean 1.75 is above, so the segments isolate
    // the OUTSIDE corners — (bottom, left) around c00 and (right, top)
    // around c11; the 3 → 1 edges cross at fraction (1.5 − 3)/(1 − 3) =
    // 0.75.
    const geometry = buildFieldContourGeometry(
      saddleGrid(0, 3, 3, 1),
      { slice: { axis: "z", positionMm: 0 }, thresholds: [1.5] },
      SCALE,
    );
    expect(contourPoints(geometry)).toEqual([
      [0.5, 0, 0],
      [0, 0.5, 0],
      [1, 0.75, 0],
      [0.75, 1, 0],
    ]);
  });

  it("inside diagonal c10–c01 with the center outside splits into two lobes", () => {
    // Corners 0, 2, 2, 0 around threshold 1.5: the mean 1 is below, so
    // the segments isolate the INSIDE corners — (bottom, right) around
    // c10 and (left, top) around c01 — fractions 0.75 on the 0→2 edges,
    // 0.25 on the 2→0.
    const geometry = buildFieldContourGeometry(
      saddleGrid(0, 2, 2, 0),
      { slice: { axis: "z", positionMm: 0 }, thresholds: [1.5] },
      SCALE,
    );
    expect(contourPoints(geometry)).toEqual([
      [0.75, 0, 0],
      [1, 0.25, 0],
      [0, 0.75, 0],
      [0.25, 1, 0],
    ]);
  });

  it("a mean exactly at the threshold rides the two-lobe pairing", () => {
    // Corners 0, 3, 3, 0 around threshold 1.5: the c10–c01 diagonal is
    // inside and the corner mean equals the threshold — the center sits
    // ON the contour — so the tie rides the two-lobe pairing, (bottom,
    // right) + (left, top), each crossing at the half-way fraction 0.5.
    const geometry = buildFieldContourGeometry(
      saddleGrid(0, 3, 3, 0),
      { slice: { axis: "z", positionMm: 0 }, thresholds: [1.5] },
      SCALE,
    );
    expect(contourPoints(geometry)).toEqual([
      [0.5, 0, 0],
      [1, 0.5, 0],
      [0, 0.5, 0],
      [0.5, 1, 0],
    ]);
  });

  it("a non-saddle single-cell field emits its one segment only", () => {
    // Corners 0, 0, 0, 4 (one raised corner): mean 1 is below 1.5, and
    // only the two edges touching the raised corner cross (fraction
    // 1.5/4 = 0.375) — the pairing rule never invents a second segment
    // for a two-crossing cell.
    const geometry = buildFieldContourGeometry(
      saddleGrid(0, 0, 0, 4),
      { slice: { axis: "z", positionMm: 0 }, thresholds: [1.5] },
      SCALE,
    );
    expect(contourPoints(geometry)).toEqual([
      [1, 0.375, 0],
      [0.375, 1, 0],
    ]);
  });
});
