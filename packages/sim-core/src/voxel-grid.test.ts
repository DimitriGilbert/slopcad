/**
 * Voxel grid bridge tests (Phase 62a): the field-id vocabulary, the
 * node-lattice helpers, and the whole payload ride — a grid becomes a
 * document-space field block through the existing S4 projection, the
 * block encodes through the existing SMR1 codec, and the decoded
 * payload returns to a typed grid bitwise — the exact path the Phase
 * 62b overlays will consume — plus the bridge's structured refusals.
 */

import { describe, expect, it } from "vitest";

import { SIM_ERROR_CODES } from "./errors";
import {
  type SimResultFieldBlock,
  decodeSimResultPayload,
  encodeSimResultPayload,
} from "./sim-result";
import {
  type SimDistanceGrid,
  type SimOccupancyGrid,
  SIM_GRID_MAX_SAMPLES,
  parseSimGridFieldId,
  simGridFieldId,
  simGridFromFieldBlock,
  simGridSampleCount,
  simGridSamplePositionM,
  simGridSolverField,
  simGridToFieldBlock,
} from "./voxel-grid";

function requireOk<T, E extends { readonly message: string }>(
  result:
    | { readonly ok: true; readonly value: T }
    | { readonly ok: false; readonly error: E },
  what: string,
): T {
  if (!result.ok) {
    throw new Error(`The grid test rejected ${what}: ${result.error.message}`);
  }
  return result.value;
}

function occupancyGrid(): SimOccupancyGrid {
  return {
    semantic: "occupancy",
    name: "domain",
    shape: [3, 2, 2],
    originM: [-0.002, -0.001, 0],
    spacingM: [0.001, 0.001, 0.001],
    cells: Uint8Array.from([1, 0, 0, 1, 1, 1, 0, 0, 1, 0, 1, 0]),
  };
}

function distanceGrid(): SimDistanceGrid {
  return {
    semantic: "signed-distance",
    name: "fan",
    shape: [2, 2, 1],
    originM: [0, 0, 0.0005],
    spacingM: [0.001, 0.001, 0.001],
    distanceM: Float64Array.from([0.0005, -0.001, 0.002, -0.0005]),
  };
}

describe("the field id vocabulary", () => {
  it("round-trips names and semantics, dotted names included", () => {
    expect(simGridFieldId("domain", "occupancy")).toBe("domain.occupancy");
    expect(simGridFieldId("fan", "signed-distance")).toBe(
      "fan.signed-distance",
    );
    const plain = requireOk(
      parseSimGridFieldId("domain.occupancy"),
      "the plain id",
    );
    expect(plain).toEqual({ name: "domain", semantic: "occupancy" });
    const dotted = requireOk(
      parseSimGridFieldId("a.b.signed-distance"),
      "the dotted id",
    );
    expect(dotted).toEqual({ name: "a.b", semantic: "signed-distance" });
  });

  it("refuses ids without a semantic suffix or with an illegal name", () => {
    for (const id of ["occupancy", "domain-density", "", "bad !.occupancy"]) {
      const parsed = parseSimGridFieldId(id);
      expect(parsed.ok).toBe(false);
      if (parsed.ok) return;
      expect(parsed.error.code).toBe(SIM_ERROR_CODES.gridFieldMalformed);
    }
  });
});

describe("the node lattice helpers", () => {
  it("counts samples and places them at origin + i·spacing", () => {
    const grid = occupancyGrid();
    expect(simGridSampleCount(grid)).toBe(12);
    expect(simGridSamplePositionM(grid, 2, 1, 1)).toEqual([0, 0, 0.001]);
  });
});

