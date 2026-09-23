/**
 * The drawing output layer (Phase 55): deterministic byte-stable
 * serialization of a whole drawing — SVG, PDF, and the programmatic
 * summary — from one picture model.
 *
 * The exporter discipline every serializer in the codebase follows applies
 * to all three: fixed attribute/object order, no clocks, no locale, no
 * randomness — the same drawing and the same geometry always produce
 * identical bytes (the byte-determinism law §1.2). The workbench canvas
 * renders through the SVG member of this module, so what is on screen and
 * what exports are one picture.
 *
 * ## Picture model
 *
 * Every exporter walks the same structure: per sheet — frame border, views
 * (visible, hidden, hatch strokes, label), balloons (leader, circle, item
 * number resolved from the sheet's first BOM table containing the
 * occurrence), BOM tables (title, header row, item rows) — in document
 * order. Sheet coordinates are TOP-DOWN millimetres; each exporter maps
 * them to its target convention (SVG user units pass through; PDF y flips
 * to grow upward and scales mm→pt at 72/25.4; the DXF writer flips y in
 * `drawing-dxf.ts`).
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

/** The projected geometry per view id for a whole drawing. */
export type DrawingGeometryByView = ReadonlyMap<string, DrawingViewGeometry>;

/** Formats a number deterministically: ≤4 decimals, trimmed, no exponent. */
const n = (value: number): string => {
  const fixed = value.toFixed(4);
  const trimmed = fixed.replace(/\.?0+$/, "");
  return trimmed === "-0" ? "0" : trimmed;
};

const MM_TO_PT = 72 / 25.4;

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

const pathOf = (chain: readonly (readonly [number, number])[]): string =>
  chain
    .map(
      (point, index) =>
        `${index === 0 ? "M" : "L"}${n(point[0])} ${n(point[1])}`,
    )
    .join("");

/**
 * Serializes a drawing (plus its views' projected geometry) to the
 * canonical byte-stable SVG string. Geometry for a view that has none yet
 * renders the view frame only — an honest empty state, never a fabricated
 * picture.
 */
