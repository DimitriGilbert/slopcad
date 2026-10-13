/**
 * The curated NASA-7 species database (ROADMAP-SIM Phase 68a): the
 * thermodynamic coefficients of the NASA Glenn (formerly Lewis/CEA)
 * database as published in
 *
 *   B. J. McBride, M. J. Zehe and S. Gordon,
 *   "NASA Glenn Coefficients for Calculating Thermodynamic Properties
 *   of Individual Species", NASA TP-2002-211556, 2002
 *
 * retrieved 2026-10-12 from the Cantera project's machine conversion of
 * that database (BSD-3-Clause, github.com/Cantera/cantera,
 * data/nasa_gas.yaml, commit on main at retrieval) — the coefficients
 * are the NASA Glenn fits verbatim; each species block carries the
 * database's own source note (the SIX-CHARACTER REFERENCE-DATE codes of
 * the original CEA thermo.inp: TPIS = Gurvich et al., Thermodynamic
 * Properties of Individual Substances; L = NASA Lewis fit date;
 * X = TRC/NIST tables). The fits cover 200–6000 K at a 1 bar standard
 * state. The database is a US Government work redistributed with this
 * citation; nothing here is license-restricted (roadmap law S8).
 *
 * Validation pins against the NIST-JANAF Thermochemical Tables (4th
 * ed., Chase 1998) live in thermo-data.test.ts. One known divergence,
 * stated honestly: the fit's OH enthalpy of formation is 39.35 kJ/mol
 * (the fit's source data) against JANAF's 37.3 kJ/mol — a documented
 * ~2 kJ/mol discrepancy in the older OH data that propagates into every
 * NASA-7 redistribution of it; bands in the flame tests account for it.
 */

import type { Nasa7Species } from "./nasa7";

/** The element vocabulary, fixed order (matrix/iteration determinism). */
export const ELEMENTS = ["C", "H", "O", "N", "AR"] as const;

export type ElementName = (typeof ELEMENTS)[number];

/**
 * Conventional atomic weights, kg/kmol (IUPAC CIAAW 2021, used for
 * molar masses throughout — cited, not fitted).
 */
export const ATOMIC_WEIGHTS_KG_PER_KMOL: Readonly<Record<ElementName, number>> =
  {
    C: 12.011,
    H: 1.008,
    O: 15.999,
    N: 14.007,
    AR: 39.948,
  };

/** Molar mass from a composition, kg/kmol. */
export function molecularWeightOf(
  composition: Readonly<Record<string, number>>,
): number {
  let mass = 0;
  for (const element of ELEMENTS) {
    const count = composition[element] ?? 0;
    mass += count * ATOMIC_WEIGHTS_KG_PER_KMOL[element];
  }
  return mass;
}

/** The stoichiometric O₂ a mole of fuel needs for complete combustion. */
export function stoichiometricO2PerMol(
  composition: Readonly<Record<string, number>>,
): number {
  const carbon = composition["C"] ?? 0;
  const hydrogen = composition["H"] ?? 0;
  const oxygen = composition["O"] ?? 0;
  // C + H/4 − O/2: CxHyOz + (x + y/4 − z/2) O2 → x CO2 + (y/2) H2O.
  return carbon + hydrogen / 4 - oxygen / 2;
}

function species(
  name: string,
  composition: Readonly<Record<string, number>>,
  ranges: readonly {
    readonly tMinK: number;
    readonly tMaxK: number;
    readonly coefficients: readonly number[];
  }[],
  note: string,
): Nasa7Species {
  return Object.freeze({
    name,
    composition: Object.freeze({ ...composition }),
    molecularWeightKgPerKmol: molecularWeightOf(composition),
    ranges: Object.freeze(
      ranges.map((range) => ({
        tMinK: range.tMinK,
        tMaxK: range.tMaxK,
        coefficients:
          range.coefficients as Nasa7Species["ranges"][number]["coefficients"],
      })),
    ),
    note,
  });
}

/**
 * The full curated set: the eleven equilibrium product species of the
 * premixed-combustion starter set (the minimum Phase 68a names, fixed
 * order — every solver matrix and history column is built in this
 * order, which is part of the bitwise-determinism contract) plus the
 * fuel reactants CH4 and the two octanes (equilibrium products need not
 * include the fuel: reactants enter by element totals and inlet
 * enthalpy — see inlet.ts).
 */
