/**
 * The voxel grid data model (ROADMAP-SIM Phase 62a, law S3's data half):
 * a NAMED uniform sample lattice whose values carry one of two field
 * semantics — occupancy (a 0/1 mask of closed-solid membership) or
 * signed-distance (metres, negative inside) — riding the Phase 61
 * SimResult binary payload blocks UNCHANGED. A grid IS a field block:
 * the same extent triples, the same origin/spacing geometry, the same
 * x-fastest value order, so a grid persists through the existing S4
 * projection and the SMR1 codec (`simGridToFieldBlock` →
 * `encodeSimResultPayload`), and a stored payload decodes back into a
 * typed grid through the existing decoder path
 * (`decodeSimResultPayload` → `simGridFromFieldBlock`) — the door the
 * Phase 62b overlays consume, with no second payload format and no
 * second decoding path.
 *
 * Samples are NODE-CENTERED: the value at extent index (i, j, k)
 * belongs to the point `origin + i·spacing` per axis — VTK ImageData's
 * point-sample convention, which the `.vti` exporter writes — not to a
 * cell centre. Occupancy semantics: a sample is 1 exactly when the
 * sample point lies inside or on the closed solid the grid discretizes
 * (the voxelizer's classification, `./voxelizer`). The cell
 * interpretation a solver derives from the node mask (an LBM's solid
 * cells, Phase 63) is the consumer's documented mapping, never a second
 * grid geometry.
 *
 * Units (law S4): the grid is SOLVER-SPACE — geometry in metres. The
 * conversions of this module ride the boundary's existing doors:
 * `simGridToFieldBlock` goes through `projectSimResult` (solver →
 * document, the one projection site), and `simGridFromFieldBlock` is
 * its inverse at the document → solver door; both use the single
 * length constant `MM_PER_M`, and nothing else in this module converts.
 */

import type { SimResultFieldBlock } from "./sim-result";

import { type SimError, SIM_ERROR_CODES, simError } from "./errors";
import { type SimParseResult, simFail, simOk } from "./result";
import { type SolverSimField, MM_PER_M, projectSimResult } from "./units";

/** The field semantics a voxel grid's values may carry. */
export const SIM_GRID_FIELD_SEMANTICS = [
  "occupancy",
  "signed-distance",
] as const;

export type SimGridFieldSemantic = (typeof SIM_GRID_FIELD_SEMANTICS)[number];

/** The document-space unit label each semantic's block values carry. */
const SEMANTIC_UNITS: Readonly<Record<SimGridFieldSemantic, string>> =
  Object.freeze({ occupancy: "1", "signed-distance": "mm" });

/**
 * The longest grid name the 64-character block id budget admits: the id
 * is `<name>.<semantic>`, and "signed-distance" is the longest suffix.
 */
export const SIM_GRID_NAME_MAX_LENGTH = 64 - ".signed-distance".length;

const GRID_NAME_PATTERN = /^[A-Za-z0-9._-]{1,48}$/;

/**
 * The sanity budget on a grid's total sample count — the ceiling every
 * grid-producing door (voxelizer, block bridge) enforces before
 * allocating. 2^24 samples: a 256³ occupancy grid, far past the Phase 63
 * reference resolutions and far under any honest memory claim.
 */
export const SIM_GRID_MAX_SAMPLES = 2 ** 24;

/** The uniform lattice geometry every voxel grid shares (SI, law S4). */
export interface SimGridGeometry {
  /** Sample counts per axis (the block extent); each ≥ 1, product ≤ budget. */
  readonly shape: readonly [number, number, number];
  /** The first sample's position per axis, m. */
  readonly originM: readonly [number, number, number];
  /** The per-axis sample stride, m (uniform per axis, strictly positive). */
  readonly spacingM: readonly [number, number, number];
}

/** An occupancy grid: closed-solid membership per node (1 inside/on, 0 outside). */
export interface SimOccupancyGrid extends SimGridGeometry {
  readonly semantic: "occupancy";
  /** The grid's name — the field id's prefix, the block id budget's charset. */
  readonly name: string;
  /** Exactly `shape` product values, x-fastest, each 0 or 1. */
  readonly cells: Uint8Array;
}

