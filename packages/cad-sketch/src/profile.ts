/**
 * Profile resolution (Phase 26.1; Phase 36 extension): the sketch →
 * extrudable-profile model. A profile is one or more closed loops of
 * workplane-space segments resolved from a sketch's entities — the input
 * the extrude feature executes on.
 *
 * ## Chain resolution
 *
 * Profile-capable real (non-construction) geometry: lines, arcs, circles,
 * ellipses, elliptical arcs, splines, polygons, and slots. Construction
 * entities are excluded by definition — the Phase 25 carry-note's rule
 * that construction geometry never becomes solid input; points and
 * rectangle records carry no profile boundary of their own (a rectangle's
 * referenced lines participate as the lines they are; a polygon's and a
 * slot's boundaries resolve to their exact constituent primitives — line
 * and arc segments carrying the entity's own id).
 *
 * - A circle or a full ellipse is a closed loop by itself (one segment;
 *   the ellipse's loop area is the exact πab).
 * - Lines, arcs, elliptical arcs, and splines chain by endpoint adjacency
 *   within {@link PROFILE_ENDPOINT_TOLERANCE_MM}; each interior joint
 *   consumes both endpoints, a chain that meets itself closes into a loop.
 * - A chain whose ends do not meet is an open chain — the structured
 *   `sketch/profile-open-chain` failure carries the gap in mm and both
 *   free-end entity ids.
 * - Curved fidelity: ellipse-family segments keep exact analytic areas
 *   (Green's theorem in closed form) and tessellate at
 *   {@link SKETCH_PROFILE_DEFLECTIONS} for self-intersection; spline
 *   segments carry the chord-form Green area within the documented
 *   deflection band.
 *
 * ## Structured failure taxonomy (all JSON-safe, persisted-data stable)
 *
 * - `sketch/profile-empty` — no profile-capable real geometry at all.
 * - `sketch/profile-open-chain` — open entities that never close (gap +
 *   entity ids attached).
 * - `sketch/profile-degenerate` — a zero-length line, a loop of fewer than
 *   three distinct vertices, or a loop whose enclosed area is zero within
 *   {@link PROFILE_MIN_AREA_MM2}.
 * - `sketch/profile-self-intersecting` — resolution-level detection of
 *   exact line×line, line×arc, AND arc×arc crossings (two arcs' underlying
 *   circles meet in at most two closed-form points; a candidate counts
 *   only when it lies within both arcs' sweeps), extended in Phase 36 to
 *   the tessellated kinds: ellipse-family and spline segments cross-check
 *   through their chord polylines at the fixed deflection table. The
 *   kernels themselves make no self-intersection promises — see the kernel
 *   contract's extrude documentation for the per-kernel honesty.
 * - `sketch/profile-multiple-loops` — the extrude form
 *   ({@link resolveExtrudeProfile}) requires exactly one loop; a resolution
 *   with several disjoint loops fails with the loop count attached.
 *
 * Loop winding is preserved as drawn (the signed area is reported);
 * extrusion semantics are winding-independent. Polygons and slots resolve
 * to CCW-ordered boundaries by construction (their signed area is positive).
 */

import type { SketchEntityId } from "./sketch-ids";

import { SKETCH_DIAGNOSTIC_CODES } from "./diagnostics";
import {
  circumcircleOf,
  type LineEntity,
  type SketchEntity,
  type SlotEntity,
  type SplineFlavor,
  type SplinePoint,
} from "./entities";
import {
  SPLINE_TESSELLATION_DEFLECTION_MM,
  tessellateSpline,
} from "./spline-math";

/** A workplane-space profile point (mm). */
export interface ProfilePoint {
  readonly x: number;
  readonly y: number;
}

/** One boundary segment of a resolved profile loop, with its source entity. */
export type ProfileSegment =
  | {
      readonly kind: "line";
      readonly entity: SketchEntityId;
      readonly start: ProfilePoint;
      readonly end: ProfilePoint;
    }
  | {
      readonly kind: "arc";
      readonly entity: SketchEntityId;
      readonly center: ProfilePoint;
      readonly radius: number;
      /** CCW sweep start angle (rad, in [0, 2π)). */
      readonly startAngle: number;
      /** CCW sweep end angle (rad, in [0, 2π)); sweep is (end − start) mod 2π. */
      readonly endAngle: number;
    }
  | {
      readonly kind: "circle";
      readonly entity: SketchEntityId;
      readonly center: ProfilePoint;
      readonly radius: number;
    }
  | {
      readonly kind: "ellipse";
      readonly entity: SketchEntityId;
      readonly center: ProfilePoint;
      readonly radiusX: number;
      readonly radiusY: number;
      /** Rotation of the radiusX axis from workplane +x (rad). */
      readonly rotation: number;
    }
  | {
      readonly kind: "ellipticalArc";
      readonly entity: SketchEntityId;
      readonly center: ProfilePoint;
      readonly radiusX: number;
      readonly radiusY: number;
      readonly rotation: number;
      /** CCW parametric sweep start (rad, in [0, 2π)). */
      readonly startAngle: number;
      /** CCW parametric sweep end (rad, in [0, 2π)); sweep is (end − start) mod 2π. */
      readonly endAngle: number;
    }
  | {
      readonly kind: "spline";
      readonly entity: SketchEntityId;
      readonly flavor: SplineFlavor;
      readonly points: readonly SplinePoint[];
    };

/**
 * The fixed tessellation deflection table (Phase 36), the sketch domain's
 * analog of the kernels' chord discipline (`PROFILE_MAX_SEGMENT_ANGLE_RAD`
 * in `@slopcad/cad-kernel`'s profile-geometry): the ellipse chords keep the
 * turning per chord at or under `ellipseMaxTurningRad` (the parametric
 * step bounds dφ/dt by the axis ratio — max(a/b, b/a)); the spline chords
 * stay within `splineDeflectionMm` of the true curve by the convex-hull
 * flatness bound (see `spline-math.ts`). Identical entities always
 * tessellate identically — the table is data, not adaptive state.
 */
export const SKETCH_PROFILE_DEFLECTIONS = {
  readonly: true,
  ellipseMaxTurningRad: 0.1,
  splineDeflectionMm: SPLINE_TESSELLATION_DEFLECTION_MM,
} as const;

/** A closed loop of profile segments, with its walk-accurate signed area. */
export interface ProfileLoop {
  readonly segments: readonly ProfileSegment[];
  /**
   * The signed area the loop's connected boundary encloses (mm², positive
   * for CCW traversal). Computed along the resolution walk — segments may
   * have been drawn in either direction, so this is measured on the walk,
   * not from the stored draw directions.
   */
  readonly signedArea: number;
}

