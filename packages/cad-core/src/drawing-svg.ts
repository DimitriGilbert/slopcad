/**
 * The drawing sheet's deterministic SVG exporter (Phase 54): ONE pure
 * string builder from {@link DrawingPrimitive}s to an SVG document, the
 * export-preview surface the roadmap's validation names.
 *
 * ## Determinism (law §1.2)
 *
 * Same primitives in, same bytes out — there is no clock, no randomness,
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
  type DrawingPrimitive,
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

function primitiveToSvg(primitive: DrawingPrimitive): string {
  switch (primitive.kind) {
    case "line":
      return `<line x1="${formatSvgNumber(primitive.x1)}" y1="${formatSvgNumber(primitive.y1)}" x2="${formatSvgNumber(primitive.x2)}" y2="${formatSvgNumber(primitive.y2)}" stroke="black" stroke-width="0.35"${primitive.dashed ? ' stroke-dasharray="2 1.5"' : ""}/>`;
    case "rect":
      return `<rect x="${formatSvgNumber(primitive.x)}" y="${formatSvgNumber(primitive.y)}" width="${formatSvgNumber(primitive.width)}" height="${formatSvgNumber(primitive.height)}" fill="none" stroke="black" stroke-width="0.5"${primitive.dashed ? ' stroke-dasharray="2 1.5"' : ""}/>`;
    case "arc": {
      // Raw sheet coordinates and the y-flip-corrected flags come from
      // the shared discipline — the canvas draws the same geometry.
      const geometry = sheetArcGeometry(primitive);
      return `<path d="M ${formatSvgNumber(geometry.startX)} ${formatSvgNumber(geometry.startY)} A ${formatSvgNumber(primitive.radius)} ${formatSvgNumber(primitive.radius)} 0 ${geometry.largeArc ? "1" : "0"} ${geometry.sweepFlag ? "1" : "0"} ${formatSvgNumber(geometry.endX)} ${formatSvgNumber(geometry.endY)}" fill="none" stroke="black" stroke-width="0.35"/>`;
    }
    case "arrow": {
      // The shared arrowhead triangle, raw sheet coordinates.
      return `<polygon points="${arrowHeadPolygonPoints(primitive.x, primitive.y, primitive.angleRad, formatSvgNumber)}" fill="black"/>`;
    }
    case "text":
      // The per-text counter-flip the canvas applies too: without it the
      // root group's y-flip mirrors every glyph run in the export.
      return `<text x="${formatSvgNumber(primitive.x)}" y="${formatSvgNumber(primitive.y)}" font-size="${formatSvgNumber(primitive.sizeMm)}" text-anchor="${primitive.anchor}" font-family="monospace" fill="black" transform="${uprightTextTransform(primitive.y, formatSvgNumber)}">${esc(primitive.text)}</text>`;
  }
}

/**
 * Serializes the sheet's primitives into a deterministic SVG document
 * (sheet space y-up is flipped to SVG y-down once, at the root group).
 */
export function serializeDrawingSheetSvg(
  widthMm: number,
  heightMm: number,
  primitives: readonly DrawingPrimitive[],
): string {
  const parts: string[] = [];
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${formatSvgNumber(widthMm)}mm" height="${formatSvgNumber(heightMm)}mm" viewBox="0 0 ${formatSvgNumber(widthMm)} ${formatSvgNumber(heightMm)}">`,
  );
  parts.push(
    `<g transform="translate(0 ${formatSvgNumber(heightMm)}) scale(1 -1)">`,
  );
  for (const primitive of primitives) {
    parts.push(primitiveToSvg(primitive));
  }
  parts.push("</g>");
  parts.push("</svg>");
  return `${parts.join("\n")}\n`;
}
