/**
 * The Phase 55 drawing output fixtures: byte-determinism for all three
 * exporters (SVG, PDF, DXF), the DXF round-trip into itself, the section
 * geometry fixtures (cut-face area against the analytic box section — the
 * same quantity the Phase 46 kernel section measures; the kernel-side
 * agreement is pinned in cad-kernel-manifold's drawing-section fixture),
 * the fold-line/auxiliary bases, detail crops, and the deterministic BOM
 * numbering.
 */

import { describe, expect, it } from "vitest";
import type { ViewBasis } from "./index";

import {
  type DrawingDocument,
  type DrawingGeometryByView,
  auxiliaryViewBasis,
  createBodyId,
  createDrawingViewId,
  createOccurrenceId,
  createSheetId,
  detailCropGeometry,
  drawingSummary,
  DRAWING_ERROR_CODES,
  edgesOverlayProjectionForKind,
  hatchLoops,
  meshPlaneCrossSection,
  numberBomItems,
  parseDrawingDocument,
  parseDrawingDxf,
  polygonArea,
  projectedViewBasisForKind,
  serializeDrawingDocument,
  serializeDrawingDxf,
  serializeDrawingPdf,
  serializeDrawingSvg,
  serializeParsedDrawingDxf,
  viewBasis,
} from "./index";
import { boxMesh, FRONT_EYE_UP } from "./drawing-section.test-helpers";
import {
  brokenOutOverlayProjection,
  sectionOverlayProjection,
} from "./drawing-section";

const bodyId = createBodyId("body_drawing_plate");

/** Sign-of-zero-tolerant componentwise basis equality. */
function expectBasisClose(actual: ViewBasis, expected: ViewBasis): void {
  for (const key of ["right", "up", "look"] as const) {
    const a = actual[key];
    const e = expected[key];
    for (let i = 0; i < 3; i += 1) {
      const av = a[i];
      const ev = e[i];
      expect(av).toBeDefined();
      expect(ev).toBeDefined();
      if (av === undefined || ev === undefined) continue;
      expect(av).toBeCloseTo(ev, 12);
    }
  }
}

const frontView = {
  id: createDrawingViewId("dwv_front"),
  kind: "front" as const,
  bodyId,
  x: 148,
  y: 140,
  scale: null,
  alignedTo: null,
};

const baseSheet = {
  id: createSheetId("sht_main"),
  size: "A3" as const,
  orientation: "landscape" as const,
  scale: { numerator: 1, denominator: 1 },
  views: [frontView],
};

describe("Phase 55 drawing parse/serialize (additive fields)", () => {
  it("serializes a Phase 53 drawing without the new keys (byte-identical old form)", () => {
    const drawing: DrawingDocument = { sheets: [baseSheet] };
    const json = JSON.stringify(serializeDrawingDocument(drawing));
    expect(json).not.toContain('"label"');
    expect(json).not.toContain('"projection"');
    expect(json).not.toContain('"bomTables"');
    expect(json).not.toContain('"balloons"');
  });

  it("round-trips label, projection, BOM tables, and balloons", () => {
    const viewId = createDrawingViewId("dwv_section");
    const drawing: DrawingDocument = {
      sheets: [
        {
          ...baseSheet,
          views: [
            ...baseSheet.views,
            {
              id: viewId,
              kind: "top" as const,
              bodyId,
              x: 260,
              y: 140,
              scale: { numerator: 2, denominator: 1 },
              alignedTo: null,
              label: "SECTION A-A",
              projection: {
                method: "section" as const,
                planeOrigin: [0, 0, 5],
                planeNormal: [0, 0, 1],
                keepSide: 1 as const,
                hatchSpacingMm: 2,
                hatchAngleRad: Math.PI / 4,
              },
            },
          ],
          bomTables: [
            {
              x: 20,
              y: 20,
              title: "PARTS",
              rows: [
                {
                  item: 1,
                  occurrenceId: createOccurrenceId("occ_plate-1"),
                  label: "Plate",
                  bomFlag: null,
                  quantity: 2,
                },
              ],
            },
          ],
          balloons: [
            {
              occurrenceId: createOccurrenceId("occ_plate-1"),
              x: 100,
              y: 200,
              leaderX: 148,
              leaderY: 140,
              viewId: createDrawingViewId("dwv_front"),
            },
          ],
        },
      ],
    };
    const round = parseDrawingDocument(serializeDrawingDocument(drawing));
    expect(round.ok).toBe(true);
    if (!round.ok) return;
    expect(round.value).toEqual(drawing);
    // Determinism: the same document serializes to identical bytes.
    expect(JSON.stringify(serializeDrawingDocument(drawing))).toBe(
      JSON.stringify(serializeDrawingDocument(round.value)),
    );
  });

  it("rejects a projection naming an unknown parent", () => {
    const bad = {
      formatVersion: 1,
      sheets: [
        {
          ...baseSheet,
          views: [
            {
              id: "dwv_left",
              kind: "front",
              bodyId: bodyId,
              x: 10,
              y: 10,
              scale: null,
              alignedTo: null,
              projection: {
                method: "projected",
                parentViewId: "dwv_missing",
                direction: "left",
              },
            },
          ],
        },
      ],
    };
    const parsed = parseDrawingDocument(bad);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error.code).toBe(DRAWING_ERROR_CODES.projectionParentUnknown);
  });
});

