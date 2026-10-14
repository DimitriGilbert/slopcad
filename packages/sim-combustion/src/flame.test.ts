/**
 * Adiabatic-flame pins (Phase 68a): equilibrium values against
 * published CEA-adjacent references, honestly banded for the
 * engineering-adjacent positioning — adiabatic flame temperatures of
 * stoichiometric H2–air, CH4–air, and the octanes in air at 298.15 K
 * inlet and 1 atm against the standard textbook values (Turns, An
 * Introduction to Combustion, 2nd ed., 2000, ch. 2: H2/air ≈ 2380 K,
 * CH4/air ≈ 2226 K; octane/air ≈ 2270 K from the gasoline-surrogate
 * literature — e.g. Heyne, Mehl, et al. and the CEA tables the
 * combustion community cites), major product mole fractions in CEA-
 * table bands, φ-sweep structure (peak flame temperature near
 * stoichiometric, monotone lean/rich falloff), the pressure and
 * inlet-temperature trends (Le Chatelier's principle), and the
 * deterministic CSV projection (law S7).
 */

import { describe, expect, it } from "vitest";

import { adiabaticFlame, exportFuelAirTableCsv, fuelAirTable } from "./flame";
import { premixedFuelAirInlet, solveEquilibriumHP } from "./index";

function must<T>(
  result:
    | { readonly ok: true; readonly value: T }
    | { readonly ok: false; readonly error: { readonly message: string } },
  what: string,
): T {
  if (!result.ok) throw new Error(`${what}: ${result.error.message}`);
  return result.value;
}

const STANDARD_INLET = {
  inletTK: 298.15,
  pressureBar: 1.01325,
} as const;

describe("adiabatic flame temperatures against published values", () => {
  it.each([
    // [fuel, published T_ad (K), band (K)] — Turns 2nd ed. and the
    // CEA-adjacent gasoline-surrogate literature; bands state the
    // data-fit and reference convention spread honestly.
    ["H2", 2380, 60],
    ["CH4", 2226, 60],
    ["C8H18-ISO", 2270, 70],
    ["C8H18-N", 2270, 70],
  ])("%s-air stoichiometric", (fuel, published, band) => {
    const flame = must(
      adiabaticFlame({
        fuel,
        equivalenceRatio: 1,
        ...STANDARD_INLET,
      }),
      `the ${fuel} flame`,
    );
    expect(Math.abs(flame.solution.temperatureK - published)).toBeLessThan(
      band,
    );
    // The energy balance closes by construction of the HP solve; pin
    // the residual the solution reports.
    expect(flame.solution.residuals.enthalpy).toBeLessThan(1e-7);
    expect(flame.solution.residuals.elementBalance).toBeLessThan(1e-9);
  });

  it("reproduces the published major species of stoichiometric flames", () => {
    // CEA-table bands (Turns 2nd ed., ch. 2 equilibrium tables; the
    // exact split varies with the air model — the bands absorb it).
    const hydrogen = must(
      adiabaticFlame({ fuel: "H2", equivalenceRatio: 1, ...STANDARD_INLET }),
      "the H2 flame",
    );
    expect(hydrogen.solution.moleFractions.H2O).toBeGreaterThan(0.3);
    expect(hydrogen.solution.moleFractions.H2O).toBeLessThan(0.34);
    expect(hydrogen.solution.moleFractions.H2 ?? 0).toBeGreaterThan(0.01);
    expect(hydrogen.solution.moleFractions.H2 ?? 0).toBeLessThan(0.03);
    expect(hydrogen.solution.moleFractions.OH ?? 0).toBeGreaterThan(0.004);
    expect(hydrogen.solution.moleFractions.OH ?? 0).toBeLessThan(0.011);

    const methane = must(
      adiabaticFlame({ fuel: "CH4", equivalenceRatio: 1, ...STANDARD_INLET }),
      "the CH4 flame",
    );
    expect(methane.solution.moleFractions.CO2).toBeGreaterThan(0.075);
    expect(methane.solution.moleFractions.CO2).toBeLessThan(0.095);
    expect(methane.solution.moleFractions.H2O).toBeGreaterThan(0.17);
    expect(methane.solution.moleFractions.H2O).toBeLessThan(0.195);
    expect(methane.solution.moleFractions.CO ?? 0).toBeGreaterThan(0.004);
    expect(methane.solution.moleFractions.CO ?? 0).toBeLessThan(0.014);
  });

  it("reproduces the oxy-fuel hydrogen temperature (no nitrogen)", () => {
    // H2 + 0.5 O2 at 1 bar (the air stream's nitrogen and argon
    // zeroed — the honest oxy-fuel reduction of the premixed inlet):
    // ~3077 K in every CEA-adjacent table.
    const inlet = must(
      premixedFuelAirInlet({
        fuel: "H2",
        equivalenceRatio: 1,
        inletTK: 298.15,
      }),
      "the oxy inlet",
    );
    const solved = must(
      solveEquilibriumHP({
        elementTotals: { ...inlet.elementTotals, N: 0, AR: 0 },
        targetEnthalpyJ: inlet.enthalpyJ,
        pressureBar: 1,
        initialTemperatureK: 298.15,
      }),
      "the oxy solve",
    );
    expect(Math.abs(solved.temperatureK - 3077)).toBeLessThan(60);
    // The product set honestly excludes N-bearing species here.
    expect(solved.speciesNames).not.toContain("N2");
    expect(solved.moleFractions.H2O).toBeGreaterThan(0.55);
  });
});

