/**
 * The reduced-chemistry module (ROADMAP-SIM Phase 68b): one-step
 * global Arrhenius kinetics for the curated fuels, the form
 *
 *   d[Fuel]/dt = −A · T^n · exp(−E_a/RT) · [Fuel]^a · [O₂]^b
 *
 * with every parameter from the published calibrations of
 *
 *   C. K. Westbrook and F. L. Dryer, "Simplified Reaction Mechanisms
 *   for the Oxidation of Hydrocarbon Fuels in Flames", Combustion
 *   Science and Technology 27 (1981) 31–43
 *
 * — the standard global forms, reproduced here per fuel exactly as
 * published (CGS units: concentrations mol/cm³, rate mol/(cm³·s),
 * activation energy kcal/mol, temperature exponent 0). The two fuels
 * carried are the two whose table rows this curation pins with
 * confidence; the module's door declines the others BY NAME rather
 * than guessing parameters — H₂ and CO one-step rows are an honest
 * curation gap, a loud decline, never a fabricated set (the same
 * discipline thermo-data.ts applies to species).
 *
 * The same rate law powers both the 0D reactor's reaction source and
 * the Livengood–Wu knock integral's induction time — one ignition-delay
 * definition shared by both consumers, integrated by a fixed-count
 * deterministic RK4 march (law S2).
 *
 * Honesty band, stated once here and carried at the consumers: the
 * one-step parameters are a FLAME calibration, not an autoignition
 * mechanism — no octane-number physics, no chain-branching/cool-flame
 * chemistry — so the induction times are order-of-magnitude honest
 * (the shock-tube band the tests pin) and any absolute knock integral
 * built on them is biased eager. Comparative use (trends with
 * temperature, pressure, advance, compression ratio) is the honest
 * use; absolute onset prediction is not.
 */

import {
  simError,
  simFail,
  simOk,
  SIM_ERROR_CODES,
  type SimError,
  type SimParseResult,
} from "@slopcad/sim-core";

import { GAS_CONSTANT_J_PER_MOL_K } from "./nasa7";
import { getSpecies, stoichiometricO2PerMol } from "./thermo-data";
import { premixedFuelAirInlet } from "./inlet";

/** The kcal/mol → J/mol conversion (thermochemical, exact by definition). */
const CAL_TH_PER_MOL_J = 4.184e3;

/** The one-step global rate set of one fuel, as published (CGS basis). */
export interface OneStepKinetics {
  readonly fuelName: string;
  /** Pre-exponential A as published — mol, cm, s basis. */
  readonly preExponentialCgs: number;
  /** Activation energy E_a, kcal/mol (Westbrook–Dryer table). */
  readonly activationEnergyKcalPerMol: number;
  /** Fuel concentration order a (negative on CH4 — as published). */
  readonly fuelOrder: number;
  /** Oxygen concentration order b. */
  readonly oxygenOrder: number;
  /** Temperature exponent n (0 in the 1981 table). */
  readonly temperatureExponent: number;
}

/**
 * The Westbrook–Dryer (1981) one-step table rows this curation carries.
 * CH4: A = 8.3×10⁵, E_a = 30.0 kcal/mol, a = −0.3, b = 1.3, n = 0.
 * C8H18 (both curated octanes): A = 4.6×10¹¹, E_a = 30.0 kcal/mol,
 * a = 0.25, b = 1.5, n = 0 — the table's C₈ row applied to both
 * isomers (the global-fit level does not resolve isomer chemistry;
 * stated, not hidden).
 */
