/**
 * The drawing document model (Phase 53 — Drawings I): sheets and views.
 *
 * A drawing is a document-resident collection of SHEETS; each sheet is a
 * standard ISO 216 A-series size (A0–A4) in a portrait or landscape
 * orientation with a default scale, and carries a list of VIEW records. A
 * view is a base projection of one model body — front, top, right, or
 * isometric — placed at a point on the sheet (the projected geometry's
 * centre, in sheet millimetres), drawn at the sheet's scale unless it
 * declares its own, and optionally ALIGNED to a parent base view.
 *
 * ## Alignment (first/third angle)
 *
 * {@link alignedViewPlacement} places an aligned view relative to its parent
 * using one of the two documented conventions: THIRD angle (ISO/US — the top
 * view sits above the front view, the right view to its right) and FIRST
 * angle (ISO A — top below, right to the left). Sheet coordinates are
 * top-down (screen convention): smaller y is higher on the paper. The gap between the views'
 * nearest frame edges is `gapMm` (sheet mm), and the aligned axis keeps the
 * projected geometry registered with the parent (a top view shares the
 * parent's x centre; a right view shares its y centre), which is the
 * property the e2e layout round-trip pins.
 *
 * ## Wire format
 *
 * {@link serializeDrawingDocument} emits a fixed-shape, fixed-key-order JSON
 * object stamped with {@link CAD_DRAWING_FORMAT_VERSION};
 * {@link parseDrawingDocument} validates every field strictly (stable
 * `drawing/*` failure codes) and round-trips exactly. Unknown fields are
 * ignored, so future versions deserialize without corruption — the same
 * discipline every cad-core substrate serializer follows.
 *
 * ## What the format deliberately does NOT carry
 *
 * Projected edge geometry. A view's geometry is DERIVED from the body by
 * the kernel (`drawingView`) or the deterministic overlay fallback — the
 * native-format hard rule that derived kernel objects never become canonical
 * applies unchanged: the view record persists placement, scale, direction
 * convention, and source, never the polyline set.
 */

import { CAD_ID_MAX_PAYLOAD_LENGTH } from "./ids";
import {
  type BodyId,
  type DrawingViewId,
  type SheetId,
  parseBodyId,
  parseDrawingViewId,
  parseSheetId,
} from "./ids";
import { type ParseResult, fail, ok } from "./result";

/** The drawing wire format's own version stamp. */
export const CAD_DRAWING_FORMAT_VERSION = 1;

/** The standard sheet sizes (ISO 216 A series, in millimetres, portrait). */
export const DRAWING_SHEET_SIZES = {
  A0: { width: 841, height: 1189 },
  A1: { width: 594, height: 841 },
  A2: { width: 420, height: 594 },
  A3: { width: 297, height: 420 },
  A4: { width: 210, height: 297 },
} as const;

/** A drawing sheet size standard. */
export type DrawingSheetSize = keyof typeof DRAWING_SHEET_SIZES;

/** The ordered list of sheet size standards. */
export const DRAWING_SHEET_SIZE_NAMES = Object.keys(
  DRAWING_SHEET_SIZES,
) as readonly DrawingSheetSize[];

/** Sheet orientation: portrait keeps the standard's h > w; landscape swaps. */
export type DrawingSheetOrientation = "portrait" | "landscape";

/** The standard drawing scale ratios (numerator : denominator). */
export const DRAWING_SCALES = [
  { numerator: 1, denominator: 10 },
  { numerator: 1, denominator: 5 },
  { numerator: 1, denominator: 2 },
  { numerator: 1, denominator: 1 },
  { numerator: 2, denominator: 1 },
  { numerator: 5, denominator: 1 },
  { numerator: 10, denominator: 1 },
] as const;

/** One standard drawing scale ratio. */
export interface DrawingScale {
  readonly numerator: number;
  readonly denominator: number;
}

/** The base view kinds a drawing view can project (Phase 53 vocabulary). */
export type DrawingViewKind = "front" | "top" | "right" | "isometric";

/** The ordered base view kinds. */
export const DRAWING_VIEW_KINDS = [
  "front",
  "top",
  "right",
  "isometric",
] as const;

/**
 * The projection-angle conventions {@link alignedViewPlacement} places by.
 */
export type DrawingProjectionAngle = "first" | "third";

/**
 * One drawing view record: WHERE a projection of one body goes on a sheet —
 * never the projection itself (see module docs).
 */
