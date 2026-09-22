/**
 * The pure wire geometry of 3D curve entities (Phase 47): the canonical
 * parametrizations, the deterministic station walks, the analytic lengths,
 * and the parallel-transport frames every kernel shares. This module is
 * KERNEL-INDEPENDENT MATH — no engine, no allocation order dependence, no
 * clock — so every adapter that answers a wire question returns the
 * identical value (the cross-kernel equivalence fixtures pin byte equality,
 * the `path-geometry` precedent).
 *
 * ## Conventions (documented, deterministic)
 *
 * - A curve's payload is the shared {@link SerializedCurve} schema (one
 *   source of truth: the document record stores it, the kernel op consumes
 *   it). Canonicalization turns its serialized dimensional fields into
 *   millimetres/radians exactly once.
 * - The INTERPOLATED spline is a natural cubic per coordinate over
 *   chord-length parameters (the tridiagonal solve, Thomas algorithm):
 *   C2 inside, exact through every declared point — the round-trip
 *   fixture pins the knot stations.
 * - The CONTROL spline is the uniform cubic B-spline over the declared
 *   poles (De Boor): C2 inside, approaching — not passing — the poles.
 * - The HELIX reuses the Phase 40 spine parametrization verbatim (see
 *   `helix-geometry.ts`), placed at `origin` along a normalized `axis`
 *   with the deterministic secondary-axis rule: the frame's x̂ is the
 *   normalized rejection of the world axis LEAST aligned with `axis`
 *   (axis order z, y, x — so +z keeps the identity frame).
 * - The EQUATION curve evaluates the payload's parsed ASTs with the
 *   single binding `t` (dimensionless) at fixed station counts.
 * - Stations: splines sample each knot span at
 *   {@link CURVE_STATIONS_PER_SPAN} interior breakpoints; helices reuse
 *   the Phase 40 shared-deflection rule (`helixStations`); equations
 *   sample {@link CURVE_EQUATION_STATIONS} uniform parameters. The same
 *   payload always yields the same polyline — the byte-determinism law.
 * - Length: the untapered helix is the closed form
 *   `turns·√((2πR)² + pitch²)`; every other curve reports the chord sum
 *   of its own station polyline — a deterministic LOWER bound within the
 *   documented chord band (halving the station spacing roughly halves the
 *   deficit; the fixtures pin the band).
 */

import {
  type CurvePoint3,
  type EquationCurveAst,
  type SerializedCurve,
  type SerializedDimensionalValue,
  curveRecordProblems,
  dimensionless,
  evaluateExpression,
  factorToCanonical,
  fail,
  ok,
  type ParseResult,
  parseEquationCurveAst,
  valueIn,
} from "@slopcad/cad-core";

import { type CanonicalHelixSpine, helixStations } from "./helix-geometry";

/** A canonical 3D point/Vector in millimetres. */
export type WireVec3 = readonly [number, number, number];

/** The canonical (mm/rad) form of a curve payload. */
export type CanonicalCurve =
  | {
      readonly kind: "interpolated-spline";
      readonly points: readonly WireVec3[];
    }
  | {
      readonly kind: "control-spline";
      readonly points: readonly WireVec3[];
    }
  | {
      readonly kind: "helix";
      readonly spine: CanonicalHelixSpine;
      readonly origin: WireVec3;
      /** The normalized axis; the frame's x̂ is derived deterministically. */
      readonly axis: WireVec3;
    }
  | {
      readonly kind: "equation";
      readonly tMin: number;
      readonly tMax: number;
      readonly ast: EquationCurveAst;
    };

/** Interior breakpoints sampled per knot span of a spline (inclusive ends). */
export const CURVE_STATIONS_PER_SPAN = 8;

/** Uniform stations sampled over an equation curve's parameter range. */
export const CURVE_EQUATION_STATIONS = 64;

