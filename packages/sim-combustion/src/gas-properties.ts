/**
 * The working-gas property machinery (ROADMAP-SIM Phase 68b): the
 * per-mass thermodynamic property evaluators the 0D reactor and the 0D
 * engine chamber integrate on, in the kinetic-energy-state discipline
 * the prior-art input names — the STATE a solver carries is an energy,
 * never a temperature; temperature is the derived quantity an energy
 * inversion returns (so energy bookkeeping conserves by construction,
 * the audit identity being float summation and nothing else).
 *
 * Two property families, both built on the Phase 68a NASA-7 database:
 *
 * - the FROZEN family: a fixed composition (reactants, partially
 *   reacted reactor states, complete-combustion references) evaluated
 *   directly from the published polynomial fits — exact per
 *   evaluation, monotone in T, cheap to invert;
 * - the EQUILIBRIUM family: the burned zone's properties from the 68a
 *   element-potential equilibrium solver, tabulated once per charge
 *   over a (T, p) grid at cycle setup and interpolated bilinearly
 *   (linear in ln p) — the standard property-table move behind
 *   two-zone SI chamber models, with the table's provenance (every
 *   node a converged TP solve) carried in the result.
 *
 * Pure IEEE-754 arithmetic in a fixed evaluation order (law S2).
 */

import {
  simError,
  simFail,
  simOk,
  SIM_ERROR_CODES,
  type SimError,
  type SimParseResult,
} from "@slopcad/sim-core";

import { solveEquilibriumTP } from "./equilibrium";
import {
  GAS_CONSTANT_J_PER_MOL_K,
  nasa7CpJPerMolK,
  nasa7EnthalpyJPerMol,
  type Nasa7Species,
} from "./nasa7";
import { getSpecies } from "./thermo-data";

/** One species' resolved record and its moles on the mixture basis. */
interface ResolvedSpecies {
  readonly record: Nasa7Species;
  readonly moles: number;
}

/**
 * A fixed composition reduced to per-mass property evaluators: species
 * mole numbers on an arbitrary basis plus that basis's mass and molar
 * totals. Everything downstream works per kilogram of mixture.
 */
export interface FrozenMixture {
  /** Species mole numbers on the basis (species name → moles). */
  readonly species: Readonly<Record<string, number>>;
  /** The basis's total mass, kg (Σ n_j·MW_j). */
  readonly basisMassKg: number;
  /** The mixture's specific gas constant R = R_univ·Σn/m, J/(kg·K). */
  readonly gasConstantJPerKgK: number;
  /** Mean molar mass of the mixture on the basis, kg/kmol. */
  readonly meanMolecularWeightKgPerKmol: number;
  /** The resolved per-species pairs (fixed order — determinism). */
  readonly resolved: readonly ResolvedSpecies[];
}

/**
 * Reduces a species mole-number map to the per-mass property basis.
 * Unknown species names and non-finite or negative moles decline
 * structurally; a zero-mass composition declines (nothing to
 * properties).
 */
export function frozenMixture(
  species: Readonly<Record<string, number>>,
): SimParseResult<FrozenMixture, SimError> {
  let totalMoles = 0;
  let massKg = 0;
  const resolved: ResolvedSpecies[] = [];
  for (const [name, moles] of Object.entries(species)) {
    if (!Number.isFinite(moles) || moles < 0) {
      return simFail(
        simError(
          SIM_ERROR_CODES.scenarioInvalid,
          `The mixture's species "${name}" carries ${String(moles)} moles; mole numbers must be finite and non-negative.`,
          { name, moles },
        ),
      );
    }
    const record = getSpecies(name);
    if (record === undefined) {
      return simFail(
        simError(
          SIM_ERROR_CODES.scenarioInvalid,
          `The mixture references "${name}", which the curated NASA-7 database does not carry.`,
          name,
        ),
      );
    }
    totalMoles += moles;
    // mol × kg/kmol = kg/1000 — the molar-mass unit bridge.
    massKg += (moles * record.molecularWeightKgPerKmol) / 1000;
    resolved.push({ record, moles });
  }
  if (!(massKg > 0) || !(totalMoles > 0)) {
    return simFail(
      simError(
        SIM_ERROR_CODES.scenarioInvalid,
        "A working-gas mixture needs a positive total mass; the given composition is empty.",
        species,
      ),
    );
  }
  return simOk(
    Object.freeze({
      species,
      basisMassKg: massKg,
      gasConstantJPerKgK: (GAS_CONSTANT_J_PER_MOL_K * totalMoles) / massKg,
      meanMolecularWeightKgPerKmol: (massKg * 1000) / totalMoles,
      resolved: Object.freeze(resolved),
    }),
  );
}

