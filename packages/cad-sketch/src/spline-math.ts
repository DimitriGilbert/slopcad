/**
 * Spline mathematics (Phase 36): the deterministic curve model behind the
 * `spline` entity — evaluation, gradients, and tessellation — shared by the
 * constraint compiler (residuals), profile resolution, and the workbench
 * canvas view model.
 *
 * ## The curve model
 *
 * Both flavors evaluate through the SAME cubic Bézier chain
 * (`bezierChainOfSpline`):
 *
 * - `control` flavor: the stored points ARE the polybezier controls —
 *   segment k spans stored points `3k … 3k+3` (point counts 4, 7, 10, …).
 * - `interpolated` flavor: the stored points are fit points; the chain is
 *   the exact per-span Bézier equivalent of the uniform Catmull-Rom spline
 *   with clamped (duplicated-endpoint) end conditions:
 *   `b0 = Pᵢ`, `b1 = Pᵢ + (Pᵢ₊₁ − Pᵢ₋₁)/6`, `b2 = Pᵢ₊₁ − (Pᵢ₊₂ − Pᵢ)/6`,
 *   `b3 = Pᵢ₊₁`, with `P₋₁ = P₀` and `P_N = P_{N−1}`.
 *
 * The interpolated conversion is a FIXED SPARSE LINEAR map from fit points
 * to Bézier controls, so curve-point gradients chain exactly onto the fit
 * points (`splinePointGradient`): full variational solving of the interior
 * shape is out of the pinned scope, but every stored point participates in
 * the rows that do exist.
 *
 * ## Tessellation (the fixed deflection discipline)
 *
 * `tessellateSpline` subdivides each Bézier segment by de Casteljau
 * midpoint subdivision until the convex-hull flatness bound holds: the
 * curve's distance from the chord `P0→P3` is at most the max distance of
 * `P1`/`P2` from that chord (the curve lies in the control-point hull), so
 * the criterion `max(d(P1, chord), d(P2, chord)) ≤
 * {@link SPLINE_TESSELLATION_DEFLECTION_MM}` bounds every emitted chord's
 * deviation by the same tolerance — a rigorous band, not a heuristic. The
 * subdivision depth is capped ({@link SPLINE_TESSELLATION_MAX_DEPTH}) so a
 * pathological control polygon cannot blow up the table; identical inputs
 * always produce the identical vertex list (pure function of the points).
 */

import type { SplineEntity, SplinePoint } from "./entities";

/** One cubic Bézier segment: controls b0..b3 (b0/b3 on the curve). */
export interface BezierSegment {
  readonly b0: SplinePoint;
  readonly b1: SplinePoint;
  readonly b2: SplinePoint;
  readonly b3: SplinePoint;
}

/** A Bézier chain plus the flavor it came from (gradient structure differs). */
export interface SplineChain {
  readonly flavor: SplineEntity["flavor"];
  readonly segments: readonly BezierSegment[];
  /** The stored points the chain derives from (fit or control points). */
  readonly points: readonly SplinePoint[];
}

function splineDeriv(
  chain: SplineChain,
): (
  index: number,
) => readonly { readonly point: number; readonly weight: number }[] {
  if (chain.flavor === "control") {
    // The caller addresses a control by its CHAIN index (4·segment + which,
    // mirroring the interpolated flavor's span addressing), but the control
    // flavor packs one segment per three new points: segment k's controls
    // are stored points 3k..3k+3. The identity map was only correct for
    // segment 0 — every later segment landed its gradient on the wrong
    // stored point (or past the end of the point list).
    return (index) => [
      { point: 3 * Math.floor(index / 4) + (index % 4), weight: 1 },
    ];
  }
  return (index) => splineFitDeriv(chain, index);
}
/**
 * The Bézier chain of a spline entity, in segment order. For the
 * `interpolated` flavor the conversion is the Catmull-Rom map above
 * (deterministic; clamped ends).
 */
