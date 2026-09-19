/**
 * Reference-to-reference distance measurement (Phase 27.2): the domain core
 * behind the workbench's Distance row and the measurement surfaces that
 * follow it — the plan's "measure distance between supported references".
 *
 * ## The supported matrix (honest, per what the current surfaces resolve)
 *
 * A reference measures as a SAMPLED-GEOMETRY entity: a point (the measure
 * gesture's world picks), a vertex (an exact position — a persistent
 * reference's `pointAbsoluteMm` on a persistent-topology kernel), an edge
 * polyline, or a triangulated face/body surface. What resolves today:
 *
 * - `body` / `solid` / single-output `feature` references → the body's
 *   render-object tessellation (a `body` surface);
 * - transient synthetic `face` references (the Manifold-era pick) → the
 *   synthetic face's triangles (`groupSyntheticFaces`);
 * - persistent VERTEX references (OCCT topology snapshots) → the exact
 *   absolute point the snapshot measures;
 * - synthetic `edge`/`vertex` references and persistent edge/face snapshot
 *   entities → DECLINED, structured: no transient producer mints them
 *   (Phase 12 picking produces faces), and a persistent snapshot's
 *   descriptors are SUMMARY measures (length/area + centroid) — a centroid
 *   is not on a cylinder wall, so measuring to it would misreport the
 *   minimum. The decline names the missing capability instead of guessing.
 *
 * Geometric semantics per entity pair, in canonical millimetres:
 *
 * - point/vertex ↔ point/vertex — Euclidean;
 * - point/vertex ↔ edge/face/body — the exact minimum-distance PROJECTION
 *   onto the entity's sampled geometry (point-to-segment over the polyline,
 *   point-to-triangle over the surface);
 * - edge/face/body ↔ edge/face/body — the minimum over SAMPLED points: each
 *   side's defining points (polyline vertices, index-referenced surface
 *   vertices) projected exactly onto the other side, both directions
 *   combined. Exact when the true extremum is sampled — the fixture truths
 *   are — an upper bound of the true geometric minimum otherwise, and the
 *   readout says nothing more than the sampling carried.
 *
 * Every decline is structured ({@link DistanceError}): a selection that is
 * not exactly a pair (`distance/not-a-pair`), a reference the passed
 * surfaces cannot resolve (`distance/unresolvable-reference`), or geometry
 * that violates its buffer contract (`distance/geometry-invalid`). Nothing
 * computes silently over data it cannot honestly interpret.
 */

import type { FeatureRecord } from "./document";
import type { BodyId } from "./ids";
import type { TopologyEntitySnapshot } from "./persistent-reference";
import type { RenderObject, RenderVector3 } from "./projection";
import type { ParseFailure, ParseResult } from "./result";
import type { SelectionReference } from "./selection";

import { type LengthValue, length, valueIn } from "./dimensional";
import { fail, ok } from "./result";
import { groupSyntheticFaces } from "./synthetic-faces";

// ---------------------------------------------------------------------------
// Failures
// ---------------------------------------------------------------------------

/** Stable failure codes produced by the distance operations. */
export const DISTANCE_ERROR_CODES = {
  /** The selection does not hold exactly two references. */
  notAPair: "distance/not-a-pair",
  /** A reference names nothing the passed surfaces can resolve. */
  unresolvableReference: "distance/unresolvable-reference",
  /** Entity geometry violated its buffer contract. */
  geometryInvalid: "distance/geometry-invalid",
} as const;

export type DistanceErrorCode =
  (typeof DISTANCE_ERROR_CODES)[keyof typeof DISTANCE_ERROR_CODES];

/** Structured failure describing why a distance was declined. */
export interface DistanceError extends ParseFailure {
  readonly code: DistanceErrorCode;
}

function distanceError(
  code: DistanceErrorCode,
  message: string,
  input: unknown,
): DistanceError {
  return { code, message, input };
}

// ---------------------------------------------------------------------------
// Entities: the sampled geometry a reference measures as
// ---------------------------------------------------------------------------