/**
 * Canonicalizes a curve payload: serialized dimensional fields become
 * millimetres/radians, the helix frame is normalized once, and the
 * equation's ASTs are parsed once (re-parsing per station would be both
 * wasteful and a second parse surface). Assumes the payload passed the
 * shared semantic battery (`curveRecordProblems`); degenerate fields the
 * battery already rejects surface here as `NaN`, which every consumer's
 * finiteness check reports.
 */
export function canonicalizeCurve(
  curve: SerializedCurve,
): ParseResult<CanonicalCurve, CurveCanonicalizeError> {
  if (curve.kind === "interpolated-spline" || curve.kind === "control-spline") {
    return ok({
      kind: curve.kind,
      points: curve.points.map((point) => [...point]),
    });
  }
  if (curve.kind === "helix") {
    const axis: WireVec3 =
      curve.axis === undefined ? [0, 0, 1] : normalizeAxis(curve.axis);
    return ok({
      kind: "helix",
      spine: {
        radiusMm: serializedMm(curve.radius),
        pitchMm: serializedMm(curve.pitch),
        turns: curve.turns,
        handedness: curve.handedness,
        startAngleRad:
          curve.startAngle.value * factorToCanonical(curve.startAngle.unit),
        taperMm: curve.taper === undefined ? 0 : serializedMm(curve.taper),
      },
      origin: curve.origin === undefined ? [0, 0, 0] : [...curve.origin],
      axis,
    });
  }
  const ast = parseEquationCurveAst(curve);
  if (!ast.ok) {
    return fail({
      code: "curve/canonicalize-failed",
      message: ast.error.message,
      input: curve,
    });
  }
  return ok({
    kind: "equation",
    tMin: curve.tMin,
    tMax: curve.tMax,
    ast: ast.value,
  });
}

/** Structured failure of {@link canonicalizeCurve} (a curve payload that no longer parses). */
export interface CurveCanonicalizeError {
  readonly code: "curve/canonicalize-failed";
  readonly message: string;
  readonly input: unknown;
}

/** The millimetre magnitude of a serialized length field. */
function serializedMm(field: SerializedDimensionalValue): number {
  return field.value * factorToCanonical(field.unit);
}

/** Normalizes a non-zero axis; a zero vector answers the +z axis. */
function normalizeAxis(axis: CurvePoint3): WireVec3 {
  const norm = Math.sqrt(
    axis[0] * axis[0] + axis[1] * axis[1] + axis[2] * axis[2],
  );
  if (!(norm > 0)) return [0, 0, 1];
  return [axis[0] / norm, axis[1] / norm, axis[2] / norm];
}

/**
 * The deterministic orthonormal frame of a helix axis: x̂ is the
 * normalized rejection of the world axis least aligned with `axis`
 * (smallest |dot|, ties resolved to the earliest of x, y, z), ŷ = axis × x̂.
 * The +z axis keeps the identity frame, so the default helix matches the
 * Phase 40 local-frame parametrization exactly.
 */
export function helixAxisFrame(
  axis: WireVec3,
): readonly [WireVec3, WireVec3, WireVec3] {
  // The world axis LEAST aligned with `axis` (smallest |dot|; ties keep
  // the earliest candidate in x, y, z order), so the +z axis keeps the
  // identity frame — the Phase 40 local-frame parametrization exactly.
  const candidates: readonly WireVec3[] = [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ];
  let best: WireVec3 = candidates[0] ?? [1, 0, 0];
  let bestAbsDot = Infinity;
  for (const candidate of candidates) {
    const dot =
      candidate[0] * axis[0] + candidate[1] * axis[1] + candidate[2] * axis[2];
    if (Math.abs(dot) < bestAbsDot) {
      bestAbsDot = Math.abs(dot);
      best = candidate;
    }
  }
  const dot = best[0] * axis[0] + best[1] * axis[1] + best[2] * axis[2];
  const rejection: WireVec3 = [
    best[0] - dot * axis[0],
    best[1] - dot * axis[1],
    best[2] - dot * axis[2],
  ];
  const xAxis = normalizeAxis(rejection);
  const yAxis: WireVec3 = [
    axis[1] * xAxis[2] - axis[2] * xAxis[1],
    axis[2] * xAxis[0] - axis[0] * xAxis[2],
    axis[0] * xAxis[1] - axis[1] * xAxis[0],
  ];
  return [xAxis, yAxis, axis];
}

