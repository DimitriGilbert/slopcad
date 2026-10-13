/**
 * Flame-speed correlation pins (Phase 68b): the Metghalchi–Keck form's
 * exact plumbing against the published coefficients recombined by hand
 * in the test, the published exponent signs' qualitative signatures,
 * the honest documentation of the fit's known ambient under-prediction
 * against later iso-octane measurements, the validity-band flags, and
 * the loud declines (uncarried fuels, outside the fitted parabola's
 * span, dilution past the term's zero).
 */

import { describe, expect, it } from "vitest";

import {
  FLAME_SPEED_DILUTION_COEFFICIENT,
  laminarFlameSpeedMPerS,
} from "./index";

function must<T>(
  result:
    | { readonly ok: true; readonly value: T }
    | { readonly ok: false; readonly error: { readonly message: string } },
  what: string,
): T {
  if (!result.ok) throw new Error(`${what}: ${result.error.message}`);
  return result.value;
}

const REF_T = 298.15;
const REF_P = 1.01325;

describe("the Metghalchi–Keck correlation", () => {
  it("reproduces the published reference value at the fit's peak", () => {
    // Metghalchi & Keck (1982), iso-octane: S_L0(φ_m) = B_m =
    // 26.28 cm/s at (298.15 K, 1 atm, no dilution) — the published
    // coefficients recombined by hand here.
    const peak = must(
      laminarFlameSpeedMPerS({
        fuel: "C8H18-ISO",
        equivalenceRatio: 1.13,
        unburnedTK: REF_T,
        pressureBar: REF_P,
      }),
      "peak",
    );
    expect(peak.speedMPerS).toBeCloseTo(0.2628, 10);
    expect(peak.referenceSpeedMPerS).toBeCloseTo(0.2628, 10);
    expect(peak.withinFitBand.temperature).toBe(true);
    expect(peak.withinFitBand.pressure).toBe(true);
  });

  it("carries the published parabola, exponents, and dilution exactly", () => {
    // Hand-recombined at φ = 1: S_L0 = 26.28 − 94.51·(1 − 1.13)²
    // = 24.681 cm/s; α = 2.18, β = −0.16 at φ = 1.
    const atOne = must(
      laminarFlameSpeedMPerS({
        fuel: "C8H18-N",
        equivalenceRatio: 1,
        unburnedTK: REF_T,
        pressureBar: REF_P,
      }),
      "phi 1",
    );
    const sl0 = 26.28 - 94.51 * (1 - 1.13) ** 2;
    expect(atOne.speedMPerS).toBeCloseTo(sl0 / 100, 10);
    // Temperature exponent at φ = 1 (α = 2.18):
    // S_L(600)/S_L(400) = (600/400)^2.18 exactly (same φ, same p).
    const t400 = must(
      laminarFlameSpeedMPerS({
        fuel: "C8H18-ISO",
        equivalenceRatio: 1,
        unburnedTK: 400,
        pressureBar: REF_P,
      }),
      "400K",
    );
    const t600 = must(
      laminarFlameSpeedMPerS({
        fuel: "C8H18-ISO",
        equivalenceRatio: 1,
        unburnedTK: 600,
        pressureBar: REF_P,
      }),
      "600K",
    );
    expect(t600.speedMPerS / t400.speedMPerS).toBeCloseTo(
      (600 / 400) ** 2.18,
      8,
    );
    // Pressure exponent at φ = 1: (20/1 atm)^−0.16.
    const p20 = must(
      laminarFlameSpeedMPerS({
        fuel: "C8H18-ISO",
        equivalenceRatio: 1,
        unburnedTK: REF_T,
        pressureBar: 20 * REF_P,
      }),
      "20 atm",
    );
    expect(p20.speedMPerS / atOne.speedMPerS).toBeCloseTo(20 ** -0.16, 8);
    // Dilution: the published (1 − 2.1·y) factor.
    const diluted = must(
      laminarFlameSpeedMPerS({
        fuel: "C8H18-ISO",
        equivalenceRatio: 1,
        unburnedTK: REF_T,
        pressureBar: REF_P,
        residualMassFraction: 0.1,
      }),
      "diluted",
    );
    expect(diluted.speedMPerS / atOne.speedMPerS).toBeCloseTo(
      1 - FLAME_SPEED_DILUTION_COEFFICIENT * 0.1,
      10,
    );
  });

  it("peaks at φ_m and falls off both sides", () => {
    const speeds = [0.8, 1.0, 1.13, 1.3].map(
      (phi) =>
        must(
          laminarFlameSpeedMPerS({
            fuel: "C8H18-ISO",
            equivalenceRatio: phi,
            unburnedTK: 500,
            pressureBar: 5,
          }),
          `phi ${String(phi)}`,
        ).speedMPerS,
    );
    expect(speeds[2]).toBeGreaterThan(speeds[0] ?? 0);
    expect(speeds[2]).toBeGreaterThan(speeds[1] ?? 0);
    expect(speeds[2]).toBeGreaterThan(speeds[3] ?? 0);
  });

  it("documents the fit's known ambient under-prediction honestly", () => {
    // Published iso-octane/air burning-velocity measurements at
    // ambient conditions peak near 35–40 cm/s (Gülder, Proc. Combust.
    // Inst. 19 (1982) 275; the subsequent bomb/laser measurements
    // summarized in the laminar-flame-speed literature). The M&K
    // iso-octane fit — extrapolated from its elevated-temperature,
    // elevated-pressure bomb data — sits BELOW that band at ambient
    // (its known and documented bias; the engine-condition range is
    // where the fit is used): asserted here as stated behavior, not
    // hidden.
    const ambient = must(
      laminarFlameSpeedMPerS({
        fuel: "C8H18-ISO",
        equivalenceRatio: 1,
        unburnedTK: REF_T,
        pressureBar: REF_P,
      }),
      "ambient",
    );
    expect(ambient.speedMPerS).toBeGreaterThan(0.2);
    expect(ambient.speedMPerS).toBeLessThan(0.3);
  });

  it("flags engine conditions outside the measured band, never declines them", () => {
    const engine = must(
      laminarFlameSpeedMPerS({
        fuel: "C8H18-ISO",
        equivalenceRatio: 1,
        unburnedTK: 900,
        pressureBar: 40,
      }),
      "engine state",
    );
    expect(engine.withinFitBand.temperature).toBe(false);
    expect(engine.withinFitBand.pressure).toBe(false);
    expect(engine.speedMPerS).toBeGreaterThan(0);
  });

  it("declines uncarried fuels, off-span φ, and dead dilution loudly", () => {
    const uncarried = laminarFlameSpeedMPerS({
      fuel: "CH4",
      equivalenceRatio: 1,
      unburnedTK: REF_T,
      pressureBar: REF_P,
    });
    expect(uncarried.ok).toBe(false);
    if (!uncarried.ok) {
      expect(uncarried.error.message).toContain(
        "declines rather than guessing a flame speed",
      );
    }
    // φ far from φ_m: the fitted parabola is no longer positive.
    expect(
      laminarFlameSpeedMPerS({
        fuel: "C8H18-ISO",
        equivalenceRatio: 2.2,
        unburnedTK: REF_T,
        pressureBar: REF_P,
      }).ok,
    ).toBe(false);
    expect(
      laminarFlameSpeedMPerS({
        fuel: "C8H18-ISO",
        equivalenceRatio: 0.45,
        unburnedTK: REF_T,
        pressureBar: REF_P,
      }).ok,
    ).toBe(false);
    // Dilution at the term's zero.
    expect(
      laminarFlameSpeedMPerS({
        fuel: "C8H18-ISO",
        equivalenceRatio: 1,
        unburnedTK: REF_T,
        pressureBar: REF_P,
        residualMassFraction: 0.5,
      }).ok,
    ).toBe(false);
    // Malformed states.
    expect(
      laminarFlameSpeedMPerS({
        fuel: "C8H18-ISO",
        equivalenceRatio: 1,
        unburnedTK: 0,
        pressureBar: REF_P,
      }).ok,
    ).toBe(false);
    expect(
      laminarFlameSpeedMPerS({
        fuel: "C8H18-ISO",
        equivalenceRatio: 1,
        unburnedTK: REF_T,
        pressureBar: -1,
      }).ok,
    ).toBe(false);
  });

  it("is bitwise deterministic on repeat runs (law S2)", () => {
    const input = {
      fuel: "C8H18-ISO",
      equivalenceRatio: 1.05,
      unburnedTK: 620,
      pressureBar: 17.5,
    } as const;
    const first = must(laminarFlameSpeedMPerS(input), "first");
    const second = must(laminarFlameSpeedMPerS(input), "second");
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });
});
