/**
 * The Phase 53 drawing model fixtures: parse/serialize round-trip with
 * byte-determinism, the failure taxonomy, the alignment math (first/third
 * angle), the frame math, and the edges-overlay projection's analytic
 * feature-edge counts on a hand-built box mesh.
 */

import { describe, expect, it } from "vitest";

import {
  alignedViewPlacement,
  createBodyId,
  createDrawingViewId,
  createSheetId,
  DRAWING_ERROR_CODES,
  DRAWING_SHEET_SIZES,
  type DrawingDocument,
  type DrawingSheet,
  edgesOverlayProjectionForKind,
  parseDrawingDocument,
  roundTripDrawingDocument,
  serializeDrawingDocument,
  sheetDimensions,
  stringifyNativeCadDocument,
  createDocument,
  createDocumentId,
  createNativeCadDocument,
  parseNativeCadDocumentFromString,
  serializeNativeCadDocument,
  viewBasisForKind,
  viewFitsSheet,
  viewFrameFromGeometry,
} from "./index";

const bodyId = createBodyId("body_plate");

const sheet: DrawingSheet = {
  id: createSheetId("sht_main"),
  size: "A3",
  orientation: "landscape",
  scale: { numerator: 1, denominator: 1 },
  views: [
    {
      id: createDrawingViewId("dwv_front"),
      kind: "front",
      bodyId,
      x: 148,
      y: 140,
      scale: null,
      alignedTo: null,
    },
    {
      id: createDrawingViewId("dwv_top"),
      kind: "top",
      bodyId,
      x: 148,
      y: 250,
      scale: null,
      alignedTo: createDrawingViewId("dwv_front"),
    },
  ],
};

const drawing: DrawingDocument = { sheets: [sheet] };

/** JSON.parse with the any-laundering made explicit at one seam. */
const parseJson = (text: string): unknown => JSON.parse(text) as unknown;

describe("the drawing document model", () => {
  it("round-trips exactly and deterministically", () => {
    const serialized = serializeDrawingDocument(drawing);
    const text = JSON.stringify(serialized);
    const parsed = parseDrawingDocument(parseJson(text));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(serializeDrawingDocument(parsed.value)).toEqual(serialized);
    expect(JSON.stringify(serializeDrawingDocument(parsed.value))).toBe(text);
    const again = roundTripDrawingDocument(drawing);
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(serializeDrawingDocument(again.value)).toEqual(serialized);
  });

  it("rejects a wrong version, an unknown size, a bad id, and an unknown alignment target", () => {
    const canonical = serializeDrawingDocument(drawing);
    const clone = (): Record<string, unknown> =>
      JSON.parse(JSON.stringify(canonical)) as Record<string, unknown>;
    const badVersion = clone();
    badVersion.formatVersion = 2;
    expect(parseDrawingDocument(badVersion).ok).toBe(false);
    const badSize = clone();
    const sheetRecord = badSize.sheets as Record<string, unknown>[];
    const sizeSheet = sheetRecord[0];
    if (sizeSheet !== undefined) sizeSheet.size = "A5";
    const sizeResult = parseDrawingDocument(badSize);
    expect(sizeResult.ok).toBe(false);
    if (!sizeResult.ok) {
      expect(sizeResult.error.code).toBe(DRAWING_ERROR_CODES.unknownSheetSize);
    }
    const badId = clone();
    const idSheet = badId.sheets as Record<string, unknown>[];
    const idViews = idSheet[0]?.views as Record<string, unknown>[];
    const badIdView = idViews?.[0];
    if (badIdView !== undefined) badIdView.id = "view_front";
    const idResult = parseDrawingDocument(badId);
    expect(idResult.ok).toBe(false);
    if (!idResult.ok) {
      expect(idResult.error.code).toBe(DRAWING_ERROR_CODES.invalidViewId);
    }
    const badAlignment = clone();
    const alSheet = badAlignment.sheets as Record<string, unknown>[];
    const alViews = alSheet[0]?.views as Record<string, unknown>[];
    const alignedView = alViews?.[1];
    if (alignedView !== undefined) alignedView.alignedTo = "dwv_missing";
    const alignmentResult = parseDrawingDocument(badAlignment);
    expect(alignmentResult.ok).toBe(false);
    if (!alignmentResult.ok) {
      expect(alignmentResult.error.code).toBe(
        DRAWING_ERROR_CODES.unknownAlignmentTarget,
      );
    }
  });

  it("derives the documented view bases and sheet dimensions", () => {
    const front = viewBasisForKind("front");
    expect(front.right[0]).toBeCloseTo(1, 12);
    expect(front.up[2]).toBeCloseTo(1, 12);
    const top = viewBasisForKind("top");
    expect(top.right[0]).toBeCloseTo(1, 12);
    expect(top.up[1]).toBeCloseTo(1, 12);
    const right = viewBasisForKind("right");
    expect(right.right[1]).toBeCloseTo(1, 12);
    expect(right.up[2]).toBeCloseTo(1, 12);
    expect(sheetDimensions({ size: "A4", orientation: "portrait" })).toEqual({
      width: 210,
      height: 297,
    });
    expect(sheetDimensions({ size: "A4", orientation: "landscape" })).toEqual({
      width: 297,
      height: 210,
    });
    expect(DRAWING_SHEET_SIZES.A0).toEqual({ width: 841, height: 1189 });
  });

  it("places aligned views by the first/third-angle conventions", () => {
    const parent = { x: 100, y: 100, kind: "front" as const };
    const parentFrame = { width: 60, height: 20 };
    const viewFrame = { width: 60, height: 40 };
    const gap = 15;
    // Third angle: top ABOVE the front view (sheet y is top-down: a
    // smaller y is higher on the paper).
    const thirdTop = alignedViewPlacement(
      "top",
      parent,
      "third",
      parentFrame,
      viewFrame,
      gap,
    );
    expect(thirdTop.x).toBe(100);
    expect(thirdTop.y).toBe(100 - (10 + gap + 20));
    // First angle: top BELOW.
    const firstTop = alignedViewPlacement(
      "top",
      parent,
      "first",
      parentFrame,
      viewFrame,
      gap,
    );
    expect(firstTop.y).toBe(100 + (10 + gap + 20));
    // Third angle: right to the RIGHT of the front view, y registered.
    const thirdRight = alignedViewPlacement(
      "right",
      parent,
      "third",
      parentFrame,
      viewFrame,
      gap,
    );
    expect(thirdRight.x).toBe(100 + 30 + gap + 30);
    expect(thirdRight.y).toBe(100);
  });

  it("frames a view from geometry bounds and judges sheet fit", () => {
    const frontView = sheet.views[0];
    if (frontView === undefined) throw new Error("the front view is missing");
    const frame = viewFrameFromGeometry(frontView, sheet, {
      minU: 0,
      maxU: 60,
      minV: 0,
      maxV: 30,
    });
    expect(frame).toEqual({ x: 148, y: 140, width: 60, height: 30 });
    const { width, height } = sheetDimensions(sheet);
    expect(
      viewFitsSheet(
        { x: width / 2, y: height / 2, width: 60, height: 30 },
        sheet,
      ),
    ).toBe(true);
    expect(
      viewFitsSheet({ x: 12, y: height / 2, width: 60, height: 30 }, sheet),
    ).toBe(false);
  });
});

