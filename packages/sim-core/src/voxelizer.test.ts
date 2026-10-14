/**
 * Voxelizer tests (Phase 62a, law S3): occupancy against ANALYTIC ground
 * truth — box/sphere exactness at aligned resolutions, exact
 * cross-section slices — plus the determinism pins (bitwise repeat,
 * triangle-order and vertex-order invariance), body-derived bounds
 * stability, and the loud `sim/*` declines of the mesh, domain, plane,
 * and name doors. All fixtures are self-authored soups in canonical
 * millimetres with dyadic coordinates, so every comparison at face
 * planes is exact floating-point arithmetic, never a tolerance; the
 * kernel-package compatibility pins live in
 * `./voxel-cross-compat.test.ts`.
 */

import { describe, expect, it } from "vitest";
import type { SimOccupancyGrid } from "./voxel-grid";

import { SIM_ERROR_CODES } from "./errors";
import {
  type SimTessellationWire,
  voxelizeSimTessellation,
  voxelizeSimTessellationSlice,
} from "./voxelizer";

function requireOk<T, E extends { readonly message: string }>(
  result:
    | { readonly ok: true; readonly value: T }
    | { readonly ok: false; readonly error: E },
  what: string,
): T {
  if (!result.ok) {
    throw new Error(
      `The voxelizer test rejected ${what}: ${result.error.message}`,
    );
  }
  return result.value;
}

interface Box {
  readonly min: readonly [number, number, number];
  readonly max: readonly [number, number, number];
}

/** An exact axis-aligned box soup: 8 vertices, 12 outward-CCW triangles. */
function boxTessellation(box: Box): SimTessellationWire {
  const [x0, y0, z0] = box.min;
  const [x1, y1, z1] = box.max;
  const positions = [
    x0,
    y0,
    z0, // 0
    x1,
    y0,
    z0, // 1
    x1,
    y1,
    z0, // 2
    x0,
    y1,
    z0, // 3
    x0,
    y0,
    z1, // 4
    x1,
    y0,
    z1, // 5
    x1,
    y1,
    z1, // 6
    x0,
    y1,
    z1, // 7
  ];
  const indices = [
    0,
    3,
    2,
    0,
    2,
    1, // zMin, outward −z
    4,
    5,
    6,
    4,
    6,
    7, // zMax, outward +z
    0,
    1,
    5,
    0,
    5,
    4, // yMin, outward −y
    3,
    7,
    6,
    3,
    6,
    2, // yMax, outward +y
    0,
    4,
    7,
    0,
    7,
    3, // xMin, outward −x
    1,
    2,
    6,
    1,
    6,
    5, // xMax, outward +x
  ];
  return { positions, indices };
}

/**
 * A UV sphere soup: poles on +z/−z, `rings` latitude stations, `segments`
 * azimuth stations, outward-CCW winding (pole fans plus quad splits).
 * Every vertex sits exactly on the analytic sphere; triangle interiors
 * are chords strictly inside it.
 */
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
      const here = ringStart(row) + corner;
      const below = ringStart(row + 1) + corner;
      const belowNext = ringStart(row + 1) + next;
      const hereNext = ringStart(row) + next;
      indices.push(here, below, belowNext);
      indices.push(here, belowNext, hereNext);
    }
  }
  return { positions, indices };
}

/** Permutes the soup's TRIANGLE order (no winding change). */
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

/** Reverses the vertex order and remaps indices (same geometry, same winding). */
function reverseVertices(
  tessellation: SimTessellationWire,
): SimTessellationWire {
  const vertexCount = tessellation.positions.length / 3;
  const positions: number[] = [];
  for (let vertex = vertexCount - 1; vertex >= 0; vertex -= 1) {
    positions.push(
      tessellation.positions[vertex * 3] ?? 0,
      tessellation.positions[vertex * 3 + 1] ?? 0,
      tessellation.positions[vertex * 3 + 2] ?? 0,
    );
  }
  const indices = tessellation.indices.map((index) => vertexCount - 1 - index);
  return { positions, indices };
}

