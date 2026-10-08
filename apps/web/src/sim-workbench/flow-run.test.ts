/**
 * The flow-run controller's tests (Phase 63c): the compile → stream →
 * finalize → persist orchestration driven over the IN-MEMORY transport
 * pair with the REAL routed engine hosted in-process — the same seam
 * double discipline the repo's router tests use. Pins:
 *
 * - the phase sequence and the committed-application counters (the
 *   ledger moves only on applications, law S6);
 * - the preview rounds reassembling into blocks (overlay application IS
 *   committed application), with the final round equal to the finalized
 *   result's own speed block;
 * - the law-S7 persistence wiring: the completed run puts through the
 *   local store's in-memory storage double keyed by the scenario-snapshot
 *   hash, lists back, and gets by run id with the identical bytes;
 * - the failure path: a scenario the engine declines surfaces the wire's
 *   `sim/*` code through {@link FlowRunFailure}, and nothing persists.
 *
 * Node semantics inside jsdom (the app's env): no real worker, no real
 * database — the pair and the double are the seams.
 */

import { describe, expect, it } from "vitest";
import {
  createInMemorySimResultStorage,
  createLocalSimResultStore,
  createSimInMemoryTransportPair,
  createSimWorkerClient,
  hostSimWorker,
  type SimWorkerClient,
} from "@slopcad/sim-core";
import {
  LBM_PREVIEW_CHUNK_MAX_VALUES,
  createDefaultSimEngine,
} from "@slopcad/sim-flow";

import { createSimApplicationLedger } from "../cad-workbench/sim-application-ledger";
import { FlowRunFailure, type FlowRunPhase, runFlowScenario } from "./flow-run";

/** A small tunnel scenario record (the controller consumes serialized records). */
function scenarioRecord(): Record<string, unknown> {
  return {
    id: "sim_000001",
    name: "controller-tunnel",
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
    materials: [],
    gravityMPerS2: [0, -9.80665, 0],
    stepBudget: 24,
  };
}

/** The obstacle: an aligned bar across the slice plane. */
const TESSELLATION = {
  positions: [
    40, 15, 0, 60, 15, 0, 60, 25, 0, 40, 25, 0, 40, 15, 10, 60, 15, 10, 60, 25,
    10, 40, 25, 10,
  ],
  indices: [
    0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 3, 2, 6, 3, 6, 7, 0,
    3, 7, 0, 7, 4, 1, 2, 6, 1, 6, 5,
  ],
};

/** Boots the in-process channel: the routed engine over the pair. */
function bootChannel(): SimWorkerClient {
  const pair = createSimInMemoryTransportPair();
  void hostSimWorker({
    transport: pair.server,
    createEngine: createDefaultSimEngine,
  });
  return createSimWorkerClient({ transport: pair.client });
}

describe("runFlowScenario: compile, stream, finalize, persist", () => {
  it("walks the phases, applies notifications through the ledger, and persists the run keyed by its hash", async () => {
    const channel = bootChannel();
    const storage = createInMemorySimResultStorage();
    const store = createLocalSimResultStore({
      storage,
      now: () => new Date("2026-10-08T00:00:00Z"),
    });
    const ledger = createSimApplicationLedger();
    const phases: FlowRunPhase[] = [];
    const appliedBlocks: unknown[] = [];
    const outcome = await runFlowScenario({
      client: channel,
      scenario: scenarioRecord(),
      tessellation: TESSELLATION,
      documentVersionId: "doc_controller_test",
      store,
      ledger,
      events: {
        onPhase: (phase) => phases.push(phase),
        onApplied: ({ counters, block }) => {
          expect(counters.notifications).toBeGreaterThan(0);
          if (block !== null) appliedBlocks.push(block);
        },
      },
    });
    expect(phases).toEqual([
      "compiling",
      "running",
      "finalizing",
      "persisting",
      "completed",
    ]);
    // The committed applications: progress steps plus preview rounds'
    // chunks, and the ledger's high-water step reached the budget.
    expect(ledger.progressStep).toBe(24);
    expect(ledger.notifications).toBe(
      24 +
        appliedBlocks.length *
          Math.max(1, Math.ceil((21 * 9) / LBM_PREVIEW_CHUNK_MAX_VALUES)),
    );
    // The preview rounds reassembled into speed blocks (the overlay's
    // input), and the finalized result carries the same field family.
    expect(appliedBlocks.length).toBe(3); // rounds at steps 10, 20, 24.
    for (const block of appliedBlocks) {
      expect(block).toMatchObject({ id: "speed", unit: "mm/s" });
    }
    expect(outcome.result.summary.status).toBe("completed");
    expect(outcome.result.fields.map((field) => field.id)).toContain(
      "mean-velocity-x",
    );
    expect(outcome.record.scenarioSnapshotHash).toBe(
      outcome.result.summary.scenarioSnapshotHash,
    );

    // The persistence wiring: list enumerates the run; get returns the
    // identical stored bytes (byte-determinism through the seam).
    const listed = await store.list("doc_controller_test");
    expect(listed.ok).toBe(true);
    if (listed.ok) {
      expect(listed.value.map((run) => run.id)).toContain(outcome.record.id);
    }
    const fetched = await store.get(outcome.record.id);
    expect(fetched.ok).toBe(true);
    if (fetched.ok && fetched.value !== null) {
      expect(fetched.value.result.summary).toEqual(outcome.result.summary);
      expect(fetched.value.result.fields).toEqual(outcome.result.fields);
      expect(fetched.value.result.histories).toEqual(outcome.result.histories);
    }
  });

  it("surfaces the engine's structured decline and persists nothing", async () => {
    const channel = bootChannel();
    const storage = createInMemorySimResultStorage();
    const store = createLocalSimResultStore({ storage });
    const ledger = createSimApplicationLedger();
    const phases: FlowRunPhase[] = [];
    const attempt = runFlowScenario({
      client: channel,
      // A geometry-less flow run: the engine declines loudly.
      scenario: { ...scenarioRecord(), name: "empty" },
      documentVersionId: "doc_controller_test",
      store,
      ledger,
      events: { onPhase: (phase) => phases.push(phase) },
    });
    await expect(attempt).rejects.toBeInstanceOf(FlowRunFailure);
    await attempt.catch((error: FlowRunFailure) => {
      expect(error.code).toBe("sim/geometry-unavailable");
    });
    expect(phases).toEqual(["compiling", "running", "failed"]);
    const listed = await store.list("doc_controller_test");
    expect(listed.ok).toBe(true);
    if (listed.ok) {
      expect(listed.value).toHaveLength(0);
    }
  });
});
