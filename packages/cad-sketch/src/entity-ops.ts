/**
 * Sketch entity operations (Phase 37): the multi-entity editing grammar —
 * offset entity/chain, mirror about a line, rectangular and circular
 * arrays, and extend (the complement of the editor's trim) — as pure
 * functions from (sketch, request) to the serializable {@link SketchCommand}
 * list that performs the op. Nothing here mutates the sketch: every op
 * returns `sketch.entity.create` commands (offset, mirror, arrays — the
 * originals stay) or `sketch.entity.update` (extend), so the ops ride the
 * existing command interpreter, the session history, and the command-log
 * wire format unchanged.
 *
 * ## Determinism
 *
 * Ops are pure data-in/data-out: identical (sketch, request) pairs produce
 * identical command lists. New entity ids are minted from the sketch's own
 * taken-id set by {@link createSketchOpIdAllocator} — the same
 * `prefix_base-n` scheme the editor uses — so replaying a committed op
 * regenerates identical ids. Copies preserve the source entity's
 * construction and fixed flags. Geometric decisions (offset side, mirror
 * image, array placement, extend target) are closed-form: no iteration, no
 * tolerance-dependent search beyond the documented chain-contact epsilon.
 *
 * ## Disclosed scope (capability-honest declines)
 *
 * - Offset supports lines (individually or as a connected chain of
 *   TOGETHER-TARGETED lines), circles, arcs, polygons, and slots. Splines,
 *   ellipses, elliptical arcs, rectangles (aggregates — target their edge
 *   lines), and points decline `sketch-op/unsupported-kind`: offsetting a
 *   Bézier or an ellipse needs curve-offset machinery with its own
 *   deflection band that this phase does not build.
 * - Mirror supports every non-aggregate kind; the mirror axis must be a
 *   line entity. Rectangles decline `sketch-op/unsupported-kind` (aggregate;
 *   mirror their edge lines).
 * - Arrays translate/rotate any non-aggregate kind; rectangles decline
 *   (`sketch-op/unsupported-kind`).
 * - Extend grows a line's clicked end along its own direction to the
 *   nearest intersection lying BEYOND that end (t > 1) against line
 *   segments and circle/arc rims — the exact complement of the editor's
 *   shrink-only trim. No boundary in reach declines
 *   `sketch-op/extend-no-intersection`.
 */

import { type ParseResult, fail, ok } from "@slopcad/cad-core";
import type { Sketch } from "./sketch";
import type { SketchCommand } from "./commands";

import {
  createArc3SlotEntity,
  createArcEntity,
  createCircleEntity,
  createEllipseEntity,
  createEllipticalArcEntity,
  createLineEntity,
  createPointEntity,
  createPolygonEntity,
  createSplineEntity,
  createStraightSlotEntity,
  type SketchEntity,
} from "./entities";
import { createSketchEntityId, type SketchEntityId } from "./sketch-ids";

/** A workplane-space point in mm (op request coordinates). */
export interface EntityOpPoint {
  readonly x: number;
  readonly y: number;
}

/** Stable failure codes produced when an entity-op request is rejected. */
export const SKETCH_ENTITY_OP_ERROR_CODES = {
  entityUnknown: "sketch-op/entity-unknown",
  unsupportedKind: "sketch-op/unsupported-kind",
  offsetCollapsed: "sketch-op/offset-collapsed",
  mirrorLineNeeded: "sketch-op/mirror-line-needed",
  arrayCountsInvalid: "sketch-op/array-counts-invalid",
  arraySpacingInvalid: "sketch-op/array-spacing-invalid",
  arrayCountInvalid: "sketch-op/array-count-invalid",
  extendNeedsLine: "sketch-op/extend-needs-line",
  extendNoIntersection: "sketch-op/extend-no-intersection",
} as const;

export type SketchEntityOpErrorCode =
  (typeof SKETCH_ENTITY_OP_ERROR_CODES)[keyof typeof SKETCH_ENTITY_OP_ERROR_CODES];

/** Structured failure describing why an entity op was rejected. */
export interface SketchEntityOpError {
  readonly code: SketchEntityOpErrorCode;
  readonly message: string;
  readonly input: unknown;
}

function opError(
  code: SketchEntityOpErrorCode,
  message: string,
  input: unknown,
): SketchEntityOpError {
  return { code, message, input };
}

/**
 * The maximum coordinate mismatch (mm) at which two endpoints count as
 * connected for chain detection. Drawn chains share picks, so their contact
 * is exact; the epsilon only absolves last-digit arithmetic drift.
 */
export const CHAIN_CONTACT_EPSILON_MM = 1e-6;

/**
 * The offset-copy span (mm) at or below which a chain member counts as
 * collapsed. An offset that insets a loop to its exact collapse leaves
 * every member a zero-length span; past the collapse the miters fold
 * members end-for-end. Either way the op refuses
 * `sketch-op/offset-collapsed` instead of committing degenerate geometry.
 */
export const OFFSET_COLLAPSE_EPSILON_MM = 1e-6;

// ---------------------------------------------------------------------------
// Id allocation
// ---------------------------------------------------------------------------

/**
 * A deterministic entity-id allocator over a sketch's taken ids: each
 * allocation returns the smallest `skent_base-n` the sketch does not use
 * yet, and remembers it, so ids minted in one op never collide with each
 * other. Pure with respect to the sketch: the allocator holds only its own
 * grown set.
 */
export function createSketchOpIdAllocator(
  sketch: Sketch,
): (base: string) => SketchEntityId {
  const taken = new Set<string>([
    ...sketch.entities.map((entity) => entity.id),
    ...sketch.constraints.map((constraint) => constraint.id),
  ]);
  return (base) => {
    for (let n = 1; ; n += 1) {
      const candidate = createSketchEntityId(`skent_${base}-${String(n)}`);
      if (!taken.has(candidate)) {
        taken.add(candidate);
        return candidate;
      }
    }
  };
}

// ---------------------------------------------------------------------------
// Entity shape helpers (pure coordinate transforms per kind)
// ---------------------------------------------------------------------------

function entitiesById(sketch: Sketch): ReadonlyMap<string, SketchEntity> {
  return new Map(sketch.entities.map((entity) => [entity.id, entity]));
}

function requireEntities(
  sketch: Sketch,
  entityIds: readonly SketchEntityId[],
):
  | { readonly ok: true }
  | { readonly ok: false; readonly error: SketchEntityOpError } {
  const byId = entitiesById(sketch);
  for (const id of entityIds) {
    if (!byId.has(id)) {
      return {
        ok: false,
        error: opError(
          SKETCH_ENTITY_OP_ERROR_CODES.entityUnknown,
          `Entity ${id} does not exist; the op needs existing entities.`,
          id,
        ),
      };
    }
  }
  return { ok: true };
}