export interface DrawingView {
  readonly id: DrawingViewId;
  /** The base projection kind (fixes the view direction — see below). */
  readonly kind: DrawingViewKind;
  /** The model body the view projects. */
  readonly bodyId: BodyId;
  /** Sheet x of the projected geometry's centre, millimetres. */
  readonly x: number;
  /** Sheet y of the projected geometry's centre, millimetres. */
  readonly y: number;
  /** The view's scale (overrides the sheet default when present). */
  readonly scale: DrawingScale | null;
  /** The parent base view this view is aligned to, when aligned. */
  readonly alignedTo: DrawingViewId | null;
}

/** One drawing sheet: a size, an orientation, a default scale, and views. */
export interface DrawingSheet {
  readonly id: SheetId;
  readonly size: DrawingSheetSize;
  readonly orientation: DrawingSheetOrientation;
  readonly scale: DrawingScale;
  readonly views: readonly DrawingView[];
}

/** A whole drawing: the document-resident sheet collection. */
export interface DrawingDocument {
  readonly sheets: readonly DrawingSheet[];
}

/** Canonical JSON forms (fixed key order — see module docs). */
export interface SerializedDrawingScale {
  readonly numerator: number;
  readonly denominator: number;
}

export interface SerializedDrawingView {
  readonly id: string;
  readonly kind: string;
  readonly bodyId: string;
  readonly x: number;
  readonly y: number;
  readonly scale: SerializedDrawingScale | null;
  readonly alignedTo: string | null;
}

export interface SerializedDrawingSheet {
  readonly id: string;
  readonly size: string;
  readonly orientation: string;
  readonly scale: SerializedDrawingScale;
  readonly views: readonly SerializedDrawingView[];
}

export interface SerializedDrawingDocument {
  readonly formatVersion: number;
  readonly sheets: readonly SerializedDrawingSheet[];
}

/** Stable failure codes produced when a drawing document is rejected. */
export const DRAWING_ERROR_CODES = {
  malformed: "drawing/malformed",
  versionInvalid: "drawing/version-invalid",
  unknownSheetSize: "drawing/unknown-sheet-size",
  unknownOrientation: "drawing/unknown-orientation",
  invalidScale: "drawing/invalid-scale",
  unknownViewKind: "drawing/unknown-view-kind",
  invalidViewId: "drawing/invalid-view-id",
  invalidSheetId: "drawing/invalid-sheet-id",
  invalidBodyId: "drawing/invalid-body-id",
  unknownAlignmentTarget: "drawing/unknown-alignment-target",
  duplicateViewId: "drawing/duplicate-view-id",
  viewOffSheet: "drawing/view-off-sheet",
} as const;

export type DrawingErrorCode =
  (typeof DRAWING_ERROR_CODES)[keyof typeof DRAWING_ERROR_CODES];

export interface DrawingError {
  readonly code: DrawingErrorCode;
  readonly message: string;
  /** The rejected input, retained for diagnostics (the ParseFailure law). */
  readonly input: unknown;
}

/**
 * The canonical view directions: the EYE direction — the unit vector from
 * the body toward the viewer — for each base view kind, in world axes.
 * Front views the XZ plane from -Y (the object's front faces -Y), top views
 * the XY plane from +Z, right views the YZ plane from +X, and isometric
 * views from the (+, +, +) corner. These are the Phase 39 datum-plane frame
 * conventions carried to drawings: the same axis vocabulary the datum
 * planes name, so a "front" datum plane and a "front" view agree by
 * construction.
 */
export const DRAWING_VIEW_EYE_DIRECTIONS: Readonly<
  Record<DrawingViewKind, readonly [number, number, number]>
> = {
  front: [0, -1, 0],
  top: [0, 0, 1],
  right: [1, 0, 0],
  isometric: [1 / Math.sqrt(3), 1 / Math.sqrt(3), 1 / Math.sqrt(3)],
};

/**
 * The canonical up hints per view kind (world axes). The top view's up is
 * +Y: in a third-angle layout the top view's projected sheet-up matches the
 * alignment rule's registered x axis.
 */
export const DRAWING_VIEW_UP_HINTS: Readonly<
  Record<DrawingViewKind, readonly [number, number, number]>
> = {
  front: [0, 0, 1],
  top: [0, 1, 0],
  right: [0, 0, 1],
  isometric: [0, 0, 1],
};

