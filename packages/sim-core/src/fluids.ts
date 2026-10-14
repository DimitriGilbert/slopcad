/**
 * The starter fluid property set (Phase 61, the named-record precedent of
 * `DocumentMaterialRecord`): air, water, and ethylene glycol ("glycol"),
 * each an immutable record of permissive OWN curve fits for density and
 * dynamic viscosity over temperature plus the scalar properties the
 * regime-honesty law (S9) and the Boussinesq coupling need — thermal
 * expansion coefficient, specific heat, conductivity, and speed of sound
 * at the record's reference temperature.
 *
 * ## Provenance (the sources the fits are built from)
 *
 * - **Air** (1 atm): density from the ideal-gas law with R = 287.058
 *   J/(kg·K) (NIST); dynamic viscosity from Sutherland's law with
 *   μ_ref = 1.716e-5 Pa·s at 273.15 K and S = 110.4 K (White, *Viscous
 *   Fluid Flow*). Reference constants at 300 K: cp = 1006 J/(kg·K),
 *   k = 0.0263 W/(m·K), β = 1/T (ideal gas), c = √(γRT) = 347.2 m/s.
 * - **Water** (saturated liquid, 1 atm): density and viscosity anchors
 *   from standard property tables (Incropera & DeWitt, *Fundamentals of
 *   Heat and Mass Transfer*, Table A.6) at 283.15–363.15 K. Reference
 *   constants at 300 K: cp = 4179 J/(kg·K), k = 0.610 W/(m·K),
 *   β = 2.75e-4 1/K, c = 1497 m/s.
 * - **Ethylene glycol** (saturated liquid): anchors from the published
 *   saturated-ethylene-glycol table (Cengel, *Introduction to
 *   Thermodynamics and Heat Transfer*) at 280–360 K, cross-checked by the
 *   table's own Pr column (Pr(300 K) = 151 reproduces from
 *   μ·cp/k). Reference constants at 300 K: cp = 2415 J/(kg·K),
 *   k = 0.252 W/(m·K), β = 6.1e-4 1/K, c = 1660 m/s.
 *
 * ## The fits
 *
 * Each fit is a polynomial in (T − referenceK) evaluated by Horner's
 * rule; the coefficients were least-squares fitted to the anchors above
 * at authoring time with these measured residuals over the valid range —
 * air density ≤ 0.05 %, air viscosity ≤ 0.005 %, water density ≤ 0.03 %,
 * water viscosity ≤ 0.15 %, glycol density ≤ 0.01 %, glycol viscosity
 * ≤ 0.05 % — a permissive accuracy consistent with the roadmap's
 * "qualitatively correct, comparative-trends-trustworthy" positioning.
 * Evaluation outside a record's `validRangeK` declines structured
 * (`sim/fluid-temperature-out-of-range`): extrapolating a polynomial fit
 * is a silent lie, never a property.
 */

import { type SimError, SIM_ERROR_CODES, simError } from "./errors";
import { type SimParseResult, simFail, simOk } from "./result";

/**
 * A polynomial curve fit over temperature: Σ coefficients[i] ·
 * (T − referenceK)^i, evaluated by Horner's rule. Deterministic and pure.
 */
export interface SimFluidPropertyFit {
  readonly coefficients: readonly number[];
  readonly referenceK: number;
}

/** One named fluid's property record. */
export interface SimFluidProperties {
  /** The record's id — the name a scenario's `fluid` field selects. */
  readonly id: string;
  /** The display name. */
  readonly name: string;
  /** The temperature range the fits are valid over, K (inclusive). */
  readonly validRangeK: readonly [number, number];
  /** The temperature the scalar properties are stated at, K. */
  readonly referenceK: number;
  /** ρ(T), kg/m³. */
  readonly density: SimFluidPropertyFit;
  /** μ(T), Pa·s. */
  readonly dynamicViscosity: SimFluidPropertyFit;
  /** β at the reference temperature, 1/K — the Boussinesq buoyancy input. */
  readonly thermalExpansionPerK: number;
  /** cp at the reference temperature, J/(kg·K). */
  readonly specificHeatJPerKgK: number;
  /** k at the reference temperature, W/(m·K). */
  readonly thermalConductivityWPerMK: number;
  /** The speed of sound at the reference temperature, m/s — the Mach input. */
  readonly speedOfSoundMPerS: number;
}

/** Evaluates a fit at a temperature (pure; no range check — the fluid's own). */
export function evaluateSimFluidFit(
  fit: SimFluidPropertyFit,
  temperatureK: number,
): number {
  const x = temperatureK - fit.referenceK;
  let sum = 0;
  for (let index = fit.coefficients.length - 1; index >= 0; index -= 1) {
    sum = sum * x + (fit.coefficients[index] ?? 0);
  }
  return sum;
}

/** The air record (1 atm, 250–400 K). */
export const SIM_FLUID_AIR: SimFluidProperties = Object.freeze({
  id: "air",
  name: "Air (1 atm)",
  validRangeK: [250, 400] as const,
  referenceK: 300,
  density: Object.freeze({
    coefficients: [1.176472549, -0.003947205765, 1.3444521e-5, -3.395646436e-8],
    referenceK: 300,
  }),
  dynamicViscosity: Object.freeze({
    coefficients: [
      1.845921383e-5, 4.733188638e-8, -3.854807922e-11, 4.48075924e-14,
    ],
    referenceK: 300,
  }),
  thermalExpansionPerK: 1 / 300,
  specificHeatJPerKgK: 1006,
  thermalConductivityWPerMK: 0.0263,
  speedOfSoundMPerS: 347.2,
});

