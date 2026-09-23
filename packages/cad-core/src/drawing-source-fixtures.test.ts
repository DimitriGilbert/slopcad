/**
 * Phase 54 dimension-source and presentation/export fixtures: the
 * dimension-value fixture (a 20 mm extrude carries a 20 mm dim — value
 * derived from the same parameter, unit-converted), the deterministic
 * presentation, and the byte-determinism of the SVG export preview.
 */

import { describe, expect, it } from "vitest";
import type { CadDocument } from "./document";
import type { ParseResult } from "./result";

import { addDocumentParameter, addFeature, createDocument } from "./document";
import { angle, length } from "./dimensional";
import { createDocumentId, createFeatureId } from "./ids";
import {
  parseDrawingDimension,
  serializeDrawingDimension,
  type DrawingDimension,
} from "./drawing-annotations";
import {
  compareDrawingId,
  composeSheetPresentation,
  formatDimensionValue,
  holeCalloutText,
  threadCalloutText,
} from "./drawing-presentation";
import { recoverFeatureDimensions } from "./drawing-dimension-source";
import { formatSvgNumber, serializeDrawingSheetSvg } from "./drawing-svg";
import {
  DRAWING_SHEET_TEMPLATES,
  drawingSheetTemplateById,
} from "./drawing-sheet";

function unwrap<T>(result: ParseResult<T>, what: string): T {
  if (!result.ok)
    throw new Error(`${what} failed: ${JSON.stringify(result.error)}`);
  return result.value;
}

function documentWithExtrudeDepth20(): CadDocument {
  let document = createDocument(createDocumentId("doc_drawing"));
  document = unwrap(
    addDocumentParameter(document, {
      name: "depth",
      // The fixture's point: the parameter is authored in CENTIMETRES;
      // the recovered dimension carries the same quantity in millimetres.
      value: length(2, "cm"),
    }),
    "addDocumentParameter",
  ).document;
  const parameter = document.parameters.parameters[0];
  if (parameter === undefined) throw new Error("parameter missing");
  document = unwrap(
    addFeature(document, {
      id: createFeatureId("feat_base"),
      kind: "extrude",
      inputs: [{ kind: "parameter", id: parameter.id }],
      outputs: [],
    }),
    "addFeature",
  ).document;
  return document;
}

const RECOVERY_OPTIONS = {
  viewId: "view_front",
  originXMm: 30,
  originYMm: 30,
  viewWidthMm: 60,
  viewHeightMm: 40,
  scale: 0.5,
  stackStepMm: 10,
} as const;

describe("feature-parameter dimension recovery (Phase 54)", () => {
  it("a 20mm extrude carries a 20mm dim, unit-converted from 2cm", () => {
    const document = documentWithExtrudeDepth20();
    const dimensions = recoverFeatureDimensions(document, RECOVERY_OPTIONS);
    expect(dimensions).toHaveLength(1);
    const dimension = dimensions[0];
    expect(dimension).toBeDefined();
    if (dimension === undefined) return;
    expect(dimension.kind).toBe("linear");
    if (dimension.kind !== "linear") return;
    expect(dimension.valueMm).toBe(20);
    expect(dimension.origin).toMatchObject({
      source: "model",
      kind: "feature-parameter",
      featureId: "feat_base",
      parameterName: "depth",
    });
    // The drawn geometry rides the view scale: 20mm at 1:2 spans 10mm.
    expect(dimension.to.y - dimension.from.y).toBe(10);
  });

  it("recovers a fillet radius as a radial dimension with provenance", () => {
    let document = createDocument(createDocumentId("doc_drawing_fillet"));
    document = unwrap(
      addDocumentParameter(document, { name: "rim", value: length(4, "mm") }),
      "addDocumentParameter",
    ).document;
    const parameter = document.parameters.parameters[0];
    if (parameter === undefined) throw new Error("parameter missing");
    document = unwrap(
      addFeature(document, {
        id: createFeatureId("feat_edge_fillet"),
        kind: "fillet",
        inputs: [{ kind: "parameter", id: parameter.id }],
        outputs: [],
      }),
      "addFeature",
    ).document;
    const dimensions = recoverFeatureDimensions(document, RECOVERY_OPTIONS);
    expect(dimensions).toHaveLength(1);
    const dimension = dimensions[0];
    if (dimension === undefined) return;
    expect(dimension.kind).toBe("radial");
    if (dimension.kind !== "radial") return;
    expect(dimension.valueMm).toBe(4);
    expect(dimension.origin).toMatchObject({ source: "model" });
  });

  it("round-trips recovered dimensions through the annotation parser", () => {
    const document = documentWithExtrudeDepth20();
    const dimensions = recoverFeatureDimensions(document, RECOVERY_OPTIONS);
    for (const dimension of dimensions) {
      const parsed = parseDrawingDimension(
        serializeDrawingDimension(dimension),
      );
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) continue;
      expect(parsed.value).toEqual(dimension);
    }
  });

  it("declines features without a length parameter honestly", () => {
    let document = createDocument(createDocumentId("doc_drawing_decline"));
    document = unwrap(
      addDocumentParameter(document, {
        name: "tilt",
        value: angle(15, "deg"),
      }),
      "addDocumentParameter",
    ).document;
    const parameter = document.parameters.parameters[0];
    if (parameter === undefined) throw new Error("parameter missing");
    document = unwrap(
      addFeature(document, {
        id: createFeatureId("feat_base"),
        kind: "extrude",
        inputs: [{ kind: "parameter", id: parameter.id }],
        outputs: [],
      }),
      "addFeature",
    ).document;
    expect(recoverFeatureDimensions(document, RECOVERY_OPTIONS)).toHaveLength(
      0,
    );
  });
});