/** The resolved profiles of a sketch: every closed loop found. */
export interface ResolvedProfile {
  readonly loops: readonly ProfileLoop[];
}

/** Structured failure describing why a profile could not be resolved. */
export interface ProfileError {
  readonly code: string;
  readonly message: string;
  /** The primary offending entity ids, when the failure names entities. */
  readonly related: readonly SketchEntityId[];
  /** JSON-safe failure detail (gap sizes, loop counts, intersection points). */
  readonly data: Readonly<Record<string, number | string>>;
}

type Result<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: ProfileError };

/** Endpoint adjacency tolerance for chain building (mm). */
export const PROFILE_ENDPOINT_TOLERANCE_MM = 1e-6;

/**
 * Loops whose enclosed area's magnitude falls at or below this are
 * degenerate (mm²) — the boundary closes but bounds no material.
 */
export const PROFILE_MIN_AREA_MM2 = 1e-9;

function profileError(
  code: string,
  message: string,
  related: readonly SketchEntityId[] = [],
  data: Readonly<Record<string, number | string>> = {},
): { readonly ok: false; readonly error: ProfileError } {
  return { ok: false, error: { code, message, related, data } };
}

function samePoint(a: ProfilePoint, b: ProfilePoint): boolean {
  return Math.hypot(a.x - b.x, a.y - b.y) <= PROFILE_ENDPOINT_TOLERANCE_MM;
}

function lineEndpoints(entity: LineEntity): {
  readonly start: ProfilePoint;
  readonly end: ProfilePoint;
} {
  return {
    start: { x: entity.x1, y: entity.y1 },
    end: { x: entity.x2, y: entity.y2 },
  };
}

/**
 * The parametric point of an ellipse-family segment at parameter `t`
 * (rad): center + R(rotation)·(radiusX·cos t, radiusY·sin t).
 */
export function ellipsePoint(
  entity: {
    readonly radiusX: number;
    readonly radiusY: number;
    readonly rotation: number;
    readonly center: ProfilePoint;
  },
  t: number,
): ProfilePoint {
  const u = entity.radiusX * Math.cos(t);
  const v = entity.radiusY * Math.sin(t);
  const c = Math.cos(entity.rotation);
  const s = Math.sin(entity.rotation);
  return {
    x: entity.center.x + c * u - s * v,
    y: entity.center.y + s * u + c * v,
  };
}

/** Canonicalizes an angle into [0, 2π). */
function canonicalAngle(angle: number): number {
  const wrapped = angle % (Math.PI * 2);
  return wrapped < 0 ? wrapped + Math.PI * 2 : wrapped;
}

/**
 * The segments an entity contributes to a profile. Polygons and slots
 * resolve to their EXACT constituent primitives (n line segments; the
 * slot's cap arcs, offset arcs, and tangent lines) — analytic geometry, no
 * tessellation; ellipses and splines contribute their native segment kinds
 * (tessellated downstream at the fixed deflection table for
 * self-intersection and Green's chord area).
 */
function segmentsOf(entity: SketchEntity): readonly ProfileSegment[] {
  if (entity.construction) return [];
  switch (entity.kind) {
    case "line": {
      const { start, end } = lineEndpoints(entity);
      return [{ kind: "line", entity: entity.id, start, end }];
    }
    case "arc":
      return [
        {
          kind: "arc",
          entity: entity.id,
          center: { x: entity.cx, y: entity.cy },
          radius: entity.radius,
          startAngle: entity.startAngle,
          endAngle: entity.endAngle,
        },
      ];
    case "circle":
      return [
        {
          kind: "circle",
          entity: entity.id,
          center: { x: entity.cx, y: entity.cy },
          radius: entity.radius,
        },
      ];
    case "ellipse":
      return [
        {
          kind: "ellipse",
          entity: entity.id,
          center: { x: entity.cx, y: entity.cy },
          radiusX: entity.radiusX,
          radiusY: entity.radiusY,
          rotation: entity.rotation,
        },
      ];
    case "ellipticalArc":
      return [
        {
          kind: "ellipticalArc",
          entity: entity.id,
          center: { x: entity.cx, y: entity.cy },
          radiusX: entity.radiusX,
          radiusY: entity.radiusY,
          rotation: entity.rotation,
          startAngle: entity.startAngle,
          endAngle: entity.endAngle,
        },
      ];
    case "spline":
      return [
        {
          kind: "spline",
          entity: entity.id,
          flavor: entity.flavor,
          points: entity.points,
        },
      ];
    case "polygon": {
      // Vertices on the effective circumcircle; the fit mode decides the
      // radius the authored number means.
      const effective =
        entity.fit === "inscribed"
          ? entity.radius
          : entity.radius / Math.cos(Math.PI / entity.sides);
      const vertices: ProfilePoint[] = [];
      for (let k = 0; k < entity.sides; k += 1) {
        const angle = entity.rotation + (Math.PI * 2 * k) / entity.sides;
        vertices.push({
          x: entity.cx + effective * Math.cos(angle),
          y: entity.cy + effective * Math.sin(angle),
        });
      }
      const segments: ProfileSegment[] = [];
      for (let k = 0; k < entity.sides; k += 1) {
        const start = vertices[k];
        const end = vertices[(k + 1) % entity.sides];
        if (start === undefined || end === undefined) continue;
        segments.push({
          kind: "line",
          entity: entity.id,
          start,
          end,
        });
      }
      return segments;
    }
    case "slot":
      return slotSegments(entity);
    case "point":
    case "rectangle":
      return [];
  }
}

/**
 * The slot's exact boundary segments. `straight`: two π-sweep cap arcs and
 * the two parallel tangent lines (a CCW boundary). `arc3`: the outer/inner
 * offset arcs (the centerline circumcircle at R±radius over the
 * through-point angular interval) and the two π-sweep caps centered at the
 * centerline's endpoints. All four pieces are exact arcs.
 */
