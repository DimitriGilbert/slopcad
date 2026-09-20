/**
 * Spline profile geometry (Phase 36): the kernel-side cubic Bézier chain
 * model behind the `spline` segment kind — the flavor conversion, the
 * deflection tessellation the mesh kernels extrude, and the endpoint
 * queries the shared validators use.
 *
 * This mirrors `@slopcad/cad-sketch`'s `spline-math.ts` DELIBERATELY: the
 * sketch domain and the kernel contract are independent packages (the
 * sketch domain never depends on kernels), so each carries its own copy of
 * the same published evaluation rules — same Catmull-Rom conversion
 * (`b1 = Pᵢ + (Pᵢ₊₁ − Pᵢ₋₁)/6`, `b2 = Pᵢ₊₁ − (Pᵢ₊₂ − Pᵢ)/6`, clamped
 * ends), same convex-hull flatness bound, same dyadic-parameter vertices.
 * The contract tests pin the two sides to identical tessellations, so the
 * duplication cannot drift.
 */

import type { ProfileSplineFlavor } from "./contract";

/** A 2D point in the profile's local frame (mm). */
export interface SplinePoint2 {
  readonly x: number;
  readonly y: number;
}

/** One cubic Bézier segment: controls b0..b3 (b0/b3 on the curve). */
export interface SplineBezierSegment {
  readonly b0: SplinePoint2;
  readonly b1: SplinePoint2;
  readonly b2: SplinePoint2;
  readonly b3: SplinePoint2;
}

/**
 * Maximum chord deviation of a tessellated spline profile segment (mm):
 * de Casteljau subdivision until both interior controls sit within this of
 * the chord — the convex-hull bound puts the whole sub-curve within it.
 */
export const PROFILE_SPLINE_DEFLECTION_MM = 0.01;

/** Maximum de Casteljau subdivision depth per Bézier segment. */
export const PROFILE_SPLINE_MAX_DEPTH = 10;

function at(
  points: readonly (readonly [number, number])[],
  index: number,
): SplinePoint2 {
  const clamped = Math.max(0, Math.min(points.length - 1, index));
  const point = points[clamped];
  if (point === undefined) {
    throw new RangeError("Spline points are dense (validated upstream).");
  }
  return { x: point[0], y: point[1] };
}

/**
 * The spline's cubic Bézier chain: `control` points ARE the polybezier
 * controls (counts 4, 7, 10, …); `interpolated` points are Catmull-Rom fit
 * points converted per-span.
 */
export function splineBezierChain(
  flavor: ProfileSplineFlavor,
  points: readonly (readonly [number, number])[],
): readonly SplineBezierSegment[] {
  if (flavor === "control") {
    const segments: SplineBezierSegment[] = [];
    for (let k = 0; 3 * k + 3 < points.length; k += 1) {
      segments.push({
        b0: at(points, 3 * k),
        b1: at(points, 3 * k + 1),
        b2: at(points, 3 * k + 2),
        b3: at(points, 3 * k + 3),
      });
    }
    return segments;
  }
  const segments: SplineBezierSegment[] = [];
  for (let i = 0; i + 1 < points.length; i += 1) {
    const p0 = at(points, i - 1);
    const p1 = at(points, i);
    const p2 = at(points, i + 1);
    const p3 = at(points, i + 2);
    segments.push({
      b0: p1,
      b1: { x: p1.x + (p2.x - p0.x) / 6, y: p1.y + (p2.y - p0.y) / 6 },
      b2: { x: p2.x - (p3.x - p1.x) / 6, y: p2.y - (p3.y - p1.y) / 6 },
      b3: p2,
    });
  }
  return segments;
}

/** Evaluates one Bézier segment at `t ∈ [0, 1]` (exact parametric point). */
export function splineSegmentPoint(
  segment: SplineBezierSegment,
  t: number,
): SplinePoint2 {
  const u = 1 - t;
  const w0 = u * u * u;
  const w1 = 3 * u * u * t;
  const w2 = 3 * u * t * t;
  const w3 = t * t * t;
  return {
    x:
      w0 * segment.b0.x +
      w1 * segment.b1.x +
      w2 * segment.b2.x +
      w3 * segment.b3.x,
    y:
      w0 * segment.b0.y +
      w1 * segment.b1.y +
      w2 * segment.b2.y +
      w3 * segment.b3.y,
  };
}

