/**
 * The drawing output layer (Phase 55, unified in Phase 55 round 2): ONE
 * deterministic presentation walk from a {@link DrawingDocument} to the
 * shared sheet picture — {@link DrawingSheetPicture}s of
 * {@link DrawingPrimitive}s in sheet millimetres, y-UP, the exact
 * vocabulary and flip discipline of the Phase 54 sheet presentation —
 * and the three byte-stable serializers (SVG, PDF) that consume it.
 *
 * ## One walk, three media
 *
 * The walk ( {@link presentDrawingSheet} ) resolves every view's projected
 * geometry, balloons, and BOM tables into primitives exactly once; the
 * SVG serializer reuses the sheet exporter's per-primitive builders, and
 * the PDF writer maps the same primitives onto content-stream operators.
 * Layout decisions (view transforms, label baselines, balloon circles,
 * BOM cell grids) live HERE and nowhere else — the Phase 53/55 shape
 * where each exporter re-walked the document with its own transforms is
 * gone, and with it the possibility of the media drifting apart.
 *
 * ## Coordinates
 *
 * Document records are TOP-DOWN sheet millimetres (the authoring
 * convention); the presentation emits y-UP (the rendering convention the
 * flip discipline renders). The single conversion `height − y` happens at
 * presentation time; the SVG root flip group, the PDF's y-up user space,
 * and the DXF writer's y-up model space all consume the same primitives
 * unconverted.
 *
 * ## Determinism
 *
 * Fixed attribute/object order, no clocks, no locale, no randomness —
 * the same drawing and the same geometry always produce identical bytes
 * (the byte-determinism law §1.2).
 *
 * ## Honest rendering rules
 *
 * A view with no geometry renders its placement only — never a fabricated
 * picture. A balloon whose occurrence has no BOM row renders without a
 * number. Hatching appears only where a projection derived a cut face.
 */

import {
  type DrawingBalloon,
  type DrawingBomTable,
  type DrawingDocument,
  type DrawingSheet,
  type DrawingViewGeometry,
  sheetDimensions,
  scaleLength,
  viewFrameFromGeometry,
} from "./drawing";
import {
  type DrawingPictureGroup,
  type DrawingPrimitive,
  type DrawingSheetPicture,
} from "./drawing-presentation";
import { drawingGroupMarkup, formatSvgNumber } from "./drawing-svg";

/** The projected geometry per view id for a whole drawing. */
export type DrawingGeometryByView = ReadonlyMap<string, DrawingViewGeometry>;

/**
 * The pinned stroke/label table (sheet millimetres) — one source for the
 * presentation and every medium that consumes it.
 */
export const DRAWING_PICTURE_STYLE = {
  /** Frame border width. */
  frameWidthMm: 0.5,
  /** Visible edge width. */
  visibleWidthMm: 0.35,
  /** Hidden edge width (dashed). */
  hiddenWidthMm: 0.18,
  /** Cut-face hatch width. */
  hatchWidthMm: 0.15,
  /** Balloon leader width. */
  balloonLeaderWidthMm: 0.2,
  /** Balloon circle width. */
  balloonCircleWidthMm: 0.25,
  /** BOM table rule width. */
  bomWidthMm: 0.2,
  /** The dash pattern for dashed strokes (SVG dash array / PDF dash). */
  dashMm: [2, 1.5] as const,
  /** View label text height. */
  labelHeightMm: 3.5,
  /** Balloon item number text height. */
  balloonItemHeightMm: 2.8,
  /** Balloon circle radius. */
  balloonRadiusMm: 4,
  /** The frame border inset from the sheet edge. */
  frameInsetMm: 10,
} as const;

/** Formats a number deterministically: ≤4 decimals, trimmed, no exponent. */
const n = (value: number): string => {
  const fixed = value.toFixed(4);
  const trimmed = fixed.replace(/\.?0+$/, "");
  return trimmed === "-0" ? "0" : trimmed;
};

const MM_TO_PT = 72 / 25.4;