/** Specific enthalpy h(T) of the frozen mixture, J/kg (formation included). */
export function frozenEnthalpyJPerKg(mix: FrozenMixture, tK: number): number {
  let h = 0;
  for (const entry of mix.resolved) {
    h += entry.moles * nasa7EnthalpyJPerMol(entry.record, tK);
  }
  return h / mix.basisMassKg;
}

/** Specific heat capacity cp(T) of the frozen mixture, J/(kg·K). */
export function frozenCpJPerKgK(mix: FrozenMixture, tK: number): number {
  let cp = 0;
  for (const entry of mix.resolved) {
    cp += entry.moles * nasa7CpJPerMolK(entry.record, tK);
  }
  return cp / mix.basisMassKg;
}

/** Specific internal energy u(T) = h(T) − R·T of the frozen mixture, J/kg. */
export function frozenInternalEnergyJPerKg(
  mix: FrozenMixture,
  tK: number,
): number {
  return frozenEnthalpyJPerKg(mix, tK) - mix.gasConstantJPerKgK * tK;
}

/** Specific cv = cp − R of the frozen mixture, J/(kg·K). */
export function frozenCvJPerKgK(mix: FrozenMixture, tK: number): number {
  return frozenCpJPerKgK(mix, tK) - mix.gasConstantJPerKgK;
}

/**
 * Inverts u(T) for the frozen mixture: the temperature whose frozen
 * specific internal energy is `uJPerKg`. Monotone increasing (cv > 0
 * everywhere in the fitted domain), so a fixed-count bisection over the
 * NASA-7 fitted domain brackets it — deterministic to the bit.
 */
export function frozenTemperatureFromInternalEnergyK(
  mix: FrozenMixture,
  uJPerKg: number,
): number {
  let lo = 200;
  let hi = 6000;
  for (let i = 0; i < 64; i += 1) {
    const mid = 0.5 * (lo + hi);
    if (frozenInternalEnergyJPerKg(mix, mid) < uJPerKg) {
      lo = mid;
    } else {
      hi = mid;
    }
  }
  return 0.5 * (lo + hi);
}

/**
 * The frozen complete-combustion products of a reactant mixture: the
 * LHV reference state (carbon to CO₂, hydrogen to H₂O vapor — the
 * gaseous NASA-7 fit, so the derived heating value is the LOWER one —
 * nitrogen and argon inert, oxygen consumed first). Oxygen is
 * allocated carbon-first (CO), then hydrogen (H₂O), then upgrades
 * CO → CO₂ — the 68a equilibrium seed's order, restated; leftover
 * hydrogen rides as H₂.
 */
export interface CompleteCombustionProducts {
  readonly species: Readonly<Record<string, number>>;
  /**
   * Fuel moles the frozen reference could not oxidize at all, nonzero
   * past CO saturation on very rich mixtures — the caller declines,
   * never guesses a partial-burn reference.
   */
  readonly unconsumedFuelMoles: number;
}

/**
 * The frozen complete-combustion product composition of a reactant
 * mole map, on the same basis.
 */
