/**
 * Signed-distance field tests (Phase 62a, the roadmap's named risk):
 * the field against ANALYTIC distance — box exact per node (interior
 * negative, exterior positive, zero on the surface), the gradient's
 * unit magnitude away from boundaries, the zero level within half a
 * voxel, a tessellated sphere within its chord band — plus bitwise
 * determinism, triangle-order invariance, and the door's declines.
 * The roadmap keeps this module behind its own fixtures for a reason:
 * mesh–grid interpolation bugs live here, so every assertion is
 * against closed-form distance, never against the module itself.
 */

import { describe, expect, it } from "vitest";
import type { SimOccupancyGrid } from "./voxel-grid";
import type { SimTessellationWire } from "./voxelizer";

import { SIM_ERROR_CODES } from "./errors";
import { simSignedDistanceGrid } from "./signed-distance";
import { voxelizeSimTessellation } from "./voxelizer";

function requireOk<T, E extends { readonly message: string }>(
  result:
    | { readonly ok: true; readonly value: T }
    | { readonly ok: false; readonly error: E },
  what: string,
): T {
  if (!result.ok) {
    throw new Error(
      `The signed-distance test rejected ${what}: ${result.error.message}`,
    );
  }
  return result.value;
}

interface Box {
  readonly min: readonly [number, number, number];
  readonly max: readonly [number, number, number];
}

function boxTessellation(box: Box): SimTessellationWire {
  const [x0, y0, z0] = box.min;
  const [x1, y1, z1] = box.max;
  return {
    positions: [
      x0,
      y0,
      z0,
      x1,
      y0,
      z0,
      x1,
      y1,
      z0,
      x0,
      y1,
      z0,
      x0,
      y0,
      z1,
      x1,
      y0,
      z1,
      x1,
      y1,
      z1,
      x0,
      y1,
      z1,
    ],
    indices: [
      0, 3, 2, 0, 2, 1, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 3, 7, 6, 3, 6, 2, 0,
      4, 7, 0, 7, 3, 1, 2, 6, 1, 6, 5,
    ],
  };
}

function sphereTessellation(
  center: readonly [number, number, number],
  radius: number,
  segments: number,
  rings: number,
): SimTessellationWire {
  const positions: number[] = [center[0], center[1], center[2] + radius];
  const ringStart = (row: number): number => 1 + (row - 1) * segments;
  for (let row = 1; row < rings; row += 1) {
    const theta = (Math.PI * row) / rings;
    for (let corner = 0; corner < segments; corner += 1) {
      const phi = (2 * Math.PI * corner) / segments;
      positions.push(
        center[0] + radius * Math.sin(theta) * Math.cos(phi),
        center[1] + radius * Math.sin(theta) * Math.sin(phi),
        center[2] + radius * Math.cos(theta),
      );
    }
  }
  const southPole = 1 + (rings - 1) * segments;
  positions.push(center[0], center[1], center[2] - radius);
  const indices: number[] = [];
  for (let corner = 0; corner < segments; corner += 1) {
    const next = (corner + 1) % segments;
    indices.push(0, ringStart(1) + corner, ringStart(1) + next);
    indices.push(
      southPole,
      ringStart(rings - 1) + next,
      ringStart(rings - 1) + corner,
    );
  }
  for (let row = 1; row < rings - 1; row += 1) {
    for (let corner = 0; corner < segments; corner += 1) {
      const next = (corner + 1) % segments;
      indices.push(
        ringStart(row) + corner,
        ringStart(row + 1) + corner,
        ringStart(row + 1) + next,
      );
      indices.push(
        ringStart(row) + corner,
        ringStart(row + 1) + next,
        ringStart(row) + next,
      );
    }
  }
  return { positions, indices };
}

