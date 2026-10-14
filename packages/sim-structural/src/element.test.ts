/**
 * The hex element's math pins (Phase 69a): the D matrix against the
 * Lamé pair, the exact quadrature identities (Gauss stiffness energies,
 * body-force resultants, the thermal load's self-equilibrium), the
 * center-strain forms on linear fields, and the von Mises invariant.
 */

import { describe, expect, it } from "vitest";

import {
  hexCenterStrain,
  hexCentrifugalLoad,
  hexDMatrix,
  hexStiffness,
  hexThermalLoad,
  hexUniformBodyLoad,
  hexVonMises,
} from "./element";

const E = 210e9;
const NU = 0.3;
const H = 0.005;

/** The canonical corner signs (bottom CCW, then top). */
const SIGNS: readonly (readonly [-1 | 1, -1 | 1, -1 | 1])[] = [
  [-1, -1, -1],
  [1, -1, -1],
  [1, 1, -1],
  [-1, 1, -1],
  [-1, -1, 1],
  [1, -1, 1],
  [1, 1, 1],
  [-1, 1, 1],
];

describe("the hex element", () => {
  it("builds the isotropic D matrix from the Lamé pair", () => {
    const d = hexDMatrix(E, NU);
    const lambda = (E * NU) / ((1 + NU) * (1 - 2 * NU));
    const shear = E / (2 * (1 + NU));
    const rel = (actual: number, expected: number): number =>
      Math.abs(actual / expected - 1);
    expect(rel(d[0] ?? 0, lambda + 2 * shear)).toBeLessThan(1e-12);
    expect(rel(d[1] ?? 0, lambda)).toBeLessThan(1e-12);
    expect(rel(d[7] ?? 0, lambda + 2 * shear)).toBeLessThan(1e-12);
    expect(rel(d[8] ?? 0, lambda)).toBeLessThan(1e-12);
    expect(rel(d[3 * 6 + 3] ?? 0, shear)).toBeLessThan(1e-12);
    expect(rel(d[4 * 6 + 4] ?? 0, shear)).toBeLessThan(1e-12);
    expect(rel(d[5 * 6 + 5] ?? 0, shear)).toBeLessThan(1e-12);
    expect(d[3 * 6]).toBe(0);
  });

  it("assembles a symmetric stiffness to round-off", () => {
    // The (i, j) and (j, i) bilinears are separate dot products whose
    // float64 rounding may differ in the last ulp — symmetry to
    // round-off, stated.
    const ke = hexStiffness(hexDMatrix(E, NU), H, H, H);
    for (let i = 0; i < 24; i += 1) {
      for (let j = 0; j < 24; j += 1) {
        const a = ke[i * 24 + j] ?? 0;
        const b = ke[j * 24 + i] ?? 0;
        const scale = Math.max(Math.abs(a), Math.abs(b), 1);
        expect(Math.abs(a - b) / scale).toBeLessThan(1e-12);
      }
    }
  });

  it("integrates the exact energies of constant-strain fields", () => {
    const d = hexDMatrix(E, NU);
    const ke = hexStiffness(d, H, H, H);
    const volume = H ** 3;
    const energyOf = (u: Float64Array): number => {
      let w = 0;
      for (let i = 0; i < 24; i += 1) {
        for (let j = 0; j < 24; j += 1) {
          w += (u[i] ?? 0) * (ke[i * 24 + j] ?? 0) * (u[j] ?? 0);
        }
      }
      return w;
    };
    // ε_xx = a with the lateral components held at zero: the uniaxial
    // STRAIN energy ½(λ+2G)a²V (Poisson coupling included).
    const a = 1e-4;
    const ux = new Float64Array(24);
    for (let c = 0; c < 8; c += 1) {
      const signs = SIGNS[c];
      if (signs === undefined) continue;
      ux[c * 3] = a * signs[0] * (H / 2);
    }
    const lambda = (E * NU) / ((1 + NU) * (1 - 2 * NU));
    const shear = E / (2 * (1 + NU));
    expect(energyOf(ux)).toBeCloseTo((lambda + 2 * shear) * a * a * volume, 9);
    // γ_xy = b: the shear energy ½Gb²V.
    const b = 2e-4;
    const uxy = new Float64Array(24);
    for (let c = 0; c < 8; c += 1) {
      const signs = SIGNS[c];
      if (signs === undefined) continue;
      const [sx, sy] = signs;
      uxy[c * 3] = (b * sy * (H / 2)) / 2;
      uxy[c * 3 + 1] = (b * sx * (H / 2)) / 2;
    }
    expect(energyOf(uxy)).toBeCloseTo(shear * b * b * volume, 9);
  });

  it("recovers the center strain of linear fields exactly", () => {
    // ε_xx = 2e-4, ε_yy = −1e-4, γ_xy = 5e-5.
    const exx = 2e-4;
    const eyy = -1e-4;
    const gxy = 5e-5;
    const u = new Float64Array(24);
    for (let c = 0; c < 8; c += 1) {
      const signs = SIGNS[c];
      if (signs === undefined) continue;
      const [sx, sy] = signs;
      const x = (sx * H) / 2;
      const y = (sy * H) / 2;
      u[c * 3] = exx * x + (gxy / 2) * y;
      u[c * 3 + 1] = eyy * y + (gxy / 2) * x;
    }
    const strain = hexCenterStrain(H, H, H, u);
    // The corner-combination forms are algebraically exact: agreement
    // to a few ulp of the authored magnitudes.
    expect(Math.abs((strain[0] ?? 0) / exx - 1)).toBeLessThan(1e-13);
    expect(Math.abs((strain[1] ?? 0) / eyy - 1)).toBeLessThan(1e-13);
    expect(strain[2]).toBe(0);
    expect(Math.abs((strain[3] ?? 0) / gxy - 1)).toBeLessThan(1e-13);
    expect(strain[4]).toBe(0);
    expect(strain[5]).toBe(0);
  });

  it("lumps the uniform body force exactly as V/8 per corner", () => {
    const f = hexUniformBodyLoad(H, H, H, [0, -9.80665, 0]);
    const perNode = (H ** 3 * -9.80665) / 8;
    for (let c = 0; c < 8; c += 1) {
      expect(f[c * 3]).toBe(0);
      expect(f[c * 3 + 1]).toBeCloseTo(perNode, 12);
      expect(f[c * 3 + 2]).toBe(0);
    }
  });

  it("integrates the centrifugal load to the exact resultant", () => {
    // ∫b dV = multiplier·V·r⊥(centroid) exactly — b is linear.
    const multiplier = 7850 * 600 ** 2;
    const center = [0.12, 0.025, 0.03] as const;
    const axisPoint = [0.1, 0.02, 0.0] as const;
    const f = hexCentrifugalLoad(
      H,
      H,
      H,
      center[0],
      center[1],
      center[2],
      axisPoint,
      [0, 0, 1],
      multiplier,
    );
    const volume = H ** 3;
    let sx = 0;
    let sy = 0;
    let sz = 0;
    for (let c = 0; c < 8; c += 1) {
      sx += f[c * 3] ?? 0;
      sy += f[c * 3 + 1] ?? 0;
      sz += f[c * 3 + 2] ?? 0;
    }
    // The centroid sits 20 mm off-axis in x, 5 mm in y: the resultant
    // is multiplier·V·r⊥(centroid), exactly (b is linear).
    expect(sx).toBeCloseTo(multiplier * volume * 0.02, 3);
    expect(sy).toBeCloseTo(multiplier * volume * 0.005, 3);
    expect(sz).toBeCloseTo(0, 9);
    // An element straddling the axis carries no NET load (its two
    // halves pull against each other) — the resultant vanishes though
    // individual corner loads do not.
    const onAxis = hexCentrifugalLoad(
      H,
      H,
      H,
      axisPoint[0],
      axisPoint[1],
      axisPoint[2],
      axisPoint,
      [0, 0, 1],
      multiplier,
    );
    for (let component = 0; component < 3; component += 1) {
      let sum = 0;
      for (let c = 0; c < 8; c += 1) {
        sum += onAxis[c * 3 + component] ?? 0;
      }
      expect(Math.abs(sum)).toBeLessThan(1e-9);
    }
  });

  it("carries the thermal load self-equilibrated", () => {
    const f = hexThermalLoad(H, H, H, hexDMatrix(E, NU), 1.2e-5 * 50);
    for (let component = 0; component < 3; component += 1) {
      let sum = 0;
      for (let c = 0; c < 8; c += 1) {
        sum += f[c * 3 + component] ?? 0;
      }
      expect(Math.abs(sum)).toBeLessThan(1e-9);
    }
  });

  it("evaluates the standard 3D von Mises invariant", () => {
    expect(hexVonMises([100e6, 0, 0, 0, 0, 0])).toBeCloseTo(100e6, 6);
    expect(hexVonMises([0, 0, 0, 30e6, 0, 0])).toBeCloseTo(
      30e6 * Math.sqrt(3),
      6,
    );
    // Hydrostatic states carry no von Mises stress.
    expect(hexVonMises([50e6, 50e6, 50e6, 0, 0, 0])).toBeCloseTo(0, 6);
    // Biaxial equal tension: |σ|.
    expect(hexVonMises([80e6, 80e6, 0, 0, 0, 0])).toBeCloseTo(80e6, 6);
  });
});