describe("sheet presentation determinism (Phase 54)", () => {
  const template = drawingSheetTemplateById("a4-landscape-1-1");
  if (template === undefined) throw new Error("template missing");

  it("identical inputs present identically", () => {
    const extrudeDocument = documentWithExtrudeDepth20();
    const dimensions = recoverFeatureDimensions(
      extrudeDocument,
      RECOVERY_OPTIONS,
    );
    const a = composeSheetPresentation(
      template.setup,
      template.titleBlock,
      [],
      dimensions,
      [],
    );
    const b = composeSheetPresentation(
      template.setup,
      template.titleBlock,
      [],
      dimensions,
      [],
    );
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("orders dimensions by id regardless of authoring order", () => {
    expect(compareDrawingId("drdim_a", "drdim_b")).toBeLessThan(0);
    expect(compareDrawingId("drdim_b", "drdim_a")).toBeGreaterThan(0);
    expect(compareDrawingId("drdim_a", "drdim_a")).toBe(0);
  });

  it("formats values, callouts, and templates deterministically", () => {
    expect(formatDimensionValue(20, "mm")).toBe("20");
    expect(formatDimensionValue(0.05, "mm")).toBe("0.05");
    expect(holeCalloutText(8, 6)).toBe("\u23008 \u2193 6");
    expect(holeCalloutText(8, null)).toBe("\u23008");
    expect(threadCalloutText("M8x1.25", null)).toBe("M8x1.25");
    expect(DRAWING_SHEET_TEMPLATES).toHaveLength(3);
    expect(drawingSheetTemplateById("missing")).toBeUndefined();
  });
});

describe("drawing SVG export preview (Phase 54)", () => {
  const template = drawingSheetTemplateById("a4-landscape-1-1");
  if (template === undefined) throw new Error("template missing");

  it("re-exports an unchanged sheet byte-identically", () => {
    const dimensions: readonly DrawingDimension[] = recoverFeatureDimensions(
      documentWithExtrudeDepth20(),
      RECOVERY_OPTIONS,
    );
    const primitives = composeSheetPresentation(
      template.setup,
      template.titleBlock,
      [],
      dimensions,
      [],
    );
    const a = serializeDrawingSheetSvg(297, 210, primitives);
    const b = serializeDrawingSheetSvg(297, 210, primitives);
    expect(a).toBe(b);
    expect(a.startsWith("<svg")).toBe(true);
    expect(a).toContain('viewBox="0 0 297 210"');
    // The recovered 20mm value text rides the dimension's presentation.
    expect(a).toContain(">20</text>");
  });

  it("counter-flips exported text so glyphs render upright", () => {
    const svg = serializeDrawingSheetSvg(100, 100, [
      {
        kind: "text",
        x: 10,
        y: 30.5,
        text: "20",
        anchor: "middle",
        sizeMm: 3.5,
      },
    ]);
    // The root group's y-flip mirrors glyph runs; the per-text
    // counter-flip (the same transform the canvas applies) restores them.
    expect(svg).toContain('y="30.5"');
    expect(svg).toContain('transform="translate(0 61) scale(1 -1)"');
  });

  it("exports oblique arrowheads in raw sheet coordinates", () => {
    const svg = serializeDrawingSheetSvg(100, 100, [
      { kind: "arrow", x: 10, y: 10, angleRad: Math.PI / 4 },
    ]);
    // Tip at (10, 10) pointing up-right at 45 degrees: the base corners
    // sit back along the arrow — pre-flipped corners would mirror it.
    expect(svg).toContain('points="10,10 8.6565,7.1009 7.1009,8.6565"');
  });

  it("exports arcs with raw sheet endpoints and y-flip-corrected sweep", () => {
    const svg = serializeDrawingSheetSvg(100, 100, [
      {
        kind: "arc",
        cx: 0,
        cy: 0,
        radius: 10,
        startRad: 0,
        endRad: Math.PI / 2,
      },
    ]);
    // A counter-clockwise quarter arc from (10, 0) to (0, 10): raw
    // endpoints with sweep flag 1 (pre-flipped endpoints mirrored the
    // arc about its center).
    expect(svg).toContain('d="M 10 0 A 10 10 0 0 1 0 10"');
  });

  it("formats numbers deterministically", () => {
    expect(formatSvgNumber(20)).toBe("20");
    expect(formatSvgNumber(0.5)).toBe("0.5");
    expect(formatSvgNumber(1 / 3)).toBe("0.3333");
  });
});
