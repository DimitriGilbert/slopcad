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
import { createStructuralSimEngine } from "@slopcad/sim-structural";
import type { SimEngine } from "@slopcad/sim-core";

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

/**
 * Boots the in-process channel with the STRUCTURAL engine routed in
 * front (the page's worker-entry routing restated — the kind router the
 * production host serves).
 */
function bootStructuralChannel(): SimWorkerClient {
  const pair = createSimInMemoryTransportPair();
  void hostSimWorker({
    transport: pair.server,
    createEngine: (): SimEngine => {
      const routed = createDefaultSimEngine();
      const structural = createStructuralSimEngine();
      return {
        id: "test-routed-sim",
        supportedKinds: [
          ...new Set([...routed.supportedKinds, ...structural.supportedKinds]),
        ],
        backend: "cpu",
        run: (request, onProgress, onFieldChunk) => {
          if (structural.supportedKinds.includes(request.compiled.kind)) {
            return structural.run(request, onProgress, onFieldChunk);
          }
          return routed.run(request, onProgress, onFieldChunk);
        },
      };
    },
  });
  return createSimWorkerClient({ transport: pair.client });
}

/** The bracket demo's serialized scenario record (document wire form). */
function structuralScenarioRecord(): Record<string, unknown> {
  return {
    id: "sim_000002",
    name: "controller-bracket",
    kind: "structural",
    domain: {
      kind: "explicit",
      min: [-60, -40, 0],
      max: [60, 40, 80],
      resolutionMm: 5,
    },
    conditions: [
      { kind: "fixed-support", face: "zMin" },
      {
        kind: "point-load",
        atWorldPointMm: [0, -36, 80],
        forceN: [0, -500, 0],
      },
    ],
    fluid: "air",
    materials: [
      { bodyId: "body_bracket-base", materialId: "mat_steel" },
      { bodyId: "body_bracket-wall", materialId: "mat_steel" },
    ],
    gravityMPerS2: [0, -9.80665, 0],
    structural: { selfWeight: false },
  };
}

/** The steel record + the two bodies' box tessellations (the wire form). */
const STEEL_RECORD = {
  id: "mat_steel",
  name: "Steel S235",
  densityGPerCm3: 7.85,
  youngsModulusPa: 210e9,
  poissonRatio: 0.3,
  yieldStrengthPa: 250e6,
  thermalExpansionPerK: 1.2e-5,
} as const;

