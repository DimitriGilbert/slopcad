/**
 * The deterministic SVG serializer (Phase 54, unified in Phase 55 round 2):
 * ONE pure string builder from the presentation's picture model to SVG
 * markup — the single SVG surface in the codebase. The 54 sheet exporter
 * (`serializeDrawingSheetSvg`), the document exporters
 * (`serializeDrawingSvg` in `drawing-output.ts`), and the unified
 * workbench canvas all emit through the per-primitive and per-group
 * builders here, so no second SVG walk can drift away from the flip
 * discipline.
 *
 * ## Determinism (law §1.2)
 *
 * Same picture in, same bytes out — there is no clock, no randomness,
 * no locale-sensitive formatting, and no display state in here. Numbers
 * render through {@link formatSvgNumber} (four decimals, trailing zeros
 * trimmed — exact for the integer millimetre grid the sheet uses);
 * attribute order is fixed per element; the primitive order is the
 * presentation's own fixed order. Re-exporting an unchanged sheet is
 * byte-identical, and the workbench's export-preview asserts exactly that.
 */

import {
  arrowHeadPolygonPoints,
  sheetArcGeometry,
  uprightTextTransform,
  type DrawingPictureGroup,
  type DrawingPrimitive,
  type DrawingSheetPicture,
} from "./drawing-presentation";

/** Formats a number deterministically: 4 decimals, trailing zeros trimmed. */
export function formatSvgNumber(value: number): string {
  if (Number.isInteger(value)) return String(value);
  const fixed = value.toFixed(4);
  const trimmed = fixed.replace(/0+$/, "").replace(/\.$/, "");
  return trimmed;
}

