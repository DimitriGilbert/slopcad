/**
 * The 0D engine cycle (ROADMAP-SIM Phase 68b — the named deliverable):
 * a two-zone premixed (Otto) SI chamber integrating pressure and
 * temperature over the closed portion of the cycle with equilibrium
 * burned-gas properties (the Phase 68a solver, tabulated per charge)
 * and Wiebe heat release GROUNDED in the Metghalchi–Keck laminar
 * flame-speed correlation — the burn duration is chamber scale over
 * flame speed, never a fitted diesel-style burn curve.
 *
 * SHIPPED vs DEFERRED, stated once here: this is the IDEAL OTTO
 * CLOSED-CYCLE subset. The chamber integrates from intake-valve
 * closing at BDC to exhaust-valve opening at BDC; the trapped charge
 * is authored as the IVC state (pressure, temperature, equivalence
 * ratio) — composition/AFR as transported state, the researched
 * failure mode's fix, so a throttled or ultra-lean charge releases
 * exactly the fuel energy it actually traps. Gas exchange —
 * Pulkrabek orifice valve flow through IVO/EVC — is DEFERRED, with
 * the breathing modeled honestly as the authored IVC state (no intake
 * heat pickup, no valve-flow pumping loop; the pumping loss rides the
 * friction family as an authored PMEP field instead of an integrated
 * loop, stated as correlation-band honest). The Phase 67 slider-crank
 * supplies the chamber volume history through the standard linkage
 * formula (engine-geometry.ts, pinned bitwise against sim-dynamics).
 *
 * Energy bookkeeping follows the kinetic-energy-state discipline: the
 * march's STATE is the two zone energies plus the burned mass
 * fraction; temperatures and the common pressure are DERIVED by
 * inverting that state, so the step identity
 *
 *   ΔU_u + ΔU_b = −p̄·ΔV − Q̇·Δt
 *
 * holds by construction with the SAME p̄ and Q̇ the committed work and
 * wall-heat accumulators use (float summation and nothing else), and
 * the cycle closes as fuel = brake + exhaust enthalpy + wall/coolant
 * loss, friction dissipation included, residual at the summation
 * floor.
 *
 * Friction makes the outputs BRAKE quantities: the Chen–Flynn FMEP
 * correlation as scenario fields with published-range defaults
 * (sources in the constants below), pumping as an authored PMEP field
 * per the correlation's standard use; wall heat through the Woschni
 * (1967) correlation as scenario fields likewise — the adiabatic
 * trace one entry away (wallHeat mode "adiabatic"). Knock is the
 * Livengood–Wu integral over the unburned zone with the SAME induction
 * definition the 0D reactor uses (the one-step kinetics ignition
 * delay), marking the spark-advance boundary — comparatively honest
 * only: that delay is a flame calibration, not an autoignition
 * mechanism (no octane-number physics), so the absolute integral is
 * biased eager and only its trends with advance, compression ratio,
 * and charge state are meaningful. Spray/non-premixed is declined
 * with a `sim/*` code at this door too — every level, §6.
 */

import {
  simError,
  simFail,
  simOk,
  SIM_ERROR_CODES,
  type SimError,
  type SimHistoryTable,
  type SimParseResult,
} from "@slopcad/sim-core";

import {
  buildBurnedEquilibriumTable,
  completeCombustionOf,
  frozenInternalEnergyJPerKg,
  frozenMixture,
  frozenTemperatureFromInternalEnergyK,
  lowerHeatingValueJPerKg,
  type BurnedEquilibriumTable,
  type FrozenMixture,
} from "./gas-properties";
import {
  chamberVolumeM3,
  chamberVolumePerRad,
  chamberWallAreaM2,
  compileSliderCrankGeometry,
  compressionRatioOf,
  displacementM3,
  type SliderCrankGeometry,
} from "./engine-geometry";
import { laminarFlameSpeedMPerS } from "./flame-speed";
import { ignitionDelaySeconds } from "./kinetics";
import { premixedFuelAirInlet } from "./inlet";
import { getSpecies } from "./thermo-data";

/** The combustion modes the cycle door understands. */
export type CycleCombustionMode = "premixed";

/**
 * The Chen–Flynn FMEP correlation's scenario fields:
 * FMEP = a + b·p_max + c·v̄_piston + d·v̄_piston², bar-side units.
 */
export interface ChenFlynnFriction {
  readonly aBar: number;
  readonly bBarPerBar: number;
  readonly cBarPerMPerS: number;
  readonly dBarPerM2S2: number;
  /**
   * The pumping mean effective pressure, bar — authored per the
   * correlation's standard use (BMEP = IMEP − FMEP − PMEP); the
   * closed-cycle subset carries no integrated gas-exchange loop.
   */
  readonly pumpingMepBar: number;
}

/**
 * The Chen–Flynn default, mid-range of the published calibration
 * ranges quoted across the engine-friction literature and 1D
 * engine-model practice (per-engine calibrated: a ≈ 0.3–0.5 bar,
 * b ≈ 0.005–0.01 bar/bar, c ≈ 0.05–0.10 bar/(m/s),
 * d ≈ 0.001–0.005 bar/(m/s)² — the ranges surveyed by Pipitone,
 * "A new simple friction model for S.I. engines", SAE 2004-01-2022,
 * and by Tadros et al.'s Chen–Flynn term determination, MDPI 2025).
 * Pumping: the naturally-aspirated four-stroke WOT band ~0.1–0.3 bar
 * (Heywood's gas-exchange discussion). Correlation-band honest, not a
 * component model — per-component breakdown is deferred by ruling.
 */
export const CHEN_FLYNN_DEFAULT: Readonly<ChenFlynnFriction> = Object.freeze({
  aBar: 0.4,
  bBarPerBar: 0.0075,
  cBarPerMPerS: 0.075,
  dBarPerM2S2: 0.0025,
  pumpingMepBar: 0.2,
});

