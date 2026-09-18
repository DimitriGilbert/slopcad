/**
 * The worker server (Phase 10.2): a generic adapter hosting the Phase 10.1
 * operation vocabulary against a kernel over the in-memory transport. These
 * tests drive it at the wire level — raw messages in, parsed responses out —
 * pinning the trust boundary (malformed/versioned input), the cancellation
 * ledger routing (refuse, suppress, ignore), duplicate admission, misdirected
 * traffic, structured kernel failures, the solid-id mapping lifecycle, and
 * the Phase 26.5 vocabulary additions: the `solid.fillet` dispatch and the
 * `solid.topology` extension's hosted/unsupported/cancelled routing, plus
 * the Phase 26.6 `solid.chamfer` dispatch.
 */

import { describe, expect, it } from "vitest";
import {
  createBodyId,
  length,
  type BodyId,
  type ParseResult,
  type TopologySnapshot,
} from "@slopcad/cad-core";
import type {
  WorkerErrorResponseMessage,
  WorkerSuccessResponseMessage,
} from "./worker-protocol";
import type { GeometryKernel, KernelSolid } from "./contract";

import { KERNEL_ERROR_CODES } from "./contract";
import { createFakeKernel } from "./fake-kernel";
import { createWorkerRequestId, createWorkerSolidId } from "./worker-ids";
import {
  parseWorkerOperationResult,
  BREP_EXPORT_UNSUPPORTED_CODE,
  BREP_IMPORT_UNSUPPORTED_CODE,
  STEP_EXPORT_UNSUPPORTED_CODE,
  STEP_IMPORT_UNSUPPORTED_CODE,
  TOPOLOGY_UNSUPPORTED_CODE,
  type WorkerStepExportSettings,
} from "./worker-operations";
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
} as const;

const mmWire = (value: number) =>
  ({
    dimension: "length",
    unit: "mm",
    value,
  }) as const;

/**
 * A minimal valid topology snapshot the wired extension reports verbatim,
 * echoing the request's labeling context (the same wire-valid shape the
 * operation codec's own tests pin).
 */
function testTopologySnapshot(
  bodyId: BodyId,
  regeneration: number,
): TopologySnapshot {
  return {
    kernelId: "test-kernel",
    persistentTopology: true,
    identitySchemas: ["test-identity-v1"],
    bodyId,
    regeneration,
    entities: [
      {
        kind: "edge",
        ordinal: 5,
        identity: {
          kernelId: "test-kernel",
          schema: "test-identity-v1",
          data: { hash: 123456789 },
        },
        geometry: {
          lengthMm: 4,
          centroidAbsoluteMm: [1, 1.5, 2],
          centroidRelativeMm: [1, 1.5, 0],
        },
      },
      {
        kind: "vertex",
        ordinal: 0,
        identity: null,
        geometry: {
          pointAbsoluteMm: [0, 0, 0],
          pointRelativeMm: [-1, -1.5, -2],
        },
      },
    ],
  };
}

interface ServerHarness {
  /** Everything the server emitted, in order. */
  readonly responses: unknown[];
  readonly send: (data: unknown) => void;
  readonly requestBox: (requestId: string) => void;
  readonly cancel: (requestId: string) => void;
}

function setup(
  options: {
    countBoxCalls?: boolean;
    /** Wires a `step.import` extension: the given codes map to failures. */
    stepImport?: (code: string) => boolean;
    /**
     * Wires a `step.export` extension: receives the resolved settings and
     * returns the bytes to export, or `null` to fail with a test code.
     */
    stepExport?: (settings: {
      readonly unit?: string;
      readonly schema?: string;
    }) => Uint8Array | null;
    /** Wires a `brep.import` extension: the given codes map to failures. */
    brepImport?: (code: string) => boolean;
    /**
     * Wires a `brep.export` extension: returns the bytes to export, or
     * `null` to fail with a test code.
     */
    brepExport?: () => Uint8Array | null;
    /**
     * Wires a `solid.topology` extension: returning `true` reports the
     * test snapshot (echoing the labeling context), `false` fails with a
     * test code.
     */
    topology?: (context: {
      readonly bodyId: string;
      readonly regeneration: number;
    }) => boolean;
  } = {},
): ServerHarness & {
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
  const stepImport =
    options.stepImport === undefined
      ? undefined
      : (bytes: Uint8Array) => {
          if (
            options.stepImport !== undefined &&
            options.stepImport(new TextDecoder().decode(bytes))
          ) {
            const created = base.createBox(boxWireInput);
            if (!created.ok) {
              throw new Error("The harness box creation must succeed.");
            }
            return { ok: true as const, value: [created.value] };
          }
          return {
            ok: false as const,
            error: {
              code: "step-import/test",
              message: "test rejection",
              input: bytes,
            },
          };
        };
  const stepExport =
    options.stepExport === undefined
      ? undefined
      : (
          solids: readonly KernelSolid[],
          settings: WorkerStepExportSettings,
        ): ParseResult<Uint8Array> => {
          const bytes = options.stepExport?.(settings);
          if (bytes !== undefined && bytes !== null) {
            return { ok: true as const, value: bytes };
          }
          return {
            ok: false as const,
            error: {
              code: "step-export/test",
              message: "test rejection",
              input: solids.length,
            },
          };
        };
  const brepImport =
    options.brepImport === undefined
      ? undefined
      : (bytes: Uint8Array) => {
          if (
            options.brepImport !== undefined &&
            options.brepImport(new TextDecoder().decode(bytes))
          ) {
            const created = base.createBox(boxWireInput);
            if (!created.ok) {
              throw new Error("The harness box creation must succeed.");
            }
            return { ok: true as const, value: [created.value] };
          }
          return {
            ok: false as const,
            error: {
              code: "brep-import/test",
              message: "test rejection",
              input: bytes,
            },
          };
        };
  const brepExport =
    options.brepExport === undefined
      ? undefined
      : (solids: readonly KernelSolid[]): ParseResult<Uint8Array> => {
          const bytes = options.brepExport?.();
          if (bytes !== undefined && bytes !== null) {
            return { ok: true as const, value: bytes };
          }
          return {
            ok: false as const,
            error: {
              code: "brep-export/test",
              message: "test rejection",
              input: solids.length,
            },
          };
        };
  const topology =
    options.topology === undefined
      ? undefined
      : (
          solid: KernelSolid,
          context: { readonly bodyId: BodyId; readonly regeneration: number },
        ): ParseResult<TopologySnapshot> => {
          if (
            options.topology?.({
              bodyId: context.bodyId,
              regeneration: context.regeneration,
            })
          ) {
            return {
              ok: true as const,
              value: testTopologySnapshot(context.bodyId, context.regeneration),
            };
          }
          return {
            ok: false as const,
            error: {
              code: "topology/test",
              message: "test rejection",
              input: solid,
            },
          };
        };
  createWorkerServer({
    kernel,
    transport: pair.server,
    stepImport,
    stepExport,
    brepImport,
    brepExport,
    topology,
  });
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
  if (
    !parsed.ok ||
    parsed.value.kind !== "response" ||
    parsed.value.status !== "error"
  ) {
    throw new Error(`Expected an error response at index ${index}.`);
  }
  return parsed.value;
}

