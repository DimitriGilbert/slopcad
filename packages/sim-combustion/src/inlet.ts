/**
 * The reactant stream module (ROADMAP-SIM Phase 68a): a premixed
 * fuel–air inlet at an equivalence ratio φ, reduced to what the
 * equilibrium solver consumes — element totals (moles of C, H, O, N,
 * Ar) and the inlet mixture enthalpy. The fuel treatment, stated once:
 * a fuel is an ENTHALPY CARRIER at the inlet, never a required
 * equilibrium product — CH4 and the octanes appear in no product set;
 * their atoms enter the element totals and their inlet enthalpy enters
 * H⁰ through their own NASA-7 fits (thermo-data.ts). Equivalence ratio
 * is fuel/oxygen over its stoichiometric value, the moles basis the
 * combustion literature uses; the stoichiometric oxygen is derived from
 * the fuel's composition (C + H/4 − O/2), not tabulated.
 */

import {
  simError,
  simFail,
  simOk,
  SIM_ERROR_CODES,
  type SimError,
  type SimParseResult,
} from "@slopcad/sim-core";
import type { ElementName } from "./thermo-data";

import {
  ELEMENTS,
  FUEL_SPECIES_NAMES,
  getSpecies,
  stoichiometricO2PerMol,
} from "./thermo-data";
import { NASA7_T_MAX_K, NASA7_T_MIN_K, nasa7EnthalpyJPerMol } from "./nasa7";

/** Dry air's oxygen mole fraction — the stream's scale anchor. */
const DRY_AIR_O2_FRACTION = 0.209476;

/**
 * Standard dry air, mole fractions — U.S. Standard Atmosphere, 1976
 * (NOAA/NASA/USAF), dry-air composition as published (N₂ 0.780840,
 * O₂ 0.209476, Ar 0.009340, CO₂ 0.000314). Humidity is a caller
 * concern, stated: these tables are dry-air tables.
 */
export const DRY_AIR_MOLE_FRACTIONS: Readonly<Record<string, number>> =
  Object.freeze({
    N2: 0.78084,
    O2: DRY_AIR_O2_FRACTION,
    AR: 0.00934,
    CO2: 0.000314,
  });

/** The equivalence ratio's authored bound: (0, 5] keeps tables honest. */
export const MAX_EQUIVALENCE_RATIO = 5;

/** A reactant mixture reduced to the equilibrium solver's inputs. */
export interface ReactantMixture {
  /** Moles per species at the inlet (species name → moles, fixed keys). */
  readonly species: Readonly<Record<string, number>>;
  /** Element totals over the whole mixture, moles (C, H, O, N, AR). */
  readonly elementTotals: Readonly<Record<ElementName, number>>;
  /** The inlet temperature, K. */
  readonly inletTK: number;
  /** The mixture's total enthalpy at the inlet temperature, J. */
  readonly enthalpyJ: number;
  /** The fuel species' name. */
  readonly fuelName: string;
  /** The authored equivalence ratio. */
  readonly equivalenceRatio: number;
}

/**
 * Builds a premixed fuel–air reactant mixture: `fuelMoles` moles of the
 * named fuel with dry air supplying O₂ at the equivalence ratio φ
 * (φ = (F/O₂)/(F/O₂)_stoich; φ = 1 stoichiometric, < 1 lean, > 1 rich).
 * Declines structured on an unknown fuel, φ outside (0, 5], or an inlet
 * temperature outside the NASA-7 domain.
 */
export function premixedFuelAirInlet(input: {
  readonly fuel: string;
  readonly equivalenceRatio: number;
  readonly inletTK: number;
  readonly fuelMoles?: number;
}): SimParseResult<ReactantMixture, SimError> {
  const fuel = getSpecies(input.fuel);
  if (fuel === undefined) {
    return simFail(
      simError(
        SIM_ERROR_CODES.scenarioInvalid,
        `The reactant stream names the fuel "${input.fuel}", which the curated NASA-7 database does not carry (fuels: ${FUEL_SPECIES_NAMES.join(", ")}).`,
        input.fuel,
      ),
    );
  }
  const phi = input.equivalenceRatio;
  if (!Number.isFinite(phi) || phi <= 0 || phi > MAX_EQUIVALENCE_RATIO) {
    return simFail(
      simError(
        SIM_ERROR_CODES.scenarioInvalid,
        `The equivalence ratio must lie in (0, ${String(MAX_EQUIVALENCE_RATIO)}]; it was ${String(phi)}.`,
        phi,
      ),
    );
  }
  const inletTK = input.inletTK;
  if (
    !Number.isFinite(inletTK) ||
    inletTK < NASA7_T_MIN_K ||
    inletTK > NASA7_T_MAX_K
  ) {
    return simFail(
      simError(
        SIM_ERROR_CODES.scenarioInvalid,
        `The inlet temperature must lie in the NASA-7 domain [${String(NASA7_T_MIN_K)}, ${String(NASA7_T_MAX_K)}] K; it was ${String(inletTK)} K.`,
        inletTK,
      ),
    );
  }
  const fuelMoles = input.fuelMoles === undefined ? 1 : input.fuelMoles;
  if (!Number.isFinite(fuelMoles) || fuelMoles <= 0) {
    return simFail(
      simError(
        SIM_ERROR_CODES.scenarioInvalid,
        `The fuel moles basis must be strictly positive; it was ${String(fuelMoles)}.`,
        fuelMoles,
      ),
    );
  }

  const stoichO2 = stoichiometricO2PerMol(fuel.composition);
  const o2Moles = (stoichO2 * fuelMoles) / phi;
  const airScale = o2Moles / DRY_AIR_O2_FRACTION;
  const species: Record<string, number> = { [fuel.name]: fuelMoles };
  for (const [name, fraction] of Object.entries(DRY_AIR_MOLE_FRACTIONS)) {
    if (name === fuel.name) {
      species[name] = (species[name] ?? 0) + airScale * fraction;
      continue;
    }
    species[name] = airScale * fraction;
  }

  const elementTotals: Record<ElementName, number> = {
    C: 0,
    H: 0,
    O: 0,
    N: 0,
    AR: 0,
  };
  let enthalpyJ = 0;
  for (const [name, moles] of Object.entries(species)) {
    const record = getSpecies(name);
    if (record === undefined) {
      return simFail(
        simError(
          SIM_ERROR_CODES.scenarioInvalid,
          `The reactant stream references "${name}", which the curated NASA-7 database does not carry.`,
          name,
        ),
      );
    }
    for (const element of ELEMENTS) {
      elementTotals[element] += (record.composition[element] ?? 0) * moles;
    }
    enthalpyJ += moles * nasa7EnthalpyJPerMol(record, inletTK);
  }

  return simOk(
    Object.freeze({
      species: Object.freeze(species),
      elementTotals: Object.freeze(elementTotals),
      inletTK,
      enthalpyJ,
      fuelName: fuel.name,
      equivalenceRatio: phi,
    }),
  );
}
