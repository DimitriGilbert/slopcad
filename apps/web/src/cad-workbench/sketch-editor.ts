/**
 * The workbench sketch editor (Phase 25): the pure composition layer between
 * the sketch domain (`@slopcad/cad-sketch`) and the `@slopcad/ui` sketch
 * components. Two responsibilities, both plain functions over immutable
 * state:
 *
 * ## The editor reducer
 *
 * {@link sketchEditorReducer} turns semantic events (tool activation, canvas
 * picks with the hit entity id, Escape, Delete) into the next editor state —
 * tool, gesture, pending picks, selection, a machine-readable status — plus,
 * at explicit decision points, the atomic {@link SketchTransaction} to
 * commit. Every sketch mutation leaves here as serializable commands
 * (entity create/update/delete, constraint create/delete, dimension set), so
 * the session's snapshot history makes every edit undoable. The reducer
 * never touches the session: the host applies the returned transaction and
 * reports a refusal back as an error status.
 *
 * Constraint tools accumulate typed picks (the picked entity plus, where the
 * constraint needs one, its nearest point target — start/midpoint/end for
 * lines, start/end/center for arcs, center for points/circles) and commit
 * automatically when the kind's arity is satisfied with compatible kinds. A
 * pick of an incompatible kind is refused with an error status and never
 * enters the pending set — malformed references are prevented at the pick,
 * not repaired after. Dimensional constraints (distance/radius/diameter/
 * angle) commit with the value MEASURED from the current geometry, so a new
 * dimension is satisfied at creation; editing the number afterwards is the
 * dimension-edit flow (`sketch.dimension.set`).
 *
 * ## The canvas view model
 *
 * {@link sketchViewModel} derives the pure-data view model the canvas
 * renders from the SOLVED geometry (the host passes the last-known-good
 * solved sketch), the authored sketch's constraint list, the selection, and
 * the solver diagnostics: entities with construction/selection/diagnostic
 * styling, rectangle regions, dimension labels and diagnostic badges.
 *
 * All user-facing status strings are externalized in
 * {@link SKETCH_EDITOR_STATUS_TEXT} — machine surfaces assert codes and
 * ids, the status line shows text.
 */

import { angle, length, valueIn, type LengthValue } from "@slopcad/cad-core";
import {
  createAngleConstraint,
  createCircleEntity,
  createCoincidentConstraint,
  createCollinearConstraint,
  createDistanceConstraint,
  createDistanceXConstraint,
  createDistanceYConstraint,
  createDiameterConstraint,
  createEllipseEntity,
  createEqualConstraint,
  createHorizontalConstraint,
  createHorizontalPairConstraint,
  createLineEntity,
  createMidpointConstraint,
  createParallelConstraint,
  createPerpendicularConstraint,
  createPointOnEntityConstraint,
  createRadiusConstraint,
  createRectangleEntity,
  createSketch,
  createSketchConstraintId,
  createSketchEntityId,
  createStraightSlotEntity,
  createTangentConstraint,
  createVerticalConstraint,
  createVerticalPairConstraint,
  entityPolyline,
  isSketchConstraintKind,
  pointTarget,
  serializeSketchConstraint,
  serializeSketchEntity,
  validateConstraintReferences,
  xyWorkplane,
  type PointTarget,
  type Sketch,
  type SketchCommand,
  type SketchConstraint,
  type SketchConstraintId,
  type SketchDiagnostic,
  type SketchEntity,
  type SketchEntityId,
  type SketchTransaction,
  type SolvedEntityParameters,
} from "@slopcad/cad-sketch";
import type {
  CadSketchCanvasAnnotation,
  CadSketchCanvasEntity,
  CadSketchCanvasRegion,
  CadSketchDiagnosticLevel,
} from "@slopcad/ui/components/cad/cad-sketch-canvas";

// ---------------------------------------------------------------------------
// Tool vocabulary
// ---------------------------------------------------------------------------

/** The drawing tools of the sketch toolbar's first cluster. */
export const SKETCH_DRAWING_TOOLS = [
  "select",
  "line",
  "circle",
  "rectangle",
  "ellipse",
  "slot",
  "trim",
  "construction",
] as const;

/** The constraint tools of the second cluster (the domain's kind names). */
export const SKETCH_CONSTRAINT_TOOLS = [
  "coincident",
  "horizontal",
  "vertical",
  "pointOnEntity",
  "collinear",
  "horizontalPair",
  "verticalPair",
  "parallel",
  "perpendicular",
  "equal",
  "midpoint",
  "tangent",
  "distance",
  "distanceX",
  "distanceY",
  "radius",
  "diameter",
  "angle",
] as const;

export type SketchDrawingTool = (typeof SKETCH_DRAWING_TOOLS)[number];
export type SketchConstraintTool = (typeof SKETCH_CONSTRAINT_TOOLS)[number];
export type SketchToolId = SketchDrawingTool | SketchConstraintTool;

const SKETCH_TOOL_ID_SET: ReadonlySet<string> = new Set<string>([
  ...SKETCH_DRAWING_TOOLS,
  ...SKETCH_CONSTRAINT_TOOLS,
]);

