/**
 * Draft-taper geometry (Phase 41): the shared, kernel-neutral math of the
 * extrusion's optional `taper` — the planar INSET of a profile loop's
 * chord polygon and the structured validation battery every kernel runs
 * BEFORE any geometry (`kernel/invalid-taper`, the `revolveCrossesAxis`
 * discipline: one shared validator, identical rejections across engines).
 *
 * The model the contract pins (see `ProfileExtrudeInput.taper`'s field
 * doc): the cross-section at parameter t along the extrusion is the loop
 * inset by `t·H`, `H = height·tan(taper)`; over a straight-segmented
 * polygon this is exactly the two-station ruled morph between the loop and
 * its far inset (the inset corner moves linearly from the base corner to
 * the far-inset corner), so the Simpson/prismoidal volume is exact — and
 * OCCT's `BRepOffsetAPI_DraftAngle` agrees with this model to the last
 * digit on box, cylinder, and CONCAVE L fixtures (probed), which is the
 * evidence the inset semantics — not some per-wall uniform-scale — is the
 * cross-kernel draft.
 */

import { valueIn, type AngleValue } from "@slopcad/cad-core";

import { type ProfileSegmentInput } from "./contract";
import {
  polygonSignedArea,
  type ProfilePoint2,
  tessellateProfileLoop,
} from "./profile-geometry";

/** The taper-angle domain bound: strictly inside ±π/2 (tan must be finite). */
export const TAPER_ANGLE_LIMIT_RAD = Math.PI / 2;

/** Edge-length and area floors for the far inset (mm / mm²). */
const INSET_DEGENERACY_TOLERANCE = 1e-9;

/** One structured taper problem: the shared battery's refusal. */
export interface TaperProblem {
  readonly code: "kernel/invalid-taper";
  readonly message: string;
}

/**
 * Insets a CCW simple polygon by `distance` toward its interior (negative
 * distance = outward): the MITER offset — each edge's supporting line
 * shifts by `distance` along its inward normal (the left normal of the
 * CCW traversal direction), and consecutive shifted lines meet at their
 * intersection. The miter corner model is the one the cross-section
 * family pins (probed: OCCT's `BRepOffsetAPI_DraftAngle` agrees with the
 * miter-area quadratic `A₀ − P₀d + κd²`, concave corners included).
 * Returns `null` when the inset degenerates: parallel adjacent edges, a
 * non-positive-area or winding-flipped result, or an edge whose miter
 * length collapses to zero (the shifted segment flips against its
 * original direction — the offset has passed a wall).
 */
export function insetPolygon(
  polygon: readonly ProfilePoint2[],
  distance: number,
): readonly ProfilePoint2[] | null {
  const count = polygon.length;
  if (count < 3) return null;
  // Each edge i runs v_i → v_{i+1}; the interior of a CCW traversal lies
  // on the edge direction's LEFT, so the INWARD normal is the left normal.
  const lines: {
    readonly point: ProfilePoint2;
    readonly normal: ProfilePoint2;
  }[] = [];
  for (let i = 0; i < count; i += 1) {
    const a = polygon[i];
    const b = polygon[(i + 1) % count];
    if (a === undefined || b === undefined) return null;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const length = Math.hypot(dx, dy);
    if (!(length > INSET_DEGENERACY_TOLERANCE)) return null;
    const nx = -dy / length;
    const ny = dx / length;
    lines.push({
      point: { x: a.x + distance * nx, y: a.y + distance * ny },
      normal: { x: nx, y: ny },
    });
  }
  const inset: ProfilePoint2[] = [];
  for (let i = 0; i < count; i += 1) {
    const prev = lines[(i - 1 + count) % count];
    const current = lines[i];
    if (prev === undefined || current === undefined) return null;
    // Solve prev.point + s·d_prev = current.point + t·d_current for the
    // two shifted lines' intersection, in normal form.
    const dpx = -prev.normal.y;
    const dpy = prev.normal.x;
    const dcx = -current.normal.y;
    const dcy = current.normal.x;
    const den = dpx * dcy - dpy * dcx;
    if (!(Math.abs(den) > INSET_DEGENERACY_TOLERANCE)) return null;
    const rhsX = current.point.x - prev.point.x;
    const rhsY = current.point.y - prev.point.y;
    const s = (rhsX * dcy - rhsY * dcx) / den;
    inset.push({
      x: prev.point.x + s * dpx,
      y: prev.point.y + s * dpy,
    });
  }
  const area = polygonSignedArea(inset);
  if (!(area > INSET_DEGENERACY_TOLERANCE)) return null;
  // Every miter edge must keep its traversal direction: miter edge i runs
  // inset[i] → inset[i+1] on shifted line i, and it must point the SAME
  // way the original edge did — past an edge collapse the flipped segment
  // is the offset crossing a wall, the structural difference between a
  // smaller draft and an inverted one.
  for (let i = 0; i < count; i += 1) {
    const a = polygon[i];
    const b = polygon[(i + 1) % count];
    const u = inset[i];
    const v = inset[(i + 1) % count];
    if (
      a === undefined ||
      b === undefined ||
      u === undefined ||
      v === undefined
    ) {
      return null;
    }
    const miterDot = (v.x - u.x) * (b.x - a.x) + (v.y - u.y) * (b.y - a.y);
    if (!(miterDot > INSET_DEGENERACY_TOLERANCE)) return null;
  }
  return inset;
}

