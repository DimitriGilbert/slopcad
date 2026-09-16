/**
 * The worker server (Phase 10.2): a generic adapter hosting the Phase 10.1
 * operation vocabulary against a kernel over the in-memory transport. These
 * tests drive it at the wire level — raw messages in, parsed responses out —
 * pinning the trust boundary (malformed/versioned input), the cancellation
 * ledger routing (refuse, suppress, ignore), duplicate admission, misdirected
 * traffic, structured kernel failures, and the solid-id mapping lifecycle.
 */

import { describe, expect, it } from "vitest";
import { length } from "@slopcad/cad-core";
import type { GeometryKernel } from "./contract";
import type {
  WorkerErrorResponseMessage,
  WorkerSuccessResponseMessage,
} from "./worker-protocol";

import { createFakeKernel } from "./fake-kernel";
import { createWorkerRequestId, createWorkerSolidId } from "./worker-ids";
import {
  createWorkerRequest,
  createWorkerSuccessResponse,
  parseWorkerMessage,
} from "./worker-protocol";
import { createWorkerServer } from "./worker-server";
import { createInMemoryTransportPair } from "./worker-transport";

const mm = (value: number) => length(value, "mm");

const flush = async (ticks = 16): Promise<void> => {
  for (let tick = 0; tick < ticks; tick += 1) await Promise.resolve();
};

const boxWireInput = {
  width: { dimension: "length", unit: "mm", value: 2 },
  depth: { dimension: "length", unit: "mm", value: 3 },
  height: { dimension: "length", unit: "mm", value: 4 },
};

interface ServerHarness {
  /** Everything the server emitted, in order. */
  readonly responses: unknown[];
  readonly send: (data: unknown) => void;
  readonly requestBox: (requestId: string) => void;
  readonly cancel: (requestId: string) => void;
}

function setup(options: { countBoxCalls?: boolean } = {}): ServerHarness & {
  readonly boxCalls: readonly string[];
} {
  const base = createFakeKernel();
  const boxCalls: string[] = [];
  let kernel: GeometryKernel = base;
  if (options.countBoxCalls) {
    kernel = {
      ...base,
      createBox: (input) => {
        boxCalls.push("createBox");
        return base.createBox(input);
      },
    };
  }
  const pair = createInMemoryTransportPair();
  createWorkerServer({ kernel, transport: pair.server });
  const responses: unknown[] = [];
  pair.client.onMessage((data) => responses.push(data));
  return {
    responses,
    boxCalls,
    send: (data) => pair.client.send(data),
    requestBox: (requestId) => {
      pair.client.send({
        protocolVersion: 1,
        kind: "request",
        requestId,
        operation: "solid.createBox",
        input: boxWireInput,
      });
    },
    cancel: (requestId) => {
      pair.client.send({ protocolVersion: 1, kind: "cancel", requestId });
    },
  };
}

function errorResponseAt(
  responses: readonly unknown[],
  index: number,
): WorkerErrorResponseMessage {
  const parsed = parseWorkerMessage(responses[index]);
  if (!parsed.ok || parsed.value.kind !== "response" || parsed.value.status !== "error") {
    throw new Error(`Expected an error response at index ${index}.`);
  }
  return parsed.value;
}

function successResponseAt(
  responses: readonly unknown[],
  index: number,
): WorkerSuccessResponseMessage {
  const parsed = parseWorkerMessage(responses[index]);
  if (!parsed.ok || parsed.value.kind !== "response" || parsed.value.status !== "ok") {
    throw new Error(`Expected a success response at index ${index}.`);
  }
  return parsed.value;
}

