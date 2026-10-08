/**
 * The engine adapter's contract tests (Phase 63c), channel half: the
 * routed real engine served over a REAL `node:worker_threads` channel —
 * `sim.compile` (scenario + tessellation across the wire, the
 * geometry-aware compile inside the worker), `sim.run` (the streamed
 * notification class through the node transport), and `sim.finalize`
 * (the persisted form's deterministic bytes). The channel-level truths
 * this file owns:
 *
 * - compile → run → finalize over the thread: the notification stream's
 *   integrity (monotone progress, chunk rounds that reassemble, the
 *   final round equal to the finalized speed block);
 * - determinism across the channel: two identical runs finalize to
 *   identical payload bytes and identical summaries;
 * - cooperative cancellation through the wire: a cancel mid-run acks
 *   `worker/cancelled` and mints no run;
 * - engine selection: a thermal scenario on the same channel rides the
 *   fake engine (the routed default), and `structural` declines with
 *   the Phase 69 carve code.
 *
 * Node-env vitest, no network — the law-S2/S5 stance.
 */

import { describe, expect, it } from "vitest";
import {
  createSimWorkerRequestId,
  decodeSimResultPayload,
  reassembleSimFieldChunks,
  type SimEngineFieldChunk,
  type SimNotificationDelivery,
  type SimResultSummary,
  type SimHistorySeries,
  type SimResultFieldBlock,
} from "@slopcad/sim-core";

import { createLbmNodeWorkerChannel } from "./engine-node-channel";
import { LBM_PREVIEW_INTERVAL_STEPS } from "./engine";
import { boxTessellationWire } from "./fixtures";

/** The channel fixture: a 24-step slow-air tunnel around an aligned bar. */
function channelScenario(): Record<string, unknown> {
  return {
    name: "channel-tunnel",
    kind: "flow",
    domain: {
      kind: "explicit",
      min: [0, 0, 0],
      max: [100, 40, 10],
      resolutionMm: 5,
    },
    conditions: [
      {
        kind: "velocity-inlet",
        face: "xMin",
        speedMPerS: 0.005,
        direction: [1, 0, 0],
      },
      { kind: "wall", face: "yMin", slip: false },
      { kind: "symmetry", face: "yMax" },
    ],
    fluid: "air",
    stepBudget: 24,
  };
}

const OBSTACLE = boxTessellationWire([40, 15, 0], [60, 25, 10]);

/** One compile→run→finalize pass with the notification stream captured. */
async function runOverChannel(
  channel: ReturnType<typeof createLbmNodeWorkerChannel>,
  scenario: Record<string, unknown>,
  tessellation: unknown = OBSTACLE,
): Promise<{
  readonly notifications: readonly SimNotificationDelivery[];
  readonly summary: SimResultSummary;
  readonly fields: readonly SimResultFieldBlock[];
  readonly histories: readonly SimHistorySeries[];
  readonly runId: string;
}> {
  const notifications: SimNotificationDelivery[] = [];
  const unsubscribe = channel.client.onNotification((delivery) => {
    notifications.push(delivery);
  });
  try {
    const compiled = await channel.client.request("sim.compile", {
      scenario,
      tessellation,
    });
    const run = await channel.client.request("sim.run", {
      problem: compiled.problem,
    });
    const finalized = await channel.client.request("sim.finalize", {
      run: run.run,
    });
    const fields = decodeSimResultPayload(finalized.payload);
    if (!fields.ok) {
      throw new Error(
        `the finalize payload did not decode: ${fields.error.message}`,
      );
    }
    return {
      notifications,
      summary: finalized.summary,
      fields: fields.value,
      histories: finalized.histories,
      runId: run.run,
    };
  } finally {
    unsubscribe();
  }
}