export function completeCombustionOf(
  reactants: Readonly<Record<string, number>>,
): CompleteCombustionProducts {
  let carbon = 0;
  let hydrogen = 0;
  let oxygen = 0;
  let nitrogen = 0;
  let argon = 0;
  let fuelMoles = 0;
  for (const [name, moles] of Object.entries(reactants)) {
    const record = getSpecies(name);
    if (record === undefined) continue;
    carbon += (record.composition["C"] ?? 0) * moles;
    hydrogen += (record.composition["H"] ?? 0) * moles;
    oxygen += (record.composition["O"] ?? 0) * moles;
    nitrogen += (record.composition["N"] ?? 0) * moles;
    argon += (record.composition["AR"] ?? 0) * moles;
    if (name !== "CO2" && name !== "H2O" && name !== "N2" && name !== "AR") {
      fuelMoles += moles;
    }
  }
  let oLeft = oxygen;
  const co = Math.min(carbon, oLeft);
  oLeft -= co;
  const h2o = Math.min(hydrogen / 2, oLeft);
  oLeft -= h2o;
  // The CO → CO₂ upgrade consumes one oxygen atom per upgraded CO
  // (CO + O → CO₂), not one O₂.
  const co2 = Math.min(co, oLeft);
  oLeft -= co2;
  const coFinal = co - co2;
  const h2 = hydrogen / 2 - h2o;
  const species: Record<string, number> = {
    CO2: co2,
    H2O: h2o,
    CO: coFinal,
    H2: h2,
    // The leftover oxygen rides through as O₂ (lean charges) — the
    // record is mass-complete: the reactant basis's every atom is
    // placed.
    O2: Math.max(oLeft, 0) / 2,
    N2: nitrogen / 2,
    AR: argon,
  };
  return {
    species: Object.freeze(species),
    unconsumedFuelMoles:
      carbon - co2 - coFinal > 1e-12 * (1 + fuelMoles) ? fuelMoles : 0,
  };
}

/**
 * The lower heating value of a fuel, J/kg, DERIVED from the same NASA-7
 * database the solvers integrate on (h of the fuel plus its
 * stoichiometric oxygen minus h of the frozen complete-combustion
 * products, all at 298.15 K, water vapor) — no tabulated heating value
 * is hardcoded anywhere in this package. A reactant map whose carbon
 * survives CO saturation declines loudly: the LHV reference is a
 * complete-combustion state by definition.
 */
export function lowerHeatingValueJPerKg(
  fuelName: string,
): SimParseResult<number, SimError> {
  const fuel = getSpecies(fuelName);
  if (fuel === undefined) {
    return simFail(
      simError(
        SIM_ERROR_CODES.scenarioInvalid,
        `The LHV derivation names the fuel "${fuelName}", which the curated NASA-7 database does not carry.`,
        fuelName,
      ),
    );
  }
  const stoichO2 =
    (fuel.composition["C"] ?? 0) +
    (fuel.composition["H"] ?? 0) / 4 -
    (fuel.composition["O"] ?? 0) / 2;
  const products = completeCombustionOf({ [fuelName]: 1, O2: stoichO2 });
  if (products.unconsumedFuelMoles > 0) {
    return simFail(
      simError(
        SIM_ERROR_CODES.scenarioInvalid,
        `The frozen complete-combustion reference of "${fuelName}" leaves fuel atoms unconsumed; the LHV is a complete-combustion quantity and the derivation declines rather than guessing a partial-burn reference.`,
        fuelName,
      ),
    );
  }
  const oxygen2 = getSpecies("O2");
  if (oxygen2 === undefined) {
    return simFail(
      simError(
        SIM_ERROR_CODES.scenarioInvalid,
        "The curated NASA-7 database carries no O2 record; the LHV derivation cannot proceed.",
        fuelName,
      ),
    );
  }
  const hReactants =
    nasa7EnthalpyJPerMol(fuel, 298.15) +
    stoichO2 * nasa7EnthalpyJPerMol(oxygen2, 298.15);
  let hProducts = 0;
  for (const [name, moles] of Object.entries(products.species)) {
    const record = getSpecies(name);
    if (record === undefined || moles === 0) continue;
    hProducts += moles * nasa7EnthalpyJPerMol(record, 298.15);
  }
  const lhv = ((hReactants - hProducts) * 1000) / fuel.molecularWeightKgPerKmol;
  if (!(lhv > 0)) {
    return simFail(
      simError(
        SIM_ERROR_CODES.quantityInvalid,
        `The LHV derivation of "${fuelName}" returned ${String(lhv)} J/kg; a heating value must be strictly positive.`,
        { fuelName, lhv },
      ),
    );
  }
  return simOk(lhv);
}

