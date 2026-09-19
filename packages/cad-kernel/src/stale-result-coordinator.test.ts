/**
 * The stale-result coordinator (Phase 10.4): the plan's two validation
 * criteria — request A followed by B with A completing later leaves B visible,
 * and cancellation/replacement does not corrupt worker state — plus the burst,
 * leak, and health races, all staged deterministically.
 *
 * Two harnesses, no timers, no real threads:
 *
 * - **Hand delivery** — the in-memory transport with the test playing the
 *   responder: successes and errors for chosen request ids are delivered by
 *   hand in explicitly chosen adversarial orders (the technique the Phase
 *   10.2 client tests established), while a minimal harness responder answers
 *   the channel's disposal traffic (acknowledging it, refusing it, or
 *   holding it for a hand-delivered answer — see `DisposalMode`).
 * - **Real session** — the full in-memory stack (fake kernel, worker server,
 *   client, coordinator) with FIFO delivery, where staleness arises from
 *   supersession and leaks are probed semantically: a released solid answers
 *   `kernel/solid-not-owned`, a live one measures.
 */

import { describe, expect, it } from "vitest";
import { length } from "@slopcad/cad-core";
import type {
  ComputationContext,
  ComputationOutcome,
  StaleResultCoordinator,
  SupersededComputationPolicy,
} from "./stale-result-coordinator";
import type { WorkerClient } from "./worker-client";
import type {
  WorkerIdGenerator,
  WorkerRequestId,
  WorkerSolidId,
} from "./worker-ids";
import type {
  WorkerSolidResult,
  WorkerVolumeResult,
} from "./worker-operations";
import type { WorkerRequestMessage } from "./worker-protocol";

import { createFakeKernel } from "./fake-kernel";
import { DIAGNOSTIC_LOG_CAPACITY } from "./diagnostic-log";
import {
  bootWorkerChannel,
  type WorkerBootFailure,
  type WorkerCrashPort,
} from "./worker-boot";
import { createStaleResultCoordinator } from "./stale-result-coordinator";
import { createWorkerClient, WorkerRequestFailure } from "./worker-client";
import { workerError } from "./worker-errors";
import {
  createWorkerRequestId,
  createWorkerSolidId,
  createWorkerIdGenerator,
} from "./worker-ids";
import { parseWorkerOperationInput } from "./worker-operations";
import {
  createWorkerErrorResponse,
  createWorkerSuccessResponse,
  parseWorkerMessage,
} from "./worker-protocol";
import { createInMemoryKernelSession } from "./worker-session";
import { createInMemoryTransportPair } from "./worker-transport";

const mm = (value: number) => length(value, "mm");

const flush = async (ticks = 16): Promise<void> => {
  for (let tick = 0; tick < ticks; tick += 1) await Promise.resolve();
};

const boxInput = { width: mm(2), depth: mm(3), height: mm(4) };

const boxComputation = (
  context: ComputationContext,
): Promise<WorkerSolidResult> => context.request("solid.createBox", boxInput);

const failingComputation = (
  context: ComputationContext,
): Promise<WorkerSolidResult> =>
  context.request("solid.createSphere", { radius: mm(-1) });

/** The n-th session solid id, matching the fake kernel's deterministic mint. */
const solidIdOf = (n: number): WorkerSolidId =>
  createWorkerSolidId(`wsol_${String(n).padStart(6, "0")}`);

/** The n-th request id, matching the coordinator's deterministic generator. */
const requestIdOf = (n: number): WorkerRequestId =>
  createWorkerRequestId(`req_${String(n).padStart(6, "0")}`);

/**
 * How the hand-delivery harness answers the coordinator's (and the client's)
 * disposal traffic: `"succeed"` acknowledges every disposal (the default the
 * existing races rely on), `"refuse"` answers each with a structured error
 * (bulk refusals, for the disposal-failure bookkeeping), and `"hold"` records
 * the request and stays silent so the test can answer it by hand.
 */
type DisposalMode = "succeed" | "refuse" | "hold";

interface HandDeliveryHarness {
  readonly coordinator: StaleResultCoordinator<WorkerSolidResult>;
  /** Every request the coordinator sent, parsed, in wire order. */
  readonly requests: WorkerRequestMessage[];
  /** Request ids the coordinator cancelled, in order. */
  readonly cancelled: WorkerRequestId[];
  /** Solid ids whose disposal was issued over the channel, in order. */
  readonly disposed: WorkerSolidId[];
  /** Delivers a responder message to the client exactly as a worker would. */
  deliver(data: unknown): void;
}