/** The natural-cubic-spline coefficients of one coordinate. */
interface CubicSpan {
  readonly a: number;
  readonly b: number;
  readonly c: number;
  readonly d: number;
  readonly t0: number;
  readonly t1: number;
}

/**
 * Solves the natural cubic spline of one coordinate over chord-length
 * knots (the Thomas tridiagonal solve — deterministic, no pivoting
 * variance): C2, exact at every knot. Returns the per-span coefficient
 * table s(t) = a + b·u + c·u² + d·u³ with u = t − t0.
 */
function naturalCubicSpans(
  knots: readonly number[],
  values: readonly number[],
): readonly CubicSpan[] {
  const n = knots.length - 1;
  const h: number[] = [];
  for (let i = 0; i < n; i += 1) {
    h.push((knots[i + 1] ?? 0) - (knots[i] ?? 0));
  }
  // Natural boundary: second derivative zero at both ends.
  const alpha: number[] = Array.from({ length: n }, () => 0);
  for (let i = 1; i < n; i += 1) {
    alpha[i] =
      (3 / (h[i] ?? 1)) * ((values[i + 1] ?? 0) - (values[i] ?? 0)) -
      (3 / (h[i - 1] ?? 1)) * ((values[i] ?? 0) - (values[i - 1] ?? 0));
  }
  const l: number[] = Array.from({ length: n + 1 }, () => 1);
  const mu: number[] = Array.from({ length: n + 1 }, () => 0);
  const z: number[] = Array.from({ length: n + 1 }, () => 0);
  for (let i = 1; i < n; i += 1) {
    const alphaI = alpha[i] ?? 0;
    const hPrev = h[i - 1] ?? 1;
    const zPrev = z[i - 1] ?? 0;
    const muPrev = mu[i - 1] ?? 0;
    const li = 2 * ((knots[i + 1] ?? 0) - (knots[i - 1] ?? 0)) - muPrev * hPrev;
    l[i] = li;
    mu[i] = (h[i] ?? 1) / li;
    z[i] = (alphaI - hPrev * zPrev) / li;
  }
  const c: number[] = Array.from({ length: n + 1 }, () => 0);
  const b: number[] = Array.from({ length: n }, () => 0);
  const d: number[] = Array.from({ length: n }, () => 0);
  for (let j = n - 1; j >= 0; j -= 1) {
    c[j] = (z[j] ?? 0) - (mu[j] ?? 0) * (c[j + 1] ?? 0);
    b[j] =
      ((values[j + 1] ?? 0) - (values[j] ?? 0)) / (h[j] ?? 1) -
      ((h[j] ?? 1) / 3) * ((c[j + 1] ?? 0) + 2 * (c[j] ?? 0));
    d[j] = ((c[j + 1] ?? 0) - (c[j] ?? 0)) / (3 * (h[j] ?? 1));
  }
  const spans: CubicSpan[] = [];
  for (let i = 0; i < n; i += 1) {
    spans.push({
      a: values[i] ?? 0,
      b: b[i] ?? 0,
      c: c[i] ?? 0,
      d: d[i] ?? 0,
      t0: knots[i] ?? 0,
      t1: knots[i + 1] ?? 0,
    });
  }
  return spans;
}

/** Chord-length knots of a point list (monotone; distinct by battery). */
function chordKnots(points: readonly WireVec3[]): readonly number[] {
  const knots: number[] = [0];
  for (let i = 1; i < points.length; i += 1) {
    const previous = points[i - 1];
    const current = points[i];
    if (previous === undefined || current === undefined) continue;
    knots.push(
      (knots[knots.length - 1] ?? 0) +
        Math.sqrt(
          (current[0] - previous[0]) ** 2 +
            (current[1] - previous[1]) ** 2 +
            (current[2] - previous[2]) ** 2,
        ),
    );
  }
  return knots;
}