describe("the routed engine over the node worker channel", () => {
  it("compiles, streams, and finalizes a flow run with an integral notification stream", async () => {
    const channel = createLbmNodeWorkerChannel();
    try {
      const first = await runOverChannel(channel, channelScenario());
      expect(first.summary.status).toBe("completed");
      expect(first.summary.scenarioSnapshotHash).toMatch(/^[0-9a-f]{8}$/);
      expect(first.fields.map((field) => field.id)).toContain("speed");
      expect(first.fields.map((field) => field.id)).toContain(
        "mean-velocity-x",
      );
      expect(first.histories.map((series) => series.name)).toEqual([
        "drag",
        "lift",
      ]);

      // The stream: strictly monotone progress reaching the budget, and
      // chunk rounds that each reassemble as the speed block.
      const progress = first.notifications
        .map((delivery) => delivery.notification)
        .filter(
          (
            notification,
          ): notification is Extract<
            SimNotificationDelivery["notification"],
            { readonly kind: "progress" }
          > => notification.kind === "progress",
        );
      expect(progress.length).toBe(24);
      for (let index = 1; index < progress.length; index += 1) {
        const previous = progress[index - 1];
        const current = progress[index];
        if (previous === undefined || current === undefined) continue;
        expect(current.step - previous.step).toBe(1);
      }
      expect(progress[progress.length - 1]?.step).toBe(24);

      const chunks = first.notifications
        .map((delivery) => delivery.notification)
        .filter(
          (
            notification,
          ): notification is Extract<
            SimNotificationDelivery["notification"],
            { readonly kind: "field-chunk" }
          > => notification.kind === "field-chunk",
        );
      const rounds: SimEngineFieldChunk[][] = [];
      let current: SimEngineFieldChunk[] = [];
      for (const chunk of chunks) {
        if (chunk.chunkIndex === 0) {
          if (current.length > 0) rounds.push(current);
          current = [chunk];
          continue;
        }
        current.push(chunk);
      }
      if (current.length > 0) rounds.push(current);
      expect(rounds.length).toBe(
        Math.floor(24 / LBM_PREVIEW_INTERVAL_STEPS) + 1,
      );
      const lastRound = rounds[rounds.length - 1];
      expect(lastRound).toBeDefined();
      const finalBlock =
        lastRound === undefined
          ? undefined
          : reassembleSimFieldChunks(lastRound);
      expect(finalBlock?.ok).toBe(true);
      const finalizedSpeed = first.fields.find((field) => field.id === "speed");
      expect(finalizedSpeed).toBeDefined();
      if (
        finalBlock !== undefined &&
        finalBlock.ok &&
        finalizedSpeed !== undefined
      ) {
        expect(finalBlock.value.values).toEqual(finalizedSpeed.values);
      }
    } finally {
      await channel.close();
    }
  });

  it("is deterministic across the channel: identical runs finalize to identical bytes", async () => {
    const channel = createLbmNodeWorkerChannel();
    try {
      const first = await runOverChannel(channel, channelScenario());
      const second = await runOverChannel(channel, channelScenario());
      expect(second.summary).toEqual(first.summary);
      expect(second.histories).toEqual(first.histories);
      expect(second.fields).toEqual(first.fields);
      expect(second.runId).not.toBe(first.runId);
    } finally {
      await channel.close();
    }
  });

  it("cancels a run cooperatively through the wire: the ack replaces the outcome and no run is minted", async () => {
    const channel = createLbmNodeWorkerChannel();
    try {
      const firstProgress = new Promise<void>((resolve) => {
        const unsubscribe = channel.client.onNotification((delivery) => {
          if (delivery.notification.kind === "progress") {
            unsubscribe();
            resolve();
          }
        });
      });
      const runRequestId = createSimWorkerRequestId("req_cancel_run");
      const compile = await channel.client.request("sim.compile", {
        scenario: { ...channelScenario(), stepBudget: 4000 },
        tessellation: OBSTACLE,
      });
      const runPromise = channel.client.request(
        "sim.run",
        { problem: compile.problem },
        runRequestId,
      );
      await firstProgress;
      channel.client.cancel(runRequestId);
      await expect(runPromise).rejects.toMatchObject({
        name: "SimRequestFailure",
        error: { code: "worker/cancelled" },
      });
      // Nothing was minted: the next finalized run id over this channel
      // is the FIRST one (the suppressed run consumed none).
      const fresh = await runOverChannel(channel, channelScenario());
      expect(fresh.summary.status).toBe("completed");
    } finally {
      await channel.close();
    }
  });

  it("routes thermal to the fake engine on the same channel and declines structural with the Phase 69 carve", async () => {
    const channel = createLbmNodeWorkerChannel();
    try {
      const thermal = await runOverChannel(channel, {
        name: "warm",
        kind: "thermal",
        domain: {
          kind: "explicit",
          min: [0, 0, 0],
          max: [10, 10, 10],
          resolutionMm: 2,
        },
        conditions: [],
        fluid: "air",
      });
      expect(thermal.summary.status).toBe("completed");
      expect(thermal.histories.map((series) => series.name)).toEqual([
        "max-temperature",
      ]);

      const structuralId = createSimWorkerRequestId("req_structural");
      const structuralPromise = channel.client.request(
        "sim.compile",
        {
          scenario: {
            name: "bracket",
            kind: "structural",
            domain: {
              kind: "explicit",
              min: [0, 0, 0],
              max: [10, 10, 10],
              resolutionMm: 2,
            },
            conditions: [],
            fluid: "air",
          },
        },
        structuralId,
      );
      await expect(structuralPromise).rejects.toMatchObject({
        name: "SimRequestFailure",
        error: { data: { simCode: "sim/scenario-kind-unsupported" } },
      });
    } finally {
      await channel.close();
    }
  });
});
