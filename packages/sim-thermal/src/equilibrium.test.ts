/**
 * The §7.12 equilibrium fixture — the roadmap's law pin: an enclosed
 * heat source settles at the temperature where the source power equals
 * the wall's convection + radiation losses, verified against a hand
 * energy balance (scalar bisection of P = h·A·(T − T_amb) +
 * ε·σ·A·(T⁴ − T_amb⁴) at the settled T), with the audit closing on the
 * solver's own numbers and the enclosure exchange conserving exactly.
 */

import { describe, expect, it } from "vitest";
import { SIM_ERROR_CODES } from "@slopcad/sim-core";
import type { ThermalRunScenario } from "./run";

import { STEFAN_BOLTZMANN_W_PER_M2_K4 } from "./radiation";
import { runThermalScenario } from "./run";
import { thermalSolidMaterialFromRecord } from "./material";
import {
  analyticGrid,
  shellGrid,
  testFluid,
  uniformMaterialIndex,
} from "./fixtures";

const T_AMB = 293.15;
const H = 10;
const EMISSIVITY = 0.6;
const CELL = 0.005;
const OUTER = 7;

/** The shell's exterior area: 6 faces of 7×7 cells. */
const AREA_EXT = 6 * 49 * CELL * CELL;

/** The hand balance's settled temperature by bisection (the §7.12 fixture's truth). */
function settledTemperatureK(powerW: number, withRadiation: boolean): number {
  let low = T_AMB;
  let high = 2000;
  for (let iteration = 0; iteration < 200; iteration += 1) {
    const mid = (low + high) / 2;
    const loss =
      H * AREA_EXT * (mid - T_AMB) +
      (withRadiation
        ? EMISSIVITY *
          STEFAN_BOLTZMANN_W_PER_M2_K4 *
          AREA_EXT *
          (mid ** 4 - T_AMB ** 4)
        : 0);
    if (loss < powerW) {
      low = mid;
    } else {
      high = mid;
    }
  }
  return (low + high) / 2;
}

function shellScenario(
  radiationMode: "off" | "full",
  sourceWPerM3: number,
): ThermalRunScenario {
  const grid = shellGrid(OUTER, 2, 4, CELL, "stove");
  const material = thermalSolidMaterialFromRecord({
    id: "mat_shell",
    name: "Shell",
    densityGPerCm3: 8.96,
    thermalConductivityWPerMK: 400,
    specificHeatJPerKgK: 385,
    emissivity: EMISSIVITY,
  });
  if (!material.ok) throw new Error(material.error.message);
  const source = new Float64Array(OUTER ** 3);
  for (let cell = 0; cell < OUTER ** 3; cell += 1) {
    if (grid.cells[cell] === 1) source[cell] = sourceWPerM3;
  }
  return {
    name: "stove",
    grid,
    materials: [material.value],
    cellMaterialIndex: uniformMaterialIndex(grid, 1),
    fluid: testFluid(),
    ambient: {
      heatTransferCoefficientWPerM2K: H,
      ambientTemperatureK: T_AMB,
    },
    radiationMode,
    sourceWPerM3: source,
    characteristicLengthM: OUTER * CELL,
    mode: { kind: "steady", toleranceK: 1e-11, maxIterations: 20_000 },
  };
}

