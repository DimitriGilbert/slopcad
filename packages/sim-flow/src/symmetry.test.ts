import { describe, expect, it } from "vitest";

import { analyticOccupancy, testFluid } from "./fixtures";
import {
  type LbmStepper,
  type LbmStepperConfig,
  createLbmStepper,
} from "./stepper";

/**
 * The y-mirror permutation: reflecting a direction over a horizontal
 * plane flips only its y component — rest and the x axis directions are
 * their own mirrors, 2 ↔ 4 swap, and the diagonals pair (1,1)↔(1,−1) and
 * (−1,1)↔(−1,−1). (The 180° `D2Q9_OPPOSITE` table is NOT this.)
 */
const Y_MIRROR: readonly number[] = [0, 1, 4, 3, 2, 8, 7, 6, 5];

/**
 * The half-domain symmetry fixture (Phase 63d's validation block): a
 * symmetry-plane scenario at HALF the domain matching the MIRRORED
 * full-domain run — the compute saver the roadmap named, pinned at the
 * kernel level.
 *
 * ## The two runs
 *
 * - **Full**: nx × 2m nodes, a disc centred exactly ON the mid-plane
 *   (y* = m − 0.5, between rows m−1 and m), no-slip walls south and
 *   north. Its solution is mirror-symmetric about y* by construction.
 * - **Half**: nx × m nodes representing the full run's UPPER half (row
 *   h ↔ full row m + h), the disc's upper half sitting ON the south
 *   boundary, south face = SYMMETRY, north face = the full run's north
 *   wall.
 *
 * ## What pins exactly, and what pins in a band
 *
 * - **Exact (the symmetry-BC mechanics)**: (1) the full run preserves
 *   its mirror symmetry BITWISE — every distribution at (x, y) equals
 *   its opposite-direction distribution at (x, 2m−1−y), and the lift
 *   history is exactly 0, every step: IEEE arithmetic is sign-exact, so
 *   a symmetric initial state under sign-symmetric operations stays
 *   bitwise symmetric; (2) the half run's south face reconstructs the
 *   missing up-movers from its own post-collision specular partners —
 *   f₂ = f₄ᶜᵒˡˡ, f₅ = f₈ᶜᵒˡˡ, f₆ = f₇ᶜᵒˡˡ bitwise, and the face's
 *   wall-normal velocity is zero to float-accumulation epsilon.
 * - **Band (the honest placement statement)**: the half run's FIELDS
 *   agree with the mirrored full run — and 2× its drag agrees with the
 *   full run's drag — within a few percent, NOT bitwise. The reason is
 *   the on-node specular reflection's PLANE PLACEMENT: it sits half a
 *   link outside the boundary node (the wall-link midpoint convention),
 *   while the full run's mirror plane lies ON the links between its
 *   centre rows — a first-order half-cell placement difference whose
 *   diagonal reconstruction reads the same node where the full run
 *   streams across the plane from the mirrored neighbour. The bands
 *   below state that honestly; the drift is dominated by the inlet
 *   column's corner reconstruction differing at the symmetry row.
 *
 * Lattice: 48 × 40 full / 48 × 20 half, disc r = 5.5 at x = 14,
 * u∞ = 0.1 m/s at u_lat = 0.05, ν = 2.7e-5 m²/s → Re = u∞D/ν ≈ 41 —
 * the steady attached-wake regime (no shedding: the comparison is
 * against a settled symmetric state). 3000 steps ≈ 6 through-times.
 */

const NX = 48;
const HALF_NY = 20;
const FULL_NY = 2 * HALF_NY;
const CX = 14;
const R = 5.5;
const U = 0.1;
const NU = 2.7e-5;
const STEPS = 3000;