/** Options every rebuilt entity forwards (construction, fixed). */
interface RebuildOptions {
  readonly construction: boolean;
  readonly fixed: boolean;
}

function optionsOf(entity: SketchEntity): RebuildOptions {
  return { construction: entity.construction, fixed: entity.fixed };
}

/**
 * Translates `entity` by `(dx, dy)` (workplane mm), rebuilding it under
 * `id` — the rigid-move primitive the editor's drag interaction and the
 * rectangular array both use. `null` for rectangles (aggregates carry no
 * geometry of their own).
 */
export function translateSketchEntity(
  entity: SketchEntity,
  id: SketchEntityId,
  dx: number,
  dy: number,
): SketchEntity | null {
  return translateEntity(entity, id, dx, dy);
}

/** Translates `entity` by `(dx, dy)` and rebuilds it under `id`. */
function translateEntity(
  entity: SketchEntity,
  id: SketchEntityId,
  dx: number,
  dy: number,
): SketchEntity | null {
  const options = optionsOf(entity);
  const move = (p: EntityOpPoint): EntityOpPoint => ({
    x: p.x + dx,
    y: p.y + dy,
  });
  switch (entity.kind) {
    case "point":
      return createPointEntity(id, move({ x: entity.x, y: entity.y }), options);
    case "line":
      return createLineEntity(
        id,
        move({ x: entity.x1, y: entity.y1 }),
        move({ x: entity.x2, y: entity.y2 }),
        options,
      );
    case "circle":
      return createCircleEntity(
        id,
        move({ x: entity.cx, y: entity.cy }),
        entity.radius,
        options,
      );
    case "arc":
      return createArcEntity(
        id,
        move({ x: entity.cx, y: entity.cy }),
        entity.radius,
        entity.startAngle,
        entity.endAngle,
        options,
      );
    case "ellipse":
      return createEllipseEntity(
        id,
        move({ x: entity.cx, y: entity.cy }),
        entity.radiusX,
        entity.radiusY,
        entity.rotation,
        options,
      );
    case "ellipticalArc":
      return createEllipticalArcEntity(
        id,
        move({ x: entity.cx, y: entity.cy }),
        entity.radiusX,
        entity.radiusY,
        entity.rotation,
        entity.startAngle,
        entity.endAngle,
        options,
      );
    case "spline":
      return createSplineEntity(
        id,
        entity.flavor,
        entity.points.map(move),
        options,
      );
    case "polygon":
      return createPolygonEntity(
        id,
        move({ x: entity.cx, y: entity.cy }),
        entity.radius,
        entity.sides,
        entity.rotation,
        entity.fit,
        options,
      );
    case "slot":
      return entity.variant === "straight"
        ? createStraightSlotEntity(
            id,
            move({ x: entity.x1, y: entity.y1 }),
            move({ x: entity.x2, y: entity.y2 }),
            entity.radius,
            options,
          )
        : createArc3SlotEntity(
            id,
            move({ x: entity.x1, y: entity.y1 }),
            move({ x: entity.x2, y: entity.y2 }),
            move({ x: entity.x3 ?? entity.x2, y: entity.y3 ?? entity.y2 }),
            entity.radius,
            options,
          );
    case "rectangle":
      return null;
  }
}

/** Rotates `entity` by `angle` (rad, CCW) about `center`, rebuilds under `id`. */
function rotateEntityAbout(
  entity: SketchEntity,
  id: SketchEntityId,
  center: EntityOpPoint,
  angle: number,
): SketchEntity | null {
  const options = optionsOf(entity);
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const spin = (p: EntityOpPoint): EntityOpPoint => {
    const wx = p.x - center.x;
    const wy = p.y - center.y;
    return {
      x: center.x + wx * cos - wy * sin,
      y: center.y + wx * sin + wy * cos,
    };
  };
  const spinAngle = (a: number): number => a + angle;
  switch (entity.kind) {
    case "point":
      return createPointEntity(id, spin({ x: entity.x, y: entity.y }), options);
    case "line":
      return createLineEntity(
        id,
        spin({ x: entity.x1, y: entity.y1 }),
        spin({ x: entity.x2, y: entity.y2 }),
        options,
      );
    case "circle":
      return createCircleEntity(
        id,
        spin({ x: entity.cx, y: entity.cy }),
        entity.radius,
        options,
      );
    case "arc":
      return createArcEntity(
        id,
        spin({ x: entity.cx, y: entity.cy }),
        entity.radius,
        spinAngle(entity.startAngle),
        spinAngle(entity.endAngle),
        options,
      );
    case "ellipse":
      return createEllipseEntity(
        id,
        spin({ x: entity.cx, y: entity.cy }),
        entity.radiusX,
        entity.radiusY,
        spinAngle(entity.rotation),
        options,
      );
    case "ellipticalArc":
      return createEllipticalArcEntity(
        id,
        spin({ x: entity.cx, y: entity.cy }),
        entity.radiusX,
        entity.radiusY,
        spinAngle(entity.rotation),
        spinAngle(entity.startAngle),
        spinAngle(entity.endAngle),
        options,
      );
    case "spline":
      return createSplineEntity(
        id,
        entity.flavor,
        entity.points.map(spin),
        options,
      );
    case "polygon":
      return createPolygonEntity(
        id,
        spin({ x: entity.cx, y: entity.cy }),
        entity.radius,
        entity.sides,
        spinAngle(entity.rotation),
        entity.fit,
        options,
      );
    case "slot":
      return entity.variant === "straight"
        ? createStraightSlotEntity(
            id,
            spin({ x: entity.x1, y: entity.y1 }),
            spin({ x: entity.x2, y: entity.y2 }),
            entity.radius,
            options,
          )
        : createArc3SlotEntity(
            id,
            spin({ x: entity.x1, y: entity.y1 }),
            spin({ x: entity.x2, y: entity.y2 }),
            spin({ x: entity.x3 ?? entity.x2, y: entity.y3 ?? entity.y2 }),
            entity.radius,
            options,
          );
    case "rectangle":
      return null;
  }
}

/** Mirrors `point` across the infinite line through `a`→`b`. */
function mirrorPointAcrossLine(
  point: EntityOpPoint,
  a: EntityOpPoint,
  b: EntityOpPoint,
): EntityOpPoint {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSquared = dx * dx + dy * dy;
  const wx = point.x - a.x;
  const wy = point.y - a.y;
  const t = (wx * dx + wy * dy) / lengthSquared;
  // Foot of the perpendicular, doubled: mirror = 2·foot − point.
  return {
    x: a.x + 2 * t * dx - wx,
    y: a.y + 2 * t * dy - wy,
  };
}

