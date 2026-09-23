/**
 * The drawing DXF output (Phase 55, unified in Phase 55 round 2): a
 * deterministic ASCII DXF (AC1009 / R12 flavour) writer over the SAME
 * presentation pictures the SVG/PDF exporters consume — plus the parser
 * that reads the SAME SUBSET back.
 *
 * ## The honestly pinned entity subset
 *
 * The picture is primitives, so the writer emits exactly `LINE`
 * (segments, rect sides, arrowheads), `CIRCLE` (balloons), and `TEXT`
 * (labels, BOM cells, balloon numbers) — no ARC/SPLINE/DIMENSION entities
 * are fabricated for geometry that is not analytic in the picture model.
 * Sheet millimetres map to DXF model-space units 1:1; the presentation is
 * y-up and DXF's model space grows upward, so coordinates pass through
 * unconverted (the one `height − y` flip already happened at presentation
 * time).
 *
 * ## Layers
 *
 * The six pinned layers are the picture groups' medium mapping
 * (`dg-frame`→FRAMES, `dg-visible`→VIEWS, `dg-hidden`→DHIDDEN,
 * `dg-hatch`→HATCH, `dg-label`→TEXT, balloons/BOM→BOM) — the layout walk
 * decides placement once, the layer table is all this medium adds.
 *
 * ## Round-trip
 *
 * `parseDrawingDxf` reads back the written subset strictly (every entity
 * grouped with its layer) and `serializeParsedDrawingDxf` re-emits the
 * canonical bytes — `serializeDrawingDxf` is that canonical emission, so
 * `serializeDrawingDxf` ∘ `parseDrawingDxf` is the identity on written
 * files, which the fixtures pin byte-for-byte.
 */

import { type DrawingDocument } from "./drawing";
import {
  type DrawingGeometryByView,
  presentDrawingDocument,
} from "./drawing-output";
import {
  DRAWING_ARROW_LENGTH_MM,
  DRAWING_ARROW_WIDTH_MM,
  type DrawingPictureGroup,
  type DrawingPrimitive,
  type DrawingSheetPicture,
} from "./drawing-presentation";

/** The DXF layers the writer uses (fixed order — part of the byte format). */
export const DRAWING_DXF_LAYERS = [
  "FRAMES",
  "VIEWS",
  "DHIDDEN",
  "HATCH",
  "TEXT",
  "BOM",
] as const;

export type DrawingDxfLayer = (typeof DRAWING_DXF_LAYERS)[number];

/** Picture group class → DXF layer (the medium's pinned table). */
const LAYER_BY_GROUP: Readonly<Record<string, DrawingDxfLayer>> = {
  "dg-frame": "FRAMES",
  "dg-visible": "VIEWS",
  "dg-hidden": "DHIDDEN",
  "dg-hatch": "HATCH",
  "dg-balloon": "BOM",
  "dg-bom": "BOM",
  "dg-view": "VIEWS",
  "dg-furniture": "TEXT",
};

/** Element-classed primitives override the group layer (`dg-label`). */
const LAYER_BY_ELEMENT_CLASS: Readonly<Record<string, DrawingDxfLayer>> = {
  "dg-frame": "FRAMES",
  "dg-label": "TEXT",
  "dg-balloon-item": "BOM",
  "dg-balloon-circle": "BOM",
};

/** One parsed DXF entity from the written subset. */
export type DrawingDxfEntity =
  | {
      readonly kind: "line";
      readonly layer: string;
      readonly x1: number;
      readonly y1: number;
      readonly x2: number;
      readonly y2: number;
    }
  | {
      readonly kind: "circle";
      readonly layer: string;
      readonly x: number;
      readonly y: number;
      readonly radius: number;
    }
  | {
      readonly kind: "text";
      readonly layer: string;
      readonly x: number;
      readonly y: number;
      readonly height: number;
      readonly text: string;
    };

/** A parsed drawing DXF file: layers then entities (file order). */
export interface DrawingDxfDocument {
  readonly layers: readonly string[];
  readonly entities: readonly DrawingDxfEntity[];
}

/** Stable failure codes for {@link parseDrawingDxf}. */
export const DRAWING_DXF_ERROR_CODES = {
  malformed: "drawing-dxf/malformed",
  headerInvalid: "drawing-dxf/header-invalid",
  layerUnknown: "drawing-dxf/layer-unknown",
  entityMalformed: "drawing-dxf/entity-malformed",
} as const;