/** A signed-distance grid: metres, negative inside, on the closed surface 0. */
export interface SimDistanceGrid extends SimGridGeometry {
  readonly semantic: "signed-distance";
  readonly name: string;
  /** Exactly `shape` product values, x-fastest, each finite, in metres. */
  readonly distanceM: Float64Array;
}

export type SimVoxelGrid = SimOccupancyGrid | SimDistanceGrid;

/** The total sample count of a grid's lattice (its extent product). */
export function simGridSampleCount(grid: SimGridGeometry): number {
  return grid.shape[0] * grid.shape[1] * grid.shape[2];
}

/**
 * The sample position at extent index (i, j, k), metres — `origin +
 * i·spacing` per axis, the documented node-centered lattice. The indices
 * must lie within the grid's extent; the arithmetic is pure, so an
 * out-of-extent index extrapolates deterministically (caller error, no
 * validation tax on hot loops).
 */
export function simGridSamplePositionM(
  grid: SimGridGeometry,
  i: number,
  j: number,
  k: number,
): readonly [number, number, number] {
  return [
    grid.originM[0] + i * grid.spacingM[0],
    grid.originM[1] + j * grid.spacingM[1],
    grid.originM[2] + k * grid.spacingM[2],
  ];
}

// ---------------------------------------------------------------------------
// The field id vocabulary — "<name>.<semantic>"
// ---------------------------------------------------------------------------

/** The field id a grid's block carries: the name plus the semantic suffix. */
export function simGridFieldId(
  name: string,
  semantic: SimGridFieldSemantic,
): string {
  return `${name}.${semantic}`;
}

/** Parses a field id back into its grid name and semantic. */
export function parseSimGridFieldId(
  id: string,
): SimParseResult<
  { readonly name: string; readonly semantic: SimGridFieldSemantic },
  SimError
> {
  for (const semantic of SIM_GRID_FIELD_SEMANTICS) {
    const suffix = `.${semantic}`;
    if (!id.endsWith(suffix)) continue;
    const name = id.slice(0, id.length - suffix.length);
    if (GRID_NAME_PATTERN.test(name)) {
      return simOk({ name, semantic });
    }
  }
  return simFail(
    simError(
      SIM_ERROR_CODES.gridFieldMalformed,
      `A grid field id must be "<grid-name>.<semantic>" with the semantic one of ${SIM_GRID_FIELD_SEMANTICS.join(", ")} and the name matching [A-Za-z0-9._-], received "${id}".`,
      id,
    ),
  );
}

// ---------------------------------------------------------------------------
// Shared validation doors
// ---------------------------------------------------------------------------

/** Whether a grid name fits the binary id budget's charset and length. */
export function simGridNameProblem(name: string): SimError | undefined {
  if (!GRID_NAME_PATTERN.test(name)) {
    return simError(
      SIM_ERROR_CODES.gridFieldMalformed,
      `A grid name must match [A-Za-z0-9._-] and be 1-${String(SIM_GRID_NAME_MAX_LENGTH)} characters, received "${name}".`,
      name,
    );
  }
  return undefined;
}

