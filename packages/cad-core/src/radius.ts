/**
 * Radius/diameter measurement (Phase 27.3): the domain core behind the
 * workbench's Radius row — the plan's "measure circles/arcs/cylindrical
 * geometry where supported", answered as an honest support matrix.
 *
 * ## The supported matrix (per what the current surfaces actually carry)
 *
 * - **Stored radii — exact.** Circular entities that store their radius
 *   (the sketch `circle` and `arc` entities carry `radius` in mm) measure
 *   through {@link storedRadius}: the stored value validated as a positive
 *   finite length, nothing inferred.
 * - **Surface-typed persistent faces — exact.** A persistent topology
 *   snapshot's face entity measures through {@link snapshotEntityRadius}
 *   when its descriptor carries `cylinderRadiusMm` — the field a
 *   surface-typing producer records (the OCCT producer probes
 *   `BRepAdaptor_Surface`, and on `GeomAbs_Cylinder` stores
 *   `gp_Cylinder.Radius()` exactly). Descriptors without the field decline:
 *   summary measures (area, centroid) do not determine a radius.
 * - **Tessellated cylindrical regions — fitted, band-documented.** A
 *   synthetic face's triangles measure through
 *   {@link fitCylindricalRadius}: a least-squares fit of an axis (the
 *   eigenvector of the triangles' normal scatter with the smallest
 *   eigenvalue — a cylinder wall's normals are all perpendicular to its
 *   axis) and of a circle (the classic algebraic Kasa fit over the axis-
 *   projected vertices), accepted only when every vertex's radial residual
 *   is within {@link RADIUS_FIT_MAX_RESIDUAL_MM}. The approximation honesty:
 *   the fit measures the mesh's VERTICES, and the kernels place circular
 *   geometry's vertices ON the true surface — profile-derived cylinders at
 *   the shared 0.1 rad segment ceiling (63 chords per full turn,
 *   `PROFILE_MAX_SEGMENT_ANGLE_RAD`), engine primitives at their own
 *   segmentation — so the fitted radius reproduces the true radius to float
 *   precision and the fit is segment-count independent. The mesh's linear
 *   FACETS depart from the true surface by at most the chord sagitta
 *   `r·(1 − cos(π/n))` (for the 63-chord convention ≈ 0.124% of the radius);
 *   that facet band is what a tessellation whose vertices sat off the
 *   surface would inherit. The result is labelled `precision: "fitted"` so
 *   no surface presents a fit as an exact.
 * - **Everything else — structured decline.** A plane or a sphere patch
 *   fails the fit's residual gate (`radius/not-cylindrical`); `body`,
 *   `solid`, `feature`, and synthetic `edge`/`vertex` references decline
 *   (`radius/unresolvable-reference`) — a body is a composition of faces,
 *   not one circle, and no transient surface produces edges or vertices.
 *
 * ## Semantics and units
 *
 * Every measure carries BOTH presentations — the radius and its diameter
 * dual (`2·r` through the shared dimensional infrastructure) — as canonical
 * millimetre lengths, formatted at three decimals by
 * {@link formatRadiusMeasure} (the readouts render the units). The
 * selection-level entry {@link selectionRadius} requires EXACTLY one
 * reference — a radius is a property of one circular/cylindrical entity —
 * and every decline is structured ({@link RadiusError}): nothing presents
 * an approximate or unrelated number as a measurement.
 */

import type { FeatureRecord } from "./document";
import type { BodyId } from "./ids";
import type { TopologyEntitySnapshot } from "./persistent-reference";
import type { RenderObject } from "./projection";
import type { ParseFailure, ParseResult } from "./result";
import type { SelectionReference } from "./selection";

import {
  type LengthValue,
  dimensionless,
  length,
  multiply,
  valueIn,
} from "./dimensional";
import { measureSurfaceOfSyntheticFace } from "./distance";
import { fail, ok } from "./result";

// ---------------------------------------------------------------------------
// Failures
// ---------------------------------------------------------------------------