/** The direction `d` mirrored across the line through `a`→`b` (a at origin). */
function mirrorDirectionAcrossLine(
  d: EntityOpPoint,
  a: EntityOpPoint,
  b: EntityOpPoint,
): EntityOpPoint {
  const mirrored = mirrorPointAcrossLine({ x: a.x + d.x, y: a.y + d.y }, a, b);
  return { x: mirrored.x - a.x, y: mirrored.y - a.y };
}

/** Mirrors `entity` across the infinite line through `a`→`b`, rebuilds under `id`. */
function mirrorEntityAcrossLine(
  entity: SketchEntity,
  id: SketchEntityId,
  a: EntityOpPoint,
  b: EntityOpPoint,
): SketchEntity | null {
  const options = optionsOf(entity);
  const flip = (p: EntityOpPoint): EntityOpPoint =>
    mirrorPointAcrossLine(p, a, b);
  switch (entity.kind) {
    case "point":
      return createPointEntity(id, flip({ x: entity.x, y: entity.y }), options);
    case "line":
      return createLineEntity(
        id,
        flip({ x: entity.x1, y: entity.y1 }),
        flip({ x: entity.x2, y: entity.y2 }),
        options,
      );
    case "circle":
      return createCircleEntity(
        id,
        flip({ x: entity.cx, y: entity.cy }),
        entity.radius,
        options,
      );
    case "arc": {
      // Mirroring reverses orientation: the CCW sweep from start to end
      // maps to the CCW sweep from the mirrored END to the mirrored START.
      const start = flip({
        x: entity.cx + entity.radius * Math.cos(entity.startAngle),
        y: entity.cy + entity.radius * Math.sin(entity.startAngle),
      });
      const end = flip({
        x: entity.cx + entity.radius * Math.cos(entity.endAngle),
        y: entity.cy + entity.radius * Math.sin(entity.endAngle),
      });
      const center = flip({ x: entity.cx, y: entity.cy });
      return createArcEntity(
        id,
        center,
        entity.radius,
        Math.atan2(end.y - center.y, end.x - center.x),
        Math.atan2(start.y - center.y, start.x - center.x),
        options,
      );
    }
    case "ellipse": {
      const center = flip({ x: entity.cx, y: entity.cy });
      const axis = mirrorDirectionAcrossLine(
        { x: Math.cos(entity.rotation), y: Math.sin(entity.rotation) },
        a,
        b,
      );
      return createEllipseEntity(
        id,
        center,
        entity.radiusX,
        entity.radiusY,
        Math.atan2(axis.y, axis.x),
        options,
      );
    }
    case "ellipticalArc": {
      // A reflection M maps the parametric point p(t) to p'(−t) in the
      // mirrored frame: the mirrored start angle is −end and vice versa
      // (the sweep stays CCW through the swapped endpoints).
      const center = flip({ x: entity.cx, y: entity.cy });
      const axis = mirrorDirectionAcrossLine(
        { x: Math.cos(entity.rotation), y: Math.sin(entity.rotation) },
        a,
        b,
      );
      return createEllipticalArcEntity(
        id,
        center,
        entity.radiusX,
        entity.radiusY,
        Math.atan2(axis.y, axis.x),
        -entity.endAngle,
        -entity.startAngle,
        options,
      );
    }
    case "spline":
      return createSplineEntity(
        id,
        entity.flavor,
        entity.points.map(flip),
        options,
      );
    case "polygon": {
      const center = flip({ x: entity.cx, y: entity.cy });
      const axis = mirrorDirectionAcrossLine(
        { x: Math.cos(entity.rotation), y: Math.sin(entity.rotation) },
        a,
        b,
      );
      return createPolygonEntity(
        id,
        center,
        entity.radius,
        entity.sides,
        Math.atan2(axis.y, axis.x),
        entity.fit,
        options,
      );
    }
    case "slot":
      return entity.variant === "straight"
        ? createStraightSlotEntity(
            id,
            flip({ x: entity.x1, y: entity.y1 }),
            flip({ x: entity.x2, y: entity.y2 }),
            entity.radius,
            options,
          )
        : createArc3SlotEntity(
            id,
            flip({ x: entity.x1, y: entity.y1 }),
            flip({ x: entity.x2, y: entity.y2 }),
            flip({ x: entity.x3 ?? entity.x2, y: entity.y3 ?? entity.y2 }),
            entity.radius,
            options,
          );
    case "rectangle":
      return null;
  }
}

// ---------------------------------------------------------------------------
// Offset
// ---------------------------------------------------------------------------

/**
 * The signed distance of `p` from the infinite line a→b, positive on the
 * line's LEFT side (the side its left normal `(−dy, dx)/len` points to —
 * the direction the offset translation uses).
 */
function signedDistanceFromLine(
  p: EntityOpPoint,
  a: EntityOpPoint,
  b: EntityOpPoint,
): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const length = Math.hypot(dx, dy);
  return (-(p.x - a.x) * dy + (p.y - a.y) * dx) / length;
}

/** The signed distance of `p` from a circle/arc rim (outside positive). */
function signedDistanceFromRim(
  p: EntityOpPoint,
  center: EntityOpPoint,
  radius: number,
): number {
  return Math.hypot(p.x - center.x, p.y - center.y) - radius;
}

/**
 * Whether two endpoints count as connected for chain detection (the
 * documented chain-contact epsilon).
 */
function endpointsTouch(a: EntityOpPoint, b: EntityOpPoint): boolean {
  return Math.hypot(a.x - b.x, a.y - b.y) <= CHAIN_CONTACT_EPSILON_MM;
}

function lineEnds(entity: SketchEntity): {
  readonly start: EntityOpPoint;
  readonly end: EntityOpPoint;
} | null {
  return entity.kind === "line"
    ? {
        start: { x: entity.x1, y: entity.y1 },
        end: { x: entity.x2, y: entity.y2 },
      }
    : null;
}

/**
 * The connectivity substrate of a set of lines: each line's endpoints and
 * the touching-neighbor adjacency (within the chain-contact epsilon), both
 * keyed by id. Shared by chain detection and member orientation so both
 * walk the same joints.
 */
