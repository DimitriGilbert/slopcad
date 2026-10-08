/**
 * Sim worker envelope tests (Phase 61b): the version gate, the four message
 * kinds (request, response, cancel, and the NEW notification class), the
 * builders' byte-determinism, and the strict parse boundary — mirroring the
 * kernel protocol's suite for the restated envelope plus the notification
 * coverage that is new here.
 */

import { describe, expect, it } from "vitest";

import {
  createSimFieldChunkNotification,
  createSimProgressNotification,
  createSimWorkerCancel,
  createSimWorkerErrorResponse,
  createSimWorkerRequest,
  createSimWorkerSuccessResponse,
  decodeSimWorkerNotification,
  decodeSimWorkerRequest,
  parseSimWorkerMessage,
  SIM_WORKER_PROTOCOL_VERSION,
} from "./sim-worker-protocol";
import {
  createSimWorkerRequestId,
  type SimProblemId,
  type SimRunId,
  parseSimProblemId,
  parseSimRunId,
  parseSimWorkerRequestId,
} from "./sim-worker-ids";
import {
  SIM_WORKER_PROTOCOL_ERROR_CODES,
  simWorkerError,
} from "./sim-worker-errors";

const requestId = parseSimWorkerRequestId("req_000001");
if (!requestId.ok) throw new Error("the test request id must parse");

function roundTrip(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value)) as unknown;
}

describe("the version gate", () => {
  it("rejects a message from another protocol version whole, before any other field is read", () => {
    const parsed = parseSimWorkerMessage({
      protocolVersion: 2,
      kind: "request",
      requestId: "req_000001",
      operation: "sim.compile",
      input: { scenario: {} },
    });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error.code).toBe(
      SIM_WORKER_PROTOCOL_ERROR_CODES.unsupportedVersion,
    );
  });

  it("rejects a missing or non-integer version as a malformed message", () => {
    for (const version of [undefined, "1", 1.5, null]) {
      const parsed = parseSimWorkerMessage({ protocolVersion: version });
      expect(parsed.ok).toBe(false);
      if (parsed.ok) return;
      expect(parsed.error.code).toBe(
        SIM_WORKER_PROTOCOL_ERROR_CODES.malformedMessage,
      );
    }
  });
});

describe("the request/response/cancel envelope", () => {
  it("builds a request, round-trips it through JSON, and decodes the operation", () => {
    const message = createSimWorkerRequest(requestId.value, "sim.run", {
      problem: problemId("wprob_000001"),
    });
    const parsed = parseSimWorkerMessage(roundTrip(message));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value).toEqual(message);
    if (parsed.value.kind !== "request") return;
    const decoded = decodeSimWorkerRequest(parsed.value);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(decoded.value.operation).toBe("sim.run");
    if (decoded.value.operation !== "sim.run") return;
    expect(decoded.value.input.problem).toBe("wprob_000001");
  });

  it("fails an unknown operation with worker/unknown-operation", () => {
    const decoded = decodeSimWorkerRequest({
      protocolVersion: SIM_WORKER_PROTOCOL_VERSION,
      kind: "request",
      requestId: requestId.value,
      operation: "solid.createBox",
      input: {},
    });
    expect(decoded.ok).toBe(false);
    if (decoded.ok) return;
    expect(decoded.error.code).toBe(
      SIM_WORKER_PROTOCOL_ERROR_CODES.unknownOperation,
    );
  });

  it("fails a malformed operation payload with worker/malformed-payload", () => {
    const decoded = decodeSimWorkerRequest({
      protocolVersion: SIM_WORKER_PROTOCOL_VERSION,
      kind: "request",
      requestId: requestId.value,
      operation: "sim.run",
      input: { problem: "not-a-worker-id" },
    });
    expect(decoded.ok).toBe(false);
    if (decoded.ok) return;
    expect(decoded.error.code).toBe(
      SIM_WORKER_PROTOCOL_ERROR_CODES.malformedPayload,
    );
  });

  it("builds and parses success and error responses; a null request id marks uncorrelatable errors", () => {
    const success = createSimWorkerSuccessResponse(requestId.value, "sim.run", {
      run: runIdOf("wrun_000001"),
      steps: 24,
      chunks: 24,
    });
    const parsedSuccess = parseSimWorkerMessage(roundTrip(success));
    expect(parsedSuccess.ok && parsedSuccess.value).toEqual(success);
    const failure = createSimWorkerErrorResponse(
      null,
      simWorkerError(SIM_WORKER_PROTOCOL_ERROR_CODES.malformedMessage, "nope"),
    );
    const parsedFailure = parseSimWorkerMessage(roundTrip(failure));
    expect(parsedFailure.ok && parsedFailure.value).toEqual(failure);
  });

  it("builds and parses a cancel message", () => {
    const cancel = createSimWorkerCancel(requestId.value);
    const parsed = parseSimWorkerMessage(roundTrip(cancel));
    expect(parsed.ok && parsed.value).toEqual(cancel);
  });

  it("rejects an unknown message kind", () => {
    const parsed = parseSimWorkerMessage({
      protocolVersion: SIM_WORKER_PROTOCOL_VERSION,
      kind: "greeting",
    });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error.code).toBe(
      SIM_WORKER_PROTOCOL_ERROR_CODES.unknownMessageKind,
    );
  });
});