/** Stable failure codes produced by the radius operations. */
export const RADIUS_ERROR_CODES = {
  /** The selection does not hold exactly one reference. */
  notSingleReference: "radius/not-single-reference",
  /** A reference names nothing the radius matrix can resolve. */
  unresolvableReference: "radius/unresolvable-reference",
  /** The resolved surface is not cylindrical within the fit's band. */
  notCylindrical: "radius/not-cylindrical",
  /** Entity geometry violated its buffer contract. */
  geometryInvalid: "radius/geometry-invalid",
  /** A stored radius is not a positive finite number. */
  radiusInvalid: "radius/radius-invalid",
} as const;

export type RadiusErrorCode =
  (typeof RADIUS_ERROR_CODES)[keyof typeof RADIUS_ERROR_CODES];

/** Structured failure describing why a radius measurement was declined. */
export interface RadiusError extends ParseFailure {
  readonly code: RadiusErrorCode;
}

function radiusError(
  code: RadiusErrorCode,
  message: string,
  input: unknown,
): RadiusError {
  return { code, message, input };
}

// ---------------------------------------------------------------------------
// The measure: radius + diameter dual, with its precision label
// ---------------------------------------------------------------------------

/** How a radius was obtained — presented alongside the value, never merged. */
export type RadiusPrecision = "exact" | "fitted";

/** The fitted path's reported geometry, as data. */
export interface RadiusFitDetails {
  /** The fitted cylinder axis, a unit vector. */
  readonly axis: readonly [number, number, number];
  /**
   * The fitted circle's centre in millimetres, reported at the vertex set's
   * mean axial coordinate along the fitted axis.
   */
  readonly centerMm: readonly [number, number, number];
  /** The largest vertex radial residual from the fitted circle, in mm. */
  readonly residualMm: number;
  /** The distinct vertex count the fit consumed. */
  readonly vertexCount: number;
}

/** A radius measurement: the value, its diameter dual, and the precision. */
export interface RadiusMeasure {
  /** The radius, a canonical-millimetre length. */
  readonly radius: LengthValue;
  /** The diameter — twice the radius through the shared unit infrastructure. */
  readonly diameter: LengthValue;
  /** `exact` for stored/surface-typed radii, `fitted` for the tessellated path. */
  readonly precision: RadiusPrecision;
  /** The fit's geometry, present exactly when `precision` is `"fitted"`. */
  readonly fit?: RadiusFitDetails;
}

/**
 * The maximum vertex radial residual (mm) a fit may show and still count as
 * cylindrical. The kernels' on-surface vertices are exact in the kernel,
 * but the worker mesh transport is single-precision (Manifold's MeshGL):
 * float32 leaves ~6e-8 relative noise — 0.1 µm bounds honest acceptance for
 * millimetre-to-decimetre geometry with orders of magnitude of margin, and
 * stays orders below the documented facet band (≈0.124% of the radius for
 * the 63-chord convention).
 */
export const RADIUS_FIT_MAX_RESIDUAL_MM = 1e-4;

/** Builds a measure from a validated canonical-millimetre radius. */
function measureOf(
  radiusMm: number,
  precision: RadiusPrecision,
  fit?: RadiusFitDetails,
): RadiusMeasure {
  const radius = length(radiusMm);
  return {
    radius,
    diameter: multiply(radius, dimensionless(2)),
    precision,
    ...(fit === undefined ? {} : { fit }),
  };
}

/**
 * Measures a stored radius — the exact path of entities that carry one (the
 * sketch circle and arc entities' `radius` field, in millimetres). Declines
 * anything that is not a positive finite number.
 */
export function storedRadius(
  radiusMm: number,
): ParseResult<RadiusMeasure, RadiusError> {
  if (
    typeof radiusMm !== "number" ||
    !Number.isFinite(radiusMm) ||
    radiusMm <= 0
  ) {
    return fail(
      radiusError(
        RADIUS_ERROR_CODES.radiusInvalid,
        `A stored radius must be a positive finite number of millimetres, received ${String(radiusMm)}.`,
        radiusMm,
      ),
    );
  }
  return ok(measureOf(radiusMm, "exact"));
}

