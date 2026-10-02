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

import { angle, length, type LengthValue } from "@slopcad/cad-core";
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
  createPointEntity,
  createPointOnEntityConstraint,
  createPointOnTangentConstraint,
  createPolygonEntity,
  createRadiusConstraint,
  createRectangleEntity,
  createSketch,
  createSketchConstraintId,
  createSketchEntityId,
  createSplineEntity,
  createStraightSlotEntity,
  createTangentConstraint,
  createVerticalConstraint,
  createVerticalPairConstraint,
  dimensionText,
  entityPolyline,
  extendLineCommand,
  isSketchConstraintKind,
  mirrorEntitiesCommands,
  offsetEntitiesCommands,
  pointTarget,
  pointTargetPosition,
  serializeSketchConstraint,
  serializeSketchEntity,
  translateSketchEntity,
  sketchDimensionPresentations,
  validateConstraintReferences,
  xyWorkplane,
  SKETCH_ENTITY_OP_ERROR_CODES,
  type DimensionPresentation,
  type PointTarget,
  type Sketch,
  type SketchCommand,
  type SketchConstraint,
  type SketchConstraintId,
  type SketchDiagnostic,
  type SketchEntity,
  type SketchEntityId,
  type SketchConstrainedness,
  type SketchTransaction,
  type SolvedEntityParameters,
  type SplineEndSelection,
  type Workplane,
} from "@slopcad/cad-sketch";
import type {
  CadSketchCanvasAnnotation,
  CadSketchCanvasDimension,
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
  "spline",
  "polygon",
] as const;

/**
 * The entity-operation tools of the second cluster (Phase 37): offset,
 * mirror, the arrays, extend, and convert — the multi-entity grammar the
 * domain's `entity-ops`/`convert` modules back — plus the POINT entity
 * placement (Phase 42): a single-pick primitive that rides the edit
 * cluster's tail so the DRAWING cluster's positional shortcut row (the
 * digit keys) keeps its documented assignment.
 */
export const SKETCH_EDIT_TOOLS = [
  "offset",
  "mirror",
  "extend",
  "rectArray",
  "circArray",
  "convert",
  "point",
] as const;

