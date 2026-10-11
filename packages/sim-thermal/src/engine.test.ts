/**
 * The conduction engine adapter's contract tests (Phase 65c, the
 * sim-flow `./engine.test` precedent): the compiled thermal scenario —
 * produced by the REAL geometry-aware compile door (`sim-core`'s
 * `compileSimScenarioWithGeometry`, per-body tessellation + material
 + records) — runs through the Phase 61 `SimEngine` contract end to
 * end. The truths this file owns:
 *
 * - the compile door's products ride through: the unit-depth slab, the
 *   material map, the re-validated stance — and the sealed steady
 *   stove settles at a REAL equilibrium (the energy balance closes:
 *   source ≈ convection + radiation losses at the settled field);
 * - the notification stream: one progress hop per stage and ONE final
 *   preview round whose reassembled block is bitwise the finalized
 *   result's temperature block (the last-round discipline);
 * - determinism: the same compiled problem produces the
 *   bitwise-identical result and notification stream (law S2);
 * - the loud declines: a coupled (cht) stance declined by this sealed
 *   engine, a geometry-less compile, a z-face condition, and the
 *   flow-vocabulary conditions that belong to the coupled march.
 *
 * Node-env vitest, no network, no React — the law-S2/S5 stance.
 */

import { describe, expect, it } from "vitest";
import {
  compileSimScenarioWithGeometry,
  reassembleSimFieldChunks,
  type SimEngineFieldChunk,
  type SimEngineProgress,
} from "@slopcad/sim-core";

import { STEEL_WIRE, boxTessellationWire, materialWire } from "./fixtures";
import { createThermalSimEngine } from "./engine";

/** The demo stove's own bar: an aligned box inside the tunnel domain, mm. */
const BAR = boxTessellationWire([40, 15, 0], [60, 25, 10]);

/** The serialized thermal scenario the compile door consumes. */
function thermalScenario(overrides?: {
  readonly thermal?: Record<string, unknown>;
  readonly conditions?: readonly unknown[];
  readonly materials?: readonly unknown[];
}): Record<string, unknown> {
  return {
    name: "stove-bar",
    kind: "thermal",
    domain: {
      kind: "explicit",
      min: [0, 0, 0],
      max: [100, 40, 10],
      resolutionMm: 5,
    },
    conditions: overrides?.conditions ?? [],
    fluid: "air",
    materials: overrides?.materials ?? [
      { bodyId: "body_bar", materialId: "mat_steel" },
    ],
    thermal: overrides?.thermal ?? {
      radiationMode: "linearized",
      solveMode: "steady",
      cht: false,
      sourceW: 8,
      initialTemperatureK: 293.15,
      ambientConvectionWPerM2K: 5,
    },
  };
}

/** Compiles the scenario through the real door with the bar geometry. */
function compileThermal(
  scenario: Record<string, unknown>,
  materials: readonly unknown[] = [STEEL_WIRE],
) {
  return compileSimScenarioWithGeometry({
    scenario,
    materials,
    bodyTessellations: [{ bodyId: "body_bar", tessellation: BAR }],
  });
}

