/**
 * Phase 62b colormap-data coverage (the `lighting.test.ts` discipline):
 * stops pinned against LITERALS (never against values derived from the
 * same table), interpolation pinned at known fractional positions —
 * expressed through the same authored arithmetic the semantics define —
 * and the family total: every map well-formed, every lookup total, every
 * call deterministic.
 */

import { describe, expect, it } from "vitest";

import {
  CAD_FIELD_COLORMAPS,
  CAD_FIELD_COLORMAP_COOLWARM,
  CAD_FIELD_COLORMAP_IDS,
  CAD_FIELD_COLORMAP_JET,
  CAD_FIELD_COLORMAP_VIRIDIS,
  fieldColormapById,
  fieldColorRamp,
  fieldSrgbToLinear,
  sampleFieldColormap,
} from "./field-colormaps";

describe("field colormap data", () => {
  it("viridis carries the published anchor stops verbatim", () => {
    expect(
      CAD_FIELD_COLORMAP_VIRIDIS.stops.map((stop) => stop.position),
    ).toEqual([0, 0.25, 0.5, 0.75, 1]);
    expect(CAD_FIELD_COLORMAP_VIRIDIS.stops[0]?.color).toEqual([
      0.267004, 0.004874, 0.329415,
    ]);
    expect(CAD_FIELD_COLORMAP_VIRIDIS.stops[2]?.color).toEqual([
      0.127568, 0.566949, 0.550556,
    ]);
    expect(CAD_FIELD_COLORMAP_VIRIDIS.stops[4]?.color).toEqual([
      0.993248, 0.906157, 0.143936,
    ]);
  });

  it("jet carries the classic six-stop piecewise form", () => {
    expect(CAD_FIELD_COLORMAP_JET.stops.map((stop) => stop.position)).toEqual([
      0, 0.125, 0.375, 0.625, 0.875, 1,
    ]);
    expect(CAD_FIELD_COLORMAP_JET.stops[0]?.color).toEqual([0, 0, 0.5]);
    expect(CAD_FIELD_COLORMAP_JET.stops[2]?.color).toEqual([0, 1, 1]);
    expect(CAD_FIELD_COLORMAP_JET.stops[5]?.color).toEqual([0.5, 0, 0]);
  });

  it("coolwarm carries its three canonical anchors", () => {
    expect(
      CAD_FIELD_COLORMAP_COOLWARM.stops.map((stop) => stop.position),
    ).toEqual([0, 0.5, 1]);
    expect(CAD_FIELD_COLORMAP_COOLWARM.stops[0]?.color).toEqual([
      0.231, 0.299, 0.754,
    ]);
    expect(CAD_FIELD_COLORMAP_COOLWARM.stops[1]?.color).toEqual([
      0.865, 0.865, 0.865,
    ]);
    expect(CAD_FIELD_COLORMAP_COOLWARM.stops[2]?.color).toEqual([
      0.706, 0.016, 0.15,
    ]);
  });

  it("every map is total: ascending stops from 0 to 1 with in-range colors", () => {
    for (const map of CAD_FIELD_COLORMAPS) {
      expect(map.stops.length).toBeGreaterThan(1);
      expect(map.stops[0]?.position).toBe(0);
      expect(map.stops[map.stops.length - 1]?.position).toBe(1);
      const positions = map.stops.map((stop) => stop.position);
      for (let index = 1; index < positions.length; index += 1) {
        expect(positions[index]).toBeGreaterThan(
          positions[index - 1] ?? Number.NEGATIVE_INFINITY,
        );
      }
      for (const stop of map.stops) {
        for (const channel of stop.color) {
          expect(channel).toBeGreaterThanOrEqual(0);
          expect(channel).toBeLessThanOrEqual(1);
        }
      }
    }
    expect(CAD_FIELD_COLORMAP_IDS).toEqual(["viridis", "jet", "coolwarm"]);
  });

  it("the lookup is total and falls back to viridis on an unknown id", () => {
    expect(fieldColormapById("jet")).toBe(CAD_FIELD_COLORMAP_JET);
    expect(fieldColormapById("coolwarm")).toBe(CAD_FIELD_COLORMAP_COOLWARM);
    expect(fieldColormapById("viridis")).toBe(CAD_FIELD_COLORMAP_VIRIDIS);
    expect(fieldColormapById("nonsense")).toBe(CAD_FIELD_COLORMAP_VIRIDIS);
  });
});

