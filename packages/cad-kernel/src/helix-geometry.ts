/**
 * The analytic helix spine and its screw-solid sweep (Phase 40): the pure,
 * kernel-neutral math every helix consumer shares — the parametrization, the
 * validation battery, the meridian transport, the exact swept-volume
 * integral, and the station rule the tessellating kernels chord at.
 *
 * ## The parametrization (the convention this module pins)
 *
 * The spine lives in a LOCAL frame whose axis is local +z and whose base
 * center sits at the local origin:
 *
 * ```
 * p(t) = R(t)·(cos θ(t)·x̂ + sin θ(t)·ŷ) + h(t)·ẑ,           t ∈ [0, 1]
 * θ(t) = θ₀ + H·τ·t          (τ = 2π·turns, H = +1 right, −1 left)
 * h(t) = pitch·turns·t       (pitch ≥ 0 — handedness carries direction)
 * R(t) = R₀ + taperMm·t      (taper = the TOTAL signed radius change)
 * ```
 *
 * `H = +1` (right-handed) advances along +z while winding counter-clockwise
 * about it (the right-hand rule); `H = −1` winds clockwise. The start angle
 * `θ₀` positions the spine's first point in the local xy plane. A zero pitch
 * with a non-zero taper is the flat ARCHIMEDEAN-CLASS spiral (radius linear
 * in the angle, z constant); a zero pitch AND zero taper is a circle — not a
 * helix, and the battery declines it.
 *
 * ## The meridian transport (the sweep frame the contract pins)
 *
 * The profile is a closed loop drawn in the START MERIDIAN: the local xz
 * plane through the spine's start point, loop coordinates
 * `(u, v) = (radial offset, axial offset)` measured FROM the start point
 * `p(0)`. The sweep carries it by the rigid motion
 *
 * ```
 * M_t(p(0) + u·r̂(θ₀) + v·ẑ) = p(t) + u·r̂(θ(t)) + v·ẑ,
 * r̂(θ) = cos θ·x̂ + sin θ·ŷ,
 * ```
 *
 * i.e. a rotation about the spine axis by the swept angle, plus the
 * translation that carries the start point onto the current spine point.
 * This is THE thread tooth's frame — the ISO thread profile is specified in
 * an axial plane, and the meridian plane is that plane carried along the
 * helix. It is drift-free BY CONSTRUCTION: the rotation is about one fixed
 * axis, so no torsion-induced twist accumulates. (The Frenet trihedron of an
 * untapered helix equals this frame rotated by the CONSTANT lead angle about
 * the radial direction — stable, but never coincident: the Frenet section is
 * perpendicular to the tangent while the meridian never is. Pipe builders
 * therefore cannot produce the meridian solid exactly; the OCCT adapter
 * rules exact transported stations and lofts between them, honestly banded.)
 *
 * ## The screw solid and its exact volume
 *
 * In cylindrical coordinates the swept region is the SCREW SOLID
 * `{(ρ, φ, ζ) : (ρ − R(t), ζ − h(t)) ∈ P where θ(t) ≡ φ (mod 2π)}` — the
 * material at angle φ is the profile P, screwed along the axis with the
 * constant `κ = pitch / (H·2π)` (rotate by ψ, translate by κ·ψ). The
 * parametrization's Jacobian is `|J| = (R(t) + u)·|θ′|` — the taper rate
 * drops out — so with `A` = the profile area, `ū` = its centroid's radial
 * offset, and `R̄ = R₀ + taperMm/2` the mean radius:
 *
 * ```
 * V = τ · A · (R̄ + ū)          (the multiplicity integral)
 * ```
 *
 * which is the SET volume exactly while no two turns' material overlaps —
 * the profile's axial extent ≤ pitch (turns ≤ 1 never overlap; the battery's
 * overlap rule covers the rest). Overlapping turns are legal input (OCCT
 * builds them); the fake kernel's analytic subset declines them with the
 * structured `kernel/helix-turn-overlap` rather than silently overcounting.
 */

import {
  KERNEL_ERROR_CODES,
  type KernelErrorCode,
  type ProfileSegmentInput,
} from "./contract";
import {
  type ProfilePoint2,
  profileLoopProblem,
  tessellateProfileLoop,
} from "./profile-geometry";

/**
 * The canonical (unit-free) helix spine the validators and transport
 * consume: every length in millimetres, every angle in radians. The
 * contract's {@link HelixSpineInput} carries dimensional values; adapters
 * canonicalize through {@link canonicalHelixSpine} exactly once.
 */
