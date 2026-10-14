/**
 * Regime honesty (law S9): every run reports the dimensionless numbers
 * that gate its validity — Re, Ma, Pr, Ra as applicable per domain —
 * computed from scenario inputs and fluid properties at compile time and
 * carried on the result summary. The thresholds that raise the
 * qualitative flags are ADVISORY honesty markers, never acceptance
 * certificates (the roadmap's S16 risk): each is published here with its
 * source, and a flagged run proceeds — flagged, not declined.
 */

/** The qualitative honesty flags a run can carry. */
export const SIM_QUALITATIVE_FLAGS = [
  "turbulence-dominated",
  "compressibility-affected",
  "buoyancy-driven",
  /**
   * A fan run whose tip-dynamic Reynolds number sits below the fan
   * literature's data regime (Phase 66's S9 guidance line,
   * `@slopcad/sim-flow`'s `FAN_LOW_REYNOLDS_ADVISORY`): the curve's
   * shape is qualitative there — the numbers are still reported, the
   * run still proceeds.
   */
  "low-reynolds-fan",
] as const;

export type SimQualitativeFlag = (typeof SIM_QUALITATIVE_FLAGS)[number];

/**
 * The advisory regime thresholds. Advisory in both directions: a run just
 * under a threshold is not "safe", and a run just over it is not wrong —
 * the flags exist so the result summary states its own limits.
 */
export const SIM_REGIME_THRESHOLDS = Object.freeze({
  /**
   * Reynolds numbers above this are flagged turbulence-dominated: the
   * classic internal-flow turbulent onset (Re ≈ 2300 transition band,
   * Re ≈ 4000 fully turbulent — Pope, *Turbulent Flows*). With no-RANS
   * standing, resolved unsteady runs answer turbulence by time-averaging
   * post-hoc, and the flag states that this is the expected regime.
   */
  turbulentReynolds: 4000,
  /**
   * Mach numbers above this are flagged compressibility-affected: the
   * standard aerodynamics rule of thumb (Ma > 0.3, ~5 % density change).
   */
  compressibleMach: 0.3,
  /**
   * Rayleigh numbers above this are flagged buoyancy-driven (turbulent
   * natural-convection onset, Incropera & DeWitt Table 9.1's Ra ≈ 1e9
   * band): the Boussinesq approximation's own honesty band.
   */
  buoyantRayleigh: 1e9,
});

/** The S9 report: the dimensionless numbers plus the honesty flags. */
export interface SimRegimeReport {
  /** ρ·V·L/μ — present for flow and thermal scenarios with a velocity scale. */
  readonly reynolds?: number;
  /** V/c — present for flow and thermal scenarios with a velocity scale. */
  readonly mach?: number;
  /** μ·cp/k — present whenever a fluid state was evaluated. */
  readonly prandtl?: number;
  /**
   * g·β·ΔT·L³/(ν·α) — present for thermal scenarios with a temperature
   * difference scale (the buoyancy gate).
   */
  readonly rayleigh?: number;
  /** The advisory honesty flags (never empty-blocking; the run proceeds). */
  readonly qualitative: readonly SimQualitativeFlag[];
}

/** Reynolds number, Re = ρ·V·L/μ. */
export function simReynolds(
  densityKgPerM3: number,
  speedMPerS: number,
  lengthM: number,
  dynamicViscosityPaS: number,
): number {
  return (densityKgPerM3 * speedMPerS * lengthM) / dynamicViscosityPaS;
}

/** Mach number, Ma = V/c. */
export function simMach(speedMPerS: number, speedOfSoundMPerS: number): number {
  return speedMPerS / speedOfSoundMPerS;
}

/** Prandtl number, Pr = μ·cp/k. */
export function simPrandtl(
  dynamicViscosityPaS: number,
  specificHeatJPerKgK: number,
  thermalConductivityWPerMK: number,
): number {
  return (
    (dynamicViscosityPaS * specificHeatJPerKgK) / thermalConductivityWPerMK
  );
}

/**
 * Rayleigh number, Ra = g·β·ΔT·L³/(ν·α) — the buoyancy gate for thermal
 * scenarios (Boussinesq's honesty band).
 */
export function simRayleigh(
  gravityMagnitudeMPerS2: number,
  thermalExpansionPerK: number,
  deltaTemperatureK: number,
  lengthM: number,
  kinematicViscosityM2PerS: number,
  thermalDiffusivityM2PerS: number,
): number {
  return (
    (gravityMagnitudeMPerS2 *
      thermalExpansionPerK *
      Math.abs(deltaTemperatureK) *
      lengthM *
      lengthM *
      lengthM) /
    (kinematicViscosityM2PerS * thermalDiffusivityM2PerS)
  );
}

/** The numbers the compile boundary computed, pre-flagging. */
export interface SimRegimeInputs {
  readonly reynolds?: number;
  readonly mach?: number;
  readonly prandtl?: number;
  readonly rayleigh?: number;
}

/**
 * Builds the S9 report from the computed dimensionless numbers: every
 * advisory threshold the numbers cross raises its flag. Deterministic
 * and pure — identical inputs produce the identical frozen report.
 */
export function simRegimeReport(inputs: SimRegimeInputs): SimRegimeReport {
  const qualitative: SimQualitativeFlag[] = [];
  if (
    inputs.reynolds !== undefined &&
    inputs.reynolds > SIM_REGIME_THRESHOLDS.turbulentReynolds
  ) {
    qualitative.push("turbulence-dominated");
  }
  if (
    inputs.mach !== undefined &&
    inputs.mach > SIM_REGIME_THRESHOLDS.compressibleMach
  ) {
    qualitative.push("compressibility-affected");
  }
  if (
    inputs.rayleigh !== undefined &&
    inputs.rayleigh > SIM_REGIME_THRESHOLDS.buoyantRayleigh
  ) {
    qualitative.push("buoyancy-driven");
  }
  return Object.freeze({
    ...(inputs.reynolds === undefined ? {} : { reynolds: inputs.reynolds }),
    ...(inputs.mach === undefined ? {} : { mach: inputs.mach }),
    ...(inputs.prandtl === undefined ? {} : { prandtl: inputs.prandtl }),
    ...(inputs.rayleigh === undefined ? {} : { rayleigh: inputs.rayleigh }),
    qualitative: Object.freeze(qualitative),
  });
}
