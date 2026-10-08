/**
 * The spike driver's unit truths (Phase 64b): the absent-device path
 * records the LOUD skip (never a fabricated pass, law S5), the repeat
 * mapping carries the 64a report's numbers and violations verbatim,
 * and the adapter provenance probe declines honestly where
 * `navigator.gpu` does not exist (jsdom has none).
 */

import { describe, expect, it } from "vitest";
import { GPU_ORACLE_MATRIX } from "@slopcad/sim-flow";
import type { GpuOracleCaseReport } from "@slopcad/sim-flow";

import {
  readSimGpuAdapterProvenance,
  runSimGpuOracleMatrix,
  simGpuOracleRepeatOf,
} from "./sim-gpu-oracle-run";

/** A minimal in-tolerance 64a report for the mapping assertions. */
function syntheticReport(): GpuOracleCaseReport {
  const within = { l2Relative: 1e-4, linfRelative: 1e-3 };
  return {
    id: "poiseuille-channel",
    steps: 400,
    diverged: false,
    distribution: { l2Relative: 2e-4, linfRelative: 3e-3 },
    rho: within,
    ux: within,
    uy: within,
    drag: { l2Relative: 5e-3, linfRelative: 2e-2, oraclePeak: 1 },
    lift: { l2Relative: 4e-3, linfRelative: 1.5e-2, oraclePeak: 0.5 },
  };
}

describe("the webgpu spike driver", () => {
  it("records the loud skip when the device source finds no device", async () => {
    const report = await runSimGpuOracleMatrix({
      deviceSource: () => Promise.resolve(undefined),
      repeats: 2,
      adapter: null,
    });
    expect(report.phase).toBe("done");
    expect(report.deviceAbsent).toBe(true);
    expect(report.skipReason).not.toBeNull();
    expect(report.skipReason).toContain("SKIPPED");
    expect(report.skipReason).toContain("no WebGPU device");
    expect(report.cases).toEqual([]);
    expect(report.error).toBeNull();
    expect(report.repeatsPerCase).toBe(2);
  });

  it("fails loudly when the device source itself throws", async () => {
    const report = await runSimGpuOracleMatrix({
      deviceSource: () => Promise.reject(new Error("adapter boom")),
    });
    expect(report.phase).toBe("failed");
    expect(report.error).toContain("adapter boom");
    expect(report.cases).toEqual([]);
  });

  it("maps a 64a report into the published repeat record verbatim", () => {
    const tolerances = GPU_ORACLE_MATRIX[0]?.tolerances;
    if (tolerances === undefined) throw new Error("matrix missing its case");
    const repeat = simGpuOracleRepeatOf(syntheticReport(), tolerances);
    expect(repeat.violations).toEqual([]);
    expect(repeat.l2Relative.distribution).toBe(2e-4);
    expect(repeat.linfRelative.drag).toBe(2e-2);
    expect(repeat.l2Relative.lift).toBe(4e-3);
  });

  it("maps a blown report into its recorded violations", () => {
    const tolerances = GPU_ORACLE_MATRIX[0]?.tolerances;
    if (tolerances === undefined) throw new Error("matrix missing its case");
    const blown: GpuOracleCaseReport = {
      ...syntheticReport(),
      distribution: { l2Relative: 0.5, linfRelative: 0.9 },
    };
    const repeat = simGpuOracleRepeatOf(blown, tolerances);
    expect(repeat.violations.length).toBe(2);
    expect(repeat.violations[0]).toContain("distribution L2");
    expect(repeat.violations[1]).toContain("distribution L∞");
  });

  it("declines adapter provenance honestly where navigator.gpu is absent", async () => {
    expect(await readSimGpuAdapterProvenance()).toBeNull();
  });
});
