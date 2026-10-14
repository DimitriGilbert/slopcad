/**
 * Decoded field grids (ROADMAP-SIM Phase 62b): the render-side form of a
 * simulation field — a `SimResultFieldBlock` (what
 * `decodeSimResultPayload` returns) re-validated and wrapped as a
 * document-space sampling lattice. This is the ONE consumption door of
 * the overlay family, and it is deliberately the S4-compliant one: the
 * block arrives already PROJECTED (solver SI → document mm through
 * `projectSimResult`, with its explicit unit label riding along), so the
 * renderer never converts units — geometry is read in millimetres, values
 * are read in the unit the block declares, and both are surfaced here as
 * data (`originMm`/`spacingMm`, `unit`).
 *
 * ## Node-centered lattice (the sim-core convention)
 *
 * Samples are NODE-CENTERED, exactly as `@slopcad/sim-core`'s voxel grids
 * and VTK ImageData define them: the value at extent index (i, j, k)
 * belongs to the point `origin + i·spacing` per axis, in x-fastest value
 * order. {@link sampleFieldGrid} is the trilinear read of that lattice;
 * positions outside the lattice clamp to its boundary (a documented
 * extrapolation-free choice), and {@link fieldGridContainsPoint} is the
 * exact bounds test integrators terminate on.
 *
 * ## Validation
 *
 * The block was validated when encoded, but the renderer re-checks what
 * it consumes (the wire-trust discipline every boundary in this repo
 * applies): positive integer extents matching the value count, finite
 * values and geometry, strictly positive spacing. A violation throws a
 * `TypeError`/`RangeError` with the offending fact — a malformed field
 * is surfaced loudly, never painted as zeros.
 */

import type { SimResultFieldBlock } from "@slopcad/sim-core";

/** A scalar field decoded for rendering: the lattice, its values, its unit. */
export interface DecodedFieldGrid {
  /** Sample counts per axis (the block extent), x-fastest value order. */
  readonly shape: readonly [number, number, number];
  /** The first sample's position per axis, document millimetres. */
  readonly originMm: readonly [number, number, number];
  /** The per-axis sample stride, document millimetres. */
  readonly spacingMm: readonly [number, number, number];
  /** Exactly the extent product of values, x-fastest. */
  readonly values: Float64Array;
  /** The values' explicit unit label (S4): the block's, or `"1"` if none. */
  readonly unit: string;
  /** The values' finite [min, max] — the default color window. */
  readonly range: readonly [number, number];
}

/**
 * A vector field decoded for rendering: three component blocks sharing
 * one lattice (the x, y, and z components of one vector quantity — the
 * host names the blocks; this door checks they agree).
 */
export interface DecodedVectorField {
  readonly shape: readonly [number, number, number];
  readonly originMm: readonly [number, number, number];
  readonly spacingMm: readonly [number, number, number];
  /** The x components, x-fastest, the shared lattice's value order. */
  readonly x: Float64Array;
  /** The y components. */
  readonly y: Float64Array;
  /** The z components. */
  readonly z: Float64Array;
  /** The components' shared explicit unit label (e.g. `"mm/s"`). */
  readonly unit: string;
  /** The largest vector magnitude over all samples (the glyph/streamline scale). */
  readonly maxMagnitude: number;
}

/** The three component blocks of one vector quantity. */
export interface FieldVectorComponents {
  readonly x: SimResultFieldBlock;
  readonly y: SimResultFieldBlock;
  readonly z: SimResultFieldBlock;
}

/**
 * The flat x-fastest index of extent index (i, j, k) — the one indexing
 * rule of this module (the block's own value order).
 */
function flatIndex(
  shape: readonly [number, number, number],
  i: number,
  j: number,
  k: number,
): number {
  return i + shape[0] * (j + shape[1] * k);
}

