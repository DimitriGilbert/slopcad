/**
 * The 1D conduction pins against analytic ground truth: the steady
 * linear profile reproduced EXACTLY by the half-cell Dirichlet
 * discretization, the Neumann/Dirichlet case with its energy balance,
 * and the two-material composite wall through the harmonic-mean
 * interface conductance. Lateral faces carry no condition — the
 * documented adiabatic (symmetry) boundary.
 */

import { describe, expect, it } from "vitest";
import type { ThermalRunScenario } from "./run";

import { thermalSolidMaterialFromRecord } from "./material";
import { runThermalScenario } from "./run";
import {
  STEEL_WIRE,
  COPPER_WIRE,
  analyticGrid,
  uniformMaterialIndex,
} from "./fixtures";

const DX = 0.001;
const N = 16;

function steel() {
  const parsed = thermalSolidMaterialFromRecord(STEEL_WIRE);
  if (!parsed.ok) throw new Error(parsed.error.message);
  return parsed.value;
}

function rodScenario(
  overrides: Partial<ThermalRunScenario> = {},
): ThermalRunScenario {
  const grid = analyticGrid([N, 1, 1], DX, () => true, "rod");
  return {
    name: "rod",
    grid,
    materials: [steel()],
    cellMaterialIndex: uniformMaterialIndex(grid, 1),
    fluid: {
      fluidId: "air",
      temperatureK: 300,
      densityKgPerM3: 1.176,
      dynamicViscosityPaS: 1.846e-5,
      kinematicViscosityM2PerS: 1.57e-5,
      thermalDiffusivityM2PerS: 2.22e-5,
      prandtl: 0.706,
      thermalExpansionPerK: 1 / 300,
      specificHeatJPerKgK: 1006,
      thermalConductivityWPerMK: 0.0263,
      speedOfSoundMPerS: 347.2,
    },
    radiationMode: "off",
    characteristicLengthM: N * DX,
    mode: { kind: "steady", toleranceK: 1e-12, maxIterations: 20_000 },
    ...overrides,
  };
}

describe("1D steady conduction vs analytic", () => {
  it("reproduces the linear profile of a Dirichlet/Dirichlet rod exactly", () => {
    const tHot = 500;
    const tCold = 300;
    const run = runThermalScenario(
      rodScenario({
        conditions: [
          { kind: "fixed-temperature", face: "xMin", temperatureK: tHot },
          { kind: "fixed-temperature", face: "xMax", temperatureK: tCold },
        ],
      }),
    );
    expect(run.ok).toBe(true);
    if (!run.ok) return;
    const field = run.value.mode.temperatureK;
    // The Dirichlet planes sit at the outer faces (±dx/2 beyond the end
    // cell centres), so the analytic cell-centre profile is linear in
    // (i + 0.5)/N — the half-cell discretization is exact for it.
    for (let i = 0; i < N; i += 1) {
      const analytic = tHot + (tCold - tHot) * ((i + 0.5) / N);
      expect(field[i]).toBeCloseTo(analytic, 9);
    }
    expect(run.value.mode.kind).toBe("steady");
    if (run.value.mode.kind !== "steady") return;
    expect(run.value.mode.residualK).toBeLessThanOrEqual(1e-12);
    // The audit: through-flow in at the hot face equals out at the cold
    // face; k·A·ΔT/L by hand: 45 · 1e-6 · 200 / 0.016 = 0.5625 W.
    expect(run.value.balance.netW).toBeCloseTo(0, 10);
    expect(Math.abs(run.value.balance.dirichletNetW)).toBeLessThan(1e-9);
  });

  it("carries a Neumann flux to a Dirichlet sink with the analytic profile and flux", () => {
    const tCold = 300;
    const qPP = 1e5; // W/m² into the rod at xMin
    const k = 45;
    const run = runThermalScenario(
      rodScenario({
        conditions: [
          { kind: "heat-flux", face: "xMin", fluxWPerM2: qPP },
          { kind: "fixed-temperature", face: "xMax", temperatureK: tCold },
        ],
      }),
    );
    expect(run.ok).toBe(true);
    if (!run.ok) return;
    const field = run.value.mode.temperatureK;
    // T(x) = T_cold + (q''/k)·(L − x) with x the cell-centre distance
    // from the hot outer face: cell i sits at (i + 0.5)·dx.
    for (let i = 0; i < N; i += 1) {
      const analytic = tCold + (qPP / k) * (N * DX - (i + 0.5) * DX);
      expect(field[i]).toBeCloseTo(analytic, 9);
    }
    // The audit: q''·A in through the Neumann face, the same power out
    // through the Dirichlet face — the closed-domain balance.
    expect(run.value.balance.neumannInW).toBeCloseTo(qPP * DX * DX, 12);
    expect(run.value.balance.dirichletNetW).toBeCloseTo(-qPP * DX * DX, 9);
    expect(run.value.balance.netW).toBeCloseTo(0, 10);
  });

  it("solves the two-material composite wall through the harmonic interface", () => {
    const steelMaterial = steel();
    const copper = thermalSolidMaterialFromRecord(COPPER_WIRE);
    if (!copper.ok) throw new Error(copper.error.message);
    const grid = analyticGrid([N, 1, 1], DX, () => true, "composite");
    const index = new Uint16Array(N);
    for (let i = 0; i < N; i += 1) {
      index[i] = i < N / 2 ? 1 : 2;
    }
    const tHot = 500;
    const tCold = 300;
    const run = runThermalScenario(
      rodScenario({
        grid,
        materials: [steelMaterial, copper.value],
        cellMaterialIndex: index,
        conditions: [
          { kind: "fixed-temperature", face: "xMin", temperatureK: tHot },
          { kind: "fixed-temperature", face: "xMax", temperatureK: tCold },
        ],
      }),
    );
    expect(run.ok).toBe(true);
    if (!run.ok) return;
    const field = run.value.mode.temperatureK;
    // Series resistances: q = ΔT / (L1/k1 + L2/k2); per-material linear
    // profiles pinned at the outer faces, continuous at the interface.
    const l1 = (N / 2) * DX;
    const l2 = (N / 2) * DX;
    const q =
      (tHot - tCold) /
      (l1 / steelMaterial.thermalConductivityWPerMK +
        l2 / copper.value.thermalConductivityWPerMK);
    for (let i = 0; i < N; i += 1) {
      const xFromHot = (i + 0.5) * DX;
      const analytic =
        xFromHot <= l1
          ? tHot - (q / steelMaterial.thermalConductivityWPerMK) * xFromHot
          : tHot -
            (q / steelMaterial.thermalConductivityWPerMK) * l1 -
            (q / copper.value.thermalConductivityWPerMK) * (xFromHot - l1);
      expect(field[i]).toBeCloseTo(analytic, 9);
    }
  });
});