function explicitDomain(
  min: readonly [number, number, number],
  max: readonly [number, number, number],
  resolutionMm: number,
): {
  readonly kind: "explicit";
  readonly minMm: readonly [number, number, number];
  readonly maxMm: readonly [number, number, number];
  readonly resolutionMm: number;
} {
  return { kind: "explicit", minMm: min, maxMm: max, resolutionMm };
}

const BOX: Box = { min: [0, 0, 0], max: [10, 10, 10] };

/** The analytic closed-box membership at integer node positions. */
function expectedBoxCells(
  box: Box,
  originMm: readonly [number, number, number],
  shape: readonly [number, number, number],
  resolutionMm: number,
): Uint8Array {
  const [nx, ny, nz] = shape;
  const cells = new Uint8Array(nx * ny * nz);
  let index = 0;
  for (let k = 0; k < nz; k += 1) {
    const z = (originMm[2] ?? 0) + k * resolutionMm;
    for (let j = 0; j < ny; j += 1) {
      const y = (originMm[1] ?? 0) + j * resolutionMm;
      for (let i = 0; i < nx; i += 1) {
        const x = (originMm[0] ?? 0) + i * resolutionMm;
        const inside =
          x >= (box.min[0] ?? 0) &&
          x <= (box.max[0] ?? 0) &&
          y >= (box.min[1] ?? 0) &&
          y <= (box.max[1] ?? 0) &&
          z >= (box.min[2] ?? 0) &&
          z <= (box.max[2] ?? 0);
        cells[index] = inside ? 1 : 0;
        index += 1;
      }
    }
  }
  return cells;
}

describe("3D occupancy against analytic ground truth", () => {
  it("reproduces an aligned box exactly at every node (h = 1 mm)", () => {
    const grid = requireOk(
      voxelizeSimTessellation({
        tessellation: boxTessellation(BOX),
        domain: explicitDomain([-2, -2, -2], [12, 12, 12], 1),
      }),
      "the aligned box voxelize",
    );
    expect(grid.shape).toEqual([15, 15, 15]);
    expect(grid.originM).toEqual([-0.002, -0.002, -0.002]);
    expect(grid.spacingM).toEqual([0.001, 0.001, 0.001]);
    expect(grid.cells).toEqual(
      expectedBoxCells(BOX, [-2, -2, -2], [15, 15, 15], 1),
    );
    let occupied = 0;
    for (const cell of grid.cells) occupied += cell;
    expect(occupied).toBe(11 ** 3);
  });

  it("reproduces an aligned box exactly at a finer resolution (h = 0.5 mm)", () => {
    const grid = requireOk(
      voxelizeSimTessellation({
        tessellation: boxTessellation(BOX),
        domain: explicitDomain([-1, -1, -1], [11, 11, 11], 0.5),
      }),
      "the fine box voxelize",
    );
    expect(grid.shape).toEqual([25, 25, 25]);
    expect(grid.cells).toEqual(
      expectedBoxCells(BOX, [-1, -1, -1], [25, 25, 25], 0.5),
    );
  });

  it("reproduces a box offset between node planes exactly (closed bounds)", () => {
    const offset: Box = { min: [0.25, 0.25, 0.25], max: [10.25, 10.25, 10.25] };
    const grid = requireOk(
      voxelizeSimTessellation({
        tessellation: boxTessellation(offset),
        domain: explicitDomain([-2, -2, -2], [12, 12, 12], 1),
      }),
      "the offset box voxelize",
    );
    expect(grid.cells).toEqual(
      expectedBoxCells(offset, [-2, -2, -2], [15, 15, 15], 1),
    );
  });

  it("brackets a tessellated sphere: deep-interior nodes occupied, exterior empty", () => {
    // The mesh is inscribed in the analytic sphere (chords), so exterior
    // nodes (|p| > r) are empty for sure, and nodes inside the inball of
    // the largest triangle circumcircle are occupied for sure; only the
    // chord band between is the staircase's own.
    const segments = 32;
    const rings = 16;
    const radius = 5;
    const grid = requireOk(
      voxelizeSimTessellation({
        tessellation: sphereTessellation([0, 0, 0], radius, segments, rings),
        domain: explicitDomain([-6, -6, -6], [6, 6, 6], 1),
      }),
      "the sphere voxelize",
    );
    expect(grid.shape).toEqual([13, 13, 13]);
    const angularBound = Math.hypot(Math.PI / (2 * rings), Math.PI / segments);
    const innerRadius = radius * Math.cos(angularBound);
    for (let k = 0; k < 13; k += 1) {
      for (let j = 0; j < 13; j += 1) {
        for (let i = 0; i < 13; i += 1) {
          const x = -6 + i;
          const y = -6 + j;
          const z = -6 + k;
          const distance = Math.sqrt(x * x + y * y + z * z);
          const cell = grid.cells[i + 13 * (j + 13 * k)];
          if (distance > radius + 1e-9) {
            expect(cell).toBe(0);
          }
          if (distance < innerRadius) {
            expect(cell).toBe(1);
          }
        }
      }
    }
  });
});