export interface CanonicalHelixSpine {
  /** The start radius `R₀`, strictly positive (mm). */
  readonly radiusMm: number;
  /** The axial advance per full turn, non-negative (mm); 0 is a flat spiral. */
  readonly pitchMm: number;
  /** The number of turns, strictly positive; fractional turns are legal. */
  readonly turns: number;
  /** `+1` right-handed (CCW about +z while advancing), `−1` left-handed. */
  readonly handedness: 1 | -1;
  /** The start angle `θ₀` (radians), any finite value. */
  readonly startAngleRad: number;
  /** The TOTAL signed radius change over the spine (mm); R(t) must stay > 0. */
  readonly taperMm: number;
}

/** One turn in radians. */
const TAU = Math.PI * 2;

/**
 * The radial touch tolerance of the axis-crossing rule: a profile edge whose
 * radius reaches the axis within this band touches (legal, the revolve
 * precedent) rather than crosses (rejected).
 */
const HELIX_AXIS_TOUCH_TOLERANCE_MM = 1e-9;

/**
 * The axial slack the turn-overlap rule allows before consecutive turns'
 * material counts as overlapping: an exact equality (extent == pitch) is the
 * boundary where copies merely touch, which the set volume still equals.
 */
const HELIX_TURN_OVERLAP_TOLERANCE_MM = 1e-9;

/**
 * The structured problem a helix sweep rejects with: the contract error code
 * plus the human detail. Kernels return it verbatim (prefixed by their
 * operation name), the bridge carries it into feature diagnostics, and the
 * workbench validation seam surfaces it before anything commits — the
 * sweep/revolve battery discipline.
 */
export interface HelixSweepProblem {
  readonly code: KernelErrorCode;
  readonly message: string;
}

/** The spine's total swept angle (radians, signed by handedness). */
export function helixSweptAngle(spine: CanonicalHelixSpine): number {
  return spine.handedness * TAU * spine.turns;
}

/** The spine's radius at parameter `t` (mm); linear in `t`. */
export function helixRadiusAt(spine: CanonicalHelixSpine, t: number): number {
  return spine.radiusMm + spine.taperMm * t;
}

/** The spine's axial height at parameter `t` (mm); `pitch·turns·t`. */
export function helixHeightAt(spine: CanonicalHelixSpine, t: number): number {
  return spine.pitchMm * spine.turns * t;
}

/** The spine's angle at parameter `t` (radians). */
export function helixAngleAt(spine: CanonicalHelixSpine, t: number): number {
  return spine.startAngleRad + helixSweptAngle(spine) * t;
}

/** The spine point at parameter `t`, in the LOCAL frame (mm). */
export function helixPointAt(
  spine: CanonicalHelixSpine,
  t: number,
): readonly [number, number, number] {
  const angle = helixAngleAt(spine, t);
  const radius = helixRadiusAt(spine, t);
  const height = helixHeightAt(spine, t);
  return [radius * Math.cos(angle), radius * Math.sin(angle), height];
}

/**
 * The meridian transport of one profile point `(u, v)` at parameter `t`
 * (see the module doc): `p(t) + u·r̂(θ(t)) + v·ẑ`, in the LOCAL frame.
 */
export function helixTransportPoint(
  spine: CanonicalHelixSpine,
  u: number,
  v: number,
  t: number,
): readonly [number, number, number] {
  const angle = helixAngleAt(spine, t);
  const radius = helixRadiusAt(spine, t);
  const height = helixHeightAt(spine, t);
  return [
    (radius + u) * Math.cos(angle),
    (radius + u) * Math.sin(angle),
    height + v,
  ];
}

/**
 * Validates the helix sweep BEFORE any kernel geometry, the shared battery
 * every adapter runs (the sweep/revolve discipline): spine parameter rules,
 * profile loop validity in meridian coordinates, and the axis-crossing rule.
 * Returns `null` when the sweep may build.
 *
 * The rules, in order:
 *
 * 1. SPINE degeneracy (`kernel/invalid-helix`): radius ≤ 0, pitch < 0,
 *    non-finite turns, turns ≤ 0, a radius that reaches 0 anywhere on
 *    `[0, 1]` (a cone tip is a revolve, not a helix), or the flat circle
 *    (pitch = 0 AND taper = 0 — constant radius at constant height).
 * 2. PROFILE validity (`kernel/invalid-profile`): the shared structural
 *    loop validator over the loop as drawn in the meridian.
 * 3. AXIS crossing (`kernel/profile-axis-crossing`): the transported
 *    profile must carry material on ONE side of the axis only — the exact
 *    condition is `min_t (R(t) + u_min) ≥ 0`, checked at the radius
 *    extremes (R is linear), with touching legal (the revolve precedent).
 */
