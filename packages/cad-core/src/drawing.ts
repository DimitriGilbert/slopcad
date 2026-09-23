/**
 * The drawing document model (Phase 53 — Drawings I; Phase 55 — Drawings
 * III): sheets, views, and callouts.
 *
 * A drawing is a document-resident collection of SHEETS; each sheet is a
 * standard ISO 216 A-series size (A0–A4) in a portrait or landscape
 * orientation with a default scale, and carries a list of VIEW records. A
 * view is a base projection of one model body — front, top, right, or
 * isometric — placed at a point on the sheet (the projected geometry's
 * centre, in sheet millimetres), drawn at the sheet's scale unless it
 * declares its own, and optionally ALIGNED to a parent base view.
 *
 * Phase 55 extends the record vocabulary additively (every field
 * wire-absent in its Phase 53 form): a view may carry a
 * {@link DrawingViewProjection} — projected (fold-line), auxiliary,
 * section, detail, or broken-out — and a label; a sheet may carry BOM
 * tables ({@link DrawingBomTable}, rows resolved from the Phase 50
 * occurrence structure by {@link numberBomItems}) and balloons
 * ({@link DrawingBalloon}) keyed to occurrences.
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
  type ConfigurationId,
  type DrawingViewId,
  type OccurrenceId,
  type SheetId,
  parseBodyId,
  parseConfigurationId,
  parseDrawingViewId,
  parseOccurrenceId,
  parseSheetId,
} from "./ids";
import { type OccurrenceBomFlag } from "./document";
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
 * The fold directions a PROJECTED view can fold to (Phase 55). The base
 * vocabulary already owns top/right; the fold-line method adds the views
 * the base list lacks — left, back, bottom — each derived from a parent
 * view's basis by a 90° fold (see `projectedViewBasis` in
 * `drawing-section.ts`).
 */
export type DrawingProjectedDirection = "left" | "back" | "bottom";

/** The ordered fold directions. */
export const DRAWING_PROJECTED_DIRECTIONS = ["left", "back", "bottom"] as const;

/**
 * How a view's direction and geometry are DERIVED (Phase 55). `absent`
 * means a Phase 53 base view: the view's `kind` fixes the projection.
 * Every other method derives the view from a parent view and/or a plane,
 * all in the view-plane model-millimetre vocabulary the base views use:
 *
 * - `projected` — the fold-line method: a 90° fold of the parent's basis
 *   to the given direction (left/back/bottom).
 * - `auxiliary` — an auxiliary view from an inclined EDGE (two world
 *   endpoints): the view looks along the in-parent-plane direction
 *   perpendicular to the edge, with the edge as the sheet-up axis, so the
 *   edge shows true length.
 * - `section` — a full section view through a plane (the Phase 46
 *   section-record vocabulary: origin, normal, kept side): the kept side's
 *   projected edges plus deterministic 45°-style hatching of the cut face.
 * - `detail` — a circular crop of the parent's projected geometry (centre
 *   and radius in the parent's view-plane model millimetres), typically at
 *   an enlarged per-view scale.
 * - `broken-out` — a section hatch restricted to a band of the parent's
 *   geometry (`bandMinU`..`bandMaxU`, view-plane model millimetres); the
 *   rest of the view stays unsectioned.
 */
export type DrawingViewProjection =
  | {
      readonly method: "projected";
      readonly parentViewId: DrawingViewId;
      readonly direction: DrawingProjectedDirection;
    }
  | {
      readonly method: "auxiliary";
      readonly parentViewId: DrawingViewId;
      readonly edgeFrom: readonly [number, number, number];
      readonly edgeTo: readonly [number, number, number];
    }
  | {
      readonly method: "section";
      readonly planeOrigin: readonly [number, number, number];
      readonly planeNormal: readonly [number, number, number];
      readonly keepSide: 1 | -1;
      readonly hatchSpacingMm: number;
      readonly hatchAngleRad: number;
    }
  | {
      readonly method: "detail";
      readonly parentViewId: DrawingViewId;
      readonly centreU: number;
      readonly centreV: number;
      readonly radiusMm: number;
    }
  | {
      readonly method: "broken-out";
      readonly parentViewId: DrawingViewId;
      readonly bandMinU: number;
      readonly bandMaxU: number;
      readonly planeOrigin: readonly [number, number, number];
      readonly planeNormal: readonly [number, number, number];
      readonly keepSide: 1 | -1;
      readonly hatchSpacingMm: number;
    };