describe("cross-section slices against analytic ground truth", () => {
  it("slices an aligned box mid-plane into the exact rectangle", () => {
    const grid = requireOk(
      voxelizeSimTessellationSlice({
        tessellation: boxTessellation(BOX),
        domain: explicitDomain([-2, -2, -2], [12, 12, 12], 1),
        plane: { axis: "z", coordinateMm: 5 },
      }),
      "the z = 5 slice",
    );
    expect(grid.shape).toEqual([15, 15, 1]);
    expect(grid.originM).toEqual([-0.002, -0.002, 0.005]);
    const expected = expectedBoxCells(BOX, [-2, -2, 5], [15, 15, 1], 1);
    expect(grid.cells).toEqual(expected);
    let occupied = 0;
    for (const cell of grid.cells) occupied += cell;
    expect(occupied).toBe(11 * 11);
  });

  it("keeps document-axis order for a y-normal slice", () => {
    const grid = requireOk(
      voxelizeSimTessellationSlice({
        tessellation: boxTessellation(BOX),
        domain: explicitDomain([-2, -2, -2], [12, 12, 12], 1),
        plane: { axis: "y", coordinateMm: 2.5 },
      }),
      "the y = 2.5 slice",
    );
    expect(grid.shape).toEqual([15, 1, 15]);
    expect(grid.originM).toEqual([-0.002, 0.0025, -0.002]);
    expect(grid.cells).toEqual(
      expectedBoxCells(BOX, [-2, 2.5, -2], [15, 1, 15], 1),
    );
  });

  it("returns an honestly empty grid for a plane that misses the solid", () => {
    const grid = requireOk(
      voxelizeSimTessellationSlice({
        tessellation: boxTessellation(BOX),
        domain: explicitDomain([-2, -2, -2], [12, 12, 12], 1),
        plane: { axis: "x", coordinateMm: 12.5 },
      }),
      "the x = 12.5 slice",
    );
    expect(grid.shape).toEqual([1, 15, 15]);
    let occupied = 0;
    for (const cell of grid.cells) occupied += cell;
    expect(occupied).toBe(0);
  });
});

describe("determinism (law S2)", () => {
  it("is bitwise identical across repeated runs", () => {
    const input = {
      tessellation: boxTessellation(BOX),
      domain: explicitDomain([-2, -2, -2], [12, 12, 12], 1),
    };
    const first = requireOk(voxelizeSimTessellation(input), "run one");
    const second = requireOk(voxelizeSimTessellation(input), "run two");
    expect(second).toEqual(first);
  });

  it("never depends on the soup's triangle order or vertex order", () => {
    const domain = explicitDomain([-2, -2, -2], [12, 12, 12], 1);
    const baseline = requireOk(
      voxelizeSimTessellation({
        tessellation: sphereTessellation([0, 0, 0], 5, 16, 8),
        domain,
      }),
      "the baseline sphere",
    );
    const trianglePermuted = requireOk(
      voxelizeSimTessellation({
        tessellation: permuteTriangles(sphereTessellation([0, 0, 0], 5, 16, 8)),
        domain,
      }),
      "the triangle-permuted sphere",
    );
    expect(trianglePermuted).toEqual(baseline);
    const vertexReversed = requireOk(
      voxelizeSimTessellation({
        tessellation: reverseVertices(sphereTessellation([0, 0, 0], 5, 16, 8)),
        domain,
      }),
      "the vertex-reversed sphere",
    );
    expect(vertexReversed).toEqual(baseline);
  });
});

