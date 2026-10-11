/**
 * The fan analysis's tests (Phase 66b): the plane extraction against
 * hand-filled snapshots (airflow and ΔP exact), the load-curve sweep's
 * friction-seam arithmetic (the Phase 67 leave-alone seam added and
 * not added), the full motor-driven operating-point analysis on a tiny
 * paddle rotor (the identities — BPF, the powers, the efficiencies —
 * and the S9 guidance line), and the structured declines that
 * propagate from the solve.
 */

import { describe, expect, it } from "vitest";
import type { CompiledSimMotorLine } from "@slopcad/sim-core";
import type { Lbm3dSISnapshot } from "./stepper-3d";

import { testFluid } from "./fixtures";
import {
  analyzeFanOperatingPoint,
  extractFanPerformance,
  runFanLoadCurveSweep,
  type FanAnalysisConfig,
} from "./fan-3d";
import { type Lbm3dMrfConfig } from "./mrf-3d";
import { analyticOccupancy3d } from "./fixtures";

const DX = 0.001;
const U_CHAR = 0.075;
const NUS = 1.5e-4;

/** A compiled straight-line motor from the datasheet trio (SI). */
function linearMotor(
  stallTorqueNPerM: number,
  noLoadSpeedRadPerS: number,
  nominalVoltageV: number,
): CompiledSimMotorLine {
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

describe("the fan performance extraction (hand-filled snapshots)", () => {
  const NX = 10;
  const NY = 4;
  const NZ = 4;
  // One solid on the flow plane (x = 5): 15 fluid nodes there.
  const solid = new Uint8Array(NX * NY * NZ);
  solid[5 + 1 * NX + 1 * NX * NY] = 1;
  const mask = { nx: NX, ny: NY, nz: NZ, solid };
  const nodes = NX * NY * NZ;
  const snapshot: Lbm3dSISnapshot = {
    step: 1,
    densityKgPerM3: new Float64Array(nodes).fill(1.2),
    velocityXMPerS: new Float64Array(nodes).fill(2),
    velocityYMPerS: new Float64Array(nodes),
    velocityZMPerS: new Float64Array(nodes),
    pressurePa: new Float64Array(nodes),
  };
  // Plane indexes: flow round(0.5·9) = 5, pressures round(0.25·9) = 2
  // and round(0.75·9) = 7.
  for (let index = 0; index < nodes; index += 1) {
    const x = index % NX;
    snapshot.pressurePa[index] = x <= 4 ? 100 : 130;
  }

  it("integrates the plane airflow and the mean-pressure rise exactly", () => {
    const extracted = extractFanPerformance(snapshot, mask, 0, DX);
    if (!extracted.ok) throw new Error(extracted.error.message);
    expect(extracted.value.flowPlaneIndex).toBe(5);
    expect(extracted.value.pressurePlaneIndexes).toEqual([2, 7]);
    // Q = 15 fluid nodes · 2 m/s · (1 mm)².
    expect(extracted.value.airflowM3PerS).toBeCloseTo(15 * 2 * DX * DX, 15);
    // ΔP = 130 − 100 over the fluid means.
    expect(extracted.value.deltaPPa).toBeCloseTo(30, 12);
  });

  it("refuses malformed plane fractions and short axes", () => {
    const bad = extractFanPerformance(snapshot, mask, 0, DX, {
      flowPlaneFraction: 1.5,
    });
    expect(bad.ok).toBe(false);
    const unordered = extractFanPerformance(snapshot, mask, 0, DX, {
      pressurePlaneFractions: [0.75, 0.25],
    });
    expect(unordered.ok).toBe(false);
    const shortMask = {
      nx: 5,
      ny: 4,
      nz: 4,
      solid: new Uint8Array(5 * 4 * 4),
    };
    const shortAxis = extractFanPerformance(
      { ...snapshot, pressurePa: new Float64Array(5 * 4 * 4) },
      shortMask,
      0,
      DX,
    );
    expect(shortAxis.ok).toBe(false);
  });
});

/** The tiny paddle rotor: a cross-bar about the x axis, r_tip 3 cells. */
function paddleRotor(dx: number, dy: number, dz: number): boolean {
  const hub = Math.abs(dx) <= 1 && Math.abs(dy) <= 1 && Math.abs(dz) <= 1;
  const blade = Math.abs(dx) <= 0.6 && Math.abs(dy) <= 3 && Math.abs(dz) <= 0.6;
  return hub || blade;
}

const NX = 14;
const NY = 9;
const NZ = 9;
const AXIS_X = 7;
const CENTER_YZ = 4;

/** The MRF config the sweep clones per rung (axis along x, the fan axis). */
function paddleMrfConfig(): Omit<Lbm3dMrfConfig, "omegaRadPerS"> {
  return {
    mask: {
      nx: NX,
      ny: NY,
      nz: NZ,
      solid: analyticOccupancy3d(NX, NY, NZ, (x, y, z) =>
        paddleRotor(x - AXIS_X, y - CENTER_YZ, z - CENTER_YZ),
      ),
    },
    fluid: testFluid(1.2, NUS),
    cellSizeM: DX,
    characteristicVelocityMPerS: U_CHAR,
    collision: { kind: "trt" },
    west: { kind: "wall", slip: false },
    east: { kind: "wall", slip: false },
    south: { kind: "wall", slip: false },
    north: { kind: "wall", slip: false },
    bottom: { kind: "wall", slip: false },
    top: { kind: "wall", slip: false },
    rotation: { kind: "mrf" },
    axis: {
      pointM: [AXIS_X * DX, CENTER_YZ * DX, CENTER_YZ * DX],
      direction: [1, 0, 0],
    },
    rotatingZone: (_x, y, z) => Math.hypot(y - CENTER_YZ, z - CENTER_YZ) <= 4,
  };
}

describe("the load-curve sweep and the Phase 67 friction seam", () => {
  it("sweeps rungs and keeps the aero and seam-inclusive series apart", () => {
    const withDrag = runFanLoadCurveSweep(paddleMrfConfig(), [15, 30, 45], {
      stepsPerRung: 400,
      averageWindowSteps: 150,
      shaftDragTorqueNPerM: () => 1e-10,
    });
    if (!withDrag.ok) throw new Error(withDrag.error.message);
    const withoutDrag = runFanLoadCurveSweep(paddleMrfConfig(), [15, 30, 45], {
      stepsPerRung: 400,
      averageWindowSteps: 150,
    });
    if (!withoutDrag.ok) throw new Error(withoutDrag.error.message);
    expect(withDrag.value.samples).toHaveLength(3);
    expect(withoutDrag.value.aeroSamples).toHaveLength(3);
    // The seam's arithmetic, exactly: total = aero + drag at every rung;
    // without the seam the total IS the aero load.
    for (let i = 0; i < 3; i += 1) {
      const total = withDrag.value.samples[i];
      const aero = withDrag.value.aeroSamples[i];
      const bare = withoutDrag.value.samples[i];
      const bareAero = withoutDrag.value.aeroSamples[i];
      if (
        total === undefined ||
        aero === undefined ||
        bare === undefined ||
        bareAero === undefined
      ) {
        throw new Error("missing rung sample");
      }
      expect(total.omegaRadPerS).toBe(aero.omegaRadPerS);
      expect(total.torqueNPerM).toBeCloseTo(aero.torqueNPerM + 1e-10, 20);
      expect(bare.torqueNPerM).toBe(bareAero.torqueNPerM);
      // The aero rung torques are finite; the drag resistance must
      // make the total strictly larger than the aero load.
      expect(total.torqueNPerM).toBeGreaterThan(aero.torqueNPerM);
    }
    // The rung speeds are the ladder, verbatim.
    expect(withDrag.value.samples.map((s) => s.omegaRadPerS)).toEqual([
      15, 30, 45,
    ]);
  }, 120_000);

  it("refuses malformed ladders and window options", () => {
    const unordered = runFanLoadCurveSweep(paddleMrfConfig(), [30, 15], {
      stepsPerRung: 50,
      averageWindowSteps: 10,
    });
    expect(unordered.ok).toBe(false);
    const tooFew = runFanLoadCurveSweep(paddleMrfConfig(), [30], {
      stepsPerRung: 50,
      averageWindowSteps: 10,
    });
    expect(tooFew.ok).toBe(false);
    const badWindow = runFanLoadCurveSweep(paddleMrfConfig(), [15, 30], {
      stepsPerRung: 50,
      averageWindowSteps: 80,
    });
    expect(badWindow.ok).toBe(false);
  });
});

describe("the motor-driven operating-point analysis (tiny paddle fan)", () => {
  const config: FanAnalysisConfig = {
    mrf: paddleMrfConfig(),
    bladeCount: 7,
    omegaLadderRadPerS: [15, 30, 45],
    stepsPerRung: 400,
    averageWindowSteps: 150,
  };

  it("finds the operating point and reports the full output family", () => {
    // A weak motor whose line crosses the ladder's load curve inside
    // the swept band (measured at authoring time: the paddle's aero
    // load at the rungs is ~1e-9 N·m scale, rising with ω).
    const motor = linearMotor(4e-9, 60, 6);
    const analyzed = analyzeFanOperatingPoint(config, motor);
    if (!analyzed.ok) throw new Error(analyzed.error.message);
    const result = analyzed.value;
    // The operating point sits inside the ladder's span, torque positive.
    expect(result.solve.omegaRadPerS).toBeGreaterThan(15);
    expect(result.solve.omegaRadPerS).toBeLessThan(45);
    expect(result.solve.torqueNPerM).toBeGreaterThan(0);
    expect(result.solve.rpm).toBeCloseTo(
      (result.solve.omegaRadPerS * 60) / (2 * Math.PI),
      9,
    );
    // BPF = blades × RPM / 60, arithmetic from the found point.
    expect(result.bladePassFrequencyHz).toBeCloseTo(
      (7 * result.solve.rpm) / 60,
      12,
    );
    // The power identities, exact against the reported point.
    expect(result.powers.shaftPowerW).toBeCloseTo(
      result.solve.torqueNPerM * result.solve.omegaRadPerS,
      15,
    );
    expect(result.powers.fanAirPowerW).toBeCloseTo(
      result.performance.deltaPPa * result.performance.airflowM3PerS,
      18,
    );
    expect(result.powers.electricalPowerW).toBeCloseTo(
      (motor.nominalVoltageV * result.solve.torqueNPerM) / motor.ktNPerA,
      12,
    );
    expect(result.powers.motorEfficiency).toBeCloseTo(
      result.powers.shaftPowerW / (result.powers.electricalPowerW ?? 1),
      9,
    );
    expect(result.powers.systemEfficiency).toBeCloseTo(
      result.powers.fanAirPowerW / (result.powers.electricalPowerW ?? 1),
      9,
    );
    // The S9 guidance line: the tip Reynolds number and its flags.
    const tipSpeed = result.solve.omegaRadPerS * result.tipRadiusM;
    expect(result.regime.reynolds).toBeCloseTo(
      (tipSpeed * 2 * result.tipRadiusM) / NUS,
      6,
    );
    expect(result.regime.lowReynoldsFan).toBe(true);
    // The load curve rides along — the chart data (66c's surface).
    expect(result.loadCurve.samples).toHaveLength(3);
    // The steps-per-revolution fact at the operating speed.
    expect(result.stepsPerRevolution).toBeGreaterThan(0);
  }, 180_000);

  it("propagates the ambiguity decline of a mis-paired motor", () => {
    // A motor far too strong for this fan inside the swept band: no
    // intersection exists there — the structured decline, never a guess.
    const strong = linearMotor(0.05, 300, 12);
    const analyzed = analyzeFanOperatingPoint(config, strong);
    expect(analyzed.ok).toBe(false);
    if (analyzed.ok) return;
    expect(analyzed.error.code).toBe("sim/operating-point-ambiguous");
    expect(analyzed.error.message).toContain("do not intersect");
  }, 120_000);

  it("refuses a non-positive blade count and bad options", () => {
    const noBlades = analyzeFanOperatingPoint(
      { ...config, bladeCount: 0 },
      linearMotor(4e-9, 60, 6),
    );
    expect(noBlades.ok).toBe(false);
    if (noBlades.ok) return;
    expect(noBlades.error.message).toContain("blade count");
  });
});
