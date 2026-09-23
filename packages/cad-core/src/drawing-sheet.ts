/**
 * Drawing sheet furniture (Phase 54): the sheet setup vocabulary (ISO A
 * sizes, orientation, scale), the title block, the revision table, and the
 * pinned template presets — the pure data the sheet frame's presentation
 * lays out and the template picker (Formedible) chooses from.
 *
 * ## Seam (Phase 53 boundary)
 *
 * The drawing document model — sheet records, view records — is Phase 53's.
 * This module carries what Phase 54 owns: the furniture records and the
 * pinned templates, serializable with the fixed-key-order discipline so a
 * round-tripped sheet's furniture is byte-stable. Sheet geometry derives
 * from the pinned ISO 216 A-series table (portrait millimetres), so layout
 * never depends on locale or display state.
 *
 * ## Determinism
 *
 * Every layout input is closed-form data: the size table is a constant,
 * template ids are pinned strings, and parse functions validate untrusted
 * input with stable `drawing-sheet/*` failure codes.
 */

import { type ParseResult, fail, ok } from "./result";

/** The ISO 216 A-series sheet sizes (portrait, millimetres). */
export const DRAWING_SHEET_SIZES = ["A4", "A3", "A2", "A1", "A0"] as const;

export type DrawingSheetSize = (typeof DRAWING_SHEET_SIZES)[number];

/** Sheet orientations. */
export const DRAWING_SHEET_ORIENTATIONS = ["portrait", "landscape"] as const;

export type DrawingSheetOrientation =
  (typeof DRAWING_SHEET_ORIENTATIONS)[number];

/**
 * The pinned ISO 216 A-series table (portrait width × height, mm) — the
 * one source every layout derives from.
 */
export const DRAWING_SHEET_SIZE_MM: Readonly<
  Record<
    DrawingSheetSize,
    { readonly widthMm: number; readonly heightMm: number }
  >
> = {
  A4: { widthMm: 210, heightMm: 297 },
  A3: { widthMm: 297, heightMm: 420 },
  A2: { widthMm: 420, heightMm: 594 },
  A1: { widthMm: 594, heightMm: 841 },
  A0: { widthMm: 841, heightMm: 1189 },
};

/** A sheet setup: size, orientation, and the drawing scale factor. */
export interface DrawingSheetSetup {
  readonly size: DrawingSheetSize;
  readonly orientation: DrawingSheetOrientation;
  /** The view scale (model mm → sheet mm multiplier, e.g. 0.5 for 1:2). */
  readonly scale: number;
}

/** The sheet's laid-out dimensions in millimetres (orientation applied). */
export function sheetDimensionsMm(setup: DrawingSheetSetup): {
  readonly widthMm: number;
  readonly heightMm: number;
} {
  const portrait = DRAWING_SHEET_SIZE_MM[setup.size];
  return setup.orientation === "portrait"
    ? { widthMm: portrait.widthMm, heightMm: portrait.heightMm }
    : { widthMm: portrait.heightMm, heightMm: portrait.widthMm };
}

/** Title block fields (Phase 54): the fixed field set a title block shows. */
export interface DrawingTitleBlock {
  readonly title: string;
  readonly author: string;
  readonly material: string;
  readonly mass: string;
  /** The scale text as authored ("1:2"), never derived for display. */
  readonly scale: string;
  readonly date: string;
}

/** One revision table row (newest last, drafting convention). */
export interface DrawingRevisionRow {
  readonly revision: string;
  readonly description: string;
  readonly author: string;
  readonly date: string;
}

/**
 * A pinned sheet template: setup + default title block + the frame margin
 * the presentation uses. Template ids are stable strings — the picker
 * persists the id, never a copied record.
 */
export interface DrawingSheetTemplate {
  readonly id: string;
  readonly name: string;
  readonly setup: DrawingSheetSetup;
  readonly frameMarginMm: number;
  readonly titleBlock: DrawingTitleBlock;
}

/** Stable failure codes for sheet furniture parsing. */
export const DRAWING_SHEET_ERROR_CODES = {
  notAnObject: "drawing-sheet/not-an-object",
  unknownSize: "drawing-sheet/unknown-size",
  unknownOrientation: "drawing-sheet/unknown-orientation",
  invalidScale: "drawing-sheet/invalid-scale",
  missingField: "drawing-sheet/missing-field",
  unknownTemplate: "drawing-sheet/unknown-template",
} as const;

export type DrawingSheetErrorCode =
  (typeof DRAWING_SHEET_ERROR_CODES)[keyof typeof DRAWING_SHEET_ERROR_CODES];

/** Structured failure describing why sheet furniture input was rejected. */
export interface DrawingSheetParseError {
  readonly code: DrawingSheetErrorCode;
  readonly message: string;
  readonly input: unknown;
}

const EMPTY_TITLE_BLOCK: DrawingTitleBlock = {
  title: "",
  author: "",
  material: "",
  mass: "",
  scale: "",
  date: "",
};

/**
 * The pinned template presets (Phase 54): three ISO-starters the picker
 * offers. Defaults carry an honest scale of 1:1 and an empty title block
 * the authoring form fills.
 */
