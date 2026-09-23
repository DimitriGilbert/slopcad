/**
 * Drawing sheet presentation (Phase 54): the deterministic geometry of a
 * presented sheet — frame, title block, revision table, dimensions, and
 * annotations — as pure primitive data in sheet millimetres that the
 * workbench canvas renders and the SVG exporter serializes.
 *
 * ## Determinism
 *
 * The sketch-dimension presentation discipline (Phase 37) applied to the
 * sheet: fixed constants (arrow size, text height, offsets below), fixed
 * layout fractions (the title block sits in the frame's bottom-right
 * corner, the revision table grows down from the frame's top-right
 * corner), fixed value formatting ({@link formatDimensionValue}), and a
 * fixed primitive order (furniture, then dimensions in id order, then
 * annotations in id order — {@link compareDrawingId} keeps identifier
 * ordering stable regardless of authoring order). Identical inputs present
 * identically, byte for byte.
 *
 * ## Fallback, not failure
 *
 * An angular dimension whose sweep is degenerate (zero sweep) still
 * presents its bare value label at the arc's deterministic anchor rather
 * than vanishing — the value stays visible, honestly carried.
 */

import type {
  DrawingAnnotation,
  DrawingDimension,
} from "./drawing-annotations";
import type { DrawingRevisionRow, DrawingTitleBlock } from "./drawing-sheet";

import { sheetDimensionsMm, type DrawingSheetSetup } from "./drawing-sheet";

/** Sheet-frame inset from the sheet edge (mm). */
export const DRAWING_FRAME_MARGIN_MM = 10;

/** Dimension text height (mm). */
export const DRAWING_TEXT_HEIGHT_MM = 3.5;

/** Small label text height (mm) — furniture labels and callout text. */
export const DRAWING_SMALL_TEXT_HEIGHT_MM = 2.8;

/** Arrowhead length (mm) along the dimension line. */
export const DRAWING_ARROW_LENGTH_MM = 3;

/** Arrowhead half-width (mm) across the dimension line. */
export const DRAWING_ARROW_WIDTH_MM = 1.1;

/** Extension-line overshoot past the dimension line (mm). */
export const DRAWING_EXTENSION_OVERSHOOT_MM = 2;

/** Gap between measured geometry and the extension line start (mm). */
export const DRAWING_EXTENSION_GAP_MM = 1;

/** Default dimension-line offset when a dimension carries none (mm). */
export const DRAWING_DIMENSION_OFFSET_MM = 8;

/** Title block cell height (mm). */
export const DRAWING_TITLE_BLOCK_HEIGHT_MM = 22;

/** Title block width as a fraction of the frame width. */
export const DRAWING_TITLE_BLOCK_WIDTH_FRACTION = 0.42;

/** Revision table row height (mm). */
export const DRAWING_REVISION_ROW_HEIGHT_MM = 6;

/** Revision table width as a fraction of the frame width. */
export const DRAWING_REVISION_TABLE_WIDTH_FRACTION = 0.34;

/**
 * The ISO 1101 symbol glyph per pinned geometric characteristic (the
 * pinned-subset decision — each glyph is the standardized character, kept
 * in one fixed map).
 */
export const GDNT_SYMBOLS: Readonly<Record<string, string>> = {
  straightness: "\u23E4",
  flatness: "\u23E5",
  circularity: "\u25CB",
  cylindricity: "\u232D",
  lineProfile: "\u2313",
  surfaceProfile: "\u2303",
  angularity: "\u2220",
  perpendicularity: "\u27C2",
  parallelism: "\u2225",
  position: "\u2316",
  concentricity: "\u25CE",
  symmetry: "\u232F",
  circularRunout: "\u2197",
  totalRunout: "\u21F7",
};

/**
 * A presented sheet primitive: everything the canvas and exporter draw.
 * Coordinates are sheet millimetres, y-UP (the single space the flip
 * discipline renders); every consumer — workbench canvas, SVG exporter,
 * the document exporters — draws THIS vocabulary and nothing else.
 */