function successResponseAt(
  responses: readonly unknown[],
  index: number,
): WorkerSuccessResponseMessage {
  const parsed = parseWorkerMessage(responses[index]);
  if (
    !parsed.ok ||
    parsed.value.kind !== "response" ||
    parsed.value.status !== "ok"
  ) {
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
    expect(errorResponseAt(responses, 0).error.code).toBe(
      "worker/unknown-message-kind",
    );
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
      createWorkerSuccessResponse(
        createWorkerRequestId("req_000001"),
        "solid.createBox",
        {
          solid: createWorkerSolidId("wsol_000001"),
        },
      ),
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
    const { responses, requestBox, cancel, boxCalls } = setup({
      countBoxCalls: true,
    });
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
    const { responses, requestBox, cancel, boxCalls } = setup({
      countBoxCalls: true,
    });
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
      createWorkerRequest(
        createWorkerRequestId("req_000001"),
        "solid.createBox",
        {
          width: mm(2),
          depth: mm(3),
          height: mm(4),
        },
      ),
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
    expect(response.error.data).toEqual({
      kernelCode: "kernel/invalid-length",
    });
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
    expect(response.error.data).toEqual({
      kernelCode: "kernel/solid-not-owned",
    });
  });

  it("hands the transform's rotation through to the kernel (Phase 21.2 wire extension)", async () => {
    // The fake kernel rejects a rotation outright, so the invalid-rotation
    // code over the wire is direct evidence the field survived decode and
    // reached the kernel call — the pass-through a rotation-capable kernel
    // (OpenCascade) relies on. A translation-only transform keeps working
    // unchanged beside it.
    const { responses, send } = setup();
    send({
      protocolVersion: 1,
      kind: "request",
      requestId: "req_000001",
      operation: "solid.createBox",
      input: boxWireInput,
    });
    await flush();
    const created = successResponseAt(responses, 0);
    const solidId = parseWorkerOperationResult(
      "solid.createBox",
      created.result,
    );
    if (!solidId.ok) throw new Error("Expected a minted solid id.");
    const wsol = solidId.value.solid;

    send({
      protocolVersion: 1,
      kind: "request",
      requestId: "req_000002",
      operation: "solid.transform",
      input: {
        solid: wsol,
        translation: {
          x: { dimension: "length", unit: "mm", value: 1 },
          y: { dimension: "length", unit: "mm", value: 0 },
          z: { dimension: "length", unit: "mm", value: 0 },
        },
        rotation: {
          axis: [0, 0, 1],
          angle: { dimension: "angle", unit: "deg", value: 90 },
        },
      },
    });
    await flush();

    const response = errorResponseAt(responses, 1);
    expect(response.requestId).toBe("req_000002");
    expect(response.error.code).toBe("worker/operation-failed");
    expect(response.error.data).toEqual({
      kernelCode: "kernel/invalid-rotation",
    });

    // The pre-extension shape still translates: no rotation field at all.
    send({
      protocolVersion: 1,
      kind: "request",
      requestId: "req_000003",
      operation: "solid.transform",
      input: {
        solid: wsol,
        translation: {
          x: { dimension: "length", unit: "mm", value: 1 },
          y: { dimension: "length", unit: "mm", value: 0 },
          z: { dimension: "length", unit: "mm", value: 0 },
        },
      },
    });
    await flush();
    const translated = successResponseAt(responses, 2);
    expect(translated.requestId).toBe("req_000003");
    const minted = parseWorkerOperationResult(
      "solid.transform",
      translated.result,
    );
    if (!minted.ok)
      throw new Error("Expected the translation to mint a solid.");
    expect(typeof minted.value.solid).toBe("string");
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
      createWorkerRequest(
        createWorkerRequestId("req_000001"),
        "solid.createBox",
        {
          width: mm(2),
          depth: mm(3),
          height: mm(4),
        },
      ),
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
    expect(successResponseAt(responses, 0).result).toEqual({
      solid: "wsol_000001",
    });

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
    expect(successResponseAt(responses, 1).result).toEqual({
      solid: "wsol_000001",
    });
  });
});

