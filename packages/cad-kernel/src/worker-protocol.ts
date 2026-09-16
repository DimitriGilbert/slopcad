/**
 * The versioned worker message envelope (Phase 10.1): the serializable
 * request, response, and cancellation messages that cross a worker channel,
 * and the strict parser that guards the boundary.
 *
 * The architecture is settled: the CAD domain executes client-side in a
 * worker and the main thread is a command/projection client, so everything
 * that crosses the main-thread↔worker boundary is data. An envelope carries
 * three things: the {@link WORKER_PROTOCOL_VERSION} it speaks, the message
 * `kind`, and a {@link WorkerRequestId} for correlation. Requests additionally
 * carry an operation name and its payload (the vocabulary of
 * `./worker-operations`); responses carry either a result or a structured
 * {@link WorkerError}.
 *
 * ## Version gating
 *
 * `parseWorkerMessage` checks `protocolVersion` *before any other field is
 * read*. A message from another protocol version may give every other field
 * a different meaning, so it is rejected whole with a structured
 * `worker/unsupported-version` failure — never misparsed. A missing or
 * non-integer version is a `worker/malformed-message` (there is no version to
 * disagree with yet). A responder that fails the version gate cannot trust
 * the message's request id either; it answers with an error response whose
 * `requestId` is `null` (the documented marker for "correlation impossible"),
 * built with {@link createWorkerErrorResponse}.
 *
 * ## Determinism and tolerance
 *
 * Builders emit fields in a fixed key order, so identical messages produce
 * identical bytes. Parsing is strict on known fields and ignores unknown
 * fields, so a newer minor revision of the same version deserializes without
 * corruption. Every message survives `value → JSON → value` unchanged.
 */

import { type ParseResult, fail, ok } from "@slopcad/cad-core";

import {
  isWorkerOperationId,
  type WorkerOperationId,
  type WorkerOperationInput,
  type WorkerOperationResult,
  WORKER_OPERATION_IDS,
  parseWorkerOperationInput,
  parseWorkerOperationResult,
  serializeWorkerOperationInput,
  serializeWorkerOperationResult,
} from "./worker-operations";
import {
  type WorkerError,
  WORKER_PROTOCOL_ERROR_CODES,
  type WorkerParseError,
  parseWorkerError,
  workerParseError,
} from "./worker-errors";
import { type WorkerRequestId, parseWorkerRequestId } from "./worker-ids";

/**
 * The worker protocol version this package speaks. Bumping it is a breaking
 * wire change: endpoints that disagree fail each other's messages with
 * `worker/unsupported-version` instead of misreading them.
 */
export const WORKER_PROTOCOL_VERSION = 1;

/** The message kinds of the protocol. */
export const WORKER_MESSAGE_KINDS = ["request", "response", "cancel"] as const;

/** Discriminator of a worker message. */
export type WorkerMessageKind = (typeof WORKER_MESSAGE_KINDS)[number];

/**
 * A request: execute `operation` with `input`. `operation` stays a string on
 * the envelope so an unknown operation name is *representable* and fails
 * predictably in {@link decodeWorkerRequest} with `worker/unknown-operation`;
 * `input` is the operation's canonical serialized payload.
 */
export interface WorkerRequestMessage {
  readonly protocolVersion: number;
  readonly kind: "request";
  readonly requestId: WorkerRequestId;
  readonly operation: string;
  readonly input: unknown;
}

/**
 * A successful response: `result` is the operation's canonical serialized
 * result. `requestId` is never `null` here — a success always correlates
 * with a request the caller issued.
 */
export interface WorkerSuccessResponseMessage {
  readonly protocolVersion: number;
  readonly kind: "response";
  readonly requestId: WorkerRequestId;
  readonly status: "ok";
  readonly result: unknown;
}

/**
 * A failed response: `error` is the structured wire failure. `requestId` is
 * `null` exactly when the request could not be parsed at all (e.g. a version
 * gate failure), because an unparseable request has no trustworthy
 * correlation id.
 */
export interface WorkerErrorResponseMessage {
  readonly protocolVersion: number;
  readonly kind: "response";
  readonly requestId: WorkerRequestId | null;
  readonly status: "error";
  readonly error: WorkerError;
}

