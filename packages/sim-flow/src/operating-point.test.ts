/**
 * The operating point's tests (Phase 66b) — the roadmap's pinned
 * fixtures, all hand-solvable in closed form because both curves are
 * piecewise linear: the linear-torque motor against a quadratic load
 * (the closed-form intersection, at a ladder rung so the piecewise-
 * linear solve is exact), the stability criterion (stable and unstable
 * intersections correctly classified), the multiple-intersection
 * declines (two stable, a collinear tangency, and no intersection at
 * all), the tabulated motor's as-authored interpolation, and the BPF
 * arithmetic on the hand-solvable fixture. Pure math — no lattice.
 */

import { describe, expect, it } from "vitest";
import type {
  CompiledSimMotor,
  CompiledSimMotorTable,
} from "@slopcad/sim-core";

import {
  bladePassFrequencyHz,
  intersectMotorLoadCurve,
  loadTorqueAt,
  motorTorqueAt,
  motorTorqueSlope,
  rpmOf,
  solveOperatingPoint,
  validatedLoadCurve,
  type TorqueSpeedSample,
} from "./operating-point";

/** A compiled straight-line motor from the datasheet trio (SI). */
function linearMotor(
  stallTorqueNPerM: number,
  noLoadSpeedRadPerS: number,
  nominalVoltageV: number,
): CompiledSimMotor {
  const noLoadSpeedRpm = (noLoadSpeedRadPerS * 60) / (2 * Math.PI);
  const kvRpmPerV = noLoadSpeedRpm / nominalVoltageV;
  return {
    kind: "dc-brushed",
    stallTorqueNPerM,
    noLoadSpeedRadPerS,
    nominalVoltageV,
    kvRpmPerV,
    ktNPerA: 1 / (kvRpmPerV * ((2 * Math.PI) / 60)),
  };
}

/** A compiled tabulated motor from authored-style SI points. */
function tabulatedMotor(
  points: readonly {
    readonly speedRadPerS: number;
    readonly torqueNPerM: number;
  }[],
): CompiledSimMotorTable {
  return { kind: "tabulated", points };
}

describe("the hand-solvable fixture (linear motor, quadratic load)", () => {
  // T_motor = 0.1·(1 − ω/100); T_load = 3.75e-5·ω², sampled at every
  // 10 rad/s so the rung at ω = 40 sits exactly on both curves.
  const motor = linearMotor(0.1, 100, 12);
  const load: TorqueSpeedSample[] = [];
  for (let omega = 0; omega <= 100; omega += 10) {
    load.push({ omegaRadPerS: omega, torqueNPerM: 3.75e-5 * omega * omega });
  }

  it("finds the closed-form intersection exactly (ω* = 40, T* = 0.06)", () => {
    // Closed form: 3.75e-5·ω² + 1e-3·ω − 0.1 = 0 → ω = 40 (the other
    // root, −200/3, is outside the domain) — the hand solve.
    const solved = solveOperatingPoint(motor, load);
    if (!solved.ok) throw new Error(solved.error.message);
    expect(solved.value.candidates).toHaveLength(1);
    expect(solved.value.omegaRadPerS).toBeCloseTo(40, 9);
    expect(solved.value.torqueNPerM).toBeCloseTo(0.06, 9);
    expect(solved.value.rpm).toBeCloseTo(rpmOf(40), 9);
    const candidate = solved.value.candidates[0];
    expect(candidate?.stable).toBe(true);
    // The criterion pinned at the root (a kink root at the rung: the
    // reported slopes are the LEFT segment's — 2k·35 = 2.625e-3 — and
    // the right segment's 3.375e-3 both dominate the motor's −1e-3, so
    // the classification is stable from either side).
    expect(candidate?.loadSlopeNPerMPerRadPerS).toBeCloseTo(0.002625, 9);
    expect(candidate?.motorSlopeNPerMPerRadPerS).toBeCloseTo(-0.001, 9);
  });

  it("pins the BPF arithmetic on the same fixture (7 blades)", () => {
    const solved = solveOperatingPoint(motor, load);
    if (!solved.ok) throw new Error(solved.error.message);
    const bpf = bladePassFrequencyHz(7, solved.value.rpm);
    // blades × rpm / 60 = 7 · rpmOf(40) / 60 = 7 · (40/(2π))·… Hz.
    expect(bpf).toBeCloseTo((7 * solved.value.rpm) / 60, 12);
    expect(bpf).toBeCloseTo((7 * 40) / (2 * Math.PI), 9);
    expect(bladePassFrequencyHz(1, 60)).toBeCloseTo(1, 12);
    expect(rpmOf(2 * Math.PI)).toBeCloseTo(60, 12);
  });
});

