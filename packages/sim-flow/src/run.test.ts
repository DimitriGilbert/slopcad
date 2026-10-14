import {
  SIM_ERROR_CODES,
  SIM_RESULT_SUMMARY_VERSION,
  decodeSimResultPayload,
  encodeSimResultPayload,
  simMach,
  simPrandtl,
  simRegimeReport,
  simReynolds,
} from "@slopcad/sim-core";
import { describe, expect, it } from "vitest";

import { analyticOccupancy, testFluid } from "./fixtures";
import { type LbmRunScenario, lbmRunSimResult, runLbmScenario } from "./run";

/**
 * The run driver's wiring pins (Phase 63b): histories from the 63a
 * force series, the averaging window's mean/fluctuation fields, the S9
 * regime wiring (numbers EXACTLY the sim-core module's — flags advisory,
 * the run proceeds, never declines), the snapshot-hash provenance, the
 * SimResult persistence fit (including the failed-diverged carve), the
 * structured declines, and the bitwise-determinism pin over a full
 * report including the grid-convergence self-check.
 */

/** A small 2D wind tunnel around a cylinder slice — the 63a fixture shape. */
function windTunnelScenario(
  overrides: Partial<LbmRunScenario> = {},
): LbmRunScenario {
  return {
    name: "driver-tunnel",
    stepper: {
      mask: {
        nx: 32,
        ny: 16,
        solid: analyticOccupancy(
          32,
          16,
          (x, y) => (x - 10.5) ** 2 + (y - 8) ** 2 <= 3.5 ** 2,
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
    stepBudget: 300,
    characteristicLengthM: 0.007,
    averaging: { startStep: 150 },
    ...overrides,
  };
}

/** A cheap empty channel for pure wiring pins (regime flags, declines). */
function channelScenario(
  fluidNu: number,
  speed: number,
  overrides: Partial<LbmRunScenario> = {},
): LbmRunScenario {
  return {
    name: "driver-channel",
    stepper: {
      mask: { nx: 16, ny: 8, solid: new Uint8Array(16 * 8) },
      fluid: testFluid(1.2, fluidNu),
      cellSizeM: 0.001,
      characteristicVelocityMPerS: speed,
      collision: { kind: "trt" },
      west: { kind: "velocity-inlet", velocityMPerS: [speed, 0] },
      east: { kind: "pressure-outlet", pressurePa: 0 },
      south: { kind: "wall", slip: false },
      north: { kind: "wall", slip: false },
    },
    stepBudget: 10,
    characteristicLengthM: 0.05,
    ...overrides,
  };
}

describe("the run driver", () => {
  it("produces the force histories, windowed means, and averaging fields", () => {
    const run = runLbmScenario(windTunnelScenario());
    expect(run.ok).toBe(true);
    if (!run.ok) throw new Error(run.error.message);
    const report = run.value;
    expect(report.diverged).toBe(false);
    expect(report.steps).toBe(300);
    expect(report.physicalDurationS).toBeGreaterThan(0);
    expect(report.histories.map((series) => series.name)).toEqual([
      "drag",
      "lift",
    ]);
    expect(report.histories[0]?.unit).toBe("N/m");
    expect(report.histories[0]?.samples.length).toBe(300);
    expect(report.histories[1]?.samples.length).toBe(300);
    expect(report.forces.window).toEqual({
      fromStep: 150,
      toStep: 300,
      sampleCount: 151,
    });
    expect(report.forces.meanDragNPerM).not.toBeNull();
    expect(report.forces.meanDragNPerM ?? 0).toBeGreaterThan(0);
    expect(Math.abs(report.forces.meanLiftNPerM ?? 1)).toBeLessThan(
      // Symmetric body, symmetric tunnel: lift is noise-small beside drag.
      Math.abs(report.forces.meanDragNPerM ?? 1),
    );
    expect(report.fields.map((field) => field.id)).toEqual([
      "velocity-x",
      "velocity-y",
      "speed",
      "pressure",
      "mean-velocity-x",
      "mean-velocity-y",
      "fluctuation-velocity-x",
      "fluctuation-velocity-y",
    ]);
    const meanField = report.fields.find(
      (field) => field.id === "mean-velocity-x",
    );
    expect(meanField?.extent).toEqual([32, 16, 1]);
    expect(meanField?.dataType).toBe("float32");
    expect(meanField?.dimension).toBe("velocity");
    // The inlet column (x = 0) carries the Zou/He-pinned velocity: its
    // fluctuation is zero to rounding, while the developing wake behind
    // the cylinder genuinely fluctuates through the window.
    const fluctuation = report.fields.find(
      (field) => field.id === "fluctuation-velocity-x",
    );
    expect(fluctuation).toBeDefined();
    if (fluctuation === undefined) throw new Error("unreachable: checked");
    const inletRms = fluctuation.values[0 + 3 * 32] ?? 0;
    expect(inletRms).toBeLessThan(1e-6);
    const wakeRms = fluctuation.values[20 + 8 * 32] ?? 0;
    expect(wakeRms).toBeGreaterThan(1e-6);
  });

  it("computes the S9 regime exactly as the sim-core module does (low Re, unflagged)", () => {
    const run = runLbmScenario(windTunnelScenario());
    expect(run.ok).toBe(true);
    if (!run.ok) throw new Error(run.error.message);
    const fluid = testFluid(1.2, 2.7e-5);
    const expected = simRegimeReport({
      reynolds: simReynolds(1.2, 0.1, 0.007, fluid.dynamicViscosityPaS),
      mach: simMach(0.1, fluid.speedOfSoundMPerS),
      prandtl: simPrandtl(
        fluid.dynamicViscosityPaS,
        fluid.specificHeatJPerKgK,
        fluid.thermalConductivityWPerMK,
      ),
    });
    expect(run.value.regime).toEqual(expected);
    expect(run.value.regime.qualitative).toEqual([]);
    expect(run.value.regime.reynolds ?? 0).toBeGreaterThan(20);
    expect(run.value.regime.reynolds ?? 0).toBeLessThan(30);
  });

  it("flags a high-Re scenario qualitative and proceeds (never declines)", () => {
    // ν = 1e-6 m²/s at L = 0.05 m, U = 0.1 m/s: Re = 5000, past the
    // advisory turbulent threshold — flagged, and the run still runs.
    const run = runLbmScenario(channelScenario(1e-6, 0.1));
    expect(run.ok).toBe(true);
    if (!run.ok) throw new Error(run.error.message);
    expect(run.value.regime.reynolds).toBe(
      simReynolds(1.2, 0.1, 0.05, 1.2 * 1e-6),
    );
    expect(run.value.regime.reynolds).toBeGreaterThan(4000);
    expect(run.value.regime.qualitative).toEqual(["turbulence-dominated"]);
    expect(run.value.steps).toBe(10);
  });

  it("flags a compressibility-affected scenario qualitative and proceeds", () => {
    // U = 120 m/s against c = 347 m/s: Ma ≈ 0.35 past the 0.3 advisory
    // threshold, while Re stays laminar-side — the flags separate.
    const run = runLbmScenario(channelScenario(2.7e-3, 120));
    expect(run.ok).toBe(true);
    if (!run.ok) throw new Error(run.error.message);
    expect(run.value.regime.mach).toBeCloseTo(120 / 347, 10);
    expect(run.value.regime.qualitative).toEqual(["compressibility-affected"]);
    expect(run.value.steps).toBe(10);
  });

  it("carries the compile-fed regime report and snapshot hash verbatim", () => {
    const compileRegime = simRegimeReport({ prandtl: 0.7 });
    const run = runLbmScenario(
      windTunnelScenario({
        regime: compileRegime,
        scenarioSnapshotHash: "deadbeef",
      }),
    );
    expect(run.ok).toBe(true);
    if (!run.ok) throw new Error(run.error.message);
    expect(run.value.regime).toBe(compileRegime);
    expect(run.value.scenarioSnapshotHash).toBe("deadbeef");
  });

  it("hashes its own canonical identity when not compile-fed", () => {
    const first = runLbmScenario(windTunnelScenario());
    const second = runLbmScenario(windTunnelScenario());
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) throw new Error("unreachable: checked");
    expect(first.value.scenarioSnapshotHash).toBe(
      second.value.scenarioSnapshotHash,
    );
    const changedBudget = runLbmScenario(
      windTunnelScenario({ stepBudget: 299, averaging: { startStep: 150 } }),
    );
    expect(changedBudget.ok).toBe(true);
    if (changedBudget.ok) {
      expect(changedBudget.value.scenarioSnapshotHash).not.toBe(
        first.value.scenarioSnapshotHash,
      );
    }
  });

  it("assembles a persistence-fit SimResult (summary, projected blocks, histories)", () => {
    const run = runLbmScenario(windTunnelScenario());
    expect(run.ok).toBe(true);
    if (!run.ok) throw new Error(run.error.message);
    const result = lbmRunSimResult(run.value);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.message);
    const { summary, fields, histories } = result.value;
    expect(summary.schemaVersion).toBe(SIM_RESULT_SUMMARY_VERSION);
    expect(summary.status).toBe("completed");
    expect(summary.failureCode).toBeUndefined();
    expect(summary.scenarioSnapshotHash).toBe(run.value.scenarioSnapshotHash);
    expect(summary.regime).toBe(run.value.regime);
    const quantityByName = new Map(
      summary.quantities.map((quantity) => [quantity.name, quantity]),
    );
    expect(quantityByName.get("steps")).toEqual({
      name: "steps",
      value: 300,
      unit: "1",
    });
    expect(quantityByName.get("physical-duration")?.unit).toBe("s");
    expect(quantityByName.get("mean-drag-force")?.unit).toBe("N");
    expect(quantityByName.get("mean-drag-force")?.value).toBeCloseTo(
      run.value.forces.meanDragNPerM ?? Number.NaN,
      10,
    );
    expect(quantityByName.get("mean-lift-force")?.unit).toBe("N");
    expect(fields.length).toBe(8);
    const velocityX = fields[0];
    expect(velocityX?.originMm).toEqual([0, 0, 0]);
    expect(velocityX?.spacingMm).toEqual([1, 1, 1]);
    // S4 projection: SI m/s → document mm/s at the inlet's pinned column.
    expect(velocityX?.values[0 + 3 * 32]).toBeCloseTo(100, 1);
    expect(histories).toBe(run.value.histories);
    // The blocks encode and decode through the SMR1 payload byte path.
    const encoded = encodeSimResultPayload(fields);
    expect(encoded.ok).toBe(true);
    if (!encoded.ok) throw new Error(encoded.error.message);
    const decoded = decodeSimResultPayload(encoded.value);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) throw new Error(decoded.error.message);
    for (const [index, block] of fields.entries()) {
      const decodedBlock = decoded.value[index];
      expect(decodedBlock?.id).toBe(block.id);
      expect(decodedBlock?.values).toEqual(block.values.map(Math.fround));
    }
  });

  it("reports a diverged run honestly and persists it as failed", () => {
    // The 63a divergence pin's recipe: BGK at τ⁺ ≈ 0.516 rings itself
    // apart (NaN by ~1000 steps there); the driver must report the
    // freeze, withhold fields, and persist a failed SimResult carrying
    // sim/run-diverged — never a fabricated completed one.
    const diverging: LbmRunScenario = {
      name: "driver-blowup",
      stepper: {
        mask: { nx: 48, ny: 17, solid: new Uint8Array(48 * 17) },
        fluid: testFluid(1.2, 8e-6),
        cellSizeM: 0.001,
        characteristicVelocityMPerS: 0.075,
        collision: { kind: "bgk" },
        west: { kind: "velocity-inlet", velocityMPerS: [0.05, 0] },
        east: { kind: "pressure-outlet", pressurePa: 0 },
        south: { kind: "wall", slip: false },
        north: { kind: "wall", slip: false },
      },
      stepBudget: 4000,
      characteristicLengthM: 0.017,
    };
    const run = runLbmScenario(diverging);
    expect(run.ok).toBe(true);
    if (!run.ok) throw new Error(run.error.message);
    const report = run.value;
    expect(report.diverged).toBe(true);
    expect(report.steps).toBeLessThan(4000);
    expect(report.fields).toEqual([]);
    expect(report.histories[0]?.samples.length).toBe(report.steps);
    for (const sample of report.histories[0]?.samples ?? []) {
      expect(Number.isFinite(sample)).toBe(true);
    }
    const result = lbmRunSimResult(report);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.message);
    expect(result.value.summary.status).toBe("failed");
    expect(result.value.summary.failureCode).toBe(SIM_ERROR_CODES.runDiverged);
    expect(result.value.summary.quantities).toEqual([]);
    expect(result.value.fields).toEqual([]);
  });

  it("declines structurally invalid run fields", () => {
    const budgetZero = runLbmScenario(windTunnelScenario({ stepBudget: 0 }));
    expect(budgetZero.ok).toBe(false);
    if (!budgetZero.ok) {
      expect(budgetZero.error.code).toBe(SIM_ERROR_CODES.scenarioInvalid);
      expect(budgetZero.error.message).toContain("step budget");
    }
    const windowTooLate = runLbmScenario(
      windTunnelScenario({ averaging: { startStep: 300 } }),
    );
    expect(windowTooLate.ok).toBe(false);
    if (!windowTooLate.ok) {
      expect(windowTooLate.error.message).toContain("averaging window");
    }
    const badLength = runLbmScenario(
      windTunnelScenario({ characteristicLengthM: 0 }),
    );
    expect(badLength.ok).toBe(false);
  });

  it("is bitwise deterministic on a full report including the self-check", () => {
    // A compact ladder: 24×12 coarse with its 48×24 refinement — cheap
    // enough to run twice, complete enough to pin every report surface
    // (summary numbers, histories, instantaneous + averaging fields, and
    // the convergence drift) to bitwise identity.
    const scenario: LbmRunScenario = {
      name: "driver-determinism",
      stepper: {
        mask: {
          nx: 24,
          ny: 12,
          solid: analyticOccupancy(
            24,
            12,
            (x, y) => (x - 8) ** 2 + (y - 6) ** 2 <= 2.5 ** 2,
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
      stepBudget: 150,
      characteristicLengthM: 0.005,
      averaging: { startStep: 75 },
      gridConvergence: {
        refinedMask: {
          nx: 48,
          ny: 24,
          solid: analyticOccupancy(
            48,
            24,
            (x, y) => (x - 16) ** 2 + (y - 12) ** 2 <= 5 ** 2,
          ),
        },
      },
    };
    const first = runLbmScenario(scenario);
    const second = runLbmScenario(scenario);
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) throw new Error("unreachable: checked");
    expect(first.value.convergence).toBeDefined();
    expect(JSON.stringify(first.value)).toBe(JSON.stringify(second.value));
  });
});
