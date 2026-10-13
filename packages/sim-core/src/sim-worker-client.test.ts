/**
 * Sim worker client tests (Phase 61b): correlation and id discipline, the
 * notification subscription's pending-only delivery, the caller-side
 * cancellation mirror, and terminal closure — the kernel client suite's
 * scenarios plus the notification-class coverage that is new here. The far
 * end of the in-memory pair plays the responder with the protocol's own
 * builders, exactly as the kernel client tests do.
 */

import { describe, expect, it } from "vitest";

import { createSimInMemoryTransportPair } from "./sim-transport";
import { createSimWorkerClient, SimRequestFailure } from "./sim-worker-client";
import {
  createSimFieldChunkNotification,
  createSimProgressNotification,
  createSimWorkerSuccessResponse,
  parseSimWorkerMessage,
} from "./sim-worker-protocol";
import {
  createSimWorkerRequestId,
  parseSimProblemId,
  parseSimRunId,
  type SimProblemId,
  type SimRunId,
} from "./sim-worker-ids";

function problemId(raw: string): SimProblemId {
  const parsed = parseSimProblemId(raw);
  if (!parsed.ok) throw new Error("test problem id must parse");
  return parsed.value;
}

function runId(raw: string): SimRunId {
  const parsed = parseSimRunId(raw);
  if (!parsed.ok) throw new Error("test run id must parse");
  return parsed.value;
}

/** A responder that answers every request with `answer`. */
function respondingEnd(
  pair: ReturnType<typeof createSimInMemoryTransportPair>,
  answer: (requestId: ReturnType<typeof createSimWorkerRequestId>) => unknown,
): void {
  pair.server.onMessage((data) => {
    const parsed = parseSimWorkerMessage(data);
    if (!parsed.ok || parsed.value.kind !== "request") return;
    pair.server.send(answer(parsed.value.requestId));
  });
}

describe("correlation and id discipline", () => {
  it("resolves the typed result of its own request", async () => {
    const pair = createSimInMemoryTransportPair();
    const client = createSimWorkerClient({ transport: pair.client });
    respondingEnd(pair, (id) =>
      createSimWorkerSuccessResponse(id, "sim.run", {
        run: runId("wrun_000001"),
        steps: 24,
        chunks: 24,
      }),
    );
    const result = await client.request("sim.run", {
      problem: problemId("wprob_000001"),
    });
    expect(result).toEqual({ run: "wrun_000001", steps: 24, chunks: 24 });
    client.close();
  });

  it("rejects with the structured worker error of an error response", async () => {
    const pair = createSimInMemoryTransportPair();
    const client = createSimWorkerClient({ transport: pair.client });
    respondingEnd(pair, (id) => ({
      protocolVersion: 1,
      kind: "response",
      requestId: id,
      status: "error",
      error: {
        code: "worker/operation-failed",
        message: "declined",
        data: { simCode: "sim/problem-unknown" },
      },
    }));
    const failure = await client
      .request("sim.run", { problem: problemId("wprob_000404") })
      .then(
        () => null,
        (error: unknown) => error,
      );
    expect(failure).toBeInstanceOf(SimRequestFailure);
    if (!(failure instanceof SimRequestFailure)) return;
    expect(failure.error.data?.simCode).toBe("sim/problem-unknown");
    client.close();
  });

  it("refuses a duplicate id locally without touching the channel", async () => {
    const pair = createSimInMemoryTransportPair();
    let sentCount = 0;
    pair.server.onMessage(() => {
      sentCount += 1;
    });
    const client = createSimWorkerClient({ transport: pair.client });
    const id = createSimWorkerRequestId("req_000001");
    const first = client.request(
      "sim.run",
      { problem: problemId("wprob_000001") },
      id,
    );
    const second = client.request(
      "sim.run",
      { problem: problemId("wprob_000001") },
      id,
    );
    await expect(second).rejects.toMatchObject({
      error: { code: "worker/duplicate-request" },
    });
    expect(sentCount).toBe(1);
    // The first request is still pending; closing settles it (asserted so
    // its rejection is handled, never unhandled).
    client.close();
    await expect(first).rejects.toMatchObject({
      error: { code: "worker/transport-closed" },
    });
  });
});