function handDeliveryHarness(
  superseded: SupersededComputationPolicy,
  disposals: DisposalMode = "succeed",
): HandDeliveryHarness {
  const pair = createInMemoryTransportPair();
  const requests: WorkerRequestMessage[] = [];
  const cancelled: WorkerRequestId[] = [];
  const disposed: WorkerSolidId[] = [];
  // A minimal responder for the coordinator's own disposal traffic only —
  // every other response is hand-delivered by the test in its chosen order.
  pair.server.onMessage((data) => {
    const parsed = parseWorkerMessage(data);
    if (!parsed.ok) return;
    if (parsed.value.kind === "cancel") {
      cancelled.push(parsed.value.requestId);
      return;
    }
    if (parsed.value.kind !== "request") return;
    requests.push(parsed.value);
    if (parsed.value.operation === "solid.dispose") {
      const input = parseWorkerOperationInput(
        "solid.dispose",
        parsed.value.input,
      );
      if (!input.ok) {
        throw new Error("The coordinator sent a malformed dispose input.");
      }
      disposed.push(input.value.solid);
      if (disposals === "hold") return; // the test answers this one by hand
      pair.server.send(
        disposals === "refuse"
          ? createWorkerErrorResponse(
              parsed.value.requestId,
              workerError(
                "worker/operation-failed",
                "The session refused the disposal.",
                { kernelCode: "kernel/solid-not-owned" },
              ),
            )
          : createWorkerSuccessResponse(
              parsed.value.requestId,
              "solid.dispose",
              null,
            ),
      );
    }
  });
  const client = createWorkerClient({ transport: pair.client });
  const coordinator = createStaleResultCoordinator<WorkerSolidResult>({
    client,
    superseded,
  });
  return {
    coordinator,
    requests,
    cancelled,
    disposed,
    deliver: (data) => pair.server.send(data),
  };
}

/** The request id of the `updateIndex`-th box computation on the wire. */
function boxRequestOf(
  harness: HandDeliveryHarness,
  updateIndex: number,
): WorkerRequestId {
  const boxRequests = harness.requests.filter(
    (message) => message.operation === "solid.createBox",
  );
  const found = boxRequests[updateIndex];
  if (found === undefined) {
    throw new Error(`No box request for update index ${String(updateIndex)}.`);
  }
  return found.requestId;
}

/** Delivers a successful box result: request `updateIndex` resolves to solid `n`. */
function deliverBoxResult(
  harness: HandDeliveryHarness,
  updateIndex: number,
  n: number,
): void {
  harness.deliver(
    createWorkerSuccessResponse(
      boxRequestOf(harness, updateIndex),
      "solid.createBox",
      {
        solid: solidIdOf(n),
      },
    ),
  );
}