describe("body-derived domains", () => {
  it("derives stable bounds from referenced vertices only", () => {
    const soup = boxTessellation(BOX);
    const stray = {
      positions: [...soup.positions, 100, 100, 100],
      indices: soup.indices,
    };
    const margin = 2;
    const grid = requireOk(
      voxelizeSimTessellation({
        tessellation: stray,
        domain: { kind: "body", marginMm: margin, resolutionMm: 1 },
      }),
      "the body-derived voxelize",
    );
    expect(grid.shape).toEqual([15, 15, 15]);
    expect(grid.originM).toEqual([-0.002, -0.002, -0.002]);
    const explicit = requireOk(
      voxelizeSimTessellation({
        tessellation: soup,
        domain: explicitDomain([-2, -2, -2], [12, 12, 12], 1),
      }),
      "the explicit-domain voxelize",
    );
    expect(grid.cells).toEqual(explicit.cells);
  });

  it("honors a zero margin by gridding the bounds themselves", () => {
    const grid = requireOk(
      voxelizeSimTessellation({
        tessellation: boxTessellation(BOX),
        domain: { kind: "body", marginMm: 0, resolutionMm: 1 },
      }),
      "the zero-margin voxelize",
    );
    expect(grid.shape).toEqual([11, 11, 11]);
    expect(grid.originM).toEqual([0, 0, 0]);
    expect(grid.cells).toEqual(
      expectedBoxCells(BOX, [0, 0, 0], [11, 11, 11], 1),
    );
  });
});