describe("the step.import extension (Phase 21.3)", () => {
  const stepInput = { data: "SSBXLUhPTEU=" };

  it("answers step.import through the extension and mints one id per solid", async () => {
    const { responses, send } = setup({ stepImport: () => true });
    send({
      protocolVersion: 1,
      kind: "request",
      requestId: "req_000001",
      operation: "step.import",
      input: stepInput,
    });
    await flush();

    const response = successResponseAt(responses, 0);
    // One provenance-marked ref per imported solid, minted in file order —
    // the data-level distinction between imported geometry and the
    // feature-built solids of every other solid-producing operation.
    expect(response.result).toEqual({
      solids: [{ solid: "wsol_000001", origin: "imported-step" }],
    });

    // The minted id addresses an ordinary session solid.
    const minted = createWorkerSolidId("wsol_000001");
    send({
      protocolVersion: 1,
      kind: "request",
      requestId: "req_000002",
      operation: "solid.bounds",
      input: { solid: minted },
    });
    await flush();
    expect(successResponseAt(responses, 1).status).toBe("ok");
  });

  it("answers step.import with step-import/unsupported when no extension is hosted", async () => {
    const { responses, send } = setup();
    send({
      protocolVersion: 1,
      kind: "request",
      requestId: "req_000001",
      operation: "step.import",
      input: stepInput,
    });
    await flush();

    const response = errorResponseAt(responses, 0);
    expect(response.requestId).toBe("req_000001");
    expect(response.error.code).toBe("worker/operation-failed");
    expect(response.error.data).toEqual({
      kernelCode: STEP_IMPORT_UNSUPPORTED_CODE,
    });
  });

  it("carries the extension's structured step-import failure in the error data", async () => {
    const { responses, send } = setup({ stepImport: () => false });
    send({
      protocolVersion: 1,
      kind: "request",
      requestId: "req_000001",
      operation: "step.import",
      input: stepInput,
    });
    await flush();

    const response = errorResponseAt(responses, 0);
    expect(response.error.code).toBe("worker/operation-failed");
    expect(response.error.data).toEqual({ kernelCode: "step-import/test" });
    // A failed import mints nothing: the next solid-producing outcome gets
    // the first id of the session.
    send({
      protocolVersion: 1,
      kind: "request",
      requestId: "req_000002",
      operation: "solid.createBox",
      input: boxWireInput,
    });
    await flush();
    expect(successResponseAt(responses, 1).result).toEqual({
      solid: "wsol_000001",
    });
  });

  it("releases every imported solid when the request is cancelled mid-flight", async () => {
    const { responses, send, cancel, requestBox } = setup({
      stepImport: () => true,
    });
    send({
      protocolVersion: 1,
      kind: "request",
      requestId: "req_000001",
      operation: "step.import",
      input: stepInput,
    });
    cancel("req_000001");
    await flush();
    expect(errorResponseAt(responses, 0).error.code).toBe("worker/cancelled");

    // No id was consumed by the suppressed import: the next mint is the
    // session's first — and the suppressed solids were released, so the
    // channel stays healthy.
    requestBox("req_000002");
    await flush();
    expect(successResponseAt(responses, 1).result).toEqual({
      solid: "wsol_000001",
    });
  });
});

