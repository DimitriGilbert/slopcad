/**
 * The operating point (Phase 66b, ROADMAP-SIM §7.9's ruling): a
 * selected motor record turns the fan load curve T_load(ω) into an
 * operating point by solving T_motor(ω) = T_load(ω). This module is
 * the pure arithmetic — no lattice, no fluid — so its fixtures are
 * hand-solvable in closed form: both curves are piecewise linear (the
 * load curve through the MRF sweep's samples, the motor straight for
 * the analytic kinds and interpolated as authored for the tabulated
 * kind), and every intersection is the exact root of one linear
 * piece, solved in closed form and classified by slopes.
 *
 * ## The stability criterion
 *
 * An intersection is STABLE where dT_load/dω > dT_motor/dω — the
 * load's torque rises faster than the motor's delivers, so a speed
 * excursion is pushed back (the roadmap's own criterion). For piecewise
 * linear curves this is the segment-slope comparison at the root,
 * exact. A tangent root (slopes equal within tolerance) is NEUTRAL —
 * neutrally stable pairings are genuinely ambiguous, not stable.
 *
 * ## The decline discipline (roadmap risk S13)
 *
 * Multiple intersections are ALL reported with their classification;
 * exactly one stable intersection is taken. Anything else — no
 * intersection in the swept band, none stable, two or more stable, a
 * tangent root, or a collinear overlap (the curves coincide over an
 * interval — infinitely many intersections) — declines structured with
 * `sim/operating-point-ambiguous` (the code the Phase 61 spine carved
 * for exactly this), never a guess.
 */

import {
  type CompiledSimMotor,
  type SimError,
  SIM_ERROR_CODES,
  type SimParseResult,
  simError,
  simFail,
  simOk,
} from "@slopcad/sim-core";

/** One load-curve sample: a rung of the MRF ω ladder with its torque. */
export interface TorqueSpeedSample {
  readonly omegaRadPerS: number;
  readonly torqueNPerM: number;
}

/** One intersection of the motor and load curves, classified. */
export interface OperatingPointCandidate {
  readonly omegaRadPerS: number;
  readonly torqueNPerM: number;
  /** dT_load/dω > dT_motor/dω at the root (the stability criterion). */
  readonly stable: boolean;
  /** dT_load/dω at the root, N·m per rad/s. */
  readonly loadSlopeNPerMPerRadPerS: number;
  /** dT_motor/dω at the root, N·m per rad/s. */
  readonly motorSlopeNPerMPerRadPerS: number;
}

/** The found operating point (SI, plus the datasheet speed unit). */
export interface FanOperatingPointSolve {
  readonly omegaRadPerS: number;
  readonly torqueNPerM: number;
  readonly rpm: number;
  /** Every intersection found, the stable one first among equals. */
  readonly candidates: readonly OperatingPointCandidate[];
}

/** rpm from rad/s (the authored motor unit). */
export function rpmOf(omegaRadPerS: number): number {
  return (omegaRadPerS * 60) / (2 * Math.PI);
}

/**
 * The motor torque at one speed — the analytic kinds' straight line
 * T = T_stall·(1 − ω/ω₀) on [0, ω₀], the tabulated kind's linear
 * interpolation between its authored points (as authored — no fit, no
 * extrapolation; outside the table the segment slope nearest the query
 * continues the line, the piecewise-linear curve's own extension).
 */
export function motorTorqueAt(
  motor: CompiledSimMotor,
  omegaRadPerS: number,
): number {
  if (motor.kind === "tabulated") {
    return piecewiseLinearAt(
      motor.points.map((point) => ({
        x: point.speedRadPerS,
        y: point.torqueNPerM,
      })),
      omegaRadPerS,
    );
  }
  return motor.stallTorqueNPerM * (1 - omegaRadPerS / motor.noLoadSpeedRadPerS);
}

