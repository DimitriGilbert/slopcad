/**
 * The oracle-vs-GPU tolerance harness (Phase 64a, requirement 4) —
 * law S5's GPU gate: the WGSL provider is NEVER bit-asserted against
 * the CPU oracle and never silently trusted; it is compared against
 * it at matched step counts over a scenario matrix, with the
 * tolerances RECORDED AS DATA and their derivation documented here.
 *
 * ## What is compared (and why those things)
 *
 * - the NINE DISTRIBUTION ARRAYS, pooled — the layout contract's own
 *   named diff surface (`./d2q9`: "the Phase 64 harness diffs these
 *   buffers against GPU readbacks cell-for-cell without a
 *   permutation"); this catches every indexing, streaming, and
 *   boundary-reconstruction deviation at its source;
 * - the macroscopic fields (ρ, u_x, u_y) — what users see;
 * - the force histories (drag, lift) — the integrated quantities.
 *
 * Deltas are relative L2 (‖a−b‖₂/‖a‖₂) and relative L∞
 * (max|a−b|/max|a|), the same honest normalizers the
 * grid-convergence self-check uses (`./convergence`); force deltas
 * normalize by the oracle's peak magnitude over the run, because lift
 * crosses zero and self-normalization would blow up.
 *
 * ## The tolerance derivation (recorded, with reasoning)
 *
 * The CPU kernel computes macroscopic and collision terms in f64 and
 * stores f32; the WGSL kernel is f32 throughout. One step's relative
 * rounding difference is therefore O(2⁻²⁴) per operation — around
 * 1e-7. Every matrix scenario is LAMINAR and contracts toward a
 * steady attractor (Poiseuille's developed parabola, the cylinder's
 * attached wake at Re ≈ 33, the half-domain's settled mirror state),
 * so per-step differences do not compound exponentially: they
 * saturate at the attractor's rounding floor, a few orders above
 * 1e-7. The recorded bands sit roughly three orders above that floor
 * and at least an order BELOW anything structural: a permuted
 * direction, a wrong reflection table, or a misapplied face
 * reconstruction displaces O(1) mass or momentum and cannot hide
 * under 1e-2. Force histories carry the widest bands because the
 * momentum-exchange impulse is a small difference of large opposing
 * streams — the same cancellation that makes forces the honest
 * integrated quantity also amplifies rounding the most. A shedding
 * (chaotic) case would need Lyapunov-grown bands and stays OUT of the
 * matrix until a real-device campaign measures the growth; the bands
 * below are for the laminar matrix as recorded.
 *
 * ## Skip-loudly (never a silent pass)
 *
 * The harness runs under any WebGPU-capable host and, where no device
 * exists (plain node, the default unit environment), the matrix is
 * SKIPPED with a visible marker and its reason — {@link gpuOracleSkipReason}
 * produces the banner, the test prints it and calls `ctx.skip()`. The
 * comparison ARITHMETIC itself is pinned headlessly by unit tests
 * against hand-computed vectors, so the gate cannot rot untested.
 */

import type { WgslDevice } from "./gpu-device";

import { analyticOccupancy, testFluid } from "./fixtures";
import { type LbmStepperConfig, createLbmStepper } from "./stepper";
import { createWgslLbmStepper } from "./wgsl-stepper";

/** One field-pair comparison outcome (the honest relative normalizers). */
export interface GpuFieldDelta {
  /** ‖oracle − provider‖₂ / ‖oracle‖₂ over the field. */
  readonly l2Relative: number;
  /** max|oracle − provider| / max|oracle| over the field. */
  readonly linfRelative: number;
}

/** One history-pair comparison outcome. */
export interface GpuForceDelta extends GpuFieldDelta {
  /** The oracle's peak magnitude over the run (the normalizer used). */
  readonly oraclePeak: number;
}

/** The recorded tolerances for one matrix case (data, derivation above). */
export interface GpuOracleTolerances {
  readonly distributionL2Relative: number;
  readonly distributionLinfRelative: number;
  readonly macroL2Relative: number;
  readonly macroLinfRelative: number;
  readonly forceL2Relative: number;
  readonly forceLinfRelative: number;
}

