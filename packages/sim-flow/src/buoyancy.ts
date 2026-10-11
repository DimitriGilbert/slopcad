/**
 * The Boussinesq buoyancy force (Phase 65b, the CHT coupling's driving
 * term — "the stove's physical driver"): the density perturbation is
 * NEVER carried as a second fluid; it enters exactly once, as the body
 * force of the Boussinesq momentum equation
 *
 *   ρ₀(∂u/∂t + u·∇u) = −∇p + μ∇²u − ρ₀·β·(T − T_ref)·g,
 *
 * where the hydrostatic ρ₀·g leg was absorbed into the pressure
 * reference (the standard Boussinesq bookkeeping), leaving the
 * sign-carrying statement a child can check: hot (T > T_ref) against
 * g = (0, −9.81) pushes UP. The inputs are the Phase 61 spine's — the
 * scenario gravity vector and the fluid record's thermal-expansion
 * coefficient β — consumed here at their SI door (law S4).
 *
 * ## The lattice conversion (stated once, the `./lattice-units`
 * precedent)
 *
 * The force is applied per node in LATTICE momentum units per step.
 * One lattice population unit of momentum per unit depth is ρ₀·dx²
 * (one unit of Σf·c at lattice density ρ = 1 carries ρ₀·dx²·(dx/dt)
 * kg·m/s per metre — the `forcePerDepthFactor` derivation), and the
 * Boussinesq force per volume b = −ρ₀·β·(T − T_ref)·g integrates over
 * one cell's dx² · 1 m of depth and one dt of time, giving
 *
 *   F_lat = b·dx²·dt / (ρ₀·dx³/dt) = −β·(T − T_ref)·g·dt²/dx,
 *
 * independent of ρ₀ (the Boussinesq force acts on the reference
 * density; the lattice stores ρ/ρ₀). The Guo collision forcing
 * (`./relaxation`) consumes this field verbatim, and the per-step
 * momentum ledger books its sum (`./stepper`) — the force enters the
 * exact momentum audit, never a silent side channel.
 *
 * Determinism (law S2): pure per-node arithmetic in fixed index order
 * over the caller-owned temperature field; solid nodes read zero force
 * (collision never visits them anyway — the guard is bookkeeping
 * honesty, not a behavior branch).
 */

import type { LbmSolidMask } from "./state";
import type { LbmUnitSystem } from "./lattice-units";

/** What a forced stepper consumes — SI at the door plus the live field. */
export interface LbmBuoyancyConfig {
  /** The scenario gravity vector, m/s² (the Phase 61 spine's, e.g. [0, −9.81]). */
  readonly gravityMPerS2: readonly [number, number];
  /** The fluid's thermal-expansion coefficient β, 1/K (the Phase 61 fluid record's). */
  readonly thermalExpansionPerK: number;
  /** The reference temperature T_ref, K (the Boussinesq linearization point). */
  readonly referenceTemperatureK: number;
  /**
   * The live temperature field, K per node (`x + y·nx`, the lattice's
   * value order) — CALLER-OWNED and aliased, never copied: the CHT
   * coupled march (`./cht`) advances this field between flow steps,
   * and each step's force reads its current values. Solid columns are
   * read as no force.
   */
  readonly temperatureK: Float64Array;
}

/** The per-node lattice force field (momentum units per step per node). */
export interface LbmForceField {
  readonly fx: Float64Array;
  readonly fy: Float64Array;
}

/**
 * The total force a field applies over the fluid nodes, lattice
 * units — the momentum-ledger's body-force term, separable so the
 * stepper can book it without re-reading the field.
 */
export function lbmForceFieldTotal(
  field: LbmForceField,
  mask: LbmSolidMask,
): {
  readonly x: number;
  readonly y: number;
} {
  let x = 0;
  let y = 0;
  for (let index = 0; index < mask.solid.length; index += 1) {
    if (mask.solid[index] === 1) continue;
    x += field.fx[index] ?? 0;
    y += field.fy[index] ?? 0;
  }
  return { x, y };
}

/**
 * Computes the Boussinesq force field over the lattice, lattice units:
 * F = −β·(T − T_ref)·g·dt²/dx at every FLUID node from the current
 * temperature field, zero at solids. Pure — the same field and closure
 * produce bitwise-identical forces every call.
 */
export function lbmBuoyancyForceLattice(
  config: LbmBuoyancyConfig,
  mask: LbmSolidMask,
  units: LbmUnitSystem,
): LbmForceField {
  const count = mask.nx * mask.ny;
  const fx = new Float64Array(count);
  const fy = new Float64Array(count);
  const beta = config.thermalExpansionPerK;
  const reference = config.referenceTemperatureK;
  const [gx, gy] = config.gravityMPerS2;
  const factor = (units.timeStepS * units.timeStepS) / units.cellSizeM;
  // F = −β·ΔT·g·dt²/dx, pre-multiplied per component.
  const ax = -beta * (gx ?? 0) * factor;
  const ay = -beta * (gy ?? 0) * factor;
  for (let index = 0; index < count; index += 1) {
    if (mask.solid[index] === 1) continue;
    const deltaT = (config.temperatureK[index] ?? reference) - reference;
    fx[index] = ax * deltaT;
    fy[index] = ay * deltaT;
  }
  return { fx, fy };
}

/**
 * The honest-input check for a buoyancy block (the stepper's problem
 * door shares it): a finite gravity pair (zero is legitimate
 * micro-gravity), a positive finite β, a positive finite T_ref, and a
 * temperature field of exactly nx·ny values. Returns the decline
 * message, or undefined when the block runs.
 */
export function lbmBuoyancyProblem(
  buoyancy: LbmBuoyancyConfig,
  mask: LbmSolidMask,
): string | undefined {
  const [gx, gy] = buoyancy.gravityMPerS2;
  if (
    typeof gx !== "number" ||
    !Number.isFinite(gx) ||
    typeof gy !== "number" ||
    !Number.isFinite(gy)
  ) {
    return `A buoyancy block's gravity vector must be a pair of finite m/s² values, received [${String(gx)}, ${String(gy)}].`;
  }
  // A zero gravity vector is a legitimate configuration (no buoyancy
  // force): micro-gravity is honest input, not a decline.
  if (
    typeof buoyancy.thermalExpansionPerK !== "number" ||
    !Number.isFinite(buoyancy.thermalExpansionPerK) ||
    buoyancy.thermalExpansionPerK < 0
  ) {
    return `A buoyancy block's thermal-expansion coefficient must be a non-negative finite 1/K value, received ${String(buoyancy.thermalExpansionPerK)}.`;
  }
  if (
    typeof buoyancy.referenceTemperatureK !== "number" ||
    !Number.isFinite(buoyancy.referenceTemperatureK) ||
    buoyancy.referenceTemperatureK <= 0
  ) {
    return `A buoyancy block's reference temperature must be a positive finite kelvin value, received ${String(buoyancy.referenceTemperatureK)}.`;
  }
  if (
    !(buoyancy.temperatureK instanceof Float64Array) ||
    buoyancy.temperatureK.length !== mask.nx * mask.ny
  ) {
    return `A buoyancy block's temperature field must be a Float64Array of exactly ${String(mask.nx * mask.ny)} values (the lattice's value order), received ${String(buoyancy.temperatureK instanceof Float64Array ? buoyancy.temperatureK.length : "not a Float64Array")}.`;
  }
  return undefined;
}