describe("the notification subscription", () => {
  it("delivers notifications for pending requests, decoded to the engine shape", async () => {
    const pair = createSimInMemoryTransportPair();
    const client = createSimWorkerClient({ transport: pair.client });
    const received: string[] = [];
    client.onNotification((delivery) => {
      received.push(
        delivery.notification.kind === "field-chunk"
          ? `field-chunk:${delivery.notification.id}:${String(delivery.notification.values.length)}`
          : delivery.notification.kind === "progress"
            ? `progress:${String(delivery.notification.step)}`
            : `optimization-generation:${String(delivery.notification.generation)}`,
      );
    });
    respondingEnd(pair, (id) => {
      pair.server.send(
        createSimProgressNotification(id, { step: 3, totalSteps: 24 }),
      );
      pair.server.send(
        createSimFieldChunkNotification(id, {
          id: "pressure",
          unit: "Pa",
          extent: [2, 2, 1],
          originMm: [0, 0, 0],
          spacingMm: [1, 1, 1],
          dataType: "float64",
          chunkIndex: 0,
          chunkCount: 1,
          values: [1, 2, 3, 4],
        }),
      );
      return createSimWorkerSuccessResponse(id, "sim.run", {
        run: runId("wrun_000001"),
        steps: 3,
        chunks: 1,
      });
    });
    const result = await client.request("sim.run", {
      problem: problemId("wprob_000001"),
    });
    expect(result.steps).toBe(3);
    expect(received).toEqual(["progress:3", "field-chunk:pressure:4"]);
    client.close();
  });

  it("drops notifications for ids it never held pending", async () => {
    const pair = createSimInMemoryTransportPair();
    const client = createSimWorkerClient({ transport: pair.client });
    const received: string[] = [];
    client.onNotification((delivery) => {
      received.push(String(delivery.notification.kind));
    });
    const foreign = createSimWorkerRequestId("req_000404");
    pair.server.send(createSimProgressNotification(foreign, { step: 1 }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(received).toEqual([]);
    client.close();
  });

  it("stops delivering after close", async () => {
    const pair = createSimInMemoryTransportPair();
    const client = createSimWorkerClient({ transport: pair.client });
    const pending = client.request("sim.run", {
      problem: problemId("wprob_000001"),
    });
    const received: string[] = [];
    client.onNotification((delivery) => {
      received.push(String(delivery.notification.kind));
    });
    client.close();
    await expect(pending).rejects.toBeInstanceOf(SimRequestFailure);
    const id = createSimWorkerRequestId("req_000001");
    pair.server.send(createSimProgressNotification(id, { step: 1 }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(received).toEqual([]);
  });
});

describe("cancellation, caller side", () => {
  it("voids the request the moment cancel is called; a late success settles nothing", async () => {
    const pair = createSimInMemoryTransportPair();
    const client = createSimWorkerClient({ transport: pair.client });
    const id = createSimWorkerRequestId("req_000001");
    const pending = client.request(
      "sim.run",
      { problem: problemId("wprob_000001") },
      id,
    );
    client.cancel(id);
    await expect(pending).rejects.toMatchObject({
      error: { code: "worker/cancelled" },
    });
    // The straggling success crosses the wire afterwards; the client
    // discards it (nothing resolves or rejects a second time).
    pair.server.send(
      createSimWorkerSuccessResponse(id, "sim.run", {
        run: runId("wrun_000001"),
        steps: 24,
        chunks: 24,
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    client.close();
  });

  it("is a no-op for an id it never issued", () => {
    const pair = createSimInMemoryTransportPair();
    const client = createSimWorkerClient({ transport: pair.client });
    expect(() =>
      client.cancel(createSimWorkerRequestId("req_000404")),
    ).not.toThrow();
    client.close();
  });
});

describe("closure", () => {
  it("settles in-flight requests with worker/transport-closed and refuses later ones", async () => {
    const pair = createSimInMemoryTransportPair();
    const client = createSimWorkerClient({ transport: pair.client });
    const pending = client.request("sim.run", {
      problem: problemId("wprob_000001"),
    });
    client.close();
    await expect(pending).rejects.toMatchObject({
      error: { code: "worker/transport-closed" },
    });
    await expect(
      client.request("sim.run", { problem: problemId("wprob_000001") }),
    ).rejects.toMatchObject({ error: { code: "worker/transport-closed" } });
  });
});