/** The motor curve's slope at one speed (the stability input). */
export function motorTorqueSlope(
  motor: CompiledSimMotor,
  omegaRadPerS: number,
): number {
  if (motor.kind === "tabulated") {
    return piecewiseLinearSlope(
      motor.points.map((point) => ({
        x: point.speedRadPerS,
        y: point.torqueNPerM,
      })),
      omegaRadPerS,
    );
  }
  return -motor.stallTorqueNPerM / motor.noLoadSpeedRadPerS;
}

interface PiecePoint {
  readonly x: number;
  readonly y: number;
}

function piecewiseLinearAt(points: readonly PiecePoint[], x: number): number {
  const first = points[0];
  const last = points[points.length - 1];
  if (first === undefined || last === undefined) return 0;
  if (x <= first.x) return first.y;
  if (x >= last.x) {
    // Continue the last segment (the curve's own extension).
    const slope = slopeBetween(points[points.length - 2], last);
    return last.y + slope * (x - last.x);
  }
  for (let i = 0; i < points.length - 1; i += 1) {
    const a = points[i];
    const b = points[i + 1];
    if (a === undefined || b === undefined) continue;
    if (x >= a.x && x <= b.x) {
      return a.y + slopeBetween(a, b) * (x - a.x);
    }
  }
  return last.y;
}

function piecewiseLinearSlope(
  points: readonly PiecePoint[],
  x: number,
): number {
  const first = points[0];
  const last = points[points.length - 1];
  if (first === undefined || last === undefined) return 0;
  for (let i = 0; i < points.length - 1; i += 1) {
    const a = points[i];
    const b = points[i + 1];
    if (a === undefined || b === undefined) continue;
    if (x >= a.x && x <= b.x) return slopeBetween(a, b);
  }
  if (x < first.x) return slopeBetween(first, points[1]);
  return slopeBetween(points[points.length - 2], last);
}

function slopeBetween(
  a: PiecePoint | undefined,
  b: PiecePoint | undefined,
): number {
  if (a === undefined || b === undefined) return 0;
  const span = b.x - a.x;
  if (Math.abs(span) < 1e-15) return 0;
  return (b.y - a.y) / span;
}

/** The load curve's piecewise-linear evaluation (samples as authored). */
export function loadTorqueAt(
  load: readonly TorqueSpeedSample[],
  omegaRadPerS: number,
): number {
  return piecewiseLinearAt(
    load.map((sample) => ({ x: sample.omegaRadPerS, y: sample.torqueNPerM })),
    omegaRadPerS,
  );
}

/** The load curve's piecewise-linear slope. */
export function loadTorqueSlope(
  load: readonly TorqueSpeedSample[],
  omegaRadPerS: number,
): number {
  return piecewiseLinearSlope(
    load.map((sample) => ({ x: sample.omegaRadPerS, y: sample.torqueNPerM })),
    omegaRadPerS,
  );
}

/** A validated load curve: at least two strictly increasing speeds. */
export function validatedLoadCurve(
  load: readonly TorqueSpeedSample[],
): SimParseResult<readonly TorqueSpeedSample[], SimError> {
  const refuse = (
    message: string,
    at: unknown,
  ): SimParseResult<never, SimError> =>
    simFail(simError(SIM_ERROR_CODES.scenarioInvalid, message, at));
  if (load.length < 2) {
    return refuse(
      "A load curve needs at least two swept rungs to interpolate.",
      load,
    );
  }
  for (const sample of load) {
    if (
      typeof sample.omegaRadPerS !== "number" ||
      !Number.isFinite(sample.omegaRadPerS) ||
      typeof sample.torqueNPerM !== "number" ||
      !Number.isFinite(sample.torqueNPerM)
    ) {
      return refuse(
        "A load-curve sample needs a finite speed (rad/s) and torque (N·m).",
        sample,
      );
    }
  }
  for (let i = 1; i < load.length; i += 1) {
    const previous = load[i - 1];
    const current = load[i];
    if (
      previous !== undefined &&
      current !== undefined &&
      current.omegaRadPerS <= previous.omegaRadPerS
    ) {
      return refuse(
        "A load curve's rungs must carry strictly increasing speeds (sweep order).",
        load,
      );
    }
  }
  return simOk(load);
}

