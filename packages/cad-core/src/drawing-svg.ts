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

import type { DrawingPrimitive } from "./drawing-presentation";

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
      // Sheet space is y-up; SVG is y-down — flip the arc's y and sweep.
      const startX =
        primitive.cx + Math.cos(primitive.startRad) * primitive.radius;
      const startY =
        primitive.cy - Math.sin(primitive.startRad) * primitive.radius;
      const endX = primitive.cx + Math.cos(primitive.endRad) * primitive.radius;
      const endY = primitive.cy - Math.sin(primitive.endRad) * primitive.radius;
      const sweep = primitive.endRad - primitive.startRad;
      const largeArc = Math.abs(sweep) > Math.PI ? 1 : 0;
      const sweepFlag = sweep > 0 ? 0 : 1;
      return `<path d="M ${formatSvgNumber(startX)} ${formatSvgNumber(startY)} A ${formatSvgNumber(primitive.radius)} ${formatSvgNumber(primitive.radius)} 0 ${String(largeArc)} ${String(sweepFlag)} ${formatSvgNumber(endX)} ${formatSvgNumber(endY)}" fill="none" stroke="black" stroke-width="0.35"/>`;
    }
    case "arrow": {
      // A filled isoceles triangle pointing along angleRad (sheet y-up).
      const length = 3;
      const halfWidth = 1.1;
      const cos = Math.cos(primitive.angleRad);
      const sin = Math.sin(primitive.angleRad);
      // In sheet space the base corners sit at (-length, ±halfWidth);
      // flipping to SVG y-down mirrors the corner y signs.
      const base1X = primitive.x + cos * -length - sin * -halfWidth;
      const base1Y = primitive.y - sin * -length - cos * -halfWidth;
      const base2X = primitive.x + cos * -length - sin * halfWidth;
      const base2Y = primitive.y - sin * -length - cos * halfWidth;
      return `<polygon points="${formatSvgNumber(primitive.x)},${formatSvgNumber(primitive.y)} ${formatSvgNumber(base1X)},${formatSvgNumber(base1Y)} ${formatSvgNumber(base2X)},${formatSvgNumber(base2Y)}" fill="black"/>`;
    }
    case "text":
      return `<text x="${formatSvgNumber(primitive.x)}" y="${formatSvgNumber(primitive.y)}" font-size="${formatSvgNumber(primitive.sizeMm)}" text-anchor="${primitive.anchor}" font-family="monospace" fill="black">${esc(primitive.text)}</text>`;
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
