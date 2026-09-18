/**
 * The node worker channel's own tests (Phase 10.3): the honesty proofs that
 * only a real thread can give — that the kernel executes on the worker's
 * thread (thread identity echoed over the channel, cross-checked against
 * both the factory's thread id and this test's own thread), that the main
 * thread keeps serving its event loop while the worker computes, and that
 * every way a channel can die settles in-flight requests with the
 * structured `worker/transport-closed` failure instead of hanging.
 */

import { threadId as testThreadId } from "node:worker_threads";
import { describe, expect, it } from "vitest";
import { length } from "@slopcad/cad-core";
import type { WorkerClient } from "@slopcad/cad-kernel";
import { WORKER_PROTOCOL_ERROR_CODES } from "@slopcad/cad-kernel";

import {
  createNodeManifoldWorkerChannel,
  nodeManifoldWorkerThreadEcho,
  type NodeManifoldWorkerChannel,
} from "./node-manifold-worker";

const mm = (value: number) => length(value, "mm");

/**
 * A sequential boolean chain long enough to span many main-thread event
 * loop turns in the worker: each step creates a small sphere, translates
 * it along x, and unions it onto the accumulator.
 */
async function growBooleanChain(
  client: WorkerClient,
  steps: number,
): Promise<void> {
  let acc = await client.request("solid.createSphere", { radius: mm(20) });
  for (let step = 1; step <= steps; step += 1) {
    const bit = await client.request("solid.createSphere", { radius: mm(5) });
    const placed = await client.request("solid.transform", {
      solid: bit.solid,
      translation: { x: mm(step * 1.5), y: mm(0), z: mm(0) },
    });
    acc = await client.request("solid.union", {
      operands: [acc.solid, placed.solid],
    });
  }
  await client.request("solid.volume", { solid: acc.solid });
}

describe("createNodeManifoldWorkerChannel", () => {
  it("hosts the kernel on a real worker thread, not the caller's", async () => {
    const channel = createNodeManifoldWorkerChannel({ echoThreadId: true });
    try {
      // The echo is posted by the worker entry before hosting starts and
      // crosses the real channel as plain non-protocol data.
      const echoed = new Promise<number>((resolve, reject) => {
        channel.transport.onMessage((data) => {
          const threadId = nodeManifoldWorkerThreadEcho(data);
          if (threadId !== null) resolve(threadId);
        });
        setTimeout(
          () => reject(new Error("The worker never echoed its thread id.")),
          10_000,
        );
      });

      const reported = await echoed;
      // Identity, cross-checked three ways: the echo matches the thread
      // the factory created, that thread is a real worker thread, and it
      // is not the thread running this test (where an in-process kernel
      // would execute).
      expect(reported).toBe(channel.threadId);
      expect(channel.threadId).toBeGreaterThan(0);
      expect(reported).not.toBe(testThreadId);

      // And that thread's kernel genuinely answers over the channel:
      const box = await channel.client.request("solid.createBox", {
        width: mm(2),
        depth: mm(3),
        height: mm(4),
      });
      const volume = await channel.client.request("solid.volume", {
        solid: box.solid,
      });
      expect(volume.volume).toBeCloseTo(24, 9);
    } finally {
      await channel.close();
    }
  }, 30_000);

  it("keeps the caller's event loop responsive while the worker computes a long boolean chain", async () => {
    const channel = createNodeManifoldWorkerChannel();
    try {
      let chainSettled = false;
      const heavy = growBooleanChain(channel.client, 40).finally(() => {
        chainSettled = true;
      });

      // Macrotask ticks only: if the kernel work ran on THIS thread
      // (synchronously or as microtasks), it would all complete before
      // the first setTimeout callback could fire, and concurrentTicks
      // would stay 0. A number > 0 can only be observed when the worker
      // computes while this loop keeps turning.
      let concurrentTicks = 0;
      while (!chainSettled) {
        await new Promise((resolve) => setTimeout(resolve, 1));
        if (!chainSettled) concurrentTicks += 1;
      }
      await heavy;

      expect(concurrentTicks).toBeGreaterThanOrEqual(5);
    } finally {
      await channel.close();
    }
  }, 60_000);

  it("close settles in-flight requests with worker/transport-closed and ends the thread cleanly", async () => {
    const channel = createNodeManifoldWorkerChannel();
    // The request is pending in the client until its response is
    // delivered, and no message event can run before this synchronous
    // stretch ends — so the settlement below is deterministic, not a race.
    const inFlight = channel.client.request("solid.createSphere", {
      radius: mm(1),
    });
    // Attach the rejection handler before closing, so settlement never
    // observes an unhandled rejection.
    const settled = expect(inFlight).rejects.toMatchObject({
      error: { code: WORKER_PROTOCOL_ERROR_CODES.transportClosed },
    });

    await channel.close();

    await settled;
    const exit = await channel.exited;
    expect(exit.errorMessage).toBeNull();
  }, 30_000);

  it("an abrupt terminate settles in-flight requests through the exit hook", async () => {
    const channel: NodeManifoldWorkerChannel =
      createNodeManifoldWorkerChannel();
    const inFlight = growBooleanChain(channel.client, 40);
    // Attach the rejection handler before the thread dies, so the exit
    // hook's settlement never observes an unhandled rejection.
    const settled = expect(inFlight).rejects.toMatchObject({
      error: { code: WORKER_PROTOCOL_ERROR_CODES.transportClosed },
    });

    const exit = await channel.terminate();

    await settled;
    expect(exit.errorMessage).toBeNull();
  }, 30_000);

  it("exposes a request client whose results are kernel-neutral over the wire", async () => {
    const channel = createNodeManifoldWorkerChannel();
    try {
      const cylinder = await channel.client.request("solid.createCylinder", {
        radius: mm(2),
        height: mm(5),
      });
      // Solid ids are plain wsol_ strings — no kernel handle crosses.
      expect(typeof cylinder.solid).toBe("string");
      expect(cylinder.solid).toMatch(/^wsol_/);

      const volume = await channel.client.request("solid.volume", {
        solid: cylinder.solid,
      });
      expect(volume.volume).toBeGreaterThan(0);
    } finally {
      await channel.close();
    }
  }, 30_000);
});