/** The wall-heat boundary: Woschni correlation fields, or adiabatic. */
export type CycleWallHeat =
  | { readonly mode: "adiabatic" }
  | {
      readonly mode: "woschni";
      /** The wall temperature, K (coolant-side head/liner, authored). */
      readonly wallTemperatureK: number;
    };

/** The Wiebe function's shape parameters, scenario fields. */
export interface WiebeParameters {
  /** The completion factor a — 99.3% burned at the duration's end. */
  readonly completionFactorA: number;
  /** The form factor m. */
  readonly formFactorM: number;
}

/**
 * The Wiebe defaults published for SI engine heat release: a = 5,
 * m = 2 (Heywood, Internal Combustion Engine Fundamentals, 1988 — the
 * burned-fraction analysis's typical SI values). The burn DURATION is
 * never fitted: it is derived from the flame-speed correlation.
 */
export const WIEBE_DEFAULT: Readonly<WiebeParameters> = Object.freeze({
  completionFactorA: 5,
  formFactorM: 2,
});

/**
 * The burn-duration grounding's turbulent-flame multiplier: the flame
 * travel (half the bore) divided by the enhanced flame speed
 * f_T·S_L. Default 10 — the value consistent with the published SI
 * burn-duration band of roughly 50–60° crank at mid speeds (Heywood)
 * against the Metghalchi–Keck flame speed at chamber conditions on
 * production-bore engines; a scenario field, not a fitted constant.
 */
export const DEFAULT_TURBULENCE_SPEED_MULTIPLIER = 10;

/** The Otto closed-cycle scenario, SI. */
export interface OttoCycleScenario {
  readonly combustionMode: CycleCombustionMode | "spray" | "non-premixed";
  readonly fuel: string;
  readonly geometry: {
    readonly boreM: number;
    readonly crankRadiusM: number;
    readonly rodLengthM: number;
    readonly compressionRatio: number;
  };
  readonly speedRpm: number;
  readonly charge: {
    readonly intakePressureBar: number;
    readonly intakeTK: number;
    readonly equivalenceRatio: number;
  };
  readonly spark: {
    /** Spark timing, crank degrees BEFORE compression TDC. */
    readonly timingBTDCDeg: number;
    readonly turbulenceSpeedMultiplier?: number;
    readonly wiebe?: WiebeParameters;
  };
  readonly wallHeat: CycleWallHeat;
  readonly friction?: ChenFlynnFriction;
  readonly integration?: {
    /** The crank-angle step, degrees (default 0.5). */
    readonly crankStepDeg?: number;
    /** The property-table grid density multipliers (defaults 1). */
    readonly tableTSteps?: number;
    readonly tablePSteps?: number;
  };
}

/** The burned-fraction (Wiebe) shape with its derived duration. */
export interface BurnModel {
  readonly sparkAngleRad: number;
  /** The DERIVED burn duration, rad — chamber scale over flame speed. */
  readonly burnDurationRad: number;
  readonly turbulenceSpeedMultiplier: number;
  readonly wiebe: WiebeParameters;
  /** The flame speed the duration was grounded on, m/s. */
  readonly flameSpeedMPerS: number;
  /** The unburned state the flame speed was evaluated at. */
  readonly groundedAt: { readonly tK: number; readonly pressureBar: number };
  /** The correlation's validity report at that state. */
  readonly withinFitBand: {
    readonly temperature: boolean;
    readonly pressure: boolean;
    readonly dilution: boolean;
  };
}

/** The indicated (gas-path) family — the bookkeeping truth. */
export interface IndicatedFamily {
  /** The closed-portion net work, J. */
  readonly workJ: number;
  /** The gross closed-portion IMEP, Pa. */
  readonly imepPa: number;
  /** Indicated thermal efficiency over the fuel's LHV energy. */
  readonly thermalEfficiency: number;
  readonly fuelMassKg: number;
  readonly lhvJPerKg: number;
  readonly fuelEnergyJ: number;
}

/** The brake family (friction overlay, correlation-band honest). */
export interface BrakeFamily {
  readonly fmepPa: number;
  readonly pmepPa: number;
  readonly bmepPa: number;
  /** Brake torque per cycle, N·m (four-stroke: W/(4π)). */
  readonly torqueNPerM: number;
  /** Brake power, W. */
  readonly powerW: number;
  readonly thermalEfficiency: number;
  /** The friction work over the cycle = FMEP·V_d, J. */
  readonly frictionWorkJ: number;
}

/** The loss family and the audit that closes the energy balance. */
export interface EnergyAudit {
  /** The wall/coolant rejection over the closed portion, J. */
  readonly wallHeatJ: number;
  /** The friction dissipation over the cycle (= FMEP·V_d), J. */
  readonly frictionWorkJ: number;
  /** The exhaust enthalpy at EVO above the products-at-298.15 reference, J. */
  readonly exhaustEnthalpyJ: number;
  /** The charge's sensible energy at IVC above reactants at 298.15, J. */
  readonly intakeSensibleJ: number;
  /**
   * The fuel chemical energy = derived LHV × fuel mass, J — the left
   * side of fuel = brake + exhaust enthalpy + wall/coolant loss.
   */
  readonly fuelChemicalJ: number;
  /** fuelChemical − (brake + friction + wall + exhaust − intakeSensible), J. */
  readonly residualJ: number;
}

/**
 * The Livengood–Wu knock report over the unburned zone.
 *
 * Comparative-band honest: the induction time underneath the integral
 * is the one-step Westbrook–Dryer flame calibration, not an
 * autoignition mechanism — there is no octane-number physics, no
 * cool-flame/NTC behavior, no end-gas chemistry in it. The ABSOLUTE
 * integral (and therefore any absolute onset angle it reports) is
 * biased eager and is not a knock-limit predictor; the report is
 * trustworthy comparatively — the integral's trend with spark
 * advance, compression ratio, and charge state — which is exactly how
 * the cycle uses it (marking the advance boundary, relatively).
 */
