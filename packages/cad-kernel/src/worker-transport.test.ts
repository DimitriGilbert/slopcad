/**
 * The in-memory transport (Phase 10.2): dispatch is microtask-delayed and
 * send-order FIFO, delivery never happens synchronously inside `send`, and
 * the pair is a pure mover — arbitrary payloads cross it uninspected and
 * unchanged. These properties are the determinism contract the client and
 * server are built on, so they are pinned here.
 */

import { describe, expect, it } from "vitest";

import { createInMemoryTransportPair } from "./worker-transport";

const flush = async (ticks = 16): Promise<void> => {
  for (let tick = 0; tick < ticks; tick += 1) await Promise.resolve();
};

describe("in-memory transport dispatch", () => {
  it("delivers to the other end's listeners, never synchronously", async () => {
    const pair = createInMemoryTransportPair();
    const receivedByServer: unknown[] = [];
    const receivedByClient: unknown[] = [];
    let deliveredSynchronously = false;
    pair.server.onMessage((data) => receivedByServer.push(data));
    pair.client.onMessage((data) => receivedByClient.push(data));
    pair.server.onMessage(() => {
      deliveredSynchronously = true;
    });

    pair.client.send("to-server");

    expect(deliveredSynchronously).toBe(false);
    expect(receivedByServer).toEqual([]);
    await flush();
    expect(receivedByServer).toEqual(["to-server"]);
    expect(receivedByClient).toEqual([]);
  });

  it("delivers in send order across both directions", async () => {
    const pair = createInMemoryTransportPair();
    const events: string[] = [];
    pair.server.onMessage((data) => events.push(`server:${String(data)}`));
    pair.client.onMessage((data) => events.push(`client:${String(data)}`));

    pair.client.send("c1");
    pair.client.send("c2");
    pair.server.send("s1");
    pair.client.send("c3");
    await flush();

    expect(events).toEqual(["server:c1", "server:c2", "client:s1", "server:c3"]);
  });

  it("moves arbitrary payloads without inspecting them", async () => {
    const pair = createInMemoryTransportPair();
    const received: unknown[] = [];
    pair.server.onMessage((data) => received.push(data));
    const payload = { kind: "not-a-protocol-message", nested: [1, 2, 3] };

    pair.client.send(42);
    pair.client.send(payload);
    pair.client.send(null);
    await flush();

    expect(received).toEqual([42, payload, null]);
    expect(received[1]).toBe(payload);
  });

  it("unsubscribes listeners; later sends do not reach them", async () => {
    const pair = createInMemoryTransportPair();
    const unsubscribed: unknown[] = [];
    const retained: unknown[] = [];
    const unsubscribe = pair.server.onMessage((data) => unsubscribed.push(data));
    pair.server.onMessage((data) => retained.push(data));

    unsubscribe();
    unsubscribe(); // a second unsubscribe of the same listener is a no-op
    pair.client.send("after-unsubscribe");
    await flush();

    expect(unsubscribed).toEqual([]);
    expect(retained).toEqual(["after-unsubscribe"]);
  });

  it("does not replay already-delivered messages to later subscribers", async () => {
    const pair = createInMemoryTransportPair();
    const early: unknown[] = [];
    pair.server.onMessage((data) => early.push(data));

    pair.client.send("first");
    await flush();
    const late: unknown[] = [];
    pair.server.onMessage((data) => late.push(data));
    pair.client.send("second");
    await flush();

    expect(early).toEqual(["first", "second"]);
    expect(late).toEqual(["second"]);
  });
});