export type DrawingPrimitive =
  | {
      readonly kind: "line";
      readonly x1: number;
      readonly y1: number;
      readonly x2: number;
      readonly y2: number;
      readonly dashed?: boolean;
      /** Stroke width in sheet millimetres (absent = the media default). */
      readonly widthMm?: number;
      /** The element's SVG class (absent = no class attribute). */
      readonly class?: string;
    }
  | {
      readonly kind: "rect";
      readonly x: number;
      readonly y: number;
      readonly width: number;
      readonly height: number;
      readonly dashed?: boolean;
      /** Stroke width in sheet millimetres (absent = the media default). */
      readonly widthMm?: number;
      /** The element's SVG class (absent = no class attribute). */
      readonly class?: string;
    }
  | {
      /** A circle (balloons): centre, radius, sheet millimetres. */
      readonly kind: "circle";
      readonly cx: number;
      readonly cy: number;
      readonly radius: number;
      readonly dashed?: boolean;
      /** Stroke width in sheet millimetres (absent = the media default). */
      readonly widthMm?: number;
      /** The element's SVG class (absent = no class attribute). */
      readonly class?: string;
    }
  | {
      /** A circular arc from startRad to endRad (sheet radians, y-up). */
      readonly kind: "arc";
      readonly cx: number;
      readonly cy: number;
      readonly radius: number;
      readonly startRad: number;
      readonly endRad: number;
      /** The element's SVG class (absent = no class attribute). */
      readonly class?: string;
    }
  | {
      /** A filled arrowhead at (x, y) pointing along angleRad. */
      readonly kind: "arrow";
      readonly x: number;
      readonly y: number;
      readonly angleRad: number;
      /** The element's SVG class (absent = no class attribute). */
      readonly class?: string;
    }
  | {
      readonly kind: "text";
      readonly x: number;
      readonly y: number;
      readonly text: string;
      readonly anchor: "start" | "middle" | "end";
      readonly sizeMm: number;
      /** The element's SVG class (absent = no class attribute). */
      readonly class?: string;
    };

/**
 * One named run of presented primitives — the SVG DOM's `<g class=…>`
 * with its data attributes, and the exporters' style key. The class
 * vocabulary (`dg-frame`, `dg-view`, `dg-visible`, `dg-hidden`,
 * `dg-hatch`, `dg-label`, `dg-balloon`, `dg-balloon-circle`,
 * `dg-balloon-item`, `dg-bom`, `dg-furniture`) is the stable contract
 * between the presentation and every medium: the SVG groups, the PDF
 * stroke table, and the DXF layer map all key on it.
 */
export interface DrawingPictureGroup {
  readonly class: string;
  /** Stable data attributes (view/balloon/table identity and placement). */
  readonly data?: Readonly<Record<string, string>>;
  readonly primitives: readonly DrawingPrimitive[];
  /** Nested runs (a view's visible/hidden/hatch stroke sets). */
  readonly children?: readonly DrawingPictureGroup[];
}

/** One presented sheet: its size and the ordered group run. */
export interface DrawingSheetPicture {
  readonly widthMm: number;
  readonly heightMm: number;
  readonly groups: readonly DrawingPictureGroup[];
}

/**
 * Formats a dimension value: millimetres trimmed to at most two decimals,
 * degrees to one — the fixed text the value fixtures assert against.
 */
export function formatDimensionValue(
  value: number,
  unit: "mm" | "deg",
): string {
  const rounded =
    unit === "mm" ? Math.round(value * 100) / 100 : Math.round(value * 10) / 10;
  return String(rounded);
}