export interface KnockReport {
  /** The integral's maximum (∫ dt/τ over the unburned zone's life). */
  readonly integralMax: number;
  /** The crank angle where the integral crossed 1, degrees, if it did. */
  readonly onsetAngleDeg: number | undefined;
}

/** The 0D Otto closed-cycle result. */
export interface OttoCycleResult {
  readonly fuel: string;
  readonly speedRpm: number;
  readonly geometry: SliderCrankGeometry;
  readonly compressionRatio: number;
  readonly charge: OttoCycleScenario["charge"];
  readonly history: SimHistoryTable;
  readonly burn: BurnModel;
  readonly indicated: IndicatedFamily;
  readonly brake: BrakeFamily;
  readonly audit: EnergyAudit;
  readonly knock: KnockReport;
  readonly peak: {
    readonly pressureBar: number;
    readonly pressureAngleDeg: number;
    readonly burnedTemperatureK: number;
  };
  /** The motored companion (no combustion) the cycle ran beside. */
  readonly motored: {
    readonly imepPa: number;
    readonly peakPressureBar: number;
    readonly peakTemperatureK: number;
  };
}

/** The Wiebe burned mass fraction at crank angle θ. */
export function wiebeBurnedFraction(
  burn: Pick<BurnModel, "sparkAngleRad" | "burnDurationRad" | "wiebe">,
  crankAngleRad: number,
): number {
  if (crankAngleRad <= burn.sparkAngleRad || burn.burnDurationRad <= 0) {
    return 0;
  }
  const progress = (crankAngleRad - burn.sparkAngleRad) / burn.burnDurationRad;
  return (
    1 -
    Math.exp(
      -burn.wiebe.completionFactorA *
        Math.pow(progress, burn.wiebe.formFactorM + 1),
    )
  );
}

/** Woschni's C₁ for the closed portion (valves shut). */
export const WOSCHNI_C1_CLOSED = 2.28;
/** Woschni's combustion-term coefficient, m/(s·K). */
export const WOSCHNI_C2_BURNING = 3.24e-3;

/**
 * The Woschni (1967) convective coefficient, W/(m²·K) — the published
 * correlation exactly:
 *
 *   h = 3.26·B^(−0.2)·p^0.8·T^(−0.55)·w^0.8
 *
 * with B in m, p in kPa, T in K, w in m/s (the constant's units —
 * the equation is a curve fit, not dimensionally homogeneous; the kPa
 * entry is where the published constant lives).
 *
 *   G. Woschni, "A Universally Applicable Equation for the
 *   Instantaneous Heat Transfer Coefficient in the Internal
 *   Combustion Engine", SAE Paper 670931, 1967.
 */
export function woschniHeatTransferCoefficientWPerM2K(input: {
  readonly boreM: number;
  readonly pressureBar: number;
  readonly gasTK: number;
  readonly gasVelocityMPerS: number;
}): number {
  return (
    3.26 *
    Math.pow(input.boreM, -0.2) *
    Math.pow(input.pressureBar * 100, 0.8) *
    Math.pow(input.gasTK, -0.55) *
    Math.pow(Math.max(input.gasVelocityMPerS, 1e-6), 0.8)
  );
}

/** The Chen–Flynn FMEP, bar. */
export function chenFlynnFmepBar(
  friction: ChenFlynnFriction,
  maxCylinderPressureBar: number,
  meanPistonSpeedMPerS: number,
): number {
  return (
    friction.aBar +
    friction.bBarPerBar * maxCylinderPressureBar +
    friction.cBarPerMPerS * meanPistonSpeedMPerS +
    friction.dBarPerM2S2 * meanPistonSpeedMPerS * meanPistonSpeedMPerS
  );
}

/** The trapped charge reduced to the march's property basis. */
interface ChargeState {
  readonly massKg: number;
  readonly fuelMassKg: number;
  readonly unburned: FrozenMixture;
  readonly elementTotals: Readonly<Record<string, number>>;
  readonly basisMassKg: number;
  /** Reactants-at-298.15 specific internal energy, J/kg (audit ref). */
  readonly uReactants298JPerKg: number;
  /** Complete-combustion-products-at-298.15 u, J/kg (audit ref). */
  readonly uProducts298JPerKg: number;
}

function buildCharge(input: {
  readonly fuel: string;
  readonly equivalenceRatio: number;
  readonly intakeTK: number;
  readonly intakePressureBar: number;
  readonly volumeM3: number;
}): SimParseResult<ChargeState, SimError> {
  const inlet = premixedFuelAirInlet({
    fuel: input.fuel,
    equivalenceRatio: input.equivalenceRatio,
    inletTK: input.intakeTK,
  });
  if (!inlet.ok) return inlet;
  const mix = frozenMixture(inlet.value.species);
  if (!mix.ok) return mix;
  const unburned = mix.value;
  const massKg =
    (input.intakePressureBar * 1e5 * input.volumeM3) /
    (unburned.gasConstantJPerKgK * input.intakeTK);
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
  const fuelMassFraction =
    ((inlet.value.species[input.fuel] ?? 0) *
      fuelRecord.molecularWeightKgPerKmol) /
    1000 /
    unburned.basisMassKg;
  const products = completeCombustionOf(inlet.value.species);
  if (products.unconsumedFuelMoles > 0) {
    return simFail(
      simError(
        SIM_ERROR_CODES.scenarioInvalid,
        `The charge at equivalence ratio ${String(input.equivalenceRatio)} is too rich for the complete-combustion reference (past CO saturation); the closed cycle declines rather than guessing a partial-burn reference.`,
        input.equivalenceRatio,
      ),
    );
  }
  const productsMix = frozenMixture(products.species);
  if (!productsMix.ok) return productsMix;
  return simOk({
    massKg,
    fuelMassKg: fuelMassFraction * massKg,
    unburned,
    elementTotals: inlet.value.elementTotals,
    basisMassKg: unburned.basisMassKg,
    uReactants298JPerKg: frozenInternalEnergyJPerKg(unburned, 298.15),
    uProducts298JPerKg: frozenInternalEnergyJPerKg(productsMix.value, 298.15),
  });
}

