/**
 * Shared field fixtures for the overlay-family tests (the
 * `render-fixtures.ts` precedent for the Phase 62b slice): tiny
 * deterministic `SimResultFieldBlock`s built from analytic functions, so
 * every overlay test asserts against fields with known closed-form
 * values (linear ramps, radial bowls, uniform and circular vector
 * fields) instead of hand-assembled value arrays — and the decode door
 * under test is always the real block shape `decodeSimResultPayload`
 * produces.
 */

import type { SimResultFieldBlock } from "@slopcad/sim-core";

/** A uniform lattice every fixture field shares. */
export interface FieldLattice {
  readonly shape: readonly [number, number, number];
  readonly originMm: readonly [number, number, number];
  readonly spacingMm: readonly [number, number, number];
}

/** The fixture lattices' document-space sample position at (i, j, k), mm. */
export function latticePosition(
  lattice: FieldLattice,
  i: number,
  j: number,
  k: number,
): readonly [number, number, number] {
  return [
    lattice.originMm[0] + i * lattice.spacingMm[0],
    lattice.originMm[1] + j * lattice.spacingMm[1],
    lattice.originMm[2] + k * lattice.spacingMm[2],
  ];
}

/** Builds one scalar block from an analytic value function. */
export function scalarFieldBlock(
  id: string,
  lattice: FieldLattice,
  valueAt: (x: number, y: number, z: number) => number,
  unit?: string,
): SimResultFieldBlock {
  const [nx, ny, nz] = lattice.shape;
  const values: number[] = [];
  for (let k = 0; k < nz; k += 1) {
    for (let j = 0; j < ny; j += 1) {
      for (let i = 0; i < nx; i += 1) {
        const [x, y, z] = latticePosition(lattice, i, j, k);
        values.push(valueAt(x, y, z));
      }
    }
  }
  return {
    id,
    ...(unit === undefined ? {} : { unit }),
    extent: lattice.shape,
    originMm: lattice.originMm,
    spacingMm: lattice.spacingMm,
    dataType: "float64",
    values,
  };
}

/** Builds the three component blocks of a vector field from a function. */
export function vectorFieldBlocks(
  id: string,
  lattice: FieldLattice,
  vectorAt: (
    x: number,
    y: number,
    z: number,
  ) => readonly [number, number, number],
  unit?: string,
): {
  readonly x: SimResultFieldBlock;
  readonly y: SimResultFieldBlock;
  readonly z: SimResultFieldBlock;
} {
  const [nx, ny, nz] = lattice.shape;
  const xs: number[] = [];
  const ys: number[] = [];
  const zs: number[] = [];
  for (let k = 0; k < nz; k += 1) {
    for (let j = 0; j < ny; j += 1) {
      for (let i = 0; i < nx; i += 1) {
        const [x, y, z] = latticePosition(lattice, i, j, k);
        const [vx, vy, vz] = vectorAt(x, y, z);
        xs.push(vx);
        ys.push(vy);
        zs.push(vz);
      }
    }
  }
  const blockOf = (
    suffix: string,
    values: readonly number[],
  ): SimResultFieldBlock => ({
    id: `${id}.${suffix}`,
    ...(unit === undefined ? {} : { unit }),
    extent: lattice.shape,
    originMm: lattice.originMm,
    spacingMm: lattice.spacingMm,
    dataType: "float64",
    values,
  });
  return {
    x: blockOf("x", xs),
    y: blockOf("y", ys),
    z: blockOf("z", zs),
  };
}

/**
 * A small cubic lattice: 5×5×3 nodes spanning [0, 4]×[0, 4]×[0, 2] at 1 mm
 * spacing — the scalar fixtures' default home.
 */
export const CUBE_LATTICE: FieldLattice = {
  shape: [5, 5, 3],
  originMm: [0, 0, 0],
  spacingMm: [1, 1, 1],
};

/**
 * A centered planar lattice: 21×21×1 nodes spanning [−10, 10]² at 1 mm
 * spacing, z = 0 — the vector-field fixtures' home (uniform and circular
 * fields live in this plane).
 */
export const PLANE_LATTICE: FieldLattice = {
  shape: [21, 21, 1],
  originMm: [-10, -10, 0],
  spacingMm: [1, 1, 1],
};
