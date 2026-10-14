/**
 * The fan analysis (Phase 66b): the MRF sweep's load curve, the
 * operating point, and the performance read at it — the motor-in-the-
 * loop story of ROADMAP-SIM §7.9.
 *
 * ## The load curve — T_load(ω) from an ω ladder
 *
 * A small ladder of frame rates, each rung a steady MRF solve (fresh
 * state, `stepsPerRung` steps, the load torque the windowed mean of
 * the rung's LAST `averageWindowSteps` rotor-torque samples,
 * sign-flipped to the load convention: with Ω > 0 about +ê the
 * fluid-on-rotor torque is negative, so T_load = −mean(τ)). The curve
 * is FRICTION-INCLUSIVE-READY: the optional shaft-drag seam adds
 * Phase 67's bearing torque when that phase wires it — absent here,
 * the samples are the pure aerodynamic load plus whatever rides the
 * seam, and both series are kept (the aero one for physics reads, the
 * total one for the operating-point solve — brake-side numbers, the
 * roadmap's own framing).
 *
 * ## The performance read at the operating point
 *
 * Airflow and ΔP come from a final MRF rung AT the found ω*: the
 * volumetric flow through the mid-domain plane normal to the (coordinate-
 * parallel) rotation axis, and the area-weighted mean-pressure
 * difference between a downstream and an upstream plane — fractions of
 * the domain length, away from the boundary-condition transients. The
 * electrical family exists only for the analytic motor kinds (stall
 * torque + no-load speed + nominal voltage close the ideal-DC model:
 * I = T/Kt, P_elec = V·I); a tabulated motor carries no voltage, and
 * the fields stay honestly absent rather than fabricated.
 *
 * ## S9 and BPF
 *
 * The operating Reynolds number is the tip-dynamic form
 * Re_tip = U_tip·D_tip/ν with U_tip = ω·r_tip — the fan Re guidance
 * line; below FAN_LOW_REYNOLDS_ADVISORY the result carries the
 * low-Reynolds qualitative flag (fan performance data's own regime),
 * and above the S9 turbulent line (sim-core's advisory thresholds —
 * one source) the turbulence-dominated flag stands. BPF = blades ×
 * RPM, arithmetic from the found point; the blade count is AUTHORED
 * (a scenario field) — counting blades off a voxel staircase is
 * noise, and this module will not pretend otherwise.
 */

import {
  type CompiledSimMotor,
  type SimError,
  SIM_ERROR_CODES,
  SIM_REGIME_THRESHOLDS,
  type SimParseResult,
  simError,
  simFail,
  simOk,
} from "@slopcad/sim-core";
import type { Lbm3dSISnapshot } from "./stepper-3d";
import type { Lbm3dSolidMask } from "./state-3d";

import { type Lbm3dMrfConfig, createMrf3dStepper } from "./mrf-3d";
import {
  type FanOperatingPointSolve,
  type TorqueSpeedSample,
  bladePassFrequencyHz,
  solveOperatingPoint,
} from "./operating-point";

/**
 * The low-Reynolds advisory line for fans: tip-dynamic Reynolds numbers
 * below this carry the qualitative flag — fan performance data and
 * blade correlations assume Re ≳ 1e4–1e5 (the fan-literature regime,
 * e.g. the Eck/Bleier drag-versus-Re bands); below it the curve's
 * shape is qualitative, the number is still reported. Advisory, never
 * an acceptance certificate (the S16 posture).
 */
export const FAN_LOW_REYNOLDS_ADVISORY = 1e4;

/** A swept load curve: friction-inclusive samples plus the aero view. */
export interface FanLoadCurve {
  /** T_load(ω) the solve consumes — aero + whatever rides the seam. */
  readonly samples: readonly TorqueSpeedSample[];
  /** The pure aerodynamic rung torques (the seam-free view). */
  readonly aeroSamples: readonly TorqueSpeedSample[];
}

