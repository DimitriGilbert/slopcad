/**
 * The versioned sim worker message envelope (Phase 61b): the serializable
 * request, response, cancellation, and NOTIFICATION messages that cross a
 * sim worker channel, and the strict parser that guards the boundary.
 *
 * The envelope is the kernel protocol's (`@slopcad/cad-kernel`'s
 * `worker-protocol`), restated under sim-core's zero-runtime-dependency
 * stance with the version and correlation discipline pinned to the same
 * rules — {@link SIM_WORKER_PROTOCOL_VERSION} equals the kernel's
 * `WORKER_PROTOCOL_VERSION` (a cross-compatibility test pins the pair), the
 * `req_` request-id wire format is identical, and the version gate runs
 * before any other field is read. The one deliberate extension is the NEW
 * message class the simulation spine adds: the worker→host **notification**,
 * carrying the progress events and field-chunk updates a running sim
 * streams (law S6 — each applied update is a committed application).
 *
 * ## The notification class
 *
 * A notification is NOT a response: it never settles a request, only
 * streams data about one in flight. It correlates through the same
 * `requestId` as responses (the run request it streams for), so the
 * client-side correlation discipline extends to it unchanged — a
 * notification for a request id the client does not hold pending is late,
 * foreign, or misdirected and is dropped deterministically. Two payloads
 * exist, on the wire in the message's `notification` field:
 *
 * - `progress` — `{ kind, step, totalSteps? }`, the engine's step counter;
 * - `field-chunk` — a slice of one document-space field block: the block
 *   header (id, unit?, extent, origin/spacing in mm, float width), the
 *   chunk's index and its field's chunk count, an explicit `valueCount`,
 *   and the chunk's values as strict base64 of the raw little-endian float
 *   bytes of the 61a result payload layout (`./sim-field-chunks`). Chunk
 *   framing is lossless and deterministic: a field's chunk stream
 *   reassembles into exactly the block the finalized result carries.
 *
 * Like request payloads and results, notifications travel on the wire in
 * their serialized form (values as base64 text); the typed form a host
 * consumes — {@link SimEngineProgress} / {@link SimEngineFieldChunk}, the
 * engine contract's own shapes — is recovered at the trust boundary through
 * {@link decodeSimWorkerNotification}.
 *
 * Server-side, notifications are best-effort emissions during a run: the
 * pinned cancellation rule applies to the terminal response only (a
 * cancelled run's outcome is suppressed), while notifications legitimately
 * emitted before the cancellation took effect stand as sent — they are
 * preview data, and the finalize result remains the single authority.
 *
 * ## Version gating
 *
 * `parseSimWorkerMessage` checks `protocolVersion` *before any other field
 * is read*; a message from another protocol version is rejected whole with
 * a structured `worker/unsupported-version` failure — never misparsed. A
 * missing or non-integer version is a `worker/malformed-message`. A
 * responder that fails the version gate answers with an error response
 * whose `requestId` is `null` (correlation impossible).
 *
 * ## Determinism and tolerance
 *
 * Builders emit fields in a fixed key order, so identical messages produce
 * identical bytes. Parsing is strict on known fields and ignores unknown
 * fields. Every message survives `value → JSON → value` unchanged.
 */

import type {
  SimEngineFieldChunk,
  SimEngineOptimizationGeneration,
  SimEngineProgress,
} from "./engine";
import type { SimWorkerOperationId } from "./sim-worker-operations";
import type {
  SimWorkerOperationInput,
  SimWorkerOperationResult,
} from "./sim-worker-operations";
import type { SimWorkerError, SimWorkerParseError } from "./sim-worker-errors";
import type { SimWorkerRequestId } from "./sim-worker-ids";

