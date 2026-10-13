/**
 * Phase 62b decoded-field coverage: the block → lattice door (geometry,
 * units, ranges), the node-centered trilinear read against analytic
 * fields (exact at nodes, linear-exact between them, clamped outside),
 * the vector-field door's agreement checks, and the loud-refusal cases.
 */

import { describe, expect, it } from "vitest";

import {
  decodedFieldGrid,
  decodedVectorField,
  fieldGridContainsPoint,
  fieldGridSamplePositionMm,
  sampleFieldGrid,
  sampleVectorField,
  sampleVectorMagnitude,
} from "./field-grid";
import {
  CUBE_LATTICE,
  latticePosition,
  PLANE_LATTICE,
  scalarFieldBlock,
  vectorFieldBlocks,
} from "./field-fixtures";

describe("decodedFieldGrid", () => {
  it("carries the block's geometry, values, and explicit unit", () => {
    const block = scalarFieldBlock(
      "distance",
      CUBE_LATTICE,
      (x, y, z) => x + y + z,
      "mm",
    );
    const grid = decodedFieldGrid(block);
    expect(grid.shape).toEqual([5, 5, 3]);
    expect(grid.originMm).toEqual([0, 0, 0]);
    expect(grid.spacingMm).toEqual([1, 1, 1]);
    expect(grid.unit).toBe("mm");
    expect(grid.values).toBeInstanceOf(Float64Array);
    expect(grid.values.length).toBe(75);
  });

  it('defaults the unit label to "1" when the block carried none', () => {
    const grid = decodedFieldGrid(
      scalarFieldBlock("occupancy", CUBE_LATTICE, (x) => (x < 2 ? 1 : 0)),
    );
    expect(grid.unit).toBe("1");
  });

  it("computes the finite value range the color window defaults to", () => {
    const grid = decodedFieldGrid(
      scalarFieldBlock("ramp", CUBE_LATTICE, (x, _y, z) => 2 * x - 3 * z),
    );
    expect(grid.range).toEqual([-6, 8]);
  });

  it("refuses a block whose value count disagrees with its extent", () => {
    const block = scalarFieldBlock("broken", CUBE_LATTICE, (x) => x);
    expect(() =>
      decodedFieldGrid({ ...block, values: block.values.slice(0, 10) }),
    ).toThrow(RangeError);
  });

  it("refuses a non-finite value", () => {
    const block = scalarFieldBlock("nan", CUBE_LATTICE, (x) => x);
    expect(() =>
      decodedFieldGrid({
        ...block,
        values: [Number.NaN, ...block.values.slice(1)],
      }),
    ).toThrow(RangeError);
  });

  it("refuses non-positive spacing and non-integer extents", () => {
    const block = scalarFieldBlock("flat", CUBE_LATTICE, (x) => x);
    expect(() => decodedFieldGrid({ ...block, spacingMm: [1, 0, 1] })).toThrow(
      RangeError,
    );
    expect(() =>
      decodedFieldGrid({ ...block, extent: [2.5, 5, 3], values: block.values }),
    ).toThrow(RangeError);
  });
});

describe("sampleFieldGrid (node-centered trilinear)", () => {
  const linear = decodedFieldGrid(
    scalarFieldBlock(
      "linear",
      CUBE_LATTICE,
      (x, y, z) => x + 2 * y + 3 * z,
      "mm",
    ),
  );

  it("reads the exact node values at node positions", () => {
    for (let k = 0; k < 3; k += 1) {
      for (let j = 0; j < 5; j += 1) {
        for (let i = 0; i < 5; i += 1) {
          const [x, y, z] = latticePosition(CUBE_LATTICE, i, j, k);
          expect(sampleFieldGrid(linear, x, y, z)).toBe(x + 2 * y + 3 * z);
        }
      }
    }
  });

  it("is exact on a linear field at arbitrary interior points", () => {
    expect(sampleFieldGrid(linear, 0.5, 0.5, 0.5)).toBeCloseTo(3, 12);
    expect(sampleFieldGrid(linear, 2.25, 3.5, 1.75)).toBeCloseTo(
      2.25 + 2 * 3.5 + 3 * 1.75,
      12,
    );
  });

  it("interpolates the eight corners' average at a cell centre", () => {
    // Cell corners around (0.5, 0.5, 0.5): f = x² + y² reads 0, 1, 1, 2
    // per z layer — the trilinear centre of any cell is the corner
    // average for every field.
    const bowl = decodedFieldGrid(
      scalarFieldBlock("bowl", CUBE_LATTICE, (x, y) => x * x + y * y, "mm^2"),
    );
    const expected = (0 + 1 + 1 + 2 + 0 + 1 + 1 + 2) / 8;
    expect(sampleFieldGrid(bowl, 0.5, 0.5, 0.5)).toBeCloseTo(expected, 12);
  });

  it("clamps positions outside the lattice to the boundary samples", () => {
    expect(sampleFieldGrid(linear, -10, -10, -10)).toBe(0);
    expect(sampleFieldGrid(linear, 100, 0, 0)).toBe(4);
    expect(sampleFieldGrid(linear, 100, 100, 100)).toBe(4 + 8 + 6);
  });
});