/** Where the planes sit along the axis (fractions of the domain length). */
export interface FanPlaneExtraction {
  /** The flow plane (airflow integration), default 0.5. */
  readonly flowPlaneFraction: number;
  /** [upstream, downstream] pressure planes, default [0.25, 0.75]. */
  readonly pressurePlaneFractions: readonly [number, number];
}

/** The extracted performance at one MRF solution. */
export interface FanPerformance {
  /** The volumetric flow through the flow plane, m³/s (signed). */
  readonly airflowM3PerS: number;
  /** Downstream minus upstream mean pressure, Pa. */
  readonly deltaPPa: number;
  readonly flowPlaneIndex: number;
  readonly pressurePlaneIndexes: readonly [number, number];
}

/** The S9 fan guidance line at the operating point. */
export interface FanRegimeHonesty {
  /** Re_tip = (ω·r_tip)·(2·r_tip)/ν. */
  readonly reynolds: number;
  /** Below FAN_LOW_REYNOLDS_ADVISORY — the qualitative flag. */
  readonly lowReynoldsFan: boolean;
  /** Above sim-core's turbulent advisory line (the standing S9 flag). */
  readonly turbulent: boolean;
}

/** The powers and efficiencies at the operating point. */
export interface FanPowers {
  /** The shaft load power, T·ω (W). */
  readonly shaftPowerW: number;
  /** The air power, ΔP·Q (W). */
  readonly fanAirPowerW: number;
  /** The electrical draw, V·I (W) — analytic motor kinds only. */
  readonly electricalPowerW?: number;
  /** Shaft over electrical — analytic motor kinds only. */
  readonly motorEfficiency?: number;
  /** Air over electrical, the motor+fan system figure — analytic only. */
  readonly systemEfficiency?: number;
}

/** What {@link analyzeFanOperatingPoint} returns at the found point. */
export interface FanOperatingPointResult {
  readonly solve: FanOperatingPointSolve;
  readonly performance: FanPerformance;
  /** The rung-at-ω* windowed torque (the solve's cross-check, transparency). */
  readonly verifyRungTorqueNPerM: number;
  readonly powers: FanPowers;
  readonly bladePassFrequencyHz: number;
  readonly regime: FanRegimeHonesty;
  readonly loadCurve: FanLoadCurve;
  /** The rotor's tip radius (solids inside the zone), metres. */
  readonly tipRadiusM: number;
  /** The lattice steps one revolution takes at the operating speed. */
  readonly stepsPerRevolution: number;
}

/** The sweep options — the rung protocol and the Phase 67 friction seam. */
export interface FanLoadCurveSweepOptions {
  /** Steps per rung (the steady-solve budget), a positive integer. */
  readonly stepsPerRung: number;
  /** The windowed-mean width over the rung's LAST samples, ≤ steps per rung. */
  readonly averageWindowSteps: number;
  /**
   * The Phase 67 seam: bearing/shaft drag added to each rung's torque
   * (N·m at the rung's ω). ABSENT here — the load curve is then the
   * pure aerodynamic load, and the operating point's power figures are
   * aero-side; when Phase 67's per-joint friction rides the fan shaft
   * through this seam, the same figures become brake-side.
   */
  readonly shaftDragTorqueNPerM?: (omegaRadPerS: number) => number;
}

/** The full analysis configuration (the motor rides in separately). */
export interface FanAnalysisConfig {
  /** The MRF config the sweep clones per rung (frame rate per rung). */
  readonly mrf: Omit<Lbm3dMrfConfig, "omegaRadPerS">;
  /** The authored blade count (BPF arithmetic — a scenario field). */
  readonly bladeCount: number;
  /** The ω ladder, rad/s: at least two strictly increasing positive rungs. */
  readonly omegaLadderRadPerS: readonly number[];
  readonly stepsPerRung: number;
  readonly averageWindowSteps: number;
  readonly shaftDragTorqueNPerM?: (omegaRadPerS: number) => number;
  readonly extraction?: Partial<FanPlaneExtraction>;
}

/**
 * The default plane placement — mid-domain flow, quarter/three-quarter
 * pressure planes, away from the boundary-condition transients.
 */