import { decodeSimBase64Strict, encodeSimBase64 } from "./sim-base64";
import {
  decodeSimFieldChunkValues,
  encodeSimFieldChunkValues,
} from "./sim-field-chunks";
import {
  isSimWorkerOperationId,
  parseSimWorkerOperationInput,
  parseSimWorkerOperationResult,
  serializeSimWorkerOperationInput,
  serializeSimWorkerOperationResult,
  SIM_WORKER_OPERATION_IDS,
} from "./sim-worker-operations";
import {
  parseSimWorkerError,
  SIM_WORKER_PROTOCOL_ERROR_CODES,
  simWorkerParseError,
} from "./sim-worker-errors";
import { parseSimWorkerRequestId } from "./sim-worker-ids";

/**
 * The sim worker protocol version this package speaks — pinned equal to the
 * kernel protocol's `WORKER_PROTOCOL_VERSION` so the two envelopes agree on
 * every shared field's meaning; a bump is a breaking wire change for both,
 * decided together (a cross-compatibility test fails on drift).
 */
export const SIM_WORKER_PROTOCOL_VERSION = 1;

/** The message kinds of the sim worker protocol (notification is new). */
export const SIM_WORKER_MESSAGE_KINDS = [
  "request",
  "response",
  "cancel",
  "notification",
] as const;

/** Discriminator of a sim worker message. */
export type SimWorkerMessageKind = (typeof SIM_WORKER_MESSAGE_KINDS)[number];

/**
 * A request: execute `operation` with `input`. `operation` stays a string on
 * the envelope so an unknown operation name is *representable* and fails
 * predictably in {@link decodeSimWorkerRequest} with
 * `worker/unknown-operation`; `input` is the operation's canonical
 * serialized payload.
 */
export interface SimWorkerRequestMessage {
  readonly protocolVersion: number;
  readonly kind: "request";
  readonly requestId: SimWorkerRequestId;
  readonly operation: string;
  readonly input: unknown;
}

/**
 * A successful response: `result` is the operation's canonical serialized
 * result. `requestId` is never `null` here — a success always correlates
 * with a request the caller issued.
 */
export interface SimWorkerSuccessResponseMessage {
  readonly protocolVersion: number;
  readonly kind: "response";
  readonly requestId: SimWorkerRequestId;
  readonly status: "ok";
  readonly result: unknown;
}

/**
 * A failed response: `error` is the structured wire failure. `requestId` is
 * `null` exactly when the request could not be parsed at all (e.g. a
 * version gate failure), because an unparseable request has no trustworthy
 * correlation id.
 */
export interface SimWorkerErrorResponseMessage {
  readonly protocolVersion: number;
  readonly kind: "response";
  readonly requestId: SimWorkerRequestId | null;
  readonly status: "error";
  readonly error: SimWorkerError;
}

/** A response: success carries the result, failure carries a structured error. */
export type SimWorkerResponseMessage =
  SimWorkerSuccessResponseMessage | SimWorkerErrorResponseMessage;

/**
 * A cancellation: void the request bearing `requestId`. Semantics are pinned
 * in `./sim-worker-cancellation` — in short, cancellation wins ties: once
 * recorded, no success for that request id can be emitted.
 */
export interface SimWorkerCancelMessage {
  readonly protocolVersion: number;
  readonly kind: "cancel";
  readonly requestId: SimWorkerRequestId;
}

/** The wire form of a progress notification (the engine's step counter). */
export interface SerializedSimProgressNotification {
  readonly kind: "progress";
  readonly step: number;
  readonly totalSteps?: number;
}

/** The wire form of a field-chunk notification (values as base64 bytes). */
export interface SerializedSimFieldChunkNotification {
  readonly kind: "field-chunk";
  readonly id: string;
  readonly unit?: string;
  readonly extent: readonly [number, number, number];
  readonly originMm: readonly [number, number, number];
  readonly spacingMm: readonly [number, number, number];
  readonly dataType: "float32" | "float64";
  readonly chunkIndex: number;
  readonly chunkCount: number;
  /** The chunk's value count — must match the base64 byte length. */
  readonly valueCount: number;
  /** The chunk's values: strict base64 of the raw little-endian floats. */
  readonly values: string;
}