describe("fieldGridContainsPoint and sample positions", () => {
  const grid = decodedFieldGrid(
    scalarFieldBlock("flat", CUBE_LATTICE, (x) => x),
  );

  it("contains the closed node bounds and nothing beyond", () => {
    expect(fieldGridContainsPoint(grid, 0, 0, 0)).toBe(true);
    expect(fieldGridContainsPoint(grid, 4, 4, 2)).toBe(true);
    expect(fieldGridContainsPoint(grid, 2, 2, 1)).toBe(true);
    expect(fieldGridContainsPoint(grid, -0.001, 0, 0)).toBe(false);
    expect(fieldGridContainsPoint(grid, 4.001, 0, 0)).toBe(false);
    expect(fieldGridContainsPoint(grid, 0, 5, 0)).toBe(false);
  });

  it("computes node positions as origin + index·spacing", () => {
    expect(fieldGridSamplePositionMm(grid, 2, 3, 1)).toEqual([2, 3, 1]);
    const offset = decodedFieldGrid(
      scalarFieldBlock(
        "offset",
        { shape: [2, 2, 2], originMm: [-4, 10, 6], spacingMm: [2, 0.5, 3] },
        (x) => x,
      ),
    );
    expect(fieldGridSamplePositionMm(offset, 1, 1, 1)).toEqual([-2, 10.5, 9]);
  });
});

describe("decodedVectorField", () => {
  it("decodes three component blocks sharing one lattice", () => {
    const field = decodedVectorField(
      vectorFieldBlocks("v", CUBE_LATTICE, (x, y, z) => [x, y, z], "mm/s"),
    );
    expect(field.shape).toEqual([5, 5, 3]);
    expect(field.unit).toBe("mm/s");
    expect(field.x[0]).toBe(0);
    expect(field.x[74]).toBe(4);
    expect(field.z[74]).toBe(2);
  });

  it("computes the whole-lattice maximum magnitude", () => {
    const field = decodedVectorField(
      vectorFieldBlocks("v", CUBE_LATTICE, (x, y, z) => [x, y, z], "mm/s"),
    );
    // The corner (4, 4, 2): magnitude 6 — the lattice's largest.
    expect(field.maxMagnitude).toBeCloseTo(Math.sqrt(16 + 16 + 4), 12);
  });

  it("reads vectors exactly on linear component fields", () => {
    const field = decodedVectorField(
      vectorFieldBlocks(
        "circular",
        PLANE_LATTICE,
        (x, y) => [-y, x, 0],
        "mm/s",
      ),
    );
    expect(sampleVectorField(field, 3, 4, 0)).toEqual([-4, 3, 0]);
    expect(sampleVectorField(field, -2.5, 0.5, 0)).toEqual([-0.5, -2.5, 0]);
    expect(sampleVectorMagnitude(field, 3, 4, 0)).toBeCloseTo(5, 12);
  });

  it("refuses components whose lattices disagree", () => {
    const good = vectorFieldBlocks("v", CUBE_LATTICE, (x) => [x, 0, 0]);
    const shifted = scalarFieldBlock(
      "shifted",
      { ...CUBE_LATTICE, originMm: [1, 0, 0] },
      (x) => x,
    );
    expect(() => decodedVectorField({ ...good, y: shifted })).toThrow(
      RangeError,
    );
  });

  it("refuses components whose unit labels disagree", () => {
    const good = vectorFieldBlocks("v", CUBE_LATTICE, (x) => [x, 0, 0], "mm/s");
    const mismatched = scalarFieldBlock("other", CUBE_LATTICE, () => 0, "Pa");
    expect(() => decodedVectorField({ ...good, z: mismatched })).toThrow(
      RangeError,
    );
  });

  it("treats an absent unit on every component as dimensionless", () => {
    const field = decodedVectorField(
      vectorFieldBlocks("v", CUBE_LATTICE, () => [1, 0, 0]),
    );
    expect(field.unit).toBe("1");
  });
});
