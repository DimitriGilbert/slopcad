/**
 * Phase 62b vector-glyph coverage: the decimation pattern pinned exactly
 * (every stride-th node from the lattice origin, no more and no less),
 * needle direction and length against analytic fields, zero-magnitude
 * skipping, determinism, and the loud-refusal cases.
 */

import { describe, expect, it } from "vitest";

import { CAD_FIELD_COLORMAP_VIRIDIS, fieldColorRamp } from "./field-colormaps";
import { decodedVectorField } from "./field-grid";
import { buildFieldGlyphGeometry, fieldGlyphNodeIndices } from "./field-glyphs";
import {
  CUBE_LATTICE,
  PLANE_LATTICE,
  vectorFieldBlocks,
} from "./field-fixtures";

/** The tests' fixed color scale. */
const SCALE = { colormap: CAD_FIELD_COLORMAP_VIRIDIS } as const;

describe("fieldGlyphNodeIndices", () => {
  it("keeps every stride-th index from the lattice origin", () => {
    expect(fieldGlyphNodeIndices(5, 2)).toEqual([0, 2, 4]);
    expect(fieldGlyphNodeIndices(5, 1)).toEqual([0, 1, 2, 3, 4]);
    expect(fieldGlyphNodeIndices(6, 3)).toEqual([0, 3]);
    expect(fieldGlyphNodeIndices(1, 3)).toEqual([0]);
    expect(fieldGlyphNodeIndices(5, 10)).toEqual([0]);
  });

  it("is deterministic: repeated calls return identical arrays", () => {
    expect(fieldGlyphNodeIndices(9, 3)).toEqual(fieldGlyphNodeIndices(9, 3));
  });
});

