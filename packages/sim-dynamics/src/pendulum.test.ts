/**
 * The constrained pendulum vs analytic (Phase 67a): a point-mass
 * pendulum on a z revolute — the small-angle quarter-period crossing,
 * the analytic joint-angle trajectory at integrator order, energy
 * conservation on a large swing, and the gravity-side pivot reaction.
 */

import { describe, expect, it } from "vitest";
import type { DynamicsStepResult } from "./contract";

import { mustBuild, mustStep, pendulumBuild } from "./fixtures";

const G = 9.80665;

function jointAngle(result: DynamicsStepResult): number {
  return result.joints[0]?.dofs[0]?.position ?? 0;
}

describe("constrained pendulum vs analytic", () => {
  it("crosses to −θ₀ at the small-angle quarter period", () => {
    const lengthM = 0.5;
    const theta0 = 0.1;
    const system = mustBuild(pendulumBuild({ lengthM, massKg: 1, theta0 }));
    const dt = 0.0001;
    const omega = Math.sqrt(G / lengthM);
    const steps = Math.round(Math.PI / 2 / omega / dt);
    let q = 0;
    for (let index = 0; index < steps; index += 1) {
      q = jointAngle(mustStep(system, { timeStepS: dt }));
    }
    // q(t) = θ₀(cos ωt − 1); at the quarter period q = −θ₀ within the
    // first-order integrator's phase drift and the θ₀² nonlinearity.
    expect(q).toBeCloseTo(-theta0, 2);
    expect(Math.abs(q + theta0)).toBeLessThan(0.005);
  });

  it("tracks the analytic angle trajectory over a half swing", () => {
    const lengthM = 0.5;
    const theta0 = 0.1;
    const system = mustBuild(pendulumBuild({ lengthM, massKg: 1, theta0 }));
    const dt = 0.0002;
    const omega = Math.sqrt(G / lengthM);
    let q = 0;
    for (let index = 0; index < 500; index += 1) {
      q = jointAngle(mustStep(system, { timeStepS: dt }));
    }
    const t = 500 * dt;
    expect(q).toBeCloseTo(theta0 * (Math.cos(omega * t) - 1), 3);
  });

  it("conserves energy on a large swing (no friction)", () => {
    const system = mustBuild(
      pendulumBuild({ lengthM: 0.5, massKg: 1, theta0: 1.0 }),
    );
    const dt = 0.0002;
    const e0 = mustStep(system, { timeStepS: dt }).energy.auditJ;
    let worst = 0;
    for (let index = 1; index < 5000; index += 1) {
      const audit = mustStep(system, { timeStepS: dt }).energy.auditJ;
      worst = Math.max(worst, Math.abs(audit - e0));
    }
    // E₀ = mgL(1 − cos θ₀) ≈ 2.254 J; the measured semi-implicit drift
    // over one second at dt = 0.2 ms (first order, stated honestly).
    expect(worst).toBeLessThan(2e-3);
  });

  it("reports the gravity-side reaction at the pivot", () => {
    const system = mustBuild(
      pendulumBuild({ lengthM: 0.5, massKg: 1, theta0: 0.1 }),
    );
    const step = mustStep(system, { timeStepS: 0.001 });
    const reaction = step.joints[0]?.reaction;
    expect(reaction).toBeDefined();
    if (!reaction) return;
    // At the first step (θ = θ₀, θ̇ = 0): the transmitted pivot force is
    // m·a − m·g with a = α ẑ × c, α = −(g/L)·sin θ₀·cos... of the point
    // mass — the closed forms: Fₓ = −m·g·sin θ₀·cos θ₀,
    // F_y = m·g·cos² θ₀ (the weight minus the tangential pull).
    const theta0 = 0.1;
    expect(reaction.forceN[0]).toBeCloseTo(
      -G * Math.sin(theta0) * Math.cos(theta0),
      2,
    );
    expect(reaction.forceN[1]).toBeCloseTo(G * Math.cos(theta0) ** 2, 2);
  });
});
