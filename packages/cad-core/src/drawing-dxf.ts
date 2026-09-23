/**
 * The drawing DXF output (Phase 55): a deterministic ASCII DXF (AC1009 /
 * R12 flavour) writer over the same picture model as the SVG/PDF
 * exporters, plus the parser that reads the SAME SUBSET back.
 *
 * ## The honestly pinned entity subset
 *
 * The drawing's geometry is polyline chains, so the writer emits exactly
 * `LINE`, `CIRCLE` (balloons), and `TEXT` (labels, BOM cells, balloon
 * numbers) — no ARC/SPLINE/DIMENSION entities are fabricated for geometry
 * that is not analytic in the picture model. Chains become one LINE per
 * segment (the lossless polyline encoding for the subset). Sheet
 * millimetres map to DXF model-space units 1:1 with the y axis flipped
 * (sheet y is top-down; DXF y grows upward).
 *
 * ## Round-trip
 *
 * `parseDrawingDxf` reads back the written subset strictly (every entity
 * grouped with its layer) and `serializeParsedDrawingDxf` re-emits the
 * canonical bytes — `serializeDrawingDxf` is that canonical emission, so
 * `serializeDrawingDxf` ∘ `parseDrawingDxf` is the identity on written
 * files, which the fixtures pin byte-for-byte.
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
import { BOM_COLUMN_WIDTHS, BOM_ROW_HEIGHT } from "./drawing-output";

/** The projected geometry per view id for a whole drawing. */
export type DrawingGeometryByView = ReadonlyMap<string, DrawingViewGeometry>;

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
  for (const sheet of drawing.sheets) {
    const { width, height } = sheetDimensions(sheet);
    const X = (x: number): number => x;
    const Y = (y: number): number => height - y;
    // Frame border.
    const frame: readonly (readonly [number, number])[] = [
      [10, 10],
      [width - 10, 10],
      [width - 10, height - 10],
      [10, height - 10],
      [10, 10],
    ];
    for (let i = 0; i + 1 < frame.length; i += 1) {
      const a = frame[i];
      const b = frame[i + 1];
      if (a === undefined || b === undefined) continue;
      entities.push({
        kind: "line",
        layer: "FRAMES",
        x1: X(a[0]),
        y1: Y(a[1]),
        x2: X(b[0]),
        y2: Y(b[1]),
      });
    }
    for (const view of sheet.views) {
      const geo = geometry.get(view.id) ?? null;
      if (geo === null || geo.bounds === null) continue;
      const scale = view.scale ?? sheet.scale;
      const centreU = (geo.bounds.minU + geo.bounds.maxU) / 2;
      const centreV = (geo.bounds.minV + geo.bounds.maxV) / 2;
      const T = (
        point: readonly [number, number],
      ): readonly [number, number] => [
        view.x + scaleLength(point[0] - centreU, scale),
        Y(view.y - scaleLength(point[1] - centreV, scale)),
      ];
      const chains = (
        chains: readonly (readonly (readonly [number, number])[])[],
        layer: DrawingDxfLayer,
      ): void => {
        for (const chain of chains) {
          const t = chain.map(T);
          for (let i = 0; i + 1 < t.length; i += 1) {
            const a = t[i];
            const b = t[i + 1];
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
        }
      };
      chains(geo.visible, "VIEWS");
      chains(geo.hidden, "DHIDDEN");
      chains(geo.hatch ?? [], "HATCH");
      let labelBaseline = view.y + 8;
      const frameBox = viewFrameFromGeometry(view, sheet, geo.bounds);
      if (frameBox !== null)
        labelBaseline = frameBox.y + frameBox.height / 2 + 5;
      if (view.label !== undefined) {
        entities.push({
          kind: "text",
          layer: "TEXT",
          x: view.x,
          y: Y(labelBaseline),
          height: 3.5,
          text: view.label,
        });
      }
    }
    for (const balloon of sheet.balloons ?? []) {
      entities.push({
        kind: "line",
        layer: "BOM",
        x1: balloon.x,
        y1: Y(balloon.y),
        x2: balloon.leaderX,
        y2: Y(balloon.leaderY),
      });
      entities.push({
        kind: "circle",
        layer: "BOM",
        x: balloon.x,
        y: Y(balloon.y),
        radius: 4,
      });
      const item = balloonItem(sheet, balloon);
      if (item !== null) {
        entities.push({
          kind: "text",
          layer: "BOM",
          x: balloon.x,
          y: Y(balloon.y + 1.2),
          height: 2.8,
          text: String(item),
        });
      }
    }
    for (const table of sheet.bomTables ?? []) {
      appendBomDxf(entities, table, Y);
    }
  }
  return { layers: [...DRAWING_DXF_LAYERS], entities };
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

function appendBomDxf(
  entities: DrawingDxfEntity[],
  table: DrawingBomTable,
  Y: (y: number) => number,
): void {
  const { item, quantity, description } = BOM_COLUMN_WIDTHS;
  const totalWidth = item + quantity + description;
  const rows = table.rows.length + 1 + (table.title === null ? 0 : 1);
  const top = table.y + rows * BOM_ROW_HEIGHT;
  const hline = (y: number): void => {
    entities.push({
      kind: "line",
      layer: "BOM",
      x1: table.x,
      y1: Y(y),
      x2: table.x + totalWidth,
      y2: Y(y),
    });
  };
  const vline = (x: number): void => {
    entities.push({
      kind: "line",
      layer: "BOM",
      x1: x,
      y1: Y(table.y),
      x2: x,
      y2: Y(top),
    });
  };
  hline(table.y);
  hline(top);
  vline(table.x);
  vline(table.x + totalWidth);
  let y = table.y;
  if (table.title !== null) {
    entities.push({
      kind: "text",
      layer: "BOM",
      x: table.x + totalWidth / 2,
      y: Y(y + BOM_ROW_HEIGHT - 2),
      height: 3,
      text: table.title,
    });
    y += BOM_ROW_HEIGHT;
    hline(y);
  }
  entities.push({
    kind: "text",
    layer: "BOM",
    x: table.x + item / 2,
    y: Y(y + BOM_ROW_HEIGHT - 2),
    height: 2.5,
    text: "ITEM",
  });
  entities.push({
    kind: "text",
    layer: "BOM",
    x: table.x + item + quantity / 2,
    y: Y(y + BOM_ROW_HEIGHT - 2),
    height: 2.5,
    text: "QTY",
  });
  entities.push({
    kind: "text",
    layer: "BOM",
    x: table.x + item + quantity + 2,
    y: Y(y + BOM_ROW_HEIGHT - 2),
    height: 2.5,
    text: "DESCRIPTION",
  });
  y += BOM_ROW_HEIGHT;
  hline(y);
  for (const row of table.rows) {
    const baseY = y + BOM_ROW_HEIGHT - 2;
    entities.push({
      kind: "text",
      layer: "BOM",
      x: table.x + item / 2,
      y: Y(baseY),
      height: 2.5,
      text: String(row.item),
    });
    entities.push({
      kind: "text",
      layer: "BOM",
      x: table.x + item + quantity / 2,
      y: Y(baseY),
      height: 2.5,
      text: String(row.quantity),
    });
    entities.push({
      kind: "text",
      layer: "BOM",
      x: table.x + item + quantity + 2,
      y: Y(baseY),
      height: 2.5,
      text: bomRowText(row),
    });
    y += BOM_ROW_HEIGHT;
    if (y < top) hline(y);
  }
  vline(table.x + item);
  vline(table.x + item + quantity);
}

function bomRowText(row: DrawingBomTable["rows"][number]): string {
  const flag = row.bomFlag === null ? "" : ` (${row.bomFlag})`;
  return `${row.label}${flag}`;
}

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
