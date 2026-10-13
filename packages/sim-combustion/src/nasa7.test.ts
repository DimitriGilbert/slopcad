/**
 * NASA-7 polynomial pins (Phase 68a): the curated coefficients
 * evaluated against published reference values — the NIST-JANAF
 * Thermochemical Tables, 4th edition (M. W. Chase Jr., ed., J. Phys.
 * Chem. Ref. Data, Monograph 9, 1998) at 298.15 K (standard entropies,
 * formation enthalpies, heat capacities) and 1000 K (entropies) —
 * every number below either cited from Chase 1998 or re-derived from
 * the module's own published constants. Bands are honest fit-level
 * bands (the fits reproduce the tables to ~0.1%; entropies to 0.08%
 * for the NASA Glenn fits' worst cases). The known OH divergence (the
 * fit's 39.35 kJ/mol against JANAF's 37.3 kJ/mol, a documented ~2
 * kJ/mol discrepancy in the older OH source data) is pinned with its
 * own widened band and comment, not hidden.
 */

import { describe, expect, it } from "vitest";

import {
  GAS_CONSTANT_J_PER_MOL_K,
  getSpecies,
  nasa7CpJPerMolK,
  nasa7CpOverR,
  nasa7EnthalpyJPerMol,
  nasa7EntropyJPerMolK,
  nasa7FittedSpanK,
  nasa7GOverRT,
  nasa7HOverRT,
  nasa7SOverR,
} from "./index";

/** JANAF 4th ed. (Chase 1998) values at 298.15 K and 1000 K. */
const JANAF_298 = {
  // [S° J/(mol·K), ΔfH° kJ/mol, cp° J/(mol·K)]
  N2: [191.61, 0, 29.12],
  O2: [205.15, 0, 29.38],
  CO2: [213.79, -393.51, 37.13],
  H2O: [188.84, -241.83, 33.6],
  CO: [197.66, -110.53, 29.14],
  H2: [130.68, 0, 28.84],
  OH: [183.71, 37.3, 29.89],
  H: [114.72, 218.0, 20.786],
  O: [161.06, 249.18, 21.9],
  NO: [210.76, 91.27, 29.85],
  AR: [154.85, 0, 20.786],
  CH4: [186.37, -74.6, 35.64],
} as const;

/** JANAF 4th ed. standard entropies at 1000 K, J/(mol·K). */
const JANAF_S_1000 = {
  N2: 228.159,
  O2: 243.576,
  CO2: 269.299,
  H2O: 232.738,
  CO: 234.539,
  H2: 166.216,
} as const;