/**
 * The sampled geometry one reference measures as, in canonical millimetres.
 * Point-like kinds carry one exact position; an edge carries its sampled
 * polyline; a face or body carries flat xyz positions plus a flat
 * triangle-vertex-index array into them — the projection contract's own
 * buffer shapes, so render-object data measures directly. Entities alias
 * the passed arrays (read-only); nothing copies or mutates them.
 */
export type MeasureEntity =
  | { readonly kind: "point"; readonly position: RenderVector3 }
  | { readonly kind: "vertex"; readonly position: RenderVector3 }
  | { readonly kind: "edge"; readonly polyline: readonly RenderVector3[] }
  | {
      readonly kind: "face";
      readonly positions: readonly number[];
      readonly indices: readonly number[];
    }
  | {
      readonly kind: "body";
      readonly positions: readonly number[];
      readonly indices: readonly number[];
    };

/** Constructs a point entity from a world point (canonical millimetres). */
export function pointEntity(position: RenderVector3): MeasureEntity {
  return Object.freeze({ kind: "point", position });
}

/** Constructs a vertex entity from its exact position (canonical millimetres). */
export function vertexEntity(position: RenderVector3): MeasureEntity {
  return Object.freeze({ kind: "vertex", position });
}

/** Constructs an edge entity from its sampled polyline, in order. */
export function edgeEntity(polyline: readonly RenderVector3[]): MeasureEntity {
  return Object.freeze({ kind: "edge", polyline: Object.freeze(polyline) });
}

/**
 * Constructs a face or body entity from flat buffers: `indices` is a flat
 * triangle-vertex-index array into `positions` — the render object's own
 * buffer shapes, so a face slice may share its object's positions array and
 * carry only its own triangles' indices.
 */
export function surfaceEntity(
  kind: "face" | "body",
  positions: readonly number[],
  indices: readonly number[],
): MeasureEntity {
  return Object.freeze({ kind, positions, indices });
}

/**
 * The render object's full tessellation as a body surface: the projection
 * contract already validated these buffers (flat, finite, in range), so the
 * surface aliases them unchanged.
 */
function surfaceOfRenderObject(object: RenderObject): MeasureEntity {
  return surfaceEntity("body", object.positions, object.indices);
}

/**
 * One synthetic face's triangles as a face surface: the face's triangle
 * indices sliced out of the grouping, positions shared with the object.
 * Fails structured for a face index outside the grouping — a reference and
 * its grouping disagreeing must decline, never map to face 0.
 */
export function measureSurfaceOfSyntheticFace(
  object: RenderObject,
  faceIndex: number,
): ParseResult<MeasureEntity, DistanceError> {
  const grouping = groupSyntheticFaces(object);
  const face = grouping.faces[faceIndex];
  if (face === undefined || face.index !== faceIndex) {
    return fail(
      distanceError(
        DISTANCE_ERROR_CODES.unresolvableReference,
        `Face index ${String(faceIndex)} is outside the grouping's 0..${String(grouping.faceCount - 1)} range.`,
        faceIndex,
      ),
    );
  }
  const indices: number[] = [];
  for (const triangle of face.triangleIndices) {
    for (let corner = 0; corner < 3; corner += 1) {
      const vertex = object.indices[triangle * 3 + corner];
      if (vertex === undefined) {
        return fail(
          distanceError(
            DISTANCE_ERROR_CODES.geometryInvalid,
            `The render object's triangle ${String(triangle)} is missing corner ${String(corner)}; the face surface cannot be sliced.`,
            triangle,
          ),
        );
      }
      indices.push(vertex);
    }
  }
  return ok(surfaceEntity("face", object.positions, Object.freeze(indices)));
}

// ---------------------------------------------------------------------------
// Reference resolution: the surfaces the current kernels carry
// ---------------------------------------------------------------------------

/** The object of `bodyId` in the passed scene, or `undefined`. */
function objectOfBody(
  objects: readonly RenderObject[],
  bodyId: BodyId,
): RenderObject | undefined {
  return objects.find((object) => object.bodyId === bodyId);
}