describe("the step.export extension (Phase 21.4)", () => {
  const exportBytes = new Uint8Array([0x49, 0x53, 0x4f]);

  /** Mints the session's first solid, then addresses it for step.export. */
  async function mintedSolidRef(
    harness: ReturnType<typeof setup>,
    requestId: string,
  ): Promise<void> {
    harness.requestBox(requestId);
    await flush();
  }

  it("answers step.export through the extension with the bytes and no minted ids", async () => {
    const seen: { unit?: string; schema?: string }[] = [];
    const harness = setup({
      stepExport: (settings) => {
        seen.push(settings);
        return exportBytes;
      },
    });
    await mintedSolidRef(harness, "req_000001");
    harness.send({
      protocolVersion: 1,
      kind: "request",
      requestId: "req_000002",
      operation: "step.export",
      input: { solids: ["wsol_000001"], unit: "INCH", schema: "AP203" },
    });
    await flush();

    // The extension received the resolved settings verbatim.
    expect(seen).toEqual([{ unit: "INCH", schema: "AP203" }]);
    const response = successResponseAt(harness.responses, 1);
    const parsed = parseWorkerOperationResult("step.export", response.result);
    expect(parsed).toEqual({ ok: true, value: { data: exportBytes } });
    // The result mints no solid: the next mint is still the session's second.
    harness.requestBox("req_000003");
    await flush();
    expect(successResponseAt(harness.responses, 2).result).toEqual({
      solid: "wsol_000002",
    });
  });

  it("answers step.export with step-export/unsupported when no extension is hosted", async () => {
    const harness = setup();
    await mintedSolidRef(harness, "req_000001");
    harness.send({
      protocolVersion: 1,
      kind: "request",
      requestId: "req_000002",
      operation: "step.export",
      input: { solids: ["wsol_000001"] },
    });
    await flush();

    const response = errorResponseAt(harness.responses, 1);
    expect(response.requestId).toBe("req_000002");
    expect(response.error.code).toBe("worker/operation-failed");
    expect(response.error.data).toEqual({
      kernelCode: STEP_EXPORT_UNSUPPORTED_CODE,
    });
  });

  it("fails step.export with the session's solid-not-owned for unknown ids, before the extension runs", async () => {
    let extensionRan = false;
    const harness = setup({
      stepExport: () => {
        extensionRan = true;
        return exportBytes;
      },
    });
    harness.send({
      protocolVersion: 1,
      kind: "request",
      requestId: "req_000001",
      operation: "step.export",
      input: { solids: ["wsol_000404"] },
    });
    await flush();

    const response = errorResponseAt(harness.responses, 0);
    expect(response.error.code).toBe("worker/operation-failed");
    expect(response.error.data).toEqual({
      kernelCode: KERNEL_ERROR_CODES.solidNotOwned,
    });
    expect(extensionRan).toBe(false);
  });

  it("carries the extension's structured step-export failure in the error data", async () => {
    const harness = setup({ stepExport: () => null });
    await mintedSolidRef(harness, "req_000001");
    harness.send({
      protocolVersion: 1,
      kind: "request",
      requestId: "req_000002",
      operation: "step.export",
      input: { solids: ["wsol_000001"] },
    });
    await flush();

    const response = errorResponseAt(harness.responses, 1);
    expect(response.error.code).toBe("worker/operation-failed");
    expect(response.error.data).toEqual({ kernelCode: "step-export/test" });
  });
});

describe("the brep.import extension (Phase 21.5)", () => {
  const brepInput = { data: "Q0FTQ0FERSBUb3BvbG9neSBWMw==" };

  it("answers brep.import through the extension and mints one id per solid with the brep provenance", async () => {
    const { responses, send } = setup({ brepImport: () => true });
    send({
      protocolVersion: 1,
      kind: "request",
      requestId: "req_000001",
      operation: "brep.import",
      input: brepInput,
    });
    await flush();

    const response = successResponseAt(responses, 0);
    expect(response.result).toEqual({
      solids: [{ solid: "wsol_000001", origin: "imported-brep" }],
    });

    // The minted id addresses an ordinary session solid.
    send({
      protocolVersion: 1,
      kind: "request",
      requestId: "req_000002",
      operation: "solid.bounds",
      input: { solid: createWorkerSolidId("wsol_000001") },
    });
    await flush();
    expect(successResponseAt(responses, 1).status).toBe("ok");
  });

  it("answers brep.import with brep-import/unsupported when no extension is hosted", async () => {
    const { responses, send } = setup();
    send({
      protocolVersion: 1,
      kind: "request",
      requestId: "req_000001",
      operation: "brep.import",
      input: brepInput,
    });
    await flush();

    const response = errorResponseAt(responses, 0);
    expect(response.requestId).toBe("req_000001");
    expect(response.error.code).toBe("worker/operation-failed");
    expect(response.error.data).toEqual({
      kernelCode: BREP_IMPORT_UNSUPPORTED_CODE,
    });
  });

  it("carries the extension's structured brep-import failure in the error data", async () => {
    const { responses, send } = setup({ brepImport: () => false });
    send({
      protocolVersion: 1,
      kind: "request",
      requestId: "req_000001",
      operation: "brep.import",
      input: brepInput,
    });
    await flush();

    const response = errorResponseAt(responses, 0);
    expect(response.error.code).toBe("worker/operation-failed");
    expect(response.error.data).toEqual({ kernelCode: "brep-import/test" });
    // A failed import mints nothing: the next solid-producing outcome gets
    // the first id of the session.
    send({
      protocolVersion: 1,
      kind: "request",
      requestId: "req_000002",
      operation: "solid.createBox",
      input: boxWireInput,
    });
    await flush();
    expect(successResponseAt(responses, 1).result).toEqual({
      solid: "wsol_000001",
    });
  });

  it("releases every imported solid when the request is cancelled mid-flight", async () => {
    const { responses, send, cancel, requestBox } = setup({
      brepImport: () => true,
    });
    send({
      protocolVersion: 1,
      kind: "request",
      requestId: "req_000001",
      operation: "brep.import",
      input: brepInput,
    });
    cancel("req_000001");
    await flush();
    expect(errorResponseAt(responses, 0).error.code).toBe("worker/cancelled");

    requestBox("req_000002");
    await flush();
    expect(successResponseAt(responses, 1).result).toEqual({
      solid: "wsol_000001",
    });
  });
});

