/**
 * Closed-loop closure through the restated LM machinery (Phase 67a):
 * the four-bar fixture — a planar 1-DOF mechanism whose fifth joint
 * closes the cycle — stays closed through a gravity swing (the loop
 * residual under the closure tolerance every step), reports the loop
 * joint's multiplier reaction, conserves the audit to integrator order,
 * and declines loudly when the loop cannot close.
 */

import { describe, expect, it } from "vitest";

import { createReferenceDynamicsEngine } from "./engine";
import { fourBarBuild, mustBuild, mustStep } from "./fixtures";

describe("loop closure (the four-bar)", () => {
  it("builds as a 1-loop mechanism with 3 tree DOF", () => {
    const system = mustBuild(fourBarBuild());
    expect(system.bodyCount).toBe(5);
    expect(system.dofCount).toBe(3);
    expect(system.loopJointCount).toBe(1);
  });

  it("holds the loop closed through a gravity swing, dissipating at first order", () => {
    const measure = (
      dt: number,
    ): {
      residual: number;
      drift: number;
      kinetic: number;
      loopForce: number;
    } => {
      const system = mustBuild(fourBarBuild());
      const first = mustStep(system, { timeStepS: dt });
      const audit0 = first.energy.auditJ;
      let residual = 0;
      let drift = 0;
      let kinetic = 0;
      let loopForce = 0;
      const steps = Math.round(1 / dt);
      for (let index = 1; index < steps; index += 1) {
        const step = mustStep(system, { timeStepS: dt });
        residual = Math.max(residual, step.solver.loopResidual);
        drift = Math.max(drift, Math.abs(step.energy.auditJ - audit0));
        kinetic = Math.max(kinetic, step.energy.kineticJ);
        const loop = step.joints.find((joint) => !joint.tree);
        if (loop?.reaction !== undefined) {
          loopForce = Math.max(
            loopForce,
            Math.abs(loop.reaction.forceN[0]),
            Math.abs(loop.reaction.forceN[1]),
          );
        }
      }
      return { residual, drift, kinetic, loopForce };
    };
    const coarse = measure(5e-4);
    const fine = measure(2.5e-4);
    // Closure: every step's worst row stays at the projection tolerance.
    expect(coarse.residual).toBeLessThan(1e-8);
    expect(fine.residual).toBeLessThan(1e-8);
    // The swing happens — gravity drives the mechanism and loads the
    // closing pin with a reportable multiplier wrench.
    expect(coarse.kinetic).toBeGreaterThan(0.05);
    expect(coarse.loopForce).toBeGreaterThan(0.01);
    // The velocity-level closure's Baumgarte-coupled equality impulses
    // dissipate at O(dt) — the documented stance, pinned by the halving
    // ratio rather than hidden behind a loose bound.
    expect(fine.drift / coarse.drift).toBeLessThan(0.65);
    expect(coarse.drift).toBeLessThan(0.3);
  });

  it("declines a loop that cannot close at the initial placement", () => {
    const build = fourBarBuild();
    // Lift the closing pin 0.5 m out of the plane: the planar mechanism
    // can never carry it back onto the rocker's tip circle (the loop
    // rows hold a permanent z residual).
    const broken = {
      ...build,
      occurrences: build.occurrences.map((occurrence) =>
        occurrence.id === "pinE"
          ? {
              ...occurrence,
              placement: {
                ...occurrence.placement,
                translation: [
                  occurrence.placement.translation[0],
                  occurrence.placement.translation[1],
                  occurrence.placement.translation[2] + 500,
                ] as [number, number, number],
              },
            }
          : occurrence,
      ),
    };
    const result = createReferenceDynamicsEngine().build(broken);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("sim/loop-unresolved");
  });

  it("declines friction fields on a closing joint (never silently dropped)", () => {
    // The physics ruling: velocity-level friction is a cone constraint
    // on the joint's GRANTED motion; on a closing joint that is the
    // relative twist across the loop, not a tree generalized
    // coordinate — the kernel's cone discipline does not carry it, so
    // the build declines instead of ignoring the authored fields.
    const build = fourBarBuild();
    const looped = {
      ...build,
      joints: build.joints.map((joint) => {
        const record = joint as Record<string, unknown>;
        return record.id === "jnt_loop"
          ? { ...record, frictionLossNPerM: 0.05 }
          : joint;
      }),
    };
    const result = createReferenceDynamicsEngine().build(looped);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("sim/mechanism-invalid");
    expect(result.error.message).toContain("jnt_loop");
    // The same fields on the TREE joints build fine (consumed there).
    const treeDamped = {
      ...build,
      joints: build.joints.map((joint) => {
        const record = joint as Record<string, unknown>;
        return record.id === "jnt_crank"
          ? { ...record, viscousDampingNPerMSPerRad: 0.01 }
          : joint;
      }),
    };
    expect(createReferenceDynamicsEngine().build(treeDamped).ok).toBe(true);
  });
});
