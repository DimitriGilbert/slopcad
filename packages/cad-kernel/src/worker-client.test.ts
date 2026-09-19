/**
 * The worker client (Phase 10.2): request/response correlation over a
 * transport, driven here against the in-memory pair with hand-delivered
 * server messages — so every adversarial case (malformed responses, late
 * successes after cancellation, null-id errors, misdirected traffic) is
 * staged deterministically without a real responder.
 */

import { describe, expect, it } from "vitest";
import { length } from "@slopcad/cad-core";
import type { WorkerMessage } from "./worker-protocol";

import { createWorkerClient, WorkerRequestFailure } from "./worker-client";
import { WORKER_PROTOCOL_ERROR_CODES, workerError } from "./worker-errors";
import { createWorkerRequestId, createWorkerSolidId } from "./worker-ids";
import {
  createWorkerErrorResponse,
  createWorkerRequest,
  createWorkerSuccessResponse,
  parseWorkerMessage,
} from "./worker-protocol";
import { createInMemoryTransportPair } from "./worker-transport";

const mm = (value: number) => length(value, "mm");

const flush = async (ticks = 16): Promise<void> => {
  for (let tick = 0; tick < ticks; tick += 1) await Promise.resolve();
};

const boxInput = { width: mm(2), depth: mm(3), height: mm(4) };

const firstRequestId = createWorkerRequestId("req_000001");
const secondRequestId = createWorkerRequestId("req_000002");
const firstSolid = createWorkerSolidId("wsol_000001");

interface ClientHarness {
  readonly client: ReturnType<typeof createWorkerClient>;
  /** Everything the client sent, in order (observed at the server end). */
  readonly sent: unknown[];
  /** Delivers data to the client exactly as a responder's message would. */
  deliver(data: unknown): void;
}

function setup(): ClientHarness {
  const pair = createInMemoryTransportPair();
  const sent: unknown[] = [];
  pair.server.onMessage((data) => sent.push(data));
  const client = createWorkerClient({ transport: pair.client });
  return {
    client,
    sent,
    deliver: (data) => pair.server.send(data),
  };
}

function sentMessageAt(harness: ClientHarness, index: number): WorkerMessage {
  const parsed = parseWorkerMessage(harness.sent[index]);
  if (!parsed.ok) throw new Error(`Expected a sent message at index ${index}.`);
  return parsed.value;
}

function failureOf(promise: Promise<unknown>): Promise<WorkerRequestFailure> {
  return promise.then(
    () => {
      throw new Error("Expected the request to fail.");
    },
    (error: unknown) => {
      if (!(error instanceof WorkerRequestFailure)) {
        throw new Error(
          `Expected a WorkerRequestFailure, received ${String(error)}.`,
        );
      }
      return error;
    },
  );
}

describe("client correlation", () => {
  it("sends the canonical request and resolves the decoded result", async () => {
    const harness = setup();
    const box = harness.client.request("solid.createBox", boxInput);
    await flush();

    expect(harness.sent).toHaveLength(1);
    expect(sentMessageAt(harness, 0)).toEqual({
      protocolVersion: 1,
      kind: "request",
      requestId: "req_000001",
      operation: "solid.createBox",
      input: {
        width: { dimension: "length", unit: "mm", value: 2 },
        depth: { dimension: "length", unit: "mm", value: 3 },
        height: { dimension: "length", unit: "mm", value: 4 },
      },
    });

    harness.deliver(
      createWorkerSuccessResponse(firstRequestId, "solid.createBox", {
        solid: firstSolid,
      }),
    );
    await expect(box).resolves.toEqual({ solid: "wsol_000001" });
  });

  it("mints request ids sequentially, also across concurrent requests", async () => {
    const harness = setup();
    const box = harness.client.request("solid.createBox", boxInput);
    const sphere = harness.client.request("solid.createSphere", {
      radius: mm(1),
    });
    await flush();

    const first = sentMessageAt(harness, 0);
    const second = sentMessageAt(harness, 1);
    expect(first.kind === "request" && first.requestId).toBe("req_000001");
    expect(second.kind === "request" && second.requestId).toBe("req_000002");

    // Responses may arrive out of order; each settles its own request.
    harness.deliver(
      createWorkerSuccessResponse(secondRequestId, "solid.createSphere", {
        solid: createWorkerSolidId("wsol_000002"),
      }),
    );
    harness.deliver(
      createWorkerSuccessResponse(firstRequestId, "solid.createBox", {
        solid: firstSolid,
      }),
    );
    await expect(sphere).resolves.toEqual({ solid: "wsol_000002" });
    await expect(box).resolves.toEqual({ solid: "wsol_000001" });
  });

  it("adopts a caller-chosen request id exactly as given", async () => {
    const harness = setup();
    const explicit = createWorkerRequestId("req_chosen.1");
    const box = harness.client.request("solid.createBox", boxInput, explicit);
    await flush();

    const message = sentMessageAt(harness, 0);
    expect(message.kind === "request" && message.requestId).toBe(
      "req_chosen.1",
    );

    harness.deliver(
      createWorkerSuccessResponse(explicit, "solid.createBox", {
        solid: firstSolid,
      }),
    );
    await expect(box).resolves.toEqual({ solid: "wsol_000001" });
  });
});