function chainAdjacency(
  lines: readonly {
    readonly id: SketchEntityId;
    readonly entity: SketchEntity;
  }[],
): {
  readonly ends: ReadonlyMap<
    string,
    { readonly start: EntityOpPoint; readonly end: EntityOpPoint }
  >;
  readonly neighbors: ReadonlyMap<string, readonly string[]>;
} {
  const ends = new Map<
    string,
    { readonly start: EntityOpPoint; readonly end: EntityOpPoint }
  >();
  for (const line of lines) {
    const candidate = lineEnds(line.entity);
    if (candidate !== null) ends.set(line.id, candidate);
  }
  const neighbors = new Map<string, string[]>();
  const link = (a: string, b: string): void => {
    const list = neighbors.get(a) ?? [];
    if (!list.includes(b)) list.push(b);
    neighbors.set(a, list);
  };
  const ids = lines.map((line) => line.id);
  for (let i = 0; i < ids.length; i += 1) {
    for (let j = i + 1; j < ids.length; j += 1) {
      const a = ends.get(ids[i] ?? "");
      const b = ends.get(ids[j] ?? "");
      if (a === undefined || b === undefined) continue;
      if (
        endpointsTouch(a.start, b.start) ||
        endpointsTouch(a.start, b.end) ||
        endpointsTouch(a.end, b.start) ||
        endpointsTouch(a.end, b.end)
      ) {
        const idA = ids[i];
        const idB = ids[j];
        if (idA !== undefined && idB !== undefined) {
          link(idA, idB);
          link(idB, idA);
        }
      }
    }
  }
  return { ends, neighbors };
}

/**
 * Orders the targeted lines into connected chains: each chain is a maximal
 * run of lines where consecutive members share an endpoint (within the
 * chain-contact epsilon). Returns the chains in first-target order; a
 * single unconnected line is its own chain. Closed loops are detected by
 * the caller through the returned `closed` flag.
 */
function lineChains(
  lines: readonly {
    readonly id: SketchEntityId;
    readonly entity: SketchEntity;
  }[],
): readonly {
  readonly ids: readonly SketchEntityId[];
  readonly closed: boolean;
}[] {
  const { ends, neighbors } = chainAdjacency(lines);
  const ids = lines.map((line) => line.id);
  const visited = new Set<string>();
  const chains: {
    readonly ids: readonly SketchEntityId[];
    readonly closed: boolean;
  }[] = [];
  for (const id of ids) {
    if (visited.has(id)) continue;
    // Walk the run in order from one free end when possible.
    const order: string[] = [id];
    visited.add(id);
    // Grow backwards then forwards along non-branching connections (a drawn
    // chain links each member to at most two others; branching joins keep
    // the first walk, which is deterministic in target order).
    let grew = true;
    while (grew) {
      grew = false;
      const head = order[0];
      const tail = order[order.length - 1];
      for (const probe of [head, tail]) {
        if (probe === undefined) continue;
        for (const next of neighbors.get(probe) ?? []) {
          if (visited.has(next)) continue;
          if (probe === head) order.unshift(next);
          else order.push(next);
          visited.add(next);
          grew = true;
          break;
        }
        if (grew) break;
      }
    }
    const firstEnds = ends.get(order[0] ?? "");
    const lastEnds = ends.get(order[order.length - 1] ?? "");
    const closed =
      order.length > 2 &&
      firstEnds !== undefined &&
      lastEnds !== undefined &&
      (endpointsTouch(firstEnds.start, lastEnds.start) ||
        endpointsTouch(firstEnds.start, lastEnds.end) ||
        endpointsTouch(firstEnds.end, lastEnds.start) ||
        endpointsTouch(firstEnds.end, lastEnds.end));
    chains.push({
      closed,
      ids: order.map((member) => createSketchEntityId(member)),
    });
  }
  return chains;
}

/**
 * Orients every chain member relative to the chain's anchor — the
 * first-targeted line, whose drawn direction defines the chain's side.
 * `+1` means the member is drawn with the chain (translating it by the
 * measured signed distance along its own left normal puts its copy on the
 * anchor's side); `−1` means it is drawn against the chain and the
 * translation negates. The anchor itself is `+1` by definition, so its own
 * translation is exactly the measured distance: the copy lands on the
 * clicked side for positive AND negative measurements alike.
 *
 * The side propagates through the joints: flow enters the chain at the
 * anchor's drawn start and leaves at its drawn end, and each neighbor is
 * oriented by the end it meets that flow with. A member whose joints
 * cannot determine an orientation (a branch leftover) falls back to the
 * click's own side relative to its line. Total and deterministic: every
 * member receives an entry.
 */
function chainMemberOrientations(
  members: readonly {
    readonly id: SketchEntityId;
    readonly entity: SketchEntity;
  }[],
  anchorId: SketchEntityId,
  towards: EntityOpPoint,
  anchorDistance: number,
): ReadonlyMap<string, 1 | -1> {
  const { ends, neighbors } = chainAdjacency(members);
  const orientations = new Map<string, 1 | -1>([[anchorId, 1]]);
  const signedOf = (id: string): number | null => {
    const entity = members.find((member) => member.id === id)?.entity;
    if (entity === undefined || entity.kind !== "line") return null;
    return signedDistanceFromLine(
      towards,
      { x: entity.x1, y: entity.y1 },
      { x: entity.x2, y: entity.y2 },
    );
  };
  const queue: {
    readonly end: "start" | "end";
    readonly exits: boolean;
    readonly id: string;
  }[] = [
    { end: "end", exits: true, id: anchorId },
    { end: "start", exits: false, id: anchorId },
  ];
  while (queue.length > 0) {
    const front = queue.shift();
    if (front === undefined) break;
    const point = ends.get(front.id)?.[front.end];
    if (point === undefined) continue;
    for (const neighborId of neighbors.get(front.id) ?? []) {
      if (orientations.has(neighborId)) continue;
      const neighborEnds = ends.get(neighborId);
      if (neighborEnds === undefined) continue;
      const meetsAtStart = endpointsTouch(neighborEnds.start, point);
      const meetsAtEnd = endpointsTouch(neighborEnds.end, point);
      if (!meetsAtStart && !meetsAtEnd) continue;
      // Met at its start, a member runs with the flow leaving this front;
      // met at its end it runs against it — reversed on the receiving
      // side, where the flow arrives through the neighbor.
      const oriented: 1 | -1 = meetsAtStart === front.exits ? 1 : -1;
      orientations.set(neighborId, oriented);
      queue.push({
        end:
          oriented === 1
            ? front.exits
              ? "end"
              : "start"
            : front.exits
              ? "start"
              : "end",
        exits: front.exits,
        id: neighborId,
      });
    }
  }
  for (const member of members) {
    if (orientations.has(member.id)) continue;
    const signed = signedOf(member.id);
    orientations.set(
      member.id,
      signed === null || signed >= 0 === anchorDistance >= 0 ? 1 : -1,
    );
  }
  return orientations;
}

