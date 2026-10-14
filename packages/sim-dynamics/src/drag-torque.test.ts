/**
 * Steady drag-torque and motor-drive fixtures (Phase 67a): a spun-up
 * rotor against viscous drag reaches the analytic steady state
 * ω* = τ/d (effort-driven) and ω* solving T_motor(ω) = d·ω
 * (motor-driven, rotor inertia included) — the "rotor inertia + motor
 * torque − load → ω(t)" abstraction, and the Phase 66 operating-point
 * cross-reference's transient shape.
 */

import { describe, expect, it } from "vitest";

import { mustBuild, mustStep, motorDragBuild, spinDownBuild } from "./fixtures";

const MOTOR_LINE: Record<string, unknown> = {
  id: "mtr_drive",
  name: "Drive motor",
  kind: "dc-brushed",
  stallTorqueMNm: 100,
  noLoadSpeedRpm: 6000,
  nominalVoltageV: 12,
};

describe("steady drag-torque fixture", () => {
  it("reaches the analytic steady state under a constant effort", () => {
    const inertia = 0.02;
    const damping = 0.01;
    const effort = 0.05;
    const dt = 0.001;
    const system = mustBuild(
      spinDownBuild({ inertiaKgM2: inertia, omega0: 0, viscous: damping }),
    );
    // τ_time = I/d = 2 s: 30 s is 15 time constants (e⁻¹⁵ ≈ 3e-7).
    for (let index = 0; index < 30000; index += 1) {
      mustStep(system, {
        timeStepS: dt,
        jointEfforts: [{ jointId: "jnt_spin", effort }],
      });
    }
    const steady = mustStep(system, {
      timeStepS: dt,
      jointEfforts: [{ jointId: "jnt_spin", effort }],
    });
    // The discrete fixed point IS ω* = τ/d (the implicit step preserves
    // it exactly); the ramp's remainder is e⁻¹⁵ of the gap.
    expect(steady.joints[0]?.dofs[0]?.rate).toBeCloseTo(effort / damping, 3);
    // Dissipated power at steady state = d·ω*² = τ²/d.
    expect(steady.joints[0]?.dofs[0]?.dissipatedPowerW).toBeCloseTo(
      damping * (effort / damping) ** 2,
      3,
    );
    // The viscous force is −d·ω exactly.
    expect(steady.joints[0]?.dofs[0]?.viscousForce).toBeCloseTo(
      -damping * (effort / damping),
      3,
    );
  });

  it("settles the motor line against viscous drag at the analytic point", () => {
    const inertia = 0.02;
    const rotorInertia = 0.005;
    const damping = 0.005;
    const dt = 0.001;
    const system = mustBuild(
      motorDragBuild({
        inertiaKgM2: inertia,
        viscous: damping,
        motor: { ...MOTOR_LINE, rotorInertiaKgM2: rotorInertia },
      }),
    );
    // τ_time = (I + I_r)/d = 5 s: 60 s is 12 time constants.
    for (let index = 0; index < 60000; index += 1) {
      mustStep(system, { timeStepS: dt });
    }
    const steady = mustStep(system, { timeStepS: dt });
    const motor = steady.joints.find(
      (joint) => joint.id === "jnt_drive",
    )?.motor;
    expect(motor).toBeDefined();
    if (!motor) return;
    // T_stall·(1 − ω/ω₀) = d·ω  →  ω* = T/(d + T/ω₀) with
    // T = 0.1 N·m, ω₀ = 6000·2π/60 = 628.319 rad/s.
    const stall = 0.1;
    const noLoad = 6000 * ((2 * Math.PI) / 60);
    const omegaStar = stall / (damping + stall / noLoad);
    expect(motor.speedRadPerS).toBeCloseTo(omegaStar, 2);
    expect(motor.torqueNPerM).toBeCloseTo(damping * omegaStar, 3);
    expect(motor.mechanicalPowerW).toBeCloseTo(
      damping * omegaStar * omegaStar,
      3,
    );
    // Electrical: I = T/Kt, P = V·I (analytic kinds only).
    expect(motor.electricalPowerW).toBeGreaterThan(motor.mechanicalPowerW);
    // The rotor inertia shows in the effective inertia: the spin-up time
    // constant is (I + I_r)/d = 5 s; after 15 s (3 τ) the ramp is ≥ 94%.
    const rampSystem = mustBuild(
      motorDragBuild({
        inertiaKgM2: inertia,
        viscous: damping,
        motor: { ...MOTOR_LINE, rotorInertiaKgM2: rotorInertia },
      }),
    );
    for (let index = 0; index < 15000; index += 1) {
      mustStep(rampSystem, { timeStepS: 0.001 });
    }
    const ramped = mustStep(rampSystem, { timeStepS: 0.001 });
    const motorRamp = ramped.joints.find(
      (joint) => joint.id === "jnt_drive",
    )?.motor;
    if (!motorRamp) return;
    expect(motorRamp.speedRadPerS).toBeGreaterThan(0.94 * omegaStar);
  });

  it("extrapolates the tabulated curve with constant ends", () => {
    const system = mustBuild(
      motorDragBuild({
        inertiaKgM2: 0.02,
        viscous: 0.004,
        motor: {
          id: "mtr_table",
          name: "Table motor",
          kind: "tabulated",
          points: [
            { speedRpm: 0, torqueMNm: 80 },
            { speedRpm: 3000, torqueMNm: 40 },
            { speedRpm: 6000, torqueMNm: 0 },
          ],
        },
      }),
    );
    // τ_time = I/d = 5 s: 40 s is 8 time constants (e⁻⁸ ≈ 3e-4).
    for (let index = 0; index < 60000; index += 1) {
      mustStep(system, { timeStepS: 0.001 });
    }
    const steady = mustStep(system, { timeStepS: 0.001 });
    const motor = steady.joints.find(
      (joint) => joint.id === "jnt_drive",
    )?.motor;
    expect(motor).toBeDefined();
    if (!motor) return;
    // Piecewise-linear table: T(ω) = 0.08 − ω·(0.08/628.319) →
    // ω* = T/(d + T/ω₀) with d = 0.004: 0.08 = 0.004ω + 0.000127ω.
    const omegaStar = 0.08 / (0.004 + 0.08 / (3000 * ((2 * Math.PI) / 30)));
    expect(motor.speedRadPerS).toBeCloseTo(omegaStar, 2);
    expect(motor.electricalPowerW).toBeUndefined();
    expect(motor.electricalWorkJ).toBeUndefined();
  });
});