export const NASA7_SPECIES: Readonly<Record<string, Nasa7Species>> =
  Object.freeze({
    CO2: species(
      "CO2",
      { C: 1, O: 2 },
      [
        {
          tMinK: 200,
          tMaxK: 1000,
          coefficients: [
            2.35677352, 8.98459677e-3, -7.12356269e-6, 2.45919022e-9,
            -1.43699548e-13, -4.83719697e4, 9.90105222,
          ],
        },
        {
          tMinK: 1000,
          tMaxK: 6000,
          coefficients: [
            4.63659493, 2.74131991e-3, -9.95828531e-7, 1.60373011e-10,
            -9.16103468e-15, -4.90249341e4, -1.93534855,
          ],
        },
      ],
      "TPIS78",
    ),
    H2O: species(
      "H2O",
      { H: 2, O: 1 },
      [
        {
          tMinK: 200,
          tMaxK: 1000,
          coefficients: [
            4.19864056, -2.0364341e-3, 6.52040211e-6, -5.48797062e-9,
            1.77197817e-12, -3.02937267e4, -0.849032208,
          ],
        },
        {
          tMinK: 1000,
          tMaxK: 6000,
          coefficients: [
            2.67703787, 2.97318329e-3, -7.7376969e-7, 9.44336689e-11,
            -4.26900959e-15, -2.98858938e4, 6.88255571,
          ],
        },
      ],
      "L 8/89",
    ),
    N2: species(
      "N2",
      { N: 2 },
      [
        {
          tMinK: 200,
          tMaxK: 1000,
          coefficients: [
            3.53100528, -1.23660987e-4, -5.02999437e-7, 2.43530612e-9,
            -1.40881235e-12, -1046.97628, 2.96747468,
          ],
        },
        {
          tMinK: 1000,
          tMaxK: 6000,
          coefficients: [
            2.95257626, 1.39690057e-3, -4.92631691e-7, 7.86010367e-11,
            -4.60755321e-15, -923.948645, 5.87189252,
          ],
        },
      ],
      "TPIS78",
    ),
    O2: species(
      "O2",
      { O: 2 },
      [
        {
          tMinK: 200,
          tMaxK: 1000,
          coefficients: [
            3.78245636, -2.99673415e-3, 9.847302e-6, -9.68129508e-9,
            3.24372836e-12, -1063.94356, 3.65767573,
          ],
        },
        {
          tMinK: 1000,
          tMaxK: 6000,
          coefficients: [
            3.66096083, 6.56365523e-4, -1.41149485e-7, 2.05797658e-11,
            -1.29913248e-15, -1215.97725, 3.41536184,
          ],
        },
      ],
      "TPIS89",
    ),
    CO: species(
      "CO",
      { C: 1, O: 1 },
      [
        {
          tMinK: 200,
          tMaxK: 1000,
          coefficients: [
            3.57953347, -6.1035368e-4, 1.01681433e-6, 9.07005884e-10,
            -9.04424499e-13, -1.4344086e4, 3.50840928,
          ],
        },
        {
          tMinK: 1000,
          tMaxK: 6000,
          coefficients: [
            3.04848583, 1.35172818e-3, -4.85794075e-7, 7.88536486e-11,
            -4.69807489e-15, -1.42661171e4, 6.0170979,
          ],
        },
      ],
      "TPIS79",
    ),
    H2: species(
      "H2",
      { H: 2 },
      [
        {
          tMinK: 200,
          tMaxK: 1000,
          coefficients: [
            2.34433112, 7.98052075e-3, -1.9478151e-5, 2.01572094e-8,
            -7.37611761e-12, -917.935173, 0.683010238,
          ],
        },
        {
          tMinK: 1000,
          tMaxK: 6000,
          coefficients: [
            2.93286579, 8.26607967e-4, -1.46402335e-7, 1.54100359e-11,
            -6.88804432e-16, -813.065597, -1.02432887,
          ],
        },
      ],
      "TPIS78",
    ),
    OH: species(
      "OH",
      { O: 1, H: 1 },
      [
        {
          tMinK: 200,
          tMaxK: 1000,
          coefficients: [
            3.99201543, -2.40131752e-3, 4.61793841e-6, -3.88113333e-9,
            1.3641147e-12, 3615.08056, -0.103925458,
          ],
        },
        {
          tMinK: 1000,
          tMaxK: 6000,
          coefficients: [
            2.83864607, 1.10725586e-3, -2.93914978e-7, 4.20524247e-11,
            -2.42169092e-15, 3943.95852, 5.84452662,
          ],
        },
      ],
      "TPIS78",
    ),
    H: species(
      "H",
      { H: 1 },
      [
        {
          tMinK: 200,
          tMaxK: 1000,
          coefficients: [2.5, 0.0, 0.0, 0.0, 0.0, 2.54736599e4, -0.446682853],
        },
        {
          tMinK: 1000,
          tMaxK: 6000,
          coefficients: [
            2.50000286, -5.65334214e-9, 3.63251723e-12, -9.1994972e-16,
            7.95260746e-20, 2.54736589e4, -0.446698494,
          ],
        },
      ],
      "L 5/93",
    ),
    O: species(
      "O",
      { O: 1 },
      [
        {
          tMinK: 200,
          tMaxK: 1000,
          coefficients: [
            3.1682671, -3.27931884e-3, 6.64306396e-6, -6.12806624e-9,
            2.11265971e-12, 2.91222592e4, 2.05193346,
          ],
        },
        {
          tMinK: 1000,
          tMaxK: 6000,
          coefficients: [
            2.54363697, -2.73162486e-5, -4.1902952e-9, 4.95481845e-12,
            -4.79553694e-16, 2.9226012e4, 4.92229457,
          ],
        },
      ],
      "L 1/90",
    ),
    NO: species(
      "NO",
      { N: 1, O: 1 },
      [
        {
          tMinK: 200,
          tMaxK: 1000,
          coefficients: [
            4.21859896, -4.63988124e-3, 1.10443049e-5, -9.34055507e-9,
            2.80554874e-12, 9845.09964, 2.28061001,
          ],
        },
        {
          tMinK: 1000,
          tMaxK: 6000,
          coefficients: [
            3.26071234, 1.19101135e-3, -4.29122646e-7, 6.94481463e-11,
            -4.03295681e-15, 9921.43132, 6.36900518,
          ],
        },
      ],
      "TPIS89",
    ),
    AR: species(
      "AR",
      { AR: 1 },
      [
        {
          tMinK: 200,
          tMaxK: 6000,
          coefficients: [2.5, 0.0, 0.0, 0.0, 0.0, -745.375, 4.37967491],
        },
      ],
      "L 6/88",
    ),
    CH4: species(
      "CH4",
      { C: 1, H: 4 },
      [
        {
          tMinK: 200,
          tMaxK: 1000,
          coefficients: [
            5.14987613, -0.0136709788, 4.91800599e-5, -4.84743026e-8,
            1.66693956e-11, -1.02466476e4, -4.64130376,
          ],
        },
        {
          tMinK: 1000,
          tMaxK: 6000,
          coefficients: [
            1.63552643, 0.0100842795, -3.36916254e-6, 5.34958667e-10,
            -3.15518833e-14, -1.00056455e4, 9.99313326,
          ],
        },
      ],
      "L 8/88",
    ),
    "C8H18-ISO": species(
      "C8H18-ISO",
      { C: 8, H: 18 },
      [
        {
          tMinK: 200,
          tMaxK: 1000,
          coefficients: [
            0.815737338, 0.0732643959, 1.78300688e-5, -6.9358962e-8,
            3.21629382e-11, -3.04772862e4, 24.1509994,
          ],
        },
        {
          tMinK: 1000,
          tMaxK: 6000,
          coefficients: [
            15.9899273, 0.055318479, -1.95267072e-5, 3.11779172e-9,
            -1.85312577e-13, -3.58757973e4, -60.1161414,
          ],
        },
      ],
      "X 4/85 (TRC tables; 2,2,4-trimethylpentane)",
    ),
    "C8H18-N": species(
      "C8H18-N",
      { C: 8, H: 18 },
      [
        {
          tMinK: 200,
          tMaxK: 1000,
          coefficients: [
            12.5244908, -0.0101018365, 2.21991595e-4, -2.8486242e-7,
            1.12409624e-10, -2.98433034e4, -19.7108554,
          ],
        },
        {
          tMinK: 1000,
          tMaxK: 6000,
          coefficients: [
            22.1755407, 0.0424426161, -1.49161103e-5, 2.40376673e-9,
            -1.44359037e-13, -3.61030944e4, -88.0854457,
          ],
        },
      ],
      "X 4/85 (TRC tables; n-octane)",
    ),
  });