function failureOf(promise: Promise<unknown>): Promise<WorkerRequestFailure> {
  return promise.then(
    () => {
      throw new Error("Expected the update to fail.");
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

/** Extracts a dropped outcome or fails the test — for narrow type-safe reads. */
function droppedOf(
  outcome: ComputationOutcome<WorkerSolidResult>,
): Exclude<ComputationOutcome<WorkerSolidResult>, { outcome: "applied" }> {
  if (outcome.outcome !== "dropped") {
    throw new Error("Expected the outcome to be dropped.");
  }
  return outcome;
}

describe("coordinator over hand-delivered resolutions", () => {
  it("leaves B visible when A completes later — the plan's first criterion", async () => {
    const harness = handDeliveryHarness("complete");
    // Both dispatched before any resolution: stamps are the dispatch order.
    const a = harness.coordinator.update(boxComputation);
    const b = harness.coordinator.update(boxComputation);
    await flush();
    expect(boxRequestOf(harness, 0)).toBe(requestIdOf(1));
    expect(boxRequestOf(harness, 1)).toBe(requestIdOf(2));

    // B's result is delivered and applied first…
    deliverBoxResult(harness, 1, 2);
    await flush();
    // …then A's result arrives late, from the older revision.
    deliverBoxResult(harness, 0, 1);

    const [outcomeA, outcomeB] = await Promise.all([a, b]);
    expect(outcomeB).toEqual({
      outcome: "applied",
      revision: 2,
      result: { solid: solidIdOf(2) },
    });
    expect(outcomeA).toEqual({
      outcome: "dropped",
      revision: 1,
      reason: "superseded",
      currentRevision: 2,
    });
    expect(harness.coordinator.visible()?.revision).toBe(2);
    expect(harness.coordinator.visible()?.state.solid).toBe(solidIdOf(2));
    // The stale solid was disposed over the channel; the visible one stands.
    expect(harness.disposed).toEqual([solidIdOf(1)]);
    expect(harness.coordinator.drops()).toEqual([
      {
        outcome: "dropped",
        revision: 1,
        reason: "superseded",
        currentRevision: 2,
      },
    ]);
  });

  it("survives a burst of 12 updates with shuffled resolutions — newest visible, every stale drop observable", async () => {
    const harness = handDeliveryHarness("complete");
    const outcomes: Array<Promise<ComputationOutcome<WorkerSolidResult>>> = [];
    for (let update = 0; update < 12; update += 1) {
      outcomes.push(harness.coordinator.update(boxComputation));
    }
    await flush();

    // A fixed adversarial permutation: newest first, oldest last, mixed after.
    const shuffle = [12, 3, 7, 1, 11, 2, 9, 4, 10, 6, 5, 8];
    for (const revision of shuffle) {
      deliverBoxResult(harness, revision - 1, revision);
    }

    const settled = await Promise.all(outcomes);
    const applied = settled.filter((outcome) => outcome.outcome === "applied");
    expect(applied).toEqual([
      { outcome: "applied", revision: 12, result: { solid: solidIdOf(12) } },
    ]);
    const droppedRevisions = settled
      .filter((outcome) => outcome.outcome === "dropped")
      .map((outcome) => outcome.revision)
      .sort((x, y) => x - y);
    expect(droppedRevisions).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);

    expect(harness.coordinator.visible()?.state.solid).toBe(solidIdOf(12));
    expect(harness.coordinator.drops()).toHaveLength(11);
    for (const drop of harness.coordinator.drops()) {
      expect(drop.reason).toBe("superseded");
      expect(drop.currentRevision).toBe(12);
    }
    // Every stale computation's solid was disposed; the visible one was not.
    expect([...harness.disposed].sort()).toEqual(
      [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11].map(solidIdOf),
    );
    expect(harness.disposed).not.toContain(solidIdOf(12));
  });

  it("releases replaced and dropped solids when progressive updates interleave with a burst", async () => {
    const harness = handDeliveryHarness("complete");

    // Updates 1–5 are dispatched and resolved one by one: each is current when
    // its result arrives, so each applies and is then replaced by the next.
    for (let revision = 1; revision <= 5; revision += 1) {
      const outcome = harness.coordinator.update(boxComputation);
      await flush();
      deliverBoxResult(harness, revision - 1, revision);
      const settled = await outcome;
      expect(settled).toEqual({
        outcome: "applied",
        revision,
        result: { solid: solidIdOf(revision) },
      });
    }

    // Updates 6–10 burst, and their resolutions arrive shuffled.
    const burst: Array<Promise<ComputationOutcome<WorkerSolidResult>>> = [];
    for (let revision = 6; revision <= 10; revision += 1) {
      burst.push(harness.coordinator.update(boxComputation));
    }
    await flush();
    for (const revision of [10, 6, 9, 7, 8]) {
      deliverBoxResult(harness, revision - 1, revision);
    }
    const settledBurst = await Promise.all(burst);

    const appliedRevisions = settledBurst
      .filter((outcome) => outcome.outcome === "applied")
      .map((outcome) => outcome.revision);
    expect(appliedRevisions).toEqual([10]);
    expect(harness.coordinator.visible()?.state.solid).toBe(solidIdOf(10));
    expect(
      settledBurst
        .filter((outcome) => outcome.outcome === "dropped")
        .map((outcome) => outcome.revision)
        .sort((x, y) => x - y),
    ).toEqual([6, 7, 8, 9]);

    // Replaced (1–5) and dropped (6–9) solids were all disposed; only the
    // visible revision's solid survives in the session.
    expect([...harness.disposed].sort()).toEqual(
      [1, 2, 3, 4, 5, 6, 7, 8, 9].map(solidIdOf),
    );
    expect(harness.disposed).not.toContain(solidIdOf(10));
    expect(harness.coordinator.disposalFailures()).toEqual([]);
  });

  it("cancels superseded requests under the cancel policy and voids their late successes", async () => {
    const harness = handDeliveryHarness("cancel");
    const a = harness.coordinator.update(boxComputation);
    await flush();
    const b = harness.coordinator.update(boxComputation);
    await flush();

    // A's pending request was cancelled at B's dispatch — on the wire.
    expect(harness.cancelled).toEqual([requestIdOf(1)]);
    // The late success for the cancelled request loses the race: it is
    // discarded client-side (the pinned Phase 10.2 rule), so the coordinator
    // never learns its mint — and the client's discard hygiene disposes that
    // orphaned mint on the spot instead of leaking it.
    deliverBoxResult(harness, 0, 1);
    deliverBoxResult(harness, 1, 2);

    const [outcomeA, outcomeB] = await Promise.all([a, b]);
    expect(outcomeB).toEqual({
      outcome: "applied",
      revision: 2,
      result: { solid: solidIdOf(2) },
    });
    const dropped = droppedOf(outcomeA);
    expect(dropped.revision).toBe(1);
    expect(dropped.failure?.error.code).toBe("worker/cancelled");
    expect(harness.coordinator.visible()?.state.solid).toBe(solidIdOf(2));
    expect(harness.disposed).toEqual([solidIdOf(1)]);
    expect(harness.coordinator.drops()).toHaveLength(1);
  });

  it("rejects with the structured failure when the computation fails while current", async () => {
    const harness = handDeliveryHarness("complete");
    const outcome = harness.coordinator.update(failingComputation);
    await flush();

    const sphereRequest = harness.requests.find(
      (message) => message.operation === "solid.createSphere",
    );
    if (sphereRequest === undefined) {
      throw new Error(
        "Expected the failing computation's request on the wire.",
      );
    }
    harness.deliver(
      createWorkerErrorResponse(
        sphereRequest.requestId,
        workerError("worker/operation-failed", "The sphere was rejected.", {
          kernelCode: "kernel/invalid-length",
        }),
      ),
    );

    const failure = await failureOf(outcome);
    expect(failure.error.code).toBe("worker/operation-failed");
    expect(failure.error.data).toEqual({ kernelCode: "kernel/invalid-length" });
    expect(harness.coordinator.visible()).toBeNull();
    expect(harness.coordinator.drops()).toEqual([]);
  });

  it("resolves a superseded computation's failure as dropped, not as an error", async () => {
    const harness = handDeliveryHarness("complete");
    const a = harness.coordinator.update(failingComputation);
    await flush();
    const b = harness.coordinator.update(boxComputation);
    await flush();

    // A's error response arrives after B was dispatched: void, not actionable.
    const sphereRequest = harness.requests.find(
      (message) => message.operation === "solid.createSphere",
    );
    if (sphereRequest === undefined) {
      throw new Error(
        "Expected the failing computation's request on the wire.",
      );
    }
    harness.deliver(
      createWorkerErrorResponse(
        sphereRequest.requestId,
        workerError("worker/operation-failed", "The sphere was rejected.", {
          kernelCode: "kernel/invalid-length",
        }),
      ),
    );
    deliverBoxResult(harness, 0, 2);

    const [outcomeA, outcomeB] = await Promise.all([a, b]);
    expect(outcomeB.outcome).toBe("applied");
    const dropped = droppedOf(outcomeA);
    expect(dropped.failure?.error.data).toEqual({
      kernelCode: "kernel/invalid-length",
    });
    expect(harness.coordinator.visible()?.state.solid).toBe(solidIdOf(2));
  });

  it("releases a late mint that lands after the computation failed and settled — no late-mint leak", async () => {
    const harness = handDeliveryHarness("complete");
    const pipeline = (
      context: ComputationContext,
    ): Promise<WorkerSolidResult> => {
      // A trailing request the computation never awaits: its success is still
      // in flight when the failure settles the update — whatever it mints
      // will arrive for a computation that is already sealed.
      void context.request("solid.createBox", boxInput);
      return context.request("solid.createSphere", { radius: mm(-1) });
    };
    const outcome = harness.coordinator.update(pipeline);
    await flush();

    const sphereRequest = harness.requests.find(
      (message) => message.operation === "solid.createSphere",
    );
    if (sphereRequest === undefined) {
      throw new Error("Expected the failing request on the wire.");
    }
    harness.deliver(
      createWorkerErrorResponse(
        sphereRequest.requestId,
        workerError("worker/operation-failed", "The sphere was rejected.", {
          kernelCode: "kernel/invalid-length",
        }),
      ),
    );

    // The failure settles while current: the update rejects, the computation
    // is sealed with an empty mint set, and nothing is outstanding.
    const failure = await failureOf(outcome);
    expect(failure.error.code).toBe("worker/operation-failed");
    expect(harness.disposed).toEqual([]);

    // Only NOW the trailing success crosses — a late mint, garbage by
    // definition, disposed immediately at its recording site.
    const boxRequest = harness.requests.find(
      (message) => message.operation === "solid.createBox",
    );
    if (boxRequest === undefined) {
      throw new Error("Expected the trailing request on the wire.");
    }
    harness.deliver(
      createWorkerSuccessResponse(boxRequest.requestId, "solid.createBox", {
        solid: solidIdOf(1),
      }),
    );
    await flush();
    expect(harness.disposed).toEqual([solidIdOf(1)]);
    expect(harness.coordinator.disposalFailures()).toEqual([]);
    expect(harness.coordinator.visible()).toBeNull();
    expect(harness.coordinator.drops()).toEqual([]);
  });

  it("records a refused disposal in disposalFailures instead of throwing", async () => {
    // "hold": the disposal crosses the wire but the harness stays silent, so
    // the refusal is injected exactly as the channel would deliver it.
    const harness = handDeliveryHarness("complete", "hold");
    const appliedA = harness.coordinator.update(boxComputation);
    await flush();
    deliverBoxResult(harness, 0, 1);
    await expect(appliedA).resolves.toEqual({
      outcome: "applied",
      revision: 1,
      result: { solid: solidIdOf(1) },
    });

    // B applies and releases A's replaced solid; the channel refuses.
    const appliedB = harness.coordinator.update(boxComputation);
    await flush();
    deliverBoxResult(harness, 1, 2);
    await flush(); // B's release path issues the disposal, and holds for it
    const disposeRequest = harness.requests.find(
      (message) => message.operation === "solid.dispose",
    );
    if (disposeRequest === undefined) {
      throw new Error("Expected the replaced state's disposal on the wire.");
    }
    harness.deliver(
      createWorkerErrorResponse(
        disposeRequest.requestId,
        workerError(
          "worker/operation-failed",
          "The session refused the disposal.",
          { kernelCode: "kernel/solid-not-owned" },
        ),
      ),
    );

    // The refusal is observable and settles nothing destructively: B still
    // applied, the visible state is B's, and nothing threw.
    await expect(appliedB).resolves.toEqual({
      outcome: "applied",
      revision: 2,
      result: { solid: solidIdOf(2) },
    });
    expect(harness.coordinator.disposalFailures()).toHaveLength(1);
    const refusal = harness.coordinator.disposalFailures()[0];
    expect(refusal?.error.code).toBe("worker/operation-failed");
    expect(refusal?.error.data).toEqual({
      kernelCode: "kernel/solid-not-owned",
    });
    expect(harness.coordinator.visible()?.state.solid).toBe(solidIdOf(2));
    expect(harness.coordinator.drops()).toEqual([]);
  });

  it("bounds its drop and disposal-failure diagnostics to the diagnostic window", async () => {
    const harness = handDeliveryHarness("complete", "refuse");
    const total = DIAGNOSTIC_LOG_CAPACITY + 12;
    const outcomes: Array<Promise<ComputationOutcome<WorkerSolidResult>>> = [];
    for (let update = 0; update < total; update += 1) {
      outcomes.push(harness.coordinator.update(boxComputation));
    }
    await flush();

    // Every result but the newest's arrives first: each is stale, each mint
    // is disposed, and every disposal is refused — flooding both logs.
    for (let update = 0; update < total - 1; update += 1) {
      deliverBoxResult(harness, update, update + 1);
    }
    deliverBoxResult(harness, total - 1, total);
    await Promise.all(outcomes);

    const drops = harness.coordinator.drops();
    expect(drops).toHaveLength(DIAGNOSTIC_LOG_CAPACITY);
    // The newest window survived in settle order; the oldest 11 drops were
    // superseded by the bound.
    expect(drops[0]?.revision).toBe(total - DIAGNOSTIC_LOG_CAPACITY);
    expect(drops[drops.length - 1]?.revision).toBe(total - 1);

    const failures = harness.coordinator.disposalFailures();
    expect(failures).toHaveLength(DIAGNOSTIC_LOG_CAPACITY);
    for (const refusal of failures) {
      expect(refusal.error.code).toBe("worker/operation-failed");
    }
    expect(harness.coordinator.visible()?.state.solid).toBe(solidIdOf(total));
  });

  it("sinks the coordinator's own cancellation of a fire-and-forget request — no unhandled rejection", async () => {
    const harness = handDeliveryHarness("cancel");
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      const pipeline = (
        context: ComputationContext,
      ): Promise<WorkerSolidResult> => {
        // The first request is fired and never awaited — a supported
        // scenario by this module's own contract — while the second is the
        // computation's returned promise.
        void context.request("solid.createBox", boxInput);
        return context.request("solid.createSphere", { radius: mm(1) });
      };
      const a = harness.coordinator.update(pipeline);
      await flush();

      // B dispatches: the default policy's cancel loop voids BOTH of A's
      // request ids — including the never-awaited one — and the rejection
      // the coordinator itself causes must land in a sink it owes, not in
      // an unhandled rejection.
      const b = harness.coordinator.update(boxComputation);
      await flush();
      expect(harness.cancelled).toEqual([requestIdOf(1), requestIdOf(2)]);

      deliverBoxResult(harness, 1, 1); // B's own box request applies
      const [outcomeA, outcomeB] = await Promise.all([a, b]);
      const dropped = droppedOf(outcomeA);
      expect(dropped.failure?.error.code).toBe("worker/cancelled");
      expect(outcomeB).toEqual({
        outcome: "applied",
        revision: 2,
        result: { solid: solidIdOf(1) },
      });
      // One event-loop turn, not just microtasks: Node decides unhandled
      // rejections between macrotasks, so this is the earliest a would-be
      // unhandled rejection is observable at all.
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(unhandled).toEqual([]);
    } finally {
      process.removeListener("unhandledRejection", onUnhandled);
    }
  });

  it("stays healthy after a burst: a follow-up request still succeeds", async () => {
    const harness = handDeliveryHarness("complete");
    const outcomes: Array<Promise<ComputationOutcome<WorkerSolidResult>>> = [];
    for (let update = 0; update < 12; update += 1) {
      outcomes.push(harness.coordinator.update(boxComputation));
    }
    await flush();
    for (const revision of [12, 3, 7, 1, 11, 2, 9, 4, 10, 6, 5, 8]) {
      deliverBoxResult(harness, revision - 1, revision);
    }
    await Promise.all(outcomes);

    const followUp = harness.coordinator.update(boxComputation);
    await flush();
    deliverBoxResult(harness, 12, 13);
    await expect(followUp).resolves.toEqual({
      outcome: "applied",
      revision: 13,
      result: { solid: solidIdOf(13) },
    });
    expect(harness.coordinator.disposalFailures()).toEqual([]);
  });
});

interface RealSessionHarness {
  readonly client: WorkerClient;
  readonly coordinator: StaleResultCoordinator<WorkerSolidResult>;
  readonly ids: WorkerIdGenerator;
}

function realSession(
  superseded: SupersededComputationPolicy,
): RealSessionHarness {
  const ids = createWorkerIdGenerator();
  const session = createInMemoryKernelSession(createFakeKernel());
  const coordinator = createStaleResultCoordinator<WorkerSolidResult>({
    client: session.client,
    ids,
    superseded,
  });
  return { client: session.client, coordinator, ids };
}

/** Probes a session solid semantically: owned measures, released answers not-owned. */
async function solidState(
  harness: RealSessionHarness,
  solidId: WorkerSolidId,
): Promise<"owned" | "released"> {
  return harness.client
    .request("solid.volume", { solid: solidId }, harness.ids.nextRequestId())
    .then(
      () => "owned" as const,
      (error: unknown) => {
        if (!(error instanceof WorkerRequestFailure)) throw error;
        if (error.error.data?.kernelCode === "kernel/solid-not-owned") {
          return "released" as const;
        }
        throw error;
      },
    );
}

describe("coordinator over the real in-memory session", () => {
  it("rapid-updates under the cancel policy void all but the newest, and the channel stays healthy", async () => {
    const harness = realSession("cancel");
    const outcomes = Array.from({ length: 10 }, () =>
      harness.coordinator.update(boxComputation),
    );
    const settled = await Promise.all(outcomes);

    for (let index = 0; index < 9; index += 1) {
      const outcome = settled[index];
      if (outcome === undefined) {
        throw new Error(
          `Expected a settled outcome at index ${String(index)}.`,
        );
      }
      const dropped = droppedOf(outcome);
      expect(dropped.failure?.error.code).toBe("worker/cancelled");
      expect(dropped.currentRevision).toBe(10);
    }
    expect(settled[9]).toEqual({
      outcome: "applied",
      revision: 10,
      result: { solid: solidIdOf(1) },
    });
    // Suppressed computations consume no solid id: exactly one was minted.
    expect(harness.coordinator.visible()?.state.solid).toBe(solidIdOf(1));

    // Worker integrity: the visible solid measures, and a follow-up request
    // succeeds on the same channel after the burst.
    const volume = await harness.client.request(
      "solid.volume",
      { solid: solidIdOf(1) },
      harness.ids.nextRequestId(),
    );
    expect(volume.volume).toBe(24);
    const followUp = await harness.client.request(
      "solid.createSphere",
      { radius: mm(1) },
      harness.ids.nextRequestId(),
    );
    expect(followUp.solid).toBe(solidIdOf(2));
    expect(harness.coordinator.disposalFailures()).toEqual([]);
    expect(harness.coordinator.drops()).toHaveLength(9);
  });

  it("rapid-updates under the complete policy dispose every superseded solid — no leak", async () => {
    const harness = realSession("complete");
    const outcomes = Array.from({ length: 10 }, () =>
      harness.coordinator.update(boxComputation),
    );
    const settled = await Promise.all(outcomes);

    // FIFO delivery: the newest revision is current, so 1–9 are stale.
    expect(settled[9]).toEqual({
      outcome: "applied",
      revision: 10,
      result: { solid: solidIdOf(10) },
    });
    expect(
      settled
        .filter((outcome) => outcome.outcome === "dropped")
        .map((outcome) => outcome.revision),
    ).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);

    // The session mapping holds exactly the visible revision's solid.
    for (let n = 1; n <= 9; n += 1) {
      expect(await solidState(harness, solidIdOf(n))).toBe("released");
    }
    expect(await solidState(harness, solidIdOf(10))).toBe("owned");
    expect(harness.coordinator.disposalFailures()).toEqual([]);
  });

  it("sequential replacements leave the mapping empty after the burst is disposed — no leak", async () => {
    const harness = realSession("complete");
    for (let revision = 1; revision <= 10; revision += 1) {
      const settled = await harness.coordinator.update(boxComputation);
      expect(settled).toEqual({
        outcome: "applied",
        revision,
        result: { solid: solidIdOf(revision) },
      });
    }
    expect(harness.coordinator.visible()?.state.solid).toBe(solidIdOf(10));
    expect(harness.coordinator.drops()).toEqual([]); // each result was current

    // Every replaced solid was released; the visible one is the only citizen.
    for (let n = 1; n <= 9; n += 1) {
      expect(await solidState(harness, solidIdOf(n))).toBe("released");
    }
    expect(await solidState(harness, solidIdOf(10))).toBe("owned");

    // Disposing the visible state empties the mapping entirely…
    await harness.client.request(
      "solid.dispose",
      { solid: solidIdOf(10) },
      harness.ids.nextRequestId(),
    );
    expect(await solidState(harness, solidIdOf(10))).toBe("released");

    // …and the channel stays healthy for fresh work afterwards.
    const followUp = await harness.client.request(
      "solid.createBox",
      boxInput,
      harness.ids.nextRequestId(),
    );
    expect(followUp.solid).toBe(solidIdOf(11));
    expect(harness.coordinator.disposalFailures()).toEqual([]);
  });

  it("releases the solids a failed current computation minted before it failed", async () => {
    const harness = realSession("complete");
    const pipeline = async (
      context: ComputationContext,
    ): Promise<WorkerSolidResult> => {
      await context.request("solid.createBox", boxInput);
      return context.request("solid.createSphere", { radius: mm(-1) });
    };

    const failure = await failureOf(harness.coordinator.update(pipeline));

    expect(failure.error.code).toBe("worker/operation-failed");
    expect(failure.error.data).toEqual({ kernelCode: "kernel/invalid-length" });
    expect(harness.coordinator.visible()).toBeNull();
    // The box the pipeline minted before failing was released, not leaked.
    expect(await solidState(harness, solidIdOf(1))).toBe("released");
    expect(harness.coordinator.disposalFailures()).toEqual([]);
    expect(harness.coordinator.drops()).toEqual([]);
  });

  it("releases every solid of a multi-request computation dropped as stale", async () => {
    const harness = realSession("complete");
    const pipeline = async (
      context: ComputationContext,
    ): Promise<WorkerSolidResult> => {
      const box = await context.request("solid.createBox", boxInput);
      return context.request("solid.transform", {
        solid: box.solid,
        translation: { x: mm(1), y: mm(0), z: mm(0) },
      });
    };

    const stale = harness.coordinator.update(pipeline);
    const current = harness.coordinator.update(boxComputation);
    const [outcomeStale, outcomeCurrent] = await Promise.all([stale, current]);

    expect(outcomeCurrent).toEqual({
      outcome: "applied",
      revision: 2,
      result: { solid: solidIdOf(2) },
    });
    droppedOf(outcomeStale);
    // The pipeline minted its intermediate box (1) and its transform (3);
    // both were disposed when the pipeline's result was dropped.
    expect(await solidState(harness, solidIdOf(1))).toBe("released");
    expect(await solidState(harness, solidIdOf(3))).toBe("released");
    expect(await solidState(harness, solidIdOf(2))).toBe("owned");
    expect(harness.coordinator.disposalFailures()).toEqual([]);
  });

  it("disposes a cancelled update's in-flight mint — the two-update cancel repro leaves only B's solid owned", async () => {
    const harness = realSession("cancel");
    const updateA = harness.coordinator.update(boxComputation);
    // Exactly two microtask yields: A's request has executed server-side and
    // its success is in flight when B dispatches and voids A's request.
    await Promise.resolve();
    await Promise.resolve();
    const updateB = harness.coordinator.update(boxComputation);

    const [outcomeA, outcomeB] = await Promise.all([updateA, updateB]);
    const dropped = droppedOf(outcomeA);
    expect(dropped.failure?.error.code).toBe("worker/cancelled"); // void, never a late success
    expect(outcomeB).toEqual({
      outcome: "applied",
      revision: 2,
      result: { solid: solidIdOf(2) },
    });
    expect(harness.coordinator.visible()?.state.solid).toBe(solidIdOf(2));
    await flush(); // let the straggler's hygiene disposal cross the channel

    // The session owns exactly the visible revision's solid: A's mint —
    // executed, delivered, and discarded after the cancel — was released by
    // the client's discard hygiene, not orphaned.
    expect(await solidState(harness, solidIdOf(1))).toBe("released");
    expect(await solidState(harness, solidIdOf(2))).toBe("owned");
    expect(harness.coordinator.disposalFailures()).toEqual([]);
  });

  it("releases a trailing request's late mint that lands after the result applied — the session holds exactly the visible solid", async () => {
    const harness = realSession("complete");
    const pipeline = async (
      context: ComputationContext,
    ): Promise<WorkerSolidResult> => {
      const applied = await context.request("solid.createBox", boxInput);
      // A trailing request fired just before returning: its success is still
      // in flight when the update applies and seals, so its mint arrives for
      // an already-sealed computation.
      void context.request("solid.createBox", boxInput);
      return applied;
    };

    const outcome = await harness.coordinator.update(pipeline);
    expect(outcome).toEqual({
      outcome: "applied",
      revision: 1,
      result: { solid: solidIdOf(1) },
    });
    await flush();

    // The visible solid stands; the trailing late mint was disposed at its
    // recording site instead of leaking past the sealed computation.
    expect(await solidState(harness, solidIdOf(1))).toBe("owned");
    expect(await solidState(harness, solidIdOf(2))).toBe("released");
    expect(harness.coordinator.disposalFailures()).toEqual([]);
    expect(harness.coordinator.drops()).toEqual([]);
  });

  it("defaults to the cancel policy and stays leak-free without the superseded option", async () => {
    const ids = createWorkerIdGenerator();
    const session = createInMemoryKernelSession(createFakeKernel());
    // No `superseded` option: the documented default must hold end-to-end.
    const coordinator = createStaleResultCoordinator<WorkerSolidResult>({
      client: session.client,
      ids,
    });
    const harness: RealSessionHarness = {
      client: session.client,
      coordinator,
      ids,
    };

    // The exact orphan-producing interleave under the default policy: A
    // executes, its success is in flight, B dispatches and cancels A.
    const updateA = coordinator.update(boxComputation);
    await Promise.resolve();
    await Promise.resolve();
    const updateB = coordinator.update(boxComputation);
    const [outcomeA, outcomeB] = await Promise.all([updateA, updateB]);

    const dropped = droppedOf(outcomeA);
    expect(dropped.failure?.error.code).toBe("worker/cancelled"); // default = cancel
    expect(outcomeB).toEqual({
      outcome: "applied",
      revision: 2,
      result: { solid: solidIdOf(2) },
    });
    await flush();
    expect(await solidState(harness, solidIdOf(1))).toBe("released");
    expect(await solidState(harness, solidIdOf(2))).toBe("owned");

    // And a rapid burst on top stays healthy: every superseded request is
    // voided before the worker executes it, so only the newest mints.
    const burst = Array.from({ length: 5 }, () =>
      coordinator.update(boxComputation),
    );
    const settled = await Promise.all(burst);
    for (const outcome of settled.slice(0, 4)) {
      expect(droppedOf(outcome).failure?.error.code).toBe("worker/cancelled");
    }
    expect(settled[4]).toEqual({
      outcome: "applied",
      revision: 7,
      result: { solid: solidIdOf(3) },
    });
    expect(coordinator.visible()?.state.solid).toBe(solidIdOf(3));
    expect(await solidState(harness, solidIdOf(1))).toBe("released");
    expect(await solidState(harness, solidIdOf(2))).toBe("released");
    expect(await solidState(harness, solidIdOf(3))).toBe("owned");
    expect(coordinator.disposalFailures()).toEqual([]);
    expect(coordinator.drops()).toHaveLength(5); // A plus the four burst drops
  });
});