/** Validates a block's lattice and copies its values into a Float64Array. */
function decodeLattice(block: SimResultFieldBlock): {
  shape: readonly [number, number, number];
  originMm: readonly [number, number, number];
  spacingMm: readonly [number, number, number];
  values: Float64Array;
} {
  const [nx, ny, nz] = block.extent;
  for (const count of block.extent) {
    if (!Number.isInteger(count) || (count ?? 0) < 1) {
      throw new RangeError(
        `The field block "${block.id}"'s extent must be three positive integers.`,
      );
    }
  }
  const total = (nx ?? 1) * (ny ?? 1) * (nz ?? 1);
  if (block.values.length !== total) {
    throw new RangeError(
      `The field block "${block.id}"'s value count (${String(block.values.length)}) must equal its extent product (${String(total)}).`,
    );
  }
  for (const triple of [block.originMm, block.spacingMm] as const) {
    if (triple.some((entry) => !Number.isFinite(entry))) {
      throw new RangeError(
        `The field block "${block.id}"'s origin and spacing must be finite triples.`,
      );
    }
  }
  if (block.spacingMm.some((entry) => entry <= 0)) {
    throw new RangeError(
      `The field block "${block.id}"'s spacing must be strictly positive on every axis.`,
    );
  }
  const values = new Float64Array(total);
  for (const [index, value] of block.values.entries()) {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new RangeError(
        `The field block "${block.id}"'s values must each be finite numbers.`,
      );
    }
    values[index] = value;
  }
  return {
    shape: block.extent,
    originMm: block.originMm,
    spacingMm: block.spacingMm,
    values,
  };
}

/** Decodes a scalar block into the render-side sampling lattice. */
export function decodedFieldGrid(block: SimResultFieldBlock): DecodedFieldGrid {
  const lattice = decodeLattice(block);
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const value of lattice.values) {
    if (value < min) min = value;
    if (value > max) max = value;
  }
  return Object.freeze({
    shape: lattice.shape,
    originMm: lattice.originMm,
    spacingMm: lattice.spacingMm,
    values: lattice.values,
    unit: block.unit ?? "1",
    range: Object.freeze([min, max] as const),
  });
}

/**
 * Decodes three component blocks into one vector field. The components
 * must share their lattice EXACTLY (extent, origin, spacing — they came
 * from the same grid) and carry the same unit label; anything else is a
 * host wiring error and throws.
 */
export function decodedVectorField(
  components: FieldVectorComponents,
): DecodedVectorField {
  const { x, y, z } = components;
  const xLattice = decodeLattice(x);
  const yLattice = decodeLattice(y);
  const zLattice = decodeLattice(z);
  const lattices = [
    { axis: "x", block: x, lattice: xLattice },
    { axis: "y", block: y, lattice: yLattice },
    { axis: "z", block: z, lattice: zLattice },
  ];
  for (const { axis, block, lattice } of lattices.slice(1)) {
    if (
      lattice.shape.some((count, index) => count !== xLattice.shape[index]) ||
      lattice.originMm.some(
        (entry, index) => entry !== xLattice.originMm[index],
      ) ||
      lattice.spacingMm.some(
        (entry, index) => entry !== xLattice.spacingMm[index],
      )
    ) {
      throw new RangeError(
        `A vector field's components must share one lattice exactly; the "${axis}" block "${block.id}" disagrees with the x block "${x.id}".`,
      );
    }
  }
  const unit = x.unit ?? "1";
  if ((y.unit ?? "1") !== unit || (z.unit ?? "1") !== unit) {
    throw new RangeError(
      `A vector field's components must carry one unit label; the blocks "${x.id}", "${y.id}", "${z.id}" do not agree.`,
    );
  }
  let maxMagnitude = 0;
  const total = xLattice.values.length;
  for (let index = 0; index < total; index += 1) {
    const vx = xLattice.values[index] ?? 0;
    const vy = yLattice.values[index] ?? 0;
    const vz = zLattice.values[index] ?? 0;
    const magnitude = Math.sqrt(vx * vx + vy * vy + vz * vz);
    if (magnitude > maxMagnitude) maxMagnitude = magnitude;
  }
  return Object.freeze({
    shape: xLattice.shape,
    originMm: xLattice.originMm,
    spacingMm: xLattice.spacingMm,
    x: xLattice.values,
    y: yLattice.values,
    z: zLattice.values,
    unit,
    maxMagnitude,
  });
}