// ---------------------------------------------------------------------------
// The ONE presentation walk: document records → sheet pictures
// ---------------------------------------------------------------------------

/** Options for {@link presentDrawingSheet}. */
export interface PresentDrawingSheetOptions {
  /**
   * Emit the sheet-frame border group (default `true`). The unified
   * workbench composes Phase 54 furniture — which already draws the
   * frame — over the document picture and turns this off, so the frame
   * never draws twice.
   */
  readonly includeFrame?: boolean;
}

/** The rect primitive variant (the BOM/frame builder's return type). */
type DrawingRect = Extract<DrawingPrimitive, { readonly kind: "rect" }>;

/** Balloon/BOM/label group classes — the presentation↔medium contract. */
const GROUP = {
  frame: "dg-frame",
  view: "dg-view",
  visible: "dg-visible",
  hidden: "dg-hidden",
  hatch: "dg-hatch",
  label: "dg-label",
  balloon: "dg-balloon",
  balloonCircle: "dg-balloon-circle",
  balloonItem: "dg-balloon-item",
  bom: "dg-bom",
} as const;

/**
 * Presents one sheet — frame, views (visible/hidden/hatch strokes,
 * label), balloons (leader, circle, item number resolved from the
 * sheet's first BOM table containing the occurrence), BOM tables — as
 * y-UP sheet-millimetre primitive groups. This is the single layout walk
 * every exporter consumes.
 */
