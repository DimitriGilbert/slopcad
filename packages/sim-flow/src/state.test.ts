import { describe, expect, it } from "vitest";

import { D2Q9_Q, d2q9Equilibrium } from "./d2q9";
import {
  createLbmState,
  lbmComputeMacroscopic,
  lbmReflectSolids,
  lbmTotalMomentum,
} from "./state";

const emptyMask = { nx: 5, ny: 5, solid: new Uint8Array(25) };

describe("the SoA state", () => {
  it("creates at the rest equilibrium (ρ = 1, u = 0, zero momentum)", () => {
    const state = createLbmState(emptyMask);
    expect(state.f.length).toBe(D2Q9_Q);
    expect(state.fTmp.length).toBe(D2Q9_Q);
    for (let i = 0; i < D2Q9_Q; i += 1) {
      expect(state.f[i]?.length).toBe(25);
      expect(state.f[i]?.[7]).toBeCloseTo(d2q9Equilibrium(i, 1, 0, 0), 6);
    }
    expect(lbmTotalMomentum(state)).toEqual({ x: 0, y: 0 });
    expect(lbmComputeMacroscopic(state)).toBe(true);
    expect(state.rho[12]).toBeCloseTo(1, 6);
    expect(state.ux[12]).toBe(0);
    expect(state.uy[12]).toBe(0);
  });

  it("computes macroscopic density and velocity from the distributions", () => {
    const state = createLbmState(emptyMask);
    const index = 2 + 3 * 5;
    // Seed a moving state through its exact equilibrium, then read it back.
    for (let i = 0; i < D2Q9_Q; i += 1) {
      state.f[i]![index] = d2q9Equilibrium(i, 1.05, 0.04, -0.02);
    }
    expect(lbmComputeMacroscopic(state)).toBe(true);
    expect(state.rho[index]).toBeCloseTo(1.05, 6);
    expect(state.ux[index]).toBeCloseTo(0.04, 6);
    expect(state.uy[index]).toBeCloseTo(-0.02, 6);
  });

  it("flags divergence on non-finite density instead of fabricating fields", () => {
    const state = createLbmState(emptyMask);
    state.f[0]![6] = Number.NaN;
    expect(lbmComputeMacroscopic(state)).toBe(false);
    state.f[0]![6] = 0;
    state.f[1]![6] = -1;
    expect(lbmComputeMacroscopic(state)).toBe(false);
  });

  it("skips solid nodes in macroscopic sums and momentum", () => {
    const solid = new Uint8Array(25);
    solid[7] = 1;
    const state = createLbmState({ nx: 5, ny: 5, solid });
    state.f[0]![7] = 5;
    expect(lbmComputeMacroscopic(state)).toBe(true);
    expect(state.rho[7]).toBe(1);
    expect(state.ux[7]).toBe(0);
    expect(lbmTotalMomentum(state)).toEqual({ x: 0, y: 0 });
  });

  it("full-way bounce-back reflects a population where it stands and books 2·f·c", () => {
    const solid = new Uint8Array(25);
    solid[7] = 1; // node (2, 1)
    const state = createLbmState({ nx: 5, ny: 5, solid });
    // Zero the scratch at the solid node, then deliver one +x population.
    for (let i = 0; i < D2Q9_Q; i += 1) {
      state.fTmp[i]![7] = 0;
    }
    state.fTmp[1]![7] = 0.125;
    const impulse = lbmReflectSolids(state);
    // Only direction 1 carried population: impulse = 2·f·c = 2·0.125·(+1, 0).
    expect(impulse.impulseX).toBeCloseTo(0.25, 6);
    expect(impulse.impulseY).toBe(0);
    expect(state.fTmp[1]![7]).toBe(0);
    expect(state.fTmp[3]![7]).toBeCloseTo(0.125, 6);
  });
});