/** The ordered projection methods (parser and UI vocabulary). */
export const DRAWING_PROJECTION_METHODS = [
  "projected",
  "auxiliary",
  "section",
  "detail",
  "broken-out",
] as const;

export type DrawingProjectionMethod =
  (typeof DRAWING_PROJECTION_METHODS)[number];

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
  /**
   * The view's authored label ("SECTION A-A", "DETAIL B (2:1)") — present
   * exactly when non-empty (the bomFlag wire-absent precedent), so a
   * label-less view serializes byte-identically to its Phase 53 form.
   */
  readonly label?: string;
  /**
   * The Phase 55 projection derivation — present exactly when the view is
   * NOT a plain base view (absent keeps the Phase 53 wire form). The
   * geometry is still derived, never persisted (module docs).
   */
  readonly projection?: DrawingViewProjection;
  /**
   * The configuration the view is pinned to (Phase 57-additive): the view's
   * projection resolves its model state through that configuration's
   * effective parameter view instead of the document's base values. Absent
   * = the view projects the base document (every pre-Phase-57 view), so
   * unpinned views serialize byte-identically to their earlier form and an
   * old reader's tolerant parse drops the field. Wire shape is validated at
   * the drawing boundary; the pin naming a configuration the document
   * actually has is the native envelope's cross-check.
   */
  readonly configurationId?: ConfigurationId;
}

/**
 * One BOM table row: one numbered item line, resolved from the assembly's
 * occurrence structure (Phase 50) by `numberBomItems`. The row persists the
 * RESOLVED numbering — a drawing's BOM must not silently renumber when the
 * source assembly gains occurrences; re-derivation is an explicit
 * authoring act.
 */
export interface DrawingBomRow {
  /** The deterministic 1-based item number (see `numberBomItems`). */
  readonly item: number;
  /** The occurrence the row answers. */
  readonly occurrenceId: OccurrenceId;
  /** The item label (the occurrence's name at derivation time). */
  readonly label: string;
  /** The occurrence's structure flag when non-default. */
  readonly bomFlag: Exclude<OccurrenceBomFlag, "default"> | null;
  /** How many occurrences the row groups (same name, same derivation). */
  readonly quantity: number;
}

/**
 * One BOM table on a sheet: its anchor (TOP-LEFT corner, sheet millimetres,
 * top-down) and its resolved rows. Rows render top to bottom in item order.
 */
export interface DrawingBomTable {
  readonly x: number;
  readonly y: number;
  readonly title: string | null;
  readonly rows: readonly DrawingBomRow[];
}

/**
 * One balloon: a keyed circle anchored at sheet millimetres with a leader
 * to the geometry it calls out. The balloon's ITEM number resolves at
 * render time from the sheet's BOM tables by occurrence id (the first
 * table whose rows contain it); a balloon with no matching row renders
 * without a number rather than a fabricated one.
 */
export interface DrawingBalloon {
  readonly occurrenceId: OccurrenceId;
  /** Balloon centre, sheet millimetres. */
  readonly x: number;
  readonly y: number;
  /** Leader tip (the called-out point), sheet millimetres. */
  readonly leaderX: number;
  readonly leaderY: number;
  /** The view the leader points into, when it points into one. */
  readonly viewId: DrawingViewId | null;
}

