/**
 * Motor abstraction units (Phase 67a): the 61 motor record's compiled SI
 * forms as torque sources — the ideal linear line over all speeds
 * (beyond no-load it brakes; backdriven it exceeds stall), the
 * piecewise-linear table with constant end extrapolation, the
 * electrical view on analytic kinds only, and the rotor-inertia read.
 */

import type { CompiledSimMotor } from "@slopcad/sim-core";
import { compileSimMotor } from "@slopcad/sim-core";
import { describe, expect, it } from "vitest";

import {
  isAnalyticMotor,
  isTabulatedMotor,
  motorElectricalPowerW,
  motorRotorInertiaKgM2,
  motorTorqueNPerM,
} from "./motor";

const LINE_WIRE: Record<string, unknown> = {
  id: "mtr_line",
  name: "Line motor",
  kind: "dc-brushed",
  stallTorqueMNm: 100,
  noLoadSpeedRpm: 6000,
  nominalVoltageV: 12,
  rotorInertiaKgM2: 0.003,
};

function compileLine(): CompiledSimMotor {
  const compiled = compileSimMotor(LINE_WIRE, "mtr_line");
  if (!compiled.ok) throw new Error(compiled.error.message);
  return compiled.value;
}

const RPM = (2 * Math.PI) / 60;

describe("motor abstraction", () => {
  it("serves stall at rest, zero at no-load, and braking beyond", () => {
    const motor = compileLine();
    expect(motorTorqueNPerM(motor, 0)).toBeCloseTo(0.1, 12);
    expect(motorTorqueNPerM(motor, 6000 * RPM)).toBeCloseTo(0, 12);
    expect(motorTorqueNPerM(motor, 2 * 6000 * RPM)).toBeCloseTo(-0.1, 12);
    expect(motorTorqueNPerM(motor, -6000 * RPM)).toBeCloseTo(0.2, 12);
    expect(motorRotorInertiaKgM2(motor)).toBe(0.003);
  });

  it("interpolates the table piecewise-linearly with constant ends", () => {
    const wire: Record<string, unknown> = {
      id: "mtr_table",
      name: "Table motor",
      kind: "tabulated",
      points: [
        { speedRpm: 0, torqueMNm: 80 },
        { speedRpm: 3000, torqueMNm: 40 },
        { speedRpm: 6000, torqueMNm: 0 },
      ],
    };
    const compiled = compileSimMotor(wire, "mtr_table");
    if (!compiled.ok) throw new Error(compiled.error.message);
    const motor = compiled.value;
    expect(isTabulatedMotor(motor)).toBe(true);
    expect(motorTorqueNPerM(motor, 0)).toBeCloseTo(0.08, 12);
    expect(motorTorqueNPerM(motor, 1500 * RPM)).toBeCloseTo(0.06, 12);
    expect(motorTorqueNPerM(motor, 4500 * RPM)).toBeCloseTo(0.02, 12);
    expect(motorTorqueNPerM(motor, 6000 * RPM)).toBeCloseTo(0, 12);
    expect(motorTorqueNPerM(motor, 9000 * RPM)).toBeCloseTo(0, 12);
    expect(motorTorqueNPerM(motor, -500 * RPM)).toBeCloseTo(0.08, 12);
    // No voltage authored: no electrical view, never a guess.
    expect(motorElectricalPowerW(motor, 0.05)).toBeUndefined();
    expect(motorRotorInertiaKgM2(motor)).toBe(0);
  });

  it("derives the electrical view from Kt on analytic kinds", () => {
    const motor = compileLine();
    expect(isAnalyticMotor(motor)).toBe(true);
    // Kt = 1/(Kv·2π/60) with Kv = 6000/12 rpm/V → Kt ≈ 0.0191 N·m/A.
    const stallTorque = 0.1;
    const current =
      stallTorque /
      (motor.kind === "dc-brushed" || motor.kind === "bldc"
        ? motor.ktNPerA
        : 1);
    expect(motorElectricalPowerW(motor, stallTorque)).toBeCloseTo(
      12 * current,
      9,
    );
  });
});
