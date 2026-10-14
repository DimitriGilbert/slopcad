/**
 * The 3D lattice unit system (Phase 66a, law S4): the SI ↔ lattice leg
 * for the D3Q19 kernel. The closure is dimension-independent — dx, dt,
 * ν_lat, τ⁺, the low-Mach knob, and every output factor except the
 * force factor are the 2D module's own (`./lattice-units`), so this
 * module DERIVES from that one instead of duplicating it (one source
 * of truth; the shared closure moves only if both callers move). The
 * one 3D difference is the force factor:
 *
 * - force: F_SI = impulse_lat · ρ₀·dx⁴/dt² — one lattice population
 *   unit of momentum is ρ₀·dx³ (one cell's mass in 3D), one lattice
 *   velocity is dx/dt, and a per-step impulse becomes a force over dt.
 *   The 2D module's per-depth ρ₀·dx³/dt² does not apply: a 3D force is
 *   newtons, not newtons per metre.
 */

import type { SimError, SimParseResult } from "@slopcad/sim-core";

import {
  type LbmUnitSystem,
  type LbmUnitSystemInputs,
  lbmUnitSystem,
} from "./lattice-units";

/**
 * The 3D unit closure: the shared 2D facts with the force factor
 * replaced by the volumetric one (the per-depth factor dropped — it is
 * meaningless in 3D and carrying it would invite the wrong conversion).
 */
export type Lbm3dUnitSystem = Omit<LbmUnitSystem, "forcePerDepthFactor"> & {
  /** Lattice → SI: multiply a per-step lattice impulse by this for N. */
  readonly forceFactor: number;
};

/**
 * Builds the 3D unit closure — every input refusal is the shared
 * closure's own (same messages, same knobs), with the 3D force factor
 * derived alongside.
 */
export function lbm3dUnitSystem(
  inputs: LbmUnitSystemInputs,
): SimParseResult<Lbm3dUnitSystem, SimError> {
  const shared = lbmUnitSystem(inputs);
  if (!shared.ok) return shared;
  const units = shared.value;
  const dx = units.cellSizeM;
  const dt = units.timeStepS;
  return {
    ok: true,
    value: Object.freeze({
      cellSizeM: units.cellSizeM,
      timeStepS: units.timeStepS,
      latticeVelocity: units.latticeVelocity,
      latticeViscosity: units.latticeViscosity,
      tauPlus: units.tauPlus,
      latticeMach: units.latticeMach,
      velocityFactor: units.velocityFactor,
      pressureFactorPa: units.pressureFactorPa,
      densityFactor: units.densityFactor,
      forceFactor:
        (inputs.referenceDensityKgPerM3 * dx * dx * dx * dx) / (dt * dt),
    }),
  };
}
