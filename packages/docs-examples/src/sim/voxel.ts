/**
 * The `simulation` guide's voxelizer example
 * (docs/guides/simulation.md, the Phase 62 section): tessellation →
 * occupancy grid → signed-distance field → the document-space field
 * block the field overlays consume — the law-S3 geometry interface run
 * end to end over an ANALYTIC fixture (an axis-aligned box soup with
 * dyadic coordinates, so every comparison below is exact
 * floating-point arithmetic, never a tolerance). This is the same
 * pipeline the `/workbench-sim` fixture page drives over a real
 * kernel-tessellated document body; the example proves the numbers the
 * honest-scope section states: staircase boundaries (law S3),
 * node-centered samples, closed-set occupancy (boundary nodes inside).
 */

import {
  decodeSimResultPayload,
  encodeSimResultPayload,
  simGridFromFieldBlock,
  simGridToFieldBlock,
  simSignedDistanceGrid,
  type SimOccupancyGrid,
  voxelizeSimTessellation,
  voxelizeSimTessellationSlice,
} from "@slopcad/sim-core";

/** What the example reports back to the guide and the docs page. */
export interface SimVoxelExampleSummary {
  /** The resolved 3D occupancy shape (the explicit domain's node lattice). */
  readonly shape: readonly [number, number, number];
  /** The occupied node count — the analytic box's exact node count. */
  readonly occupiedNodes: number;
  /** The total node count of the lattice. */
  readonly totalNodes: number;
  /** Every boundary node counts inside (the closed-set convention). */
  readonly boundaryNodesInside: boolean;
  /** The 2D slice's shape — one node exactly ON the plane per in-plane axis. */
  readonly sliceShape: readonly [number, number, number];
  /** The slice's occupied count (the analytic cross-section's node count). */
  readonly sliceOccupiedNodes: number;
  /** The signed distance one node OUTSIDE the box's −x face, metres. */
  readonly distanceOutsideM: number;
  /** The signed distance at the box's centre, metres (negative: inside). */
  readonly distanceCenterM: number;
  /** The field block's document-space unit label. */
  readonly occupancyUnit: string;
  /** The grid → block → payload → decode → grid round trip is exact. */
  readonly roundTripIdentical: boolean;
}

/** Unwraps a parse result or throws with its message (examples fail loud). */
function unwrap<T, E extends { readonly message: string }>(
  result:
    | { readonly ok: true; readonly value: T }
    | { readonly ok: false; readonly error: E },
  what: string,
): T {
  if (!result.ok) {
    throw new Error(
      `The voxelizer example rejected ${what}: ${result.error.message}`,
    );
  }
  return result.value;
}

/**
 * An exact axis-aligned box soup (8 vertices, 12 outward-CCW triangles)
 * spanning [4, 12]³ in canonical millimetres — the voxelizer's own test
 * fixture convention, dyadic so face-plane classification is exact.
 */
function boxSoup(): {
  readonly positions: readonly number[];
  readonly indices: readonly number[];
} {
  return {
    positions: [
      4,
      4,
      4, // 0
      12,
      4,
      4, // 1
      12,
      12,
      4, // 2
      4,
      12,
      4, // 3
      4,
      4,
      12, // 4
      12,
      4,
      12, // 5
      12,
      12,
      12, // 6
      4,
      12,
      12, // 7
    ],
    indices: [
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
      2,
      3,
      7,
      2,
      7,
      6, // yMax, outward +y
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
    ],
  };
}

/** The facts the simulation guide's voxelizer section states. */
export function runSimVoxelExample(): SimVoxelExampleSummary {
  const tessellation = boxSoup();
  // The explicit domain: [0, 16]³ at 2 mm — nodes at every even
  // millimetre, so the box's faces land exactly ON node planes.
  const domain = {
    kind: "explicit",
    minMm: [0, 0, 0],
    maxMm: [16, 16, 16],
    resolutionMm: 2,
  } as const;

  const grid: SimOccupancyGrid = unwrap(
    voxelizeSimTessellation({ tessellation, domain, name: "demo-box" }),
    "the 3D voxelization",
  );
  // 9 nodes per axis (0..16 step 2); the box spans nodes 2..6 (4..12),
  // so 5³ = 125 of 729 are occupied — exact, not a count tolerance.
  const totalNodes = grid.shape[0] * grid.shape[1] * grid.shape[2];
  let occupiedNodes = 0;
  for (const cell of grid.cells) occupiedNodes += cell;

  const slice = unwrap(
    voxelizeSimTessellationSlice({
      tessellation,
      domain,
      name: "demo-box-slice",
      plane: { axis: "z", coordinateMm: 8 },
    }),
    "the cross-section slice",
  );
  let sliceOccupiedNodes = 0;
  for (const cell of slice.cells) sliceOccupiedNodes += cell;

  const distance = unwrap(
    simSignedDistanceGrid({ tessellation, occupancy: grid }),
    "the signed-distance field",
  );
  // The index of the node at (x, y, z) in the x-fastest value order.
  const flatIndexOf = (x: number, y: number, z: number): number =>
    x / 2 + grid.shape[0] * (y / 2 + grid.shape[1] * (z / 2));

  // The block door: the grid projects through the S4 boundary into the
  // document-space field block, encodes to the SMR1 payload bytes,
  // decodes back, and re-derives the typed grid — the exact door the
  // cad-r3f field overlays consume (`decodedFieldGrid`).
  const block = unwrap(simGridToFieldBlock(grid), "the grid's field block");
  const payload = unwrap(
    encodeSimResultPayload([block]),
    "the SMR1 payload encode",
  );
  const decodedBlocks = unwrap(
    decodeSimResultPayload(payload),
    "the SMR1 payload decode",
  );
  const decodedBlock = decodedBlocks[0];
  if (decodedBlock === undefined) {
    throw new Error("The decoded payload carried no field block.");
  }
  const roundTripped = unwrap(
    simGridFromFieldBlock(decodedBlock),
    "the decoded block's grid door",
  );
  let roundTripIdentical = roundTripped.semantic === grid.semantic;
  if (roundTripIdentical) {
    const same = roundTripped as SimOccupancyGrid;
    roundTripIdentical =
      same.name === grid.name &&
      same.shape.every((count, axis) => count === grid.shape[axis]) &&
      same.cells.length === grid.cells.length &&
      same.cells.every((cell, index) => cell === grid.cells[index]);
  }

  return {
    shape: grid.shape,
    occupiedNodes,
    totalNodes,
    // The node exactly ON the box's corner (4, 4, 4) is occupied — the
    // closed-solid convention (inside or on).
    boundaryNodesInside: grid.cells[flatIndexOf(4, 4, 4)] === 1,
    sliceShape: slice.shape,
    sliceOccupiedNodes,
    // The node at (2, 8, 8) sits 2 mm outside the −x face: +0.002 m.
    distanceOutsideM: distance.distanceM[flatIndexOf(2, 8, 8)] ?? Number.NaN,
    // The box's centre node (8, 8, 8): 4 mm from every face, negative.
    distanceCenterM: distance.distanceM[flatIndexOf(8, 8, 8)] ?? Number.NaN,
    occupancyUnit: block.unit ?? "1",
    roundTripIdentical,
  };
}