/** One matrix case: a stepper config, a matched step count, tolerances. */
export interface GpuOracleCase {
  readonly id: string;
  readonly config: LbmStepperConfig;
  readonly steps: number;
  readonly tolerances: GpuOracleTolerances;
}

/** The full comparison report for one matrix case. */
export interface GpuOracleCaseReport {
  readonly id: string;
  readonly steps: number;
  /** Divergence on either side voids the comparison (reported, never passed). */
  readonly diverged: boolean;
  readonly distribution: GpuFieldDelta;
  readonly rho: GpuFieldDelta;
  readonly ux: GpuFieldDelta;
  readonly uy: GpuFieldDelta;
  readonly drag: GpuForceDelta;
  readonly lift: GpuForceDelta;
}

/**
 * The skip marker's reason when no WebGPU device exists — printed
 * loudly by the tests that skip, so the gate never silently passes.
 */
export function gpuOracleSkipReason(): string {
  return [
    "[gpu-oracle] SKIPPED: no WebGPU device on this host.",
    "The S5 oracle-vs-GPU matrix compared nothing — the CPU oracle remains",
    "the test truth. Run under a WebGPU-capable host (the Phase 64b",
    "Dawn/Playwright spike is the sanctioned door) to execute this gate;",
    "the comparison arithmetic itself is pinned headlessly in",
    "`gpu-oracle.test.ts`.",
  ].join(" ");
}

export function gpuFieldDelta(
  oracle: ArrayLike<number>,
  provider: ArrayLike<number>,
): GpuFieldDelta {
  if (oracle.length !== provider.length) {
    throw new Error(
      `An oracle-vs-GPU field comparison needs equal lengths, received ${String(oracle.length)}/${String(provider.length)}.`,
    );
  }
  let differenceSq = 0;
  let oracleSq = 0;
  let maxDifference = 0;
  let maxOracle = 0;
  for (let index = 0; index < oracle.length; index += 1) {
    const a = oracle[index] ?? 0;
    const b = provider[index] ?? 0;
    const difference = a - b;
    differenceSq += difference * difference;
    oracleSq += a * a;
    const magnitude = Math.abs(difference);
    if (magnitude > maxDifference) maxDifference = magnitude;
    const oracleMagnitude = Math.abs(a);
    if (oracleMagnitude > maxOracle) maxOracle = oracleMagnitude;
  }
  const l2Denominator = Math.sqrt(oracleSq);
  if (l2Denominator === 0) {
    throw new Error(
      "An oracle-vs-GPU field comparison needs a non-zero oracle field to normalize against.",
    );
  }
  return {
    l2Relative: Math.sqrt(differenceSq) / l2Denominator,
    linfRelative: maxDifference / maxOracle,
  };
}

export function gpuForceDelta(
  oracle: readonly number[],
  provider: readonly number[],
  fallbackScale = 0,
): GpuForceDelta {
  let oraclePeak = 0;
  for (const sample of oracle) {
    const magnitude = Math.abs(sample);
    if (magnitude > oraclePeak) oraclePeak = magnitude;
  }
  let providerPeak = 0;
  for (const sample of provider) {
    const magnitude = Math.abs(sample);
    if (magnitude > providerPeak) providerPeak = magnitude;
  }
  let differenceSq = 0;
  let maxDifference = 0;
  for (let index = 0; index < oracle.length; index += 1) {
    const difference = (oracle[index] ?? 0) - (provider[index] ?? 0);
    differenceSq += difference * difference;
    const magnitude = Math.abs(difference);
    if (magnitude > maxDifference) maxDifference = magnitude;
  }
  // The Phase 64b spike's second finding: a SYMMETRIC case's oracle lift
  // history is identically zero (the f64 twin cancels top/bottom exactly
  // — the poiseuille channel, the centered cylinder), and the recorded
  // matrix could never run past its own normalizer refusal. The honest
  // comparisons: both sides identically zero is EXACT agreement; an
  // identically-zero oracle against a provider's rounding noise
  // (f32 reduction asymmetry) measures against the run's FORCE SCALE
  // (the caller passes the drag peak) — the physically meaningful
  // yardstick. No scale, no comparison: the refusal stands.
  if (oraclePeak === 0) {
    if (providerPeak === 0) {
      return { l2Relative: 0, linfRelative: 0, oraclePeak: 0 };
    }
    if (fallbackScale > 0) {
      return {
        l2Relative: Math.sqrt(differenceSq) / fallbackScale,
        linfRelative: maxDifference / fallbackScale,
        oraclePeak: 0,
      };
    }
    throw new Error(
      "An oracle-vs-GPU force comparison needs a non-zero oracle history (or a non-zero fallback force scale) to normalize against.",
    );
  }
  const oracleSq = oracle.reduce((sum, sample) => sum + sample * sample, 0);
  return {
    l2Relative:
      oracleSq === 0 ? Infinity : Math.sqrt(differenceSq) / Math.sqrt(oracleSq),
    linfRelative: maxDifference / oraclePeak,
    oraclePeak,
  };
}