describe("buildFieldGlyphGeometry", () => {
  it("places one needle per decimated node, pointing along the field", () => {
    const field = decodedVectorField(
      vectorFieldBlocks("uniform", CUBE_LATTICE, () => [2, 0, 0], "mm/s"),
    );
    const scaleMm = 3;
    const geometry = buildFieldGlyphGeometry(
      field,
      { stride: 2, scaleMm },
      SCALE,
    );
    const position = geometry.getAttribute("position");
    // Stride 2 on 5×5×3: i, j ∈ {0, 2, 4}, k ∈ {0, 2} — 18 glyphs.
    expect(position.count).toBe(18 * 2);
    // The first needle (x-fastest): rooted at the origin node, tip one
    // full scale along +x (the uniform magnitude IS the maximum).
    expect([position.getX(0), position.getY(0), position.getZ(0)]).toEqual([
      0, 0, 0,
    ]);
    expect([position.getX(1), position.getY(1), position.getZ(1)]).toEqual([
      scaleMm,
      0,
      0,
    ]);
    // The second needle: node (2, 0, 0).
    expect([position.getX(2), position.getY(2), position.getZ(2)]).toEqual([
      2, 0, 0,
    ]);
  });

  it("scales needle length by magnitude against the field's own maximum", () => {
    const field = decodedVectorField(
      vectorFieldBlocks("ramp", CUBE_LATTICE, (x) => [x, 0, 0], "mm/s"),
    );
    const scaleMm = 4;
    const geometry = buildFieldGlyphGeometry(
      field,
      { stride: 2, scaleMm },
      SCALE,
    );
    const position = geometry.getAttribute("position");
    // Stride 2 keeps i ∈ {0, 2, 4}: the i = 0 column is still fluid
    // (magnitude 0) and is SKIPPED, so i = 2 opens the buffer at half
    // the maximum magnitude — half the needle length.
    expect(position.count).toBe(2 * 3 * 2 * 2);
    expect([position.getX(0), position.getY(0), position.getZ(0)]).toEqual([
      2, 0, 0,
    ]);
    expect([position.getX(1), position.getY(1), position.getZ(1)]).toEqual([
      2 + scaleMm / 2,
      0,
      0,
    ]);
    // The i = 4 needles reach the full scale.
    expect([position.getX(2), position.getY(2), position.getZ(2)]).toEqual([
      4, 0, 0,
    ]);
    expect([position.getX(3), position.getY(3), position.getZ(3)]).toEqual([
      4 + scaleMm,
      0,
      0,
    ]);
  });

  it("points needles along the local vector, not along an axis", () => {
    const field = decodedVectorField(
      vectorFieldBlocks(
        "circular",
        PLANE_LATTICE,
        (x, y) => [-y, x, 0],
        "mm/s",
      ),
    );
    const scaleMm = 2;
    const geometry = buildFieldGlyphGeometry(
      field,
      { stride: 10, scaleMm },
      SCALE,
    );
    const position = geometry.getAttribute("position");
    // Stride 10 on 21 nodes from origin (−10, −10): indices {0, 10, 20}
    // per axis → x, y ∈ {−10, 0, 10}, i fastest. Glyph 2 is node
    // (10, −10, 0) with v = (10, 10, 0)/√2 — a full-length needle
    // (|v| = 10√2 IS the lattice maximum, reached at the corners)
    // pointing diagonally.
    const glyphAt = (index: number): [number, number, number] => [
      position.getX(index),
      position.getY(index),
      position.getZ(index),
    ];
    expect(glyphAt(4)).toEqual([10, -10, 0]);
    const [tipX, tipY, tipZ] = glyphAt(5);
    // Positions land in a float32 attribute: six digits, not bit equality.
    expect(tipX).toBeCloseTo(10 + scaleMm / Math.SQRT2, 6);
    expect(tipY).toBeCloseTo(-10 + scaleMm / Math.SQRT2, 6);
    expect(tipZ).toBe(0);
  });

  it("skips zero-magnitude nodes entirely", () => {
    const field = decodedVectorField(
      vectorFieldBlocks(
        "halfstill",
        CUBE_LATTICE,
        (x) => [x > 1 ? 2 : 0, 0, 0],
        "mm/s",
      ),
    );
    const geometry = buildFieldGlyphGeometry(
      field,
      { stride: 1, scaleMm: 1 },
      SCALE,
    );
    // Nodes with x ∈ {0, 1} are still fluid: 2 columns × 5 × 3 dropped
    // from the 75-node lattice.
    expect(geometry.getAttribute("position").count).toBe((75 - 30) * 2);
  });

  it("paints both endpoints the magnitude's color through the scale", () => {
    const field = decodedVectorField(
      vectorFieldBlocks("uniform", CUBE_LATTICE, () => [2, 0, 0], "mm/s"),
    );
    const geometry = buildFieldGlyphGeometry(
      field,
      { stride: 2, scaleMm: 3 },
      SCALE,
    );
    const color = geometry.getAttribute("color");
    const ramp = fieldColorRamp(SCALE, [0, field.maxMagnitude]);
    const expected = ramp(2);
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
    const field = decodedVectorField(
      vectorFieldBlocks(
        "circular",
        PLANE_LATTICE,
        (x, y) => [-y, x, 0],
        "mm/s",
      ),
    );
    const build = () =>
      buildFieldGlyphGeometry(field, { stride: 4, scaleMm: 2 }, SCALE);
    expect([...build().getAttribute("position").array]).toEqual([
      ...build().getAttribute("position").array,
    ]);
    expect([...build().getAttribute("color").array]).toEqual([
      ...build().getAttribute("color").array,
    ]);
  });

  it("refuses a non-positive stride or scale", () => {
    const field = decodedVectorField(
      vectorFieldBlocks("uniform", CUBE_LATTICE, () => [2, 0, 0], "mm/s"),
    );
    for (const stride of [0, -1, 1.5]) {
      expect(() =>
        buildFieldGlyphGeometry(field, { stride, scaleMm: 1 }, SCALE),
      ).toThrow(RangeError);
    }
    for (const scaleMm of [0, -2, Number.NaN]) {
      expect(() =>
        buildFieldGlyphGeometry(field, { stride: 1, scaleMm }, SCALE),
      ).toThrow(RangeError);
    }
  });
});