function unresolvable(reason: string, input: unknown) {
  return fail(
    distanceError(DISTANCE_ERROR_CODES.unresolvableReference, reason, input),
  );
}

/**
 * Resolves a selection reference to the entity the CURRENT scene measures
 * it as. `body`/`solid` resolve to the body's render object; `feature`
 * resolves through its single declared output; a synthetic `face` resolves
 * to its synthetic face's triangles in the body's grouping. Synthetic
 * `edge`/`vertex` references DECLINE: no current surface produces them, and
 * the decline names that fact instead of substituting a stand-in entity.
 * The caller passes the settled scene's objects — a body absent from them
 * (unrendered, stale) declines rather than measuring another scene.
 */
export function measureEntityOfReference(
  reference: SelectionReference,
  objects: readonly RenderObject[],
  features: readonly FeatureRecord[],
): ParseResult<MeasureEntity, DistanceError> {
  if (reference.kind === "body" || reference.kind === "solid") {
    const object = objectOfBody(objects, reference.bodyId);
    return object === undefined
      ? unresolvable(
          `No rendered object for body "${reference.bodyId}"; the scene does not carry it.`,
          reference,
        )
      : ok(surfaceOfRenderObject(object));
  }
  if (reference.kind === "feature") {
    const feature = features.find(
      (candidate) => candidate.id === reference.featureId,
    );
    if (feature === undefined) {
      return unresolvable(
        `No feature "${reference.featureId}" exists; a feature reference cannot resolve.`,
        reference,
      );
    }
    if (feature.outputs.length !== 1) {
      return unresolvable(
        `Feature "${reference.featureId}" outputs ${String(feature.outputs.length)} bodies; a feature reference resolves only through a single output.`,
        feature,
      );
    }
    const bodyId = feature.outputs[0];
    const object =
      bodyId === undefined ? undefined : objectOfBody(objects, bodyId);
    return object === undefined
      ? unresolvable(
          `No rendered object for the feature's body "${String(bodyId)}"; the scene does not carry it.`,
          reference,
        )
      : ok(surfaceOfRenderObject(object));
  }
  if (reference.kind === "face") {
    const object = objectOfBody(objects, reference.bodyId);
    if (object === undefined) {
      return unresolvable(
        `No rendered object for body "${reference.bodyId}"; the scene does not carry the face.`,
        reference,
      );
    }
    return measureSurfaceOfSyntheticFace(object, reference.faceIndex);
  }
  return unresolvable(
    `A synthetic ${reference.kind} reference has no producing surface: transient picking produces faces only, and a persistent snapshot's summary measures are not the entity's geometry — the pair is declined, not approximated.`,
    reference,
  );
}

/**
 * Resolves a persistent topology snapshot entity (the OCCT resolution
 * path) to a measurable entity: a VERTEX resolves to its exact absolute
 * point — the one descriptor field that IS the entity's geometry. Edge and
 * face snapshot entities DECLINE: their descriptors carry summary measures
 * (length/area, centroid) which locate the entity class but are not
 * sampled geometry — measuring to a centroid would misreport the minimum
 * (a cylinder wall's centroid is at its axis), so the measurement is
 * declined until a sampled-geometry carrier exists.
 */
export function measureEntityOfSnapshotEntity(
  entity: TopologyEntitySnapshot,
): ParseResult<MeasureEntity, DistanceError> {
  if (entity.kind === "vertex") {
    const point = entity.geometry.pointAbsoluteMm;
    return point === undefined
      ? unresolvable(
          `The vertex snapshot entity at ordinal ${String(entity.ordinal)} carries no absolute point; its descriptor cannot ground a measurement.`,
          entity,
        )
      : ok(vertexEntity(point));
  }
  return unresolvable(
    `A persistent ${entity.kind} reference resolves to summary measures (a centroid and ${entity.kind === "edge" ? "length" : "area"}), not the entity's sampled geometry; measuring to the centroid would misreport the minimum, so the pair is declined.`,
    entity,
  );
}