/** The uniform cubic B-spline basis weight of index i at u ∈ [0, 1). */
function uniformBsplineWeights(
  u: number,
): readonly [number, number, number, number] {
  const u2 = u * u;
  const u3 = u2 * u;
  return [
    (1 - 3 * u + 3 * u2 - u3) / 6,
    (4 - 6 * u2 + 3 * u3) / 6,
    (1 + 3 * u + 3 * u2 - 3 * u3) / 6,
    u3 / 6,
  ];
}

/**
 * The curve's station parameters: the deterministic sample set of
 * {@link canonicalizeCurve}'s kind rules, in increasing order.
 */
export function curveStations(curve: CanonicalCurve): readonly number[] {
  if (curve.kind === "interpolated-spline" || curve.kind === "control-spline") {
    const spans = curve.points.length - 1;
    const stations: number[] = [];
    for (let span = 0; span < spans; span += 1) {
      for (let step = 0; step < CURVE_STATIONS_PER_SPAN; step += 1) {
        stations.push(span + step / CURVE_STATIONS_PER_SPAN);
      }
    }
    stations.push(spans);
    return stations;
  }
  if (curve.kind === "helix") return helixStations(curve.spine);
  const stations: number[] = [];
  for (let i = 0; i <= CURVE_EQUATION_STATIONS; i += 1) {
    stations.push(
      curve.tMin + ((curve.tMax - curve.tMin) * i) / CURVE_EQUATION_STATIONS,
    );
  }
  return stations;
}

function helixLocalPoint(spine: CanonicalHelixSpine, t: number): WireVec3 {
  const radius = spine.radiusMm + spine.taperMm * t;
  const theta =
    spine.startAngleRad + spine.handedness * Math.PI * 2 * spine.turns * t;
  const height = spine.pitchMm * spine.turns * t;
  return [radius * Math.cos(theta), radius * Math.sin(theta), height];
}

/**
 * The curve's point at parameter `t` (a spline span coordinate, a helix
 * fraction, or an equation parameter). Pure float64 arithmetic.
 */
export function curvePointAt(curve: CanonicalCurve, t: number): WireVec3 {
  if (curve.kind === "interpolated-spline" || curve.kind === "control-spline") {
    const points = curve.points;
    if (curve.kind === "control-spline") {
      const spans = points.length - 3;
      const clamped = Math.min(Math.max(t, 0), Math.max(spans, 0));
      const span = Math.min(Math.floor(clamped), Math.max(spans - 1, 0));
      const u = clamped - span;
      const weights = uniformBsplineWeights(u);
      const result: [number, number, number] = [0, 0, 0];
      for (let k = 0; k < 4; k += 1) {
        const pole = points[span + k];
        const weight = weights[k];
        if (pole === undefined || weight === undefined) continue;
        result[0] += weight * pole[0];
        result[1] += weight * pole[1];
        result[2] += weight * pole[2];
      }
      return result;
    }
    const knots = chordKnots(points);
    const spansX = naturalCubicSpans(
      knots,
      points.map((p) => p[0]),
    );
    const spansY = naturalCubicSpans(
      knots,
      points.map((p) => p[1]),
    );
    const spansZ = naturalCubicSpans(
      knots,
      points.map((p) => p[2]),
    );
    // The station coordinate is the SPAN index (the same coordinate
    // curveStations emits); map it onto the chord parameterization.
    const spanCount = spansX.length;
    const clampedSpan = Math.min(Math.max(t, 0), spanCount);
    const index = Math.min(Math.floor(clampedSpan), Math.max(spanCount - 1, 0));
    const fraction = clampedSpan - index;
    const knotLow = knots[index] ?? 0;
    const knotHigh = knots[index + 1] ?? knotLow;
    const clamped = knotLow + fraction * (knotHigh - knotLow);
    const spanX = spansX[index];
    const spanY = spansY[index];
    const spanZ = spansZ[index];
    if (spanX === undefined || spanY === undefined || spanZ === undefined) {
      return [...(points[0] ?? [0, 0, 0])];
    }
    const u = clamped - spanX.t0;
    return [
      spanX.a + spanX.b * u + spanX.c * u * u + spanX.d * u * u * u,
      spanY.a + spanY.b * u + spanY.c * u * u + spanY.d * u * u * u,
      spanZ.a + spanZ.b * u + spanZ.c * u * u + spanZ.d * u * u * u,
    ];
  }
  if (curve.kind === "helix") {
    const local = helixLocalPoint(curve.spine, t);
    const [xAxis, yAxis, zAxis] = helixAxisFrame(curve.axis);
    return [
      curve.origin[0] +
        local[0] * xAxis[0] +
        local[1] * yAxis[0] +
        local[2] * zAxis[0],
      curve.origin[1] +
        local[0] * xAxis[1] +
        local[1] * yAxis[1] +
        local[2] * zAxis[1],
      curve.origin[2] +
        local[0] * xAxis[2] +
        local[1] * yAxis[2] +
        local[2] * zAxis[2],
    ];
  }
  const x = equationLength(curve.ast.x, t);
  const y = equationLength(curve.ast.y, t);
  const z = equationLength(curve.ast.z, t);
  return [x, y, z];
}