describe("client failure propagation", () => {
  it("rejects a structured error response as a WorkerRequestFailure", async () => {
    const harness = setup();
    const box = harness.client.request("solid.createBox", boxInput);
    await flush();

    harness.deliver(
      createWorkerErrorResponse(
        firstRequestId,
        workerError(
          "worker/operation-failed",
          "The box was rejected by the kernel.",
          {
            kernelCode: "kernel/invalid-length",
          },
        ),
      ),
    );

    const failure = await failureOf(box);
    expect(failure.error.code).toBe("worker/operation-failed");
    expect(failure.error.data).toEqual({ kernelCode: "kernel/invalid-length" });
    expect(failure.message).toBe("The box was rejected by the kernel.");
  });

  it("rejects a malformed result payload with worker/malformed-payload", async () => {
    const harness = setup();
    const box = harness.client.request("solid.createBox", boxInput);
    await flush();

    harness.deliver({
      protocolVersion: 1,
      kind: "response",
      requestId: "req_000001",
      status: "ok",
      result: {},
    });

    const failure = await failureOf(box);
    expect(failure.error.code).toBe("worker/malformed-payload");
  });

  it("drops malformed channel data without settling the request", async () => {
    const harness = setup();
    let settled = false;
    const box = harness.client.request("solid.createBox", boxInput);
    box.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await flush();

    harness.deliver("not-a-message");
    harness.deliver({
      protocolVersion: 1,
      kind: "response",
      requestId: null,
      status: "error",
      error: { code: "worker/malformed-message", message: "uncorrelatable" },
    });
    await flush();
    expect(settled).toBe(false);

    // The channel is not poisoned: a later valid response still settles it.
    harness.deliver(
      createWorkerSuccessResponse(firstRequestId, "solid.createBox", {
        solid: firstSolid,
      }),
    );
    await flush();
    expect(settled).toBe(true);
    await expect(box).resolves.toEqual({ solid: "wsol_000001" });
  });

  it("drops a response for a foreign request id", async () => {
    const harness = setup();
    let settled = false;
    const box = harness.client.request("solid.createBox", boxInput);
    box.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await flush();

    harness.deliver(
      createWorkerSuccessResponse(secondRequestId, "solid.createBox", {
        solid: createWorkerSolidId("wsol_000009"),
      }),
    );
    await flush();
    expect(settled).toBe(false);
  });

  it("drops a request or cancel arriving in the caller role", async () => {
    const harness = setup();
    let settled = false;
    const box = harness.client.request("solid.createBox", boxInput);
    box.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await flush();

    harness.deliver(
      createWorkerRequest(secondRequestId, "solid.createSphere", {
        radius: mm(1),
      }),
    );
    harness.deliver({
      protocolVersion: 1,
      kind: "cancel",
      requestId: "req_000001",
    });
    await flush();
    expect(settled).toBe(false);
  });
});

describe("client id discipline", () => {
  it("rejects a duplicate id locally without touching the channel", async () => {
    const harness = setup();
    const explicit = createWorkerRequestId("req_reused");
    const first = harness.client.request("solid.createBox", boxInput, explicit);
    await flush();
    expect(harness.sent).toHaveLength(1);

    const second = harness.client.request(
      "solid.createSphere",
      { radius: mm(1) },
      explicit,
    );
    const failure = await failureOf(second);
    expect(failure.error.code).toBe("worker/duplicate-request");
    expect(harness.sent).toHaveLength(1); // the duplicate never reached the wire

    // The id stays spent after the first request settles, too.
    harness.deliver(
      createWorkerSuccessResponse(explicit, "solid.createBox", {
        solid: firstSolid,
      }),
    );
    await expect(first).resolves.toEqual({ solid: "wsol_000001" });
    const third = harness.client.request(
      "solid.createSphere",
      { radius: mm(2) },
      explicit,
    );
    expect((await failureOf(third)).error.code).toBe(
      "worker/duplicate-request",
    );
    expect(harness.sent).toHaveLength(1);
  });
});