/**
 * Measures a persistent topology snapshot entity — the surface-typed
 * (OCCT) path. A FACE whose descriptor carries `cylinderRadiusMm` (the
 * producer's `BRepAdaptor_Surface` → `GeomAbs_Cylinder` probe result)
 * measures exactly. Everything else declines: summary measures (area,
 * centroid, length, point) do not determine a radius, and non-faces have no
 * surface to type.
 */
export function snapshotEntityRadius(
  entity: TopologyEntitySnapshot,
): ParseResult<RadiusMeasure, RadiusError> {
  const radiusMm = entity.geometry.cylinderRadiusMm;
  if (entity.kind === "face" && radiusMm !== undefined) {
    if (!Number.isFinite(radiusMm) || radiusMm <= 0) {
      return fail(
        radiusError(
          RADIUS_ERROR_CODES.radiusInvalid,
          `The face snapshot at ordinal ${String(entity.ordinal)} carries a cylinder radius that is not a positive finite number.`,
          radiusMm,
        ),
      );
    }
    return ok(measureOf(radiusMm, "exact"));
  }
  return fail(
    radiusError(
      RADIUS_ERROR_CODES.unresolvableReference,
      entity.kind === "face"
        ? `The face snapshot at ordinal ${String(entity.ordinal)} carries no cylindrical surface typing; its summary measures (area, centroid) do not determine a radius, so the measurement is declined rather than inferred.`
        : `A persistent ${entity.kind} has no surface to type; the radius matrix resolves surface-typed faces only.`,
      entity,
    ),
  );
}

// ---------------------------------------------------------------------------
// The fit: axis by normal-scatter eigen decomposition, circle by Kasa
// ---------------------------------------------------------------------------

/** A mutable 3×3 matrix (row-major). */
type Matrix3 = [
  [number, number, number],
  [number, number, number],
  [number, number, number],
];

/** One symmetric 3×3 eigen decomposition result. */
interface EigenDecomposition {
  /** Eigenvalues, ascending. */
  readonly values: readonly [number, number, number];
  /** Eigenvectors as COLUMNS aligned with `values`, each a unit vector. */
  readonly vectors: readonly [
    readonly [number, number, number],
    readonly [number, number, number],
    readonly [number, number, number],
  ];
}

/**
 * Applies one (i, j) Givens rotation in place: A ← JᵀAJ on the working
 * matrix and V ← V·J on the eigenvector accumulator (J is the rotation by
 * c, s in the (i, j) plane).
 */
function rotateEntries(
  m: Matrix3,
  v: Matrix3,
  i: 0 | 1 | 2,
  j: 0 | 1 | 2,
  c: number,
  s: number,
): void {
  for (let k = 0; k < 3; k += 1) {
    const mik = m[i][k];
    const mjk = m[j][k];
    if (mik === undefined || mjk === undefined) continue;
    m[i][k] = c * mik - s * mjk;
    m[j][k] = s * mik + c * mjk;
  }
  for (let k = 0; k < 3; k += 1) {
    const row = m[k];
    if (row === undefined) continue;
    const mki = row[i];
    const mkj = row[j];
    if (mki === undefined || mkj === undefined) continue;
    row[i] = c * mki - s * mkj;
    row[j] = s * mki + c * mkj;
  }
  for (let k = 0; k < 3; k += 1) {
    const column = v[k];
    if (column === undefined) continue;
    const vki = column[i];
    const vkj = column[j];
    if (vki === undefined || vkj === undefined) continue;
    column[i] = c * vki - s * vkj;
    column[j] = s * vki + c * vkj;
  }
}

/**
 * Jacobi eigen decomposition of a symmetric 3×3 matrix: cyclic sweeps of
 * Givens rotations zero the off-diagonal entries. Fully deterministic —
 * fixed sweep order, fixed convergence threshold, so the same input always
 * yields the same eigenvectors (up to the sign the caller fixes).
 */