describe("the doors decline loudly", () => {
  const goodDomain = explicitDomain([-2, -2, -2], [12, 12, 12], 1);

  function declineCode(input: {
    readonly tessellation: unknown;
    readonly domain: unknown;
    readonly name?: string;
    readonly plane?: unknown;
  }): string {
    const result =
      input.plane === undefined
        ? voxelizeSimTessellation(input)
        : voxelizeSimTessellationSlice(
            input as {
              readonly tessellation: unknown;
              readonly domain: unknown;
              readonly plane: unknown;
            },
          );
    if (result.ok) {
      throw new Error("The voxelize door accepted input it must refuse.");
    }
    return result.error.code;
  }

  it("refuses empty and degenerate tessellations", () => {
    expect(
      declineCode({
        tessellation: { positions: [], indices: [] },
        domain: goodDomain,
      }),
    ).toBe(SIM_ERROR_CODES.tessellationInvalid);
    expect(
      declineCode({
        tessellation: { positions: [0, 0, 0], indices: [] },
        domain: goodDomain,
      }),
    ).toBe(SIM_ERROR_CODES.tessellationInvalid);
  });

  it("refuses malformed soups", () => {
    expect(
      declineCode({
        tessellation: { positions: [0, 0, 0, 1], indices: [0, 0, 0] },
        domain: goodDomain,
      }),
    ).toBe(SIM_ERROR_CODES.tessellationInvalid);
    expect(
      declineCode({
        tessellation: {
          positions: [0, 0, 0, 1, 0, 0, 0, 1, 0],
          indices: [0, 1, 3],
        },
        domain: goodDomain,
      }),
    ).toBe(SIM_ERROR_CODES.tessellationInvalid);
    expect(
      declineCode({
        tessellation: {
          positions: [0, 0, 0, 1, 0, Number.NaN, 0, 1, 0],
          indices: [0, 1, 2],
        },
        domain: goodDomain,
      }),
    ).toBe(SIM_ERROR_CODES.tessellationInvalid);
    expect(
      declineCode({
        tessellation: {
          positions: [0, 0, 0, 1, 0, 0, 0, 1, 0],
          indices: [0, 1, 2],
          normals: [0, 0],
        },
        domain: goodDomain,
      }),
    ).toBe(SIM_ERROR_CODES.tessellationInvalid);
  });

  it("refuses invalid domains, resolutions, and budgets", () => {
    expect(
      declineCode({
        tessellation: boxTessellation(BOX),
        domain: {
          kind: "explicit",
          minMm: [0, 0, 0],
          maxMm: [10, 0, 10],
          resolutionMm: 1,
        },
      }),
    ).toBe(SIM_ERROR_CODES.voxelDomainInvalid);
    expect(
      declineCode({
        tessellation: boxTessellation(BOX),
        domain: {
          kind: "explicit",
          minMm: [5, 5, 5],
          maxMm: [4, 10, 10],
          resolutionMm: 1,
        },
      }),
    ).toBe(SIM_ERROR_CODES.voxelDomainInvalid);
    expect(
      declineCode({
        tessellation: boxTessellation(BOX),
        domain: { kind: "body", marginMm: -1, resolutionMm: 1 },
      }),
    ).toBe(SIM_ERROR_CODES.voxelDomainInvalid);
    expect(
      declineCode({
        tessellation: boxTessellation(BOX),
        domain: {
          kind: "explicit",
          minMm: [0, 0, 0],
          maxMm: [10, 10, 10],
          resolutionMm: 0,
        },
      }),
    ).toBe(SIM_ERROR_CODES.voxelDomainInvalid);
    expect(
      declineCode({
        tessellation: boxTessellation(BOX),
        domain: {
          kind: "explicit",
          minMm: [0, 0, 0],
          maxMm: [10, 10, 10],
          resolutionMm: 0.001,
        },
      }),
    ).toBe(SIM_ERROR_CODES.voxelDomainInvalid);
    expect(
      declineCode({
        tessellation: boxTessellation(BOX),
        domain: { kind: "nope", resolutionMm: 1 },
      }),
    ).toBe(SIM_ERROR_CODES.voxelDomainInvalid);
  });

  it("refuses malformed slice planes and grid names", () => {
    expect(
      declineCode({
        tessellation: boxTessellation(BOX),
        domain: goodDomain,
        plane: { axis: "w", coordinateMm: 5 },
      }),
    ).toBe(SIM_ERROR_CODES.voxelDomainInvalid);
    expect(
      declineCode({
        tessellation: boxTessellation(BOX),
        domain: goodDomain,
        plane: { axis: "z", coordinateMm: Number.NaN },
      }),
    ).toBe(SIM_ERROR_CODES.voxelDomainInvalid);
    expect(
      declineCode({
        tessellation: boxTessellation(BOX),
        domain: goodDomain,
        plane: { axis: "z", coordinateMm: 5 },
        name: "bad name!",
      }),
    ).toBe(SIM_ERROR_CODES.gridFieldMalformed);
    expect(
      declineCode({
        tessellation: boxTessellation(BOX),
        domain: goodDomain,
        name: "x".repeat(49),
      }),
    ).toBe(SIM_ERROR_CODES.gridFieldMalformed);
  });
});

describe("the occupancy grid's payload-block identity", () => {
  it("names itself on the grid vocabulary and exposes SI geometry", () => {
    const grid: SimOccupancyGrid = requireOk(
      voxelizeSimTessellation({
        tessellation: boxTessellation(BOX),
        domain: { kind: "body", marginMm: 1, resolutionMm: 2 },
        name: "fan",
      }),
      "the named voxelize",
    );
    expect(grid.name).toBe("fan");
    expect(grid.semantic).toBe("occupancy");
    expect(grid.shape).toEqual([7, 7, 7]);
    expect(grid.originM).toEqual([-0.001, -0.001, -0.001]);
    expect(grid.spacingM).toEqual([0.002, 0.002, 0.002]);
  });
});