describe("the brep.export extension (Phase 21.5)", () => {
  const exportBytes = new Uint8Array([0x0a, 0x43, 0x41, 0x53, 0x43]);

  it("answers brep.export through the extension with the bytes and no minted ids", async () => {
    const harness = setup({ brepExport: () => exportBytes });
    harness.requestBox("req_000001");
    await flush();
    harness.send({
      protocolVersion: 1,
      kind: "request",
      requestId: "req_000002",
      operation: "brep.export",
      input: { solids: ["wsol_000001"] },
    });
    await flush();

    const response = successResponseAt(harness.responses, 1);
    const parsed = parseWorkerOperationResult("brep.export", response.result);
    expect(parsed).toEqual({ ok: true, value: { data: exportBytes } });
    // The result mints no solid: the next mint is still the session's second.
    harness.requestBox("req_000003");
    await flush();
    expect(successResponseAt(harness.responses, 2).result).toEqual({
      solid: "wsol_000002",
    });
  });

  it("answers brep.export with brep-export/unsupported when no extension is hosted", async () => {
    const harness = setup();
    harness.requestBox("req_000001");
    await flush();
    harness.send({
      protocolVersion: 1,
      kind: "request",
      requestId: "req_000002",
      operation: "brep.export",
      input: { solids: ["wsol_000001"] },
    });
    await flush();

    const response = errorResponseAt(harness.responses, 1);
    expect(response.requestId).toBe("req_000002");
    expect(response.error.code).toBe("worker/operation-failed");
    expect(response.error.data).toEqual({
      kernelCode: BREP_EXPORT_UNSUPPORTED_CODE,
    });
  });

  it("fails brep.export with the session's solid-not-owned for unknown ids, before the extension runs", async () => {
    let extensionRan = false;
    const harness = setup({
      brepExport: () => {
        extensionRan = true;
        return exportBytes;
      },
    });
    harness.send({
      protocolVersion: 1,
      kind: "request",
      requestId: "req_000001",
      operation: "brep.export",
      input: { solids: ["wsol_000404"] },
    });
    await flush();

    const response = errorResponseAt(harness.responses, 0);
    expect(response.error.code).toBe("worker/operation-failed");
    expect(response.error.data).toEqual({
      kernelCode: KERNEL_ERROR_CODES.solidNotOwned,
    });
    expect(extensionRan).toBe(false);
  });

  it("carries the extension's structured brep-export failure in the error data", async () => {
    const harness = setup({ brepExport: () => null });
    harness.requestBox("req_000001");
    await flush();
    harness.send({
      protocolVersion: 1,
      kind: "request",
      requestId: "req_000002",
      operation: "brep.export",
      input: { solids: ["wsol_000001"] },
    });
    await flush();

    const response = errorResponseAt(harness.responses, 1);
    expect(response.error.code).toBe("worker/operation-failed");
    expect(response.error.data).toEqual({ kernelCode: "brep-export/test" });
  });
});

describe("the solid.fillet operation (Phase 26.5)", () => {
  /** Sends a fillet request against a session solid, at the wire level. */
  function requestFillet(
    harness: ReturnType<typeof setup>,
    requestId: string,
    target: string,
    edges: readonly number[],
    radiusMm: number,
  ): void {
    harness.send({
      protocolVersion: 1,
      kind: "request",
      requestId,
      operation: "solid.fillet",
      input: { target, edges, radius: mmWire(radiusMm) },
    });
  }

  it("answers solid.fillet through the kernel and mints the filleted solid", async () => {
    const harness = setup();
    harness.requestBox("req_000001");
    await flush();
    // Ordinal 8 is a vertical edge of the fake kernel's box-edge table —
    // the snapshot-ordinal addressing a real fillet feature resolves to.
    requestFillet(harness, "req_000002", "wsol_000001", [8], 0.5);
    await flush();

    const response = successResponseAt(harness.responses, 1);
    expect(response.requestId).toBe("req_000002");
    expect(response.result).toEqual({ solid: "wsol_000002" });

    // The minted fillet is an ordinary session solid whose volume is the
    // analytic corner-fillet model's: the box minus one removed quadrant.
    harness.send({
      protocolVersion: 1,
      kind: "request",
      requestId: "req_000003",
      operation: "solid.volume",
      input: { solid: "wsol_000002" },
    });
    await flush();
    const volume = parseWorkerOperationResult(
      "solid.volume",
      successResponseAt(harness.responses, 2).result,
    );
    expect(volume.ok).toBe(true);
    if (!volume.ok) return;
    expect(volume.value.volume).toBeCloseTo(
      2 * 3 * 4 - 0.25 * (1 - Math.PI / 4) * 4,
      9,
    );
  });

  it("declines a target outside the kernel's fillet domain with the kernel's own unsupported code", async () => {
    const harness = setup();
    harness.send({
      protocolVersion: 1,
      kind: "request",
      requestId: "req_000001",
      operation: "solid.createSphere",
      input: { radius: mmWire(2) },
    });
    await flush();
    // The fake kernel's honest fillet domain is a pristine box leaf: a
    // sphere target declines with kernel/unsupported-operation — the same
    // structured code a fillet-less engine (Manifold, JSCAD) answers with.
    requestFillet(harness, "req_000002", "wsol_000001", [8], 0.5);
    await flush();

    const response = errorResponseAt(harness.responses, 1);
    expect(response.requestId).toBe("req_000002");
    expect(response.error.code).toBe("worker/operation-failed");
    expect(response.error.data).toEqual({
      kernelCode: KERNEL_ERROR_CODES.unsupportedOperation,
    });
  });

  it("carries the stale-ordinal structured failure in the error data and mints nothing", async () => {
    const harness = setup();
    harness.requestBox("req_000001");
    await flush();
    requestFillet(harness, "req_000002", "wsol_000001", [999], 0.5);
    await flush();

    const response = errorResponseAt(harness.responses, 1);
    expect(response.error.code).toBe("worker/operation-failed");
    expect(response.error.data).toEqual({
      kernelCode: KERNEL_ERROR_CODES.filletEdgeUnknown,
    });
    // A failed fillet mints no id: the next solid-producing outcome gets
    // the session's second id.
    harness.requestBox("req_000003");
    await flush();
    expect(successResponseAt(harness.responses, 2).result).toEqual({
      solid: "wsol_000002",
    });
  });

  it("fails solid.fillet with the session's solid-not-owned for an unknown target", async () => {
    const harness = setup();
    harness.requestBox("req_000001");
    await flush();
    requestFillet(harness, "req_000002", "wsol_099999", [8], 0.5);
    await flush();

    const response = errorResponseAt(harness.responses, 1);
    expect(response.error.code).toBe("worker/operation-failed");
    expect(response.error.data).toEqual({
      kernelCode: KERNEL_ERROR_CODES.solidNotOwned,
    });
  });

  it("suppresses a cancelled fillet: the outcome is void and mints no id", async () => {
    const harness = setup();
    harness.requestBox("req_000001");
    await flush();
    requestFillet(harness, "req_000002", "wsol_000001", [8], 0.5);
    harness.cancel("req_000002");
    await flush();
    expect(errorResponseAt(harness.responses, 1).error.code).toBe(
      "worker/cancelled",
    );

    // The suppressed fillet consumed no id: the next mint is the
    // session's second, and the channel stays healthy.
    harness.requestBox("req_000003");
    await flush();
    expect(successResponseAt(harness.responses, 2).result).toEqual({
      solid: "wsol_000002",
    });
  });
});