export const FAN_DEFAULT_PLANE_EXTRACTION: Readonly<FanPlaneExtraction> = {
  flowPlaneFraction: 0.5,
  pressurePlaneFractions: [0.25, 0.75] as const,
};

function refuseParse<T>(
  message: string,
  at: unknown,
): SimParseResult<T, SimError> {
  return simFail(simError(SIM_ERROR_CODES.scenarioInvalid, message, at));
}

/** The windowed mean of a sample tail, deterministic. */
function windowedMean(
  samples: readonly number[],
  window: number,
): number | undefined {
  if (samples.length === 0 || window < 1) return undefined;
  const start = Math.max(0, samples.length - window);
  let sum = 0;
  for (let i = start; i < samples.length; i += 1) {
    sum += samples[i] ?? 0;
  }
  return sum / (samples.length - start);
}

/**
 * Runs the ω ladder: one steady MRF solve per rung, the load torque the
 * windowed mean of the rung's final rotor-torque samples
 * (sign-flipped). A diverged rung declines `sim/run-diverged`; every
 * compile refusal of the MRF door propagates.
 */
export function runFanLoadCurveSweep(
  config: Omit<Lbm3dMrfConfig, "omegaRadPerS">,
  omegaLadderRadPerS: readonly number[],
  options: FanLoadCurveSweepOptions,
): SimParseResult<FanLoadCurve, SimError> {
  if (
    omegaLadderRadPerS.length < 2 ||
    omegaLadderRadPerS.some(
      (omega) =>
        typeof omega !== "number" || !Number.isFinite(omega) || omega <= 0,
    )
  ) {
    return refuseParse(
      "A load-curve ladder needs at least two positive finite rad/s rungs.",
      omegaLadderRadPerS,
    );
  }
  for (let i = 1; i < omegaLadderRadPerS.length; i += 1) {
    const previous = omegaLadderRadPerS[i - 1];
    const current = omegaLadderRadPerS[i];
    if (
      typeof previous !== "number" ||
      typeof current !== "number" ||
      current <= previous
    ) {
      return refuseParse(
        "A load-curve ladder's rungs must be strictly increasing.",
        omegaLadderRadPerS,
      );
    }
  }
  if (
    !Number.isInteger(options.stepsPerRung) ||
    options.stepsPerRung < 1 ||
    !Number.isInteger(options.averageWindowSteps) ||
    options.averageWindowSteps < 1 ||
    options.averageWindowSteps > options.stepsPerRung
  ) {
    return refuseParse(
      "A load-curve sweep needs integer steps per rung and an average window between 1 and the rung's steps.",
      options,
    );
  }
  const samples: TorqueSpeedSample[] = [];
  const aeroSamples: TorqueSpeedSample[] = [];
  for (const omega of omegaLadderRadPerS) {
    const rung = createMrf3dStepper({ ...config, omegaRadPerS: omega });
    if (!rung.ok) return rung;
    const stepper = rung.value;
    stepper.run(options.stepsPerRung);
    if (stepper.diverged) {
      return simFail(
        simError(
          SIM_ERROR_CODES.runDiverged,
          `The load-curve rung at ${omega.toPrecision(6)} rad/s diverged (step ${String(stepper.step)}) — the run freezes at its last valid step and no load sample is fabricated.`,
          { omegaRadPerS: omega, step: stepper.step },
        ),
      );
    }
    const series = stepper.rotationState().history[0]?.samples ?? [];
    const mean = windowedMean(series, options.averageWindowSteps);
    if (mean === undefined) {
      return refuseParse(
        "A load-curve rung recorded no torque samples to average.",
        { omegaRadPerS: omega },
      );
    }
    const aeroTorque = -mean;
    const drag =
      options.shaftDragTorqueNPerM === undefined
        ? 0
        : options.shaftDragTorqueNPerM(omega);
    if (!Number.isFinite(aeroTorque) || !Number.isFinite(drag)) {
      return refuseParse(
        "A load-curve rung produced a non-finite torque sample.",
        { omegaRadPerS: omega, aeroTorque, drag },
      );
    }
    aeroSamples.push({ omegaRadPerS: omega, torqueNPerM: aeroTorque });
    samples.push({ omegaRadPerS: omega, torqueNPerM: aeroTorque + drag });
  }
  return simOk({ samples, aeroSamples });
}

