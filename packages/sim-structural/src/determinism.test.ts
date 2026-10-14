/**
 * Bitwise determinism (Phase 69, law S2): the same scenario produces
 * the bitwise-identical report — every field value, every scalar, the
 * snapshot hash — and the SimResult seam projects identically. No
 * clock, no randomness, fixed iteration discipline: pure sequential
 * float64 arithmetic over a fixed assembly order.
 */

import { describe, expect, it } from "vitest";
import type { StructuralRunReport } from "./run";

import { runStructuralScenario, structuralRunSimResult } from "./run";
import { boxGrid, steelScenario } from "./fixtures";

function loadedScenario() {
  const grid = boxGrid(12, 3, 3, 0.005);
  const thermal = new Float64Array(grid.cells.length);
  for (let i = 0; i < thermal.length; i += 1) {
    thermal[i] = i % 7 === 0 ? 30 : 10;
  }
  return steelScenario(grid, {
    thermalDeltaTK: thermal,
    conditions: [
      { kind: "fixed-support", face: "xMin" },
      { kind: "force-load", face: "xMax", forceN: [0, -80, 0] },
    ],
  });
}

/** Field-by-field bitwise equality (NaN-safe by construction: finite). */
function expectIdenticalReports(
  first: StructuralRunReport,
  second: StructuralRunReport,
): void {
  expect(second.scenarioSnapshotHash).toBe(first.scenarioSnapshotHash);
  expect(second.maxDeflectionM).toBe(first.maxDeflectionM);
  expect(second.vonMisesMaxPa).toBe(first.vonMisesMaxPa);
  expect(second.factorOfSafety).toBe(first.factorOfSafety);
  expect(second.solver.iterations).toBe(first.solver.iterations);
  expect(second.solver.relativeResidual).toBe(first.solver.relativeResidual);
  expect(second.grid.elementCount).toBe(first.grid.elementCount);
  for (const [a, b] of [
    [first.displacementField.values, second.displacementField.values],
    [first.vonMisesField.values, second.vonMisesField.values],
  ] as const) {
    expect(b).toHaveLength(a.length);
    for (let index = 0; index < a.length; index += 1) {
      expect(b[index]).toBe(a[index]);
    }
  }
  for (const [a, b] of [
    [first.materialSafety, second.materialSafety],
  ] as const) {
    expect(b).toEqual(a);
  }
}

describe("bitwise determinism of repeat runs", () => {
  it("reproduces the combined-load run bitwise-identically", () => {
    const first = runStructuralScenario(loadedScenario());
    const second = runStructuralScenario(loadedScenario());
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expectIdenticalReports(first.value, second.value);
  }, 60_000);

  it("projects the repeated runs to identical SimResults", () => {
    const firstRun = runStructuralScenario(loadedScenario());
    const secondRun = runStructuralScenario(loadedScenario());
    expect(firstRun.ok).toBe(true);
    expect(secondRun.ok).toBe(true);
    if (!firstRun.ok || !secondRun.ok) return;
    const first = structuralRunSimResult(firstRun.value);
    const second = structuralRunSimResult(secondRun.value);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(JSON.stringify(second.value.summary.quantities)).toBe(
      JSON.stringify(first.value.summary.quantities),
    );
    expect(JSON.stringify(second.value.fields)).toBe(
      JSON.stringify(first.value.fields),
    );
  }, 60_000);

  it("hashes the standalone scenario identity stably", () => {
    const firstRun = runStructuralScenario(loadedScenario());
    const secondRun = runStructuralScenario(loadedScenario());
    expect(firstRun.ok).toBe(true);
    expect(secondRun.ok).toBe(true);
    if (!firstRun.ok || !secondRun.ok) return;
    expect(firstRun.value.scenarioSnapshotHash).toBe(
      secondRun.value.scenarioSnapshotHash,
    );
  }, 60_000);
});
