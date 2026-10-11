/**
 * The occupancy → conduction-cell mapping (Phase 65a, law S3's consumer
 * half — the sim-flow `./occupancy` precedent): the Phase 62a voxel
 * grid is NODE-CENTERED, and the finite-volume cell this solver owns is
 * the DIRECT node interpretation — one control volume of size
 * spacing × spacing × spacing CENTERED on each occupied node. The
 * documentation duty `sim-core`'s grid module names ("the cell
 * interpretation a solver derives from the node mask is the consumer's
 * documented mapping, never a second grid geometry") is discharged
 * here: no resampling, no second geometry, one immutable copy.
 *
 * Beyond the solid/fluid split, this module owns the two FLUID
 * classifications the boundary completeness of Phase 65 needs:
 *
 * - **Exterior** — every non-solid cell 6-connected to the domain box's
 *   boundary. Solid faces adjacent to exterior cells (or to the outside
 *   of the box) are the AMBIENT boundary: convection to the scenario's
 *   ambient air plus the §7.12 radiation loss, the equilibrium boundary
 *   that lets steady solves settle at real temperatures.
 * - **Cavity** — every 6-connected component of the remaining non-solid
 *   cells: a fully enclosed void. Its surrounding solid faces form one
 *   ENCLOSURE whose grey-diffuse surface-to-surface exchange
 *   (`./radiation`) is the coarse in-scope form of §7.12. A cavity in a
 *   radiation-off problem is an honest vacuum gap (no conduction
 *   crosses a fluid cell in this phase — fluid convection is 65b's
 *   coupling).
 *
 * The classifications are pure graph arithmetic over the mask — a
 * deterministic breadth-first flood in fixed index order, so the same
 * grid classifies bitwise-identically every time (law S2).
 */

// NOTE: no blank line between the type and value imports by force of
// eslint's import/order — `import type` statements classify into the
// same rank-0 group as external value imports (the sim-flow
// occupancy.ts precedent).
import {
  type SimError,
  type SimOccupancyGrid,
  SIM_ERROR_CODES,
  type SimParseResult,
  simError,
  simFail,
  simGridGeometryProblem,
  simOk,
} from "@slopcad/sim-core";

/** The six face directions of a cell, x-fastest pair order: −x, +x, −y, +y, −z, +z. */
export const THERMAL_FACE_DIRECTIONS = [
  { axis: 0, sign: -1 },
  { axis: 0, sign: 1 },
  { axis: 1, sign: -1 },
  { axis: 1, sign: 1 },
  { axis: 2, sign: -1 },
  { axis: 2, sign: 1 },
] as const;

/** The domain face a grid-boundary direction lands on (the condition key). */
export function thermalDomainFaceOfDirection(
  axis: number,
  sign: number,
): "xMin" | "xMax" | "yMin" | "yMax" | "zMin" | "zMax" {
  const names = ["x", "y", "z"] as const;
  const axisName = names[axis] ?? "x";
  return sign < 0 ? `${axisName}Min` : `${axisName}Max`;
}

/** The classified conduction grid: the mask plus the fluid topology. */
export interface ThermalCellGrid {
  readonly nx: number;
  readonly ny: number;
  readonly nz: number;
  readonly spacingM: readonly [number, number, number];
  /** The solid mask (a copy; 1 = a conduction cell). */
  readonly solid: Uint8Array;
  /** 1 for non-solid cells 6-connected to the domain boundary. */
  readonly exterior: Uint8Array;
  /** Enclosure id per cell (≥ 0 for cavity cells, −1 otherwise). */
  readonly cavityOf: Int32Array;
  /** The number of distinct enclosures found. */
  readonly enclosureCount: number;
  /** The uniform control-volume size of every cell, m³. */
  readonly cellVolumeM3: number;
}

/** The area of a face on the given axis (the product of the other spacings), m². */
export function thermalFaceAreaM2(grid: ThermalCellGrid, axis: number): number {
  const a = grid.spacingM[0] ?? 1;
  const b = grid.spacingM[1] ?? 1;
  const c = grid.spacingM[2] ?? 1;
  return axis === 0 ? b * c : axis === 1 ? a * c : a * b;
}

/**
 * Classifies a Phase 62a occupancy grid into the conduction topology:
 * solid cells verbatim, exterior fluid by flood from the box boundary,
 * and every enclosed non-solid 6-connected component as one enclosure.
 * Grid geometry problems (extent, budget, spacing) decline through the
 * grid module's own door; a non-binary or count-mismatched mask declines
 * with the same `sim/grid-field-malformed` discipline.
 */
