/**
 * Equilibrium-solver discipline pins (Phase 68a): the KKT truth on
 * converged solutions (element balance and stationarity at the gates),
 * closed-form cross-checks derived from the same thermodynamic data
 * (the O2 dissociation equilibrium solved analytically from its own
 * Kp — a solver-vs-closed-form check, not a circular one), the
 * HP temperature-row property (HP seeded at T with the enthalpy of
 * TP(T+Δ) must return T+Δ), bitwise determinism, and the loud
 * declines: iteration caps, malformed inputs, and the honest rich
 * bound where the product set runs out of oxygen to carry carbon.
 */

import { describe, expect, it } from "vitest";

import {
  getSpecies,
  nasa7GOverRT,
  premixedFuelAirInlet,
  solveEquilibriumHP,
  solveEquilibriumTP,
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

describe("the TP equilibrium solve", () => {
  it("matches the closed-form O2 dissociation at 3500 K, 1 bar", () => {
    // Kp = exp(−(2·g°_O − g°_O2)/RT) from the same NASA-7 data; the
    // single-reaction equilibrium is then algebra: O2 ⇌ 2O at total
    // moles basis 2 gives α = sqrt(Kp/(4P + Kp)) — derived here, so
    // the check pins the SOLVER against closed-form algebra, not
    // against itself.
    const oxygen = getSpecies("O");
    const oxygen2 = getSpecies("O2");
    if (oxygen === undefined || oxygen2 === undefined) {
      throw new Error("missing oxygen species");
    }
    const kp = Math.exp(
      -(2 * nasa7GOverRT(oxygen, 3500) - nasa7GOverRT(oxygen2, 3500)),
    );
    const alpha = Math.sqrt(kp / (4 * 1 + kp));
    const xO2Expected = (1 - alpha) / (1 + alpha);
    const xOExpected = (2 * alpha) / (1 + alpha);
    const solved = must(
      solveEquilibriumTP({
        elementTotals: { O: 2 },
        temperatureK: 3500,
        pressureBar: 1,
      }),
      "the O2 TP solve",
    );
    expect(solved.moleFractions.O2).toBeCloseTo(xO2Expected, 6);
    expect(solved.moleFractions.O).toBeCloseTo(xOExpected, 6);
    expect(solved.residuals.elementBalance).toBeLessThan(1e-10);
    expect(solved.residuals.stationarity).toBeLessThan(1e-8);
  });

  it("leaves a pure noble gas exactly pure", () => {
    const solved = must(
      solveEquilibriumTP({
        elementTotals: { AR: 2 },
        temperatureK: 1500,
        pressureBar: 2,
      }),
      "the Ar TP solve",
    );
    expect(solved.moleFractions.AR).toBeCloseTo(1, 12);
    expect(solved.totalMoles).toBeCloseTo(2, 10);
    expect(solved.speciesNames).toEqual(["AR"]);
  });

  it("suppresses radicals to trace at low temperature", () => {
    const solved = must(
      solveEquilibriumTP({
        elementTotals: { H: 2, O: 1 },
        temperatureK: 1000,
        pressureBar: 1,
      }),
      "the low-T H2O solve",
    );
    expect(solved.moleFractions.H2O).toBeGreaterThan(0.99);
    // The radicals' equilibrium at 1000 K is trace: H far below 1e-10,
    // OH around 1e-8 (its own equilibrium constant at 1000 K) — the
    // solver's values, pinned as order-of-magnitude physicality.
    expect(solved.moleFractions.H ?? 0).toBeLessThan(1e-10);
    expect(solved.moleFractions.OH ?? 0).toBeLessThan(1e-7);
  });

  it("closes the element balance on a full CH4–air system at flame temperature", () => {
    const inlet = must(
      premixedFuelAirInlet({
        fuel: "CH4",
        equivalenceRatio: 1,
        inletTK: 298.15,
      }),
      "the inlet",
    );
    const solved = must(
      solveEquilibriumTP({
        elementTotals: inlet.elementTotals,
        temperatureK: 2225.7,
        pressureBar: 1.01325,
      }),
      "the stoichiometric TP solve",
    );
    // 2e-9, an order inside the solver's 1e-8 element-balance gate: the
    // Phase 68b complete-combustion-seed fix (the CO → CO₂ upgrade
    // consumes one O per CO, not one O₂) changed this fixture's Newton
    // path; the converged balance moved from ~1e-10 to ~1.25e-9, still
    // an order inside the discipline gate the solver itself enforces.
    expect(solved.residuals.elementBalance).toBeLessThan(2e-9);
    expect(solved.residuals.stationarity).toBeLessThan(1e-8);
    // Mass conservation: the solution's total mass equals the
    // inlet's (mole numbers change with dissociation; mass cannot).
    const inletMass = Object.entries(inlet.species).reduce((sum, [name, n]) => {
      const species = getSpecies(name);
      if (species === undefined) throw new Error(`missing ${name}`);
      return sum + n * species.molecularWeightKgPerKmol;
    }, 0);
    const solvedMass = Object.entries(solved.moles).reduce((sum, [name, n]) => {
      const species = getSpecies(name);
      if (species === undefined) throw new Error(`missing ${name}`);
      return sum + n * species.molecularWeightKgPerKmol;
    }, 0);
    expect(solvedMass).toBeCloseTo(inletMass, 6);
  });

  it("solves the dissociating composition at multiple temperatures", () => {
    const inlet = must(
      premixedFuelAirInlet({
        fuel: "H2",
        equivalenceRatio: 1,
        inletTK: 298.15,
      }),
      "the inlet",
    );
    // S/B: H2O fraction falls as T rises (dissociation), monotonically.
    const fractions = [1600, 2000, 2400].map(
      (tK) =>
        must(
          solveEquilibriumTP({
            elementTotals: inlet.elementTotals,
            temperatureK: tK,
            pressureBar: 1.01325,
          }),
          `TP at ${String(tK)} K`,
        ).moleFractions.H2O,
    );
    const f0 = fractions[0];
    const f1 = fractions[1];
    const f2 = fractions[2];
    if (f0 === undefined || f1 === undefined || f2 === undefined) {
      throw new Error("missing TP sample");
    }
    expect(f0).toBeGreaterThan(f1);
    expect(f1).toBeGreaterThan(f2);
  });
});

describe("the HP equilibrium solve", () => {
  it("inverts the TP enthalpy: HP at T with H(T+100) returns T+100", () => {
    const inlet = must(
      premixedFuelAirInlet({
        fuel: "CH4",
        equivalenceRatio: 1.2,
        inletTK: 298.15,
      }),
      "the inlet",
    );
    for (const tK of [1400, 1800, 2200]) {
      const atT = must(
        solveEquilibriumTP({
          elementTotals: inlet.elementTotals,
          temperatureK: tK,
          pressureBar: 1.01325,
        }),
        "TP at T",
      );
      const atTPlus = must(
        solveEquilibriumTP({
          elementTotals: inlet.elementTotals,
          temperatureK: tK + 100,
          pressureBar: 1.01325,
        }),
        "TP at T+100",
      );
      // The returned temperature sits between T and T+100 within the
      // enthalpy slope's linearity (the HP answer is the TP state whose
      // enthalpy matches; assert against the bracketing TP enthalpies).
      const solved = must(
        solveEquilibriumHP({
          elementTotals: inlet.elementTotals,
          targetEnthalpyJ: atTPlus.enthalpyJ,
          pressureBar: 1.01325,
          initialTemperatureK: tK,
        }),
        "the HP inversion",
      );
      expect(solved.temperatureK).toBeGreaterThan(tK);
      expect(solved.temperatureK).toBeLessThan(tK + 101);
      expect(solved.enthalpyJ).toBeCloseTo(atTPlus.enthalpyJ, -1);
      expect(atT.enthalpyJ).toBeLessThan(atTPlus.enthalpyJ);
    }
  });

  it("is bitwise deterministic on repeat runs (law S2)", () => {
    const inlet = must(
      premixedFuelAirInlet({
        fuel: "C8H18-ISO",
        equivalenceRatio: 0.9,
        inletTK: 298.15,
      }),
      "the inlet",
    );
    const first = must(
      solveEquilibriumHP({
        elementTotals: inlet.elementTotals,
        targetEnthalpyJ: inlet.enthalpyJ,
        pressureBar: 1.01325,
        initialTemperatureK: 298.15,
      }),
      "first run",
    );
    const second = must(
      solveEquilibriumHP({
        elementTotals: inlet.elementTotals,
        targetEnthalpyJ: inlet.enthalpyJ,
        pressureBar: 1.01325,
        initialTemperatureK: 298.15,
      }),
      "second run",
    );
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    for (const [name, moles] of Object.entries(first.moles)) {
      expect(Object.is(second.moles[name], moles), name).toBe(true);
    }
    expect(Object.is(second.temperatureK, first.temperatureK)).toBe(true);
    expect(Object.is(second.gibbsJ, first.gibbsJ)).toBe(true);
  });

  it("declines loudly when the iteration cap is exhausted", () => {
    const inlet = must(
      premixedFuelAirInlet({
        fuel: "CH4",
        equivalenceRatio: 1,
        inletTK: 298.15,
      }),
      "the inlet",
    );
    const capped = solveEquilibriumHP({
      elementTotals: inlet.elementTotals,
      targetEnthalpyJ: inlet.enthalpyJ,
      pressureBar: 1.01325,
      initialTemperatureK: 298.15,
      options: { maxIterations: 2 },
    });
    expect(capped.ok).toBe(false);
    if (!capped.ok) {
      expect(capped.error.code).toBe("sim/solver-unconverged");
      expect(capped.error.message).toContain("declines rather than");
      expect(capped.error.message).toContain("element balance");
    }
  });

  it("declines the oxygen-starved rich mixture honestly (no solid carbon)", () => {
    // CH4 at φ=5: oxygen totals ~0.81 mol against ~1.003 mol carbon —
    // past CO saturation the product set cannot carry the carbon.
    const inlet = premixedFuelAirInlet({
      fuel: "CH4",
      equivalenceRatio: 5,
      inletTK: 298.15,
    });
    expect(inlet.ok).toBe(true);
    if (!inlet.ok) return;
    const solved = solveEquilibriumHP({
      elementTotals: inlet.value.elementTotals,
      targetEnthalpyJ: inlet.value.enthalpyJ,
      pressureBar: 1.01325,
      initialTemperatureK: 298.15,
    });
    expect(solved.ok).toBe(false);
    if (!solved.ok) {
      expect(solved.error.code).toBe("sim/scenario-invalid");
      expect(solved.error.message).toContain("solid carbon");
    }
  });

  it("declines malformed problems structurally", () => {
    const noPressure = solveEquilibriumTP({
      elementTotals: { O: 2 },
      temperatureK: 3000,
      pressureBar: 0,
    });
    expect(noPressure.ok).toBe(false);
    const noElements = solveEquilibriumTP({
      elementTotals: { C: 0, O: 0 },
      temperatureK: 3000,
      pressureBar: 1,
    });
    expect(noElements.ok).toBe(false);
    const negative = solveEquilibriumTP({
      elementTotals: { O: -1 },
      temperatureK: 3000,
      pressureBar: 1,
    });
    expect(negative.ok).toBe(false);
    const badTemperature = solveEquilibriumTP({
      elementTotals: { O: 2 },
      temperatureK: Number.NaN,
      pressureBar: 1,
    });
    expect(badTemperature.ok).toBe(false);
    const noEnthalpy = solveEquilibriumHP({
      elementTotals: { O: 2 },
      targetEnthalpyJ: Number.NaN,
      pressureBar: 1,
      initialTemperatureK: 300,
    });
    expect(noEnthalpy.ok).toBe(false);
    // An element outside the vocabulary contributes nothing: the
    // problem has no positive total and declines rather than guessing.
    const unsupported = solveEquilibriumTP({
      elementTotals: { FE: 1 },
      temperatureK: 300,
      pressureBar: 1,
    });
    expect(unsupported.ok).toBe(false);
    const empty = solveEquilibriumTP({
      elementTotals: {},
      temperatureK: 300,
      pressureBar: 1,
    });
    expect(empty.ok).toBe(false);
  });
});
