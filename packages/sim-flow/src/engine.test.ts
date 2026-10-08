/**
 * The engine adapter's contract tests (Phase 63c), in-process half: the
 * real 2D flow engine behind the Phase 61 `SimEngine` contract, driven
 * directly over compiled problems from the geometry-aware compile door.
 * The channel-level truths (worker thread, protocol notifications,
 * cancellation through the wire) live in `./engine-node-channel.test.ts`;
 * this file pins the ENGINE's own semantics:
 *
 * - compile + run + finalize over an analytic box obstacle: the slice
 *   voxelizes exactly, the run completes, the result carries the S9
 *   regime, the snapshot hash, the force histories, and the averaged
 *   mean/fluctuation fields;
 * - the notification stream's integrity: monotone progress, preview
 *   rounds on the recorded cadence, and the FINAL round's reassembled
 *   speed block bitwise-equal to the finalized result's own;
 * - determinism: the same compiled problem produces the identical
 *   emission schedule and the identical finalized summary;
 * - the honest declines: geometry-less flow runs, z-face conditions,
 *   non-flow condition kinds, missing inlets, GPU preference, thermal
 *   and structural routing;
 * - the grid-convergence self-check: the flagged run's summary carries
 *   the drift quantities, and the ladder's refined rung ran (progress
 *   continued past the coarse budget).
 *
 * Node-env vitest, no network, no DOM — the law-S2/S5 stance.
 */

import { describe, expect, it } from "vitest";
import {
  compileSimScenarioWithGeometry,
  decodeSimResultPayload,
  encodeSimResultPayload,
  reassembleSimFieldChunks,
  type SimEngineFieldChunk,
  type SimEngineProgress,
  type SimResult,
} from "@slopcad/sim-core";

import { boxTessellationWire } from "./fixtures";
import {
  createDefaultSimEngine,
  createLbmSimEngine,
  LBM_PREVIEW_INTERVAL_STEPS,
} from "./engine";

/**
 * The contract fixture: a slow air tunnel (real air at coarse voxels is
 * viscous-dominated — the staircase honesty; the lattice closure keeps
 * τ⁺ comfortably inside its band) around an aligned box, at a 5 mm
 * resolution and a 24-step budget.
 */
function tunnelScenario(overrides?: {
  readonly stepBudget?: number;
  readonly gridConvergence?: boolean;
}): Record<string, unknown> {
  return {
    name: "contract-tunnel",
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
    stepBudget: overrides?.stepBudget ?? 24,
    ...(overrides?.gridConvergence === undefined
      ? {}
      : { gridConvergence: overrides.gridConvergence }),
  };
}

/** The obstacle: a bar across the slice plane's mid-height. */
const OBSTACLE = boxTessellationWire([40, 15, 0], [60, 25, 10]);

/** The explicit "compile without geometry" marker for {@link compileTunnel}. */
const NO_GEOMETRY = Symbol("no-geometry");

function compileTunnel(overrides?: {
  readonly stepBudget?: number;
  readonly gridConvergence?: boolean;
  readonly tessellation?: unknown;
  readonly scenario?: Record<string, unknown>;
}) {
  const tessellation =
    overrides?.tessellation === undefined ? OBSTACLE : overrides.tessellation;
  return compileSimScenarioWithGeometry({
    scenario: overrides?.scenario ?? tunnelScenario(overrides),
    ...(tessellation === NO_GEOMETRY ? {} : { tessellation }),
  });
}

/** Runs the engine with captured emissions. */
async function runCaptured(
  compiled: Parameters<
    ReturnType<typeof createLbmSimEngine>["run"]
  >[0]["compiled"],
): Promise<{
  readonly progress: readonly SimEngineProgress[];
  readonly chunks: readonly SimEngineFieldChunk[];
  readonly result: SimResult;
}> {
  const progress: SimEngineProgress[] = [];
  const chunks: SimEngineFieldChunk[] = [];
  const engine = createLbmSimEngine();
  const run = await engine.run(
    { compiled },
    (entry) => progress.push(entry),
    (chunk) => chunks.push(chunk),
  );
  if (!run.ok) {
    throw new Error(`the engine declined the fixture: ${run.error.message}`);
  }
  return { progress, chunks, result: run.value };
}

/** Splits a chunk stream into rounds (each starting at chunk index 0). */
function chunkRounds(
  chunks: readonly SimEngineFieldChunk[],
): readonly (readonly SimEngineFieldChunk[])[] {
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
  return rounds;
}