function slotSegments(entity: SlotEntity): readonly ProfileSegment[] {
  const id = entity.id;
  if (entity.variant === "straight") {
    const theta = Math.atan2(entity.y2 - entity.y1, entity.x2 - entity.x1);
    const half = Math.PI / 2;
    const radial = (angle: number, center: ProfilePoint): ProfilePoint => ({
      x: center.x + entity.radius * Math.cos(angle),
      y: center.y + entity.radius * Math.sin(angle),
    });
    const c1: ProfilePoint = { x: entity.x1, y: entity.y1 };
    const c2: ProfilePoint = { x: entity.x2, y: entity.y2 };
    return [
      // Start cap: the半circle bulging away from the centerline, from the
      // +perpendicular side CCW around to the −perpendicular side.
      {
        kind: "arc",
        entity: id,
        center: c1,
        radius: entity.radius,
        startAngle: canonicalAngle(theta + half),
        endAngle: canonicalAngle(theta + 3 * half),
      },
      // Bottom tangent line C1 → C2 (−perpendicular side).
      {
        kind: "line",
        entity: id,
        start: radial(theta - half, c1),
        end: radial(theta - half, c2),
      },
      // End cap: the半circle bulging past C2.
      {
        kind: "arc",
        entity: id,
        center: c2,
        radius: entity.radius,
        startAngle: canonicalAngle(theta + 3 * half),
        endAngle: canonicalAngle(theta + 5 * half),
      },
      // Top tangent line back.
      {
        kind: "line",
        entity: id,
        start: radial(theta + half, c2),
        end: radial(theta + half, c1),
      },
    ];
  }
  const start = { x: entity.x1, y: entity.y1 };
  const through = { x: entity.x2, y: entity.y2 };
  const end = {
    x: entity.x3 ?? entity.x2,
    y: entity.y3 ?? entity.y2,
  };
  const circumcircle = circumcircleOf(start, through, end);
  // The sketch layer validated the circumcircle at construction; a slot
  // that reaches resolution without one is a structural corruption.
  if (circumcircle === null) {
    throw new RangeError(
      `Arc3 slot ${entity.id} has a collinear centerline at profile resolution; the entity invariant was violated.`,
    );
  }
  const center: ProfilePoint = { x: circumcircle.cx, y: circumcircle.cy };
  const a1 = angleAbout(center, start);
  const a3 = angleAbout(center, end);
  const ccw = circumcircle.ccw === 1;
  // The through-point angular interval, as a CCW arc entity: from a1 to a3
  // when the centerline runs CCW, from a3 back to a1 when it runs CW.
  const intervalStart = ccw ? a1 : a3;
  const intervalEnd = ccw ? a3 : a1;
  // Caps bulge away from the interval: the start cap on the side before a1
  // (relative to travel), the end cap beyond a3.
  const cap1Start = ccw ? a1 + Math.PI : a1;
  const cap3Start = ccw ? a3 : a3 - Math.PI;
  return [
    {
      kind: "arc",
      entity: id,
      center,
      radius: circumcircle.radius + entity.radius,
      startAngle: canonicalAngle(intervalStart),
      endAngle: canonicalAngle(intervalEnd),
    },
    {
      kind: "arc",
      entity: id,
      center: { x: entity.x3 ?? entity.x2, y: entity.y3 ?? entity.y2 },
      radius: entity.radius,
      startAngle: canonicalAngle(cap3Start),
      endAngle: canonicalAngle(cap3Start + Math.PI),
    },
    {
      kind: "arc",
      entity: id,
      center,
      radius: circumcircle.radius - entity.radius,
      startAngle: canonicalAngle(intervalStart),
      endAngle: canonicalAngle(intervalEnd),
    },
    {
      kind: "arc",
      entity: id,
      center: start,
      radius: entity.radius,
      startAngle: canonicalAngle(cap1Start),
      endAngle: canonicalAngle(cap1Start + Math.PI),
    },
  ];
}

/**
 * The forward signed-area contribution of one segment (Green's theorem,
 * path-additive): lines contribute the trapezoid form; an arc from a0 to a1
 * (CCW about its center) contributes ½[r²Δ + cx·r·Δsin − cy·r·Δcos]; a
 * circle is the full 2π sweep. Ellipse-family segments contribute the EXACT
 * closed form ½[cx·(s·u + c·v) − cy·(c·u − s·v) + ab·t] between parameter
 * limits (a full ellipse: exactly πab); a spline contributes Green's
 * theorem on its chord form (the documented deflection band — see
 * {@link SKETCH_PROFILE_DEFLECTIONS}). Traversing the same geometry in
 * reverse negates the contribution.
 */
function segmentAreaContribution(segment: ProfileSegment): number {
  if (segment.kind === "line") {
    return (
      (segment.start.x * segment.end.y - segment.end.x * segment.start.y) / 2
    );
  }
  if (segment.kind === "spline") {
    const vertices = tessellateSpline(segment).map((vertex) => vertex.point);
    let area = 0;
    for (let i = 0; i + 1 < vertices.length; i += 1) {
      const a = vertices[i];
      const b = vertices[i + 1];
      if (a === undefined || b === undefined) continue;
      area += (a.x * b.y - b.x * a.y) / 2;
    }
    return area;
  }
  if (segment.kind === "ellipse" || segment.kind === "ellipticalArc") {
    const a = segment.radiusX;
    const b = segment.radiusY;
    const c = Math.cos(segment.rotation);
    const s = Math.sin(segment.rotation);
    const t0 = segment.kind === "ellipse" ? 0 : segment.startAngle;
    const sweep =
      segment.kind === "ellipse"
        ? Math.PI * 2
        : ellipticalArcSegmentSweep(segment);
    const t1 = t0 + sweep;
    // F(t) = cx·(s·u + c·v) − cy·(c·u − s·v) + ab·t, contribution (F(t1) − F(t0))/2.
    const f = (t: number): number =>
      segment.center.x * (s * a * Math.cos(t) + c * b * Math.sin(t)) -
      segment.center.y * (c * a * Math.cos(t) - s * b * Math.sin(t)) +
      a * b * t;
    return (f(t1) - f(t0)) / 2;
  }
  const sweep = profileSegmentSweep(segment);
  const a0 = segment.kind === "circle" ? 0 : segment.startAngle;
  const a1 = a0 + sweep;
  const { center, radius } = segment;
  return (
    0.5 *
    (radius * radius * (a1 - a0) +
      center.x * radius * (Math.sin(a1) - Math.sin(a0)) -
      center.y * radius * (Math.cos(a1) - Math.cos(a0)))
  );
}

/** The signed area a loop encloses (mm², positive for CCW winding). */
export function profileLoopSignedArea(loop: ProfileLoop): number {
  return loop.signedArea;
}

function arcSegmentSweep(
  segment: Extract<ProfileSegment, { kind: "arc" }>,
): number {
  const sweep = (segment.endAngle - segment.startAngle) % (Math.PI * 2);
  return sweep <= 0 ? sweep + Math.PI * 2 : sweep;
}

function arcPoint(
  center: ProfilePoint,
  radius: number,
  angle: number,
): ProfilePoint {
  return {
    x: center.x + radius * Math.cos(angle),
    y: center.y + radius * Math.sin(angle),
  };
}