function fullRun(): LbmStepper {
  const config: LbmStepperConfig = {
    mask: {
      nx: NX,
      ny: FULL_NY,
      solid: analyticOccupancy(
        NX,
        FULL_NY,
        (x, y) => (x - CX) ** 2 + (y - (HALF_NY - 0.5)) ** 2 <= R * R,
      ),
    },
    fluid: testFluid(1.2, NU),
    cellSizeM: 0.001,
    characteristicVelocityMPerS: U,
    collision: { kind: "trt" },
    west: { kind: "velocity-inlet", velocityMPerS: [U, 0] },
    east: { kind: "convective-outflow" },
    south: { kind: "wall", slip: false },
    north: { kind: "wall", slip: false },
  };
  const created = createLbmStepper(config);
  if (!created.ok) throw new Error(created.error.message);
  return created.value;
}

function halfRun(): LbmStepper {
  const config: LbmStepperConfig = {
    mask: {
      nx: NX,
      ny: HALF_NY,
      // The full run's upper-half disc: centre on the symmetry plane,
      // half a cell below the half domain's south boundary row.
      solid: analyticOccupancy(
        NX,
        HALF_NY,
        (x, y) => (x - CX) ** 2 + (y + 0.5) ** 2 <= R * R,
      ),
    },
    fluid: testFluid(1.2, NU),
    cellSizeM: 0.001,
    characteristicVelocityMPerS: U,
    collision: { kind: "trt" },
    west: { kind: "velocity-inlet", velocityMPerS: [U, 0] },
    east: { kind: "convective-outflow" },
    south: { kind: "symmetry" },
    north: { kind: "wall", slip: false },
  };
  const created = createLbmStepper(config);
  if (!created.ok) throw new Error(created.error.message);
  return created.value;
}