export const ONE_STEP_KINETICS: Readonly<Record<string, OneStepKinetics>> =
  Object.freeze({
    CH4: Object.freeze({
      fuelName: "CH4",
      preExponentialCgs: 8.3e5,
      activationEnergyKcalPerMol: 30,
      fuelOrder: -0.3,
      oxygenOrder: 1.3,
      temperatureExponent: 0,
    }),
    "C8H18-ISO": Object.freeze({
      fuelName: "C8H18-ISO",
      preExponentialCgs: 4.6e11,
      activationEnergyKcalPerMol: 30,
      fuelOrder: 0.25,
      oxygenOrder: 1.5,
      temperatureExponent: 0,
    }),
    "C8H18-N": Object.freeze({
      fuelName: "C8H18-N",
      preExponentialCgs: 4.6e11,
      activationEnergyKcalPerMol: 30,
      fuelOrder: 0.25,
      oxygenOrder: 1.5,
      temperatureExponent: 0,
    }),
  });

/** The fuels whose one-step rows this module carries, curated order. */
export const KINETIC_FUEL_NAMES: readonly string[] = Object.freeze(
  Object.keys(ONE_STEP_KINETICS),
);

/** Looks a fuel's one-step set up, or declines naming the gap. */
export function getOneStepKinetics(
  fuelName: string,
): SimParseResult<OneStepKinetics, SimError> {
  const set = ONE_STEP_KINETICS[fuelName];
  if (set === undefined) {
    return simFail(
      simError(
        SIM_ERROR_CODES.scenarioInvalid,
        `No published one-step global rate set is carried for the fuel "${fuelName}" (carried: ${KINETIC_FUEL_NAMES.join(", ")}) — the reduced-chemistry door declines rather than guessing Arrhenius parameters.`,
        fuelName,
      ),
    );
  }
  return simOk(set);
}

/**
 * The reaction rate of the global step, SI: mol/(m³·s), with
 * concentrations in mol/m³ at temperature tK. The published CGS
 * pre-exponential is converted exactly:
 * ω_SI = 1e6^(1−a−b) · A · T^n · exp(−E_a/RT) · c_F^a · c_O₂^b.
 */
export function oneStepRateMolPerM3S(
  set: OneStepKinetics,
  tK: number,
  fuelConcentrationMolPerM3: number,
  o2ConcentrationMolPerM3: number,
): number {
  const activationJPerMol = set.activationEnergyKcalPerMol * CAL_TH_PER_MOL_J;
  const aSi =
    set.preExponentialCgs * Math.pow(1e6, 1 - set.fuelOrder - set.oxygenOrder);
  const tTerm =
    set.temperatureExponent === 0 ? 1 : Math.pow(tK, set.temperatureExponent);
  return (
    aSi *
    tTerm *
    Math.exp(-activationJPerMol / (GAS_CONSTANT_J_PER_MOL_K * tK)) *
    Math.pow(Math.max(fuelConcentrationMolPerM3, 0), set.fuelOrder) *
    Math.pow(Math.max(o2ConcentrationMolPerM3, 0), set.oxygenOrder)
  );
}

/** The unburned-mixture composition the induction march integrates on. */
interface InductionMixture {
  readonly set: OneStepKinetics;
  /** The isothermal march temperature, K (the rate's only T dependence). */
  readonly tK: number;
  /** Initial fuel concentration at (T, p), mol/m³. */
  readonly fuel0: number;
  /** Initial O₂ concentration at (T, p), mol/m³. */
  readonly o20: number;
  /** Stoichiometric O₂ per mole of fuel. */
  readonly nuO2: number;
  /**
   * Mole-number change of the global step per mole of fuel burned
   * (products minus reactants) — the concentration bookkeeping of an
   * isothermal-isobaric march.
   */
  readonly deltaN: number;
  /** Total concentration p/(RT), mol/m³ at extent 0 — fixed by (T, p). */
  readonly totalConcentration: number;
}