/** The angle of `point` about `center`, normalized into [0, 2π). */
function angleAbout(center: ProfilePoint, point: ProfilePoint): number {
  const raw = Math.atan2(point.y - center.y, point.x - center.x);
  return raw < 0 ? raw + Math.PI * 2 : raw;
}

/**
 * Whether `point` lies within the arc's CCW sweep from `startAngle`
 * (endpoints included; exact analytic membership, no tolerance).
 */
function withinArcSweep(
  segment: Extract<ProfileSegment, { kind: "arc" }>,
  point: ProfilePoint,
): boolean {
  const relative =
    (angleAbout(segment.center, point) - segment.startAngle + Math.PI * 2) %
    (Math.PI * 2);
  return relative <= arcSegmentSweep(segment);
}

/** One walk entry: the segment plus whether the walk traverses it reversed. */
interface ChainEntry {
  readonly segment: ProfileSegment;
  readonly reversed: boolean;
}

/** A chain under construction: its walk entries plus both free ends. */
interface Chain {
  readonly entries: readonly ChainEntry[];
  readonly start: ProfilePoint;
  readonly end: ProfilePoint;
}

/** The walk's signed area: segment contributions, negated when reversed. */
function walkArea(entries: readonly ChainEntry[]): number {
  let area = 0;
  for (const entry of entries) {
    area += entry.reversed
      ? -segmentAreaContribution(entry.segment)
      : segmentAreaContribution(entry.segment);
  }
  return area;
}

function segmentStart(segment: ProfileSegment): ProfilePoint {
  if (segment.kind === "line") return segment.start;
  if (segment.kind === "spline") {
    const first = segment.points[0];
    if (first === undefined) {
      throw new RangeError("A profile spline has no points.");
    }
    return first;
  }
  if (segment.kind === "ellipse") return ellipsePoint(segment, 0);
  if (segment.kind === "ellipticalArc")
    return ellipsePoint(segment, segment.startAngle);
  return arcStartOf(segment);
}

function segmentEnd(segment: ProfileSegment): ProfilePoint {
  if (segment.kind === "line") return segment.end;
  if (segment.kind === "spline") {
    const last = segment.points[segment.points.length - 1];
    if (last === undefined) {
      throw new RangeError("A profile spline has no points.");
    }
    return last;
  }
  if (segment.kind === "ellipse") return ellipsePoint(segment, 0);
  if (segment.kind === "ellipticalArc")
    return ellipsePoint(segment, segment.endAngle);
  return arcEndOf(segment);
}

/** The CCW parametric sweep of an elliptical arc segment in (0, 2π). */
function ellipticalArcSegmentSweep(
  segment: Extract<ProfileSegment, { kind: "ellipticalArc" }>,
): number {
  const sweep = (segment.endAngle - segment.startAngle) % (Math.PI * 2);
  return sweep <= 0 ? sweep + Math.PI * 2 : sweep;
}

function arcStartOf(
  segment: Extract<ProfileSegment, { kind: "arc" | "circle" }>,
): ProfilePoint {
  if (segment.kind === "circle")
    return arcPoint(segment.center, segment.radius, 0);
  return arcPoint(segment.center, segment.radius, segment.startAngle);
}

function arcEndOf(
  segment: Extract<ProfileSegment, { kind: "arc" | "circle" }>,
): ProfilePoint {
  if (segment.kind === "circle")
    return arcPoint(segment.center, segment.radius, 0);
  return arcPoint(segment.center, segment.radius, segment.endAngle);
}

/**
 * Appends (or prepends) an open segment onto a chain end that touches it,
 * in either orientation — sketch entities carry no direction guarantee, so
 * a joint may be start-to-start, end-to-end, or either way round. The
 * entry records reversal so the walk's signed area stays exact.
 */
function extendChain(chain: Chain, segment: ProfileSegment): Chain | null {
  if (samePoint(chain.end, segmentStart(segment))) {
    return {
      entries: [...chain.entries, { segment, reversed: false }],
      start: chain.start,
      end: segmentEnd(segment),
    };
  }
  if (samePoint(chain.end, segmentEnd(segment))) {
    return {
      entries: [...chain.entries, { segment, reversed: true }],
      start: chain.start,
      end: segmentStart(segment),
    };
  }
  if (samePoint(chain.start, segmentEnd(segment))) {
    return {
      entries: [{ segment, reversed: false }, ...chain.entries],
      start: segmentStart(segment),
      end: chain.end,
    };
  }
  if (samePoint(chain.start, segmentStart(segment))) {
    return {
      entries: [{ segment, reversed: true }, ...chain.entries],
      start: segmentEnd(segment),
      end: chain.end,
    };
  }
  return null;
}

/**
 * The exact line×line crossing of two line segments, or `null`. The
 * intersection must lie strictly inside both segments (t, u ∈ (0, 1)), so
 * shared-endpoint joints — the chain's own connections — are never
 * crossings, and near-parallel segments with tiny cross products cannot
 * manufacture far-away phantom intersections.
 */
function lineLineCrossing(
  a: ProfilePoint,
  b: ProfilePoint,
  c: ProfilePoint,
  d: ProfilePoint,
): ProfilePoint | null {
  const r = { x: b.x - a.x, y: b.y - a.y };
  const s = { x: d.x - c.x, y: d.y - c.y };
  const denom = r.x * s.y - r.y * s.x;
  if (denom === 0) return null;
  const t = ((c.x - a.x) * s.y - (c.y - a.y) * s.x) / denom;
  const u = ((c.x - a.x) * r.y - (c.y - a.y) * r.x) / denom;
  if (t <= 0 || t >= 1 || u <= 0 || u >= 1) return null;
  return { x: a.x + t * r.x, y: a.y + t * r.y };
}

/**
 * The first line×arc crossing (a transversal intersection of the segment
 * with the arc's CCW sweep, shared endpoints excluded), or `null`.
 */
function lineArcCrossing(
  a: ProfilePoint,
  b: ProfilePoint,
  segment: Extract<ProfileSegment, { kind: "arc" }>,
): ProfilePoint | null {
  const r = { x: b.x - a.x, y: b.y - a.y };
  const f = { x: a.x - segment.center.x, y: a.y - segment.center.y };
  const rr = r.x * r.x + r.y * r.y;
  if (rr === 0) return null;
  const fr = f.x * r.x + f.y * r.y;
  const ff = f.x * f.x + f.y * f.y - segment.radius * segment.radius;
  const discriminant = fr * fr - rr * ff;
  if (discriminant < 0) return null;
  const root = Math.sqrt(discriminant);
  for (const t of [(-fr - root) / rr, (-fr + root) / rr]) {
    if (t <= 0 || t >= 1) continue;
    const point = { x: a.x + t * r.x, y: a.y + t * r.y };
    if (!withinArcSweep(segment, point)) continue;
    if (
      samePoint(point, segmentStart(segment)) ||
      samePoint(point, segmentEnd(segment)) ||
      samePoint(point, a) ||
      samePoint(point, b)
    ) {
      continue;
    }
    return point;
  }
  return null;
}