export function helixSweepProblem(
  loop: readonly ProfileSegmentInput[],
  spine: CanonicalHelixSpine,
): HelixSweepProblem | null {
  if (!Number.isFinite(spine.radiusMm) || spine.radiusMm <= 0) {
    return {
      code: KERNEL_ERROR_CODES.invalidLength,
      message: `the helix radius must be strictly positive (got ${String(spine.radiusMm)} mm)`,
    };
  }
  if (!Number.isFinite(spine.pitchMm) || spine.pitchMm < 0) {
    return {
      code: KERNEL_ERROR_CODES.invalidHelix,
      message: `the helix pitch must be non-negative — handedness carries the direction (got ${String(spine.pitchMm)} mm)`,
    };
  }
  if (!Number.isFinite(spine.turns) || spine.turns <= 0) {
    return {
      code: KERNEL_ERROR_CODES.invalidHelix,
      message: `the helix needs a strictly positive number of turns (got ${String(spine.turns)})`,
    };
  }
  if (!Number.isFinite(spine.taperMm)) {
    return {
      code: KERNEL_ERROR_CODES.invalidHelix,
      message: `the helix taper must be a finite radius change (got ${String(spine.taperMm)} mm)`,
    };
  }
  if (!Number.isFinite(spine.startAngleRad)) {
    return {
      code: KERNEL_ERROR_CODES.invalidHelix,
      message: "the helix start angle must be finite",
    };
  }
  const minRadius = Math.min(helixRadiusAt(spine, 0), helixRadiusAt(spine, 1));
  if (minRadius <= 0) {
    return {
      code: KERNEL_ERROR_CODES.invalidHelix,
      message: `the tapered radius must stay strictly positive over the spine (it reaches ${String(minRadius)} mm — a cone tip is a revolve, not a helix)`,
    };
  }
  if (spine.pitchMm === 0 && spine.taperMm === 0) {
    return {
      code: KERNEL_ERROR_CODES.invalidHelix,
      message:
        "a zero-pitch, zero-taper spine is a circle, not a helix — revolve or sweep it instead",
    };
  }
  const loopProblem = profileLoopProblem(loop);
  if (loopProblem !== null) {
    return {
      code: KERNEL_ERROR_CODES.invalidProfile,
      message: `the helix profile is invalid: ${loopProblem}`,
    };
  }
  const polygon = helixProfilePolygon(loop);
  let uMin = Infinity;
  for (const vertex of polygon) {
    if (vertex.x < uMin) uMin = vertex.x;
  }
  if (uMin + minRadius < -HELIX_AXIS_TOUCH_TOLERANCE_MM) {
    return {
      code: KERNEL_ERROR_CODES.profileAxisCrossing,
      message: `the profile crosses the helix axis (its least radius ${String(uMin + minRadius)} mm is negative); sweeping it would wrap material through the axis`,
    };
  }
  return null;
}

/**
 * Whether consecutive turns' material overlaps — the boundary where the
 * exact multiplicity volume stops being the set volume (see the module
 * doc). Overlap needs `turns > 1` AND an axial extent beyond one pitch.
 */
export function helixTurnsOverlap(
  loop: readonly ProfileSegmentInput[],
  spine: CanonicalHelixSpine,
): boolean {
  if (spine.turns <= 1) return false;
  const polygon = helixProfilePolygon(loop);
  let vMin = Infinity;
  let vMax = -Infinity;
  for (const vertex of polygon) {
    if (vertex.y < vMin) vMin = vertex.y;
    if (vertex.y > vMax) vMax = vertex.y;
  }
  return vMax - vMin > spine.pitchMm + HELIX_TURN_OVERLAP_TOLERANCE_MM;
}

/**
 * The profile's CCW chord polygon in MERIDIAN coordinates —
 * `(x, y) = (radial offset u, axial offset v)` from the spine start point
 * — at the shared angular deflection (the same tessellation every curved
 * profile segment already chords at).
 */
export function helixProfilePolygon(
  loop: readonly ProfileSegmentInput[],
): readonly ProfilePoint2[] {
  return tessellateProfileLoop(loop);
}

/**
 * The EXACT swept volume of the screw solid (the module doc's derivation):
 * `V = τ · A · (R̄ + ū)` with `A` the polygon area, `ū` its radial first
 * moment ratio, `R̄ = R₀ + taper/2` the mean radius. The polygon arrives
 * CCW from {@link helixProfilePolygon}. The caller MUST have declined
 * overlapping turns ({@link helixTurnsOverlap}) — under overlap this value
 * overcounts (it is the multiplicity integral, not the set volume).
 */