describe("the enclosed-heat-source equilibrium (§7.12)", () => {
  it("settles where source = wall convection + radiation (hand balance, full law)", () => {
    const shellCells = OUTER ** 3 - 3 ** 3;
    const powerW = 4e5 * shellCells * CELL ** 3;
    const settled = settledTemperatureK(powerW, true);
    const run = runThermalScenario(shellScenario("full", 4e5));
    expect(run.ok).toBe(true);
    if (!run.ok) return;
    const { temperatures, balance } = run.value;
    // High-k shell → uniform; the wall gradient is P·t/(kA) ≈ 0.03 K,
    // so every cell sits at the hand-balance temperature within 0.5 K.
    expect(temperatures.maxK).toBeCloseTo(settled, 0);
    expect(Math.abs(temperatures.maxK - settled)).toBeLessThan(0.5);
    expect(Math.abs(temperatures.minK - settled)).toBeLessThan(0.5);
    // The audit: the source power leaves through convection + radiation
    // at the settled field, and the ledger closes to solver tolerance.
    expect(balance.sourceW).toBeCloseTo(powerW, 6);
    expect(balance.convectionOutW + balance.radiationOutW).toBeCloseTo(
      powerW,
      6,
    );
    expect(Math.abs(balance.netW)).toBeLessThan(1e-6);
    // The enclosure exchange conserves identically (measured).
    expect(balance.enclosureImbalanceW).toBeLessThan(1e-9);
    // And the enclosure's radiosity temperature sits at the shell's.
    expect(run.value.enclosures.length).toBe(1);
    const enclosure = run.value.enclosures[0];
    expect(enclosure?.cellCount).toBe(27);
    expect(enclosure?.surfaceAreaM2).toBeCloseTo(6 * 9 * CELL * CELL, 12);
    expect(Math.abs((enclosure?.temperatureK ?? 0) - settled)).toBeLessThan(1);
  });

  it("settles at the pure-convection equilibrium when radiation is off", () => {
    const shellCells = OUTER ** 3 - 3 ** 3;
    const powerW = 4e5 * shellCells * CELL ** 3;
    const settled = settledTemperatureK(powerW, false);
    const run = runThermalScenario(shellScenario("off", 4e5));
    expect(run.ok).toBe(true);
    if (!run.ok) return;
    expect(Math.abs(run.value.temperatures.maxK - settled)).toBeLessThan(0.5);
    expect(run.value.balance.radiationOutW).toBe(0);
    expect(run.value.balance.convectionOutW).toBeCloseTo(powerW, 6);
    expect(Math.abs(run.value.balance.netW)).toBeLessThan(1e-7);
  });

  it("refuses a steady solve with no temperature anchor (all-adiabatic + source)", () => {
    const grid = analyticGrid([4, 1, 1], CELL, () => true, "insulated-source");
    const material = thermalSolidMaterialFromRecord({
      id: "mat_x",
      name: "X",
      densityGPerCm3: 7.8,
      thermalConductivityWPerMK: 45,
      specificHeatJPerKgK: 466,
    });
    if (!material.ok) throw new Error(material.error.message);
    const run = runThermalScenario({
      name: "no-anchor",
      grid,
      materials: [material.value],
      cellMaterialIndex: uniformMaterialIndex(grid, 1),
      fluid: testFluid(),
      radiationMode: "off",
      sourceWPerM3: new Float64Array(4).fill(1e5),
      characteristicLengthM: 0.02,
      mode: { kind: "steady" },
    });
    expect(run.ok).toBe(false);
    if (run.ok) return;
    expect(run.error.message).toContain("no temperature anchor");
  });

  it("refuses a heated island no anchor reaches (per-component analysis)", () => {
    // The validator's repro: an 8×1×1 rod where cells 0–4 are anchored
    // by the xMin Dirichlet wall, cell 5 is a cavity, cell 6 is a
    // heated island bounded by that cavity and adiabatic faces, and
    // cell 7 is exterior fluid. The island is its own zero-conductance
    // component touching no anchor — the old door saw the ONE Dirichlet
    // face anywhere, let the singular row park cell 6 at its initial
    // temperature with residual ≈ 0, and reported "completed": a
    // fabricated success the per-component door now declines loudly.
    const grid = analyticGrid(
      [8, 1, 1],
      CELL,
      (i) => i !== 5 && i !== 7,
      "heated-island",
    );
    const material = thermalSolidMaterialFromRecord({
      id: "mat_island",
      name: "Island",
      densityGPerCm3: 7.8,
      thermalConductivityWPerMK: 45,
      specificHeatJPerKgK: 466,
    });
    if (!material.ok) throw new Error(material.error.message);
    const source = new Float64Array(8);
    source[6] = 1e6;
    const run = runThermalScenario({
      name: "heated-island",
      grid,
      materials: [material.value],
      cellMaterialIndex: uniformMaterialIndex(grid, 1),
      fluid: testFluid(),
      conditions: [
        { kind: "fixed-temperature", face: "xMin", temperatureK: 300 },
      ],
      radiationMode: "off",
      sourceWPerM3: source,
      characteristicLengthM: 0.08,
      mode: { kind: "steady" },
    });
    expect(run.ok).toBe(false);
    if (run.ok) return;
    expect(run.error.code).toBe(SIM_ERROR_CODES.scenarioInvalid);
    expect(run.error.message).toContain("no temperature anchor");
    expect(run.error.message).toContain("6");
  });
});
