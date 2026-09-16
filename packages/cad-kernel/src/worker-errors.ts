/**
 * Stable error codes and the structured, serializable error payload of the
 * worker protocol (Phase 10.1).
 *
 * Two shapes share this module, and the split is deliberate:
 *
 * - {@link WorkerParseError} is the *in-process* failure returned by every
 *   protocol parse function. It extends cad-core's `ParseFailure` so worker
 *   protocol parsing composes with the rest of the stack's result discipline
 *   (structured failures at trust boundaries, never throws). It retains the
 *   rejected `input` for diagnostics — which is exactly why it must not cross
 *   the wire.
 * - {@link WorkerError} is the *wire* payload an error response carries: a
 *   stable {@link WorkerErrorCode}, a human-readable message, and optional
 *   JSON-primitive `data` (e.g. the kernel error code that caused an
 *   `worker/operation-failed`). The rejected input is deliberately not echoed
 *   onto the wire — payloads can be large, and the sender already has them.
 *
 * Every failure mode of worker communication is one of these codes. A raw
 * exception string is never the only signal: kernel-side failures ride an
 * `worker/operation-failed` response with the kernel code in `data`, and
 * transport-level surprises are converted by the responder (Phase 10.2) into
 * one of the codes below.
 */

import {
  type ParseFailure,
  type ParseResult,
  fail,
  ok,
} from "@slopcad/cad-core";

/**
 * Registry of stable worker protocol error codes, formatted
 * `<domain>/<name>`. Never rename an existing code — callers branch on them.
 */
export const WORKER_PROTOCOL_ERROR_CODES = {
  /** The message carries a protocol version this endpoint does not speak. */
  unsupportedVersion: "worker/unsupported-version",
  /** The message `kind` is not one the protocol defines. */
  unknownMessageKind: "worker/unknown-message-kind",
  /** The request names an operation outside the protocol's vocabulary. */
  unknownOperation: "worker/unknown-operation",
  /** A required envelope field is missing or has the wrong shape. */
  malformedMessage: "worker/malformed-message",
  /** An operation's input or result payload has the wrong shape. */
  malformedPayload: "worker/malformed-payload",
  /** A request id was reused while its first use was still unresolved. */
  duplicateRequest: "worker/duplicate-request",
  /** The request was cancelled; its outcome is void. */
  cancelled: "worker/cancelled",
  /**
   * The channel closed before the request settled, so its outcome is unknown
   * and the request is void. This code is synthesized by the endpoint that
   * observes the closure (the worker client's close, driven by a channel
   * adapter's termination) — a remote peer never sends it — and exists so
   * that closing or losing a transport can never leave an in-flight promise
   * pending forever (the Phase 10.3 termination rule).
   */
  transportClosed: "worker/transport-closed",
  /** The operation ran and failed; `data` carries the underlying cause code. */
  operationFailed: "worker/operation-failed",
} as const;

export type WorkerErrorCode =
  (typeof WORKER_PROTOCOL_ERROR_CODES)[keyof typeof WORKER_PROTOCOL_ERROR_CODES];

const CODE_SET: ReadonlySet<string> = new Set(
  Object.values(WORKER_PROTOCOL_ERROR_CODES),
);

/** Type guard for untrusted worker error codes. */
export function isWorkerErrorCode(input: unknown): input is WorkerErrorCode {
  return typeof input === "string" && CODE_SET.has(input);
}

/** JSON-safe primitive values allowed in {@link WorkerError.data}. */
export type WorkerErrorDataValue = string | number | boolean | null;

/**
 * The structured, serializable error payload of an error response. Every
 * field is plain data, so a worker error survives `value → JSON → value`
 * unchanged. Raw exception strings never appear as the only signal: when an
 * exception is the cause, `code` classifies it and `data` carries the
 * stable cause code (e.g. `kernel/invalid-length` under
 * `worker/operation-failed`).
 */
export interface WorkerError {
  readonly code: WorkerErrorCode;
  readonly message: string;
  readonly data?: Readonly<Record<string, WorkerErrorDataValue>>;
}

/**
 * Structured failure describing why input was rejected by a worker protocol
 * parse function. In-process only; use {@link toWorkerError} to convert it
 * into the wire payload of an error response.
 */
export interface WorkerParseError extends ParseFailure {
  readonly code: WorkerErrorCode;
}

/** Builds an in-process worker protocol parse failure. */
export function workerParseError(
  code: WorkerErrorCode,
  message: string,
  input: unknown,
): WorkerParseError {
  return { code, message, input };
}

/** Builds the wire error payload of an error response. */
export function workerError(
  code: WorkerErrorCode,
  message: string,
  data?: Readonly<Record<string, WorkerErrorDataValue>>,
): WorkerError {
  return data === undefined ? { code, message } : { code, message, data };
}

/** Converts a parse failure into its wire form by dropping the retained input. */
export function toWorkerError(error: WorkerParseError): WorkerError {
  return { code: error.code, message: error.message };
}

function isPlainRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}

function isDataValue(input: unknown): input is WorkerErrorDataValue {
  if (typeof input === "number") return Number.isFinite(input);
  return (
    typeof input === "string" || typeof input === "boolean" || input === null
  );
}

/**
 * Parses untrusted input (e.g. an error payload revived from a message) as a
 * {@link WorkerError}. Known fields are validated strictly; unknown fields
 * are ignored so future protocol versions deserialize without corruption.
 */
export function parseWorkerError(
  input: unknown,
): ParseResult<WorkerError, WorkerParseError> {
  const rejected = (
    message: string,
  ): ParseResult<WorkerError, WorkerParseError> =>
    fail(
      workerParseError(
        WORKER_PROTOCOL_ERROR_CODES.malformedMessage,
        message,
        input,
      ),
    );
  if (!isPlainRecord(input)) {
    return rejected("A worker error payload must be a plain object.");
  }
  const { code, message, data } = input;
  if (!isWorkerErrorCode(code)) {
    return rejected(
      "A worker error code must be one of the codes registered in WORKER_PROTOCOL_ERROR_CODES.",
    );
  }
  if (typeof message !== "string" || message.length === 0) {
    return rejected("A worker error message must be a non-empty string.");
  }
  if (data === undefined) return ok({ code, message });
  if (!isPlainRecord(data)) {
    return rejected(
      "Worker error data must be a plain object of string, finite number, boolean, or null values.",
    );
  }
  const parsedData: Record<string, WorkerErrorDataValue> = {};
  for (const [key, value] of Object.entries(data)) {
    if (!isDataValue(value)) {
      return rejected(
        `Worker error data["${key}"] must be a string, finite number, boolean, or null.`,
      );
    }
    parsedData[key] = value;
  }
  return ok({ code, message, data: parsedData });
}
