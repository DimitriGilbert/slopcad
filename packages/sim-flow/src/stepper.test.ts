import { describe, expect, it } from "vitest";
import { projectSimResult } from "@slopcad/sim-core";

import { testFluid } from "./fixtures";
import {
  type LbmStepper,
  type LbmStepperConfig,
  createLbmStepper,
} from "./stepper";

function channelConfig(
  overrides: Partial<LbmStepperConfig> = {},
): LbmStepperConfig {
  return {
    mask: { nx: 20, ny: 9, solid: new Uint8Array(180) },
    fluid: testFluid(1.2, 2e-4),
    cellSizeM: 0.001,
    characteristicVelocityMPerS: 0.075,
    west: { kind: "velocity-inlet", velocityMPerS: [0.05, 0] },
    east: { kind: "convective-outflow" },
    south: { kind: "wall", slip: false },
    north: { kind: "wall", slip: false },
    ...overrides,
  };
}

function bytesOf(array: Float32Array | Float64Array): Buffer {
  return Buffer.from(array.buffer, array.byteOffset, array.byteLength);
}

/** Bitwise equality of two steppers' full state (law S2's byte claim). */
function assertSameBytes(first: LbmStepper, second: LbmStepper): void {
  expect(first.step).toBe(second.step);
  const fa = first.distributions();
  const fb = second.distributions();
  for (let i = 0; i < 9; i += 1) {
    expect(bytesOf(fa[i]!).equals(bytesOf(fb[i]!))).toBe(true);
  }
  const sa = first.snapshotSI();
  const sb = second.snapshotSI();
  for (const key of [
    "densityKgPerM3",
    "velocityXMPerS",
    "velocityYMPerS",
    "pressurePa",
  ] as const) {
    expect(bytesOf(sa[key]).equals(bytesOf(sb[key]))).toBe(true);
  }
  const historyA = first.forceState().history;
  const historyB = second.forceState().history;
  expect(historyA.length).toBe(historyB.length);
  for (let series = 0; series < historyA.length; series += 1) {
    expect(historyA[series]?.samples).toEqual(historyB[series]?.samples);
  }
}

function stepperOf(config: LbmStepperConfig) {
  const created = createLbmStepper(config);
  if (!created.ok) throw new Error(created.error.message);
  return created.value;
}

describe("the stepper", () => {
  it("is bitwise deterministic on repeat runs (fixed steps, same bytes)", () => {
    const first = stepperOf(channelConfig());
    const second = stepperOf(channelConfig());
    first.run(300);
    second.run(300);
    assertSameBytes(first, second);
  });

  it("pause/step/resume equals one straight run (the 63b/63c driving shape)", () => {
    const straight = stepperOf(channelConfig());
    straight.run(300);
    const paused = stepperOf(channelConfig());
    paused.run(120);
    paused.advance();
    paused.advance();
    expect(paused.step).toBe(122);
    paused.run(178);
    expect(paused.step).toBe(300);
    assertSameBytes(straight, paused);
  });

  it("freezes on divergence instead of fabricating (BGK's high-Re resonance)", () => {
    // ν = 8e-6 m²/s lands τ⁺ = 0.516 — close enough to the ½ floor that
    // BGK's odd-even resonance blows the channel up (measured: NaN by
    // step ~1000); the stepper must report it and freeze, never
    // fabricate fields past it.
    const run = stepperOf(
      channelConfig({
        fluid: testFluid(1.2, 8e-6),
        collision: { kind: "bgk" },
      }),
    );
    run.run(6000);
    expect(run.diverged).toBe(true);
    const frozenAt = run.step;
    run.run(100);
    expect(run.step).toBe(frozenAt);
  });

  it("survives the same configuration under TRT (the stability knob)", () => {
    // The SAME τ⁺ = 0.516 under TRT (Λ = 1/4, τ⁻ ≈ 16) runs the whole
    // window without diverging — the two-relaxation-times separation
    // over-damping the odd modes exactly where BGK rings.
    const run = stepperOf(
      channelConfig({
        fluid: testFluid(1.2, 8e-6),
        collision: { kind: "trt" },
      }),
    );
    run.run(6000);
    expect(run.diverged).toBe(false);
    expect(run.step).toBe(6000);
  });

  it("declines structurally invalid configurations", () => {
    expect(
      createLbmStepper(
        channelConfig({
          west: { kind: "velocity-inlet", velocityMPerS: [-0.05, 0] },
        }),
      ).ok,
    ).toBe(false);
    expect(createLbmStepper(channelConfig({ latticeVelocity: 0.3 })).ok).toBe(
      false,
    );
    expect(
      createLbmStepper(channelConfig({ fluid: testFluid(1.2, 1e-9) })).ok,
    ).toBe(false);
    expect(
      createLbmStepper(
        channelConfig({ east: { kind: "pressure-outlet", pressurePa: -1e12 } }),
      ).ok,
    ).toBe(false);
    const badMask = new Uint8Array(180).fill(3);
    expect(
      createLbmStepper(
        channelConfig({ mask: { nx: 20, ny: 9, solid: badMask } }),
      ).ok,
    ).toBe(false);
  });

  it("emits S4-ready solver fields with the grid's geometry", () => {
    const run = stepperOf(
      channelConfig({ originM: [0.25, -0.1], referencePressurePa: 101325 }),
    );
    run.run(50);
    const fields = run.solverFields();
    expect(fields.map((field) => field.id)).toEqual([
      "velocity-x",
      "velocity-y",
      "speed",
      "pressure",
    ]);
    for (const field of fields) {
      expect(field.extent).toEqual([20, 9, 1]);
      expect(field.originM).toEqual([0.25, -0.1, 0]);
      expect(field.spacingM).toEqual([0.001, 0.001, 0.001]);
      expect(field.values.length).toBe(180);
      for (const value of field.values) {
        expect(Number.isFinite(value)).toBe(true);
      }
    }
    const pressure = fields.find((field) => field.id === "pressure");
    expect(pressure?.dimension).toBe("pressure");
    // 50 steps in, the started flow perturbs gauge density only mildly:
    // the reference pressure projects within half a pascal.
    expect(pressure?.values[85]).toBeCloseTo(101325, 0);
    // The S4 seam end-to-end: the solver fields project through
    // sim-core's boundary into document space with the declared units
    // on every projected quantity (velocities m/s → mm/s here).
    const projected = projectSimResult({ scalars: [], fields });
    expect(projected.ok).toBe(true);
    if (!projected.ok) return;
    const projectedVelocity = projected.value.fields.find(
      (field) => field.id === "velocity-x",
    );
    const siSnapshot = run.snapshotSI();
    expect(projectedVelocity?.unit).toBe("mm/s");
    expect(projectedVelocity?.originMm).toEqual([250, -100, 0]);
    expect(projectedVelocity?.values[85]).toBeCloseTo(
      (siSnapshot.velocityXMPerS[85] ?? 0) * 1000,
      6,
    );
  });

  it("carries the run's SI facts in its meta (units, rates, regime honesty)", () => {
    const run = stepperOf(channelConfig());
    expect(run.meta.nx).toBe(20);
    expect(run.meta.units.cellSizeM).toBe(0.001);
    expect(run.meta.rates.kind).toBe("trt");
    expect(run.meta.units.latticeMach).toBeCloseTo(0.05 * Math.sqrt(3), 12);
    expect(run.meta.collision.kind).toBe("trt");
    expect(run.lastStepBookkeeping()).toBeUndefined();
    run.advance();
    const bookkeeping = run.lastStepBookkeeping();
    expect(bookkeeping?.step).toBe(1);
  });
});