/**
 * The first arc×arc crossing of two arcs (a point lying within both arcs'
 * CCW sweeps, shared endpoints excluded), or `null`. The two underlying
 * circles meet in at most two points — the closed-form radical-line
 * construction: the chord midpoint sits `a` along the center line
 * (`a = (r₁² − r₂² + d²) / 2d`) and both crossings stand
 * `√(r₁² − a²)` off it perpendicular — and each candidate counts only
 * when it lies within BOTH arcs' sweeps. Concentric arcs (same center)
 * overlap only identically or never — neither is a transversal crossing.
 */
function arcArcCrossing(
  a: Extract<ProfileSegment, { kind: "arc" }>,
  b: Extract<ProfileSegment, { kind: "arc" }>,
): ProfilePoint | null {
  const dx = b.center.x - a.center.x;
  const dy = b.center.y - a.center.y;
  const distance = Math.hypot(dx, dy);
  if (distance === 0) return null;
  if (distance > a.radius + b.radius) return null;
  if (distance < Math.abs(a.radius - b.radius)) return null;
  const along =
    (a.radius * a.radius - b.radius * b.radius + distance * distance) /
    (2 * distance);
  const offSquared = a.radius * a.radius - along * along;
  if (offSquared < 0) return null;
  const off = Math.sqrt(offSquared);
  const baseX = a.center.x + (along * dx) / distance;
  const baseY = a.center.y + (along * dy) / distance;
  for (const sign of [1, -1]) {
    const point = {
      x: baseX + (sign * off * dy) / distance,
      y: baseY - (sign * off * dx) / distance,
    };
    if (!withinArcSweep(a, point) || !withinArcSweep(b, point)) continue;
    if (
      samePoint(point, segmentStart(a)) ||
      samePoint(point, segmentEnd(a)) ||
      samePoint(point, segmentStart(b)) ||
      samePoint(point, segmentEnd(b))
    ) {
      continue;
    }
    return point;
  }
  return null;
}

/** The chord polyline of a tessellated segment (vertices on the true curve). */
function tessellatedChords(
  segment: Extract<
    ProfileSegment,
    { kind: "ellipse" | "ellipticalArc" | "spline" }
  >,
): readonly ProfilePoint[] {
  if (segment.kind === "spline") {
    return tessellateSpline(segment).map((vertex) => vertex.point);
  }
  const sweep =
    segment.kind === "ellipse"
      ? Math.PI * 2
      : ellipticalArcSegmentSweep(segment);
  // dφ/dt ≤ max(a/b, b/a) over the ellipse, so this parametric step keeps
  // every chord's turning at or under SKETCH_PROFILE_DEFLECTIONS.ellipseMaxTurningRad.
  const ratio = Math.max(
    segment.radiusX / segment.radiusY,
    segment.radiusY / segment.radiusX,
  );
  const step = SKETCH_PROFILE_DEFLECTIONS.ellipseMaxTurningRad / ratio;
  const divisions = Math.max(1, Math.ceil(sweep / step));
  const t0 = segment.kind === "ellipse" ? 0 : segment.startAngle;
  const points: ProfilePoint[] = [];
  for (let i = 0; i <= divisions; i += 1) {
    points.push(ellipsePoint(segment, t0 + (sweep * i) / divisions));
  }
  return points;
}

/**
 * Detects a line×line, line×arc, or arc×arc crossing inside one loop's
 * segments (shared joints excluded — those are the chain's own
 * connections), extended to the tessellated kinds: ellipse-family and
 * spline segments cross-check through their chord polylines at the fixed
 * deflection table (vertices on the true curves), against each other and
 * against the analytic line/arc/circle segments — strict-interior chord
 * crossings, so shared joints never count and a curvature-scale touch the
 * chords cannot resolve is outside the detection's honesty (the documented
 * deflection band).
 */
function firstSelfCrossing(loop: ProfileLoop): {
  readonly first: SketchEntityId;
  readonly second: SketchEntityId;
  readonly at: ProfilePoint;
} | null {
  const segments = loop.segments;
  for (let i = 0; i < segments.length; i += 1) {
    const first = segments[i];
    if (first === undefined) continue;
    for (let j = i + 1; j < segments.length; j += 1) {
      const second = segments[j];
      if (second === undefined) continue;
      // Adjacent segments share a joint by construction; skip that pair.
      if (j === i + 1 || (i === 0 && j === segments.length - 1)) {
        continue;
      }
      if (first.kind === "line" && second.kind === "line") {
        const at = lineLineCrossing(
          first.start,
          first.end,
          second.start,
          second.end,
        );
        if (at !== null) {
          return { first: first.entity, second: second.entity, at };
        }
      }
      if (first.kind === "line" && second.kind === "arc") {
        const at = lineArcCrossing(first.start, first.end, second);
        if (at !== null) {
          return { first: first.entity, second: second.entity, at };
        }
      }
      if (first.kind === "arc" && second.kind === "line") {
        const at = lineArcCrossing(second.start, second.end, first);
        if (at !== null) {
          return { first: first.entity, second: second.entity, at };
        }
      }
      if (first.kind === "arc" && second.kind === "arc") {
        const at = arcArcCrossing(first, second);
        if (at !== null) {
          return { first: first.entity, second: second.entity, at };
        }
      }
    }
  }
  // The tessellated battery: every pair with at least one tessellated
  // operand (ellipse family or spline), chords against chords, chords
  // against analytic segments. Chords of one tessellated segment may cross
  // each other (a genuinely self-intersecting spline) — those pairs are
  // included on purpose; only shared-joint touches are excluded, by the
  // strict-interior crossing rule itself.
  const tessellated = segments.flatMap((segment) =>
    segment.kind === "ellipse" ||
    segment.kind === "ellipticalArc" ||
    segment.kind === "spline"
      ? [{ id: segment.entity, points: tessellatedChords(segment) }]
      : [],
  );
  for (let p = 0; p < tessellated.length; p += 1) {
    const piece = tessellated[p];
    if (piece === undefined) continue;
    for (let c = 0; c + 1 < piece.points.length; c += 1) {
      const a = piece.points[c];
      const b = piece.points[c + 1];
      if (a === undefined || b === undefined) continue;
      // Chords against later tessellated pieces, and a piece against its
      // own later chords (self-crossing).
      for (let q = p; q < tessellated.length; q += 1) {
        const other = tessellated[q];
        if (other === undefined) continue;
        const startAt = q === p ? c + 2 : 0;
        for (let d = startAt; d + 1 < other.points.length; d += 1) {
          const u = other.points[d];
          const v = other.points[d + 1];
          if (u === undefined || v === undefined) continue;
          const at = lineLineCrossing(a, b, u, v);
          if (at !== null) {
            return { first: piece.id, second: other.id, at };
          }
        }
      }
      // Chords against every analytic line/arc/circle segment of the loop.
      for (const segment of segments) {
        if (
          segment.kind === "ellipse" ||
          segment.kind === "ellipticalArc" ||
          segment.kind === "spline"
        ) {
          continue;
        }
        if (segment.kind === "line") {
          const at = lineLineCrossing(a, b, segment.start, segment.end);
          if (at !== null) {
            return { first: piece.id, second: segment.entity, at };
          }
          continue;
        }
        if (segment.kind === "arc") {
          const at = lineArcCrossing(a, b, segment);
          if (at !== null) {
            return { first: piece.id, second: segment.entity, at };
          }
          continue;
        }
        const first = chordCircleCrossing(a, b, segment);
        if (first !== null) {
          return { first: piece.id, second: segment.entity, at: first };
        }
      }
    }
  }
  return null;
}

