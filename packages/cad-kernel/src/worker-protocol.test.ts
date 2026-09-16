/**
 * The worker message envelope (Phase 10.1): version gating, message parsing,
 * fixed-key-order serialization, JSON round-trips, and the decode boundary
 * from envelope to typed operation request.
 */

import { describe, expect, it } from "vitest";
import { length, type ParseResult } from "@slopcad/cad-core";

import {
  createWorkerCancel,
  createWorkerErrorResponse,
  createWorkerRequest,
  createWorkerSuccessResponse,
  decodeWorkerRequest,
  decodeWorkerResult,
  type WorkerMessage,
  type WorkerRequestMessage,
  type WorkerSuccessResponseMessage,
  parseWorkerMessage,
  WORKER_MESSAGE_KINDS,
  WORKER_PROTOCOL_VERSION,
} from "./worker-protocol";
import {
  parseWorkerError,
  toWorkerError,
  workerError,
  workerParseError,
  WORKER_PROTOCOL_ERROR_CODES,
  type WorkerParseError,
} from "./worker-errors";
import {
  createWorkerRequestId,
  createWorkerSolidId,
  type WorkerRequestId,
} from "./worker-ids";

function failureOf(
  result: ParseResult<unknown, WorkerParseError>,
): WorkerParseError {
  if (result.ok) throw new Error("Expected the parse to fail.");
  return result.error;
}

function jsonRoundTrip<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function wireCopy(value: unknown): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

const requestId = createWorkerRequestId("req_000001");
const solidId = createWorkerSolidId("wsol_000001");
const boxRequest = (): WorkerRequestMessage =>
  createWorkerRequest(requestId, "solid.createBox", {
    width: length(10, "mm"),
    depth: length(10, "mm"),
    height: length(5, "mm"),
  });

describe("protocol version", () => {
  it("is pinned to 1, the initial worker protocol base", () => {
    expect(WORKER_PROTOCOL_VERSION).toBe(1);
    expect(Number.isInteger(WORKER_PROTOCOL_VERSION)).toBe(true);
  });

  it("defines exactly the three message kinds", () => {
    expect(WORKER_MESSAGE_KINDS).toEqual(["request", "response", "cancel"]);
  });
});

describe("message builders", () => {
  it("builds requests in the fixed envelope key order with canonical payload", () => {
    const message = boxRequest();
    expect(Object.keys(message)).toEqual([
      "protocolVersion",
      "kind",
      "requestId",
      "operation",
      "input",
    ]);
    expect(message.input).toEqual({
      width: { dimension: "length", unit: "mm", value: 10 },
      depth: { dimension: "length", unit: "mm", value: 10 },
      height: { dimension: "length", unit: "mm", value: 5 },
    });
  });

  it("builds success responses in the fixed envelope key order", () => {
    const message = createWorkerSuccessResponse(requestId, "solid.createBox", {
      solid: solidId,
    });
    expect(Object.keys(message)).toEqual([
      "protocolVersion",
      "kind",
      "requestId",
      "status",
      "result",
    ]);
  });

  it("builds error responses, including the null-requestId marker", () => {
    const message = createWorkerErrorResponse(
      null,
      workerError(WORKER_PROTOCOL_ERROR_CODES.unsupportedVersion, "too old"),
    );
    expect(Object.keys(message)).toEqual([
      "protocolVersion",
      "kind",
      "requestId",
      "status",
      "error",
    ]);
    expect(message.requestId).toBeNull();
  });

  it("builds cancel messages referencing the voided request id", () => {
    const message = createWorkerCancel(requestId);
    expect(message).toEqual({
      protocolVersion: WORKER_PROTOCOL_VERSION,
      kind: "cancel",
      requestId,
    });
  });

  it("produces byte-stable serialization for identical messages", () => {
    expect(JSON.stringify(boxRequest())).toBe(JSON.stringify(boxRequest()));
    expect(JSON.stringify(createWorkerCancel(requestId))).toBe(
      JSON.stringify(createWorkerCancel(requestId)),
    );
  });
});