/** The shared lattice-geometry door: extent, budget, origin, and spacing. */
export function simGridGeometryProblem(
  grid: SimGridGeometry,
): SimError | undefined {
  const [nx, ny, nz] = grid.shape;
  for (const count of grid.shape) {
    if (!Number.isInteger(count) || count < 1) {
      return simError(
        SIM_ERROR_CODES.gridFieldMalformed,
        "A grid's shape must be three integers of at least 1.",
        grid.shape,
      );
    }
  }
  const total = (nx ?? 1) * (ny ?? 1) * (nz ?? 1);
  if (total > SIM_GRID_MAX_SAMPLES) {
    return simError(
      SIM_ERROR_CODES.gridFieldMalformed,
      `A grid's sample count (${String(total)}) exceeds the sanity budget of ${String(SIM_GRID_MAX_SAMPLES)}.`,
      grid.shape,
    );
  }
  for (const triple of [grid.originM, grid.spacingM] as const) {
    if (
      triple.some(
        (entry) => typeof entry !== "number" || !Number.isFinite(entry),
      )
    ) {
      return simError(
        SIM_ERROR_CODES.gridFieldMalformed,
        "A grid's origin and spacing must be finite triples.",
        triple,
      );
    }
  }
  if (grid.spacingM.some((entry) => entry <= 0)) {
    return simError(
      SIM_ERROR_CODES.gridFieldMalformed,
      "A grid's spacing must be strictly positive on every axis.",
      grid.spacingM,
    );
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Grid → block (through the existing S4 projection), block → grid
// ---------------------------------------------------------------------------

/**
 * A grid as a SOLVER-space field — the shape the existing S4 projection
 * (`projectSimResult`) consumes: occupancy declares `dimensionless`
 * (factor 1, label "1"), signed-distance declares `length` (values
 * m → mm, label "mm"), and the geometry stays the grid's own SI triples.
 */
export function simGridSolverField(
  grid: SimVoxelGrid,
): SimParseResult<SolverSimField, SimError> {
  const nameProblem = simGridNameProblem(grid.name);
  if (nameProblem !== undefined) return simFail(nameProblem);
  const geometryProblem = simGridGeometryProblem(grid);
  if (geometryProblem !== undefined) return simFail(geometryProblem);
  if (grid.semantic === "occupancy") {
    if (simGridSampleCount(grid) !== grid.cells.length) {
      return simFail(
        simError(
          SIM_ERROR_CODES.gridFieldMalformed,
          "An occupancy grid's cell count must equal its extent product.",
          grid,
        ),
      );
    }
    for (const cell of grid.cells) {
      if (cell !== 0 && cell !== 1) {
        return simFail(
          simError(
            SIM_ERROR_CODES.gridFieldMalformed,
            "An occupancy grid's cells must each be 0 or 1.",
            cell,
          ),
        );
      }
    }
    return simOk({
      id: simGridFieldId(grid.name, "occupancy"),
      unit: SEMANTIC_UNITS.occupancy,
      extent: grid.shape,
      originM: grid.originM,
      spacingM: grid.spacingM,
      dataType: "float32",
      values: Array.from(grid.cells),
      dimension: "dimensionless",
    });
  }
  if (simGridSampleCount(grid) !== grid.distanceM.length) {
    return simFail(
      simError(
        SIM_ERROR_CODES.gridFieldMalformed,
        "A distance grid's value count must equal its extent product.",
        grid,
      ),
    );
  }
  for (const value of grid.distanceM) {
    if (!Number.isFinite(value)) {
      return simFail(
        simError(
          SIM_ERROR_CODES.gridFieldMalformed,
          "A distance grid's values must be finite metres.",
          value,
        ),
      );
    }
  }
  return simOk({
    id: simGridFieldId(grid.name, "signed-distance"),
    unit: SEMANTIC_UNITS["signed-distance"],
    extent: grid.shape,
    originM: grid.originM,
    spacingM: grid.spacingM,
    dataType: "float64",
    values: Array.from(grid.distanceM),
    dimension: "length",
  });
}

/**
 * A grid as a DOCUMENT-space field block — through the existing
 * `projectSimResult` door (the S4 solver → document site), never a
 * second conversion path: geometry m → mm, signed-distance values
 * m → mm, occupancy dimensionless. The returned block feeds
 * `encodeSimResultPayload` verbatim.
 */
export function simGridToFieldBlock(
  grid: SimVoxelGrid,
): SimParseResult<SimResultFieldBlock, SimError> {
  const field = simGridSolverField(grid);
  if (!field.ok) return field;
  const projected = projectSimResult({ scalars: [], fields: [field.value] });
  if (!projected.ok) return projected;
  const block = projected.value.fields[0];
  if (block === undefined) {
    return simFail(
      simError(
        SIM_ERROR_CODES.gridFieldMalformed,
        "The S4 projection returned no field for a one-field grid.",
        grid,
      ),
    );
  }
  return simOk(block);
}

/**
 * A document-space field block back into a typed grid — the Phase 62b
 * door: whatever `decodeSimResultPayload` returned decodes further into
 * occupancy or signed-distance semantics when (and only when) the id
 * carries the grid vocabulary, the unit agrees with the semantics, the
 * values are honest for them (binary occupancy, finite distances), and
 * the geometry survives the document → solver conversion. The values
 * and geometry convert mm → m through the one constant. What survives
 * that ride exactly: the 0/1 of an occupancy mask, and the bits of a
 * float64 distance grid through the SMR1 codec itself. The mm ↔ m
 * leg (× `MM_PER_M` out, ÷ back in) is exact only for dyadic values —
 * any other double lands within 1 ulp of itself, geometry (origin,
 * spacing) and distances alike.
 */
export function simGridFromFieldBlock(
  block: SimResultFieldBlock,
): SimParseResult<SimVoxelGrid, SimError> {
  const refuse = (
    message: string,
    at: unknown,
  ): SimParseResult<never, SimError> =>
    simFail(simError(SIM_ERROR_CODES.gridFieldMalformed, message, at));
  const identity = parseSimGridFieldId(block.id);
  if (!identity.ok) return identity;
  const { name, semantic } = identity.value;
  if (block.unit !== SEMANTIC_UNITS[semantic]) {
    return refuse(
      `A ${semantic} grid field block's unit must be "${SEMANTIC_UNITS[semantic]}", received "${String(block.unit)}".`,
      block.unit,
    );
  }
  const expected =
    (block.extent[0] ?? 1) * (block.extent[1] ?? 1) * (block.extent[2] ?? 1);
  if (
    !block.extent.every((count) => Number.isInteger(count) && count >= 1) ||
    block.values.length !== expected
  ) {
    return refuse(
      "A grid field block's extent must be three positive integers matching its value count.",
      block.extent,
    );
  }
  if (expected > SIM_GRID_MAX_SAMPLES) {
    return refuse(
      `A grid field block's sample count (${String(expected)}) exceeds the sanity budget of ${String(SIM_GRID_MAX_SAMPLES)}.`,
      block.extent,
    );
  }
  for (const triple of [block.originMm, block.spacingMm] as const) {
    if (triple.some((entry) => !Number.isFinite(entry))) {
      return refuse(
        "A grid field block's origin and spacing must be finite triples.",
        triple,
      );
    }
  }
  if (block.spacingMm.some((entry) => entry <= 0)) {
    return refuse(
      "A grid field block's spacing must be strictly positive on every axis.",
      block.spacingMm,
    );
  }
  const originM: readonly [number, number, number] = [
    block.originMm[0] / MM_PER_M,
    block.originMm[1] / MM_PER_M,
    block.originMm[2] / MM_PER_M,
  ];
  const spacingM: readonly [number, number, number] = [
    block.spacingMm[0] / MM_PER_M,
    block.spacingMm[1] / MM_PER_M,
    block.spacingMm[2] / MM_PER_M,
  ];
  if (semantic === "occupancy") {
    const cells = new Uint8Array(expected);
    for (const [index, value] of block.values.entries()) {
      if (value !== 0 && value !== 1) {
        return refuse(
          "An occupancy grid field block's values must each be exactly 0 or 1.",
          value,
        );
      }
      cells[index] = value;
    }
    return simOk(
      Object.freeze({
        semantic,
        name,
        shape: block.extent,
        originM,
        spacingM,
        cells,
      }),
    );
  }
  const distanceM = new Float64Array(expected);
  for (const [index, value] of block.values.entries()) {
    if (!Number.isFinite(value)) {
      return refuse(
        "A signed-distance grid field block's values must be finite millimetres.",
        value,
      );
    }
    distanceM[index] = value / MM_PER_M;
  }
  return simOk(
    Object.freeze({
      semantic,
      name,
      shape: block.extent,
      originM,
      spacingM,
      distanceM,
    }),
  );
}