describe("the conduction thermal engine", () => {
  it("runs the sealed steady stove through the contract at a real equilibrium", async () => {
    const compiled = compileThermal(thermalScenario());
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    expect(compiled.value.occupancySlice).toBeDefined();
    expect(compiled.value.thermal).toBeDefined();

    const engine = createThermalSimEngine();
    const result = await engine.run({ compiled: compiled.value });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const summary = result.value.summary;
    expect(summary.status).toBe("completed");
    expect(summary.scenarioSnapshotHash).toMatch(/^[0-9a-f]{8}$/);
    expect(summary.servedBackend).toBe("cpu");
    expect(summary.regime.prandtl).toBeGreaterThan(0.5);
    expect(summary.regime.prandtl).toBeLessThan(1);

    // The temperature block is the one field; kelvin, the slice's shape.
    expect(result.value.fields.map((field) => field.id)).toEqual([
      "temperature",
    ]);
    const block = result.value.fields[0];
    if (block === undefined) return;
    expect(block.unit).toBe("K");
    expect([...block.extent]).toEqual([21, 9, 1]);

    // The §7.12 equilibrium: the bar settles above ambient, and the
    // energy balance closes — the source meets the boundary losses at
    // the settled field (the audit's own claim, asserted as numbers).
    const quantity = (name: string): number | undefined =>
      summary.quantities.find((row) => row.name === name)?.value;
    const maxTemperature = quantity("max-temperature");
    expect(maxTemperature).toBeDefined();
    if (maxTemperature !== undefined) {
      expect(maxTemperature).toBeGreaterThan(293.15);
      expect(maxTemperature).toBeLessThan(600);
    }
    const imbalance = quantity("net-heat-imbalance");
    const source = quantity("source-power");
    expect(imbalance).toBeDefined();
    expect(source).toBeDefined();
    if (imbalance !== undefined && source !== undefined && source > 0) {
      expect(Math.abs(imbalance)).toBeLessThan(0.02 * source);
    }
  });

  it("streams one final preview round whose block is bitwise the finalized block", async () => {
    const compiled = compileThermal(thermalScenario());
    if (!compiled.ok) return;
    const engine = createThermalSimEngine();
    const progress: SimEngineProgress[] = [];
    const chunks: SimEngineFieldChunk[] = [];
    const result = await engine.run(
      { compiled: compiled.value },
      (step) => progress.push(step),
      (chunk) => chunks.push(chunk),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // One hop per stage, monotone.
    expect(progress.length).toBe(2);
    expect(progress[0]?.step).toBe(0);
    expect(progress[1]?.step).toBe(1);

    // One round: every chunk of the temperature field, gapless, whose
    // reassembly is bitwise the finalized block (the last-round law).
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.every((chunk) => chunk.id === "temperature")).toBe(true);
    const reassembled = reassembleSimFieldChunks(chunks);
    expect(reassembled.ok).toBe(true);
    if (!reassembled.ok) return;
    const finalized = result.value.fields[0];
    if (finalized === undefined) return;
    expect(reassembled.value.values).toEqual(finalized.values);
    expect(reassembled.value.extent).toEqual(finalized.extent);
    expect(reassembled.value.unit).toBe(finalized.unit);
  });

  it("is deterministic: the same compiled problem produces the identical result and stream", async () => {
    const compiled = compileThermal(thermalScenario());
    if (!compiled.ok) return;
    const engine = createThermalSimEngine();
    const runOnce = async (): Promise<{
      readonly summaryJson: string;
      readonly payloadJson: string;
      readonly chunkJson: string;
    }> => {
      const chunks: SimEngineFieldChunk[] = [];
      const result = await engine.run(
        { compiled: compiled.value },
        undefined,
        (chunk) => chunks.push(chunk),
      );
      if (!result.ok) throw new Error(result.error.message);
      return {
        summaryJson: JSON.stringify(result.value.summary),
        payloadJson: JSON.stringify(result.value.fields.map((f) => f.values)),
        chunkJson: JSON.stringify(chunks.map((chunk) => chunk.values)),
      };
    };
    const first = await runOnce();
    const second = await runOnce();
    expect(second.summaryJson).toBe(first.summaryJson);
    expect(second.payloadJson).toBe(first.payloadJson);
    expect(second.chunkJson).toBe(first.chunkJson);
  });

  it("declines the coupled stance, geometry-less compiles, and off-slice conditions loudly", async () => {
    const engine = createThermalSimEngine();

    // The coupled stance: this engine's own loud decline (the routed
    // engine serves the march; a sealed solve never silently downgrades).
    const coupled = compileThermal(
      thermalScenario({
        thermal: {
          radiationMode: "off",
          solveMode: "transient",
          cht: true,
          sourceW: 8,
          initialTemperatureK: 293.15,
          ambientConvectionWPerM2K: 5,
          durationS: 10,
          sampleIntervalS: 2,
        },
      }),
    );
    expect(coupled.ok).toBe(true);
    if (coupled.ok) {
      const run = await engine.run({ compiled: coupled.value });
      expect(run.ok).toBe(false);
      if (!run.ok) {
        expect(run.error.code).toBe("sim/scenario-invalid");
        expect(run.error.message).toContain("coupled");
      }
    }

    // A geometry-less compile: the engine refuses to fabricate a solid.
    const bare = compileSimScenarioWithGeometry({
      scenario: thermalScenario(),
    });
    expect(bare.ok).toBe(true);
    if (bare.ok) {
      const run = await engine.run({ compiled: bare.value });
      expect(run.ok).toBe(false);
      if (!run.ok) {
        expect(run.error.code).toBe("sim/geometry-unavailable");
      }
    }

    // A z-face condition: outside the slab's 2D statement.
    const zFaced = compileThermal(
      thermalScenario({
        conditions: [
          { kind: "fixed-temperature", face: "zMax", temperatureK: 400 },
        ],
      }),
    );
    expect(zFaced.ok).toBe(true);
    if (zFaced.ok) {
      const run = await engine.run({ compiled: zFaced.value });
      expect(run.ok).toBe(false);
      if (!run.ok) {
        expect(run.error.message).toContain("zMax");
      }
    }

    // The flow vocabulary on a thermal scenario: the coupled march's.
    const walled = compileThermal(
      thermalScenario({
        conditions: [{ kind: "wall", face: "xMin", slip: false }],
      }),
    );
    expect(walled.ok).toBe(true);
    if (walled.ok) {
      const run = await engine.run({ compiled: walled.value });
      expect(run.ok).toBe(false);
      if (!run.ok) {
        expect(run.error.message).toContain("coupled");
      }
    }
  });

  it("runs the sealed transient march with histories and the ledger scalars", async () => {
    const compiled = compileThermal(
      thermalScenario({
        thermal: {
          radiationMode: "off",
          solveMode: "transient",
          cht: false,
          sourceW: 8,
          initialTemperatureK: 293.15,
          ambientConvectionWPerM2K: 5,
          durationS: 40,
          sampleIntervalS: 5,
        },
      }),
    );
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    const engine = createThermalSimEngine();
    const result = await engine.run({ compiled: compiled.value });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.summary.status).toBe("completed");
    expect(result.value.histories.map((series) => series.name)).toContain(
      "temperature-max",
    );
    const quantity = (name: string): number | undefined =>
      result.value.summary.quantities.find((row) => row.name === name)?.value;
    expect(quantity("physical-duration")).toBe(40);
    expect(quantity("energy-closure")).toBeDefined();
    // The march warms the bar above its initial field, monotonically in
    // the mean: the first sample is the initial temperature.
    const maxSeries = result.value.histories.find(
      (series) => series.name === "temperature-max",
    );
    if (maxSeries !== undefined) {
      expect(maxSeries.samples[0]).toBeCloseTo(293.15, 9);
      const last = maxSeries.samples[maxSeries.samples.length - 1];
      expect(last).toBeGreaterThan(293.15);
    }
  });

  it("declines a transient material without specific heat through the material door", async () => {
    const compiled = compileThermal(
      thermalScenario({
        thermal: {
          radiationMode: "off",
          solveMode: "transient",
          cht: false,
          sourceW: 8,
          initialTemperatureK: 293.15,
          ambientConvectionWPerM2K: 5,
          durationS: 20,
          sampleIntervalS: 5,
        },
      }),
      [
        materialWire({
          id: "mat_steel",
          densityGPerCm3: 7.8,
          thermalConductivityWPerMK: 45,
        }),
      ],
    );
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    const engine = createThermalSimEngine();
    const result = await engine.run({ compiled: compiled.value });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("specific heat");
    }
  });
});
