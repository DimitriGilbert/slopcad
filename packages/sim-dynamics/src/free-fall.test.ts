/**
 * Free fall under the gravity body force vs analytic (Phase 67a): one
 * point-mass body, gravity −Y, the free 6-DOF root. The kernel's
 * semi-implicit step has the exact closed form yₙ = −g·dt²·n(n+1)/2 and
 * vₙ = −n·g·dt (asserted at 1e-9), and the continuum parabola within
 * the integrator's first-order offset.
 */

import { describe, expect, it } from "vitest";

import { freeFallBuild } from "./fixtures";
import { createReferenceDynamicsEngine } from "./engine";

const G = 9.80665;

describe("free fall vs analytic (the gravity body force)", () => {
  it("falls on the exact semi-implicit closed form and the continuum parabola", () => {
    const engine = createReferenceDynamicsEngine();
    const built = engine.build(freeFallBuild());
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const dt = 0.001;
    const steps = 1000;
    let last = built.value.step({ timeStepS: dt });
    for (let index = 1; index < steps; index += 1) {
      const next = built.value.step({ timeStepS: dt });
      expect(next.ok).toBe(true);
      if (!next.ok) return;
      last = next;
    }
    expect(last.ok).toBe(true);
    if (!last.ok) return;
    const n = steps;
    const yExact = -G * dt * dt * ((n * (n + 1)) / 2);
    const vExact = -n * G * dt;
    // Translation is document millimetres; velocities SI.
    expect(last.value.occurrences[0]?.translationMm[1]).toBeCloseTo(
      yExact * 1000,
      6,
    );
    expect(last.value.occurrences[0]?.linearVelocityMPerS[1]).toBeCloseTo(
      vExact,
      9,
    );
    // Continuum: y(1 s) = −g/2 within the first-order offset g·dt/2.
    expect(
      (last.value.occurrences[0]?.translationMm[1] ?? 0) / 1000,
    ).toBeCloseTo(-G / 2, 2);
    expect(last.value.momentum.linearKgMPerS[1]).toBeCloseTo(vExact, 9);
    // Nothing else moves: the rotational DOFs stay at zero.
    const free = last.value.joints.find((joint) => joint.id === "body::free");
    expect(free?.dofs.slice(0, 3).every((dof) => dof.rate === 0)).toBe(true);
  });

  it("conserves KE + PE to the semi-implicit order over the fall", () => {
    const engine = createReferenceDynamicsEngine();
    const built = engine.build(freeFallBuild());
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const dt = 0.001;
    const first = built.value.step({ timeStepS: dt });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const e0 = first.value.energy.auditJ;
    for (let index = 1; index < 1000; index += 1) {
      built.value.step({ timeStepS: dt });
    }
    const end = built.value.step({ timeStepS: dt });
    expect(end.ok).toBe(true);
    if (!end.ok) return;
    // The semi-implicit drift is −½·m·g²·dt·t (0.048 J at t = 1 s, dt = 1 ms).
    expect(Math.abs(end.value.energy.auditJ - e0)).toBeLessThan(0.05);
  });
});
