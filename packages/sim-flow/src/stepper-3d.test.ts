/**
 * The 3D stepper's tests (Phase 66a): the oracle's own honesty surface —
 * bitwise determinism, pause/step/resume equality, the divergence
 * freeze, the solver-field shape (a 3D extent, five fields), and every
 * structural refusal the compile doors own. The physics pins (the
 * Poiseuille parabola, the box audit identity) live in their own
 * fixtures; this file pins the stepper's contract.
 */

import { describe, expect, it } from "vitest";

import { analyticOccupancy3d, testFluid } from "./fixtures";
import {
  type Lbm3dStepper,
  type Lbm3dStepperConfig,
  createLbm3dStepper,
} from "./stepper-3d";

function channelConfig(
  overrides: Partial<Lbm3dStepperConfig> = {},
): Lbm3dStepperConfig {
  return {
    mask: { nx: 12, ny: 7, nz: 7, solid: new Uint8Array(12 * 7 * 7) },
    fluid: testFluid(1.2, 2e-4),
    cellSizeM: 0.001,
    characteristicVelocityMPerS: 0.075,
    west: { kind: "velocity-inlet", velocityMPerS: [0.05, 0, 0] },
    east: { kind: "convective-outflow" },
    south: { kind: "wall", slip: false },
    north: { kind: "wall", slip: false },
    bottom: { kind: "wall", slip: false },
    top: { kind: "wall", slip: false },
    ...overrides,
  };
}

function bytesOf(array: Float32Array | Float64Array): Buffer {
  return Buffer.from(array.buffer, array.byteOffset, array.byteLength);
}

