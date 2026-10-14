/**
 * Reactant-stream pins (Phase 68a): the equivalence-ratio arithmetic,
 * the dry-air anchor (U.S. Standard Atmosphere 1976, as published),
 * element totals and inlet enthalpy against hand-re-derived values,
 * and the structured declines. The fuel treatment under test: the
 * fuel enters as an inlet composition and enthalpy carrier — never a
 * required equilibrium product.
 */

import { describe, expect, it } from "vitest";

import {
  DRY_AIR_MOLE_FRACTIONS,
  MAX_EQUIVALENCE_RATIO,
  premixedFuelAirInlet,
} from "./inlet";
import { nasa7EnthalpyJPerMol, getSpecies } from "./index";

describe("the premixed fuel–air inlet", () => {
  it("anchors dry air to the 1976 U.S. Standard Atmosphere", () => {
    // USSA 1976 dry air (NOAA/NASA/USAF), mole fractions as published.
    expect(DRY_AIR_MOLE_FRACTIONS).toEqual({
      N2: 0.78084,
      O2: 0.209476,
      AR: 0.00934,
      CO2: 0.000314,
    });
  });

  it("builds the stoichiometric CH4–air stream by hand arithmetic", () => {
    const inlet = premixedFuelAirInlet({
      fuel: "CH4",
      equivalenceRatio: 1,
      inletTK: 298.15,
    });
    if (!inlet.ok) throw new Error(inlet.error.message);
    const moles = inlet.value.species;
    // 1 mol CH4 needs 2 mol O2; air scale = 2 / 0.209476 = 9.54782...
    const airScale = 2 / 0.209476;
    expect(moles.CH4).toBe(1);
    expect(moles.O2).toBeCloseTo(2, 12);
    expect(moles.N2).toBeCloseTo(0.78084 * airScale, 12);
    expect(moles.AR).toBeCloseTo(0.00934 * airScale, 12);
    expect(moles.CO2).toBeCloseTo(0.000314 * airScale, 12);
    // Element totals: C = 1 (fuel) + air's CO2 carbon; H = 4;
    // O = 4 (O2) + 2·air-CO2; N = 2·N2; AR = air's argon.
    const b = inlet.value.elementTotals;
    expect(b.C).toBeCloseTo(1 + 0.000314 * airScale, 12);
    expect(b.H).toBeCloseTo(4, 12);
    expect(b.O).toBeCloseTo(4 + 2 * 0.000314 * airScale, 12);
    expect(b.N).toBeCloseTo(2 * 0.78084 * airScale, 12);
    expect(b.AR).toBeCloseTo(0.00934 * airScale, 12);
  });

  it("scales oxygen as 1/φ (lean doubles, rich halves)", () => {
    const lean = premixedFuelAirInlet({
      fuel: "H2",
      equivalenceRatio: 0.5,
      inletTK: 298.15,
    });
    const rich = premixedFuelAirInlet({
      fuel: "H2",
      equivalenceRatio: 2,
      inletTK: 298.15,
    });
    if (!lean.ok || !rich.ok) throw new Error("inlet declined");
    // Stoichiometric H2 oxygen is 0.5 mol per mol fuel.
    expect(lean.value.species.O2).toBeCloseTo(1, 12);
    expect(rich.value.species.O2).toBeCloseTo(0.25, 12);
  });

  it("carries the inlet enthalpy through each species' own fit", () => {
    const inlet = premixedFuelAirInlet({
      fuel: "CH4",
      equivalenceRatio: 1,
      inletTK: 298.15,
    });
    if (!inlet.ok) throw new Error(inlet.error.message);
    let expected = 0;
    for (const [name, moles] of Object.entries(inlet.value.species)) {
      const species = getSpecies(name);
      if (species === undefined) throw new Error(`missing ${name}`);
      expected += moles * nasa7EnthalpyJPerMol(species, 298.15);
    }
    expect(inlet.value.enthalpyJ).toBeCloseTo(expected, 6);
    // H(298.15) ≈ ΔfH° per species: the stream is ≈ −74.6 kJ (CH4) plus
    // the trace air CO2 (−393.5 × 0.003) — everything else is ~0.
    expect(inlet.value.enthalpyJ / 1000).toBeCloseTo(-75.8, 0.1);
  });

  it("declines structured on unknown fuels, bad ratios, bad temperatures", () => {
    const unknown = premixedFuelAirInlet({
      fuel: "C2H5OH",
      equivalenceRatio: 1,
      inletTK: 298.15,
    });
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) {
      expect(unknown.error.code).toBe("sim/scenario-invalid");
      expect(unknown.error.message).toContain("curated NASA-7 database");
    }
    for (const phi of [0, -1, Number.POSITIVE_INFINITY, 6]) {
      const bad = premixedFuelAirInlet({
        fuel: "CH4",
        equivalenceRatio: phi,
        inletTK: 298.15,
      });
      expect(bad.ok, `phi=${String(phi)}`).toBe(false);
    }
    expect(MAX_EQUIVALENCE_RATIO).toBe(5);
    const cold = premixedFuelAirInlet({
      fuel: "CH4",
      equivalenceRatio: 1,
      inletTK: 100,
    });
    expect(cold.ok).toBe(false);
    if (!cold.ok) {
      expect(cold.error.message).toContain("NASA-7 domain");
    }
    const badBasis = premixedFuelAirInlet({
      fuel: "CH4",
      equivalenceRatio: 1,
      inletTK: 298.15,
      fuelMoles: 0,
    });
    expect(badBasis.ok).toBe(false);
  });
});
