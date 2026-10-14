/**
 * The §7.12 radiation pins: the Stefan–Boltzmann forms against hand
 * numbers, the uniform-radiosity enclosure exchange's exact internal
 * conservation, and the LINEARIZED vs FULL cross-check through the
 * solver — the settled-temperature band the standard fixed-reference
 * linearization admits, stated (a mediocre estimate reference lands
 * within tens of kelvin; the exact equilibrium as reference collapses
 * the error).
 */

import { describe, expect, it } from "vitest";
import { SIM_ERROR_CODES } from "@slopcad/sim-core";
import type { ThermalRunScenario } from "./run";

import {
  STEFAN_BOLTZMANN_W_PER_M2_K4,
  enclosureNetExchangeW,
  enclosureRadiosityTemperatureK,
  linearizedRadiationCoefficientWPerM2K,
  stefanBoltzmannFluxWPerM2,
} from "./radiation";
import { thermalSolidMaterialFromRecord } from "./material";
import { runThermalScenario } from "./run";
import { analyticGrid, testFluid, uniformMaterialIndex } from "./fixtures";

describe("the Stefan–Boltzmann forms", () => {
  it("evaluates the quartic flux against the hand number", () => {
    expect(stefanBoltzmannFluxWPerM2(1, 300, 300)).toBe(0);
    // σ·(400⁴ − 300⁴) = 5.670374419e-8 · 1.75e10 = 992.3 W/m².
    expect(stefanBoltzmannFluxWPerM2(1, 400, 300)).toBeCloseTo(
      STEFAN_BOLTZMANN_W_PER_M2_K4 * (400 ** 4 - 300 ** 4),
      6,
    );
    expect(stefanBoltzmannFluxWPerM2(0.8, 400, 300)).toBeCloseTo(
      0.8 * STEFAN_BOLTZMANN_W_PER_M2_K4 * (400 ** 4 - 300 ** 4),
      6,
    );
    // A colder surface than its environment gains (negative loss).
    expect(stefanBoltzmannFluxWPerM2(1, 300, 400)).toBeLessThan(0);
  });

  it("evaluates the standard linearized coefficient ε·σ·(T_ref + T_env)·(T_ref² + T_env²)", () => {
    const expected =
      0.8 *
      STEFAN_BOLTZMANN_W_PER_M2_K4 *
      (500 + 293.15) *
      (500 ** 2 + 293.15 ** 2);
    expect(linearizedRadiationCoefficientWPerM2K(0.8, 500, 293.15)).toBeCloseTo(
      expected,
      9,
    );
    // The 4εσT³ small-ΔT limit: at T_ref = T_env = T the coefficient is
    // exactly 4εσT³.
    expect(linearizedRadiationCoefficientWPerM2K(1, 400, 400)).toBeCloseTo(
      4 * STEFAN_BOLTZMANN_W_PER_M2_K4 * 400 ** 3,
      9,
    );
  });
});

describe("the uniform-radiosity enclosure exchange", () => {
  it("computes T_enc as the ε·A-weighted quartic mean", () => {
    const tEnc = enclosureRadiosityTemperatureK([
      { areaM2: 1, emissivity: 0.5, temperatureK: 500 },
      { areaM2: 1, emissivity: 0.5, temperatureK: 300 },
    ]);
    // Equal ε·A weights: T_enc⁴ = (500⁴ + 300⁴)/2 — compared at the
    // kelvin scale (the quartic's own magnitude swamps absolute digits).
    expect(tEnc).toBeCloseTo(((500 ** 4 + 300 ** 4) / 2) ** 0.25, 6);
  });

  it("conserves identically: Σ q_i = 0, the hot surface losing to the cold", () => {
    const exchanges = enclosureNetExchangeW([
      { areaM2: 2, emissivity: 0.8, temperatureK: 600 },
      { areaM2: 3, emissivity: 0.4, temperatureK: 400 },
      { areaM2: 1, emissivity: 0.1, temperatureK: 350 },
    ]);
    let sum = 0;
    for (const exchange of exchanges) sum += exchange;
    expect(Math.abs(sum)).toBeLessThan(1e-9);
    expect(exchanges[0]).toBeGreaterThan(0);
    expect(exchanges[1]).toBeLessThan(0);
  });

  it("declines to NaN when nothing in the enclosure can exchange (Σ ε·A = 0)", () => {
    expect(
      Number.isNaN(
        enclosureRadiosityTemperatureK([
          { areaM2: 1, emissivity: 0, temperatureK: 500 },
        ]),
      ),
    ).toBe(true);
  });
});

