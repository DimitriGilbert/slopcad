/**
 * The 3D lattice state (Phase 66a): the SoA distribution buffers plus
 * the macroscopic fields, in EXACTLY the layout the WGSL 3D provider
 * mirrors (`./d3q19`'s contract): nineteen `Float32Array`s of
 * `nx·ny·nz` indexed `x + y·nx + z·nx·ny`, x-fastest. A second set
 * (`fTmp`) receives each step's push-streaming (`./streaming-3d`); the
 * swap is a reference exchange, never a copy — the kernel never
 * reallocates after construction (the 63a posture carried to 3D).
 *
 * Macroscopic fields (ρ_lat = ρ/ρ₀, lattice velocities) are accumulated
 * in `Float64Array`s from the stored f32 distributions: the same
 * additions in the same order every step, so state evolution is
 * bitwise-deterministic (law S2). Solid nodes hold whatever
 * bounce-back left them; their macroscopic columns are undefined by
 * contract and never read.
 */

import {
  D3Q19_OPPOSITE,
  D3Q19_Q,
  D3Q19_VELOCITIES,
  d3q19FillEquilibrium,
} from "./d3q19";

/**
 * The solid map: 1 where the node is a full-way bounce-back solid —
 * the Phase 62 voxelizer's native 3D occupancy, honored as-is (the
 * node interpretation `./occupancy-3d` owns).
 */
export interface Lbm3dSolidMask {
  readonly nx: number;
  readonly ny: number;
  readonly nz: number;
  /** Exactly nx·ny·nz values, x-fastest (`x + y·nx + z·nx·ny`), 0 or 1. */
  readonly solid: Uint8Array;
}

/** The mutable 3D lattice state — owned by the stepper, exported for tests. */
export interface Lbm3dState {
  readonly nx: number;
  readonly ny: number;
  readonly nz: number;
  readonly solid: Lbm3dSolidMask;
  /** The live distributions (the layout contract: 19 × nx·ny·nz f32). */
  f: Float32Array[];
  /** The streaming scratch set (swapped with `f` every step). */
  fTmp: Float32Array[];
  /** Macroscopic density ρ/ρ₀ (1 = the reference state). */
  readonly rho: Float64Array;
  /** Macroscopic x-velocity, lattice units. */
  readonly ux: Float64Array;
  /** Macroscopic y-velocity, lattice units. */
  readonly uy: Float64Array;
  /** Macroscopic z-velocity, lattice units. */
  readonly uz: Float64Array;
}

/**
 * Creates the 3D state initialized to the rest equilibrium (ρ = 1,
 * u = 0) at every node — solids included, where the value is irrelevant
 * until the first bounce-back reflects over it. The solid mask is
 * aliased, never copied: the stepper owns exactly one mask for the
 * run's life.
 */
export function createLbm3dState(mask: Lbm3dSolidMask): Lbm3dState {
  const count = mask.nx * mask.ny * mask.nz;
  const f: Float32Array[] = [];
  const fTmp: Float32Array[] = [];
  for (let i = 0; i < D3Q19_Q; i += 1) {
    f.push(new Float32Array(count));
    fTmp.push(new Float32Array(count));
  }
  d3q19FillEquilibrium(f, 1, 0, 0, 0);
  d3q19FillEquilibrium(fTmp, 1, 0, 0, 0);
  return {
    nx: mask.nx,
    ny: mask.ny,
    nz: mask.nz,
    solid: mask,
    f,
    fTmp,
    rho: new Float64Array(count).fill(1),
    ux: new Float64Array(count),
    uy: new Float64Array(count),
    uz: new Float64Array(count),
  };
}

/**
 * Recomputes ρ, u at every FLUID node from the live distributions,
 * skipping solids (their columns stay stale by contract). Returns false
 * the moment any node's density is non-finite or non-positive — the
 * divergence sentinel the stepper turns into its `diverged` flag; a
 * blown-up run reports itself instead of fabricating fields.
 */
export function lbm3dComputeMacroscopic(state: Lbm3dState): boolean {
  const { f, rho, ux, uy, uz } = state;
  const mask = state.solid.solid;
  for (let index = 0; index < mask.length; index += 1) {
    if (mask[index] === 1) continue;
    let sum = 0;
    let mx = 0;
    let my = 0;
    let mz = 0;
    for (let i = 0; i < D3Q19_Q; i += 1) {
      const value = f[i]?.[index] ?? 0;
      sum += value;
      mx += value * (D3Q19_VELOCITIES[i]?.[0] ?? 0);
      my += value * (D3Q19_VELOCITIES[i]?.[1] ?? 0);
      mz += value * (D3Q19_VELOCITIES[i]?.[2] ?? 0);
    }
    if (!Number.isFinite(sum) || sum <= 0) return false;
    rho[index] = sum;
    ux[index] = mx / sum;
    uy[index] = my / sum;
    uz[index] = mz / sum;
  }
  return true;
}

/**
 * The total momentum carried by ALL distributions, lattice units — the
 * M(t) of the per-step exact momentum audit the 3D force integration
 * pins against (the 63a identity, generalized: ΔM = face overwrites −
 * solid impulses − dropped, per component). Solid nodes are INCLUDED:
 * full-way bounce-back parks reflected populations on solid nodes
 * between the reflection and their re-streaming, and that transient
 * storage is part of the books the identity closes over.
 */
