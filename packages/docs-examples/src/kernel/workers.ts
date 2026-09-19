/**
 * The `workers` guide's runnable example (docs/guides/workers.md): the
 * Node hosting path — a real `node:worker_threads` thread running the
 * Manifold worker entry, driven through the promise-based `WorkerClient`
 * over the versioned worker protocol. The example builds a box, unions a
 * translated sphere onto it, measures the result ON THE WORKER THREAD,
 * and shuts the channel down gracefully (in-flight requests settle with
 * `worker/transport-closed`, never a hang). The browser twin of the same
 * protocol is the `/docs` page's live worker example.
 */

import { length } from "@slopcad/cad-core";
import type { WorkerClient } from "@slopcad/cad-kernel";
import {
  createNodeManifoldWorkerChannel,
  type NodeManifoldWorkerChannel,
} from "@slopcad/cad-kernel-manifold/node-manifold-worker";

/** What the example reports back to the guide and the docs page. */
export interface WorkersExampleSummary {
  readonly workerThreadId: number;
  readonly boxVolumeMm3: number;
  readonly unionVolumeMm3: number;
  readonly boxOnWorkerThread: boolean;
  readonly closeSettledPendingRequests: number;
}

/**
 * Runs the worker round trip and reports the facts. `mainThreadId` is the
 * caller's own thread id (`threadId` from `node:worker_threads`, 0 in the
 * main thread) — the example proves the geometry executed on ANOTHER
 * thread, not the caller's.
 */
export async function runWorkersExample(
  mainThreadId: number,
): Promise<WorkersExampleSummary> {
  const channel: NodeManifoldWorkerChannel = createNodeManifoldWorkerChannel();
  try {
    const client: WorkerClient = channel.client;

    // Primitives and booleans, all executed on the worker thread.
    const box = await client.request("solid.createBox", {
      width: length(30),
      depth: length(20),
      height: length(10),
    });
    const bit = await client.request("solid.createSphere", {
      radius: length(5),
    });
    const placed = await client.request("solid.transform", {
      solid: bit.solid,
      translation: { x: length(30), y: length(0), z: length(0) },
    });
    const union = await client.request("solid.union", {
      operands: [box.solid, placed.solid],
    });
    const boxVolume = await client.request("solid.volume", {
      solid: box.solid,
    });
    const unionVolume = await client.request("solid.volume", {
      solid: union.solid,
    });

    // One pending request outstanding at close: the graceful close
    // settles it with `worker/transport-closed` instead of hanging.
    let settledPending = 0;
    const pending = client.request("solid.volume", { solid: union.solid }).then(
      () => "resolved" as const,
      (error) => {
        settledPending += 1;
        return String(error);
      },
    );
    await channel.close();
    await pending;

    return {
      workerThreadId: channel.threadId,
      boxVolumeMm3: boxVolume.volume,
      unionVolumeMm3: unionVolume.volume,
      boxOnWorkerThread: channel.threadId !== mainThreadId,
      closeSettledPendingRequests: settledPending,
    };
  } finally {
    // `close` is idempotent at the channel level; ensure the thread is
    // gone even when an assertion path skipped it.
    await channel.close();
  }
}
