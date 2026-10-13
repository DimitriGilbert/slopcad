/**
 * 3D collision (Phase 66a): BGK first, TRT as the stability knob over
 * the D3Q19 lattice — the 63a ordering carried to 3D. The rates and
 * their honesty checks are SHARED with the 2D kernel
 * (`lbmRelaxationRates`, `lbmCollisionModelProblem` in `./relaxation`:
 * both are pure functions of the model and τ⁺, lattice-independent by
 * construction); only the equilibrium evaluation is D3Q19's.
 *
 * Momentum and density are conserved exactly at every collision
 * (pair-wise antisymmetry of the odd parts), in f64 arithmetic before
 * the f32 store — deterministic rounding, law S2.
 *
 * Scope line, updated by Phase 66b: the kernel's first forced consumer
 * arrived — MRF's rotating-zone frame force (the exact lab-variable
 * form ((Ω×r)·∇)u_h − Ω×u_h, `./mrf-3d`) enters as per-node Guo
 * force-density arrays, the 3D raise this module always said it would
 * grow. The scheme is Guo-style
 * with the half-force velocity shift: the equilibrium (both TRT parts)
 * is evaluated at u_eq = u_h + F/(2ρ) and the source
 *   S_i = w_i·[3(c_i − u_eq)·F + 9(c_i·u_eq)(c_i·F)]
 * is split by reflection parity — the even part S⁺ with coefficient
 * (1 − λ⁺/2), the odd part S⁻ = 3·w_i·(c_i·F) with (1 − λ⁻/2) — so the
 * TRT rates and the source parities pair correctly and the per-node
 * momentum gain is EXACTLY F (λ⁻·F/2 from the shifted equilibrium's odd
 * relaxation + (1 − λ⁻/2)·F from the odd source), mass exactly
 * unchanged. BGK collapses to the textbook single-τ form. Unforced
 * nodes take the byte-identical 66a path: the arrays are read only when
 * supplied, and adding exact zeros would not change a single rounding
 * anyway (u + 0/2ρ = u in f64).
 */

import type { Lbm3dState } from "./state-3d";
import type { LbmRelaxationRates } from "./relaxation";

import {
  D3Q19_OPPOSITE,
  D3Q19_Q,
  D3Q19_WEIGHTS,
  D3Q19_VELOCITIES,
  d3q19Equilibrium,
  d3q19EquilibriumEven,
  d3q19EquilibriumOdd,
} from "./d3q19";

/** Per-node lattice force densities (momentum per step per cell). */
export interface Lbm3dGuoForcing {
  /** F_x per node, lattice units; zero wherever no force acts. */
  readonly fx: Float64Array;
  /** F_y per node, lattice units; zero wherever no force acts. */
  readonly fy: Float64Array;
  /** F_z per node, lattice units; zero wherever no force acts. */
  readonly fz: Float64Array;
}

/**
 * Applies one collision to the live distributions, in place, at every
 * FLUID node from the macroscopic fields (which must be current for
 * `f` — the stepper's step order guarantees it). Solids are skipped:
 * their contents are bounce-back's business, never collision's. With
 * forcing arrays supplied, the Guo scheme above applies at the nodes
 * they mark; without them this is the 66a unforced collision unchanged.
 */