export function helixScrewVolume(
  polygon: readonly ProfilePoint2[],
  spine: CanonicalHelixSpine,
): number {
  const signedArea = polygonSignedAreaOf(polygon);
  const area = Math.abs(signedArea);
  const moment = polygonRadialMoment(polygon);
  // The moment carries the winding's sign, so dividing by the SIGNED area
  // yields the centroid's radial offset ū for either winding; the mean
  // radius shift then adds it to R̄ = R₀ + taper/2 (see the module doc).
  const meanRadius = spine.radiusMm + spine.taperMm / 2;
  return (
    Math.abs(helixSweptAngle(spine)) * area * (meanRadius + moment / signedArea)
  );
}

/** The shoelace area of a polygon (signed; CCW is positive). */
function polygonSignedAreaOf(polygon: readonly ProfilePoint2[]): number {
  let area = 0;
  for (let i = 0; i < polygon.length; i += 1) {
    const a = polygon[i];
    const b = polygon[(i + 1) % polygon.length];
    if (a === undefined || b === undefined) continue;
    area += a.x * b.y - b.x * a.y;
  }
  return area / 2;
}

/** The polygon's radial first moment `∫ u dA` (the shoelace-weighted form). */
function polygonRadialMoment(polygon: readonly ProfilePoint2[]): number {
  let moment = 0;
  for (let i = 0; i < polygon.length; i += 1) {
    const a = polygon[i];
    const b = polygon[(i + 1) % polygon.length];
    if (a === undefined || b === undefined) continue;
    moment += (a.x + b.x) * (a.x * b.y - b.x * a.y);
  }
  return moment / 6;
}

/**
 * The screw-solid membership test: whether the world-frame cylindrical
 * coordinates `(ρ, φ, ζ)` carry profile material, checking every 2π branch
 * the swept angle range covers. Exact for tapered and untapered spines
 * alike (θ is strictly monotone in t, so each branch fixes one t, and the
 * taper's radius at that t is linear). `polygon` arrives CCW in meridian
 * coordinates; the tolerance absorbs double-precision noise, the revolve
 * classification discipline.
 */
export function helixScrewContains(
  polygon: readonly ProfilePoint2[],
  spine: CanonicalHelixSpine,
  radius: number,
  angle: number,
  height: number,
  tolerance: number,
): boolean {
  const total = helixSweptAngle(spine);
  const startAngle = spine.startAngleRad;
  const endAngle = startAngle + total;
  const low = Math.min(startAngle, endAngle);
  const high = Math.max(startAngle, endAngle);
  // The branch index range m with θ(t_m) = angle + 2πm ∈ [low, high]:
  // m runs over the finite window the interval spans.
  const mMin = Math.ceil((low - angle) / TAU - 0.5);
  const mMax = Math.floor((high - angle) / TAU + 0.5);
  for (let m = mMin; m <= mMax; m += 1) {
    const branchAngle = angle + TAU * m;
    if (branchAngle < low - 1e-9 || branchAngle > high + 1e-9) continue;
    const t = (branchAngle - startAngle) / total;
    if (t < -1e-9 || t > 1 + 1e-9) continue;
    const u = radius - helixRadiusAt(spine, t);
    const v = height - helixHeightAt(spine, t);
    if (pointInPolygonWithTolerance(polygon, u, v, tolerance)) return true;
  }
  return false;
}

/** The polygon membership of `(u, v)` with a linear slack (mm). */
function pointInPolygonWithTolerance(
  polygon: readonly ProfilePoint2[],
  u: number,
  v: number,
  tolerance: number,
): boolean {
  // The shared ray-cast with a boundary snap: a query within `tolerance` of
  // an edge counts inside (the revolve/sweep classification slack).
  let inside = false;
  const count = polygon.length;
  for (let i = 0, j = count - 1; i < count; j = i, i += 1) {
    const a = polygon[i];
    const b = polygon[j];
    if (a === undefined || b === undefined) continue;
    if (
      Math.abs(a.y - b.y) <= Number.EPSILON &&
      Math.abs(a.x - b.x) <= Number.EPSILON
    ) {
      continue;
    }
    // On-edge test (the perpendicular distance to the segment).
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const lengthSquared = dx * dx + dy * dy;
    const t =
      lengthSquared > 0 ? ((u - a.x) * dx + (v - a.y) * dy) / lengthSquared : 0;
    const clamped = Math.min(1, Math.max(0, t));
    const px = a.x + clamped * dx;
    const py = a.y + clamped * dy;
    if ((u - px) * (u - px) + (v - py) * (v - py) <= tolerance * tolerance) {
      return true;
    }
    if (
      a.y > v !== b.y > v &&
      u < ((b.x - a.x) * (v - a.y)) / (b.y - a.y) + a.x
    ) {
      inside = !inside;
    }
  }
  return inside;
}