/**
 * Extracts airflow and ΔP from an MRF solution: the flow through the
 * plane normal to `axisIndex`, and the fluid-area-weighted mean
 * pressure difference between the two pressure planes. Solids are
 * excluded by the mask (their snapshot columns are not pressure
 * readings); the planes are interior by construction.
 */
export function extractFanPerformance(
  snapshot: Lbm3dSISnapshot,
  mask: Lbm3dSolidMask,
  axisIndex: 0 | 1 | 2,
  cellSizeM: number,
  extraction?: Partial<FanPlaneExtraction>,
): SimParseResult<FanPerformance, SimError> {
  const extents: readonly [number, number, number] = [
    mask.nx,
    mask.ny,
    mask.nz,
  ];
  const extent = extents[axisIndex];
  if (extent < 6) {
    return refuseParse(
      "Fan performance extraction needs at least six nodes along the rotation axis for interior planes.",
      { extent },
    );
  }
  const flowFraction =
    extraction?.flowPlaneFraction ??
    FAN_DEFAULT_PLANE_EXTRACTION.flowPlaneFraction;
  const pressureFractions =
    extraction?.pressurePlaneFractions ??
    FAN_DEFAULT_PLANE_EXTRACTION.pressurePlaneFractions;
  if (
    !Number.isFinite(flowFraction) ||
    flowFraction <= 0 ||
    flowFraction >= 1 ||
    pressureFractions.length !== 2 ||
    pressureFractions.some(
      (fraction) =>
        !Number.isFinite(fraction) || fraction <= 0 || fraction >= 1,
    ) ||
    (pressureFractions[1] ?? 0) <= (pressureFractions[0] ?? 0)
  ) {
    return refuseParse(
      "Fan performance plane fractions must be strictly inside (0, 1), pressure planes ordered upstream-first.",
      { flowFraction, pressureFractions },
    );
  }
  const planeIndexOf = (fraction: number): number =>
    Math.min(extent - 2, Math.max(1, Math.round(fraction * (extent - 1))));
  const flowPlaneIndex = planeIndexOf(flowFraction);
  const upstreamIndex = planeIndexOf(pressureFractions[0] ?? 0.25);
  const downstreamIndex = planeIndexOf(pressureFractions[1] ?? 0.75);
  const cellArea = cellSizeM * cellSizeM;
  const [nx, ny] = extents;
  const velocityOf = (index: number): readonly [number, number, number] => [
    snapshot.velocityXMPerS[index] ?? 0,
    snapshot.velocityYMPerS[index] ?? 0,
    snapshot.velocityZMPerS[index] ?? 0,
  ];
  const planeSum = (
    planeIndex: number,
    value: (index: number) => number,
  ): { sum: number; count: number } => {
    let sum = 0;
    let count = 0;
    const coords: [number, number, number] = [0, 0, 0];
    coords[axisIndex] = planeIndex;
    const others = ([0, 1, 2] as const).filter((axis) => axis !== axisIndex);
    const [o1, o2] = others;
    if (o1 === undefined || o2 === undefined) return { sum: 0, count: 0 };
    const extent1 = extents[o1];
    const extent2 = extents[o2];
    for (let a = 0; a < extent1; a += 1) {
      for (let b = 0; b < extent2; b += 1) {
        coords[o1] = a;
        coords[o2] = b;
        const index =
          (coords[0] ?? 0) + (coords[1] ?? 0) * nx + (coords[2] ?? 0) * nx * ny;
        if (mask.solid[index] === 1) continue;
        sum += value(index);
        count += 1;
      }
    }
    return { sum, count };
  };
  const flow = planeSum(flowPlaneIndex, (index) => {
    const [vx, vy, vz] = velocityOf(index);
    return axisIndex === 0 ? vx : axisIndex === 1 ? vy : vz;
  });
  const upstream = planeSum(
    upstreamIndex,
    (index) => snapshot.pressurePa[index] ?? 0,
  );
  const downstream = planeSum(
    downstreamIndex,
    (index) => snapshot.pressurePa[index] ?? 0,
  );
  if (upstream.count === 0 || downstream.count === 0 || flow.count === 0) {
    return refuseParse(
      "Fan performance extraction found no fluid nodes on a measurement plane.",
      { flowPlaneIndex, upstreamIndex, downstreamIndex },
    );
  }
  return simOk({
    airflowM3PerS: flow.sum * cellArea,
    deltaPPa: downstream.sum / downstream.count - upstream.sum / upstream.count,
    flowPlaneIndex,
    pressurePlaneIndexes: [upstreamIndex, downstreamIndex],
  });
}