export function serializeDrawingSvg(
  drawing: DrawingDocument,
  geometry: DrawingGeometryByView,
): string {
  const parts: string[] = [];
  for (const sheet of drawing.sheets) {
    const { width, height } = sheetDimensions(sheet);
    parts.push(
      `<g class="dg-sheet" data-sheet-id="${sheet.id}" data-size="${sheet.size}" data-orientation="${sheet.orientation}">`,
    );
    parts.push(
      `<rect class="dg-frame" x="10" y="10" width="${n(width - 20)}" height="${n(height - 20)}" fill="none" stroke="currentColor" stroke-width="0.5"/>`,
    );
    for (const view of sheet.views) {
      const geo = geometry.get(view.id) ?? null;
      parts.push(
        `<g class="dg-view" data-view-id="${view.id}" data-kind="${view.kind}" data-x="${n(view.x)}" data-y="${n(view.y)}">`,
      );
      let labelBaseline = view.y + 8;
      if (geo !== null && geo.bounds !== null) {
        const scale = view.scale ?? sheet.scale;
        const centreU = (geo.bounds.minU + geo.bounds.maxU) / 2;
        const centreV = (geo.bounds.minV + geo.bounds.maxV) / 2;
        const transform = (
          point: readonly [number, number],
        ): [number, number] => [
          view.x + scaleLength(point[0] - centreU, scale),
          view.y - scaleLength(point[1] - centreV, scale),
        ];
        const chainPath = (
          chain: readonly (readonly [number, number])[],
        ): string => pathOf(chain.map(transform));
        parts.push(`<g class="dg-visible">`);
        for (const chain of geo.visible)
          parts.push(`<path d="${chainPath(chain)}"/>`);
        parts.push(`</g>`);
        parts.push(`<g class="dg-hidden">`);
        for (const chain of geo.hidden)
          parts.push(`<path d="${chainPath(chain)}"/>`);
        parts.push(`</g>`);
        const hatch = geo.hatch ?? [];
        if (hatch.length > 0) {
          parts.push(`<g class="dg-hatch">`);
          for (const chain of hatch)
            parts.push(`<path d="${chainPath(chain)}"/>`);
          parts.push(`</g>`);
        }
        const frame = viewFrameFromGeometry(view, sheet, geo.bounds);
        if (frame !== null) labelBaseline = frame.y + frame.height / 2 + 5;
      }
      if (view.label !== undefined) {
        parts.push(
          `<text class="dg-label" x="${n(view.x)}" y="${n(labelBaseline)}" text-anchor="middle">${escapeText(view.label)}</text>`,
        );
      }
      parts.push(`</g>`);
    }
    for (const balloon of sheet.balloons ?? []) {
      parts.push(
        `<g class="dg-balloon" data-occurrence-id="${balloon.occurrenceId}" data-x="${n(balloon.x)}" data-y="${n(balloon.y)}">`,
      );
      parts.push(
        `<line x1="${n(balloon.x)}" y1="${n(balloon.y)}" x2="${n(balloon.leaderX)}" y2="${n(balloon.leaderY)}"/>`,
      );
      parts.push(
        `<circle class="dg-balloon-circle" cx="${n(balloon.x)}" cy="${n(balloon.y)}" r="4" fill="none"/>`,
      );
      const item = balloonItem(sheet, balloon);
      if (item !== null) {
        parts.push(
          `<text class="dg-balloon-item" x="${n(balloon.x)}" y="${n(balloon.y + 1.2)}" text-anchor="middle">${String(item)}</text>`,
        );
      }
      parts.push(`</g>`);
    }
    for (const table of sheet.bomTables ?? []) {
      parts.push(
        `<g class="dg-bom" data-x="${n(table.x)}" data-y="${n(table.y)}">`,
      );
      appendBomSvg(parts, table);
      parts.push(`</g>`);
    }
    parts.push(`</g>`);
  }
  const summary = drawingSummary(drawing);
  const first = drawing.sheets[0];
  const box = first === undefined ? "0 0 210 297" : viewBoxFor(first);
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${box}" role="img" aria-label="${escapeText(summary)}">`,
    `<title>${escapeText(summary)}</title>`,
    `<style>.dg-visible{fill:none;stroke:currentColor;stroke-width:0.35}.dg-hidden{fill:none;stroke:currentColor;stroke-width:0.18;stroke-dasharray:1 0.75}.dg-hatch{fill:none;stroke:currentColor;stroke-width:0.15}.dg-label{fill:currentColor;font-size:3.5px;text-anchor:middle}.dg-balloon line{stroke:currentColor;stroke-width:0.2}.dg-balloon-circle{stroke:currentColor;stroke-width:0.25}.dg-balloon-item{fill:currentColor;font-size:2.8px;text-anchor:middle}.dg-bom line,.dg-bom rect{stroke:currentColor;fill:none;stroke-width:0.2}.dg-bom text{fill:currentColor;font-size:2.5px}</style>`,
    ...parts,
    `</svg>`,
    ``,
  ].join("\n");
}

/** BOM cell layout (sheet millimetres): column widths and row height. */
export const BOM_COLUMN_WIDTHS = {
  item: 10,
  quantity: 12,
  description: 42,
} as const;
export const BOM_ROW_HEIGHT = 6;