/** One drawing sheet: a size, an orientation, a default scale, and views. */
export interface DrawingSheet {
  readonly id: SheetId;
  readonly size: DrawingSheetSize;
  readonly orientation: DrawingSheetOrientation;
  readonly scale: DrawingScale;
  readonly views: readonly DrawingView[];
  /** The sheet's BOM tables, in add order (Phase 55; wire-absent = none). */
  readonly bomTables?: readonly DrawingBomTable[];
  /** The sheet's balloons, in add order (Phase 55; wire-absent = none). */
  readonly balloons?: readonly DrawingBalloon[];
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
  /** Present exactly when the view carries a label (wire-absent = none). */
  readonly label?: string;
  /** Present exactly when the view has a Phase 55 projection derivation. */
  readonly projection?: Record<string, unknown>;
  /** Present exactly when the view pins a configuration (additive). */
  readonly configurationId?: string;
}

export interface SerializedDrawingBomRow {
  readonly item: number;
  readonly occurrenceId: string;
  readonly label: string;
  readonly bomFlag: string | null;
  readonly quantity: number;
}

export interface SerializedDrawingBomTable {
  readonly x: number;
  readonly y: number;
  readonly title: string | null;
  readonly rows: readonly SerializedDrawingBomRow[];
}

export interface SerializedDrawingBalloon {
  readonly occurrenceId: string;
  readonly x: number;
  readonly y: number;
  readonly leaderX: number;
  readonly leaderY: number;
  readonly viewId: string | null;
}

export interface SerializedDrawingSheet {
  readonly id: string;
  readonly size: string;
  readonly orientation: string;
  readonly scale: SerializedDrawingScale;
  readonly views: readonly SerializedDrawingView[];
  /** Present exactly when the sheet carries BOM tables (never empty). */
  readonly bomTables?: readonly SerializedDrawingBomTable[];
  /** Present exactly when the sheet carries balloons (never empty). */
  readonly balloons?: readonly SerializedDrawingBalloon[];
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
  projectionMethodUnknown: "drawing/projection-method-unknown",
  projectionInvalid: "drawing/projection-invalid",
  projectionParentUnknown: "drawing/projection-parent-unknown",
  invalidOccurrenceId: "drawing/invalid-occurrence-id",
  bomTableInvalid: "drawing/bom-table-invalid",
  balloonInvalid: "drawing/balloon-invalid",
  invalidConfigurationPin: "drawing/invalid-configuration-pin",
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

/** Parses a finite world-space point triple (projection plane/edge fields). */
function parsePoint3(
  input: unknown,
  what: string,
): ParseResult<[number, number, number], DrawingError> {
  if (
    !Array.isArray(input) ||
    input.length !== 3 ||
    input.some((v) => typeof v !== "number" || !Number.isFinite(v))
  ) {
    return drawingError(
      DRAWING_ERROR_CODES.projectionInvalid,
      `A projection's ${what} must be an array of three finite numbers.`,
    );
  }
  return ok(input as [number, number, number]);
}

function parseFiniteField(
  source: Record<string, unknown>,
  key: string,
  what: string,
): ParseResult<number, DrawingError> {
  const value = source[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return drawingError(
      DRAWING_ERROR_CODES.projectionInvalid,
      `A projection's ${what} must be a finite number.`,
    );
  }
  return ok(value);
}

function parsePositiveField(
  source: Record<string, unknown>,
  key: string,
  what: string,
): ParseResult<number, DrawingError> {
  const value = source[key];
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return drawingError(
      DRAWING_ERROR_CODES.projectionInvalid,
      `A projection's ${what} must be a positive finite number.`,
    );
  }
  return ok(value);
}

function parseKeepSide(
  source: Record<string, unknown>,
): ParseResult<1 | -1, DrawingError> {
  if (source.keepSide !== 1 && source.keepSide !== -1) {
    return drawingError(
      DRAWING_ERROR_CODES.projectionInvalid,
      "A projection's keepSide must be 1 or -1.",
    );
  }
  return ok(source.keepSide);
}

