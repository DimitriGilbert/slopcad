/**
 * The ROTATE tool (Phase 13): pick + drag arc → one atomic `parameter.set`
 * transaction carrying a signed rotation angle, scoped honestly against the
 * kernel's actual capabilities.
 *
 * ## Gesture semantics
 *
 * `pointer-down` over geometry anchors the gesture: the picked reference's
 * body becomes the target and the rotation center is the center of that
 * body's rendered bounds (from the context's projection — the projection
 * access the tool contract provides for measurements), with the rotation
 * axis fixed at world +Z (the scene's z-up convention). `pointer-move`
 * previews the swept angle as plain tool state. `pointer-up` computes the
 * signed angle (radians, positive counter-clockwise seen from +Z) between
 * the anchor's radial direction and the release point's radial direction
 * around the center, and issues ONE transaction: a single `parameter.set`
 * of the rotate feature's angle parameter, as a canonical-radian
 * `AngleValue`. Degenerate gestures (missing world point, zero radial
 * direction) and unresolvable targets consume the gesture with a structured
 * failure and never issue.
 *
 * ## Command mapping (the Phase 13 decision, disclosed)
 *
 * Like translate, NO vocabulary extension: a rotation is modeled as a
 * feature of kind `"rotate"` whose inputs declare the rotated body plus
 * exactly ONE angle parameter (the signed rotation about +Z, canonical
 * radians). The tool resolves the LAST such feature in document order for
 * the picked body and sets its angle parameter in one atomic transaction —
 * one undoable, replayable history entry.
 *
 * ## What executes today (honest scope)
 *
 * The DOCUMENT mutation fully executes: the parameter is set, the session
 * and its history advance, the transaction serializes and replays. The
 * GEOMETRIC rotation does not: every kernel declares
 * `transformRotation: false` (the Phase 8 contract carries translation
 * only), and no document→kernel execution pipeline exists in Phase 13 — the
 * fixture therefore deliberately applies no rotation, and nothing in this
 * module claims one. What would execute: a future executor reading the
 * rotate feature and applying a kernel `transform` once kernels declare the
 * capability and the executor seam (regeneration) gains a document-driven
 * runner. Until then the tool emits the command shape and the kernel
 * capability gates the geometry — exactly the Phase 13 scoping rule.
 */

import type { ToolContext } from "./tool-context";
import type { ToolInputEvent } from "./tool-events";

import { angle, type AngleValue } from "./dimensional";
import {
  type CadDocument,
  getDocumentParameter,
} from "./document";
import {
  type BodyId,
  type FeatureId,
  type ParameterId,
} from "./ids";
import {
  type RenderProjection,
  type RenderVector3,
} from "./projection";
import { selectionReferenceBodyId } from "./selection";
import {
  TOOL_FAILURE_CODES,
  type CadTool,
  type ToolTransition,
  toolFailure,
} from "./tool-manager";

/** The feature kind the rotate tool updates. */
export const ROTATE_FEATURE_KIND = "rotate";

/**
 * A resolved rotate target: the feature record and its rotation-angle
 * parameter id (a live angle parameter — the signed rotation about +Z).
 */
export interface RotateTarget {
  readonly featureId: FeatureId;
  readonly parameterId: ParameterId;
}

/**
 * Resolves the rotate feature a drag on `bodyId` updates: the LAST feature
 * of kind `"rotate"` in document order whose inputs declare the body and
 * exactly one parameter reference resolving to a live ANGLE parameter.
 * `undefined` when no feature qualifies — callers treat that as
 * `tool/target-unresolved`.
 */
export function resolveRotateTarget(
  document: CadDocument,
  bodyId: BodyId,
): RotateTarget | undefined {
  for (let index = document.features.length - 1; index >= 0; index -= 1) {
    const feature = document.features[index];
    if (feature === undefined || feature.kind !== ROTATE_FEATURE_KIND) continue;
    if (!feature.inputs.some((ref) => ref.kind === "body" && ref.id === bodyId)) {
      continue;
    }
    let parameterId: ParameterId | undefined;
    let parameterCount = 0;
    for (const ref of feature.inputs) {
      if (ref.kind === "parameter") {
        parameterCount += 1;
        parameterId = ref.id;
      }
    }
    if (parameterCount !== 1 || parameterId === undefined) continue;
    const parameter = getDocumentParameter(document, parameterId);
    if (parameter === undefined || parameter.value.dimension !== "angle") continue;
    return { featureId: feature.id, parameterId };
  }
  return undefined;
}

/**
 * The center of a body's rendered bounds from a projection: the midpoint of
 * the render object's axis-aligned bounding box. `undefined` when the
 * projection is absent or carries no object for the body.
 */
export function bodyBoundsCenter(
  projection: RenderProjection | null,
  bodyId: BodyId,
): RenderVector3 | undefined {
  if (projection === null) return undefined;
  const object = projection.objects.find((candidate) => candidate.bodyId === bodyId);
  if (object === undefined) return undefined;
  return [
    (object.bounds.min[0] + object.bounds.max[0]) / 2,
    (object.bounds.min[1] + object.bounds.max[1]) / 2,
    (object.bounds.min[2] + object.bounds.max[2]) / 2,
  ];
}