// ---------------------------------------------------------------------------
// Geometry: exact point-to-primitive distances in canonical millimetres
// ---------------------------------------------------------------------------

/** Euclidean distance between two points. */
function pointPointDistance(a: RenderVector3, b: RenderVector3): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

/**
 * Exact distance from a point to a segment: the clamped projection onto the
 * segment's supporting line, an endpoint when the projection falls outside.
 * A degenerate (zero-length) segment measures to its endpoint.
 */
function pointSegmentDistance(
  p: RenderVector3,
  a: RenderVector3,
  b: RenderVector3,
): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const dz = b[2] - a[2];
  const lengthSquared = dx * dx + dy * dy + dz * dz;
  if (lengthSquared === 0) return pointPointDistance(p, a);
  const t = Math.min(
    1,
    Math.max(
      0,
      ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy + (p[2] - a[2]) * dz) /
        lengthSquared,
    ),
  );
  return Math.hypot(
    p[0] - (a[0] + t * dx),
    p[1] - (a[1] + t * dy),
    p[2] - (a[2] + t * dz),
  );
}

function dot(
  ax: number,
  ay: number,
  az: number,
  bx: number,
  by: number,
  bz: number,
): number {
  return ax * bx + ay * by + az * bz;
}

/**
 * Exact distance from a point to a triangle (Ericson's region test): the
 * perpendicular distance when the projection lands inside, otherwise the
 * minimum over the three edges' segment distances. A fully degenerate
 * triangle (zero area, so the barycentric denominator vanishes) falls back
 * to its edges.
 */
function pointTriangleDistance(
  p: RenderVector3,
  a: RenderVector3,
  b: RenderVector3,
  c: RenderVector3,
): number {
  const abx = b[0] - a[0];
  const aby = b[1] - a[1];
  const abz = b[2] - a[2];
  const acx = c[0] - a[0];
  const acy = c[1] - a[1];
  const acz = c[2] - a[2];
  const apx = p[0] - a[0];
  const apy = p[1] - a[1];
  const apz = p[2] - a[2];
  const d1 = dot(abx, aby, abz, apx, apy, apz);
  const d2 = dot(acx, acy, acz, apx, apy, apz);
  if (d1 <= 0 && d2 <= 0) return pointPointDistance(p, a);
  const bpx = p[0] - b[0];
  const bpy = p[1] - b[1];
  const bpz = p[2] - b[2];
  const d3 = dot(abx, aby, abz, bpx, bpy, bpz);
  const d4 = dot(acx, acy, acz, bpx, bpy, bpz);
  if (d3 >= 0 && d4 <= d3) return pointPointDistance(p, b);
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const v = d1 / (d1 - d3);
    return pointPointDistance(p, [
      a[0] + v * abx,
      a[1] + v * aby,
      a[2] + v * abz,
    ]);
  }
  const cpx = p[0] - c[0];
  const cpy = p[1] - c[1];
  const cpz = p[2] - c[2];
  const d5 = dot(abx, aby, abz, cpx, cpy, cpz);
  const d6 = dot(acx, acy, acz, cpx, cpy, cpz);
  if (d6 >= 0 && d5 <= d6) return pointPointDistance(p, c);
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const w = d2 / (d2 - d6);
    return pointPointDistance(p, [
      a[0] + w * acx,
      a[1] + w * acy,
      a[2] + w * acz,
    ]);
  }
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const w = (d4 - d3) / (d4 - d3 + (d5 - d6));
    return pointPointDistance(p, [
      b[0] + w * (c[0] - b[0]),
      b[1] + w * (c[1] - b[1]),
      b[2] + w * (c[2] - b[2]),
    ]);
  }
  const denominator = va + vb + vc;
  if (denominator === 0) {
    return Math.min(
      pointSegmentDistance(p, a, b),
      pointSegmentDistance(p, b, c),
      pointSegmentDistance(p, c, a),
    );
  }
  const v = vb / denominator;
  const w = vc / denominator;
  return pointPointDistance(p, [
    a[0] + abx * v + acx * w,
    a[1] + aby * v + acy * w,
    a[2] + abz * v + acz * w,
  ]);
}