/** Zone state derived from the (U_u, U_b, x_b, V) march state. */
interface ZoneState {
  readonly tUnburnedK: number;
  readonly tBurnedK: number;
  readonly pressureBar: number;
}

/**
 * Inverts the zone energies at a common pressure: T_u from the frozen
 * inversion (p-independent), T_b from the equilibrium table's u(·, p)
 * inversion by Newton with a fixed-count bisection safeguard, and the
 * pressure by log-bisection on the volume residual
 * (m_u·R_u·T_u + m_b·R_b·T_b)/p − V = 0 — monotone decreasing in p.
 * Fixed iteration counts throughout: bitwise deterministic.
 */
function solveZones(input: {
  readonly unburned: FrozenMixture;
  readonly table: BurnedEquilibriumTable;
  readonly mUnburnedKg: number;
  readonly mBurnedKg: number;
  readonly uUnburnedJPerKg: number;
  readonly uBurnedJPerKg: number;
  readonly volumeM3: number;
  readonly seed: ZoneState;
}): ZoneState {
  // The no-zone sentinels read 0 K — an unambiguous "zone absent"
  // marker in the history, never a fabricated temperature.
  const tUnburnedK =
    input.mUnburnedKg > 0
      ? frozenTemperatureFromInternalEnergyK(
          input.unburned,
          input.uUnburnedJPerKg,
        )
      : 0;
  const burnedTemperatureAt = (pressureBar: number): number => {
    if (input.mBurnedKg <= 0) return 0;
    let t = Math.min(Math.max(input.seed.tBurnedK, 400), 5500);
    let converged = false;
    for (let i = 0; i < 7; i += 1) {
      const f = input.table.uAtJPerKg(t, pressureBar) - input.uBurnedJPerKg;
      const cv = input.table.cvAtJPerKgK(t, pressureBar);
      if (!(cv > 1)) break;
      const next = t - f / cv;
      if (!Number.isFinite(next)) break;
      t = Math.min(Math.max(next, 300), 6000);
      if (Math.abs(f) < 1e3) {
        converged = true;
        break;
      }
    }
    if (!converged) {
      // Fixed-count bisection safeguard over the table span.
      let lo = 300;
      let hi = 6000;
      for (let i = 0; i < 48; i += 1) {
        const mid = 0.5 * (lo + hi);
        if (input.table.uAtJPerKg(mid, pressureBar) < input.uBurnedJPerKg) {
          lo = mid;
        } else {
          hi = mid;
        }
      }
      t = 0.5 * (lo + hi);
    }
    return t;
  };
  const volumeResidual = (pressureBar: number): number => {
    if (input.mBurnedKg <= 0) {
      return (
        (input.mUnburnedKg * input.unburned.gasConstantJPerKgK * tUnburnedK) /
          (pressureBar * 1e5) -
        input.volumeM3
      );
    }
    const tB = burnedTemperatureAt(pressureBar);
    const rBurned = input.table.rAtJPerKgK(tB, pressureBar);
    return (
      (input.mUnburnedKg * input.unburned.gasConstantJPerKgK * tUnburnedK +
        input.mBurnedKg * rBurned * tB) /
        (pressureBar * 1e5) -
      input.volumeM3
    );
  };
  let lo = 1e-3;
  let hi = 1e4;
  for (let expand = 0; expand < 60; expand += 1) {
    if (volumeResidual(lo) > 0 && volumeResidual(hi) < 0) break;
    lo /= 2;
    hi *= 2;
  }
  let lnLo = Math.log(lo);
  let lnHi = Math.log(hi);
  for (let i = 0; i < 48; i += 1) {
    const lnMid = 0.5 * (lnLo + lnHi);
    if (volumeResidual(Math.exp(lnMid)) > 0) {
      lnLo = lnMid;
    } else {
      lnHi = lnMid;
    }
  }
  const pressureBar = Math.exp(0.5 * (lnLo + lnHi));
  return {
    tUnburnedK,
    tBurnedK: input.mBurnedKg > 0 ? burnedTemperatureAt(pressureBar) : 0,
    pressureBar,
  };
}

/**
 * Runs the 0D Otto closed cycle: the motored companion first (the
 * unburned-only pass whose spark-instant state grounds the burn
 * duration — no heat has been released at the spark — and whose
 * pressure trace feeds Woschni's combustion term), then the fired
 * two-zone march with the conservative-by-construction zone-energy
 * bookkeeping, then the indicated/brake/audit/knock projections.
 * Pure, deterministic, loud on every decline.
 */