/** Evaluates one equation-curve AST at `t`, answering canonical mm. */
function equationLength(node: EquationCurveAst["x"], t: number): number {
  const outcome = evaluateExpression(node, (name) =>
    name === "t" ? dimensionless(t) : undefined,
  );
  if (!outcome.ok) return Number.NaN;
  return valueIn(outcome.value, "mm");
}

/**
 * The curve's unit tangent at parameter `t`, by central differences at the
 * station scale (deterministic: the SAME station spacing the polyline
 * uses, so the G1 battery and the transport frames see one geometry).
 */
export function curveTangentAt(curve: CanonicalCurve, t: number): WireVec3 {
  const stationScale = stationStep(curve);
  const ahead = curvePointAt(curve, t + stationScale / 2);
  const behind = curvePointAt(curve, t - stationScale / 2);
  const delta: [number, number, number] = [
    ahead[0] - behind[0],
    ahead[1] - behind[1],
    ahead[2] - behind[2],
  ];
  return normalizeAxis(delta);
}

function stationStep(curve: CanonicalCurve): number {
  if (curve.kind === "interpolated-spline" || curve.kind === "control-spline") {
    return 1 / CURVE_STATIONS_PER_SPAN;
  }
  if (curve.kind === "helix") {
    const stations = helixStations(curve.spine);
    return 1 / Math.max(1, stations.length - 1);
  }
  return (curve.tMax - curve.tMin) / CURVE_EQUATION_STATIONS;
}

/**
 * The curve's deterministic polyline (the shared tessellation every
 * kernel, the renderer, and the serialization validator re-derive).
 */
export function curvePolyline(curve: CanonicalCurve): readonly WireVec3[] {
  return curveStations(curve).map((t) => curvePointAt(curve, t));
}

/**
 * The curve's length: the closed form for the untapered helix, the chord
 * sum of the station polyline otherwise (the documented lower-bound band).
 */
export function curveLength(curve: CanonicalCurve): number {
  if (curve.kind === "helix" && curve.spine.taperMm === 0) {
    const circumference = Math.PI * 2 * curve.spine.radiusMm;
    return (
      curve.spine.turns *
      Math.sqrt(circumference * circumference + curve.spine.pitchMm ** 2)
    );
  }
  const polyline = curvePolyline(curve);
  let total = 0;
  for (let i = 1; i < polyline.length; i += 1) {
    const previous = polyline[i - 1];
    const current = polyline[i];
    if (previous === undefined || current === undefined) continue;
    total += Math.sqrt(
      (current[0] - previous[0]) ** 2 +
        (current[1] - previous[1]) ** 2 +
        (current[2] - previous[2]) ** 2,
    );
  }
  return total;
}

