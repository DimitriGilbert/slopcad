/**
 * Cross-compatibility pins against `@slopcad/sim-dynamics` (Phase
 * 68b): the 0D chamber's slider-crank volume history is the Phase 67
 * kinematics seam CONSUMED, not reworked — the closed-form piston-pin
 * position this package integrates on is pinned BITWISE against the
 * reference dynamics package's exported `sliderCrankPistonSlideM`
 * ground truth over a full crank revolution. The sim-dynamics import
 * is dev-only: it appears in no runtime graph of sim-combustion,
 * exactly as the cad-core pins do in sim-dynamics.
 */

import { sliderCrankPistonSlideM } from "@slopcad/sim-dynamics/fixtures";
import { describe, expect, it } from "vitest";

import { compileSliderCrankGeometry, pistonPinDistanceM } from "./index";

function must<T>(
  result:
    | { readonly ok: true; readonly value: T }
    | { readonly ok: false; readonly error: { readonly message: string } },
  what: string,
): T {
  if (!result.ok) throw new Error(`${what}: ${result.error.message}`);
  return result.value;
}

describe("the Phase 67 volume-history seam", () => {
  it("is bitwise the reference kernel's closed-form piston slide", () => {
    // The same production-shaped linkage the sim-dynamics fixture
    // suite uses: r = 43 mm, l = 143 mm (r/l = 0.3).
    const r = 0.043;
    const l = 0.143;
    const geometry = must(
      compileSliderCrankGeometry({
        boreM: 0.086,
        crankRadiusM: r,
        rodLengthM: l,
        clearanceVolumeM3: 5.5e-5,
      }),
      "geometry",
    );
    for (let i = 0; i <= 720; i += 1) {
      const theta = (i * Math.PI) / 360;
      // sliderCrankPistonSlideM: s(θ) = r·cosθ + √(l² − r²sin²θ) − (r+l);
      // the pin distance minus its TDC value IS the slide.
      const reference = sliderCrankPistonSlideM(r, l, theta);
      // The identical expression tree: pin distance minus the exact
      // TDC pin position (r + l) — no round-trip through sqrt(l²).
      const mine = pistonPinDistanceM(geometry, theta) - (r + l);
      expect(Object.is(mine, reference), `theta ${String(theta)}`).toBe(true);
    }
  });
});