describe("fold-line, auxiliary, and detail derivations", () => {
  it("folds front to left with the vertical registration kept", () => {
    const left = projectedViewBasisForKind("front", "left");
    const expected = viewBasis([-1, 0, 0], [0, 0, 1]);
    expectBasisClose(left, expected);
  });

  it("folds front to bottom keeping the horizontal registration", () => {
    const parent = viewBasis([0, -1, 0], [0, 0, 1]);
    const bottom = projectedViewBasisForKind("front", "bottom");
    // The horizontal registration: sheet-right equals the parent's.
    expect(bottom.right[0]).toBeCloseTo(parent.right[0], 12);
    expect(bottom.right[1]).toBeCloseTo(parent.right[1], 12);
    expect(bottom.right[2]).toBeCloseTo(parent.right[2], 12);
    expect(bottom.look[2]).toBeGreaterThan(0); // looks up from below
  });

  it("folds front to back mirroring the sheet axes", () => {
    const parent = viewBasis([0, -1, 0], [0, 0, 1]);
    const back = projectedViewBasisForKind("front", "back");
    expect(back.up[0]).toBeCloseTo(parent.up[0], 12);
    expect(back.up[1]).toBeCloseTo(parent.up[1], 12);
    expect(back.up[2]).toBeCloseTo(parent.up[2], 12);
    expect(back.right[0]).toBeCloseTo(-parent.right[0], 12);
  });

  it("derives an auxiliary basis from an inclined edge and declines degenerate edges", () => {
    const parent = viewBasis([0, -1, 0], [0, 0, 1]);
    const aux = auxiliaryViewBasis(parent, [0, 0, 0], [1, 0, 0]);
    expect(aux).not.toBeNull();
    if (aux === null) return;
    // The edge is the sheet-up axis: looking down the world Z with X up.
    expect(aux.up[0]).toBeCloseTo(1, 12);
    expect(aux.look[2]).toBeCloseTo(-1, 12);
    // An edge parallel to the parent's look has no in-plane projection.
    expect(auxiliaryViewBasis(parent, [0, 0, 0], [0, 1, 0])).toBeNull();
    expect(auxiliaryViewBasis(parent, [0, 0, 0], [0, 0, 0])).toBeNull();
  });

  it("crops a detail view to the circle and clips crossing segments", () => {
    const geometry = edgesOverlayProjectionForKind(boxMesh(), "front");
    // The front view of the cube is a square perimeter; a circle centred
    // on the bottom edge's midpoint crosses three edges.
    const cropped = detailCropGeometry(geometry, 5, 0, 4);
    expect(cropped.bounds).not.toBeNull();
    if (cropped.bounds === null) return;
    // Bounds shrink to the crop circle's reach (±4 around (5,0)).
    expect(cropped.bounds.minU).toBeGreaterThanOrEqual(1 - 1e-9);
    expect(cropped.bounds.maxU).toBeLessThanOrEqual(9 + 1e-9);
    expect(cropped.bounds.minV).toBeGreaterThanOrEqual(-1e-9);
    expect(cropped.bounds.maxV).toBeLessThanOrEqual(4 + 1e-9);
    // Every surviving point is inside the crop circle.
    for (const chain of cropped.visible) {
      for (const point of chain) {
        const du = point[0] - 5;
        const dv = point[1] - 0;
        expect(du * du + dv * dv).toBeLessThanOrEqual(16 + 1e-9);
      }
    }
    // Nothing survives a crop away from the geometry.
    const empty = detailCropGeometry(geometry, 50, 50, 3);
    expect(empty.bounds).toBeNull();
    expect(empty.visible).toHaveLength(0);
  });
});