/** Compares drawing ids by (prefix-independent) payload then whole string. */
export function compareDrawingId(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * ## The y-flip rendering discipline (one space, two surfaces)
 *
 * Both SVG surfaces — the workbench's live canvas and the deterministic
 * exporter — draw these primitives inside ONE root group
 * `translate(0 heightMm) scale(1 -1)`, so local coordinates ARE sheet
 * coordinates (y-up). That single group flip mirrors glyph runs and
 * reverses sweep directions, so the three corrections below live HERE,
 * beside the primitive vocabulary, and BOTH surfaces consume them: the
 * canvas and the export cannot drift apart again (the Phase 54
 * validation root cause was exactly that drift — the exporter skipped
 * the text counter-flip the canvas applied, and each surface carried
 * its own pre-flipped arrow and arc math).
 */

/**
 * The arrowhead triangle's polygon points in RAW sheet coordinates: the
 * tip at (x, y), the base corners `DRAWING_ARROW_LENGTH_MM` back along
 * the arrow and ±`DRAWING_ARROW_WIDTH_MM` across it. The root group's
 * single y-flip renders the triangle pointing along `angleRad` — no
 * per-surface pre-flip (a pre-flip mirrors oblique arrowheads).
 */
export function arrowHeadPolygonPoints(
  x: number,
  y: number,
  angleRad: number,
  format: (value: number) => string,
): string {
  const cos = Math.cos(angleRad);
  const sin = Math.sin(angleRad);
  const backX = cos * DRAWING_ARROW_LENGTH_MM;
  const backY = sin * DRAWING_ARROW_LENGTH_MM;
  const acrossX = sin * DRAWING_ARROW_WIDTH_MM;
  const acrossY = cos * DRAWING_ARROW_WIDTH_MM;
  return [
    `${format(x)},${format(y)}`,
    `${format(x - backX + acrossX)},${format(y - backY - acrossY)}`,
    `${format(x - backX - acrossX)},${format(y - backY + acrossY)}`,
  ].join(" ");
}

/** An arc primitive's rendered geometry under the y-flip root group. */
export interface SheetArcGeometry {
  readonly startX: number;
  readonly startY: number;
  readonly endX: number;
  readonly endY: number;
  /** SVG large-arc flag (the arc sweeps more than π). */
  readonly largeArc: boolean;
  /** SVG sweep flag AFTER the root group's y-flip. */
  readonly sweepFlag: boolean;
}

/**
 * The arc's endpoints in RAW sheet coordinates plus the large-arc and
 * sweep flags correct for rendering inside the y-flip group: the group's
 * reflection reverses the sweep direction, so a counter-clockwise sheet
 * sweep (`endRad > startRad`) renders with sweep flag 1.
 */
export function sheetArcGeometry(arc: {
  readonly cx: number;
  readonly cy: number;
  readonly radius: number;
  readonly startRad: number;
  readonly endRad: number;
}): SheetArcGeometry {
  const sweep = arc.endRad - arc.startRad;
  return {
    startX: arc.cx + Math.cos(arc.startRad) * arc.radius,
    startY: arc.cy + Math.sin(arc.startRad) * arc.radius,
    endX: arc.cx + Math.cos(arc.endRad) * arc.radius,
    endY: arc.cy + Math.sin(arc.endRad) * arc.radius,
    largeArc: Math.abs(sweep) > Math.PI,
    sweepFlag: sweep > 0,
  };
}

/**
 * The per-text counter-flip that keeps a glyph run upright inside the
 * y-flip root group: reflecting the text about its own baseline y puts
 * the run back upright AT the same sheet position. Both the canvas and
 * the exporter must apply this or their glyphs mirror — the Phase 54
 * blocker.
 */
export function uprightTextTransform(
  yMm: number,
  format: (value: number) => string,
): string {
  return `translate(0 ${format(yMm * 2)}) scale(1 -1)`;
}

function dimensionText(dimension: DrawingDimension): string {
  const reference = dimension.origin.source === "reference";
  switch (dimension.kind) {
    case "linear":
      return wrap(formatDimensionValue(dimension.valueMm, "mm"), reference);
    case "radial":
      return wrap(
        `R${formatDimensionValue(dimension.valueMm, "mm")}`,
        reference,
      );
    case "diameter":
      return wrap(
        `\u2300${formatDimensionValue(dimension.valueMm, "mm")}`,
        reference,
      );
    case "angular":
      return wrap(
        `${formatDimensionValue(dimension.valueDeg, "deg")}\u00B0`,
        reference,
      );
  }
}

function wrap(text: string, reference: boolean): string {
  return reference ? `(${text})` : text;
}

function arrowAt(x: number, y: number, angleRad: number): DrawingPrimitive {
  return { kind: "arrow", x, y, angleRad };
}

/**
 * The linear dimension's value text, anchored at the dim line's midpoint:
 * above it for horizontal and aligned spans (the baseline clears the
 * line by half the text height), and BESIDE it for vertical spans — a
 * vertical dim line would strike through middle-anchored glyphs and
 * crowd the arrowheads, so the text offsets along the same normal that
 * placed the dim line, clear of line and arrows alike.
 */
function dimensionValueText(
  dimension: DrawingDimension & { readonly kind: "linear" },
  from: { readonly x: number; readonly y: number },
  to: { readonly x: number; readonly y: number },
  normalX: number,
): DrawingPrimitive {
  const midX = (from.x + to.x) / 2;
  const midY = (from.y + to.y) / 2;
  if (dimension.orientation === "vertical") {
    const side = normalX >= 0 ? 1 : -1;
    return {
      kind: "text",
      x: midX + side * DRAWING_TEXT_HEIGHT_MM * 1.5,
      y: midY - DRAWING_TEXT_HEIGHT_MM / 2,
      text: dimensionText(dimension),
      anchor: "middle",
      sizeMm: DRAWING_TEXT_HEIGHT_MM,
    };
  }
  return {
    kind: "text",
    x: midX,
    y: midY + DRAWING_TEXT_HEIGHT_MM / 2,
    text: dimensionText(dimension),
    anchor: "middle",
    sizeMm: DRAWING_TEXT_HEIGHT_MM,
  };
}

/**
 * Presents one dimension into sheet primitives: extension lines and an
 * offset dimension line with arrowheads for linear; a center→rim leader
 * for radial; the across-the-center line for diameter; the swept arc for
 * angular. The value text anchors at the primitive's deterministic
 * midpoint.
 */
export function presentDrawingDimension(
  dimension: DrawingDimension,
): readonly DrawingPrimitive[] {
  switch (dimension.kind) {
    case "linear": {
      const offset = dimension.offsetMm;
      const dx = dimension.to.x - dimension.from.x;
      const dy = dimension.to.y - dimension.from.y;
      // Horizontal/vertical orientations snap the offset axis; aligned
      // offsets along the measured segment's left normal.
      let nx: number;
      let ny: number;
      if (dimension.orientation === "horizontal") {
        ny = offset;
        nx = 0;
      } else if (dimension.orientation === "vertical") {
        nx = offset;
        ny = 0;
      } else {
        const length = Math.hypot(dx, dy);
        if (length === 0) {
          nx = offset;
          ny = 0;
        } else {
          nx = (-dy / length) * offset;
          ny = (dx / length) * offset;
        }
      }
      const from = { x: dimension.from.x + nx, y: dimension.from.y + ny };
      const to = { x: dimension.to.x + nx, y: dimension.to.y + ny };
      const angle = Math.atan2(to.y - from.y, to.x - from.x);
      const gapAngle = angle + Math.PI / 2;
      const gapX = Math.cos(gapAngle) * DRAWING_EXTENSION_GAP_MM;
      const gapY = Math.sin(gapAngle) * DRAWING_EXTENSION_GAP_MM;
      const overshootX = Math.cos(gapAngle) * DRAWING_EXTENSION_OVERSHOOT_MM;
      const overshootY = Math.sin(gapAngle) * DRAWING_EXTENSION_OVERSHOOT_MM;
      return [
        {
          kind: "line",
          x1: dimension.from.x + gapX,
          y1: dimension.from.y + gapY,
          x2: from.x + overshootX,
          y2: from.y + overshootY,
        },
        {
          kind: "line",
          x1: dimension.to.x + gapX,
          y1: dimension.to.y + gapY,
          x2: to.x + overshootX,
          y2: to.y + overshootY,
        },
        { kind: "line", x1: from.x, y1: from.y, x2: to.x, y2: to.y },
        arrowAt(from.x, from.y, angle),
        arrowAt(to.x, to.y, angle + Math.PI),
        dimensionValueText(dimension, from, to, nx),
      ];
    }
    case "radial": {
      const angle = Math.atan2(
        dimension.rim.y - dimension.center.y,
        dimension.rim.x - dimension.center.x,
      );
      return [
        {
          kind: "line",
          x1: dimension.center.x,
          y1: dimension.center.y,
          x2: dimension.rim.x,
          y2: dimension.rim.y,
        },
        arrowAt(dimension.rim.x, dimension.rim.y, angle),
        {
          kind: "text",
          x: dimension.center.x + (dimension.rim.x - dimension.center.x) * 0.6,
          y:
            dimension.center.y +
            (dimension.rim.y - dimension.center.y) * 0.6 +
            DRAWING_TEXT_HEIGHT_MM / 2,
          text: dimensionText(dimension),
          anchor: "middle",
          sizeMm: DRAWING_TEXT_HEIGHT_MM,
        },
      ];
    }
    case "diameter": {
      const cos = Math.cos(dimension.anchorAngleRad);
      const sin = Math.sin(dimension.anchorAngleRad);
      const from = {
        x: dimension.center.x - cos * dimension.radiusMm,
        y: dimension.center.y - sin * dimension.radiusMm,
      };
      const to = {
        x: dimension.center.x + cos * dimension.radiusMm,
        y: dimension.center.y + sin * dimension.radiusMm,
      };
      const angle = Math.atan2(to.y - from.y, to.x - from.x);
      return [
        { kind: "line", x1: from.x, y1: from.y, x2: to.x, y2: to.y },
        arrowAt(from.x, from.y, angle + Math.PI),
        arrowAt(to.x, to.y, angle),
        {
          kind: "text",
          x: dimension.center.x,
          y: dimension.center.y + DRAWING_TEXT_HEIGHT_MM / 2,
          text: dimensionText(dimension),
          anchor: "middle",
          sizeMm: DRAWING_TEXT_HEIGHT_MM,
        },
      ];
    }
    case "angular": {
      const sweep = dimension.endAngleRad - dimension.startAngleRad;
      if (sweep === 0) {
        // Degenerate sweep: the bare value at the deterministic anchor —
        // visible, honestly carried, no arc drawn.
        return [
          {
            kind: "text",
            x: dimension.vertex.x + dimension.arcRadiusMm,
            y: dimension.vertex.y + DRAWING_TEXT_HEIGHT_MM / 2,
            text: dimensionText(dimension),
            anchor: "start",
            sizeMm: DRAWING_TEXT_HEIGHT_MM,
          },
        ];
      }
      const textAngle =
        dimension.startAngleRad +
        (dimension.endAngleRad - dimension.startAngleRad) / 2;
      return [
        {
          kind: "arc",
          cx: dimension.vertex.x,
          cy: dimension.vertex.y,
          radius: dimension.arcRadiusMm,
          startRad: dimension.startAngleRad,
          endRad: dimension.endAngleRad,
        },
        arrowAt(
          dimension.vertex.x +
            Math.cos(dimension.startAngleRad) * dimension.arcRadiusMm,
          dimension.vertex.y +
            Math.sin(dimension.startAngleRad) * dimension.arcRadiusMm,
          dimension.startAngleRad - Math.PI / 2,
        ),
        arrowAt(
          dimension.vertex.x +
            Math.cos(dimension.endAngleRad) * dimension.arcRadiusMm,
          dimension.vertex.y +
            Math.sin(dimension.endAngleRad) * dimension.arcRadiusMm,
          dimension.endAngleRad + Math.PI / 2,
        ),
        {
          kind: "text",
          x:
            dimension.vertex.x +
            Math.cos(textAngle) * (dimension.arcRadiusMm + 4),
          y:
            dimension.vertex.y +
            Math.sin(textAngle) * (dimension.arcRadiusMm + 4) +
            DRAWING_TEXT_HEIGHT_MM / 2,
          text: dimensionText(dimension),
          anchor: "middle",
          sizeMm: DRAWING_TEXT_HEIGHT_MM,
        },
      ];
    }
  }
}

/** Presents one annotation into sheet primitives. */
export function presentDrawingAnnotation(
  annotation: DrawingAnnotation,
): readonly DrawingPrimitive[] {
  switch (annotation.kind) {
    case "note":
      return [
        {
          kind: "text",
          x: annotation.anchor.x,
          y: annotation.anchor.y,
          text: annotation.text,
          anchor: "start",
          sizeMm: DRAWING_SMALL_TEXT_HEIGHT_MM,
        },
      ];
    case "leader":
    case "holeCallout":
    case "threadCallout": {
      const tailAngle = Math.atan2(
        annotation.tip.y - annotation.elbow.y,
        annotation.tip.x - annotation.elbow.x,
      );
      const text =
        annotation.kind === "leader"
          ? annotation.text
          : annotation.kind === "holeCallout"
            ? holeCalloutText(annotation.diameterMm, annotation.depthMm)
            : threadCalloutText(annotation.designation, annotation.depthMm);
      return [
        {
          kind: "line",
          x1: annotation.elbow.x,
          y1: annotation.elbow.y,
          x2: annotation.tip.x,
          y2: annotation.tip.y,
        },
        arrowAt(annotation.tip.x, annotation.tip.y, tailAngle),
        {
          kind: "line",
          x1: annotation.elbow.x,
          y1: annotation.elbow.y,
          x2: annotation.elbow.x + DRAWING_SMALL_TEXT_HEIGHT_MM * 2,
          y2: annotation.elbow.y,
        },
        {
          kind: "text",
          x: annotation.elbow.x + DRAWING_SMALL_TEXT_HEIGHT_MM * 2.5,
          y: annotation.elbow.y + DRAWING_SMALL_TEXT_HEIGHT_MM / 2,
          text,
          anchor: "start",
          sizeMm: DRAWING_SMALL_TEXT_HEIGHT_MM,
        },
      ];
    }
    case "featureControlFrame": {
      const cell = DRAWING_SMALL_TEXT_HEIGHT_MM * 2;
      const symbol = GDNT_SYMBOLS[annotation.characteristic] ?? "?";
      const datumCells = annotation.datumRefs.length;
      const width = cell * (2 + datumCells);
      const primitives: DrawingPrimitive[] = [
        {
          kind: "rect",
          x: annotation.anchor.x,
          y: annotation.anchor.y,
          width,
          height: cell,
        },
        {
          kind: "line",
          x1: annotation.anchor.x + cell,
          y1: annotation.anchor.y,
          x2: annotation.anchor.x + cell,
          y2: annotation.anchor.y + cell,
        },
        {
          kind: "text",
          x: annotation.anchor.x + cell / 2,
          y: annotation.anchor.y + cell / 2,
          text: symbol,
          anchor: "middle",
          sizeMm: DRAWING_SMALL_TEXT_HEIGHT_MM,
        },
        {
          kind: "text",
          x: annotation.anchor.x + cell * 1.5,
          y: annotation.anchor.y + cell / 2,
          text: formatDimensionValue(annotation.toleranceMm, "mm"),
          anchor: "middle",
          sizeMm: DRAWING_SMALL_TEXT_HEIGHT_MM,
        },
      ];
      for (let index = 0; index < datumCells; index += 1) {
        const cellX = annotation.anchor.x + cell * (2 + index);
        primitives.push({
          kind: "line",
          x1: cellX,
          y1: annotation.anchor.y,
          x2: cellX,
          y2: annotation.anchor.y + cell,
        });
        primitives.push({
          kind: "text",
          x: cellX + cell / 2,
          y: annotation.anchor.y + cell / 2,
          text: annotation.datumRefs[index] ?? "",
          anchor: "middle",
          sizeMm: DRAWING_SMALL_TEXT_HEIGHT_MM,
        });
      }
      return primitives;
    }
  }
}

/** The hole callout's fixed text: diameter + optional depth. */
export function holeCalloutText(
  diameterMm: number,
  depthMm: number | null,
): string {
  const diameter = `\u2300${formatDimensionValue(diameterMm, "mm")}`;
  return depthMm === null
    ? diameter
    : `${diameter} \u2193 ${formatDimensionValue(depthMm, "mm")}`;
}

/** The thread callout's fixed text: designation + optional depth. */
export function threadCalloutText(
  designation: string,
  depthMm: number | null,
): string {
  return depthMm === null
    ? designation
    : `${designation} \u2193 ${formatDimensionValue(depthMm, "mm")}`;
}

/**
 * Presents the sheet furniture: the frame border, the title block grid
 * (bottom-right), and the revision table (top-right, newest last). All
 * layout is closed-form in the sheet dimensions — no display state.
 */
export function presentSheetFurniture(
  setup: DrawingSheetSetup,
  titleBlock: DrawingTitleBlock,
  revisions: readonly DrawingRevisionRow[],
  frameMarginMm: number = DRAWING_FRAME_MARGIN_MM,
): readonly DrawingPrimitive[] {
  const { widthMm, heightMm } = sheetDimensionsMm(setup);
  const frameX = frameMarginMm;
  const frameY = frameMarginMm;
  const frameW = widthMm - frameMarginMm * 2;
  const frameH = heightMm - frameMarginMm * 2;
  const primitives: DrawingPrimitive[] = [
    {
      kind: "rect",
      x: frameX,
      y: frameY,
      width: frameW,
      height: frameH,
      class: "dg-frame",
    },
  ];
  // Title block: bottom-right, three stacked rows of fixed labels.
  const tbW = frameW * DRAWING_TITLE_BLOCK_WIDTH_FRACTION;
  const tbH = DRAWING_TITLE_BLOCK_HEIGHT_MM;
  const tbX = frameX + frameW - tbW;
  const tbY = frameY;
  primitives.push({ kind: "rect", x: tbX, y: tbY, width: tbW, height: tbH });
  primitives.push({
    kind: "line",
    x1: tbX,
    y1: tbY + tbH / 3,
    x2: tbX + tbW,
    y2: tbY + tbH / 3,
  });
  primitives.push({
    kind: "line",
    x1: tbX,
    y1: tbY + (tbH * 2) / 3,
    x2: tbX + tbW,
    y2: tbY + (tbH * 2) / 3,
  });
  const label = (text: string, y: number): DrawingPrimitive => ({
    kind: "text",
    x: tbX + 2,
    y: y - 0.6,
    text,
    anchor: "start",
    sizeMm: DRAWING_SMALL_TEXT_HEIGHT_MM,
  });
  primitives.push(label(titleBlock.title, tbY + tbH / 3));
  primitives.push(
    label(
      `AUTHOR ${titleBlock.author}  MATERIAL ${titleBlock.material}`,
      tbY + (tbH * 2) / 3,
    ),
  );
  primitives.push(
    label(
      `MASS ${titleBlock.mass}  SCALE ${titleBlock.scale}  DATE ${titleBlock.date}`,
      tbY + tbH,
    ),
  );
  // Revision table: top-right corner, growing downward, newest last.
  if (revisions.length > 0) {
    const rtW = frameW * DRAWING_REVISION_TABLE_WIDTH_FRACTION;
    const rtX = frameX + frameW - rtW;
    const rtTop = frameY + frameH;
    let rowY = rtTop;
    for (const row of revisions) {
      primitives.push({
        kind: "rect",
        x: rtX,
        y: rowY - DRAWING_REVISION_ROW_HEIGHT_MM,
        width: rtW,
        height: DRAWING_REVISION_ROW_HEIGHT_MM,
      });
      primitives.push({
        kind: "text",
        x: rtX + 2,
        y: rowY - DRAWING_REVISION_ROW_HEIGHT_MM / 2 - 0.6,
        text: `${row.revision}  ${row.description}  ${row.author}  ${row.date}`,
        anchor: "start",
        sizeMm: DRAWING_SMALL_TEXT_HEIGHT_MM,
      });
      rowY -= DRAWING_REVISION_ROW_HEIGHT_MM;
    }
  }
  return primitives;
}

/**
 * Composes the whole sheet's presentation in the fixed order: furniture,
 * dimensions (id order), annotations (id order). This is the ONE function
 * both the live canvas and the SVG exporter consume, so what the author
 * sees is byte-for-byte what exports.
 */
export function composeSheetPresentation(
  setup: DrawingSheetSetup,
  titleBlock: DrawingTitleBlock,
  revisions: readonly DrawingRevisionRow[],
  dimensions: readonly DrawingDimension[],
  annotations: readonly DrawingAnnotation[],
  frameMarginMm: number = DRAWING_FRAME_MARGIN_MM,
): readonly DrawingPrimitive[] {
  return [
    ...presentSheetFurniture(setup, titleBlock, revisions, frameMarginMm),
    ...[...dimensions]
      .sort((a, b) => compareDrawingId(a.id, b.id))
      .flatMap(presentDrawingDimension),
    ...[...annotations]
      .sort((a, b) => compareDrawingId(a.id, b.id))
      .flatMap(presentDrawingAnnotation),
  ];
}
