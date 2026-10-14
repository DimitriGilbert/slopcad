/**
 * Torque integration about a rotation axis (Phase 66b, the roadmap's
 * "3D force accumulation extended to torque"): the momentum-exchange
 * impulse of every boundary link, crossed with its lever arm from the
 * axis and projected on the axis direction. The link data comes from
 * the reflection pass's boundary-link sink (`./state-3d`'s
 * `Lbm3dBoundaryLinkSink` seam): each genuine fluid→solid arrival i at
 * solid node x_s delivers the body an axial moment
 *
 *   τ_link = ê · (r_mid × Δp_link),  Δp_link = (2·f_i + δ_i)·c_i,
 *   r_mid = (x_s − c_i/2) − axisPoint
 *
 * — the standard immersed-LBM midpoint placement (the wall sits half a
 * link from the solid node, toward the fluid source; the same half-link
 * honesty the domain walls' bounce-back documents in `./boundaries-3d`).
 *
 * Two sinks share this bookkeeping:
 *
 * - the STATIC wall sink (MRF's rotor-in-frame, any fixed solid): no
 *   parked-value correction (δ = 0), torque from 2·f_i·c_i only;
 * - the ROTATING wall sink (resolved rotation): the moving-boundary
 *   correction δ_i = −6·w_i·ρ_f·(c_i·u_w) — the momentum-exchange
 *   moving-wall term of the Ladd/Aidun lineage — with u_w = Ω_lat ×
 *   r_mid the rigid wall velocity at the link midpoint and ρ_f the
 *   source node's step-start density (the lagged source the boundary
 *   conditions use; deterministic).
 *
 * The accumulator converts lattice torque to SI once —
 * τ_SI = τ_lat·dx·forceFactor, the lever arm's dx times the 3D force
 * factor — and owns the deterministic per-step series (N·m), the
 * force accumulator's own discipline.
 */

import type { SimHistorySeries } from "@slopcad/sim-core";
import type { Lbm3dUnitSystem } from "./lattice-units-3d";
import type { Lbm3dRotationAxis } from "./rotation-3d";
import type { Lbm3dBoundaryLinkSink } from "./state-3d";

import { D3Q19_VELOCITIES, D3Q19_WEIGHTS } from "./d3q19";

/** The torque series name of the deterministic rotation history. */
export const LBM3D_TORQUE_SERIES_NAME = "torque" as const;

/** The unit label the torque series carries. */
export const LBM3D_TORQUE_UNIT = "N·m";

/** The mutable per-step lattice torque a sink writes into. */
export interface Lbm3dTorqueLedger {
  /** Σ τ_link this step, lattice units, about +ê (N·m after the factor). */
  tauLat: number;
}

/** The per-step axial-torque accumulator (SI N·m, deterministic series). */
export class Lbm3dTorqueAccumulator {
  private readonly torqueFactor: number;
  private readonly samples: number[] = [];

  constructor(units: Lbm3dUnitSystem) {
    this.torqueFactor = units.forceFactor * units.cellSizeM;
  }

  /** Records one step's lattice torque sum as the step's SI sample. */
  record(tauLat: number): void {
    this.samples.push(tauLat * this.torqueFactor);
  }

  /** The number of recorded steps (the series length). */
  get length(): number {
    return this.samples.length;
  }

  /** The latest torque sample, zero before the first step. */
  current(): {
    readonly torqueNPerM: number;
  } {
    return { torqueNPerM: this.samples[this.samples.length - 1] ?? 0 };
  }

  /**
   * The deterministic history series, in the sim-core shape the result
   * store persists (samples aliased, never copied — treat as
   * read-only; windowed means are the caller's post-processing).
   */
  history(): readonly SimHistorySeries[] {
    return [
      {
        name: LBM3D_TORQUE_SERIES_NAME,
        unit: LBM3D_TORQUE_UNIT,
        samples: this.samples,
      },
    ];
  }
}

/**
 * The static-wall torque sink: books the axial moment of every boundary
 * link's plain momentum exchange (δ = 0 — the walls do not move in
 * this frame). This is MRF's rotor bookkeeping and any fixed-solid
 * drag moment.
 */
