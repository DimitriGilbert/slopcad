/**
 * The oracle-vs-GPU tolerance harness, 3D (Phase 66a) — law S5's GPU
 * gate for the D3Q19 provider: the WGSL 3D path is NEVER bit-asserted
 * against the CPU oracle and never silently trusted; it is compared
 * against it at matched step counts over a 3D scenario matrix, with
 * the tolerances RECORDED AS DATA and their derivation stated here.
 * The comparison arithmetic (relative L2/L∞ over fields, peak-
 * normalized histories) is the 2D harness's own (`./gpu-oracle-harness`
 * — generic over values, reused unchanged); this module owns the 3D
 * matrix, the third momentum component's plumbing, and the report.
 *
 * ## What is compared (and why those things)
 *
 * - the NINETEEN DISTRIBUTION ARRAYS, pooled — the d3q19 layout
 *   contract's own named diff surface; this catches every indexing,
 *   streaming, and boundary-reconstruction deviation at its source;
 * - the macroscopic fields (ρ, u_x, u_y, u_z) — what users see;
 * - the force histories (drag, lift, side) — the integrated
 *   quantities, normalized by the oracle's peak magnitude over the run
 *   (lift/side cross zero; self-normalization would blow up).
 *
 * ## The tolerance derivation (recorded, with reasoning)
 *
 * Same structure as the 2D record: the CPU computes macroscopic and
 * collision terms in f64 and stores f32; the WGSL kernel is f32
 * throughout, so one step's relative rounding difference is O(2⁻²⁴),
 * around 1e-7. Every matrix scenario is LAMINAR and contracts toward a
 * steady attractor (the channel's developed parabola, the box's steady
 * wake at Re ≈ 35), so per-step differences saturate at the attractor's
 * rounding floor rather than compounding. The recorded bands sit
 * roughly three orders above that floor and at least an order BELOW
 * anything structural: a permuted direction, a wrong reflection table,
 * or a misapplied face reconstruction displaces O(1) mass or momentum
 * and cannot hide under 1e-2. Force histories carry the widest bands
 * because the momentum-exchange impulse is a small difference of large
 * opposing streams. A shedding (chaotic) case stays OUT of the matrix
 * until a real-device campaign measures the growth; the bands below
 * are for the laminar matrix as recorded.
 *
 * ## Skip-loudly (never a silent pass)
 *
 * The harness runs under any WebGPU-capable host and, where no device
 * exists (plain node, the default unit environment), the matrix is
 * SKIPPED with a visible marker and its reason — {@link gpuOracle3dSkipReason}
 * produces the banner, the test prints it and calls `ctx.skip()`. The
 * comparison ARITHMETIC itself is pinned headlessly by the 2D harness's
 * own unit tests (shared functions), and the matrix shape is pinned
 * here, so the gate cannot rot untested.
 */

import type { WgslDevice } from "./gpu-device";

import {
  type GpuFieldDelta,
  type GpuForceDelta,
  GPU_ORACLE_TOLERANCES,
  type GpuOracleTolerances,
  gpuFieldDelta,
  gpuForceDelta,
} from "./gpu-oracle-harness";
import { analyticOccupancy3d, testFluid } from "./fixtures";
import { type Lbm3dStepperConfig, createLbm3dStepper } from "./stepper-3d";
import { createWgsl3dStepper } from "./wgsl-stepper-3d";

/** The full comparison report for one 3D matrix case. */
export interface GpuOracle3dCaseReport {
  readonly id: string;
  readonly steps: number;
  /** Divergence on either side voids the comparison (reported, never passed). */
  readonly diverged: boolean;
  readonly distribution: GpuFieldDelta;
  readonly rho: GpuFieldDelta;
  readonly ux: GpuFieldDelta;
  readonly uy: GpuFieldDelta;
  readonly uz: GpuFieldDelta;
  readonly drag: GpuForceDelta;
  readonly lift: GpuForceDelta;
  readonly side: GpuForceDelta;
}

/** One 3D matrix case: a 3D stepper config, a matched step count, tolerances. */
export interface GpuOracle3dCase {
  readonly id: string;
  readonly config: Lbm3dStepperConfig;
  readonly steps: number;
  readonly tolerances: GpuOracleTolerances;
}

/**
 * The skip marker's reason when no WebGPU device exists — printed
 * loudly by the tests that skip, so the gate never silently passes.
 */
export function gpuOracle3dSkipReason(): string {
  return [
    "[gpu-oracle-3d] SKIPPED: no WebGPU device on this host.",
    "The S5 oracle-vs-GPU 3D matrix compared nothing — the CPU oracle remains",
    "the test truth. Run under a WebGPU-capable host (the Phase 64b",
    "Dawn/Playwright spike is the sanctioned door) to execute this gate;",
    "the comparison arithmetic itself is pinned headlessly in",
    "`gpu-oracle-3d.test.ts` and the shared 2D harness tests.",
  ].join(" ");
}

/**
 * The recorded tolerance set for the laminar 3D matrix: the 2D record
 * verbatim — the derivation transfers (f32-vs-f64 rounding floor,
 * contractive laminar attractors, structural deviations at O(1)).
 */
export const GPU_ORACLE_3D_TOLERANCES: GpuOracleTolerances =
  GPU_ORACLE_TOLERANCES;