function permuteTriangles(
  tessellation: SimTessellationWire,
): SimTessellationWire {
  const triangles: number[][] = [];
  for (let t = 0; t < tessellation.indices.length; t += 3) {
    triangles.push([
      tessellation.indices[t] ?? 0,
      tessellation.indices[t + 1] ?? 0,
      tessellation.indices[t + 2] ?? 0,
    ]);
  }
  const indices: number[] = [];
  for (const triangle of triangles.reverse()) {
    indices.push(triangle[0] ?? 0, triangle[1] ?? 0, triangle[2] ?? 0);
  }
  return { positions: tessellation.positions, indices };
}

const BOX: Box = { min: [0, 0, 0], max: [10, 10, 10] };
const DOMAIN = {
  kind: "explicit" as const,
  minMm: [-2, -2, -2] as const,
  maxMm: [12, 12, 12] as const,
  resolutionMm: 1,
};

/** The closed-form signed distance to the box's surface, millimetres. */
function analyticBoxDistanceMm(
  box: Box,
  x: number,
  y: number,
  z: number,
): number {
  const dx = Math.max((box.min[0] ?? 0) - x, 0, x - (box.max[0] ?? 0));
  const dy = Math.max((box.min[1] ?? 0) - y, 0, y - (box.max[1] ?? 0));
  const dz = Math.max((box.min[2] ?? 0) - z, 0, z - (box.max[2] ?? 0));
  const outside = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (outside > 0) return outside;
  return -Math.min(
    x - (box.min[0] ?? 0),
    (box.max[0] ?? 0) - x,
    y - (box.min[1] ?? 0),
    (box.max[1] ?? 0) - y,
    z - (box.min[2] ?? 0),
    (box.max[2] ?? 0) - z,
  );
}

function boxFixture(): {
  occupancy: SimOccupancyGrid;
  soup: SimTessellationWire;
} {
  const occupancy = requireOk(
    voxelizeSimTessellation({
      tessellation: boxTessellation(BOX),
      domain: DOMAIN,
    }),
    "the box voxelize",
  );
  return { occupancy, soup: boxTessellation(BOX) };
}