describe("the edges-overlay projection fallback", () => {
  // A 60x40x10 box as an indexed triangle soup (12 triangles).
  const boxMesh = {
    positions: [
      0, 0, 0, 60, 0, 0, 60, 40, 0, 0, 40, 0, 0, 0, 10, 60, 0, 10, 60, 40, 10,
      0, 40, 10,
    ],
    indices: [
      0, 3, 2, 0, 2, 1, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2,
      3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7,
    ],
  };

  it("extracts the box's 8 drawable feature edges per orthographic view", () => {
    const front = edgesOverlayProjectionForKind(boxMesh, "front");
    expect(front.fidelity).toBe("edges-overlay");
    // 12 feature edges; the 4 edges parallel to the view direction project
    // to points and are dropped (a drawing never renders an end-on edge as
    // a degenerate dot).
    expect(front.visible.length).toBe(8);
    expect(front.hidden).toEqual([]);
    expect(front.bounds).toEqual({ minU: 0, maxU: 60, minV: 0, maxV: 10 });
    const top = edgesOverlayProjectionForKind(boxMesh, "top");
    expect(top.visible.length).toBe(8);
    expect(top.bounds).toEqual({ minU: 0, maxU: 60, minV: 0, maxV: 40 });
  });

  it("returns the empty geometry for malformed meshes", () => {
    expect(
      edgesOverlayProjectionForKind({ positions: [], indices: [] }, "front"),
    ).toEqual({
      fidelity: "edges-overlay",
      visible: [],
      hidden: [],
      bounds: null,
    });
    expect(
      edgesOverlayProjectionForKind(
        { positions: [0, 0, 0], indices: [0, 99, 0] },
        "front",
      ).bounds,
    ).toBeNull();
  });
});

describe("the native envelope's drawing field", () => {
  const envelopeOf = () => {
    const result = createNativeCadDocument(
      createDocument(createDocumentId("doc_root")),
    );
    if (!result.ok) throw new Error("the envelope factory failed");
    return result.value;
  };

  it("omits the field when no drawing exists (pre-Phase 53 bytes unchanged)", () => {
    const native = envelopeOf();
    const text = stringifyNativeCadDocument(serializeNativeCadDocument(native));
    expect(text).not.toContain('"drawing"');
    const parsed = parseNativeCadDocumentFromString(text);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.drawing).toBeNull();
  });

  it("round-trips a drawing through the envelope's optional field", () => {
    const native = envelopeOf();
    const withDrawing = { ...native, drawing };
    const text = stringifyNativeCadDocument(
      serializeNativeCadDocument(withDrawing),
    );
    expect(text).toContain('"drawing"');
    const parsed = parseNativeCadDocumentFromString(text);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.drawing).not.toBeNull();
    expect(
      JSON.stringify(
        serializeDrawingDocument(parsed.value.drawing ?? { sheets: [] }),
      ),
    ).toBe(JSON.stringify(serializeDrawingDocument(drawing)));
    // Old-reader compatibility in reverse: a reader that strips the unknown
    // field still loads the document.
    const stripped = parseJson(text) as Record<string, unknown>;
    delete stripped.drawing;
    const reread = parseNativeCadDocumentFromString(JSON.stringify(stripped));
    expect(reread.ok).toBe(true);
  });
});
