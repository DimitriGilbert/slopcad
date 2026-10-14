/**
 * The occupancy → solid-mask mapping for the D3Q19 kernel (Phase 66a,
 * law S3's consumer half): the Phase 62 voxel grid is NODE-CENTERED and
 * 3D-NATIVE — the value at extent index (i, j, k) belongs to the point
 * `origin + i·spacing` per axis — and the D3Q19 lattice's nodes ARE
 * those grid nodes, one-to-one, in all three dimensions. The mapping is
 * therefore the DIRECT node interpretation, the 2D module's own shape
 * with the singleton restriction lifted:
 *
 * - grid extent [nx, ny, nz] → lattice (nx, ny, nz); a grid whose
 *   third extent is a singleton is a 2D slice and declines loudly to
 *   the D2Q9 kernel's door (`./occupancy`) rather than being inflated
 *   into a slab;
 * - a node is a full-way bounce-back solid exactly when its occupancy
 *   value is 1 (inside-or-on the closed solid — the voxelizer's
 *   classification, honored as-is; on-surface nodes are solid, the
 *   staircase honesty of law S3);
 * - the mask aliases the grid's value order unchanged (x-fastest,
 *   `x + y·nx + z·nx·ny`) so the layout contract (`./d3q19`) holds for
 *   the mask too.
 */

import {
  type SimError,
  SIM_ERROR_CODES,
  SIM_GRID_MAX_SAMPLES,
  type SimOccupancyGrid,
  type SimParseResult,
  simError,
  simFail,
  simOk,
} from "@slopcad/sim-core";
import type { Lbm3dSolidMask } from "./state-3d";

/**
 * Builds the 3D lattice solid mask from a Phase 62 occupancy grid: the
 * direct node interpretation above. A 2D slice grid, non-binary values,
 * or a value count that disagrees with the extent declines structured
 * (`sim/grid-field-malformed`), and so does a grid past the sample
 * budget every grid-producing door already enforces — the mask is the
 * same memory again, and the refusal belongs at this door too.
 */
export function lbm3dSolidMaskFromGrid(
  grid: SimOccupancyGrid,
): SimParseResult<Lbm3dSolidMask, SimError> {
  if (grid.shape[2] === 1) {
    return simFail(
      simError(
        SIM_ERROR_CODES.gridFieldMalformed,
        `The D3Q19 reference kernel consumes a 3D occupancy grid (extent [nx, ny, nz]); the grid's extent is [${grid.shape.join(", ")}] — a singleton third extent is a 2D slice, and that is the D2Q9 kernel's door, never a silent inflation.`,
        grid.shape,
      ),
    );
  }
  const nx = grid.shape[0] ?? 1;
  const ny = grid.shape[1] ?? 1;
  const nz = grid.shape[2] ?? 1;
  if (grid.cells.length !== nx * ny * nz) {
    return simFail(
      simError(
        SIM_ERROR_CODES.gridFieldMalformed,
        `An occupancy grid's value count (${String(grid.cells.length)}) must equal its extent product (${String(nx * ny * nz)}).`,
        grid.shape,
      ),
    );
  }
  if (nx * ny * nz > SIM_GRID_MAX_SAMPLES) {
    return simFail(
      simError(
        SIM_ERROR_CODES.gridFieldMalformed,
        `A 3D lattice mask of ${String(nx * ny * nz)} nodes exceeds the ${String(SIM_GRID_MAX_SAMPLES)}-sample grid budget every grid door enforces.`,
        grid.shape,
      ),
    );
  }
  for (const value of grid.cells) {
    if (value !== 0 && value !== 1) {
      return simFail(
        simError(
          SIM_ERROR_CODES.gridFieldMalformed,
          `An occupancy grid's values must each be exactly 0 or 1, received ${String(value)}.`,
          value,
        ),
      );
    }
  }
  return simOk({ nx, ny, nz, solid: Uint8Array.from(grid.cells) });
}

/**
 * Builds a 3D mask directly from a lattice-shaped byte array — the
 * module-level door the unit fixtures and the Phase 66a harness use to
 * seed analytic occupancy (boxes, spheres) without going through a grid
 * record.
 */
export function lbm3dSolidMask(
  nx: number,
  ny: number,
  nz: number,
  solid: Uint8Array,
): SimParseResult<Lbm3dSolidMask, SimError> {
  if (
    !Number.isInteger(nx) ||
    !Number.isInteger(ny) ||
    !Number.isInteger(nz) ||
    nx < 3 ||
    ny < 3 ||
    nz < 3 ||
    solid.length !== nx * ny * nz
  ) {
    return simFail(
      simError(
        SIM_ERROR_CODES.gridFieldMalformed,
        `A 3D lattice mask needs integer extents of at least 3 per axis (interior nodes must exist) and a value array of exactly nx·ny·nz, received ${String(nx)}×${String(ny)}×${String(nz)} with ${String(solid.length)} values.`,
        { nx, ny, nz, length: solid.length },
      ),
    );
  }
  for (const value of solid) {
    if (value !== 0 && value !== 1) {
      return simFail(
        simError(
          SIM_ERROR_CODES.gridFieldMalformed,
          `A 3D lattice mask's values must each be exactly 0 or 1, received ${String(value)}.`,
          value,
        ),
      );
    }
  }
  return simOk({ nx, ny, nz, solid: Uint8Array.from(solid) });
}
