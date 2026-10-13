/**
 * The uniform thermal-expansion validation (Phase 69, the CHT→structural
 * chaining seam): a constrained bar (σ = EαΔT restrained, zero axial
 * displacement) and the free-thermal case (zero stress, free
 * expansion) — both
 * against the closed forms, at published bands.
 *
 * Measured (2026-10-13, steel, 200×10×10 mm bar, ΔT = +50 K):
 *
 * - CONSTRAINED (both end faces fully fixed): the mid-length cells'
 *   mean von Mises = 1.0244·EαΔT — the clamped faces' Poisson boundary
 *   layer (the ends want ναΔT of lateral motion the full fixture
 *   forbids) decays over ~2 diameters; the band is pinned 1.01–1.04
 *   and the symmetric halves agree. The axial displacement is zero;
 *   the residual |u| is exactly the Poisson-coupled lateral bulge
 *   s·(w/2 + h/2) with s = αΔT(1 + λ/(2λ+2G)) — pinned to 2%.
 *
 * - FREE (one end fixed): the tip displacement is the free elongation
 *   αΔT·(L + h) over the meshed bar (L plus the half-cell fringe the
 *   node-centered interpretation implies), 0.985 of it at this aspect
 *   (the clamped root's boundary layer holds back ~1.5% — the same
 *   over-restraint the constrained case documents), zero hoop stress
 *   in the interior.
 */

import { describe, expect, it } from "vitest";

import { runStructuralScenario } from "./run";
import { boxGrid, steelScenario } from "./fixtures";

const E_PA = 210e9;
const NU = 0.3;
const ALPHA_PER_K = 1.2e-5;
const DELTA_T_K = 50;
const CELL_M = 0.005;
const CELLS_LONG = 40;
const BAR_LENGTH_M = CELLS_LONG * CELL_M;

/** The Lamé first parameter, for the lateral-bulge closed form. */
function laméFirst(): number {
  return (E_PA * NU) / ((1 + NU) * (1 - 2 * NU));
}

function thermalBarScenario(freeEnd: boolean) {
  const grid = boxGrid(CELLS_LONG, 2, 2, CELL_M);
  const thermal = new Float64Array(grid.cells.length).fill(DELTA_T_K);
  return steelScenario(grid, {
    gravityMPerS2: [0, 0, 0],
    thermalDeltaTK: thermal,
    conditions: [
      { kind: "fixed-support", face: "xMin" },
      ...(freeEnd
        ? []
        : [{ kind: "fixed-support" as const, face: "xMax" as const }]),
    ],
  });
}

/** The mean von Mises of the four cells around quarter-position `at`. */
function quarterCellStressPa(values: readonly number[], at: number): number {
  let sum = 0;
  for (const i of [at, at + 1]) {
    for (let j = 0; j < 2; j += 1) {
      for (let k = 0; k < 2; k += 1) {
        sum += values[i + j * CELLS_LONG + k * CELLS_LONG * 2] ?? 0;
      }
    }
  }
  return sum / 8;
}

/** The mean von Mises of the two centre x-cells. */
function centreCellStressPa(values: readonly number[]): number {
  const mid = CELLS_LONG / 2;
  let sum = 0;
  for (const i of [mid - 1, mid]) {
    for (let j = 0; j < 2; j += 1) {
      for (let k = 0; k < 2; k += 1) {
        sum += values[i + j * CELLS_LONG + k * CELLS_LONG * 2] ?? 0;
      }
    }
  }
  return sum / 8;
}

describe("uniform thermal expansion of a constrained bar", () => {
  it("carries σ = EαΔT in the interior at the published band", () => {
    const run = runStructuralScenario(thermalBarScenario(false));
    expect(run.ok).toBe(true);
    if (!run.ok) return;
    const report = run.value;
    const closed = E_PA * ALPHA_PER_K * DELTA_T_K;
    const centre = centreCellStressPa(report.vonMisesField.values) / closed;
    // The clamped-face boundary layer: pinned 1.01–1.04.
    expect(centre).toBeGreaterThan(1.01);
    expect(centre).toBeLessThan(1.04);
    // The clamped ends' boundary layers mirror each other: the cells
    // beside each end face carry the same mean stress.
    const firstEnd = quarterCellStressPa(report.vonMisesField.values, 0);
    const lastEnd = quarterCellStressPa(
      report.vonMisesField.values,
      CELLS_LONG - 2,
    );
    expect(Math.abs(firstEnd / lastEnd - 1)).toBeLessThan(0.01);
    // The residual displacement is the Poisson lateral bulge, not axial
    // motion: s·(w/2 + h/2), s = αΔT·(1 + λ/(2(λ+G))).
    const shear = E_PA / (2 * (1 + NU));
    const lambda = laméFirst();
    const s = ALPHA_PER_K * DELTA_T_K * (1 + lambda / (2 * (lambda + shear)));
    const bulge = s * (0.01 / 2 + CELL_M / 2);
    expect(report.maxDeflectionM / bulge).toBeGreaterThan(0.97);
    expect(report.maxDeflectionM / bulge).toBeLessThan(1.02);
    // The clamped corners carry the triaxial overshoot — the max is
    // ABOVE the closed form (the boundary layer's signature), bounded.
    expect(report.vonMisesMaxPa / closed).toBeGreaterThan(1.0);
    expect(report.vonMisesMaxPa / closed).toBeLessThan(1.6);
  }, 120_000);
});

describe("the free-thermal case (zero stress, free expansion)", () => {
  it("elongates exactly and carries no interior stress", () => {
    const run = runStructuralScenario(thermalBarScenario(true));
    expect(run.ok).toBe(true);
    if (!run.ok) return;
    const report = run.value;
    // The meshed bar spans L + h (the half-cell fringe both ends); the
    // fixed face sits at −h/2, the free corners at L + h/2.
    const elongation = ALPHA_PER_K * DELTA_T_K * (BAR_LENGTH_M + CELL_M);
    const ratio = report.maxDeflectionM / elongation;
    // The clamped root's boundary layer holds back ~1.5% at this
    // aspect (measured 0.9853): the published band.
    expect(ratio).toBeGreaterThan(0.98);
    expect(ratio).toBeLessThan(0.995);
    // Interior cells (quarter length, away from the clamped root)
    // carry ~zero stress: the clamped-root layer is the only stressed
    // region in a freely expanding bar.
    const vm = report.vonMisesField.values;
    let interiorMax = 0;
    for (let i = 8; i < 32; i += 1) {
      for (let j = 0; j < 2; j += 1) {
        for (let k = 0; k < 2; k += 1) {
          interiorMax = Math.max(
            interiorMax,
            vm[i + j * CELLS_LONG + k * CELLS_LONG * 2] ?? 0,
          );
        }
      }
    }
    expect(interiorMax).toBeLessThan(0.02 * E_PA * ALPHA_PER_K * DELTA_T_K);
  }, 120_000);
});