/** A response: success carries the result, failure carries a structured error. */
export type WorkerResponseMessage =
  WorkerSuccessResponseMessage | WorkerErrorResponseMessage;

/**
 * A cancellation: void the request bearing `requestId`. Semantics are pinned
 * in `./worker-cancellation` — in short, cancellation wins ties: once
 * recorded, no success for that request id can be emitted.
 */
export interface WorkerCancelMessage {
  readonly protocolVersion: number;
  readonly kind: "cancel";
  readonly requestId: WorkerRequestId;
}

/** Any message of the worker protocol. */
export type WorkerMessage =
  WorkerRequestMessage | WorkerResponseMessage | WorkerCancelMessage;

/**
 * Builds a request message with the operation's typed input, serialized to
 * its canonical wire form in fixed key order.
 */
export function createWorkerRequest<O extends WorkerOperationId>(
  requestId: WorkerRequestId,
  operation: O,
  input: WorkerOperationInput<O>,
): WorkerRequestMessage {
  return {
    protocolVersion: WORKER_PROTOCOL_VERSION,
    kind: "request",
    requestId,
    operation,
    input: serializeWorkerOperationInput(operation, input),
  };
}

/**
 * Builds a success response with the operation's typed result, serialized to
 * its canonical wire form in fixed key order.
 */
export function createWorkerSuccessResponse<O extends WorkerOperationId>(
  requestId: WorkerRequestId,
  operation: O,
  result: WorkerOperationResult<O>,
): WorkerSuccessResponseMessage {
  return {
    protocolVersion: WORKER_PROTOCOL_VERSION,
    kind: "response",
    requestId,
    status: "ok",
    result: serializeWorkerOperationResult(operation, result),
  };
}

/**
 * Builds an error response. Pass `null` as `requestId` only when the request
 * itself could not be parsed (see {@link WorkerErrorResponseMessage}).
 */
export function createWorkerErrorResponse(
  requestId: WorkerRequestId | null,
  error: WorkerError,
): WorkerErrorResponseMessage {
  return {
    protocolVersion: WORKER_PROTOCOL_VERSION,
    kind: "response",
    requestId,
    status: "error",
    error,
  };
}

/** Builds a cancel message voiding the request bearing `requestId`. */
export function createWorkerCancel(
  requestId: WorkerRequestId,
): WorkerCancelMessage {
  return {
    protocolVersion: WORKER_PROTOCOL_VERSION,
    kind: "cancel",
    requestId,
  };
}

function isPlainRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}

function malformed(
  message: string,
  input: unknown,
): ParseResult<never, WorkerParseError> {
  return fail(
    workerParseError(
      WORKER_PROTOCOL_ERROR_CODES.malformedMessage,
      message,
      input,
    ),
  );
}

function parseRequestRequestId(
  input: Record<string, unknown>,
): ParseResult<WorkerRequestId, WorkerParseError> {
  const parsed = parseWorkerRequestId(input.requestId);
  if (parsed.ok) return parsed;
  return malformed(
    `A worker message requestId must be a valid request id: ${parsed.error.message}`,
    input.requestId,
  );
}

/**
 * Parses untrusted input (e.g. a `message.data` revived from JSON) as a
 * worker message. The version gate runs before any other field is read, so
 * an unsupported version always fails with `worker/unsupported-version` and
 * never misparses; an unknown `kind` fails with
 * `worker/unknown-message-kind`; a broken envelope fails with
 * `worker/malformed-message`. Unknown fields are ignored. This function
 * never throws — every failure is a structured {@link WorkerParseError}.
 */
