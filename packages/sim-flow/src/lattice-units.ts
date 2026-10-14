/**
 * The lattice unit system (Phase 63a, law S4): the solver runs honest SI
 * at its doors and lattice units in its core, with EVERY conversion
 * factor derived once, here, deterministically — never sprinkled through
 * the kernel. The compiled scenario already did document → solver (mm →
 * SI) at sim-core's boundary; this module does the solver's own SI ↔
 * lattice leg and nothing else.
 *
 * ## The unit closure (2D, per unit depth)
 *
 * - `dx = cellSizeM` — one lattice spacing is exactly one voxel-grid
 *   cell (`./occupancy`).
 * - The caller picks the characteristic LATTICE velocity u_lat
 *   (default 0.05, clamped ≤ 0.2): the low-Mach honesty knob, since the
 *   D2Q9 equilibrium's O(Ma²) compressibility error scales with it and
 *   the stability ceiling sits near u_lat ~ 0.3.
 * - `dt = u_lat · dx / u_char` — fixes the velocity ratio, so
 *   u_lattice = u_SI · dt/dx exactly for the characteristic speed.
 * - `ν_lat = ν_SI · dt / dx²` and `τ⁺ = 3·ν_lat + ½` (from
 *   ν = c_s²(τ − ½), c_s² = 1/3) — the physical relaxation.
 * - Reynolds is invariant under the closure: Re = u_char·L/ν_SI =
 *   u_lat·L_lat/ν_lat, so the lattice reproduces the scenario's regime
 *   exactly, which is the whole point of the conversion.
 *
 * ## Output factors (lattice → SI)
 *
 * - velocity: u_SI = u_lat · dx/dt;
 * - pressure: p = p_ref + (ρ_lat − 1)·ρ₀·dx²/(3·dt²) — the lattice
 *   density is stored as ρ/ρ₀, so ρ_lat = 1 is the reference state and
 *   the outlet's ambient;
 * - density: ρ_SI = ρ_lat · ρ₀;
 * - force per unit depth: F_SI = impulse_lat · ρ₀·dx³/dt² — one lattice
 *   population unit of momentum is ρ₀·dx² per depth, one lattice
 *   velocity is dx/dt, and a per-step impulse becomes a force over dt.
 *
 * Every factor is a pure arithmetic product of the inputs — the module
 * holds no state, so determinism is structural (law S2).
 */

import {
  type SimError,
  SIM_ERROR_CODES,
  simError,
  type SimParseResult,
  simFail,
  simOk,
} from "@slopcad/sim-core";

import { D2Q9_CS2 } from "./d2q9";

/**
 * The default characteristic lattice velocity — conservative for the
 * D2Q9 low-Mach regime (Ma_lat = u_lat/√c_s² ≈ 0.087).
 */
export const LBM_DEFAULT_LATTICE_VELOCITY = 0.05;

/** The ceiling on the characteristic lattice velocity (stability honesty). */
export const LBM_MAX_LATTICE_VELOCITY = 0.2;

/**
 * The relaxation-time stability band the reference kernel accepts for
 * τ⁺: strictly above the ν = 0 limit of ½ (BGK's odd-even resonance) and
 * below 2, past which BGK's shear modes ring themselves apart. TRT
 * (`./relaxation`) earns its keep near both ends.
 */
export const LBM_TAU_PLUS_MIN = 0.5 + 1e-4;
export const LBM_TAU_PLUS_MAX = 2;

/** What {@link lbmUnitSystem} consumes: the SI quartet plus the knob. */
export interface LbmUnitSystemInputs {
  /** The voxel-grid cell size, m — the lattice spacing (> 0). */
  readonly cellSizeM: number;
  /** The characteristic SI velocity, m/s (> 0): the inlet or free-stream speed. */
  readonly characteristicVelocityMPerS: number;
  /** The fluid's kinematic viscosity, m²/s (> 0) — from the compiled fluid state. */
  readonly kinematicViscosityM2PerS: number;
  /** The reference density, kg/m³ (> 0) — ρ₀ of the compiled fluid state. */
  readonly referenceDensityKgPerM3: number;
  /** The characteristic lattice velocity (default {@link LBM_DEFAULT_LATTICE_VELOCITY}). */
  readonly latticeVelocity?: number;
}