/**
 * The burned-zone equilibrium property table: specific internal energy
 * u(T, p) and specific gas constant R(T, p) of the charge's equilibrium
 * products, one converged TP solve per node (the Phase 68a solver —
 * this is the "equilibrium properties" the chamber integrates on).
 * Interpolation is bilinear in (T, ln p); values outside the grid clamp
 * to its edge (the closed cycle's states sit inside by construction —
 * EVO temperatures far above the low edge, peak pressures far below the
 * high one — and the clamp is stated, not silent extrapolation).
 */
export interface BurnedEquilibriumTable {
  readonly temperatureKGrid: readonly number[];
  readonly pressureBarGrid: readonly number[];
  /** u nodes, J/kg: uNodes[iT][ip]. */
  readonly uNodes: readonly (readonly number[])[];
  /** R nodes, J/(kg·K): rNodes[iT][ip]. */
  readonly rNodes: readonly (readonly number[])[];
  /** The TP-solve iteration count per node (provenance). */
  readonly iterations: readonly (readonly number[])[];
  /** Specific internal energy u(T, p), J/kg — clamped bilinear in (T, ln p). */
  readonly uAtJPerKg: (tK: number, pressureBar: number) => number;
  /** Specific gas constant R(T, p), J/(kg·K) — clamped bilinear in (T, ln p). */
  readonly rAtJPerKgK: (tK: number, pressureBar: number) => number;
  /** Partial ∂u/∂T at fixed p, J/(kg·K) — a centered table difference. */
  readonly cvAtJPerKgK: (tK: number, pressureBar: number) => number;
}

/**
 * Builds the burned-zone table for a charge: `elementTotals` and
 * `basisMassKg` from the charge composition (per any basis — per-kg
 * normalization happens here). The T grid is uniform over [tMinK,
 * tMaxK]; the p grid is uniform in ln p over [pMinBar, pMaxBar]. Every
 * node is a solveEquilibriumTP call; the first node that misses its
 * discipline fails the whole build loudly (never a partially
 * fabricated table).
 */