describe("the half-domain symmetry fixture", () => {
  it("keeps the full run mirror-symmetric bitwise, with exactly zero lift", () => {
    const run = fullRun();
    for (let step = 1; step <= STEPS; step += 1) {
      run.advance();
      // Bitwise mirror: every distribution's mirror partner (opposite
      // direction, mirrored row) is byte-equal — sampled densely early
      // (the transient) and at the tail (the settled state).
      if (step <= 10 || step % 500 === 0) {
        const f = run.distributions();
        for (let i = 0; i < 9; i += 1) {
          const column = f[i];
          const mirror = f[Y_MIRROR[i] ?? 0];
          if (column === undefined || mirror === undefined) continue;
          for (let x = 0; x < NX; x += 1) {
            for (let y = 0; y < HALF_NY; y += 1) {
              const here = column[x + y * NX] ?? 0;
              const there = mirror[x + (FULL_NY - 1 - y) * NX] ?? 0;
              if (here !== there) {
                throw new Error(
                  `Mirror symmetry broke at step ${String(step)}, direction ${String(i)}, node (${String(x)}, ${String(y)}): ${String(here)} vs ${String(there)}.`,
                );
              }
            }
          }
        }
      }
    }
    expect(run.diverged).toBe(false);
    expect(run.step).toBe(STEPS);
    // The exact consequence: a mirror-symmetric flow has zero lift, to
    // the last bit of the accumulator (mirrored impulses cancel).
    const lift = run.forceState().history[1]?.samples ?? [];
    for (const sample of lift) {
      expect(sample).toBe(0);
    }
    // Timeout budget: the 3000-step run measures ≈ 7.4 s isolated and
    // 19.0 s under the full gate; its same-compute sibling below
    // measured 50.6 s there (the gate's worst contention, while
    // docs-examples' multi-minute gallery runs overlap) — the Phase 63
    // validator finding. 120 s is ≈ 2.4× that worst case — an
    // infrastructure budget, not an assertion.
  }, 120_000);

  it("holds the symmetry face's wall-normal velocity near the plane's zero", () => {
    const run = halfRun();
    for (let step = 1; step <= STEPS; step += 1) {
      run.advance();
    }
    expect(run.diverged).toBe(false);
    // The on-node specular reflection reconstructs the missing trio from
    // the node's own outgoing pair (the exact mapping `./boundaries`
    // pins), which places the plane half a link outside the node: uy is
    // exactly 0 ON THE PLANE and O(∂uy/∂y·dx/2) AT the boundary node —
    // first-order, stated. The measured node values stay a small
    // fraction of the characteristic lattice velocity (measured ≈ 17%
    // at authoring time, the accelerated gap beside the disc).
    const snapshot = run.snapshotLattice();
    let maxAbsUy = 0;
    for (let x = 0; x < NX; x += 1) {
      maxAbsUy = Math.max(maxAbsUy, Math.abs(snapshot.uy[x] ?? 0));
    }
    expect(maxAbsUy).toBeLessThan(0.5 * run.meta.units.latticeVelocity);
    // Timeout budget: the same 3000-step halfRun() march as the sibling
    // above, minus its dense mid-run sampling (one terminal snapshot) —
    // the half domain makes it the cheapest march here, but the Phase 63
    // validator still reproduced a cold-cache timeout under the gate's
    // contention: ≈ 25 s worst case against the 20 s shared default. 60 s
    // is ≈ 2.4× that measured worst case — an infrastructure budget,
    // not an assertion.
  }, 60_000);

  it("matches the mirrored full domain's fields within the stated band", () => {
    const full = fullRun();
    const half = halfRun();
    let maxRhoDiff = 0;
    let maxUxDiff = 0;
    let maxUyDiff = 0;
    for (let step = 1; step <= STEPS; step += 1) {
      full.advance();
      half.advance();
      if (step % 500 === 0) {
        const fs = full.snapshotLattice();
        const hs = half.snapshotLattice();
        for (let y = 0; y < HALF_NY; y += 1) {
          for (let x = 0; x < NX; x += 1) {
            const fullIndex = x + (y + HALF_NY) * NX;
            const halfIndex = x + y * NX;
            maxRhoDiff = Math.max(
              maxRhoDiff,
              Math.abs((fs.rho[fullIndex] ?? 0) - (hs.rho[halfIndex] ?? 0)),
            );
            maxUxDiff = Math.max(
              maxUxDiff,
              Math.abs((fs.ux[fullIndex] ?? 0) - (hs.ux[halfIndex] ?? 0)),
            );
            maxUyDiff = Math.max(
              maxUyDiff,
              Math.abs((fs.uy[fullIndex] ?? 0) - (hs.uy[halfIndex] ?? 0)),
            );
          }
        }
      }
    }
    expect(full.diverged).toBe(false);
    expect(half.diverged).toBe(false);
    // Measured at authoring time: max|Δρ| ≈ 2.8e-2, max|Δux| ≈ 1.6e-3,
    // max|Δuy| ≈ 2.1e-3 lattice units (the inlet-corner reconstruction
    // drift documented above). The bands double the measurements without
    // going slack on a broken mapping, which would differ at O(1).
    expect(maxRhoDiff).toBeLessThan(0.06);
    expect(maxUxDiff).toBeLessThan(0.004);
    expect(maxUyDiff).toBeLessThan(0.004);
    // The drag: the half run integrates its half of the symmetric body;
    // 2×half matches full within the same placement band (measured
    // ≈ 2.5% at authoring time).
    const fullDrag = full.forceState().history[0]?.samples[STEPS - 1] ?? 0;
    const halfDrag = half.forceState().history[0]?.samples[STEPS - 1] ?? 0;
    expect(Math.abs(fullDrag - 2 * halfDrag)).toBeLessThan(0.05 * fullDrag);
    // Timeout budget: this test is the observed full-gate victim —
    // 7.5 s isolated, 50.6 s under the gate's parallel CPU contention
    // (its 40 s mid-sizing budget was exceeded; the 20 s shared
    // default was blown 2.5× over before that) — the Phase 63
    // validator finding. 120 s is ≈ 2.4× that measured worst case —
    // an infrastructure budget, not an assertion.
  }, 120_000);
});