describe("server trust boundary", () => {
  it("answers an unsupported protocol version with a null-id structured error", async () => {
    const { responses, send } = setup();
    send({
      protocolVersion: 99,
      kind: "request",
      requestId: "req_000001",
      operation: "solid.createBox",
      input: {},
    });
    await flush();
    expect(responses).toHaveLength(1);
    const response = errorResponseAt(responses, 0);
    expect(response.requestId).toBeNull();
    expect(response.error.code).toBe("worker/unsupported-version");
  });

  it("answers a malformed message with a null-id malformed-message error", async () => {
    const { responses, send } = setup();
    send(42);
    await flush();
    expect(responses).toHaveLength(1);
    const response = errorResponseAt(responses, 0);
    expect(response.requestId).toBeNull();
    expect(response.error.code).toBe("worker/malformed-message");
  });

  it("answers an unknown message kind with its structured code", async () => {
    const { responses, send } = setup();
    send({ protocolVersion: 1, kind: "explode", requestId: "req_000001" });
    await flush();
    expect(responses).toHaveLength(1);
    expect(errorResponseAt(responses, 0).error.code).toBe("worker/unknown-message-kind");
  });

  it("answers an unknown operation with the request's id", async () => {
    const { responses, send } = setup();
    send({
      protocolVersion: 1,
      kind: "request",
      requestId: "req_000001",
      operation: "solid.explode",
      input: {},
    });
    await flush();
    const response = errorResponseAt(responses, 0);
    expect(response.requestId).toBe("req_000001");
    expect(response.error.code).toBe("worker/unknown-operation");
  });

  it("answers a malformed payload with the request's id", async () => {
    const { responses, send } = setup();
    send({
      protocolVersion: 1,
      kind: "request",
      requestId: "req_000001",
      operation: "solid.createBox",
      input: { width: "not-a-length" },
    });
    await flush();
    const response = errorResponseAt(responses, 0);
    expect(response.requestId).toBe("req_000001");
    expect(response.error.code).toBe("worker/malformed-payload");
  });

  it("drops a response arriving in the responder role", async () => {
    const { responses, send } = setup();
    send(
      createWorkerSuccessResponse(createWorkerRequestId("req_000001"), "solid.createBox", {
        solid: createWorkerSolidId("wsol_000001"),
      }),
    );
    await flush();
    expect(responses).toHaveLength(0);
  });
});

describe("server admission through the cancellation ledger", () => {
  it("refuses a duplicate request id with worker/duplicate-request", async () => {
    const { responses, requestBox, boxCalls } = setup({ countBoxCalls: true });
    requestBox("req_000001");
    await flush();
    requestBox("req_000001");
    await flush();

    expect(successResponseAt(responses, 0).status).toBe("ok");
    const duplicate = errorResponseAt(responses, 1);
    expect(duplicate.requestId).toBe("req_000001");
    expect(duplicate.error.code).toBe("worker/duplicate-request");
    expect(boxCalls).toEqual(["createBox"]);
  });

  it("refuses a request cancelled before it arrived, executing nothing", async () => {
    const { responses, requestBox, cancel, boxCalls } = setup({ countBoxCalls: true });
    cancel("req_000001");
    requestBox("req_000001");
    await flush();

    expect(responses).toHaveLength(1);
    const response = errorResponseAt(responses, 0);
    expect(response.requestId).toBe("req_000001");
    expect(response.error.code).toBe("worker/cancelled");
    expect(boxCalls).toEqual([]);
  });

  it("suppresses the outcome of a request cancelled while running", async () => {
    const { responses, requestBox, cancel, boxCalls } = setup({ countBoxCalls: true });
    requestBox("req_000001");
    cancel("req_000001");
    await flush();

    expect(responses).toHaveLength(1);
    const response = errorResponseAt(responses, 0);
    expect(response.requestId).toBe("req_000001");
    expect(response.error.code).toBe("worker/cancelled");
    expect(boxCalls).toEqual(["createBox"]); // best-effort: computed, then voided
  });

  it("ignores a cancel for a request that already finished", async () => {
    const { responses, requestBox, cancel } = setup();
    requestBox("req_000001");
    await flush();
    expect(responses).toHaveLength(1);
    expect(successResponseAt(responses, 0).status).toBe("ok");

    cancel("req_000001");
    await flush();
    expect(responses).toHaveLength(1); // an emitted response cannot be unsent
  });

  it("ignores everything after close", async () => {
    const pair = createInMemoryTransportPair();
    const server = createWorkerServer({
      kernel: createFakeKernel(),
      transport: pair.server,
    });
    const responses: unknown[] = [];
    pair.client.onMessage((data) => responses.push(data));
    server.close();
    pair.client.send(
      createWorkerRequest(createWorkerRequestId("req_000001"), "solid.createBox", {
        width: mm(2),
        depth: mm(3),
        height: mm(4),
      }),
    );
    await flush();
    expect(responses).toHaveLength(0);
  });
});