export function buildBurnedEquilibriumTable(input: {
  readonly elementTotals: Readonly<Record<string, number>>;
  readonly basisMassKg: number;
  readonly tMinK: number;
  readonly tMaxK: number;
  readonly tSteps: number;
  readonly pMinBar: number;
  readonly pMaxBar: number;
  readonly pSteps: number;
}): SimParseResult<BurnedEquilibriumTable, SimError> {
  const { tMinK, tMaxK, tSteps, pMinBar, pMaxBar, pSteps } = input;
  if (
    !Number.isFinite(tMinK) ||
    !Number.isFinite(tMaxK) ||
    tMinK < 200 ||
    tMaxK > 6000 ||
    tMaxK <= tMinK ||
    !Number.isInteger(tSteps) ||
    tSteps < 1 ||
    !Number.isFinite(pMinBar) ||
    !Number.isFinite(pMaxBar) ||
    pMinBar <= 0 ||
    pMaxBar <= pMinBar ||
    !Number.isInteger(pSteps) ||
    pSteps < 1
  ) {
    return simFail(
      simError(
        SIM_ERROR_CODES.scenarioInvalid,
        `The burned-zone property table's grid is malformed (T [${String(tMinK)}, ${String(tMaxK)}] K in ${String(tSteps)} intervals, p [${String(pMinBar)}, ${String(pMaxBar)}] bar in ${String(pSteps)} intervals).`,
        input,
      ),
    );
  }
  if (!Number.isFinite(input.basisMassKg) || input.basisMassKg <= 0) {
    return simFail(
      simError(
        SIM_ERROR_CODES.scenarioInvalid,
        `The burned-zone property table's basis mass must be strictly positive (kg); it was ${String(input.basisMassKg)}.`,
        input.basisMassKg,
      ),
    );
  }
  const temperatureKGrid: number[] = [];
  const lnPGrid: number[] = [];
  const pressureBarGrid: number[] = [];
  const lnPMin = Math.log(pMinBar);
  const lnPMax = Math.log(pMaxBar);
  for (let i = 0; i <= tSteps; i += 1) {
    temperatureKGrid.push(tMinK + ((tMaxK - tMinK) * i) / tSteps);
  }
  for (let j = 0; j <= pSteps; j += 1) {
    const lnP = lnPMin + ((lnPMax - lnPMin) * j) / pSteps;
    lnPGrid.push(lnP);
    pressureBarGrid.push(Math.exp(lnP));
  }
  const uNodes: number[][] = [];
  const rNodes: number[][] = [];
  const iterations: number[][] = [];
  for (const tK of temperatureKGrid) {
    const uRow: number[] = [];
    const rRow: number[] = [];
    const iterRow: number[] = [];
    for (const pressureBar of pressureBarGrid) {
      const solved = solveEquilibriumTP({
        elementTotals: input.elementTotals,
        temperatureK: tK,
        pressureBar,
      });
      if (!solved.ok) return solved;
      uRow.push(
        (solved.value.enthalpyJ -
          solved.value.totalMoles * GAS_CONSTANT_J_PER_MOL_K * tK) /
          input.basisMassKg,
      );
      rRow.push(
        (solved.value.totalMoles * GAS_CONSTANT_J_PER_MOL_K) /
          input.basisMassKg,
      );
      iterRow.push(solved.value.iterations);
    }
    uNodes.push(uRow);
    rNodes.push(rRow);
    iterations.push(iterRow);
  }

  const interpolate = (
    nodes: readonly (readonly number[])[],
    tK: number,
    pressureBar: number,
  ): number => {
    const tClamped = Math.min(Math.max(tK, tMinK), tMaxK);
    let tLo = 0;
    while (
      tLo < tSteps - 1 &&
      tClamped > (temperatureKGrid[tLo + 1] ?? tMaxK)
    ) {
      tLo += 1;
    }
    const t1 = temperatureKGrid[tLo] ?? tMinK;
    const t2 = temperatureKGrid[tLo + 1] ?? tMaxK;
    const fT = t2 > t1 ? (tClamped - t1) / (t2 - t1) : 0;
    const lnPClamped = Math.min(
      Math.max(Math.log(Math.max(pressureBar, 1e-12)), lnPMin),
      lnPMax,
    );
    let pLo = 0;
    while (pLo < pSteps - 1 && lnPClamped > (lnPGrid[pLo + 1] ?? lnPMax)) {
      pLo += 1;
    }
    const q1 = lnPGrid[pLo] ?? lnPMin;
    const q2 = lnPGrid[pLo + 1] ?? lnPMax;
    const fP = q2 > q1 ? (lnPClamped - q1) / (q2 - q1) : 0;
    const rowLo = nodes[tLo] ?? [];
    const rowHi = nodes[tLo + 1] ?? rowLo;
    const uA =
      (rowLo[pLo] ?? 0) + fP * ((rowLo[pLo + 1] ?? 0) - (rowLo[pLo] ?? 0));
    const uB =
      (rowHi[pLo] ?? 0) + fP * ((rowHi[pLo + 1] ?? 0) - (rowHi[pLo] ?? 0));
    return uA + fT * (uB - uA);
  };

  return simOk(
    Object.freeze({
      temperatureKGrid: Object.freeze(temperatureKGrid),
      pressureBarGrid: Object.freeze(pressureBarGrid),
      uNodes: Object.freeze(uNodes.map((row) => Object.freeze(row))),
      rNodes: Object.freeze(rNodes.map((row) => Object.freeze(row))),
      iterations: Object.freeze(iterations.map((row) => Object.freeze(row))),
      uAtJPerKg: (tK: number, pressureBar: number): number =>
        interpolate(uNodes, tK, pressureBar),
      rAtJPerKgK: (tK: number, pressureBar: number): number =>
        interpolate(rNodes, tK, pressureBar),
      cvAtJPerKgK: (tK: number, pressureBar: number): number => {
        const h = 5;
        return (
          (interpolate(uNodes, tK + h, pressureBar) -
            interpolate(uNodes, tK - h, pressureBar)) /
          (2 * h)
        );
      },
    }),
  );
}