/** The first strictly-interior chord×circle crossing, or `null`. */
function chordCircleCrossing(
  a: ProfilePoint,
  b: ProfilePoint,
  segment: Extract<ProfileSegment, { kind: "circle" }>,
): ProfilePoint | null {
  const r = { x: b.x - a.x, y: b.y - a.y };
  const f = { x: a.x - segment.center.x, y: a.y - segment.center.y };
  const rr = r.x * r.x + r.y * r.y;
  if (rr === 0) return null;
  const fr = f.x * r.x + f.y * r.y;
  const ff = f.x * f.x + f.y * f.y - segment.radius * segment.radius;
  const discriminant = fr * fr - rr * ff;
  if (discriminant < 0) return null;
  const root = Math.sqrt(discriminant);
  for (const t of [(-fr - root) / rr, (-fr + root) / rr]) {
    if (t <= 0 || t >= 1) continue;
    return { x: a.x + t * r.x, y: a.y + t * r.y };
  }
  return null;
}

/**
 * Counts a closed chain's distinct WALK vertices: each entry's walk-start
 * joint (`entry.reversed ? segmentEnd : segmentStart` — the joint the walk
 * actually connects through; a closed chain's vertex cycle is exactly these
 * starts), deduplicated with the module's endpoint-adjacency tolerance.
 * Stored draw-direction starts are not the walk's joints — entities carry
 * no direction guarantee, so keying on them miscounts loops whose segments
 * are drawn emanating from a shared point.
 */
function distinctWalkVertexCount(entries: readonly ChainEntry[]): number {
  const corners: ProfilePoint[] = [];
  for (const entry of entries) {
    const joint = entry.reversed
      ? segmentEnd(entry.segment)
      : segmentStart(entry.segment);
    if (!corners.some((corner) => samePoint(corner, joint))) {
      corners.push(joint);
    }
  }
  return corners.length;
}

/**
 * Resolves a sketch's entities into every closed profile loop, with the
 * structured failures of the module doc. Construction geometry, points,
 * and rectangle records contribute nothing; circles are loops of their own;
 * lines and arcs chain by endpoint adjacency.
 */
export function resolveProfileLoops(
  entities: readonly SketchEntity[],
): Result<ResolvedProfile> {
  const segments: ProfileSegment[] = [];
  for (const entity of entities) {
    segments.push(...segmentsOf(entity));
  }
  const selfClosed = segments.filter(
    (
      segment,
    ): segment is Extract<ProfileSegment, { kind: "circle" | "ellipse" }> =>
      segment.kind === "circle" || segment.kind === "ellipse",
  );
  const open = segments.filter(
    (segment) => segment.kind !== "circle" && segment.kind !== "ellipse",
  );
  if (segments.length === 0) {
    return profileError(
      SKETCH_DIAGNOSTIC_CODES.profileEmpty,
      "The sketch has no profile-capable real geometry: extrusion needs at least one closed loop of lines, arcs, circles, ellipses, or splines (construction geometry is excluded).",
    );
  }
  for (const segment of open) {
    if (
      segment.kind === "line" &&
      Math.hypot(
        segment.end.x - segment.start.x,
        segment.end.y - segment.start.y,
      ) <= PROFILE_ENDPOINT_TOLERANCE_MM
    ) {
      return profileError(
        SKETCH_DIAGNOSTIC_CODES.profileDegenerate,
        `Line entity "${segment.entity}" has zero length; a profile boundary cannot pass through it.`,
        [segment.entity],
      );
    }
  }
  const loops: ProfileLoop[] = selfClosed.map((segment) => ({
    segments: [segment],
    signedArea: segmentAreaContribution(segment),
  }));
  const remaining: ProfileSegment[] = [...open];
  const chains: Chain[] = [];
  while (remaining.length > 0) {
    const seed = remaining.shift();
    if (seed === undefined) break;
    let chain: Chain = {
      entries: [{ segment: seed, reversed: false }],
      start: segmentStart(seed),
      end: segmentEnd(seed),
    };
    // Extend forward and backward until neither end accepts a new segment
    // (the chain is done) or the ends meet (the chain closed).
    let extended = true;
    while (extended && !samePoint(chain.start, chain.end)) {
      extended = false;
      for (let index = 0; index < remaining.length; index += 1) {
        const candidate = remaining[index];
        if (candidate === undefined) continue;
        const next = extendChain(chain, candidate);
        if (next !== null) {
          chain = next;
          remaining.splice(index, 1);
          extended = true;
          break;
        }
      }
    }
    chains.push(chain);
  }
  for (const chain of chains) {
    if (!samePoint(chain.start, chain.end)) {
      const first = chain.entries[0];
      const last = chain.entries[chain.entries.length - 1];
      return profileError(
        SKETCH_DIAGNOSTIC_CODES.profileOpenChain,
        `The profile chain is open: its ends miss by ${Math.hypot(
          chain.end.x - chain.start.x,
          chain.end.y - chain.start.y,
        ).toFixed(
          6,
        )} mm. Close the boundary between "${String(first?.segment.entity ?? "")}" and "${String(last?.segment.entity ?? "")}".`,
        [
          ...(first === undefined ? [] : [first.segment.entity]),
          ...(last === undefined ? [] : [last.segment.entity]),
        ],
        {
          gapMm: Math.hypot(
            chain.end.x - chain.start.x,
            chain.end.y - chain.start.y,
          ),
        },
      );
    }
    const loop: ProfileLoop = {
      segments: chain.entries.map((entry) => entry.segment),
      signedArea: walkArea(chain.entries),
    };
    // A self-crossing is the more specific failure and can masquerade as a
    // zero-area loop, so it is checked before degeneracy.
    if (loop.segments.length >= 2) {
      const crossing = firstSelfCrossing(loop);
      if (crossing !== null) {
        return profileError(
          SKETCH_DIAGNOSTIC_CODES.profileSelfIntersecting,
          `The profile boundary crosses itself at (${crossing.at.x.toFixed(6)}, ${crossing.at.y.toFixed(6)}): entities "${crossing.first}" and "${crossing.second}" intersect. Self-intersecting loops cannot be extruded.`,
          [crossing.first, crossing.second],
          { x: crossing.at.x, y: crossing.at.y },
        );
      }
    }
    const area = Math.abs(loop.signedArea);
    if (
      area <= PROFILE_MIN_AREA_MM2 ||
      distinctWalkVertexCount(chain.entries) < 3
    ) {
      return profileError(
        SKETCH_DIAGNOSTIC_CODES.profileDegenerate,
        `The closed chain through "${String(
          loop.segments.map((segment) => segment.entity).join('", "'),
        )}" encloses no area (area ${area.toExponential(3)} mm²); a profile must bound a face.`,
        loop.segments.map((segment) => segment.entity),
        { areaMm2: area },
      );
    }
    loops.push(loop);
  }
  return { ok: true, value: { loops } };
}

