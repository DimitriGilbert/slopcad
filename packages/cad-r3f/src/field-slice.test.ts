/**
 * Phase 62b slice-plane coverage: geometry built from analytic fields,
 * colors pinned to the color scale's own output at the analytic values
 * (never re-derived through the builder), the node-lattice footprint
 * asserted through three's own bounds, determinism as identical buffers
 * across rebuilds, and the loud-refusal cases.
 */

import * as THREE from "three";
import { describe, expect, it } from "vitest";

import { CAD_FIELD_COLORMAP_VIRIDIS, fieldColorRamp } from "./field-colormaps";
import { decodedFieldGrid } from "./field-grid";
import { buildFieldSliceGeometry } from "./field-slice";
import { CUBE_LATTICE, scalarFieldBlock } from "./field-fixtures";

/** The tests' fixed color scale — the same data an overlay host passes. */
const SCALE = { colormap: CAD_FIELD_COLORMAP_VIRIDIS } as const;

/** The linear field f = x + 2y + 3z on the cube lattice. */
const LINEAR = decodedFieldGrid(
  scalarFieldBlock(
    "linear",
    CUBE_LATTICE,
    (x, y, z) => x + 2 * y + 3 * z,
    "mm",
  ),
);

/** Reads a float32 attribute component. */
function componentAt(
  geometry: THREE.BufferGeometry,
  name: string,
  index: number,
): number {
  const attribute = geometry.getAttribute(name);
  if (!(attribute instanceof THREE.BufferAttribute)) {
    throw new Error(`Expected a BufferAttribute for "${name}".`);
  }
  const value = attribute.array[index];
  if (value === undefined) {
    throw new Error(`Attribute "${name}" has no component ${String(index)}.`);
  }
  return value;
}

/** Quantizes a color triple the float32 attribute write applies. */
function froundColor(
  color: readonly [number, number, number],
): [number, number, number] {
  return [Math.fround(color[0]), Math.fround(color[1]), Math.fround(color[2])];
}

