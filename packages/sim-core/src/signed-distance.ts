/**
 * The signed-distance field over a voxel grid (ROADMAP-SIM Phase 62a,
 * law S3's distance half) — the groundwork for the Phase 66 cut-cell
 * decision and later refinement, deliberately kept behind its own
 * module and its own entry: computing it is an OPTIONAL consumer
 * choice (`simSignedDistanceGrid` is never called by the voxelizer),
 * per the roadmap's risk note that mesh–grid interpolation bugs live
 * in the distance field, answered with exact arithmetic and its own
 * analytic fixtures.
 *
 * ## Semantics
 *
 * Over the SAME grid as an occupancy grid (identical name, shape,
 * origin, spacing — the occupancy grid IS the geometry carrier), each
 * node gets the EXACT Euclidean distance to the tessellation's
 * triangle soup — the true point-to-triangle closest point per
 * triangle, minimum over all triangles, no fast-marching or
 * interpolation stencil anywhere — signed negative inside the closed
 * solid and positive outside, with the sign taken from the occupancy
 * classification at that node (the two modules share one membership
 * truth) and 0 on the surface to within the node lattice's own
 * floating-point position noise (sub-femtometre at part scale — the
 * SI lattice expression rounds where the millimetre-classified
 * occupancy did not). Because the min of a set is
 * exact under IEEE arithmetic, the field is bitwise-deterministic and
 * independent of the soup's triangle order; the AABB culling that
 * keeps the brute force tractable skips a triangle only when a lower
 * bound on its distance already cannot beat the running minimum, so
 * the culled value is the uncullable truth.
 *
 * ## Units (law S4)
 *
 * The tessellation's canonical millimetres convert to solver-space
 * metres at this door (the shared `MM_PER_M`, the geometry half of the
 * compile door — the same single-site rule `./voxelizer` states), and
 * the field's values are metres; nodes sit at
 * `simGridSamplePositionM`'s documented lattice, the one source of
 * truth for the geometry. Projection to document space rides
 * `simGridToFieldBlock` (mm, through `projectSimResult`) like every
 * other grid.
 */

import { type SimError, SIM_ERROR_CODES, simError } from "./errors";
import { type SimParseResult, simFail, simOk } from "./result";
import { MM_PER_M } from "./units";
import {
  type SimDistanceGrid,
  type SimOccupancyGrid,
  simGridNameProblem,
  simGridSampleCount,
  simGridSamplePositionM,
} from "./voxel-grid";
import {
  type ValidatedSimTessellation,
  parseSimTessellationWire,
} from "./voxelizer";

/** What {@link simSignedDistanceGrid} consumes. */
export interface SimSignedDistanceInput {
  /** The watertight triangle soup in canonical mm (re-validated). */
  readonly tessellation: unknown;
  /**
   * The occupancy grid the field lives on — its geometry defines the
   * lattice, its classification defines the signs, its name names the
   * field ("\<name\>.signed-distance" on the block).
   */
  readonly occupancy: SimOccupancyGrid;
}

/** The soup in solver-space metres, ready for distance arithmetic. */
interface MetreTriangles {
  readonly coords: Float64Array;
  readonly minX: Float64Array;
  readonly maxX: Float64Array;
  readonly minY: Float64Array;
  readonly maxY: Float64Array;
  readonly minZ: Float64Array;
  readonly maxZ: Float64Array;
}

