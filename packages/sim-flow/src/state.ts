/**
 * The lattice state (Phase 63a): the SoA distribution buffers plus the
 * macroscopic fields, in EXACTLY the layout the Phase 64 GPU provider
 * mirrors (`./d2q9`'s contract): nine `Float32Array`s of `nx·ny`
 * indexed `x + y·nx`, x-fastest. A second set (`fTmp`) receives each
 * step's push-streaming; the swap is a reference exchange, never a copy
 * — the kernel never reallocates after construction, which is the
 * deliberate answer to cfd-ts's broken resize.
 *
 * Macroscopic fields (ρ_lat = ρ/ρ₀, lattice velocities) are accumulated
 * in `Float64Array`s from the stored f32 distributions: the same
 * additions in the same order every step, so state evolution is
 * bitwise-deterministic (law S2). Solid nodes hold whatever bounce-back
 * left them; their macroscopic columns are undefined by contract and
 * never read.
 */

import {
  D2Q9_OPPOSITE,
  D2Q9_Q,
  D2Q9_VELOCITIES,
  d2q9FillEquilibrium,
} from "./d2q9";

/** The solid map: 1 where the node is a full-way bounce-back solid. */
export interface LbmSolidMask {
  readonly nx: number;
  readonly ny: number;
  /** Exactly nx·ny values, x-fastest (`x + y·nx`), each 0 or 1. */
  readonly solid: Uint8Array;
}

/** The mutable lattice state — owned by the stepper, exported for tests. */
export interface LbmState {
  readonly nx: number;
  readonly ny: number;
  readonly solid: LbmSolidMask;
  /** The live distributions (the layout contract: 9 × nx·ny f32). */
  f: Float32Array[];
  /** The streaming scratch set (swapped with `f` every step). */
  fTmp: Float32Array[];
  /** Macroscopic density ρ/ρ₀ (1 = the reference state). */
  readonly rho: Float64Array;
  /** Macroscopic x-velocity, lattice units. */
  readonly ux: Float64Array;
  /** Macroscopic y-velocity, lattice units. */
  readonly uy: Float64Array;
}

/**
 * Creates the state initialized to the rest equilibrium (ρ = 1, u = 0)
 * at every node — solids included, where the value is irrelevant until
 * the first bounce-back reflects over it. The solid mask is aliased,
 * never copied: the stepper owns exactly one mask for the run's life.
 */
export function createLbmState(mask: LbmSolidMask): LbmState {
  const count = mask.nx * mask.ny;
  const f: Float32Array[] = [];
  const fTmp: Float32Array[] = [];
  for (let i = 0; i < D2Q9_Q; i += 1) {
    f.push(new Float32Array(count));
    fTmp.push(new Float32Array(count));
  }
  d2q9FillEquilibrium(f, 1, 0, 0);
  d2q9FillEquilibrium(fTmp, 1, 0, 0);
  return {
    nx: mask.nx,
    ny: mask.ny,
    solid: mask,
    f,
    fTmp,
    rho: new Float64Array(count).fill(1),
    ux: new Float64Array(count),
    uy: new Float64Array(count),
  };
}

/**
 * Recomputes ρ, u at every FLUID node from the live distributions,
 * skipping solids (their columns stay stale by contract). Returns false
 * the moment any node's density is non-finite or non-positive — the
 * divergence sentinel the stepper turns into its `diverged` flag; a
 * blown-up BGK run reports itself instead of fabricating fields.
 *
 * The optional per-node force arrays add Guo's half-step correction to
 * the velocity — u = (Σf·c + F/2)/ρ — so a forced collision
 * (`lbmCollide`'s Guo term) reads the physical velocity from its
 * equilibrium's own convention (law: the forced stepper passes its
 * buoyancy field here every step; an unforced call is bitwise the
 * plain form, F = 0 contributing exact zeros).
 */