export function bezierChainOfSpline(entity: {
  readonly flavor: SplineEntity["flavor"];
  readonly points: readonly SplinePoint[];
}): SplineChain {
  const points = entity.points;
  if (entity.flavor === "control") {
    const segments: BezierSegment[] = [];
    for (let k = 0; 3 * k + 3 < points.length; k += 1) {
      const b0 = points[3 * k];
      const b1 = points[3 * k + 1];
      const b2 = points[3 * k + 2];
      const b3 = points[3 * k + 3];
      if (
        b0 === undefined ||
        b1 === undefined ||
        b2 === undefined ||
        b3 === undefined
      ) {
        continue;
      }
      segments.push({ b0, b1, b2, b3 });
    }
    return { flavor: "control", segments, points };
  }
  const at = (index: number): SplinePoint => {
    const clamped = Math.max(0, Math.min(points.length - 1, index));
    const point = points[clamped];
    if (point === undefined) {
      throw new RangeError("Spline fit points are dense (validated upstream).");
    }
    return point;
  };
  const segments: BezierSegment[] = [];
  for (let i = 0; i + 1 < points.length; i += 1) {
    const p0 = at(i - 1);
    const p1 = at(i);
    const p2 = at(i + 1);
    const p3 = at(i + 2);
    segments.push({
      b0: p1,
      b1: {
        x: p1.x + (p2.x - p0.x) / 6,
        y: p1.y + (p2.y - p0.y) / 6,
      },
      b2: {
        x: p2.x - (p3.x - p1.x) / 6,
        y: p2.y - (p3.y - p1.y) / 6,
      },
      b3: p2,
    });
  }
  return { flavor: "interpolated", segments, points };
}

/**
 * The exact gradient of Bézier control `which` (0–3) of `segment` w.r.t. the
 * spline's stored points: control flavor is the identity on points[3k+which];
 * interpolated flavor is the fixed sparse linear combination the
 * Catmull-Rom conversion applies (unclamped coefficients — `add` clamps
 * indices exactly as the conversion does, so boundary spans accumulate the
 * clamped-neighbor weight onto the clamped point).
 */
function splineFitDeriv(
  chain: SplineChain,
  index: number,
): readonly { readonly point: number; readonly weight: number }[] {
  // Control index i of span s maps to fit-point combinations:
  //   c0 = P[s]                     → {s: 1}
  //   c1 = P[s] + (P[s+1] − P[s−1])/6 → {s: 1, s+1: 1/6, s−1: −1/6}
  //   c2 = P[s+1] − (P[s+2] − P[s])/6 → {s: 1/6, s+1: 1, s+2: −1/6}
  //   c3 = P[s+1]                   → {s+1: 1}
  const span = Math.floor(index / 4);
  const which = index % 4;
  const terms = new Map<number, number>();
  const add = (rawIndex: number, weight: number): void => {
    const clamped = Math.max(0, Math.min(chain.points.length - 1, rawIndex));
    terms.set(clamped, (terms.get(clamped) ?? 0) + weight);
  };
  if (which === 0) {
    add(span, 1);
  } else if (which === 1) {
    add(span, 1);
    add(span + 1, 1 / 6);
    add(span - 1, -1 / 6);
  } else if (which === 2) {
    add(span, 1 / 6);
    add(span + 1, 1);
    add(span + 2, -1 / 6);
  } else {
    add(span + 1, 1);
  }
  return [...terms].map(([point, weight]) => ({ point, weight }));
}

/** The Bernstein basis of one cubic segment at `t`. */
function bernstein(t: number): readonly [number, number, number, number] {
  const u = 1 - t;
  return [u * u * u, 3 * u * u * t, 3 * u * t * t, t * t * t];
}

/** Evaluates the chain at (segment, t) — exact parametric point. */
export function evaluateSplinePoint(
  chain: SplineChain,
  segment: number,
  t: number,
): SplinePoint {
  const seg = chain.segments[segment];
  if (seg === undefined) {
    throw new RangeError(`Spline chain has no segment ${String(segment)}.`);
  }
  const [w0, w1, w2, w3] = bernstein(t);
  return {
    x: w0 * seg.b0.x + w1 * seg.b1.x + w2 * seg.b2.x + w3 * seg.b3.x,
    y: w0 * seg.b0.y + w1 * seg.b1.y + w2 * seg.b2.y + w3 * seg.b3.y,
  };
}

