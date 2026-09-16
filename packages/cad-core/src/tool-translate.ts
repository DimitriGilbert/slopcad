/**
 * The TRANSLATE tool (Phase 13): pick + drag vector → one atomic
 * `parameter.set` transaction. The gesture: `pointer-down` over geometry
 * anchors the drag (the picked reference's body becomes the target);
 * `pointer-move` updates the in-flight vector as plain tool state (preview
 * data only — nothing is issued, nothing in the domain changes);
 * `pointer-up` commits.
 *
 * ## Command mapping (the Phase 13 decision, disclosed)
 *
 * The tool needs NO command-vocabulary extension. A translation is modeled
 * in the document as a feature of kind `"translate"` whose inputs declare
 * the translated body plus THREE length parameters — the x, y, z components
 * of the translation — in that order (x, y, z in canonical millimetres, the
 * projection contract's world frame). At drag release the tool resolves that
 * feature for the picked body (the LAST `"translate"` feature in document
 * order declaring the body; its parameter inputs must resolve to length
 * parameters) and issues ONE transaction of three `parameter.set` commands,
 * one per component, as canonical-millimetre values. One transaction means
 * the three components commit atomically — a drag never moves an axis
 * alone — and lands as a single undoable, replayable history entry through
 * the session. This is exactly "update a translate-feature's parameter" with
 * the Phase 7 vocabulary; executing the translation (rebuilding the body's
 * solid) is the kernel phases' executor concern, not the tool's.
 *
 * ## Non-emission cases (each a structured failure, never a silent guess)
 *
 * - `pointer-down` without a pick, or a pick that resolves to no body
 *   (e.g. a feature reference) → no anchor, `tool/target-unresolved`.
 * - A drag ending without a world point, or a zero-length drag → nothing
 *   issued, `tool/degenerate-gesture`.
 * - No resolvable `"translate"` feature for the body → nothing issued,
 *   `tool/target-unresolved`.
 * - A rejected transaction (structured substrate failure) → the document
 *   and history are untouched (atomic), `transaction/*` code passes
 *   through.
 *
 * In every non-emission case the gesture is consumed and the tool returns
 * to `awaiting-anchor`, staying active.
 */

import type { ToolContext } from "./tool-context";
import type { ToolInputEvent } from "./tool-events";

import {
  type CadDocument,
  getDocumentParameter,
} from "./document";
import { length } from "./dimensional";
import {
  type BodyId,
  type FeatureId,
  type ParameterId,
} from "./ids";
import { type RenderVector3 } from "./projection";
import { selectionReferenceBodyId } from "./selection";
import {
  TOOL_FAILURE_CODES,
  type CadTool,
  type ToolTransition,
  toolFailure,
} from "./tool-manager";

/** The feature kind the translate tool updates. */
export const TRANSLATE_FEATURE_KIND = "translate";

/**
 * A resolved translate target: the feature record and its three
 * translation-component parameter ids, in x, y, z declaration order.
 */
export interface TranslateTarget {
  readonly featureId: FeatureId;
  readonly parameters: readonly [ParameterId, ParameterId, ParameterId];
}

/**
 * Resolves the translate feature a drag on `bodyId` updates: the LAST
 * feature of kind `"translate"` in document order whose inputs declare the
 * body, whose inputs then carry exactly three parameter references, each
 * resolving to a live LENGTH parameter. `undefined` when no feature
 * qualifies — callers treat that as `tool/target-unresolved`.
 */
export function resolveTranslateTarget(
  document: CadDocument,
  bodyId: BodyId,
): TranslateTarget | undefined {
  for (let index = document.features.length - 1; index >= 0; index -= 1) {
    const feature = document.features[index];
    if (feature === undefined || feature.kind !== TRANSLATE_FEATURE_KIND) continue;
    if (!feature.inputs.some((ref) => ref.kind === "body" && ref.id === bodyId)) {
      continue;
    }
    const parameterIds: ParameterId[] = [];
    for (const ref of feature.inputs) {
      if (ref.kind === "parameter") parameterIds.push(ref.id);
    }
    if (parameterIds.length !== 3) continue;
    let x: ParameterId | undefined;
    let y: ParameterId | undefined;
    let z: ParameterId | undefined;
    let valid = true;
    for (const id of parameterIds) {
      const parameter = getDocumentParameter(document, id);
      if (parameter === undefined || parameter.value.dimension !== "length") {
        valid = false;
        break;
      }
      if (x === undefined) x = id;
      else if (y === undefined) y = id;
      else if (z === undefined) z = id;
    }
    if (!valid || x === undefined || y === undefined || z === undefined) continue;
    return { featureId: feature.id, parameters: [x, y, z] };
  }
  return undefined;
}