/**
 * The wire form of an optimization-generation notification (Phase 70a):
 * the best-of-generation notice an optimization run publishes after each
 * generation settles — pure JSON numbers, no binary payload.
 */
export interface SerializedSimOptimizationGenerationNotification {
  readonly kind: "optimization-generation";
  readonly generation: number;
  readonly evaluated: number;
  readonly budget: number;
  readonly best?: readonly number[];
}

/** The wire payload of a notification message. */
export type SerializedSimWorkerNotification =
  | SerializedSimProgressNotification
  | SerializedSimFieldChunkNotification
  | SerializedSimOptimizationGenerationNotification;

/** The decoded progress notification: the engine's step counter, tagged. */
export interface SimProgressNotification extends SimEngineProgress {
  readonly kind: "progress";
}

/** The decoded field-chunk notification: one block slice, tagged. */
export interface SimFieldChunkNotification extends SimEngineFieldChunk {
  readonly kind: "field-chunk";
}

/** The decoded optimization-generation notification: the notice, tagged. */
export interface SimOptimizationGenerationNotification extends SimEngineOptimizationGeneration {
  readonly kind: "optimization-generation";
}

/** The typed notification payload a host consumes after decode. */
export type SimWorkerNotification =
  | SimProgressNotification
  | SimFieldChunkNotification
  | SimOptimizationGenerationNotification;

/** One decoded notification with the request it streams for. */
export interface SimNotificationDelivery {
  readonly requestId: SimWorkerRequestId;
  readonly notification: SimWorkerNotification;
}

/**
 * A notification: worker→host streaming data about the request bearing
 * `requestId` — never a terminal response, never settles the request.
 */
export interface SimWorkerNotificationMessage {
  readonly protocolVersion: number;
  readonly kind: "notification";
  readonly requestId: SimWorkerRequestId;
  readonly notification: SerializedSimWorkerNotification;
}

/** Any message of the sim worker protocol. */
export type SimWorkerMessage =
  | SimWorkerRequestMessage
  | SimWorkerResponseMessage
  | SimWorkerCancelMessage
  | SimWorkerNotificationMessage;

// ---------------------------------------------------------------------------
// Builders (fixed key order)
// ---------------------------------------------------------------------------

/** Builds a request message with the operation's typed, serialized input. */
export function createSimWorkerRequest<O extends SimWorkerOperationId>(
  requestId: SimWorkerRequestId,
  operation: O,
  input: SimWorkerOperationInput<O>,
): SimWorkerRequestMessage {
  return {
    protocolVersion: SIM_WORKER_PROTOCOL_VERSION,
    kind: "request",
    requestId,
    operation,
    input: serializeSimWorkerOperationInput(operation, input),
  };
}

/** Builds a success response with the operation's typed, serialized result. */
export function createSimWorkerSuccessResponse<O extends SimWorkerOperationId>(
  requestId: SimWorkerRequestId,
  operation: O,
  result: SimWorkerOperationResult<O>,
): SimWorkerSuccessResponseMessage {
  return {
    protocolVersion: SIM_WORKER_PROTOCOL_VERSION,
    kind: "response",
    requestId,
    status: "ok",
    result: serializeSimWorkerOperationResult(operation, result),
  };
}

/**
 * Builds an error response. Pass `null` as `requestId` only when the
 * request itself could not be parsed.
 */
export function createSimWorkerErrorResponse(
  requestId: SimWorkerRequestId | null,
  error: SimWorkerError,
): SimWorkerErrorResponseMessage {
  return {
    protocolVersion: SIM_WORKER_PROTOCOL_VERSION,
    kind: "response",
    requestId,
    status: "error",
    error,
  };
}

/** Builds a cancel message voiding the request bearing `requestId`. */
export function createSimWorkerCancel(
  requestId: SimWorkerRequestId,
): SimWorkerCancelMessage {
  return {
    protocolVersion: SIM_WORKER_PROTOCOL_VERSION,
    kind: "cancel",
    requestId,
  };
}