/** Bitwise equality of two 3D steppers' full state (law S2's byte claim). */
function assertSameBytes(first: Lbm3dStepper, second: Lbm3dStepper): void {
  expect(first.step).toBe(second.step);
  const fa = first.distributions();
  const fb = second.distributions();
  for (let i = 0; i < 19; i += 1) {
    expect(bytesOf(fa[i]!).equals(bytesOf(fb[i]!))).toBe(true);
  }
  const sa = first.snapshotSI();
  const sb = second.snapshotSI();
  for (const key of [
    "densityKgPerM3",
    "velocityXMPerS",
    "velocityYMPerS",
    "velocityZMPerS",
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

function stepperOf(config: Lbm3dStepperConfig): Lbm3dStepper {
  const created = createLbm3dStepper(config);
  if (!created.ok) throw new Error(created.error.message);
  return created.value;
}

describe("the 3D stepper", () => {
  it("is bitwise deterministic on repeat runs (fixed steps, same bytes)", () => {
    const first = stepperOf(channelConfig());
    const second = stepperOf(channelConfig());
    first.run(200);
    second.run(200);
    assertSameBytes(first, second);
  });

  it("pause/step/resume equals one straight run (the 66b driving shape)", () => {
    const straight = stepperOf(channelConfig());
    straight.run(200);
    const paused = stepperOf(channelConfig());
    paused.run(80);
    paused.advance();
    paused.advance();
    expect(paused.step).toBe(82);
    paused.run(118);
    expect(paused.step).toBe(200);
    assertSameBytes(straight, paused);
  });

  it("freezes on divergence instead of fabricating (BGK's high-Re resonance)", () => {
    // ν = 1.5e-5 m²/s lands τ⁺ = 0.530 — close enough to the ½ floor
    // that BGK's odd-even resonance blows the duct up (measured: NaN
    // by step 147); the stepper must report it and freeze, never
    // fabricate fields past it.
    const run = stepperOf(
      channelConfig({
        fluid: testFluid(1.2, 1.5e-5),
        collision: { kind: "bgk" },
      }),
    );
    run.run(6000);
    expect(run.diverged).toBe(true);
    const frozenAt = run.step;
    run.run(100);
    expect(run.step).toBe(frozenAt);
  });

  it("survives the same configuration under TRT with the advection-dominated magic parameter", () => {
    // The 3D knob map, measured at authoring time on this duct
    // (τ⁺ = 0.530): BGK diverges at 147, TRT Λ = 1/4 at 1190 — the
    // channel-exact value's slow odd relaxation (τ⁻ ≈ 8.8) is not the
    // stability choice in 3D edge-dominated geometries, where the
    // wall-edge nodes' shared-diagonal treatment feeds a marginal
    // resonance the 2D twin does not have — and TRT Λ = 1/12 (the
    // advection-dominated value `./relaxation` documents) runs the
    // whole window without diverging. Two knobs, pinned honestly.
    const run = stepperOf(
      channelConfig({
        fluid: testFluid(1.2, 1.5e-5),
        collision: { kind: "trt", magicLambda: 1 / 12 },
      }),
    );
    run.run(6000);
    expect(run.diverged).toBe(false);
    expect(run.step).toBe(6000);
    const quarter = stepperOf(
      channelConfig({
        fluid: testFluid(1.2, 1.5e-5),
        collision: { kind: "trt" },
      }),
    );
    quarter.run(6000);
    expect(quarter.diverged).toBe(true);
    // Timeout budget: the two 6000-step-window duct runs (7190 steps
    // total; the Λ = 1/4 twin freezes at 1190) measure ≈ 10.2 s
    // isolated (measured at authoring time); the full gate's parallel
    // CPU contention multiplies fixtures by up to ~7× (the Phase 63
    // measurements) — 70 s is ≈ 1.0× that extrapolated worst case — an
    // infrastructure budget, not an assertion: passing still requires
    // passing.
  }, 70_000);

  it("declines structurally invalid configurations", () => {
    expect(
      createLbm3dStepper(
        channelConfig({
          mask: {
            nx: 12,
            ny: 7,
            nz: 7,
            solid: new Uint8Array(12 * 7 * 6),
          },
        }),
      ).ok,
    ).toBe(false);
    expect(
      createLbm3dStepper(
        channelConfig({
          mask: {
            nx: 12,
            ny: 7,
            nz: 2,
            solid: new Uint8Array(12 * 7 * 2),
          },
        }),
      ).ok,
    ).toBe(false);
    const badValues = new Uint8Array(12 * 7 * 7).fill(2);
    expect(
      createLbm3dStepper(
        channelConfig({ mask: { nx: 12, ny: 7, nz: 7, solid: badValues } }),
      ).ok,
    ).toBe(false);
    expect(
      createLbm3dStepper(
        channelConfig({
          fluid: { ...testFluid(1.2, 2e-4), kinematicViscosityM2PerS: 0 },
        }),
      ).ok,
    ).toBe(false);
    expect(
      createLbm3dStepper(
        channelConfig({
          collision: { kind: "trt", magicLambda: 1.5 },
        }),
      ).ok,
    ).toBe(false);
    // An inlet pointing OUT of the domain on every axis-facing face.
    expect(
      createLbm3dStepper(
        channelConfig({
          west: { kind: "velocity-inlet", velocityMPerS: [-0.05, 0, 0] },
        }),
      ).ok,
    ).toBe(false);
    expect(
      createLbm3dStepper(
        channelConfig({
          top: { kind: "velocity-inlet", velocityMPerS: [0, 0, 0.05] },
        }),
      ).ok,
    ).toBe(false);
    // A lattice velocity past the low-Mach ceiling: 0.4 m/s at
    // u_lat/u_char = 2/3 maps to a lattice speed of 0.267 > 0.2.
    expect(
      createLbm3dStepper(
        channelConfig({
          west: { kind: "velocity-inlet", velocityMPerS: [0.4, 0, 0] },
        }),
      ).ok,
    ).toBe(false);
    // An outlet pressure that drives the lattice density non-positive.
    expect(
      createLbm3dStepper(
        channelConfig({
          east: { kind: "pressure-outlet", pressurePa: -1e9 },
        }),
      ).ok,
    ).toBe(false);
    expect(
      createLbm3dStepper(channelConfig({ originM: [0, Number.NaN, 0] })).ok,
    ).toBe(false);
  });

  it("emits the S4 solver fields with a 3D extent and the documented ids", () => {
    const run = stepperOf(
      channelConfig({
        mask: {
          nx: 12,
          ny: 7,
          nz: 7,
          solid: analyticOccupancy3d(
            12,
            7,
            7,
            (x, y, z) =>
              x >= 5 && x <= 7 && y >= 2 && y <= 4 && z >= 2 && z <= 4,
          ),
        },
      }),
    );
    run.run(50);
    const fields = run.solverFields();
    expect(fields.map((field) => field.id)).toEqual([
      "velocity-x",
      "velocity-y",
      "velocity-z",
      "speed",
      "pressure",
    ]);
    for (const field of fields) {
      expect(field.extent).toEqual([12, 7, 7]);
      expect(field.originM).toEqual([0, 0, 0]);
      expect(field.spacingM).toEqual([0.001, 0.001, 0.001]);
      expect(field.dataType).toBe("float32");
      expect(field.values.length).toBe(12 * 7 * 7);
    }
  });
});
