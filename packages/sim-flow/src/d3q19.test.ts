import { describe, expect, it } from "vitest";

import {
  D3Q19_CS2,
  D3Q19_OPPOSITE,
  D3Q19_Q,
  D3Q19_VELOCITIES,
  D3Q19_WEIGHTS,
  d3q19Equilibrium,
  d3q19EquilibriumEven,
  d3q19EquilibriumOdd,
} from "./d3q19";

describe("the D3Q19 lattice", () => {
  it("weights form the quadrature (they sum to one)", () => {
    expect(D3Q19_WEIGHTS.length).toBe(D3Q19_Q);
    const sum = D3Q19_WEIGHTS.reduce((total, weight) => total + weight, 0);
    expect(sum).toBeCloseTo(1, 15);
  });

  it("velocities are the nineteen distinct lattice links and the reflection table negates each", () => {
    expect(D3Q19_VELOCITIES.length).toBe(D3Q19_Q);
    const seen = new Set<string>();
    for (let i = 0; i < D3Q19_Q; i += 1) {
      const [cx, cy, cz] = D3Q19_VELOCITIES[i] ?? [NaN, NaN, NaN];
      seen.add(`${String(cx)},${String(cy)},${String(cz)}`);
      const [ox, oy, oz] = D3Q19_VELOCITIES[D3Q19_OPPOSITE[i] ?? -1] ?? [
        NaN,
        NaN,
        NaN,
      ];
      // Sum-zero, not Object.is negation: the table carries +0/−0.
      expect(ox + cx).toBe(0);
      expect(oy + cy).toBe(0);
      expect(oz + cz).toBe(0);
      expect(D3Q19_OPPOSITE[D3Q19_OPPOSITE[i] ?? -1]).toBe(i);
    }
    expect(seen.size).toBe(D3Q19_Q);
  });

  it("equilibrium conserves mass exactly (Σe = ρ)", () => {
    for (const [rho, ux, uy, uz] of [
      [1, 0, 0, 0],
      [1.02, 0.05, -0.03, 0.02],
      [0.97, -0.08, 0.06, -0.04],
    ] as const) {
      let sum = 0;
      for (let i = 0; i < D3Q19_Q; i += 1) {
        sum += d3q19Equilibrium(i, rho, ux, uy, uz);
      }
      expect(sum).toBeCloseTo(rho, 12);
    }
  });

  it("equilibrium carries the momentum to third order (Σc·e = ρu + O(u³))", () => {
    const rho = 1.01;
    const ux = 0.01;
    const uy = -0.007;
    const uz = 0.004;
    let mx = 0;
    let my = 0;
    let mz = 0;
    for (let i = 0; i < D3Q19_Q; i += 1) {
      const value = d3q19Equilibrium(i, rho, ux, uy, uz);
      mx += value * (D3Q19_VELOCITIES[i]?.[0] ?? 0);
      my += value * (D3Q19_VELOCITIES[i]?.[1] ?? 0);
      mz += value * (D3Q19_VELOCITIES[i]?.[2] ?? 0);
    }
    expect(Math.abs(mx - rho * ux)).toBeLessThan(1e-3 * rho * ux);
    expect(Math.abs(my - rho * uy)).toBeLessThan(1e-3 * rho * Math.abs(uy));
    expect(Math.abs(mz - rho * uz)).toBeLessThan(1e-3 * rho * uz);
  });

  it("the second moment is isotropic at the Newtonian stress (Σ c_a c_b e = ρ·c_s²·δ)", () => {
    let mxx = 0;
    let myy = 0;
    let mzz = 0;
    let mxy = 0;
    let mxz = 0;
    let myz = 0;
    for (let i = 0; i < D3Q19_Q; i += 1) {
      const [cx, cy, cz] = D3Q19_VELOCITIES[i] ?? [0, 0, 0];
      const value = d3q19Equilibrium(i, 1, 0, 0, 0);
      mxx += value * cx * cx;
      myy += value * cy * cy;
      mzz += value * cz * cz;
      mxy += value * cx * cy;
      mxz += value * cx * cz;
      myz += value * cy * cz;
    }
    expect(mxx).toBeCloseTo(D3Q19_CS2, 12);
    expect(myy).toBeCloseTo(D3Q19_CS2, 12);
    expect(mzz).toBeCloseTo(D3Q19_CS2, 12);
    expect(mxy).toBeCloseTo(0, 15);
    expect(mxz).toBeCloseTo(0, 15);
    expect(myz).toBeCloseTo(0, 15);
  });

  it("the even/odd split recombines into the full equilibrium", () => {
    for (const [rho, ux, uy, uz] of [
      [1, 0, 0, 0],
      [0.98, 0.06, 0.04, -0.03],
    ] as const) {
      for (let i = 0; i < D3Q19_Q; i += 1) {
        const combined =
          d3q19EquilibriumEven(i, rho, ux, uy, uz) +
          d3q19EquilibriumOdd(i, rho, ux, uy, uz);
        expect(combined).toBeCloseTo(d3q19Equilibrium(i, rho, ux, uy, uz), 15);
      }
    }
  });

  it("counts the weights by direction class: rest 1/3, six axes 1/18, twelve diagonals 1/36", () => {
    let axis = 0;
    let diagonal = 0;
    for (let i = 1; i < D3Q19_Q; i += 1) {
      const [cx, cy, cz] = D3Q19_VELOCITIES[i] ?? [0, 0, 0];
      const magnitude = Math.abs(cx) + Math.abs(cy) + Math.abs(cz);
      if (magnitude === 1) {
        axis += 1;
        expect(D3Q19_WEIGHTS[i]).toBeCloseTo(1 / 18, 15);
      } else {
        expect(magnitude).toBe(2);
        diagonal += 1;
        expect(D3Q19_WEIGHTS[i]).toBeCloseTo(1 / 36, 15);
      }
    }
    expect(D3Q19_WEIGHTS[0]).toBeCloseTo(1 / 3, 15);
    expect(axis).toBe(6);
    expect(diagonal).toBe(12);
  });
});