/** An axis-aligned box's triangle soup, mm (the voxelizer's wire form). */
function boxTessellation(
  minMm: readonly [number, number, number],
  maxMm: readonly [number, number, number],
): { positions: number[]; indices: number[] } {
  const [x0, y0, z0] = minMm;
  const [x1, y1, z1] = maxMm;
  const v: readonly (readonly [number, number, number])[] = [
    [x0, y0, z0],
    [x1, y0, z0],
    [x1, y1, z0],
    [x0, y1, z0],
    [x0, y0, z1],
    [x1, y0, z1],
    [x1, y1, z1],
    [x0, y1, z1],
  ];
  const quads: readonly (readonly [number, number, number, number])[] = [
    [0, 3, 2, 1],
    [4, 5, 6, 7],
    [0, 1, 5, 4],
    [1, 2, 6, 5],
    [2, 3, 7, 6],
    [3, 0, 4, 7],
  ];
  const positions: number[] = [];
  const indices: number[] = [];
  for (const [a, b, c, d] of quads) {
    const base = positions.length / 3;
    for (const index of [a, b, c, d]) {
      const corner = v[index];
      if (corner === undefined) continue;
      positions.push(corner[0], corner[1], corner[2]);
    }
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  return { positions, indices };
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

describe("runFlowScenario: the structural run (Phase 69)", () => {
  it(
    "routes the bracket through the structural engine with its chain inputs and persists the scalars",
    { timeout: 120_000 },
    async () => {
      const channel = bootStructuralChannel();
      const storage = createInMemorySimResultStorage();
      const store = createLocalSimResultStore({
        storage,
        now: () => new Date("2026-10-13T00:00:00Z"),
      });
      const ledger = createSimApplicationLedger();
      const appliedBlocks: unknown[] = [];
      const outcome = await runFlowScenario({
        client: channel,
        scenario: structuralScenarioRecord(),
        materials: [STEEL_RECORD],
        bodyTessellations: [
          {
            bodyId: "body_bracket-base",
            tessellation: boxTessellation([-60, -40, 0], [60, 40, 8]),
          },
          {
            bodyId: "body_bracket-wall",
            tessellation: boxTessellation([-60, -40, 0], [60, -32, 80]),
          },
        ],
        documentVersionId: "doc_controller_structural",
        store,
        ledger,
        events: {
          onApplied: ({ block }) => {
            if (block !== null) appliedBlocks.push(block);
          },
        },
      });
      // Both preview rounds reassembled — von Mises first, the
      // displacement block applied LAST (the deterministic overlay
      // order the engine pins).
      expect(appliedBlocks.length).toBe(2);
      expect(appliedBlocks[0]).toMatchObject({ id: "von-mises", unit: "Pa" });
      expect(appliedBlocks[1]).toMatchObject({
        id: "displacement",
        unit: "mm",
      });
      // The persisted summary carries the machine-readable scalar
      // family Phase 70 optimizes against.
      const names = outcome.result.summary.quantities.map(
        (quantity) => quantity.name,
      );
      expect(names).toContain("max-deflection");
      expect(names).toContain("von-mises-max");
      expect(names).toContain("factor-of-safety");
      expect(outcome.result.histories).toEqual([]);
      // The store round-trip: the run lists and gets back identical
      // bytes, keyed by the scenario-snapshot hash.
      const listed = await store.list("doc_controller_structural");
      expect(listed.ok).toBe(true);
      if (listed.ok) {
        expect(listed.value).toHaveLength(1);
        expect(listed.value[0]?.scenarioSnapshotHash).toBe(
          outcome.result.summary.scenarioSnapshotHash,
        );
      }

      // The chain inputs cross the wire: a thermal-chained stance with
      // a supplied temperature block compiles and solves hotter (the
      // wire codec's structuralChain round-trip is the seam this pins).
      const hotOutcome = await runFlowScenario({
        client: channel,
        scenario: {
          ...structuralScenarioRecord(),
          name: "controller-bracket-hot",
          structural: {
            selfWeight: false,
            thermal: { referenceTemperatureK: 293.15 },
          },
        },
        materials: [STEEL_RECORD],
        bodyTessellations: [
          {
            bodyId: "body_bracket-base",
            tessellation: boxTessellation([-60, -40, 0], [60, 40, 8]),
          },
          {
            bodyId: "body_bracket-wall",
            tessellation: boxTessellation([-60, -40, 0], [60, -32, 80]),
          },
        ],
        structuralChain: {
          thermal: {
            field: {
              originMm: [-60, -40, 0],
              spacingMm: [5, 5, 5],
              extent: [25, 17, 1],
              values: new Array<number>(25 * 17).fill(393.15),
            },
          },
        },
        documentVersionId: "doc_controller_structural",
        store,
        ledger,
      });
      const quantityOf = (name: string): number | undefined =>
        hotOutcome.result.summary.quantities.find(
          (entry) => entry.name === name,
        )?.value;
      expect(quantityOf("von-mises-max")).toBeDefined();
      const coldVonMises = outcome.result.summary.quantities.find(
        (entry) => entry.name === "von-mises-max",
      )?.value;
      const hotVonMises = quantityOf("von-mises-max");
      if (coldVonMises !== undefined && hotVonMises !== undefined) {
        expect(hotVonMises).toBeGreaterThan(coldVonMises);
      }

      // The unchained stance with a supplied chain declines loudly
      // through the wire (never a silently dropped input).
      const strayChain = runFlowScenario({
        client: channel,
        scenario: structuralScenarioRecord(),
        materials: [STEEL_RECORD],
        bodyTessellations: [
          {
            bodyId: "body_bracket-base",
            tessellation: boxTessellation([-60, -40, 0], [60, 40, 8]),
          },
          {
            bodyId: "body_bracket-wall",
            tessellation: boxTessellation([-60, -40, 0], [60, -32, 80]),
          },
        ],
        structuralChain: { fanRpm: 3000 },
        documentVersionId: "doc_controller_structural",
        store,
        ledger,
      });
      await expect(strayChain).rejects.toMatchObject({
        name: "FlowRunFailure",
        code: "sim/scenario-invalid",
      });
    },
  );
});