describe("section geometry fixtures", () => {
  it("traces the box mid-section loop and its area matches the analytic cut", () => {
    const mesh = boxMesh();
    const cut = meshPlaneCrossSection(mesh, {
      origin: [0, 0, 5],
      normal: [0, 0, 1],
      keepSide: 1,
    });
    expect(cut.loops).toHaveLength(1);
    const loop = cut.loops[0];
    if (loop === undefined) return;
    expect(polygonArea(loop)).toBeCloseTo(100, 6);
  });

  it("measures the OBLIQUE cut's true area (the area-vector magnitude)", () => {
    // The plane x + y + z = 15 cuts the 10 mm cube in a regular hexagon of
    // side 5·sqrt(2): area (3·sqrt(3)/2)·(5·sqrt(2))² = 75·sqrt(3) ≈
    // 129.9038. A scalar sum of the projected cross products (the
    // pre-Phase-55-round-2 formula) returns A·|n̂x+n̂y+n̂z| = 225 — the
    // √3 oblique factor — so this pin fails against it.
    const mesh = boxMesh();
    const cut = meshPlaneCrossSection(mesh, {
      origin: [5, 5, 5],
      normal: [1, 1, 1],
      keepSide: 1,
    });
    expect(cut.loops).toHaveLength(1);
    const loop = cut.loops[0];
    if (loop === undefined) return;
    expect(polygonArea(loop)).toBeCloseTo(75 * Math.sqrt(3), 6);
  });

  it("hatches the cut face with deterministic strokes inside the section", () => {
    const mesh = boxMesh();
    const loops = meshPlaneCrossSection(mesh, {
      origin: [0, 0, 5],
      normal: [0, 0, 1],
      keepSide: 1,
    }).loops;
    const strokes = hatchLoops(loops, 2, Math.PI / 4);
    expect(strokes.length).toBeGreaterThan(0);
    for (const stroke of strokes) {
      const a = stroke[0];
      const b = stroke[1];
      if (a === undefined || b === undefined) continue;
      // All strokes live on the cut plane.
      expect(a[2]).toBeCloseTo(5, 9);
      expect(b[2]).toBeCloseTo(5, 9);
      // And inside the 10x10 cut square.
      for (const p of [a, b]) {
        expect(p[0]).toBeGreaterThanOrEqual(-1e-9);
        expect(p[0]).toBeLessThanOrEqual(10 + 1e-9);
        expect(p[1]).toBeGreaterThanOrEqual(-1e-9);
        expect(p[1]).toBeLessThanOrEqual(10 + 1e-9);
      }
    }
    expect(strokes).toEqual(hatchLoops(loops, 2, Math.PI / 4));
  });

  it("clips the section view's edges to the kept side and carries the hatch", () => {
    const geometry = sectionOverlayProjection(
      boxMesh(),
      { origin: [0, 0, 5], normal: [0, 0, 1], keepSide: 1 },
      FRONT_EYE_UP.eye,
      FRONT_EYE_UP.up,
    );
    expect(geometry.bounds).not.toBeNull();
    expect(geometry.hatch ?? []).not.toHaveLength(0);
    // Front view: v is world z; the kept side keeps z >= 5 only.
    for (const chain of geometry.visible) {
      for (const point of chain) {
        expect(point[1]).toBeGreaterThanOrEqual(5 - 1e-9);
      }
    }
    // The removed side's bottom edge is gone (no stroke at v ≈ 0).
    const minV = Math.min(
      ...geometry.visible.flatMap((chain) => chain.map((p) => p[1])),
    );
    expect(minV).toBeGreaterThanOrEqual(5 - 1e-9);
  });

  it("restricts broken-out hatch to the band and keeps full edges", () => {
    const geometry = brokenOutOverlayProjection(
      boxMesh(),
      { origin: [0, 0, 5], normal: [0, 0, 1], keepSide: 1 },
      0,
      2,
      FRONT_EYE_UP.eye,
      FRONT_EYE_UP.up,
    );
    expect(geometry.bounds).not.toBeNull();
    // Full projection edges survive (front view of the whole box: v 0..10).
    expect(geometry.bounds?.minV).toBeCloseTo(0, 9);
    expect(geometry.bounds?.maxV).toBeCloseTo(10, 9);
    for (const chain of geometry.hatch ?? []) {
      for (const point of chain) {
        expect(point[0]).toBeLessThanOrEqual(2 + 1e-9);
      }
    }
  });
});