/** A view basis: the sheet-right and sheet-up unit vectors in world axes. */
export interface ViewBasis {
  /** Sheet-right unit vector (world axes). */
  readonly right: readonly [number, number, number];
  /** Sheet-up unit vector (world axes). */
  readonly up: readonly [number, number, number];
  /** The look direction — from the eye toward the body (world axes). */
  readonly look: readonly [number, number, number];
}

/**
 * Derives a view's on-sheet basis from its eye direction and up hint: up is
 * purified with one Gram-Schmidt step, right = up x eye, look = -eye. For
 * every base kind this yields the documented conventions (front: sheet
 * right +X, sheet up +Z; top: +X, +Y; right: +Y, +Z) and each (right, up,
 * eye) triple is right-handed, so the projected frame is consistent.
 */
export function viewBasis(
  eye: readonly [number, number, number],
  upHint: readonly [number, number, number],
): ViewBasis {
  const eyeNorm = norm3(eye);
  const eyeUnit: [number, number, number] = [
    eye[0] / eyeNorm,
    eye[1] / eyeNorm,
    eye[2] / eyeNorm,
  ];
  const upNorm = norm3(upHint);
  const dot =
    (upHint[0] * eyeUnit[0] + upHint[1] * eyeUnit[1] + upHint[2] * eyeUnit[2]) /
    upNorm;
  const upRaw: [number, number, number] = [
    upHint[0] / upNorm - dot * eyeUnit[0],
    upHint[1] / upNorm - dot * eyeUnit[1],
    upHint[2] / upNorm - dot * eyeUnit[2],
  ];
  const upLen = norm3(upRaw);
  const up: [number, number, number] = [
    upRaw[0] / upLen,
    upRaw[1] / upLen,
    upRaw[2] / upLen,
  ];
  const right = cross3(up, eyeUnit);
  return { right, up, look: [-eyeUnit[0], -eyeUnit[1], -eyeUnit[2]] };
}

/** The view basis for a base view kind (the documented conventions). */
export function viewBasisForKind(kind: DrawingViewKind): ViewBasis {
  return viewBasis(
    DRAWING_VIEW_EYE_DIRECTIONS[kind],
    DRAWING_VIEW_UP_HINTS[kind],
  );
}

/**
 * Places an aligned view relative to its parent under a projection-angle
 * convention (see module docs). `gapMm` is the sheet-millimetre gap between
 * the views' nearest FRAME edges — for the kinds Phase 53 aligns (top and
 * right to a front parent) the frames are the parent's frame inflated by
 * the gap on the aligned side. The aligned axis keeps both views' centres
 * registered on the shared axis (top: same x; right: same y).
 */
export function alignedViewPlacement(
  kind: DrawingViewKind,
  parent: {
    readonly x: number;
    readonly y: number;
    readonly kind: DrawingViewKind;
  },
  angle: DrawingProjectionAngle,
  parentFrame: { readonly width: number; readonly height: number },
  viewFrame: { readonly width: number; readonly height: number },
  gapMm: number,
): { readonly x: number; readonly y: number } {
  // Sheet coordinates are TOP-DOWN (the screen/SVG convention the drawing
  // canvas serializes 1:1): smaller y is higher on the paper. Third angle
  // therefore places the top view at a SMALLER y (above the front view)
  // and the right view at a LARGER x (to its right); first angle mirrors
  // both (top below, right to the left).
  const s = angle === "third" ? 1 : -1;
  if (kind === "top") {
    const y =
      parent.y - s * (parentFrame.height / 2 + gapMm + viewFrame.height / 2);
    return { x: parent.x, y };
  }
  if (kind === "right") {
    const x =
      parent.x + s * (parentFrame.width / 2 + gapMm + viewFrame.width / 2);
    return { x, y: parent.y };
  }
  // Front and isometric views are base views — never aligned.
  return { x: parent.x, y: parent.y };
}

/** The sheet's on-paper dimensions in millimetres (orientation applied). */
export function sheetDimensions(sheet: {
  readonly size: DrawingSheetSize;
  readonly orientation: DrawingSheetOrientation;
}): { readonly width: number; readonly height: number } {
  const standard = DRAWING_SHEET_SIZES[sheet.size];
  return sheet.orientation === "portrait"
    ? { width: standard.width, height: standard.height }
    : { width: standard.height, height: standard.width };
}

/** Multiplies a model-space length by a scale ratio. */
export function scaleLength(lengthMm: number, scale: DrawingScale): number {
  return (lengthMm * scale.numerator) / scale.denominator;
}

