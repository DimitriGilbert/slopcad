/**
 * Fluid property set tests: the fits vs their published anchor points at
 * the range ends (the Phase 61 validation bullet), the derived Prandtl
 * numbers vs the published values, and the out-of-range decline.
 */

import { describe, expect, it } from "vitest";

import {
  SIM_FLUIDS,
  SIM_FLUID_AIR,
  SIM_FLUID_GLYCOL,
  SIM_FLUID_WATER,
  evaluateSimFluidFit,
  getSimFluid,
  simFluidState,
} from "./fluids";
import { SIM_ERROR_CODES } from "./errors";

function relativeError(actual: number, expected: number): number {
  return Math.abs((actual - expected) / expected);
}

describe("the air fit (1 atm, ideal gas + Sutherland)", () => {
  it("matches the published density at both range ends", () => {
    // ρ = P/(R·T), P = 101325 Pa, R = 287.058 J/(kg·K) (NIST).
    expect(
      relativeError(
        evaluateSimFluidFit(SIM_FLUID_AIR.density, 250),
        1.411909788,
      ),
    ).toBeLessThan(0.001);
    expect(
      relativeError(
        evaluateSimFluidFit(SIM_FLUID_AIR.density, 400),
        0.8824436177,
      ),
    ).toBeLessThan(0.001);
  });

  it("matches the published dynamic viscosity at both range ends", () => {
    // Sutherland's law, μ_ref = 1.716e-5 Pa·s at 273.15 K, S = 110.4 K.
    expect(
      relativeError(
        evaluateSimFluidFit(SIM_FLUID_AIR.dynamicViscosity, 250),
        1.599052394e-5,
      ),
    ).toBeLessThan(0.0001);
    expect(
      relativeError(
        evaluateSimFluidFit(SIM_FLUID_AIR.dynamicViscosity, 400),
        2.2851609e-5,
      ),
    ).toBeLessThan(0.0001);
  });

  it("reproduces the canonical 300 K properties", () => {
    const state = simFluidState(SIM_FLUID_AIR, 300);
    expect(state.ok).toBe(true);
    if (!state.ok) return;
    expect(state.value.densityKgPerM3).toBeCloseTo(1.176472549, 8);
    expect(state.value.dynamicViscosityPaS).toBeCloseTo(1.845921383e-5, 12);
    // Pr(300 K) = 0.706 vs the published 0.707 (Incropera Table A.4).
    expect(state.value.prandtl).toBeCloseTo(0.706, 3);
    expect(state.value.prandtl).toBeGreaterThan(0.7);
    expect(state.value.prandtl).toBeLessThan(0.71);
  });
});

describe("the water fit (saturated liquid tables)", () => {
  it("matches the published density at both range ends", () => {
    // Incropera & DeWitt Table A.6 anchors.
    expect(
      relativeError(
        evaluateSimFluidFit(SIM_FLUID_WATER.density, 283.15),
        999.7,
      ),
    ).toBeLessThan(0.001);
    expect(
      relativeError(
        evaluateSimFluidFit(SIM_FLUID_WATER.density, 363.15),
        965.3,
      ),
    ).toBeLessThan(0.001);
  });

  it("matches the published dynamic viscosity at both range ends", () => {
    expect(
      relativeError(
        evaluateSimFluidFit(SIM_FLUID_WATER.dynamicViscosity, 283.15),
        1.307e-3,
      ),
    ).toBeLessThan(0.005);
    expect(
      relativeError(
        evaluateSimFluidFit(SIM_FLUID_WATER.dynamicViscosity, 363.15),
        3.15e-4,
      ),
    ).toBeLessThan(0.005);
  });

  it("carries the published Prandtl band at 300 K", () => {
    const state = simFluidState(SIM_FLUID_WATER, 300);
    expect(state.ok).toBe(true);
    if (!state.ok) return;
    // Pr(300 K) ≈ 5.85 vs the published ≈ 5.8 (tables: 5.83 at 293.15 K).
    expect(state.value.prandtl).toBeGreaterThan(5.7);
    expect(state.value.prandtl).toBeLessThan(6.0);
  });
});

describe("the ethylene glycol fit (saturated liquid table)", () => {
  it("matches the published anchors at both range ends", () => {
    // Cengel's saturated ethylene glycol table anchors (see fluids.ts).
    expect(
      relativeError(evaluateSimFluidFit(SIM_FLUID_GLYCOL.density, 280), 1121),
    ).toBeLessThan(0.002);
    expect(
      relativeError(evaluateSimFluidFit(SIM_FLUID_GLYCOL.density, 360), 1077),
    ).toBeLessThan(0.002);
    expect(
      relativeError(
        evaluateSimFluidFit(SIM_FLUID_GLYCOL.dynamicViscosity, 280),
        2.83e-2,
      ),
    ).toBeLessThan(0.005);
    expect(
      relativeError(
        evaluateSimFluidFit(SIM_FLUID_GLYCOL.dynamicViscosity, 360),
        3.72e-3,
      ),
    ).toBeLessThan(0.005);
  });

  it("reproduces the table's own Pr column at 300 K", () => {
    const state = simFluidState(SIM_FLUID_GLYCOL, 300);
    expect(state.ok).toBe(true);
    if (!state.ok) return;
    // Pr(300 K) = 151 straight out of the published table.
    expect(state.value.prandtl).toBeCloseTo(151, 0);
  });
});

describe("the fluid registry", () => {
  it("resolves the three starter records by id", () => {
    expect(getSimFluid("air")).toBe(SIM_FLUID_AIR);
    expect(getSimFluid("water")).toBe(SIM_FLUID_WATER);
    expect(getSimFluid("glycol")).toBe(SIM_FLUID_GLYCOL);
    expect(Object.keys(SIM_FLUIDS).sort()).toEqual(["air", "glycol", "water"]);
  });

  it("declines temperatures outside a record's stated range", () => {
    const below = simFluidState(SIM_FLUID_AIR, 249.9);
    expect(below.ok).toBe(false);
    if (below.ok) return;
    expect(below.error.code).toBe(SIM_ERROR_CODES.fluidTemperatureOutOfRange);
    const above = simFluidState(SIM_FLUID_WATER, 363.16);
    expect(above.ok).toBe(false);
    if (above.ok) return;
    expect(above.error.code).toBe(SIM_ERROR_CODES.fluidTemperatureOutOfRange);
  });

  it("accepts the range endpoints themselves", () => {
    expect(simFluidState(SIM_FLUID_AIR, 250).ok).toBe(true);
    expect(simFluidState(SIM_FLUID_AIR, 400).ok).toBe(true);
  });
});