describe("the signed distance vs analytic ground truth (the box)", () => {
  it("matches the closed-form distance at every node", () => {
    const { occupancy, soup } = boxFixture();
    const field = requireOk(
      simSignedDistanceGrid({ tessellation: soup, occupancy }),
      "the box distance field",
    );
    expect(field.semantic).toBe("signed-distance");
    expect(field.name).toBe("domain");
    expect(field.shape).toEqual([15, 15, 15]);
    let index = 0;
    for (let k = 0; k < 15; k += 1) {
      for (let j = 0; j < 15; j += 1) {
        for (let i = 0; i < 15; i += 1) {
          const expectedMm = analyticBoxDistanceMm(BOX, -2 + i, -2 + j, -2 + k);
          expect(field.distanceM[index]).toBeCloseTo(expectedMm / 1000, 10);
          index += 1;
        }
      }
    }
  });

  it("is negative strictly inside, positive strictly outside, 0 on the surface (to lattice noise)", () => {
    const { occupancy, soup } = boxFixture();
    const field = requireOk(
      simSignedDistanceGrid({ tessellation: soup, occupancy }),
      "the box distance field",
    );
    // The SI lattice expression rounds node positions where the
    // millimetre-classified occupancy did not, so on-surface values
    // carry sub-femtometre noise instead of an exact 0.
    const surfaceNoiseM = 1e-15;
    let index = 0;
    for (let k = 0; k < 15; k += 1) {
      for (let j = 0; j < 15; j += 1) {
        for (let i = 0; i < 15; i += 1) {
          const x = -2 + i;
          const y = -2 + j;
          const z = -2 + k;
          const onSurface =
            (x === 0 || x === 10
              ? y >= 0 && y <= 10 && z >= 0 && z <= 10
              : false) ||
            (y === 0 || y === 10
              ? x >= 0 && x <= 10 && z >= 0 && z <= 10
              : false) ||
            (z === 0 || z === 10
              ? x >= 0 && x <= 10 && y >= 0 && y <= 10
              : false);
          const strictlyInside =
            x > 0 && x < 10 && y > 0 && y < 10 && z > 0 && z < 10;
          const strictlyOutside = !onSurface && !strictlyInside;
          const value = field.distanceM[index] ?? 0;
          if (onSurface)
            expect(Math.abs(value)).toBeLessThanOrEqual(surfaceNoiseM);
          if (strictlyInside) expect(value).toBeLessThan(0);
          if (strictlyOutside) expect(value).toBeGreaterThan(0);
          index += 1;
        }
      }
    }
  });

  it("keeps |grad| ≈ 1 in the planar slabs away from faces and the medial axis", () => {
    const { occupancy, soup } = boxFixture();
    const field = requireOk(
      simSignedDistanceGrid({ tessellation: soup, occupancy }),
      "the box distance field",
    );
    const [nx, ny] = field.shape;
    const h = field.spacingM[0] ?? 0.001;
    const at = (i: number, j: number, k: number): number =>
      field.distanceM[
        (i ?? 1) + (nx ?? 1) * ((j ?? 1) + (ny ?? 1) * (k ?? 1))
      ] ?? 0;
    let checked = 0;
    // Slabs where ONE face is the strictly nearest surface — the SDF is
    // planar there (a central difference of a linear field is exact);
    // nodes on the medial axis, where the nearest face switches, are
    // the field's true kinks and are deliberately not asserted.
    for (let k = 6; k <= 8; k += 1) {
      for (let j = 6; j <= 8; j += 1) {
        for (let i = 4; i <= 5; i += 1) {
          const gx = (at(i + 1, j, k) - at(i - 1, j, k)) / (2 * h);
          const gy = (at(i, j + 1, k) - at(i, j - 1, k)) / (2 * h);
          const gz = (at(i, j, k + 1) - at(i, j, k - 1)) / (2 * h);
          const magnitude = Math.sqrt(gx * gx + gy * gy + gz * gz);
          expect(Math.abs(magnitude - 1)).toBeLessThan(1e-6);
          checked += 1;
        }
      }
    }
    for (let k = 6; k <= 8; k += 1) {
      for (let j = 6; j <= 8; j += 1) {
        for (let i = 13; i <= 13; i += 1) {
          const gx = (at(i + 1, j, k) - at(i - 1, j, k)) / (2 * h);
          const gy = (at(i, j + 1, k) - at(i, j - 1, k)) / (2 * h);
          const gz = (at(i, j, k + 1) - at(i, j, k - 1)) / (2 * h);
          const magnitude = Math.sqrt(gx * gx + gy * gy + gz * gz);
          expect(Math.abs(magnitude - 1)).toBeLessThan(1e-6);
          checked += 1;
        }
      }
    }
    expect(checked).toBe(27);
  });

  it("holds the zero level within half a voxel of a face between nodes", () => {
    // An aligned face passes exactly THROUGH nodes (|sdf| = noise
    // there, bracketing nothing); a face at a quarter-voxel offset
    // exercises the interpolated crossing honestly.
    const offset: Box = { min: [0.25, 0.25, 0.25], max: [10.25, 10.25, 10.25] };
    const occupancy = requireOk(
      voxelizeSimTessellation({
        tessellation: boxTessellation(offset),
        domain: DOMAIN,
      }),
      "the offset box voxelize",
    );
    const field = requireOk(
      simSignedDistanceGrid({
        tessellation: boxTessellation(offset),
        occupancy,
      }),
      "the offset distance field",
    );
    const [nx, ,] = field.shape;
    // The x = 10.25 face lies between node x = 10 (inside, −0.25 mm)
    // and x = 11 (outside, +0.75 mm); the planar field's interpolated
    // zero crossing must land on the face itself — within half a voxel
    // by the contract, exactly by the arithmetic.
    const j = 7;
    const k = 7;
    const at = (i: number): number =>
      field.distanceM[(i ?? 1) + (nx ?? 1) * (j + 15 * k)] ?? 0;
    const inside = at(12);
    const outside = at(13);
    const fraction = -inside / (outside - inside);
    const crossingMm = 10 + fraction * 1;
    expect(Math.abs(crossingMm - 10.25)).toBeLessThanOrEqual(0.5);
    expect(Math.abs(crossingMm - 10.25)).toBeLessThan(1e-9);
    // Boundary-band samples: every node within a voxel of the surface
    // carries |sdf| ≤ one voxel (the exact distance cannot exceed it).
    let index = 0;
    for (let kk = 0; kk < 15; kk += 1) {
      for (let jj = 0; jj < 15; jj += 1) {
        for (let ii = 0; ii < 15; ii += 1) {
          const expectedMm = analyticBoxDistanceMm(
            offset,
            -2 + ii,
            -2 + jj,
            -2 + kk,
          );
          if (Math.abs(expectedMm) <= 1) {
            expect(Math.abs(field.distanceM[index] ?? 0)).toBeLessThanOrEqual(
              0.001 + 1e-12,
            );
          }
          index += 1;
        }
      }
    }
  });
});