/**
 * The extrude form of profile resolution: exactly one closed loop. A
 * resolution with several disjoint closed loops fails with
 * `sketch/profile-multiple-loops` and the loop count attached — selecting
 * one loop among many is a later phase's interaction, not a silent default.
 */
export function resolveExtrudeProfile(
  entities: readonly SketchEntity[],
): Result<ProfileLoop> {
  const resolved = resolveProfileLoops(entities);
  if (!resolved.ok) return resolved;
  if (resolved.value.loops.length !== 1) {
    return profileError(
      SKETCH_DIAGNOSTIC_CODES.profileMultipleLoops,
      `The sketch resolves to ${String(resolved.value.loops.length)} closed loops; extrusion (Phase 26.1) needs exactly one.`,
      [],
      { loops: resolved.value.loops.length },
    );
  }
  const loop = resolved.value.loops[0];
  if (loop === undefined) {
    return profileError(
      SKETCH_DIAGNOSTIC_CODES.profileEmpty,
      "The sketch resolved no profile loop.",
    );
  }
  return { ok: true, value: loop };
}

/**
 * One walk-oriented segment of a resolved sweep path (Phase 38): the line
 * and arc primitives the kernel contract's path vocabulary carries, each
 * oriented along the resolution walk (an entity drawn against the walk is
 * reported traversed from its far endpoint back to its near one).
 */
export type SweepPathSegment =
  | {
      readonly kind: "line";
      readonly entity: SketchEntityId;
      readonly start: ProfilePoint;
      readonly end: ProfilePoint;
    }
  | {
      readonly kind: "arc";
      readonly entity: SketchEntityId;
      readonly center: ProfilePoint;
      readonly radius: number;
      /**
       * The walk's start angle (rad): the entity's own CCW start when the
       * walk runs forward, its CCW end when the walk reverses the arc.
       */
      readonly startAngle: number;
      /**
       * The walk's end angle (rad): `startAngle + walkSweep`, where
       * {@link SweepPathSegmentArc.walkSweep} carries the sign.
       */
      readonly endAngle: number;
      /**
       * The SIGNED walk sweep (rad, magnitude in (0, 2π]): positive when the
       * walk runs the arc counter-clockwise (the entity's own direction),
       * negative when the walk reverses it.
       */
      readonly walkSweep: number;
    };

/** The resolved sweep path of a sketch: one ordered open (or closed) chain. */
export interface ResolvedSweepPath {
  readonly segments: readonly SweepPathSegment[];
  /**
   * Whether the chain closes on itself (the walk's end meets its start) —
   * the kernel contract's closed ring path, swept capped at nothing.
   */
  readonly closed: boolean;
}

/** The chain-walk of the open (chainable) segments, shared by both resolvers. */
function buildChains(segments: readonly ProfileSegment[]): readonly Chain[] {
  const open = segments.filter(
    (segment) => segment.kind !== "circle" && segment.kind !== "ellipse",
  );
  const remaining: ProfileSegment[] = [...open];
  const chains: Chain[] = [];
  while (remaining.length > 0) {
    const seed = remaining.shift();
    if (seed === undefined) break;
    let chain: Chain = {
      entries: [{ segment: seed, reversed: false }],
      start: segmentStart(seed),
      end: segmentEnd(seed),
    };
    // Extend forward and backward until neither end accepts a new segment
    // (the chain is done) or the ends meet (the chain closed).
    let extended = true;
    while (extended && !samePoint(chain.start, chain.end)) {
      extended = false;
      for (let index = 0; index < remaining.length; index += 1) {
        const candidate = remaining[index];
        if (candidate === undefined) continue;
        const next = extendChain(chain, candidate);
        if (next !== null) {
          chain = next;
          remaining.splice(index, 1);
          extended = true;
          break;
        }
      }
    }
    chains.push(chain);
  }
  return chains;
}

/**
 * The sweep-path form of chain resolution (Phase 38): exactly one connected
 * chain of LINE and ARC entities — the kernel contract's path vocabulary —
 * in walk order, open or closed (a closed chain is the contract's ring
 * path). This is the open-chain sibling of {@link resolveExtrudeProfile}:
 * where profile resolution REFUSES an open chain (`sketch/profile-open-chain`),
 * path resolution is its consumer.
 *
 * Structured failures (persisted-data stable, `sketch/path-*`):
 *
 * - `sketch/path-empty` — no path-capable geometry at all.
 * - `sketch/path-unsupported-entity` — a boundary entity whose resolved
 *   segment kind the path vocabulary cannot carry (circle, ellipse family,
 *   spline — name the entity); polygons and slots participate through their
 *   exact line/arc constituents, construction geometry is excluded.
 * - `sketch/path-degenerate` — a zero-length line segment.
 * - `sketch/path-multiple-chains` — the entities resolve to more than one
 *   connected chain (a path is one connected spine; the count rides the
 *   failure data).
 *
 * The walk's orientation is the path's direction: consumers map the
 * returned segments' workplane coordinates onto the kernel contract's local
 * XZ plane (see the bridge and workbench sweep modules), where the walk
 * start must sit at the local origin with its first tangent along +z — the
 * kernel validates those rules itself; this resolver owns only sketch-side
 * structure.
 */