function jacobiEigenDecomposition(matrix: Matrix3): EigenDecomposition {
  const a: Matrix3 = [
    [matrix[0][0], matrix[0][1], matrix[0][2]],
    [matrix[1][0], matrix[1][1], matrix[1][2]],
    [matrix[2][0], matrix[2][1], matrix[2][2]],
  ];
  const v: Matrix3 = [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ];
  const scale =
    Math.abs(a[0][0]) + Math.abs(a[1][1]) + Math.abs(a[2][2]) + 1e-300;
  for (let sweep = 0; sweep < 64; sweep += 1) {
    const off = Math.abs(a[0][1]) + Math.abs(a[0][2]) + Math.abs(a[1][2]);
    if (off <= 1e-15 * scale) break;
    for (const [p, q] of [
      [0, 1],
      [0, 2],
      [1, 2],
    ] as const) {
      const apq = a[p][q];
      if (apq === undefined || Math.abs(apq) <= 1e-18 * scale) continue;
      const app = a[p][p];
      const aqq = a[q][q];
      if (app === undefined || aqq === undefined) continue;
      const theta = (aqq - app) / (2 * apq);
      const t =
        Math.sign(theta || 1) /
        (Math.abs(theta) + Math.sqrt(theta * theta + 1));
      const c = 1 / Math.sqrt(t * t + 1);
      const s = t * c;
      rotateEntries(a, v, p, q, c, s);
    }
  }
  type AxisOrdinal = 0 | 1 | 2;
  const order: readonly [AxisOrdinal, AxisOrdinal, AxisOrdinal] =
    a[0][0] <= a[1][1] && a[0][0] <= a[2][2]
      ? a[1][1] <= a[2][2]
        ? [0, 1, 2]
        : [0, 2, 1]
      : a[1][1] <= a[2][2] && a[1][1] <= a[0][0]
        ? a[2][2] <= a[0][0]
          ? [1, 2, 0]
          : [1, 0, 2]
        : a[2][2] <= a[0][0]
          ? a[0][0] <= a[1][1]
            ? [2, 0, 1]
            : [2, 1, 0]
          : [2, 1, 0];
  const eigenAt = (ordinal: 0 | 1 | 2): readonly [number, number, number] => {
    const x = v[0][ordinal];
    const y = v[1][ordinal];
    const z = v[2][ordinal];
    if (x === undefined || y === undefined || z === undefined) {
      throw new RangeError(
        `Jacobi decomposition lost eigenvector column ${String(ordinal)}.`,
      );
    }
    const magnitude = Math.hypot(x, y, z) || 1;
    return [x / magnitude, y / magnitude, z / magnitude];
  };
  const first = eigenAt(order[0]);
  const second = eigenAt(order[1]);
  const third = eigenAt(order[2]);
  const diag = (ordinal: 0 | 1 | 2): number => {
    const value = a[ordinal][ordinal];
    if (value === undefined) {
      throw new RangeError(
        `Jacobi decomposition lost diagonal entry ${String(ordinal)}.`,
      );
    }
    return value;
  };
  const values: readonly [number, number, number] = Object.freeze([
    diag(0),
    diag(1),
    diag(2),
  ]);
  const vectors: readonly [
    readonly [number, number, number],
    readonly [number, number, number],
    readonly [number, number, number],
  ] = Object.freeze([first, second, third]);
  return Object.freeze({ values, vectors });
}

/**
 * Fixes an eigenvector's sign deterministically: the component of largest
 * absolute value is made positive (ties break toward the lower index), so
 * the same geometry always fits to the same axis vector.
 */
function signFixed(
  vector: readonly [number, number, number],
): readonly [number, number, number] {
  const [vx, vy, vz] = vector;
  if (vx === undefined || vy === undefined || vz === undefined) return vector;
  let best = 0;
  for (const index of [1, 2] as const) {
    const current = vector[index];
    const bestValue = vector[best];
    if (
      current !== undefined &&
      bestValue !== undefined &&
      Math.abs(current) > Math.abs(bestValue)
    ) {
      best = index;
    }
  }
  const pivot = vector[best];
  if (pivot === undefined || pivot >= 0) return vector;
  return [-vx, -vy, -vz];
}

function normalize3(
  x: number,
  y: number,
  z: number,
): readonly [number, number, number] | null {
  const magnitude = Math.hypot(x, y, z);
  if (magnitude <= 1e-12) return null;
  return [x / magnitude, y / magnitude, z / magnitude];
}

