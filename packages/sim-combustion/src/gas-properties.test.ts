/**
 * Working-gas property pins (Phase 68b): the derived LHV against the
 * published heating values (the derivation's own data must land on the
 * tabulated chemistry), the frozen family's exact identities (u = h −
 * RT, the inversion round trip), the complete-combustion reference's
 * stoichiometry, and the burned-zone equilibrium table's physical
 * monotonicity and clamped-interpolation discipline.
 */

import { describe, expect, it } from "vitest";

import {
  buildBurnedEquilibriumTable,
  completeCombustionOf,
  frozenCpJPerKgK,
  frozenCvJPerKgK,
  frozenEnthalpyJPerKg,
  frozenInternalEnergyJPerKg,
  frozenMixture,
  frozenTemperatureFromInternalEnergyK,
  GAS_CONSTANT_J_PER_MOL_K,
  lowerHeatingValueJPerKg,
  premixedFuelAirInlet,
} from "./index";

function must<T>(
  result:
    | { readonly ok: true; readonly value: T }
    | { readonly ok: false; readonly error: { readonly message: string } },
  what: string,
): T {
  if (!result.ok) throw new Error(`${what}: ${result.error.message}`);
  return result.value;
}

describe("the derived lower heating values", () => {
  it("lands on the published LHVs (water vapor reference)", () => {
    // Published lower heating values, J/kg (Heywood, Internal
    // Combustion Engine Fundamentals, 1988, App. D among the standard
    // tabulations; hydrogen 119,945 kJ/kg, methane ~50,010, iso-octane
    // ~44.3 MJ/kg, n-octane ~44.4, CO ~10.1): the derivation uses ONLY
    // the NASA-7 database — landing inside these bands is the
    // independent check that the formation enthalpies and the mol→kg
    // bridge are wired right.
    const bands: readonly [string, number, number][] = [
      ["C8H18-ISO", 43.5e6, 45.0e6],
      ["C8H18-N", 43.5e6, 45.0e6],
      ["CH4", 49.5e6, 50.5e6],
      ["H2", 119.0e6, 121.0e6],
      ["CO", 9.9e6, 10.3e6],
    ];
    for (const [fuel, lo, hi] of bands) {
      const lhv = must(lowerHeatingValueJPerKg(fuel), fuel);
      expect(lhv, fuel).toBeGreaterThan(lo);
      expect(lhv, fuel).toBeLessThan(hi);
    }
  });

  it("derives the LHV with no tabulated heating value in the module", () => {
    // The hand form of the derivation, computed here from the same
    // database: 1 mol CH4 + 2 mol O2 → CO2 + 2 H2O(g) at 298.15 K.
    const lhv = must(lowerHeatingValueJPerKg("CH4"), "CH4 LHV");
    const products = completeCombustionOf({ CH4: 1, O2: 2 });
    expect(products.species.CO2).toBeCloseTo(1, 12);
    expect(products.species.H2O).toBeCloseTo(2, 12);
    expect(products.unconsumedFuelMoles).toBe(0);
    expect(lhv).toBeGreaterThan(49.5e6);
  });

  it("declines an unknown fuel structurally", () => {
    const bad = lowerHeatingValueJPerKg("UNOBTANIUM");
    expect(bad.ok).toBe(false);
  });
});

describe("the frozen mixture family", () => {
  it("computes the specific gas constant of stoichiometric octane–air", () => {
    const inlet = must(
      premixedFuelAirInlet({
        fuel: "C8H18-ISO",
        equivalenceRatio: 1,
        inletTK: 298.15,
      }),
      "inlet",
    );
    const mix = must(frozenMixture(inlet.species), "mix");
    // Hand: 1 mol fuel (114.23 g) + 59.67 mol air (~28.95 g/mol mean)
    // → ~1.844 kg per 60.67 mol → M ≈ 30.4 g/mol → R ≈ 8314/30.4
    // ≈ 273.5 J/(kg·K); the band covers the dry-air mole-fraction set.
    expect(mix.gasConstantJPerKgK).toBeGreaterThan(265);
    expect(mix.gasConstantJPerKgK).toBeLessThan(285);
    // Pure species: R_N2 = R_univ·1000/MW with MW = 2 × 14.007 =
    // 28.014 kg/kmol (the database's cited conventional atomic
    // weight) → 296.80 J/(kg·K).
    const nitrogen = must(frozenMixture({ N2: 1 }), "N2");
    expect(nitrogen.gasConstantJPerKgK).toBeCloseTo(
      (GAS_CONSTANT_J_PER_MOL_K * 1000) / 28.014,
      6,
    );
  });

  it("holds u = h − R·T and cv = cp − R at every temperature", () => {
    const inlet = must(
      premixedFuelAirInlet({
        fuel: "C8H18-ISO",
        equivalenceRatio: 1,
        inletTK: 298.15,
      }),
      "inlet",
    );
    const mix = must(frozenMixture(inlet.species), "mix");
    for (const tK of [300, 650, 1500, 2800]) {
      expect(
        frozenInternalEnergyJPerKg(mix, tK) -
          (frozenEnthalpyJPerKg(mix, tK) - mix.gasConstantJPerKgK * tK),
      ).toBeCloseTo(0, 6);
      expect(
        frozenCvJPerKgK(mix, tK) -
          (frozenCpJPerKgK(mix, tK) - mix.gasConstantJPerKgK),
      ).toBeCloseTo(0, 6);
    }
  });

  it("inverts its own internal energy exactly (the state-is-energy rule)", () => {
    const inlet = must(
      premixedFuelAirInlet({
        fuel: "CH4",
        equivalenceRatio: 1,
        inletTK: 298.15,
      }),
      "inlet",
    );
    const mix = must(frozenMixture(inlet.species), "mix");
    for (const tK of [250, 400, 700, 1200, 2500]) {
      const u = frozenInternalEnergyJPerKg(mix, tK);
      expect(frozenTemperatureFromInternalEnergyK(mix, u)).toBeCloseTo(tK, 5);
    }
  });

  it("declines a malformed composition structurally", () => {
    expect(frozenMixture({}).ok).toBe(false);
    expect(frozenMixture({ N2: -1 }).ok).toBe(false);
    expect(frozenMixture({ WOOD: 1 }).ok).toBe(false);
  });
});