// ---------------------------------------------------------------------------
// Parsing / serialization
// ---------------------------------------------------------------------------

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const drawingError = (
  code: DrawingErrorCode,
  message: string,
  input: unknown = null,
): ParseResult<never, DrawingError> => fail({ code, message, input });

function parseScale(input: unknown): ParseResult<DrawingScale, DrawingError> {
  if (!isRecord(input)) {
    return drawingError(
      DRAWING_ERROR_CODES.malformed,
      "A scale must be an object.",
    );
  }
  const { numerator, denominator } = input;
  if (
    typeof numerator !== "number" ||
    !Number.isInteger(numerator) ||
    numerator <= 0
  ) {
    return drawingError(
      DRAWING_ERROR_CODES.invalidScale,
      "A scale numerator must be a positive integer.",
    );
  }
  if (
    typeof denominator !== "number" ||
    !Number.isInteger(denominator) ||
    denominator <= 0
  ) {
    return drawingError(
      DRAWING_ERROR_CODES.invalidScale,
      "A scale denominator must be a positive integer.",
    );
  }
  return ok({ numerator, denominator });
}

function serializeScale(scale: DrawingScale): SerializedDrawingScale {
  return { numerator: scale.numerator, denominator: scale.denominator };
}

function parsePlacement(
  input: unknown,
  what: string,
): ParseResult<number, DrawingError> {
  if (typeof input !== "number" || !Number.isFinite(input)) {
    return drawingError(
      DRAWING_ERROR_CODES.malformed,
      `A view's ${what} must be a finite number.`,
    );
  }
  return ok(input);
}

function parseView(
  input: unknown,
  knownViewIds: ReadonlySet<string>,
): ParseResult<DrawingView, DrawingError> {
  if (!isRecord(input)) {
    return drawingError(
      DRAWING_ERROR_CODES.malformed,
      "A view must be an object.",
    );
  }
  const idResult = parseDrawingViewId(input.id);
  if (!idResult.ok) {
    return drawingError(
      DRAWING_ERROR_CODES.invalidViewId,
      "A view id must be a valid `dwv_` id.",
    );
  }
  const kind = input.kind;
  if (
    typeof kind !== "string" ||
    !DRAWING_VIEW_KINDS.includes(kind as DrawingViewKind)
  ) {
    return drawingError(
      DRAWING_ERROR_CODES.unknownViewKind,
      `A view kind must be one of ${DRAWING_VIEW_KINDS.map((k) => `"${k}"`).join(", ")}.`,
    );
  }
  const bodyIdResult = parseBodyId(input.bodyId);
  if (!bodyIdResult.ok) {
    return drawingError(
      DRAWING_ERROR_CODES.invalidBodyId,
      "A view's bodyId must be a valid `body_` id.",
    );
  }
  const x = input.x;
  if (!isRecord(input) || typeof x !== "number" || !Number.isFinite(x)) {
    return drawingError(
      DRAWING_ERROR_CODES.malformed,
      "A view's x must be a finite number.",
    );
  }
  const yResult = parsePlacement(input.y, "y");
  if (!yResult.ok) return yResult;
  let scale: DrawingScale | null = null;
  if (input.scale !== null) {
    const scaleResult = parseScale(input.scale);
    if (!scaleResult.ok) return scaleResult;
    scale = scaleResult.value;
  }
  let alignedTo: DrawingViewId | null = null;
  if (input.alignedTo !== null) {
    const alignedResult = parseDrawingViewId(input.alignedTo);
    if (!alignedResult.ok) {
      return drawingError(
        DRAWING_ERROR_CODES.invalidViewId,
        "A view's alignedTo must be a valid `dwv_` id or null.",
      );
    }
    if (!knownViewIds.has(alignedResult.value)) {
      return drawingError(
        DRAWING_ERROR_CODES.unknownAlignmentTarget,
        `A view's alignedTo names the unknown view "${String(
          alignedResult.value,
        )}".`,
      );
    }
    alignedTo = alignedResult.value;
  }
  return ok({
    id: idResult.value,
    kind: kind as DrawingViewKind,
    bodyId: bodyIdResult.value,
    x,
    y: yResult.value,
    scale,
    alignedTo,
  });
}

/**
 * Parses untrusted input as a drawing document. Strict on known fields,
 * tolerant of unknown fields (the substrate parser discipline). Alignment
 * targets and view-id uniqueness are validated across the whole document;
 * off-sheet placement is NOT a parse error (geometry is derived later) but
 * is checked by {@link validateDrawingDocument} when sheet dimensions are
 * known.
 */