function parseProjectionParent(
  input: Record<string, unknown>,
  knownViewIds: ReadonlySet<string>,
): ParseResult<DrawingViewId, DrawingError> {
  const parentResult = parseDrawingViewId(input.parentViewId);
  if (!parentResult.ok) {
    return drawingError(
      DRAWING_ERROR_CODES.invalidViewId,
      "A projection's parentViewId must be a valid `dwv_` id.",
    );
  }
  if (!knownViewIds.has(parentResult.value)) {
    return drawingError(
      DRAWING_ERROR_CODES.projectionParentUnknown,
      `A projection's parentViewId names the unknown view "${String(
        parentResult.value,
      )}".`,
    );
  }
  return parentResult;
}

/**
 * Parses a Phase 55 projection derivation record. Strict on every field of
 * the declared method; the method discriminates which fields must exist.
 */
function parseProjection(
  input: unknown,
  knownViewIds: ReadonlySet<string>,
): ParseResult<DrawingViewProjection, DrawingError> {
  if (!isRecord(input)) {
    return drawingError(
      DRAWING_ERROR_CODES.projectionInvalid,
      "A projection must be an object.",
    );
  }
  const method = input.method;
  if (
    typeof method !== "string" ||
    !DRAWING_PROJECTION_METHODS.includes(method as DrawingProjectionMethod)
  ) {
    return drawingError(
      DRAWING_ERROR_CODES.projectionMethodUnknown,
      `A projection method must be one of ${DRAWING_PROJECTION_METHODS.map((m) => `"${m}"`).join(", ")}.`,
    );
  }
  let parentViewId: DrawingViewId | null = null;
  if (method !== "section") {
    const parent = parseProjectionParent(input, knownViewIds);
    if (!parent.ok) return parent;
    parentViewId = parent.value;
  }
  if (method === "projected") {
    const direction = input.direction;
    if (
      typeof direction !== "string" ||
      !DRAWING_PROJECTED_DIRECTIONS.includes(
        direction as DrawingProjectedDirection,
      )
    ) {
      return drawingError(
        DRAWING_ERROR_CODES.projectionInvalid,
        `A projected view's direction must be one of ${DRAWING_PROJECTED_DIRECTIONS.map((d) => `"${d}"`).join(", ")}.`,
      );
    }
    return ok({
      method,
      parentViewId: parentViewId as DrawingViewId,
      direction: direction as DrawingProjectedDirection,
    });
  }
  if (method === "auxiliary") {
    const edgeFrom = parsePoint3(input.edgeFrom, "edgeFrom");
    if (!edgeFrom.ok) return edgeFrom;
    const edgeTo = parsePoint3(input.edgeTo, "edgeTo");
    if (!edgeTo.ok) return edgeTo;
    return ok({
      method,
      parentViewId: parentViewId as DrawingViewId,
      edgeFrom: edgeFrom.value,
      edgeTo: edgeTo.value,
    });
  }
  if (method === "detail") {
    const centreU = parseFiniteField(input, "centreU", "centreU");
    if (!centreU.ok) return centreU;
    const centreV = parseFiniteField(input, "centreV", "centreV");
    if (!centreV.ok) return centreV;
    const radius = parsePositiveField(input, "radiusMm", "radiusMm");
    if (!radius.ok) return radius;
    return ok({
      method,
      parentViewId: parentViewId as DrawingViewId,
      centreU: centreU.value,
      centreV: centreV.value,
      radiusMm: radius.value,
    });
  }
  if (method === "broken-out") {
    const bandMinU = parseFiniteField(input, "bandMinU", "bandMinU");
    if (!bandMinU.ok) return bandMinU;
    const bandMaxU = parseFiniteField(input, "bandMaxU", "bandMaxU");
    if (!bandMaxU.ok) return bandMaxU;
    const planeOrigin = parsePoint3(input.planeOrigin, "planeOrigin");
    if (!planeOrigin.ok) return planeOrigin;
    const planeNormal = parsePoint3(input.planeNormal, "planeNormal");
    if (!planeNormal.ok) return planeNormal;
    if (planeNormal.value.every((v) => v === 0)) {
      return drawingError(
        DRAWING_ERROR_CODES.projectionInvalid,
        "A projection's planeNormal must be non-zero.",
      );
    }
    const keepSide = parseKeepSide(input);
    if (!keepSide.ok) return keepSide;
    const spacing = parsePositiveField(
      input,
      "hatchSpacingMm",
      "hatchSpacingMm",
    );
    if (!spacing.ok) return spacing;
    return ok({
      method,
      parentViewId: parentViewId as DrawingViewId,
      bandMinU: bandMinU.value,
      bandMaxU: bandMaxU.value,
      planeOrigin: planeOrigin.value,
      planeNormal: planeNormal.value,
      keepSide: keepSide.value,
      hatchSpacingMm: spacing.value,
    });
  }
  // method === "section"
  const planeOrigin = parsePoint3(input.planeOrigin, "planeOrigin");
  if (!planeOrigin.ok) return planeOrigin;
  const planeNormal = parsePoint3(input.planeNormal, "planeNormal");
  if (!planeNormal.ok) return planeNormal;
  if (planeNormal.value.every((v) => v === 0)) {
    return drawingError(
      DRAWING_ERROR_CODES.projectionInvalid,
      "A projection's planeNormal must be non-zero.",
    );
  }
  const keepSide = parseKeepSide(input);
  if (!keepSide.ok) return keepSide;
  const spacing = parsePositiveField(input, "hatchSpacingMm", "hatchSpacingMm");
  if (!spacing.ok) return spacing;
  const angle = parseFiniteField(input, "hatchAngleRad", "hatchAngleRad");
  if (!angle.ok) return angle;
  return ok({
    method: "section",
    planeOrigin: planeOrigin.value,
    planeNormal: planeNormal.value,
    keepSide: keepSide.value,
    hatchSpacingMm: spacing.value,
    hatchAngleRad: angle.value,
  });
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
  // Phase 55 additive fields: wire-absent keeps the Phase 53 form.
  let label: string | undefined;
  if (input.label !== undefined && input.label !== null) {
    if (typeof input.label !== "string" || input.label.length > 64) {
      return drawingError(
        DRAWING_ERROR_CODES.malformed,
        "A view's label must be a string of at most 64 characters.",
      );
    }
    label = input.label;
  }
  let projection: DrawingViewProjection | undefined;
  if (input.projection !== undefined && input.projection !== null) {
    const projectionResult = parseProjection(input.projection, knownViewIds);
    if (!projectionResult.ok) return projectionResult;
    projection = projectionResult.value;
  }
  let configurationId: ConfigurationId | undefined;
  if (input.configurationId !== undefined && input.configurationId !== null) {
    const pinResult = parseConfigurationId(input.configurationId);
    if (!pinResult.ok) {
      return drawingError(
        DRAWING_ERROR_CODES.invalidConfigurationPin,
        "A view's configurationId pin must be a valid `cfg_` id.",
      );
    }
    configurationId = pinResult.value;
  }
  return ok({
    id: idResult.value,
    kind: kind as DrawingViewKind,
    bodyId: bodyIdResult.value,
    x,
    y: yResult.value,
    scale,
    alignedTo,
    ...(label === undefined ? {} : { label }),
    ...(projection === undefined ? {} : { projection }),
    ...(configurationId === undefined ? {} : { configurationId }),
  });
}