/** The axis-aligned bounds of the curve's station polyline. */
export function curveBounds(curve: CanonicalCurve): {
  readonly min: WireVec3;
  readonly max: WireVec3;
} {
  const polyline = curvePolyline(curve);
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (const point of polyline) {
    for (let axis = 0; axis < 3; axis += 1) {
      const value = point[axis];
      const lo = min[axis];
      const hi = max[axis];
      if (value === undefined || lo === undefined || hi === undefined) continue;
      if (value < lo) min[axis] = value;
      if (value > hi) max[axis] = value;
    }
  }
  if (!Number.isFinite(min[0])) {
    return { min: [0, 0, 0], max: [0, 0, 0] };
  }
  return { min, max };
}

/** The maximum chord-direction change tolerated at a station joint (rad). */
export const CURVE_G1_TOLERANCE_RAD = 0.25;

/**
 * The generalized G1 battery for wire spines: at every interior station
 * the incoming and outgoing chord directions must agree within
 * {@link CURVE_G1_TOLERANCE_RAD} — a CHORD-scale tolerance set above the
 * shared station rule's turning (a smooth curve turns at most the station
 * angle ≈ 0.1 rad per joint, the Phase 40 deflection; a true kink turns
 * by orders of magnitude more), so the battery flags gross
 * tangent-continuity violations without chasing discretization noise (the
 * contract's tangent-continuity rule carried to 3D — a kinked spine
 * sweeps a different solid in every engine). Answers the index of the
 * first failing station or `null`.
 */
export function wireG1FailureIndex(
  polyline: readonly WireVec3[],
): number | null {
  for (let i = 1; i < polyline.length - 1; i += 1) {
    const previous = polyline[i - 1];
    const current = polyline[i];
    const next = polyline[i + 1];
    if (previous === undefined || current === undefined || next === undefined) {
      continue;
    }
    const incoming = normalizeAxis([
      current[0] - previous[0],
      current[1] - previous[1],
      current[2] - previous[2],
    ]);
    const outgoing = normalizeAxis([
      next[0] - current[0],
      next[1] - current[1],
      next[2] - current[2],
    ]);
    const dot =
      incoming[0] * outgoing[0] +
      incoming[1] * outgoing[1] +
      incoming[2] * outgoing[2];
    if (dot < Math.cos(CURVE_G1_TOLERANCE_RAD)) return i;
  }
  return null;
}

/**
 * One parallel-transport frame station: the transported orthonormal
 * (normal, binormal) pair carried alongside the tangent. Deterministic
 * double-reflection transport (no branch on magnitude): the planar-path
 * special case keeps the frame CONSTANT (the fixed-binormal equivalence
 * with the Phase 26.3 sweep).
 */
export interface TransportFrame {
  readonly point: WireVec3;
  readonly tangent: WireVec3;
  readonly normal: WireVec3;
  readonly binormal: WireVec3;
}

/**
 * The parallel-transport frames along a polyline spine: the initial normal
 * is the deterministic least-aligned-world-axis rejection of the first
 * tangent (the helix frame rule), then double-reflection per step.
 */
export function parallelTransportFrames(
  polyline: readonly WireVec3[],
): readonly TransportFrame[] {
  if (polyline.length === 0) return [];
  const first = polyline[0] ?? [0, 0, 0];
  const second = polyline[1] ?? first;
  const firstTangent = normalizeAxis([
    second[0] - first[0],
    second[1] - first[1],
    second[2] - first[2],
  ]);
  const [xAxis, yAxis] = helixAxisFrame(firstTangent);
  const frames: TransportFrame[] = [
    { point: first, tangent: firstTangent, normal: xAxis, binormal: yAxis },
  ];
  let normal = xAxis;
  for (let i = 1; i < polyline.length; i += 1) {
    const previous = polyline[i - 1] ?? first;
    const current = polyline[i] ?? first;
    const tangent = normalizeAxis([
      current[0] - previous[0],
      current[1] - previous[1],
      current[2] - previous[2],
    ]);
    // Double reflection (Wang et al.): rotate `normal` by the reflection
    // pair v1 = previous + current, v2 = current - previous.
    const v1: WireVec3 = [
      previous[0] + current[0],
      previous[1] + current[1],
      previous[2] + current[2],
    ];
    const v2: WireVec3 = [
      current[0] - previous[0],
      current[1] - previous[1],
      current[2] - previous[2],
    ];
    normal = reflectReflect(normal, v1, v2);
    // Re-orthogonalize against numerical drift (deterministic Gram-Schmidt).
    const dot =
      normal[0] * tangent[0] + normal[1] * tangent[1] + normal[2] * tangent[2];
    const projection: WireVec3 = [
      normal[0] - dot * tangent[0],
      normal[1] - dot * tangent[1],
      normal[2] - dot * tangent[2],
    ];
    normal = normalizeAxis(projection);
    const binormal: WireVec3 = [
      tangent[1] * normal[2] - tangent[2] * normal[1],
      tangent[2] * normal[0] - tangent[0] * normal[2],
      tangent[0] * normal[1] - tangent[1] * normal[0],
    ];
    frames.push({ point: current, tangent, normal, binormal });
  }
  return frames;
}