export function parseDrawingDocument(
  input: unknown,
): ParseResult<DrawingDocument, DrawingError> {
  if (!isRecord(input)) {
    return drawingError(
      DRAWING_ERROR_CODES.malformed,
      "A drawing must be an object.",
    );
  }
  const { formatVersion, sheets } = input;
  if (formatVersion !== CAD_DRAWING_FORMAT_VERSION) {
    return drawingError(
      DRAWING_ERROR_CODES.versionInvalid,
      `A drawing document must carry formatVersion ${CAD_DRAWING_FORMAT_VERSION}.`,
    );
  }
  if (!Array.isArray(sheets)) {
    return drawingError(
      DRAWING_ERROR_CODES.malformed,
      "A drawing document's sheets must be an array.",
    );
  }
  // Views may align to any view on ANY sheet (a sheet carries one part
  // family in practice, but the alignment graph is document-scoped by
  // design — ids are document-scoped), so ids are collected first.
  const knownViewIds = new Set<string>();
  for (const sheet of sheets) {
    if (!isRecord(sheet)) continue;
    const views = sheet.views;
    if (Array.isArray(views)) {
      for (const view of views) {
        if (isRecord(view) && typeof view.id === "string") {
          knownViewIds.add(view.id);
        }
      }
    }
  }
  const parsedSheets: DrawingSheet[] = [];
  for (const sheet of sheets) {
    if (!isRecord(sheet)) {
      return drawingError(
        DRAWING_ERROR_CODES.malformed,
        "A sheet must be an object.",
      );
    }
    const idResult = parseSheetId(sheet.id);
    if (!idResult.ok) {
      return drawingError(
        DRAWING_ERROR_CODES.invalidSheetId,
        "A sheet id must be a valid `sht_` id.",
      );
    }
    const size = sheet.size;
    if (
      typeof size !== "string" ||
      !DRAWING_SHEET_SIZE_NAMES.includes(size as DrawingSheetSize)
    ) {
      return drawingError(
        DRAWING_ERROR_CODES.unknownSheetSize,
        `A sheet size must be one of ${DRAWING_SHEET_SIZE_NAMES.map((s) => `"${s}"`).join(", ")}.`,
      );
    }
    const orientation = sheet.orientation;
    if (orientation !== "portrait" && orientation !== "landscape") {
      return drawingError(
        DRAWING_ERROR_CODES.unknownOrientation,
        'A sheet orientation must be "portrait" or "landscape".',
      );
    }
    const scaleResult = parseScale(sheet.scale);
    if (!scaleResult.ok) return scaleResult;
    if (!Array.isArray(sheet.views)) {
      return drawingError(
        DRAWING_ERROR_CODES.malformed,
        "A sheet's views must be an array.",
      );
    }
    const views: DrawingView[] = [];
    const seen = new Set<string>();
    for (const view of sheet.views) {
      const viewResult = parseView(view, knownViewIds);
      if (!viewResult.ok) return viewResult;
      if (seen.has(viewResult.value.id)) {
        return drawingError(
          DRAWING_ERROR_CODES.duplicateViewId,
          `The view id "${viewResult.value.id}" appears twice.`,
        );
      }
      seen.add(viewResult.value.id);
      views.push(viewResult.value);
    }
    parsedSheets.push({
      id: idResult.value,
      size: size as DrawingSheetSize,
      orientation,
      scale: scaleResult.value,
      views,
    });
  }
  return ok({ sheets: parsedSheets });
}

/**
 * Serializes a drawing document to the canonical fixed-key-order JSON shape.
 * Fields are emitted in declaration order — `formatVersion`, `sheets`, and
 * per sheet `id`, `size`, `orientation`, `scale`, `views`, per view `id`,
 * `kind`, `bodyId`, `x`, `y`, `scale`, `alignedTo` — so the same document
 * always serializes to identical bytes.
 */
export function serializeDrawingDocument(
  drawing: DrawingDocument,
): SerializedDrawingDocument {
  return {
    formatVersion: CAD_DRAWING_FORMAT_VERSION,
    sheets: drawing.sheets.map((sheet) => ({
      id: sheet.id,
      size: sheet.size,
      orientation: sheet.orientation,
      scale: serializeScale(sheet.scale),
      views: sheet.views.map((view) => ({
        id: view.id,
        kind: view.kind,
        bodyId: view.bodyId,
        x: view.x,
        y: view.y,
        scale: view.scale === null ? null : serializeScale(view.scale),
        alignedTo: view.alignedTo,
      })),
    })),
  };
}

