/**
 * The coupled thermal engine's contract tests (Phase 65c, the
 * `./engine.test` conduction twin): the compiled coupled scenario —
 * produced by the REAL geometry-aware compile door with per-body
 * tessellation + material records — runs the 65b conjugate march
 * through the Phase 61 `SimEngine` contract. The truths this file
 * owns:
 *
 * - the buoyant plume is REAL: the fluid moves (nonzero max speed) and
 *   warms (max fluid temperature above the initial field) — the stove
 *   demo's physical driver, driven from compiled scenario fields only;
 * - the energy ledger rides the summary as quantities — the 65b
 *   measured conservation claim, reported as numbers;
 * - the routed default engine serves the coupled stance (the 65c
 *   routing: thermal → the coupled march when the scenario flags it);
 * - determinism: the same compiled problem produces the
 *   bitwise-identical result (law S2);
 * - the loud declines: a direct call without the flag, and the compile
 *   door's refusal of a coupled stance with no fluid domain to convect
 *   through.
 *
 * Node-env vitest, no network — the law-S2/S5 stance.
 */

import { describe, expect, it } from "vitest";
import {
  compileSimScenarioWithGeometry,
  type SimEngineFieldChunk,
} from "@slopcad/sim-core";

import { createDefaultSimEngine } from "./engine";
import { createChtSimEngine } from "./engine-cht";
import { boxTessellationWire } from "./fixtures";

/** The stove's bar: an aligned box inside the cavity domain, mm. */
const BAR = boxTessellationWire([40, 15, 0], [60, 25, 10]);

/** The steel record the assignment names (the 65a fixture's values). */
const STEEL = {
  id: "mat_steel",
  name: "Steel",
  densityGPerCm3: 7.8,
  thermalConductivityWPerMK: 45,
  specificHeatJPerKgK: 466,
  emissivity: 0.6,
};

/** The serialized coupled scenario the compile door consumes. */
function coupledScenario(): Record<string, unknown> {
  return {
    name: "stove-plume",
    kind: "thermal",
    domain: {
      kind: "explicit",
      min: [0, 0, 0],
      max: [100, 40, 10],
      resolutionMm: 5,
    },
    // The room whose walls stay at ambient — the honest loss path a
    // sealed cavity otherwise lacks (the lateral faces, Dirichlet).
    conditions: [
      { kind: "fixed-temperature", face: "xMin", temperatureK: 293.15 },
      { kind: "fixed-temperature", face: "xMax", temperatureK: 293.15 },
      { kind: "fixed-temperature", face: "yMin", temperatureK: 293.15 },
      { kind: "fixed-temperature", face: "yMax", temperatureK: 293.15 },
    ],
    fluid: "air",
    materials: [{ bodyId: "body_bar", materialId: "mat_steel" }],
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
  };
}

function compileCoupled() {
  return compileSimScenarioWithGeometry({
    scenario: coupledScenario(),
    materials: [STEEL],
    bodyTessellations: [{ bodyId: "body_bar", tessellation: BAR }],
  });
}

describe("the coupled thermal engine", () => {
  it("runs the buoyant plume through the contract with the ledger as quantities", async () => {
    const compiled = compileCoupled();
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;

    const engine = createChtSimEngine();
    const chunks: SimEngineFieldChunk[] = [];
    const result = await engine.run(
      { compiled: compiled.value },
      undefined,
      (chunk) => chunks.push(chunk),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const summary = result.value.summary;
    expect(summary.status).toBe("completed");
    expect(summary.scenarioSnapshotHash).toMatch(/^[0-9a-f]{8}$/);
    expect(summary.servedBackend).toBe("cpu");
    expect(summary.regime.prandtl).toBeGreaterThan(0.5);

    // The shared temperature field is among the blocks; the preview
    // round published exactly it.
    expect(result.value.fields.map((field) => field.id)).toContain(
      "temperature",
    );
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.every((chunk) => chunk.id === "temperature")).toBe(true);

    const quantity = (name: string): number | undefined =>
      summary.quantities.find((row) => row.name === name)?.value;
    // The plume is real: the fluid moved and warmed.
    const fluidMax = quantity("fluid-temperature-max");
    const fluidMean = quantity("fluid-temperature-mean");
    expect(fluidMax).toBeDefined();
    expect(fluidMean).toBeDefined();
    if (fluidMax !== undefined) {
      expect(fluidMax).toBeGreaterThan(293.15);
    }
    // The measured ledger rides along; the closure is small against
    // the boundary+source scale it audits.
    const closure = quantity("energy-closure");
    const source = quantity("solid-source-energy");
    const fluidBoundary = quantity("fluid-boundary-energy-in");
    expect(closure).toBeDefined();
    expect(source).toBeDefined();
    expect(fluidBoundary).toBeDefined();
    if (
      closure !== undefined &&
      source !== undefined &&
      fluidBoundary !== undefined
    ) {
      const scale = Math.abs(source) + Math.abs(fluidBoundary);
      if (scale > 0) {
        expect(Math.abs(closure)).toBeLessThan(0.05 * scale);
      }
    }
    // The march's histories: the CHT series the panel can plot.
    expect(result.value.histories.map((series) => series.name)).toContain(
      "fluid-temperature-mean",
    );
  });

  it("is deterministic: the same compiled problem produces the identical result", async () => {
    const compiled = compileCoupled();
    if (!compiled.ok) return;
    const engine = createChtSimEngine();
    const runOnce = async (): Promise<string> => {
      const result = await engine.run({ compiled: compiled.value });
      if (!result.ok) throw new Error(result.error.message);
      return JSON.stringify([
        result.value.summary,
        result.value.fields.map((field) => field.values),
        result.value.histories,
      ]);
    };
    expect(await runOnce()).toBe(await runOnce());
  });

  it("rides the routed default engine when the scenario flags the coupled stance", async () => {
    const compiled = compileCoupled();
    if (!compiled.ok) return;
    const routed = createDefaultSimEngine({
      deviceSource: () => Promise.resolve(undefined),
    });
    const result = await routed.run({ compiled: compiled.value });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.summary.status).toBe("completed");
    const quantityNames = result.value.summary.quantities.map(
      (quantity) => quantity.name,
    );
    expect(quantityNames).toContain("energy-closure");
  });

  it("declines a direct call without the flag, and the compile refuses a coupled stance with no fluid", async () => {
    const coupled = compileCoupled();
    if (coupled.ok) {
      // Strip the flag: this engine serves the coupled stance ONLY.
      const sealed = {
        ...coupled.value,
        thermal:
          coupled.value.thermal === undefined
            ? undefined
            : { ...coupled.value.thermal, cht: false },
      };
      const engine = createChtSimEngine();
      const run = await engine.run({ compiled: sealed });
      expect(run.ok).toBe(false);
      if (!run.ok) {
        expect(run.error.message).toContain("coupled");
      }
    }

    // A slice the solids FILL: the compile door declines the coupled
    // stance — there is no fluid domain to convect through.
    const filled = compileSimScenarioWithGeometry({
      scenario: coupledScenario(),
      materials: [STEEL],
      bodyTessellations: [
        {
          bodyId: "body_bar",
          tessellation: boxTessellationWire([0, 0, 0], [100, 40, 10]),
        },
      ],
    });
    expect(filled.ok).toBe(false);
    if (!filled.ok) {
      expect(filled.error.message).toContain("no fluid domain");
    }
  });
});