/** Parses one BOM row (strict: every field present and well-typed). */
function parseBomRow(input: unknown): ParseResult<DrawingBomRow, DrawingError> {
  if (!isRecord(input)) {
    return drawingError(
      DRAWING_ERROR_CODES.bomTableInvalid,
      "A BOM row must be an object.",
    );
  }
  const item = input.item;
  if (typeof item !== "number" || !Number.isInteger(item) || item <= 0) {
    return drawingError(
      DRAWING_ERROR_CODES.bomTableInvalid,
      "A BOM row's item must be a positive integer.",
    );
  }
  const occurrenceResult = parseOccurrenceId(input.occurrenceId);
  if (!occurrenceResult.ok) {
    return drawingError(
      DRAWING_ERROR_CODES.invalidOccurrenceId,
      "A BOM row's occurrenceId must be a valid `occ_` id.",
    );
  }
  const { label, quantity } = input;
  if (typeof label !== "string" || label.length === 0 || label.length > 64) {
    return drawingError(
      DRAWING_ERROR_CODES.bomTableInvalid,
      "A BOM row's label must be a string of 1-64 characters.",
    );
  }
  if (
    typeof quantity !== "number" ||
    !Number.isInteger(quantity) ||
    quantity <= 0
  ) {
    return drawingError(
      DRAWING_ERROR_CODES.bomTableInvalid,
      "A BOM row's quantity must be a positive integer.",
    );
  }
  let bomFlag: DrawingBomRow["bomFlag"] = null;
  if (input.bomFlag === "phantom" || input.bomFlag === "purchased") {
    bomFlag = input.bomFlag;
  } else if (input.bomFlag !== null) {
    return drawingError(
      DRAWING_ERROR_CODES.bomTableInvalid,
      'A BOM row\'s bomFlag must be "phantom", "purchased", or null.',
    );
  }
  return ok({
    item,
    occurrenceId: occurrenceResult.value,
    label,
    bomFlag,
    quantity,
  });
}