/** Reads vertex `index`'s xyz out of a flat position buffer, or throws. */
function positionAt(
  positions: readonly number[],
  index: number,
): readonly [number, number, number] {
  const x = positions[index * 3];
  const y = positions[index * 3 + 1];
  const z = positions[index * 3 + 2];
  if (x === undefined || y === undefined || z === undefined) {
    throw new RangeError(
      `Radius fit indexed position ${String(index)} of a ${String(positions.length / 3)}-vertex buffer.`,
    );
  }
  return [x, y, z];
}

/** Geometric (counter-clockwise winding) normal of one triangle, or `null`. */
function triangleNormal(
  positions: readonly number[],
  a: number,
  b: number,
  c: number,
): readonly [number, number, number] | null {
  const pa = positionAt(positions, a);
  const pb = positionAt(positions, b);
  const pc = positionAt(positions, c);
  const ux = pb[0] - pa[0];
  const uy = pb[1] - pa[1];
  const uz = pb[2] - pa[2];
  const vx = pc[0] - pa[0];
  const vy = pc[1] - pa[1];
  const vz = pc[2] - pa[2];
  return normalize3(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
}

interface BufferValidation {
  readonly vertexCount: number;
}

/**
 * Validates the flat buffers against the projection contract's shapes (the
 * same buffer shapes the distance matrix measures): flat xyz positions,
 * flat triangle-vertex indices in range.
 */
function validateBuffers(
  positions: readonly number[],
  indices: readonly number[],
): BufferValidation | RadiusError {
  const invalid = (message: string, input: unknown): RadiusError =>
    radiusError(RADIUS_ERROR_CODES.geometryInvalid, message, input);
  if (positions.length === 0 || positions.length % 3 !== 0) {
    return invalid(
      "A radius fit's positions must be a non-empty flat xyz array divisible by 3.",
      positions.length,
    );
  }
  if (indices.length < 3 || indices.length % 3 !== 0) {
    return invalid(
      "A radius fit's indices must be a non-empty flat triangle-vertex array divisible by 3.",
      indices.length,
    );
  }
  const vertexCount = positions.length / 3;
  for (const value of positions) {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      return invalid("A radius fit's positions must be finite numbers.", value);
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
        `A radius fit's indices must be integers within the vertex range 0..${String(vertexCount - 1)}.`,
        index,
      );
    }
  }
  return { vertexCount };
}

/** Solve Ax = b by Cramer's rule; `null` when the system is singular. */
function solve3(
  m: Matrix3,
  b: readonly [number, number, number],
): readonly [number, number, number] | null {
  const det =
    m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) -
    m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) +
    m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
  if (!Number.isFinite(det) || det === 0) return null;
  const replace = (column: number): Matrix3 => {
    const copy: Matrix3 = [
      [m[0][0], m[0][1], m[0][2]],
      [m[1][0], m[1][1], m[1][2]],
      [m[2][0], m[2][1], m[2][2]],
    ];
    const b0 = b[0];
    const b1 = b[1];
    const b2 = b[2];
    if (b0 === undefined || b1 === undefined || b2 === undefined) {
      throw new RangeError(
        "Radius circle fit received a non-dense right-hand side.",
      );
    }
    if (column === 0) {
      copy[0][0] = b0;
      copy[1][0] = b1;
      copy[2][0] = b2;
    } else if (column === 1) {
      copy[0][1] = b0;
      copy[1][1] = b1;
      copy[2][1] = b2;
    } else {
      copy[0][2] = b0;
      copy[1][2] = b1;
      copy[2][2] = b2;
    }
    return copy;
  };
  const determinant = (candidate: Matrix3): number =>
    candidate[0][0] *
      (candidate[1][1] * candidate[2][2] - candidate[1][2] * candidate[2][1]) -
    candidate[0][1] *
      (candidate[1][0] * candidate[2][2] - candidate[1][2] * candidate[2][0]) +
    candidate[0][2] *
      (candidate[1][0] * candidate[2][1] - candidate[1][1] * candidate[2][0]);
  const x = determinant(replace(0)) / det;
  const y = determinant(replace(1)) / det;
  const z = determinant(replace(2)) / det;
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
    return null;
  }
  return [x, y, z];
}

