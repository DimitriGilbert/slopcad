import { describe, expect, it } from "vitest";

import { D2Q9_Q, D2Q9_VELOCITIES, d2q9Equilibrium } from "./d2q9";
import {
  LBM_DEFAULT_MAGIC_LAMBDA,
  lbmCollide,
  lbmRelaxationRates,
} from "./relaxation";
import { createLbmState, lbmComputeMacroscopic } from "./state";

const mask = { nx: 3, ny: 3, solid: new Uint8Array(9) };

describe("collision", () => {
  it("is an exact no-op at equilibrium (both models, bitwise)", () => {
    for (const model of [{ kind: "bgk" } as const, { kind: "trt" } as const]) {
      const state = createLbmState(mask);
      const rates = lbmRelaxationRates(model, 0.9);
      const index = 1 + 1 * 3;
      for (let i = 0; i < D2Q9_Q; i += 1) {
        state.f[i]![index] = d2q9Equilibrium(i, 1.03, 0.04, 0.02);
      }
      // The step order computes macroscopic first; honor it (collision
      // relaxes toward the state's OWN (ρ, u), which must match f).
      expect(lbmComputeMacroscopic(state)).toBe(true);
      const before = state.f.map((column) => column[index]);
      lbmCollide(state, rates);
      // A no-op at storage precision: the stored equilibrium and the
      // recomputed one differ only by f32 rounding, so the relaxation
      // moves nothing beyond that rounding.
      for (let i = 0; i < D2Q9_Q; i += 1) {
        expect(state.f[i]![index]).toBeCloseTo(before[i] ?? 0, 6);
      }
    }
  });

  it("conserves mass and momentum exactly from a nonequilibrium seed (TRT)", () => {
    const state = createLbmState(mask);
    const rates = lbmRelaxationRates({ kind: "trt" }, 0.68);
    const index = 1 + 1 * 3;
    // Perturb two populations away from their shared equilibrium.
    state.f[1]![index] = d2q9Equilibrium(1, 1.0, 0.05, 0) + 0.02;
    state.f[3]![index] = d2q9Equilibrium(3, 1.0, 0.05, 0) - 0.02;
    state.f[5]![index] = d2q9Equilibrium(5, 1.0, 0.05, 0) + 0.01;
    expect(lbmComputeMacroscopic(state)).toBe(true);
    const momentsOf = (): { mass: number; mx: number; my: number } => {
      let mass = 0;
      let mx = 0;
      let my = 0;
      for (let i = 0; i < D2Q9_Q; i += 1) {
        const value = state.f[i]?.[index] ?? 0;
        mass += value;
        mx += value * (D2Q9_VELOCITIES[i]?.[0] ?? 0);
        my += value * (D2Q9_VELOCITIES[i]?.[1] ?? 0);
      }
      return { mass, mx, my };
    };
    const before = momentsOf();
    lbmCollide(state, rates);
    const after = momentsOf();
    // Float32 storage rounding: conservation is exact in f64 arithmetic,
    // the store rounds each population at the ~1e-7 relative level.
    expect(after.mass).toBeCloseTo(before.mass, 7);
    expect(after.mx).toBeCloseTo(before.mx, 7);
    expect(after.my).toBeCloseTo(before.my, 7);
  });

  it("skips solid nodes", () => {
    const solid = new Uint8Array(9);
    solid[4] = 1;
    const state = createLbmState({ nx: 3, ny: 3, solid });
    const rates = lbmRelaxationRates({ kind: "bgk" }, 0.9);
    state.f[0]![4] = 3.25;
    lbmCollide(state, rates);
    expect(state.f[0]![4]).toBe(3.25);
  });

  it("materializes the TRT rates through the magic parameter", () => {
    const rates = lbmRelaxationRates({ kind: "trt" }, 0.8);
    expect(rates.magicLambda).toBe(LBM_DEFAULT_MAGIC_LAMBDA);
    const tauMinus = 1 / rates.lambdaMinus;
    expect((0.8 - 0.5) * (tauMinus - 0.5)).toBeCloseTo(
      LBM_DEFAULT_MAGIC_LAMBDA,
      12,
    );
    expect(lbmRelaxationRates({ kind: "bgk" }, 0.8).lambdaMinus).toBe(
      lbmRelaxationRates({ kind: "bgk" }, 0.8).lambdaPlus,
    );
  });
});