export function presentDrawingSheet(
  sheet: DrawingSheet,
  geometry: DrawingGeometryByView,
  options: PresentDrawingSheetOptions = {},
): DrawingSheetPicture {
  const { width, height } = sheetDimensions(sheet);
  // Document records are top-down; presentation is y-up. One conversion.
  const Y = (y: number): number => height - y;
  /** A top-down rect [y, y+h] as a y-up rect primitive. */
  const rectYup = (
    x: number,
    y: number,
    w: number,
    h: number,
    extra?: { readonly dashed?: boolean; readonly widthMm?: number },
  ): DrawingRect => ({
    kind: "rect",
    x,
    y: height - y - h,
    width: w,
    height: h,
    ...extra,
  });
  const groups: DrawingPictureGroup[] = [];
  if (options.includeFrame !== false) {
    groups.push({
      class: "",
      primitives: [
        {
          ...rectYup(
            DRAWING_PICTURE_STYLE.frameInsetMm,
            DRAWING_PICTURE_STYLE.frameInsetMm,
            width - DRAWING_PICTURE_STYLE.frameInsetMm * 2,
            height - DRAWING_PICTURE_STYLE.frameInsetMm * 2,
            { widthMm: DRAWING_PICTURE_STYLE.frameWidthMm },
          ),
          class: GROUP.frame,
        },
      ],
    });
  }
  for (const view of sheet.views) {
    const geo = geometry.get(view.id) ?? null;
    const children: DrawingPictureGroup[] = [];
    let label: DrawingPrimitive | null = null;
    if (geo !== null && geo.bounds !== null) {
      const scale = view.scale ?? sheet.scale;
      const centreU = (geo.bounds.minU + geo.bounds.maxU) / 2;
      const centreV = (geo.bounds.minV + geo.bounds.maxV) / 2;
      const U = (u: number): number => view.x + scaleLength(u - centreU, scale);
      const V = (v: number): number =>
        Y(view.y) + scaleLength(v - centreV, scale);
      const strokeGroup = (
        chains: readonly (readonly (readonly [number, number])[])[],
        className: string,
        widthMm: number,
        dashed: boolean,
      ): DrawingPictureGroup => ({
        class: className,
        primitives: chainsToLines(chains, U, V, widthMm, dashed),
      });
      children.push(
        strokeGroup(
          geo.visible,
          GROUP.visible,
          DRAWING_PICTURE_STYLE.visibleWidthMm,
          false,
        ),
        strokeGroup(
          geo.hidden,
          GROUP.hidden,
          DRAWING_PICTURE_STYLE.hiddenWidthMm,
          true,
        ),
      );
      const hatch = geo.hatch ?? [];
      if (hatch.length > 0) {
        children.push(
          strokeGroup(
            hatch,
            GROUP.hatch,
            DRAWING_PICTURE_STYLE.hatchWidthMm,
            false,
          ),
        );
      }
      let labelBaseline = view.y + 8;
      const frame = viewFrameFromGeometry(view, sheet, geo.bounds);
      if (frame !== null) labelBaseline = frame.y + frame.height / 2 + 5;
      if (view.label !== undefined) {
        label = {
          kind: "text",
          x: view.x,
          y: Y(labelBaseline),
          text: view.label,
          anchor: "middle",
          sizeMm: DRAWING_PICTURE_STYLE.labelHeightMm,
          class: GROUP.label,
        };
      }
    }
    groups.push({
      class: GROUP.view,
      data: {
        "view-id": view.id,
        kind: view.kind,
        x: n(view.x),
        y: n(view.y),
      },
      children,
      primitives: label === null ? [] : [label],
    });
  }
  for (const balloon of sheet.balloons ?? []) {
    const item = balloonItem(sheet, balloon);
    const primitives: DrawingPrimitive[] = [
      {
        kind: "line",
        x1: balloon.x,
        y1: Y(balloon.y),
        x2: balloon.leaderX,
        y2: Y(balloon.leaderY),
        widthMm: DRAWING_PICTURE_STYLE.balloonLeaderWidthMm,
      },
      {
        kind: "circle",
        cx: balloon.x,
        cy: Y(balloon.y),
        radius: DRAWING_PICTURE_STYLE.balloonRadiusMm,
        widthMm: DRAWING_PICTURE_STYLE.balloonCircleWidthMm,
        class: GROUP.balloonCircle,
      },
    ];
    if (item !== null) {
      primitives.push({
        kind: "text",
        x: balloon.x,
        y: Y(balloon.y + 1.2),
        text: String(item),
        anchor: "middle",
        sizeMm: DRAWING_PICTURE_STYLE.balloonItemHeightMm,
        class: GROUP.balloonItem,
      });
    }
    groups.push({
      class: GROUP.balloon,
      data: {
        "occurrence-id": balloon.occurrenceId,
        x: n(balloon.x),
        y: n(balloon.y),
      },
      primitives,
    });
  }
  for (const table of sheet.bomTables ?? []) {
    groups.push({
      class: GROUP.bom,
      data: { x: n(table.x), y: n(table.y) },
      primitives: bomPrimitives(table, rectYup, Y),
    });
  }
  return { widthMm: width, heightMm: height, groups };
}

/** Chains (view-plane model mm) → y-up sheet line segments. */
function chainsToLines(
  chains: readonly (readonly (readonly [number, number])[])[],
  U: (u: number) => number,
  V: (v: number) => number,
  widthMm: number,
  dashed: boolean,
): DrawingPrimitive[] {
  const lines: DrawingPrimitive[] = [];
  for (const chain of chains) {
    for (let i = 0; i + 1 < chain.length; i += 1) {
      const a = chain[i];
      const b = chain[i + 1];
      if (a === undefined || b === undefined) continue;
      lines.push({
        kind: "line",
        x1: U(a[0]),
        y1: V(a[1]),
        x2: U(b[0]),
        y2: V(b[1]),
        widthMm,
        ...(dashed ? { dashed } : {}),
      });
    }
  }
  return lines;
}

/**
 * Presents a whole drawing: one picture per sheet, in document order.
 */
export function presentDrawingDocument(
  drawing: DrawingDocument,
  geometry: DrawingGeometryByView,
): readonly DrawingSheetPicture[] {
  return drawing.sheets.map((sheet) => presentDrawingSheet(sheet, geometry));
}

/** BOM cell layout (sheet millimetres): column widths and row height. */
export const BOM_COLUMN_WIDTHS = {
  item: 10,
  quantity: 12,
  description: 42,
} as const;
export const BOM_ROW_HEIGHT = 6;