/** Builds a progress notification for the request bearing `requestId`. */
export function createSimProgressNotification(
  requestId: SimWorkerRequestId,
  progress: SimEngineProgress,
): SimWorkerNotificationMessage {
  return {
    protocolVersion: SIM_WORKER_PROTOCOL_VERSION,
    kind: "notification",
    requestId,
    notification: {
      kind: "progress",
      step: progress.step,
      ...(progress.totalSteps === undefined
        ? {}
        : { totalSteps: progress.totalSteps }),
    },
  };
}

/** Builds a field-chunk notification for the request bearing `requestId`. */
export function createSimFieldChunkNotification(
  requestId: SimWorkerRequestId,
  chunk: SimEngineFieldChunk,
): SimWorkerNotificationMessage {
  return {
    protocolVersion: SIM_WORKER_PROTOCOL_VERSION,
    kind: "notification",
    requestId,
    notification: {
      kind: "field-chunk",
      id: chunk.id,
      ...(chunk.unit === undefined ? {} : { unit: chunk.unit }),
      extent: [...chunk.extent] as readonly [number, number, number],
      originMm: [...chunk.originMm] as readonly [number, number, number],
      spacingMm: [...chunk.spacingMm] as readonly [number, number, number],
      dataType: chunk.dataType,
      chunkIndex: chunk.chunkIndex,
      chunkCount: chunk.chunkCount,
      // The explicit count mirrors the payload block's own u32: the parser
      // demands it match the base64 byte length, so a truncated chunk can
      // never decode to guessed values.
      valueCount: chunk.values.length,
      values: encodeSimBase64(
        encodeSimFieldChunkValues(chunk.values, chunk.dataType),
      ),
    },
  };
}

/**
 * Builds an optimization-generation notification for the request bearing
 * `requestId` (Phase 70a): the generation counter, the cumulative
 * evaluation count, the budget, and — when the generation produced one —
 * the best candidate's raw objective vector.
 */
export function createSimOptimizationGenerationNotification(
  requestId: SimWorkerRequestId,
  notice: SimEngineOptimizationGeneration,
): SimWorkerNotificationMessage {
  return {
    protocolVersion: SIM_WORKER_PROTOCOL_VERSION,
    kind: "notification",
    requestId,
    notification: {
      kind: "optimization-generation",
      generation: notice.generation,
      evaluated: notice.evaluated,
      budget: notice.budget,
      ...(notice.best === undefined ? {} : { best: [...notice.best] }),
    },
  };
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

function isPlainRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}

function isFiniteNumber(input: unknown): input is number {
  return typeof input === "number" && Number.isFinite(input);
}

function isNonNegativeInteger(input: unknown): input is number {
  return typeof input === "number" && Number.isInteger(input) && input >= 0;
}

function malformed(
  message: string,
  input: unknown,
): { ok: false; error: SimWorkerParseError } {
  return {
    ok: false,
    error: simWorkerParseError(
      SIM_WORKER_PROTOCOL_ERROR_CODES.malformedMessage,
      message,
      input,
    ),
  };
}

type ParseOutcome<T> =
  | { readonly ok: true; readonly value: T }
  | {
      readonly ok: false;
      readonly error: SimWorkerParseError;
    };

function parseRequestId(
  input: Record<string, unknown>,
): ParseOutcome<SimWorkerRequestId> {
  const parsed = parseSimWorkerRequestId(input.requestId);
  if (parsed.ok) return { ok: true, value: parsed.value };
  return malformed(
    `A sim worker message requestId must be a valid request id: ${parsed.error.message}`,
    input.requestId,
  );
}