/** The 3D scenario matrix — the Phase 66a fixtures' shapes at small grids. */
export const GPU_ORACLE_3D_MATRIX: readonly GpuOracle3dCase[] = [
  {
    id: "channel3d-poiseuille",
    // The 3D Poiseuille fixture's plate channel: developed laminar flow
    // between the no-slip y plates with symmetry in z, the tightest
    // expected agreement (a contractive steady attractor).
    config: {
      mask: { nx: 24, ny: 11, nz: 11, solid: new Uint8Array(24 * 11 * 11) },
      fluid: testFluid(1.2, 2e-4),
      cellSizeM: 0.001,
      characteristicVelocityMPerS: 0.075,
      collision: { kind: "trt" },
      west: { kind: "velocity-inlet", velocityMPerS: [0.05, 0, 0] },
      east: { kind: "pressure-outlet", pressurePa: 0 },
      south: { kind: "wall", slip: false },
      north: { kind: "wall", slip: false },
      bottom: { kind: "symmetry" },
      top: { kind: "symmetry" },
    },
    steps: 500,
    tolerances: GPU_ORACLE_3D_TOLERANCES,
  },
  {
    id: "box3d-obstacle",
    // The 3D box fixture's centered cube in cross-flow: solid
    // bounce-back + three-component momentum-exchange forces, with the
    // convective outflow and symmetry planes under exercise. The magic
    // parameter is Λ = 1/12 — the box fixture's measured decision (the
    // channel-exact Λ = 1/4 diverges the no-slip-walls variant at
    // step ≈ 466); here the symmetry planes soften the edges, but the
    // provider runs the same knob as the CPU oracle either way.
    config: {
      mask: {
        nx: 24,
        ny: 12,
        nz: 12,
        solid: analyticOccupancy3d(
          24,
          12,
          12,
          (x, y, z) =>
            x >= 8 && x <= 11 && y >= 4 && y <= 7 && z >= 3 && z <= 8,
        ),
      },
      fluid: testFluid(1.2, 2.7e-5),
      cellSizeM: 0.001,
      characteristicVelocityMPerS: 0.1,
      collision: { kind: "trt", magicLambda: 1 / 12 },
      west: { kind: "velocity-inlet", velocityMPerS: [0.1, 0, 0] },
      east: { kind: "convective-outflow" },
      south: { kind: "symmetry" },
      north: { kind: "symmetry" },
      bottom: { kind: "wall", slip: false },
      top: { kind: "wall", slip: false },
    },
    steps: 600,
    tolerances: GPU_ORACLE_3D_TOLERANCES,
  },
];

/**
 * Runs one 3D matrix case on both kernels at matched step counts and
 * computes the deltas. Comparison only — the assertions (and the
 * tolerance data) live with the callers.
 */
export async function runGpuOracle3dCase(
  device: WgslDevice,
  testCase: GpuOracle3dCase,
): Promise<GpuOracle3dCaseReport> {
  const oracle = createLbm3dStepper(testCase.config);
  if (!oracle.ok) throw new Error(oracle.error.message);
  oracle.value.run(testCase.steps);
  const provider = await createWgsl3dStepper(testCase.config, device, {
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
  // concatenation of the nineteen per-direction planes — cell-for-cell,
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
  // fallback a symmetric case's identically-zero lift/side history
  // measures its provider's rounding noise against (the shared 2D
  // harness's spike finding, applied per component here).
  const drag = gpuForceDelta(
    oracleForces[0]?.samples ?? [],
    providerForces[0]?.samples ?? [],
  );
  const lift = gpuForceDelta(
    oracleForces[1]?.samples ?? [],
    providerForces[1]?.samples ?? [],
    drag.oraclePeak,
  );
  return {
    id: testCase.id,
    steps: testCase.steps,
    diverged: oracle.value.diverged || provider.value.diverged,
    distribution: gpuFieldDelta(oracleFlat, providerFlat),
    rho: gpuFieldDelta(oracleMacro.rho, providerMacro.rho),
    ux: gpuFieldDelta(oracleMacro.ux, providerMacro.ux),
    uy: gpuFieldDelta(oracleMacro.uy, providerMacro.uy),
    uz: gpuFieldDelta(oracleMacro.uz, providerMacro.uz),
    drag,
    lift,
    side: gpuForceDelta(
      oracleForces[2]?.samples ?? [],
      providerForces[2]?.samples ?? [],
      drag.oraclePeak,
    ),
  };
}

/**
 * Checks a 3D report against a case's recorded tolerances — the
 * violation descriptions (empty when within), so callers assert
 * cleanly.
 */
export function gpuOracle3dViolations(
  report: GpuOracle3dCaseReport,
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
  check("uz L2", report.uz.l2Relative, tolerances.macroL2Relative);
  check("uz L∞", report.uz.linfRelative, tolerances.macroLinfRelative);
  check("drag L2", report.drag.l2Relative, tolerances.forceL2Relative);
  check("drag L∞", report.drag.linfRelative, tolerances.forceLinfRelative);
  check("lift L2", report.lift.l2Relative, tolerances.forceL2Relative);
  check("lift L∞", report.lift.linfRelative, tolerances.forceLinfRelative);
  check("side L2", report.side.l2Relative, tolerances.forceL2Relative);
  check("side L∞", report.side.linfRelative, tolerances.forceLinfRelative);
  return violations;
}