export function runOttoCycle(
  scenario: OttoCycleScenario,
): SimParseResult<OttoCycleResult, SimError> {
  if (scenario.combustionMode !== "premixed") {
    return simFail(
      simError(
        SIM_ERROR_CODES.combustionModeUnsupported,
        `The 0D engine cycle models premixed (Otto) charges only; "${scenario.combustionMode}" combustion (spray, mixing-controlled, diesel-class) is declined at every level per the roadmap's scope boundary, never approximated with a fitted burn curve.`,
        scenario.combustionMode,
      ),
    );
  }
  const flameGate = laminarFlameSpeedMPerS({
    fuel: scenario.fuel,
    equivalenceRatio: scenario.charge.equivalenceRatio,
    unburnedTK: scenario.charge.intakeTK,
    pressureBar: scenario.charge.intakePressureBar,
  });
  if (!flameGate.ok) return flameGate;
  const { geometry: wire } = scenario;
  if (!Number.isFinite(wire.compressionRatio) || wire.compressionRatio <= 1) {
    return simFail(
      simError(
        SIM_ERROR_CODES.scenarioInvalid,
        `The compression ratio must exceed 1; it was ${String(wire.compressionRatio)}.`,
        wire.compressionRatio,
      ),
    );
  }
  const displacement =
    Math.PI * 0.25 * wire.boreM * wire.boreM * 2 * wire.crankRadiusM;
  const geometry = compileSliderCrankGeometry({
    boreM: wire.boreM,
    crankRadiusM: wire.crankRadiusM,
    rodLengthM: wire.rodLengthM,
    clearanceVolumeM3: displacement / (wire.compressionRatio - 1),
  });
  if (!geometry.ok) return geometry;
  const geo = geometry.value;
  if (!Number.isFinite(scenario.speedRpm) || scenario.speedRpm <= 0) {
    return simFail(
      simError(
        SIM_ERROR_CODES.scenarioInvalid,
        `The engine speed must be strictly positive (rpm); it was ${String(scenario.speedRpm)}.`,
        scenario.speedRpm,
      ),
    );
  }
  const timingDeg = scenario.spark.timingBTDCDeg;
  if (!Number.isFinite(timingDeg) || timingDeg <= 0 || timingDeg >= 178) {
    return simFail(
      simError(
        SIM_ERROR_CODES.scenarioInvalid,
        `The spark timing must lie strictly inside the compression stroke (0–178° before TDC); it was ${String(timingDeg)}°.`,
        timingDeg,
      ),
    );
  }
  const crankStepDeg = scenario.integration?.crankStepDeg ?? 0.5;
  if (!Number.isFinite(crankStepDeg) || crankStepDeg <= 0 || crankStepDeg > 5) {
    return simFail(
      simError(
        SIM_ERROR_CODES.scenarioInvalid,
        `The crank step must lie in (0, 5] degrees; it was ${String(crankStepDeg)}°.`,
        crankStepDeg,
      ),
    );
  }
  const wiebe = scenario.spark.wiebe ?? WIEBE_DEFAULT;
  if (
    !Number.isFinite(wiebe.completionFactorA) ||
    wiebe.completionFactorA <= 0 ||
    !Number.isFinite(wiebe.formFactorM) ||
    wiebe.formFactorM <= -1
  ) {
    return simFail(
      simError(
        SIM_ERROR_CODES.scenarioInvalid,
        "The Wiebe shape parameters are malformed (completion factor > 0 and form factor > −1 required).",
        wiebe,
      ),
    );
  }
  if (
    scenario.wallHeat.mode === "woschni" &&
    (!Number.isFinite(scenario.wallHeat.wallTemperatureK) ||
      scenario.wallHeat.wallTemperatureK <= 0)
  ) {
    return simFail(
      simError(
        SIM_ERROR_CODES.scenarioInvalid,
        `The Woschni wall temperature must be strictly positive (K); it was ${String(scenario.wallHeat.wallTemperatureK)}.`,
        scenario.wallHeat.wallTemperatureK,
      ),
    );
  }

  const vBdc = chamberVolumeM3(geo, Math.PI);
  const charge = buildCharge({
    fuel: scenario.fuel,
    equivalenceRatio: scenario.charge.equivalenceRatio,
    intakeTK: scenario.charge.intakeTK,
    intakePressureBar: scenario.charge.intakePressureBar,
    volumeM3: vBdc,
  });
  if (!charge.ok) return charge;
  const chargeState = charge.value;
  const lhv = lowerHeatingValueJPerKg(scenario.fuel);
  if (!lhv.ok) return lhv;

  const steps = Math.round(360 / crankStepDeg);
  const omegaRadPerS = (scenario.speedRpm * 2 * Math.PI) / 60;
  // The MEAN piston speed over a revolution: the pin travels up and
  // back 2·stroke per crank turn, so v̄_p = 2·stroke·N = stroke·ω/π —
  // NOT stroke·ω (that is π× the mean; the instantaneous piston speed
  // swings from zero at the dead centers to ≈(stroke/2)·ω·(1 + λ/2) at
  // mid-stroke, λ the rod ratio, averaging stroke·ω/π over the turn).
  // Chen–Flynn's v̄_p term and Woschni's C₁·c̄_m both take this
  // cycle-mean value: 86 mm stroke at 1500 rpm → 4.30 m/s.
  const meanPistonSpeed = (2 * geo.crankRadiusM * omegaRadPerS) / Math.PI;
  const dTheta = (2 * Math.PI) / steps;
  const dt = dTheta / omegaRadPerS;
  const initialUJPerKg = frozenInternalEnergyJPerKg(
    chargeState.unburned,
    scenario.charge.intakeTK,
  );

  // ---- The motored companion: unburned-only, same grid, Woschni when
  // the fired run asks for it (its combustion term consumes this trace).
  const motoredWanted = scenario.wallHeat.mode === "woschni";
  const motoredPressureBar: number[] = [];
  const motoredTK: number[] = [];
  let motoredWorkJ = 0;
  {
    let u = initialUJPerKg;
    let v = vBdc;
    let p = scenario.charge.intakePressureBar;
    let t = scenario.charge.intakeTK;
    for (let step = 0; step <= steps; step += 1) {
      motoredPressureBar.push(p);
      motoredTK.push(t);
      if (step === steps) break;
      const theta = -Math.PI + dTheta * step;
      const nextV = chamberVolumeM3(geo, -Math.PI + dTheta * (step + 1));
      let qRate = 0;
      if (motoredWanted && scenario.wallHeat.mode === "woschni") {
        const h = woschniHeatTransferCoefficientWPerM2K({
          boreM: geo.boreM,
          pressureBar: p,
          gasTK: t,
          gasVelocityMPerS: WOSCHNI_C1_CLOSED * meanPistonSpeed,
        });
        qRate =
          h *
          chamberWallAreaM2(geo, theta) *
          (t - scenario.wallHeat.wallTemperatureK);
      }
      const dv = nextV - v;
      // Conservative Euler bookkeeping, specific-energy form:
      // u += (−p·ΔV − Q̇·Δt)/m — both bracketed terms are absolute
      // joules over the charge mass.
      u += (-(p * 1e5 * dv) - qRate * dt) / chargeState.massKg;
      motoredWorkJ += p * 1e5 * dv;
      t = frozenTemperatureFromInternalEnergyK(chargeState.unburned, u);
      p =
        (chargeState.massKg * chargeState.unburned.gasConstantJPerKgK * t) /
        nextV /
        1e5;
      v = nextV;
    }
  }

  // ---- The burn-duration grounding: the Metghalchi–Keck flame speed
  // at the MOTORED state at the spark instant, travel = half the bore,
  // enhanced speed = multiplier × S_L, duration = ω·travel/enhanced.
  const sparkIndex = Math.round((steps * (180 - timingDeg)) / 360);
  const sparkTheta = -Math.PI + dTheta * sparkIndex;
  const sparkTK =
    motoredTK[Math.min(sparkIndex, steps)] ?? scenario.charge.intakeTK;
  const sparkPBar =
    motoredPressureBar[Math.min(sparkIndex, steps)] ??
    scenario.charge.intakePressureBar;
  const flameAtSpark = laminarFlameSpeedMPerS({
    fuel: scenario.fuel,
    equivalenceRatio: scenario.charge.equivalenceRatio,
    unburnedTK: sparkTK,
    pressureBar: sparkPBar,
  });
  if (!flameAtSpark.ok) return flameAtSpark;
  const turbulenceMultiplier =
    scenario.spark.turbulenceSpeedMultiplier ??
    DEFAULT_TURBULENCE_SPEED_MULTIPLIER;
  if (!Number.isFinite(turbulenceMultiplier) || turbulenceMultiplier <= 0) {
    return simFail(
      simError(
        SIM_ERROR_CODES.scenarioInvalid,
        `The turbulence flame-speed multiplier must be strictly positive; it was ${String(turbulenceMultiplier)}.`,
        turbulenceMultiplier,
      ),
    );
  }
  const burnTravelS =
    geo.boreM / 2 / (turbulenceMultiplier * flameAtSpark.value.speedMPerS);
  const burnDurationRad = omegaRadPerS * burnTravelS;
  if (!Number.isFinite(burnDurationRad) || burnDurationRad <= 0) {
    return simFail(
      simError(
        SIM_ERROR_CODES.quantityInvalid,
        `The derived burn duration is not a positive finite angle (${String(burnDurationRad)} rad) — the flame-speed grounding refuses this scenario rather than fabricating a burn shape.`,
        burnDurationRad,
      ),
    );
  }
  const burn: BurnModel = {
    sparkAngleRad: sparkTheta,
    burnDurationRad,
    turbulenceSpeedMultiplier: turbulenceMultiplier,
    wiebe,
    flameSpeedMPerS: flameAtSpark.value.speedMPerS,
    groundedAt: { tK: sparkTK, pressureBar: sparkPBar },
    withinFitBand: flameAtSpark.value.withinFitBand,
  };

  // ---- The burned-zone equilibrium property table (the 68a solver,
  // one converged TP solve per node — "equilibrium properties").
  const tableTSteps = Math.max(
    8,
    Math.round(32 * (scenario.integration?.tableTSteps ?? 1)),
  );
  const tablePSteps = Math.max(
    4,
    Math.round(12 * (scenario.integration?.tablePSteps ?? 1)),
  );
  const table = buildBurnedEquilibriumTable({
    elementTotals: chargeState.elementTotals,
    basisMassKg: chargeState.basisMassKg,
    // The burned zone exists only past the spark and is always hot —
    // its coldest state is the EVO gas at ~1100 K+. The table floor
    // sits at 800 K: probed across the engine φ range (0.8–1.2) and
    // the full table pressure grid (0.8–160 bar) as the lowest band
    // where the 68a solver's TP march closes rich octane product
    // systems (below that, stationarity at the huge low-T equilibrium
    // constants stalls); the clamp is stated — and the energy
    // bookkeeping never depends on it (the march's state is the zone
    // energies, temperatures derived).
    tMinK: 800,
    tMaxK: 3600,
    tSteps: tableTSteps,
    pMinBar: 0.8,
    pMaxBar: 160,
    pSteps: tablePSteps,
  });
  if (!table.ok) return table;
  const tab = table.value;

  // ---- The fired two-zone march.
  const m = chargeState.massKg;
  let uUnburnedJPerKg = initialUJPerKg;
  let uBurnedTotalJ = 0;
  let burnedFraction = 0;
  let zones: ZoneState = {
    tUnburnedK: scenario.charge.intakeTK,
    tBurnedK: 0,
    pressureBar: scenario.charge.intakePressureBar,
  };
  const vd = displacementM3(geo);
  let workJ = 0;
  let wallHeatJ = 0;
  let knockIntegral = 0;
  let knockOnsetAngle: number | undefined;
  const historyTheta: number[] = [];
  const historyPressure: number[] = [];
  const historyUnburnedT: number[] = [];
  const historyBurnedT: number[] = [];
  const historyBurnedFraction: number[] = [];
  const historyTorque: number[] = [];
  const historyWallRate: number[] = [];
  const historyKnock: number[] = [];
  let peakPressureBar = 0;
  let peakPressureAngleDeg = -180;
  let peakBurnedT = 0;

  const record = (theta: number, wallRateW: number): void => {
    historyTheta.push((theta * 180) / Math.PI);
    historyPressure.push(zones.pressureBar);
    historyUnburnedT.push(zones.tUnburnedK);
    historyBurnedT.push(zones.tBurnedK);
    historyBurnedFraction.push(burnedFraction);
    historyTorque.push(
      zones.pressureBar * 1e5 * chamberVolumePerRad(geo, theta),
    );
    historyWallRate.push(wallRateW);
    historyKnock.push(knockIntegral);
    if (zones.pressureBar > peakPressureBar) {
      peakPressureBar = zones.pressureBar;
      peakPressureAngleDeg = (theta * 180) / Math.PI;
    }
    if (zones.tBurnedK > peakBurnedT) peakBurnedT = zones.tBurnedK;
  };

  record(-Math.PI, 0);
  for (let step = 0; step < steps; step += 1) {
    const theta = -Math.PI + dTheta * step;
    const nextTheta = -Math.PI + dTheta * (step + 1);
    const vPrev = chamberVolumeM3(geo, theta);
    const vNext = chamberVolumeM3(geo, nextTheta);
    const nextXb = wiebeBurnedFraction(burn, nextTheta);
    const dm = m * (nextXb - burnedFraction);
    if (dm < -1e-12) {
      return simFail(
        simError(
          SIM_ERROR_CODES.quantityInvalid,
          "The burned mass fraction regressed during the march — the Wiebe shape is non-monotone and the run declines rather than un-burning mass.",
          { step, burnedFraction, nextXb },
        ),
      );
    }
    const mUnburnedPrev = m * (1 - burnedFraction);
    const mUnburnedNext = m * (1 - nextXb);
    const mBurnedNext = m * nextXb;
    // Mass crossing zones carries the unburned zone's specific
    // internal energy — the chemical bookkeeping reclassifies, never
    // creates: the zone-energy sum's audit below is exact.
    const transferU = mUnburnedPrev > 0 ? uUnburnedJPerKg : 0;
    const uUnburnedTotalPrev = uUnburnedJPerKg * mUnburnedPrev;
    // Both zone bases are the STEP-START energies: every corrector
    // round recomputes the step's advance from the same bases, so the
    // final round's update is the single committed advance (a round
    // reading the previous round's output would subtract the step's
    // work and heat twice — the audit residual made that bug loud).
    const uBurnedTotalPrev = uBurnedTotalJ;
    const wallTempK =
      scenario.wallHeat.mode === "woschni"
        ? scenario.wallHeat.wallTemperatureK
        : 0;

    // Predictor-corrector rounds; the audit identity holds in every
    // round because the committed work/heat ARE the round's terms.
    let vUnburnedNext = vNext * Math.min(Math.max(1 - nextXb, 0), 1);
    let pressureFinal = zones.pressureBar;
    let wallRateFinal = 0;
    let tUnburnedNew = zones.tUnburnedK;
    let tBurnedNew = zones.tBurnedK;
    let commitWorkJ = 0;
    let commitHeatJ = 0;
    for (let round = 0; round < 3; round += 1) {
      const pMid = 0.5 * (zones.pressureBar + pressureFinal);
      // Zone work split through the volume fractions — the split sums
      // to the whole by construction (both rounds' ends partition V).
      const vUnburnedPrevApprox = vPrev * (1 - burnedFraction);
      const vBurnedPrevApprox = vPrev - vUnburnedPrevApprox;
      const vBurnedNext = vNext - vUnburnedNext;
      const wUnburned = pMid * 1e5 * (vUnburnedNext - vUnburnedPrevApprox);
      const wBurned = pMid * 1e5 * (vBurnedNext - vBurnedPrevApprox);
      let qUnburnedRate = 0;
      let qBurnedRate = 0;
      if (scenario.wallHeat.mode === "woschni") {
        const area = chamberWallAreaM2(geo, nextTheta);
        const gasVelocity =
          WOSCHNI_C1_CLOSED * meanPistonSpeed +
          (nextTheta >= sparkTheta
            ? WOSCHNI_C2_BURNING *
              ((vd * scenario.charge.intakeTK) /
                (scenario.charge.intakePressureBar * vBdc)) *
              (pMid - (motoredPressureBar[step + 1] ?? pMid))
            : 0);
        const h = woschniHeatTransferCoefficientWPerM2K({
          boreM: geo.boreM,
          pressureBar: pMid,
          gasTK:
            m > 0
              ? (mUnburnedNext * tUnburnedNew + mBurnedNext * tBurnedNew) / m
              : (tUnburnedNew + tBurnedNew) / 2,
          gasVelocityMPerS: gasVelocity,
        });
        // Zone split of the wetted area by volume fraction — the
        // coarse standard two-zone split, stated.
        const fUnburned =
          vNext > 0 ? Math.min(Math.max(vUnburnedNext / vNext, 0), 1) : 0;
        qUnburnedRate = h * area * fUnburned * (tUnburnedNew - wallTempK);
        qBurnedRate = h * area * (1 - fUnburned) * (tBurnedNew - wallTempK);
      }
      const uUnburnedTotalNext =
        uUnburnedTotalPrev - wUnburned - qUnburnedRate * dt - transferU * dm;
      const uBurnedTotalNext =
        uBurnedTotalPrev - wBurned - qBurnedRate * dt + transferU * dm;
      const solved = solveZones({
        unburned: chargeState.unburned,
        table: tab,
        mUnburnedKg: mUnburnedNext,
        mBurnedKg: mBurnedNext,
        uUnburnedJPerKg:
          mUnburnedNext > 0 ? uUnburnedTotalNext / mUnburnedNext : 0,
        uBurnedJPerKg: mBurnedNext > 0 ? uBurnedTotalNext / mBurnedNext : 0,
        volumeM3: vNext,
        seed: zones,
      });
      tUnburnedNew = solved.tUnburnedK;
      tBurnedNew = solved.tBurnedK;
      pressureFinal = solved.pressureBar;
      wallRateFinal = qUnburnedRate + qBurnedRate;
      vUnburnedNext =
        mUnburnedNext > 0
          ? (mUnburnedNext *
              chargeState.unburned.gasConstantJPerKgK *
              tUnburnedNew) /
            (pressureFinal * 1e5)
          : 0;
      uUnburnedJPerKg =
        mUnburnedNext > 0 ? uUnburnedTotalNext / mUnburnedNext : 0;
      uBurnedTotalJ = uBurnedTotalNext;
      commitWorkJ = pMid * 1e5 * (vNext - vPrev);
      commitHeatJ = wallRateFinal * dt;
    }
    // Commit: the round's p̄ and Q̇ ARE the step's bookkeeping — the
    // audit identity holds on exactly these accumulators.
    workJ += commitWorkJ;
    wallHeatJ += commitHeatJ;
    burnedFraction = nextXb;
    zones = {
      tUnburnedK: tUnburnedNew,
      tBurnedK: tBurnedNew,
      pressureBar: pressureFinal,
    };

    // Livengood–Wu over the unburned zone with the reactor's own
    // induction definition (one-step Arrhenius ignition delay — the
    // shared, stated source): dI = dt/τ(T_u, p).
    if (mUnburnedNext > 1e-9 * m) {
      const delay = ignitionDelaySeconds({
        fuel: scenario.fuel,
        equivalenceRatio: scenario.charge.equivalenceRatio,
        temperatureK: zones.tUnburnedK,
        pressureBar: zones.pressureBar,
      });
      if (!delay.ok) return delay;
      knockIntegral += dt / delay.value.ignitionDelayS;
      if (knockOnsetAngle === undefined && knockIntegral >= 1) {
        knockOnsetAngle = (nextTheta * 180) / Math.PI;
      }
    }
    record(nextTheta, wallRateFinal);
  }

  // ---- Projections: indicated, brake, audit, knock.
  const imepPa = workJ / vd;
  const fuelEnergyJ = chargeState.fuelMassKg * lhv.value;
  const friction = scenario.friction ?? CHEN_FLYNN_DEFAULT;
  const fmepBar = chenFlynnFmepBar(friction, peakPressureBar, meanPistonSpeed);
  const fmepPa = fmepBar * 1e5;
  const pmepPa = friction.pumpingMepBar * 1e5;
  const frictionWorkJ = (fmepPa + pmepPa) * vd;
  const brakeWorkJ = workJ - frictionWorkJ;
  const cyclesPerSecond = scenario.speedRpm / 120;
  const finalUJ = uUnburnedJPerKg * m * (1 - burnedFraction) + uBurnedTotalJ;
  const fuelChemicalJ =
    (chargeState.uReactants298JPerKg - chargeState.uProducts298JPerKg) * m;
  const intakeSensibleJ =
    (initialUJPerKg - chargeState.uReactants298JPerKg) * m;
  const exhaustEnthalpyJ = finalUJ - chargeState.uProducts298JPerKg * m;

  return simOk({
    fuel: scenario.fuel,
    speedRpm: scenario.speedRpm,
    geometry: geo,
    compressionRatio: compressionRatioOf(geo),
    charge: scenario.charge,
    history: {
      columns: [
        { name: "crank-angle", unit: "deg", samples: historyTheta },
        { name: "pressure", unit: "bar", samples: historyPressure },
        {
          name: "pressure-motored",
          unit: "bar",
          samples: motoredPressureBar.slice(0, historyTheta.length),
        },
        { name: "unburned-temperature", unit: "K", samples: historyUnburnedT },
        { name: "burned-temperature", unit: "K", samples: historyBurnedT },
        {
          name: "burned-mass-fraction",
          unit: "-",
          samples: historyBurnedFraction,
        },
        { name: "gas-torque", unit: "N·m", samples: historyTorque },
        { name: "wall-heat-rate", unit: "W", samples: historyWallRate },
        { name: "knock-integral", unit: "-", samples: historyKnock },
      ],
    },
    burn,
    indicated: {
      workJ,
      imepPa,
      thermalEfficiency: fuelEnergyJ > 0 ? workJ / fuelEnergyJ : 0,
      fuelMassKg: chargeState.fuelMassKg,
      lhvJPerKg: lhv.value,
      fuelEnergyJ,
    },
    brake: {
      fmepPa,
      pmepPa,
      bmepPa: brakeWorkJ / vd,
      torqueNPerM: brakeWorkJ / (4 * Math.PI),
      powerW: brakeWorkJ * cyclesPerSecond,
      thermalEfficiency: fuelEnergyJ > 0 ? brakeWorkJ / fuelEnergyJ : 0,
      frictionWorkJ,
    },
    audit: {
      wallHeatJ,
      frictionWorkJ,
      exhaustEnthalpyJ,
      intakeSensibleJ,
      fuelChemicalJ,
      residualJ:
        fuelChemicalJ -
        (brakeWorkJ +
          frictionWorkJ +
          wallHeatJ +
          exhaustEnthalpyJ -
          intakeSensibleJ),
    },
    knock: {
      integralMax: knockIntegral,
      onsetAngleDeg: knockOnsetAngle,
    },
    peak: {
      pressureBar: peakPressureBar,
      pressureAngleDeg: peakPressureAngleDeg,
      burnedTemperatureK: peakBurnedT,
    },
    motored: {
      imepPa: motoredWorkJ / vd,
      peakPressureBar: motoredPressureBar.reduce((p, q) => Math.max(p, q), 0),
      peakTemperatureK: motoredTK.reduce((p, q) => Math.max(p, q), 0),
    },
  });
}