/**
 * The gradient of the chain point at (segment, t) w.r.t. the spline's
 * stored points: a sparse map of point index → combined weight, exact
 * (Bernstein weights chained through the flavor's control map). The same
 * weight applies to both axes — the conversion maps x and y identically —
 * so the caller distributes `weight` onto the point's x and y slots alike.
 * For the `control` flavor the indices are the stored control points; for
 * `interpolated` they are the fit points.
 */
export function splinePointGradient(
  chain: SplineChain,
  segment: number,
  t: number,
): ReadonlyMap<number, number> {
  const seg = chain.segments[segment];
  if (seg === undefined) {
    throw new RangeError(`Spline chain has no segment ${String(segment)}.`);
  }
  const weights = bernstein(t);
  const grad = new Map<number, number>();
  const derivative = splineDeriv(chain);
  for (let which = 0; which < 4; which += 1) {
    const w = weights[which];
    if (w === undefined || w === 0) continue;
    for (const term of derivative(4 * segment + which)) {
      grad.set(term.point, (grad.get(term.point) ?? 0) + w * term.weight);
    }
  }
  return grad;
}

/**
 * The derivative Bernstein weights of one cubic segment at `t`:
 * `B'(t) = (−3u², 3(u²−2ut), 3(2ut−t²), 3t²)` with `u = 1 − t` — the four
 * weights sum to exactly 0 (the basis partitions unity), and the first
 * control's weight is always ≤ 0.
 */
function bernsteinDerivative(
  t: number,
): readonly [number, number, number, number] {
  const u = 1 - t;
  return [
    -3 * u * u,
    3 * (u * u - 2 * u * t),
    3 * (2 * u * t - t * t),
    3 * t * t,
  ];
}

/**
 * The chain's tangent (dC/dt) at (segment, t) — the exact derivative, the
 * same evaluation the point gradient chains through. End tangents have the
 * closed forms `C'(0) = 3(b1 − b0)` and `C'(1) = 3(b3 − b2)`, so a control
 * flavor's end tangent is `3(P_1 − P_0)` / `3(P_{N−1} − P_{N−2})` and the
 * interpolated flavor's is the same direction at 1/6 the magnitude.
 */
export function splineTangent(
  chain: SplineChain,
  segment: number,
  t: number,
): { readonly vx: number; readonly vy: number } {
  const seg = chain.segments[segment];
  if (seg === undefined) {
    throw new RangeError(`Spline chain has no segment ${String(segment)}.`);
  }
  const [w0, w1, w2, w3] = bernsteinDerivative(t);
  return {
    vx: w0 * seg.b0.x + w1 * seg.b1.x + w2 * seg.b2.x + w3 * seg.b3.x,
    vy: w0 * seg.b0.y + w1 * seg.b1.y + w2 * seg.b2.y + w3 * seg.b3.y,
  };
}

/**
 * The exact gradient of the tangent at (segment, t) w.r.t. the spline's
 * stored points — the mirror of {@link splinePointGradient} for the
 * derivative weights: `H_i(t) = Σ_j B'_j(t)·M[j][i]`, the same scalar on
 * the point's x and y slots. Sparsity: a control-flavor end tangent touches
 * exactly its two end points with weights (+3, −3); the interpolated flavor
 * touches the same two with (+1/2, −1/2); an interior anchor of an
 * interpolated span touches the 4 neighboring fit points.
 */
export function splineTangentGradient(
  chain: SplineChain,
  segment: number,
  t: number,
): ReadonlyMap<number, number> {
  const seg = chain.segments[segment];
  if (seg === undefined) {
    throw new RangeError(`Spline chain has no segment ${String(segment)}.`);
  }
  const weights = bernsteinDerivative(t);
  const grad = new Map<number, number>();
  const derivative = splineDeriv(chain);
  for (let which = 0; which < 4; which += 1) {
    const w = weights[which];
    if (w === undefined || w === 0) continue;
    for (const term of derivative(4 * segment + which)) {
      grad.set(term.point, (grad.get(term.point) ?? 0) + w * term.weight);
    }
  }
  return grad;
}