export function lbm3dStaticWallTorqueSink(
  ledger: Lbm3dTorqueLedger,
  axis: Lbm3dRotationAxis,
): Lbm3dBoundaryLinkSink {
  const [ex, ey, ez] = axis.direction;
  const [ax, ay, az] = axis.pointLattice;
  return (direction, x, y, z, value) => {
    const cx = D3Q19_VELOCITIES[direction]?.[0] ?? 0;
    const cy = D3Q19_VELOCITIES[direction]?.[1] ?? 0;
    const cz = D3Q19_VELOCITIES[direction]?.[2] ?? 0;
    // Lever arm to the link midpoint (half a link toward the source).
    const rx = x - cx / 2 - ax;
    const ry = y - cy / 2 - ay;
    const rz = z - cz / 2 - az;
    // ê · (r × (2·f·c)) = 2·f · ê·(r × c).
    const crossX = ry * cz - rz * cy;
    const crossY = rz * cx - rx * cz;
    const crossZ = rx * cy - ry * cx;
    ledger.tauLat += 2 * value * (ex * crossX + ey * crossY + ez * crossZ);
    return 0;
  };
}

/**
 * The MRF rotor torque sink: the frozen-rotor formulation's wall — the
 * rotor is a wall moving at u_w = Ω_lat·(ê × r_mid) in the lab-frame
 * variables the MRF populations live in (the no-slip u_rel = 0 of the
 * rotating frame IS u_lab = Ω×r at the wall), so its momentum
 * exchange carries the same moving-wall correction as resolved
 * rotation — the two schemes measure torque identically by
 * construction. `rotor` marks the solids INSIDE the rotating zone
 * (the stator outside takes plain bounce-back and books no rotor
 * torque).
 */
export function lbm3dMrfRotorTorqueSink(
  ledger: Lbm3dTorqueLedger,
  axis: Lbm3dRotationAxis,
  omegaLattice: number,
  rotor: Uint8Array,
  rho: Float64Array,
  nx: number,
  ny: number,
): Lbm3dBoundaryLinkSink {
  return lbm3dRotatingWallTorqueSink(
    ledger,
    axis,
    omegaLattice,
    rotor,
    rho,
    nx,
    ny,
  );
}

/**
 * The rotating-wall torque sink (resolved rotation): for boundary links
 * whose SOLID node belongs to the rotating body (`rotor` mask — static
 * solids sharing the lattice get no correction and book no rotor
 * torque), applies the moving-wall parked-value correction
 * δ_i = −6·w_i·ρ_f·(c_i·u_w) with u_w = Ω_lat·(ê × r_mid) and books
 * the axial moment of the full impulse (2·f_i + δ_i)·c_i. `rho` is the
 * state's step-start density (lagged, the boundary precedent).
 */
export function lbm3dRotatingWallTorqueSink(
  ledger: Lbm3dTorqueLedger,
  axis: Lbm3dRotationAxis,
  omegaLattice: number,
  rotor: Uint8Array,
  rho: Float64Array,
  nx: number,
  ny: number,
): Lbm3dBoundaryLinkSink {
  const [ex, ey, ez] = axis.direction;
  const [ax, ay, az] = axis.pointLattice;
  return (direction, x, y, z, value) => {
    const index = x + y * nx + z * nx * ny;
    const cx = D3Q19_VELOCITIES[direction]?.[0] ?? 0;
    const cy = D3Q19_VELOCITIES[direction]?.[1] ?? 0;
    const cz = D3Q19_VELOCITIES[direction]?.[2] ?? 0;
    // Lever arm to the link midpoint (half a link toward the source).
    const rx = x - cx / 2 - ax;
    const ry = y - cy / 2 - ay;
    const rz = z - cz / 2 - az;
    const crossX = ry * cz - rz * cy;
    const crossY = rz * cx - rx * cz;
    const crossZ = rx * cy - ry * cx;
    if (rotor[index] !== 1) {
      // A static solid's link: no correction, and no rotor torque —
      // the tube's drag moment is not the rotor's torque series (the
      // total force series still carries it, through the impulse).
      return 0;
    }
    // u_w = Ω_lat·(ê × r_mid), rigid wall velocity at the midpoint.
    const wx = omegaLattice * (ey * rz - ez * ry);
    const wy = omegaLattice * (ez * rx - ex * rz);
    const wz = omegaLattice * (ex * ry - ey * rx);
    const rhoF = rho[x - cx + (y - cy) * nx + (z - cz) * nx * ny] ?? 1;
    const correction =
      -6 *
      (D3Q19_WEIGHTS[direction] ?? 0) *
      rhoF *
      (cx * wx + cy * wy + cz * wz);
    const axialCouple = ex * crossX + ey * crossY + ez * crossZ;
    ledger.tauLat += (2 * value + correction) * axialCouple;
    return correction;
  };
}
