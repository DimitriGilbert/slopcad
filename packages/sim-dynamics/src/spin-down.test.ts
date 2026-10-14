/**
 * Spin-down decay vs analytic (Phase 67a): viscous-only is the exact
 * discrete exponential (implicit viscous: ω′ = ω·I/(I + dt·d)); Coulomb
 * alone is the linear ramp that lands on EXACT REST inside a step and
 * HOLDS it (breakaway = the same Coulomb value — the stated stiction
 * posture); the slider flavour consumes the fields in translational
 * units; and the mixed run dissipates exactly the initial kinetic
 * energy by the time it rests.
 */

import { describe, expect, it } from "vitest";

import { mustBuild, mustStep, spinDownBuild } from "./fixtures";

function rateOf(step: {
  readonly joints: readonly {
    readonly dofs: readonly { readonly rate: number }[];
  }[];
}): number {
  return step.joints[0]?.dofs[0]?.rate ?? Number.NaN;
}

describe("spin-down decay vs analytic", () => {
  it("viscous-only follows the exact implicit-exponential closed form", () => {
    const inertia = 0.01;
    const damping = 0.02;
    const omega0 = 10;
    const dt = 0.001;
    const system = mustBuild(
      spinDownBuild({ inertiaKgM2: inertia, omega0, viscous: damping }),
    );
    const factor = inertia / (inertia + dt * damping);
    for (let index = 1; index <= 2000; index += 1) {
      const step = mustStep(system, { timeStepS: dt });
      expect(step.joints[0]?.dofs[0]?.rate).toBeCloseTo(
        omega0 * factor ** index,
        9,
      );
    }
    // Continuum: ω(2 s) = 10·e^{−4} within the implicit discretization.
    expect(rateOf(mustStep(system, { timeStepS: dt }))).toBeCloseTo(
      10 * Math.exp(-4),
      2,
    );
  });

  it("Coulomb-only ramps linearly to EXACT rest and stays there", () => {
    const inertia = 0.01;
    const loss = 0.05;
    const dt = 0.001;
    const system = mustBuild(
      spinDownBuild({ inertiaKgM2: inertia, omega0: 10, frictionLoss: loss }),
    );
    // Ramp: ωₙ = 10 − n·(T·dt/I) while the cone does not catch.
    for (let index = 1; index <= 1998; index += 1) {
      const step = mustStep(system, { timeStepS: dt });
      expect(step.joints[0]?.dofs[0]?.rate).toBeCloseTo(
        10 - index * ((loss * dt) / inertia),
        9,
      );
    }
    // The cone catches once |I·ω| ≤ dt·T (ω ≤ 0.005 — within a float
    // boundary step): EXACT zero, and it STAYS zero — stiction holds
    // with no drive (breakaway = the same Coulomb value; no separate
    // stiction model).
    for (let index = 1999; index <= 2010; index += 1) {
      mustStep(system, { timeStepS: dt });
    }
    const stopped = mustStep(system, { timeStepS: dt });
    expect(stopped.joints[0]?.dofs[0]?.rate).toBe(0);
    for (let index = 0; index < 500; index += 1) {
      expect(mustStep(system, { timeStepS: dt }).joints[0]?.dofs[0]?.rate).toBe(
        0,
      );
    }
  });

  it("consumes the friction fields in translational units on a slider", () => {
    const mass = 2;
    const loss = 1;
    const dt = 0.001;
    const system = mustBuild(
      spinDownBuild({
        inertiaKgM2: 0.01,
        omega0: 3,
        frictionLoss: loss,
        kind: "slider",
        massKg: mass,
      }),
    );
    // vₙ = 3 − n·(F·dt/m) — the N reading of the friction-loss field.
    for (let index = 1; index <= 1000; index += 1) {
      const step = mustStep(system, { timeStepS: dt });
      expect(step.joints[0]?.dofs[0]?.rate).toBeCloseTo(
        3 - index * ((loss * dt) / mass),
        9,
      );
    }
    // Rest at t = 3·m/F = 6 s exactly (cone catch included).
    for (let index = 0; index < 5000; index += 1) {
      mustStep(system, { timeStepS: dt });
    }
    const stopped = mustStep(system, { timeStepS: dt });
    expect(stopped.joints[0]?.dofs[0]?.rate).toBe(0);
  });

  it("dissipates exactly the initial kinetic energy by rest (mixed)", () => {
    const inertia = 0.01;
    const system = mustBuild(
      spinDownBuild({
        inertiaKgM2: inertia,
        omega0: 8,
        viscous: 0.01,
        frictionLoss: 0.02,
      }),
    );
    const dt = 0.001;
    const first = mustStep(system, { timeStepS: dt });
    const ke0 = 0.5 * inertia * 8 * 8;
    let step = first;
    for (let index = 1; index < 4000; index += 1) {
      step = mustStep(system, { timeStepS: dt });
    }
    expect(step.joints[0]?.dofs[0]?.rate).toBe(0);
    // Dissipated work = the lost KE (the conservation audit's friction
    // half): ½Iω₀² to the second-order remainder of the implicit step
    // (½dt²(di+T)²/I per step — the measured budget below).
    expect(step.energy.dissipatedJ).toBeCloseTo(ke0, 3);
    expect(step.energy.auditJ).toBeCloseTo(first.energy.auditJ, 3);
  });
});
