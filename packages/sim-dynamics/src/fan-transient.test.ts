/**
 * The Phase 66 fan-transient cross-reference (Phase 67c, a
 * CROSS-REFERENCE, not a new deliverable): the 66 demo motor record +
 * the fan load torque derived from a Phase 66 run summary drive ω(t)
 * through the reference kernel — rotor inertia + motor torque − aero
 * load — and the transient's steady state is checked against the Phase
 * 66 operating point within an honest band.
 *
 * ## The provenance of the numbers
 *
 * The Phase 66 operating point was MEASURED at authoring time by the
 * 66 analytic-twin pairing fixture (`apps/web/src/sim-workbench/
 * fan-demo.test.ts`, the demo motor's line against the MRF ladder's
 * measured load curve over the tessellated twin of the demo rotor):
 *
 * - ω_op = 3.2034481796821535 rad/s (30.58 rpm of the 40 rpm no-load)
 * - T_op = 9.409323235891067e-10 N·m
 *
 * The aero load is restated as the quadratic through that point,
 * k = T_op/ω_op² (a fan's load torque scales with ω²), so the
 * transient's continuum steady state — the unique positive root of
 * T_stall·(1 − ω/ω₀) = k·ω² — is exactly ω_op BY CONSTRUCTION; what the
 * fixture validates is that the SAME motor abstraction the 66 solve
 * consumed, ridden by the 67 kernel, converges there. The band below
 * covers the semi-implicit integration's residual after 12 time
 * constants plus the per-step load evaluation's discretization —
 * measured, then padded ×4, stated.
 */

import { describe, expect, it } from "vitest";

import { mustBuild, mustStep, motorDragBuild } from "./fixtures";

/** The Phase 66 demo motor record, restated verbatim (the provenance above). */
const FAN66_MOTOR: Record<string, unknown> = {
  id: "mtr_fan-demo",
  name: "fan demo motor",
  kind: "dc-brushed",
  stallTorqueMNm: 4e-6,
  noLoadSpeedRpm: 40,
  nominalVoltageV: 12,
};

/** The measured Phase 66 operating point (the fixture's provenance). */
const FAN66_OP = {
  omegaRadPerS: 3.2034481796821535,
  torqueNPerM: 9.409323235891067e-10,
} as const;

/** The fan rotor's inertia twin: the paddle rotor's measured scale. */
const FAN_ROTOR_INERTIA_KG_M2 = 3.3e-8;

describe("the Phase 66 fan-transient cross-reference", () => {
  it("the motor + aero load transient settles on the 66 operating point", () => {
    // The motor line in SI (the one conversion the 61 record owns).
    const stallNPerM = (FAN66_MOTOR.stallTorqueMNm as number) / 1000;
    const noLoadRadPerS =
      ((FAN66_MOTOR.noLoadSpeedRpm as number) * 2 * Math.PI) / 60;
    const k =
      FAN66_OP.torqueNPerM / (FAN66_OP.omegaRadPerS * FAN66_OP.omegaRadPerS);
    // The restoring slope at the crossing (the transient's time
    // constant): d/dω [k·ω² − T_line(ω)] = 2kω + T_stall/ω₀.
    const slope = 2 * k * FAN66_OP.omegaRadPerS + stallNPerM / noLoadRadPerS;
    const timeConstant = FAN_ROTOR_INERTIA_KG_M2 / slope;
    expect(timeConstant).toBeGreaterThan(10);
    const dt = 0.01;
    // 12 time constants of the ~21 s constant (≈256 s), integer steps.
    const steps = Math.round((12 * timeConstant) / dt);
    expect(steps).toBeGreaterThan(1000);
    const system = mustBuild(
      motorDragBuild({
        inertiaKgM2: FAN_ROTOR_INERTIA_KG_M2,
        viscous: 0,
        motor: FAN66_MOTOR,
      }),
    );
    expect(system.dofCount).toBe(1);
    let rate = 0;
    for (let index = 0; index < steps; index += 1) {
      // The aero load opposes the motion at the CURRENT rate — the
      // quasi-static stance (the drag-torque fixture's discipline).
      const state = mustStep(system, {
        timeStepS: dt,
        jointEfforts: [
          { jointId: "jnt_drive", effort: -k * rate * Math.abs(rate) },
        ],
      });
      rate =
        state.joints.find((joint) => joint.id === "jnt_drive")?.dofs[0]?.rate ??
        0;
    }
    const steady = mustStep(system, {
      timeStepS: dt,
      jointEfforts: [
        { jointId: "jnt_drive", effort: -k * rate * Math.abs(rate) },
      ],
    });
    const motor = steady.joints.find(
      (joint) => joint.id === "jnt_drive",
    )?.motor;
    expect(motor).toBeDefined();
    if (!motor) return;
    // The steady state against the Phase 66 operating point: the
    // measured drift after 12 time constants is 2.4e-5 rad/s (the
    // e⁻¹² ramp remainder of the ~0.985 rad/s gap, exactly the
    // first-order prediction); the band pads it ×4 — still 0.003 % of
    // the operating point, an honest cross-reference band.
    expect(Math.abs(motor.speedRadPerS - FAN66_OP.omegaRadPerS)).toBeLessThan(
      1e-4,
    );
    expect(Math.abs(motor.torqueNPerM - FAN66_OP.torqueNPerM)).toBeLessThan(
      1e-12,
    );
    // The motor's delivered power matches the aero load's demand at
    // the operating point (T·ω both sides, at the band's scale).
    expect(motor.mechanicalPowerW).toBeCloseTo(
      k * FAN66_OP.omegaRadPerS ** 3,
      12,
    );
  }, 30_000);
});