/** Exact distance from a point to an edge's polyline: its segments' minimum. */
function pointPolylineDistance(
  p: RenderVector3,
  polyline: readonly RenderVector3[],
): number {
  let minimum = Number.POSITIVE_INFINITY;
  for (let i = 0; i + 1 < polyline.length; i += 1) {
    const a = polyline[i];
    const b = polyline[i + 1];
    if (a === undefined || b === undefined) continue;
    minimum = Math.min(minimum, pointSegmentDistance(p, a, b));
  }
  return minimum;
}

/** Exact distance from a point to a triangulated surface: its triangles' minimum. */
function pointSurfaceDistance(
  p: RenderVector3,
  entity: {
    readonly positions: readonly number[];
    readonly indices: readonly number[];
  },
): number {
  let minimum = Number.POSITIVE_INFINITY;
  for (let t = 0; t + 2 < entity.indices.length; t += 3) {
    const ia = entity.indices[t];
    const ib = entity.indices[t + 1];
    const ic = entity.indices[t + 2];
    if (ia === undefined || ib === undefined || ic === undefined) continue;
    minimum = Math.min(
      minimum,
      pointTriangleDistance(
        p,
        positionAt(entity.positions, ia),
        positionAt(entity.positions, ib),
        positionAt(entity.positions, ic),
      ),
    );
  }
  return minimum;
}

/** Reads vertex `index`'s xyz out of a flat position buffer. */
function positionAt(
  positions: readonly number[],
  index: number,
): RenderVector3 {
  const x = positions[index * 3];
  const y = positions[index * 3 + 1];
  const z = positions[index * 3 + 2];
  if (x === undefined || y === undefined || z === undefined) {
    throw new RangeError(
      `Distance geometry indexed position ${String(index)} of a ${String(positions.length / 3)}-vertex buffer.`,
    );
  }
  return [x, y, z];
}

/**
 * The sample points an entity contributes to an entity-pair minimum: a
 * point/vertex its position, an edge its polyline vertices, a face or body
 * the surface's index-referenced vertices (first occurrence, exact position
 * keys, `-0` normalized — the synthetic-face grouping's keying rule).
 */
function samplesOf(entity: MeasureEntity): readonly RenderVector3[] {
  if (entity.kind === "point" || entity.kind === "vertex") {
    return [entity.position];
  }
  if (entity.kind === "edge") return entity.polyline;
  const seen = new Set<string>();
  const samples: RenderVector3[] = [];
  for (const index of entity.indices) {
    const position = positionAt(entity.positions, index);
    const key = `${String(position[0] + 0)},${String(position[1] + 0)},${String(position[2] + 0)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    samples.push(position);
  }
  return samples;
}

/** Exact distance from one sample point to an entity's geometry. */
function pointEntityDistance(p: RenderVector3, entity: MeasureEntity): number {
  if (entity.kind === "point" || entity.kind === "vertex") {
    return pointPointDistance(p, entity.position);
  }
  if (entity.kind === "edge") return pointPolylineDistance(p, entity.polyline);
  return pointSurfaceDistance(p, entity);
}

// ---------------------------------------------------------------------------
// Validation and the measurement
// ---------------------------------------------------------------------------

function isFiniteTriple(value: unknown): value is RenderVector3 {
  return (
    Array.isArray(value) &&
    value.length === 3 &&
    value.every(
      (component) =>
        typeof component === "number" && Number.isFinite(component),
    )
  );
}

/** Validates an entity's buffers; the structured decline, or `undefined`. */
function validateEntity(entity: MeasureEntity): DistanceError | undefined {
  const invalid = (message: string, input: unknown): DistanceError =>
    distanceError(DISTANCE_ERROR_CODES.geometryInvalid, message, input);
  if (entity.kind === "point" || entity.kind === "vertex") {
    return isFiniteTriple(entity.position)
      ? undefined
      : invalid(
          "A point entity's position must be three finite numbers.",
          entity.position,
        );
  }
  if (entity.kind === "edge") {
    if (entity.polyline.length < 2) {
      return invalid(
        "An edge entity needs at least two polyline points to span a segment.",
        entity.polyline,
      );
    }
    return entity.polyline.every(isFiniteTriple)
      ? undefined
      : invalid(
          "An edge entity's polyline must be three-finite-number points.",
          entity.polyline,
        );
  }
  const { positions, indices } = entity;
  if (positions.length === 0 || positions.length % 3 !== 0) {
    return invalid(
      "A surface entity's positions must be a non-empty flat xyz array divisible by 3.",
      positions.length,
    );
  }
  if (indices.length < 3 || indices.length % 3 !== 0) {
    return invalid(
      "A surface entity's indices must be a non-empty flat triangle-vertex array divisible by 3.",
      indices.length,
    );
  }
  const vertexCount = positions.length / 3;
  for (const value of positions) {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      return invalid(
        "A surface entity's positions must be finite numbers.",
        value,
      );
    }
  }
  for (const index of indices) {
    if (
      typeof index !== "number" ||
      !Number.isInteger(index) ||
      index < 0 ||
      index >= vertexCount
    ) {
      return invalid(
        `A surface entity's indices must be integers within the vertex range 0..${String(vertexCount - 1)}.`,
        index,
      );
    }
  }
  return undefined;
}