function esc(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/** The stroke-width attribute for a stroked primitive (0.35 default). */
function strokeWidthAttr(widthMm: number | undefined): string {
  return ` stroke-width="${formatSvgNumber(widthMm ?? 0.35)}"`;
}

/** The element's class attribute (absent = nothing — the 54 bytes). */
function classAttr(className: string | undefined): string {
  return className === undefined ? "" : ` class="${className}"`;
}

function primitiveToSvg(primitive: DrawingPrimitive): string {
  switch (primitive.kind) {
    case "line":
      return `<line${classAttr(primitive.class)} x1="${formatSvgNumber(primitive.x1)}" y1="${formatSvgNumber(primitive.y1)}" x2="${formatSvgNumber(primitive.x2)}" y2="${formatSvgNumber(primitive.y2)}" stroke="black"${strokeWidthAttr(primitive.widthMm)}${primitive.dashed ? ' stroke-dasharray="2 1.5"' : ""}/>`;
    case "rect":
      return `<rect${classAttr(primitive.class)} x="${formatSvgNumber(primitive.x)}" y="${formatSvgNumber(primitive.y)}" width="${formatSvgNumber(primitive.width)}" height="${formatSvgNumber(primitive.height)}" fill="none" stroke="black"${strokeWidthAttr(primitive.widthMm ?? 0.5)}${primitive.dashed ? ' stroke-dasharray="2 1.5"' : ""}/>`;
    case "circle":
      return `<circle${classAttr(primitive.class)} cx="${formatSvgNumber(primitive.cx)}" cy="${formatSvgNumber(primitive.cy)}" r="${formatSvgNumber(primitive.radius)}" fill="none" stroke="black"${strokeWidthAttr(primitive.widthMm ?? 0.35)}${primitive.dashed ? ' stroke-dasharray="2 1.5"' : ""}/>`;
    case "arc": {
      // Raw sheet coordinates and the y-flip-corrected flags come from
      // the shared discipline — the canvas draws the same geometry.
      const geometry = sheetArcGeometry(primitive);
      return `<path${classAttr(primitive.class)} d="M ${formatSvgNumber(geometry.startX)} ${formatSvgNumber(geometry.startY)} A ${formatSvgNumber(primitive.radius)} ${formatSvgNumber(primitive.radius)} 0 ${geometry.largeArc ? "1" : "0"} ${geometry.sweepFlag ? "1" : "0"} ${formatSvgNumber(geometry.endX)} ${formatSvgNumber(geometry.endY)}" fill="none" stroke="black" stroke-width="0.35"/>`;
    }
    case "arrow": {
      // The shared arrowhead triangle, raw sheet coordinates.
      return `<polygon${classAttr(primitive.class)} points="${arrowHeadPolygonPoints(primitive.x, primitive.y, primitive.angleRad, formatSvgNumber)}" fill="black"/>`;
    }
    case "text":
      // The per-text counter-flip the canvas applies too: without it the
      // root group's y-flip mirrors every glyph run in the export.
      return `<text${classAttr(primitive.class)} x="${formatSvgNumber(primitive.x)}" y="${formatSvgNumber(primitive.y)}" font-size="${formatSvgNumber(primitive.sizeMm)}" text-anchor="${primitive.anchor}" font-family="monospace" fill="black" transform="${uprightTextTransform(primitive.y, formatSvgNumber)}">${esc(primitive.text)}</text>`;
  }
}

/** The root group's single y-flip (sheet y-up → SVG y-down), the one flip. */
function flipGroupOpen(heightMm: number): string {
  return `<g transform="translate(0 ${formatSvgNumber(heightMm)}) scale(1 -1)">`;
}

/** Data attributes in pinned (sorted-key) order — part of the byte format. */
function dataAttrs(data: Readonly<Record<string, string>> | undefined): string {
  if (data === undefined) return "";
  return Object.keys(data)
    .sort()
    .map((key) => ` data-${key}="${esc(data[key] ?? "")}"`)
    .join("");
}

/**
 * The markup lines for one group run INSIDE the root flip group: each
 * group opens `<g class=… data-…>`, serializes its child groups, then its
 * primitives (labels paint on top of their group's geometry, the DOM
 * order the workbench canvas always showed), and closes. An empty class
 * renders a bare `<g>` (the Phase 54 bytes keep exactly that shape).
 */
export function drawingGroupMarkup(
  groups: readonly DrawingPictureGroup[],
): readonly string[] {
  const lines: string[] = [];
  for (const group of groups) {
    lines.push(
      group.class === ""
        ? "<g>"
        : `<g class="${group.class}"${dataAttrs(group.data)}>`,
    );
    if (group.children !== undefined) {
      lines.push(...drawingGroupMarkup(group.children));
    }
    for (const primitive of group.primitives) {
      lines.push(primitiveToSvg(primitive));
    }
    lines.push("</g>");
  }
  return lines;
}

/**
 * Serializes one sheet picture into a standalone deterministic SVG
 * document (sheet space y-up flipped to SVG y-down once, at the root
 * group). This is the unified workbench canvas's export — furniture and
 * document content are groups of the same picture.
 */
export function serializeSheetPictureSvg(picture: DrawingSheetPicture): string {
  const parts: string[] = [];
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${formatSvgNumber(picture.widthMm)}mm" height="${formatSvgNumber(picture.heightMm)}mm" viewBox="0 0 ${formatSvgNumber(picture.widthMm)} ${formatSvgNumber(picture.heightMm)}">`,
  );
  parts.push(flipGroupOpen(picture.heightMm));
  parts.push(...drawingGroupMarkup(picture.groups));
  parts.push("</g>");
  parts.push("</svg>");
  return `${parts.join("\n")}\n`;
}

/**
 * Serializes the sheet's primitives into a deterministic SVG document
 * (the Phase 54 exporter — one bare group of primitives under the root
 * flip). The unified picture form is {@link serializeSheetPictureSvg}.
 */
export function serializeDrawingSheetSvg(
  widthMm: number,
  heightMm: number,
  primitives: readonly DrawingPrimitive[],
): string {
  return serializeSheetPictureSvg({
    widthMm,
    heightMm,
    groups: [{ class: "", primitives }],
  });
}
