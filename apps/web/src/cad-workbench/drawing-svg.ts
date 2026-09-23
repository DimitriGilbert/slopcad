/**
 * The drawing canvas's deterministic SVG serialization (Phase 53).
 *
 * The 2D render layer draws a {@link DrawingDocument} plus the projected
 * geometry of its views; this module is the byte-stable text form of
 * exactly that picture — the exporter discipline every serializer in the
 * codebase follows (fixed attribute order, no clocks, no locale, no
 * randomness): the same drawing and the same geometry always produce
 * identical bytes. The workbench's on-screen canvas renders through the
 * same pure function's data (the same geometry, the same transform), so
 * what is on screen and what `serializeDrawingSvg` emits are one picture.
 *
 * ## The transform
 *
 * Sheet millimetres map 1:1 to SVG user units with the y axis flipped
 * (sheet y grows upward, SVG y grows downward) inside a viewBox of the
 * sheet's dimensions; each view's projected geometry is translated to its
 * placement (the geometry's bounds centre lands on the view's `x`/`y`) and
 * scaled by the view's effective scale — the same math
 * {@link viewFrameFromGeometry} frames.
 *
 * ## Accessibility
 *
 * The root `<svg>` carries `role="img"` and a programmatic summary
 * (`<title>` + `aria-label`): sheet size/orientation and the ordered view
 * list, so the drawing is describable without vision; visible/hidden edge
 * paths are grouped under `aria-hidden` groups with stable classes
 * (`dg-visible` / `dg-hidden`, hidden edges dashed) while the semantic
 * summary lives on the root.
 */

import {
  type DrawingDocument,
  type DrawingViewGeometry,
  sheetDimensions,
  scaleLength,
} from "@slopcad/cad-core";

/** The projected geometry per view id for a whole drawing. */
export type DrawingGeometryByView = ReadonlyMap<string, DrawingViewGeometry>;

const n = (value: number): string => {
  // Fixed decimal form: up to 4 decimals, trailing zeros trimmed, no
  // exponent — deterministic across locales and runtimes.
  const fixed = value.toFixed(4);
  return fixed.replace(/\.?0+$/, "") === "-0"
    ? "0"
    : fixed.replace(/\.?0+$/, "");
};

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
      }
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
    `<style>.dg-visible{fill:none;stroke:currentColor;stroke-width:0.35}.dg-hidden{fill:none;stroke:currentColor;stroke-width:0.18;stroke-dasharray:1 0.75}</style>`,
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

/** The programmatic summary the canvas exposes to assistive technology. */
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
    return `${sheet.size} ${sheet.orientation} sheet, ${views}`;
  });
  return `Drawing: ${sheetParts.join("; ")}`;
}

function escapeText(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
