/**
 * The D3Q19 lattice (ROADMAP-SIM Phase 66a, law S2's 3D reference
 * kernel — the analogue of `./d2q9`): discrete velocities, quadrature
 * weights, the equilibrium pair, and the SoA memory layout EVERY
 * implementation of this kernel shares.
 *
 * ## THE LAYOUT CONTRACT (the WGSL 3D provider reads this before writing)
 *
 * The kernel stores distributions as a structure of arrays: one
 * `Float32Array` per lattice direction, each of length `nx·ny·nz`,
 * indexed `x + y·nx + z·nx·ny` — x-fastest, the same value order every
 * sim-core grid block and `.vti` writer uses (the 3D voxelizer's native
 * output, honored node-for-node by `./occupancy-3d`). The Phase 66a GPU
 * provider mirrors these arrays verbatim into GPU storage buffers
 * (19 × nx·ny·nz f32) and mirrors the direction table below, so the
 * oracle-vs-GPU tolerance harness can diff CPU arrays against buffer
 * readbacks cell-for-cell without a permutation. Any change to the
 * direction ORDER or the indexing is a contract change and must land in
 * lockstep with the GPU provider (`./wgsl-shader-3d`).
 *
 * ## Direction order
 *
 * Index 0 is the rest direction; 1–6 sweep the axis-aligned velocities
 * (+X, +Y, −X, −Y, then +Z, −Z — the x/y ring counter-clockwise from
 * +X, the 63a precedent, with the z pair appended); 7–10 sweep the x-y
 * diagonals counter-clockwise from (+1,+1,0); 11–14 the x-z diagonals
 * from (+1,0,+1); 15–18 the y-z diagonals from (0,+1,+1).
 * `D3Q19_OPPOSITE` is the fixed reflection table.
 *
 * ## Provenance
 *
 * The standard 3D lattice of the LBM literature (Qian–d'Humières–
 * Lallemand hierarchy): rest weight 1/3, axis weights 1/18, diagonal
 * weights 1/36, c_s² = 1/3 — the exact isotropy the second-order
 * equilibrium needs in three dimensions. The equilibrium is the
 * standard second-order expansion in lattice units, split into its
 * even/odd reflection parts because the TRT collision (`./relaxation`'s
 * rates, applied over this lattice by `./relaxation-3d`) relaxes them
 * at different rates — the 63a structure carried to 3D unchanged.
 */

/** The number of discrete velocities (rest + 6 axis + 12 diagonal). */
export const D3Q19_Q = 19;

/** The lattice sound speed squared, c_s² = 1/3 (lattice units). */
export const D3Q19_CS2 = 1 / 3;

/**
 * The discrete velocity vectors c_i, lattice units: index i is
 * `D3Q19_VELOCITIES[i] = [c_ix, c_iy, c_iz]`.
 */
export const D3Q19_VELOCITIES: readonly (readonly [number, number, number])[] =
  [
    [0, 0, 0],
    [1, 0, 0],
    [0, 1, 0],
    [-1, 0, 0],
    [0, -1, 0],
    [0, 0, 1],
    [0, 0, -1],
    [1, 1, 0],
    [-1, 1, 0],
    [-1, -1, 0],
    [1, -1, 0],
    [1, 0, 1],
    [-1, 0, 1],
    [-1, 0, -1],
    [1, 0, -1],
    [0, 1, 1],
    [0, -1, 1],
    [0, -1, -1],
    [0, 1, -1],
  ];

/** The quadrature weights w_i: 1/3 rest, 1/18 axis, 1/36 diagonal. */
export const D3Q19_WEIGHTS: readonly number[] = [
  1 / 3,
  1 / 18,
  1 / 18,
  1 / 18,
  1 / 18,
  1 / 18,
  1 / 18,
  1 / 36,
  1 / 36,
  1 / 36,
  1 / 36,
  1 / 36,
  1 / 36,
  1 / 36,
  1 / 36,
  1 / 36,
  1 / 36,
  1 / 36,
  1 / 36,
];

/** The reflection table: `D3Q19_OPPOSITE[i]` is the index of −c_i. */
export const D3Q19_OPPOSITE: readonly number[] = [
  0, 3, 4, 1, 2, 6, 5, 9, 10, 7, 8, 13, 14, 11, 12, 17, 18, 15, 16,
];

/** The equilibrium distribution for one direction (lattice units). */
export function d3q19Equilibrium(
  i: number,
  rho: number,
  ux: number,
  uy: number,
  uz: number,
): number {
  const [cx, cy, cz] = D3Q19_VELOCITIES[i] ?? [0, 0, 0];
  const cu = cx * ux + cy * uy + cz * uz;
  const usq = ux * ux + uy * uy + uz * uz;
  return (
    (D3Q19_WEIGHTS[i] ?? 0) * rho * (1 + 3 * cu + 4.5 * cu * cu - 1.5 * usq)
  );
}

/**
 * The equilibrium's EVEN part E⁺_i = ½(e_i(u) + e_ī(u)) — invariant
 * under direction reflection; the TRT collision relaxes it at the
 * physical rate 1/τ⁺.
 */
export function d3q19EquilibriumEven(
  i: number,
  rho: number,
  ux: number,
  uy: number,
  uz: number,
): number {
  const [cx, cy, cz] = D3Q19_VELOCITIES[i] ?? [0, 0, 0];
  const cu = cx * ux + cy * uy + cz * uz;
  const usq = ux * ux + uy * uy + uz * uz;
  return (D3Q19_WEIGHTS[i] ?? 0) * rho * (1 + 4.5 * cu * cu - 1.5 * usq);
}

/**
 * The equilibrium's ODD part E⁻_i = ½(e_i(u) − e_ī(u)) = w_i·ρ·3(c_i·u) —
 * antisymmetric under reflection; carries the momentum and is relaxed
 * at the free rate 1/τ⁻ the TRT magic parameter fixes.
 */
export function d3q19EquilibriumOdd(
  i: number,
  rho: number,
  ux: number,
  uy: number,
  uz: number,
): number {
  const [cx, cy, cz] = D3Q19_VELOCITIES[i] ?? [0, 0, 0];
  return (D3Q19_WEIGHTS[i] ?? 0) * rho * 3 * (cx * ux + cy * uy + cz * uz);
}

/**
 * Fills all nineteen equilibrium distributions for (ρ, u) into `out`,
 * indexed by direction — the initializer shape every array-seeding site
 * (state construction, tests, the Phase 66a harness) shares.
 */
export function d3q19FillEquilibrium(
  out: Float32Array[],
  rho: number,
  ux: number,
  uy: number,
  uz: number,
): void {
  for (let i = 0; i < D3Q19_Q; i += 1) {
    out[i]?.fill(d3q19Equilibrium(i, rho, ux, uy, uz));
  }
}
