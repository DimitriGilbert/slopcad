/**
 * The transient pins: the lumped-capacitance cooling law against BOTH
 * the exact discrete solution (a single cell reduces the march to the
 * scalar backward-Euler map, pinned to machine precision) and the
 * continuous exponential (a small-Bi multi-cell body, within the stated
 * first-order scheme band), the explicit scheme's stability-disciplined
 * substepping, and the cumulative energy closure that holds by
 * construction.
 */

import { describe, expect, it } from "vitest";
import { SIM_ERROR_CODES } from "@slopcad/sim-core";
import type { ThermalRunScenario } from "./run";
import type { ThermalProblem } from "./system";

import { thermalSolidMaterialFromRecord } from "./material";
import { runThermalScenario } from "./run";
import { STEFAN_BOLTZMANN_W_PER_M2_K4 } from "./radiation";
import { thermalCellGrid } from "./grid";
import {
  thermalCellCapacityJPerK,
  thermalExplicitStabilityTimeStepS,
} from "./transient";
import {
  STEEL_WIRE,
  materialWire,
  testFluid,
  uniformMaterialIndex,
  analyticGrid,
} from "./fixtures";

const STEEL_RHOC = 7800 * 466; // 3,634,800 J/(m³·K)

function steelMaterial() {
  const parsed = thermalSolidMaterialFromRecord(STEEL_WIRE);
  if (!parsed.ok) throw new Error(parsed.error.message);
  return parsed.value;
}

function baseScenario(
  overrides: Partial<ThermalRunScenario> = {},
): ThermalRunScenario {
  const grid = analyticGrid([1, 1, 1], 0.01, () => true, "lump");
  return {
    name: "lumped",
    grid,
    materials: [steelMaterial()],
    cellMaterialIndex: uniformMaterialIndex(grid, 1),
    fluid: testFluid(),
    ambient: { heatTransferCoefficientWPerM2K: 20, ambientTemperatureK: 300 },
    radiationMode: "off",
    characteristicLengthM: 0.01,
    mode: {
      kind: "transient",
      scheme: "implicit",
      durationS: 100,
      sampleIntervalS: 10,
      initialTemperatureK: 600,
    },
    ...overrides,
  };
}