/**
 * Fits a cylindrical radius to a tessellated region — the transient
 * synthetic-face path. The axis is the normal-scatter eigenvector with the
 * smallest eigenvalue (a cylinder wall's face normals are all perpendicular
 * to its axis, so the scatter along the axis vanishes); the circle is the
 * algebraic least-squares (Kasa) fit over the axis-projected vertices;
 * accepted only when every vertex's radial residual stays within
 * {@link RADIUS_FIT_MAX_RESIDUAL_MM}. See the module header for the
 * documented approximation band.
 */
export function fitCylindricalRadius(
  positions: readonly number[],
  indices: readonly number[],
): ParseResult<RadiusMeasure, RadiusError> {
  const validated = validateBuffers(positions, indices);
  if ("code" in validated) return fail(validated);

  // Scatter of the triangles' geometric normals (sign-invariant: n nᵀ),
  // unrolled over the nine entries — noUncheckedIndexedAccess makes looped
  // tuple indexing fight the compiler for no gain on a fixed 3×3.
  let m00 = 0;
  let m01 = 0;
  let m02 = 0;
  let m11 = 0;
  let m12 = 0;
  let m22 = 0;
  let triangles = 0;
  let degenerate = 0;
  for (let t = 0; t + 2 < indices.length; t += 3) {
    const ia = indices[t];
    const ib = indices[t + 1];
    const ic = indices[t + 2];
    if (ia === undefined || ib === undefined || ic === undefined) continue;
    const normal = triangleNormal(positions, ia, ib, ic);
    if (normal === null) {
      degenerate += 1;
      continue;
    }
    triangles += 1;
    const nx = normal[0];
    const ny = normal[1];
    const nz = normal[2];
    if (nx === undefined || ny === undefined || nz === undefined) continue;
    m00 += nx * nx;
    m01 += nx * ny;
    m02 += nx * nz;
    m11 += ny * ny;
    m12 += ny * nz;
    m22 += nz * nz;
  }
  const scatter: Matrix3 = [
    [m00, m01, m02],
    [m01, m11, m12],
    [m02, m12, m22],
  ];
  if (triangles === 0) {
    return fail(
      radiusError(
        RADIUS_ERROR_CODES.notCylindrical,
        "Every triangle of the region is degenerate; no surface orientation exists to fit a cylinder axis with.",
        { triangles, degenerate },
      ),
    );
  }

  // The axis: smallest-eigenvalue eigenvector, sign-fixed. The decomposition
  // returns vectors aligned with `values` ascending, so index 0 is the
  // scatter's vanishing direction — the cylinder's axis.
  const eigen = jacobiEigenDecomposition(scatter);
  const axis = signFixed(eigen.vectors[0]);

  // Distinct vertices (exact-position keys, `-0` normalized — the grouping's
  // keying rule), projected onto the plane ⊥ axis through an in-plane
  // orthonormal basis: e1 is the world axis least aligned with the fitted
  // axis crossed to the plane (deterministic — the alignment comparisons
  // order-fix it), e2 completes the frame.
  const helper: readonly [number, number, number] =
    Math.abs(axis[0]) <= Math.abs(axis[1]) &&
    Math.abs(axis[0]) <= Math.abs(axis[2])
      ? [1, 0, 0]
      : Math.abs(axis[1]) <= Math.abs(axis[2])
        ? [0, 1, 0]
        : [0, 0, 1];
  const cross = (
    a: readonly [number, number, number],
    b: readonly [number, number, number],
  ): [number, number, number] => [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
  const e1raw = cross(axis, helper);
  const e1 = normalize3(e1raw[0], e1raw[1], e1raw[2]);
  if (e1 === null) {
    return fail(
      radiusError(
        RADIUS_ERROR_CODES.notCylindrical,
        "The fitted axis degenerated; no in-plane basis exists for the circle fit.",
        axis,
      ),
    );
  }
  const e2 = cross(axis, e1);
  // The region's REFERENCED vertices only — a face slice may share its
  // object's positions buffer while carrying just its own triangles'
  // indices (the synthetic-face slice's contract), so the vertex set is
  // what the indices reference (first occurrence, exact-position keys,
  // `-0` normalized — the grouping's keying rule).
  const seen = new Set<string>();
  const projected: [number, number][] = [];
  const points: [number, number, number][] = [];
  for (let t = 0; t + 2 < indices.length; t += 3) {
    for (let corner = 0; corner < 3; corner += 1) {
      const index = indices[t + corner];
      if (index === undefined) continue;
      const [x, y, z] = positionAt(positions, index);
      const key = `${String(x + 0)},${String(y + 0)},${String(z + 0)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      projected.push([
        x * e1[0] + y * e1[1] + z * e1[2],
        x * e2[0] + y * e2[1] + z * e2[2],
      ]);
      points.push([x, y, z]);
    }
  }
  if (projected.length < 3) {
    return fail(
      radiusError(
        RADIUS_ERROR_CODES.notCylindrical,
        `The region has ${String(projected.length)} distinct vertices; a circle needs at least three.`,
        projected.length,
      ),
    );
  }

  // The projected points must SPREAD in 2D — a planar face projects onto a
  // line (the classic collinear degeneracy a circle fit cannot see past).
  let meanU = 0;
  let meanV = 0;
  for (const [u, v] of projected) {
    meanU += u;
    meanV += v;
  }
  meanU /= projected.length;
  meanV /= projected.length;
  let suu = 0;
  let svv = 0;
  let suv = 0;
  for (const [u, v] of projected) {
    suu += (u - meanU) * (u - meanU);
    svv += (v - meanV) * (v - meanV);
    suv += (u - meanU) * (v - meanV);
  }
  // The projected scatter's SMALLER eigenvalue: a cylinder wall's projection
  // spreads in both directions; a planar face's collapses onto a line, and
  // the small eigenvalue vanishes relative to the total spread.
  const totalSpread = suu + svv;
  const spreadGap = Math.hypot(suu - svv, 2 * suv);
  const minorSpread = (totalSpread - spreadGap) / 2;
  if (minorSpread <= 1e-9 * Math.max(totalSpread, 1e-300)) {
    return fail(
      radiusError(
        RADIUS_ERROR_CODES.notCylindrical,
        "The region's vertices project onto a line for every candidate axis; the surface is planar or degenerate, not cylindrical.",
        { vertices: projected.length },
      ),
    );
  }

  // Kasa algebraic circle fit: minimise Σ (u² + v² + D·u + E·v + F)².
  let sx = 0;
  let sy = 0;
  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  let sz = 0;
  let sxz = 0;
  let syz = 0;
  for (const [u, v] of projected) {
    const z = u * u + v * v;
    sx += u;
    sy += v;
    sxx += u * u;
    syy += v * v;
    sxy += u * v;
    sz += z;
    sxz += u * z;
    syz += v * z;
  }
  const solution = solve3(
    [
      [sxx, sxy, sx],
      [sxy, syy, sy],
      [sx, sy, projected.length],
    ],
    [-sxz, -syz, -sz],
  );
  if (solution === null) {
    return fail(
      radiusError(
        RADIUS_ERROR_CODES.notCylindrical,
        "The circle fit's normal equations are singular; the projected vertices do not bound a circle.",
        projected.length,
      ),
    );
  }
  const [d, e, f] = solution;
  const radiusSquared = (d * d) / 4 + (e * e) / 4 - f;
  if (
    !Number.isFinite(radiusSquared) ||
    radiusSquared <= 0 ||
    radiusSquared > 1e18
  ) {
    return fail(
      radiusError(
        RADIUS_ERROR_CODES.notCylindrical,
        "The fitted circle degenerated (non-positive or absurd radius); the surface is not a cylinder wall.",
        radiusSquared,
      ),
    );
  }
  const radius = Math.sqrt(radiusSquared);
  const centerU = -d / 2;
  const centerV = -e / 2;

  // The residual gate: every vertex within the documented band.
  let residual = 0;
  for (const [u, v] of projected) {
    residual = Math.max(
      residual,
      Math.abs(Math.hypot(u - centerU, v - centerV) - radius),
    );
  }
  if (residual > RADIUS_FIT_MAX_RESIDUAL_MM) {
    return fail(
      radiusError(
        RADIUS_ERROR_CODES.notCylindrical,
        `The region's vertices leave the fitted circle by up to ${residual.toExponential(3)} mm, beyond the ${String(RADIUS_FIT_MAX_RESIDUAL_MM)} mm band; the surface is not cylindrical.`,
        residual,
      ),
    );
  }

  // Lift the fitted centre onto the axis at the vertices' mean height.
  let meanAxial = 0;
  for (const [x, y, z] of points) {
    meanAxial += x * axis[0] + y * axis[1] + z * axis[2];
  }
  meanAxial /= points.length;
  const center: readonly [number, number, number] = [
    centerU + meanAxial * axis[0],
    centerV + meanAxial * axis[1],
    meanAxial * axis[2],
  ];
  return ok(
    measureOf(radius, "fitted", {
      axis,
      centerMm: center,
      residualMm: residual,
      vertexCount: projected.length,
    }),
  );
}