export function lbmComputeMacroscopic(
  state: LbmState,
  forceX?: Float64Array,
  forceY?: Float64Array,
): boolean {
  const { f, rho, ux, uy } = state;
  const mask = state.solid.solid;
  const forced = forceX !== undefined && forceY !== undefined;
  for (let index = 0; index < mask.length; index += 1) {
    if (mask[index] === 1) continue;
    let sum = 0;
    let mx = 0;
    let my = 0;
    for (let i = 0; i < D2Q9_Q; i += 1) {
      const value = f[i]?.[index] ?? 0;
      sum += value;
      mx += value * (D2Q9_VELOCITIES[i]?.[0] ?? 0);
      my += value * (D2Q9_VELOCITIES[i]?.[1] ?? 0);
    }
    if (!Number.isFinite(sum) || sum <= 0) return false;
    rho[index] = sum;
    ux[index] = (mx + (forced ? (forceX?.[index] ?? 0) / 2 : 0)) / sum;
    uy[index] = (my + (forced ? (forceY?.[index] ?? 0) / 2 : 0)) / sum;
  }
  return true;
}

/**
 * The total momentum carried by ALL distributions, lattice units — the
 * M(t) of the per-step exact momentum audit the force integration pins
 * against (the momentum-change sanity of Phase 63a's validation). Solid
 * nodes are INCLUDED: full-way bounce-back parks reflected populations
 * on solid nodes between the reflection and their re-streaming, and
 * that transient storage is part of the books the identity closes over
 * (ΔM = face overwrites − solid impulses − dropped, exactly).
 */
export function lbmTotalMomentum(state: LbmState): {
  readonly x: number;
  readonly y: number;
} {
  let x = 0;
  let y = 0;
  for (let index = 0; index < state.nx * state.ny; index += 1) {
    for (let i = 0; i < D2Q9_Q; i += 1) {
      const value = state.f[i]?.[index] ?? 0;
      x += value * (D2Q9_VELOCITIES[i]?.[0] ?? 0);
      y += value * (D2Q9_VELOCITIES[i]?.[1] ?? 0);
    }
  }
  return { x, y };
}

/**
 * The full-way bounce-back reflection on the streaming scratch: every
 * solid node swaps each population with its opposite, which returns the
 * population to the fluid node it arrived from on the next stream. The
 * return value is the lattice impulse delivered TO the bodies this step,
 * 2·Σ f_i·c_i over solids and directions — the momentum-exchange force
 * of the cfd-ts lineage, rewritten with the sign convention the audit
 * consumes: the fluid loses exactly this much (per-step, lattice units).
 */
export function lbmReflectSolids(state: LbmState): {
  readonly impulseX: number;
  readonly impulseY: number;
} {
  const { fTmp, nx, ny } = state;
  const mask = state.solid.solid;
  let impulseX = 0;
  let impulseY = 0;
  for (let y = 0; y < ny; y += 1) {
    for (let x = 0; x < nx; x += 1) {
      const index = x + y * nx;
      if (mask[index] !== 1) continue;
      for (let i = 0; i < D2Q9_Q; i += 1) {
        const cx = D2Q9_VELOCITIES[i]?.[0] ?? 0;
        const cy = D2Q9_VELOCITIES[i]?.[1] ?? 0;
        const value = fTmp[i]?.[index] ?? 0;
        impulseX += value * cx;
        impulseY += value * cy;
      }
      for (let i = 1; i < D2Q9_Q; i += 1) {
        const opposite = D2Q9_OPPOSITE[i] ?? 0;
        if (opposite <= i) continue;
        const column = fTmp[i];
        const mirror = fTmp[opposite];
        if (column === undefined || mirror === undefined) continue;
        const carried = column[index] ?? 0;
        column[index] = mirror[index] ?? 0;
        mirror[index] = carried;
      }
    }
  }
  return { impulseX: 2 * impulseX, impulseY: 2 * impulseY };
}