describe("the solid.chamfer operation (Phase 26.6)", () => {
  /** Sends a chamfer request against a session solid, at the wire level. */
  function requestChamfer(
    harness: ReturnType<typeof setup>,
    requestId: string,
    target: string,
    edges: readonly number[],
    distanceMm: number,
  ): void {
    harness.send({
      protocolVersion: 1,
      kind: "request",
      requestId,
      operation: "solid.chamfer",
      input: { target, edges, distance: mmWire(distanceMm) },
    });
  }

  it("answers solid.chamfer through the kernel and mints the beveled solid", async () => {
    const harness = setup();
    harness.requestBox("req_000001");
    await flush();
    // Ordinal 8 is a vertical edge of the fake kernel's box-edge table —
    // the snapshot-ordinal addressing a real chamfer feature resolves to.
    requestChamfer(harness, "req_000002", "wsol_000001", [8], 0.5);
    await flush();

    const response = successResponseAt(harness.responses, 1);
    expect(response.requestId).toBe("req_000002");
    expect(response.result).toEqual({ solid: "wsol_000002" });

    // The minted chamfer is an ordinary session solid whose volume is the
    // analytic corner-prism model's: the box minus one d²/2 wedge.
    harness.send({
      protocolVersion: 1,
      kind: "request",
      requestId: "req_000003",
      operation: "solid.volume",
      input: { solid: "wsol_000002" },
    });
    await flush();
    const volume = parseWorkerOperationResult(
      "solid.volume",
      successResponseAt(harness.responses, 2).result,
    );
    expect(volume.ok).toBe(true);
    if (!volume.ok) return;
    expect(volume.value.volume).toBeCloseTo(2 * 3 * 4 - (0.25 / 2) * 4, 9);
  });

  it("declines a target outside the kernel's chamfer domain with the kernel's own unsupported code", async () => {
    const harness = setup();
    harness.send({
      protocolVersion: 1,
      kind: "request",
      requestId: "req_000001",
      operation: "solid.createSphere",
      input: { radius: mmWire(2) },
    });
    await flush();
    // The fake kernel's honest chamfer domain is a pristine box leaf: a
    // sphere target declines with kernel/unsupported-operation — the same
    // structured code a chamfer-less engine (Manifold, JSCAD) answers with.
    requestChamfer(harness, "req_000002", "wsol_000001", [8], 0.5);
    await flush();

    const response = errorResponseAt(harness.responses, 1);
    expect(response.requestId).toBe("req_000002");
    expect(response.error.code).toBe("worker/operation-failed");
    expect(response.error.data).toEqual({
      kernelCode: KERNEL_ERROR_CODES.unsupportedOperation,
    });
  });

  it("carries the stale-ordinal structured failure in the error data and mints nothing", async () => {
    const harness = setup();
    harness.requestBox("req_000001");
    await flush();
    requestChamfer(harness, "req_000002", "wsol_000001", [999], 0.5);
    await flush();

    const response = errorResponseAt(harness.responses, 1);
    expect(response.error.code).toBe("worker/operation-failed");
    expect(response.error.data).toEqual({
      kernelCode: KERNEL_ERROR_CODES.chamferEdgeUnknown,
    });
    // A failed chamfer mints no id: the next solid-producing outcome gets
    // the session's second id.
    harness.requestBox("req_000003");
    await flush();
    expect(successResponseAt(harness.responses, 2).result).toEqual({
      solid: "wsol_000002",
    });
  });
});

