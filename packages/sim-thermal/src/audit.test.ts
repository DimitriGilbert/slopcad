/**
 * The closed-domain energy-conservation audit pins: the steady closure
 * (in = out to solver tolerance), the exact-through-construction
 * transient closure, and the linearized mode's honesty delta — the
 * march-law ledger closes while the full-quartic net carries the
 * linearization residual, both reported, never hidden.
 */

import { describe, expect, it } from "vitest";
import type { ThermalProblem } from "./system";

import { thermalSolidMaterialFromRecord } from "./material";
import { thermalBoundaryFluxLedger } from "./audit";
import { thermalCellGrid } from "./grid";
import { STEEL_WIRE, analyticGrid } from "./fixtures";

function rodProblem(
  conditions: ThermalProblem["faceConditions"],
): ThermalProblem {
  const grid = analyticGrid([16, 1, 1], 0.001, () => true, "audit-rod");
  const classified = thermalCellGrid(grid);
  if (!classified.ok) throw new Error(classified.error.message);
  const steel = thermalSolidMaterialFromRecord(STEEL_WIRE);
  if (!steel.ok) throw new Error(steel.error.message);
  return {
    grid: classified.value,
    conductivityWPerMK: new Float64Array(16).fill(
      steel.value.thermalConductivityWPerMK,
    ),
    volumetricHeatCapacityJPerM3K: new Float64Array(16).fill(
      steel.value.volumetricHeatCapacityJPerM3K ?? 1,
    ),
    emissivity: new Float64Array(16).fill(Number.NaN),
    sourceWPerM3: new Float64Array(16),
    ambient: undefined,
    faceConditions: conditions,
    radiationMode: "off",
    radiationReferenceK: 293.15,
  };
}

describe("thermalBoundaryFluxLedger", () => {
  it("closes a Neumann-in/Dirichlet-out rod exactly at the analytic flux", () => {
    const problem = rodProblem({
      xMin: { kind: "heat-flux", fluxWPerM2: 1e5 },
      xMax: { kind: "fixed-temperature", temperatureK: 300 },
    });
    // The analytic steady profile (conduction.test.ts pins the field
    // itself): T_i = 300 + (q''/k)·(L − (i+0.5)·dx).
    const field = new Float64Array(16);
    for (let i = 0; i < 16; i += 1) {
      field[i] = 300 + (1e5 / 45) * (0.016 - (i + 0.5) * 0.001);
    }
    const ledger = thermalBoundaryFluxLedger({ problem, temperatureK: field });
    // In: q''·A = 0.1 W; out through the Dirichlet face: the same.
    expect(ledger.sourceW).toBe(0);
    expect(ledger.neumannInW).toBeCloseTo(0.1, 12);
    expect(ledger.dirichletNetW).toBeCloseTo(-0.1, 9);
    expect(ledger.convectionOutW).toBe(0);
    expect(ledger.radiationOutW).toBe(0);
    expect(ledger.enclosureImbalanceW).toBe(0);
    expect(ledger.netW).toBeCloseTo(0, 10);
    expect(ledger.fullLawNetW).toBeCloseTo(0, 10);
  });

  it("splits convection and radiation at an ambient boundary (full law)", () => {
    const grid = analyticGrid([1, 1, 1], 0.05, () => true, "audit-cube");
    const classified = thermalCellGrid(grid);
    if (!classified.ok) throw new Error(classified.error.message);
    const material = thermalSolidMaterialFromRecord(STEEL_WIRE);
    if (!material.ok) throw new Error(material.error.message);
    const problem: ThermalProblem = {
      grid: classified.value,
      conductivityWPerMK: new Float64Array([45]),
      volumetricHeatCapacityJPerM3K: new Float64Array([1]),
      emissivity: new Float64Array([0.8]),
      sourceWPerM3: new Float64Array([0]),
      ambient: {
        heatTransferCoefficientWPerM2K: 5,
        ambientTemperatureK: 293.15,
      },
      faceConditions: {},
      radiationMode: "full",
      radiationReferenceK: 400,
    };
    const temperature = new Float64Array([450]);
    const ledger = thermalBoundaryFluxLedger({
      problem,
      temperatureK: temperature,
    });
    // Hand: A = 0.015 m². Convection 5·0.015·(450 − 293.15); radiation
    // 0.8·σ·0.015·(450⁴ − 293.15⁴).
    expect(ledger.convectionOutW).toBeCloseTo(5 * 0.015 * (450 - 293.15), 9);
    expect(ledger.radiationOutW).toBeCloseTo(
      0.8 * 5.670374419e-8 * 0.015 * (450 ** 4 - 293.15 ** 4),
      9,
    );
    expect(ledger.fullLawNetW).toBeCloseTo(
      -(ledger.convectionOutW + ledger.radiationOutW),
      9,
    );
  });

  it("reports the linearization residual as the march/full-law delta (not hidden)", () => {
    const grid = analyticGrid([1, 1, 1], 0.05, () => true, "audit-lin");
    const classified = thermalCellGrid(grid);
    if (!classified.ok) throw new Error(classified.error.message);
    const problem: ThermalProblem = {
      grid: classified.value,
      conductivityWPerMK: new Float64Array([45]),
      volumetricHeatCapacityJPerM3K: new Float64Array([1]),
      emissivity: new Float64Array([0.8]),
      sourceWPerM3: new Float64Array([2e5]),
      ambient: {
        heatTransferCoefficientWPerM2K: 5,
        ambientTemperatureK: 293.15,
      },
      faceConditions: {},
      radiationMode: "linearized",
      radiationReferenceK: 500,
    };
    // The linearized equilibrium: the linearized law balances exactly,
    // and the full quartic at that temperature does not — by the
    // residual the audit reports (the radiation.test.ts band's source).
    const hRad =
      0.8 * 5.670374419e-8 * (500 + 293.15) * (500 ** 2 + 293.15 ** 2);
    const equilibrium =
      293.15 + (2e5 * 0.05 ** 3) / (6 * 0.05 ** 2 * (5 + hRad));
    const ledger = thermalBoundaryFluxLedger({
      problem,
      temperatureK: new Float64Array([equilibrium]),
    });
    expect(ledger.netW).toBeCloseTo(0, 9);
    expect(Math.abs(ledger.fullLawNetW)).toBeGreaterThan(0.05);
  });
});
