/**
 * The self-weight sag validation (Phase 69): the same cantilever under
 * its own weight through the Phase 61 gravity vector, vs the
 * Euler–Bernoulli distributed-load sag wL⁴/8EI — where the staircase
 * permits (the roadmap's own caveat), at a published band.
 *
 * Measured (2026-10-13, steel, L = 100 mm, d = w = 10 mm, 4 cells per
 * depth): ratio = 0.9665 of wL⁴/8EI — the same shear-locking band the
 * tip-load ladder shows, pinned with headroom.
 */

import { describe, expect, it } from "vitest";

import { runStructuralScenario } from "./run";
import { boxGrid, steelScenario } from "./fixtures";

const E_PA = 210e9;
const LENGTH_M = 0.1;
const DEPTH_M = 0.01;
const WIDTH_M = 0.01;

describe("self-weight sag vs beam theory", () => {
  it("lands inside the published band under the default gravity", () => {
    const grid = boxGrid(40, 4, 4, 0.0025);
    // No conditions beyond the root fixture: self-weight rides the
    // scenario default gravity (−Y standard gravity, the 61a default).
    const scenario = steelScenario(grid, {
      conditions: [{ kind: "fixed-support", face: "xMin" }],
    });
    const run = runStructuralScenario(scenario);
    expect(run.ok).toBe(true);
    if (!run.ok) return;
    const report = run.value;
    const inertia = (WIDTH_M * DEPTH_M ** 3) / 12;
    const weightPerLength = 7850 * 9.80665 * WIDTH_M * DEPTH_M;
    const sag = (weightPerLength * LENGTH_M ** 4) / (8 * E_PA * inertia);
    const ratio = report.maxDeflectionM / sag;
    // Pinned 0.9665 with headroom: the coarse-voxel band.
    expect(ratio).toBeGreaterThan(0.95);
    expect(ratio).toBeLessThan(0.985);
  }, 60_000);

  it("respects an authored zero-gravity vector (no self-weight)", () => {
    const grid = boxGrid(20, 3, 3, 0.005 / 3);
    const scenario = steelScenario(grid, {
      gravityMPerS2: [0, 0, 0],
      conditions: [{ kind: "fixed-support", face: "xMin" }],
    });
    const run = runStructuralScenario(scenario);
    expect(run.ok).toBe(true);
    if (!run.ok) return;
    // No loads at all: the zero-load early exit, u = 0 everywhere.
    expect(run.value.maxDeflectionM).toBe(0);
    expect(run.value.solver.iterations).toBe(0);
    expect(run.value.vonMisesMaxPa).toBe(0);
  }, 60_000);
});