describe("the solid.shell operation (Phase 26.7)", () => {
  /** Sends a shell request against a session solid, at the wire level. */
  function requestShell(
    harness: ReturnType<typeof setup>,
    requestId: string,
    target: string,
    faces: readonly number[],
    thicknessMm: number,
  ): void {
    harness.send({
      protocolVersion: 1,
      kind: "request",
      requestId,
      operation: "solid.shell",
      input: { target, faces, thickness: mmWire(thicknessMm) },
    });
  }

  it("answers solid.shell through the kernel and mints the hollowed solid", async () => {
    const harness = setup();
    harness.requestBox("req_000001");
    await flush();
    // Ordinal 5 is the z-high face of the fake kernel's box-face table —
    // the snapshot-ordinal addressing a real shell feature resolves to.
    requestShell(harness, "req_000002", "wsol_000001", [5], 0.5);
    await flush();

    const response = successResponseAt(harness.responses, 1);
    expect(response.requestId).toBe("req_000002");
    expect(response.result).toEqual({ solid: "wsol_000002" });

    // The minted shell is an ordinary session solid whose volume is the
    // analytic open-box model's: the box minus the inset cavity.
    harness.send({
      protocolVersion: 1,
      kind: "request",
      requestId: "req_000003",
      operation: "solid.volume",
      input: { solid: "wsol_000002" },
    });
    await flush();
    const volume = parseWorkerOperationResult(
      "solid.volume",
      successResponseAt(harness.responses, 2).result,
    );
    expect(volume.ok).toBe(true);
    if (!volume.ok) return;
    expect(volume.value.volume).toBeCloseTo(
      2 * 3 * 4 - (2 - 1) * (3 - 1) * (4 - 0.5),
      9,
    );
  });

  it("declines a target outside the kernel's shell domain with the kernel's own unsupported code", async () => {
    const harness = setup();
    harness.send({
      protocolVersion: 1,
      kind: "request",
      requestId: "req_000001",
      operation: "solid.createSphere",
      input: { radius: mmWire(2) },
    });
    await flush();
    // The fake kernel's honest shell domain is a pristine box leaf: a
    // sphere target declines with kernel/unsupported-operation — the same
    // structured code a shell-less engine (Manifold, JSCAD) answers with.
    requestShell(harness, "req_000002", "wsol_000001", [5], 0.5);
    await flush();

    const response = errorResponseAt(harness.responses, 1);
    expect(response.requestId).toBe("req_000002");
    expect(response.error.code).toBe("worker/operation-failed");
    expect(response.error.data).toEqual({
      kernelCode: KERNEL_ERROR_CODES.unsupportedOperation,
    });
  });

  it("carries the stale-ordinal structured failure in the error data and mints nothing", async () => {
    const harness = setup();
    harness.requestBox("req_000001");
    await flush();
    requestShell(harness, "req_000002", "wsol_000001", [999], 0.5);
    await flush();

    const response = errorResponseAt(harness.responses, 1);
    expect(response.error.code).toBe("worker/operation-failed");
    expect(response.error.data).toEqual({
      kernelCode: KERNEL_ERROR_CODES.shellFaceUnknown,
    });
    // A failed shell mints no id: the next solid-producing outcome gets
    // the session's second id.
    harness.requestBox("req_000003");
    await flush();
    expect(successResponseAt(harness.responses, 2).result).toEqual({
      solid: "wsol_000002",
    });
  });
});

describe("the solid.mirror operation (Phase 26.9)", () => {
  /** Sends a mirror request against a session solid, at the wire level. */
  function requestMirror(
    harness: ReturnType<typeof setup>,
    requestId: string,
    target: string,
    axis: "x" | "y" | "z",
    offsetMm: number,
  ): void {
    harness.send({
      protocolVersion: 1,
      kind: "request",
      requestId,
      operation: "solid.mirror",
      input: { target, axis, offset: mmWire(offsetMm) },
    });
  }

  it("answers solid.mirror through the kernel and mints the reflected solid", async () => {
    const harness = setup();
    harness.requestBox("req_000001");
    await flush();
    // The box(2, 3, 4) through the x-plane at x = 1: the interval [0, 2]
    // flips to [2·1 − 2, 2·1 − 0] = [0, 2] — an in-plane mirror — while
    // the y-axis twin flips y ∈ [0, 3] to [−3, 0]. Volume never moves.
    requestMirror(harness, "req_000002", "wsol_000001", "y", 0);
    await flush();

    const response = successResponseAt(harness.responses, 1);
    expect(response.requestId).toBe("req_000002");
    expect(response.result).toEqual({ solid: "wsol_000002" });

    harness.send({
      protocolVersion: 1,
      kind: "request",
      requestId: "req_000003",
      operation: "solid.volume",
      input: { solid: "wsol_000002" },
    });
    await flush();
    const volume = parseWorkerOperationResult(
      "solid.volume",
      successResponseAt(harness.responses, 2).result,
    );
    expect(volume.ok).toBe(true);
    if (!volume.ok) return;
    expect(volume.value.volume).toBeCloseTo(2 * 3 * 4, 9);

    harness.send({
      protocolVersion: 1,
      kind: "request",
      requestId: "req_000004",
      operation: "solid.bounds",
      input: { solid: "wsol_000002" },
    });
    await flush();
    const bounds = parseWorkerOperationResult(
      "solid.bounds",
      successResponseAt(harness.responses, 3).result,
    );
    expect(bounds.ok).toBe(true);
    if (!bounds.ok) return;
    expect(bounds.value.bounds).toEqual({
      min: [0, -3, 0],
      max: [2, 0, 4],
    });
  });

  it("carries a foreign-target structured failure in the error data and mints nothing", async () => {
    const harness = setup();
    harness.requestBox("req_000001");
    await flush();
    requestMirror(harness, "req_000002", "wsol_999999", "x", 0);
    await flush();

    const response = errorResponseAt(harness.responses, 1);
    expect(response.error.code).toBe("worker/operation-failed");
    expect(response.error.data).toEqual({
      kernelCode: KERNEL_ERROR_CODES.solidNotOwned,
    });
    // A failed mirror mints no id: the next solid-producing outcome gets
    // the session's second id.
    harness.requestBox("req_000003");
    await flush();
    expect(successResponseAt(harness.responses, 2).result).toEqual({
      solid: "wsol_000002",
    });
  });
});

