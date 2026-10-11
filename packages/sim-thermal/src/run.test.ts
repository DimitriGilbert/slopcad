/**
 * The run-driver pins: bitwise determinism of repeat runs (law S2),
 * the S4 projection at the SimResult seam (kelvin temperatures, watt
 * powers, the field block in document-space mm geometry), the
 * snapshot-hash provenance, and the loud declines of the problem door.
 */

import { describe, expect, it } from "vitest";
import { SIM_ERROR_CODES } from "@slopcad/sim-core";
import type { ThermalRunReport, ThermalRunScenario } from "./run";

import { thermalSolidMaterialFromRecord } from "./material";
import { runThermalScenario, thermalRunSimResult } from "./run";
import { shellGrid, testFluid, uniformMaterialIndex } from "./fixtures";

function stoveScenario(sourceWPerM3 = 4e5): ThermalRunScenario {
  const grid = shellGrid(7, 2, 4, 0.005, "stove");
  const material = thermalSolidMaterialFromRecord({
    id: "mat_shell",
    name: "Shell",
    densityGPerCm3: 8.96,
    thermalConductivityWPerMK: 400,
    specificHeatJPerKgK: 385,
    emissivity: 0.6,
  });
  if (!material.ok) throw new Error(material.error.message);
  const source = new Float64Array(7 ** 3);
  for (let cell = 0; cell < 7 ** 3; cell += 1) {
    if (grid.cells[cell] === 1) source[cell] = sourceWPerM3;
  }
  return {
    name: "stove",
    grid,
    materials: [material.value],
    cellMaterialIndex: uniformMaterialIndex(grid, 1),
    fluid: testFluid(),
    ambient: {
      heatTransferCoefficientWPerM2K: 10,
      ambientTemperatureK: 293.15,
    },
    radiationMode: "full",
    sourceWPerM3: source,
    characteristicLengthM: 0.035,
    mode: { kind: "steady", toleranceK: 1e-11, maxIterations: 20_000 },
  };
}

function firstRun(): ThermalRunReport {
  const run = runThermalScenario(stoveScenario());
  if (!run.ok) throw new Error(run.error.message);
  return run.value;
}

describe("runThermalScenario determinism (law S2)", () => {
  it("produces the bitwise-identical report on repeat runs", () => {
    const a = firstRun();
    const b = runThermalScenario(stoveScenario());
    expect(b.ok).toBe(true);
    if (!b.ok) return;
    expect(b.value.scenarioSnapshotHash).toBe(a.scenarioSnapshotHash);
    expect(b.value.regime).toEqual(a.regime);
    expect(b.value.temperatures).toEqual(a.temperatures);
    expect(b.value.balance).toEqual(a.balance);
    expect(b.value.mode.kind).toBe(a.mode.kind);
    if (a.mode.kind === "steady" && b.value.mode.kind === "steady") {
      expect(b.value.mode.iterations).toBe(a.mode.iterations);
      expect(b.value.mode.outerIterations).toBe(a.mode.outerIterations);
      expect(b.value.mode.residualK).toBe(a.mode.residualK);
      const fieldA = a.mode.temperatureK;
      const fieldB = b.value.mode.temperatureK;
      expect(fieldA.length).toBe(fieldB.length);
      for (let cell = 0; cell < fieldA.length; cell += 1) {
        expect(fieldB[cell]).toBe(fieldA[cell]);
      }
    }
    expect(b.value.temperatureField?.values).toEqual(
      a.temperatureField?.values,
    );
    expect(b.value.enclosures).toEqual(a.enclosures);
  });

  it("hashes the scenario identity stably and sensitively", () => {
    const a = firstRun();
    const changed = runThermalScenario(stoveScenario(4.1e5));
    expect(changed.ok).toBe(true);
    if (!changed.ok) return;
    expect(changed.value.scenarioSnapshotHash).not.toBe(a.scenarioSnapshotHash);
    // A compile-fed hash rides through untouched.
    const fed = runThermalScenario({
      ...stoveScenario(),
      scenarioSnapshotHash: "hash-from-compile",
    });
    expect(fed.ok).toBe(true);
    if (!fed.ok) return;
    expect(fed.value.scenarioSnapshotHash).toBe("hash-from-compile");
  });
});