export type DrawingDxfErrorCode =
  (typeof DRAWING_DXF_ERROR_CODES)[keyof typeof DRAWING_DXF_ERROR_CODES];

export interface DrawingDxfError {
  readonly code: DrawingDxfErrorCode;
  readonly message: string;
  readonly input: unknown;
}

/** Formats a coordinate deterministically (≤4 decimals, trimmed). */
const n = (value: number): string => {
  const fixed = value.toFixed(4);
  const trimmed = fixed.replace(/\.?0+$/, "");
  return trimmed === "-0" ? "0" : trimmed;
};

// ---------------------------------------------------------------------------
// Writer
// ---------------------------------------------------------------------------

/**
 * Serializes a drawing (plus its views' geometry) to canonical DXF bytes.
 */
export function serializeDrawingDxf(
  drawing: DrawingDocument,
  geometry: DrawingGeometryByView,
): string {
  return serializeParsedDrawingDxf(buildDxfDocument(drawing, geometry));
}

/** Builds the entity document the writer emits (the shared picture walk). */
export function buildDxfDocument(
  drawing: DrawingDocument,
  geometry: DrawingGeometryByView,
): DrawingDxfDocument {
  const entities: DrawingDxfEntity[] = [];
  for (const picture of presentDrawingDocument(drawing, geometry)) {
    appendPicture(entities, picture);
  }
  return { layers: [...DRAWING_DXF_LAYERS], entities };
}

/** Appends one picture's entities (group walk, primitives → entities). */
function appendPicture(
  entities: DrawingDxfEntity[],
  picture: DrawingSheetPicture,
): void {
  const walk = (
    groups: readonly DrawingPictureGroup[],
    inherited: DrawingDxfLayer | null,
  ): void => {
    for (const group of groups) {
      const groupLayer = LAYER_BY_GROUP[group.class] ?? inherited;
      walk(group.children ?? [], groupLayer);
      for (const primitive of group.primitives) {
        // Element class overrides the group ("dg-label" → TEXT).
        const layer =
          LAYER_BY_ELEMENT_CLASS[primitive.class ?? ""] ?? groupLayer;
        appendPrimitive(entities, primitive, layer ?? null);
      }
    }
  };
  walk(picture.groups, null);
}

/** Expands one primitive into its DXF entities on the resolved layer. */
function appendPrimitive(
  entities: DrawingDxfEntity[],
  primitive: DrawingPrimitive,
  layer: DrawingDxfLayer | null,
): void {
  if (layer === null) return;
  switch (primitive.kind) {
    case "line":
      entities.push({
        kind: "line",
        layer,
        x1: primitive.x1,
        y1: primitive.y1,
        x2: primitive.x2,
        y2: primitive.y2,
      });
      return;
    case "rect": {
      // A rect is four side strokes (y-up corners).
      const { x, y, width, height } = primitive;
      const corners: readonly (readonly [number, number])[] = [
        [x, y],
        [x + width, y],
        [x + width, y + height],
        [x, y + height],
        [x, y],
      ];
      for (let i = 0; i + 1 < corners.length; i += 1) {
        const a = corners[i];
        const b = corners[i + 1];
        if (a === undefined || b === undefined) continue;
        entities.push({
          kind: "line",
          layer,
          x1: a[0],
          y1: a[1],
          x2: b[0],
          y2: b[1],
        });
      }
      return;
    }
    case "circle":
      entities.push({
        kind: "circle",
        layer,
        x: primitive.cx,
        y: primitive.cy,
        radius: primitive.radius,
      });
      return;
    case "arc": {
      // Deterministic 16-segment sweep (the PDF writer's approximation).
      const sweep = primitive.endRad - primitive.startRad;
      const segments = 16;
      for (let i = 0; i < segments; i += 1) {
        const a0 = primitive.startRad + (sweep * i) / segments;
        const a1 = primitive.startRad + (sweep * (i + 1)) / segments;
        entities.push({
          kind: "line",
          layer,
          x1: primitive.cx + primitive.radius * Math.cos(a0),
          y1: primitive.cy + primitive.radius * Math.sin(a0),
          x2: primitive.cx + primitive.radius * Math.cos(a1),
          y2: primitive.cy + primitive.radius * Math.sin(a1),
        });
      }
      return;
    }
    case "arrow": {
      // The shared arrowhead triangle's three sides, from the same math
      // the SVG polygon points use (base corners back along the arrow,
      // ±half-width across it).
      const cos = Math.cos(primitive.angleRad);
      const sin = Math.sin(primitive.angleRad);
      const bx = primitive.x - cos * DRAWING_ARROW_LENGTH_MM;
      const by = primitive.y - sin * DRAWING_ARROW_LENGTH_MM;
      const corners: readonly (readonly [number, number])[] = [
        [primitive.x, primitive.y],
        [bx - sin * DRAWING_ARROW_WIDTH_MM, by + cos * DRAWING_ARROW_WIDTH_MM],
        [bx + sin * DRAWING_ARROW_WIDTH_MM, by - cos * DRAWING_ARROW_WIDTH_MM],
        [primitive.x, primitive.y],
      ];
      for (let i = 0; i + 1 < corners.length; i += 1) {
        const a = corners[i];
        const b = corners[i + 1];
        if (a === undefined || b === undefined) continue;
        entities.push({
          kind: "line",
          layer,
          x1: a[0],
          y1: a[1],
          x2: b[0],
          y2: b[1],
        });
      }
      return;
    }
    case "text":
      entities.push({
        kind: "text",
        layer,
        x: primitive.x,
        y: primitive.y,
        height: primitive.sizeMm,
        text: primitive.text,
      });
      return;
  }
}