describe("the fuel–air table's structure", () => {
  const SWEEP = {
    phiFrom: 0.4,
    phiTo: 1.6,
    steps: 12,
    ...STANDARD_INLET,
  } as const;

  it("peaks near stoichiometric and falls off on both sides", () => {
    for (const fuel of ["H2", "CH4", "C8H18-ISO"] as const) {
      const table = must(fuelAirTable({ fuel, ...SWEEP }), `the ${fuel} table`);
      const temps = table.rows.map((row) => row.adiabaticFlameTemperatureK);
      const phis = table.rows.map((row) => row.equivalenceRatio);
      const peakIndex = temps.indexOf(Math.max(...temps));
      // The grid is φ = 0.4 + 0.1·k; the peak sits at k = 6 or 7
      // (φ = 1.0 or 1.1 — dissociation shifts it slightly rich).
      expect(peakIndex, fuel).toBeGreaterThanOrEqual(6);
      expect(peakIndex, fuel).toBeLessThanOrEqual(7);
      // Lean side strictly rising toward the peak.
      for (let i = 1; i <= peakIndex; i += 1) {
        const here = temps[i];
        const before = temps[i - 1];
        if (here === undefined || before === undefined) {
          throw new Error("missing sweep row");
        }
        expect(here, `${fuel} lean at φ=${String(phis[i])}`).toBeGreaterThan(
          before,
        );
      }
      // Rich side strictly falling past the peak.
      for (let i = peakIndex + 1; i < temps.length; i += 1) {
        const here = temps[i];
        const before = temps[i - 1];
        if (here === undefined || before === undefined) {
          throw new Error("missing sweep row");
        }
        expect(here, `${fuel} rich at φ=${String(phis[i])}`).toBeLessThan(
          before,
        );
      }
      // Every row converged honestly within the iteration cap.
      for (const row of table.rows) {
        expect(row.iterations).toBeLessThan(500);
      }
    }
  });

  it("runs lean with oxygen leftover and rich with CO and H2", () => {
    const table = must(
      fuelAirTable({ fuel: "CH4", ...SWEEP }),
      "the CH4 table",
    );
    const lean = table.rows[0];
    const rich = table.rows[table.rows.length - 1];
    if (lean === undefined || rich === undefined) throw new Error("rows");
    expect(lean.moleFractions.O2 ?? 0).toBeGreaterThan(0.1);
    expect(lean.moleFractions.CO ?? 0).toBeLessThan(0.001);
    expect(rich.moleFractions.CO ?? 0).toBeGreaterThan(0.02);
    expect(rich.moleFractions.H2 ?? 0).toBeGreaterThan(0.02);
    expect(rich.moleFractions.O2 ?? 0).toBeLessThan(0.001);
  });

  it("exports byte-deterministic CSV (law S7)", () => {
    const first = must(fuelAirTable({ fuel: "CH4", ...SWEEP }), "first");
    const second = must(fuelAirTable({ fuel: "CH4", ...SWEEP }), "second");
    const csvFirst = must(exportFuelAirTableCsv(first), "export one");
    const csvSecond = must(exportFuelAirTableCsv(second), "export two");
    expect(csvSecond).toBe(csvFirst);
    const lines = csvFirst.split("\n");
    expect(lines[0]).toContain("equivalence-ratio (-)");
    expect(lines[0]).toContain("adiabatic-flame-temperature (K)");
    expect(lines[0]).toContain("mole-fraction-CO2 (-)");
    // 1 header + 13 rows + trailing empty from the final newline.
    expect(lines.length).toBe(1 + 13 + 1);
    expect(csvFirst.endsWith("\n")).toBe(true);
  });

  it("declines structured on bad spans", () => {
    const zero = fuelAirTable({
      fuel: "CH4",
      phiFrom: 0.5,
      phiTo: 1.5,
      steps: 0,
      ...STANDARD_INLET,
    });
    expect(zero.ok).toBe(false);
    if (!zero.ok) {
      expect(zero.error.code).toBe("sim/scenario-invalid");
    }
    const negative = fuelAirTable({
      fuel: "CH4",
      phiFrom: -1,
      phiTo: 1,
      steps: 2,
      ...STANDARD_INLET,
    });
    expect(negative.ok).toBe(false);
  });
});

