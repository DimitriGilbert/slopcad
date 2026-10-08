/**
 * The occupancy → solid-mask mapping (Phase 63a, law S3's consumer
 * half): the Phase 62a voxel grid is NODE-CENTERED — the value at
 * extent index (i, j, k) belongs to the point `origin + i·spacing` —
 * and the D2Q9 lattice's nodes ARE those grid nodes, one-to-one. The
 * mapping this module owns and documents is therefore the DIRECT node
 * interpretation:
 *
 * - grid extent [nx, ny, 1] → lattice (nx, ny) (a 2D slice; the third
 *   axis must be a singleton — a 3D grid is Phase 66's D3Q19 door, and
 *   it declines loudly here rather than being silently squashed);
 * - a node is a full-way bounce-back solid exactly when its occupancy
 *   value is 1 (inside-or-on the closed solid — the voxelizer's
 *   classification, honored as-is; on-surface nodes are solid, the
 *   staircase honesty of law S3);
 * - the mask aliases the grid's value order unchanged (x-fastest,
 *   `x + y·nx`) so the layout contract (`./d2q9`) holds for the mask
 *   too.
 *
 * This is the documented consumer mapping `sim-core`'s grid module
 * defers to ("the cell interpretation a solver derives from the node
 * mask is the consumer's documented mapping, never a second grid
 * geometry") — no resampling, no second geometry, one copy so the
 * stepper owns its mask immutably.
 */

import {
  type SimError,
  SIM_ERROR_CODES,
  type SimOccupancyGrid,
  type SimParseResult,
  simError,
  simFail,
  simOk,
} from "@slopcad/sim-core";
// NOTE: no blank line here by force of eslint's import/order — `import
// type` statements classify into the same rank-0 group as external
// imports regardless of path (the forces.ts precedent), and
// `newlines-between: always` forbids a line within a group.
import type { LbmSolidMask } from "./state";

/**
 * Builds the lattice solid mask from a Phase 62a occupancy grid: the
 * direct node interpretation above. A grid whose third extent is not 1,
 * whose values are not binary, or whose value count disagrees with its
 * extent declines structured (`sim/grid-field-malformed`) — the same
 * discipline the grid↔block bridge applies.
 */
export function lbmSolidMaskFromGrid(
  grid: SimOccupancyGrid,
): SimParseResult<LbmSolidMask, SimError> {
  if (grid.shape[2] !== 1) {
    return simFail(
      simError(
        SIM_ERROR_CODES.gridFieldMalformed,
        `The D2Q9 reference kernel consumes a 2D occupancy slice (extent [nx, ny, 1]); the grid's extent is [${grid.shape.join(", ")}], and 3D flow is the Phase 66 D3Q19 door, never a silent squash.`,
        grid.shape,
      ),
    );
  }
  const nx = grid.shape[0] ?? 1;
  const ny = grid.shape[1] ?? 1;
  if (grid.cells.length !== nx * ny) {
    return simFail(
      simError(
        SIM_ERROR_CODES.gridFieldMalformed,
        `An occupancy grid's value count (${String(grid.cells.length)}) must equal its extent product (${String(nx * ny)}).`,
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
  return simOk({ nx, ny, solid: Uint8Array.from(grid.cells) });
}

/**
 * Builds a mask directly from a lattice-shaped byte array — the
 * module-level door the unit fixtures and the Phase 64 harness use to
 * seed analytic occupancy (box slabs, circle/sphere slices) without
 * going through a grid record.
 */
export function lbmSolidMask(
  nx: number,
  ny: number,
  solid: Uint8Array,
): SimParseResult<LbmSolidMask, SimError> {
  if (
    !Number.isInteger(nx) ||
    !Number.isInteger(ny) ||
    nx < 3 ||
    ny < 3 ||
    solid.length !== nx * ny
  ) {
    return simFail(
      simError(
        SIM_ERROR_CODES.gridFieldMalformed,
        `A lattice mask needs integer extents of at least 3 (interior nodes must exist) and a value array of exactly nx·ny, received ${String(nx)}×${String(ny)} with ${String(solid.length)} values.`,
        { nx, ny, length: solid.length },
      ),
    );
  }
  for (const value of solid) {
    if (value !== 0 && value !== 1) {
      return simFail(
        simError(
          SIM_ERROR_CODES.gridFieldMalformed,
          `A lattice mask's values must each be exactly 0 or 1, received ${String(value)}.`,
          value,
        ),
      );
    }
  }
  return simOk({ nx, ny, solid: Uint8Array.from(solid) });
}