/** Round-trips a drawing document through its canonical JSON shape. */
export function roundTripDrawingDocument(
  drawing: DrawingDocument,
): ParseResult<DrawingDocument, DrawingError> {
  return parseDrawingDocument(serializeDrawingDocument(drawing));
}

/** The framing a projected view occupies on its sheet, millimetres. */
export interface ViewFrame {
  /** The frame's centre — the view record's placement. */
  readonly x: number;
  readonly y: number;
  /** The SCALED projected geometry's extent, sheet millimetres. */
  readonly width: number;
  readonly height: number;
}

/**
 * Computes a view's frame from the projected geometry's model-space bounds
 * (from {@link DrawingViewGeometry.bounds} or the overlay fallback) and the
 * effective scale. Returns `null` when the geometry is empty.
 */
export function viewFrameFromGeometry(
  view: DrawingView,
  sheet: DrawingSheet,
  geometryBounds: {
    readonly minU: number;
    readonly maxU: number;
    readonly minV: number;
    readonly maxV: number;
  } | null,
): ViewFrame | null {
  if (geometryBounds === null) return null;
  const scale = view.scale ?? sheet.scale;
  const width = scaleLength(geometryBounds.maxU - geometryBounds.minU, scale);
  const height = scaleLength(geometryBounds.maxV - geometryBounds.minV, scale);
  if (!(Number.isFinite(width) && Number.isFinite(height))) return null;
  return { x: view.x, y: view.y, width, height };
}

/**
 * Whether a frame fits its sheet with a margin (the drawing frame inset).
 * The margin is the standard 10 mm sheet border; a frame exactly touching
 * the border passes. Placement validation needs each view's projected
 * extent — derived geometry — so the parser cannot own it; the canvas
 * validates frames via {@link viewFrameFromGeometry} + this check.
 */
export function viewFitsSheet(
  frame: ViewFrame,
  sheet: {
    readonly size: DrawingSheetSize;
    readonly orientation: DrawingSheetOrientation;
  },
  marginMm = 10,
): boolean {
  const { width, height } = sheetDimensions(sheet);
  return (
    frame.x - frame.width / 2 >= marginMm &&
    frame.x + frame.width / 2 <= width - marginMm &&
    frame.y - frame.height / 2 >= marginMm &&
    frame.y + frame.height / 2 <= height - marginMm
  );
}

/** One projected 2D polyline chain in VIEW-PLANE model millimetres. */
export type ProjectedChain = readonly (readonly [number, number])[];

/**
 * The projected geometry of one drawing view: the visible and hidden edge
 * chains in VIEW-PLANE model millimetres (u along the view's right basis,
 * v along its up basis), the geometry's bounds in the same coordinates, and
 * a fidelity class.
 *
 * - `"hlr-exact"` — exact hidden-line removal (the OCCT `HLRBRep` route):
 *   visible chains are exactly the visible edges (sharp + outline), hidden
 *   chains exactly the hidden ones; analytic curve geometry is walked at the
 *   deterministic station rule, so the polylines are exact at each station.
 * - `"edges-overlay"` — the mesh-kernel fallback: feature/silhouette edges
 *   projected orthographically with NO hidden-line removal — every chain is
 *   drawn as visible, `hidden` is empty, and interior edges may be drawn
 *   that an exact HLR would occlude. The fidelity class exists precisely so
 *   callers never have to guess which they got.
 */
export interface DrawingViewGeometry {
  readonly fidelity: "hlr-exact" | "edges-overlay";
  readonly visible: readonly ProjectedChain[];
  readonly hidden: readonly ProjectedChain[];
  /** Model-space bounds of the projected geometry (all chains, both sets). */
  readonly bounds: {
    readonly minU: number;
    readonly maxU: number;
    readonly minV: number;
    readonly maxV: number;
  } | null;
}

function norm3(
  v: readonly [number, number, number] | readonly number[],
): number {
  return Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
}

function cross3(
  a: readonly [number, number, number],
  b: readonly [number, number, number],
): [number, number, number] {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

/** Exposed for the kernel adapter: `dwv_` payload validation shares the id rules. */
export const DRAWING_ID_MAX_PAYLOAD_LENGTH = CAD_ID_MAX_PAYLOAD_LENGTH;