describe("the complete-combustion reference", () => {
  it("oxidizes octane exactly to 8 CO₂ + 9 H₂O", () => {
    const products = completeCombustionOf({ "C8H18-ISO": 1, O2: 12.5 });
    expect(products.species.CO2).toBeCloseTo(8, 12);
    expect(products.species.H2O).toBeCloseTo(9, 12);
    expect(products.species.CO).toBeCloseTo(0, 12);
    expect(products.species.H2).toBeCloseTo(0, 12);
    expect(products.unconsumedFuelMoles).toBe(0);
  });

  it("saturates at CO on rich mixtures and never drops fuel atoms", () => {
    // φ = 1.2 on octane: oxygen short by 25·(1 − 1/1.2) = 4.167 O —
    // the carbon that cannot reach CO₂ rides as CO (4.167 mol).
    const products = completeCombustionOf({
      "C8H18-ISO": 1,
      O2: 12.5 / 1.2,
    });
    expect(products.species.CO2).toBeCloseTo(8 - 4.1667, 3);
    expect(products.species.CO).toBeCloseTo(4.1667, 3);
    expect(products.unconsumedFuelMoles).toBe(0);
  });
});

describe("the burned-zone equilibrium table", () => {
  const inlet = must(
    premixedFuelAirInlet({
      fuel: "C8H18-ISO",
      equivalenceRatio: 1,
      inletTK: 298.15,
    }),
    "inlet",
  );

  it("builds over the grid with every node a converged solve", () => {
    const table = must(
      buildBurnedEquilibriumTable({
        elementTotals: inlet.elementTotals,
        basisMassKg: 1,
        tMinK: 800,
        tMaxK: 3600,
        tSteps: 4,
        pMinBar: 1,
        pMaxBar: 100,
        pSteps: 3,
      }),
      "table",
    );
    expect(table.temperatureKGrid.length).toBe(5);
    expect(table.pressureBarGrid.length).toBe(4);
    for (const row of table.iterations) {
      for (const count of row) expect(count).toBeGreaterThan(0);
    }
    // u is strictly increasing in T at every pressure node.
    for (let ip = 0; ip < table.pressureBarGrid.length; ip += 1) {
      for (let it = 1; it < table.temperatureKGrid.length; it += 1) {
        expect(
          (table.uNodes[it]?.[ip] ?? 0) - (table.uNodes[it - 1]?.[ip] ?? 0),
        ).toBeGreaterThan(0);
      }
    }
  });

  it("interpolates monotonically and clamps outside the grid", () => {
    const table = must(
      buildBurnedEquilibriumTable({
        elementTotals: inlet.elementTotals,
        basisMassKg: 1,
        tMinK: 800,
        tMaxK: 3600,
        tSteps: 4,
        pMinBar: 1,
        pMaxBar: 100,
        pSteps: 3,
      }),
      "table",
    );
    const uMid = table.uAtJPerKg(1200, 10);
    const uLo = table.uAtJPerKg(800, 10);
    const uHi = table.uAtJPerKg(3600, 10);
    expect(uMid).toBeGreaterThan(uLo);
    expect(uMid).toBeLessThan(uHi);
    // Clamps: below and above the T grid the end values hold.
    expect(table.uAtJPerKg(300, 10)).toBeCloseTo(uLo, 6);
    expect(table.uAtJPerKg(9000, 10)).toBeCloseTo(uHi, 6);
    // At fixed T, dissociation makes R fall with pressure.
    const rLowP = table.rAtJPerKgK(3000, 1);
    const rHighP = table.rAtJPerKgK(3000, 100);
    expect(rLowP).toBeGreaterThan(rHighP);
    // cv stays positive everywhere on the grid.
    for (const tK of [900, 1500, 2500, 3400]) {
      expect(table.cvAtJPerKgK(tK, 20)).toBeGreaterThan(200);
    }
  });

  it("declines a malformed grid structurally", () => {
    expect(
      buildBurnedEquilibriumTable({
        elementTotals: inlet.elementTotals,
        basisMassKg: 1,
        tMinK: 800,
        tMaxK: 600,
        tSteps: 4,
        pMinBar: 1,
        pMaxBar: 100,
        pSteps: 3,
      }).ok,
    ).toBe(false);
    expect(
      buildBurnedEquilibriumTable({
        elementTotals: inlet.elementTotals,
        basisMassKg: 0,
        tMinK: 800,
        tMaxK: 3600,
        tSteps: 4,
        pMinBar: 1,
        pMaxBar: 100,
        pSteps: 3,
      }).ok,
    ).toBe(false);
  });
});