/** Type guard for untrusted tool ids (component callbacks carry strings). */
export function isSketchToolId(input: string): input is SketchToolId {
  return SKETCH_TOOL_ID_SET.has(input);
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/** A workplane-space point in mm. */
export interface EditorPoint {
  readonly x: number;
  readonly y: number;
}

/** The in-progress drawing gesture. */
export type SketchGesture =
  | { readonly kind: "none" }
  | { readonly kind: "line"; readonly start: EditorPoint }
  | { readonly kind: "circle"; readonly center: EditorPoint }
  | { readonly kind: "rectangle"; readonly corner: EditorPoint }
  | {
      /** Ellipse after the center pick: the axis end sets radiusX + rotation. */
      readonly kind: "ellipse";
      readonly center: EditorPoint;
      readonly axis: EditorPoint;
    }
  | {
      /** Straight slot after the start-cap pick: the second pick is the end cap. */
      readonly kind: "slot";
      readonly start: EditorPoint;
      readonly end: EditorPoint;
    }
  | {
      /** The first pick of either multi-pick curve gesture. */
      readonly kind: "pick";
      readonly tool: "ellipse" | "slot";
      readonly point: EditorPoint;
    };

/** One accumulated constraint pick: the entity plus its point target, if any. */
export interface SketchEditorPick {
  readonly entityId: SketchEntityId;
  /** The nearest point target at pick time, when the tool addresses points. */
  readonly point: PointTarget["point"] | null;
}

/** The editor's status line: a code-bearing machine surface with text. */
export interface SketchEditorStatus {
  readonly severity: "ready" | "hint" | "error";
  /** The primary message text (externalized, see the status text table). */
  readonly message: string;
  /** A structured code when the status reports a failure, else `null`. */
  readonly code: string | null;
}

/** The pure editor state the sketch UI renders from. */
export interface SketchEditorState {
  readonly tool: SketchToolId;
  readonly gesture: SketchGesture;
  readonly picks: readonly SketchEditorPick[];
  readonly hoveredEntityId: string | null;
  readonly selectedEntityIds: readonly SketchEntityId[];
  readonly selectedConstraintId: SketchConstraintId | null;
  readonly status: SketchEditorStatus;
}

/** Externalized status texts; machine surfaces carry codes and ids. */
export const SKETCH_EDITOR_STATUS_TEXT = {
  readySelect: "Select: click an entity to select it; Delete removes it.",
  readyLine: "Line: click the start point.",
  lineEnd: "Line: click the end point.",
  readyCircle: "Circle: click the center.",
  circleRadius: "Circle: click to set the radius.",
  readyRectangle: "Rectangle: click the first corner.",
  rectangleSecond: "Rectangle: click the opposite corner.",
  readyEllipse: "Ellipse: click the center.",
  ellipseAxis: "Ellipse: click the axis end (sets the axis and its length).",
  ellipseMinor: "Ellipse: click to set the other extent.",
  readySlot: "Slot: click the first cap center.",
  slotEnd: "Slot: click the second cap center.",
  slotRadius:
    "Slot: click to set the cap radius (distance from the centerline).",
  readyTrim:
    "Trim: click a line near the end to trim to the nearest intersection.",
  readyConstruction:
    "Construction: click entities to toggle construction geometry.",
  pickNeeded: (tool: string, remaining: number): string =>
    `${tool}: pick ${String(remaining)} more ${remaining === 1 ? "entity" : "entities"}.`,
  constraintApplied: "Constraint applied.",
  noSelection: "Nothing selected to delete.",
  noGesture: "Nothing to cancel.",
  degenerate: "Degenerate gesture: zero size.",
  noIntersection: "No intersection on the segment: nothing was trimmed.",
  trimNeedsLine: "Trim needs a line: that entity cannot be trimmed.",
  rectangleEdge: "Referenced by a rectangle: delete the rectangle first.",
  incompatiblePick: "Incompatible pick for this constraint kind.",
  distinctPick: "Incompatible pick: pick two distinct entities.",
} as const;

/** The editor's boot state: the select tool, empty everything. */
export function createSketchEditorState(): SketchEditorState {
  return {
    gesture: { kind: "none" },
    hoveredEntityId: null,
    picks: [],
    selectedConstraintId: null,
    selectedEntityIds: [],
    status: {
      code: null,
      message: SKETCH_EDITOR_STATUS_TEXT.readySelect,
      severity: "ready",
    },
    tool: "select",
  };
}

// ---------------------------------------------------------------------------
// Events and the reducer
// ---------------------------------------------------------------------------

export type SketchEditorEvent =
  | { readonly type: "activate-tool"; readonly tool: SketchToolId }
  | {
      readonly type: "canvas-pick";
      readonly point: EditorPoint;
      readonly entityId: string | null;
    }
  | { readonly type: "hover"; readonly entityId: string | null }
  | { readonly type: "escape" }
  | { readonly type: "delete-selection" }
  | {
      readonly type: "select-constraint";
      readonly constraintId: SketchConstraintId | null;
    }
  | { readonly type: "clear-selection" };

/** The reducer's outcome: the next state plus the transaction to commit. */
export interface SketchEditorTransition {
  readonly state: SketchEditorState;
  readonly transaction: SketchTransaction | null;
}

function statusOf(
  severity: SketchEditorStatus["severity"],
  message: string,
  code: string | null = null,
): SketchEditorStatus {
  return { code, message, severity };
}

/** The number of picks each constraint tool needs before it commits. */
function pickArity(tool: SketchToolId): number {
  switch (tool) {
    case "horizontal":
    case "vertical":
    case "radius":
    case "diameter":
      return 1;
    case "coincident":
    case "parallel":
    case "perpendicular":
    case "equal":
    case "midpoint":
    case "tangent":
    case "distance":
    case "angle":
    case "pointOnEntity":
    case "collinear":
    case "horizontalPair":
    case "verticalPair":
    case "distanceX":
    case "distanceY":
      return 2;
    default:
      return 0;
  }
}

/**
 * Whether a tool's picks carry point targets. `pointOnEntity` addresses a
 * point only on its FIRST pick (the second is the curve operand).
 */
function pickUsesPointTarget(tool: SketchToolId, pickIndex: number): boolean {
  switch (tool) {
    case "coincident":
    case "distance":
    case "midpoint":
    case "horizontalPair":
    case "verticalPair":
    case "distanceX":
    case "distanceY":
      return true;
    case "pointOnEntity":
      return pickIndex === 0;
    default:
      return false;
  }
}

/** Whether `entity` offers point targets at all. */
function isPointTargetable(entity: SketchEntity): boolean {
  return entity.kind !== "rectangle";
}

/** Whether `entity` is a curve `pointOnEntity` can pin onto. */
function isPointOnEntityCurve(entity: SketchEntity): boolean {
  return (
    entity.kind === "line" ||
    entity.kind === "circle" ||
    entity.kind === "arc" ||
    entity.kind === "ellipse" ||
    entity.kind === "ellipticalArc" ||
    entity.kind === "spline"
  );
}

/** The entity kinds a constraint tool accepts, per pick slot. */
function pickKindProblem(
  tool: SketchToolId,
  entity: SketchEntity,
  pickIndex: number,
): string | null {
  const isLine = entity.kind === "line";
  const isCircular = entity.kind === "circle" || entity.kind === "arc";
  const isPointCapable = isPointTargetable(entity);
  switch (tool) {
    case "horizontal":
    case "vertical":
    case "parallel":
    case "perpendicular":
    case "angle":
      return isLine ? null : "needs a line";
    case "collinear":
      return isLine ? null : "needs a line";
    case "equal":
      return isLine || isCircular ? null : "needs a line or circle/arc";
    case "coincident":
    case "distance":
    case "midpoint":
    case "horizontalPair":
    case "verticalPair":
    case "distanceX":
    case "distanceY":
      return isPointCapable ? null : "needs a point-capable entity";
    case "pointOnEntity":
      return pickIndex === 0
        ? isPointCapable
          ? null
          : "needs a point-capable entity"
        : isPointOnEntityCurve(entity)
          ? null
          : "needs a curve (line, circle/arc, ellipse, or spline)";
    case "tangent":
      return isLine || isCircular ? null : "needs a line or circle/arc";
    case "radius":
    case "diameter":
      return isCircular || entity.kind === "polygon" || entity.kind === "slot"
        ? null
        : "needs a circle, arc, polygon, or slot";
    default:
      return null;
  }
}

/** Compatibility between the two accumulated picks of a two-pick tool. */
function pairProblem(
  tool: SketchToolId,
  first: SketchEntity,
  second: SketchEntity,
): string | null {
  const firstLine = first.kind === "line";
  const secondLine = second.kind === "line";
  const firstCircular = first.kind === "circle" || first.kind === "arc";
  const secondCircular = second.kind === "circle" || second.kind === "arc";
  switch (tool) {
    case "equal":
      if (firstLine && secondLine) return null;
      if (firstCircular && secondCircular) return null;
      return "equal needs two lines or two circles/arcs";
    case "tangent":
      if (firstLine && secondCircular) return null;
      if (firstCircular && secondLine) return null;
      if (firstCircular && secondCircular) return null;
      return "tangent needs a line and a circle/arc, or two circles/arcs";
    case "pointOnEntity": {
      const curveKinds = new Set([
        "line",
        "circle",
        "arc",
        "ellipse",
        "ellipticalArc",
        "spline",
      ]);
      // Either orientation composes: the curve pick pins the other's point.
      if (curveKinds.has(second.kind) && first.kind !== "rectangle")
        return null;
      if (curveKinds.has(first.kind) && second.kind !== "rectangle")
        return null;
      return "pointOnEntity needs a point-capable pick and a curve pick (line, circle/arc, ellipse, or spline)";
    }
    default:
      return null;
  }
}

/** The nearest point target of `entity` to `at` in workplane mm. */
function nearestPointTarget(
  entity: SketchEntity,
  at: EditorPoint,
): PointTarget["point"] | null {
  const candidates: {
    readonly distance: number;
    readonly point: PointTarget["point"];
  }[] = [];
  const consider = (point: EditorPoint, name: PointTarget["point"]): void => {
    candidates.push({
      distance: Math.hypot(point.x - at.x, point.y - at.y),
      point: name,
    });
  };
  switch (entity.kind) {
    case "point":
      consider({ x: entity.x, y: entity.y }, "center");
      break;
    case "circle":
      consider({ x: entity.cx, y: entity.cy }, "center");
      break;
    case "line":
      consider({ x: entity.x1, y: entity.y1 }, "start");
      consider(
        { x: (entity.x1 + entity.x2) / 2, y: (entity.y1 + entity.y2) / 2 },
        "center",
      );
      consider({ x: entity.x2, y: entity.y2 }, "end");
      break;
    case "arc":
      consider(
        {
          x: entity.cx + entity.radius * Math.cos(entity.startAngle),
          y: entity.cy + entity.radius * Math.sin(entity.startAngle),
        },
        "start",
      );
      consider({ x: entity.cx, y: entity.cy }, "center");
      consider(
        {
          x: entity.cx + entity.radius * Math.cos(entity.endAngle),
          y: entity.cy + entity.radius * Math.sin(entity.endAngle),
        },
        "end",
      );
      break;
    case "ellipse":
    case "ellipticalArc": {
      consider({ x: entity.cx, y: entity.cy }, "center");
      const axisEnd = (which: "start" | "end"): EditorPoint => {
        const t = which === "start" ? 0 : Math.PI / 2;
        const u = entity.radiusX * Math.cos(t);
        const v = entity.radiusY * Math.sin(t);
        const c = Math.cos(entity.rotation);
        const s = Math.sin(entity.rotation);
        return {
          x: entity.cx + c * u - s * v,
          y: entity.cy + s * u + c * v,
        };
      };
      consider(axisEnd("start"), "start");
      consider(axisEnd("end"), "end");
      if (entity.kind === "ellipticalArc") {
        const param = (t: number): EditorPoint => {
          const u = entity.radiusX * Math.cos(t);
          const v = entity.radiusY * Math.sin(t);
          const c = Math.cos(entity.rotation);
          const s = Math.sin(entity.rotation);
          return {
            x: entity.cx + c * u - s * v,
            y: entity.cy + s * u + c * v,
          };
        };
        consider(param(entity.startAngle), "start");
        consider(param(entity.endAngle), "end");
      }
      break;
    }
    case "spline": {
      const first = entity.points[0];
      const last = entity.points[entity.points.length - 1];
      if (first !== undefined) consider(first, "start");
      if (last !== undefined) consider(last, "end");
      break;
    }
    case "polygon": {
      consider({ x: entity.cx, y: entity.cy }, "center");
      const effective =
        entity.fit === "inscribed"
          ? entity.radius
          : entity.radius / Math.cos(Math.PI / entity.sides);
      const vertex = (k: number): EditorPoint => {
        const angle = entity.rotation + (Math.PI * 2 * k) / entity.sides;
        return {
          x: entity.cx + effective * Math.cos(angle),
          y: entity.cy + effective * Math.sin(angle),
        };
      };
      consider(vertex(0), "start");
      consider(vertex(1), "end");
      break;
    }
    case "slot": {
      consider({ x: entity.x1, y: entity.y1 }, "start");
      const end =
        entity.variant === "straight"
          ? { x: entity.x2, y: entity.y2 }
          : { x: entity.x3 ?? entity.x2, y: entity.y3 ?? entity.y2 };
      consider(end, "end");
      consider(
        entity.variant === "straight"
          ? {
              x: (entity.x1 + entity.x2) / 2,
              y: (entity.y1 + entity.y2) / 2,
            }
          : { x: entity.x2, y: entity.y2 },
        "center",
      );
      break;
    }
    case "rectangle":
      return null;
  }
  const nearest = candidates.reduce<{
    readonly distance: number;
    readonly point: PointTarget["point"];
  } | null>(
    (best, candidate) =>
      best === null || candidate.distance < best.distance ? candidate : best,
    null,
  );
  return nearest === null ? null : nearest.point;
}

/** The workplane position of a point target (for measuring and annotations). */
export function pointTargetPosition(
  entities: readonly SketchEntity[],
  target: PointTarget,
): EditorPoint | null {
  const entity = entities.find((candidate) => candidate.id === target.entity);
  if (entity === undefined) return null;
  switch (entity.kind) {
    case "point":
      return { x: entity.x, y: entity.y };
    case "circle":
      return { x: entity.cx, y: entity.cy };
    case "line": {
      if (target.point === "start") return { x: entity.x1, y: entity.y1 };
      if (target.point === "end") return { x: entity.x2, y: entity.y2 };
      return {
        x: (entity.x1 + entity.x2) / 2,
        y: (entity.y1 + entity.y2) / 2,
      };
    }
    case "arc": {
      if (target.point === "start") {
        return {
          x: entity.cx + entity.radius * Math.cos(entity.startAngle),
          y: entity.cy + entity.radius * Math.sin(entity.startAngle),
        };
      }
      if (target.point === "end") {
        return {
          x: entity.cx + entity.radius * Math.cos(entity.endAngle),
          y: entity.cy + entity.radius * Math.sin(entity.endAngle),
        };
      }
      return { x: entity.cx, y: entity.cy };
    }
    case "ellipse":
    case "ellipticalArc": {
      const parametric = (t: number): EditorPoint => {
        const u = entity.radiusX * Math.cos(t);
        const v = entity.radiusY * Math.sin(t);
        const c = Math.cos(entity.rotation);
        const s = Math.sin(entity.rotation);
        return {
          x: entity.cx + c * u - s * v,
          y: entity.cy + s * u + c * v,
        };
      };
      if (entity.kind === "ellipse") {
        if (target.point === "start") return parametric(0);
        if (target.point === "end") return parametric(Math.PI / 2);
        return { x: entity.cx, y: entity.cy };
      }
      if (target.point === "start") return parametric(entity.startAngle);
      if (target.point === "end") return parametric(entity.endAngle);
      return { x: entity.cx, y: entity.cy };
    }
    case "spline": {
      const first = entity.points[0];
      const last = entity.points[entity.points.length - 1];
      if (target.point === "start" && first !== undefined) return first;
      if (target.point === "end" && last !== undefined) return last;
      return null;
    }
    case "polygon": {
      if (target.point === "center") return { x: entity.cx, y: entity.cy };
      const effective =
        entity.fit === "inscribed"
          ? entity.radius
          : entity.radius / Math.cos(Math.PI / entity.sides);
      const k = target.point === "start" ? 0 : 1;
      const angle = entity.rotation + (Math.PI * 2 * k) / entity.sides;
      return {
        x: entity.cx + effective * Math.cos(angle),
        y: entity.cy + effective * Math.sin(angle),
      };
    }
    case "slot": {
      if (target.point === "start") return { x: entity.x1, y: entity.y1 };
      if (target.point === "end") {
        return entity.variant === "straight"
          ? { x: entity.x2, y: entity.y2 }
          : { x: entity.x3 ?? entity.x2, y: entity.y3 ?? entity.y2 };
      }
      return entity.variant === "straight"
        ? { x: (entity.x1 + entity.x2) / 2, y: (entity.y1 + entity.y2) / 2 }
        : { x: entity.x2, y: entity.y2 };
    }
    case "rectangle":
      return null;
  }
}

/**
 * The smallest `n >= 1` making `prefix_base-n` an unused id — deterministic
 * id minting from the sketch's own state, so command replay regenerates
 * identical ids. {@link createIdMinter} is the batch form: ids minted in one
 * transaction must not collide with each other either.
 */
function createIdMinter(
  sketch: Sketch,
): (prefix: "skent" | "skcon", base: string) => string {
  const taken = new Set<string>([
    ...sketch.entities.map((entity) => entity.id),
    ...sketch.constraints.map((constraint) => constraint.id),
  ]);
  return (prefix, base) => {
    for (let n = 1; ; n += 1) {
      const candidate = `${prefix}_${base}-${String(n)}`;
      if (!taken.has(candidate)) {
        taken.add(candidate);
        return candidate;
      }
    }
  };
}

/** The angle between two lines' directions, in degrees within (0, 180). */
function angleBetweenDegrees(
  a: {
    readonly x1: number;
    readonly y1: number;
    readonly x2: number;
    readonly y2: number;
  },
  b: {
    readonly x1: number;
    readonly y1: number;
    readonly x2: number;
    readonly y2: number;
  },
): number {
  const angleA = Math.atan2(a.y2 - a.y1, a.x2 - a.x1);
  const angleB = Math.atan2(b.y2 - b.y1, b.x2 - b.x1);
  let delta = Math.abs(((angleA - angleB) * 180) / Math.PI) % 360;
  if (delta > 180) delta = 360 - delta;
  return delta;
}

/**
 * The dimension tool's measured value from the accumulated picks, or `null`
 * when the geometry cannot provide one. distanceX/distanceY measure the
 * SIGNED first→second axis separation (negative and zero legal).
 */
function measuredDimensionValue(
  tool: SketchToolId,
  sketch: Sketch,
  picks: readonly SketchEditorPick[],
): number | null {
  const first = picks[0];
  if (first === undefined) return null;
  const firstEntity = sketch.entities.find(
    (entity) => entity.id === first.entityId,
  );
  if (firstEntity === undefined) return null;
  if (tool === "radius") {
    if (
      firstEntity.kind === "circle" ||
      firstEntity.kind === "arc" ||
      firstEntity.kind === "polygon" ||
      firstEntity.kind === "slot"
    ) {
      return firstEntity.radius;
    }
    return null;
  }
  if (tool === "diameter") {
    if (
      firstEntity.kind === "circle" ||
      firstEntity.kind === "arc" ||
      firstEntity.kind === "polygon" ||
      firstEntity.kind === "slot"
    ) {
      return firstEntity.radius * 2;
    }
    return null;
  }
  const second = picks[1];
  if (second === undefined) return null;
  if (tool === "distance" || tool === "distanceX" || tool === "distanceY") {
    const a = pointTargetPosition(sketch.entities, {
      entity: first.entityId,
      point: first.point ?? "center",
    });
    const b = pointTargetPosition(sketch.entities, {
      entity: second.entityId,
      point: second.point ?? "center",
    });
    if (a === null || b === null) return null;
    if (tool === "distance") return Math.hypot(a.x - b.x, a.y - b.y);
    if (tool === "distanceX") return b.x - a.x;
    return b.y - a.y;
  }
  if (tool === "angle") {
    if (firstEntity.kind !== "line") return null;
    const secondEntity = sketch.entities.find(
      (entity) => entity.id === second.entityId,
    );
    if (secondEntity === undefined || secondEntity.kind !== "line") return null;
    return angleBetweenDegrees(firstEntity, secondEntity);
  }
  return null;
}

/** Segment/segment intersection (workplane mm), `null` when disjoint. */
function segmentIntersection(
  a: EditorPoint,
  b: EditorPoint,
  c: EditorPoint,
  d: EditorPoint,
): EditorPoint | null {
  const r = { x: b.x - a.x, y: b.y - a.y };
  const s = { x: d.x - c.x, y: d.y - c.y };
  const denom = r.x * s.y - r.y * s.x;
  if (denom === 0) return null;
  const t = ((c.x - a.x) * s.y - (c.y - a.y) * s.x) / denom;
  const u = ((c.x - a.x) * r.y - (c.y - a.y) * r.x) / denom;
  if (t < 0 || t > 1 || u < 0 || u > 1) return null;
  return { x: a.x + t * r.x, y: a.y + t * r.y };
}

/** The segment/circle intersection points lying on the segment. */
function segmentCircleIntersections(
  a: EditorPoint,
  b: EditorPoint,
  center: EditorPoint,
  radius: number,
): readonly EditorPoint[] {
  const r = { x: b.x - a.x, y: b.y - a.y };
  const f = { x: a.x - center.x, y: a.y - center.y };
  const rr = r.x * r.x + r.y * r.y;
  if (rr === 0) return [];
  const fr = f.x * r.x + f.y * r.y;
  const ff = f.x * f.x + f.y * f.y - radius * radius;
  const discriminant = fr * fr - rr * ff;
  if (discriminant < 0) return [];
  const root = Math.sqrt(discriminant);
  const points: EditorPoint[] = [];
  for (const t of [(-fr - root) / rr, (-fr + root) / rr]) {
    if (t >= 0 && t <= 1) {
      points.push({ x: a.x + t * r.x, y: a.y + t * r.y });
    }
  }
  return points;
}

/** Whether `point` lies on the CCW arc sweep from start to end angle. */
function withinArcSweep(
  point: EditorPoint,
  entity: {
    readonly cx: number;
    readonly cy: number;
    readonly startAngle: number;
    readonly endAngle: number;
  },
): boolean {
  const angle = Math.atan2(point.y - entity.cy, point.x - entity.cx);
  const normalized = angle < 0 ? angle + Math.PI * 2 : angle;
  const sweep =
    (entity.endAngle - entity.startAngle + Math.PI * 2) % (Math.PI * 2);
  const relative =
    (normalized - entity.startAngle + Math.PI * 2) % (Math.PI * 2);
  return relative <= sweep;
}

/**
 * Trim (disclosed scope): the clicked line's endpoint nearest the click
 * moves to its nearest intersection with another entity, intersections
 * lying ON the segment only — a shrink-only trim against line-line and
 * line-circle/arc contacts. Splitting, extending past the segment, and
 * arc/arc contacts are out of scope. Returns the replacement entity, or
 * `null` when no intersection exists.
 */
function trimEntity(
  sketch: Sketch,
  lineId: SketchEntityId,
  at: EditorPoint,
): SketchEntity | null {
  const line = sketch.entities.find(
    (entity) => entity.id === lineId && entity.kind === "line",
  );
  if (line === undefined || line.kind !== "line") return null;
  const nearEnd =
    Math.hypot(line.x1 - at.x, line.y1 - at.y) <=
    Math.hypot(line.x2 - at.x, line.y2 - at.y)
      ? { x: line.x1, y: line.y1, which: "start" as const }
      : { x: line.x2, y: line.y2, which: "end" as const };
  const far =
    nearEnd.which === "start"
      ? { x: line.x2, y: line.y2 }
      : { x: line.x1, y: line.y1 };
  let best: { readonly point: EditorPoint; readonly distance: number } | null =
    null;
  for (const entity of sketch.entities) {
    if (entity.id === lineId) continue;
    const candidates: readonly EditorPoint[] = (() => {
      if (entity.kind === "line") {
        const hit = segmentIntersection(
          nearEnd,
          far,
          { x: entity.x1, y: entity.y1 },
          { x: entity.x2, y: entity.y2 },
        );
        return hit === null ? [] : [hit];
      }
      if (entity.kind === "circle") {
        return segmentCircleIntersections(
          nearEnd,
          far,
          { x: entity.cx, y: entity.cy },
          entity.radius,
        );
      }
      if (entity.kind === "arc") {
        return segmentCircleIntersections(
          nearEnd,
          far,
          { x: entity.cx, y: entity.cy },
          entity.radius,
        ).filter((point) => withinArcSweep(point, entity));
      }
      return [];
    })();
    for (const point of candidates) {
      const distance = Math.hypot(point.x - nearEnd.x, point.y - nearEnd.y);
      if (best === null || distance < best.distance) {
        best = { distance, point };
      }
    }
  }
  // distance === 0: the near endpoint already sits on the intersection, so
  // trimming would commit a degenerate (zero-length) update — refuse it. The
  // far endpoint needs the same refusal: the intersection helpers accept hits
  // exactly at the far end (t === 1), where the replacement line would also
  // collapse to zero length.
  if (best === null || best.distance === 0) return null;
  if (Math.hypot(best.point.x - far.x, best.point.y - far.y) === 0) {
    return null;
  }
  return nearEnd.which === "start"
    ? createLineEntity(lineId, best.point, far, {
        construction: line.construction,
        fixed: line.fixed,
      })
    : createLineEntity(lineId, far, best.point, {
        construction: line.construction,
        fixed: line.fixed,
      });
}

/** The entity ids a constraint's operands mention (view-model helper). */
export function constraintOperandIds(
  constraint: SketchConstraint,
): readonly string[] {
  switch (constraint.kind) {
    case "coincident":
    case "distance":
    case "distanceX":
    case "distanceY":
    case "horizontalPair":
    case "verticalPair":
      return [constraint.first.entity, constraint.second.entity];
    case "horizontal":
    case "vertical":
    case "radius":
    case "diameter":
      return [constraint.entity];
    case "parallel":
    case "perpendicular":
    case "equal":
    case "tangent":
    case "angle":
    case "collinear":
      return [constraint.first, constraint.second];
    case "pointOnEntity":
      return [constraint.point.entity, constraint.entity];
    case "midpoint":
      return [constraint.point.entity, constraint.line];
    case "symmetry":
      return constraint.about.type === "point"
        ? [
            constraint.first.entity,
            constraint.second.entity,
            constraint.about.point.entity,
          ]
        : [
            constraint.first.entity,
            constraint.second.entity,
            constraint.about.entity,
          ];
  }
}

/** Whether the constraint's operands mention `entityId`. */
function constraintReferences(
  constraint: SketchConstraint,
  entityId: SketchEntityId,
): boolean {
  return constraintOperandIds(constraint).includes(entityId);
}

/** The commands deleting an entity: its referencing constraints first. */
export function deleteEntityCommands(
  sketch: Sketch,
  entityId: SketchEntityId,
):
  | { readonly commands: readonly SketchCommand[] }
  | { readonly problem: string } {
  const referencedByRectangle = sketch.entities.some(
    (entity) => entity.kind === "rectangle" && entity.edges.includes(entityId),
  );
  if (referencedByRectangle) {
    return { problem: SKETCH_EDITOR_STATUS_TEXT.rectangleEdge };
  }
  const commands: SketchCommand[] = [];
  for (const constraint of sketch.constraints) {
    if (constraintReferences(constraint, entityId)) {
      commands.push({
        constraintId: constraint.id,
        type: "sketch.constraint.delete",
      });
    }
  }
  commands.push({ entityId, type: "sketch.entity.delete" });
  return { commands };
}

/**
 * Builds the constraint-creation command from satisfied picks, or `null`
 * when the picked kinds cannot compose (the caller shows the incompatible
 * pick status instead — this is the last-line check after the per-slot
 * checks).
 */
function constraintCommand(
  tool: SketchConstraintTool,
  sketch: Sketch,
  picks: readonly SketchEditorPick[],
): SketchConstraint | null {
  const mint = createIdMinter(sketch);
  const first = picks[0];
  const second = picks[1];
  const entityOf = (
    pick: SketchEditorPick | undefined,
  ): SketchEntity | undefined =>
    pick === undefined
      ? undefined
      : sketch.entities.find((entity) => entity.id === pick.entityId);
  switch (tool) {
    case "horizontal":
    case "vertical": {
      if (first === undefined) return null;
      const id = createSketchConstraintId(mint("skcon", tool));
      return tool === "horizontal"
        ? createHorizontalConstraint(id, first.entityId)
        : createVerticalConstraint(id, first.entityId);
    }
    case "parallel":
    case "perpendicular":
    case "equal":
    case "tangent": {
      if (first === undefined || second === undefined) return null;
      const id = createSketchConstraintId(mint("skcon", tool));
      if (tool === "parallel") {
        return createParallelConstraint(id, first.entityId, second.entityId);
      }
      if (tool === "perpendicular") {
        return createPerpendicularConstraint(
          id,
          first.entityId,
          second.entityId,
        );
      }
      if (tool === "equal") {
        return createEqualConstraint(id, first.entityId, second.entityId);
      }
      return createTangentConstraint(id, first.entityId, second.entityId);
    }
    case "angle": {
      if (first === undefined || second === undefined) return null;
      const value = measuredDimensionValue("angle", sketch, picks);
      if (value === null || !(value > 0 && value < 180)) return null;
      return createAngleConstraint(
        createSketchConstraintId(mint("skcon", tool)),
        first.entityId,
        second.entityId,
        angle(value, "deg"),
      );
    }
    case "coincident":
    case "distance": {
      if (first === undefined || second === undefined) return null;
      const id = createSketchConstraintId(mint("skcon", tool));
      const firstTarget = pointTarget(first.entityId, first.point ?? "center");
      const secondTarget = pointTarget(
        second.entityId,
        second.point ?? "center",
      );
      if (tool === "coincident") {
        return createCoincidentConstraint(id, firstTarget, secondTarget);
      }
      const value = measuredDimensionValue("distance", sketch, picks);
      if (value === null || !(value > 0)) return null;
      return createDistanceConstraint(
        id,
        firstTarget,
        secondTarget,
        length(value),
      );
    }
    case "midpoint": {
      // Picks resolve in either order: the line pick is the line, the other
      // pick is the point.
      const linePick = picks.find((pick) => entityOf(pick)?.kind === "line");
      const pointPick = picks.find((pick) => pick !== linePick);
      if (linePick === undefined || pointPick === undefined) return null;
      return createMidpointConstraint(
        createSketchConstraintId(mint("skcon", tool)),
        pointTarget(pointPick.entityId, pointPick.point ?? "center"),
        linePick.entityId,
      );
    }
    case "radius":
    case "diameter": {
      if (first === undefined) return null;
      const value = measuredDimensionValue(tool, sketch, picks);
      if (value === null || !(value > 0)) return null;
      const dimensionValue: LengthValue = length(value);
      const id = createSketchConstraintId(mint("skcon", tool));
      return tool === "radius"
        ? createRadiusConstraint(id, first.entityId, dimensionValue)
        : createDiameterConstraint(id, first.entityId, dimensionValue);
    }
    case "pointOnEntity": {
      if (first === undefined || second === undefined) return null;
      // Either orientation composes: the pick carrying a POINT TARGET is
      // the point side (a line's start is a legitimate point operand even
      // though a line is also a curve); the pick without one is the curve.
      const pointPick =
        first.point !== null && second.point === null
          ? first
          : second.point !== null && first.point === null
            ? second
            : null;
      const curvePick = pointPick === first ? second : first;
      if (pointPick === null) return null;
      return createPointOnEntityConstraint(
        createSketchConstraintId(mint("skcon", tool)),
        pointTarget(pointPick.entityId, pointPick.point ?? "center"),
        curvePick.entityId,
      );
    }
    case "collinear": {
      if (first === undefined || second === undefined) return null;
      return createCollinearConstraint(
        createSketchConstraintId(mint("skcon", tool)),
        first.entityId,
        second.entityId,
      );
    }
    case "horizontalPair":
    case "verticalPair": {
      if (first === undefined || second === undefined) return null;
      const id = createSketchConstraintId(mint("skcon", tool));
      return tool === "horizontalPair"
        ? createHorizontalPairConstraint(
            id,
            pointTarget(first.entityId, first.point ?? "center"),
            pointTarget(second.entityId, second.point ?? "center"),
          )
        : createVerticalPairConstraint(
            id,
            pointTarget(first.entityId, first.point ?? "center"),
            pointTarget(second.entityId, second.point ?? "center"),
          );
    }
    case "distanceX":
    case "distanceY": {
      if (first === undefined || second === undefined) return null;
      const value = measuredDimensionValue(tool, sketch, picks);
      if (value === null || !Number.isFinite(value)) return null;
      const id = createSketchConstraintId(mint("skcon", tool));
      return tool === "distanceX"
        ? createDistanceXConstraint(
            id,
            pointTarget(first.entityId, first.point ?? "center"),
            pointTarget(second.entityId, second.point ?? "center"),
            length(value),
          )
        : createDistanceYConstraint(
            id,
            pointTarget(first.entityId, first.point ?? "center"),
            pointTarget(second.entityId, second.point ?? "center"),
            length(value),
          );
    }
    default:
      return null;
  }
}

/**
 * The editor reducer: pure over (state, event, sketch). At decision points
 * it returns the transaction to commit; the host applies it and reports a
 * refusal by overriding the status.
 */
export function sketchEditorReducer(
  state: SketchEditorState,
  event: SketchEditorEvent,
  sketch: Sketch,
): SketchEditorTransition {
  switch (event.type) {
    case "activate-tool":
      return {
        state: {
          ...state,
          gesture: { kind: "none" },
          picks: [],
          status: readyStatusFor(event.tool),
          tool: event.tool,
        },
        transaction: null,
      };
    case "hover":
      return {
        state: { ...state, hoveredEntityId: event.entityId },
        transaction: null,
      };
    case "select-constraint":
      return {
        state: { ...state, selectedConstraintId: event.constraintId },
        transaction: null,
      };
    case "clear-selection":
      return {
        state: {
          ...state,
          selectedConstraintId: null,
          selectedEntityIds: [],
        },
        transaction: null,
      };
    case "escape": {
      if (state.gesture.kind === "none" && state.picks.length === 0) {
        return {
          state: {
            ...state,
            status: statusOf("ready", SKETCH_EDITOR_STATUS_TEXT.noGesture),
          },
          transaction: null,
        };
      }
      return {
        state: {
          ...state,
          gesture: { kind: "none" },
          picks: [],
          status: readyStatusFor(state.tool),
        },
        transaction: null,
      };
    }
    case "delete-selection": {
      if (state.selectedConstraintId !== null) {
        return {
          // Clear the selection alongside the emitted delete — mirroring
          // the entity branch clearing selectedEntityIds — so the id cannot
          // dangle after the host applies the transaction and a repeated
          // Delete does not target a nonexistent constraint.
          state: { ...state, selectedConstraintId: null },
          transaction: {
            commands: [
              {
                constraintId: state.selectedConstraintId,
                type: "sketch.constraint.delete",
              },
            ],
          },
        };
      }
      if (state.selectedEntityIds.length === 0) {
        return {
          state: {
            ...state,
            status: statusOf("error", SKETCH_EDITOR_STATUS_TEXT.noSelection),
          },
          transaction: null,
        };
      }
      // Each entity's constraint deletes are computed against the same
      // pre-transaction sketch, so a constraint referencing two selected
      // entities would be deleted twice — and the atomic applier rejects the
      // second delete (constraint-unknown), refusing the whole batch. Collect
      // one constraint delete per constraint id across entities, still before
      // every entity delete (an entity cannot be deleted while referenced).
      const constraintDeletes: SketchCommand[] = [];
      const seenConstraintIds = new Set<SketchConstraintId>();
      const entityDeletes: SketchCommand[] = [];
      for (const entityId of state.selectedEntityIds) {
        const result = deleteEntityCommands(sketch, entityId);
        if ("problem" in result) {
          return {
            state: {
              ...state,
              status: statusOf(
                "error",
                result.problem,
                "sketch-command/entity-referenced",
              ),
            },
            transaction: null,
          };
        }
        for (const command of result.commands) {
          if (command.type !== "sketch.constraint.delete") {
            entityDeletes.push(command);
          } else if (!seenConstraintIds.has(command.constraintId)) {
            seenConstraintIds.add(command.constraintId);
            constraintDeletes.push(command);
          }
        }
      }
      return {
        state: { ...state, selectedEntityIds: [] },
        transaction: { commands: [...constraintDeletes, ...entityDeletes] },
      };
    }
    case "canvas-pick":
      return canvasPick(state, event, sketch);
  }
}

function readyStatusFor(tool: SketchToolId): SketchEditorStatus {
  switch (tool) {
    case "select":
      return statusOf("ready", SKETCH_EDITOR_STATUS_TEXT.readySelect);
    case "line":
      return statusOf("ready", SKETCH_EDITOR_STATUS_TEXT.readyLine);
    case "circle":
      return statusOf("ready", SKETCH_EDITOR_STATUS_TEXT.readyCircle);
    case "rectangle":
      return statusOf("ready", SKETCH_EDITOR_STATUS_TEXT.readyRectangle);
    case "ellipse":
      return statusOf("ready", SKETCH_EDITOR_STATUS_TEXT.readyEllipse);
    case "slot":
      return statusOf("ready", SKETCH_EDITOR_STATUS_TEXT.readySlot);
    case "trim":
      return statusOf("ready", SKETCH_EDITOR_STATUS_TEXT.readyTrim);
    case "construction":
      return statusOf("ready", SKETCH_EDITOR_STATUS_TEXT.readyConstruction);
    default:
      return statusOf(
        "hint",
        SKETCH_EDITOR_STATUS_TEXT.pickNeeded(tool, pickArity(tool)),
      );
  }
}

/** Returns the entity with its construction flag flipped. */
function toggleConstruction(entity: SketchEntity): SketchEntity {
  return { ...entity, construction: !entity.construction };
}

/** The pick flow: drawing gestures, trim, construction toggles, constraints. */
function canvasPick(
  state: SketchEditorState,
  event: { readonly point: EditorPoint; readonly entityId: string | null },
  sketch: Sketch,
): SketchEditorTransition {
  const mint = createIdMinter(sketch);
  const entityById = (id: string | null): SketchEntity | undefined =>
    sketch.entities.find((entity) => entity.id === id);

  switch (state.tool) {
    case "select": {
      const entity = entityById(event.entityId);
      return {
        state: {
          ...state,
          selectedConstraintId: null,
          selectedEntityIds: entity === undefined ? [] : [entity.id],
          status:
            entity === undefined
              ? statusOf("ready", SKETCH_EDITOR_STATUS_TEXT.readySelect)
              : statusOf("hint", `Selected ${entity.id} (${entity.kind}).`),
        },
        transaction: null,
      };
    }
    case "line": {
      if (state.gesture.kind === "line") {
        const start = state.gesture.start;
        if (start.x === event.point.x && start.y === event.point.y) {
          return {
            state: {
              ...state,
              status: statusOf(
                "error",
                SKETCH_EDITOR_STATUS_TEXT.degenerate,
                "sketch/degenerate",
              ),
            },
            transaction: null,
          };
        }
        return {
          state: {
            ...state,
            gesture: { kind: "none" },
            status: statusOf("ready", SKETCH_EDITOR_STATUS_TEXT.readyLine),
          },
          transaction: {
            commands: [
              {
                entity: createLineEntity(
                  createSketchEntityId(mint("skent", "line")),
                  start,
                  event.point,
                ),
                type: "sketch.entity.create",
              },
            ],
          },
        };
      }
      return {
        state: {
          ...state,
          gesture: { kind: "line", start: event.point },
          status: statusOf("hint", SKETCH_EDITOR_STATUS_TEXT.lineEnd),
        },
        transaction: null,
      };
    }
    case "circle": {
      if (state.gesture.kind === "circle") {
        const radius = Math.hypot(
          event.point.x - state.gesture.center.x,
          event.point.y - state.gesture.center.y,
        );
        if (!(radius > 0)) {
          return {
            state: {
              ...state,
              status: statusOf(
                "error",
                SKETCH_EDITOR_STATUS_TEXT.degenerate,
                "sketch/degenerate",
              ),
            },
            transaction: null,
          };
        }
        return {
          state: {
            ...state,
            gesture: { kind: "none" },
            status: statusOf("ready", SKETCH_EDITOR_STATUS_TEXT.readyCircle),
          },
          transaction: {
            commands: [
              {
                entity: createCircleEntity(
                  createSketchEntityId(mint("skent", "circle")),
                  state.gesture.center,
                  radius,
                ),
                type: "sketch.entity.create",
              },
            ],
          },
        };
      }
      return {
        state: {
          ...state,
          gesture: { center: event.point, kind: "circle" },
          status: statusOf("hint", SKETCH_EDITOR_STATUS_TEXT.circleRadius),
        },
        transaction: null,
      };
    }
    case "rectangle": {
      if (state.gesture.kind === "rectangle") {
        const a = state.gesture.corner;
        const b = event.point;
        const x0 = Math.min(a.x, b.x);
        const x1 = Math.max(a.x, b.x);
        const y0 = Math.min(a.y, b.y);
        const y1 = Math.max(a.y, b.y);
        if (x0 === x1 || y0 === y1) {
          return {
            state: {
              ...state,
              status: statusOf(
                "error",
                SKETCH_EDITOR_STATUS_TEXT.degenerate,
                "sketch/degenerate",
              ),
            },
            transaction: null,
          };
        }
        const bottom = createSketchEntityId(mint("skent", "edge"));
        const right = createSketchEntityId(mint("skent", "edge"));
        const top = createSketchEntityId(mint("skent", "edge"));
        const left = createSketchEntityId(mint("skent", "edge"));
        const rect = createSketchEntityId(mint("skent", "rectangle"));
        return {
          state: {
            ...state,
            gesture: { kind: "none" },
            selectedEntityIds: [rect],
            status: statusOf("hint", `Created rectangle ${rect}.`),
          },
          transaction: {
            commands: [
              {
                entity: createLineEntity(
                  bottom,
                  { x: x0, y: y0 },
                  { x: x1, y: y0 },
                ),
                type: "sketch.entity.create",
              },
              {
                entity: createLineEntity(
                  right,
                  { x: x1, y: y0 },
                  { x: x1, y: y1 },
                ),
                type: "sketch.entity.create",
              },
              {
                entity: createLineEntity(
                  top,
                  { x: x1, y: y1 },
                  { x: x0, y: y1 },
                ),
                type: "sketch.entity.create",
              },
              {
                entity: createLineEntity(
                  left,
                  { x: x0, y: y1 },
                  { x: x0, y: y0 },
                ),
                type: "sketch.entity.create",
              },
              {
                entity: createRectangleEntity(rect, [bottom, right, top, left]),
                type: "sketch.entity.create",
              },
            ],
          },
        };
      }
      return {
        state: {
          ...state,
          gesture: { corner: event.point, kind: "rectangle" },
          status: statusOf("hint", SKETCH_EDITOR_STATUS_TEXT.rectangleSecond),
        },
        transaction: null,
      };
    }
    case "ellipse": {
      // Pick 1: center. Pick 2: the axis end (radiusX + rotation from the
      // center→pick direction). Pick 3: the other extent (radiusY from the
      // perpendicular distance to the axis line).
      if (state.gesture.kind === "ellipse") {
        const { center, axis } = state.gesture;
        const radiusX = Math.hypot(axis.x - center.x, axis.y - center.y);
        const rotation = Math.atan2(axis.y - center.y, axis.x - center.x);
        const cosR = Math.cos(rotation);
        const sinR = Math.sin(rotation);
        const wx = event.point.x - center.x;
        const wy = event.point.y - center.y;
        const radiusY = Math.abs(-sinR * wx + cosR * wy);
        if (!(radiusX > 0) || !(radiusY > 0)) {
          return {
            state: {
              ...state,
              status: statusOf(
                "error",
                SKETCH_EDITOR_STATUS_TEXT.degenerate,
                "sketch/degenerate",
              ),
            },
            transaction: null,
          };
        }
        const ellipse = createSketchEntityId(mint("skent", "ellipse"));
        return {
          state: {
            ...state,
            gesture: { kind: "none" },
            selectedEntityIds: [ellipse],
            status: statusOf("hint", `Created ellipse ${ellipse}.`),
          },
          transaction: {
            commands: [
              {
                entity: createEllipseEntity(
                  ellipse,
                  center,
                  radiusX,
                  radiusY,
                  rotation,
                ),
                type: "sketch.entity.create",
              },
            ],
          },
        };
      }
      if (state.gesture.kind === "pick" && state.gesture.tool === "ellipse") {
        const radiusX = Math.hypot(
          event.point.x - state.gesture.point.x,
          event.point.y - state.gesture.point.y,
        );
        if (!(radiusX > 0)) {
          return {
            state: {
              ...state,
              status: statusOf(
                "error",
                SKETCH_EDITOR_STATUS_TEXT.degenerate,
                "sketch/degenerate",
              ),
            },
            transaction: null,
          };
        }
        return {
          state: {
            ...state,
            gesture: {
              kind: "ellipse",
              center: state.gesture.point,
              axis: event.point,
            },
            status: statusOf("hint", SKETCH_EDITOR_STATUS_TEXT.ellipseMinor),
          },
          transaction: null,
        };
      }
      return {
        state: {
          ...state,
          gesture: { kind: "pick", point: event.point, tool: "ellipse" },
          status: statusOf("hint", SKETCH_EDITOR_STATUS_TEXT.ellipseAxis),
        },
        transaction: null,
      };
    }
    case "slot": {
      // Pick 1: start cap center. Pick 2: end cap center. Pick 3: a point
      // whose perpendicular distance to the centerline is the cap radius.
      if (state.gesture.kind === "slot") {
        const { start, end } = state.gesture;
        const dx = end.x - start.x;
        const dy = end.y - start.y;
        const lengthSquared = dx * dx + dy * dy;
        const radius =
          Math.abs(
            (event.point.x - start.x) * dy - (event.point.y - start.y) * dx,
          ) / Math.sqrt(lengthSquared);
        if (!(radius > 0)) {
          return {
            state: {
              ...state,
              status: statusOf(
                "error",
                SKETCH_EDITOR_STATUS_TEXT.degenerate,
                "sketch/degenerate",
              ),
            },
            transaction: null,
          };
        }
        const slot = createSketchEntityId(mint("skent", "slot"));
        return {
          state: {
            ...state,
            gesture: { kind: "none" },
            selectedEntityIds: [slot],
            status: statusOf("hint", `Created slot ${slot}.`),
          },
          transaction: {
            commands: [
              {
                entity: createStraightSlotEntity(slot, start, end, radius),
                type: "sketch.entity.create",
              },
            ],
          },
        };
      }
      if (state.gesture.kind === "pick" && state.gesture.tool === "slot") {
        return {
          state: {
            ...state,
            gesture: {
              kind: "slot",
              start: state.gesture.point,
              end: event.point,
            },
            status: statusOf("hint", SKETCH_EDITOR_STATUS_TEXT.slotRadius),
          },
          transaction: null,
        };
      }
      return {
        state: {
          ...state,
          gesture: { kind: "pick", point: event.point, tool: "slot" },
          status: statusOf("hint", SKETCH_EDITOR_STATUS_TEXT.slotEnd),
        },
        transaction: null,
      };
    }
    case "trim": {
      const entity = entityById(event.entityId);
      if (entity === undefined || entity.kind !== "line") {
        return {
          state: {
            ...state,
            status: statusOf(
              "error",
              SKETCH_EDITOR_STATUS_TEXT.trimNeedsLine,
              "sketch/trim-needs-line",
            ),
          },
          transaction: null,
        };
      }
      const updated = trimEntity(sketch, entity.id, event.point);
      if (updated === null) {
        return {
          state: {
            ...state,
            status: statusOf(
              "error",
              SKETCH_EDITOR_STATUS_TEXT.noIntersection,
              "sketch/no-intersection",
            ),
          },
          transaction: null,
        };
      }
      return {
        state,
        transaction: {
          commands: [{ entity: updated, type: "sketch.entity.update" }],
        },
      };
    }
    case "construction": {
      const entity = entityById(event.entityId);
      if (entity === undefined) return { state, transaction: null };
      const updated = toggleConstruction(entity);
      return {
        state: {
          ...state,
          status: statusOf(
            "hint",
            `${updated.id} is ${updated.construction ? "now construction" : "now real"} geometry.`,
          ),
        },
        transaction: {
          commands: [{ entity: updated, type: "sketch.entity.update" }],
        },
      };
    }
    default: {
      // The constraint tools.
      if (!isSketchConstraintKind(state.tool))
        return { state, transaction: null };
      const tool: SketchConstraintTool = state.tool;
      const entity = entityById(event.entityId);
      if (entity === undefined) return { state, transaction: null };
      const kindProblem = pickKindProblem(tool, entity, state.picks.length);
      if (kindProblem !== null) {
        return {
          state: {
            ...state,
            status: statusOf(
              "error",
              `${SKETCH_EDITOR_STATUS_TEXT.incompatiblePick} (${kindProblem})`,
              "sketch/incompatible-pick",
            ),
          },
          transaction: null,
        };
      }
      if (state.picks.length === 1) {
        const firstPick = state.picks[0];
        if (firstPick === undefined) return { state, transaction: null };
        const firstEntity = entityById(firstPick.entityId);
        if (firstEntity === undefined) return { state, transaction: null };
        const twoEntityTool =
          tool === "equal" ||
          tool === "parallel" ||
          tool === "perpendicular" ||
          tool === "angle" ||
          tool === "tangent" ||
          tool === "collinear" ||
          tool === "pointOnEntity";
        if (twoEntityTool && firstPick.entityId === entity.id) {
          return {
            state: {
              ...state,
              status: statusOf(
                "error",
                SKETCH_EDITOR_STATUS_TEXT.distinctPick,
                "sketch/incompatible-pick",
              ),
            },
            transaction: null,
          };
        }
        const pair = pairProblem(tool, firstEntity, entity);
        if (pair !== null) {
          return {
            state: {
              ...state,
              status: statusOf(
                "error",
                `${SKETCH_EDITOR_STATUS_TEXT.incompatiblePick} (${pair})`,
                "sketch/incompatible-pick",
              ),
            },
            transaction: null,
          };
        }
      }
      const pick: SketchEditorPick = {
        entityId: entity.id,
        point: pickUsesPointTarget(tool, state.picks.length)
          ? nearestPointTarget(entity, event.point)
          : null,
      };
      const picks = [...state.picks, pick];
      if (picks.length < pickArity(tool)) {
        return {
          state: {
            ...state,
            picks,
            status: statusOf(
              "hint",
              SKETCH_EDITOR_STATUS_TEXT.pickNeeded(
                tool,
                pickArity(tool) - picks.length,
              ),
            ),
          },
          transaction: null,
        };
      }
      const built = constraintCommand(tool, sketch, picks);
      if (built === null) {
        return {
          state: {
            ...state,
            status: statusOf(
              "error",
              SKETCH_EDITOR_STATUS_TEXT.incompatiblePick,
              "sketch/incompatible-pick",
            ),
          },
          transaction: null,
        };
      }
      const referenceProblem = validateConstraintReferences(
        built,
        sketch.entities,
      );
      if (referenceProblem !== null) {
        return {
          state: {
            ...state,
            status: statusOf(
              "error",
              referenceProblem.message,
              referenceProblem.code,
            ),
          },
          transaction: null,
        };
      }
      return {
        state: {
          ...state,
          picks: [],
          selectedConstraintId: built.id,
          status: statusOf(
            "ready",
            SKETCH_EDITOR_STATUS_TEXT.constraintApplied,
          ),
        },
        transaction: {
          commands: [{ constraint: built, type: "sketch.constraint.create" }],
        },
      };
    }
  }
}

// ---------------------------------------------------------------------------
// View model
// ---------------------------------------------------------------------------

/** The canvas view model: entities, regions, annotations. */
export interface SketchViewModel {
  readonly entities: readonly CadSketchCanvasEntity[];
  readonly regions: readonly CadSketchCanvasRegion[];
  readonly annotations: readonly CadSketchCanvasAnnotation[];
}

/**
 * The canvas transform constants the workbench renders with — documented so
 * the e2e specs derive click points from workplane coordinates instead of
 * guessing pixels.
 */
export const SKETCH_CANVAS = {
  gridStep: 10,
  height: 520,
  /** Screen position of the workplane origin (CSS px). */
  origin: { x: 120, y: 400 },
  scale: 6,
  width: 800,
} as const;

function diagnosticLevelFor(
  id: string,
  diagnostics: readonly SketchDiagnostic[],
): CadSketchDiagnosticLevel {
  let level: CadSketchDiagnosticLevel = "none";
  for (const diagnostic of diagnostics) {
    if (diagnostic.location?.primary !== id) continue;
    if (diagnostic.severity === "error") return "error";
    if (diagnostic.severity === "warning") level = "warning";
  }
  return level;
}

/**
 * The geometry a canvas entity draws: solved parameters when a solve is
 * available, the authored entity otherwise — the two records are structurally
 * identical for every drawable kind, so one switch styles either.
 */
type EntityGeometry = SketchEntity | SolvedEntityParameters;

function canvasEntity(
  geometry: EntityGeometry,
  authored: SketchEntity,
  selected: boolean,
  diagnostic: CadSketchDiagnosticLevel,
): CadSketchCanvasEntity | null {
  const common = {
    construction: authored.construction,
    diagnostic,
    id: geometry.id,
    selected,
  };
  switch (geometry.kind) {
    case "point":
      return { ...common, kind: "point", x: geometry.x, y: geometry.y };
    case "ellipse":
      return {
        ...common,
        kind: "ellipse",
        cx: geometry.cx,
        cy: geometry.cy,
        radiusX: geometry.radiusX,
        radiusY: geometry.radiusY,
        rotation: geometry.rotation,
      };
    case "ellipticalArc":
      return {
        ...common,
        kind: "ellipticalArc",
        cx: geometry.cx,
        cy: geometry.cy,
        radiusX: geometry.radiusX,
        radiusY: geometry.radiusY,
        rotation: geometry.rotation,
        startAngle: geometry.startAngle,
        endAngle: geometry.endAngle,
      };
    case "spline":
    case "polygon":
    case "slot": {
      // The polyline kinds tessellate at the domain's fixed deflection; the
      // discrete parameters (flavor, sides, fit, variant) come from the
      // AUTHORED entity, which the solved records deliberately omit.
      void geometry;
      const points = entityPolyline(authored);
      if (points === null || points.length < 2) return null;
      return {
        ...common,
        kind: "polyline",
        points: points.map((point) => ({ x: point.x, y: point.y })),
      };
    }
    case "line":
      return {
        ...common,
        kind: "line",
        x1: geometry.x1,
        x2: geometry.x2,
        y1: geometry.y1,
        y2: geometry.y2,
      };
    case "circle":
      return {
        ...common,
        cx: geometry.cx,
        cy: geometry.cy,
        kind: "circle",
        radius: geometry.radius,
      };
    case "arc":
      return {
        ...common,
        cx: geometry.cx,
        cy: geometry.cy,
        endAngle: geometry.endAngle,
        kind: "arc",
        radius: geometry.radius,
        startAngle: geometry.startAngle,
      };
    case "rectangle":
      return null;
  }
}

function dimensionText(constraint: SketchConstraint): string | null {
  switch (constraint.kind) {
    case "distance":
      return `${String(valueIn(constraint.value, "mm"))} mm`;
    case "distanceX":
      return `Δx ${String(valueIn(constraint.value, "mm"))} mm`;
    case "distanceY":
      return `Δy ${String(valueIn(constraint.value, "mm"))} mm`;
    case "radius":
      return `R ${String(valueIn(constraint.value, "mm"))}`;
    case "diameter":
      return `⌀ ${String(valueIn(constraint.value, "mm"))}`;
    case "angle":
      return `${String(valueIn(constraint.value, "deg"))}°`;
    default:
      return null;
  }
}

/** Annotation anchor for a dimensional constraint, workplane mm. */
function dimensionAnchor(
  sketch: Sketch,
  constraint: SketchConstraint,
): EditorPoint | null {
  switch (constraint.kind) {
    case "distance":
    case "distanceX":
    case "distanceY": {
      const a = pointTargetPosition(sketch.entities, constraint.first);
      const b = pointTargetPosition(sketch.entities, constraint.second);
      if (a === null || b === null) return null;
      return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    }
    case "radius":
    case "diameter": {
      const entity = sketch.entities.find(
        (candidate) => candidate.id === constraint.entity,
      );
      if (
        entity !== undefined &&
        (entity.kind === "circle" || entity.kind === "arc")
      ) {
        return { x: entity.cx, y: entity.cy };
      }
      return null;
    }
    case "angle": {
      const entity = sketch.entities.find(
        (candidate) => candidate.id === constraint.first,
      );
      if (entity === undefined || entity.kind !== "line") return null;
      return {
        x: (entity.x1 + entity.x2) / 2,
        y: (entity.y1 + entity.y2) / 2 + 6,
      };
    }
    default:
      return null;
  }
}

/** Constraint label for the inspector list (host data, verbatim). */
export function constraintLabel(constraint: SketchConstraint): string {
  const text = dimensionText(constraint);
  return text === null ? constraint.kind : `${constraint.kind} ${text}`;
}

/**
 * Derives the canvas view model: the SOLVED geometry (or the authored sketch
 * when no solve is available), styled by selection, construction, and
 * diagnostics; rectangles as corner polygons; dimension labels and problem
 * badges as annotations.
 */
export function sketchViewModel(
  sketch: Sketch,
  solved: Sketch | null,
  selection: { readonly entityIds: readonly string[] },
  diagnostics: readonly SketchDiagnostic[],
): SketchViewModel {
  const selectedIds = new Set(selection.entityIds);
  const geometryById = new Map<string, EntityGeometry>();
  for (const entity of sketch.entities) {
    geometryById.set(entity.id, entity);
  }
  if (solved !== null) {
    for (const entity of solved.entities) {
      geometryById.set(entity.id, entity);
    }
  }
  const entities: CadSketchCanvasEntity[] = [];
  const regions: CadSketchCanvasRegion[] = [];
  for (const authored of sketch.entities) {
    const geometry = geometryById.get(authored.id);
    if (geometry === undefined) continue;
    if (authored.kind === "rectangle") {
      // Edge order is bottom, right, top, left for a CCW chain: the corner
      // polygon is bottom.start, bottom.end, right.end, top.end — each read
      // from the SOLVED edge geometry so the face follows the solver. The
      // topology (which edges) comes from the authored rectangle.
      const edgeCorner = (
        edgeId: string,
        which: "start" | "end",
      ): EditorPoint | null => {
        const edge = geometryById.get(edgeId);
        if (edge === undefined || edge.kind !== "line") return null;
        return which === "start"
          ? { x: edge.x1, y: edge.y1 }
          : { x: edge.x2, y: edge.y2 };
      };
      const c0 = edgeCorner(authored.edges[0], "start");
      const c1 = edgeCorner(authored.edges[0], "end");
      const c2 = edgeCorner(authored.edges[1], "end");
      const c3 = edgeCorner(authored.edges[2], "end");
      if (c0 !== null && c1 !== null && c2 !== null && c3 !== null) {
        regions.push({
          diagnostic: diagnosticLevelFor(authored.id, diagnostics),
          id: authored.id,
          points: [c0, c1, c2, c3],
          selected: selectedIds.has(authored.id),
        });
      }
      continue;
    }
    const node = canvasEntity(
      geometry,
      authored,
      selectedIds.has(authored.id),
      diagnosticLevelFor(authored.id, diagnostics),
    );
    if (node !== null) entities.push(node);
  }
  const annotations: CadSketchCanvasAnnotation[] = [];
  // Dimension labels stack when they share an anchor (two dimensions on the
  // same targets): each duplicate shifts 2 mm up per prior occupant, so
  // every label stays readable.
  const anchorOccupancy = new Map<string, number>();
  for (const constraint of sketch.constraints) {
    const text = dimensionText(constraint);
    const anchor = text === null ? null : dimensionAnchor(sketch, constraint);
    if (text !== null && anchor !== null) {
      const anchorKey = `${anchor.x}:${anchor.y}`;
      const occupants = anchorOccupancy.get(anchorKey) ?? 0;
      anchorOccupancy.set(anchorKey, occupants + 1);
      const level = diagnosticLevelFor(constraint.id, diagnostics);
      annotations.push({
        id: constraint.id,
        kind: "dimension",
        level: level === "none" ? "info" : level,
        text,
        x: anchor.x,
        y: anchor.y + occupants * 2,
      });
    }
    for (const diagnostic of diagnostics) {
      if (
        diagnostic.location?.primary === constraint.id &&
        diagnostic.severity !== "info"
      ) {
        annotations.push({
          id: `${constraint.id}:${diagnostic.code}`,
          kind: "constraint",
          level: diagnostic.severity,
          text: diagnostic.code.replace("sketch/", ""),
          x: SKETCH_CANVAS_BADGE_XY.x,
          y: SKETCH_CANVAS_BADGE_XY.y,
        });
      }
    }
  }
  return { annotations, entities, regions };
}

/** Badge anchor for problem diagnostics without a geometry anchor. */
const SKETCH_CANVAS_BADGE_XY: EditorPoint = { x: 6, y: 60 };

/** The serialized machine surface of the sketch (entities + constraints). */
export function sketchSurface(sketch: Sketch): {
  readonly constraints: readonly ReturnType<typeof serializeSketchConstraint>[];
  readonly entities: readonly ReturnType<typeof serializeSketchEntity>[];
} {
  return {
    constraints: sketch.constraints.map(serializeSketchConstraint),
    entities: sketch.entities.map(serializeSketchEntity),
  };
}

/** Creates the workbench's boot sketch: an empty XY-workplane sketch. */
export function createWorkbenchSketch(): Sketch {
  const created = createSketch(xyWorkplane(), [], []);
  if (!created.ok) {
    throw new Error(`Workbench sketch rejected: ${created.error.message}`);
  }
  return created.value;
}