/** Intersection of two infinite lines, or `null` when parallel. */
function infiniteLineIntersection(
  a: EntityOpPoint,
  b: EntityOpPoint,
  c: EntityOpPoint,
  d: EntityOpPoint,
): EntityOpPoint | null {
  const rX = b.x - a.x;
  const rY = b.y - a.y;
  const sX = d.x - c.x;
  const sY = d.y - c.y;
  const denom = rX * sY - rY * sX;
  if (Math.abs(denom) < 1e-12) return null;
  const t = ((c.x - a.x) * sY - (c.y - a.y) * sX) / denom;
  return { x: a.x + t * rX, y: a.y + t * rY };
}

export interface OffsetEntitiesRequest {
  /** The entities to offset (a chain = the connected lines among these). */
  readonly entityIds: readonly SketchEntityId[];
  /**
   * The offset target: the side is the side of `towards`, and the offset
   * magnitude is the signed distance from the FIRST targeted entity's
   * geometry to `towards` (perpendicular for lines, radial for rims).
   */
  readonly towards: EntityOpPoint;
}

/**
 * Offsets the targeted entities toward `towards` by the measured distance,
 * emitting `sketch.entity.create` commands for the offset copies (the
 * originals stay). Targeted lines that connect (within the chain-contact
 * epsilon) offset as one chain: the shared signed distance is measured
 * from the FIRST-TARGETED member's geometry, the anchor — so the copy of
 * that member lands on the clicked side, at the clicked magnitude, for
 * positive and negative measurements alike. Each member moves along its
 * own normal by that distance scaled by its chain orientation (members
 * drawn against the chain negate), then consecutive members are rejoined
 * at the intersection of their offset lines — miters included, closed
 * loops closed. An offset that collapses the chain — a member's rejoined
 * copy at or under {@link OFFSET_COLLAPSE_EPSILON_MM}, or folded
 * end-for-end past the collapse — refuses `sketch-op/offset-collapsed`.
 * Non-line targets offset individually (rims grow/shrink by the signed
 * radial distance). Copies preserve construction/fixed flags.
 */
