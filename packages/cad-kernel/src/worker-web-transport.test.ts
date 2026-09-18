/**
 * The browser real-worker adapter's unit tests (Phase 10.3): the thin
 * mapping between the {@link WorkerTransport} interface and the Web Workers
 * `postMessage`/`addEventListener("message")` shape, driven by a fake port
 * that models the DOM contract the real channel offers — asynchronous
 * delivery, `event.data` unwrapping, subscription-order dispatch. The real
 * browser channel itself is exercised by the app's e2e layer (the Phase 10
 * phase-wide gate).
 */

import { describe, expect, it } from "vitest";

import {
  createWebWorkerTransport,
  isWebWorkerMessagePort,
  type WebWorkerMessagePort,
} from "./worker-web-transport";

/**
 * A fake dedicated-worker port: `postMessage` delivers to the subscribers of
 * the *other* role. Here one instance plays both roles — messages posted are
 * dispatched asynchronously (microtask-delayed, like a real channel never
 * delivering inside the posting call) to this port's own subscribers.
 */
class FakeWebPort implements WebWorkerMessagePort {
  private readonly listeners = new Set<(event: { data: unknown }) => void>();

  postMessage(data: unknown): void {
    const batch = [...this.listeners];
    queueMicrotask(() => {
      for (const listener of batch) listener({ data });
    });
  }

  addEventListener(
    _type: "message",
    listener: (event: { readonly data: unknown }) => void,
  ): void {
    this.listeners.add(listener);
  }

  removeEventListener(
    _type: "message",
    listener: (event: { readonly data: unknown }) => void,
  ): void {
    this.listeners.delete(listener);
  }
}

const flush = async (ticks = 4): Promise<void> => {
  for (let tick = 0; tick < ticks; tick += 1) await Promise.resolve();
};

describe("createWebWorkerTransport", () => {
  it("delivers sent messages to subscribers as unwrapped event.data", async () => {
    const port = new FakeWebPort();
    const transport = createWebWorkerTransport(port);
    const received: unknown[] = [];
    transport.onMessage((data) => received.push(data));

    transport.send({ protocolVersion: 1, kind: "request" });
    transport.send("a bare string is legal channel data");

    await flush();
    expect(received).toEqual([
      { protocolVersion: 1, kind: "request" },
      "a bare string is legal channel data",
    ]);
  });

  it("delivers to multiple listeners in subscription order", async () => {
    const port = new FakeWebPort();
    const transport = createWebWorkerTransport(port);
    const order: string[] = [];
    transport.onMessage(() => order.push("first"));
    transport.onMessage(() => order.push("second"));

    transport.send(null);
    await flush();
    expect(order).toEqual(["first", "second"]);
  });

  it("stops delivery after unsubscribe, for the unsubscribed listener only", async () => {
    const port = new FakeWebPort();
    const transport = createWebWorkerTransport(port);
    const received: unknown[] = [];
    const unsubscribe = transport.onMessage((data) => received.push(data));
    const stillListening: unknown[] = [];
    transport.onMessage((data) => stillListening.push(data));

    transport.send("before unsubscribe");
    await flush();
    unsubscribe();
    transport.send("after unsubscribe");
    await flush();

    expect(received).toEqual(["before unsubscribe"]);
    expect(stillListening).toEqual(["before unsubscribe", "after unsubscribe"]);
  });

  it("does not replay messages to a listener subscribed after they were delivered", async () => {
    const port = new FakeWebPort();
    const transport = createWebWorkerTransport(port);
    transport.send("already in flight");
    await flush();

    const received: unknown[] = [];
    transport.onMessage((data) => received.push(data));
    await flush();
    expect(received).toEqual([]);
  });
});

describe("isWebWorkerMessagePort", () => {
  it("accepts a scope with the dedicated-worker message surface", () => {
    expect(isWebWorkerMessagePort(new FakeWebPort())).toBe(true);
  });

  it("rejects scopes without the full message surface", () => {
    expect(isWebWorkerMessagePort(null)).toBe(false);
    expect(isWebWorkerMessagePort(42)).toBe(false);
    expect(isWebWorkerMessagePort({ postMessage: () => undefined })).toBe(
      false,
    );
    expect(
      isWebWorkerMessagePort({
        postMessage: () => undefined,
        addEventListener: () => undefined,
      }),
    ).toBe(false);
  });
});