/**
 * The sample position at extent index (i, j, k), document millimetres —
 * `origin + i·spacing` per axis (the node-centered lattice).
 */
export function fieldGridSamplePositionMm(
  grid:
    | Pick<DecodedFieldGrid, "originMm" | "spacingMm">
    | Pick<DecodedVectorField, "originMm" | "spacingMm">,
  i: number,
  j: number,
  k: number,
): readonly [number, number, number] {
  return [
    grid.originMm[0] + i * grid.spacingMm[0],
    grid.originMm[1] + j * grid.spacingMm[1],
    grid.originMm[2] + k * grid.spacingMm[2],
  ];
}

/**
 * Whether a document-space point lies inside the lattice's closed node
 * bounds (`origin` to `origin + (n−1)·spacing` per axis) — the exact
 * termination test the streamline integrator applies.
 */
export function fieldGridContainsPoint(
  grid: Pick<DecodedFieldGrid, "shape" | "originMm" | "spacingMm">,
  xMm: number,
  yMm: number,
  zMm: number,
): boolean {
  const position = [xMm, yMm, zMm] as const;
  for (let axis = 0; axis < 3; axis += 1) {
    const origin = grid.originMm[axis] ?? 0;
    const spacing = grid.spacingMm[axis] ?? 1;
    const count = grid.shape[axis] ?? 1;
    const coordinate = position[axis] ?? 0;
    const low = origin;
    const high = origin + (count - 1) * spacing;
    if (coordinate < low || coordinate > high) return false;
  }
  return true;
}

/** One axis's clamped lattice bracket: the two neighbor indices and the weight. */
function axisBracket(
  origin: number,
  spacing: number,
  count: number,
  position: number,
): { i0: number; i1: number; weight: number } {
  const continuous = (position - origin) / spacing;
  const floored = Math.floor(continuous);
  const i0 = Math.min(Math.max(floored, 0), count - 1);
  const i1 = Math.min(Math.max(floored + 1, 0), count - 1);
  const raw = continuous - floored;
  const weight = Math.min(Math.max(raw, 0), 1);
  return { i0, i1, weight };
}

/**
 * Trilinear sample of a scalar grid at a document-space point — the
 * node-centered lattice's defining read. Positions outside the lattice
 * clamp to its boundary samples (documented: extrapolation-free), so the
 * value is total; callers that need exact bounds pair this with
 * {@link fieldGridContainsPoint}.
 */
export function sampleFieldGrid(
  grid: DecodedFieldGrid,
  xMm: number,
  yMm: number,
  zMm: number,
): number {
  const [nx, ny, nz] = grid.shape;
  const bx = axisBracket(
    grid.originMm[0] ?? 0,
    grid.spacingMm[0] ?? 1,
    nx ?? 1,
    xMm,
  );
  const by = axisBracket(
    grid.originMm[1] ?? 0,
    grid.spacingMm[1] ?? 1,
    ny ?? 1,
    yMm,
  );
  const bz = axisBracket(
    grid.originMm[2] ?? 0,
    grid.spacingMm[2] ?? 1,
    nz ?? 1,
    zMm,
  );
  const values = grid.values;
  const v000 = values[flatIndex(grid.shape, bx.i0, by.i0, bz.i0)] ?? 0;
  const v100 = values[flatIndex(grid.shape, bx.i1, by.i0, bz.i0)] ?? 0;
  const v010 = values[flatIndex(grid.shape, bx.i0, by.i1, bz.i0)] ?? 0;
  const v110 = values[flatIndex(grid.shape, bx.i1, by.i1, bz.i0)] ?? 0;
  const v001 = values[flatIndex(grid.shape, bx.i0, by.i0, bz.i1)] ?? 0;
  const v101 = values[flatIndex(grid.shape, bx.i1, by.i0, bz.i1)] ?? 0;
  const v011 = values[flatIndex(grid.shape, bx.i0, by.i1, bz.i1)] ?? 0;
  const v111 = values[flatIndex(grid.shape, bx.i1, by.i1, bz.i1)] ?? 0;
  const wx = bx.weight;
  const wy = by.weight;
  const wz = bz.weight;
  const bottom =
    v000 * (1 - wx) * (1 - wy) +
    v100 * wx * (1 - wy) +
    v010 * (1 - wx) * wy +
    v110 * wx * wy;
  const top =
    v001 * (1 - wx) * (1 - wy) +
    v101 * wx * (1 - wy) +
    v011 * (1 - wx) * wy +
    v111 * wx * wy;
  return bottom * (1 - wz) + top * wz;
}