/** The constraint tools of the third cluster (the domain's kind names). */
export const SKETCH_CONSTRAINT_TOOLS = [
  "coincident",
  "horizontal",
  "vertical",
  "pointOnEntity",
  "pointOnTangent",
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
export type SketchEditTool = (typeof SKETCH_EDIT_TOOLS)[number];
export type SketchConstraintTool = (typeof SKETCH_CONSTRAINT_TOOLS)[number];
export type SketchToolId =
  SketchDrawingTool | SketchEditTool | SketchConstraintTool;

const SKETCH_TOOL_ID_SET: ReadonlySet<string> = new Set<string>([
  ...SKETCH_DRAWING_TOOLS,
  ...SKETCH_EDIT_TOOLS,
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
      /**
       * Control spline: four picks commit one cubic Bézier (the control
       * flavor's minimal count). The picks accumulate as the controls.
       */
      readonly kind: "spline";
      readonly points: readonly EditorPoint[];
    }
  | {
      /** Polygon after the center pick: the vertex pick sets radius + rotation. */
      readonly kind: "polygon";
      readonly center: EditorPoint;
    }
  | {
      /**
       * The first pick of a multi-pick gesture: ellipse/slot centerline
       * picks, the offset's source entity (entityId), or the offset's
       * second (point) pick via the offset gesture below.
       */
      readonly kind: "pick";
      readonly tool: "ellipse" | "slot" | "offset";
      readonly point: EditorPoint;
      /** The picked entity, when the gesture addresses one (offset). */
      readonly entityId?: SketchEntityId;
    }
  | {
      /**
       * Offset's second pick pending: the source entity is fixed; the next
       * click's distance and side from it set the offset.
       */
      readonly kind: "offset";
      readonly entityId: SketchEntityId;
      readonly point: EditorPoint;
    }
  | {
      /**
       * Mirror after the axis pick: each further click mirrors that entity
       * about the axis and the tool stays armed for more.
       */
      readonly kind: "mirror";
      readonly axisId: SketchEntityId;
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

/**
 * The active pointer drag (Phase 37): which entity is being dragged, how
 * the grab maps to geometry (an endpoint, a spline control, or a rigid
 * translate), the grab's start point, and the entity's pre-drag values.
 */
export interface SketchEditorDrag {
  readonly entityId: SketchEntityId;
  readonly mode:
    | { readonly kind: "endpoint"; readonly which: "start" | "end" }
    | { readonly kind: "spline-point"; readonly index: number }
    | { readonly kind: "translate" };
  readonly start: EditorPoint;
  readonly original: SketchEntity;
}

/** The pure editor state the sketch UI renders from. */
export interface SketchEditorState {
  readonly tool: SketchToolId;
  readonly gesture: SketchGesture;
  /** The live pointer drag, when one is in progress. */
  readonly drag: SketchEditorDrag | null;
  /**
   * The drag's provisional geometry (not yet committed): the host overlays
   * it on the sketch and re-solves per move.
   */
  readonly provisional: SketchEntity | null;
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
  readyPoint: "Point: click to place a point entity.",
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
  readySpline: "Spline: click four control points (one cubic Bézier segment).",
  splineNext: (remaining: number): string =>
    `Spline: click ${String(remaining)} more control point${remaining === 1 ? "" : "s"}.`,
  readyPolygon:
    "Polygon: click the center, then the first vertex (6 sides, inscribed).",
  polygonVertex: "Polygon: click the first vertex (sets size and rotation).",
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
  readyOffset:
    "Offset: click an entity (a chain of selected lines offsets together).",
  offsetSecond:
    "Offset: click a point — its distance and side from the pick set the offset.",
  readyMirror: "Mirror: click a line to serve as the mirror axis.",
  mirrorPick:
    "Mirror: click entities to mirror about the axis (each click commits).",
  readyExtend:
    "Extend: click a line near the end to grow it to the nearest boundary.",
  readyRectArray:
    "Rectangular array: select entities, set counts and spacings in the inspector, apply.",
  readyCircArray:
    "Circular array: select entities, set count, step, and center in the inspector, apply.",
  readyConvert:
    "Convert: pick model vertices from the topology list in the inspector.",
  convertNoTopology:
    "Convert: no topology view is available in this host — model geometry cannot be converted here.",
  converted: (count: number): string =>
    `Converted ${String(count)} model ${count === 1 ? "vertex" : "vertices"} to construction points.`,
  convertDeclined: (count: number): string =>
    `${String(count)} reference${count === 1 ? "" : "s"} declined (see the inspector).`,
  arrayApplied: (count: number): string =>
    `Array applied: ${String(count)} ${count === 1 ? "copy" : "copies"} created.`,
  dragged: "Drag committed: the constraints re-solved to hold.",
  dragRefused: "Drag refused: the constraints reject the moved geometry.",
} as const;

/** The editor's boot state: the select tool, empty everything. */
export function createSketchEditorState(): SketchEditorState {
  return {
    drag: null,
    gesture: { kind: "none" },
    hoveredEntityId: null,
    picks: [],
    provisional: null,
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
  | { readonly type: "clear-selection" }
  | {
      /** A pointer drag begins on an entity (Phase 37's drag interaction). */
      readonly type: "drag-start";
      readonly entityId: string;
      readonly point: EditorPoint;
    }
  | {
      /** The drag moves: re-derive the provisional geometry. */
      readonly type: "drag-move";
      readonly point: EditorPoint;
    }
  | { readonly type: "drag-end"; readonly point: EditorPoint }
  | {
      /** The host surfaces a status (op outcomes outside the canvas flow). */
      readonly type: "note-status";
      readonly status: SketchEditorStatus;
    };

/** The reducer's outcome: the next state plus the transaction to commit. */
export interface SketchEditorTransition {
  readonly state: SketchEditorState;
  readonly transaction: SketchTransaction | null;
  /**
   * The drag's provisional entity (Phase 37): display-only geometry the
   * host overlays and re-solves per move; never a transaction. `null`
   * whenever no live drag produced new geometry.
   */
  readonly provisional: SketchEntity | null;
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
    case "pointOnTangent":
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
    case "parallel":
    case "perpendicular":
    case "angle":
    case "pointOnTangent":
      // The direction constraints record the spline pick's nearest end to
      // address `at`; pointOnTangent addresses a point and a spline end.
      return true;
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
    entity.kind === "spline" ||
    entity.kind === "polygon" ||
    (entity.kind === "slot" && entity.variant === "straight")
  );
}

/** Whether `entity` is a spline operand a direction/tangent tool accepts. */
function isSpline(entity: SketchEntity): boolean {
  return entity.kind === "spline";
}

/** The polygon drawing tool's fixed side count (a discrete parameter). */
export const POLYGON_TOOL_SIDES = 6;

/**
 * The drag grab radius (workplane mm) within which a press near a line
 * endpoint drags THAT endpoint instead of translating the entity — the
 * canvas's 8 px hit tolerance mapped through the workbench's 6 px/mm scale
 * ({@link SKETCH_CANVAS.scale}).
 */
export const ENDPOINT_GRAB_MM = 8 / 6;

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
      return isLine ? null : "needs a line";
    case "parallel":
    case "perpendicular":
    case "angle":
      return isLine || isSpline(entity)
        ? null
        : "needs a line or a spline's end tangent";
    case "collinear":
      return isLine ? null : "needs a line";
    case "equal":
      return isLine || isCircular || isSpline(entity)
        ? null
        : "needs a line, circle/arc, or spline";
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
          : "needs a curve (line, circle/arc, ellipse, spline, polygon, or slot)";
    case "pointOnTangent":
      return pickIndex === 0
        ? isPointCapable
          ? null
          : "needs a point-capable entity"
        : isSpline(entity)
          ? null
          : "needs a spline";
    case "tangent":
      return isLine || isCircular || isSpline(entity)
        ? null
        : "needs a line, circle/arc, or spline";
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
  const firstSpline = first.kind === "spline";
  const secondSpline = second.kind === "spline";
  switch (tool) {
    case "equal":
      if (firstLine && secondLine) return null;
      if (firstCircular && secondCircular) return null;
      if ((firstLine || firstSpline) && (secondLine || secondSpline)) {
        return null;
      }
      return "equal needs two lines, two circles/arcs, or lines and splines (endpoint chords)";
    case "parallel":
    case "perpendicular":
    case "angle":
      if (firstLine && secondLine) return null;
      if (firstLine && secondSpline) return null;
      if (firstSpline && secondLine) return null;
      return `${tool} needs two lines, or a line and a spline (two splines have no direction pair)`;
    case "tangent":
      if (firstLine && secondCircular) return null;
      if (firstCircular && secondLine) return null;
      if (firstCircular && secondCircular) return null;
      if (firstLine && secondSpline) return null;
      if (firstSpline && secondLine) return null;
      if (firstSpline && secondSpline) return null;
      return "tangent needs a line and a circle/arc or spline, two circles/arcs, or two splines";
    case "pointOnEntity": {
      const isCurve = (entity: SketchEntity): boolean =>
        entity.kind === "line" ||
        entity.kind === "circle" ||
        entity.kind === "arc" ||
        entity.kind === "ellipse" ||
        entity.kind === "ellipticalArc" ||
        entity.kind === "spline" ||
        entity.kind === "polygon" ||
        (entity.kind === "slot" && entity.variant === "straight");
      // Either orientation composes: the curve pick pins the other's point.
      if (isCurve(second) && first.kind !== "rectangle") return null;
      if (isCurve(first) && second.kind !== "rectangle") return null;
      return "pointOnEntity needs a point-capable pick and a curve pick (line, circle/arc, ellipse, spline, polygon, or slot)";
    }
    case "pointOnTangent": {
      if (firstSpline && secondSpline) {
        return "pointOnTangent needs a point pick and a spline pick";
      }
      if (firstSpline || secondSpline) return null;
      return "pointOnTangent needs a point pick and a spline pick";
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
    const secondEntity = sketch.entities.find(
      (entity) => entity.id === second.entityId,
    );
    if (secondEntity === undefined) return null;
    // A spline operand contributes its END tangent direction (the same
    // direction the constraint's row addresses; parallel to P1 − P0 /
    // P_{N−1} − P_{N−2} on both flavors).
    const directionOf = (
      entity: SketchEntity,
      pick: SketchEditorPick,
    ): { readonly x: number; readonly y: number } | null => {
      if (entity.kind === "line") {
        return { x: entity.x2 - entity.x1, y: entity.y2 - entity.y1 };
      }
      if (entity.kind !== "spline" || entity.points.length < 2) return null;
      const end = pick.point === "start" ? 0 : entity.points.length - 2;
      const a = entity.points[end];
      const b = entity.points[end + 1];
      if (a === undefined || b === undefined) return null;
      return { x: b.x - a.x, y: b.y - a.y };
    };
    const a = directionOf(firstEntity, first);
    const b = directionOf(secondEntity, second);
    if (a === null || b === null) return null;
    return angleBetweenDegrees(
      { x1: 0, y1: 0, x2: a.x, y2: a.y },
      { x1: 0, y1: 0, x2: b.x, y2: b.y },
    );
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
    case "pointOnTangent":
      return [constraint.point.entity, constraint.spline];
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
      // A spline pick addresses its nearest end (`at`) for the direction
      // rows; the point target was recorded by pickUsesPointTarget.
      const atOf = (pick: SketchEditorPick): SplineEndSelection | undefined => {
        const entity = entityOf(pick);
        // A spline's nearest point target is always start/end; any other
        // recorded target defaults to the doc's "end".
        return entity !== undefined && entity.kind === "spline"
          ? pick.point === "start"
            ? "start"
            : "end"
          : undefined;
      };
      if (tool === "parallel") {
        return createParallelConstraint(
          id,
          first.entityId,
          second.entityId,
          atOf(first) ?? atOf(second),
        );
      }
      if (tool === "perpendicular") {
        return createPerpendicularConstraint(
          id,
          first.entityId,
          second.entityId,
          atOf(first) ?? atOf(second),
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
      const atOf = (pick: SketchEditorPick): SplineEndSelection | undefined => {
        const entity = entityOf(pick);
        // A spline's nearest point target is always start/end; any other
        // recorded target defaults to the doc's "end".
        return entity !== undefined && entity.kind === "spline"
          ? pick.point === "start"
            ? "start"
            : "end"
          : undefined;
      };
      return createAngleConstraint(
        createSketchConstraintId(mint("skcon", tool)),
        first.entityId,
        second.entityId,
        angle(value, "deg"),
        atOf(first) ?? atOf(second),
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
    case "pointOnTangent": {
      if (first === undefined || second === undefined) return null;
      // Either orientation composes: the pick on the SPLINE is the curve
      // side; the other (which carries a point target) is the point.
      const splinePick = entityOf(first)?.kind === "spline" ? first : second;
      const pointPick = splinePick === first ? second : first;
      if (entityOf(splinePick)?.kind !== "spline") return null;
      return createPointOnTangentConstraint(
        createSketchConstraintId(mint("skcon", tool)),
        pointTarget(pointPick.entityId, pointPick.point ?? "center"),
        splinePick.entityId,
        splinePick.point === "start" ? "start" : "end",
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
 * refusal by overriding the status. Drag events (Phase 37) derive the
 * provisional drag geometry instead of transactions — the host re-solves
 * per move and commits once at drag end.
 */
interface SketchEditorCoreTransition {
  readonly state: SketchEditorState;
  readonly transaction: SketchTransaction | null;
}

function sketchEditorCore(
  state: SketchEditorState,
  event: SketchEditorEvent,
  sketch: Sketch,
): SketchEditorCoreTransition {
  switch (event.type) {
    case "activate-tool":
      return {
        state: {
          ...state,
          drag: null,
          gesture: { kind: "none" },
          picks: [],
          provisional: null,
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
      if (state.drag !== null || state.provisional !== null) {
        // An escape during a drag discards the provisional geometry.
        return {
          state: { ...state, drag: null, provisional: null },
          transaction: null,
        };
      }
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
    case "drag-start": {
      // Dragging is the select tool's gesture: other tools ignore it.
      if (state.tool !== "select") return { state, transaction: null };
      const entity = sketch.entities.find(
        (candidate) => candidate.id === event.entityId,
      );
      if (entity === undefined || entity.kind === "rectangle") {
        return { state, transaction: null };
      }
      const mode = dragModeFor(entity, event.point);
      if (mode === null) return { state, transaction: null };
      return {
        state: {
          ...state,
          drag: {
            entityId: entity.id,
            mode,
            original: entity,
            start: event.point,
          },
        },
        transaction: null,
      };
    }
    case "drag-move": {
      if (state.drag === null) return { state, transaction: null };
      return {
        state: {
          ...state,
          provisional: draggedEntity(state.drag, event.point),
        },
        transaction: null,
      };
    }
    case "drag-end": {
      const drag = state.drag;
      if (drag === null) return { state, transaction: null };
      const dragged = draggedEntity(drag, event.point);
      if (dragged === null) {
        return { state: { ...state, drag: null }, transaction: null };
      }
      return {
        state: {
          ...state,
          drag: null,
          provisional: null,
          status: statusOf("hint", SKETCH_EDITOR_STATUS_TEXT.dragged),
        },
        transaction: {
          commands: [{ entity: dragged, type: "sketch.entity.update" }],
        },
      };
    }
    case "note-status":
      return { state: { ...state, status: event.status }, transaction: null };
  }
}

/**
 * The public reducer: the core transition plus the provisional drag
 * geometry, surfaced at the top level for the host's per-move re-solve.
 */
export function sketchEditorReducer(
  state: SketchEditorState,
  event: SketchEditorEvent,
  sketch: Sketch,
): SketchEditorTransition {
  const core = sketchEditorCore(state, event, sketch);
  return { ...core, provisional: core.state.provisional };
}

/**
 * How a grab at `at` maps to geometry changes on `entity` (the documented
 * drag grammar): near a line's endpoint the endpoint moves; near a spline's
 * control/fit point that point moves; anything else drags rigidly.
 */
function dragModeFor(
  entity: SketchEntity,
  at: EditorPoint,
): SketchEditorDrag["mode"] | null {
  switch (entity.kind) {
    case "line": {
      const toStart = Math.hypot(entity.x1 - at.x, entity.y1 - at.y);
      const toEnd = Math.hypot(entity.x2 - at.x, entity.y2 - at.y);
      if (toStart <= ENDPOINT_GRAB_MM || toEnd <= ENDPOINT_GRAB_MM) {
        return toStart <= toEnd
          ? { kind: "endpoint", which: "start" }
          : { kind: "endpoint", which: "end" };
      }
      return { kind: "translate" };
    }
    case "spline": {
      let nearest = -1;
      let nearestDistance = Number.POSITIVE_INFINITY;
      for (let index = 0; index < entity.points.length; index += 1) {
        const point = entity.points[index];
        if (point === undefined) continue;
        const distance = Math.hypot(point.x - at.x, point.y - at.y);
        if (distance < nearestDistance) {
          nearestDistance = distance;
          nearest = index;
        }
      }
      return nearest >= 0
        ? { kind: "spline-point", index: nearest }
        : { kind: "translate" };
    }
    case "rectangle":
      return null;
    default:
      return { kind: "translate" };
  }
}

/** The drag's provisional entity at `point`, or `null` when undraggable. */
function draggedEntity(
  drag: SketchEditorDrag,
  point: EditorPoint,
): SketchEntity | null {
  const { mode, original } = drag;
  switch (mode.kind) {
    case "endpoint": {
      if (original.kind !== "line") return null;
      return mode.which === "start"
        ? createLineEntity(
            original.id,
            point,
            { x: original.x2, y: original.y2 },
            {
              construction: original.construction,
              fixed: original.fixed,
            },
          )
        : createLineEntity(
            original.id,
            { x: original.x1, y: original.y1 },
            point,
            {
              construction: original.construction,
              fixed: original.fixed,
            },
          );
    }
    case "spline-point": {
      if (original.kind !== "spline") return null;
      return createSplineEntity(
        original.id,
        original.flavor,
        original.points.map((candidate, index) =>
          index === mode.index ? { x: point.x, y: point.y } : candidate,
        ),
        { construction: original.construction, fixed: original.fixed },
      );
    }
    case "translate":
      return translateSketchEntity(
        original,
        original.id,
        point.x - drag.start.x,
        point.y - drag.start.y,
      );
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
    case "point":
      return statusOf("ready", SKETCH_EDITOR_STATUS_TEXT.readyPoint);
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
    case "spline":
      return statusOf("ready", SKETCH_EDITOR_STATUS_TEXT.readySpline);
    case "polygon":
      return statusOf("ready", SKETCH_EDITOR_STATUS_TEXT.readyPolygon);
    case "offset":
      return statusOf("ready", SKETCH_EDITOR_STATUS_TEXT.readyOffset);
    case "mirror":
      return statusOf("ready", SKETCH_EDITOR_STATUS_TEXT.readyMirror);
    case "extend":
      return statusOf("ready", SKETCH_EDITOR_STATUS_TEXT.readyExtend);
    case "rectArray":
      return statusOf("ready", SKETCH_EDITOR_STATUS_TEXT.readyRectArray);
    case "circArray":
      return statusOf("ready", SKETCH_EDITOR_STATUS_TEXT.readyCircArray);
    case "convert":
      return statusOf("ready", SKETCH_EDITOR_STATUS_TEXT.readyConvert);
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
): SketchEditorCoreTransition {
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
    case "point": {
      // The single-pick entity: one click places the point (Phase 42 —
      // the hole dialog's positions sketches are drawn with it; also the
      // constraint tools' point pick operand). The placed point is a
      // REFERENCE, committed pinned (`fixed` — the entities module's
      // documented convention: "fixing one entity (conventionally a
      // construction point at the workplane origin) is how sketches
      // become fully constrained"). An unpinned reference leaves the
      // sketch's rigid translation a free direction, and a re-solve
      // (a parameter edit moving a bound dimension) resolves that
      // direction onto whichever operand elimination pivots on first —
      // the anchored corner slides instead of the far corner growing.
      // Pinned, a dimension pair against the point pins its other
      // operand exactly, and span dimensions grow the far side: the
      // author's anchor is the solve's anchor.
      const id = createSketchEntityId(mint("skent", "point"));
      return {
        state: {
          ...state,
          selectedEntityIds: [id],
          status: statusOf("hint", `Created point ${id}.`),
        },
        transaction: {
          commands: [
            {
              entity: createPointEntity(id, event.point, { fixed: true }),
              type: "sketch.entity.create",
            },
          ],
        },
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
    case "spline": {
      // Four picks commit one cubic Bézier (the control flavor's minimal
      // count): the picks are the controls b0..b3. The entity layer's own
      // validation (coincident segment endpoints) refuses degenerates
      // through the transaction's structured error.
      const points =
        state.gesture.kind === "spline" ? state.gesture.points : [];
      const picked = [...points, event.point];
      if (picked.length < 4) {
        return {
          state: {
            ...state,
            gesture: { kind: "spline", points: picked },
            status: statusOf(
              "hint",
              SKETCH_EDITOR_STATUS_TEXT.splineNext(4 - picked.length),
            ),
          },
          transaction: null,
        };
      }
      const [b0, b3] = [picked[0], picked[3]];
      if (
        b0 === undefined ||
        b3 === undefined ||
        (b0.x === b3.x && b0.y === b3.y)
      ) {
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
      const spline = createSketchEntityId(mint("skent", "spline"));
      return {
        state: {
          ...state,
          gesture: { kind: "none" },
          selectedEntityIds: [spline],
          status: statusOf("hint", `Created spline ${spline}.`),
        },
        transaction: {
          commands: [
            {
              entity: createSplineEntity(
                spline,
                "control",
                picked.map((point) => ({ x: point.x, y: point.y })),
              ),
              type: "sketch.entity.create",
            },
          ],
        },
      };
    }
    case "polygon": {
      // Pick 1: center. Pick 2: the first vertex — radius from the
      // distance, rotation from the direction. Fixed discrete parameters
      // (6 sides, inscribed) keep the gesture deterministic.
      if (state.gesture.kind === "polygon") {
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
        const rotation = Math.atan2(
          event.point.y - state.gesture.center.y,
          event.point.x - state.gesture.center.x,
        );
        const polygon = createSketchEntityId(mint("skent", "polygon"));
        return {
          state: {
            ...state,
            gesture: { kind: "none" },
            selectedEntityIds: [polygon],
            status: statusOf("hint", `Created polygon ${polygon}.`),
          },
          transaction: {
            commands: [
              {
                entity: createPolygonEntity(
                  polygon,
                  state.gesture.center,
                  radius,
                  POLYGON_TOOL_SIDES,
                  rotation,
                  "inscribed",
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
          gesture: { kind: "polygon", center: event.point },
          status: statusOf("hint", SKETCH_EDITOR_STATUS_TEXT.polygonVertex),
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
    case "offset": {
      // Pick 1: the source entity (kept in the gesture). Pick 2: the offset
      // target point — its measured distance and side from the source set
      // the offset. The domain op handles chains (connected targeted lines).
      if (
        state.gesture.kind === "offset" &&
        state.gesture.entityId !== undefined
      ) {
        const result = offsetEntitiesCommands(sketch, {
          entityIds: [state.gesture.entityId],
          towards: event.point,
        });
        if (!result.ok) {
          return {
            state: {
              ...state,
              gesture: { kind: "none" },
              status: statusOf(
                "error",
                result.error.message,
                result.error.code,
              ),
            },
            transaction: null,
          };
        }
        return {
          state: {
            ...state,
            gesture: { kind: "none" },
            selectedEntityIds: result.value
              .map((command) =>
                command.type === "sketch.entity.create"
                  ? command.entity.id
                  : null,
              )
              .filter((id): id is SketchEntityId => id !== null),
            status: statusOf(
              "hint",
              `Offset created ${String(result.value.length)} ${result.value.length === 1 ? "entity" : "entities"}.`,
            ),
          },
          transaction: { commands: result.value },
        };
      }
      const entity = entityById(event.entityId);
      if (entity === undefined) {
        return { state, transaction: null };
      }
      return {
        state: {
          ...state,
          gesture: {
            entityId: entity.id,
            kind: "offset",
            point: event.point,
          },
          selectedEntityIds: [entity.id],
          status: statusOf("hint", SKETCH_EDITOR_STATUS_TEXT.offsetSecond),
        },
        transaction: null,
      };
    }
    case "mirror": {
      // Pick 1: the axis (a line, kept in the gesture). Picks 2+: each
      // entity mirrors immediately; the tool stays armed for more.
      if (state.gesture.kind === "mirror") {
        const entity = entityById(event.entityId);
        if (entity === undefined || entity.id === state.gesture.axisId) {
          return { state, transaction: null };
        }
        const result = mirrorEntitiesCommands(sketch, {
          entityIds: [entity.id],
          mirrorLineId: state.gesture.axisId,
        });
        if (!result.ok) {
          return {
            state: {
              ...state,
              status: statusOf(
                "error",
                result.error.message,
                result.error.code,
              ),
            },
            transaction: null,
          };
        }
        return {
          state: {
            ...state,
            selectedEntityIds: result.value
              .map((command) =>
                command.type === "sketch.entity.create"
                  ? command.entity.id
                  : null,
              )
              .filter((id): id is SketchEntityId => id !== null),
            status: statusOf("hint", SKETCH_EDITOR_STATUS_TEXT.mirrorPick),
          },
          transaction: { commands: result.value },
        };
      }
      const entity = entityById(event.entityId);
      if (entity === undefined) return { state, transaction: null };
      if (entity.kind !== "line") {
        return {
          state: {
            ...state,
            status: statusOf(
              "error",
              "Mirror needs a line as its axis: that entity cannot be an axis.",
              SKETCH_ENTITY_OP_ERROR_CODES.mirrorLineNeeded,
            ),
          },
          transaction: null,
        };
      }
      return {
        state: {
          ...state,
          gesture: { axisId: entity.id, kind: "mirror" },
          status: statusOf("hint", SKETCH_EDITOR_STATUS_TEXT.mirrorPick),
        },
        transaction: null,
      };
    }
    case "extend": {
      const entity = entityById(event.entityId);
      if (entity === undefined) return { state, transaction: null };
      const result = extendLineCommand(sketch, entity.id, event.point);
      if (!result.ok) {
        return {
          state: {
            ...state,
            status: statusOf("error", result.error.message, result.error.code),
          },
          transaction: null,
        };
      }
      return {
        state,
        transaction: { commands: result.value },
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
          tool === "pointOnEntity" ||
          tool === "pointOnTangent";
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

/** The canvas view model: entities, regions, dimensions, annotations. */
export interface SketchViewModel {
  readonly entities: readonly CadSketchCanvasEntity[];
  readonly regions: readonly CadSketchCanvasRegion[];
  readonly annotations: readonly CadSketchCanvasAnnotation[];
  /** The drawn-dimension overlay geometry (Phase 37), constraint order. */
  readonly dimensions: readonly CadSketchCanvasDimension[];
  /**
   * Per-entity degrees of freedom (Phase 37's ink convention), empty when
   * no constrainedness analysis is available.
   */
  readonly entityDof: ReadonlyMap<string, number>;
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
  /**
   * The per-entity constrainedness readout (Phase 37), computed by the host
   * from the same solved state it displays; `null` keeps the legacy styling.
   */
  constrainedness: SketchConstrainedness | null = null,
): SketchViewModel {
  const selectedIds = new Set(selection.entityIds);
  // The sketch the dimensions present: the SOLVED geometry when available
  // (dimensions follow the solver, exactly like the entities do), the
  // authored sketch otherwise.
  const displayed = solved ?? sketch;
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
  // Phase 37: the drawn dimensions come from the domain's presentation
  // geometry; their TEXT anchors ride each presentation's textAnchor, so
  // the label sits where the dimension's own layout put it. Duplicate
  // anchors (two dimensions resolving to one anchor) stack 2 mm per prior
  // occupant so every label stays readable.
  const anchorOccupancy = new Map<string, number>();
  const presentations = sketchDimensionPresentations(displayed);
  for (const presentation of presentations) {
    const level = diagnosticLevelFor(presentation.id, diagnostics);
    const anchorKey = `${presentation.textAnchor.x}:${presentation.textAnchor.y}`;
    const occupants = anchorOccupancy.get(anchorKey) ?? 0;
    anchorOccupancy.set(anchorKey, occupants + 1);
    annotations.push({
      id: presentation.id,
      kind: "dimension",
      level: level === "none" ? "info" : level,
      text: presentation.text,
      x: presentation.textAnchor.x,
      y: presentation.textAnchor.y + occupants * 2,
    });
  }
  for (const constraint of sketch.constraints) {
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
  return {
    annotations,
    dimensions: presentations.map(toCanvasDimension),
    entities,
    entityDof: constrainedness?.entityDof ?? new Map<string, number>(),
    regions,
  };
}

/** Maps a domain presentation onto the canvas's dimension view model. */
function toCanvasDimension(
  presentation: DimensionPresentation,
): CadSketchCanvasDimension {
  switch (presentation.kind) {
    case "linear":
      return {
        dimensionLine: presentation.dimensionLine,
        extensionLines: presentation.extensionLines.filter(
          (line): line is { from: EditorPoint; to: EditorPoint } =>
            line !== undefined,
        ),
        id: presentation.id,
        kind: "linear",
        text: presentation.text,
        textAnchor: presentation.textAnchor,
      };
    case "radial":
      return {
        id: presentation.id,
        kind: "radial",
        leader: presentation.leader,
        text: presentation.text,
        textAnchor: presentation.textAnchor,
      };
    case "diametral":
      return {
        id: presentation.id,
        kind: "diametral",
        line: presentation.line,
        text: presentation.text,
        textAnchor: presentation.textAnchor,
      };
    case "angular":
      return {
        arc: presentation.arc,
        id: presentation.id,
        kind: "angular",
        text: presentation.text,
        textAnchor: presentation.textAnchor,
      };
    case "label":
      return {
        id: presentation.id,
        kind: "label",
        text: presentation.text,
        textAnchor: presentation.textAnchor,
      };
  }
}

/** Badge anchor for problem diagnostics without a geometry anchor. */
const SKETCH_CANVAS_BADGE_XY: EditorPoint = { x: 6, y: 60 };

/** The workplane position of a point target — the domain's shared readout. */
export { pointTargetPosition } from "@slopcad/cad-sketch";

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

/**
 * Creates the workbench's boot sketch: an empty sketch on the given
 * workplane (the XY plane when none is given — the Phase 39 sketch-on-face
 * flow boots sessions on a face-derived datum plane instead).
 */
export function createWorkbenchSketch(workplane?: Workplane): Sketch {
  const created = createSketch(workplane ?? xyWorkplane(), [], []);
  if (!created.ok) {
    throw new Error(`Workbench sketch rejected: ${created.error.message}`);
  }
  return created.value;
}