describe("deterministic BOM numbering", () => {
  it("numbers first-appearance groups, skips phantoms, keeps flags", () => {
    const rows = numberBomItems([
      { id: createOccurrenceId("occ_a"), name: "Plate" },
      { id: createOccurrenceId("occ_b"), name: "Sub", bomFlag: "phantom" },
      { id: createOccurrenceId("occ_c"), name: "Bolt", bomFlag: "purchased" },
      { id: createOccurrenceId("occ_d"), name: "Plate" },
      { id: createOccurrenceId("occ_e"), name: "Nut", bomFlag: "purchased" },
    ]);
    expect(rows).toEqual([
      {
        item: 1,
        occurrenceId: createOccurrenceId("occ_a"),
        label: "Plate",
        bomFlag: null,
        quantity: 2,
      },
      {
        item: 2,
        occurrenceId: createOccurrenceId("occ_c"),
        label: "Bolt",
        bomFlag: "purchased",
        quantity: 1,
      },
      {
        item: 3,
        occurrenceId: createOccurrenceId("occ_e"),
        label: "Nut",
        bomFlag: "purchased",
        quantity: 1,
      },
    ]);
  });
});

describe("SVG output (Phase 55 elements, byte-deterministic)", () => {
  const drawing: DrawingDocument = { sheets: [baseSheet] };
  const geometry: DrawingGeometryByView = new Map([
    ["dwv_front", edgesOverlayProjectionForKind(boxMesh(), "front")],
  ]);

  it("is byte-deterministic", () => {
    expect(serializeDrawingSvg(drawing, geometry)).toBe(
      serializeDrawingSvg(drawing, geometry),
    );
  });

  it("pins sheet coordinates through the root flip (the balloon's absolute y)", () => {
    // The mirror-class pin: a balloon anchored at TOP-DOWN sheet
    // (100, 200) presents y-UP — cy = 297 − 200 = 97, never 200 (an
    // unflipped walk) and never 197 (a double flip). The frame rect's
    // y-up origin (10 from the sheet's bottom edge) pins the same
    // discipline on a stroked element.
    const svg = serializeDrawingSvg(drawing, geometry);
    expect(svg).toContain('viewBox="0 0 420 297"');
    expect(svg).toContain(
      '<rect class="dg-frame" x="10" y="10" width="400" height="277"',
    );
    expect(svg).toContain('<g transform="translate(0 297) scale(1 -1)">');
  });

  it("carries hatch strokes and labels in the stable SVG classes", () => {
    const sectioned: DrawingDocument = {
      sheets: [
        {
          ...baseSheet,
          views: [
            {
              ...frontView,
              id: createDrawingViewId("dwv_sec"),
              label: "SECTION A-A",
            },
          ],
        },
      ],
    };
    const sectionGeometry: DrawingGeometryByView = new Map([
      [
        "dwv_sec",
        sectionOverlayProjection(
          boxMesh(),
          { origin: [0, 0, 5], normal: [0, 0, 1], keepSide: 1 },
          FRONT_EYE_UP.eye,
          FRONT_EYE_UP.up,
        ),
      ],
    ]);
    const svg = serializeDrawingSvg(sectioned, sectionGeometry);
    expect(svg).toContain('class="dg-hatch"');
    expect(svg).toContain('class="dg-label"');
    expect(svg).toContain("SECTION A-A");
    expect(svg).toBe(serializeDrawingSvg(sectioned, sectionGeometry));
  });

  it("resolves balloon item numbers at the association site", () => {
    const populated: DrawingDocument = {
      sheets: [
        {
          ...baseSheet,
          bomTables: [
            {
              x: 20,
              y: 20,
              title: "PARTS",
              rows: [
                {
                  item: 1,
                  occurrenceId: createOccurrenceId("occ_plate-1"),
                  label: "Plate",
                  bomFlag: null,
                  quantity: 1,
                },
              ],
            },
          ],
          balloons: [
            {
              occurrenceId: createOccurrenceId("occ_plate-1"),
              x: 100,
              y: 200,
              leaderX: 148,
              leaderY: 140,
              viewId: null,
            },
            {
              occurrenceId: createOccurrenceId("occ_unknown"),
              x: 120,
              y: 210,
              leaderX: 150,
              leaderY: 145,
              viewId: null,
            },
          ],
        },
      ],
    };
    const svg = serializeDrawingSvg(populated, geometry);
    expect(svg).toContain('class="dg-balloon"');
    expect(svg).toContain('class="dg-bom"');
    expect(svg).toContain("Plate");
    // The association-site pin: the balloon GROUP whose data-occurrence-id
    // matches the BOM row carries the item number INSIDE that group; the
    // balloon with no matching row renders without a number.
    const balloonGroups = svg.match(
      /<g class="dg-balloon" data-occurrence-id="[^"]*"[\s\S]*?<\/g>/g,
    );
    expect(balloonGroups).toHaveLength(2);
    const numbered = balloonGroups?.find((group) =>
      group.includes('data-occurrence-id="occ_plate-1"'),
    );
    expect(numbered).toContain('class="dg-balloon-item"');
    expect(numbered).toContain(">1</text>");
    // Its circle sits at the y-up position of the top-down anchor.
    expect(numbered).toContain('cx="100" cy="97"');
    const unnumbered = balloonGroups?.find((group) =>
      group.includes('data-occurrence-id="occ_unknown"'),
    );
    expect(unnumbered).not.toContain("dg-balloon-item");
    expect(drawingSummary(populated)).toBe(
      "Drawing: A3 landscape sheet, 1 view: front, BOM 1 table, 2 balloons",
    );
  });
});

