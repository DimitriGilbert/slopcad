/**
 * The solver discipline pins: residual-driven convergence on a known
 * system, the loud iteration-cap decline (`sim/solver-unconverged`),
 * the insulated-singular-row posture, and the bitwise determinism of
 * repeat solves (law S2).
 */

import { describe, expect, it } from "vitest";
import { SIM_ERROR_CODES } from "@slopcad/sim-core";
import type { ThermalProblem } from "./system";

import { thermalSolidMaterialFromRecord } from "./material";
import { solveThermalSystem } from "./solver";
import { assembleThermalSystem } from "./system";
import { thermalCellGrid } from "./grid";
import { STEEL_WIRE, analyticGrid } from "./fixtures";

/** A 32-cell steel rod along x — the discipline's known system. */
function rodProblem(): ThermalProblem {
  const grid = analyticGrid([32, 1, 1], 0.001, () => true, "rod");
  const classified = thermalCellGrid(grid);
  if (!classified.ok) throw new Error(classified.error.message);
  const steel = thermalSolidMaterialFromRecord(STEEL_WIRE);
  if (!steel.ok) throw new Error(steel.error.message);
  const cells = 32;
  return {
    grid: classified.value,
    conductivityWPerMK: new Float64Array(cells).fill(
      steel.value.thermalConductivityWPerMK,
    ),
    volumetricHeatCapacityJPerM3K: new Float64Array(cells).fill(
      steel.value.volumetricHeatCapacityJPerM3K ?? 1,
    ),
    emissivity: new Float64Array(cells).fill(Number.NaN),
    sourceWPerM3: new Float64Array(cells),
    ambient: undefined,
    faceConditions: {
      xMin: { kind: "fixed-temperature" as const, temperatureK: 500 },
      xMax: { kind: "fixed-temperature" as const, temperatureK: 300 },
    },
    radiationMode: "off" as const,
    radiationReferenceK: 293.15,
  };
}

describe("solveThermalSystem", () => {
  it("converges residual-driven and reports the residual it stopped at", () => {
    const problem = rodProblem();
    const system = assembleThermalSystem(problem, {
      iterateK: new Float64Array(32).fill(293.15),
    });
    const temperature = new Float64Array(32).fill(293.15);
    const solved = solveThermalSystem(system, temperature, undefined, {
      toleranceK: 1e-12,
      maxIterations: 20_000,
    });
    expect(solved.ok).toBe(true);
    if (!solved.ok) return;
    expect(solved.value.iterations).toBeGreaterThan(0);
    expect(solved.value.iterations).toBeLessThan(20_000);
    expect(solved.value.residualK).toBeLessThanOrEqual(1e-12);
  });

  it("declines loudly when the iteration cap is exhausted", () => {
    const problem = rodProblem();
    const system = assembleThermalSystem(problem, {
      iterateK: new Float64Array(32).fill(293.15),
    });
    const solved = solveThermalSystem(
      system,
      new Float64Array(32).fill(293.15),
      undefined,
      { toleranceK: 1e-14, maxIterations: 2 },
    );
    expect(solved.ok).toBe(false);
    if (solved.ok) return;
    expect(solved.error.code).toBe(SIM_ERROR_CODES.solverUnconverged);
    expect(solved.error.message).toContain("iteration cap");
  });

  it("refuses malformed discipline knobs at the door", () => {
    const problem = rodProblem();
    const system = assembleThermalSystem(problem, {
      iterateK: new Float64Array(32).fill(293.15),
    });
    expect(
      solveThermalSystem(system, new Float64Array(32), undefined, {
        toleranceK: 0,
        maxIterations: 100,
      }).ok,
    ).toBe(false);
    expect(
      solveThermalSystem(system, new Float64Array(32), undefined, {
        toleranceK: 1e-10,
        maxIterations: 0,
      }).ok,
    ).toBe(false);
    expect(
      solveThermalSystem(system, new Float64Array(32), undefined, {
        toleranceK: Number.NaN,
        maxIterations: 100,
      }).ok,
    ).toBe(false);
  });

  it("holds insulated singular rows at their value (excluded from the solve)", () => {
    // k = 0 everywhere, no boundary conditions: every row is singular
    // with zero source — the documented posture is "holds its value".
    const grid = analyticGrid([3, 1, 1], 0.001, () => true, "insulated");
    const classified = thermalCellGrid(grid);
    if (!classified.ok) throw new Error(classified.error.message);
    const problem: ThermalProblem = {
      grid: classified.value,
      conductivityWPerMK: new Float64Array(3),
      volumetricHeatCapacityJPerM3K: new Float64Array(3).fill(1),
      emissivity: new Float64Array(3).fill(Number.NaN),
      sourceWPerM3: new Float64Array(3),
      ambient: undefined,
      faceConditions: {},
      radiationMode: "off",
      radiationReferenceK: 293.15,
    };
    const system = assembleThermalSystem(problem, {
      iterateK: new Float64Array(3).fill(400),
    });
    const temperature = new Float64Array(3).fill(400);
    const solved = solveThermalSystem(system, temperature, undefined, {
      toleranceK: 1e-12,
      maxIterations: 10,
    });
    expect(solved.ok).toBe(true);
    if (!solved.ok) return;
    expect([...temperature]).toEqual([400, 400, 400]);
    expect(solved.value.iterations).toBe(0);
  });

  it("is bitwise deterministic on repeat solves from identical starts", () => {
    const problem = rodProblem();
    const first = new Float64Array(32).fill(293.15);
    const second = new Float64Array(32).fill(293.15);
    const system = assembleThermalSystem(problem, {
      iterateK: new Float64Array(32).fill(293.15),
    });
    const a = solveThermalSystem(system, first, undefined, {
      toleranceK: 1e-12,
      maxIterations: 20_000,
    });
    const b = solveThermalSystem(system, second, undefined, {
      toleranceK: 1e-12,
      maxIterations: 20_000,
    });
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.value.iterations).toBe(b.value.iterations);
    // Strict element equality pins bitwise determinism (same code path,
    // same arithmetic — any drift is a discipline violation).
    expect(first.length).toBe(second.length);
    for (let index = 0; index < first.length; index += 1) {
      expect(first[index]).toBe(second[index]);
    }
  });
});