describe("thermalRunSimResult (the S4 seam)", () => {
  it("projects quantities with explicit units and the field to document space", () => {
    const report = firstRun();
    const result = thermalRunSimResult(report);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const quantity = (
      name: string,
    ): { value: number; unit: string } | undefined =>
      result.value.summary.quantities.find((entry) => entry.name === name);
    expect(quantity("max-temperature")?.unit).toBe("K");
    expect(quantity("max-temperature")?.value).toBeCloseTo(
      report.temperatures.maxK,
      9,
    );
    expect(quantity("source-power")?.unit).toBe("W");
    expect(quantity("net-heat-imbalance")?.unit).toBe("W");
    expect(quantity("solver-iterations")?.unit).toBe("1");
    expect(quantity("enclosure-0-temperature")?.unit).toBe("K");
    expect(result.value.summary.status).toBe("completed");
    expect(result.value.summary.servedBackend).toBe("cpu");
    expect(result.value.summary.regime).toEqual(report.regime);

    // The field block: document-space mm geometry, kelvin values.
    expect(result.value.fields.length).toBe(1);
    const block = result.value.fields[0];
    expect(block?.id).toBe("temperature");
    expect(block?.unit).toBe("K");
    expect(block?.extent).toEqual([7, 7, 7]);
    expect(block?.originMm).toEqual([0, 0, 0]);
    expect(block?.spacingMm).toEqual([5, 5, 5]);
    // Solid cells carry the solver's values; cavity cells carry T_enc;
    // the exterior fill (there is none here — sealed shell) is ambient.
    const solidCell = 0;
    expect(block?.values[solidCell]).toBeCloseTo(
      report.mode.temperatureK[solidCell] ?? 0,
      9,
    );
    const cavityCell = 2 + 3 * 7 + 3 * 49;
    expect(block?.values[cavityCell]).toBeCloseTo(
      report.enclosures[0]?.temperatureK ?? 0,
      9,
    );
  });

  it("fills a non-exchanging (all-ε=0) enclosure with the ambient, never NaN", () => {
    // A legitimate steady solve: every wall of the shell carries
    // ε = 0, so the enclosure's radiosity quotient is the 0/0 NaN
    // (Σ εA = 0 — nothing exchanges). The cavity's coarse fill must
    // fall back to the ambient instead of poisoning the field with
    // NaN — the S4 seam declines a non-finite quantity
    // (`sim/quantity-invalid`), which would misreport a good solve as
    // failed. `??` alone does not catch NaN.
    const grid = shellGrid(7, 2, 4, 0.005, "non-exchanging-shell");
    const material = thermalSolidMaterialFromRecord({
      id: "mat_black",
      name: "Black",
      densityGPerCm3: 8.96,
      thermalConductivityWPerMK: 400,
      specificHeatJPerKgK: 385,
      emissivity: 0,
    });
    if (!material.ok) throw new Error(material.error.message);
    const run = runThermalScenario({
      name: "cold-shell",
      grid,
      materials: [material.value],
      cellMaterialIndex: uniformMaterialIndex(grid, 1),
      fluid: testFluid(),
      ambient: {
        heatTransferCoefficientWPerM2K: 10,
        ambientTemperatureK: 293.15,
      },
      radiationMode: "full",
      characteristicLengthM: 0.035,
      mode: { kind: "steady", toleranceK: 1e-11, maxIterations: 20_000 },
    });
    expect(run.ok).toBe(true);
    if (!run.ok) return;
    expect(run.value.enclosures.length).toBe(1);
    expect(Number.isNaN(run.value.enclosures[0]?.temperatureK)).toBe(true);
    const result = thermalRunSimResult(run.value);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.summary.status).toBe("completed");
    const cavityCell = 2 + 3 * 7 + 3 * 49;
    const values = result.value.fields[0]?.values ?? [];
    expect(values[cavityCell]).toBe(293.15); // the ambient fill, not NaN
    for (const value of values) {
      expect(Number.isFinite(value)).toBe(true);
    }
  });
});

describe("the problem door's loud declines", () => {
  it("refuses stray material assignments on fluid cells", () => {
    const grid = shellGrid(7, 2, 4, 0.005);
    const index = new Uint16Array(7 ** 3).fill(1);
    const run = runThermalScenario({
      ...stoveScenario(),
      grid,
      cellMaterialIndex: index,
    });
    expect(run.ok).toBe(false);
    if (run.ok) return;
    expect(run.error.message).toContain("material index");
  });

  it("refuses a source on fluid cells (65b's coupling, not this phase's)", () => {
    const source = new Float64Array(7 ** 3).fill(1);
    const run = runThermalScenario({
      ...stoveScenario(),
      sourceWPerM3: source,
    });
    expect(run.ok).toBe(false);
    if (run.ok) return;
    expect(run.error.message).toContain("solid cells");
  });

  it("refuses duplicate face conditions and a wrong-length material map", () => {
    const duplicate = runThermalScenario({
      ...stoveScenario(),
      conditions: [
        { kind: "fixed-temperature", face: "xMin", temperatureK: 400 },
        { kind: "heat-flux", face: "xMin", fluxWPerM2: 1 },
      ],
    });
    expect(duplicate.ok).toBe(false);
    if (duplicate.ok) return;
    expect(duplicate.error.message).toContain("Two thermal conditions");

    const wrongLength = runThermalScenario({
      ...stoveScenario(),
      cellMaterialIndex: new Uint16Array(10),
    });
    expect(wrongLength.ok).toBe(false);
  });

  it("refuses an unknown radiation stance and non-finite sources", () => {
    // The runtime door re-validates the typed field: an invalid stance
    // reaches it only through an untyped edge, cast once for the test.
    const badMode = runThermalScenario({
      ...stoveScenario(),
      radiationMode:
        "spectral" as unknown as ThermalRunScenario["radiationMode"],
    });
    expect(badMode.ok).toBe(false);
    if (badMode.ok) return;
    expect(badMode.error.code).toBe(SIM_ERROR_CODES.scenarioInvalid);

    const grid = shellGrid(7, 2, 4, 0.005);
    const source = new Float64Array(7 ** 3).fill(Number.NaN);
    const run = runThermalScenario({
      ...stoveScenario(),
      grid,
      sourceWPerM3: source,
    });
    expect(run.ok).toBe(false);
  });
});