describe("PDF output (deterministic vector builder)", () => {
  it("is byte-deterministic and structurally valid", () => {
    const drawing: DrawingDocument = { sheets: [baseSheet] };
    const geometry: DrawingGeometryByView = new Map([
      ["dwv_front", edgesOverlayProjectionForKind(boxMesh(), "front")],
    ]);
    const pdf = serializeDrawingPdf(drawing, geometry);
    expect(pdf).toBe(serializeDrawingPdf(drawing, geometry));
    expect(pdf.startsWith("%PDF-1.4\n")).toBe(true);
    expect(pdf.endsWith("%%EOF\n")).toBe(true);
    expect(pdf).toContain("/MediaBox [0 0");
    // A3 landscape in points: 420mm x 297mm at 72/25.4.
    expect(pdf).toContain(
      `[0 0 ${((420 * 72) / 25.4).toFixed(4)} ${((297 * 72) / 25.4).toFixed(4)}]`,
    );
    // No clocks anywhere in the output (the PDF date convention).
    expect(pdf).not.toContain("(D:");
  });

  it("lands text upright at its absolute y-up position (no text-matrix mirroring)", () => {
    // The mirror-class pin: the view label's text operator must place the
    // run at the y-UP conversion of its sheet position — baseline at
    // top-down 150 on a 297 mm sheet → y-up 147 → 416.6929 pt — and the
    // stream must carry no text matrix at all (a mirrored implementation
    // reaches for a negative-scaled Tm, or pre-flips the Td y).
    const sectioned: DrawingDocument = {
      sheets: [
        {
          ...baseSheet,
          views: [
            {
              ...frontView,
              id: createDrawingViewId("dwv_sec"),
              label: "SECTION A-A",
            },
          ],
        },
      ],
    };
    const pdf = serializeDrawingPdf(
      sectioned,
      new Map([["dwv_sec", edgesOverlayProjectionForKind(boxMesh(), "front")]]),
    );
    const streamMatch = pdf.match(/stream\n([\s\S]*?)\nendstream/);
    expect(streamMatch).not.toBeNull();
    const stream = streamMatch?.[1] ?? "";
    expect(stream).not.toContain(" Tm");
    const textOps = stream.match(/BT [\s\S]*? ET/g) ?? [];
    const labelOp = textOps.find((op) => op.includes("(SECTION A-A)"));
    expect(labelOp).toBeDefined();
    // `BT /F1 SIZE Tf X Y Td (TEXT) Tj ET` — the Td's Y operand.
    const tdY = labelOp?.match(/Tf ([\d.-]+) ([\d.-]+) Td/)?.[2];
    expect(tdY).toBe(n2(147 * (72 / 25.4)));
  });
});

/** The PDF writer's own number format (≤4 decimals, trimmed). */
function n2(value: number): string {
  const fixed = value.toFixed(4);
  const trimmed = fixed.replace(/\.?0+$/, "");
  return trimmed === "-0" ? "0" : trimmed;
}

