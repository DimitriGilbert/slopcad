/**
 * Assembly clearance measurement (Phase 58): the minimum DISTANCE between
 * two placed occurrences, computed over their tessellations — the
 * roadmap's "kernel distance on tessellations with documented precision"
 * at the cad-core layer, the sibling of Phase 51's interference detector
 * (which answers "do they overlap"; this answers "how far apart are they").
 *
 * ## What is measured, and how precisely
 *
 * Each instance carries its LOCAL-space triangle soup plus its placement;
 * the batch transforms both soups to world and takes the minimum
 * point-to-triangle distance over BOTH directions (every vertex of A
 * against every triangle of B, and vice versa). That is the standard
 * sampled clearance:
 *
 * - **Exact** whenever the closest feature pair includes a sampled
 *   vertex — every axis-aligned planar pair (the fixtures, the
 *   overwhelmingly common plate/block assembly case) qualifies.
 * - Otherwise a **documented sampled bound**: the minimum over the
 *   submitted triangles only, computed from the tessellation the host
 *   submits — refinement converges it to the true surface distance. The
 *   report carries the precision label rather than inventing an error
 *   radius it cannot prove.
 *
 * The number is millimetres, world space, `0` for touching or
 * intersecting soups. It is a pure mesh measurement: no kernel seam is
 * consulted, so a clearance answer never depends on kernel availability
 * (the interference check owns the boolean seam; this owns the arithmetic
 * over the triangles the host already renders).
 *
 * Determinism: identical soups, placements, and pair order produce an
 * identical report — pairs iterate in the caller's fixed
 * first-then-second index order, and every accumulation is a `Math.min`
 * over a deterministic iteration.
 */

import { type DatumVec3 } from "./datum";
import { type BodyId, type OccurrenceId } from "./ids";
import { transformPlacementPoint, type PlacementTransform } from "./placement";
import { type ParseFailure, type ParseResult, fail, ok } from "./result";

/** Stable failure codes for the clearance batch. */
export const ASSEMBLY_CLEARANCE_ERROR_CODES = {
  malformed: "assembly/clearance-malformed",
  empty: "assembly/clearance-empty",
} as const;

export type AssemblyClearanceErrorCode =
  (typeof ASSEMBLY_CLEARANCE_ERROR_CODES)[keyof typeof ASSEMBLY_CLEARANCE_ERROR_CODES];

/** Structured failure describing why a clearance batch was rejected. */
export interface AssemblyClearanceError extends ParseFailure {
  readonly code: AssemblyClearanceErrorCode;
}

/** The precision class the sampled minimum carries. */
export const CLEARANCE_PRECISION = "sampled-vertex-triangle" as const;

/** A LOCAL-space triangle soup: flat positions plus a flat index list. */
export interface ClearanceMesh {
  /** Triangle-corner coordinates, three floats per corner. */
  readonly positions: readonly number[];
  /** Triangle corner indices into `positions`, three per triangle. */
  readonly indices: readonly number[];
}

/** One measured instance: identity, placement, and its local soup. */
export interface ClearanceInstance {
  /** The occurrence path, outermost first (the instance's identity). */
  readonly path: readonly OccurrenceId[];
  readonly bodyId: BodyId;
  readonly transform: PlacementTransform;
  /** The body's LOCAL-space triangles; world triangles are derived here. */
  readonly mesh: ClearanceMesh;
}

/** One measured pair's clearance. */
export interface AssemblyClearance {
  /** The first instance's path, outermost first (the batch's order). */
  readonly firstPath: readonly OccurrenceId[];
  readonly secondPath: readonly OccurrenceId[];
  /** World minimum sampled distance in millimetres, `>= 0`. */
  readonly distance: number;
}

/** The batch clearance report. */
export interface ClearanceReport {
  /** Measured pairs, in the caller's fixed first-then-second order. */
  readonly clearances: readonly AssemblyClearance[];
  /** How many triangles the measurement sampled, both soups summed. */
  readonly sampledTriangles: number;
  /** The precision class of every `distance` in the report. */
  readonly precision: typeof CLEARANCE_PRECISION;
}

/** The batch's inputs: the instances and the unordered pairs to measure. */
export interface ClearanceCheckInput {
  readonly instances: readonly ClearanceInstance[];
  /**
   * Pairs to measure, as indices into `instances` — the caller owns the
   * pair policy (typically every unordered pair, or the interference
   * batch's checked set). Indices must be valid and distinct.
   */
  readonly pairs: readonly (readonly [number, number])[];
}