describe("the stability criterion pinned (a V motor, two crossings)", () => {
  // Motor tabulated V: (0, 0.5) → (30, 0.02) → (60, 0.5); load the
  // rising piecewise line (0, 0) → (30, 0.09) → (60, 0.36). Hand
  // roots: ω₁ = 500/19 ≈ 26.3158 on the falling branch (STABLE — the
  // load rises while the motor falls) and ω₂ = 40 on the rising branch
  // (UNSTABLE — the motor out-delivers with speed).
  const motor = tabulatedMotor([
    { speedRadPerS: 0, torqueNPerM: 0.5 },
    { speedRadPerS: 30, torqueNPerM: 0.02 },
    { speedRadPerS: 60, torqueNPerM: 0.5 },
  ]);
  const load: readonly TorqueSpeedSample[] = [
    { omegaRadPerS: 0, torqueNPerM: 0 },
    { omegaRadPerS: 30, torqueNPerM: 0.09 },
    { omegaRadPerS: 60, torqueNPerM: 0.36 },
  ];

  it("classifies both intersections and takes the stable one", () => {
    const candidates = intersectMotorLoadCurve(motor, load);
    expect(candidates).toHaveLength(2);
    const [first, second] = candidates;
    expect(first?.omegaRadPerS).toBeCloseTo(500 / 19, 9);
    expect(first?.stable).toBe(true);
    expect(second?.omegaRadPerS).toBeCloseTo(40, 9);
    expect(second?.stable).toBe(false);
    const solved = solveOperatingPoint(motor, load);
    if (!solved.ok) throw new Error(solved.error.message);
    expect(solved.value.omegaRadPerS).toBeCloseTo(500 / 19, 9);
    // T* on the falling branch: 0.5 − 0.016·(500/19) = 1.5/19.
    expect(solved.value.torqueNPerM).toBeCloseTo(1.5 / 19, 9);
    expect(solved.value.candidates).toHaveLength(2);
  });
});

