/**
 * The Node real-worker adapter's unit tests (Phase 10.3): the thin mapping
 * between the {@link WorkerTransport} interface and the
 * `node:worker_threads` port shape — driven by a REAL `MessageChannel` pair,
 * so the assertions cover the actual structured-clone semantics (delivered
 * values are clones, never the posted references) and the ports' own
 * asynchronous delivery, not a simulation of them.
 */

import { MessageChannel } from "node:worker_threads";
import { describe, expect, it } from "vitest";
import type { WorkerTransport } from "./worker-transport";

import { createNodeWorkerTransport } from "./worker-node-transport";

interface ChannelFixture {
  readonly a: WorkerTransport;
  readonly b: WorkerTransport;
  close(): void;
}

function setup(): ChannelFixture {
  const { port1, port2 } = new MessageChannel();
  return {
    a: createNodeWorkerTransport(port1),
    b: createNodeWorkerTransport(port2),
    close(): void {
      port1.close();
      port2.close();
    },
  };
}

describe("createNodeWorkerTransport", () => {
  it("round-trips messages through a real node MessageChannel as clones", async () => {
    const fixture = setup();
    try {
      const payload = { hello: "world", nested: [1, 2, 3] };
      const delivered = new Promise<unknown>((resolve) => {
        fixture.b.onMessage((data) => resolve(data));
      });

      fixture.a.send(payload);

      const received = await delivered;
      expect(received).toEqual(payload);
      // A real channel clones: the received value is never the sent object.
      expect(received).not.toBe(payload);
    } finally {
      fixture.close();
    }
  });

  it("moves messages in both directions and stops delivery after unsubscribe", async () => {
    const fixture = setup();
    try {
      const collected: unknown[] = [];
      const unsubscribe = fixture.b.onMessage((data) => collected.push(data));
      const fromBtoA = new Promise<unknown>((resolve) => {
        fixture.a.onMessage((data) => resolve(data));
      });
      const nextOnB = new Promise<unknown>((resolve) => {
        fixture.b.onMessage((data) => resolve(data));
      });

      fixture.a.send("a to b");
      expect(await nextOnB).toBe("a to b");

      unsubscribe();
      const afterUnsubscribe = new Promise<unknown>((resolve) => {
        fixture.b.onMessage((data) => resolve(data));
      });
      fixture.a.send("dropped for the unsubscribed listener");
      expect(await afterUnsubscribe).toBe(
        "dropped for the unsubscribed listener",
      );

      fixture.b.send("b to a");
      expect(await fromBtoA).toBe("b to a");

      expect(collected).toEqual(["a to b"]);
    } finally {
      fixture.close();
    }
  });

  it("delivers to multiple listeners in subscription order", async () => {
    const fixture = setup();
    try {
      const order: string[] = [];
      fixture.b.onMessage(() => order.push("first"));
      fixture.b.onMessage(() => order.push("second"));
      const delivered = new Promise<void>((resolve) => {
        fixture.b.onMessage(() => resolve());
      });

      fixture.a.send({ tick: 1 });
      await delivered;

      expect(order).toEqual(["first", "second"]);
    } finally {
      fixture.close();
    }
  });
});