/** The translate tool's gesture state. */
export type TranslateToolState =
  | { readonly stage: "awaiting-anchor" }
  | {
      readonly stage: "dragging";
      readonly bodyId: BodyId;
      /** The drag anchor (the picked world point, canonical mm). */
      readonly origin: RenderVector3;
      /** The in-flight vector (preview data only, never issued). */
      readonly lastVector: RenderVector3;
    }
  | { readonly stage: "issued" };

const AWAITING_ANCHOR: TranslateToolState = Object.freeze({
  stage: "awaiting-anchor",
});

/** The tool id of {@link translateTool}. */
export const TRANSLATE_TOOL_ID = "translate";

function subtractPoints(from: RenderVector3, to: RenderVector3): RenderVector3 {
  return [to[0] - from[0], to[1] - from[1], to[2] - from[2]];
}

function isZeroVector(vector: RenderVector3): boolean {
  return vector[0] === 0 && vector[1] === 0 && vector[2] === 0;
}

/**
 * The TRANSLATE tool: pick + drag → one atomic three-command
 * `parameter.set` transaction on the body's translate feature (see the
 * module doc for the full mapping and the non-emission cases).
 */
export const translateTool: CadTool<TranslateToolState> = {
  id: TRANSLATE_TOOL_ID,
  initialState: AWAITING_ANCHOR,
  onEvent(
    state: TranslateToolState,
    event: ToolInputEvent,
    context: ToolContext,
  ): ToolTransition<TranslateToolState> {
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
            `The pick reference kind "${event.pick.reference.kind}" addresses no body; translate needs a body to drag.`,
          ),
        };
      }
      return {
        state: {
          stage: "dragging",
          bodyId,
          origin: event.point,
          lastVector: [0, 0, 0],
        },
        phase: "active",
      };
    }
    if (event.type === "pointer-move") {
      if (state.stage !== "dragging") return { state, phase: "active" };
      if (event.point === null) return { state, phase: "active" };
      return {
        state: {
          ...state,
          lastVector: subtractPoints(state.origin, event.point),
        },
        phase: "active",
      };
    }
    if (event.type === "pointer-up") {
      if (state.stage !== "dragging") return { state, phase: "active" };
      if (event.point === null) {
        return {
          state: AWAITING_ANCHOR,
          phase: "active",
          failure: toolFailure(
            TOOL_FAILURE_CODES.degenerateGesture,
            "The drag ended without a resolvable world point; no translation was issued.",
          ),
        };
      }
      const vector = subtractPoints(state.origin, event.point);
      if (isZeroVector(vector)) {
        return {
          state: AWAITING_ANCHOR,
          phase: "active",
          failure: toolFailure(
            TOOL_FAILURE_CODES.degenerateGesture,
            "The drag was zero-length; no translation was issued.",
          ),
        };
      }
      const target = resolveTranslateTarget(context.session.document, state.bodyId);
      if (target === undefined) {
        return {
          state: AWAITING_ANCHOR,
          phase: "active",
          failure: toolFailure(
            TOOL_FAILURE_CODES.targetUnresolved,
            `No "translate" feature with three length-parameter components references body "${state.bodyId}"; the drag cannot be expressed as a command.`,
          ),
        };
      }
      const transaction = {
        commands: [
          { type: "parameter.set", id: target.parameters[0], value: length(vector[0]) },
          { type: "parameter.set", id: target.parameters[1], value: length(vector[1]) },
          { type: "parameter.set", id: target.parameters[2], value: length(vector[2]) },
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
          summary: `translate ${state.bodyId} by (${String(vector[0])}, ${String(vector[1])}, ${String(vector[2])}) mm`,
        },
      };
    }
    // key-down, key-up: the translate gesture is pointer-only.
    return { state, phase: "active" };
  },
};