function inductionMixture(input: {
  readonly fuel: string;
  readonly equivalenceRatio: number;
  readonly temperatureK: number;
  readonly pressureBar: number;
}): SimParseResult<InductionMixture, SimError> {
  const set = getOneStepKinetics(input.fuel);
  if (!set.ok) return set;
  const inlet = premixedFuelAirInlet({
    fuel: input.fuel,
    equivalenceRatio: input.equivalenceRatio,
    inletTK: input.temperatureK,
  });
  if (!inlet.ok) return inlet;
  const fuelRecord = getSpecies(input.fuel);
  if (fuelRecord === undefined) {
    return simFail(
      simError(
        SIM_ERROR_CODES.scenarioInvalid,
        `The fuel "${input.fuel}" is not in the curated NASA-7 database.`,
        input.fuel,
      ),
    );
  }
  const nuO2 = stoichiometricO2PerMol(fuelRecord.composition);
  const totalConcentration =
    (input.pressureBar * 1e5) / (GAS_CONSTANT_J_PER_MOL_K * input.temperatureK);
  // Product moles per mole of fuel at complete oxidation, frozen
  // composition (the global step's bookkeeping): C → CO₂, H → H₂O
  // vapor, inerts riding through.
  const productMoles =
    (fuelRecord.composition["C"] ?? 0) + (fuelRecord.composition["H"] ?? 0) / 2;
  const deltaN = productMoles - 1 - nuO2;
  const nTot = Object.values(inlet.value.species).reduce((s, v) => s + v, 0);
  const fuel0 =
    ((inlet.value.species[input.fuel] ?? 0) / nTot) * totalConcentration;
  const o2 = (inlet.value.species["O2"] ?? 0) / nTot;
  return simOk({
    set: set.value,
    tK: input.temperatureK,
    fuel0,
    o20: o2 * totalConcentration,
    nuO2,
    deltaN,
    totalConcentration,
  });
}

/** The march's extent-of-fuel-consumed derivative at fixed (T, p). */
function inductionRate(mix: InductionMixture, extent: number): number {
  const nTot = mix.totalConcentration + extent * mix.deltaN;
  const fuel = Math.max(mix.fuel0 - extent, 0);
  const o2 = Math.max(mix.o20 - mix.nuO2 * extent, 0);
  // Partial concentrations at extent 0 scaled to the current total:
  // c_i = y_i(λ)·c_tot(λ) with y_i from the fixed-basis mole numbers.
  const yScale = nTot / mix.totalConcentration;
  return oneStepRateMolPerM3S(mix.set, mix.tK, fuel * yScale, o2 * yScale);
}

/**
 * The induction-time (ignition-delay) march's fixed step budget. The
 * horizon is 4× the initial-rate linear estimate (positive fuel orders
 * decelerate the march by less than that; the negative CH4 order only
 * accelerates it), the count is fixed, and the threshold crossing is
 * located by a fixed-count bisection inside the bracketing step —
 * bitwise deterministic, no adaptivity anywhere.
 */
const INDUCTION_STEPS = 400;
const INDUCTION_HORIZON_MULTIPLE = 4;
const INDUCTION_BISECTION_STEPS = 40;
/** The fuel-consumed fraction that marks ignition. */
export const IGNITION_THRESHOLD_FRACTION = 0.05;

/** An induction-time result with its provenance. */
export interface IgnitionDelayResult {
  readonly ignitionDelayS: number;
  readonly thresholdFraction: number;
  readonly fuel: string;
  readonly equivalenceRatio: number;
  readonly temperatureK: number;
  readonly pressureBar: number;
  /** The initial-rate linear estimate τ₀ = x·c_F0/ω₀, s (the march's scale). */
  readonly initialRateEstimateS: number;
}

/**
 * The ignition delay of a premixed fuel–air state under the carried
 * one-step kinetics: the time for 5% of the REACHABLE fuel extent to
 * burn at fixed temperature and pressure (the classic global-mechanism
 * induction definition), integrated by the fixed-count deterministic
 * RK4 march. This is the single induction-time definition the 0D
 * reactor and the Livengood–Wu knock integral share — and it is a
 * flame calibration's order-of-magnitude delay, not an autoignition
 * mechanism's (no octane-number physics): trust it comparatively,
 * not as an absolute knock onset.
 */