describe("transient lumped capacitance", () => {
  it("matches the exact discrete lumped map to machine precision (single cell, implicit)", () => {
    const dt = 10;
    const durationS = 100;
    const run = runThermalScenario(
      baseScenario({
        mode: {
          kind: "transient",
          scheme: "implicit",
          durationS,
          sampleIntervalS: dt,
          initialTemperatureK: 600,
        },
      }),
    );
    expect(run.ok).toBe(true);
    if (!run.ok) return;
    expect(run.value.mode.kind).toBe("transient");
    if (run.value.mode.kind !== "transient") return;
    // τ = ρcV/(hA) with V = 1e-6, A = 6e-4, h = 20 → τ = ρc/12000.
    const tau = STEEL_RHOC / 12_000;
    const mean = run.value.histories.find(
      (series) => series.name === "temperature-mean",
    );
    expect(mean).toBeDefined();
    const samples = mean?.samples ?? [];
    expect(samples.length).toBe(11); // t = 0 … 100 s inclusive
    for (let n = 0; n <= 10; n += 1) {
      const exact = 300 + 300 / (1 + dt / tau) ** n;
      expect(samples[n]).toBeCloseTo(exact, 9);
    }
    // The by-construction closure: in − out = stored, exactly.
    const { energyInJ, energyOutJ, storedJ, closureJ } =
      run.value.mode.cumulative;
    expect(Math.abs(closureJ)).toBeLessThanOrEqual(
      1e-6 * Math.max(1, Math.abs(storedJ)),
    );
    expect(energyInJ).toBe(0);
    expect(energyOutJ).toBeGreaterThan(0);
    expect(storedJ).toBeLessThan(0);
  });

  it("tracks the continuous exponential within the first-order scheme band (multi-cell, implicit)", () => {
    const grid = analyticGrid([4, 4, 4], 0.02, () => true, "block");
    const h = 20;
    const run = runThermalScenario(
      baseScenario({
        grid,
        cellMaterialIndex: uniformMaterialIndex(grid, 1),
        characteristicLengthM: 0.08,
        mode: {
          kind: "transient",
          scheme: "implicit",
          durationS: 1200,
          sampleIntervalS: 120,
          initialTemperatureK: 600,
          timeStepS: 20,
        },
      }),
    );
    expect(run.ok).toBe(true);
    if (!run.ok) return;
    if (run.value.mode.kind !== "transient") return;
    // Lumped τ = ρcV/(hA): V = 0.08³, A = 6·0.08².
    const tau = (STEEL_RHOC * 0.08 ** 3) / (h * 6 * 0.08 ** 2);
    const mean = run.value.histories.find(
      (series) => series.name === "temperature-mean",
    );
    const samples = mean?.samples ?? [];
    // Band: backward Euler's global truncation is O(dt/2τ) of the decay
    // span (dt/τ ≈ 0.083 → ~1.3 K), the interior gradient is O(Bi·ΔT)
    // with Bi = h·Lc/k ≈ 0.006 (< 0.2 K); 5 K covers both with margin.
    for (let n = 0; n < samples.length; n += 1) {
      const t = n * 120;
      const analytic = 300 + 300 * Math.exp(-t / tau);
      expect(Math.abs((samples[n] ?? 0) - analytic)).toBeLessThan(5);
    }
    // The implicit march subdivided 120 s intervals at dt = 20 s.
    expect(run.value.mode.internalSteps).toBe(60);
    expect(run.value.mode.timeStepS).toBeCloseTo(20, 12);
  });

  it("substeps the explicit scheme at the row-sum stability limit (authored dt cannot exceed it)", () => {
    const grid = analyticGrid([4, 4, 4], 0.02, () => true, "block-explicit");
    const runExplicit = runThermalScenario(
      baseScenario({
        grid,
        cellMaterialIndex: uniformMaterialIndex(grid, 1),
        characteristicLengthM: 0.08,
        mode: {
          kind: "transient",
          scheme: "explicit",
          durationS: 1200,
          sampleIntervalS: 120,
          initialTemperatureK: 600,
        },
      }),
    );
    expect(runExplicit.ok).toBe(true);
    if (!runExplicit.ok) return;
    if (runExplicit.value.mode.kind !== "transient") return;
    // The binding row is the INTERIOR cell's — the criterion divides by
    // the row sum, so the most-coupled cell binds, not the least. Face
    // area A = 0.02² = 4e-4 m²: an interior face conducts
    // k·A/d = 45 · 4e-4/0.02 = 0.9 W/K, so an interior cell's row is
    // 6 · 0.9 = 5.4 W/K (boundary rows are LOOSER: a corner's is
    // 3·0.9 + 3·h·A = 3·0.9 + 3·20·4e-4 = 2.724 W/K → a larger allowed
    // dt). Capacity ρc·V = 3.6348e6 · 0.02³ = 29.08 J/K → dt ≤ 0.5 ·
    // 29.08/5.4 ≈ 2.692 s; each 120 s interval takes
    // ceil(120/2.692) = 45 substeps → 450 over the 10-interval march
    // (radiation off ⇒ the row is field-independent, so every interval
    // subdivides identically).
    expect(runExplicit.value.mode.internalSteps).toBe(450);
    expect(runExplicit.value.mode.timeStepS).toBeCloseTo(120 / 45, 12);
    const tau = (STEEL_RHOC * 0.08 ** 3) / (20 * 6 * 0.08 ** 2);
    const mean = runExplicit.value.histories.find(
      (series) => series.name === "temperature-mean",
    );
    const samples = mean?.samples ?? [];
    for (let n = 0; n < samples.length; n += 1) {
      const t = n * 120;
      const analytic = 300 + 300 * Math.exp(-t / tau);
      expect(Math.abs((samples[n] ?? 0) - analytic)).toBeLessThan(5);
    }

    // An authored timestep LARGER than the stability limit is clamped by
    // the same substepping — the author may buy accuracy, never instability.
    const runClamped = runThermalScenario(
      baseScenario({
        grid,
        cellMaterialIndex: uniformMaterialIndex(grid, 1),
        characteristicLengthM: 0.08,
        mode: {
          kind: "transient",
          scheme: "explicit",
          durationS: 1200,
          sampleIntervalS: 120,
          initialTemperatureK: 600,
          timeStepS: 1e9,
        },
      }),
    );
    expect(runClamped.ok).toBe(true);
    if (!runClamped.ok) return;
    if (runClamped.value.mode.kind !== "transient") return;
    expect(runClamped.value.mode.internalSteps).toBe(450);
  });

  it("pins the radiation-mode stability dt to the stated row-sum criterion, counted once", () => {
    // One 0.01 m steel cube (ε = 0.6) at 600 K convecting at h = 20
    // W/(m²·K) to 300 K air. The stated criterion is the assembled row
    // counted ONCE: convection h·A plus the radiation conductance the
    // assembly itself carries — the full mode's tangent 4εσT³·A at the
    // 600 K state, or the linearized mode's fixed secant
    // εσ(T_ref+T_amb)(T_ref²+T_amb²)·A about (600, 300). The old bug
    // ADDED a second (secant) stiffness on top of the assembled row,
    // shrinking the dt by the radiation share twice; this pin holds the
    // implementation to the single-count story.
    const spacing = 0.01;
    const area = 6 * spacing * spacing;
    const capacity = STEEL_RHOC * spacing ** 3;
    const problem = (radiationMode: "full" | "linearized"): ThermalProblem => {
      const classified = thermalCellGrid(
        analyticGrid([1, 1, 1], spacing, () => true, `lump-${radiationMode}`),
      );
      if (!classified.ok) throw new Error(classified.error.message);
      return {
        grid: classified.value,
        conductivityWPerMK: new Float64Array(1).fill(45),
        volumetricHeatCapacityJPerM3K: new Float64Array(1).fill(STEEL_RHOC),
        emissivity: new Float64Array(1).fill(0.6),
        sourceWPerM3: new Float64Array(1),
        ambient: {
          heatTransferCoefficientWPerM2K: 20,
          ambientTemperatureK: 300,
        },
        faceConditions: {},
        radiationMode,
        radiationReferenceK: 600,
      };
    };
    const convectionWPerK = 20 * area;
    const tangentWPerK =
      4 * 0.6 * STEFAN_BOLTZMANN_W_PER_M2_K4 * 600 ** 3 * area;
    const secantWPerK =
      0.6 *
      STEFAN_BOLTZMANN_W_PER_M2_K4 *
      (600 + 300) *
      (600 ** 2 + 300 ** 2) *
      area;
    for (const mode of ["full", "linearized"] as const) {
      const built = problem(mode);
      const dt = thermalExplicitStabilityTimeStepS(
        built,
        new Float64Array(1).fill(600),
        thermalCellCapacityJPerK(built),
        0.5,
      );
      const expected =
        (0.5 * capacity) /
        (convectionWPerK + (mode === "full" ? tangentWPerK : secantWPerK));
      expect(dt).toBeCloseTo(expected, 9);
      // Sanity: the two radiation stances differ (tangent ≠ secant at
      // 600 K vs 300 K), so the pin cannot pass on a shared constant.
      expect(tangentWPerK).not.toBe(secantWPerK);
    }
  });

  it("closes the cumulative energy ledger of a source-driven insulated body exactly", () => {
    const grid = analyticGrid([3, 1, 1], 0.01, () => true, "heating-rod");
    const source = new Float64Array(3).fill(1e6); // W/m³ in every cell
    const durationS = 50;
    const run = runThermalScenario(
      baseScenario({
        grid,
        cellMaterialIndex: uniformMaterialIndex(grid, 1),
        ambient: undefined,
        sourceWPerM3: source,
        characteristicLengthM: 0.03,
        mode: {
          kind: "transient",
          scheme: "implicit",
          durationS,
          sampleIntervalS: 10,
          initialTemperatureK: 300,
        },
      }),
    );
    expect(run.ok).toBe(true);
    if (!run.ok) return;
    if (run.value.mode.kind !== "transient") return;
    // Stored energy must equal P·t exactly: 3 cells · 1e6 W/m³ · 1e-6 m³
    // = 3 W for 50 s → 150 J.
    expect(run.value.mode.cumulative.storedJ).toBeCloseTo(150, 6);
    expect(run.value.mode.cumulative.closureJ).toBeCloseTo(0, 8);
    expect(run.value.mode.cumulative.energyOutJ).toBe(0);
    // And the final temperature rose by exactly the per-cell energy over
    // its capacity: 50 J / (ρc·1e-6 m³).
    expect(run.value.mode.temperatureK[1]).toBeCloseTo(
      300 + 50 / (STEEL_RHOC * 1e-6),
      8,
    );
  });

  it("declines a transient march when the material lacks ρc", () => {
    const noCp = thermalSolidMaterialFromRecord(
      materialWire({
        id: "mat_konly",
        densityGPerCm3: 7.8,
        thermalConductivityWPerMK: 45,
      }),
    );
    if (!noCp.ok) throw new Error(noCp.error.message);
    const grid = analyticGrid([1, 1, 1], 0.01, () => true, "no-cp");
    const run = runThermalScenario(
      baseScenario({
        grid,
        materials: [noCp.value],
        cellMaterialIndex: uniformMaterialIndex(grid, 1),
      }),
    );
    expect(run.ok).toBe(false);
    if (run.ok) return;
    expect(run.error.code).toBe(SIM_ERROR_CODES.scenarioInvalid);
    expect(run.error.message).toContain("specific heat");
  });

  it("declines a duration that is not an integer multiple of the sample interval", () => {
    const run = runThermalScenario(
      baseScenario({
        mode: {
          kind: "transient",
          scheme: "implicit",
          durationS: 105,
          sampleIntervalS: 10,
          initialTemperatureK: 600,
        },
      }),
    );
    expect(run.ok).toBe(false);
    if (run.ok) return;
    expect(run.error.message).toContain("integer multiple");
  });
});
