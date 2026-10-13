/**
 * Slider-crank chamber-geometry pins (Phase 68b): the volume at the
 * stroke's ends, the crank derivative against a finite difference, the
 * wetted-area behavior, and the compression-ratio arithmetic — the
 * linkage facts the 0D chamber integrates on.
 */

import { describe, expect, it } from "vitest";

import {
  chamberVolumeM3,
  chamberVolumePerRad,
  chamberWallAreaM2,
  compileSliderCrankGeometry,
  compressionRatioOf,
  displacementM3,
  pistonAreaM2,
  pistonPinDistanceM,
  pistonPinTravelPerRad,
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

// A production-shaped single cylinder: 86 mm bore × 86 mm stroke
// (r = 43 mm), 143 mm rod (r/l = 0.3), CR 10.
const GEO = must(
  compileSliderCrankGeometry({
    boreM: 0.086,
    crankRadiusM: 0.043,
    rodLengthM: 0.143,
    clearanceVolumeM3: 5.5e-5,
  }),
  "geometry",
);

describe("the slider-crank chamber geometry", () => {
  it("places V_TDC at the clearance and V_BDC at clearance + displacement", () => {
    const vTdc = chamberVolumeM3(GEO, 0);
    const vBdc = chamberVolumeM3(GEO, Math.PI);
    expect(vTdc).toBeCloseTo(GEO.clearanceVolumeM3, 12);
    expect(vBdc).toBeCloseTo(GEO.clearanceVolumeM3 + displacementM3(GEO), 9);
    expect(compressionRatioOf(GEO)).toBeCloseTo(vBdc / vTdc, 9);
    // Displacement: π/4·B²·2r = π/4·0.086²·0.086 = 4.995e-4 m³.
    expect(displacementM3(GEO)).toBeCloseTo(4.995e-4, 6);
    expect(pistonAreaM2(GEO)).toBeCloseTo((Math.PI * 0.086 ** 2) / 4, 12);
  });

  it("matches its crank derivative to a central finite difference", () => {
    for (const theta of [-2.8, -1.9, -0.7, -0.2, 0.35, 1.1, 2.4]) {
      const h = 1e-6;
      const numeric =
        (chamberVolumeM3(GEO, theta + h) - chamberVolumeM3(GEO, theta - h)) /
        (2 * h);
      expect(chamberVolumePerRad(GEO, theta)).toBeCloseTo(numeric, 6);
      const pinNumeric =
        (pistonPinDistanceM(GEO, theta + h) -
          pistonPinDistanceM(GEO, theta - h)) /
        (2 * h);
      expect(pistonPinTravelPerRad(GEO, theta)).toBeCloseTo(pinNumeric, 6);
    }
  });

  it("wets more wall as the piston travels from TDC", () => {
    const aTdc = chamberWallAreaM2(GEO, 0);
    const aBdc = chamberWallAreaM2(GEO, Math.PI);
    expect(aTdc).toBeGreaterThan(2 * pistonAreaM2(GEO));
    expect(aBdc).toBeGreaterThan(aTdc);
    // Linear in piston travel: area(θ) − area(TDC) = π·B·travel(θ)
    // exactly (the liner's contribution), pinched at a mid-stroke angle.
    const theta = -Math.PI / 3;
    const travel = pistonPinDistanceM(GEO, 0) - pistonPinDistanceM(GEO, theta);
    expect(chamberWallAreaM2(GEO, theta) - aTdc).toBeCloseTo(
      Math.PI * GEO.boreM * travel,
      12,
    );
    expect(chamberWallAreaM2(GEO, theta)).toBeGreaterThan(aTdc);
    expect(chamberWallAreaM2(GEO, theta)).toBeLessThan(aBdc);
  });

  it("declines malformed linkages structurally", () => {
    expect(
      compileSliderCrankGeometry({
        boreM: 0.086,
        crankRadiusM: 0.043,
        rodLengthM: 0.03,
        clearanceVolumeM3: 5.5e-5,
      }).ok,
    ).toBe(false);
    expect(
      compileSliderCrankGeometry({
        boreM: 0.086,
        crankRadiusM: 0.043,
        rodLengthM: 0.143,
        clearanceVolumeM3: 0,
      }).ok,
    ).toBe(false);
  });
});