/** The BOM table's primitives (y-up), from the ONE cell layout. */
function bomPrimitives(
  table: DrawingBomTable,
  rectYup: (
    x: number,
    y: number,
    w: number,
    h: number,
    extra?: { readonly widthMm?: number },
  ) => DrawingRect,
  Y: (y: number) => number,
): DrawingPrimitive[] {
  const { item, quantity, description } = BOM_COLUMN_WIDTHS;
  const totalWidth = item + quantity + description;
  const rows = table.rows.length + 1 + (table.title === null ? 0 : 1);
  const totalHeight = rows * BOM_ROW_HEIGHT;
  const width = { widthMm: DRAWING_PICTURE_STYLE.bomWidthMm } as const;
  const primitives: DrawingPrimitive[] = [
    rectYup(table.x, table.y, totalWidth, totalHeight, width),
  ];
  const rule = (y: number): void => {
    primitives.push({
      kind: "line",
      x1: table.x,
      y1: Y(y),
      x2: table.x + totalWidth,
      y2: Y(y),
      widthMm: DRAWING_PICTURE_STYLE.bomWidthMm,
    });
  };
  const cell = (
    text: string,
    x: number,
    y: number,
    anchor: "start" | "middle",
  ): void => {
    primitives.push({
      kind: "text",
      x,
      y: Y(y),
      text,
      anchor,
      sizeMm: 2.5,
    });
  };
  let y = table.y;
  if (table.title !== null) {
    cell(
      table.title,
      table.x + totalWidth / 2,
      y + BOM_ROW_HEIGHT - 2,
      "middle",
    );
    y += BOM_ROW_HEIGHT;
    rule(y);
  }
  cell("ITEM", table.x + item / 2, y + BOM_ROW_HEIGHT - 2, "middle");
  cell("QTY", table.x + item + quantity / 2, y + BOM_ROW_HEIGHT - 2, "middle");
  cell(
    "DESCRIPTION",
    table.x + item + quantity + 2,
    y + BOM_ROW_HEIGHT - 2,
    "start",
  );
  y += BOM_ROW_HEIGHT;
  rule(y);
  for (const row of table.rows) {
    const centreY = y + BOM_ROW_HEIGHT - 2;
    cell(String(row.item), table.x + item / 2, centreY, "middle");
    cell(
      String(row.quantity),
      table.x + item + quantity / 2,
      centreY,
      "middle",
    );
    cell(bomRowText(row), table.x + item + quantity + 2, centreY, "start");
    y += BOM_ROW_HEIGHT;
    if (y < table.y + totalHeight) rule(y);
  }
  // Column separators.
  primitives.push({
    kind: "line",
    x1: table.x + item,
    y1: Y(table.y),
    x2: table.x + item,
    y2: Y(table.y + totalHeight),
    widthMm: DRAWING_PICTURE_STYLE.bomWidthMm,
  });
  primitives.push({
    kind: "line",
    x1: table.x + item + quantity,
    y1: Y(table.y),
    x2: table.x + item + quantity,
    y2: Y(table.y + totalHeight),
    widthMm: DRAWING_PICTURE_STYLE.bomWidthMm,
  });
  return primitives;
}

function bomRowText(row: DrawingBomTable["rows"][number]): string {
  const flag = row.bomFlag === null ? "" : ` (${row.bomFlag})`;
  return `${row.label}${flag}`;
}