export function lbm3dCollide(
  state: Lbm3dState,
  rates: LbmRelaxationRates,
  forcing?: Lbm3dGuoForcing,
): void {
  const { f, rho, ux, uy, uz, nx, ny, nz } = state;
  const mask = state.solid.solid;
  const { lambdaPlus, lambdaMinus } = rates;
  const fx = forcing?.fx;
  const fy = forcing?.fy;
  const fz = forcing?.fz;
  const plane = nx * ny;
  for (let z = 0; z < nz; z += 1) {
    for (let y = 0; y < ny; y += 1) {
      const rowBase = z * plane + y * nx;
      for (let x = 0; x < nx; x += 1) {
        const index = rowBase + x;
        if (mask[index] === 1) continue;
        const nodeRho = rho[index] ?? 1;
        const nodeUx = ux[index] ?? 0;
        const nodeUy = uy[index] ?? 0;
        const nodeUz = uz[index] ?? 0;
        const forceX = fx?.[index] ?? 0;
        const forceY = fy?.[index] ?? 0;
        const forceZ = fz?.[index] ?? 0;
        const forced = forceX !== 0 || forceY !== 0 || forceZ !== 0;
        // The half-force shift: u_eq = u_h + F/(2ρ).
        const eqUx = forced ? nodeUx + forceX / (2 * nodeRho) : nodeUx;
        const eqUy = forced ? nodeUy + forceY / (2 * nodeRho) : nodeUy;
        const eqUz = forced ? nodeUz + forceZ / (2 * nodeRho) : nodeUz;
        if (rates.kind === "bgk") {
          for (let i = 0; i < D3Q19_Q; i += 1) {
            const column = f[i];
            if (column === undefined) continue;
            const value = column[index] ?? 0;
            let next =
              value -
              lambdaPlus *
                (value - d3q19Equilibrium(i, nodeRho, eqUx, eqUy, eqUz));
            if (forced) {
              const [cx, cy, cz] = D3Q19_VELOCITIES[i] ?? [0, 0, 0];
              const cu = cx * eqUx + cy * eqUy + cz * eqUz;
              const cf = cx * forceX + cy * forceY + cz * forceZ;
              const uf = eqUx * forceX + eqUy * forceY + eqUz * forceZ;
              next +=
                (1 - lambdaPlus / 2) *
                (D3Q19_WEIGHTS[i] ?? 0) *
                (3 * cf - 3 * uf + 9 * cu * cf);
            }
            column[index] = next;
          }
          continue;
        }
        // TRT: the rest direction is purely even; every reflected pair
        // is updated atomically from its two original values — the
        // pair's odd error enters each member with the opposite sign.
        // Under forcing, the even source (same sign both members) rides
        // λ⁺'s coefficient, the odd source (sign flip) λ⁻'s.
        const uf = eqUx * forceX + eqUy * forceY + eqUz * forceZ;
        const rest = f[0];
        if (rest !== undefined) {
          const value = rest[index] ?? 0;
          let next =
            value -
            lambdaPlus *
              (value - d3q19EquilibriumEven(0, nodeRho, eqUx, eqUy, eqUz));
          if (forced) {
            next += (1 - lambdaPlus / 2) * (D3Q19_WEIGHTS[0] ?? 0) * -3 * uf;
          }
          rest[index] = next;
        }
        for (let i = 1; i < D3Q19_Q; i += 1) {
          const j = D3Q19_OPPOSITE[i] ?? 0;
          if (j <= i) continue;
          const column = f[i];
          const mirror = f[j];
          if (column === undefined || mirror === undefined) continue;
          const fi = column[index] ?? 0;
          const fj = mirror[index] ?? 0;
          const evenError =
            (fi + fj) / 2 - d3q19EquilibriumEven(i, nodeRho, eqUx, eqUy, eqUz);
          const oddError =
            (fi - fj) / 2 - d3q19EquilibriumOdd(i, nodeRho, eqUx, eqUy, eqUz);
          if (!forced) {
            column[index] =
              fi - lambdaPlus * evenError - lambdaMinus * oddError;
            mirror[index] =
              fj - lambdaPlus * evenError + lambdaMinus * oddError;
            continue;
          }
          const weight = D3Q19_WEIGHTS[i] ?? 0;
          const [cx, cy, cz] = D3Q19_VELOCITIES[i] ?? [0, 0, 0];
          const cf = cx * forceX + cy * forceY + cz * forceZ;
          const cu = cx * eqUx + cy * eqUy + cz * eqUz;
          const sourceEven = weight * (-3 * uf + 9 * cu * cf);
          const sourceOdd = 3 * weight * cf;
          const evenPush = (1 - lambdaPlus / 2) * sourceEven;
          const oddPush = (1 - lambdaMinus / 2) * sourceOdd;
          column[index] =
            fi -
            lambdaPlus * evenError -
            lambdaMinus * oddError +
            evenPush +
            oddPush;
          mirror[index] =
            fj -
            lambdaPlus * evenError +
            lambdaMinus * oddError +
            evenPush -
            oddPush;
        }
      }
    }
  }
}
