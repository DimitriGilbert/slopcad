/**
 * Cross-compatibility pins (Phase 61b): the sim envelope's deliberate
 * restatement of the kernel protocol's disciplines is only honest while the
 * two stay pinned — this suite fails the moment they drift. The kernel
 * package is a dev-only import: it appears in no runtime graph of sim-core.
 */

import {
  WORKER_PROTOCOL_VERSION,
  parseWorkerMessage,
  WORKER_PROTOCOL_ERROR_CODES,
} from "@slopcad/cad-kernel";
import { describe, expect, it } from "vitest";

import {
  createSimFieldChunkNotification,
  createSimWorkerRequest,
  decodeSimWorkerRequest,
  parseSimWorkerMessage,
  SIM_WORKER_PROTOCOL_VERSION,
} from "./sim-worker-protocol";
import { SIM_WORKER_PROTOCOL_ERROR_CODES } from "./sim-worker-errors";
import { createSimWorkerRequestId, parseSimProblemId } from "./sim-worker-ids";

const requestId = createSimWorkerRequestId("req_000001");

describe("the envelope pin", () => {
  it("speaks the same protocol version as the kernel envelope", () => {
    expect(SIM_WORKER_PROTOCOL_VERSION).toBe(WORKER_PROTOCOL_VERSION);
  });

  it("shares the worker/* wire error family", () => {
    // The codes the two registries share by name carry the same literals;
    // a rename on either side breaks the envelope compatibility contract.
    expect(SIM_WORKER_PROTOCOL_ERROR_CODES.cancelled).toBe(
      WORKER_PROTOCOL_ERROR_CODES.cancelled,
    );
    expect(SIM_WORKER_PROTOCOL_ERROR_CODES.transportClosed).toBe(
      WORKER_PROTOCOL_ERROR_CODES.transportClosed,
    );
    expect(SIM_WORKER_PROTOCOL_ERROR_CODES.operationFailed).toBe(
      WORKER_PROTOCOL_ERROR_CODES.operationFailed,
    );
    expect(SIM_WORKER_PROTOCOL_ERROR_CODES.malformedPayload).toBe(
      WORKER_PROTOCOL_ERROR_CODES.malformedPayload,
    );
  });
});

describe("the boundaries never misparse each other's traffic", () => {
  it("a kernel endpoint rejects a sim notification structurally, never misreads it", () => {
    const notification = createSimFieldChunkNotification(requestId, {
      id: "pressure",
      extent: [2, 2, 1],
      originMm: [0, 0, 0],
      spacingMm: [1, 1, 1],
      dataType: "float32",
      chunkIndex: 0,
      chunkCount: 1,
      values: [1, 2, 3, 4],
    });
    const parsed = parseWorkerMessage(JSON.parse(JSON.stringify(notification)));
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    // Same version, unknown kind: the notification class is sim-only, so
    // the kernel boundary refuses it by kind, having read nothing else.
    expect(parsed.error.code).toBe(
      WORKER_PROTOCOL_ERROR_CODES.unknownMessageKind,
    );
  });

  it("a sim endpoint rejects a kernel operation structurally, never misreads it", () => {
    const kernelRequest = {
      protocolVersion: SIM_WORKER_PROTOCOL_VERSION,
      kind: "request",
      requestId: "req_000001",
      operation: "solid.createBox",
      input: {},
    };
    const parsed = parseSimWorkerMessage(
      JSON.parse(JSON.stringify(kernelRequest)),
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.kind).toBe("request");
    if (parsed.value.kind !== "request") return;
    // The envelope parses (it IS the same envelope); the operation
    // vocabulary refuses the kernel's group — the decode layer's job.
    const decoded = decodeSimWorkerRequest(parsed.value);
    expect(decoded.ok).toBe(false);
    if (decoded.ok) return;
    expect(decoded.error.code).toBe(
      SIM_WORKER_PROTOCOL_ERROR_CODES.unknownOperation,
    );
  });

  it("a sim request built here parses at the kernel envelope layer (the envelope is shared)", () => {
    const problem = parseSimProblemId("wprob_000001");
    if (!problem.ok) throw new Error("test problem id must parse");
    const request = createSimWorkerRequest(requestId, "sim.run", {
      problem: problem.value,
    });
    const parsed = parseWorkerMessage(JSON.parse(JSON.stringify(request)));
    expect(parsed.ok).toBe(true);
  });
});