export function ignitionDelaySeconds(input: {
  readonly fuel: string;
  readonly equivalenceRatio: number;
  readonly temperatureK: number;
  readonly pressureBar: number;
}): SimParseResult<IgnitionDelayResult, SimError> {
  if (!Number.isFinite(input.temperatureK) || input.temperatureK <= 0) {
    return simFail(
      simError(
        SIM_ERROR_CODES.scenarioInvalid,
        `The induction march needs a strictly positive temperature (K); it was ${String(input.temperatureK)}.`,
        input.temperatureK,
      ),
    );
  }
  if (!Number.isFinite(input.pressureBar) || input.pressureBar <= 0) {
    return simFail(
      simError(
        SIM_ERROR_CODES.scenarioInvalid,
        `The induction march needs a strictly positive pressure (bar); it was ${String(input.pressureBar)}.`,
        input.pressureBar,
      ),
    );
  }
  const mix = inductionMixture(input);
  if (!mix.ok) return mix;
  const m = mix.value;
  // The reachable extent: oxidizer-limited on rich mixtures.
  const extentMax = Math.min(m.fuel0, m.o20 / Math.max(m.nuO2, 1e-12));
  if (!(extentMax > 0)) {
    return simFail(
      simError(
        SIM_ERROR_CODES.scenarioInvalid,
        "The induction march needs a combustible mixture: either fuel or oxidizer is absent.",
        input,
      ),
    );
  }
  const threshold = IGNITION_THRESHOLD_FRACTION * extentMax;
  const rate0 = inductionRate(m, 0);
  if (!(rate0 > 0)) {
    return simFail(
      simError(
        SIM_ERROR_CODES.quantityInvalid,
        "The induction march's initial rate is not positive; the delay is undefined.",
        input,
      ),
    );
  }
  const linearEstimate = threshold / rate0;
  const horizon = INDUCTION_HORIZON_MULTIPLE * linearEstimate;
  const dt = horizon / INDUCTION_STEPS;
  let extent = 0;
  let crossed = -1;
  for (let step = 0; step < INDUCTION_STEPS; step += 1) {
    const t = step * dt;
    const k1 = inductionRate(m, extent);
    const k2 = inductionRate(m, extent + 0.5 * dt * k1);
    const k3 = inductionRate(m, extent + 0.5 * dt * k2);
    const k4 = inductionRate(m, extent + dt * k3);
    const next = extent + (dt / 6) * (k1 + 2 * k2 + 2 * k3 + k4);
    if (next >= threshold && extent < threshold) {
      crossed = t;
      break;
    }
    extent = next;
  }
  if (crossed < 0) {
    return simFail(
      simError(
        SIM_ERROR_CODES.solverUnconverged,
        `The induction march exhausted its ${String(INDUCTION_STEPS)}-step horizon (${horizon.toExponential(3)} s) without crossing the ${String(IGNITION_THRESHOLD_FRACTION)} fuel-consumed threshold at ${String(input.temperatureK)} K — the run declines rather than extrapolating a delay.`,
        input,
      ),
    );
  }
  // Locate the crossing inside the bracketing step by fixed-count
  // bisection on the extent variable.
  let lo = 0;
  let hi = dt;
  for (let i = 0; i < INDUCTION_BISECTION_STEPS; i += 1) {
    const mid = 0.5 * (lo + hi);
    const k1 = inductionRate(m, extent);
    const k2 = inductionRate(m, extent + 0.5 * mid * k1);
    const k3 = inductionRate(m, extent + 0.5 * mid * k2);
    const k4 = inductionRate(m, extent + mid * k3);
    const reached = extent + (mid / 6) * (k1 + 2 * k2 + 2 * k3 + k4);
    if (reached >= threshold) {
      hi = mid;
    } else {
      lo = mid;
    }
  }
  return simOk({
    ignitionDelayS: crossed + 0.5 * (lo + hi),
    thresholdFraction: IGNITION_THRESHOLD_FRACTION,
    fuel: input.fuel,
    equivalenceRatio: input.equivalenceRatio,
    temperatureK: input.temperatureK,
    pressureBar: input.pressureBar,
    initialRateEstimateS: linearEstimate,
  });
}