/** Canonical emission of a parsed document (the byte format itself). */
export function serializeParsedDrawingDxf(doc: DrawingDxfDocument): string {
  const out: string[] = [];
  const pair = (code: number, value: string): void => {
    out.push(String(code), value);
  };
  pair(0, "SECTION");
  pair(2, "HEADER");
  pair(9, "$ACADVER");
  pair(1, "AC1009");
  pair(9, "$INSUNITS");
  pair(70, "4");
  pair(0, "ENDSEC");
  pair(0, "SECTION");
  pair(2, "TABLES");
  pair(0, "TABLE");
  pair(2, "LAYER");
  pair(70, String(doc.layers.length));
  for (const layer of doc.layers) {
    pair(0, "LAYER");
    pair(2, layer);
    pair(70, "0");
    pair(62, "7");
    pair(6, "CONTINUOUS");
  }
  pair(0, "ENDTAB");
  pair(0, "ENDSEC");
  pair(0, "SECTION");
  pair(2, "ENTITIES");
  for (const entity of doc.entities) {
    if (entity.kind === "line") {
      pair(0, "LINE");
      pair(8, entity.layer);
      pair(10, n(entity.x1));
      pair(20, n(entity.y1));
      pair(11, n(entity.x2));
      pair(21, n(entity.y2));
    } else if (entity.kind === "circle") {
      pair(0, "CIRCLE");
      pair(8, entity.layer);
      pair(10, n(entity.x));
      pair(20, n(entity.y));
      pair(40, n(entity.radius));
    } else {
      pair(0, "TEXT");
      pair(8, entity.layer);
      pair(10, n(entity.x));
      pair(20, n(entity.y));
      pair(40, n(entity.height));
      pair(1, entity.text);
    }
  }
  pair(0, "ENDSEC");
  pair(0, "EOF");
  return `${out.join("\n")}\n`;
}

// ---------------------------------------------------------------------------
// Parser (the written subset, strictly)
// ---------------------------------------------------------------------------

/**
 * Parses the DXF subset this module writes. Strict where it matters: the
 * HEADER must be the written one, layers must be the known set in file
 * order, entities must carry a known layer and complete coordinates.
 */