export function lbm3dTotalMomentum(state: Lbm3dState): {
  readonly x: number;
  readonly y: number;
  readonly z: number;
} {
  let x = 0;
  let y = 0;
  let z = 0;
  const nodes = state.nx * state.ny * state.nz;
  for (let index = 0; index < nodes; index += 1) {
    for (let i = 0; i < D3Q19_Q; i += 1) {
      const value = state.f[i]?.[index] ?? 0;
      x += value * (D3Q19_VELOCITIES[i]?.[0] ?? 0);
      y += value * (D3Q19_VELOCITIES[i]?.[1] ?? 0);
      z += value * (D3Q19_VELOCITIES[i]?.[2] ?? 0);
    }
  }
  return { x, y, z };
}

/**
 * A per-boundary-link observer/corrector the reflection pass consults —
 * the Phase 66b seam rotating machinery requires: called once for every
 * population that streamed INTO a solid node from a FLUID source node
 * (a genuine boundary link), with the direction, the SOLID node's
 * coordinates, and the arrived value. The returned number is added to
 * the value as it parks in the reflected direction — the moving-wall
 * correction of resolved rotation (`./torque-3d`). While it observes,
 * the sink is also where the per-link lever arm of the torque
 * integration is booked (link midpoints live half a cell from the
 * solid node toward the source). Returning 0 keeps the pass exactly
 * the static one.
 */
export type Lbm3dBoundaryLinkSink = (
  direction: number,
  x: number,
  y: number,
  z: number,
  value: number,
) => number;

/**
 * The full-way bounce-back reflection on the streaming scratch: every
 * solid node swaps each population with its opposite, which returns the
 * population to the fluid node it arrived from on the next stream. The
 * return value is the lattice impulse delivered TO the bodies this step,
 * 2·Σ f_i·c_i over solids and directions — the momentum-exchange force
 * of the cfd-ts lineage in three components (x drag, y lift, z side),
 * with the sign convention the audit consumes: the fluid loses exactly
 * this much (per-step, lattice units) — plus, when a link sink is
 * supplied, Σ δ_i·c_i over the corrected links, so the identity stays
 * exact with moving walls (the parked correction changes the momentum
 * stored on solids by exactly the correction's share of the impulse).
 *
 * The sink path is bitwise-inert when absent: the swap skips the
 * source-mask lookups and correction arithmetic entirely, so every 66a
 * static result is bit-for-bit what it was.
 */
export function lbm3dReflectSolids(
  state: Lbm3dState,
  linkSink?: Lbm3dBoundaryLinkSink,
): {
  readonly impulseX: number;
  readonly impulseY: number;
  readonly impulseZ: number;
} {
  const { fTmp, nx, ny, nz } = state;
  const mask = state.solid.solid;
  let impulseX = 0;
  let impulseY = 0;
  let impulseZ = 0;
  let correctionX = 0;
  let correctionY = 0;
  let correctionZ = 0;
  const fluidSourced = (x: number, y: number, z: number): boolean =>
    x >= 0 &&
    x < nx &&
    y >= 0 &&
    y < ny &&
    z >= 0 &&
    z < nz &&
    mask[x + y * nx + z * nx * ny] !== 1;
  for (let z = 0; z < nz; z += 1) {
    for (let y = 0; y < ny; y += 1) {
      const rowBase = y * nx + z * nx * ny;
      for (let x = 0; x < nx; x += 1) {
        const index = rowBase + x;
        if (mask[index] !== 1) continue;
        for (let i = 0; i < D3Q19_Q; i += 1) {
          const cx = D3Q19_VELOCITIES[i]?.[0] ?? 0;
          const cy = D3Q19_VELOCITIES[i]?.[1] ?? 0;
          const cz = D3Q19_VELOCITIES[i]?.[2] ?? 0;
          const value = fTmp[i]?.[index] ?? 0;
          impulseX += value * cx;
          impulseY += value * cy;
          impulseZ += value * cz;
        }
        for (let i = 1; i < D3Q19_Q; i += 1) {
          const opposite = D3Q19_OPPOSITE[i] ?? 0;
          if (opposite <= i) continue;
          const column = fTmp[i];
          const mirror = fTmp[opposite];
          if (column === undefined || mirror === undefined) continue;
          const carried = column[index] ?? 0;
          const mirrored = mirror[index] ?? 0;
          if (linkSink === undefined) {
            column[index] = mirrored;
            mirror[index] = carried;
            continue;
          }
          const icx = D3Q19_VELOCITIES[i]?.[0] ?? 0;
          const icy = D3Q19_VELOCITIES[i]?.[1] ?? 0;
          const icz = D3Q19_VELOCITIES[i]?.[2] ?? 0;
          const ocx = D3Q19_VELOCITIES[opposite]?.[0] ?? 0;
          const ocy = D3Q19_VELOCITIES[opposite]?.[1] ?? 0;
          const ocz = D3Q19_VELOCITIES[opposite]?.[2] ?? 0;
          const correctionI = fluidSourced(x - icx, y - icy, z - icz)
            ? linkSink(i, x, y, z, carried)
            : 0;
          const correctionOpposite = fluidSourced(x - ocx, y - ocy, z - ocz)
            ? linkSink(opposite, x, y, z, mirrored)
            : 0;
          column[index] = mirrored + correctionOpposite;
          mirror[index] = carried + correctionI;
          correctionX += correctionI * icx + correctionOpposite * ocx;
          correctionY += correctionI * icy + correctionOpposite * ocy;
          correctionZ += correctionI * icz + correctionOpposite * ocz;
        }
      }
    }
  }
  return {
    impulseX: 2 * impulseX + correctionX,
    impulseY: 2 * impulseY + correctionY,
    impulseZ: 2 * impulseZ + correctionZ,
  };
}
