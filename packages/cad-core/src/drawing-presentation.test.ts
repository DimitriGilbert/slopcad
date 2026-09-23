/**
 * Phase 54 presentation fixtures: the y-flip rendering discipline's math
 * (arrowhead triangles, arc flags, the text counter-flip — the shared
 * geometry the canvas and the exporter both consume, pinned so the two
 * surfaces can never drift apart again), the vertical dimension's
 * clear-of-the-line text placement, and the pinned GD&T symbol table
 * (the fourteen ISO 1101 characteristics, membership and length — a
 * trimmed table must fail here).
 */

import { describe, expect, it } from "vitest";
import type {
  DrawingDimension,
  DrawingDimensionId,
} from "./drawing-annotations";

import {
  arrowHeadPolygonPoints,
  GDNT_SYMBOLS,
  presentDrawingDimension,
  sheetArcGeometry,
  uprightTextTransform,
} from "./drawing-presentation";
import { formatSvgNumber } from "./drawing-svg";

describe("the y-flip rendering discipline (Phase 54)", () => {
  it("builds arrowhead triangles in raw sheet coordinates", () => {
    // Tip (10, 10) pointing 45 degrees up-right: the base corners sit
    // 3mm back along the arrow and ±1.1mm across it — NO pre-flip of the
    // corner y signs (the root group's single flip renders it correctly;
    // a pre-flip mirrors oblique arrowheads).
    expect(arrowHeadPolygonPoints(10, 10, Math.PI / 4, formatSvgNumber)).toBe(
      "10,10 8.6565,7.1009 7.1009,8.6565",
    );
  });

  it("keeps axis-aligned arrowheads symmetric behind the tip", () => {
    expect(arrowHeadPolygonPoints(10, 10, 0, String)).toBe(
      "10,10 7,8.9 7,11.1",
    );
    expect(arrowHeadPolygonPoints(10, 10, Math.PI, String)).toBe(
      "10,10 13,11.1 13,8.9",
    );
  });

  it("derives arc endpoints in raw sheet coordinates with flipped sweep", () => {
    // A counter-clockwise sheet sweep renders with sweep flag 1 inside
    // the y-flip group; endpoints stay raw (a pre-flipped endpoint y
    // mirrors the arc about its center).
    const quarter = sheetArcGeometry({
      cx: 0,
      cy: 0,
      radius: 10,
      startRad: 0,
      endRad: Math.PI / 2,
    });
    expect(quarter.startX).toBe(10);
    expect(quarter.startY).toBe(0);
    expect(quarter.endX).toBeCloseTo(0, 10);
    expect(quarter.endY).toBe(10);
    expect(quarter.largeArc).toBe(false);
    expect(quarter.sweepFlag).toBe(true);
  });

  it("marks reflex and clockwise sweeps", () => {
    const reflex = sheetArcGeometry({
      cx: 0,
      cy: 0,
      radius: 5,
      startRad: 0,
      endRad: -Math.PI * 1.5,
    });
    expect(reflex.largeArc).toBe(true);
    expect(reflex.sweepFlag).toBe(false);
    const semicircle = sheetArcGeometry({
      cx: 1,
      cy: 2,
      radius: 3,
      startRad: Math.PI,
      endRad: 0,
    });
    expect(semicircle.largeArc).toBe(false);
    expect(semicircle.sweepFlag).toBe(false);
  });

  it("counter-flips text about its own baseline", () => {
    expect(uprightTextTransform(180.375, formatSvgNumber)).toBe(
      "translate(0 360.75) scale(1 -1)",
    );
    expect(uprightTextTransform(182, String)).toBe(
      "translate(0 364) scale(1 -1)",
    );
  });
});

describe("linear dimension text placement (Phase 54)", () => {
  it("places vertical dimension text clear of the line and arrows", () => {
    const dimension = {
      kind: "linear",
      id: "drdim_depth" as DrawingDimensionId,
      viewId: "view_front",
      orientation: "vertical",
      from: { x: 122, y: 177 },
      to: { x: 122, y: 187 },
      offsetMm: 6,
      valueMm: 20,
      origin: { source: "reference" },
    } as const satisfies DrawingDimension;
    const primitives = presentDrawingDimension(dimension);
    const line = primitives.find(
      (primitive) => primitive.kind === "line" && primitive.x1 === primitive.x2,
    );
    expect(line).toMatchObject({ x1: 128, x2: 128 });
    const text = primitives.find((primitive) => primitive.kind === "text");
    // Beside the dim line (offset along the same normal that placed it),
    // baseline centered on the span — the vertical line can no longer
    // strike through middle-anchored glyphs.
    expect(text).toEqual({
      kind: "text",
      x: 133.25,
      y: 180.25,
      text: "(20)",
      anchor: "middle",
      sizeMm: 3.5,
    });
  });

  it("keeps horizontal dimension text above the line", () => {
    const dimension = {
      kind: "linear",
      id: "drdim_width" as DrawingDimensionId,
      viewId: "view_front",
      orientation: "horizontal",
      from: { x: 58, y: 179 },
      to: { x: 88, y: 179 },
      offsetMm: 6,
      valueMm: 60,
      origin: { source: "reference" },
    } as const satisfies DrawingDimension;
    const text = presentDrawingDimension(dimension).find(
      (primitive) => primitive.kind === "text",
    );
    expect(text).toEqual({
      kind: "text",
      x: 73,
      y: 186.75,
      text: "(60)",
      anchor: "middle",
      sizeMm: 3.5,
    });
  });
});

describe("the pinned GD&T characteristic table (Phase 54)", () => {
  it("carries exactly the fourteen ISO 1101 characteristics", () => {
    expect(Object.keys(GDNT_SYMBOLS)).toEqual([
      "straightness",
      "flatness",
      "circularity",
      "cylindricity",
      "lineProfile",
      "surfaceProfile",
      "angularity",
      "perpendicularity",
      "parallelism",
      "position",
      "concentricity",
      "symmetry",
      "circularRunout",
      "totalRunout",
    ]);
    expect(Object.keys(GDNT_SYMBOLS)).toHaveLength(14);
  });

  it("maps each characteristic to its standardized glyph", () => {
    expect(GDNT_SYMBOLS.straightness).toBe("\u23E4");
    expect(GDNT_SYMBOLS.flatness).toBe("\u23E5");
    expect(GDNT_SYMBOLS.circularity).toBe("\u25CB");
    expect(GDNT_SYMBOLS.cylindricity).toBe("\u232D");
    expect(GDNT_SYMBOLS.lineProfile).toBe("\u2313");
    expect(GDNT_SYMBOLS.surfaceProfile).toBe("\u2303");
    expect(GDNT_SYMBOLS.angularity).toBe("\u2220");
    expect(GDNT_SYMBOLS.perpendicularity).toBe("\u27C2");
    expect(GDNT_SYMBOLS.parallelism).toBe("\u2225");
    expect(GDNT_SYMBOLS.position).toBe("\u2316");
    expect(GDNT_SYMBOLS.concentricity).toBe("\u25CE");
    expect(GDNT_SYMBOLS.symmetry).toBe("\u232F");
    expect(GDNT_SYMBOLS.circularRunout).toBe("\u2197");
    expect(GDNT_SYMBOLS.totalRunout).toBe("\u21F7");
    for (const glyph of Object.values(GDNT_SYMBOLS)) {
      expect(glyph.length).toBeGreaterThan(0);
    }
  });
});
