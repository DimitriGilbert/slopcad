/**
 * The motor abstraction (Phase 67a deliverable 4): the 61 motor record
 * as a torque source over speed — "rotor inertia + motor torque − load
 * → ω(t)". The SAME abstraction rides the slider-crank demo (67c) and
 * the Phase 66 fan transient: the kernel consumes sim-core's compiled
 * SI motor (the one conversion site), adds the record's optional rotor
 * inertia to the drive joint's effective inertia (direct drive — no
 * gear ratio is authored anywhere in the 61 record, and none is
 * fabricated), and evaluates torque at the joint's instantaneous speed
 * every step.
 *
 * Semantics, stated:
 *
 * - **Analytic kinds (DC brushed, BLDC)**: the ideal linear line
 *   `T(ω) = T_stall·(1 − ω/ω₀)` — the physically linear model of a
 *   brushed DC machine (T = Kt·I, I = (V − Ke·ω)/R), extended over ALL
 *   speeds: beyond no-load it returns braking torque (the machine
 *   becomes a generator), backdriven it exceeds stall — the honest
 *   line, never a clamped toy.
 * - **Tabulated kind**: piecewise-linear interpolation between the
 *   measured points, constant extrapolation outside their range (the
 *   curve is data; the ends are its stated reach).
 * - **Electrical view** (analytic kinds): I = T/Kt, P_el = V·I — signed
 *   (regeneration is negative draw); tabulated records carry no
 *   voltage, so the electrical view is absent, never guessed.
 *
 * Deterministic pure functions — no state, no closures over state.
 */

import type {
  CompiledSimMotor,
  CompiledSimMotorLine,
  CompiledSimMotorTable,
} from "@slopcad/sim-core";

/** The motor's torque at one speed, N·m. */
export function motorTorqueNPerM(
  motor: CompiledSimMotor,
  omegaRadPerS: number,
): number {
  switch (motor.kind) {
    case "dc-brushed":
    case "bldc":
      return (
        motor.stallTorqueNPerM * (1 - omegaRadPerS / motor.noLoadSpeedRadPerS)
      );
    case "tabulated":
      return tableTorque(motor, omegaRadPerS);
  }
}

/** Piecewise-linear table torque with constant end extrapolation. */
function tableTorque(
  motor: CompiledSimMotorTable,
  omegaRadPerS: number,
): number {
  const points = motor.points;
  const first = points[0];
  const last = points[points.length - 1];
  if (first === undefined || last === undefined) return 0;
  if (omegaRadPerS <= first.speedRadPerS) return first.torqueNPerM;
  if (omegaRadPerS >= last.speedRadPerS) return last.torqueNPerM;
  // Interior: the bracketing segment (speeds are strictly increasing —
  // validated at the compile boundary).
  for (let index = 1; index < points.length; index += 1) {
    const upper = points[index];
    const lower = points[index - 1];
    if (upper === undefined || lower === undefined) continue;
    if (omegaRadPerS <= upper.speedRadPerS) {
      const span = upper.speedRadPerS - lower.speedRadPerS;
      const weight = (omegaRadPerS - lower.speedRadPerS) / span;
      return (
        lower.torqueNPerM + weight * (upper.torqueNPerM - lower.torqueNPerM)
      );
    }
  }
  return last.torqueNPerM;
}

/** The electrical power draw at one operating point, W; absent for tabulated motors. */
export function motorElectricalPowerW(
  motor: CompiledSimMotor,
  torqueNPerM: number,
): number | undefined {
  if (motor.kind === "dc-brushed" || motor.kind === "bldc") {
    return (motor.nominalVoltageV * torqueNPerM) / motor.ktNPerA;
  }
  return undefined;
}

/** The rotor inertia the drive joint's effective inertia gains, kg·m² (0 when unauthored). */
export function motorRotorInertiaKgM2(motor: CompiledSimMotor): number {
  return motor.rotorInertiaKgM2 ?? 0;
}

/** Narrowing views for consumers that branch on the motor kind. */
export function isAnalyticMotor(
  motor: CompiledSimMotor,
): motor is CompiledSimMotorLine {
  return motor.kind === "dc-brushed" || motor.kind === "bldc";
}

export function isTabulatedMotor(
  motor: CompiledSimMotor,
): motor is CompiledSimMotorTable {
  return motor.kind === "tabulated";
}