/**
 * The recorded tolerance set for the laminar matrix: derived in the
 * module contract above (three orders above the f32 rounding floor,
 * an order below any structural deviation).
 */
export const GPU_ORACLE_TOLERANCES: GpuOracleTolerances = {
  distributionL2Relative: 1e-2,
  distributionLinfRelative: 5e-2,
  macroL2Relative: 1e-2,
  macroLinfRelative: 5e-2,
  forceL2Relative: 1e-1,
  forceLinfRelative: 2e-1,
};

/** The scenario matrix — the Phase 63 fixtures' shapes at small grids. */
export const GPU_ORACLE_MATRIX: readonly GpuOracleCase[] = [
  {
    id: "poiseuille-channel",
    // The poiseuille fixture's channel: developed laminar flow, the
    // tightest expected agreement (a contractive steady attractor).
    config: {
      mask: { nx: 48, ny: 17, solid: new Uint8Array(48 * 17) },
      fluid: testFluid(1.2, 2e-4),
      cellSizeM: 0.001,
      characteristicVelocityMPerS: 0.075,
      collision: { kind: "trt" },
      west: { kind: "velocity-inlet", velocityMPerS: [0.05, 0] },
      east: { kind: "pressure-outlet", pressurePa: 0 },
      south: { kind: "wall", slip: false },
      north: { kind: "wall", slip: false },
    },
    steps: 400,
    tolerances: GPU_ORACLE_TOLERANCES,
  },
  {
    id: "cylinder-attached-wake",
    // The cylinder fixture's disc at its steady attached-wake Re ≈ 33:
    // solid bounce-back + momentum-exchange forces under exercise.
    config: {
      mask: {
        nx: 48,
        ny: 24,
        solid: analyticOccupancy(
          48,
          24,
          (x, y) => (x - 16) ** 2 + (y - 11.5) ** 2 <= 4.5 ** 2,
        ),
      },
      fluid: testFluid(1.2, 2.7e-5),
      cellSizeM: 0.001,
      characteristicVelocityMPerS: 0.1,
      collision: { kind: "trt" },
      west: { kind: "velocity-inlet", velocityMPerS: [0.1, 0] },
      east: { kind: "pressure-outlet", pressurePa: 0 },
      south: { kind: "wall", slip: false },
      north: { kind: "wall", slip: false },
    },
    steps: 600,
    tolerances: GPU_ORACLE_TOLERANCES,
  },
  {
    id: "symmetry-half-domain",
    // The symmetry fixture's half domain: the specular-reflection face
    // and the convective outflow under exercise.
    config: {
      mask: {
        nx: 48,
        ny: 20,
        solid: analyticOccupancy(
          48,
          20,
          (x, y) => (x - 14) ** 2 + (y + 0.5) ** 2 <= 5.5 ** 2,
        ),
      },
      fluid: testFluid(1.2, 2.7e-5),
      cellSizeM: 0.001,
      characteristicVelocityMPerS: 0.1,
      collision: { kind: "trt" },
      west: { kind: "velocity-inlet", velocityMPerS: [0.1, 0] },
      east: { kind: "convective-outflow" },
      south: { kind: "symmetry" },
      north: { kind: "wall", slip: false },
    },
    steps: 400,
    tolerances: GPU_ORACLE_TOLERANCES,
  },
];

/**
 * Runs one matrix case on both kernels at matched step counts and
 * computes the deltas. Comparison only — the assertions (and the
 * tolerance data) live with the callers.
 */