describe("the NASA-7 polynomials against published values", () => {
  it("reproduces the JANAF standard entropies at 298.15 K", () => {
    for (const [name, [sRef]] of Object.entries(JANAF_298)) {
      const species = getSpecies(name);
      if (species === undefined) throw new Error(`missing species ${name}`);
      const s = nasa7EntropyJPerMolK(species, 298.15);
      // 0.1% band: the NASA Glenn fits' worst residual against the
      // tables is N2/Ar-class ~0.08% (verified at curation time).
      expect(Math.abs(s - sRef) / sRef, name).toBeLessThan(0.001);
    }
  });

  it("reproduces the JANAF enthalpies of formation at 298.15 K", () => {
    for (const [name, [, hfRef]] of Object.entries(JANAF_298)) {
      const species = getSpecies(name);
      if (species === undefined) throw new Error(`missing species ${name}`);
      const hf = nasa7EnthalpyJPerMol(species, 298.15) / 1000;
      if (name === "OH") {
        // The documented OH divergence: the fit's source data carries
        // ΔfH°(OH, 298) ≈ 39.3 kJ/mol against JANAF's 37.3 — a known
        // ~2 kJ/mol discrepancy inherited by every NASA-7
        // redistribution of the older OH data; pinned as such.
        expect(Math.abs(hf - 39.35)).toBeLessThan(0.2);
        continue;
      }
      // 0.2 kJ/mol band: the fits anchor H(298.15) = ΔfH° exactly;
      // the residual is the tables' own rounding.
      expect(Math.abs(hf - hfRef), name).toBeLessThan(0.2);
    }
  });

  it("reproduces the JANAF heat capacities at 298.15 K", () => {
    for (const [name, [, , cpRef]] of Object.entries(JANAF_298)) {
      const species = getSpecies(name);
      if (species === undefined) throw new Error(`missing species ${name}`);
      const cp = nasa7CpJPerMolK(species, 298.15);
      expect(Math.abs(cp - cpRef) / cpRef, name).toBeLessThan(0.003);
    }
  });

  it("reproduces the JANAF standard entropies at 1000 K", () => {
    for (const [name, sRef] of Object.entries(JANAF_S_1000)) {
      const species = getSpecies(name);
      if (species === undefined) throw new Error(`missing species ${name}`);
      const s = nasa7EntropyJPerMolK(species, 1000);
      expect(Math.abs(s - sRef) / sRef, name).toBeLessThan(0.001);
    }
  });

  it("carries argon as the exact monatomic ideal gas (re-derived)", () => {
    const argon = getSpecies("AR");
    if (argon === undefined) throw new Error("missing AR");
    // Kinetic theory: cp/R = 5/2 for every temperature, and the
    // entropy integrates to the polynomial's own constants.
    for (const t of [298.15, 1000, 3500]) {
      expect(nasa7CpOverR(argon, t)).toBe(2.5);
      const entropyConstant = argon.ranges[0]?.coefficients[6] ?? 0;
      const expected = entropyConstant + 2.5 * Math.log(t);
      expect(nasa7SOverR(argon, t)).toBeCloseTo(expected, 12);
    }
  });

  it("is continuous across the 1000 K range break (every two-range species)", () => {
    for (const name of [
      "CO2",
      "H2O",
      "N2",
      "O2",
      "CO",
      "H2",
      "OH",
      "H",
      "O",
      "NO",
      "CH4",
      "C8H18-ISO",
      "C8H18-N",
    ]) {
      const species = getSpecies(name);
      if (species === undefined) throw new Error(`missing species ${name}`);
      if (species.ranges.length < 2) continue;
      const breakK = species.ranges[0]?.tMaxK ?? 1000;
      // Probe one nanokelvin either side: the finite difference then
      // measures the FIT discontinuity, not the polynomial's slope.
      const below = breakK - 1e-9;
      const above = breakK + 1e-9;
      const cpGap = Math.abs(
        nasa7CpOverR(species, below) - nasa7CpOverR(species, above),
      );
      const hGap = Math.abs(
        nasa7HOverRT(species, below) - nasa7HOverRT(species, above),
      );
      const sGap = Math.abs(
        nasa7SOverR(species, below) - nasa7SOverR(species, above),
      );
      expect(cpGap, `${name} cp`).toBeLessThan(1e-5);
      expect(hGap, `${name} h`).toBeLessThan(1e-5);
      expect(sGap, `${name} s`).toBeLessThan(1e-5);
    }
  });

  it("clamps evaluation into the database domain [200, 6000] K", () => {
    const nitrogen = getSpecies("N2");
    if (nitrogen === undefined) throw new Error("missing N2");
    expect(nasa7EnthalpyJPerMol(nitrogen, 50)).toBe(
      nasa7EnthalpyJPerMol(nitrogen, 200),
    );
    expect(nasa7CpOverR(nitrogen, 9000)).toBe(nasa7CpOverR(nitrogen, 6000));
    for (const name of ["N2", "CO2", "C8H18-ISO"]) {
      const species = getSpecies(name);
      if (species === undefined) throw new Error(`missing ${name}`);
      expect(nasa7FittedSpanK(species)).toEqual([200, 6000]);
    }
  });

  it("satisfies G/(RT) = H/(RT) − S/R identically", () => {
    for (const name of ["CO2", "H2O", "CH4", "C8H18-ISO", "NO"]) {
      const species = getSpecies(name);
      if (species === undefined) throw new Error(`missing ${name}`);
      for (const t of [298.15, 850, 2400]) {
        expect(nasa7GOverRT(species, t)).toBeCloseTo(
          nasa7HOverRT(species, t) - nasa7SOverR(species, t),
          12,
        );
      }
    }
  });

  it("carries the exact 2019-SI gas constant", () => {
    // N_A · k_B, exact since the 2019 SI redefinition.
    expect(GAS_CONSTANT_J_PER_MOL_K).toBe(8.31446261815324);
  });
});
