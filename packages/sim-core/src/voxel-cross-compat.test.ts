/**
 * Voxel cross-compatibility pins (Phase 62a): the voxelizer's
 * structural restatement of the kernel contract's `Tessellation` is
 * only honest while the two stay pinned — this suite fails the moment
 * either shape drifts — and, behaviorally, REAL kernel output must
 * voxelize against analytic ground truth. The kernel package is a
 * dev-only import: it appears in no runtime graph of sim-core, exactly
 * as the wire pins of Phase 61 (`./sim-worker-cross-compat.test.ts`)
 * and the scenario pins (`./sim-scenario-cross-compat.test.ts`).
 */

import { length } from "@slopcad/cad-core";
import {
  createFakeKernel,
  FAKE_KERNEL_TESSELLATION_RINGS,
  FAKE_KERNEL_TESSELLATION_SEGMENTS,
  type GeometryKernel,
  type KernelResult,
  type KernelSolid,
  type Tessellation,
} from "@slopcad/cad-kernel";
import { describe, expect, it } from "vitest";
import type { SimTessellationWire } from "./voxelizer";

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
      `The voxel cross-compat test rejected ${what}: ${result.error.message}`,
    );
  }
  return result.value;
}

function kernelTessellation(
  kernel: GeometryKernel,
  solid: KernelResult<KernelSolid>,
): Tessellation {
  return requireOk(
    kernel.tessellate(requireOk(solid, "the solid")),
    "the tessellation",
  );
}

describe("the tessellation wire pin", () => {
  it("holds the restatement assignable both ways", () => {
    const wire: SimTessellationWire = {
      positions: [0, 0, 0, 1, 0, 0, 0, 1, 0],
      indices: [0, 1, 2],
      normals: [0, 0, 1, 0, 0, 1, 0, 0, 1],
    };
    // Compiles only while the structural shapes agree; identity at
    // runtime keeps both bindings referenced.
    const kernelSide: Tessellation = wire;
    const doorSide: SimTessellationWire = kernelSide;
    expect(doorSide).toBe(wire);
  });
});

describe("real kernel output against analytic ground truth", () => {
  it("voxelizes the fake kernel's box exactly at every node", () => {
    const kernel = createFakeKernel();
    const tessellation = kernelTessellation(
      kernel,
      kernel.createBox({
        width: length(10, "mm"),
        depth: length(10, "mm"),
        height: length(10, "mm"),
      }),
    );
    const grid = requireOk(
      voxelizeSimTessellation({
        tessellation,
        domain: {
          kind: "explicit",
          minMm: [-2, -2, -2],
          maxMm: [12, 12, 12],
          resolutionMm: 1,
        },
      }),
      "the kernel box voxelize",
    );
    expect(grid.shape).toEqual([15, 15, 15]);
    for (let k = 0; k < 15; k += 1) {
      for (let j = 0; j < 15; j += 1) {
        for (let i = 0; i < 15; i += 1) {
          const x = -2 + i;
          const y = -2 + j;
          const z = -2 + k;
          const expected =
            x >= 0 && x <= 10 && y >= 0 && y <= 10 && z >= 0 && z <= 10 ? 1 : 0;
          expect(grid.cells[i + 15 * (j + 15 * k)]).toBe(expected);
        }
      }
    }
  });

  it("brackets the fake kernel's sphere with its own resolution constants", () => {
    const kernel = createFakeKernel();
    const radius = 5;
    const tessellation = kernelTessellation(
      kernel,
      kernel.createSphere({ radius: length(radius, "mm") }),
    );
    const grid = requireOk(
      voxelizeSimTessellation({
        tessellation,
        domain: {
          kind: "explicit",
          minMm: [-6, -6, -6],
          maxMm: [6, 6, 6],
          resolutionMm: 1,
        },
      }),
      "the kernel sphere voxelize",
    );
    expect(grid.shape).toEqual([13, 13, 13]);
    // The fake kernel's own angular discretization bounds the inradius
    // of the inscribed polyhedron; the mesh is inside the analytic
    // sphere, so the sandwich is analytic either way.
    const angularBound = Math.hypot(
      Math.PI / (2 * FAKE_KERNEL_TESSELLATION_RINGS),
      Math.PI / FAKE_KERNEL_TESSELLATION_SEGMENTS,
    );
    const innerRadius = radius * Math.cos(angularBound);
    for (let k = 0; k < 13; k += 1) {
      for (let j = 0; j < 13; j += 1) {
        for (let i = 0; i < 13; i += 1) {
          const x = -6 + i;
          const y = -6 + j;
          const z = -6 + k;
          const distance = Math.sqrt(x * x + y * y + z * z);
          const cell = grid.cells[i + 13 * (j + 13 * k)];
          if (distance > radius + 1e-9) expect(cell).toBe(0);
          if (distance < innerRadius) expect(cell).toBe(1);
        }
      }
    }
  });

  it("signs the fake kernel's box distance field at the analytic extremes", () => {
    const kernel = createFakeKernel();
    const tessellation = kernelTessellation(
      kernel,
      kernel.createBox({
        width: length(10, "mm"),
        depth: length(10, "mm"),
        height: length(10, "mm"),
      }),
    );
    const grid = requireOk(
      voxelizeSimTessellation({
        tessellation,
        domain: {
          kind: "explicit",
          minMm: [-2, -2, -2],
          maxMm: [12, 12, 12],
          resolutionMm: 1,
        },
      }),
      "the kernel box voxelize",
    );
    const field = requireOk(
      simSignedDistanceGrid({ tessellation, occupancy: grid }),
      "the kernel box distance field",
    );
    const at = (x: number, y: number, z: number): number =>
      field.distanceM[x + 2 + 15 * (y + 2 + 15 * (z + 2))] ?? 0;
    // Deep interior: −5 mm (the centre); deep exterior corner: the
    // diagonal of the 2 mm padding.
    expect(at(5, 5, 5)).toBeCloseTo(-0.005, 10);
    expect(at(-2, -2, -2)).toBeCloseTo((Math.sqrt(3) * 2) / 1000, 10);
  });
});