describe("server kernel failures as structured responses", () => {
  it("rides a kernel rejection as worker/operation-failed with the kernel code", async () => {
    const { responses, send } = setup();
    send({
      protocolVersion: 1,
      kind: "request",
      requestId: "req_000001",
      operation: "solid.createBox",
      input: {
        width: { dimension: "length", unit: "mm", value: -1 },
        depth: { dimension: "length", unit: "mm", value: 3 },
        height: { dimension: "length", unit: "mm", value: 4 },
      },
    });
    await flush();

    const response = errorResponseAt(responses, 0);
    expect(response.error.code).toBe("worker/operation-failed");
    expect(response.error.data).toEqual({ kernelCode: "kernel/invalid-length" });
  });

  it("answers a solid the session does not own with the solid-not-owned equivalent", async () => {
    const { responses, send } = setup();
    send({
      protocolVersion: 1,
      kind: "request",
      requestId: "req_000001",
      operation: "solid.volume",
      input: { solid: "wsol_099999" },
    });
    await flush();

    const response = errorResponseAt(responses, 0);
    expect(response.error.code).toBe("worker/operation-failed");
    expect(response.error.data).toEqual({ kernelCode: "kernel/solid-not-owned" });
  });

  it("converts a kernel that breaks the contract and throws", async () => {
    const throwing: GeometryKernel = {
      ...createFakeKernel(),
      createBox: () => {
        throw new Error("kernel exploded");
      },
    };
    const pair = createInMemoryTransportPair();
    createWorkerServer({ kernel: throwing, transport: pair.server });
    const responses: unknown[] = [];
    pair.client.onMessage((data) => responses.push(data));
    pair.client.send(
      createWorkerRequest(createWorkerRequestId("req_000001"), "solid.createBox", {
        width: mm(2),
        depth: mm(3),
        height: mm(4),
      }),
    );
    await flush();

    const response = errorResponseAt(responses, 0);
    expect(response.error.code).toBe("worker/operation-failed");
    expect(response.error.data).toEqual({ thrown: true });
    expect(response.error.message).toContain("kernel exploded");
  });
});

describe("server solid-id mapping", () => {
  it("mints ids in delivery order and releases them on dispose", async () => {
    const { responses, send } = setup();
    send({
      protocolVersion: 1,
      kind: "request",
      requestId: "req_000001",
      operation: "solid.createBox",
      input: boxWireInput,
    });
    await flush();
    expect(successResponseAt(responses, 0).result).toEqual({ solid: "wsol_000001" });

    send({
      protocolVersion: 1,
      kind: "request",
      requestId: "req_000002",
      operation: "solid.dispose",
      input: { solid: "wsol_000001" },
    });
    await flush();
    expect(successResponseAt(responses, 1).result).toBeNull();

    send({
      protocolVersion: 1,
      kind: "request",
      requestId: "req_000003",
      operation: "solid.volume",
      input: { solid: "wsol_000001" },
    });
    await flush();
    expect(errorResponseAt(responses, 2).error.data).toEqual({
      kernelCode: "kernel/solid-not-owned",
    });
  });

  it("consumes no solid id for an outcome suppressed by cancellation", async () => {
    const { responses, requestBox, cancel } = setup();
    requestBox("req_000001");
    cancel("req_000001");
    await flush();
    requestBox("req_000002");
    await flush();

    expect(errorResponseAt(responses, 0).error.code).toBe("worker/cancelled");
    expect(successResponseAt(responses, 1).result).toEqual({ solid: "wsol_000001" });
  });
});