export function offsetEntitiesCommands(
  sketch: Sketch,
  request: OffsetEntitiesRequest,
): ParseResult<readonly SketchCommand[], SketchEntityOpError> {
  const presence = requireEntities(sketch, request.entityIds);
  if (!presence.ok) return presence;
  const byId = entitiesById(sketch);
  const firstId = request.entityIds[0];
  const first = firstId === undefined ? undefined : byId.get(firstId);
  if (first === undefined) {
    return fail(
      opError(
        SKETCH_ENTITY_OP_ERROR_CODES.entityUnknown,
        "Offset needs at least one entity.",
        request.entityIds,
      ),
    );
  }
  const mint = createSketchOpIdAllocator(sketch);
  const commands: SketchCommand[] = [];

  // Lines: chain-offset with rejoining.
  const targetedLines = request.entityIds
    .map((id) => ({ id, entity: byId.get(id) }))
    .filter(
      (
        entry,
      ): entry is {
        readonly id: SketchEntityId;
        readonly entity: SketchEntity;
      } => entry.entity !== undefined && entry.entity.kind === "line",
    );
  const chains = lineChains(targetedLines);
  const chainedIds = new Set(chains.flatMap((chain) => chain.ids));
  for (const chain of chains) {
    // The shared signed distance comes from the chain's FIRST-TARGETED
    // member — the pick the user measured against, per the
    // OffsetEntitiesRequest.towards contract — not the chain walk's head.
    const chainIds = new Set<string>(chain.ids);
    const anchorId = request.entityIds.find((candidate) =>
      chainIds.has(candidate),
    );
    const anchorEntity =
      anchorId === undefined ? undefined : byId.get(anchorId);
    if (
      anchorId === undefined ||
      anchorEntity === undefined ||
      anchorEntity.kind !== "line"
    ) {
      continue;
    }
    const distance = signedDistanceFromLine(
      request.towards,
      { x: anchorEntity.x1, y: anchorEntity.y1 },
      { x: anchorEntity.x2, y: anchorEntity.y2 },
    );
    if (distance === 0) {
      return fail(
        opError(
          SKETCH_ENTITY_OP_ERROR_CODES.offsetCollapsed,
          "Offset distance measured zero: the target point lies on the geometry.",
          request.towards,
        ),
      );
    }
    const members = chain.ids
      .map((id) => ({ entity: byId.get(id), id }))
      .filter(
        (
          entry,
        ): entry is {
          readonly id: SketchEntityId;
          readonly entity: SketchEntity;
        } => entry.entity !== undefined && entry.entity.kind === "line",
      );
    const orientations = chainMemberOrientations(
      members,
      anchorId,
      request.towards,
      distance,
    );
    // Unit left-normal of each line, scaled by the member's chain
    // orientation and the shared signed distance: the anchor moves by the
    // measured distance along its own left normal — the clicked side — and
    // every member moves to the same side of the chain. Original endpoints
    // ride along so the rejoin can find which ends actually touch.
    const offsetLines: {
      readonly id: SketchEntityId;
      readonly a: EntityOpPoint;
      readonly b: EntityOpPoint;
      readonly originalA: EntityOpPoint;
      readonly originalB: EntityOpPoint;
    }[] = [];
    for (const id of chain.ids) {
      const entity = byId.get(id);
      if (entity === undefined || entity.kind !== "line") continue;
      const dx = entity.x2 - entity.x1;
      const dy = entity.y2 - entity.y1;
      const length = Math.hypot(dx, dy);
      const nx = -dy / length;
      const ny = dx / length;
      const own = distance * (orientations.get(id) ?? 1);
      offsetLines.push({
        a: { x: entity.x1 + nx * own, y: entity.y1 + ny * own },
        b: { x: entity.x2 + nx * own, y: entity.y2 + ny * own },
        id,
        originalA: { x: entity.x1, y: entity.y1 },
        originalB: { x: entity.x2, y: entity.y2 },
      });
    }
    // Rejoin members at their offset lines' intersection, at the ends that
    // actually touch (the chain walk may run either direction). The joined
    // records are locally mutable working copies, frozen into the created
    // entities by the line constructor.
    const joined: { a: EntityOpPoint; b: EntityOpPoint }[] = offsetLines.map(
      (line) => ({ a: line.a, b: line.b }),
    );
    const joinPair = (
      current: (typeof offsetLines)[number] | undefined,
      next: (typeof offsetLines)[number] | undefined,
    ): void => {
      if (current === undefined || next === undefined) return;
      const touches = endpointsTouch(current.originalA, next.originalA)
        ? ["a", "a"]
        : endpointsTouch(current.originalA, next.originalB)
          ? ["a", "b"]
          : endpointsTouch(current.originalB, next.originalA)
            ? ["b", "a"]
            : endpointsTouch(current.originalB, next.originalB)
              ? ["b", "b"]
              : null;
      if (touches === null) return;
      const hit = infiniteLineIntersection(
        current.a,
        current.b,
        next.a,
        next.b,
      );
      if (hit === null) return;
      const currentIndex = offsetLines.indexOf(current);
      const nextIndex = offsetLines.indexOf(next);
      const currentJoined = joined[currentIndex];
      const nextJoined = joined[nextIndex];
      if (currentJoined !== undefined && touches[0] === "a")
        currentJoined.a = hit;
      if (currentJoined !== undefined && touches[0] === "b")
        currentJoined.b = hit;
      if (nextJoined !== undefined && touches[1] === "a") nextJoined.a = hit;
      if (nextJoined !== undefined && touches[1] === "b") nextJoined.b = hit;
    };
    for (let i = 0; i + 1 < offsetLines.length; i += 1) {
      joinPair(offsetLines[i], offsetLines[i + 1]);
    }
    if (chain.closed && offsetLines.length > 2) {
      joinPair(offsetLines[offsetLines.length - 1], offsetLines[0]);
    }
    // A chain offset run to (or past) its collapse leaves a member with no
    // positive span — inset a loop to its exact collapse and every member
    // spans zero; push further and the miters fold members end-for-end.
    // Either way the op refuses instead of committing degenerate geometry.
    for (let i = 0; i < offsetLines.length; i += 1) {
      const placed = joined[i];
      const source = offsetLines[i];
      if (placed === undefined || source === undefined) continue;
      const spanX = placed.b.x - placed.a.x;
      const spanY = placed.b.y - placed.a.y;
      const sourceX = source.originalB.x - source.originalA.x;
      const sourceY = source.originalB.y - source.originalA.y;
      const collapsed =
        Math.hypot(spanX, spanY) <= OFFSET_COLLAPSE_EPSILON_MM ||
        spanX * sourceX + spanY * sourceY < 0;
      if (collapsed) {
        return fail(
          opError(
            SKETCH_ENTITY_OP_ERROR_CODES.offsetCollapsed,
            `Offset collapses the chain at ${source.id}: the offset copy would carry no positive span.`,
            request.towards,
          ),
        );
      }
    }
    for (let i = 0; i < offsetLines.length; i += 1) {
      const source = byId.get(offsetLines[i]?.id ?? "");
      const placed = joined[i];
      if (source === undefined || placed === undefined) continue;
      commands.push({
        type: "sketch.entity.create",
        entity: createLineEntity(
          mint("offset"),
          placed.a,
          placed.b,
          optionsOf(source),
        ),
      });
    }
  }

  // Non-line targets: rim kinds grow/shrink; unsupported kinds decline.
  for (const id of request.entityIds) {
    if (chainedIds.has(id)) continue;
    const entity = byId.get(id);
    if (entity === undefined) continue;
    if (entity.kind === "circle" || entity.kind === "arc") {
      const distance = signedDistanceFromRim(
        request.towards,
        { x: entity.cx, y: entity.cy },
        entity.radius,
      );
      const radius = entity.radius + distance;
      if (!(radius > 0)) {
        return fail(
          opError(
            SKETCH_ENTITY_OP_ERROR_CODES.offsetCollapsed,
            `Offset collapses ${entity.id}: the rim radius would reach ${String(radius)} mm.`,
            request.towards,
          ),
        );
      }
      commands.push({
        type: "sketch.entity.create",
        entity:
          entity.kind === "circle"
            ? createCircleEntity(
                mint("offset"),
                { x: entity.cx, y: entity.cy },
                radius,
                optionsOf(entity),
              )
            : createArcEntity(
                mint("offset"),
                { x: entity.cx, y: entity.cy },
                radius,
                entity.startAngle,
                entity.endAngle,
                optionsOf(entity),
              ),
      });
      continue;
    }
    if (entity.kind === "polygon") {
      const distance = signedDistanceFromRim(
        request.towards,
        { x: entity.cx, y: entity.cy },
        entity.radius,
      );
      const radius = entity.radius + distance;
      if (!(radius > 0)) {
        return fail(
          opError(
            SKETCH_ENTITY_OP_ERROR_CODES.offsetCollapsed,
            `Offset collapses ${entity.id}: the polygon radius would reach ${String(radius)} mm.`,
            request.towards,
          ),
        );
      }
      commands.push({
        type: "sketch.entity.create",
        entity: createPolygonEntity(
          mint("offset"),
          { x: entity.cx, y: entity.cy },
          radius,
          entity.sides,
          entity.rotation,
          entity.fit,
          optionsOf(entity),
        ),
      });
      continue;
    }
    if (entity.kind === "slot") {
      // A slot offsets like its stadium boundary: the cap radius grows by
      // the signed radial distance and the centerline stays.
      const distance = signedDistanceFromRim(
        request.towards,
        { x: entity.x1, y: entity.y1 },
        entity.radius,
      );
      const radius = entity.radius + distance;
      if (!(radius > 0)) {
        return fail(
          opError(
            SKETCH_ENTITY_OP_ERROR_CODES.offsetCollapsed,
            `Offset collapses ${entity.id}: the cap radius would reach ${String(radius)} mm.`,
            request.towards,
          ),
        );
      }
      commands.push({
        type: "sketch.entity.create",
        entity:
          entity.variant === "straight"
            ? createStraightSlotEntity(
                mint("offset"),
                { x: entity.x1, y: entity.y1 },
                { x: entity.x2, y: entity.y2 },
                radius,
                optionsOf(entity),
              )
            : createArc3SlotEntity(
                mint("offset"),
                { x: entity.x1, y: entity.y1 },
                { x: entity.x2, y: entity.y2 },
                { x: entity.x3 ?? entity.x2, y: entity.y3 ?? entity.y2 },
                radius,
                optionsOf(entity),
              ),
      });
      continue;
    }
    return fail(
      opError(
        SKETCH_ENTITY_OP_ERROR_CODES.unsupportedKind,
        `Offset supports lines (and connected chains), circles, arcs, polygons, and slots; ${entity.id} is a ${entity.kind}${entity.kind === "rectangle" ? " (target its edge lines)" : ""}.`,
        entity,
      ),
    );
  }
  if (commands.length === 0) {
    return fail(
      opError(
        SKETCH_ENTITY_OP_ERROR_CODES.offsetCollapsed,
        "Offset produced no geometry.",
        request,
      ),
    );
  }
  return ok(commands);
}

