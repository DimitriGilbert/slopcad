/**
 * The node OCCT worker channel's own tests (Phase 21.2): the honesty proofs
 * that only a real thread can give — the twin of the Manifold channel tests,
 * with the heavy-op shape adapted to OpenCascade's characteristics.
 *
 * OCCT's exact BREP operations are individually fast (~5 ms/op class,
 * probed) and constant per scene, where Manifold's lazily-evaluated unions
 * grow with the accumulator. The responsiveness proof therefore drives a
 * SERIES of independent drill-plate scenes (box → cylinder → transform →
 * subtract → volume) instead of a growing boolean chain: linear, honestly
 * measurable work whose per-scene cost does not depend on history — the
 * OCCT-appropriate way to span many main-thread event loop turns.
 */

import { threadId as testThreadId } from "node:worker_threads";
import { describe, expect, it } from "vitest";
import { length } from "@slopcad/cad-core";
import type { WorkerClient } from "@slopcad/cad-kernel";
import { WORKER_PROTOCOL_ERROR_CODES } from "@slopcad/cad-kernel";

import {
  createNodeOcctWorkerChannel,
  type NodeOcctWorkerChannel,
  nodeOcctWorkerThreadEcho,
} from "./node-occt-worker";

const mm = (value: number) => length(value, "mm");

/**
 * A series of independent plate-with-bore scenes — enough OCCT work to span
 * many main-thread event loop turns, each scene a fixed, history-free cost.
 */
async function drillPlateSeries(
  client: WorkerClient,
  plates: number,
): Promise<void> {
  for (let plate = 0; plate < plates; plate += 1) {
    const sheet = await client.request("solid.createBox", {
      width: mm(30),
      depth: mm(20),
      height: mm(10),
    });
    const boreAtOrigin = await client.request("solid.createCylinder", {
      radius: mm(4),
      height: mm(10),
    });
    const bore = await client.request("solid.transform", {
      solid: boreAtOrigin.solid,
      translation: {
        x: mm(15),
        y: mm(10),
        z: mm(0),
      },
    });
    const drilled = await client.request("solid.subtract", {
      target: sheet.solid,
      tools: [bore.solid],
    });
    const volume = await client.request("solid.volume", {
      solid: drilled.solid,
    });
    if (!(volume.volume > 0)) {
      throw new Error("The drilled plate must have positive volume.");
    }
  }
}

describe("createNodeOcctWorkerChannel", () => {
  it(
    "hosts the kernel on a real worker thread, not the caller's",
    async () => {
      const channel = createNodeOcctWorkerChannel({ echoThreadId: true });
      try {
        // The echo is posted by the worker entry before hosting starts and
        // crosses the real channel as plain non-protocol data.
        const echoed = new Promise<number>((resolve, reject) => {
          channel.transport.onMessage((data) => {
            const threadId = nodeOcctWorkerThreadEcho(data);
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
        // the exact-band box volume only the real OCCT engine produces
        // (GProp integration carries last-ulp rounding, hence closeTo).
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
    },
    30_000,
  );

  it(
    "keeps the caller's event loop responsive while the worker computes a drill-plate series",
    async () => {
      const channel = createNodeOcctWorkerChannel();
      try {
        let seriesSettled = false;
        const heavy = drillPlateSeries(channel.client, 30).finally(() => {
          seriesSettled = true;
        });

        // Macrotask ticks only: if the kernel work ran on THIS thread
        // (synchronously or as microtasks), it would all complete before
        // the first setTimeout callback could fire, and concurrentTicks
        // would stay 0. A number > 0 can only be observed when the worker
        // computes while this loop keeps turning.
        let concurrentTicks = 0;
        while (!seriesSettled) {
          await new Promise((resolve) => setTimeout(resolve, 1));
          if (!seriesSettled) concurrentTicks += 1;
        }
        await heavy;

        expect(concurrentTicks).toBeGreaterThanOrEqual(5);
      } finally {
        await channel.close();
      }
    },
    60_000,
  );

  it(
    "close settles in-flight requests with worker/transport-closed and ends the thread cleanly",
    async () => {
      const channel = createNodeOcctWorkerChannel();
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
    },
    30_000,
  );

  it(
    "an abrupt terminate settles in-flight requests through the exit hook",
    async () => {
      const channel: NodeOcctWorkerChannel = createNodeOcctWorkerChannel();
      const inFlight = drillPlateSeries(channel.client, 30);
      // Attach the rejection handler before the thread dies, so the exit
      // hook's settlement never observes an unhandled rejection.
      const settled = expect(inFlight).rejects.toMatchObject({
        error: { code: WORKER_PROTOCOL_ERROR_CODES.transportClosed },
      });

      const exit = await channel.terminate();

      await settled;
      expect(exit.errorMessage).toBeNull();
    },
    60_000,
  );

  it(
    "exposes a request client whose results are kernel-neutral over the wire",
    async () => {
      const channel = createNodeOcctWorkerChannel();
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
    },
    30_000,
  );
});
