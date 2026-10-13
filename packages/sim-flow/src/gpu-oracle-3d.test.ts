/**
 * The S5 oracle-vs-GPU 3D gate's tests (Phase 66a): the matrix shape is
 * asserted against the recorded data, the 3D violation reporter is
 * pinned headlessly against a synthetic report (the shared comparison
 * arithmetic — gpuFieldDelta/gpuForceDelta — is pinned by the 2D
 * harness's own tests and reused verbatim here), and the matrix itself
 * RUNS under any WebGPU-capable host — where none exists it is SKIPPED
 * LOUDLY: a visible marker with its reason, never a silent pass.
 */

import { beforeEach, describe, expect, it } from "vitest";

import {
  GPU_ORACLE_3D_MATRIX,
  GPU_ORACLE_3D_TOLERANCES,
  type GpuOracle3dCaseReport,
  gpuOracle3dSkipReason,
  gpuOracle3dViolations,
  runGpuOracle3dCase,
} from "./gpu-oracle-3d-harness";
import { requestWebGpuDevice } from "./gpu-device";
import { WGSL3D_MAX_NODES } from "./wgsl-shader-3d";

const device = await requestWebGpuDevice();

describe("the 3D tolerance-harness data (pinned headlessly)", () => {
  it("records the matrix with every case inside the provider's documented shape", () => {
    expect(GPU_ORACLE_3D_MATRIX.map((testCase) => testCase.id)).toEqual([
      "channel3d-poiseuille",
      "box3d-obstacle",
    ]);
    for (const testCase of GPU_ORACLE_3D_MATRIX) {
      expect(testCase.steps).toBeGreaterThan(0);
      expect(testCase.tolerances).toEqual(GPU_ORACLE_3D_TOLERANCES);
      const nodes =
        testCase.config.mask.nx *
        testCase.config.mask.ny *
        testCase.config.mask.nz;
      expect(nodes).toBeLessThanOrEqual(WGSL3D_MAX_NODES);
    }
  });

  it("reports 3D violations against the recorded tolerances, empty when within", () => {
    const within: GpuOracle3dCaseReport = {
      id: "case3d",
      steps: 10,
      diverged: false,
      distribution: { l2Relative: 1e-4, linfRelative: 1e-3 },
      rho: { l2Relative: 1e-4, linfRelative: 1e-3 },
      ux: { l2Relative: 1e-4, linfRelative: 1e-3 },
      uy: { l2Relative: 1e-4, linfRelative: 1e-3 },
      uz: { l2Relative: 1e-4, linfRelative: 1e-3 },
      drag: { l2Relative: 1e-3, linfRelative: 1e-2, oraclePeak: 1 },
      lift: { l2Relative: 1e-3, linfRelative: 1e-2, oraclePeak: 0 },
      side: { l2Relative: 1e-3, linfRelative: 1e-2, oraclePeak: 0 },
    };
    expect(gpuOracle3dViolations(within, GPU_ORACLE_3D_TOLERANCES)).toEqual([]);
    const exceeded = {
      ...within,
      distribution: { l2Relative: 0.5, linfRelative: 0.9 },
      uz: { l2Relative: 0.4, linfRelative: 0.9 },
    };
    const violations = gpuOracle3dViolations(
      exceeded,
      GPU_ORACLE_3D_TOLERANCES,
    );
    expect(violations.length).toBe(4);
    expect(violations[0]).toContain("distribution L2");
    expect(violations[1]).toContain("distribution L∞");
    expect(violations[2]).toContain("uz L2");
    expect(violations[3]).toContain("uz L∞");
    const divergedReport = { ...within, diverged: true };
    expect(
      gpuOracle3dViolations(divergedReport, GPU_ORACLE_3D_TOLERANCES),
    ).toEqual(["case3d: a kernel diverged — the comparison is void"]);
  });

  it("states a skip reason that is visible and names the gate", () => {
    const reason = gpuOracle3dSkipReason();
    expect(reason).toContain("SKIPPED");
    expect(reason).toContain("no WebGPU device");
    expect(reason).toContain("oracle");
  });
});

describe("the oracle-vs-GPU 3D tolerance matrix (law S5)", () => {
  beforeEach(() => {
    if (device === undefined) {
      // The visible marker, printed before the skip — never a silent pass.
      console.warn(gpuOracle3dSkipReason());
    }
  });

  for (const testCase of GPU_ORACLE_3D_MATRIX) {
    it(`holds ${testCase.id} within the recorded tolerances at ${String(testCase.steps)} matched steps`, async (context) => {
      if (device === undefined) {
        context.skip();
        return;
      }
      const report = await runGpuOracle3dCase(device, testCase);
      const violations = gpuOracle3dViolations(report, testCase.tolerances);
      expect(violations).toEqual([]);
    });
  }
});