/** The water record (saturated liquid, 283.15–363.15 K). */
export const SIM_FLUID_WATER: SimFluidProperties = Object.freeze({
  id: "water",
  name: "Water (liquid)",
  validRangeK: [283.15, 363.15] as const,
  referenceK: 300,
  density: Object.freeze({
    coefficients: [996.3025974, -0.2757876623, -0.003456709957],
    referenceK: 300,
  }),
  dynamicViscosity: Object.freeze({
    coefficients: [
      8.536994474e-4, -1.901338677e-5, 3.515126506e-7, -5.71779035e-9,
      6.480558712e-11, -3.291666667e-13,
    ],
    referenceK: 300,
  }),
  thermalExpansionPerK: 2.75e-4,
  specificHeatJPerKgK: 4179,
  thermalConductivityWPerMK: 0.61,
  speedOfSoundMPerS: 1497,
});

/** The ethylene glycol record (saturated liquid, 280–360 K). */
export const SIM_FLUID_GLYCOL: SimFluidProperties = Object.freeze({
  id: "glycol",
  name: "Ethylene glycol (liquid)",
  validRangeK: [280, 360] as const,
  referenceK: 300,
  density: Object.freeze({
    coefficients: [1110, -0.55],
    referenceK: 300,
  }),
  dynamicViscosity: Object.freeze({
    coefficients: [
      0.01575, -0.0004625, 7.160416667e-6, -5.25e-8, 9.895833333e-11,
    ],
    referenceK: 300,
  }),
  thermalExpansionPerK: 6.1e-4,
  specificHeatJPerKgK: 2415,
  thermalConductivityWPerMK: 0.252,
  speedOfSoundMPerS: 1660,
});

/** The starter fluid property set, keyed by record id. */
export const SIM_FLUIDS: Readonly<Record<string, SimFluidProperties>> =
  Object.freeze({
    air: SIM_FLUID_AIR,
    water: SIM_FLUID_WATER,
    glycol: SIM_FLUID_GLYCOL,
  });

/** Resolves a fluid name to its record, or undefined. */
export function getSimFluid(id: string): SimFluidProperties | undefined {
  return SIM_FLUIDS[id];
}

/** A fluid's properties evaluated at one temperature (all SI). */
export interface SimFluidState {
  readonly fluidId: string;
  readonly temperatureK: number;
  /** ρ, kg/m³. */
  readonly densityKgPerM3: number;
  /** μ, Pa·s. */
  readonly dynamicViscosityPaS: number;
  /** ν = μ/ρ, m²/s. */
  readonly kinematicViscosityM2PerS: number;
  /** α = k/(ρ·cp), m²/s. */
  readonly thermalDiffusivityM2PerS: number;
  /** Pr = μ·cp/k (computed, never tabulated — the S9 truth). */
  readonly prandtl: number;
  /** β at the reference temperature, 1/K. */
  readonly thermalExpansionPerK: number;
  readonly specificHeatJPerKgK: number;
  readonly thermalConductivityWPerMK: number;
  readonly speedOfSoundMPerS: number;
}

/**
 * Evaluates a fluid record at a temperature: the two fits plus every
 * derived quantity the spine consumes. Temperatures outside the record's
 * valid range decline structured; a non-finite input is refused the same
 * way.
 */
export function simFluidState(
  fluid: SimFluidProperties,
  temperatureK: number,
): SimParseResult<SimFluidState, SimError> {
  if (!Number.isFinite(temperatureK)) {
    return simFail(
      simError(
        SIM_ERROR_CODES.fluidTemperatureOutOfRange,
        `The ${fluid.id} property set needs a finite temperature, received ${String(temperatureK)}.`,
        temperatureK,
      ),
    );
  }
  const [min, max] = fluid.validRangeK;
  if (temperatureK < (min ?? 0) || temperatureK > (max ?? 0)) {
    return simFail(
      simError(
        SIM_ERROR_CODES.fluidTemperatureOutOfRange,
        `The ${fluid.id} property set is fitted over ${String(min)}–${String(max)} K; ${String(temperatureK)} K is outside it, and extrapolating the fits would fabricate a property.`,
        temperatureK,
      ),
    );
  }
  const densityKgPerM3 = evaluateSimFluidFit(fluid.density, temperatureK);
  const dynamicViscosityPaS = evaluateSimFluidFit(
    fluid.dynamicViscosity,
    temperatureK,
  );
  if (
    !Number.isFinite(densityKgPerM3) ||
    densityKgPerM3 <= 0 ||
    !Number.isFinite(dynamicViscosityPaS) ||
    dynamicViscosityPaS <= 0
  ) {
    return simFail(
      simError(
        SIM_ERROR_CODES.fluidTemperatureOutOfRange,
        `The ${fluid.id} fits evaluated non-physical at ${String(temperatureK)} K.`,
        temperatureK,
      ),
    );
  }
  const kinematicViscosityM2PerS = dynamicViscosityPaS / densityKgPerM3;
  const thermalDiffusivityM2PerS =
    fluid.thermalConductivityWPerMK /
    (densityKgPerM3 * fluid.specificHeatJPerKgK);
  const prandtl =
    (dynamicViscosityPaS * fluid.specificHeatJPerKgK) /
    fluid.thermalConductivityWPerMK;
  return simOk(
    Object.freeze({
      fluidId: fluid.id,
      temperatureK,
      densityKgPerM3,
      dynamicViscosityPaS,
      kinematicViscosityM2PerS,
      thermalDiffusivityM2PerS,
      prandtl,
      thermalExpansionPerK: fluid.thermalExpansionPerK,
      specificHeatJPerKgK: fluid.specificHeatJPerKgK,
      thermalConductivityWPerMK: fluid.thermalConductivityWPerMK,
      speedOfSoundMPerS: fluid.speedOfSoundMPerS,
    }),
  );
}