/**
 * The equilibrium product species' names, the curated fixed order (the
 * premixed-combustion starter set: the eleven Phase 68a names — CO2,
 * H2O, N2, O2, CO, H2, OH, H, O, NO, Ar — sized for H/C/O/N systems
 * from φ≈0.2 to well rich). The rich bound is structural, not a φ
 * threshold: the solver declines once carbon atoms outnumber oxygen
 * atoms (b_C > b_O — φ > 4 on CH4, φ > 3.125 on the octanes); between
 * that decline and where solid carbon first matters the answers ship
 * gas-only with no runtime flag marking the difference — a stated
 * limit, not a silent one.
 */
export const EQUILIBRIUM_SPECIES_NAMES: readonly string[] = Object.freeze([
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

/**
 * The named fuels a reactant stream can carry: gaseous at inlet
 * conditions, thermochemistry from the same NASA Glenn database. H2 and
 * CO are also equilibrium species; CH4 and the octanes are reactant
 * inputs only (imported as inlet composition — the fuel never needs to
 * be a product species; see inlet.ts).
 */
export const FUEL_SPECIES_NAMES: readonly string[] = Object.freeze([
  "H2",
  "CH4",
  "C8H18-ISO",
  "C8H18-N",
  "CO",
]);

/** Looks a species up, or refuses with the structured decline. */
export function getSpecies(name: string): Nasa7Species | undefined {
  return NASA7_SPECIES[name];
}