describe("message parsing round-trips", () => {
  it("round-trips a request through JSON", () => {
    expect(parseWorkerMessage(jsonRoundTrip(boxRequest()))).toEqual({
      ok: true,
      value: boxRequest(),
    });
  });

  it("round-trips success and error responses through JSON", () => {
    const success = createWorkerSuccessResponse(requestId, "solid.volume", {
      volume: 42,
    });
    expect(parseWorkerMessage(jsonRoundTrip(success))).toEqual({
      ok: true,
      value: success,
    });
    const failure = createWorkerErrorResponse(
      requestId,
      workerError(WORKER_PROTOCOL_ERROR_CODES.operationFailed, "boom", {
        causeCode: "kernel/invalid-length",
      }),
    );
    expect(parseWorkerMessage(jsonRoundTrip(failure))).toEqual({
      ok: true,
      value: failure,
    });
  });

  it("round-trips a cancel message through JSON", () => {
    expect(
      parseWorkerMessage(jsonRoundTrip(createWorkerCancel(requestId))),
    ).toEqual({ ok: true, value: createWorkerCancel(requestId) });
  });

  it("ignores unknown fields so newer revisions deserialize", () => {
    const wire = wireCopy(boxRequest());
    wire.traceId = "abc";
    const parsed = parseWorkerMessage(wire);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value.kind).toBe("request");
      if (parsed.value.kind === "request") {
        expect(parsed.value.requestId).toBe(requestId);
      }
    }
  });
});

describe("version gating", () => {
  it("fails a missing or non-integer version as malformed", () => {
    expect(
      failureOf(parseWorkerMessage({ kind: "cancel", requestId })).code,
    ).toBe(WORKER_PROTOCOL_ERROR_CODES.malformedMessage);
    expect(
      failureOf(parseWorkerMessage({ protocolVersion: "1", kind: "cancel" }))
        .code,
    ).toBe(WORKER_PROTOCOL_ERROR_CODES.malformedMessage);
    expect(
      failureOf(parseWorkerMessage({ protocolVersion: 1.5, kind: "cancel" }))
        .code,
    ).toBe(WORKER_PROTOCOL_ERROR_CODES.malformedMessage);
  });

  it("fails unknown versions with the unsupported-version code", () => {
    for (const version of [0, 2, 99, -1]) {
      const error = failureOf(
        parseWorkerMessage({
          protocolVersion: version,
          kind: "cancel",
          requestId,
        }),
      );
      expect(error.code).toBe(WORKER_PROTOCOL_ERROR_CODES.unsupportedVersion);
      expect(error.message).toContain(String(version));
    }
  });

  it("gates the version before reading any other field, never misparsing", () => {
    // A version-2 message whose other fields mean something else entirely:
    // the gate must reject it as a whole without inspecting them.
    const error = failureOf(
      parseWorkerMessage({
        protocolVersion: 2,
        kind: { not: "a string" },
        requestId: null,
        operation: 42,
      }),
    );
    expect(error.code).toBe(WORKER_PROTOCOL_ERROR_CODES.unsupportedVersion);
  });

  it("fails a non-object message as malformed", () => {
    for (const input of [null, 42, "request", []]) {
      expect(failureOf(parseWorkerMessage(input)).code).toBe(
        WORKER_PROTOCOL_ERROR_CODES.malformedMessage,
      );
    }
  });
});