/** The dominant coordinate axis of a rotation direction, or the refusal. */
function coordinateAxisIndexOf(
  direction: readonly [number, number, number],
): SimParseResult<0 | 1 | 2, SimError> {
  const [dx, dy, dz] = direction;
  const norm = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (!(norm > 0) || !Number.isFinite(norm)) {
    return refuseParse(
      "A fan analysis needs a non-zero rotation direction.",
      direction,
    );
  }
  const components = [
    Math.abs(dx) / norm,
    Math.abs(dy) / norm,
    Math.abs(dz) / norm,
  ];
  let best: 0 | 1 | 2 = 0;
  for (let i = 1; i < 3; i += 1) {
    if ((components[i] ?? 0) > (components[best] ?? 0)) best = i as 0 | 1 | 2;
  }
  if ((components[best] ?? 0) < 0.99) {
    return refuseParse(
      "Fan performance extraction needs the rotation axis parallel to a coordinate axis (the plane sums' own honesty) — torque-only analysis tolerates any axis, this read does not.",
      direction,
    );
  }
  return simOk(best);
}

/** The rotor's tip radius: solids inside the rotating zone, metres. */
function fanTipRadius(
  config: Omit<Lbm3dMrfConfig, "omegaRadPerS">,
): SimParseResult<number, SimError> {
  const { nx, ny, nz } = config.mask;
  const plane = nx * ny;
  const [dx, dy, dz] = config.axis.direction;
  const norm = Math.sqrt(dx * dx + dy * dy + dz * dz);
  const ex = dx / norm;
  const ey = dy / norm;
  const ez = dz / norm;
  const originM = config.originM ?? [0, 0, 0];
  const axp = (config.axis.pointM[0] - (originM[0] ?? 0)) / config.cellSizeM;
  const ayp = (config.axis.pointM[1] - (originM[1] ?? 0)) / config.cellSizeM;
  const azp = (config.axis.pointM[2] - (originM[2] ?? 0)) / config.cellSizeM;
  let maxRadius = 0;
  let rotorNodes = 0;
  for (let z = 0; z < nz; z += 1) {
    for (let y = 0; y < ny; y += 1) {
      for (let x = 0; x < nx; x += 1) {
        const index = x + y * nx + z * plane;
        if (config.mask.solid[index] !== 1) continue;
        if (!config.rotatingZone(x, y, z)) continue;
        rotorNodes += 1;
        const rx = x - axp;
        const ry = y - ayp;
        const rz = z - azp;
        const along = rx * ex + ry * ey + rz * ez;
        const px = rx - along * ex;
        const py = ry - along * ey;
        const pz = rz - along * ez;
        maxRadius = Math.max(maxRadius, Math.sqrt(px * px + py * py + pz * pz));
      }
    }
  }
  if (rotorNodes === 0) {
    return refuseParse(
      "A fan analysis needs its rotor inside the rotating zone — no solid nodes live there.",
      config.rotatingZone,
    );
  }
  return simOk(maxRadius * config.cellSizeM);
}

/**
 * The full motor-driven analysis: sweep the ladder, solve the operating
 * point (every intersection reported, the stable one taken, ambiguity
 * declined), then read the performance from a final MRF rung AT the
 * found speed and assemble the powers, BPF, and the S9 guidance line.
 */