describe("sampleFieldColormap", () => {
  it("returns the exact stop color at a stop position", () => {
    expect(sampleFieldColormap(CAD_FIELD_COLORMAP_VIRIDIS, 0.5)).toEqual(
      CAD_FIELD_COLORMAP_VIRIDIS.stops[2]?.color,
    );
    expect(sampleFieldColormap(CAD_FIELD_COLORMAP_JET, 0)).toEqual([0, 0, 0.5]);
  });

  it("interpolates linearly between bracketing stops (jet midpoint)", () => {
    // Between jet's (0, 0, 1) at 0.125 and (0, 1, 1) at 0.375: half-way.
    expect(sampleFieldColormap(CAD_FIELD_COLORMAP_JET, 0.25)).toEqual([
      0, 0.5, 1,
    ]);
  });

  it("interpolates linearly between bracketing stops (coolwarm quarter)", () => {
    // The authored semantics, restated: lower + fraction·(upper − lower)
    // between the cool anchor and the neutral one.
    expect(sampleFieldColormap(CAD_FIELD_COLORMAP_COOLWARM, 0.25)).toEqual([
      0.231 + 0.5 * (0.865 - 0.231),
      0.299 + 0.5 * (0.865 - 0.299),
      0.754 + 0.5 * (0.865 - 0.754),
    ]);
  });

  it("clamps positions outside [0, 1] to the end stops", () => {
    expect(sampleFieldColormap(CAD_FIELD_COLORMAP_VIRIDIS, -1)).toEqual(
      CAD_FIELD_COLORMAP_VIRIDIS.stops[0]?.color,
    );
    expect(sampleFieldColormap(CAD_FIELD_COLORMAP_VIRIDIS, 2)).toEqual(
      CAD_FIELD_COLORMAP_VIRIDIS.stops[4]?.color,
    );
  });

  it("is deterministic: repeated samples return identical triples", () => {
    for (const map of CAD_FIELD_COLORMAPS) {
      for (const t of [0, 0.1, 0.37, 0.5, 0.63, 0.9, 1]) {
        expect(sampleFieldColormap(map, t)).toEqual(
          sampleFieldColormap(map, t),
        );
      }
    }
  });
});

describe("fieldSrgbToLinear", () => {
  it("maps the exact anchors: 0 → 0, 1 → 1, and the linear-half break", () => {
    expect(fieldSrgbToLinear(0)).toBe(0);
    expect(fieldSrgbToLinear(1)).toBe(1);
    expect(fieldSrgbToLinear(0.04045)).toBeCloseTo(0.04045 / 12.92, 12);
    expect(fieldSrgbToLinear(0.04046)).toBeGreaterThan(0.04046 / 12.92);
  });

  it("carries the published mid-grey transfer value", () => {
    // The well-known sRGB mid-grey result (0.21404114…) — an external
    // anchor for the curve's 2.4-power half.
    expect(fieldSrgbToLinear(0.5)).toBeCloseTo(0.21404114, 8);
  });
});

describe("fieldColorRamp", () => {
  it("normalizes over the window and paints linear rgb", () => {
    const ramp = fieldColorRamp({ colormap: CAD_FIELD_COLORMAP_JET }, [0, 10]);
    const atBottom = ramp(0);
    const atMid = ramp(5);
    const atTop = ramp(10);
    // Jet at 0 is (0, 0, 0.5); its linear form is the transfer of each
    // channel — blue 0.5 → the 2.4-power curve.
    expect(atBottom).toEqual([0, 0, fieldSrgbToLinear(0.5)]);
    // Jet at 0.5 sits between cyan (0, 1, 1) at 0.375 and yellow at 0.625:
    // half-way is (0.5, 1, 0.5) in sRGB.
    expect(atMid).toEqual([fieldSrgbToLinear(0.5), 1, fieldSrgbToLinear(0.5)]);
    expect(atTop).toEqual([fieldSrgbToLinear(0.5), 0, 0]);
  });

  it("clamps values outside the window to the scale's ends", () => {
    const ramp = fieldColorRamp(
      { colormap: CAD_FIELD_COLORMAP_VIRIDIS },
      [0, 1],
    );
    expect(ramp(-5)).toEqual(ramp(0));
    expect(ramp(5)).toEqual(ramp(1));
  });

  it("a degenerate window maps everything to the scale's bottom", () => {
    const ramp = fieldColorRamp(
      { colormap: CAD_FIELD_COLORMAP_VIRIDIS, valueRange: [3, 3] },
      [0, 10],
    );
    expect(ramp(0)).toEqual(ramp(100));
    expect(ramp(100)).toEqual(
      CAD_FIELD_COLORMAP_VIRIDIS.stops[0]?.color.map(fieldSrgbToLinear),
    );
  });

  it("an explicit window overrides the fallback", () => {
    const fallback = fieldColorRamp(
      { colormap: CAD_FIELD_COLORMAP_JET },
      [0, 10],
    );
    const explicit = fieldColorRamp(
      { colormap: CAD_FIELD_COLORMAP_JET, valueRange: [0, 20] },
      [0, 10],
    );
    // Half of the explicit window is a quarter of the fallback's: the
    // explicit ramp's value 5 equals the fallback's value 2.5.
    expect(explicit(5)).toEqual(fallback(2.5));
  });
});