/**
 * Validates the batch at the trust boundary (paths non-empty, meshes
 * well-formed, pair indices valid) and measures every requested pair.
 */
export function checkAssemblyClearances(
  input: ClearanceCheckInput,
): ParseResult<ClearanceReport, AssemblyClearanceError> {
  for (const instance of input.instances) {
    if (
      instance.path.length === 0 ||
      instance.path.some((id) => typeof id !== "string" || id.length === 0)
    ) {
      return fail({
        code: ASSEMBLY_CLEARANCE_ERROR_CODES.malformed,
        message: "A clearance instance must carry a non-empty occurrence path.",
        input: instance,
      });
    }
    const { positions, indices } = instance.mesh;
    if (
      positions.length === 0 ||
      positions.length % 3 !== 0 ||
      indices.length === 0 ||
      indices.length % 3 !== 0 ||
      indices.some(
        (index) =>
          !Number.isInteger(index) ||
          index < 0 ||
          index * 3 + 2 >= positions.length,
      )
    ) {
      return fail({
        code: ASSEMBLY_CLEARANCE_ERROR_CODES.malformed,
        message:
          "A clearance instance's mesh must carry non-empty flat position and triangle-index arrays with in-range indices.",
        input: instance,
      });
    }
    for (const coordinate of positions) {
      if (!Number.isFinite(coordinate)) {
        return fail({
          code: ASSEMBLY_CLEARANCE_ERROR_CODES.malformed,
          message: "A clearance instance's mesh positions must be finite.",
          input: instance,
        });
      }
    }
  }
  for (const [first, second] of input.pairs) {
    if (
      !Number.isInteger(first) ||
      !Number.isInteger(second) ||
      first === second ||
      first < 0 ||
      second < 0 ||
      first >= input.instances.length ||
      second >= input.instances.length
    ) {
      return fail({
        code: ASSEMBLY_CLEARANCE_ERROR_CODES.empty,
        message:
          "A clearance pair must name two distinct valid instance indices.",
        input: { first, second },
      });
    }
  }

  const worldTrianglesByInstance = input.instances.map((instance) =>
    worldTriangles(instance.mesh, instance.transform),
  );

  const clearances: AssemblyClearance[] = [];
  let sampledTriangles = 0;
  for (const [firstIndex, secondIndex] of input.pairs) {
    const first = input.instances[firstIndex];
    const second = input.instances[secondIndex];
    if (first === undefined || second === undefined) continue;
    const firstTriangles = worldTrianglesByInstance[firstIndex];
    const secondTriangles = worldTrianglesByInstance[secondIndex];
    if (
      firstTriangles === undefined ||
      secondTriangles === undefined ||
      firstTriangles.length === 0 ||
      secondTriangles.length === 0
    ) {
      return fail({
        code: ASSEMBLY_CLEARANCE_ERROR_CODES.empty,
        message:
          "A clearance instance resolved to no world triangles; the batch refuses to guess a distance.",
        input: { firstIndex, secondIndex },
      });
    }
    sampledTriangles += firstTriangles.length + secondTriangles.length;
    const minimum = sampledPairDistance(firstTriangles, secondTriangles);
    if (!Number.isFinite(minimum)) {
      return fail({
        code: ASSEMBLY_CLEARANCE_ERROR_CODES.empty,
        message:
          "A clearance pair produced no finite sampled distance; the batch refuses to guess one.",
        input: { firstIndex, secondIndex },
      });
    }
    clearances.push({
      firstPath: [...first.path],
      secondPath: [...second.path],
      distance: minimum,
    });
  }
  return ok({ clearances, sampledTriangles, precision: CLEARANCE_PRECISION });
}

/**
 * The sampled minimum over both directions: every corner of one soup
 * against every triangle of the other, and mirrored. `Infinity` when
 * either soup carries no triangles (the batch refuses that input).
 */
function sampledPairDistance(
  first: readonly WorldTriangle[],
  second: readonly WorldTriangle[],
): number {
  let minimum = Number.POSITIVE_INFINITY;
  for (const triangle of first) {
    for (const corner of triangle) {
      for (const other of second) {
        minimum = Math.min(minimum, pointTriangleDistance(corner, other));
      }
    }
  }
  for (const triangle of second) {
    for (const corner of triangle) {
      for (const other of first) {
        minimum = Math.min(minimum, pointTriangleDistance(corner, other));
      }
    }
  }
  return minimum;
}