export function analyzeFanOperatingPoint(
  config: FanAnalysisConfig,
  motor: CompiledSimMotor,
): SimParseResult<FanOperatingPointResult, SimError> {
  if (!Number.isInteger(config.bladeCount) || config.bladeCount < 1) {
    return refuseParse(
      "A fan analysis needs a positive integer blade count (the authored scenario field BPF consumes).",
      config.bladeCount,
    );
  }
  const sweep = runFanLoadCurveSweep(config.mrf, config.omegaLadderRadPerS, {
    stepsPerRung: config.stepsPerRung,
    averageWindowSteps: config.averageWindowSteps,
    ...(config.shaftDragTorqueNPerM === undefined
      ? {}
      : { shaftDragTorqueNPerM: config.shaftDragTorqueNPerM }),
  });
  if (!sweep.ok) return sweep;
  const solve = solveOperatingPoint(motor, sweep.value.samples);
  if (!solve.ok) return solve;
  const axisIndex = coordinateAxisIndexOf(config.mrf.axis.direction);
  if (!axisIndex.ok) return axisIndex;
  const tipRadius = fanTipRadius(config.mrf);
  if (!tipRadius.ok) return tipRadius;
  // The verification rung: the MRF solution at the operating speed.
  const rung = createMrf3dStepper({
    ...config.mrf,
    omegaRadPerS: solve.value.omegaRadPerS,
  });
  if (!rung.ok) return rung;
  rung.value.run(config.stepsPerRung);
  if (rung.value.diverged) {
    return simFail(
      simError(
        SIM_ERROR_CODES.runDiverged,
        `The verification rung at the operating point (${solve.value.omegaRadPerS.toPrecision(6)} rad/s) diverged — no performance is fabricated.`,
        { omegaRadPerS: solve.value.omegaRadPerS, step: rung.value.step },
      ),
    );
  }
  const series = rung.value.rotationState().history[0]?.samples ?? [];
  const verifyMean = windowedMean(series, config.averageWindowSteps);
  if (verifyMean === undefined) {
    return refuseParse(
      "The verification rung recorded no torque samples.",
      solve.value.omegaRadPerS,
    );
  }
  const performance = extractFanPerformance(
    rung.value.snapshotSI(),
    config.mrf.mask,
    axisIndex.value,
    config.mrf.cellSizeM,
    config.extraction,
  );
  if (!performance.ok) return performance;
  const { omegaRadPerS, torqueNPerM, rpm } = solve.value;
  const shaftPowerW = torqueNPerM * omegaRadPerS;
  const fanAirPowerW =
    performance.value.deltaPPa * performance.value.airflowM3PerS;
  const powers: FanPowers = {
    shaftPowerW,
    fanAirPowerW,
    ...(motor.kind === "dc-brushed" || motor.kind === "bldc"
      ? {
          electricalPowerW:
            (motor.nominalVoltageV * torqueNPerM) / motor.ktNPerA,
          motorEfficiency:
            (torqueNPerM * omegaRadPerS) /
            ((motor.nominalVoltageV * torqueNPerM) / motor.ktNPerA),
          systemEfficiency:
            fanAirPowerW /
            ((motor.nominalVoltageV * torqueNPerM) / motor.ktNPerA),
        }
      : {}),
  };
  const tipSpeed = omegaRadPerS * tipRadius.value;
  const reynolds =
    (tipSpeed * 2 * tipRadius.value) /
    config.mrf.fluid.kinematicViscosityM2PerS;
  return simOk({
    solve: solve.value,
    performance: performance.value,
    verifyRungTorqueNPerM: -verifyMean,
    powers,
    bladePassFrequencyHz: bladePassFrequencyHz(config.bladeCount, rpm),
    regime: {
      reynolds,
      lowReynoldsFan: reynolds < FAN_LOW_REYNOLDS_ADVISORY,
      turbulent: reynolds >= SIM_REGIME_THRESHOLDS.turbulentReynolds,
    },
    loadCurve: sweep.value,
    tipRadiusM: tipRadius.value,
    stepsPerRevolution: rung.value.meta.stepsPerRevolution,
  });
}