/** Whether two segments properly cross (shared interiors), endpoints aside. */
function segmentsCross(
  a1: ProfilePoint2,
  a2: ProfilePoint2,
  b1: ProfilePoint2,
  b2: ProfilePoint2,
): boolean {
  const orient = (
    p: ProfilePoint2,
    q: ProfilePoint2,
    r: ProfilePoint2,
  ): number => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
  const o1 = orient(a1, a2, b1);
  const o2 = orient(a1, a2, b2);
  const o3 = orient(b1, b2, a1);
  const o4 = orient(b1, b2, a2);
  return o1 * o2 < 0 && o3 * o4 < 0;
}

/**
 * Whether a polygon properly self-intersects: any two non-adjacent edges
 * crossing at interior points (adjacent edges share an endpoint by
 * construction). O(n²) over the chord count — cheap at the shared
 * deflection's polygon sizes.
 */
export function polygonSelfIntersects(
  polygon: readonly ProfilePoint2[],
): boolean {
  const count = polygon.length;
  for (let i = 0; i < count; i += 1) {
    const a1 = polygon[i];
    const a2 = polygon[(i + 1) % count];
    if (a1 === undefined || a2 === undefined) continue;
    // Non-adjacent: skip j = i−1, i, i+1 (mod count).
    for (let j = i + 2; j < count; j += 1) {
      if (i === 0 && j === count - 1) continue;
      const b1 = polygon[j];
      const b2 = polygon[(j + 1) % count];
      if (b1 === undefined || b2 === undefined) continue;
      if (segmentsCross(a1, a2, b1, b2)) return true;
    }
  }
  return false;
}

/**
 * The far-end inset distance of one tapered extrusion: `height·tan(taper)`
 * in millimetres, with the taper read in canonical radians. `null` when
 * the angle is non-finite or at/beyond ±π/2 (the battery reports those).
 */
export function taperInsetDistanceMm(
  heightMm: number,
  taper: AngleValue,
): number | null {
  const radians = valueIn(taper, "rad");
  if (!Number.isFinite(radians)) return null;
  if (Math.abs(radians) >= TAPER_ANGLE_LIMIT_RAD) return null;
  return heightMm * Math.tan(radians);
}

/**
 * The shared taper validation battery (every kernel runs it BEFORE any
 * geometry): a finite taper angle strictly inside ±π/2, and a far-end
 * inset — over the loop's chord polygon — that stays a valid simple loop
 * (positive area, no collapsed edge or degenerate corner, no
 * self-intersection). Straight to the refusal's message: the battery
 * never approximates and never guesses a smaller legal taper.
 */
export function taperedExtrudeProblem(
  loop: readonly ProfileSegmentInput[],
  heightMm: number,
  taper: AngleValue,
): TaperProblem | null {
  const radians = valueIn(taper, "rad");
  if (!Number.isFinite(radians)) {
    return {
      code: "kernel/invalid-taper",
      message:
        "the taper angle's magnitude is not a finite number (in canonical radians).",
    };
  }
  if (Math.abs(radians) >= TAPER_ANGLE_LIMIT_RAD) {
    return {
      code: "kernel/invalid-taper",
      message: `the taper angle ${String(radians)} rad is at or beyond the ±π/2 domain — a wall cannot lean to horizontal or past it.`,
    };
  }
  const inset = taperInsetDistanceMm(heightMm, taper);
  if (inset === null) {
    return {
      code: "kernel/invalid-taper",
      message: "the taper's far-end inset distance is not finite.",
    };
  }
  if (inset === 0) return null;
  let polygon = tessellateProfileLoop(loop);
  if (polygonSignedArea(polygon) < 0) polygon = [...polygon].reverse();
  const far = insetPolygon(polygon, inset);
  if (far === null) {
    return {
      code: "kernel/invalid-taper",
      message: `the taper's far-end inset (${String(inset)} mm) degenerates the profile — an edge collapses, a corner turns, or the loop inverts before the far cap. Reduce the taper angle or the height.`,
    };
  }
  if (polygonSelfIntersects(far)) {
    return {
      code: "kernel/invalid-taper",
      message: `the taper's far-end inset (${String(inset)} mm) self-intersects the profile. Reduce the taper angle or the height.`,
    };
  }
  return null;
}
