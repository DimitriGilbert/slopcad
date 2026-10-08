/**
 * Stable error codes and the structured, serializable error payload of the
 * sim worker protocol (Phase 61b).
 *
 * sim-core depends on nothing at runtime, so the kernel protocol's error
 * registry (`@slopcad/cad-kernel`'s `worker-errors`) is RESTATED here with
 * the same `worker/*` wire codes and the same split the kernel established:
 * an in-process parse failure retains the rejected input for diagnostics and
 * must not cross the wire, while the wire payload drops it and may carry
 * JSON-primitive `data` — for the sim protocol, the `sim/*` decline code of
 * the underlying engine/compile failure under `data.simCode` (the kernel's
 * `data.kernelCode` slot, twin discipline). The kernel module stays the
 * semantic authority; a cross-compatibility test pins the two registries'
 * shared codes against drift.
 */

/** The in-process parse failure of a sim worker protocol boundary. */
export interface SimWorkerParseError {
  /** One of the {@link SIM_WORKER_PROTOCOL_ERROR_CODES}. */
  readonly code: SimWorkerErrorCode;
  readonly message: string;
  /** Retained for diagnostics; never crosses the wire. */
  readonly input: unknown;
}

/**
 * Registry of stable wire error codes, formatted `<domain>/<name>`. The
 * `worker/*` family is pinned to the kernel protocol's registry — the two
 * envelopes fail each other's traffic with the same codes. Never rename an
 * existing code — callers branch on them.
 */
export const SIM_WORKER_PROTOCOL_ERROR_CODES = {
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
   * and the request is void. Synthesized by the endpoint observing the
   * closure; a remote peer never sends it.
   */
  transportClosed: "worker/transport-closed",
  /** The operation ran and failed; `data` carries the underlying cause code. */
  operationFailed: "worker/operation-failed",
} as const;

export type SimWorkerErrorCode =
  (typeof SIM_WORKER_PROTOCOL_ERROR_CODES)[keyof typeof SIM_WORKER_PROTOCOL_ERROR_CODES];

const CODE_SET: ReadonlySet<string> = new Set(
  Object.values(SIM_WORKER_PROTOCOL_ERROR_CODES),
);

/** Type guard for untrusted sim worker error codes. */
export function isSimWorkerErrorCode(
  input: unknown,
): input is SimWorkerErrorCode {
  return typeof input === "string" && CODE_SET.has(input);
}

/** JSON-safe primitive values allowed in {@link SimWorkerError.data}. */
export type SimWorkerErrorDataValue = string | number | boolean | null;

/**
 * The structured, serializable error payload of an error response. Every
 * field is plain data, so the payload survives `value → JSON → value`
 * unchanged.
 */
export interface SimWorkerError {
  readonly code: SimWorkerErrorCode;
  readonly message: string;
  readonly data?: Readonly<Record<string, SimWorkerErrorDataValue>>;
}

/** Builds an in-process sim worker protocol parse failure. */
export function simWorkerParseError(
  code: SimWorkerErrorCode,
  message: string,
  input: unknown,
): SimWorkerParseError {
  return { code, message, input };
}

/** Builds the wire error payload of an error response. */
export function simWorkerError(
  code: SimWorkerErrorCode,
  message: string,
  data?: Readonly<Record<string, SimWorkerErrorDataValue>>,
): SimWorkerError {
  return data === undefined ? { code, message } : { code, message, data };
}

/** Converts a parse failure into its wire form by dropping the input. */
export function toSimWorkerError(error: SimWorkerParseError): SimWorkerError {
  return { code: error.code, message: error.message };
}

function isPlainRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}

function isDataValue(input: unknown): input is SimWorkerErrorDataValue {
  if (typeof input === "number") return Number.isFinite(input);
  return (
    typeof input === "string" || typeof input === "boolean" || input === null
  );
}

/** The parse outcome of untrusted wire-error input. */
export type SimWorkerErrorParseResult =
  | { readonly ok: true; readonly value: SimWorkerError }
  | { readonly ok: false; readonly error: SimWorkerParseError };

/**
 * Parses untrusted input (e.g. an error payload revived from a message) as a
 * {@link SimWorkerError}. Known fields are validated strictly; unknown fields
 * are ignored so future protocol revisions deserialize without corruption.
 */
export function parseSimWorkerError(input: unknown): SimWorkerErrorParseResult {
  const rejected = (message: string): SimWorkerErrorParseResult => ({
    ok: false,
    error: simWorkerParseError(
      SIM_WORKER_PROTOCOL_ERROR_CODES.malformedMessage,
      message,
      input,
    ),
  });
  if (!isPlainRecord(input)) {
    return rejected("A sim worker error payload must be a plain object.");
  }
  const { code, message, data } = input;
  if (!isSimWorkerErrorCode(code)) {
    return rejected(
      "A sim worker error code must be one of the codes registered in SIM_WORKER_PROTOCOL_ERROR_CODES.",
    );
  }
  if (typeof message !== "string" || message.length === 0) {
    return rejected("A sim worker error message must be a non-empty string.");
  }
  if (data === undefined) return { ok: true, value: { code, message } };
  if (!isPlainRecord(data)) {
    return rejected(
      "Sim worker error data must be a plain object of string, finite number, boolean, or null values.",
    );
  }
  const parsedData: Record<string, SimWorkerErrorDataValue> = {};
  for (const [key, value] of Object.entries(data)) {
    if (!isDataValue(value)) {
      return rejected(
        `Sim worker error data["${key}"] must be a string, finite number, boolean, or null.`,
      );
    }
    parsedData[key] = value;
  }
  return { ok: true, value: { code, message, data: parsedData } };
}
