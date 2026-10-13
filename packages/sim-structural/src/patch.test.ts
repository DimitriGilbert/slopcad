/**
 * THE PATCH TEST (Phase 69's validation block, verbatim): a
 * constant-strain field reproduced EXACTLY — first-order hexahedra must
 * pass, and this suite pins it to the solver discipline's floor.
 *
 * The construction: symmetry rollers (`axis-fix`) on the three min
 * faces mirror the bar into an infinite medium, and a uniform pressure
 * on the max face closes a uniform uniaxial stress state — the exact
 * solution is representable in the trilinear space, every quadrature
 * is exact, and the recovered center strain of EVERY element (not just
 * the interior) equals ε = −p/E to the CG residual discipline's floor
 * (2×2×2 Gauss is exact for every integrand; the remaining error is
 * the iterative discipline's, measured here ~1e-11 relative — pinned
 * three orders above it).
 */

import { describe, expect, it } from "vitest";

import { runStructuralScenario } from "./run";
import { analyticGrid, steelScenario } from "./fixtures";

const H = 0.005;
const PRESSURE_PA = 1e6;
const EXPECTED_STRAIN = PRESSURE_PA / 210e9;

/** The patch bar: rollers on the min faces, uniform pressure on xMax. */
function patchScenario(cellsPerAxis = 4) {
  const grid = analyticGrid(
    [cellsPerAxis, cellsPerAxis, cellsPerAxis],
    H,
    () => true,
    "test-patch",
    [H / 2, H / 2, H / 2],
  );
  return steelScenario(grid, {
    gravityMPerS2: [0, 0, 0],
    conditions: [
      { kind: "axis-fix", axis: "x", face: "xMin" },
      { kind: "axis-fix", axis: "y", face: "yMin" },
      { kind: "axis-fix", axis: "z", face: "zMin" },
      { kind: "pressure-load", face: "xMax", pressurePa: PRESSURE_PA },
    ],
  });
}

describe("the patch test (constant strain reproduced exactly)", () => {
  it("recovers the exact uniaxial stress state in every element", () => {
    const run = runStructuralScenario(patchScenario());
    expect(run.ok).toBe(true);
    if (!run.ok) return;
    const report = run.value;
    // The discipline drove to its floor.
    expect(report.solver.relativeResidual).toBeLessThanOrEqual(1e-10);
    // EVERY element's von Mises equals the pressure exactly (the state
    // is pure uniaxial stress, σ = −p) — pinned to 1e-9 relative,
    // three orders above the measured 2e-11 floor.
    let worst = 0;
    for (const value of report.vonMisesField.values) {
      if (value === 0) continue;
      worst = Math.max(worst, Math.abs(value / PRESSURE_PA - 1));
    }
    expect(worst).toBeLessThanOrEqual(1e-9);
    expect(report.vonMisesMaxPa / PRESSURE_PA - 1).toBeLessThanOrEqual(1e-9);
  }, 60_000);

  it("reproduces the linear displacement field on the node lattice", () => {
    // The exact field: u_x = −ε·x, u_y = +νε·y, u_z = +νε·z (x measured
    // from the mirror plane). The element-center magnitude at grid node
    // (i, j, k) is ε·sqrt(x² + (νy)² + (νz)²) with x = origin + i·h.
    const cells = 4;
    const run = runStructuralScenario(patchScenario(cells));
    expect(run.ok).toBe(true);
    if (!run.ok) return;
    const displacement = run.value.displacementField.values;
    const nu = 0.3;
    let worst = 0;
    for (let k = 0; k < cells; k += 1) {
      for (let j = 0; j < cells; j += 1) {
        for (let i = 0; i < cells; i += 1) {
          const index = i + j * cells + k * cells * cells;
          const x = H / 2 + i * H;
          const y = H / 2 + j * H;
          const z = H / 2 + k * H;
          const expected = EXPECTED_STRAIN * Math.hypot(x, nu * y, nu * z);
          worst = Math.max(
            worst,
            Math.abs((displacement[index] ?? 0) / expected - 1),
          );
        }
      }
    }
    expect(worst).toBeLessThanOrEqual(1e-9);
  }, 60_000);

  it("passes on the single element — the element IS the patch", () => {
    const run = runStructuralScenario(patchScenario(1));
    expect(run.ok).toBe(true);
    if (!run.ok) return;
    const value = run.value.vonMisesField.values[0] ?? 0;
    expect(Math.abs(value / PRESSURE_PA - 1)).toBeLessThanOrEqual(1e-9);
  });

  it("is independent of grid resolution — the patch property", () => {
    // 2, 3, and 5 cells per axis: identical constant strain. The patch
    // test has no convergence band — it is exact at every resolution.
    for (const cells of [2, 3, 5]) {
      const run = runStructuralScenario(patchScenario(cells));
      expect(run.ok).toBe(true);
      if (!run.ok) continue;
      for (const value of run.value.vonMisesField.values) {
        if (value === 0) continue;
        expect(Math.abs(value / PRESSURE_PA - 1)).toBeLessThanOrEqual(1e-9);
      }
    }
  }, 60_000);
});