function parseBomTable(
  input: unknown,
): ParseResult<DrawingBomTable, DrawingError> {
  if (!isRecord(input)) {
    return drawingError(
      DRAWING_ERROR_CODES.bomTableInvalid,
      "A BOM table must be an object.",
    );
  }
  const x = parsePlacement(input.x, "x");
  if (!x.ok) {
    return drawingError(
      DRAWING_ERROR_CODES.bomTableInvalid,
      "A BOM table's x must be a finite number.",
    );
  }
  const y = parsePlacement(input.y, "y");
  if (!y.ok) {
    return drawingError(
      DRAWING_ERROR_CODES.bomTableInvalid,
      "A BOM table's y must be a finite number.",
    );
  }
  let title: string | null = null;
  if (input.title !== null) {
    if (typeof input.title !== "string" || input.title.length > 64) {
      return drawingError(
        DRAWING_ERROR_CODES.bomTableInvalid,
        "A BOM table's title must be a string of at most 64 characters or null.",
      );
    }
    title = input.title;
  }
  if (!Array.isArray(input.rows)) {
    return drawingError(
      DRAWING_ERROR_CODES.bomTableInvalid,
      "A BOM table's rows must be an array.",
    );
  }
  const rows: DrawingBomRow[] = [];
  for (const row of input.rows) {
    const parsed = parseBomRow(row);
    if (!parsed.ok) return parsed;
    rows.push(parsed.value);
  }
  return ok({ x: x.value, y: y.value, title, rows });
}