describe("linearized vs full through the solver (the stated band)", () => {
  const CELL = 0.05;
  const H = 5;
  const T_AMB = 293.15;
  const EMISSIVITY = 0.8;
  const POWER_W = 2e5 * CELL ** 3;

  /** The scalar hand balance of the single-cell body at equilibrium. */
  function settledK(withFullLaw: boolean, referenceK: number): number {
    if (!withFullLaw) {
      const hRad = linearizedRadiationCoefficientWPerM2K(
        EMISSIVITY,
        referenceK,
        T_AMB,
      );
      return T_AMB + POWER_W / (6 * CELL * CELL * (H + hRad));
    }
    let low = T_AMB;
    let high = 2000;
    for (let iteration = 0; iteration < 200; iteration += 1) {
      const mid = (low + high) / 2;
      const loss =
        6 *
        CELL *
        CELL *
        (H * (mid - T_AMB) +
          EMISSIVITY * STEFAN_BOLTZMANN_W_PER_M2_K4 * (mid ** 4 - T_AMB ** 4));
      if (loss < POWER_W) low = mid;
      else high = mid;
    }
    return (low + high) / 2;
  }

  function singleCellScenario(
    radiationMode: "linearized" | "full",
    referenceK: number,
  ): ThermalRunScenario {
    const grid = analyticGrid([1, 1, 1], CELL, () => true, "cube");
    const material = thermalSolidMaterialFromRecord({
      id: "mat_cube",
      name: "Cube",
      densityGPerCm3: 8.96,
      thermalConductivityWPerMK: 400,
      specificHeatJPerKgK: 385,
      emissivity: EMISSIVITY,
    });
    if (!material.ok) throw new Error(material.error.message);
    return {
      name: "cube",
      grid,
      materials: [material.value],
      cellMaterialIndex: uniformMaterialIndex(grid, 1),
      fluid: testFluid(),
      ambient: {
        heatTransferCoefficientWPerM2K: H,
        ambientTemperatureK: T_AMB,
      },
      radiationMode,
      radiationReferenceK: referenceK,
      sourceWPerM3: new Float64Array([2e5]),
      characteristicLengthM: CELL,
      mode: {
        kind: "steady",
        toleranceK: 1e-12,
        maxIterations: 20_000,
        picardToleranceK: 1e-12,
      },
    };
  }

  it("matches each law's own scalar equilibrium (the single cell is exact)", () => {
    const full = runThermalScenario(singleCellScenario("full", 293.15));
    expect(full.ok).toBe(true);
    if (!full.ok) return;
    expect(full.value.temperatures.maxK).toBeCloseTo(settledK(true, 0), 8);

    const linearized = runThermalScenario(
      singleCellScenario("linearized", 500),
    );
    expect(linearized.ok).toBe(true);
    if (!linearized.ok) return;
    expect(linearized.value.temperatures.maxK).toBeCloseTo(
      settledK(false, 500),
      8,
    );
  });

  it("admits the stated linearization band, collapsing with a good reference", () => {
    const tFull = settledK(true, 0);
    const mediocre = settledK(false, 500);
    // Band 1 — a mediocre estimate (reference 500 K against a ~419 K
    // wall): the fixed-coefficient error, |T_lin − T_full| < 35 K.
    expect(Math.abs(mediocre - tFull)).toBeGreaterThan(1);
    expect(Math.abs(mediocre - tFull)).toBeLessThan(35);
    // Band 2 — the exact equilibrium as the reference: the linearized
    // coefficient is the secant of the quartic there, and the two laws
    // agree within 1 K.
    const good = settledK(false, tFull);
    expect(Math.abs(good - tFull)).toBeLessThan(1);
    // And the solver reproduces both linearized equilibria exactly.
    const runMediocre = runThermalScenario(
      singleCellScenario("linearized", 500),
    );
    expect(runMediocre.ok).toBe(true);
    if (!runMediocre.ok) return;
    expect(runMediocre.value.temperatures.maxK).toBeCloseTo(mediocre, 8);
    // The full-law net on the linearized solve states the honesty delta:
    // the march-law balance closes, the quartic does not (by exactly the
    // linearization residual — nonzero, and reported).
    expect(Math.abs(runMediocre.value.balance.netW)).toBeLessThan(1e-9);
    expect(Math.abs(runMediocre.value.balance.fullLawNetW)).toBeGreaterThan(
      1e-3,
    );
  });

  it("declines radiation when no emissivity can be resolved", () => {
    const grid = analyticGrid([1, 1, 1], CELL, () => true, "bare-cube");
    const bare = thermalSolidMaterialFromRecord({
      id: "mat_bare",
      name: "Bare",
      densityGPerCm3: 2.7,
      thermalConductivityWPerMK: 200,
    });
    if (!bare.ok) throw new Error(bare.error.message);
    const run = runThermalScenario({
      name: "bare",
      grid,
      materials: [bare.value],
      cellMaterialIndex: uniformMaterialIndex(grid, 1),
      fluid: testFluid(),
      ambient: {
        heatTransferCoefficientWPerM2K: H,
        ambientTemperatureK: T_AMB,
      },
      radiationMode: "full",
      characteristicLengthM: CELL,
      mode: { kind: "steady" },
    });
    expect(run.ok).toBe(false);
    if (run.ok) return;
    expect(run.error.code).toBe(SIM_ERROR_CODES.scenarioInvalid);
    expect(run.error.message).toContain("emissivity");
  });
});
