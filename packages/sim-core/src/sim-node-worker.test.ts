/**
 * Real-worker integration tests (Phase 61b): the full `sim.*` pipeline —
 * compile → run (progress and field-chunk notifications streaming over the
 * real channel) → finalize — executed by the fake engine inside a REAL
 * `node:worker_threads` thread, reached only through the sim worker
 * protocol over the node transport adapter (`node-manifold-worker`'s
 * suite pattern, carried to the sim channel). Every test owns a fresh
 * channel so the session's minted ids are deterministic per test.
 *
 * Everything the in-memory suites pinned is here demanded of the actual
 * channel: notifications arrive on the main thread with the request
 * correlation intact; the finalized payload bytes equal the SMR1 encoding
 * of the reassembled final chunk round (the losslessness claim, end to
 * end); mid-run cancellation settles with the `worker/cancelled` ack; an
 * abrupt `terminate()` settles in-flight requests with
 * `worker/transport-closed`; the test-only hosting-failure mode surfaces
 * through the boot-failure report in the exit; and two fresh channels
 * running the same scenario produce identical wire notification streams —
 * the notification byte stream's determinism claim, on repeat runs.
 */

import { describe, expect, it } from "vitest";
import type { SimEngineFieldChunk } from "./engine";
import type { SimNotificationDelivery } from "./sim-worker-protocol";
import type { SimRunId } from "./sim-worker-ids";

import { reassembleSimFieldChunks } from "./sim-field-chunks";
import { type SimResultFieldBlock, encodeSimResultPayload } from "./sim-result";
import { createSimNodeWorkerChannel } from "./sim-node-worker";
import { createSimWorkerRequestId, parseSimRunId } from "./sim-worker-ids";

function runId(raw: string): SimRunId {
  const parsed = parseSimRunId(raw);
  if (!parsed.ok) throw new Error("test run id must parse");
  return parsed.value;
}

function flowScenario(): Record<string, unknown> {
  return {
    id: "sim_000001",
    name: "Wind tunnel",
    kind: "flow",
    domain: {
      kind: "explicit",
      min: [-500, -250, -250],
      max: [500, 250, 250],
      resolutionMm: 2,
    },
    conditions: [
      {
        kind: "velocity-inlet",
        face: "xMin",
        speedMPerS: 10,
        direction: [1, 0, 0],
      },
      { kind: "pressure-outlet", face: "xMax", pressurePa: 0 },
    ],
    fluid: "air",
    materials: [],
  };
}

/** One full pipeline over a fresh channel, with the delivered notifications collected. */
async function pipelineScenario(): Promise<{
  readonly notifications: readonly SimNotificationDelivery[];
  readonly finalizePayload: Uint8Array;
  readonly steps: number;
  readonly chunks: number;
}> {
  const channel = createSimNodeWorkerChannel();
  const notifications: SimNotificationDelivery[] = [];
  const unsubscribe = channel.client.onNotification((delivery) => {
    notifications.push(delivery);
  });
  const compiled = await channel.client.request("sim.compile", {
    scenario: flowScenario(),
  });
  expect(compiled.problem).toBe("wprob_000001");
  const run = await channel.client.request("sim.run", {
    problem: compiled.problem,
  });
  const finalized = await channel.client.request("sim.finalize", {
    run: run.run,
  });
  unsubscribe();
  await channel.close();
  return {
    notifications,
    finalizePayload: finalized.payload,
    steps: run.steps,
    chunks: run.chunks,
  };
}

/** Reassembles each field's final chunk round into its finalized block. */
function finalRoundBlocks(
  notifications: readonly SimNotificationDelivery[],
): readonly SimResultFieldBlock[] {
  const perField = new Map<string, SimEngineFieldChunk[]>();
  for (const delivery of notifications) {
    if (delivery.notification.kind !== "field-chunk") continue;
    const bucket = perField.get(delivery.notification.id) ?? [];
    bucket.push(delivery.notification);
    perField.set(delivery.notification.id, bucket);
  }
  const blocks: SimResultFieldBlock[] = [];
  for (const stream of perField.values()) {
    const first = stream[0];
    if (first === undefined) throw new Error("a streamed field has no chunks");
    const finalRound = stream.slice(-first.chunkCount);
    const reassembled = reassembleSimFieldChunks(finalRound);
    if (!reassembled.ok) throw new Error(reassembled.error.message);
    blocks.push(reassembled.value);
  }
  return blocks;
}