function finiteTriple(
  input: unknown,
  field: string,
): ParseOutcome<readonly [number, number, number]> {
  // The element-wise copy keeps the element type `unknown` (never the
  // `any` Array.isArray narrows to), so every component narrows through
  // its own typeof/finite check below.
  const source: readonly unknown[] | null = Array.isArray(input)
    ? (input as readonly unknown[])
    : null;
  const entries: readonly unknown[] =
    source === null ? [] : [source[0], source[1], source[2]];
  if (entries.length !== 3 || !entries.every(isFiniteNumber)) {
    return malformed(
      `A field-chunk notification's "${field}" must be an array of exactly three finite numbers.`,
      input,
    );
  }
  const [x, y, z] = entries as readonly [number, number, number];
  return { ok: true, value: [x, y, z] };
}

/** Sanity budget for one chunk's decoded value count. */
const CHUNK_VALUE_BUDGET = 100_000_000;

/** The most objectives one optimization-generation notice may carry. */
const OPTIMIZATION_NOTICE_MAX_OBJECTIVES = 8;

function parseOptimizationGenerationNotification(
  input: Record<string, unknown>,
): ParseOutcome<SerializedSimOptimizationGenerationNotification> {
  if (!isNonNegativeInteger(input.generation)) {
    return malformed(
      "An optimization-generation notification's generation must be a non-negative integer.",
      input.generation,
    );
  }
  if (!isNonNegativeInteger(input.evaluated)) {
    return malformed(
      "An optimization-generation notification's evaluated must be a non-negative integer.",
      input.evaluated,
    );
  }
  if (!isNonNegativeInteger(input.budget)) {
    return malformed(
      "An optimization-generation notification's budget must be a non-negative integer.",
      input.budget,
    );
  }
  let best: readonly number[] | undefined;
  if (input.best !== undefined) {
    if (!Array.isArray(input.best)) {
      return malformed(
        "An optimization-generation notification's best must be an array of finite numbers.",
        input.best,
      );
    }
    if (input.best.length > OPTIMIZATION_NOTICE_MAX_OBJECTIVES) {
      return malformed(
        "An optimization-generation notification's best carries more than the objective budget.",
        input.best.length,
      );
    }
    const values: number[] = [];
    for (const value of input.best) {
      if (!isFiniteNumber(value)) {
        return malformed(
          "An optimization-generation notification's best must be an array of finite numbers.",
          input.best,
        );
      }
      values.push(value);
    }
    best = values;
  }
  return {
    ok: true,
    value: {
      kind: "optimization-generation",
      generation: input.generation,
      evaluated: input.evaluated,
      budget: input.budget,
      ...(best === undefined ? {} : { best }),
    },
  };
}

function parseProgressNotification(
  input: Record<string, unknown>,
): ParseOutcome<SerializedSimProgressNotification> {
  if (!isNonNegativeInteger(input.step)) {
    return malformed(
      "A progress notification's step must be a non-negative integer.",
      input.step,
    );
  }
  if (
    input.totalSteps !== undefined &&
    !isNonNegativeInteger(input.totalSteps)
  ) {
    return malformed(
      "A progress notification's totalSteps must be a non-negative integer.",
      input.totalSteps,
    );
  }
  return {
    ok: true,
    value: {
      kind: "progress",
      step: input.step,
      ...(input.totalSteps === undefined
        ? {}
        : { totalSteps: input.totalSteps }),
    },
  };
}