describe("DXF output (deterministic writer + self round-trip)", () => {
  const drawing: DrawingDocument = { sheets: [baseSheet] };
  const geometry: DrawingGeometryByView = new Map([
    ["dwv_front", edgesOverlayProjectionForKind(boxMesh(), "front")],
  ]);

  it("is byte-deterministic and round-trips into itself", () => {
    const dxf = serializeDrawingDxf(drawing, geometry);
    expect(dxf).toBe(serializeDrawingDxf(drawing, geometry));
    const parsed = parseDrawingDxf(dxf);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    // The written subset reads back and re-emits identical bytes.
    const again = serializeParsedDrawingDxf(parsed.value);
    expect(again).toBe(dxf);
    // The entity census: lines for the frame + the box's front edges.
    expect(
      parsed.value.entities.filter((e) => e.kind === "line").length,
    ).toBeGreaterThan(4);
    expect(parsed.value.layers).toEqual([
      "FRAMES",
      "VIEWS",
      "DHIDDEN",
      "HATCH",
      "TEXT",
      "BOM",
    ]);
  });

  it("writes the frame at ABSOLUTE y-up model coordinates", () => {
    // The mirror-class pin: the sheet's top-left frame corner (top-down
    // (10, 10)) must land at DXF y = 297 − 10 = 287 — the top FRAME edge
    // reads y = 287, x spanning 10..410. A writer that flips twice (or
    // not at all) puts that edge at y = 10.
    const dxf = serializeDrawingDxf(drawing, geometry);
    const parsed = parseDrawingDxf(dxf);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const frameEdges = parsed.value.entities.filter(
      (e) => e.kind === "line" && e.layer === "FRAMES",
    );
    const topEdge = frameEdges.find(
      (e) => e.kind === "line" && e.y1 === 287 && e.y2 === 287,
    );
    expect(topEdge).toBeDefined();
    if (topEdge?.kind !== "line") return;
    expect(Math.min(topEdge.x1, topEdge.x2)).toBe(10);
    expect(Math.max(topEdge.x1, topEdge.x2)).toBe(410);
    // And no FRAMES edge sits at y = 10 except the BOTTOM edge (whose x
    // span is identical — the pin above distinguishes them by y).
    const bottomEdges = frameEdges.filter(
      (e) => e.kind === "line" && e.y1 === 10 && e.y2 === 10,
    );
    expect(bottomEdges).toHaveLength(1);
  });

  it("round-trips hatch, labels, balloons, and BOM tables through DXF", () => {
    const populated: DrawingDocument = {
      sheets: [
        {
          ...baseSheet,
          views: [{ ...frontView, label: "SECTION A-A" }],
          bomTables: [
            {
              x: 20,
              y: 20,
              title: "PARTS",
              rows: [
                {
                  item: 1,
                  occurrenceId: createOccurrenceId("occ_plate-1"),
                  label: "Plate",
                  bomFlag: null,
                  quantity: 1,
                },
              ],
            },
          ],
          balloons: [
            {
              occurrenceId: createOccurrenceId("occ_plate-1"),
              x: 100,
              y: 200,
              leaderX: 148,
              leaderY: 140,
              viewId: null,
            },
          ],
        },
      ],
    };
    const sectionGeometry: DrawingGeometryByView = new Map([
      [
        "dwv_front",
        sectionOverlayProjection(
          boxMesh(),
          { origin: [0, 0, 5], normal: [0, 0, 1], keepSide: 1 },
          FRONT_EYE_UP.eye,
          FRONT_EYE_UP.up,
        ),
      ],
    ]);
    const dxf = serializeDrawingDxf(populated, sectionGeometry);
    const parsed = parseDrawingDxf(dxf);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(serializeParsedDrawingDxf(parsed.value)).toBe(dxf);
    const circles = parsed.value.entities.filter((e) => e.kind === "circle");
    expect(circles).toHaveLength(1);
    expect(
      parsed.value.entities.some(
        (e) => e.kind === "text" && e.text === "SECTION A-A",
      ),
    ).toBe(true);
    // The balloon's number lands on the BOM layer at the y-up anchor
    // (association + absolute-coordinate pin in one).
    const balloonItem = parsed.value.entities.find(
      (e) => e.kind === "text" && e.text === "1" && e.layer === "BOM",
    );
    expect(balloonItem).toBeDefined();
    if (balloonItem?.kind !== "text") return;
    // Baseline sits 1.2 mm below the balloon centre in top-down sheet
    // millimetres → y-up 297 − 201.2.
    expect(balloonItem.y).toBeCloseTo(297 - 201.2, 6);
  });

  it("rejects entities outside the pinned subset", () => {
    const dxf = serializeDrawingDxf(drawing, geometry);
    const sabotaged = dxf.replace("LINE", "SPLINE");
    const parsed = parseDrawingDxf(sabotaged);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error.code).toBe("drawing-dxf/entity-malformed");
  });
});