export function parseWorkerMessage(
  input: unknown,
): ParseResult<WorkerMessage, WorkerParseError> {
  if (!isPlainRecord(input)) {
    return malformed("A worker message must be a plain object.", input);
  }
  const version = input.protocolVersion;
  if (typeof version !== "number" || !Number.isInteger(version)) {
    return malformed(
      `A worker message must carry an integer protocolVersion; received ${String(version)}.`,
      input,
    );
  }
  if (version !== WORKER_PROTOCOL_VERSION) {
    return fail(
      workerParseError(
        WORKER_PROTOCOL_ERROR_CODES.unsupportedVersion,
        `A worker message speaks protocol version ${String(version)}; this endpoint speaks ${String(WORKER_PROTOCOL_VERSION)}.`,
        input,
      ),
    );
  }
  switch (input.kind) {
    case "request": {
      const requestId = parseRequestRequestId(input);
      if (!requestId.ok) return requestId;
      const operation = input.operation;
      if (typeof operation !== "string" || operation.length === 0) {
        return malformed(
          'A worker request must carry a non-empty "operation" string.',
          operation,
        );
      }
      return ok({
        protocolVersion: version,
        kind: "request",
        requestId: requestId.value,
        operation,
        input: input.input,
      });
    }
    case "response": {
      if (input.status === "ok") {
        if (!("result" in input)) {
          return malformed(
            'A successful worker response must carry a "result" field.',
            input,
          );
        }
        const requestId = parseRequestRequestId(input);
        if (!requestId.ok) return requestId;
        return ok({
          protocolVersion: version,
          kind: "response",
          requestId: requestId.value,
          status: "ok",
          result: input.result,
        });
      }
      if (input.status === "error") {
        const requestId =
          input.requestId === null ? ok(null) : parseRequestRequestId(input);
        if (!requestId.ok) return requestId;
        const error = parseWorkerError(input.error);
        if (!error.ok) return error;
        return ok({
          protocolVersion: version,
          kind: "response",
          requestId: requestId.value,
          status: "error",
          error: error.value,
        });
      }
      return malformed(
        `A worker response status must be "ok" or "error"; received ${String(input.status)}.`,
        input,
      );
    }
    case "cancel": {
      const requestId = parseRequestRequestId(input);
      if (!requestId.ok) return requestId;
      return ok({
        protocolVersion: version,
        kind: "cancel",
        requestId: requestId.value,
      });
    }
    default:
      return fail(
        workerParseError(
          WORKER_PROTOCOL_ERROR_CODES.unknownMessageKind,
          `A worker message kind must be one of: ${WORKER_MESSAGE_KINDS.join(", ")}; received ${String(input.kind)}.`,
          input,
        ),
      );
  }
}

/**
 * A request with its operation and input decoded to typed data: the
 * discriminated union over the operation vocabulary, so a responder can
 * `switch` on `operation` and get the narrowed input of that operation.
 */
export type DecodedWorkerRequest = {
  readonly [O in WorkerOperationId]: {
    readonly kind: "request";
    readonly requestId: WorkerRequestId;
    readonly operation: O;
    readonly input: WorkerOperationInput<O>;
  };
}[WorkerOperationId];

function decodedRequest<O extends WorkerOperationId>(
  requestId: WorkerRequestId,
  operation: O,
  input: WorkerOperationInput<O>,
): DecodedWorkerRequest {
  // The members are built exclusively from the validated operation name and
  // the matching parser's output above, so the cast only assembles the
  // correlated union member.
  return {
    kind: "request",
    requestId,
    operation,
    input,
  } as DecodedWorkerRequest;
}

/**
 * Decodes a parsed request message: verifies the operation against the
 * vocabulary (`worker/unknown-operation`) and its payload against the
 * operation's wire shape (`worker/malformed-payload`). The envelope layer and
 * this decode together form the responder's trust boundary — after both
 * succeed, the input is typed, validated data.
 */
export function decodeWorkerRequest(
  message: WorkerRequestMessage,
): ParseResult<DecodedWorkerRequest, WorkerParseError> {
  if (!isWorkerOperationId(message.operation)) {
    return fail(
      workerParseError(
        WORKER_PROTOCOL_ERROR_CODES.unknownOperation,
        `Unknown operation "${message.operation}"; known operations: ${WORKER_OPERATION_IDS.join(", ")}.`,
        message.operation,
      ),
    );
  }
  const operation = message.operation;
  const parsed = parseWorkerOperationInput(operation, message.input);
  if (!parsed.ok) return parsed;
  return ok(decodedRequest(message.requestId, operation, parsed.value));
}

/**
 * Decodes a parsed success response's result against the operation that was
 * issued for it (the caller knows which operation bears that request id).
 * Rejects with `worker/malformed-payload` when the result does not satisfy
 * the operation's wire shape.
 */
export function decodeWorkerResult<O extends WorkerOperationId>(
  message: WorkerSuccessResponseMessage,
  operation: O,
): ParseResult<WorkerOperationResult<O>, WorkerParseError> {
  return parseWorkerOperationResult(operation, message.result);
}