/**
 * The strictly interior stationary parameters of a scalar cubic in Bézier
 * form (controls `g0..g3`): the roots in `(0, 1)` of the derivative
 * quadratic, whose Bernstein controls are `3(g_{j+1} − g_j)`, power form
 * `A·t² + B·t + C` with `A = q0 − 2q1 + q2`, `B = 2(q1 − q0)`, `C = q0`.
 * At most two parameters, ascending.
 *
 * Rooting is the Kahan-stable quadratic — with `Q = −(B + sign(B)·√D)/2`
 * the two roots are `Q/A` and `C/Q`, products that never subtract
 * nearly-equal magnitudes — plus a tolerance-based near-linear fallback
 * (`|A| ≤ 1e-12·scale` treats the quadratic term as fp noise and returns
 * the well-conditioned linear root `−C/B`). The naive `(-B ± √D)/2A` form
 * loses the root entirely when `A` is analytically zero but computed as
 * ~1e-14 (catastrophic cancellation sends both roots out of `(0, 1)`),
 * which made the anywhere-tangency anchor jump discontinuously under
 * 1e-6 parameter perturbations. This is the same scalar-cubic machinery
 * the kernel's `certifiedCubicExtremes` leaf carries (the deliberate
 * `spline-math.ts` ↔ `profile-splines.ts` mirror — §8.5).
 */
export function cubicStationaryParameters(
  g0: number,
  g1: number,
  g2: number,
  g3: number,
): readonly number[] {
  const q0 = 3 * (g1 - g0);
  const q1 = 3 * (g2 - g1);
  const q2 = 3 * (g3 - g2);
  const a = q0 - 2 * q1 + q2;
  const b = 2 * (q1 - q0);
  const c = q0;
  const roots: number[] = [];
  const keep = (t: number): void => {
    if (t > 0 && t < 1) roots.push(t);
  };
  const scale = Math.max(Math.abs(a), Math.abs(b), Math.abs(c));
  if (scale === 0) return roots;
  if (Math.abs(a) <= 1e-12 * scale) {
    // (Near-)linear derivative: the t² coefficient is floating-point noise
    // (analytically zero — a true quadratic g). −C/B is the stable limit.
    if (Math.abs(b) > 1e-12 * scale) keep(-c / b);
    return roots.sort((x, y) => x - y);
  }
  const discriminant = b * b - 4 * a * c;
  if (discriminant <= 0) return roots;
  const root = Math.sqrt(discriminant);
  const q = -(b + (b >= 0 ? root : -root)) / 2;
  // Q = 0 would force B = 0 and C = 0, leaving A·t² = 0 — no interior root.
  if (q !== 0) {
    keep(c / q);
    keep(q / a);
  }
  return roots.sort((x, y) => x - y);
}

/** Maximum chord deviation of a tessellated spline (mm). */
export const SPLINE_TESSELLATION_DEFLECTION_MM = 0.01;

/** Maximum de Casteljau subdivision depth per Bézier segment. */
export const SPLINE_TESSELLATION_MAX_DEPTH = 10;

function distanceFromLine(
  point: SplinePoint,
  a: SplinePoint,
  b: SplinePoint,
): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const length = Math.hypot(dx, dy);
  if (length === 0) return Math.hypot(point.x - a.x, point.y - a.y);
  return Math.abs((point.x - a.x) * dy - (point.y - a.y) * dx) / length;
}

function subdivide(segment: BezierSegment): {
  readonly first: BezierSegment;
  readonly second: BezierSegment;
} {
  const mid = (a: SplinePoint, b: SplinePoint): SplinePoint => ({
    x: (a.x + b.x) / 2,
    y: (a.y + b.y) / 2,
  });
  const p01 = mid(segment.b0, segment.b1);
  const p12 = mid(segment.b1, segment.b2);
  const p23 = mid(segment.b2, segment.b3);
  const p012 = mid(p01, p12);
  const p123 = mid(p12, p23);
  const p0123 = mid(p012, p123);
  return {
    first: { b0: segment.b0, b1: p01, b2: p012, b3: p0123 },
    second: { b0: p0123, b1: p123, b2: p23, b3: segment.b3 },
  };
}