describe("envelope field validation", () => {
  it("fails an unknown message kind with the unknown-kind code", () => {
    const error = failureOf(
      parseWorkerMessage({
        protocolVersion: WORKER_PROTOCOL_VERSION,
        kind: "event",
      }),
    );
    expect(error.code).toBe(WORKER_PROTOCOL_ERROR_CODES.unknownMessageKind);
  });

  it("fails an invalid request id", () => {
    for (const badId of [null, 42, "wsol_000001", "req_"]) {
      const error = failureOf(
        parseWorkerMessage({
          protocolVersion: WORKER_PROTOCOL_VERSION,
          kind: "cancel",
          requestId: badId,
        }),
      );
      expect(error.code).toBe(WORKER_PROTOCOL_ERROR_CODES.malformedMessage);
    }
  });

  it("fails a request without a non-empty operation string", () => {
    for (const operation of [undefined, "", 42]) {
      const error = failureOf(
        parseWorkerMessage({
          protocolVersion: WORKER_PROTOCOL_VERSION,
          kind: "request",
          requestId,
          operation,
          input: {},
        }),
      );
      expect(error.code).toBe(WORKER_PROTOCOL_ERROR_CODES.malformedMessage);
    }
  });

  it("fails an invalid request id inside a request message", () => {
    expect(
      failureOf(
        parseWorkerMessage({
          protocolVersion: WORKER_PROTOCOL_VERSION,
          kind: "request",
          requestId: "wsol_000001",
          operation: "solid.volume",
          input: { solid: "wsol_000001" },
        }),
      ).code,
    ).toBe(WORKER_PROTOCOL_ERROR_CODES.malformedMessage);
  });

  it("fails an invalid non-null request id inside an error response", () => {
    expect(
      failureOf(
        parseWorkerMessage({
          protocolVersion: WORKER_PROTOCOL_VERSION,
          kind: "response",
          requestId: "nope",
          status: "error",
          error: {
            code: WORKER_PROTOCOL_ERROR_CODES.cancelled,
            message: "voided",
          },
        }),
      ).code,
    ).toBe(WORKER_PROTOCOL_ERROR_CODES.malformedMessage);
  });

  it("fails a success response without a result field or with a null request id", () => {
    expect(
      failureOf(
        parseWorkerMessage({
          protocolVersion: WORKER_PROTOCOL_VERSION,
          kind: "response",
          requestId,
          status: "ok",
        }),
      ).code,
    ).toBe(WORKER_PROTOCOL_ERROR_CODES.malformedMessage);
    expect(
      failureOf(
        parseWorkerMessage({
          protocolVersion: WORKER_PROTOCOL_VERSION,
          kind: "response",
          requestId: null,
          status: "ok",
          result: null,
        }),
      ).code,
    ).toBe(WORKER_PROTOCOL_ERROR_CODES.malformedMessage);
  });

  it("parses an error response carrying the null correlation marker", () => {
    const parsed = parseWorkerMessage({
      protocolVersion: WORKER_PROTOCOL_VERSION,
      kind: "response",
      requestId: null,
      status: "error",
      error: {
        code: WORKER_PROTOCOL_ERROR_CODES.unsupportedVersion,
        message: "too old",
      },
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.kind).toBe("response");
    if (parsed.value.kind !== "response") return;
    if (parsed.value.status !== "error") {
      throw new Error("Expected an error response.");
    }
    expect(parsed.value.requestId).toBeNull();
  });

  it("fails an error response with a malformed error payload", () => {
    for (const badError of [
      undefined,
      { code: "worker/not-a-code", message: "x" },
      { code: WORKER_PROTOCOL_ERROR_CODES.cancelled, message: "" },
      {
        code: WORKER_PROTOCOL_ERROR_CODES.cancelled,
        message: "m",
        data: { o: {} },
      },
      {
        code: WORKER_PROTOCOL_ERROR_CODES.cancelled,
        message: "m",
        data: "oops",
      },
    ]) {
      const error = failureOf(
        parseWorkerMessage({
          protocolVersion: WORKER_PROTOCOL_VERSION,
          kind: "response",
          requestId,
          status: "error",
          error: badError,
        }),
      );
      expect(error.code).toBe(WORKER_PROTOCOL_ERROR_CODES.malformedMessage);
    }
  });

  it("fails a response with an unknown status", () => {
    expect(
      failureOf(
        parseWorkerMessage({
          protocolVersion: WORKER_PROTOCOL_VERSION,
          kind: "response",
          requestId,
          status: "progress",
        }),
      ).code,
    ).toBe(WORKER_PROTOCOL_ERROR_CODES.malformedMessage);
  });
});

describe("request decoding", () => {
  it("decodes a parsed request into the typed operation union", () => {
    const message = parseWorkerMessage(jsonRoundTrip(boxRequest()));
    if (!message.ok) throw new Error("Expected the message to parse.");
    if (message.value.kind !== "request") {
      throw new Error("Expected a request message.");
    }
    const decoded = decodeWorkerRequest(message.value);
    expect(decoded).toEqual({
      ok: true,
      value: {
        kind: "request",
        requestId,
        operation: "solid.createBox",
        input: {
          width: length(10, "mm"),
          depth: length(10, "mm"),
          height: length(5, "mm"),
        },
      },
    });
  });

  it("fails an unknown operation with the unknown-operation code", () => {
    const raw = wireCopy(boxRequest());
    raw.operation = "document.rebuild";
    const message = parseWorkerMessage(raw);
    if (!message.ok || message.value.kind !== "request") {
      throw new Error("Expected a parsed request.");
    }
    const error = failureOf(decodeWorkerRequest(message.value));
    expect(error.code).toBe(WORKER_PROTOCOL_ERROR_CODES.unknownOperation);
    expect(error.message).toContain("document.rebuild");
  });

  it("fails a malformed operation payload with the malformed-payload code", () => {
    const raw = wireCopy(boxRequest());
    raw.input = { width: "wide" };
    const message = parseWorkerMessage(raw);
    if (!message.ok || message.value.kind !== "request") {
      throw new Error("Expected a parsed request.");
    }
    expect(failureOf(decodeWorkerRequest(message.value)).code).toBe(
      WORKER_PROTOCOL_ERROR_CODES.malformedPayload,
    );
  });
});

describe("result decoding", () => {
  it("decodes a success response's result for the issued operation", () => {
    const message: WorkerSuccessResponseMessage = createWorkerSuccessResponse(
      requestId,
      "solid.volume",
      { volume: 125 },
    );
    expect(decodeWorkerResult(message, "solid.volume")).toEqual({
      ok: true,
      value: { volume: 125 },
    });
  });

  it("fails a result that does not match the issued operation's shape", () => {
    const message = wireCopy(
      createWorkerSuccessResponse(requestId, "solid.volume", { volume: 125 }),
    );
    message.result = { solid: "wsol_000001" };
    const parsed = parseWorkerMessage(message);
    if (!parsed.ok || parsed.value.kind !== "response") {
      throw new Error("Expected a parsed response.");
    }
    if (parsed.value.status !== "ok") throw new Error("Expected ok status.");
    expect(
      failureOf(decodeWorkerResult(parsed.value, "solid.volume")).code,
    ).toBe(WORKER_PROTOCOL_ERROR_CODES.malformedPayload);
  });
});

describe("worker error payload", () => {
  it("round-trips through JSON and parseWorkerError", () => {
    const error = workerError(
      WORKER_PROTOCOL_ERROR_CODES.operationFailed,
      "The kernel rejected the operation.",
      { causeCode: "kernel/invalid-length" },
    );
    expect(parseWorkerError(jsonRoundTrip(error))).toEqual({
      ok: true,
      value: error,
    });
  });

  it("drops the retained input when converting a parse failure to the wire", () => {
    const parseFailure = workerParseError(
      WORKER_PROTOCOL_ERROR_CODES.cancelled,
      "voided",
      { big: "input" },
    );
    expect(toWorkerError(parseFailure)).toEqual({
      code: WORKER_PROTOCOL_ERROR_CODES.cancelled,
      message: "voided",
    });
  });
});

describe("cancellation wire form", () => {
  it("is a valid protocol message referencing the request id", () => {
    const cancel = createWorkerCancel(requestId);
    const parsed = parseWorkerMessage(jsonRoundTrip(cancel));
    expect(parsed).toEqual({ ok: true, value: cancel });
    if (parsed.ok) {
      const message: WorkerMessage = parsed.value;
      expect(message.kind).toBe("cancel");
      if (message.kind === "cancel") {
        const cancelledId: WorkerRequestId = message.requestId;
        expect(cancelledId).toBe(requestId);
      }
    }
  });
});