describe("buildFieldSliceGeometry", () => {
  it("builds the in-plane node lattice: vertices, cells, and positions", () => {
    const geometry = buildFieldSliceGeometry(
      LINEAR,
      { axis: "z", positionMm: 1 },
      SCALE,
    );
    const position = geometry.getAttribute("position");
    expect(position.count).toBe(5 * 5);
    expect(geometry.getIndex()?.count).toBe(4 * 4 * 6);
    // x-fastest vertex order: vertex (j·5 + i) sits at (i, j, 1).
    expect([
      componentAt(geometry, "position", (0 * 5 + 2) * 3 + 0),
      componentAt(geometry, "position", (0 * 5 + 2) * 3 + 1),
      componentAt(geometry, "position", (0 * 5 + 2) * 3 + 2),
    ]).toEqual([2, 0, 1]);
    expect([
      componentAt(geometry, "position", (3 * 5 + 1) * 3 + 0),
      componentAt(geometry, "position", (3 * 5 + 1) * 3 + 1),
      componentAt(geometry, "position", (3 * 5 + 1) * 3 + 2),
    ]).toEqual([1, 3, 1]);
  });

  it("spans exactly the lattice's node footprint in its own bounds", () => {
    const geometry = buildFieldSliceGeometry(
      LINEAR,
      { axis: "z", positionMm: 1 },
      SCALE,
    );
    const box = geometry.boundingBox;
    expect(box).not.toBeNull();
    expect(box?.min.x).toBeCloseTo(0, 5);
    expect(box?.max.x).toBeCloseTo(4, 5);
    expect(box?.min.y).toBeCloseTo(0, 5);
    expect(box?.max.y).toBeCloseTo(4, 5);
    expect(box?.min.z).toBe(1);
    expect(box?.max.z).toBe(1);
  });

  it("paints each vertex the color scale's own output at its value", () => {
    const geometry = buildFieldSliceGeometry(
      LINEAR,
      { axis: "z", positionMm: 1 },
      SCALE,
    );
    const ramp = fieldColorRamp(SCALE, LINEAR.range);
    for (let j = 0; j < 5; j += 1) {
      for (let i = 0; i < 5; i += 1) {
        const vertex = j * 5 + i;
        const expected = ramp(i + 2 * j + 3);
        expect([
          componentAt(geometry, "color", vertex * 3),
          componentAt(geometry, "color", vertex * 3 + 1),
          componentAt(geometry, "color", vertex * 3 + 2),
        ]).toEqual(froundColor(expected));
      }
    }
  });

  it("a slice between node planes reads the interpolated values", () => {
    const geometry = buildFieldSliceGeometry(
      LINEAR,
      { axis: "z", positionMm: 0.5 },
      SCALE,
    );
    const ramp = fieldColorRamp(SCALE, LINEAR.range);
    // z = 0.5 between the z = 0 and z = 1 planes: f = x + 2y + 1.5.
    const expected = ramp(2 + 2 * 2 + 1.5);
    const vertex = 2 * 5 + 2;
    expect([
      componentAt(geometry, "color", vertex * 3),
      componentAt(geometry, "color", vertex * 3 + 1),
      componentAt(geometry, "color", vertex * 3 + 2),
    ]).toEqual(froundColor(expected));
  });

  it("the other axes build their lattices in the remaining axes", () => {
    const xSlice = buildFieldSliceGeometry(
      LINEAR,
      { axis: "x", positionMm: 2 },
      SCALE,
    );
    // In-plane axes for an x slice are y (fastest) then z: vertex (k·5 + j)
    // at (2, j, k) — 5×3 vertices, 4×2 cells.
    expect(xSlice.getAttribute("position").count).toBe(5 * 3);
    expect(xSlice.getIndex()?.count).toBe(4 * 2 * 6);
    expect([
      componentAt(xSlice, "position", (1 * 5 + 3) * 3 + 0),
      componentAt(xSlice, "position", (1 * 5 + 3) * 3 + 1),
      componentAt(xSlice, "position", (1 * 5 + 3) * 3 + 2),
    ]).toEqual([2, 3, 1]);
    const ySlice = buildFieldSliceGeometry(
      LINEAR,
      { axis: "y", positionMm: 0 },
      SCALE,
    );
    // In-plane axes for a y slice are z (fastest) then x: vertex (i·3 + k).
    expect(ySlice.getAttribute("position").count).toBe(3 * 5);
    expect([
      componentAt(ySlice, "position", (4 * 3 + 1) * 3 + 0),
      componentAt(ySlice, "position", (4 * 3 + 1) * 3 + 1),
      componentAt(ySlice, "position", (4 * 3 + 1) * 3 + 2),
    ]).toEqual([4, 0, 1]);
  });

  it("an explicit value window repaints through the pinned legend", () => {
    const pinned = buildFieldSliceGeometry(
      LINEAR,
      { axis: "z", positionMm: 0 },
      { colormap: CAD_FIELD_COLORMAP_VIRIDIS, valueRange: [0, 100] },
    );
    const ramp = fieldColorRamp(
      { colormap: CAD_FIELD_COLORMAP_VIRIDIS, valueRange: [0, 100] },
      LINEAR.range,
    );
    const expected = ramp(4 + 2 * 4);
    expect([
      componentAt(pinned, "color", (4 * 5 + 4) * 3),
      componentAt(pinned, "color", (4 * 5 + 4) * 3 + 1),
      componentAt(pinned, "color", (4 * 5 + 4) * 3 + 2),
    ]).toEqual(froundColor(expected));
  });

  it("is deterministic: identical inputs build identical buffers", () => {
    const first = buildFieldSliceGeometry(
      LINEAR,
      { axis: "z", positionMm: 1 },
      SCALE,
    );
    const second = buildFieldSliceGeometry(
      LINEAR,
      { axis: "z", positionMm: 1 },
      SCALE,
    );
    expect([...first.getAttribute("position").array]).toEqual([
      ...second.getAttribute("position").array,
    ]);
    expect([...first.getAttribute("color").array]).toEqual([
      ...second.getAttribute("color").array,
    ]);
    expect([...(first.getIndex()?.array ?? [])]).toEqual([
      ...(second.getIndex()?.array ?? []),
    ]);
  });

  it("refuses a non-finite plane position", () => {
    expect(() =>
      buildFieldSliceGeometry(
        LINEAR,
        { axis: "z", positionMm: Number.NaN },
        SCALE,
      ),
    ).toThrow(RangeError);
  });
});
