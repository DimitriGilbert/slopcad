/**
 * The centrifugal validation (Phase 69): stress vs the closed-form
 * thin-ring case, σ = ρω²R̄². The fixture is a QUARTER ring under
 * symmetry rollers (`axis-fix` on the three min faces — the mirror
 * planes coincide with the mesh's face planes by construction), so the
 * model reproduces the free spinning ring without the point-weld
 * bending a fully-fixed fixture would superpose.
 *
 * Measured (2026-10-13, steel, r_i = 26 mm, r_o = 32 mm, R̄ = 29 mm,
 * ω = 600 rad/s, 2 mm voxels): the all-element mean von Mises = 1.012·
 * ρω²R̄² (pinned 0.96–1.06); the interior radius bands (27–31 mm — the
 * staircase surface bands 26/32 mm excluded, their cell counts too few
 * and their geometry too coarse) sit within 0.95–1.15 of the thick-ring
 * plane-stress closed form σ_θθ(r). The bands are published here, with
 * their two stated causes: the staircase (voxelised annulus vs smooth)
 * and the single-cell z slab's bottom roller (ε_z restrained at one
 * plane — a ν²-order effect on the hoop state).
 */

import { describe, expect, it } from "vitest";
import type { StructuralRunScenario } from "./run";

import { runStructuralScenario } from "./run";
import { analyticGrid, steelScenario } from "./fixtures";

const H_M = 0.002;
const R_INNER_M = 0.026;
const R_OUTER_M = 0.032;
const R_MEAN_M = 0.029;
const OMEGA_RAD_PER_S = 600;
const DENSITY = 7850;
const NU = 0.3;

function quarterRingScenario(): StructuralRunScenario {
  // The grid origin sits half a cell off the ring centre so the mesh's
  // xMin/yMin corner planes (origin − h/2) ARE the ring's symmetry
  // planes through the centre.
  const origin = H_M / 2;
  const count = Math.ceil((R_OUTER_M - origin) / H_M) + 1;
  const grid = analyticGrid(
    [count, count, 1],
    H_M,
    (i, j) => {
      const r = Math.hypot(origin + i * H_M, origin + j * H_M);
      return r >= R_INNER_M && r <= R_OUTER_M;
    },
    "test-quarter-ring",
    [origin, origin, 0],
  );
  return steelScenario(grid, {
    gravityMPerS2: [0, 0, 0],
    centrifugal: {
      axisPointM: [0, 0, 0],
      axisDirection: [0, 0, 1],
      omegaRadPerS: OMEGA_RAD_PER_S,
    },
    conditions: [
      { kind: "axis-fix", axis: "x", face: "xMin" },
      { kind: "axis-fix", axis: "y", face: "yMin" },
      { kind: "axis-fix", axis: "z", face: "zMin" },
    ],
  });
}

/** The thick-ring plane-stress hoop stress at radius r (free annulus). */
function thickRingHoopPa(radius: number): number {
  const ro = R_OUTER_M ** 2;
  const ri = R_INNER_M ** 2;
  const rhoOmega2 = DENSITY * OMEGA_RAD_PER_S ** 2;
  return (
    ((3 + NU) / 8) *
    rhoOmega2 *
    (ro +
      ri +
      (ro * ri) / radius ** 2 -
      ((1 + 3 * NU) / (3 + NU)) * radius ** 2)
  );
}

describe("centrifugal stress vs the thin-ring closed form", () => {
  it("matches the hoop state at the published bands", () => {
    const run = runStructuralScenario(quarterRingScenario());
    expect(run.ok).toBe(true);
    if (!run.ok) return;
    const report = run.value;

    // The thin-ring headline: mean von Mises over every element vs
    // ρω²R̄² (pinned 1.012, band 0.96–1.06).
    const closed = DENSITY * OMEGA_RAD_PER_S ** 2 * R_MEAN_M ** 2;
    const meanRatio =
      report.vonMisesField.values.reduce((sum, value) => sum + value, 0) /
      (closed * report.grid.elementCount);
    expect(meanRatio).toBeGreaterThan(0.96);
    expect(meanRatio).toBeLessThan(1.06);

    // The thick-ring profile across the interior radius bands. The
    // model is 17 nodes per side — a small reference grid by design
    // (the solver scales; this fixture pins the physics).
    expect(report.grid.elementCount).toBe(68);
    const vm = report.vonMisesField.values;
    const count = report.grid.nx;
    const origin = H_M / 2;
    const byRadius = new Map<number, { sum: number; n: number }>();
    for (let i = 0; i < count; i += 1) {
      for (let j = 0; j < count; j += 1) {
        const value = vm[i + j * count] ?? 0;
        if (value === 0) continue;
        const radiusMm = Math.round(
          Math.hypot(origin + i * H_M, origin + j * H_M) * 1000,
        );
        const bucket = byRadius.get(radiusMm) ?? { sum: 0, n: 0 };
        bucket.sum += value;
        bucket.n += 1;
        byRadius.set(radiusMm, bucket);
      }
    }
    // The interior bands: 27–31 mm.
    for (const [radiusMm, bucket] of byRadius) {
      if (radiusMm < 27 || radiusMm > 31) continue;
      const mean = bucket.sum / bucket.n;
      const closedAtR = thickRingHoopPa(radiusMm / 1000);
      expect(mean / closedAtR).toBeGreaterThan(0.95);
      expect(mean / closedAtR).toBeLessThan(1.15);
    }
    expect(report.solver.relativeResidual).toBeLessThanOrEqual(1e-10);
  }, 120_000);

  it("declines a centrifugal stance with a zero axis direction", () => {
    const scenario = quarterRingScenario();
    const run = runStructuralScenario({
      ...scenario,
      centrifugal: {
        axisPointM: [0, 0, 0],
        axisDirection: [0, 0, 0],
        omegaRadPerS: OMEGA_RAD_PER_S,
      },
    });
    expect(run.ok).toBe(false);
    if (!run.ok) {
      expect(run.error.message).toContain("axis direction");
    }
  });
});
