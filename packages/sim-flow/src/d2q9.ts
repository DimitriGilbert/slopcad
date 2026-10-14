/**
 * The D2Q9 lattice (ROADMAP-SIM Phase 63a, law S2's flow-domain reference
 * kernel): discrete velocities, quadrature weights, the equilibrium pair,
 * and the SoA memory layout EVERY implementation of this kernel shares.
 *
 * ## THE LAYOUT CONTRACT (Phase 64 reads this before writing WGSL)
 *
 * The kernel stores distributions as a structure of arrays: one
 * `Float32Array` per lattice direction, each of length `nx·ny`, indexed
 * `x + y·nx` — x-fastest, the same value order every sim-core field
 * block and `.vti` writer uses. The Phase 64 GPU provider mirrors these
 * arrays verbatim into GPU storage buffers (9 × nx·ny f32) and mirrors
 * the direction table below, so the oracle-vs-GPU tolerance harness can
 * diff CPU arrays against buffer readbacks cell-for-cell without a
 * permutation. Any change to the direction ORDER or the indexing is a
 * contract change and must land in lockstep with the GPU provider.
 *
 * ## Direction order
 *
 * Index 0 is the rest direction; 1–4 sweep the axis-aligned velocities
 * counter-clockwise from +X; 5–8 sweep the diagonals counter-clockwise
 * from (+1,+1). `D2Q9_OPPOSITE` is the fixed reflection table.
 *
 * ## Provenance
 *
 * A clean MIT rewrite informed by the owner's LGPL-2.1 `cfd-ts` (D2Q9
 * BGK, full-way bounce-back, momentum-exchange forces) — its ideas, never
 * its code, with its known flaws (four-edge equilibrium boundaries, a
 * broken resize) treated as the rewrite spec: real boundary conditions
 * live in `./boundaries`, and this kernel never reallocates after
 * construction (a stepper's geometry is immutable; resize is a new
 * stepper). The equilibrium is the standard second-order D2Q9 expansion
 * in lattice units (c_s² = 1/3), split into its even/odd parts because
 * the TRT collision (`./relaxation`) relaxes them at different rates.
 */

/** The number of discrete velocities (rest + 4 axis + 4 diagonal). */
export const D2Q9_Q = 9;

/** The lattice sound speed squared, c_s² = 1/3 (lattice units). */
export const D2Q9_CS2 = 1 / 3;

/**
 * The discrete velocity vectors c_i, lattice units: index i is
 * `D2Q9_VELOCITIES[i] = [c_ix, c_iy]`.
 */
export const D2Q9_VELOCITIES: readonly (readonly [number, number])[] = [
  [0, 0],
  [1, 0],
  [0, 1],
  [-1, 0],
  [0, -1],
  [1, 1],
  [-1, 1],
  [-1, -1],
  [1, -1],
];

/** The quadrature weights w_i: 4/9 rest, 1/9 axis, 1/36 diagonal. */
export const D2Q9_WEIGHTS: readonly number[] = [
  4 / 9,
  1 / 9,
  1 / 9,
  1 / 9,
  1 / 9,
  1 / 36,
  1 / 36,
  1 / 36,
  1 / 36,
];

/** The reflection table: `D2Q9_OPPOSITE[i]` is the index of −c_i. */
export const D2Q9_OPPOSITE: readonly number[] = [0, 3, 4, 1, 2, 7, 8, 5, 6];

/** The equilibrium distribution for one direction (lattice units). */
export function d2q9Equilibrium(
  i: number,
  rho: number,
  ux: number,
  uy: number,
): number {
  const [cx, cy] = D2Q9_VELOCITIES[i] ?? [0, 0];
  const cu = cx * ux + cy * uy;
  const usq = ux * ux + uy * uy;
  return (
    (D2Q9_WEIGHTS[i] ?? 0) * rho * (1 + 3 * cu + 4.5 * cu * cu - 1.5 * usq)
  );
}

/**
 * The equilibrium's EVEN part E⁺_i = ½(e_i(u) + e_ī(u)) — invariant
 * under direction reflection; the TRT collision relaxes it at the
 * physical rate 1/τ⁺.
 */
export function d2q9EquilibriumEven(
  i: number,
  rho: number,
  ux: number,
  uy: number,
): number {
  const [cx, cy] = D2Q9_VELOCITIES[i] ?? [0, 0];
  const cu = cx * ux + cy * uy;
  const usq = ux * ux + uy * uy;
  return (D2Q9_WEIGHTS[i] ?? 0) * rho * (1 + 4.5 * cu * cu - 1.5 * usq);
}

/**
 * The equilibrium's ODD part E⁻_i = ½(e_i(u) − e_ī(u)) = w_i·ρ·3(c_i·u) —
 * antisymmetric under reflection; carries the momentum and is relaxed at
 * the free rate 1/τ⁻ the TRT magic parameter fixes.
 */
export function d2q9EquilibriumOdd(
  i: number,
  rho: number,
  ux: number,
  uy: number,
): number {
  const [cx, cy] = D2Q9_VELOCITIES[i] ?? [0, 0];
  return (D2Q9_WEIGHTS[i] ?? 0) * rho * 3 * (cx * ux + cy * uy);
}

/**
 * Fills all nine equilibrium distributions for (ρ, u) into `out`,
 * indexed by direction — the initializer shape every array-seeding site
 * (state construction, tests, the Phase 64 harness) shares.
 */
export function d2q9FillEquilibrium(
  out: Float32Array[],
  rho: number,
  ux: number,
  uy: number,
): void {
  for (let i = 0; i < D2Q9_Q; i += 1) {
    out[i]?.fill(d2q9Equilibrium(i, rho, ux, uy));
  }
}
