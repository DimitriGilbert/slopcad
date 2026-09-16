/**
 * Normalized tool input events (Phase 13): the plain, serializable data
 * every CAD tool consumes. Adapters produce them — the R3F fixture from
 * DOM/three.js pointer and keyboard activity, headless tests directly — and
 * tools never see a DOM event, a Three.js event, or any other host type.
 * An event is pure data: world point, pick resolution, keyboard key, and
 * modifier flags, all JSON-shaped, so an input stream can be recorded,
 * replayed, and asserted byte-for-byte in headless tests.
 *
 * ## Pointer payload
 *
 * A pointer event carries the pointer's world-space position (`point`,
 * canonical millimetres — the projection contract's world frame) and, when
 * the pointer was over geometry, the Phase 12 pick resolution (`pick`: the
 * domain `SelectionReference` plus the hit's render-object provenance).
 * `point` is `null` exactly when no world point was resolvable (the
 * pointer left the model and no ground-plane policy exists), and a pick
 * always carries its point — the structural rule `pick ⇒ point` is
 * enforced by {@link parseToolInputEvent}.
 *
 * ## Serialization
 *
 * Events are plain JSON data by construction; there is no bespoke
 * serializer. {@link parseToolInputEvent} is the untrusted-input boundary
 * (recorded streams, IPC): it validates type, point, pick, and modifiers
 * strictly with stable `tool-event/*` codes and ignores unknown fields so
 * future event versions deserialize without corruption.
 */

import { type FeatureId, parseFeatureId } from "./ids";
import {
  parseSelectionReference,
  type SelectionError,
  type SelectionReference,
} from "./selection";
import { type ParseFailure, type ParseResult, fail, ok } from "./result";
import { type RenderVector3 } from "./projection";

/** The normalized event types. */
export const TOOL_EVENT_TYPES = [
  "pointer-down",
  "pointer-move",
  "pointer-up",
  "key-down",
  "key-up",
] as const;

export type ToolEventType = (typeof TOOL_EVENT_TYPES)[number];

const TOOL_EVENT_TYPE_SET: ReadonlySet<string> = new Set(TOOL_EVENT_TYPES);

/** The pointer event types. */
export const TOOL_POINTER_EVENT_TYPES = [
  "pointer-down",
  "pointer-move",
  "pointer-up",
] as const;

export type ToolPointerEventType = (typeof TOOL_POINTER_EVENT_TYPES)[number];

/** Modifier flags carried by every event, as plain data. */
export interface ToolModifiers {
  readonly shift: boolean;
  readonly alt: boolean;
  readonly ctrl: boolean;
  readonly meta: boolean;
}

/** Builds a frozen modifiers record from adapter-side flags. */
export function toolModifiers(
  shift: boolean,
  alt: boolean,
  ctrl: boolean,
  meta: boolean,
): ToolModifiers {
  return Object.freeze({ shift, alt, ctrl, meta });
}

/** The modifiers with every flag released (the shared inert value). */
export const NO_TOOL_MODIFIERS: ToolModifiers = toolModifiers(
  false,
  false,
  false,
  false,
);

/**
 * The pick resolution of a pointer event: the Phase 12 domain reference the
 * hit resolves to plus the hit's render-object provenance. The hit's world
 * point is the event's own `point` — it is not duplicated here.
 */
export interface ToolPick {
  readonly reference: SelectionReference;
  readonly renderObjectId: string;
  readonly featureId?: FeatureId;
}

/** A normalized pointer event: world point (when resolvable), pick, modifiers. */
export interface ToolPointerEvent {
  readonly type: ToolPointerEventType;
  /** The pointer's world position in canonical millimetres, or `null`. */
  readonly point: RenderVector3 | null;
  /** The pick under the pointer, or `null` when not over geometry. */
  readonly pick: ToolPick | null;
  readonly modifiers: ToolModifiers;
}

/** A normalized keyboard event: the key plus modifier flags, as data. */
export interface ToolKeyboardEvent {
  readonly type: "key-down" | "key-up";
  readonly key: string;
  readonly modifiers: ToolModifiers;
}

/** Any normalized input event a tool can consume. */
export type ToolInputEvent = ToolPointerEvent | ToolKeyboardEvent;

/** Stable failure codes produced when input is rejected as a tool event. */
export const TOOL_EVENT_ERROR_CODES = {
  malformed: "tool-event/malformed",
  typeUnknown: "tool-event/type-unknown",
  pickWithoutPoint: "tool-event/pick-without-point",
  referenceInvalid: "tool-event/reference-invalid",
} as const;

export type ToolEventErrorCode =
  (typeof TOOL_EVENT_ERROR_CODES)[keyof typeof TOOL_EVENT_ERROR_CODES];

/** Structured failure describing why input was rejected as a tool event. */
export interface ToolEventError extends ParseFailure {
  readonly code: ToolEventErrorCode;
}

function toolEventError(
  code: ToolEventErrorCode,
  message: string,
  input: unknown,
): ToolEventError {
  return { code, message, input };
}

function isPlainRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function parsePoint(input: unknown): ParseResult<RenderVector3 | null, ToolEventError> {
  if (input === null) return ok(null);
  if (!Array.isArray(input) || input.length !== 3) {
    return fail(
      toolEventError(
        TOOL_EVENT_ERROR_CODES.malformed,
        "A tool event point must be null or an [x, y, z] array of finite numbers.",
        input,
      ),
    );
  }
  const x: unknown = input[0];
  const y: unknown = input[1];
  const z: unknown = input[2];
  if (!isFiniteNumber(x) || !isFiniteNumber(y) || !isFiniteNumber(z)) {
    return fail(
      toolEventError(
        TOOL_EVENT_ERROR_CODES.malformed,
        "A tool event point must be null or an [x, y, z] array of finite numbers.",
        input,
      ),
    );
  }
  return ok([x, y, z]);
}

function parseModifiers(input: unknown): ParseResult<ToolModifiers, ToolEventError> {
  if (
    !isPlainRecord(input) ||
    typeof input.shift !== "boolean" ||
    typeof input.alt !== "boolean" ||
    typeof input.ctrl !== "boolean" ||
    typeof input.meta !== "boolean"
  ) {
    return fail(
      toolEventError(
        TOOL_EVENT_ERROR_CODES.malformed,
        "A tool event modifiers record must carry boolean shift, alt, ctrl, and meta fields.",
        input,
      ),
    );
  }
  return ok(toolModifiers(input.shift, input.alt, input.ctrl, input.meta));
}

function parsePick(
  input: unknown,
): ParseResult<ToolPick | null, ToolEventError> {
  if (input === null) return ok(null);
  if (!isPlainRecord(input)) {
    return fail(
      toolEventError(
        TOOL_EVENT_ERROR_CODES.malformed,
        "A tool event pick must be null or a plain object with reference and renderObjectId fields.",
        input,
      ),
    );
  }
  const reference = parseSelectionReference(input.reference);
  if (!reference.ok) {
    return fail(
      toolEventError(
        TOOL_EVENT_ERROR_CODES.referenceInvalid,
        `A tool event pick needs a valid selection reference: ${reference.error.message}`,
        input.reference,
      ),
    );
  }
  if (typeof input.renderObjectId !== "string" || input.renderObjectId.length === 0) {
    return fail(
      toolEventError(
        TOOL_EVENT_ERROR_CODES.malformed,
        "A tool event pick must carry a non-empty renderObjectId string.",
        input.renderObjectId,
      ),
    );
  }
  let featureId: FeatureId | undefined;
  if (input.featureId !== undefined) {
    const parsed = parseFeatureId(input.featureId);
    if (!parsed.ok) {
      return fail(
        toolEventError(
          TOOL_EVENT_ERROR_CODES.malformed,
          `A tool event pick featureId must be a valid feature id: ${parsed.error.message}`,
          input.featureId,
        ),
      );
    }
    featureId = parsed.value;
  }
  return ok(
    featureId === undefined
      ? {
          reference: reference.value,
          renderObjectId: input.renderObjectId,
        }
      : {
          reference: reference.value,
          renderObjectId: input.renderObjectId,
          featureId,
        },
  );
}

/**
 * Parses untrusted input (a recorded event stream, an IPC payload) as a
 * {@link ToolInputEvent}. The type must be known; pointer events validate
 * point, pick (including the `pick ⇒ point` rule and the reference through
 * the selection parser), and modifiers; keyboard events validate the key
 * and modifiers. Unknown fields are ignored so future event versions
 * deserialize without data corruption.
 */
export function parseToolInputEvent(
  input: unknown,
): ParseResult<ToolInputEvent, ToolEventError | SelectionError> {
  if (!isPlainRecord(input)) {
    return fail(
      toolEventError(
        TOOL_EVENT_ERROR_CODES.malformed,
        "A tool event must be a plain object with a type field.",
        input,
      ),
    );
  }
  const { type } = input;
  if (typeof type !== "string" || !TOOL_EVENT_TYPE_SET.has(type)) {
    return fail(
      toolEventError(
        TOOL_EVENT_ERROR_CODES.typeUnknown,
        `A tool event type must be one of: ${TOOL_EVENT_TYPES.join(", ")}.`,
        type,
      ),
    );
  }
  const modifiers = parseModifiers(input.modifiers);
  if (!modifiers.ok) return modifiers;
  if (type === "pointer-down" || type === "pointer-move" || type === "pointer-up") {
    const point = parsePoint(input.point);
    if (!point.ok) return point;
    const pick = parsePick(input.pick);
    if (!pick.ok) return pick;
    if (pick.value !== null && point.value === null) {
      return fail(
        toolEventError(
          TOOL_EVENT_ERROR_CODES.pickWithoutPoint,
          "A tool event that resolves a pick must also carry the hit's world point.",
          input,
        ),
      );
    }
    return ok({
      type,
      point: point.value,
      pick: pick.value,
      modifiers: modifiers.value,
    });
  }
  if (type === "key-down" || type === "key-up") {
    if (typeof input.key !== "string" || input.key.length === 0) {
      return fail(
        toolEventError(
          TOOL_EVENT_ERROR_CODES.malformed,
          "A keyboard tool event must carry a non-empty key string.",
          input.key,
        ),
      );
    }
    return ok({ type, key: input.key, modifiers: modifiers.value });
  }
  return fail(
    toolEventError(
      TOOL_EVENT_ERROR_CODES.typeUnknown,
      `A tool event type must be one of: ${TOOL_EVENT_TYPES.join(", ")}.`,
      type,
    ),
  );
}