describe("the sim worker over a real node worker channel", () => {
  it("runs the full compile → run → finalize pipeline with a streamed notification channel", async () => {
    const channel = createSimNodeWorkerChannel();
    const notifications: SimNotificationDelivery[] = [];
    const unsubscribe = channel.client.onNotification((delivery) => {
      notifications.push(delivery);
    });
    const compiled = await channel.client.request("sim.compile", {
      scenario: flowScenario(),
    });
    expect(compiled.compiled.domainMinM).toEqual([-0.5, -0.25, -0.25]);
    expect(compiled.compiled.regime.prandtl).toBeDefined();

    const run = await channel.client.request("sim.run", {
      problem: compiled.problem,
    });
    expect(run.steps).toBe(24);
    // Two fields per round, four chunks each, three rounds.
    expect(run.chunks).toBe(24);
    const progress = notifications.filter(
      (delivery) => delivery.notification.kind === "progress",
    );
    const chunks = notifications.filter(
      (delivery) => delivery.notification.kind === "field-chunk",
    );
    expect(progress.length).toBe(24);
    expect(chunks.length).toBe(24);
    unsubscribe();

    const finalized = await channel.client.request("sim.finalize", {
      run: run.run,
    });
    expect(finalized.summary.status).toBe("completed");
    expect(finalized.summary.scenarioSnapshotHash).toBe(
      compiled.compiled.scenarioSnapshotHash,
    );
    // The final chunk round of every field reassembles to exactly the
    // blocks the finalized payload carries — the lossless streaming claim,
    // over the real channel, byte for byte.
    const decoded = encodeSimResultPayload(finalRoundBlocks(notifications));
    if (!decoded.ok) throw new Error(decoded.error.message);
    expect(decoded.value).toEqual(finalized.payload);
    await channel.close();
  });

  it("settles a mid-run cancellation with the worker/cancelled ack and finalizes nothing", async () => {
    const channel = createSimNodeWorkerChannel();
    const compiled = await channel.client.request("sim.compile", {
      scenario: flowScenario(),
    });
    const adoptedId = createSimWorkerRequestId("req_cancel-run");
    const runPromise = channel.client.request(
      "sim.run",
      { problem: compiled.problem },
      adoptedId,
    );
    // The fake engine yields one macrotask per step, so the cancel lands
    // mid-run; the promise settles with the caller-side void immediately.
    await new Promise((resolve) => setTimeout(resolve, 0));
    channel.client.cancel(adoptedId);
    await expect(runPromise).rejects.toMatchObject({
      error: { code: "worker/cancelled" },
    });
    // The suppressed run minted no run id: the session's first run id
    // declines as unknown.
    await expect(
      channel.client.request("sim.finalize", { run: runId("wrun_000001") }),
    ).rejects.toMatchObject({
      error: {
        code: "worker/operation-failed",
        data: { simCode: "sim/run-unknown" },
      },
    });
    await channel.close();
  });

  it("settles in-flight requests with worker/transport-closed when the thread dies", async () => {
    const doomed = createSimNodeWorkerChannel();
    const compiled = await doomed.client.request("sim.compile", {
      scenario: flowScenario(),
    });
    const runPromise = doomed.client.request("sim.run", {
      problem: compiled.problem,
    });
    const exit = doomed.terminate();
    await expect(runPromise).rejects.toMatchObject({
      error: { code: "worker/transport-closed" },
    });
    await exit;
  });

  it("surfaces the test-only hosting failure through the boot-failure report in the exit", async () => {
    const failing = createSimNodeWorkerChannel({ failBoot: true });
    const pending = failing.client.request("sim.compile", {
      scenario: flowScenario(),
    });
    const exit = await failing.exited;
    await expect(pending).rejects.toMatchObject({
      error: { code: "worker/transport-closed" },
    });
    expect(exit.bootFailureMessage).toContain("hosting the sim engine failed");
    expect(exit.bootFailureMessage).toContain("SLOPCAD_SIM_WORKER_FAIL_BOOT");
  });

  it("produces identical wire notification streams for repeat runs over fresh channels", async () => {
    const first = await pipelineScenario();
    const second = await pipelineScenario();
    expect(second.steps).toBe(first.steps);
    expect(second.chunks).toBe(first.chunks);
    expect(second.notifications).toEqual(first.notifications);
    expect(second.finalizePayload).toEqual(first.finalizePayload);
  });
});