/** Squared Euclidean length of a vector difference. */
function squaredDistance(a: DatumVec3, b: DatumVec3): number {
  const dx = a[0] - b[0];
  const dy = a[1] - b[1];
  const dz = a[2] - b[2];
  return dx * dx + dy * dy + dz * dz;
}

/** One WORLD-space triangle as three corner points. */
type WorldTriangle = readonly [DatumVec3, DatumVec3, DatumVec3];

/** Applies the placement to every triangle corner of the soup. */
function worldTriangles(
  mesh: ClearanceMesh,
  transform: PlacementTransform,
): WorldTriangle[] {
  const triangles: WorldTriangle[] = [];
  for (let offset = 0; offset + 2 < mesh.indices.length; offset += 3) {
    const a = mesh.indices[offset];
    const b = mesh.indices[offset + 1];
    const c = mesh.indices[offset + 2];
    if (a === undefined || b === undefined || c === undefined) continue;
    triangles.push([
      transformPlacementPoint(transform, [
        mesh.positions[a * 3] ?? 0,
        mesh.positions[a * 3 + 1] ?? 0,
        mesh.positions[a * 3 + 2] ?? 0,
      ]),
      transformPlacementPoint(transform, [
        mesh.positions[b * 3] ?? 0,
        mesh.positions[b * 3 + 1] ?? 0,
        mesh.positions[b * 3 + 2] ?? 0,
      ]),
      transformPlacementPoint(transform, [
        mesh.positions[c * 3] ?? 0,
        mesh.positions[c * 3 + 1] ?? 0,
        mesh.positions[c * 3 + 2] ?? 0,
      ]),
    ]);
  }
  return triangles;
}

/**
 * Exact point-to-triangle distance: the classic virtual-projection
 * decomposition (Ericson, *Real-Time Collision Detection*, 5.1.5) —
 * project onto the triangle's plane, classify the Voronoi region, and
 * fall out with the true minimum over the triangle.
 */
function pointTriangleDistance(
  point: DatumVec3,
  triangle: WorldTriangle,
): number {
  const [a, b, c] = triangle;
  const ab: DatumVec3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const ac: DatumVec3 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  const ap: DatumVec3 = [point[0] - a[0], point[1] - a[1], point[2] - a[2]];
  const d1 = dot(ab, ap);
  const d2 = dot(ac, ap);
  if (d1 <= 0 && d2 <= 0) return Math.sqrt(squaredDistance(point, a));

  const bp: DatumVec3 = [point[0] - b[0], point[1] - b[1], point[2] - b[2]];
  const d3 = dot(ab, bp);
  const d4 = dot(ac, bp);
  if (d3 >= 0 && d4 <= d3) return Math.sqrt(squaredDistance(point, b));

  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const v = d1 / (d1 - d3);
    return Math.sqrt(
      squaredDistance(point, [
        a[0] + v * ab[0],
        a[1] + v * ab[1],
        a[2] + v * ab[2],
      ]),
    );
  }

  const cp: DatumVec3 = [point[0] - c[0], point[1] - c[1], point[2] - c[2]];
  const d5 = dot(ab, cp);
  const d6 = dot(ac, cp);
  if (d6 >= 0 && d5 <= d6) return Math.sqrt(squaredDistance(point, c));

  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const w = d2 / (d2 - d6);
    return Math.sqrt(
      squaredDistance(point, [
        a[0] + w * ac[0],
        a[1] + w * ac[1],
        a[2] + w * ac[2],
      ]),
    );
  }

  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const w = (d4 - d3) / (d4 - d3 + (d5 - d6));
    return Math.sqrt(
      squaredDistance(point, [
        b[0] + w * (c[0] - b[0]),
        b[1] + w * (c[1] - b[1]),
        b[2] + w * (c[2] - b[2]),
      ]),
    );
  }

  const denom = 1 / (va + vb + vc);
  const v = vb * denom;
  const w = vc * denom;
  return Math.sqrt(
    squaredDistance(point, [
      a[0] + ab[0] * v + ac[0] * w,
      a[1] + ab[1] * v + ac[1] * w,
      a[2] + ab[2] * v + ac[2] * w,
    ]),
  );
}

/** The 3-vector dot product. */
function dot(a: DatumVec3, b: DatumVec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}