describe("the thermodynamic trends around a flame", () => {
  it("raises T_ad with pressure (Le Chatelier suppresses dissociation)", () => {
    const low = must(
      adiabaticFlame({
        fuel: "CH4",
        equivalenceRatio: 1,
        inletTK: 298.15,
        pressureBar: 1.01325,
      }),
      "1 atm",
    );
    const high = must(
      adiabaticFlame({
        fuel: "CH4",
        equivalenceRatio: 1,
        inletTK: 298.15,
        pressureBar: 40,
      }),
      "40 bar",
    );
    expect(high.solution.temperatureK).toBeGreaterThan(
      low.solution.temperatureK + 40,
    );
    expect(high.solution.moleFractions.CO2 ?? 0).toBeGreaterThan(
      low.solution.moleFractions.CO2 ?? 0,
    );
  });

  it("raises T_ad with inlet temperature (sensible heat rides along)", () => {
    const cold = must(
      adiabaticFlame({
        fuel: "C8H18-ISO",
        equivalenceRatio: 1,
        inletTK: 298.15,
        pressureBar: 1.01325,
      }),
      "cold inlet",
    );
    const hot = must(
      adiabaticFlame({
        fuel: "C8H18-ISO",
        equivalenceRatio: 1,
        inletTK: 600,
        pressureBar: 1.01325,
      }),
      "hot inlet",
    );
    // The rise is smaller than the inlet preheat (the products'
    // heat capacity near flame temperature exceeds the reactants' at
    // the inlet — the standard T_ad-vs-preheat behavior): ~136 K for
    // this 302 K preheat.
    expect(hot.solution.temperatureK).toBeGreaterThan(
      cold.solution.temperatureK + 100,
    );
    expect(hot.solution.temperatureK).toBeLessThan(
      cold.solution.temperatureK + 200,
    );
  });

  it("keeps the octane isomers within a few kelvin of each other", () => {
    // Isomeric fuels burn to identical products; the flame temperature
    // differs only through the formation enthalpy difference their
    // own NASA-7 fits carry (iso ≈ −224.0 vs n ≈ −208.7 kJ/mol — n is
    // the less-negative, hotter-burning one by that bookkeeping).
    const iso = must(
      adiabaticFlame({
        fuel: "C8H18-ISO",
        equivalenceRatio: 1,
        ...STANDARD_INLET,
      }),
      "iso",
    );
    const normal = must(
      adiabaticFlame({
        fuel: "C8H18-N",
        equivalenceRatio: 1,
        ...STANDARD_INLET,
      }),
      "normal",
    );
    expect(
      Math.abs(normal.solution.temperatureK - iso.solution.temperatureK),
    ).toBeLessThan(10);
  });
});