function distanceFromLine(
  point: SplinePoint2,
  a: SplinePoint2,
  b: SplinePoint2,
): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const length = Math.hypot(dx, dy);
  if (length === 0) return Math.hypot(point.x - a.x, point.y - a.y);
  return Math.abs((point.x - a.x) * dy - (point.y - a.y) * dx) / length;
}

/**
 * The spline's chord form at the fixed deflection: vertices ON the true
 * curve at their exact dyadic parameters, every chord within
 * {@link PROFILE_SPLINE_DEFLECTION_MM} of the sub-curve. Deterministic.
 */
export function tessellateSplineSegment(
  flavor: ProfileSplineFlavor,
  points: readonly (readonly [number, number])[],
): readonly SplinePoint2[] {
  const chain = splineBezierChain(flavor, points);
  const out: SplinePoint2[] = [];
  const flatten = (segment: SplineBezierSegment, depth: number): void => {
    const flat =
      depth >= PROFILE_SPLINE_MAX_DEPTH ||
      (distanceFromLine(segment.b1, segment.b0, segment.b3) <=
        PROFILE_SPLINE_DEFLECTION_MM &&
        distanceFromLine(segment.b2, segment.b0, segment.b3) <=
          PROFILE_SPLINE_DEFLECTION_MM);
    if (flat) {
      out.push(segment.b0);
      return;
    }
    const mid = (a: SplinePoint2, b: SplinePoint2): SplinePoint2 => ({
      x: (a.x + b.x) / 2,
      y: (a.y + b.y) / 2,
    });
    const p01 = mid(segment.b0, segment.b1);
    const p12 = mid(segment.b1, segment.b2);
    const p23 = mid(segment.b2, segment.b3);
    const p012 = mid(p01, p12);
    const p123 = mid(p12, p23);
    const p0123 = mid(p012, p123);
    flatten({ b0: segment.b0, b1: p01, b2: p012, b3: p0123 }, depth + 1);
    flatten({ b0: p0123, b1: p123, b2: p23, b3: segment.b3 }, depth + 1);
  };
  for (const segment of chain) flatten(segment, 0);
  const last = chain[chain.length - 1];
  if (last !== undefined) out.push(last.b3);
  return out;
}

/** The spline's start point (its first stored point — on the curve). */
export function splineStartPoint(
  points: readonly (readonly [number, number])[],
): SplinePoint2 {
  return at(points, 0);
}

/** The spline's end point (its last stored point — on the curve). */
export function splineEndPoint(
  points: readonly (readonly [number, number])[],
): SplinePoint2 {
  return at(points, points.length - 1);
}

/**
 * The structural problems of a spline segment's point list, or `null`:
 * non-finite coordinates, a control flavor whose count is not 4, 7, 10, …,
 * a control flavor with a zero-length Bézier segment, or an interpolated
 * flavor with fewer than two points or coincident consecutive fit points.
 */
export function splinePointsProblem(
  flavor: ProfileSplineFlavor,
  points: readonly (readonly [number, number])[],
): string | null {
  for (const point of points) {
    if (!Number.isFinite(point[0]) || !Number.isFinite(point[1])) {
      return "a spline point has non-finite coordinates";
    }
  }
  if (flavor === "control") {
    if (points.length < 4 || (points.length - 1) % 3 !== 0) {
      return "a control spline's point count must be 4, 7, 10, … (three new points per extra Bézier segment)";
    }
    for (let k = 0; 3 * k + 3 < points.length; k += 1) {
      const a = points[3 * k];
      const b = points[3 * k + 3];
      if (a === undefined || b === undefined) continue;
      if (a[0] === b[0] && a[1] === b[1]) {
        return `Bézier segment ${k + 1} has coincident endpoints`;
      }
    }
    return null;
  }
  if (points.length < 2) {
    return "an interpolated spline needs at least two fit points";
  }
  for (let i = 0; i + 1 < points.length; i += 1) {
    const a = points[i];
    const b = points[i + 1];
    if (a === undefined || b === undefined) continue;
    if (a[0] === b[0] && a[1] === b[1]) {
      return "consecutive spline fit points must be distinct";
    }
  }
  return null;
}