// ---------------------------------------------------------------------------
// Selection entry: the Radius row's request semantics
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
    radiusError(RADIUS_ERROR_CODES.unresolvableReference, reason, input),
  );
}

/**
 * Measures the radius a selection requests: EXACTLY one reference — a
 * radius is a property of one circular/cylindrical entity, so an empty or
 * multi-reference selection is `radius/not-single-reference` — and that
 * reference must resolve on the radius matrix: a synthetic face whose
 * triangles fit a cylinder (the current picking surface). `body`, `solid`,
 * `feature`, and synthetic `edge`/`vertex` references decline structured:
 * a body is a composition of faces rather than one circle, a feature
 * reference resolves to a whole body, and no transient surface produces
 * edges or vertices. The persistent surface-typed path is
 * {@link snapshotEntityRadius}, a different reference class.
 */
export function selectionRadius(
  selected: readonly SelectionReference[],
  objects: readonly RenderObject[],
  features: readonly FeatureRecord[],
): ParseResult<RadiusMeasure, RadiusError> {
  if (selected.length !== 1) {
    return fail(
      radiusError(
        RADIUS_ERROR_CODES.notSingleReference,
        `A radius request is one reference; the selection holds ${String(selected.length)}.`,
        selected.length,
      ),
    );
  }
  const reference = selected[0];
  if (reference === undefined) {
    return fail(
      radiusError(
        RADIUS_ERROR_CODES.notSingleReference,
        "A radius request is one reference.",
        selected,
      ),
    );
  }
  if (reference.kind === "face") {
    const object = objectOfBody(objects, reference.bodyId);
    if (object === undefined) {
      return unresolvable(
        `No rendered object for body "${reference.bodyId}"; the scene does not carry the face.`,
        reference,
      );
    }
    const face = measureSurfaceOfSyntheticFace(object, reference.faceIndex);
    if (!face.ok) {
      return fail(
        radiusError(
          RADIUS_ERROR_CODES.unresolvableReference,
          face.error.message,
          face.error.input,
        ),
      );
    }
    if (face.value.kind !== "face" && face.value.kind !== "body") {
      return unresolvable(
        "The synthetic face resolved to a point-like entity; the grouping and the surface disagree, so the radius declines.",
        face.value,
      );
    }
    return fitCylindricalRadius(face.value.positions, face.value.indices);
  }
  if (reference.kind === "body" || reference.kind === "solid") {
    return unresolvable(
      `A ${reference.kind} reference names a whole body — a composition of faces, not one circle; select its cylindrical face instead.`,
      reference,
    );
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
    return unresolvable(
      `A feature reference names its output body — a composition of faces, not one circle; select a cylindrical face instead.`,
      feature,
    );
  }
  return unresolvable(
    `A synthetic ${reference.kind} reference has no producing surface: transient picking produces faces only, so the radius matrix declines it rather than substituting a stand-in entity.`,
    reference,
  );
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/**
 * The dual presentation, formatted through the shared dimensional API —
 * three decimals, canonical millimetres, values only (the readouts render
 * the units and the `R`/`⌀` labels).
 */
export function formatRadiusMeasure(measure: RadiusMeasure): {
  radius: string;
  diameter: string;
} {
  return {
    radius: valueIn(measure.radius, "mm").toFixed(3),
    diameter: valueIn(measure.diameter, "mm").toFixed(3),
  };
}