export function parseDrawingDxf(input: string):
  | { ok: true; value: DrawingDxfDocument }
  | {
      ok: false;
      error: DrawingDxfError;
    } {
  const lines = input.split("\n");
  if ((lines.pop() ?? "") !== "") {
    return fail(
      DRAWING_DXF_ERROR_CODES.malformed,
      "A drawing DXF file must end with a newline.",
      input,
    );
  }
  let cursor = 0;
  const nextPair = (): { code: string; value: string } | null => {
    const code = lines[cursor];
    const value = lines[cursor + 1];
    if (code === undefined || value === undefined) return null;
    cursor += 2;
    return { code: code.trim(), value };
  };
  const first = nextPair();
  if (first === null || first.code !== "0" || first.value !== "SECTION") {
    return fail(
      DRAWING_DXF_ERROR_CODES.malformed,
      "A drawing DXF file must open with a SECTION.",
      first,
    );
  }
  const headerTag = nextPair();
  if (
    headerTag === null ||
    headerTag.code !== "2" ||
    headerTag.value !== "HEADER"
  ) {
    return fail(
      DRAWING_DXF_ERROR_CODES.headerInvalid,
      "The first section must be HEADER.",
      headerTag,
    );
  }
  const acadverCode = nextPair();
  const acadver = nextPair();
  if (acadverCode?.code !== "9" || acadver?.value !== "AC1009") {
    return fail(
      DRAWING_DXF_ERROR_CODES.headerInvalid,
      "The HEADER must declare $ACADVER AC1009.",
      acadver,
    );
  }
  const insunitsCode = nextPair();
  const insunitsCount = nextPair();
  if (
    insunitsCode?.code !== "9" ||
    insunitsCode?.value !== "$INSUNITS" ||
    insunitsCount?.code !== "70" ||
    insunitsCount?.value !== "4"
  ) {
    return fail(
      DRAWING_DXF_ERROR_CODES.headerInvalid,
      "The HEADER must declare $INSUNITS 4 (millimetres).",
      insunitsCount,
    );
  }
  const endHeader = nextPair();
  if (
    endHeader === null ||
    endHeader.code !== "0" ||
    endHeader.value !== "ENDSEC"
  ) {
    return fail(
      DRAWING_DXF_ERROR_CODES.malformed,
      "The HEADER section must close.",
      endHeader,
    );
  }
  // TABLES: LAYER table, then layers in file order.
  const layers: string[] = [];
  const tableTag = nextPair();
  if (
    tableTag === null ||
    tableTag.code !== "0" ||
    tableTag.value !== "SECTION"
  ) {
    return fail(
      DRAWING_DXF_ERROR_CODES.malformed,
      "The TABLES section is missing.",
      tableTag,
    );
  }
  const tablesName = nextPair();
  if (
    tablesName === null ||
    tablesName.code !== "2" ||
    tablesName.value !== "TABLES"
  ) {
    return fail(
      DRAWING_DXF_ERROR_CODES.malformed,
      "The second section must be TABLES.",
      tablesName,
    );
  }
  const tableOpen = nextPair();
  if (
    tableOpen === null ||
    tableOpen.code !== "0" ||
    tableOpen.value !== "TABLE"
  ) {
    return fail(
      DRAWING_DXF_ERROR_CODES.malformed,
      "The LAYER table is missing.",
      tableOpen,
    );
  }
  const layerTableName = nextPair();
  if (
    layerTableName === null ||
    layerTableName.code !== "2" ||
    layerTableName.value !== "LAYER"
  ) {
    return fail(
      DRAWING_DXF_ERROR_CODES.malformed,
      "The TABLES section must carry a LAYER table.",
      layerTableName,
    );
  }
  // Skip to the first LAYER record.
  let pair = nextPair();
  while (pair !== null && !(pair.code === "0" && pair.value === "LAYER")) {
    pair = nextPair();
  }
  while (pair !== null && pair.code === "0" && pair.value === "LAYER") {
    const name = nextPair();
    if (name === null || name.code !== "2") {
      return fail(
        DRAWING_DXF_ERROR_CODES.malformed,
        "A LAYER record needs a name.",
        name,
      );
    }
    layers.push(name.value);
    // Skip the record's remainder to the next 0-group.
    let field = nextPair();
    while (field !== null && field.code !== "0") field = nextPair();
    pair = field;
  }
  if (layers.length !== DRAWING_DXF_LAYERS.length) {
    return fail(
      DRAWING_DXF_ERROR_CODES.layerUnknown,
      "The LAYER table must carry the six drawing layers.",
      layers,
    );
  }
  // ENTITIES.
  const sectionTag = pair;
  if (
    sectionTag === null ||
    sectionTag.code !== "0" ||
    sectionTag.value !== "ENDTAB"
  ) {
    return fail(
      DRAWING_DXF_ERROR_CODES.malformed,
      "The LAYER table must close with ENDTAB.",
      sectionTag,
    );
  }
  let closing = nextPair();
  while (
    closing !== null &&
    !(closing.code === "0" && closing.value === "ENDSEC")
  ) {
    closing = nextPair();
  }
  const entitiesSection = nextPair();
  if (
    entitiesSection === null ||
    entitiesSection.code !== "0" ||
    entitiesSection.value !== "SECTION"
  ) {
    return fail(
      DRAWING_DXF_ERROR_CODES.malformed,
      "The ENTITIES section is missing.",
      entitiesSection,
    );
  }
  const entitiesTag = nextPair();
  if (
    entitiesTag === null ||
    entitiesTag.code !== "2" ||
    entitiesTag.value !== "ENTITIES"
  ) {
    return fail(
      DRAWING_DXF_ERROR_CODES.malformed,
      "The ENTITIES section is missing.",
      entitiesTag,
    );
  }
  const entities: DrawingDxfEntity[] = [];
  let current = nextPair();
  while (
    current !== null &&
    !(current.code === "0" && current.value === "ENDSEC")
  ) {
    const kind = current.value;
    const layer = nextPair();
    const fields = new Map<string, string>();
    let stop = nextPair();
    while (stop !== null && stop.code !== "0") {
      fields.set(stop.code, stop.value);
      stop = nextPair();
    }
    const layerValue = layer?.value;
    if (layer?.code !== "8" || layerValue === undefined) {
      return fail(
        DRAWING_DXF_ERROR_CODES.entityMalformed,
        "Every entity needs a layer (group 8).",
        kind,
      );
    }
    if (!layers.includes(layerValue)) {
      return fail(
        DRAWING_DXF_ERROR_CODES.layerUnknown,
        `The layer "${layerValue}" is not in the table.`,
        layerValue,
      );
    }
    const num = (code: string): number | null => {
      const raw = fields.get(code);
      if (raw === undefined) return null;
      const value = Number(raw);
      return Number.isFinite(value) ? value : null;
    };
    if (kind === "LINE") {
      const x1 = num("10");
      const y1 = num("20");
      const x2 = num("11");
      const y2 = num("21");
      if (x1 === null || y1 === null || x2 === null || y2 === null) {
        return fail(
          DRAWING_DXF_ERROR_CODES.entityMalformed,
          "A LINE needs four coordinates.",
          fields,
        );
      }
      entities.push({ kind: "line", layer: layerValue, x1, y1, x2, y2 });
    } else if (kind === "CIRCLE") {
      const x = num("10");
      const y = num("20");
      const radius = num("40");
      if (x === null || y === null || radius === null) {
        return fail(
          DRAWING_DXF_ERROR_CODES.entityMalformed,
          "A CIRCLE needs a centre and radius.",
          fields,
        );
      }
      entities.push({ kind: "circle", layer: layerValue, x, y, radius });
    } else if (kind === "TEXT") {
      const x = num("10");
      const y = num("20");
      const height = num("40");
      const text = fields.get("1");
      if (x === null || y === null || height === null || text === undefined) {
        return fail(
          DRAWING_DXF_ERROR_CODES.entityMalformed,
          "A TEXT needs a point, height, and string.",
          fields,
        );
      }
      entities.push({ kind: "text", layer: layerValue, x, y, height, text });
    } else {
      return fail(
        DRAWING_DXF_ERROR_CODES.entityMalformed,
        `The entity "${kind}" is outside the subset.`,
        kind,
      );
    }
    current = stop;
  }
  const eof = nextPair();
  if (eof === null || eof.code !== "0" || eof.value !== "EOF") {
    return fail(
      DRAWING_DXF_ERROR_CODES.malformed,
      "The file must close with EOF.",
      eof,
    );
  }
  if (cursor !== lines.length) {
    return fail(
      DRAWING_DXF_ERROR_CODES.malformed,
      "Trailing content after EOF.",
      null,
    );
  }
  return { ok: true, value: { layers, entities } };
}

function fail(
  code: DrawingDxfErrorCode,
  message: string,
  input: unknown,
): { ok: false; error: DrawingDxfError } {
  return { ok: false, error: { code, message, input } };
}