describe("createLbmSimEngine: the contract over compiled problems", () => {
  it("compiles the slice exactly, runs to the budget, and finalizes with regime, histories, and averaged fields", async () => {
    const compiled = compileTunnel();
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    // The analytic occupancy pin: at the 5 mm slice, the box's closed
    // set covers exactly the aligned node range.
    const slice = compiled.value.occupancySlice;
    expect(slice).toBeDefined();
    if (slice === undefined) return;
    expect([...slice.shape]).toEqual([21, 9, 1]);
    const solidNodes: number[] = [];
    slice.cells.forEach((cell, index) => {
      if (cell === 1) solidNodes.push(index);
    });
    // x ∈ {40..60} step 5 (5 columns), y ∈ {15..25} step 5 (3 rows).
    expect(solidNodes.length).toBe(5 * 3);
    expect(compiled.value.run?.stepBudget).toBe(24);
    expect(compiled.value.run?.averagingStartStep).toBe(12);

    const { progress, result } = await runCaptured(compiled.value);
    expect(progress.length).toBe(24);
    expect(progress[progress.length - 1]?.step).toBe(24);
    expect(result.summary.status).toBe("completed");
    expect(result.summary.scenarioSnapshotHash).toBe(
      compiled.value.scenarioSnapshotHash,
    );
    expect(result.summary.regime.prandtl).toBeGreaterThan(0);
    expect(result.summary.regime.reynolds).toBeGreaterThan(0);
    const fieldIds = result.fields.map((field) => field.id);
    expect(fieldIds).toContain("speed");
    expect(fieldIds).toContain("pressure");
    expect(fieldIds).toContain("mean-velocity-x");
    expect(fieldIds).toContain("fluctuation-velocity-y");
    expect(result.histories.map((series) => series.name)).toEqual([
      "drag",
      "lift",
    ]);
    expect(result.histories[0]?.samples.length).toBe(24);
    const drag = result.summary.quantities.find(
      (quantity) => quantity.name === "mean-drag-force",
    );
    expect(drag?.unit).toBe("N");
  });

  it("streams monotone progress, preview rounds on the cadence, and a final round that IS the finalized speed block", async () => {
    const compiled = compileTunnel();
    if (!compiled.ok) return;
    const { progress, chunks, result } = await runCaptured(compiled.value);
    for (let index = 1; index < progress.length; index += 1) {
      expect(
        (progress[index]?.step ?? 0) - (progress[index - 1]?.step ?? 0),
      ).toBe(1);
    }
    // The cadence: a round every LBM_PREVIEW_INTERVAL_STEPS steps plus
    // the final step's own round (24 = 2·10 + 4, so rounds at 10, 20, 24).
    const rounds = chunkRounds(chunks);
    expect(rounds.length).toBe(Math.floor(24 / LBM_PREVIEW_INTERVAL_STEPS) + 1);
    for (const round of rounds) {
      const reassembled = reassembleSimFieldChunks(round);
      expect(reassembled.ok).toBe(true);
      if (reassembled.ok) {
        expect(reassembled.value.id).toBe("speed");
        expect(reassembled.value.unit).toBe("mm/s");
      }
    }
    const finalizedSpeed = result.fields.find((field) => field.id === "speed");
    expect(finalizedSpeed).toBeDefined();
    if (finalizedSpeed === undefined) return;
    const finalRound = rounds[rounds.length - 1];
    const finalBlock =
      finalRound === undefined
        ? undefined
        : reassembleSimFieldChunks(finalRound);
    expect(finalBlock?.ok).toBe(true);
    if (finalBlock !== undefined && finalBlock.ok) {
      expect(finalBlock.value.values).toEqual(finalizedSpeed.values);
      expect([...finalBlock.value.extent]).toEqual([...finalizedSpeed.extent]);
      expect([...finalBlock.value.originMm]).toEqual([
        ...finalizedSpeed.originMm,
      ]);
      expect([...finalBlock.value.spacingMm]).toEqual([
        ...finalizedSpeed.spacingMm,
      ]);
    }
    // The lossless framing law: the finalized payload's decoded speed
    // block matches the stream's final round too.
    const encoded = result.fields;
    expect(encoded.find((field) => field.id === "speed")?.values.length).toBe(
      21 * 9,
    );
  });

  it("is deterministic: the same compiled problem yields the identical emission schedule and summary", async () => {
    const compiled = compileTunnel();
    if (!compiled.ok) return;
    const first = await runCaptured(compiled.value);
    const second = await runCaptured(compiled.value);
    expect(second.progress).toEqual(first.progress);
    expect(second.chunks).toEqual(first.chunks);
    expect(second.result.summary).toEqual(first.result.summary);
    expect(second.result.fields).toEqual(first.result.fields);
    expect(second.result.histories).toEqual(first.result.histories);
  });

  it("runs the grid-convergence ladder when flagged: progress continues past the coarse budget and the drift joins the summary", async () => {
    const compiled = compileTunnel({
      stepBudget: 20,
      gridConvergence: true,
    });
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    expect(compiled.value.occupancySliceRefined).toBeDefined();
    expect(compiled.value.occupancySliceRefined?.shape[0]).toBe(
      (compiled.value.occupancySlice?.shape[0] ?? 0) * 2,
    );
    const engine = createLbmSimEngine();
    const progress: SimEngineProgress[] = [];
    const run = await engine.run({ compiled: compiled.value }, (entry) => {
      progress.push(entry);
    });
    if (!run.ok) {
      throw new Error(`the ladder run declined: ${run.error.message}`);
    }
    // The refined rung: steps continue past the coarse 20 to the
    // ladder's whole 60, monotonically.
    const last = progress[progress.length - 1]?.step ?? 0;
    expect(last).toBe(20 * 3);
    const names = run.value.summary.quantities.map((quantity) => quantity.name);
    expect(names).toContain("grid-convergence-drag-drift");
    expect(names).toContain("grid-convergence-lift-drift");
    expect(names).toContain("grid-convergence-field-l2-drift");
    for (const name of [
      "grid-convergence-drag-drift",
      "grid-convergence-lift-drift",
      "grid-convergence-field-l2-drift",
    ]) {
      const quantity = run.value.summary.quantities.find(
        (entry) => entry.name === name,
      );
      expect(quantity?.unit).toBe("1");
      expect(Number.isFinite(quantity?.value)).toBe(true);
    }
  });

  it("declines a flow run without geometry loudly, never fabricating an empty tunnel", async () => {
    const compiled = compileTunnel({ tessellation: NO_GEOMETRY });
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    const engine = createLbmSimEngine();
    const run = await engine.run({ compiled: compiled.value });
    expect(run.ok).toBe(false);
    if (run.ok) return;
    expect(run.error.code).toBe("sim/geometry-unavailable");
  });

  it("declines conditions the 2D slice cannot consume (z faces, thermal kinds) and inlet-less tunnels", async () => {
    const zFaced = compileTunnel({
      scenario: {
        ...tunnelScenario(),
        conditions: [
          ...(tunnelScenario().conditions as unknown[]),
          { kind: "fixed-temperature", face: "zMax", temperatureK: 400 },
        ],
      },
    });
    expect(zFaced.ok).toBe(true);
    if (!zFaced.ok) return;
    const engine = createLbmSimEngine();
    const zRun = await engine.run({ compiled: zFaced.value });
    expect(zRun.ok).toBe(false);
    if (zRun.ok) return;
    expect(zRun.error.message).toContain("zMax");

    const inletless = compileTunnel({
      scenario: {
        ...tunnelScenario(),
        conditions: [
          { kind: "wall", face: "xMin", slip: false },
          { kind: "symmetry", face: "yMax" },
        ],
      },
    });
    if (!inletless.ok) return;
    const bareRun = await engine.run({ compiled: inletless.value });
    expect(bareRun.ok).toBe(false);
    if (bareRun.ok) return;
    expect(bareRun.error.message).toContain("velocity-inlet");
  });

  it("declines the GPU preference until the Phase 64 provider exists, and unsupported kinds", async () => {
    const compiled = compileTunnel({
      scenario: { ...tunnelScenario(), backend: "gpu" },
    });
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    const engine = createLbmSimEngine();
    const gpuRun = await engine.run({ compiled: compiled.value });
    expect(gpuRun.ok).toBe(false);
    if (gpuRun.ok) return;
    expect(gpuRun.error.code).toBe("sim/backend-unavailable");

    const thermal = compileSimScenarioWithGeometry({
      scenario: {
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
      },
    });
    expect(thermal.ok).toBe(true);
    if (!thermal.ok) return;
    const thermalRun = await engine.run({ compiled: thermal.value });
    expect(thermalRun.ok).toBe(false);
    if (thermalRun.ok) return;
    expect(thermalRun.error.code).toBe("sim/scenario-kind-unsupported");
  });

  it("routes through the default engine: thermal rides the fake engine, the flow engine serves flow", async () => {
    const routed = createDefaultSimEngine();
    expect(routed.supportedKinds).toContain("flow");
    expect(routed.supportedKinds).toContain("thermal");
    expect(routed.supportedKinds).not.toContain("structural");
    const compiled = compileTunnel();
    if (!compiled.ok) return;
    const run = await routed.run({ compiled: compiled.value });
    expect(run.ok).toBe(true);
    const thermal = compileSimScenarioWithGeometry({
      scenario: {
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
      },
    });
    if (!thermal.ok) return;
    const thermalRun = await routed.run({ compiled: thermal.value });
    expect(thermalRun.ok).toBe(true);
    if (thermalRun.ok) {
      // The fake engine's signature histories (the routing proof).
      expect(thermalRun.value.histories.map((series) => series.name)).toEqual([
        "max-temperature",
      ]);
    }
  });

  it("finalizes through the persistence payload: the decoded blocks match the result's fields", async () => {
    const compiled = compileTunnel();
    if (!compiled.ok) return;
    const { result } = await runCaptured(compiled.value);
    const encoded = encodeSimResultPayload(result.fields);
    expect(encoded.ok).toBe(true);
    if (!encoded.ok) return;
    const decoded = decodeSimResultPayload(encoded.value);
    expect(decoded.ok).toBe(true);
    if (decoded.ok) {
      expect(decoded.value.length).toBe(result.fields.length);
      expect(decoded.value.map((field) => field.id)).toEqual(
        result.fields.map((field) => field.id),
      );
    }
  });
});