// ---------------------------------------------------------------------------
// Mirror
// ---------------------------------------------------------------------------

export interface MirrorEntitiesRequest {
  /** The mirror axis: an existing line entity. */
  readonly mirrorLineId: SketchEntityId;
  /** The entities to mirror (the axis is excluded automatically). */
  readonly entityIds: readonly SketchEntityId[];
}

/**
 * Mirrors the requested entities about the infinite line through the axis
 * line entity, emitting `sketch.entity.create` commands for the mirrored
 * copies. Every non-aggregate kind mirrors; see the module docs for the
 * angle-handling rules (arcs sweep the mirrored endpoints in reverse;
 * elliptical arcs map t to −t).
 */
export function mirrorEntitiesCommands(
  sketch: Sketch,
  request: MirrorEntitiesRequest,
): ParseResult<readonly SketchCommand[], SketchEntityOpError> {
  const presence = requireEntities(sketch, [
    request.mirrorLineId,
    ...request.entityIds,
  ]);
  if (!presence.ok) return presence;
  const byId = entitiesById(sketch);
  const axis = byId.get(request.mirrorLineId);
  if (axis === undefined || axis.kind !== "line") {
    return fail(
      opError(
        SKETCH_ENTITY_OP_ERROR_CODES.mirrorLineNeeded,
        `Mirror needs a line entity as its axis; ${request.mirrorLineId} is ${axis === undefined ? "missing" : `a ${axis.kind}`}.`,
        request.mirrorLineId,
      ),
    );
  }
  const a = { x: axis.x1, y: axis.y1 };
  const b = { x: axis.x2, y: axis.y2 };
  const mint = createSketchOpIdAllocator(sketch);
  const commands: SketchCommand[] = [];
  for (const id of request.entityIds) {
    if (id === request.mirrorLineId) continue;
    const entity = byId.get(id);
    if (entity === undefined) continue;
    const mirrored = mirrorEntityAcrossLine(entity, mint("mirror"), a, b);
    if (mirrored === null) {
      return fail(
        opError(
          SKETCH_ENTITY_OP_ERROR_CODES.unsupportedKind,
          `Mirror supports every non-aggregate kind; ${entity.id} is a rectangle (mirror its edge lines).`,
          entity,
        ),
      );
    }
    commands.push({ type: "sketch.entity.create", entity: mirrored });
  }
  return ok(commands);
}

// ---------------------------------------------------------------------------
// Arrays
// ---------------------------------------------------------------------------

export interface RectangularArrayRequest {
  readonly entityIds: readonly SketchEntityId[];
  /** Copies along x (≥ 1) and y (≥ 1); at least one count ≥ 2. */
  readonly countX: number;
  readonly countY: number;
  /** Step between neighboring copies (mm, > 0), signed along each axis. */
  readonly spacingX: number;
  readonly spacingY: number;
}

/**
 * Copies the targeted entities onto the (countX × countY) grid stepped by
 * the signed spacings — every grid position except the source at (0, 0) —
 * as `sketch.entity.create` commands in row-major order (y outer, x inner).
 */
export function rectangularArrayCommands(
  sketch: Sketch,
  request: RectangularArrayRequest,
): ParseResult<readonly SketchCommand[], SketchEntityOpError> {
  const presence = requireEntities(sketch, request.entityIds);
  if (!presence.ok) return presence;
  const { countX, countY, spacingX, spacingY } = request;
  const countsValid =
    Number.isInteger(countX) &&
    Number.isInteger(countY) &&
    countX >= 1 &&
    countY >= 1 &&
    countX * countY >= 2;
  if (!countsValid) {
    return fail(
      opError(
        SKETCH_ENTITY_OP_ERROR_CODES.arrayCountsInvalid,
        `A rectangular array needs integer counts ≥ 1 with at least one ≥ 2 (total ≥ 2); received ${String(countX)} × ${String(countY)}.`,
        request,
      ),
    );
  }
  if (
    !(Number.isFinite(spacingX) && spacingX !== 0) ||
    !(Number.isFinite(spacingY) && spacingY !== 0)
  ) {
    return fail(
      opError(
        SKETCH_ENTITY_OP_ERROR_CODES.arraySpacingInvalid,
        "A rectangular array needs non-zero finite spacings (mm).",
        { spacingX, spacingY },
      ),
    );
  }
  const byId = entitiesById(sketch);
  const mint = createSketchOpIdAllocator(sketch);
  const commands: SketchCommand[] = [];
  for (let j = 0; j < countY; j += 1) {
    for (let i = 0; i < countX; i += 1) {
      if (i === 0 && j === 0) continue;
      const dx = i * spacingX;
      const dy = j * spacingY;
      for (const id of request.entityIds) {
        const entity = byId.get(id);
        if (entity === undefined) continue;
        const copy = translateEntity(entity, mint("array"), dx, dy);
        if (copy === null) {
          return fail(
            opError(
              SKETCH_ENTITY_OP_ERROR_CODES.unsupportedKind,
              `Arrays support every non-aggregate kind; ${entity.id} is a rectangle (array its edge lines).`,
              entity,
            ),
          );
        }
        commands.push({ type: "sketch.entity.create", entity: copy });
      }
    }
  }
  return ok(commands);
}

export interface CircularArrayRequest {
  readonly entityIds: readonly SketchEntityId[];
  /** The rotation center (workplane mm). */
  readonly center: EntityOpPoint;
  /** Total number of copies around the circle, source included (≥ 2). */
  readonly count: number;
  /**
   * The step between neighboring copies (rad, CCW, non-zero). Defaults to
   * `2π / count` — a full circle — when omitted.
   */
  readonly angleStepRad?: number;
}

/**
 * Copies the targeted entities count−1 times, rotated by k·angleStep (CCW)
 * about `center`, as `sketch.entity.create` commands in increasing-k order.
 */
