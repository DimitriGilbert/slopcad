/**
 * Multi-DOF joint ground truth (Phase 67a): the cylindrical, planar,
 * and ball DOF layouts (joints.ts) against hand-solved motion — the
 * exact territory of the moving-origin gauge, where a body both rotates
 * and translates (ω × v_O ≠ 0): a wrong gauge's spurious inertial pair
 * `[ω×(h×v_O); m·ω×v_O]` would bend the planar slides (growing with the
 * falling v_y) and drain the ball's fixed-point angular momentum
 * dt-independently. The cylindrical pin holds the two-DOF decoupling of
 * a single axis; the ball pin holds the world angular momentum of
 * torque-free tumbling about a fixed point — exactly conserved in the
 * continuum, held to the stated integrator order here.
 */

import { describe, expect, it } from "vitest";
import type { DynamicsStepResult } from "./contract";

import {
  ballSpinBuild,
  cylindricalBuild,
  mustBuild,
  mustStep,
  planarBuild,
} from "./fixtures";

const G = 9.80665;

function bodyOf(
  result: DynamicsStepResult,
): DynamicsStepResult["occurrences"][number] {
  const body = result.occurrences.find(
    (occurrence) => occurrence.id === "body",
  );
  if (body === undefined) throw new Error("the body occurrence is missing");
  return body;
}

describe("cylindrical vs analytic (free fall along the axis + spin)", () => {
  it("decouples the slide and the spin of one axis exactly", () => {
    const system = mustBuild(
      cylindricalBuild({ massKg: 1.5, spin0: 2.4, slide0: 0.3 }),
    );
    const dt = 0.0005;
    const spin0 = 2.4;
    const slide0 = 0.3;
    const steps = 1000;
    let last: DynamicsStepResult | undefined;
    let audit0 = 0;
    for (let index = 0; index < steps; index += 1) {
      last = mustStep(system, { timeStepS: dt });
      if (index === 0) audit0 = last.energy.auditJ;
    }
    if (last === undefined) throw new Error("no steps ran");
    const n = steps;
    const slideExact = slide0 * dt * n - G * dt * dt * ((n * (n + 1)) / 2);
    const body = bodyOf(last);
    // The world Y of the body origin is the slide coordinate.
    expect(body.translationMm[1]).toBeCloseTo(slideExact * 1000, 9);
    expect(body.linearVelocityMPerS[1]).toBeCloseTo(slide0 - G * dt * n, 9);
    const dofs = last.joints[0]?.dofs ?? [];
    // Pinned DOF order: rotation about the axis first, translation along it.
    expect(dofs[0]?.position).toBeCloseTo(spin0 * dt * n, 12);
    expect(dofs[0]?.rate).toBeCloseTo(spin0, 12);
    expect(dofs[1]?.position).toBeCloseTo(slideExact, 9);
    expect(dofs[1]?.rate).toBeCloseTo(slide0 - G * dt * n, 12);
    // The spin never touches the fall: the audit holds its first-step
    // value within the semi-implicit fall drift −½·m·g²·dt·t (measured
    // 0.018 J at dt = 0.5 ms, t = 0.5 s — the integrator's stated
    // first-order energy stance, not a coupling).
    expect(Math.abs(last.energy.auditJ - audit0)).toBeLessThan(0.025);
  });
});

describe("planar vs analytic (gravity slide with spin)", () => {
  it("holds the fall parabola, the free x-slide, and the constant spin", () => {
    const massKg = 1.5;
    const spin0 = 3.1;
    const vx0 = 0.6;
    const system = mustBuild(planarBuild({ massKg, spin0, vx0 }));
    const dt = 0.0005;
    const steps = 1000;
    let last: DynamicsStepResult | undefined;
    for (let index = 0; index < steps; index += 1) {
      last = mustStep(system, { timeStepS: dt });
    }
    if (last === undefined) throw new Error("no steps ran");
    const n = steps;
    const body = bodyOf(last);
    // x: no in-plane force ever touches it — exact.
    expect(body.translationMm[0]).toBeCloseTo(vx0 * dt * n * 1000, 9);
    expect(body.linearVelocityMPerS[0]).toBeCloseTo(vx0, 12);
    // y: the semi-implicit fall.
    expect(body.translationMm[1]).toBeCloseTo(
      -G * dt * dt * ((n * (n + 1)) / 2) * 1000,
      9,
    );
    // The spin is torque-free (gravity through the on-anchor COG) and
    // the slides carry no spurious coupling: ω × v_O ≠ 0 through the
    // whole run — the moving-origin gauge's exposure.
    const dofs = last.joints[0]?.dofs ?? [];
    expect(dofs[0]?.position).toBeCloseTo(spin0 * dt * n, 12);
    expect(dofs[0]?.rate).toBeCloseTo(spin0, 12);
    // Linear momentum's x component is conserved (no x force exists).
    expect(last.momentum.linearKgMPerS[0]).toBeCloseTo(massKg * vx0, 12);
    // z stays pinned by the plane.
    expect(body.translationMm[2]).toBeCloseTo(0, 12);
  });
});

describe("ball vs analytic (torque-free tumbling about a fixed point)", () => {
  it("conserves the anchor angular momentum and energy to integrator order", () => {
    const measure = (
      dt: number,
    ): { originSpeed: number; l: number; ke: number } => {
      const system = mustBuild(ballSpinBuild());
      const steps = Math.round(0.2 / dt);
      const first = mustStep(system, { timeStepS: dt });
      const l0 = first.momentum.angularKgM2PerS;
      const ke0 = first.energy.kineticJ;
      // The exposure precondition: the body origin orbits the pinned
      // anchor (v_O = ω × pb, |pb| = 0.1 m) — the moving-origin gauge.
      const originSpeed = Math.hypot(...bodyOf(first).linearVelocityMPerS);
      let l = 0;
      let ke = 0;
      for (let index = 1; index < steps; index += 1) {
        const step = mustStep(system, { timeStepS: dt });
        const lm = step.momentum.angularKgM2PerS;
        l = Math.max(
          l,
          Math.abs(lm[0] - l0[0]),
          Math.abs(lm[1] - l0[1]),
          Math.abs(lm[2] - l0[2]),
        );
        ke = Math.max(ke, Math.abs(step.energy.kineticJ - ke0));
      }
      return { originSpeed, l, ke };
    };
    const coarse = measure(1e-4);
    const fine = measure(1e-5);
    // The body origin moves — this fixture only means anything in the
    // moving-origin gauge (ω × v_O ≠ 0).
    expect(coarse.originSpeed).toBeGreaterThan(0.1);
    // Measured after the d'Alembert gauge fix: l ≤ 2.1e-5 kg·m²/s and
    // ke ≤ 1.9e-6 J over 0.2 s at both dt = 1e-4 and dt = 1e-5 (the
    // same dt-independent Lie–Euler parameterization floor the
    // tumbling pin documents; a wrong moving-origin gauge drains both
    // orders of magnitude above these caps, dt-independently).
    expect(fine.l).toBeLessThan(4e-5);
    expect(fine.ke).toBeLessThan(4e-6);
    expect(coarse.l).toBeLessThan(4e-5);
    expect(coarse.ke).toBeLessThan(4e-6);
  });
});