export async function runGpuOracleCase(
  device: WgslDevice,
  testCase: GpuOracleCase,
): Promise<GpuOracleCaseReport> {
  const oracle = createLbmStepper(testCase.config);
  if (!oracle.ok) throw new Error(oracle.error.message);
  oracle.value.run(testCase.steps);
  const provider = await createWgslLbmStepper(testCase.config, device, {
    stepCapacity: testCase.steps,
  });
  if (!provider.ok) throw new Error(provider.error.message);
  for (let step = 0; step < testCase.steps; step += 1) {
    provider.value.advance();
  }
  await provider.value.syncStatus();
  const oracleDistributions = oracle.value.distributions();
  const providerDistributions = await provider.value.distributions();
  // The pooled distribution comparison: one delta over the
  // concatenation of the nine per-direction planes — cell-for-cell,
  // the layout contract's own diff discipline.
  const oracleFlat: number[] = [];
  const providerFlat: number[] = [];
  for (let i = 0; i < oracleDistributions.length; i += 1) {
    const plane = oracleDistributions[i];
    const gpuPlane = providerDistributions[i];
    if (plane === undefined || gpuPlane === undefined) continue;
    for (let n = 0; n < plane.length; n += 1) {
      oracleFlat.push(plane[n] ?? 0);
      providerFlat.push(gpuPlane[n] ?? 0);
    }
  }
  const oracleMacro = oracle.value.snapshotLattice();
  const providerMacro = await provider.value.snapshotLattice();
  const oracleForces = oracle.value.forceState().history;
  const providerForces = (await provider.value.forceState()).history;
  provider.value.destroy();
  // The drag pair first: its oracle peak is the run's force scale, the
  // fallback a symmetric case's identically-zero lift history measures
  // its provider's rounding noise against (the module block above).
  const drag = gpuForceDelta(
    oracleForces[0]?.samples ?? [],
    providerForces[0]?.samples ?? [],
  );
  return {
    id: testCase.id,
    steps: testCase.steps,
    diverged: oracle.value.diverged || provider.value.diverged,
    distribution: gpuFieldDelta(oracleFlat, providerFlat),
    rho: gpuFieldDelta(oracleMacro.rho, providerMacro.rho),
    ux: gpuFieldDelta(oracleMacro.ux, providerMacro.ux),
    uy: gpuFieldDelta(oracleMacro.uy, providerMacro.uy),
    drag,
    lift: gpuForceDelta(
      oracleForces[1]?.samples ?? [],
      providerForces[1]?.samples ?? [],
      drag.oraclePeak,
    ),
  };
}

/**
 * Checks a report against a case's recorded tolerances — the violation
 * descriptions (empty when within), so callers assert cleanly.
 */
export function gpuOracleViolations(
  report: GpuOracleCaseReport,
  tolerances: GpuOracleTolerances,
): readonly string[] {
  if (report.diverged) {
    return [`${report.id}: a kernel diverged — the comparison is void`];
  }
  const violations: string[] = [];
  const check = (name: string, value: number, limit: number): void => {
    if (!(value <= limit)) {
      violations.push(
        `${report.id}: ${name} ${value.toPrecision(4)} exceeded the recorded ${String(limit)}`,
      );
    }
  };
  check(
    "distribution L2",
    report.distribution.l2Relative,
    tolerances.distributionL2Relative,
  );
  check(
    "distribution L∞",
    report.distribution.linfRelative,
    tolerances.distributionLinfRelative,
  );
  check("rho L2", report.rho.l2Relative, tolerances.macroL2Relative);
  check("rho L∞", report.rho.linfRelative, tolerances.macroLinfRelative);
  check("ux L2", report.ux.l2Relative, tolerances.macroL2Relative);
  check("ux L∞", report.ux.linfRelative, tolerances.macroLinfRelative);
  check("uy L2", report.uy.l2Relative, tolerances.macroL2Relative);
  check("uy L∞", report.uy.linfRelative, tolerances.macroLinfRelative);
  check("drag L2", report.drag.l2Relative, tolerances.forceL2Relative);
  check("drag L∞", report.drag.linfRelative, tolerances.forceLinfRelative);
  check("lift L2", report.lift.l2Relative, tolerances.forceL2Relative);
  check("lift L∞", report.lift.linfRelative, tolerances.forceLinfRelative);
  return violations;
}
