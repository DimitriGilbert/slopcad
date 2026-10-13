/**
 * The cantilever validation block (Phase 69): tip deflection vs
 * Euler–Bernoulli beam theory at a stated coarseness, and the
 * CONVERGENCE BAND — deflection vs grid resolution, published as a
 * pinned table, not hidden. The band's shape is the known behavior of
 * fully-integrated first-order hexahedra in bending: shear locking
 * undershoots beam theory at coarse resolution and releases
 * monotonically as cells-per-depth grows, converging toward the
 * Timoshenko-corrected continuum answer (≈ 1.008 of Euler–Bernoulli at
 * this aspect ratio — the ceiling, never exceeded materially).
 *
 * The pinned table (measured 2026-10-13, steel, L = 100 mm,
 * d = w = 10 mm, F = 100 N, ratio = FEM max deflection / FL³/3EI):
 *
 *   cells per depth   free dofs   ratio
 *   2                 540         0.8784
 *   3                 1440        0.9425
 *   4                 3000        0.9677
 *   5                 5400        0.9801
 *   6                 8820        0.9870
 *
 * The fixture asserts each rung within ±0.012 of its pinned value AND
 * the monotone release — the published band.
 */

import { describe, expect, it } from "vitest";
import type { StructuralRunScenario } from "./run";

import { runStructuralScenario, structuralRunSimResult } from "./run";
import { STEEL_WIRE } from "./fixtures";
import { boxGrid, steelScenario } from "./fixtures";

const E_PA = 210e9;
const LENGTH_M = 0.1;
const DEPTH_M = 0.01;
const WIDTH_M = 0.01;
const FORCE_N = 100;

function beamTheoryDeflectionM(): number {
  const inertia = (WIDTH_M * DEPTH_M ** 3) / 12;
  return (FORCE_N * LENGTH_M ** 3) / (3 * E_PA * inertia);
}

/** A cantilever at n cells per depth, L/d = 10, tip force −Y. */
function cantileverScenario(cellsPerDepth: number): StructuralRunScenario {
  const h = DEPTH_M / cellsPerDepth;
  const cellsLong = Math.round(LENGTH_M / h);
  const grid = boxGrid(cellsLong, cellsPerDepth, cellsPerDepth, h);
  return steelScenario(grid, {
    gravityMPerS2: [0, 0, 0],
    conditions: [
      { kind: "fixed-support", face: "xMin" },
      { kind: "force-load", face: "xMax", forceN: [0, -FORCE_N, 0] },
    ],
  });
}

describe("cantilever tip deflection vs beam theory", () => {
  it("lands inside the published band at 4 cells per depth", () => {
    const run = runStructuralScenario(cantileverScenario(4));
    expect(run.ok).toBe(true);
    if (!run.ok) return;
    const report = run.value;
    const ratio = report.maxDeflectionM / beamTheoryDeflectionM();
    // The pinned rung (0.9677) with headroom for platform float
    // variation: the coarse-voxel coarseness stated, not hidden.
    expect(ratio).toBeGreaterThan(0.95);
    expect(ratio).toBeLessThan(0.99);
    expect(report.solver.relativeResidual).toBeLessThanOrEqual(1e-10);
  }, 60_000);

  it("publishes the convergence band: deflection vs resolution, monotone", () => {
    const pinned: readonly [number, number, number][] = [
      // [cells per depth, free dofs, pinned ratio]
      [2, 540, 0.8784],
      [3, 1440, 0.9425],
      [4, 3000, 0.9677],
      [5, 5400, 0.9801],
      [6, 8820, 0.987],
    ];
    let previous = 0;
    for (const [cellsPerDepth, expectedDofs, pinnedRatio] of pinned) {
      const run = runStructuralScenario(cantileverScenario(cellsPerDepth));
      expect(run.ok).toBe(true);
      if (!run.ok) continue;
      const report = run.value;
      expect(report.grid.freeDofCount).toBe(expectedDofs);
      const ratio = report.maxDeflectionM / beamTheoryDeflectionM();
      expect(Math.abs(ratio - pinnedRatio)).toBeLessThanOrEqual(0.012);
      // The band's published shape: monotone release toward the
      // continuum ceiling (never past it materially).
      expect(ratio).toBeGreaterThan(previous);
      expect(ratio).toBeLessThan(1.02);
      previous = ratio;
    }
  }, 240_000);

  it("projects the summary scalars and fields through the S4 seam", () => {
    const run = runStructuralScenario(cantileverScenario(3));
    expect(run.ok).toBe(true);
    if (!run.ok) return;
    const result = structuralRunSimResult(run.value);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const summary = result.value.summary;
    expect(summary.status).toBe("completed");
    expect(summary.servedBackend).toBe("cpu");
    const byName = new Map(
      summary.quantities.map((quantity) => [quantity.name, quantity]),
    );
    const deflection = byName.get("max-deflection");
    expect(deflection?.unit).toBe("mm");
    expect(deflection?.value).toBeCloseTo(run.value.maxDeflectionM * 1000, 6);
    const vonMises = byName.get("von-mises-max");
    expect(vonMises?.unit).toBe("Pa");
    expect(vonMises?.value).toBe(run.value.vonMisesMaxPa);
    const factor = byName.get("factor-of-safety");
    expect(factor?.unit).toBe("1");
    expect(factor?.value).toBe(run.value.factorOfSafety);
    // The fields: displacement magnitude in mm, von Mises in Pa, on the
    // grid lattice.
    expect(result.value.fields.map((field) => field.id)).toEqual([
      "displacement",
      "von-mises",
    ]);
    const displacement = result.value.fields[0];
    expect(displacement?.unit).toBe("mm");
    expect(displacement?.spacingMm?.[0]).toBeCloseTo(10 / 3, 9);
    expect(displacement?.values).toHaveLength(30 * 3 * 3);
    expect(result.value.histories).toEqual([]);
  }, 60_000);
});

describe("the FoS arithmetic vs hand calculation", () => {
  it("divides the yield strength by the max von Mises exactly", () => {
    const run = runStructuralScenario(cantileverScenario(2));
    expect(run.ok).toBe(true);
    if (!run.ok) return;
    const report = run.value;
    const hand = (STEEL_WIRE.yieldStrengthPa ?? 0) / report.vonMisesMaxPa;
    expect(report.factorOfSafety).toBe(hand);
    // The per-material view carries the same arithmetic.
    const entry = report.materialSafety[0];
    expect(entry?.materialId).toBe("mat_steel");
    expect(entry?.vonMisesMaxPa).toBe(report.vonMisesMaxPa);
    expect(entry?.factorOfSafety).toBe(hand);
    // Both directions of the hand check.
    expect(report.vonMisesMaxPa * (report.factorOfSafety ?? 0)).toBeCloseTo(
      STEEL_WIRE.yieldStrengthPa ?? 0,
      6,
    );
  }, 60_000);

  it("withholds the scalar when the record carries no yield strength", () => {
    const scenario = cantileverScenario(2);
    const stripped = {
      ...scenario,
      materials: scenario.materials.map((material) => {
        const { yieldStrengthPa, ...rest } = material;
        void yieldStrengthPa;
        return rest;
      }),
    };
    const run = runStructuralScenario(stripped);
    expect(run.ok).toBe(true);
    if (!run.ok) return;
    expect(run.value.factorOfSafety).toBeUndefined();
    expect(run.value.materialSafety).toEqual([]);
    const result = structuralRunSimResult(run.value);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(
      result.value.summary.quantities.some(
        (quantity) => quantity.name === "factor-of-safety",
      ),
    ).toBe(false);
  }, 60_000);
});
