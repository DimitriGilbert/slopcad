/**
 * Phase 54 ISO 216 sheet-size fixtures: the pinned A-series table and the
 * orientation swap `sheetDimensionsMm` applies — the exact millimetres
 * every sheet layout (frame, title block, revision table, view frames)
 * derives from. An off-by-one in the table must fail HERE, not
 * downstream in rendered furniture.
 */

import { describe, expect, it } from "vitest";

import {
  DRAWING_SHEET_SIZE_MM,
  DRAWING_SHEET_SIZES,
  DRAWING_SHEET_TEMPLATES,
  sheetDimensionsMm,
} from "./drawing-sheet";

describe("the pinned ISO 216 A-series table (Phase 54)", () => {
  it("carries the exact portrait millimetres for every size", () => {
    expect([...DRAWING_SHEET_SIZES]).toEqual(["A4", "A3", "A2", "A1", "A0"]);
    expect(DRAWING_SHEET_SIZE_MM.A4).toEqual({ widthMm: 210, heightMm: 297 });
    expect(DRAWING_SHEET_SIZE_MM.A3).toEqual({ widthMm: 297, heightMm: 420 });
    expect(DRAWING_SHEET_SIZE_MM.A2).toEqual({ widthMm: 420, heightMm: 594 });
    expect(DRAWING_SHEET_SIZE_MM.A1).toEqual({ widthMm: 594, heightMm: 841 });
    expect(DRAWING_SHEET_SIZE_MM.A0).toEqual({ widthMm: 841, heightMm: 1189 });
  });

  it("swaps width and height for landscape sheets", () => {
    expect(
      sheetDimensionsMm({ size: "A3", orientation: "landscape", scale: 1 }),
    ).toEqual({ widthMm: 420, heightMm: 297 });
    expect(
      sheetDimensionsMm({ size: "A1", orientation: "landscape", scale: 0.5 }),
    ).toEqual({ widthMm: 841, heightMm: 594 });
  });

  it("keeps portrait dimensions as authored", () => {
    expect(
      sheetDimensionsMm({ size: "A1", orientation: "portrait", scale: 1 }),
    ).toEqual({ widthMm: 594, heightMm: 841 });
    expect(
      sheetDimensionsMm({ size: "A3", orientation: "portrait", scale: 0.5 }),
    ).toEqual({ widthMm: 297, heightMm: 420 });
  });

  it("pins the seeded A3 landscape template at 420 x 297", () => {
    const template = DRAWING_SHEET_TEMPLATES.find(
      (candidate) => candidate.id === "a3-landscape-1-2",
    );
    expect(template).toBeDefined();
    if (template === undefined) return;
    expect(sheetDimensionsMm(template.setup)).toEqual({
      widthMm: 420,
      heightMm: 297,
    });
  });
});