describe("the notification class", () => {
  it("builds a progress notification that survives JSON and decodes to the engine shape", () => {
    const message = createSimProgressNotification(requestId.value, {
      step: 7,
      totalSteps: 24,
    });
    const parsed = parseSimWorkerMessage(roundTrip(message));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.kind).toBe("notification");
    if (parsed.value.kind !== "notification") return;
    const decoded = decodeSimWorkerNotification(parsed.value);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(decoded.value.requestId).toBe(requestId.value);
    expect(decoded.value.notification).toEqual({
      kind: "progress",
      step: 7,
      totalSteps: 24,
    });
  });

  it("builds a field-chunk notification whose values cross as the payload layout's float bytes", () => {
    const message = createSimFieldChunkNotification(requestId.value, {
      id: "velocity-magnitude",
      unit: "mm/s",
      extent: [4, 2, 1],
      originMm: [-500, -250, -250],
      spacingMm: [250, 250, 250],
      dataType: "float32",
      chunkIndex: 1,
      chunkCount: 2,
      values: [1.5, -2.25, 1000.125, -0.03125, 8, 7, 6, 5],
    });
    const parsed = parseSimWorkerMessage(roundTrip(message));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    if (parsed.value.kind !== "notification") return;
    const decoded = decodeSimWorkerNotification(parsed.value);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    if (decoded.value.notification.kind !== "field-chunk") return;
    expect(decoded.value.notification.id).toBe("velocity-magnitude");
    expect(decoded.value.notification.unit).toBe("mm/s");
    expect(decoded.value.notification.chunkIndex).toBe(1);
    expect(decoded.value.notification.chunkCount).toBe(2);
    // The float32 path is the compact exchange form: values round to
    // binary32 and back exactly for these dyadic picks.
    expect(decoded.value.notification.values).toEqual([
      1.5, -2.25, 1000.125, -0.03125, 8, 7, 6, 5,
    ]);
  });

  it("fails a chunk whose declared value count does not match its bytes", () => {
    const message = roundTrip(
      createSimFieldChunkNotification(requestId.value, {
        id: "pressure",
        extent: [2, 2, 1],
        originMm: [0, 0, 0],
        spacingMm: [1, 1, 1],
        dataType: "float32",
        chunkIndex: 0,
        chunkCount: 1,
        values: [1, 2, 3, 4],
      }),
    ) as Record<string, { notification: Record<string, unknown> }>;
    const tampered = {
      ...message,
      notification: { ...message.notification, valueCount: 3 },
    };
    const parsed = parseSimWorkerMessage(tampered);
    expect(parsed.ok).toBe(false);
  });

  it("fails a notification payload of an unknown kind", () => {
    const parsed = parseSimWorkerMessage({
      protocolVersion: SIM_WORKER_PROTOCOL_VERSION,
      kind: "notification",
      requestId: "req_000001",
      notification: { kind: "gossip" },
    });
    expect(parsed.ok).toBe(false);
  });

  it("drops a notification whose request id does not parse", () => {
    const parsed = parseSimWorkerMessage({
      protocolVersion: SIM_WORKER_PROTOCOL_VERSION,
      kind: "notification",
      requestId: "wrun_000001",
      notification: { kind: "progress", step: 1 },
    });
    expect(parsed.ok).toBe(false);
  });
});

describe("builder determinism", () => {
  it("emits identical bytes for identical values, in fixed key order", () => {
    const chunk = {
      id: "temperature",
      unit: "K",
      extent: [2, 2, 1] as const,
      originMm: [0, 0, 0] as const,
      spacingMm: [1, 1, 1] as const,
      dataType: "float64" as const,
      chunkIndex: 0,
      chunkCount: 1,
      values: [300.5, 301.5, 302.5, 303.5],
    };
    const a = createSimFieldChunkNotification(requestId.value, chunk);
    const b = createSimFieldChunkNotification(requestId.value, chunk);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    // The fixed key order IS the wire contract — pinned exactly, so a key
    // reorder changes bytes and fails this line.
    expect(Object.keys(a)).toEqual([
      "protocolVersion",
      "kind",
      "requestId",
      "notification",
    ]);
    expect(Object.keys(a.notification)).toEqual([
      "kind",
      "id",
      "unit",
      "extent",
      "originMm",
      "spacingMm",
      "dataType",
      "chunkIndex",
      "chunkCount",
      "valueCount",
      "values",
    ]);
  });

  it("mints request ids from a deterministic generator in the kernel's wire format", () => {
    expect(createSimWorkerRequestId("req_000042")).toBe("req_000042");
    expect(() => createSimWorkerRequestId("wsol_000042")).toThrow();
  });
});

function problemId(raw: string): SimProblemId {
  const parsed = parseSimProblemId(raw);
  if (!parsed.ok) throw new Error("test problem id must parse");
  return parsed.value;
}

function runIdOf(raw: string): SimRunId {
  const parsed = parseSimRunId(raw);
  if (!parsed.ok) throw new Error("test run id must parse");
  return parsed.value;
}