function appendBomSvg(parts: string[], table: DrawingBomTable): void {
  const { item, quantity, description } = BOM_COLUMN_WIDTHS;
  const totalWidth = item + quantity + description;
  const rows = table.rows.length + 1 + (table.title === null ? 0 : 1);
  const totalHeight = rows * BOM_ROW_HEIGHT;
  parts.push(
    `<rect x="${n(table.x)}" y="${n(table.y)}" width="${n(totalWidth)}" height="${n(totalHeight)}"/>`,
  );
  let y = table.y;
  if (table.title !== null) {
    parts.push(
      `<text x="${n(table.x + totalWidth / 2)}" y="${n(y + BOM_ROW_HEIGHT - 2)}" text-anchor="middle" font-size="3">${escapeText(table.title)}</text>`,
    );
    y += BOM_ROW_HEIGHT;
    parts.push(
      `<line x1="${n(table.x)}" y1="${n(y)}" x2="${n(table.x + totalWidth)}" y2="${n(y)}"/>`,
    );
  }
  const headerY = y;
  parts.push(
    `<text x="${n(table.x + item / 2)}" y="${n(headerY + BOM_ROW_HEIGHT - 2)}" text-anchor="middle">ITEM</text>`,
    `<text x="${n(table.x + item + quantity / 2)}" y="${n(headerY + BOM_ROW_HEIGHT - 2)}" text-anchor="middle">QTY</text>`,
    `<text x="${n(table.x + item + quantity + 2)}" y="${n(headerY + BOM_ROW_HEIGHT - 2)}">DESCRIPTION</text>`,
  );
  y += BOM_ROW_HEIGHT;
  parts.push(
    `<line x1="${n(table.x)}" y1="${n(y)}" x2="${n(table.x + totalWidth)}" y2="${n(y)}"/>`,
  );
  for (const row of table.rows) {
    const centreY = y + BOM_ROW_HEIGHT - 2;
    parts.push(
      `<text x="${n(table.x + item / 2)}" y="${n(centreY)}" text-anchor="middle">${String(row.item)}</text>`,
      `<text x="${n(table.x + item + quantity / 2)}" y="${n(centreY)}" text-anchor="middle">${String(row.quantity)}</text>`,
      `<text x="${n(table.x + item + quantity + 2)}" y="${n(centreY)}">${escapeText(bomRowText(row))}</text>`,
    );
    y += BOM_ROW_HEIGHT;
    if (y < table.y + totalHeight) {
      parts.push(
        `<line x1="${n(table.x)}" y1="${n(y)}" x2="${n(table.x + totalWidth)}" y2="${n(y)}"/>`,
      );
    }
  }
  // Column separators.
  parts.push(
    `<line x1="${n(table.x + item)}" y1="${n(table.y)}" x2="${n(table.x + item)}" y2="${n(table.y + totalHeight)}"/>`,
    `<line x1="${n(table.x + item + quantity)}" y1="${n(table.y)}" x2="${n(table.x + item + quantity)}" y2="${n(table.y + totalHeight)}"/>`,
  );
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

function viewBoxFor(sheet: {
  readonly size: Parameters<typeof sheetDimensions>[0]["size"];
  readonly orientation: Parameters<typeof sheetDimensions>[0]["orientation"];
}): string {
  const { width, height } = sheetDimensions(sheet);
  return `0 0 ${n(width)} ${n(height)}`;
}

function escapeText(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

// ---------------------------------------------------------------------------
// PDF (vector, deterministic builder)
// ---------------------------------------------------------------------------

/**
 * Serializes a drawing to a deterministic PDF 1.4 document (uncompressed
 * content streams, base-14 Helvetica, no Info dictionary — no clocks):
 * one page per sheet at the sheet's exact ISO size. Vector only: lines for
 * edges/hatch/leaders, circles approximated by the canvas-free 16-segment
 * polygon (deterministic), text via `/F1`.
 */
export function serializeDrawingPdf(
  drawing: DrawingDocument,
  geometry: DrawingGeometryByView,
): string {
  const pages = drawing.sheets.map((sheet) => pageContent(sheet, geometry));
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

/** One sheet's content stream (PDF y-up, points). */
function pageContent(
  sheet: DrawingSheet,
  geometry: DrawingGeometryByView,
): string {
  const { width, height } = sheetDimensions(sheet);
  const pt = (v: number): number => v * MM_TO_PT;
  const X = (x: number): string => n(pt(x));
  const Y = (y: number): string => n(pt(height - y));
  const ops: string[] = [];
  const line = (
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    widthMm: number,
  ): void => {
    ops.push(`${X(x1)} ${Y(y1)} m ${X(x2)} ${Y(y2)} l ${n(pt(widthMm))} w S`);
  };
  // Frame border.
  line(10, 10, width - 10, 10, 0.5);
  line(width - 10, 10, width - 10, height - 10, 0.5);
  line(width - 10, height - 10, 10, height - 10, 0.5);
  line(10, height - 10, 10, 10, 0.5);
  for (const view of sheet.views) {
    const geo = geometry.get(view.id) ?? null;
    if (geo === null || geo.bounds === null) continue;
    const scale = view.scale ?? sheet.scale;
    const centreU = (geo.bounds.minU + geo.bounds.maxU) / 2;
    const centreV = (geo.bounds.minV + geo.bounds.maxV) / 2;
    const T = (point: readonly [number, number]): readonly [number, number] => [
      view.x + scaleLength(point[0] - centreU, scale),
      view.y - scaleLength(point[1] - centreV, scale),
    ];
    const strokeChains = (
      chains: readonly (readonly (readonly [number, number])[])[],
      widthMm: number,
      dashMm: readonly number[] | null,
    ): void => {
      if (chains.length === 0) return;
      ops.push("q");
      ops.push(`${n(pt(widthMm))} w`);
      if (dashMm !== null) {
        ops.push(`[${dashMm.map((d) => n(pt(d))).join(" ")}] 0 d`);
      }
      for (const chain of chains) {
        const t = chain.map(T);
        const firstPoint = t[0];
        if (firstPoint === undefined) continue;
        let d = `${X(firstPoint[0])} ${Y(firstPoint[1])} m`;
        for (let i = 1; i < t.length; i += 1) {
          const p = t[i];
          if (p === undefined) continue;
          d += ` ${X(p[0])} ${Y(p[1])} l`;
        }
        ops.push(d);
      }
      ops.push(`S Q`);
    };
    strokeChains(geo.visible, 0.35, null);
    strokeChains(geo.hidden, 0.18, [1, 0.75]);
    strokeChains(geo.hatch ?? [], 0.15, null);
    let labelBaseline = view.y + 8;
    const frame = viewFrameFromGeometry(view, sheet, geo.bounds);
    if (frame !== null) labelBaseline = frame.y + frame.height / 2 + 5;
    if (view.label !== undefined) {
      ops.push(textOp(view.label, view.x, labelBaseline, 3.5, "middle", Y));
    }
  }
  for (const balloon of sheet.balloons ?? []) {
    line(balloon.x, balloon.y, balloon.leaderX, balloon.leaderY, 0.2);
    // Balloon circle: deterministic 16-gon at r = 4 mm.
    const r = 4;
    const segments = 16;
    for (let i = 0; i < segments; i += 1) {
      const a0 = (2 * Math.PI * i) / segments;
      const a1 = (2 * Math.PI * (i + 1)) / segments;
      line(
        balloon.x + r * Math.cos(a0),
        balloon.y + r * Math.sin(a0),
        balloon.x + r * Math.cos(a1),
        balloon.y + r * Math.sin(a1),
        0.25,
      );
    }
    const item = balloonItem(sheet, balloon);
    if (item !== null) {
      ops.push(
        textOp(String(item), balloon.x, balloon.y + 1.2, 2.8, "middle", Y),
      );
    }
  }
  for (const table of sheet.bomTables ?? []) {
    appendBomPdf(ops, table, line, (t, x, y, size, align) =>
      textOp(t, x, y, size, align, Y),
    );
  }
  return ops.join("\n");
}

/** Widths (mm) of a text run in base-14 Helvetica at `sizeMm` cap height —
 * a fixed average-width table is NOT used; the PDF text matrix places the
 * anchor and the viewer shapes the run (no width math to get wrong). */
function textOp(
  text: string,
  x: number,
  y: number,
  sizeMm: number,
  align: "left" | "middle",
  Y: (v: number) => string,
): string {
  const escaped = pdfEscape(asciiOnly(text));
  const size = n(sizeMm * MM_TO_PT);
  if (align === "middle") {
    // Centre without font metrics: offset the origin by half the run's
    // deterministic code-point count times a fixed 0.6 em advance — an
    // approximation that is still byte-deterministic.
    const approxWidth = text.length * sizeMm * 0.6;
    return `BT /F1 ${size} Tf ${n((x - approxWidth / 2) * MM_TO_PT)} ${Y(y)} Td (${escaped}) Tj ET`;
  }
  return `BT /F1 ${size} Tf ${n(x * MM_TO_PT)} ${Y(y)} Td (${escaped}) Tj ET`;
}

function appendBomPdf(
  ops: string[],
  table: DrawingBomTable,
  line: (x1: number, y1: number, x2: number, y2: number, w: number) => void,
  text: (
    t: string,
    x: number,
    y: number,
    size: number,
    align: "left" | "middle",
  ) => string,
): void {
  const { item, quantity, description } = BOM_COLUMN_WIDTHS;
  const totalWidth = item + quantity + description;
  const rows = table.rows.length + 1 + (table.title === null ? 0 : 1);
  const totalHeight = rows * BOM_ROW_HEIGHT;
  // Border.
  line(table.x, table.y, table.x + totalWidth, table.y, 0.2);
  line(
    table.x + totalWidth,
    table.y,
    table.x + totalWidth,
    table.y + totalHeight,
    0.2,
  );
  line(
    table.x + totalWidth,
    table.y + totalHeight,
    table.x,
    table.y + totalHeight,
    0.2,
  );
  line(table.x, table.y + totalHeight, table.x, table.y, 0.2);
  let y = table.y;
  if (table.title !== null) {
    ops.push(
      text(
        table.title,
        table.x + totalWidth / 2,
        y + BOM_ROW_HEIGHT - 2,
        3,
        "middle",
      ),
    );
    y += BOM_ROW_HEIGHT;
    line(table.x, y, table.x + totalWidth, y, 0.2);
  }
  ops.push(
    text("ITEM", table.x + item / 2, y + BOM_ROW_HEIGHT - 2, 2.5, "middle"),
  );
  ops.push(
    text(
      "QTY",
      table.x + item + quantity / 2,
      y + BOM_ROW_HEIGHT - 2,
      2.5,
      "middle",
    ),
  );
  ops.push(
    text(
      "DESCRIPTION",
      table.x + item + quantity + 2,
      y + BOM_ROW_HEIGHT - 2,
      2.5,
      "left",
    ),
  );
  y += BOM_ROW_HEIGHT;
  line(table.x, y, table.x + totalWidth, y, 0.2);
  for (const row of table.rows) {
    const baseY = y + BOM_ROW_HEIGHT - 2;
    ops.push(text(String(row.item), table.x + item / 2, baseY, 2.5, "middle"));
    ops.push(
      text(
        String(row.quantity),
        table.x + item + quantity / 2,
        baseY,
        2.5,
        "middle",
      ),
    );
    ops.push(
      text(bomRowText(row), table.x + item + quantity + 2, baseY, 2.5, "left"),
    );
    y += BOM_ROW_HEIGHT;
    if (y < table.y + totalHeight) {
      line(table.x, y, table.x + totalWidth, y, 0.2);
    }
  }
  line(table.x + item, table.y, table.x + item, table.y + totalHeight, 0.2);
  line(
    table.x + item + quantity,
    table.y,
    table.x + item + quantity,
    table.y + totalHeight,
    0.2,
  );
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