export function resolveSweepPath(
  entities: readonly SketchEntity[],
): Result<ResolvedSweepPath> {
  const allSegments: ProfileSegment[] = [];
  const unsupported: SketchEntityId[] = [];
  for (const entity of entities) {
    const segments = segmentsOf(entity);
    if (segments.length === 0) continue;
    allSegments.push(...segments);
    for (const segment of segments) {
      if (segment.kind !== "line" && segment.kind !== "arc") {
        if (!unsupported.includes(segment.entity)) {
          unsupported.push(segment.entity);
        }
      }
    }
  }
  if (allSegments.length === 0) {
    return profileError(
      SKETCH_DIAGNOSTIC_CODES.pathEmpty,
      "The sketch has no path-capable geometry: a sweep path needs a connected chain of lines and arcs (construction geometry is excluded).",
    );
  }
  if (unsupported.length > 0) {
    return profileError(
      SKETCH_DIAGNOSTIC_CODES.pathUnsupportedEntity,
      `Entity "${String(
        unsupported[0],
      )}" resolves to a segment kind the sweep-path vocabulary cannot carry (circle, ellipse family, or spline); a path is a chain of lines and arcs.`,
      unsupported,
    );
  }
  for (const segment of allSegments) {
    if (
      segment.kind === "line" &&
      Math.hypot(
        segment.end.x - segment.start.x,
        segment.end.y - segment.start.y,
      ) <= PROFILE_ENDPOINT_TOLERANCE_MM
    ) {
      return profileError(
        SKETCH_DIAGNOSTIC_CODES.pathDegenerate,
        `Line entity "${String(segment.entity)}" has zero length; a sweep path cannot pass through it.`,
        [segment.entity],
      );
    }
  }
  const chains = buildChains(allSegments);
  if (chains.length !== 1) {
    return profileError(
      SKETCH_DIAGNOSTIC_CODES.pathMultipleChains,
      `The sketch resolves to ${String(chains.length)} disconnected chains; a sweep path is ONE connected chain.`,
      [],
      { chains: chains.length },
    );
  }
  const chain = chains[0];
  if (chain === undefined) {
    return profileError(
      SKETCH_DIAGNOSTIC_CODES.pathEmpty,
      "The sketch resolved no path chain.",
    );
  }
  const segments: SweepPathSegment[] = chain.entries.map((entry) => {
    if (entry.segment.kind === "line") {
      const line = entry.segment;
      return entry.reversed
        ? {
            kind: "line",
            entity: line.entity,
            start: line.end,
            end: line.start,
          }
        : {
            kind: "line",
            entity: line.entity,
            start: line.start,
            end: line.end,
          };
    }
    const candidate = entry.segment;
    // The unsupported kinds were refused above; this guard narrows the
    // remaining union to the arc member and answers structurally if a
    // future segment kind ever reaches the walk.
    if (candidate.kind !== "arc") {
      throw new RangeError(
        `Entity "${String(candidate.entity)}" reached the path walk with an unsupported segment kind "${candidate.kind}".`,
      );
    }
    const arc = candidate;
    const sweep = arcSegmentSweep(arc);
    if (!entry.reversed) {
      return {
        kind: "arc",
        entity: arc.entity,
        center: arc.center,
        radius: arc.radius,
        startAngle: arc.startAngle,
        endAngle: canonicalAngle(arc.startAngle + sweep),
        walkSweep: sweep,
      };
    }
    // Reversed walk: the arc is traversed from its CCW end back to its CCW
    // start — the same circle with the negative signed sweep.
    const startAngle = canonicalAngle(arc.startAngle + sweep);
    return {
      kind: "arc",
      entity: arc.entity,
      center: arc.center,
      radius: arc.radius,
      startAngle,
      endAngle: canonicalAngle(startAngle - sweep),
      walkSweep: -sweep,
    };
  });
  return {
    ok: true,
    value: { segments, closed: samePoint(chain.start, chain.end) },
  };
}

/**
 * The full-circle sweep of a circle entity as a loop segment's angular
 * extent (2π); an arc's sweep is its own. Ellipse-family and spline
 * segments carry no circular sweep (their area path is the closed-form /
 * chord Green's theorem), so they report 0 here — they are never routed
 * through the circular area formula.
 */
function profileSegmentSweep(
  segment: Extract<ProfileSegment, { kind: "arc" | "circle" }>,
): number {
  if (segment.kind === "circle") return Math.PI * 2;
  return arcSegmentSweep(segment);
}

/**
 * The tessellated boundary points of one profile segment, at the module's
 * fixed deflection table — the rendering/hit-testing form hosts consume
 * (lines contribute both endpoints; curves sample their true geometry).
 */
export function profileSegmentPolyline(
  segment: ProfileSegment,
): readonly ProfilePoint[] {
  if (segment.kind === "line") return [segment.start, segment.end];
  if (segment.kind === "spline") {
    return tessellateSpline(segment).map((vertex) => vertex.point);
  }
  if (segment.kind === "ellipse" || segment.kind === "ellipticalArc") {
    return tessellatedChords(segment);
  }
  const circular: Extract<ProfileSegment, { kind: "arc" | "circle" }> = segment;
  const sweep = profileSegmentSweep(circular);
  const points: ProfilePoint[] = [];
  const divisions = Math.max(
    8,
    Math.ceil(sweep / SKETCH_PROFILE_DEFLECTIONS.ellipseMaxTurningRad),
  );
  const start = circular.kind === "circle" ? 0 : circular.startAngle;
  for (let i = 0; i <= divisions; i += 1) {
    points.push(
      arcPoint(
        circular.center,
        circular.radius,
        start + (sweep * i) / divisions,
      ),
    );
  }
  return points;
}

/**
 * The tessellated boundary polyline of a BOUNDARY-CARRYING entity (line,
 * arc, circle, ellipse family, spline, polygon, slot) — the workplane
 * points a renderer or hit-tester walks, at the fixed deflection table
 * (construction entities included: rendering styles them, the profile
 * excludes them). Non-boundary kinds (points, rectangle records) return
 * `null`.
 */
export function entityPolyline(
  entity: SketchEntity,
): readonly ProfilePoint[] | null {
  const segments = segmentsOf({ ...entity, construction: false });
  if (segments.length === 0) return null;
  return segments.flatMap(profileSegmentPolyline);
}