/**
 * Measures the distance between two entities: the pair semantics of the
 * module header — Euclidean among point-like entities, an exact projection
 * when either side is point-like, the two-direction sampled minimum
 * otherwise — as a canonical-millimetre dimensional value. Declines
 * structured (`distance/geometry-invalid`) when either entity violates its
 * buffer contract; nothing computes silently over malformed data.
 */
export function measureDistance(
  a: MeasureEntity,
  b: MeasureEntity,
): ParseResult<LengthValue, DistanceError> {
  const invalidA = validateEntity(a);
  if (invalidA !== undefined) return fail(invalidA);
  const invalidB = validateEntity(b);
  if (invalidB !== undefined) return fail(invalidB);
  let minimum = Number.POSITIVE_INFINITY;
  for (const sample of samplesOf(a)) {
    minimum = Math.min(minimum, pointEntityDistance(sample, b));
  }
  for (const sample of samplesOf(b)) {
    minimum = Math.min(minimum, pointEntityDistance(sample, a));
  }
  return ok(length(minimum));
}

/**
 * Measures the distance a selection requests: the selection must hold
 * EXACTLY two references (`distance/not-a-pair` otherwise), and both must
 * resolve on the passed surfaces — the same current-scene rule the bounds
 * inspection answers to. The result is the pair's canonical-millimetre
 * distance.
 */
export function selectionDistance(
  selected: readonly SelectionReference[],
  objects: readonly RenderObject[],
  features: readonly FeatureRecord[],
): ParseResult<LengthValue, DistanceError> {
  if (selected.length !== 2) {
    return fail(
      distanceError(
        DISTANCE_ERROR_CODES.notAPair,
        `A distance request is a pair of references; the selection holds ${String(selected.length)}.`,
        selected.length,
      ),
    );
  }
  const first = selected[0];
  const second = selected[1];
  if (first === undefined || second === undefined) {
    return fail(
      distanceError(
        DISTANCE_ERROR_CODES.notAPair,
        "A distance request is a pair of references.",
        selected,
      ),
    );
  }
  const a = measureEntityOfReference(first, objects, features);
  if (!a.ok) return a;
  const b = measureEntityOfReference(second, objects, features);
  if (!b.ok) return b;
  return measureDistance(a.value, b.value);
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/**
 * Formats a distance through the shared dimensional API — three decimals,
 * canonical millimetres, the value only (the readout renders the `mm`
 * suffix), the same byte-stable convention as the bounds extents form.
 */
export function formatMeasureDistance(value: LengthValue): string {
  return valueIn(value, "mm").toFixed(3);
}