/**
 * Trilinear sample of a vector field at a document-space point — the
 * component-wise counterpart of {@link sampleFieldGrid} (same clamped
 * bracket, same weights, one read per component).
 */
export function sampleVectorField(
  field: DecodedVectorField,
  xMm: number,
  yMm: number,
  zMm: number,
): readonly [number, number, number] {
  const [nx, ny, nz] = field.shape;
  const bx = axisBracket(
    field.originMm[0] ?? 0,
    field.spacingMm[0] ?? 1,
    nx ?? 1,
    xMm,
  );
  const by = axisBracket(
    field.originMm[1] ?? 0,
    field.spacingMm[1] ?? 1,
    ny ?? 1,
    yMm,
  );
  const bz = axisBracket(
    field.originMm[2] ?? 0,
    field.spacingMm[2] ?? 1,
    nz ?? 1,
    zMm,
  );
  const read = (component: Float64Array): number => {
    const v000 = component[flatIndex(field.shape, bx.i0, by.i0, bz.i0)] ?? 0;
    const v100 = component[flatIndex(field.shape, bx.i1, by.i0, bz.i0)] ?? 0;
    const v010 = component[flatIndex(field.shape, bx.i0, by.i1, bz.i0)] ?? 0;
    const v110 = component[flatIndex(field.shape, bx.i1, by.i1, bz.i0)] ?? 0;
    const v001 = component[flatIndex(field.shape, bx.i0, by.i0, bz.i1)] ?? 0;
    const v101 = component[flatIndex(field.shape, bx.i1, by.i0, bz.i1)] ?? 0;
    const v011 = component[flatIndex(field.shape, bx.i0, by.i1, bz.i1)] ?? 0;
    const v111 = component[flatIndex(field.shape, bx.i1, by.i1, bz.i1)] ?? 0;
    const wx = bx.weight;
    const wy = by.weight;
    const wz = bz.weight;
    const bottom =
      v000 * (1 - wx) * (1 - wy) +
      v100 * wx * (1 - wy) +
      v010 * (1 - wx) * wy +
      v110 * wx * wy;
    const top =
      v001 * (1 - wx) * (1 - wy) +
      v101 * wx * (1 - wy) +
      v011 * (1 - wx) * wy +
      v111 * wx * wy;
    return bottom * (1 - wz) + top * wz;
  };
  return [read(field.x), read(field.y), read(field.z)];
}

/**
 * The vector magnitude at a document-space point — the trilinear read of
 * the components followed by the norm (the documented order; magnitudes
 * are interpolated as vectors, not bilinearly on |v|).
 */
export function sampleVectorMagnitude(
  field: DecodedVectorField,
  xMm: number,
  yMm: number,
  zMm: number,
): number {
  const [vx, vy, vz] = sampleVectorField(field, xMm, yMm, zMm);
  return Math.sqrt(vx * vx + vy * vy + vz * vz);
}
