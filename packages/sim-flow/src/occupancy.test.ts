import { describe, expect, it } from "vitest";
import type { SimOccupancyGrid } from "@slopcad/sim-core";

import { analyticOccupancy } from "./fixtures";
import { lbmSolidMask, lbmSolidMaskFromGrid } from "./occupancy";

function gridOf(nx: number, ny: number, cells: Uint8Array): SimOccupancyGrid {
  return {
    semantic: "occupancy",
    name: "fixture",
    shape: [nx, ny, 1],
    originM: [0, 0, 0],
    spacingM: [0.001, 0.001, 0.001],
    cells,
  };
}

describe("the occupancy → solid-mask mapping (the 62a node interpretation)", () => {
  it("is the direct node alias: extent [nx, ny, 1], value order unchanged", () => {
    const nx = 8;
    const ny = 6;
    const cells = analyticOccupancy(
      nx,
      ny,
      (x, y) => x >= 3 && x <= 5 && y >= 2,
    );
    const mask = lbmSolidMaskFromGrid(gridOf(nx, ny, cells));
    expect(mask.ok).toBe(true);
    if (!mask.ok) return;
    expect(mask.value.nx).toBe(nx);
    expect(mask.value.ny).toBe(ny);
    // The documented identity: node (i, j) solid ⇔ cells[i + j·nx] = 1,
    // x-fastest — one byte compare over the whole mask.
    for (let j = 0; j < ny; j += 1) {
      for (let i = 0; i < nx; i += 1) {
        expect(mask.value.solid[i + j * nx]).toBe(cells[i + j * nx]);
      }
    }
  });

  it("honors the closed-set convention: on-surface nodes are solid", () => {
    // An axis-aligned box from (2,1) to (5,4): the boundary nodes lie ON
    // the closed solid and classify inside — the voxelizer's rule.
    const nx = 8;
    const ny = 6;
    const cells = analyticOccupancy(
      nx,
      ny,
      (x, y) => x >= 2 && x <= 5 && y >= 1 && y <= 4,
    );
    const mask = lbmSolidMaskFromGrid(gridOf(nx, ny, cells));
    if (!mask.ok) throw new Error("mask refused");
    expect(mask.value.solid[2 + 1 * nx]).toBe(1);
    expect(mask.value.solid[5 + 4 * nx]).toBe(1);
    expect(mask.value.solid[1 + 1 * nx]).toBe(0);
    expect(mask.value.solid[6 + 4 * nx]).toBe(0);
  });

  it("carries a sphere-slice (circle) occupancy verbatim", () => {
    const nx = 20;
    const ny = 16;
    const cx = 9.5;
    const cy = 7.5;
    const r = 4.5;
    const cells = analyticOccupancy(
      nx,
      ny,
      (x, y) => (x - cx) ** 2 + (y - cy) ** 2 <= r * r,
    );
    const mask = lbmSolidMaskFromGrid(gridOf(nx, ny, cells));
    if (!mask.ok) throw new Error("mask refused");
    let solidCount = 0;
    for (const value of mask.value.solid) solidCount += value;
    // The analytic count itself (the predicate evaluated identically).
    let expected = 0;
    for (let y = 0; y < ny; y += 1) {
      for (let x = 0; x < nx; x += 1) {
        if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r) expected += 1;
      }
    }
    expect(solidCount).toBe(expected);
    // A circle centered mid-cell has mirror symmetry about its center row.
    const centerRow = 8;
    for (let x = 0; x < nx; x += 1) {
      expect(mask.value.solid[x + (15 - centerRow) * nx]).toBe(
        mask.value.solid[x + centerRow * nx],
      );
    }
  });

  it("declines a 3D grid loudly (the D3Q19 door is Phase 66)", () => {
    const result = lbmSolidMaskFromGrid(gridOf(4, 4, new Uint8Array(16)));
    const threeDee = lbmSolidMaskFromGrid({
      ...gridOf(4, 4, new Uint8Array(16)),
      shape: [4, 4, 4],
    });
    expect(result.ok).toBe(true);
    expect(threeDee.ok).toBe(false);
    if (!threeDee.ok) {
      expect(threeDee.error.message).toContain("Phase 66");
    }
  });

  it("declines mismatched lengths and non-binary values", () => {
    expect(lbmSolidMaskFromGrid(gridOf(4, 4, new Uint8Array(15))).ok).toBe(
      false,
    );
    const bad = new Uint8Array(16).fill(2);
    expect(lbmSolidMaskFromGrid(gridOf(4, 4, bad)).ok).toBe(false);
    expect(lbmSolidMask(3, 3, new Uint8Array(8)).ok).toBe(false);
    expect(lbmSolidMask(2, 3, new Uint8Array(6)).ok).toBe(false);
  });
});