function flattenSegment(
  segment: BezierSegment,
  depth: number,
  tLo: number,
  tHi: number,
  out: SplineTessellationVertex[],
  segmentIndex: number,
): void {
  const flat =
    depth >= SPLINE_TESSELLATION_MAX_DEPTH ||
    (distanceFromLine(segment.b1, segment.b0, segment.b3) <=
      SPLINE_TESSELLATION_DEFLECTION_MM &&
      distanceFromLine(segment.b2, segment.b0, segment.b3) <=
        SPLINE_TESSELLATION_DEFLECTION_MM);
  if (flat) {
    // De Casteljau subdivision keeps every emitted point ON the true curve
    // at its exact dyadic parameter (the interval's start).
    out.push({ point: segment.b0, segment: segmentIndex, t: tLo });
    return;
  }
  const { first, second } = subdivide(segment);
  const tMid = (tLo + tHi) / 2;
  flattenSegment(first, depth + 1, tLo, tMid, out, segmentIndex);
  flattenSegment(second, depth + 1, tMid, tHi, out, segmentIndex);
}

/** One tessellated vertex: the workplane point plus its curve parameter. */
export interface SplineTessellationVertex {
  readonly point: SplinePoint;
  readonly segment: number;
  readonly t: number;
}

/**
 * The spline's chord form at the fixed deflection: vertices ON the true
 * curve (Bézier evaluation points at their exact dyadic parameters), every
 * chord within {@link SPLINE_TESSELLATION_DEFLECTION_MM} of the curve (the
 * convex-hull bound). Deterministic — a pure function of the entity's
 * points.
 */
export function tessellateSpline(
  entity: {
    readonly flavor: SplineEntity["flavor"];
    readonly points: readonly SplinePoint[];
  },
  includeLast = true,
): readonly SplineTessellationVertex[] {
  const chain = bezierChainOfSpline(entity);
  const out: SplineTessellationVertex[] = [];
  for (let s = 0; s < chain.segments.length; s += 1) {
    const segment = chain.segments[s];
    if (segment === undefined) continue;
    flattenSegment(segment, 0, 0, 1, out, s);
  }
  if (includeLast && chain.segments.length > 0) {
    const last = chain.segments.length - 1;
    out.push({
      point: evaluateSplinePoint(chain, last, 1),
      segment: last,
      t: 1,
    });
  }
  return out;
}

/** The result of projecting a workplane point onto a spline's chord form. */
export interface SplineProjection {
  readonly segment: number;
  readonly t: number;
  readonly point: SplinePoint;
  /** The distance from the queried point to `point` (mm). */
  readonly distance: number;
}

/**
 * The nearest point of the spline's chord form to `at`, with its (segment,
 * t) parameter — the deterministic projection the point-on-spline residual
 * freezes its gradient at. Vertices are on the true curve; the projection
 * distance to the chord form is within the deflection of the distance to
 * the true curve.
 */
export function projectOntoSpline(
  entity: {
    readonly flavor: SplineEntity["flavor"];
    readonly points: readonly SplinePoint[];
  },
  at: SplinePoint,
): SplineProjection | null {
  const vertices = tessellateSpline(entity);
  let best: SplineProjection | null = null;
  for (let i = 0; i + 1 < vertices.length; i += 1) {
    const a = vertices[i];
    const b = vertices[i + 1];
    if (a === undefined || b === undefined) continue;
    const dx = b.point.x - a.point.x;
    const dy = b.point.y - a.point.y;
    const lengthSquared = dx * dx + dy * dy;
    const u =
      lengthSquared === 0
        ? 0
        : Math.max(
            0,
            Math.min(
              1,
              ((at.x - a.point.x) * dx + (at.y - a.point.y) * dy) /
                lengthSquared,
            ),
          );
    const point = { x: a.point.x + u * dx, y: a.point.y + u * dy };
    const distance = Math.hypot(point.x - at.x, point.y - at.y);
    if (best === null || distance < best.distance) {
      // The projection parameter interpolates the chord's endpoint
      // parameters (both on-curve); intermediate values are chord-linear
      // approximations within the deflection — the frozen-parameter honesty.
      best = {
        segment: u < 1 ? a.segment : b.segment,
        t: a.t + u * (b.t - a.t),
        point,
        distance,
      };
    }
  }
  return best;
}
