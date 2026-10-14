/**
 * Curated-data integrity pins (Phase 68a): the database's own
 * bookkeeping — molar masses from the IUPAC CIAAW 2021 conventional
 * atomic weights (re-derived arithmetic), the octanes' formation
 * enthalpies against the NIST WebBook (iso-octane(g) ΔfH°298 =
 * −224.01 ± 0.63 kJ/mol; n-octane(g) −208.75 kJ/mol, release 69-1,
 * consulted 2026-10), the stoichiometric-oxygen derivation, and the
 * fixed vocabularies the determinism contract rides on.
 */

import { describe, expect, it } from "vitest";

import {
  ATOMIC_WEIGHTS_KG_PER_KMOL,
  ELEMENTS,
  EQUILIBRIUM_SPECIES_NAMES,
  FUEL_SPECIES_NAMES,
  getSpecies,
  molecularWeightOf,
  NASA7_SPECIES,
  stoichiometricO2PerMol,
} from "./index";
import { nasa7EnthalpyJPerMol } from "./index";

describe("the curated NASA-7 database's own integrity", () => {
  it("carries exactly the starter set with its fixed orders", () => {
    expect(Object.keys(NASA7_SPECIES)).toEqual([
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
      "AR",
      "CH4",
      "C8H18-ISO",
      "C8H18-N",
    ]);
    expect(EQUILIBRIUM_SPECIES_NAMES).toEqual([
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
      "AR",
    ]);
    expect(FUEL_SPECIES_NAMES).toEqual([
      "H2",
      "CH4",
      "C8H18-ISO",
      "C8H18-N",
      "CO",
    ]);
    expect(ELEMENTS).toEqual(["C", "H", "O", "N", "AR"]);
  });

  it("derives molar masses from the IUPAC 2021 conventional weights", () => {
    expect(ATOMIC_WEIGHTS_KG_PER_KMOL).toEqual({
      C: 12.011,
      H: 1.008,
      O: 15.999,
      N: 14.007,
      AR: 39.948,
    });
    // Hand arithmetic from those weights (kg/kmol == g/mol).
    expect(molecularWeightOf({ N: 2 })).toBeCloseTo(28.014, 10);
    expect(molecularWeightOf({ C: 1, O: 2 })).toBeCloseTo(44.009, 10);
    expect(molecularWeightOf({ H: 2, O: 1 })).toBeCloseTo(18.015, 10);
    expect(molecularWeightOf({ C: 1, H: 4 })).toBeCloseTo(16.043, 10);
    expect(molecularWeightOf({ C: 8, H: 18 })).toBeCloseTo(114.232, 10);
    expect(molecularWeightOf({ AR: 1 })).toBeCloseTo(39.948, 10);
    for (const record of Object.values(NASA7_SPECIES)) {
      expect(record.molecularWeightKgPerKmol).toBeCloseTo(
        molecularWeightOf(record.composition),
        12,
      );
    }
  });

  it("matches the NIST WebBook octane formation enthalpies", () => {
    const iso = getSpecies("C8H18-ISO");
    const normal = getSpecies("C8H18-N");
    if (iso === undefined || normal === undefined) {
      throw new Error("missing octanes");
    }
    // NIST WebBook, 2,2,4-trimethylpentane (gas): −224.01 ± 0.63 kJ/mol.
    expect(nasa7EnthalpyJPerMol(iso, 298.15) / 1000).toBeCloseTo(-224.01, 1);
    // NIST WebBook, n-octane (gas): −208.75 kJ/mol.
    expect(nasa7EnthalpyJPerMol(normal, 298.15) / 1000).toBeCloseTo(-208.75, 1);
  });

  it("derives stoichiometric oxygen from composition (C + H/4 − O/2)", () => {
    expect(stoichiometricO2PerMol({ H: 2 })).toBeCloseTo(0.5, 12);
    expect(stoichiometricO2PerMol({ C: 1, H: 4 })).toBeCloseTo(2, 12);
    expect(stoichiometricO2PerMol({ C: 1, O: 1 })).toBeCloseTo(0.5, 12);
    expect(stoichiometricO2PerMol({ C: 8, H: 18 })).toBeCloseTo(12.5, 12);
    // A compound fuel: C2H5OH + 3 O2 → 2 CO2 + 3 H2O.
    expect(stoichiometricO2PerMol({ C: 2, H: 6, O: 1 })).toBeCloseTo(3, 12);
  });

  it("carries a database source note on every species (the citation law)", () => {
    for (const record of Object.values(NASA7_SPECIES)) {
      expect(record.note.length).toBeGreaterThan(3);
    }
  });
});