/** The motor curve as piecewise-linear pieces over its speed domain. */
function motorPieces(motor: CompiledSimMotor): readonly PiecePoint[] {
  if (motor.kind === "tabulated") {
    return motor.points.map((point) => ({
      x: point.speedRadPerS,
      y: point.torqueNPerM,
    }));
  }
  return [
    { x: 0, y: motor.stallTorqueNPerM },
    { x: motor.noLoadSpeedRadPerS, y: 0 },
  ];
}

/**
 * Every intersection of the motor and load curves on their overlapping
 * speed domain, exact per linear piece and classified by the stability
 * criterion; a collinear overlap (the curves coincide over an interval)
 * is reported as a candidate at NaN — the marker `solveOperatingPoint`
 * declines on. Deterministic: fixed piece order, closed-form roots.
 */
export function intersectMotorLoadCurve(
  motor: CompiledSimMotor,
  load: readonly TorqueSpeedSample[],
): readonly OperatingPointCandidate[] {
  const motorPoints = motorPieces(motor);
  const loadPoints: readonly PiecePoint[] = load.map((sample) => ({
    x: sample.omegaRadPerS,
    y: sample.torqueNPerM,
  }));
  const candidates: OperatingPointCandidate[] = [];
  // Piece overlap scan: load pieces × motor pieces, fixed order.
  for (let li = 0; li < loadPoints.length - 1; li += 1) {
    const la = loadPoints[li];
    const lb = loadPoints[li + 1];
    if (la === undefined || lb === undefined) continue;
    for (let mi = 0; mi < motorPoints.length - 1; mi += 1) {
      const ma = motorPoints[mi];
      const mb = motorPoints[mi + 1];
      if (ma === undefined || mb === undefined) continue;
      const lo = Math.max(la.x, ma.x);
      const hi = Math.min(lb.x, mb.x);
      if (hi < lo) continue;
      const loadSlope = slopeBetween(la, lb);
      const motorSlope = slopeBetween(ma, mb);
      const gLo =
        ma.y + motorSlope * (lo - ma.x) - (la.y + loadSlope * (lo - la.x));
      const gHi =
        ma.y + motorSlope * (hi - ma.x) - (la.y + loadSlope * (hi - la.x));
      const slopeDifference = motorSlope - loadSlope;
      const scale = Math.max(Math.abs(ma.y), Math.abs(la.y), 1e-30);
      const tolerance = 1e-9 * scale;
      if (Math.abs(slopeDifference) < 1e-12) {
        // Parallel pieces: an exact-sign flip still crosses only
        // discontinuously — impossible for equal slopes unless the
        // pieces coincide (collinear overlap), which gLo ~ 0 marks.
        if (Math.abs(gLo) <= tolerance) {
          candidates.push(collinearCandidate());
        }
        continue;
      }
      if (Math.abs(gLo) <= tolerance) {
        pushCandidate(candidates, lo, loadSlope, motorSlope);
        continue;
      }
      if (Math.abs(gHi) <= tolerance) {
        pushCandidate(candidates, hi, loadSlope, motorSlope);
        continue;
      }
      if (Math.sign(gLo) !== Math.sign(gHi)) {
        const root = lo + (gLo / (gLo - gHi)) * (hi - lo);
        if (root >= lo - tolerance && root <= hi + tolerance) {
          pushCandidate(candidates, root, loadSlope, motorSlope);
        }
      }
    }
  }
  return dedupeCandidates(candidates);
}

function collinearCandidate(): OperatingPointCandidate {
  return {
    omegaRadPerS: Number.NaN,
    torqueNPerM: Number.NaN,
    stable: false,
    loadSlopeNPerMPerRadPerS: 0,
    motorSlopeNPerMPerRadPerS: 0,
  };
}

function pushCandidate(
  candidates: OperatingPointCandidate[],
  omega: number,
  loadSlope: number,
  motorSlope: number,
): void {
  candidates.push({
    omegaRadPerS: omega,
    torqueNPerM: Number.NaN, // filled by the caller against the motor curve
    stable: loadSlope > motorSlope + 1e-12,
    loadSlopeNPerMPerRadPerS: loadSlope,
    motorSlopeNPerMPerRadPerS: motorSlope,
  });
}