function parseBalloon(
  input: unknown,
): ParseResult<DrawingBalloon, DrawingError> {
  if (!isRecord(input)) {
    return drawingError(
      DRAWING_ERROR_CODES.balloonInvalid,
      "A balloon must be an object.",
    );
  }
  const occurrenceResult = parseOccurrenceId(input.occurrenceId);
  if (!occurrenceResult.ok) {
    return drawingError(
      DRAWING_ERROR_CODES.invalidOccurrenceId,
      "A balloon's occurrenceId must be a valid `occ_` id.",
    );
  }
  const x = parsePlacement(input.x, "x");
  if (!x.ok) {
    return drawingError(
      DRAWING_ERROR_CODES.balloonInvalid,
      "A balloon's x must be a finite number.",
    );
  }
  const y = parsePlacement(input.y, "y");
  if (!y.ok) {
    return drawingError(
      DRAWING_ERROR_CODES.balloonInvalid,
      "A balloon's y must be a finite number.",
    );
  }
  const leaderX = parsePlacement(input.leaderX, "leaderX");
  if (!leaderX.ok) {
    return drawingError(
      DRAWING_ERROR_CODES.balloonInvalid,
      "A balloon's leaderX must be a finite number.",
    );
  }
  const leaderY = parsePlacement(input.leaderY, "leaderY");
  if (!leaderY.ok) {
    return drawingError(
      DRAWING_ERROR_CODES.balloonInvalid,
      "A balloon's leaderY must be a finite number.",
    );
  }
  let viewId: DrawingViewId | null = null;
  if (input.viewId !== null) {
    const viewResult = parseDrawingViewId(input.viewId);
    if (!viewResult.ok) {
      return drawingError(
        DRAWING_ERROR_CODES.invalidViewId,
        "A balloon's viewId must be a valid `dwv_` id or null.",
      );
    }
    viewId = viewResult.value;
  }
  return ok({
    occurrenceId: occurrenceResult.value,
    x: x.value,
    y: y.value,
    leaderX: leaderX.value,
    leaderY: leaderY.value,
    viewId,
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
    // Phase 55 additive collections: wire-absent = none (never serialized
    // as empty arrays, so old sheets round-trip byte-identically).
    let bomTables: DrawingBomTable[] | undefined;
    if (sheet.bomTables !== undefined && sheet.bomTables !== null) {
      if (!Array.isArray(sheet.bomTables)) {
        return drawingError(
          DRAWING_ERROR_CODES.bomTableInvalid,
          "A sheet's bomTables must be an array.",
        );
      }
      const parsedTables: DrawingBomTable[] = [];
      for (const table of sheet.bomTables) {
        const parsed = parseBomTable(table);
        if (!parsed.ok) return parsed;
        parsedTables.push(parsed.value);
      }
      bomTables = parsedTables;
    }
    let balloons: DrawingBalloon[] | undefined;
    if (sheet.balloons !== undefined && sheet.balloons !== null) {
      if (!Array.isArray(sheet.balloons)) {
        return drawingError(
          DRAWING_ERROR_CODES.balloonInvalid,
          "A sheet's balloons must be an array.",
        );
      }
      const parsedBalloons: DrawingBalloon[] = [];
      for (const balloon of sheet.balloons) {
        const parsed = parseBalloon(balloon);
        if (!parsed.ok) return parsed;
        parsedBalloons.push(parsed.value);
      }
      balloons = parsedBalloons;
    }
    parsedSheets.push({
      id: idResult.value,
      size: size as DrawingSheetSize,
      orientation,
      scale: scaleResult.value,
      views,
      ...(bomTables === undefined ? {} : { bomTables }),
      ...(balloons === undefined ? {} : { balloons }),
    });
  }
  return ok({ sheets: parsedSheets });
}

/**
 * Serializes a drawing document to the canonical fixed-key-order JSON shape.
 * Fields are emitted in declaration order — `formatVersion`, `sheets`, and
 * per sheet `id`, `size`, `orientation`, `scale`, `views` (`bomTables` and
 * `balloons` last, only when non-empty), per view `id`, `kind`, `bodyId`,
 * `x`, `y`, `scale`, `alignedTo` (`label`, `projection`, and
 * `configurationId` last, only when present) — so the same document always
 * serializes to identical bytes.
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
      views: sheet.views.map((view): SerializedDrawingView => ({
        id: view.id,
        kind: view.kind,
        bodyId: view.bodyId,
        x: view.x,
        y: view.y,
        scale: view.scale === null ? null : serializeScale(view.scale),
        alignedTo: view.alignedTo,
        ...(view.label === undefined ? {} : { label: view.label }),
        ...(view.projection === undefined
          ? {}
          : { projection: serializeProjection(view.projection) }),
        ...(view.configurationId === undefined
          ? {}
          : { configurationId: view.configurationId }),
      })),
      ...(sheet.bomTables === undefined || sheet.bomTables.length === 0
        ? {}
        : { bomTables: sheet.bomTables.map(serializeBomTable) }),
      ...(sheet.balloons === undefined || sheet.balloons.length === 0
        ? {}
        : { balloons: sheet.balloons.map(serializeBalloon) }),
    })),
  };
}

function serializeProjection(
  projection: DrawingViewProjection,
): Record<string, unknown> {
  if (projection.method === "projected") {
    return {
      method: projection.method,
      parentViewId: projection.parentViewId,
      direction: projection.direction,
    };
  }
  if (projection.method === "auxiliary") {
    return {
      method: projection.method,
      parentViewId: projection.parentViewId,
      edgeFrom: [...projection.edgeFrom],
      edgeTo: [...projection.edgeTo],
    };
  }
  if (projection.method === "detail") {
    return {
      method: projection.method,
      parentViewId: projection.parentViewId,
      centreU: projection.centreU,
      centreV: projection.centreV,
      radiusMm: projection.radiusMm,
    };
  }
  if (projection.method === "broken-out") {
    return {
      method: projection.method,
      parentViewId: projection.parentViewId,
      bandMinU: projection.bandMinU,
      bandMaxU: projection.bandMaxU,
      planeOrigin: [...projection.planeOrigin],
      planeNormal: [...projection.planeNormal],
      keepSide: projection.keepSide,
      hatchSpacingMm: projection.hatchSpacingMm,
    };
  }
  return {
    method: projection.method,
    planeOrigin: [...projection.planeOrigin],
    planeNormal: [...projection.planeNormal],
    keepSide: projection.keepSide,
    hatchSpacingMm: projection.hatchSpacingMm,
    hatchAngleRad: projection.hatchAngleRad,
  };
}

function serializeBomTable(table: DrawingBomTable): SerializedDrawingBomTable {
  return {
    x: table.x,
    y: table.y,
    title: table.title,
    rows: table.rows.map((row) => ({
      item: row.item,
      occurrenceId: row.occurrenceId,
      label: row.label,
      bomFlag: row.bomFlag,
      quantity: row.quantity,
    })),
  };
}

function serializeBalloon(balloon: DrawingBalloon): SerializedDrawingBalloon {
  return {
    occurrenceId: balloon.occurrenceId,
    x: balloon.x,
    y: balloon.y,
    leaderX: balloon.leaderX,
    leaderY: balloon.leaderY,
    viewId: balloon.viewId,
  };
}

/**
 * Derives a BOM table's rows from the assembly's occurrence structure
 * (Phase 50), with the deterministic auto-numbering law: occurrences whose
 * flag is `phantom` never ship a row (sub-assembly headers dissolve); the
 * remaining occurrences GROUP by name (same name = same item, quantity =
 * group size); groups number 1, 2, 3, … in FIRST-APPEARANCE order of the
 * occurrences array. Pure and clock-free, so the same assembly structure
 * always numbers identically.
 *
 * The input is the structural subset of `DocumentOccurrence` the numbering
 * reads (id, name, flag), so any occurrence source fits.
 */
export function numberBomItems(
  occurrences: readonly {
    readonly id: OccurrenceId;
    readonly name: string;
    readonly bomFlag?: OccurrenceBomFlag;
  }[],
): DrawingBomRow[] {
  // Map insertion order IS first-appearance order (spec-guaranteed,
  // deterministic) — no separate order list to keep in sync.
  const groups = new Map<
    string,
    {
      occurrenceId: OccurrenceId;
      quantity: number;
      bomFlag: DrawingBomRow["bomFlag"];
    }
  >();
  for (const occurrence of occurrences) {
    if (occurrence.bomFlag === "phantom") continue;
    const existing = groups.get(occurrence.name);
    if (existing === undefined) {
      groups.set(occurrence.name, {
        occurrenceId: occurrence.id,
        quantity: 1,
        bomFlag:
          occurrence.bomFlag === undefined || occurrence.bomFlag === "default"
            ? null
            : occurrence.bomFlag,
      });
    } else {
      existing.quantity += 1;
    }
  }
  return [...groups].map(([label, group], index) => ({
    item: index + 1,
    occurrenceId: group.occurrenceId,
    label,
    bomFlag: group.bomFlag,
    quantity: group.quantity,
  }));
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
  /**
   * Section-face hatching (Phase 55): cut-face strokes in the same
   * view-plane model millimetres. Present only when the projection derived
   * a cut face (section/broken-out); absent otherwise — additive, so the
   * kernel `drawingView` adapters need not know about it.
   */
  readonly hatch?: readonly ProjectedChain[];
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
