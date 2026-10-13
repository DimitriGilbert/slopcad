/**
 * The S5 oracle-vs-GPU gate's tests (Phase 64a, requirement 4): the
 * comparison ARITHMETIC is pinned headlessly against hand-computed
 * vectors (so the gate cannot rot untested on GPU-less hosts), the
 * tolerance data is asserted against the recorded matrix, and the
 * matrix itself RUNS under any WebGPU-capable host — where none
 * exists it is SKIPPED LOUDLY: a visible marker with its reason,
 * never a silent pass.
 */

import { beforeEach, describe, expect, it } from "vitest";

import {
  GPU_ORACLE_MATRIX,
  GPU_ORACLE_TOLERANCES,
  type GpuOracleCaseReport,
  gpuFieldDelta,
  gpuForceDelta,
  gpuOracleSkipReason,
  gpuOracleViolations,
  runGpuOracleCase,
} from "./gpu-oracle-harness";
import { requestWebGpuDevice } from "./gpu-device";

const device = await requestWebGpuDevice();

describe("the tolerance-harness arithmetic (pinned headlessly)", () => {
  it("measures zero against identical fields", () => {
    const delta = gpuFieldDelta([1, 2, 3, -4], [1, 2, 3, -4]);
    expect(delta.l2Relative).toBe(0);
    expect(delta.linfRelative).toBe(0);
  });

  it("measures the hand-computed L2 and L∞ of a known difference", () => {
    const delta = gpuFieldDelta([1, 2, 4], [1, 2, 3]);
    // ‖(0,0,1)‖₂ / ‖(1,2,4)‖₂ = 1/√21; max|Δ|/max|a| = 1/4.
    expect(delta.l2Relative).toBeCloseTo(1 / Math.sqrt(21), 12);
    expect(delta.linfRelative).toBeCloseTo(0.25, 12);
  });

  it("normalizes force histories by the oracle's peak magnitude", () => {
    const delta = gpuForceDelta([10, -5, 10], [9, -5, 12]);
    // ‖(1,0,2)‖₂ / ‖(10,−5,10)‖₂ = √5/15; max|Δ|/peak = 2/10.
    expect(delta.oraclePeak).toBe(10);
    expect(delta.l2Relative).toBeCloseTo(Math.sqrt(5) / 15, 12);
    expect(delta.linfRelative).toBeCloseTo(0.2, 12);
  });

  it("treats identically-zero histories as exact agreement, and measures a zero oracle's noise against the fallback scale", () => {
    // The Phase 64b spike finding: symmetric cases (the poiseuille
    // channel, the centered cylinder) have identically-zero oracle lift.
    const both = gpuForceDelta([0, 0], [0, 0]);
    expect(both.l2Relative).toBe(0);
    expect(both.linfRelative).toBe(0);
    // Zero oracle, non-zero provider, the run's force scale as fallback:
    // ‖(0,1e-3)‖₂ / 10 and 1e-3/10 — noise as a fraction of the scale.
    const noise = gpuForceDelta([0, 0], [0, 1e-3], 10);
    expect(noise.l2Relative).toBeCloseTo(1e-4, 12);
    expect(noise.linfRelative).toBeCloseTo(1e-4, 12);
    // No scale, no comparison — the refusal stands.
    expect(() => gpuForceDelta([0, 0], [0, 1e-3])).toThrow(/non-zero oracle/);
  });

  it("refuses comparisons without a normalizer to normalize against", () => {
    expect(() => gpuFieldDelta([0, 0], [0, 0])).toThrow(/non-zero oracle/);
    expect(() => gpuFieldDelta([1], [1, 2])).toThrow(/equal lengths/);
  });

  it("reports violations against the recorded tolerances, empty when within", () => {
    const within: GpuOracleCaseReport = {
      id: "case",
      steps: 10,
      diverged: false,
      distribution: { l2Relative: 1e-4, linfRelative: 1e-3 },
      rho: { l2Relative: 1e-4, linfRelative: 1e-3 },
      ux: { l2Relative: 1e-4, linfRelative: 1e-3 },
      uy: { l2Relative: 1e-4, linfRelative: 1e-3 },
      drag: { l2Relative: 1e-3, linfRelative: 1e-2, oraclePeak: 1 },
      lift: { l2Relative: 1e-3, linfRelative: 1e-2, oraclePeak: 1 },
    };
    expect(gpuOracleViolations(within, GPU_ORACLE_TOLERANCES)).toEqual([]);
    const exceeded = {
      ...within,
      distribution: { l2Relative: 0.5, linfRelative: 0.9 },
    };
    const violations = gpuOracleViolations(exceeded, GPU_ORACLE_TOLERANCES);
    expect(violations.length).toBe(2);
    expect(violations[0]).toContain("distribution L2");
    expect(violations[1]).toContain("distribution L∞");
    const divergedReport = { ...within, diverged: true };
    expect(gpuOracleViolations(divergedReport, GPU_ORACLE_TOLERANCES)).toEqual([
      "case: a kernel diverged — the comparison is void",
    ]);
  });

  it("records the matrix with every case inside the provider's documented shape", () => {
    expect(GPU_ORACLE_MATRIX.map((testCase) => testCase.id)).toEqual([
      "poiseuille-channel",
      "cylinder-attached-wake",
      "symmetry-half-domain",
    ]);
    for (const testCase of GPU_ORACLE_MATRIX) {
      expect(testCase.steps).toBeGreaterThan(0);
      expect(testCase.tolerances).toEqual(GPU_ORACLE_TOLERANCES);
    }
  });

  it("states a skip reason that is visible and names the gate", () => {
    const reason = gpuOracleSkipReason();
    expect(reason).toContain("SKIPPED");
    expect(reason).toContain("no WebGPU device");
    expect(reason).toContain("oracle");
  });
});

describe("the oracle-vs-GPU tolerance matrix (law S5)", () => {
  beforeEach(() => {
    if (device === undefined) {
      // The visible marker, printed before the skip — never a silent pass.
      console.warn(gpuOracleSkipReason());
    }
  });

  for (const testCase of GPU_ORACLE_MATRIX) {
    it(`holds ${testCase.id} within the recorded tolerances at ${String(testCase.steps)} matched steps`, async (context) => {
      if (device === undefined) {
        context.skip();
        return;
      }
      const report = await runGpuOracleCase(device, testCase);
      const violations = gpuOracleViolations(report, testCase.tolerances);
      expect(violations).toEqual([]);
    });
  }
});