function dedupeCandidates(
  candidates: readonly OperatingPointCandidate[],
): OperatingPointCandidate[] {
  const finite = candidates.filter((candidate) =>
    Number.isFinite(candidate.omegaRadPerS),
  );
  const sorted = [...finite].sort((a, b) => a.omegaRadPerS - b.omegaRadPerS);
  const merged: OperatingPointCandidate[] = [];
  for (const candidate of sorted) {
    const previous = merged[merged.length - 1];
    if (
      previous !== undefined &&
      Math.abs(candidate.omegaRadPerS - previous.omegaRadPerS) <=
        1e-9 * Math.max(1, Math.abs(previous.omegaRadPerS))
    ) {
      // The same root seen from two pieces: stable only if BOTH sides
      // say so (a kink root must satisfy the criterion on each side).
      if (previous.stable && !candidate.stable) {
        merged[merged.length - 1] = { ...previous, stable: false };
      }
      continue;
    }
    merged.push(candidate);
  }
  const collinear = candidates.some(
    (candidate) => !Number.isFinite(candidate.omegaRadPerS),
  );
  return collinear ? [...merged, collinearCandidate()] : merged;
}

/**
 * Solves the operating point: every intersection reported, exactly one
 * stable one taken, everything else a structured decline — the
 * roadmap's discipline, verbatim.
 */
export function solveOperatingPoint(
  motor: CompiledSimMotor,
  load: readonly TorqueSpeedSample[],
): SimParseResult<FanOperatingPointSolve, SimError> {
  const validated = validatedLoadCurve(load);
  if (!validated.ok) return validated;
  const candidates = intersectMotorLoadCurve(motor, load);
  const refuse = (
    message: string,
    at: unknown,
  ): SimParseResult<never, SimError> =>
    simFail(simError(SIM_ERROR_CODES.operatingPointAmbiguous, message, at));
  const reportable = candidates.filter((candidate) =>
    Number.isFinite(candidate.omegaRadPerS),
  );
  const withTorque = reportable.map((candidate) => ({
    ...candidate,
    torqueNPerM: motorTorqueAt(motor, candidate.omegaRadPerS),
  }));
  const stable = withTorque.filter((candidate) => candidate.stable);
  const collinear = candidates.length > reportable.length;
  if (collinear) {
    return refuse(
      "The motor and load curves coincide over a speed interval — infinitely many intersections; the pairing is genuinely ambiguous and no operating point is guessed.",
      withTorque,
    );
  }
  if (withTorque.length === 0) {
    return refuse(
      "The motor and load curves do not intersect inside the swept band — no operating point exists there; widen the sweep or re-pair the motor.",
      load,
    );
  }
  if (stable.length === 0) {
    return refuse(
      `Every intersection of the motor and load curves is unstable (dT_load/dω ≤ dT_motor/dω at all ${String(withTorque.length)} of them) — the pairing cannot hold a steady speed.`,
      withTorque,
    );
  }
  if (stable.length > 1) {
    return refuse(
      `The motor and load curves intersect stably at ${String(stable.length)} speeds — multiple stable operating points; the pairing is genuinely ambiguous and none is guessed.`,
      withTorque,
    );
  }
  const chosen = stable[0];
  if (chosen === undefined) {
    return refuse("The operating-point solve produced no candidate.", load);
  }
  return simOk({
    omegaRadPerS: chosen.omegaRadPerS,
    torqueNPerM: chosen.torqueNPerM,
    rpm: rpmOf(chosen.omegaRadPerS),
    candidates: withTorque,
  });
}

/**
 * The blade-passing frequency — BPF = blades × RPM, arithmetic from the
 * found operating point (the honest ceiling of the aeroacoustics
 * scope, §6): blade count × revolutions per minute, in hertz.
 */
export function bladePassFrequencyHz(bladeCount: number, rpm: number): number {
  return (bladeCount * rpm) / 60;
}