function buildMetreTriangles(
  tessellation: ValidatedSimTessellation,
): MetreTriangles {
  const triangleCount = tessellation.indices.length / 3;
  const coords = new Float64Array(triangleCount * 9);
  const minX = new Float64Array(triangleCount);
  const maxX = new Float64Array(triangleCount);
  const minY = new Float64Array(triangleCount);
  const maxY = new Float64Array(triangleCount);
  const minZ = new Float64Array(triangleCount);
  const maxZ = new Float64Array(triangleCount);
  for (let triangle = 0; triangle < triangleCount; triangle += 1) {
    for (let corner = 0; corner < 3; corner += 1) {
      const vertex = tessellation.indices[triangle * 3 + corner] ?? 0;
      for (let axis = 0; axis < 3; axis += 1) {
        coords[triangle * 9 + corner * 3 + axis] =
          (tessellation.positions[vertex * 3 + axis] ?? 0) / MM_PER_M;
      }
    }
    const base = triangle * 9;
    minX[triangle] = Math.min(
      coords[base] ?? 0,
      coords[base + 3] ?? 0,
      coords[base + 6] ?? 0,
    );
    maxX[triangle] = Math.max(
      coords[base] ?? 0,
      coords[base + 3] ?? 0,
      coords[base + 6] ?? 0,
    );
    minY[triangle] = Math.min(
      coords[base + 1] ?? 0,
      coords[base + 4] ?? 0,
      coords[base + 7] ?? 0,
    );
    maxY[triangle] = Math.max(
      coords[base + 1] ?? 0,
      coords[base + 4] ?? 0,
      coords[base + 7] ?? 0,
    );
    minZ[triangle] = Math.min(
      coords[base + 2] ?? 0,
      coords[base + 5] ?? 0,
      coords[base + 8] ?? 0,
    );
    maxZ[triangle] = Math.max(
      coords[base + 2] ?? 0,
      coords[base + 5] ?? 0,
      coords[base + 8] ?? 0,
    );
  }
  return { coords, minX, maxX, minY, maxY, minZ, maxZ };
}

/**
 * The squared distance from a point to one triangle — Ericson's exact
 * region-classified closest point (vertex, edge, or interior), the
 * reference formulation with no approximation anywhere.
 */
function pointTriangleDistanceSq(
  px: number,
  py: number,
  pz: number,
  base: number,
  coords: Float64Array,
): number {
  const ax = coords[base] ?? 0;
  const ay = coords[base + 1] ?? 0;
  const az = coords[base + 2] ?? 0;
  const abx = (coords[base + 3] ?? 0) - ax;
  const aby = (coords[base + 4] ?? 0) - ay;
  const abz = (coords[base + 5] ?? 0) - az;
  const acx = (coords[base + 6] ?? 0) - ax;
  const acy = (coords[base + 7] ?? 0) - ay;
  const acz = (coords[base + 8] ?? 0) - az;
  const apx = px - ax;
  const apy = py - ay;
  const apz = pz - az;
  const d1 = abx * apx + aby * apy + abz * apz;
  const d2 = acx * apx + acy * apy + acz * apz;
  if (d1 <= 0 && d2 <= 0) {
    return apx * apx + apy * apy + apz * apz;
  }
  const bpx = px - (coords[base + 3] ?? 0);
  const bpy = py - (coords[base + 4] ?? 0);
  const bpz = pz - (coords[base + 5] ?? 0);
  const d3 = abx * bpx + aby * bpy + abz * bpz;
  const d4 = acx * bpx + acy * bpy + acz * bpz;
  if (d3 >= 0 && d4 <= d3) {
    return bpx * bpx + bpy * bpy + bpz * bpz;
  }
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const t = d1 / (d1 - d3);
    const qx = apx - t * abx;
    const qy = apy - t * aby;
    const qz = apz - t * abz;
    return qx * qx + qy * qy + qz * qz;
  }
  const cpx = px - (coords[base + 6] ?? 0);
  const cpy = py - (coords[base + 7] ?? 0);
  const cpz = pz - (coords[base + 8] ?? 0);
  const d5 = abx * cpx + aby * cpy + abz * cpz;
  const d6 = acx * cpx + acy * cpy + acz * cpz;
  if (d6 >= 0 && d5 <= d6) {
    return cpx * cpx + cpy * cpy + cpz * cpz;
  }
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const t = d2 / (d2 - d6);
    const qx = apx - t * acx;
    const qy = apy - t * acy;
    const qz = apz - t * acz;
    return qx * qx + qy * qy + qz * qz;
  }
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const t = (d4 - d3) / (d4 - d3 + (d5 - d6));
    const cbx = (coords[base + 6] ?? 0) - (coords[base + 3] ?? 0);
    const cby = (coords[base + 7] ?? 0) - (coords[base + 4] ?? 0);
    const cbz = (coords[base + 8] ?? 0) - (coords[base + 5] ?? 0);
    const qx = bpx - t * cbx;
    const qy = bpy - t * cby;
    const qz = bpz - t * cbz;
    return qx * qx + qy * qy + qz * qz;
  }
  const denominator = 1 / (va + vb + vc);
  const v = vb * denominator;
  const w = vc * denominator;
  const qx = apx - v * abx - w * acx;
  const qy = apy - v * aby - w * acy;
  const qz = apz - v * abz - w * acz;
  return qx * qx + qy * qy + qz * qz;
}