function reflectReflect(
  vector: WireVec3,
  v1: WireVec3,
  v2: WireVec3,
): WireVec3 {
  const reflected1 = reflect(vector, v1);
  return reflect(reflected1, v2);
}

function reflect(vector: WireVec3, axis: WireVec3): WireVec3 {
  const normSquared = axis[0] * axis[0] + axis[1] * axis[1] + axis[2] * axis[2];
  if (!(normSquared > 0)) return vector;
  const dot =
    (2 * (vector[0] * axis[0] + vector[1] * axis[1] + vector[2] * axis[2])) /
    normSquared;
  return [
    vector[0] - dot * axis[0],
    vector[1] - dot * axis[1],
    vector[2] - dot * axis[2],
  ];
}

/**
 * The shared `wire` operation body (Phase 47): canonicalize the payload,
 * run the semantic battery, and answer the deterministic
 * {@link KernelWire}. Every adapter delegates here — the op is pure
 * kernel-independent math, so all four backends return byte-identical
 * results (the cross-kernel equivalence fixture pins equality, the
 * `path-geometry` precedent) and no capability flag exists for it.
 */
export function evaluateWire(curve: SerializedCurve):
  | {
      readonly ok: true;
      readonly wire: {
        readonly polyline: readonly (readonly [number, number, number])[];
        readonly chains: readonly (readonly (readonly [
          number,
          number,
          number,
        ])[])[];
        readonly length: number;
        readonly bounds: {
          readonly min: readonly [number, number, number];
          readonly max: readonly [number, number, number];
        };
      };
    }
  | {
      readonly ok: false;
      readonly code: "kernel/invalid-profile";
      readonly message: string;
    } {
  const problems = curveRecordProblems(curve);
  if (problems.length > 0) {
    return {
      ok: false,
      code: "kernel/invalid-profile",
      message: `wire rejected the curve payload: ${problems[0]?.message ?? "the curve is semantically invalid."}`,
    };
  }
  const canonical = canonicalizeCurve(curve);
  if (!canonical.ok) {
    return {
      ok: false,
      code: "kernel/invalid-profile",
      message: `wire rejected the curve payload: ${canonical.error.message}`,
    };
  }
  const polyline = curvePolyline(canonical.value);
  for (const point of polyline) {
    if (
      !Number.isFinite(point[0]) ||
      !Number.isFinite(point[1]) ||
      !Number.isFinite(point[2])
    ) {
      return {
        ok: false,
        code: "kernel/invalid-profile",
        message:
          "wire rejected the curve payload: its station walk produced a non-finite point.",
      };
    }
  }
  const bounds = curveBounds(canonical.value);
  return {
    ok: true,
    wire: {
      polyline,
      chains: [polyline],
      length: curveLength(canonical.value),
      bounds: { min: bounds.min, max: bounds.max },
    },
  };
}

// Re-exported for the adapters: the semantic battery is part of the wire
// vocabulary's single surface.
export { curveRecordProblems } from "@slopcad/cad-core";
