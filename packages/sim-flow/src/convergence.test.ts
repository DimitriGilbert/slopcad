import { SIM_ERROR_CODES } from "@slopcad/sim-core";
import { describe, expect, it } from "vitest";

import { analyticOccupancy, testFluid } from "./fixtures";
import {
  LBM_GRID_CONVERGENCE_DIRECTION,
  LBM_GRID_CONVERGENCE_REFINEMENT,
} from "./convergence";
import { type LbmRunScenario, runLbmScenario } from "./run";

/**
 * The grid-convergence self-check's fixture (Phase 63b's validation
 * bullet): the 63a static-cylinder wind tunnel run as a factor-2 ladder
 * — the 48×24 coarse grid at dx = 1 mm and its 96×48 refinement at
 * dx = 0.5 mm, the same circle physically (r = 4.5 mm at (16, 11.5) mm)
 * — with the drift reported at matched physical time. The budgets are
 * deliberately compact (600 coarse steps / 1200 fine): the drift is an
 * advisory trust indicator, not a steady-state physics pin, and the
 * assertions hold it to exactly what it claims to be — finite, honestly
 * covered, direction-stated.
 *
 * Lattice design (the 63a fixture's, held fixed across the ladder):
 * u∞ = 0.1 m/s at u_lat = 0.05, ν = 2.7e-5 m²/s → coarse τ⁺ ≈ 0.54,
 * refined τ⁺ ≈ 0.58 (the unit closure doubles ν_lat when dx halves, so
 * the SI viscosity — and with it Re ≈ 33 — is the same on both rungs).
 */

const COARSE_NX = 48;
const COARSE_NY = 24;
const BUDGET = 600;
const WINDOW_START = 300;

function ladderScenario(
  overrides: Partial<LbmRunScenario> = {},
): LbmRunScenario {
  return {
    name: "cylinder-ladder",
    stepper: {
      mask: {
        nx: COARSE_NX,
        ny: COARSE_NY,
        solid: analyticOccupancy(
          COARSE_NX,
          COARSE_NY,
          (x, y) => (x - 16) ** 2 + (y - 11.5) ** 2 <= 4.5 ** 2,
        ),
      },
      fluid: testFluid(1.2, 2.7e-5),
      cellSizeM: 0.001,
      characteristicVelocityMPerS: 0.1,
      collision: { kind: "trt" },
      west: { kind: "velocity-inlet", velocityMPerS: [0.1, 0] },
      east: { kind: "pressure-outlet", pressurePa: 0 },
      south: { kind: "wall", slip: false },
      north: { kind: "wall", slip: false },
    },
    stepBudget: BUDGET,
    characteristicLengthM: 0.009,
    averaging: { startStep: WINDOW_START },
    gridConvergence: {
      refinedMask: {
        nx: 2 * COARSE_NX,
        ny: 2 * COARSE_NY,
        solid: analyticOccupancy(
          2 * COARSE_NX,
          2 * COARSE_NY,
          (x, y) => (x - 32) ** 2 + (y - 23) ** 2 <= 9 ** 2,
        ),
      },
    },
    ...overrides,
  };
}