/** The derived unit closure: the lattice parameters and every SI factor. */
export interface LbmUnitSystem {
  /** The lattice spacing, m (the input cell size). */
  readonly cellSizeM: number;
  /** The lattice time step, s. */
  readonly timeStepS: number;
  /** The characteristic lattice velocity. */
  readonly latticeVelocity: number;
  /** The lattice viscosity ν_lat (dimensionless in lattice units). */
  readonly latticeViscosity: number;
  /** The physical relaxation time τ⁺ = 3·ν_lat + ½. */
  readonly tauPlus: number;
  /** The lattice Mach number of the characteristic velocity (honesty field). */
  readonly latticeMach: number;
  /** Lattice → SI: multiply a lattice velocity by this (dx/dt, m/s). */
  readonly velocityFactor: number;
  /** Lattice → SI: multiply (ρ_lat − 1) by this and add p_ref to get Pa. */
  readonly pressureFactorPa: number;
  /** Lattice → SI: multiply a lattice density by this to get kg/m³. */
  readonly densityFactor: number;
  /** Lattice → SI: multiply a per-step lattice impulse by this for N per metre. */
  readonly forcePerDepthFactor: number;
}

/**
 * Builds the unit closure from the SI quartet, refusing the inputs a
 * honest kernel cannot run: non-finite or non-positive scales, a lattice
 * velocity outside (0, 0.2], or a τ⁺ outside the stability band (with
 * the fix named in the decline — the lattice velocity knob that moves
 * τ⁺ in the right direction, since τ⁺ grows with u_lat).
 */
export function lbmUnitSystem(
  inputs: LbmUnitSystemInputs,
): SimParseResult<LbmUnitSystem, SimError> {
  const refuse = (
    message: string,
    at: unknown,
  ): SimParseResult<never, SimError> =>
    simFail(simError(SIM_ERROR_CODES.scenarioInvalid, message, at));
  const positive = (value: number, what: string): string | undefined =>
    typeof value !== "number" || !Number.isFinite(value) || value <= 0
      ? `${what} must be a positive finite number.`
      : undefined;
  for (const [value, what] of [
    [inputs.cellSizeM, "The lattice cell size (m)"],
    [inputs.characteristicVelocityMPerS, "The characteristic velocity (m/s)"],
    [inputs.kinematicViscosityM2PerS, "The kinematic viscosity (m²/s)"],
    [inputs.referenceDensityKgPerM3, "The reference density (kg/m³)"],
  ] as const) {
    const problem = positive(value, what);
    if (problem !== undefined) return refuse(problem, value);
  }
  const latticeVelocity =
    inputs.latticeVelocity ?? LBM_DEFAULT_LATTICE_VELOCITY;
  if (
    typeof latticeVelocity !== "number" ||
    !Number.isFinite(latticeVelocity) ||
    latticeVelocity <= 0 ||
    latticeVelocity > LBM_MAX_LATTICE_VELOCITY
  ) {
    return refuse(
      `The characteristic lattice velocity must lie in (0, ${String(LBM_MAX_LATTICE_VELOCITY)}], received ${String(latticeVelocity)}.`,
      latticeVelocity,
    );
  }
  const dx = inputs.cellSizeM;
  const dt = (latticeVelocity * dx) / inputs.characteristicVelocityMPerS;
  const latticeViscosity = (inputs.kinematicViscosityM2PerS * dt) / (dx * dx);
  const tauPlus = 3 * latticeViscosity + 0.5;
  if (tauPlus <= LBM_TAU_PLUS_MIN) {
    return refuse(
      `The physical relaxation time τ⁺ = ${tauPlus.toPrecision(6)} is at or below the ν→0 stability floor ${String(LBM_TAU_PLUS_MIN)}: the viscosity is too small for this cell size at lattice velocity ${String(latticeVelocity)}. Lower the lattice velocity (a smaller u_lat grows dt and with it ν_lat) or coarsen the grid.`,
      tauPlus,
    );
  }
  if (tauPlus >= LBM_TAU_PLUS_MAX) {
    return refuse(
      `The physical relaxation time τ⁺ = ${tauPlus.toPrecision(6)} is at or above the stability ceiling ${String(LBM_TAU_PLUS_MAX)}: the viscosity is too large for this cell size at lattice velocity ${String(latticeVelocity)}. Raise the lattice velocity or refine the grid.`,
      tauPlus,
    );
  }
  return simOk(
    Object.freeze({
      cellSizeM: dx,
      timeStepS: dt,
      latticeVelocity,
      latticeViscosity,
      tauPlus,
      latticeMach: latticeVelocity / Math.sqrt(D2Q9_CS2),
      velocityFactor: dx / dt,
      pressureFactorPa:
        (inputs.referenceDensityKgPerM3 * dx * dx) / (3 * dt * dt),
      densityFactor: inputs.referenceDensityKgPerM3,
      forcePerDepthFactor:
        (inputs.referenceDensityKgPerM3 * dx * dx * dx) / (dt * dt),
    }),
  );
}