/**
 * The fake main-thread end of a booted dedicated-worker channel whose fake
 * responder answers `solid.createBox` synchronously and stays silent for
 * everything else — so a computation's first request succeeds (its mint is
 * recorded) while its second is still in flight when the thread "crashes",
 * driving the real `bootWorkerChannel` crash settlement end to end (the
 * `worker-boot` testing pattern, with a responder bolted on).
 */
class RespondingFakeWorkerPort implements WorkerCrashPort {
  terminated = false;
  /** Everything the client posted, in order — the wire. */
  readonly posted: unknown[] = [];
  private readonly messageListeners = new Set<
    (event: { readonly data: unknown }) => void
  >();
  private readonly errorListeners = new Set<
    (event: { readonly message: string }) => void
  >();
  private readonly messageErrorListeners = new Set<() => void>();

  postMessage(data: unknown): void {
    this.posted.push(data);
    const parsed = parseWorkerMessage(data);
    if (!parsed.ok || parsed.value.kind !== "request") return;
    if (parsed.value.operation !== "solid.createBox") return;
    this.dispatch(
      createWorkerSuccessResponse(parsed.value.requestId, "solid.createBox", {
        solid: solidIdOf(1),
      }),
    );
  }

  removeEventListener(
    type: "message",
    listener: (event: { readonly data: unknown }) => void,
  ): void {
    if (type === "message") this.messageListeners.delete(listener);
  }