describe("the grid-convergence self-check", () => {
  it("reports the cylinder ladder's drift at matched physical time", () => {
    const run = runLbmScenario(ladderScenario());
    expect(run.ok).toBe(true);
    if (!run.ok) throw new Error(run.error.message);
    const { convergence } = run.value;
    expect(convergence).toBeDefined();
    if (convergence === undefined) throw new Error("unreachable: checked");

    // The ladder's shape: factor 2, exactly twice the steps and window.
    expect(convergence.refinementFactor).toBe(LBM_GRID_CONVERGENCE_REFINEMENT);
    expect(convergence.coarse.nx).toBe(COARSE_NX);
    expect(convergence.coarse.ny).toBe(COARSE_NY);
    expect(convergence.coarse.cellSizeM).toBe(0.001);
    expect(convergence.coarse.completedSteps).toBe(BUDGET);
    expect(convergence.coarse.averagingWindowSteps).toBe(
      BUDGET - WINDOW_START + 1,
    );
    expect(convergence.fine.nx).toBe(2 * COARSE_NX);
    expect(convergence.fine.ny).toBe(2 * COARSE_NY);
    expect(convergence.fine.cellSizeM).toBeCloseTo(0.0005, 12);
    expect(convergence.fine.completedSteps).toBe(2 * BUDGET);
    expect(convergence.fine.averagingWindowSteps).toBe(
      // [2·startStep, 2·budget] — both endpoints doubled, so one sample
      // more than twice the coarse count (2·(b−a)+1), the matched
      // physical window [t_start, t_end] inclusive.
      2 * (BUDGET - WINDOW_START) + 1,
    );

    // Matched physical time: both rungs end (and average to) the same
    // instant — the unit closure halves dt when dx halves, so exactly
    // twice the fine steps is the same duration, to rounding.
    expect(convergence.coarse.physicalDurationS).toBeGreaterThan(0);
    expect(convergence.fine.physicalDurationS).toBeCloseTo(
      convergence.coarse.physicalDurationS,
      9,
    );

    // Integrated-quantity drift: finite, a fraction of the pair's force
    // scale, both rungs carrying positive window-mean drag.
    for (const drift of [convergence.dragDrift, convergence.liftDrift]) {
      expect(Number.isFinite(drift.coarseNPerM)).toBe(true);
      expect(Number.isFinite(drift.fineNPerM)).toBe(true);
      expect(Number.isFinite(drift.relative)).toBe(true);
      expect(Math.abs(drift.relative)).toBeLessThan(1);
    }
    expect(convergence.dragDrift.coarseNPerM).toBeGreaterThan(0);
    expect(convergence.dragDrift.fineNPerM).toBeGreaterThan(0);

    // Field-level drift: honestly covered (the staircase blocks only the
    // body's rim nodes from comparison) and strictly positive — the two
    // resolutions genuinely differ.
    expect(convergence.fieldDrift.comparedNodes).toBeGreaterThan(0);
    expect(convergence.fieldDrift.coverage).toBeGreaterThan(0.8);
    expect(convergence.fieldDrift.coverage).toBeLessThanOrEqual(1);
    expect(convergence.fieldDrift.l2Relative).toBeGreaterThan(0);
    expect(convergence.fieldDrift.l2Relative).toBeLessThan(1);
    expect(convergence.fieldDrift.linfRelative).toBeGreaterThan(0);

    // The direction is stated, not implied — the dissipation-vs-
    // refinement expectation the prior art taught the report to carry.
    expect(convergence.direction).toBe(LBM_GRID_CONVERGENCE_DIRECTION);
    expect(convergence.direction).toContain("over-dissipates");
    expect(convergence.direction).toContain("refinement");
    // Timeout budget: the two-rung ladder (600 coarse + 1200 fine
    // steps) measures ≈ 9.6 s isolated; the full gate's parallel CPU
    // contention multiplied this package's fixtures by up to 6.7×
    // (measured worst: 7.5 s → 50.6 s), putting this run's worst case
    // at ≈ 64 s against the 20 s shared default. 120 s is ≈ 1.9× that
    // worst case — an infrastructure budget, not an assertion.
  }, 120_000);

  it("declines a refined mask that is not a factor-2 ladder", () => {
    const run = runLbmScenario(
      ladderScenario({
        gridConvergence: {
          refinedMask: {
            nx: 2 * COARSE_NX,
            ny: COARSE_NY + 1,
            solid: new Uint8Array(2 * COARSE_NX * (COARSE_NY + 1)),
          },
        },
      }),
    );
    expect(run.ok).toBe(false);
    if (!run.ok) {
      expect(run.error.code).toBe(SIM_ERROR_CODES.scenarioInvalid);
      expect(run.error.message).toContain("ladder");
    }
  });

  it("declines the self-check without an averaging window to match on", () => {
    const { averaging, ...rest } = ladderScenario();
    expect(averaging).toBeDefined();
    const run = runLbmScenario(rest);
    expect(run.ok).toBe(false);
    if (!run.ok) {
      expect(run.error.message).toContain("averaging window");
    }
  });
});
