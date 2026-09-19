/**
 * Profile resolution (Phase 26.1): the sketch → extrudable-profile model.
 * A profile is one or more closed loops of workplane-space segments resolved
 * from a sketch's entities — the input the extrude feature executes on.
 *
 * ## Chain resolution
 *
 * Profile-capable real (non-construction) geometry: lines, arcs, and
 * circles. Construction entities are excluded by definition — the Phase 25
 * carry-note's rule that construction geometry never becomes solid input;
 * points and rectangle records carry no profile boundary of their own (a
 * rectangle's referenced lines participate as the lines they are).
 *
 * - A circle is a closed loop by itself (one full-circle segment).
 * - Lines and arcs chain by endpoint adjacency within
 *   {@link PROFILE_ENDPOINT_TOLERANCE_MM}; each interior joint consumes both
 *   endpoints, a chain that meets itself closes into a loop.
 * - A chain whose ends do not meet is an open chain — the structured
 *   `sketch/profile-open-chain` failure carries the gap in mm and both
 *   free-end entity ids.
 *
 * ## Structured failure taxonomy (all JSON-safe, persisted-data stable)
 *
 * - `sketch/profile-empty` — no profile-capable real geometry at all.
 * - `sketch/profile-open-chain` — lines/arcs that never close (gap +
 *   entity ids attached).
 * - `sketch/profile-degenerate` — a zero-length line, a loop of fewer than
 *   three distinct vertices, or a loop whose enclosed area is zero within
 *   {@link PROFILE_MIN_AREA_MM2}.
 * - `sketch/profile-self-intersecting` — resolution-level detection of
 *   exact line×line, line×arc, AND arc×arc crossings (two arcs' underlying
 *   circles meet in at most two closed-form points; a candidate counts
 *   only when it lies within both arcs' sweeps). The kernels themselves
 *   make no self-intersection promises — see the kernel contract's
 *   extrude documentation for the per-kernel honesty.
 * - `sketch/profile-multiple-loops` — the extrude form
 *   ({@link resolveExtrudeProfile}) requires exactly one loop; a resolution
 *   with several disjoint loops fails with the loop count attached.
 *
 * Loop winding is preserved as drawn (the signed area is reported); extrusion
 * semantics are winding-independent.
 */

import type { SketchEntity, LineEntity } from "./entities";
import type { SketchEntityId } from "./sketch-ids";

import { SKETCH_DIAGNOSTIC_CODES } from "./diagnostics";

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
    };

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

/** The segments an entity contributes to a profile (empty for non-boundary kinds). */
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
    case "point":
    case "rectangle":
      return [];
  }
}

/**
 * The forward signed-area contribution of one segment (Green's theorem,
 * path-additive): lines contribute the trapezoid form; an arc from a0 to a1
 * (CCW about its center) contributes ½[r²Δ + cx·r·Δsin − cy·r·Δcos]; a
 * circle is the full 2π sweep. Traversing the same geometry in reverse
 * negates the contribution.
 */
function segmentAreaContribution(segment: ProfileSegment): number {
  if (segment.kind === "line") {
    return (
      (segment.start.x * segment.end.y - segment.end.x * segment.start.y) / 2
    );
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
  return segment.kind === "line" ? segment.start : arcStartOf(segment);
}

function segmentEnd(segment: ProfileSegment): ProfilePoint {
  return segment.kind === "line" ? segment.end : arcEndOf(segment);
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

/**
 * Detects a line×line, line×arc, or arc×arc crossing inside one loop's
 * segments (shared joints excluded — those are the chain's own
 * connections).
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
  return null;
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
  const circles = segments.filter(
    (segment): segment is Extract<ProfileSegment, { kind: "circle" }> =>
      segment.kind === "circle",
  );
  const open = segments.filter((segment) => segment.kind !== "circle");
  if (segments.length === 0) {
    return profileError(
      SKETCH_DIAGNOSTIC_CODES.profileEmpty,
      "The sketch has no profile-capable real geometry: extrusion needs at least one closed loop of lines, arcs, or circles (construction geometry is excluded).",
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
  const loops: ProfileLoop[] = circles.map((circle) => ({
    segments: [circle],
    signedArea: segmentAreaContribution(circle),
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
    const distinctCorners = new Set(
      loop.segments.map(
        (segment) => `${segmentStart(segment).x}:${segmentStart(segment).y}`,
      ),
    );
    if (area <= PROFILE_MIN_AREA_MM2 || distinctCorners.size < 3) {
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
 * The full-circle sweep of a circle entity as a loop segment's angular
 * extent (2π); an arc's sweep is its own.
 */
function profileSegmentSweep(segment: ProfileSegment): number {
  if (segment.kind === "line") return 0;
  if (segment.kind === "circle") return Math.PI * 2;
  return arcSegmentSweep(segment);
}