describe("the solid.topology extension (Phase 26.5)", () => {
  function requestTopology(
    harness: ReturnType<typeof setup>,
    requestId: string,
    solid: string,
  ): void {
    harness.send({
      protocolVersion: 1,
      kind: "request",
      requestId,
      operation: "solid.topology",
      input: {
        solid,
        bodyId: createBodyId("body_fillet_fixture"),
        regeneration: 3,
      },
    });
  }

  it("answers solid.topology through the extension and mints no id", async () => {
    const seen: { bodyId: string; regeneration: number }[] = [];
    const harness = setup({
      topology: (context) => {
        seen.push(context);
        return true;
      },
    });
    harness.requestBox("req_000001");
    await flush();
    requestTopology(harness, "req_000002", "wsol_000001");
    await flush();

    const response = successResponseAt(harness.responses, 1);
    expect(response.requestId).toBe("req_000002");
    const parsed = parseWorkerOperationResult(
      "solid.topology",
      response.result,
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    // The snapshot crosses back wire-valid, echoing the labeling context.
    expect(parsed.value.snapshot.bodyId).toBe("body_fillet_fixture");
    expect(parsed.value.snapshot.regeneration).toBe(3);
    expect(seen).toEqual([{ bodyId: "body_fillet_fixture", regeneration: 3 }]);
    // solid.topology mints nothing: the next solid-producing outcome gets
    // the session's second id, not a third.
    harness.requestBox("req_000003");
    await flush();
    expect(successResponseAt(harness.responses, 2).result).toEqual({
      solid: "wsol_000002",
    });
  });

  it("answers solid.topology with topology/unsupported when no extension is hosted", async () => {
    const harness = setup();
    harness.requestBox("req_000001");
    await flush();
    requestTopology(harness, "req_000002", "wsol_000001");
    await flush();

    const response = errorResponseAt(harness.responses, 1);
    expect(response.requestId).toBe("req_000002");
    expect(response.error.code).toBe("worker/operation-failed");
    expect(response.error.data).toEqual({
      kernelCode: TOPOLOGY_UNSUPPORTED_CODE,
    });
  });

  it("carries the extension's structured topology failure in the error data", async () => {
    const harness = setup({ topology: () => false });
    harness.requestBox("req_000001");
    await flush();
    requestTopology(harness, "req_000002", "wsol_000001");
    await flush();

    const response = errorResponseAt(harness.responses, 1);
    expect(response.error.code).toBe("worker/operation-failed");
    expect(response.error.data).toEqual({ kernelCode: "topology/test" });
  });

  it("fails solid.topology with the session's solid-not-owned before the extension runs", async () => {
    let extensionRan = false;
    const harness = setup({
      topology: () => {
        extensionRan = true;
        return true;
      },
    });
    requestTopology(harness, "req_000001", "wsol_000404");
    await flush();

    const response = errorResponseAt(harness.responses, 0);
    expect(response.error.code).toBe("worker/operation-failed");
    expect(response.error.data).toEqual({
      kernelCode: KERNEL_ERROR_CODES.solidNotOwned,
    });
    expect(extensionRan).toBe(false);
  });

  it("suppresses a cancelled topology request: the ack is the cancelled error and no id is consumed", async () => {
    const harness = setup({ topology: () => true });
    harness.requestBox("req_000001");
    await flush();
    requestTopology(harness, "req_000002", "wsol_000001");
    harness.cancel("req_000002");
    await flush();
    expect(errorResponseAt(harness.responses, 1).error.code).toBe(
      "worker/cancelled",
    );

    // A topology outcome owns no solids, so suppression releases nothing —
    // and mints nothing either way: the next mint is the session's second.
    harness.requestBox("req_000003");
    await flush();
    expect(successResponseAt(harness.responses, 2).result).toEqual({
      solid: "wsol_000002",
    });
  });
});
