/**
 * Regime-honesty tests (law S9): the dimensionless formulas against
 * hand-computed values and the advisory flags against the published
 * thresholds.
 */

import { describe, expect, it } from "vitest";

import {
  SIM_REGIME_THRESHOLDS,
  simMach,
  simPrandtl,
  simRayleigh,
  simRegimeReport,
  simReynolds,
} from "./regime";

describe("the dimensionless formulas", () => {
  it("computes Reynolds by ρ·V·L/μ", () => {
    // Hand: 1.176472549 · 10 · 0.5 / 1.845921383e-5 = 318668.1079
    expect(simReynolds(1.176472549, 10, 0.5, 1.845921383e-5)).toBeCloseTo(
      318668.107926,
      4,
    );
  });

  it("computes Mach by V/c", () => {
    expect(simMach(10, 347.2)).toBeCloseTo(0.028801843318, 10);
  });

  it("computes Prandtl by μ·cp/k", () => {
    expect(simPrandtl(1.845921383e-5, 1006, 0.0263)).toBeCloseTo(
      0.706082475779,
      10,
    );
  });

  it("computes Rayleigh by g·β·ΔT·L³/(ν·α)", () => {
    // Hand (water at 300 K, ΔT = 40 K, L = 0.1 m, g = 9.80665):
    // ν = 8.536994474e-4/996.3025974, α = 0.61/(996.3025974·4179)
    expect(
      simRayleigh(9.80665, 2.75e-4, 40, 0.1, 8.56867632e-7, 1.4650964e-7),
    ).toBeCloseTo(859277463.63, 0);
  });
});

describe("the advisory flags", () => {
  it("flags turbulence-dominated above the internal-flow threshold", () => {
    const flagged = simRegimeReport({
      reynolds: SIM_REGIME_THRESHOLDS.turbulentReynolds + 1,
    });
    expect(flagged.qualitative).toEqual(["turbulence-dominated"]);
    const calm = simRegimeReport({
      reynolds: SIM_REGIME_THRESHOLDS.turbulentReynolds,
    });
    expect(calm.qualitative).toEqual([]);
  });

  it("flags compressibility-affected above Ma 0.3", () => {
    const flagged = simRegimeReport({ mach: 0.31 });
    expect(flagged.qualitative).toEqual(["compressibility-affected"]);
    expect(simRegimeReport({ mach: 0.3 }).qualitative).toEqual([]);
  });

  it("flags buoyancy-driven above the turbulent-convection Ra band", () => {
    const flagged = simRegimeReport({ rayleigh: 1.1e9 });
    expect(flagged.qualitative).toEqual(["buoyancy-driven"]);
    expect(simRegimeReport({ rayleigh: 1e9 }).qualitative).toEqual([]);
  });

  it("carries every number it was given and omits the rest", () => {
    const report = simRegimeReport({
      reynolds: 100,
      prandtl: 0.7,
    });
    expect(report).toEqual({
      reynolds: 100,
      prandtl: 0.7,
      qualitative: [],
    });
    expect("mach" in report).toBe(false);
    expect("rayleigh" in report).toBe(false);
  });
});