/**
 * The signed angle (radians, positive counter-clockwise seen from +Z)
 * swept from radial direction `from`-around-`center` to `to`-around-`center`
 * in the XY plane, or `null` when either radial direction is the zero
 * vector (degenerate).
 */
export function sweptAngleAboutZ(
  center: RenderVector3,
  from: RenderVector3,
  to: RenderVector3,
): number | null {
  const ax = from[0] - center[0];
  const ay = from[1] - center[1];
  const bx = to[0] - center[0];
  const by = to[1] - center[1];
  if ((ax === 0 && ay === 0) || (bx === 0 && by === 0)) return null;
  return Math.atan2(ax * by - ay * bx, ax * bx + ay * by);
}

/** The rotate tool's gesture state. */
export type RotateToolState =
  | { readonly stage: "awaiting-anchor" }
  | {
      readonly stage: "dragging";
      readonly bodyId: BodyId;
      /** The rotation center (the body's rendered bounds center, mm). */
      readonly center: RenderVector3;
      /** The anchor point (the picked world point, canonical mm). */
      readonly from: RenderVector3;
      /** The in-flight swept angle in radians (preview data only). */
      readonly lastAngle: number;
    }
  | { readonly stage: "issued" };

const AWAITING_ANCHOR: RotateToolState = Object.freeze({
  stage: "awaiting-anchor",
});

/** The tool id of {@link rotateTool}. */
export const ROTATE_TOOL_ID = "rotate";

/**
 * The ROTATE tool: pick + drag arc → one atomic `parameter.set` of the
 * rotate feature's angle parameter (canonical radians). The document
 * mutation executes; the geometric rotation is gated by the kernels'
 * `transformRotation: false` capability and the absent document executor
 * (see the module doc for the exact scope).
 */
export const rotateTool: CadTool<RotateToolState> = {
  id: ROTATE_TOOL_ID,
  initialState: AWAITING_ANCHOR,
  onEvent(
    state: RotateToolState,
    event: ToolInputEvent,
    context: ToolContext,
  ): ToolTransition<RotateToolState> {
    if (event.type === "pointer-down") {
      if (event.pick === null || event.point === null) {
        return { state, phase: "active" };
      }
      const bodyId = selectionReferenceBodyId(event.pick.reference);
      if (bodyId === undefined) {
        return {
          state,
          phase: "active",
          failure: toolFailure(
            TOOL_FAILURE_CODES.targetUnresolved,
            `The pick reference kind "${event.pick.reference.kind}" addresses no body; rotate needs a body to drag.`,
          ),
        };
      }
      const center = bodyBoundsCenter(context.projection, bodyId);
      if (center === undefined) {
        return {
          state,
          phase: "active",
          failure: toolFailure(
            TOOL_FAILURE_CODES.targetUnresolved,
            `No rendered bounds for body "${bodyId}" in the current projection; the rotation center cannot be resolved.`,
          ),
        };
      }
      return {
        state: { stage: "dragging", bodyId, center, from: event.point, lastAngle: 0 },
        phase: "active",
      };
    }
    if (event.type === "pointer-move") {
      if (state.stage !== "dragging") return { state, phase: "active" };
      if (event.point === null) return { state, phase: "active" };
      const swept = sweptAngleAboutZ(state.center, state.from, event.point);
      if (swept === null) return { state, phase: "active" };
      return { state: { ...state, lastAngle: swept }, phase: "active" };
    }
    if (event.type === "pointer-up") {
      if (state.stage !== "dragging") return { state, phase: "active" };
      if (event.point === null) {
        return {
          state: AWAITING_ANCHOR,
          phase: "active",
          failure: toolFailure(
            TOOL_FAILURE_CODES.degenerateGesture,
            "The drag ended without a resolvable world point; no rotation was issued.",
          ),
        };
      }
      const swept = sweptAngleAboutZ(state.center, state.from, event.point);
      if (swept === null) {
        return {
          state: AWAITING_ANCHOR,
          phase: "active",
          failure: toolFailure(
            TOOL_FAILURE_CODES.degenerateGesture,
            "The drag swept no radial direction around the rotation center; no rotation was issued.",
          ),
        };
      }
      const target = resolveRotateTarget(context.session.document, state.bodyId);
      if (target === undefined) {
        return {
          state: AWAITING_ANCHOR,
          phase: "active",
          failure: toolFailure(
            TOOL_FAILURE_CODES.targetUnresolved,
            `No "rotate" feature with an angle-parameter component references body "${state.bodyId}"; the drag cannot be expressed as a command.`,
          ),
        };
      }
      const rotation: AngleValue = angle(swept);
      const transaction = {
        commands: [
          { type: "parameter.set", id: target.parameterId, value: rotation },
        ],
      } as const;
      const issued = context.issue(transaction);
      if (!issued.ok) {
        return {
          state: AWAITING_ANCHOR,
          phase: "active",
          failure: toolFailure(issued.error.code, issued.error.message),
        };
      }
      return {
        state: { stage: "issued" },
        phase: "completed",
        detail: {
          kind: "commands",
          transaction,
          summary: `rotate ${state.bodyId} by ${String(swept)} rad about +Z`,
        },
      };
    }
    // key-down, key-up: the rotate gesture is pointer-only.
    return { state, phase: "active" };
  },
};