  terminate(): void {
    this.terminated = true;
  }

  addEventListener(
    type: "message" | "error" | "messageerror",
    listener: (event: never) => void,
  ): void {
    if (type === "message") {
      this.messageListeners.add(
        listener as (event: { readonly data: unknown }) => void,
      );
    } else if (type === "error") {
      this.errorListeners.add(
        listener as (event: { readonly message: string }) => void,
      );
    } else {
      this.messageErrorListeners.add(listener as () => void);
    }
  }

  /** Stages the thread's `error` event (an uncaught crash). */
  crash(message: string): void {
    for (const listener of [...this.errorListeners]) listener({ message });
  }

  /** Delivers a worker-to-main message exactly as the DOM event would. */
  private dispatch(data: unknown): void {
    for (const listener of [...this.messageListeners]) listener({ data });
  }
}

describe("coordinator crash settlement through the real boot wiring", () => {
  it("settles an update whose channel crashes mid-flight — the mint's release cannot hang it", async () => {
    const port = new RespondingFakeWorkerPort();
    const crashes: WorkerBootFailure[] = [];
    const boot = bootWorkerChannel(port, (failure) => crashes.push(failure));
    const coordinator = createStaleResultCoordinator<WorkerVolumeResult>({
      client: boot.client,
    });

    const pipeline = async (
      context: ComputationContext,
    ): Promise<WorkerVolumeResult> => {
      // The first request succeeds in-turn (its mint is recorded on the
      // computation); the second is still in flight when the thread dies.
      const box = await context.request("solid.createBox", boxInput);
      return context.request("solid.volume", { solid: box.solid });
    };
    const update = coordinator.update(pipeline);
    await flush();
    expect(port.posted).toHaveLength(2); // the box and the volume, no more

    port.crash("Uncaught boom");

    // The crash settlement closes the client: the in-flight volume request
    // rejects with worker/transport-closed, and the failure path's release
    // of the recorded mint must not hang the update on the dead channel —
    // it settles (here: rejects with the structured crash failure).
    const failure = await failureOf(update);
    expect(failure.error.code).toBe("worker/transport-closed");
    expect(crashes).toEqual([{ kind: "error", message: "Uncaught boom" }]);
    expect(port.terminated).toBe(true);
    await flush();

    // The post-crash disposal of the recorded mint was refused locally by
    // the closed client (it never crossed the wire) and treated as
    // best-effort silence — not a disposal refusal worth reporting.
    expect(port.posted).toHaveLength(2);
    expect(coordinator.disposalFailures()).toEqual([]);
    expect(coordinator.visible()).toBeNull();
  });
});