function parseFieldChunkNotification(
  input: Record<string, unknown>,
): ParseOutcome<SerializedSimFieldChunkNotification> {
  if (typeof input.id !== "string" || input.id.length === 0) {
    return malformed(
      "A field-chunk notification's id must be a non-empty string.",
      input.id,
    );
  }
  if (
    input.unit !== undefined &&
    (typeof input.unit !== "string" || input.unit.length === 0)
  ) {
    return malformed(
      "A field-chunk notification's unit must be a non-empty string.",
      input.unit,
    );
  }
  if (!Array.isArray(input.extent) || input.extent.length !== 3) {
    return malformed(
      "A field-chunk notification's extent must be an array of three positive integers.",
      input.extent,
    );
  }
  const [ex, ey, ez] = input.extent as readonly unknown[];
  if (
    !isNonNegativeInteger(ex) ||
    !(ex > 0) ||
    !isNonNegativeInteger(ey) ||
    !(ey > 0) ||
    !isNonNegativeInteger(ez) ||
    !(ez > 0)
  ) {
    return malformed(
      "A field-chunk notification's extent must be an array of three positive integers.",
      input.extent,
    );
  }
  const originMm = finiteTriple(input.originMm, "originMm");
  if (!originMm.ok) return originMm;
  const spacingMm = finiteTriple(input.spacingMm, "spacingMm");
  if (!spacingMm.ok) return spacingMm;
  if (input.dataType !== "float32" && input.dataType !== "float64") {
    return malformed(
      'A field-chunk notification\'s dataType must be "float32" or "float64".',
      input.dataType,
    );
  }
  if (
    !isNonNegativeInteger(input.chunkIndex) ||
    !isNonNegativeInteger(input.chunkCount) ||
    input.chunkCount < 1
  ) {
    return malformed(
      "A field-chunk notification's chunkIndex/chunkCount must be non-negative integers with chunkCount at least 1.",
      { chunkIndex: input.chunkIndex, chunkCount: input.chunkCount },
    );
  }
  if (!isNonNegativeInteger(input.valueCount)) {
    return malformed(
      "A field-chunk notification must declare a non-negative integer valueCount.",
      input.valueCount,
    );
  }
  if (typeof input.values !== "string") {
    return malformed(
      "A field-chunk notification's values must be strict base64 text.",
      input.values,
    );
  }
  const bytes = decodeSimBase64Strict(input.values);
  if (bytes === null) {
    return malformed(
      "A field-chunk notification's values are not strict canonical base64.",
      input.values,
    );
  }
  const width = input.dataType === "float32" ? 4 : 8;
  if (
    input.valueCount > CHUNK_VALUE_BUDGET ||
    bytes.length !== input.valueCount * width
  ) {
    return malformed(
      "A field-chunk notification's valueCount must match its base64 byte length.",
      input.valueCount,
    );
  }
  return {
    ok: true,
    value: {
      kind: "field-chunk",
      id: input.id,
      ...(input.unit === undefined ? {} : { unit: input.unit }),
      extent: [ex, ey, ez] as readonly [number, number, number],
      originMm: originMm.value,
      spacingMm: spacingMm.value,
      dataType: input.dataType,
      chunkIndex: input.chunkIndex,
      chunkCount: input.chunkCount,
      valueCount: input.valueCount,
      values: input.values,
    },
  };
}

function parseNotificationPayload(
  input: unknown,
): ParseOutcome<SerializedSimWorkerNotification> {
  if (!isPlainRecord(input)) {
    return malformed(
      'A notification message must carry a "notification" object.',
      input,
    );
  }
  if (input.kind === "progress") return parseProgressNotification(input);
  if (input.kind === "field-chunk") return parseFieldChunkNotification(input);
  if (input.kind === "optimization-generation") {
    return parseOptimizationGenerationNotification(input);
  }
  return malformed(
    'A notification payload kind must be "progress", "field-chunk", or "optimization-generation".',
    input.kind,
  );
}

/**
 * Parses untrusted input (e.g. a `message.data` revived from JSON) as a sim
 * worker message. The version gate runs before any other field is read, so
 * an unsupported version always fails with `worker/unsupported-version` and
 * never misparses; an unknown `kind` fails with
 * `worker/unknown-message-kind`; a broken envelope fails with
 * `worker/malformed-message`. Unknown fields are ignored. This function
 * never throws — every failure is a structured {@link SimWorkerParseError}.
 */