describe("the payload ride (grid → projection → SMR1 → grid)", () => {
  it("projects an occupancy grid to a dimensionless document block", () => {
    const solver = requireOk(
      simGridSolverField(occupancyGrid()),
      "the occupancy solver field",
    );
    expect(solver.id).toBe("domain.occupancy");
    expect(solver.unit).toBe("1");
    expect(solver.dimension).toBe("dimensionless");
    expect(solver.dataType).toBe("float32");
    const block = requireOk(
      simGridToFieldBlock(occupancyGrid()),
      "the occupancy block",
    );
    expect(block.id).toBe("domain.occupancy");
    expect(block.unit).toBe("1");
    expect(block.extent).toEqual([3, 2, 2]);
    expect(block.originMm).toEqual([-2, -1, 0]);
    expect(block.spacingMm).toEqual([1, 1, 1]);
    expect(block.values).toEqual([1, 0, 0, 1, 1, 1, 0, 0, 1, 0, 1, 0]);
  });

  it("projects a distance grid to a millimetre document block", () => {
    const block = requireOk(
      simGridToFieldBlock(distanceGrid()),
      "the distance block",
    );
    expect(block.id).toBe("fan.signed-distance");
    expect(block.unit).toBe("mm");
    expect(block.dataType).toBe("float64");
    expect(block.originMm).toEqual([0, 0, 0.5]);
    expect(block.spacingMm).toEqual([1, 1, 1]);
    expect(block.values).toEqual([0.5, -1, 2, -0.5]);
  });

  it("returns a grid bitwise through the SMR1 codec (occupancy)", () => {
    const grid = occupancyGrid();
    const block = requireOk(simGridToFieldBlock(grid), "the block");
    const bytes = requireOk(encodeSimResultPayload([block]), "the encode");
    const reencoded = requireOk(
      encodeSimResultPayload([block]),
      "the re-encode",
    );
    expect(reencoded).toEqual(bytes); // byte-determinism of the ride
    const decoded = requireOk(decodeSimResultPayload(bytes), "the decode");
    const back = requireOk(
      simGridFromFieldBlock(decoded[0] ?? block),
      "the grid decode",
    );
    expect(back).toEqual(grid);
  });

  it("returns a distance grid through the SMR1 codec (float64 exact)", () => {
    const grid = distanceGrid();
    const block = requireOk(simGridToFieldBlock(grid), "the block");
    const bytes = requireOk(encodeSimResultPayload([block]), "the encode");
    const decoded = requireOk(decodeSimResultPayload(bytes), "the decode");
    const back = requireOk(
      simGridFromFieldBlock(decoded[0] ?? block),
      "the grid decode",
    );
    expect(back).toEqual(grid);
  });
});

describe("the bridge declines loudly", () => {
  function block(overrides: Partial<SimResultFieldBlock>): SimResultFieldBlock {
    return {
      id: "domain.occupancy",
      unit: "1",
      extent: [2, 2, 1],
      originMm: [0, 0, 0],
      spacingMm: [1, 1, 1],
      dataType: "float64",
      values: [0, 1, 1, 0],
      ...overrides,
    };
  }

  it("refuses blocks whose semantics do not hold up", () => {
    const cases: readonly Partial<SimResultFieldBlock>[] = [
      { id: "pressure" }, // no grid vocabulary
      { unit: "Pa" }, // occupancy must be dimensionless "1"
      { values: [0, 0.5, 1, 0] }, // non-binary occupancy
      { extent: [3, 2, 1] }, // extent product disagrees with value count
      { spacingMm: [0, 1, 1] }, // degenerate spacing
      { originMm: [Number.NaN, 0, 0] }, // non-finite geometry
    ];
    for (const overrides of cases) {
      const decoded = simGridFromFieldBlock(block(overrides));
      expect(decoded.ok).toBe(false);
      if (decoded.ok) return;
      expect(decoded.error.code).toBe(SIM_ERROR_CODES.gridFieldMalformed);
    }
    const sdfWrongUnit = simGridFromFieldBlock(
      block({ id: "domain.signed-distance", unit: "1", values: [0, 1, 2, 3] }),
    );
    expect(sdfWrongUnit.ok).toBe(false);
  });

  it("refuses grids the doors would never mint", () => {
    const mismatchedCells = simGridSolverField({
      ...occupancyGrid(),
      cells: new Uint8Array(3),
    });
    expect(mismatchedCells.ok).toBe(false);

    const fractional = simGridSolverField({
      ...occupancyGrid(),
      cells: Uint8Array.from([1, 0, 2, 1, 1, 1, 0, 0, 1, 0, 1, 0]),
    });
    expect(fractional.ok).toBe(false);

    const oversize = simGridSolverField({
      ...occupancyGrid(),
      shape: [SIM_GRID_MAX_SAMPLES + 1, 1, 1],
      cells: new Uint8Array(3),
    });
    expect(oversize.ok).toBe(false);
    if (oversize.ok) return;
    expect(oversize.error.code).toBe(SIM_ERROR_CODES.gridFieldMalformed);

    const nonFinite = simGridSolverField({
      ...distanceGrid(),
      distanceM: Float64Array.from([0, Number.NaN, 1, 2]),
    });
    expect(nonFinite.ok).toBe(false);

    const badName = simGridSolverField({ ...occupancyGrid(), name: "nope!" });
    expect(badName.ok).toBe(false);
  });
});