/** The item number a balloon renders, from the sheet's BOM tables. */
function balloonItem(
  sheet: DrawingSheet,
  balloon: DrawingBalloon,
): number | null {
  for (const table of sheet.bomTables ?? []) {
    for (const row of table.rows) {
      if (row.occurrenceId === balloon.occurrenceId) return row.item;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Summary (the programmatic a11y text every output carries)
// ---------------------------------------------------------------------------

/**
 * The programmatic summary of a drawing (the SVG `aria-label`/`title` and
 * the PDF document outline text): sheet size/orientation, the ordered view
 * list, and the Phase 55 callout counts.
 */
export function drawingSummary(drawing: DrawingDocument): string {
  if (drawing.sheets.length === 0) {
    return "Drawing: no sheets";
  }
  const sheetParts = drawing.sheets.map((sheet) => {
    const views =
      sheet.views.length === 0
        ? "no views"
        : `${sheet.views.length} view${sheet.views.length === 1 ? "" : "s"}: ${sheet.views
            .map((view) => view.kind)
            .join(", ")}`;
    let summary = `${sheet.size} ${sheet.orientation} sheet, ${views}`;
    const tables = sheet.bomTables?.length ?? 0;
    if (tables > 0) {
      summary += `, BOM ${String(tables)} table${tables === 1 ? "" : "s"}`;
    }
    const balloons = sheet.balloons?.length ?? 0;
    if (balloons > 0) {
      summary += `, ${String(balloons)} balloon${balloons === 1 ? "" : "s"}`;
    }
    return summary;
  });
  return `Drawing: ${sheetParts.join("; ")}`;
}

// ---------------------------------------------------------------------------
// SVG
// ---------------------------------------------------------------------------

function escapeText(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/**
 * Serializes a drawing (plus its views' projected geometry) to the
 * canonical byte-stable SVG string: per sheet, the presentation's picture
 * inside the root y-flip group. Geometry for a view that has none yet
 * renders the view frame only — an honest empty state, never a fabricated
 * picture.
 */
export function serializeDrawingSvg(
  drawing: DrawingDocument,
  geometry: DrawingGeometryByView,
): string {
  const parts: string[] = [];
  for (const sheet of drawing.sheets) {
    const picture = presentDrawingSheet(sheet, geometry);
    parts.push(
      `<g class="dg-sheet" data-sheet-id="${sheet.id}" data-size="${sheet.size}" data-orientation="${sheet.orientation}">`,
    );
    parts.push(
      `<g transform="translate(0 ${formatSvgNumber(picture.heightMm)}) scale(1 -1)">`,
    );
    parts.push(...drawingGroupMarkup(picture.groups));
    parts.push(`</g>`);
    parts.push(`</g>`);
  }
  const summary = drawingSummary(drawing);
  const first = drawing.sheets[0];
  const box = first === undefined ? "0 0 210 297" : viewBoxFor(first);
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${box}" role="img" aria-label="${escapeText(summary)}">`,
    `<title>${escapeText(summary)}</title>`,
    ...parts,
    `</svg>`,
    ``,
  ].join("\n");
}

function viewBoxFor(sheet: {
  readonly size: Parameters<typeof sheetDimensions>[0]["size"];
  readonly orientation: Parameters<typeof sheetDimensions>[0]["orientation"];
}): string {
  const { width, height } = sheetDimensions(sheet);
  return `0 0 ${n(width)} ${n(height)}`;
}

// ---------------------------------------------------------------------------
// PDF (vector, deterministic builder)
// ---------------------------------------------------------------------------

/**
 * Serializes a drawing to a deterministic PDF 1.4 document (uncompressed
 * content streams, base-14 Helvetica, no Info dictionary — no clocks):
 * one page per sheet at the sheet's exact ISO size. Vector only, from the
 * SAME presentation pictures the SVG carries: lines for edges/hatch/
 * leaders, circles approximated by the canvas-free 16-segment polygon
 * (deterministic), rects as four strokes, text via `/F1`. PDF user space
 * grows upward — the y-up presentation maps 1:1, no flip.
 */
export function serializeDrawingPdf(
  drawing: DrawingDocument,
  geometry: DrawingGeometryByView,
): string {
  const pages = drawing.sheets.map((sheet) =>
    pictureToPdfOps(presentDrawingSheet(sheet, geometry)),
  );
  const pageWidths = drawing.sheets.map(
    (sheet) => sheetDimensions(sheet).width * MM_TO_PT,
  );
  const pageHeights = drawing.sheets.map(
    (sheet) => sheetDimensions(sheet).height * MM_TO_PT,
  );
  // Object numbering: 1 catalog, 2 pages, 3 font, then page/content pairs.
  const pageCount = pages.length;
  const objects: string[] = [];
  const kids = Array.from(
    { length: pageCount },
    (_, i) => `${String(4 + i * 2)} 0 R`,
  ).join(" ");
  objects[1] = `<< /Type /Catalog /Pages 2 0 R >>`;
  objects[2] = `<< /Type /Pages /Kids [${kids}] /Count ${String(pageCount)} >>`;
  objects[3] = `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>`;
  for (let i = 0; i < pageCount; i += 1) {
    const pageObj = 4 + i * 2;
    const contentObj = pageObj + 1;
    objects[pageObj] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${n(pageWidths[i] ?? 0)} ${n(pageHeights[i] ?? 0)}] ` +
      `/Resources << /Font << /F1 3 0 R >> >> /Contents ${String(contentObj)} 0 R >>`;
    const stream = pages[i] ?? "";
    objects[contentObj] =
      `<< /Length ${String(stream.length)} >>\nstream\n${stream}\nendstream`;
  }
  return assemblePdf(objects);
}

/** Concatenates numbered objects with a computed xref (byte-deterministic). */
function assemblePdf(objects: readonly string[]): string {
  let body = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (let i = 1; i < objects.length; i += 1) {
    const obj = objects[i];
    if (obj === undefined) continue;
    offsets[i] = body.length;
    body += `${String(i)} 0 obj\n${obj}\nendobj\n`;
  }
  const count = objects.length; // highest object number + 1
  let xref = `xref\n0 ${String(count)}\n0000000000 65535 f \n`;
  for (let i = 1; i < count; i += 1) {
    const offset = offsets[i];
    xref +=
      offset === undefined
        ? "0000000000 65535 f \n"
        : `${String(offset).padStart(10, "0")} 00000 n \n`;
  }
  return `${body}${xref}trailer\n<< /Size ${String(count)} /Root 1 0 R >>\nstartxref\n${String(body.length)}\n%%EOF\n`;
}

/** One picture's content stream (PDF y-up points — no flip needed). */
function pictureToPdfOps(picture: DrawingSheetPicture): string {
  const pt = (v: number): number => v * MM_TO_PT;
  const X = (x: number): string => n(pt(x));
  const Y = (y: number): string => n(pt(y));
  const ops: string[] = [];
  const stroke = (
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    widthMm: number,
    dashed: boolean,
  ): void => {
    ops.push(
      `${X(x1)} ${Y(y1)} m ${X(x2)} ${Y(y2)} l ${n(pt(widthMm))} w${dashed ? ` [${DRAWING_PICTURE_STYLE.dashMm.map((d) => n(pt(d))).join(" ")}] 0 d` : ""} S`,
    );
  };
  const walk = (groups: readonly DrawingPictureGroup[]): void => {
    for (const group of groups) {
      walk(group.children ?? []);
      for (const primitive of group.primitives) {
        switch (primitive.kind) {
          case "line":
            stroke(
              primitive.x1,
              primitive.y1,
              primitive.x2,
              primitive.y2,
              primitive.widthMm ?? DRAWING_PICTURE_STYLE.visibleWidthMm,
              primitive.dashed ?? false,
            );
            break;
          case "rect": {
            // A rect strokes as its four sides (bottom, right, top, left
            // in y-up space), the same picture the SVG draws.
            const { x, y, width, height } = primitive;
            const w = primitive.widthMm ?? DRAWING_PICTURE_STYLE.frameWidthMm;
            const d = primitive.dashed ?? false;
            stroke(x, y, x + width, y, w, d);
            stroke(x + width, y, x + width, y + height, w, d);
            stroke(x + width, y + height, x, y + height, w, d);
            stroke(x, y + height, x, y, w, d);
            break;
          }
          case "circle": {
            // Deterministic 16-gon at the primitive's radius.
            const segments = 16;
            for (let i = 0; i < segments; i += 1) {
              const a0 = (2 * Math.PI * i) / segments;
              const a1 = (2 * Math.PI * (i + 1)) / segments;
              stroke(
                primitive.cx + primitive.radius * Math.cos(a0),
                primitive.cy + primitive.radius * Math.sin(a0),
                primitive.cx + primitive.radius * Math.cos(a1),
                primitive.cy + primitive.radius * Math.sin(a1),
                primitive.widthMm ?? DRAWING_PICTURE_STYLE.balloonCircleWidthMm,
                false,
              );
            }
            break;
          }
          case "arc": {
            // Deterministic 16-segment sweep from startRad to endRad.
            const sweep = primitive.endRad - primitive.startRad;
            const segments = 16;
            for (let i = 0; i < segments; i += 1) {
              const a0 = primitive.startRad + (sweep * i) / segments;
              const a1 = primitive.startRad + (sweep * (i + 1)) / segments;
              stroke(
                primitive.cx + primitive.radius * Math.cos(a0),
                primitive.cy + primitive.radius * Math.sin(a0),
                primitive.cx + primitive.radius * Math.cos(a1),
                primitive.cy + primitive.radius * Math.sin(a1),
                DRAWING_PICTURE_STYLE.visibleWidthMm,
                false,
              );
            }
            break;
          }
          case "arrow": {
            // The shared arrowhead triangle, filled: three sides then the
            // fill operator (the SVG polygon's exact geometry).
            const cos = Math.cos(primitive.angleRad);
            const sin = Math.sin(primitive.angleRad);
            const len = 3;
            const half = 1.1;
            const bx = primitive.x - cos * len;
            const by = primitive.y - sin * len;
            const p1: readonly [number, number] = [primitive.x, primitive.y];
            const p2: readonly [number, number] = [
              bx - sin * half,
              by + cos * half,
            ];
            const p3: readonly [number, number] = [
              bx + sin * half,
              by - cos * half,
            ];
            ops.push(
              `${X(p1[0])} ${Y(p1[1])} m ${X(p2[0])} ${Y(p2[1])} l ${X(p3[0])} ${Y(p3[1])} l h f`,
            );
            break;
          }
          case "text":
            ops.push(
              textOp(primitive.text, primitive.x, primitive.y, primitive),
            );
            break;
        }
      }
    }
  };
  walk(picture.groups);
  return ops.join("\n");
}

/** Widths (mm) of a text run in base-14 Helvetica at `sizeMm` cap height —
 * a fixed average-width table is NOT used; the PDF text matrix places the
 * anchor and the viewer shapes the run (no width math to get wrong). */
function textOp(
  text: string,
  x: number,
  y: number,
  primitive: DrawingPrimitive & { readonly kind: "text" },
): string {
  const escaped = pdfEscape(asciiOnly(text));
  const size = n(primitive.sizeMm * MM_TO_PT);
  if (primitive.anchor === "middle") {
    // Centre without font metrics: offset the origin by half the run's
    // deterministic code-point count times a fixed 0.6 em advance — an
    // approximation that is still byte-deterministic.
    const approxWidth = text.length * primitive.sizeMm * 0.6;
    return `BT /F1 ${size} Tf ${n((x - approxWidth / 2) * MM_TO_PT)} ${n(y * MM_TO_PT)} Td (${escaped}) Tj ET`;
  }
  return `BT /F1 ${size} Tf ${n(x * MM_TO_PT)} ${n(y * MM_TO_PT)} Td (${escaped}) Tj ET`;
}

function asciiOnly(text: string): string {
  return text.replace(/[^\x20-\x7E]/g, "?");
}

function pdfEscape(text: string): string {
  return text
    .replaceAll("\\", "\\\\")
    .replaceAll("(", "\\(")
    .replaceAll(")", "\\)");
}