export function parseSimWorkerMessage(
  input: unknown,
): ParseOutcome<SimWorkerMessage> {
  if (!isPlainRecord(input)) {
    return malformed("A sim worker message must be a plain object.", input);
  }
  const version = input.protocolVersion;
  if (typeof version !== "number" || !Number.isInteger(version)) {
    return malformed(
      `A sim worker message must carry an integer protocolVersion; received ${String(version)}.`,
      input,
    );
  }
  if (version !== SIM_WORKER_PROTOCOL_VERSION) {
    return {
      ok: false,
      error: simWorkerParseError(
        SIM_WORKER_PROTOCOL_ERROR_CODES.unsupportedVersion,
        `A sim worker message speaks protocol version ${String(version)}; this endpoint speaks ${String(SIM_WORKER_PROTOCOL_VERSION)}.`,
        input,
      ),
    };
  }
  switch (input.kind) {
    case "request": {
      const requestId = parseRequestId(input);
      if (!requestId.ok) return requestId;
      const operation = input.operation;
      if (typeof operation !== "string" || operation.length === 0) {
        return malformed(
          'A sim worker request must carry a non-empty "operation" string.',
          operation,
        );
      }
      return {
        ok: true,
        value: {
          protocolVersion: version,
          kind: "request",
          requestId: requestId.value,
          operation,
          input: input.input,
        },
      };
    }
    case "response": {
      if (input.status === "ok") {
        if (!("result" in input)) {
          return malformed(
            'A successful sim worker response must carry a "result" field.',
            input,
          );
        }
        const requestId = parseRequestId(input);
        if (!requestId.ok) return requestId;
        return {
          ok: true,
          value: {
            protocolVersion: version,
            kind: "response",
            requestId: requestId.value,
            status: "ok",
            result: input.result,
          },
        };
      }
      if (input.status === "error") {
        const requestId =
          input.requestId === null
            ? ({ ok: true, value: null } as const)
            : parseRequestId(input);
        if (!requestId.ok) return requestId;
        const error = parseSimWorkerError(input.error);
        if (!error.ok) {
          return malformed(
            `A failed sim worker response must carry a structured error: ${error.error.message}`,
            input.error,
          );
        }
        return {
          ok: true,
          value: {
            protocolVersion: version,
            kind: "response",
            requestId: requestId.value,
            status: "error",
            error: error.value,
          },
        };
      }
      return malformed(
        `A sim worker response status must be "ok" or "error"; received ${String(input.status)}.`,
        input.status,
      );
    }
    case "cancel": {
      const requestId = parseRequestId(input);
      if (!requestId.ok) return requestId;
      return {
        ok: true,
        value: {
          protocolVersion: version,
          kind: "cancel",
          requestId: requestId.value,
        },
      };
    }
    case "notification": {
      const requestId = parseRequestId(input);
      if (!requestId.ok) return requestId;
      const notification = parseNotificationPayload(input.notification);
      if (!notification.ok) return notification;
      return {
        ok: true,
        value: {
          protocolVersion: version,
          kind: "notification",
          requestId: requestId.value,
          notification: notification.value,
        },
      };
    }
    default:
      return {
        ok: false,
        error: simWorkerParseError(
          SIM_WORKER_PROTOCOL_ERROR_CODES.unknownMessageKind,
          `A sim worker message kind must be one of: ${SIM_WORKER_MESSAGE_KINDS.join(", ")}; received ${String(input.kind)}.`,
          input,
        ),
      };
  }
}

/**
 * Decodes a parsed notification message's wire payload to the typed form a
 * host consumes ({@link SimProgressNotification} or
 * {@link SimFieldChunkNotification}): the chunk's base64 value bytes are
 * decoded and re-validated at the width its data type declares. Rejects
 * with `worker/malformed-message` — never returns partially guessed values.
 */