export const DRAWING_SHEET_TEMPLATES: readonly DrawingSheetTemplate[] = [
  {
    id: "a4-landscape-1-1",
    name: "A4 landscape · 1:1",
    setup: { size: "A4", orientation: "landscape", scale: 1 },
    frameMarginMm: 10,
    titleBlock: EMPTY_TITLE_BLOCK,
  },
  {
    id: "a4-portrait-1-1",
    name: "A4 portrait · 1:1",
    setup: { size: "A4", orientation: "portrait", scale: 1 },
    frameMarginMm: 10,
    titleBlock: EMPTY_TITLE_BLOCK,
  },
  {
    id: "a3-landscape-1-2",
    name: "A3 landscape · 1:2",
    setup: { size: "A3", orientation: "landscape", scale: 0.5 },
    frameMarginMm: 10,
    titleBlock: EMPTY_TITLE_BLOCK,
  },
] as const;

/** Looks a pinned template up by id (exact string match). */
export function drawingSheetTemplateById(
  id: string,
): DrawingSheetTemplate | undefined {
  return DRAWING_SHEET_TEMPLATES.find((template) => template.id === id);
}

/** Parses a sheet setup from untrusted input. */
export function parseDrawingSheetSetup(
  input: unknown,
): ParseResult<DrawingSheetSetup, DrawingSheetParseError> {
  if (typeof input !== "object" || input === null) {
    return fail({
      code: DRAWING_SHEET_ERROR_CODES.notAnObject,
      message: "A sheet setup must be an object.",
      input,
    });
  }
  const record = input as Record<string, unknown>;
  if (
    typeof record.size !== "string" ||
    !DRAWING_SHEET_SIZES.includes(record.size as DrawingSheetSize)
  ) {
    return fail({
      code: DRAWING_SHEET_ERROR_CODES.unknownSize,
      message: "The sheet size must be one of A4, A3, A2, A1, A0.",
      input,
    });
  }
  if (
    typeof record.orientation !== "string" ||
    !DRAWING_SHEET_ORIENTATIONS.includes(
      record.orientation as DrawingSheetOrientation,
    )
  ) {
    return fail({
      code: DRAWING_SHEET_ERROR_CODES.unknownOrientation,
      message: "The sheet orientation must be portrait or landscape.",
      input,
    });
  }
  if (
    typeof record.scale !== "number" ||
    !Number.isFinite(record.scale) ||
    record.scale <= 0
  ) {
    return fail({
      code: DRAWING_SHEET_ERROR_CODES.invalidScale,
      message: "The sheet scale must be a positive finite number.",
      input,
    });
  }
  return ok({
    size: record.size as DrawingSheetSize,
    orientation: record.orientation as DrawingSheetOrientation,
    scale: record.scale,
  });
}

function stringOrEmpty(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** Parses a title block from untrusted input (unknown fields tolerated). */
export function parseDrawingTitleBlock(
  input: unknown,
): ParseResult<DrawingTitleBlock, DrawingSheetParseError> {
  if (typeof input !== "object" || input === null) {
    return fail({
      code: DRAWING_SHEET_ERROR_CODES.notAnObject,
      message: "A title block must be an object.",
      input,
    });
  }
  const record = input as Record<string, unknown>;
  return ok({
    title: stringOrEmpty(record.title),
    author: stringOrEmpty(record.author),
    material: stringOrEmpty(record.material),
    mass: stringOrEmpty(record.mass),
    scale: stringOrEmpty(record.scale),
    date: stringOrEmpty(record.date),
  });
}

/** Parses a revision table row from untrusted input. */
export function parseDrawingRevisionRow(
  input: unknown,
): ParseResult<DrawingRevisionRow, DrawingSheetParseError> {
  if (typeof input !== "object" || input === null) {
    return fail({
      code: DRAWING_SHEET_ERROR_CODES.notAnObject,
      message: "A revision row must be an object.",
      input,
    });
  }
  const record = input as Record<string, unknown>;
  if (
    typeof record.revision !== "string" ||
    typeof record.description !== "string"
  ) {
    return fail({
      code: DRAWING_SHEET_ERROR_CODES.missingField,
      message: "A revision row needs `revision` and `description` strings.",
      input,
    });
  }
  return ok({
    revision: record.revision,
    description: record.description,
    author: stringOrEmpty(record.author),
    date: stringOrEmpty(record.date),
  });
}

/** The fixed-key-order serialized sheet furniture bundle. */
export interface SerializedDrawingSheetFurniture {
  readonly setup: DrawingSheetSetup;
  readonly titleBlock: DrawingTitleBlock;
  readonly revisions: readonly DrawingRevisionRow[];
  readonly templateId: string;
}

/**
 * Serializes the sheet furniture bundle (setup, title block, revision
 * rows, and the template id the picker chose) in fixed key order.
 */
export function serializeDrawingSheetFurniture(
  setup: DrawingSheetSetup,
  titleBlock: DrawingTitleBlock,
  revisions: readonly DrawingRevisionRow[],
  templateId: string,
): SerializedDrawingSheetFurniture {
  return {
    setup: {
      size: setup.size,
      orientation: setup.orientation,
      scale: setup.scale,
    },
    titleBlock: {
      title: titleBlock.title,
      author: titleBlock.author,
      material: titleBlock.material,
      mass: titleBlock.mass,
      scale: titleBlock.scale,
      date: titleBlock.date,
    },
    revisions: revisions.map((row) => ({
      revision: row.revision,
      description: row.description,
      author: row.author,
      date: row.date,
    })),
    templateId,
  };
}