export function circularArrayCommands(
  sketch: Sketch,
  request: CircularArrayRequest,
): ParseResult<readonly SketchCommand[], SketchEntityOpError> {
  const presence = requireEntities(sketch, request.entityIds);
  if (!presence.ok) return presence;
  const { count, center, angleStepRad } = request;
  if (!Number.isInteger(count) || count < 2 || count > 4096) {
    return fail(
      opError(
        SKETCH_ENTITY_OP_ERROR_CODES.arrayCountInvalid,
        `A circular array needs an integer count between 2 and 4096; received ${String(count)}.`,
        count,
      ),
    );
  }
  const step = angleStepRad ?? (Math.PI * 2) / count;
  if (!Number.isFinite(step) || step === 0) {
    return fail(
      opError(
        SKETCH_ENTITY_OP_ERROR_CODES.arrayCountInvalid,
        "A circular array needs a non-zero finite angle step (rad).",
        angleStepRad,
      ),
    );
  }
  const byId = entitiesById(sketch);
  const mint = createSketchOpIdAllocator(sketch);
  const commands: SketchCommand[] = [];
  for (let k = 1; k < count; k += 1) {
    for (const id of request.entityIds) {
      const entity = byId.get(id);
      if (entity === undefined) continue;
      const copy = rotateEntityAbout(entity, mint("array"), center, k * step);
      if (copy === null) {
        return fail(
          opError(
            SKETCH_ENTITY_OP_ERROR_CODES.unsupportedKind,
            `Arrays support every non-aggregate kind; ${entity.id} is a rectangle (array its edge lines).`,
            entity,
          ),
        );
      }
      commands.push({ type: "sketch.entity.create", entity: copy });
    }
  }
  return ok(commands);
}

// ---------------------------------------------------------------------------
// Extend
// ---------------------------------------------------------------------------

/** Segment/segment intersection parameters: `a + t·r` meets `c + u·s`. */
function segmentIntersectionTU(
  a: EntityOpPoint,
  b: EntityOpPoint,
  c: EntityOpPoint,
  d: EntityOpPoint,
): { readonly t: number; readonly u: number } | null {
  const rX = b.x - a.x;
  const rY = b.y - a.y;
  const sX = d.x - c.x;
  const sY = d.y - c.y;
  const denom = rX * sY - rY * sX;
  if (denom === 0) return null;
  const t = ((c.x - a.x) * sY - (c.y - a.y) * sX) / denom;
  const u = ((c.x - a.x) * rY - (c.y - a.y) * rX) / denom;
  return { t, u };
}

/** Whether `angle` lies on the CCW sweep from `start` to `end` ([0, 2π)). */
function angleWithinSweep(angle: number, start: number, end: number): boolean {
  const sweep = (end - start + Math.PI * 2) % (Math.PI * 2);
  const relative = (angle - start + Math.PI * 2) % (Math.PI * 2);
  return relative <= sweep;
}

/** The values of t > 1 where the ray a→b (t = 1 at b) meets the circle. */
function rayCircleParametersBeyond(
  a: EntityOpPoint,
  b: EntityOpPoint,
  center: EntityOpPoint,
  radius: number,
): readonly number[] {
  const rX = b.x - a.x;
  const rY = b.y - a.y;
  const fX = a.x - center.x;
  const fY = a.y - center.y;
  const rr = rX * rX + rY * rY;
  if (rr === 0) return [];
  const fr = fX * rX + fY * rY;
  const ff = fX * fX + fY * fY - radius * radius;
  const discriminant = fr * fr - rr * ff;
  if (discriminant < 0) return [];
  const root = Math.sqrt(discriminant);
  return [(-fr - root) / rr, (-fr + root) / rr].filter((t) => t > 1);
}

/**
 * Extends the clicked line's end nearest `at` along its own direction to
 * the nearest boundary beyond that end — the complement of the editor's
 * shrink-only trim — returning the `sketch.entity.update` command that
 * moves the endpoint. Boundaries: other line segments (their u ∈ [0, 1]),
 * circle rims, and arc rims restricted to their sweep. The far end and the
 * rest of the geometry never move.
 */
export function extendLineCommand(
  sketch: Sketch,
  lineId: SketchEntityId,
  at: EntityOpPoint,
): ParseResult<readonly SketchCommand[], SketchEntityOpError> {
  const byId = entitiesById(sketch);
  const line = byId.get(lineId);
  if (line === undefined) {
    return fail(
      opError(
        SKETCH_ENTITY_OP_ERROR_CODES.entityUnknown,
        `Entity ${lineId} does not exist; extend needs an existing line.`,
        lineId,
      ),
    );
  }
  if (line.kind !== "line") {
    return fail(
      opError(
        SKETCH_ENTITY_OP_ERROR_CODES.extendNeedsLine,
        `Extend grows a line; ${lineId} is a ${line.kind}.`,
        line,
      ),
    );
  }
  const nearIsStart =
    Math.hypot(line.x1 - at.x, line.y1 - at.y) <=
    Math.hypot(line.x2 - at.x, line.y2 - at.y);
  const near = nearIsStart
    ? { x: line.x1, y: line.y1 }
    : { x: line.x2, y: line.y2 };
  const far = nearIsStart
    ? { x: line.x2, y: line.y2 }
    : { x: line.x1, y: line.y1 };
  // The extension ray: origin at the far end, t = 1 at the near end, t > 1
  // beyond it — the exact complement of trim's t ∈ [0, 1] search.
  let best: { readonly t: number; readonly point: EntityOpPoint } | null = null;
  for (const entity of sketch.entities) {
    if (entity.id === lineId) continue;
    if (entity.kind === "line") {
      const hit = segmentIntersectionTU(
        far,
        near,
        { x: entity.x1, y: entity.y1 },
        { x: entity.x2, y: entity.y2 },
      );
      if (hit === null || hit.t <= 1 || hit.u < 0 || hit.u > 1) continue;
      if (best === null || hit.t < best.t) {
        best = {
          t: hit.t,
          point: {
            x: far.x + hit.t * (near.x - far.x),
            y: far.y + hit.t * (near.y - far.y),
          },
        };
      }
      continue;
    }
    if (entity.kind === "circle" || entity.kind === "arc") {
      const center = { x: entity.cx, y: entity.cy };
      for (const t of rayCircleParametersBeyond(
        far,
        near,
        center,
        entity.radius,
      )) {
        const point = {
          x: far.x + t * (near.x - far.x),
          y: far.y + t * (near.y - far.y),
        };
        if (
          entity.kind === "arc" &&
          !angleWithinSweep(
            Math.atan2(point.y - center.y, point.x - center.x),
            entity.startAngle,
            entity.endAngle,
          )
        ) {
          continue;
        }
        if (best === null || t < best.t) best = { t, point };
      }
    }
  }
  if (best === null) {
    return fail(
      opError(
        SKETCH_ENTITY_OP_ERROR_CODES.extendNoIntersection,
        `No boundary lies beyond the ${nearIsStart ? "start" : "end"} of ${lineId} along its direction: nothing was extended.`,
        { lineId, at },
      ),
    );
  }
  const updated = nearIsStart
    ? createLineEntity(lineId, best.point, far, optionsOf(line))
    : createLineEntity(lineId, far, best.point, optionsOf(line));
  return ok([{ type: "sketch.entity.update", entity: updated }]);
}