/**
 * The maximum of `cos θ` over a signed angular interval `[start, start +
 * span]` (span ≠ 0): the endpoints, plus 0 where the interval crosses it
 * (a full-or-more turn interval always returns 1).
 */
function maxCosOverAngleInterval(start: number, span: number): number {
  if (Math.abs(span) >= TAU - 1e-12) return 1;
  const low = Math.min(start, start + span);
  const high = Math.max(start, start + span);
  let best = Math.max(Math.cos(low), Math.cos(high));
  // Every multiple of 2π inside (low, high) contributes cos = 1.
  const firstUp = Math.ceil(low / TAU) * TAU;
  if (firstUp <= high) best = 1;
  return best;
}

/**
 * The minimum of `cos θ` over a signed angular interval: the negated
 * maximum of `cos` over the interval shifted by π (cos(θ + π) = −cos θ).
 */
function minCosOverAngleInterval(start: number, span: number): number {
  return -maxCosOverAngleInterval(start + Math.PI, span);
}

/**
 * The UNTAPERED screw solid's tight world AABB in the LOCAL frame: the
 * radius band `[R₀ + u_min, R₀ + u_max]` swept over the angular interval
 * `[θ₀, θ₀ + τ]` (the band is angle-independent when the taper is zero —
 * tight by construction), and the axial span
 * `[v_min, v_max + pitch·turns]`.
 */
export function helixUntaperedLocalBounds(
  polygon: readonly ProfilePoint2[],
  spine: CanonicalHelixSpine,
): {
  readonly min: readonly [number, number, number];
  readonly max: readonly [number, number, number];
} {
  let uMin = Infinity;
  let uMax = -Infinity;
  let vMin = Infinity;
  let vMax = -Infinity;
  for (const vertex of polygon) {
    if (vertex.x < uMin) uMin = vertex.x;
    if (vertex.x > uMax) uMax = vertex.x;
    if (vertex.y < vMin) vMin = vertex.y;
    if (vertex.y > vMax) vMax = vertex.y;
  }
  const radiusMin = Math.max(0, spine.radiusMm + uMin);
  const radiusMax = spine.radiusMm + uMax;
  const span = helixSweptAngle(spine);
  const start = spine.startAngleRad;
  const xMax = radiusMax * maxCosOverAngleInterval(start, span);
  const xMin = radiusMax * minCosOverAngleInterval(start, span);
  const yMax = radiusMax * maxCosOverAngleInterval(start - Math.PI / 2, span);
  const yMin = radiusMax * minCosOverAngleInterval(start - Math.PI / 2, span);
  // A radius band reaching the axis puts the axis line itself inside the
  // solid's closure — 0 joins both lateral extents. Otherwise the extents
  // come from the band's angular support alone.
  const touchesAxis = radiusMin <= 0;
  return {
    min: [
      Math.min(xMin, touchesAxis ? 0 : xMin),
      Math.min(yMin, touchesAxis ? 0 : yMin),
      vMin,
    ],
    max: [
      Math.max(xMax, touchesAxis ? 0 : xMax),
      Math.max(yMax, touchesAxis ? 0 : yMax),
      vMax + helixHeightAt(spine, 1),
    ],
  };
}

/**
 * The station rule the tessellating consumers chord the spine at (the
 * shared deflection discipline): one station per
 * {@link PROFILE_STATION_ANGLE_RAD} of swept angle, never fewer than the
 * two endpoints. Deterministic — the same spine always yields the same
 * station count, which is what the fake kernel's byte-determinism pins
 * ride on.
 */
export const PROFILE_STATION_ANGLE_RAD = 0.1;

/** The station parameters `t` of the spine, in increasing order. */
export function helixStations(spine: CanonicalHelixSpine): readonly number[] {
  const total = Math.abs(helixSweptAngle(spine));
  const intervals = Math.max(1, Math.ceil(total / PROFILE_STATION_ANGLE_RAD));
  const stations: number[] = [];
  for (let i = 0; i <= intervals; i += 1) {
    stations.push(i / intervals);
  }
  return stations;
}
