import { describe, expect, it } from "vitest";

import {
  D2Q9_CS2,
  D2Q9_OPPOSITE,
  D2Q9_Q,
  D2Q9_VELOCITIES,
  D2Q9_WEIGHTS,
  d2q9Equilibrium,
  d2q9EquilibriumEven,
  d2q9EquilibriumOdd,
} from "./d2q9";

describe("the D2Q9 lattice", () => {
  it("weights form the quadrature (they sum to one)", () => {
    expect(D2Q9_WEIGHTS.length).toBe(D2Q9_Q);
    const sum = D2Q9_WEIGHTS.reduce((total, weight) => total + weight, 0);
    expect(sum).toBeCloseTo(1, 15);
  });

  it("velocities are the nine distinct lattice links and the reflection table negates each", () => {
    expect(D2Q9_VELOCITIES.length).toBe(D2Q9_Q);
    for (let i = 0; i < D2Q9_Q; i += 1) {
      const [cx, cy] = D2Q9_VELOCITIES[i] ?? [NaN, NaN];
      const [ox, oy] = D2Q9_VELOCITIES[D2Q9_OPPOSITE[i] ?? -1] ?? [NaN, NaN];
      // Sum-zero, not Object.is negation: the table carries +0/−0.
      expect(ox + cx).toBe(0);
      expect(oy + cy).toBe(0);
      expect(D2Q9_OPPOSITE[D2Q9_OPPOSITE[i] ?? -1]).toBe(i);
    }
  });

  it("equilibrium conserves mass exactly (Σe = ρ)", () => {
    for (const [rho, ux, uy] of [
      [1, 0, 0],
      [1.02, 0.05, -0.03],
      [0.97, -0.08, 0.06],
    ] as const) {
      let sum = 0;
      for (let i = 0; i < D2Q9_Q; i += 1) {
        sum += d2q9Equilibrium(i, rho, ux, uy);
      }
      expect(sum).toBeCloseTo(rho, 12);
    }
  });

  it("equilibrium carries the momentum to third order (Σc·e = ρu + O(u³))", () => {
    const rho = 1.01;
    const ux = 0.01;
    const uy = -0.007;
    let mx = 0;
    let my = 0;
    for (let i = 0; i < D2Q9_Q; i += 1) {
      const value = d2q9Equilibrium(i, rho, ux, uy);
      mx += value * (D2Q9_VELOCITIES[i]?.[0] ?? 0);
      my += value * (D2Q9_VELOCITIES[i]?.[1] ?? 0);
    }
    expect(Math.abs(mx - rho * ux)).toBeLessThan(1e-3 * rho * ux);
    expect(Math.abs(my - rho * uy)).toBeLessThan(1e-3 * rho * Math.abs(uy));
  });

  it("the even/odd split recombines into the full equilibrium", () => {
    for (const [rho, ux, uy] of [
      [1, 0, 0],
      [0.98, 0.06, 0.04],
    ] as const) {
      for (let i = 0; i < D2Q9_Q; i += 1) {
        const combined =
          d2q9EquilibriumEven(i, rho, ux, uy) +
          d2q9EquilibriumOdd(i, rho, ux, uy);
        expect(combined).toBeCloseTo(d2q9Equilibrium(i, rho, ux, uy), 15);
      }
    }
  });

  it("the second moment is the Newtonian stress at rest (Σ c_a c_b e = ρ·c_s²·δ)", () => {
    let mxx = 0;
    let myy = 0;
    for (let i = 0; i < D2Q9_Q; i += 1) {
      const [cx, cy] = D2Q9_VELOCITIES[i] ?? [0, 0];
      const value = d2q9Equilibrium(i, 1, 0, 0);
      mxx += value * cx * cx;
      myy += value * cy * cy;
    }
    expect(mxx).toBeCloseTo(D2Q9_CS2, 12);
    expect(myy).toBeCloseTo(D2Q9_CS2, 12);
  });
});