describe("the signed distance vs analytic ground truth (the sphere)", () => {
  it("stays within the inscribed-mesh chord band of |p| − r", () => {
    const segments = 32;
    const rings = 16;
    const radius = 5;
    const soup = sphereTessellation([0, 0, 0], radius, segments, rings);
    const occupancy = requireOk(
      voxelizeSimTessellation({
        tessellation: soup,
        domain: DOMAIN,
      }),
      "the sphere voxelize",
    );
    const field = requireOk(
      simSignedDistanceGrid({ tessellation: soup, occupancy }),
      "the sphere distance field",
    );
    // The mesh is inscribed (vertices on the sphere, faces on chords),
    // so its Hausdorff distance from the sphere is the chord sagitta.
    const angularBound = Math.hypot(Math.PI / (2 * rings), Math.PI / segments);
    const band = radius * (1 - Math.cos(angularBound));
    let index = 0;
    for (let k = 0; k < 15; k += 1) {
      for (let j = 0; j < 15; j += 1) {
        for (let i = 0; i < 15; i += 1) {
          const x = -2 + i;
          const y = -2 + j;
          const z = -2 + k;
          const analyticMm = Math.sqrt(x * x + y * y + z * z) - radius;
          expect(
            Math.abs((field.distanceM[index] ?? 0) - analyticMm / 1000),
          ).toBeLessThanOrEqual(band / 1000 + 1e-12);
          index += 1;
        }
      }
    }
  });
});

describe("determinism and order independence (law S2)", () => {
  it("is bitwise identical across repeats and triangle-order permutations", () => {
    const { occupancy, soup } = boxFixture();
    const first = requireOk(
      simSignedDistanceGrid({ tessellation: soup, occupancy }),
      "field one",
    );
    const second = requireOk(
      simSignedDistanceGrid({ tessellation: soup, occupancy }),
      "field two",
    );
    expect(second).toEqual(first);
    const permuted = requireOk(
      simSignedDistanceGrid({
        tessellation: permuteTriangles(soup),
        occupancy,
      }),
      "the permuted field",
    );
    expect(permuted).toEqual(first);
  });
});

describe("the door declines loudly", () => {
  it("refuses an empty tessellation and a mismatched occupancy grid", () => {
    const { occupancy, soup } = boxFixture();
    const empty = simSignedDistanceGrid({
      tessellation: { positions: [], indices: [] },
      occupancy,
    });
    expect(empty.ok).toBe(false);
    if (empty.ok) return;
    expect(empty.error.code).toBe(SIM_ERROR_CODES.tessellationInvalid);

    const mismatched = simSignedDistanceGrid({
      tessellation: soup,
      occupancy: {
        ...occupancy,
        cells: new Uint8Array((occupancy.cells.length ?? 1) - 1),
      },
    });
    expect(mismatched.ok).toBe(false);
    if (mismatched.ok) return;
    expect(mismatched.error.code).toBe(SIM_ERROR_CODES.gridFieldMalformed);
  });
});