describe("client cancellation", () => {
  it("voids an in-flight request and discards a success that lost the race", async () => {
    const harness = setup();
    const box = harness.client.request("solid.createBox", boxInput);
    await flush();
    expect(harness.sent).toHaveLength(1);

    harness.client.cancel(firstRequestId);
    const failure = await failureOf(box);
    expect(failure.error.code).toBe("worker/cancelled");

    // The cancel crossed the channel…
    const cancelSent = sentMessageAt(harness, 1);
    expect(cancelSent).toEqual({
      protocolVersion: 1,
      kind: "cancel",
      requestId: "req_000001",
    });

    // …and the late success is discarded: the request never resolves with it.
    let resolvedWithSuccess = false;
    box.then(
      () => {
        resolvedWithSuccess = true;
      },
      () => {
        // The cancellation rejection is asserted above.
      },
    );
    harness.deliver(
      createWorkerSuccessResponse(firstRequestId, "solid.createBox", {
        solid: firstSolid,
      }),
    );
    await flush();
    expect(resolvedWithSuccess).toBe(false);
  });

  it("is a no-op for an unknown request id", async () => {
    const harness = setup();
    harness.client.cancel(createWorkerRequestId("req_never-issued"));
    await flush();
    expect(harness.sent).toHaveLength(0);
  });

  it("is a no-op after the request settled, which cannot be unsettled", async () => {
    const harness = setup();
    const box = harness.client.request("solid.createBox", boxInput);
    await flush();
    harness.deliver(
      createWorkerSuccessResponse(firstRequestId, "solid.createBox", {
        solid: firstSolid,
      }),
    );
    await expect(box).resolves.toEqual({ solid: "wsol_000001" });

    harness.client.cancel(firstRequestId);
    await flush();
    expect(harness.sent).toHaveLength(1); // only the request; no cancel was sent
    await expect(box).resolves.toEqual({ solid: "wsol_000001" });
  });

  it("settles in-flight requests with worker/transport-closed on close, and later responses cannot settle them again", async () => {
    const harness = setup();
    const box = harness.client.request("solid.createBox", boxInput);
    await flush();

    harness.client.close();
    const failure = await box.then(
      () => {
        throw new Error(
          "close must settle the in-flight request, not resolve it.",
        );
      },
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(WorkerRequestFailure);
    if (!(failure instanceof WorkerRequestFailure)) {
      throw new Error("Expected a WorkerRequestFailure.");
    }
    expect(failure.error.code).toBe(
      WORKER_PROTOCOL_ERROR_CODES.transportClosed,
    );
    expect(failure.error.message).toContain(`"${firstRequestId}"`);

    // A late success for the orphaned request is dropped: the request is
    // void from the close on, never resolved by straggling traffic.
    harness.deliver(
      createWorkerSuccessResponse(firstRequestId, "solid.createBox", {
        solid: firstSolid,
      }),
    );
    await flush();
    await expect(box).rejects.toMatchObject({
      error: { code: WORKER_PROTOCOL_ERROR_CODES.transportClosed },
    });
  });

  it("close is quiet when no request is in flight", async () => {
    const harness = setup();
    await flush();
    harness.client.close();
    harness.deliver(
      createWorkerSuccessResponse(firstRequestId, "solid.createBox", {
        solid: firstSolid,
      }),
    );
    await flush();
  });

  it("refuses a request issued after close with worker/transport-closed — never pending, never sent", async () => {
    const harness = setup();
    harness.client.close();

    // The refusal settles immediately with the close path's own structured
    // code: a closed channel could never deliver this request a response, so
    // registering it as pending would hang the caller forever.
    const failure = await failureOf(
      harness.client.request("solid.createBox", boxInput),
    );
    expect(failure.error.code).toBe(
      WORKER_PROTOCOL_ERROR_CODES.transportClosed,
    );
    expect(failure.error.message).toContain(`"${firstRequestId}"`);

    // The refused request never touched the channel…
    expect(harness.sent).toHaveLength(0);
    // …and close stays terminal: a second close is quiet, and a request with
    // a caller-chosen id is refused the same way (the guard is in issue()).
    harness.client.close();
    const explicit = await failureOf(
      harness.client.request(
        "solid.createBox",
        boxInput,
        createWorkerRequestId("req_after-close"),
      ),
    );
    expect(explicit.error.code).toBe(
      WORKER_PROTOCOL_ERROR_CODES.transportClosed,
    );
    expect(harness.sent).toHaveLength(0);
  });
});

describe("client discard hygiene for voided successes", () => {
  it("best-effort disposes the orphaned mint a straggling success carries", async () => {
    const harness = setup();
    const box = harness.client.request("solid.createBox", boxInput);
    await flush();
    harness.client.cancel(firstRequestId);
    await failureOf(box); // the pinned rule: cancelled, never resolved

    // The straggling success loses the race — it must settle nothing…
    let resolvedWithSuccess = false;
    box.then(
      () => {
        resolvedWithSuccess = true;
      },
      () => {
        // The cancellation rejection is asserted above.
      },
    );
    harness.deliver(
      createWorkerSuccessResponse(firstRequestId, "solid.createBox", {
        solid: firstSolid,
      }),
    );
    await flush();
    expect(resolvedWithSuccess).toBe(false);

    // …but its mint is an orphan nobody else will ever dispose, so the
    // discard site releases it best-effort under an id derived from the
    // voided id — collision-free with any generator's numeric payloads.
    expect(harness.sent).toHaveLength(3); // request, cancel, hygiene disposal
    const disposal = sentMessageAt(harness, 2);
    expect(disposal).toEqual({
      protocolVersion: 1,
      kind: "request",
      requestId: "req_000001.disposal",
      operation: "solid.dispose",
      input: { solid: "wsol_000001" },
    });
  });

  it("issues no hygiene disposal when the straggling success mints nothing", async () => {
    const harness = setup();
    const volume = harness.client.request("solid.volume", {
      solid: firstSolid,
    });
    await flush();
    harness.client.cancel(firstRequestId);
    await failureOf(volume);

    harness.deliver(
      createWorkerSuccessResponse(firstRequestId, "solid.volume", {
        volume: 24,
      }),
    );
    await flush();
    expect(harness.sent).toHaveLength(2); // request + cancel only
  });

  it("never disposes for a request that settled normally — the solid is owned", async () => {
    const harness = setup();
    const box = harness.client.request("solid.createBox", boxInput);
    await flush();
    harness.deliver(
      createWorkerSuccessResponse(firstRequestId, "solid.createBox", {
        solid: firstSolid,
      }),
    );
    await expect(box).resolves.toEqual({ solid: "wsol_000001" });

    // A duplicate straggler for the settled id is a plain drop: the solid
    // belongs to the caller now, so no hygiene may touch it.
    harness.deliver(
      createWorkerSuccessResponse(firstRequestId, "solid.createBox", {
        solid: firstSolid,
      }),
    );
    await flush();
    expect(harness.sent).toHaveLength(1); // only the original request
    await expect(box).resolves.toEqual({ solid: "wsol_000001" });
  });

  it("skips the hygiene when the straggling success carries a malformed result", async () => {
    const harness = setup();
    const box = harness.client.request("solid.createBox", boxInput);
    await flush();
    harness.client.cancel(firstRequestId);
    await failureOf(box);

    harness.deliver({
      protocolVersion: 1,
      kind: "response",
      requestId: "req_000001",
      status: "ok",
      result: { solid: 42 }, // not a worker solid id: no trustworthy mint
    });
    await flush();
    expect(harness.sent).toHaveLength(2); // request + cancel only
  });

  it("drops a straggler for a foreign id without issuing anything", async () => {
    const harness = setup();
    const box = harness.client.request("solid.createBox", boxInput);
    await flush();
    harness.client.cancel(firstRequestId);
    await failureOf(box);

    // A success for an id this client never issued correlates with nothing
    // and voids nothing — foreign traffic stays a plain drop.
    harness.deliver(
      createWorkerSuccessResponse(secondRequestId, "solid.createBox", {
        solid: createWorkerSolidId("wsol_000009"),
      }),
    );
    await flush();
    expect(harness.sent).toHaveLength(2); // request + cancel only
  });
});