describe("the ambiguity declines (never a guess)", () => {
  it("declines two stable intersections, reporting all candidates", () => {
    // Motor straight: T = 0.6 − 0.005ω. Load: rise to a peak at 30, a
    // steep fall to 50, then flat — hand roots 300/11 (stable),
    // 35 (unstable), 80 (stable): TWO stable points.
    const motor = linearMotor(0.6, 120, 24);
    const load: readonly TorqueSpeedSample[] = [
      { omegaRadPerS: 0, torqueNPerM: 0.1 },
      { omegaRadPerS: 30, torqueNPerM: 0.5 },
      { omegaRadPerS: 50, torqueNPerM: 0.2 },
      { omegaRadPerS: 90, torqueNPerM: 0.2 },
    ];
    const candidates = intersectMotorLoadCurve(motor, load);
    expect(candidates).toHaveLength(3);
    expect(candidates[0]?.omegaRadPerS).toBeCloseTo(300 / 11, 9);
    expect(candidates[0]?.stable).toBe(true);
    expect(candidates[1]?.omegaRadPerS).toBeCloseTo(35, 9);
    expect(candidates[1]?.stable).toBe(false);
    expect(candidates[2]?.omegaRadPerS).toBeCloseTo(80, 9);
    expect(candidates[2]?.stable).toBe(true);
    const solved = solveOperatingPoint(motor, load);
    expect(solved.ok).toBe(false);
    if (solved.ok) return;
    expect(solved.error.code).toBe("sim/operating-point-ambiguous");
    expect(solved.error.message).toContain("2");
    // All candidates ride the decline payload — the report, not a guess.
    expect(Array.isArray(solved.error.input)).toBe(true);
    expect(solved.error.input).toHaveLength(3);
  });

  it("declines a collinear tangency (curves coincident over an interval)", () => {
    // The load's second segment IS the motor line from 40 to 90 — the
    // curves touch at 40 and coincide beyond it.
    const motor = linearMotor(0.6, 120, 24);
    const load: readonly TorqueSpeedSample[] = [
      { omegaRadPerS: 0, torqueNPerM: 0.2 },
      { omegaRadPerS: 40, torqueNPerM: 0.4 },
      { omegaRadPerS: 90, torqueNPerM: 0.15 },
    ];
    const solved = solveOperatingPoint(motor, load);
    expect(solved.ok).toBe(false);
    if (solved.ok) return;
    expect(solved.error.code).toBe("sim/operating-point-ambiguous");
    expect(solved.error.message).toContain("coincide");
  });

  it("declines when no intersection exists in the swept band", () => {
    const motor = linearMotor(0.05, 120, 12);
    const load: readonly TorqueSpeedSample[] = [
      { omegaRadPerS: 0, torqueNPerM: 0.2 },
      { omegaRadPerS: 50, torqueNPerM: 0.5 },
    ];
    const solved = solveOperatingPoint(motor, load);
    expect(solved.ok).toBe(false);
    if (solved.ok) return;
    expect(solved.error.code).toBe("sim/operating-point-ambiguous");
    expect(solved.error.message).toContain("do not intersect");
  });
});

describe("the tabulated motor's as-authored interpolation", () => {
  const motor = tabulatedMotor([
    { speedRadPerS: 0, torqueNPerM: 0.5 },
    { speedRadPerS: 30, torqueNPerM: 0.2 },
    { speedRadPerS: 60, torqueNPerM: 0.1 },
  ]);

  it("interpolates linearly between authored points", () => {
    expect(motorTorqueAt(motor, 0)).toBeCloseTo(0.5, 12);
    expect(motorTorqueAt(motor, 15)).toBeCloseTo(0.35, 12);
    expect(motorTorqueAt(motor, 45)).toBeCloseTo(0.15, 12);
    expect(motorTorqueAt(motor, 60)).toBeCloseTo(0.1, 12);
    expect(motorTorqueSlope(motor, 15)).toBeCloseTo(-0.01, 12);
    expect(motorTorqueSlope(motor, 45)).toBeCloseTo(-1 / 300, 12);
  });

  it("continues the last segment outside the table (the curve's extension)", () => {
    expect(motorTorqueAt(motor, 90)).toBeCloseTo(0.1 - 90 / 300 + 60 / 300, 12);
    expect(loadTorqueAt([{ omegaRadPerS: 0, torqueNPerM: 1 }], 5)).toBe(1);
  });
});

describe("the load-curve validation", () => {
  it("refuses structurally malformed ladders", () => {
    const tooFew = validatedLoadCurve([{ omegaRadPerS: 1, torqueNPerM: 1 }]);
    expect(tooFew.ok).toBe(false);
    const unordered = validatedLoadCurve([
      { omegaRadPerS: 10, torqueNPerM: 1 },
      { omegaRadPerS: 5, torqueNPerM: 2 },
    ]);
    expect(unordered.ok).toBe(false);
    const nonFinite = validatedLoadCurve([
      { omegaRadPerS: 0, torqueNPerM: Number.NaN },
      { omegaRadPerS: 5, torqueNPerM: 2 },
    ]);
    expect(nonFinite.ok).toBe(false);
    const good = validatedLoadCurve([
      { omegaRadPerS: 0, torqueNPerM: 0 },
      { omegaRadPerS: 5, torqueNPerM: 2 },
    ]);
    expect(good.ok).toBe(true);
  });
});