export function thermalCellGrid(
  grid: SimOccupancyGrid,
): SimParseResult<ThermalCellGrid, SimError> {
  const geometryProblem = simGridGeometryProblem(grid);
  if (geometryProblem !== undefined) return simFail(geometryProblem);
  const nx = grid.shape[0] ?? 1;
  const ny = grid.shape[1] ?? 1;
  const nz = grid.shape[2] ?? 1;
  const cellCount = nx * ny * nz;
  if (grid.cells.length !== cellCount) {
    return simFail(
      simError(
        SIM_ERROR_CODES.gridFieldMalformed,
        `An occupancy grid's cell count (${String(grid.cells.length)}) must equal its extent product (${String(cellCount)}).`,
        grid.shape,
      ),
    );
  }
  const solid = Uint8Array.from(grid.cells);
  for (const value of solid) {
    if (value !== 0 && value !== 1) {
      return simFail(
        simError(
          SIM_ERROR_CODES.gridFieldMalformed,
          `An occupancy grid's cells must each be 0 or 1, received ${String(value)}.`,
          value,
        ),
      );
    }
  }
  const exterior = new Uint8Array(cellCount);
  const cavityOf = new Int32Array(cellCount).fill(-1);

  // The exterior flood: BFS from every non-solid cell on the box
  // boundary, fixed start order (row-major over the boundary planes).
  const queue = new Int32Array(cellCount);
  let queueHead = 0;
  let queueTail = 0;
  const pushIfFluid = (index: number): void => {
    if (solid[index] === 0 && exterior[index] === 0) {
      exterior[index] = 1;
      queue[queueTail] = index;
      queueTail += 1;
    }
  };
  for (let k = 0; k < nz; k += 1) {
    for (let j = 0; j < ny; j += 1) {
      for (let i = 0; i < nx; i += 1) {
        const onBoundary =
          i === 0 ||
          i === nx - 1 ||
          j === 0 ||
          j === ny - 1 ||
          k === 0 ||
          k === nz - 1;
        if (onBoundary) {
          pushIfFluid(i + j * nx + k * nx * ny);
        }
      }
    }
  }
  const neighboursOf = (index: number): number[] => {
    const i = index % nx;
    const j = Math.floor(index / nx) % ny;
    const k = Math.floor(index / (nx * ny));
    const out: number[] = [];
    if (i > 0) out.push(index - 1);
    if (i < nx - 1) out.push(index + 1);
    if (j > 0) out.push(index - nx);
    if (j < ny - 1) out.push(index + nx);
    if (k > 0) out.push(index - nx * ny);
    if (k < nz - 1) out.push(index + nx * ny);
    return out;
  };
  while (queueHead < queueTail) {
    const index = queue[queueHead] ?? 0;
    queueHead += 1;
    for (const neighbour of neighboursOf(index)) {
      pushIfFluid(neighbour);
    }
  }

  // The enclosures: every still-unvisited non-solid component, ids in
  // first-contact index order.
  let enclosureCount = 0;
  for (let seed = 0; seed < cellCount; seed += 1) {
    if (
      solid[seed] === 1 ||
      exterior[seed] === 1 ||
      (cavityOf[seed] ?? -1) >= 0
    ) {
      continue;
    }
    const id = enclosureCount;
    enclosureCount += 1;
    cavityOf[seed] = id;
    queueHead = 0;
    queueTail = 0;
    queue[queueTail] = seed;
    queueTail += 1;
    while (queueHead < queueTail) {
      const index = queue[queueHead] ?? 0;
      queueHead += 1;
      for (const neighbour of neighboursOf(index)) {
        if (
          solid[neighbour] === 0 &&
          exterior[neighbour] === 0 &&
          (cavityOf[neighbour] ?? -1) < 0
        ) {
          cavityOf[neighbour] = id;
          queue[queueTail] = neighbour;
          queueTail += 1;
        }
      }
    }
  }

  const a = grid.spacingM[0] ?? 1;
  const b = grid.spacingM[1] ?? 1;
  const c = grid.spacingM[2] ?? 1;
  return simOk(
    Object.freeze({
      nx,
      ny,
      nz,
      spacingM: grid.spacingM,
      solid,
      exterior,
      cavityOf,
      enclosureCount,
      cellVolumeM3: a * b * c,
    }),
  );
}

/** One exposed boundary face of a solid cell — the boundary-completeness unit. */
export interface ThermalExposedFace {
  /** The owning solid cell's flat index. */
  readonly cell: number;
  /** The face's direction index into {@link THERMAL_FACE_DIRECTIONS}. */
  readonly direction: number;
  readonly axis: number;
  readonly sign: number;
  /** The face area, m². */
  readonly areaM2: number;
  /**
   * The face's classification: "domain" faces sit on the box boundary
   * (addressable by a scenario face condition), "ambient" faces touch
   * exterior fluid, "enclosure" faces bound the given enclosure id.
   */
  readonly kind: "domain" | "ambient" | "enclosure";
  /** The enclosure id, when kind is "enclosure". */
  readonly enclosure: number;
}

/**
 * Enumerates every exposed face of the solid region in deterministic
 * row-major cell order (direction order fixed by
 * {@link THERMAL_FACE_DIRECTIONS}) — the one face list the boundary
 * resolution, the assembly, and the energy audit all walk.
 */
export function thermalExposedFaces(
  grid: ThermalCellGrid,
): readonly ThermalExposedFace[] {
  const faces: ThermalExposedFace[] = [];
  const { nx, ny, nz } = grid;
  for (let k = 0; k < nz; k += 1) {
    for (let j = 0; j < ny; j += 1) {
      for (let i = 0; i < nx; i += 1) {
        const cell = i + j * nx + k * nx * ny;
        if (grid.solid[cell] !== 1) continue;
        for (let direction = 0; direction < 6; direction += 1) {
          const { axis, sign } = THERMAL_FACE_DIRECTIONS[direction] ?? {
            axis: 0,
            sign: -1,
          };
          const coordinate = axis === 0 ? i : axis === 1 ? j : k;
          const extent = axis === 0 ? nx : axis === 1 ? ny : nz;
          const next = coordinate + sign;
          if (next < 0 || next >= extent) {
            faces.push({
              cell,
              direction,
              axis,
              sign,
              areaM2: thermalFaceAreaM2(grid, axis),
              kind: "domain",
              enclosure: -1,
            });
            continue;
          }
          const neighbour =
            cell + sign * (axis === 0 ? 1 : axis === 1 ? nx : nx * ny);
          if (grid.solid[neighbour] === 1) continue;
          const enclosure = grid.cavityOf[neighbour] ?? -1;
          faces.push({
            cell,
            direction,
            axis,
            sign,
            areaM2: thermalFaceAreaM2(grid, axis),
            kind: enclosure >= 0 ? "enclosure" : "ambient",
            enclosure,
          });
        }
      }
    }
  }
  return faces;
}