export function decodeSimWorkerNotification(
  message: SimWorkerNotificationMessage,
): ParseOutcome<SimNotificationDelivery> {
  const notification = message.notification;
  if (notification.kind === "progress") {
    return {
      ok: true,
      value: {
        requestId: message.requestId,
        notification: {
          kind: "progress",
          ...(notification.totalSteps === undefined
            ? {}
            : { totalSteps: notification.totalSteps }),
          step: notification.step,
        },
      },
    };
  }
  if (notification.kind === "optimization-generation") {
    return {
      ok: true,
      value: {
        requestId: message.requestId,
        notification: {
          kind: "optimization-generation",
          generation: notification.generation,
          evaluated: notification.evaluated,
          budget: notification.budget,
          ...(notification.best === undefined
            ? {}
            : { best: [...notification.best] }),
        },
      },
    };
  }
  const bytes = decodeSimBase64Strict(notification.values);
  if (bytes === null) {
    // Unreachable for a message that crossed parseSimWorkerMessage; kept
    // because this decode is its own trust boundary.
    return malformed(
      "A field-chunk notification's values are not strict canonical base64.",
      notification.values,
    );
  }
  const decoded = decodeSimFieldChunkValues(
    bytes,
    notification.dataType,
    notification.valueCount,
  );
  if (!decoded.ok) return malformed(decoded.error.message, notification);
  const chunk: SimFieldChunkNotification = {
    kind: "field-chunk",
    id: notification.id,
    ...(notification.unit === undefined ? {} : { unit: notification.unit }),
    extent: notification.extent,
    originMm: notification.originMm,
    spacingMm: notification.spacingMm,
    dataType: notification.dataType,
    chunkIndex: notification.chunkIndex,
    chunkCount: notification.chunkCount,
    values: decoded.value,
  };
  return {
    ok: true,
    value: { requestId: message.requestId, notification: chunk },
  };
}

/**
 * A request with its operation and input decoded to typed data: the
 * discriminated union over the operation vocabulary, so a responder can
 * `switch` on `operation` and get the narrowed input of that operation.
 */
export type DecodedSimWorkerRequest = {
  readonly [O in SimWorkerOperationId]: {
    readonly kind: "request";
    readonly requestId: SimWorkerRequestId;
    readonly operation: O;
    readonly input: SimWorkerOperationInput<O>;
  };
}[SimWorkerOperationId];

function decodedRequest<O extends SimWorkerOperationId>(
  requestId: SimWorkerRequestId,
  operation: O,
  input: SimWorkerOperationInput<O>,
): DecodedSimWorkerRequest {
  // The members are built exclusively from the validated operation name and
  // the matching parser's output above, so the cast only assembles the
  // correlated union member.
  return {
    kind: "request",
    requestId,
    operation,
    input,
  } as DecodedSimWorkerRequest;
}

/**
 * Decodes a parsed request message: verifies the operation against the
 * vocabulary (`worker/unknown-operation`) and its payload against the
 * operation's wire shape (`worker/malformed-payload`). The envelope layer
 * and this decode together form the responder's trust boundary.
 */
export function decodeSimWorkerRequest(
  message: SimWorkerRequestMessage,
): ParseOutcome<DecodedSimWorkerRequest> {
  if (!isSimWorkerOperationId(message.operation)) {
    return {
      ok: false,
      error: simWorkerParseError(
        SIM_WORKER_PROTOCOL_ERROR_CODES.unknownOperation,
        `Unknown operation "${message.operation}"; known operations: ${SIM_WORKER_OPERATION_IDS.join(", ")}.`,
        message.operation,
      ),
    };
  }
  const operation = message.operation;
  const parsed = parseSimWorkerOperationInput(operation, message.input);
  if (!parsed.ok) return parsed;
  return {
    ok: true,
    value: decodedRequest(message.requestId, operation, parsed.value),
  };
}

/**
 * Decodes a parsed success response's result against the operation that was
 * issued for it (the caller knows which operation bears that request id).
 * Rejects with `worker/malformed-payload` when the result does not satisfy
 * the operation's wire shape.
 */
export function decodeSimWorkerResult<O extends SimWorkerOperationId>(
  message: SimWorkerSuccessResponseMessage,
  operation: O,
): ParseOutcome<SimWorkerOperationResult<O>> {
  return parseSimWorkerOperationResult(operation, message.result);
}