/**
 * The signed-distance field over an occupancy grid's own lattice:
 * exact distances (metres), signs from the occupancy classification,
 * 0 on the surface. Deterministic and triangle-order-independent by
 * construction (the module header); declines on the mesh door's terms
 * and on an occupancy grid whose shape and cell count disagree.
 */
export function simSignedDistanceGrid(
  input: SimSignedDistanceInput,
): SimParseResult<SimDistanceGrid, SimError> {
  const tessellation = parseSimTessellationWire(input.tessellation);
  if (!tessellation.ok) return tessellation;
  const occupancy = input.occupancy;
  const nameProblem = simGridNameProblem(occupancy.name);
  if (nameProblem !== undefined) return simFail(nameProblem);
  const count = simGridSampleCount(occupancy);
  if (occupancy.cells.length !== count) {
    return simFail(
      simError(
        SIM_ERROR_CODES.gridFieldMalformed,
        "A signed-distance field needs an occupancy grid whose cell count equals its extent product.",
        occupancy,
      ),
    );
  }
  const triangles = buildMetreTriangles(tessellation.value);
  const triangleCount = triangles.minX.length;
  const distanceM = new Float64Array(count);
  const [nx, ny, nz] = occupancy.shape;
  let index = 0;
  for (let k = 0; k < (nz ?? 1); k += 1) {
    for (let j = 0; j < (ny ?? 1); j += 1) {
      for (let i = 0; i < (nx ?? 1); i += 1) {
        const [px, py, pz] = simGridSamplePositionM(occupancy, i, j, k);
        let bestSq = Number.POSITIVE_INFINITY;
        for (let triangle = 0; triangle < triangleCount; triangle += 1) {
          // AABB lower bound: a triangle strictly boxed out of beating
          // the running minimum cannot change it (min is exact), so the
          // cull never alters the value — only the cost.
          const dx =
            px < (triangles.minX[triangle] ?? 0)
              ? (triangles.minX[triangle] ?? 0) - px
              : px > (triangles.maxX[triangle] ?? 0)
                ? px - (triangles.maxX[triangle] ?? 0)
                : 0;
          const dy =
            py < (triangles.minY[triangle] ?? 0)
              ? (triangles.minY[triangle] ?? 0) - py
              : py > (triangles.maxY[triangle] ?? 0)
                ? py - (triangles.maxY[triangle] ?? 0)
                : 0;
          const dz =
            pz < (triangles.minZ[triangle] ?? 0)
              ? (triangles.minZ[triangle] ?? 0) - pz
              : pz > (triangles.maxZ[triangle] ?? 0)
                ? pz - (triangles.maxZ[triangle] ?? 0)
                : 0;
          if (dx * dx + dy * dy + dz * dz >= bestSq) continue;
          const squared = pointTriangleDistanceSq(
            px,
            py,
            pz,
            triangle * 9,
            triangles.coords,
          );
          if (squared < bestSq) bestSq = squared;
        }
        const distance = Math.sqrt(bestSq);
        distanceM[index] =
          distance === 0
            ? 0
            : occupancy.cells[index] === 1
              ? -distance
              : distance;
        index += 1;
      }
    }
  }
  return simOk(
    Object.freeze({
      semantic: "signed-distance",
      name: occupancy.name,
      shape: occupancy.shape,
      originM: occupancy.originM,
      spacingM: occupancy.spacingM,
      distanceM,
    }),
  );
}
