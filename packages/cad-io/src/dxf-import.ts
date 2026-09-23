/**
 * DXF import (Phase 56): parses untrusted bytes — the raw text of an ASCII
 * `.dxf` file — into an {@link ImportedDxfSketch}: cad-sketch entities in
 * canonical millimetres (the Phase 36 vocabulary), plus the honest
 * provenance the subset discipline owes the caller.
 *
 * ## Pinned subset (the honesty boundary)
 *
 * R12-class 2D drawing exchange: entity kinds LINE, CIRCLE, ARC,
 * LWPOLYLINE, the legacy POLYLINE/VERTEX/SEQEND trio, and SPLINE. Every
 * other ENTITIES keyword (INSERT, DIMENSION, TEXT, ELLIPSE, MTEXT, POINT,
 * …) is recorded in {@link ImportedDxfSketch.declined} with its handle,
 * layer, and a `kind-out-of-subset` reason — never silently dropped — and
 * the rest of the file imports. What DOES import is exact — no
 * tessellation, no approximation:
 *
 * - **LINE** (10/20 → 11/21) → `line`.
 * - **CIRCLE** (10/20 center, 40 radius) → `circle`.
 * - **ARC** (10/20 center, 40 radius, 50/51 angles in DEGREES) → `arc`.
 *   DXF arcs sweep counter-clockwise start→end — cad-sketch's arc
 *   convention — and the builder canonicalizes the radians to [0, 2π).
 * - **LWPOLYLINE** (repeated 10/20 vertices, 70 bit 1 = closed, per-vertex
 *   42 bulge) and the **legacy POLYLINE + VERTEX + SEQEND** trio → chains
 *   of `line` entities. A vertex's bulge converts its OUTGOING segment
 *   (v→v+1; for a closed chain, last→first) to an exact `arc`: the DXF
 *   bulge is tan(θ/4), θ the enclosed angle signed CCW-positive, and the
 *   arc's center/radius/angles follow from the chord deterministically
 *   (the center sits on the chord's perpendicular at r·cos(θ/2) from the
 *   midpoint — left of travel for positive bulges). Chain segments mint
 *   ids from the entity key (`skent_<key>`, `skent_<key>-s1`, …); `-` is
 *   not a hex digit, so suffixed ids never collide with a real handle.
 *   Zero-length segments are skipped. The mesh/polyface POLYLINE flag
 *   bits (16/32/64) are out of subset — declined, not converted.
 * - **SPLINE** (71 degree, 73 control count, 10/20 control points) →
 *   `spline` in the `control` flavor — EXACTLY the cubic Bézier chain
 *   cad-sketch stores — when the file describes one: degree 3, no fit
 *   points (groups 11/21 and 74 absent), not closed (70 bit 1), 3k+1
 *   controls, and — when a knot vector (40) travels with it — the clamped
 *   Bézier-chain pattern (four equal knots at each end, exact triples at
 *   each of the k−1 interior joins). Any other spline declines with
 *   `spline-out-of-subset`: cad-sketch's `interpolated` flavor is a
 *   Catmull-Rom fit that would NOT reproduce the DXF curve through those
 *   points (fabrication), and a general B-spline needs knot insertion
 *   this importer does not perform.
 *
 * An in-subset entity that fails its strict conversion (zero radius,
 * missing coordinates, a full-turn ARC, a control count that disagrees
 * with the declared one) is a WHOLE-FILE failure with
 * `dxf-import/entity-invalid` naming the entity: the file claimed
 * well-formed geometry of the pinned kind and was not — a trust-boundary
 * defect, not a scope boundary. Scope boundaries decline; defects reject.
 *
 * ## Ids, layers, units
 *
 * - **Ids** — an entity's key is its handle (group 5, or the R12-era
 *   group 105), lowercased; a handleless record keys from a deterministic
 *   `dxf<N>` counter (its position among ENTITIES records). `x` cannot
 *   occur in a hex handle, so minted `skent_dxf<N>` ids never collide
 *   with `skent_<hex>`. Duplicate handles are a whole-file failure
 *   (`duplicate-handle`): ids mint from handles, and a collision would
 *   silently overwrite.
 * - **Layers** — an entity's layer is its group 8 (absent = layer "0",
 *   the DXF default). The default imports every layer; `options.layers`
 *   narrows to a case-insensitive exact match (the DXF layer-name rule)
 *   and filtered-out entities do not import — the caller's own request,
 *   so they are neither entities nor declines. Distinct imported layer
 *   names travel in {@link ImportedDxfSketch.layers} in first-appearance
 *   order.
 * - **Units** — the HEADER's `$INSUNITS` selects the millimetre scale
 *   from the pinned {@link DXF_UNIT_TO_MILLIMETER_FACTORS} table (the DXF
 *   enum: inches through parsecs). Absent `$INSUNITS` (typical R12
 *   output) imports coordinates 1:1 with `unitsSource: "default-mm"` —
 *   the documented convention, not a detection. An out-of-table value
 *   fails with `dxf-import/unsupported-unit` rather than guess a scale.
 *   DXF is y-up like the sketch plane: no axis flip.
 *
 * ## Framing and failure discipline
 *
 * ASCII DXF is group-code/value line pairs in `0 SECTION` / `2 <NAME>` …
 * `0 ENDSEC` shells; the importer reads `$INSUNITS` from HEADER and
 * converts only ENTITIES-section records (TABLES carry metadata this
 * importer does not need; entities inside BLOCKS are definitions — their
 * placements live in INSERT, out of subset). Binary DXF (the
 * `AutoCAD Binary DXF` sentinel) and any non-text byte string decline
 * outright (`binary-unsupported`). No byte input throws: empty input,
 * binary sentinels, non-DXF text, an out-of-table unit, duplicate
 * handles, or an in-subset entity failing its strict conversion all fail
 * with a structured `dxf-import/*` code on the cad-core `ParseResult`
 * discipline. Deterministic: one pass, fixed order, no time, no
 * randomness.
 */

import {
  type ParseFailure,
  type ParseResult,
  fail,
  ok,
} from "@slopcad/cad-core";
import {
  createArcEntity,
  createCircleEntity,
  createLineEntity,
  createSplineEntity,
  createSketchEntityId,
  type SketchEntity,
  type SketchEntityId,
} from "@slopcad/cad-sketch";

/** Stable failure codes produced when DXF import rejects its input. */
export const DXF_IMPORT_ERROR_CODES = {
  empty: "dxf-import/empty",
  binaryUnsupported: "dxf-import/binary-unsupported",
  notDxf: "dxf-import/not-dxf",
  syntax: "dxf-import/syntax",
  unsupportedUnit: "dxf-import/unsupported-unit",
  duplicateHandle: "dxf-import/duplicate-handle",
  entityInvalid: "dxf-import/entity-invalid",
} as const;

export type DxfImportErrorCode =
  (typeof DXF_IMPORT_ERROR_CODES)[keyof typeof DXF_IMPORT_ERROR_CODES];

/** Structured failure describing why DXF import rejected some bytes. */
export interface DxfImportError extends ParseFailure {
  readonly code: DxfImportErrorCode;
}

/** The `$INSUNITS` enum names the pinned table covers, with mm scales. */
export const DXF_UNIT_TO_MILLIMETER_FACTORS = {
  inches: 25.4,
  feet: 304.8,
  miles: 1_609_344,
  millimeters: 1,
  centimeters: 10,
  meters: 1000,
  kilometers: 1_000_000,
  microinches: 25.4 / 1000,
  mils: 25.4 / 1000,
  yards: 914.4,
  angstroms: 1e-7,
  nanometers: 1e-6,
  microns: 1e-3,
  decimeters: 100,
  decameters: 10_000,
  hectometers: 100_000,
  gigameters: 1e12,
  astronomicalUnits: 1.495978707e14,
  lightYears: 9.4607304725808e18,
  parsecs: 3.085677581491367e19,
} as const;

/** A `$INSUNITS` enum name covered by the pinned unit table. */
export type DxfUnitName = keyof typeof DXF_UNIT_TO_MILLIMETER_FACTORS;

/** `$INSUNITS` code → table name (0 = unitless → the default-mm convention). */
const INSUNITS_TABLE: Readonly<Record<number, DxfUnitName>> = {
  1: "inches",
  2: "feet",
  3: "miles",
  4: "millimeters",
  5: "centimeters",
  6: "meters",
  7: "kilometers",
  8: "microinches",
  9: "mils",
  10: "yards",
  11: "angstroms",
  12: "nanometers",
  13: "microns",
  14: "decimeters",
  15: "decameters",
  16: "hectometers",
  17: "gigameters",
  18: "astronomicalUnits",
  19: "lightYears",
  20: "parsecs",
};

/** One entity the pinned subset does not cover, recorded instead of imported. */
export interface DxfDeclinedEntity {
  readonly kind: string;
  readonly handle: string | null;
  readonly layer: string | null;
  readonly reason: "kind-out-of-subset" | "spline-out-of-subset";
}

/** Provenance of the millimetre scale the import applied. */
export type DxfUnitsSource = "insunits" | "default-mm";

/** The successful result of importing a DXF file. */
export interface ImportedDxfSketch {
  readonly entities: readonly SketchEntity[];
  readonly units: "mm";
  readonly unitsSource: DxfUnitsSource;
  readonly unitName: DxfUnitName | null;
  readonly layers: readonly string[];
  readonly declined: readonly DxfDeclinedEntity[];
}

/** The result of DXF import: an imported sketch, or a structured failure. */
export type DxfImportResult = ParseResult<ImportedDxfSketch, DxfImportError>;

/** Import options: the layer filter (absent or empty = every layer). */
export interface DxfImportOptions {
  readonly layers?: readonly string[];
}

function dxfError(
  code: DxfImportErrorCode,
  message: string,
  bytes: Uint8Array,
): DxfImportError {
  return { code, message, input: bytes };
}

// ---------------------------------------------------------------------------
// Byte framing and pair scanning
// ---------------------------------------------------------------------------

/**
 * Whether every byte is text ASCII DXF can carry: printable ASCII, tab,
 * LF, CR, and the Latin-1 range real drawings' layer names use.
 */
function isDecodableText(bytes: Uint8Array): boolean {
  for (let i = 0; i < bytes.length; i += 1) {
    const byte = bytes[i] ?? 0;
    if (
      byte === 0x09 ||
      byte === 0x0a ||
      byte === 0x0d ||
      (byte >= 0x20 && byte <= 0x7e) ||
      byte >= 0xa0
    ) {
      continue;
    }
    return false;
  }
  return true;
}

/** One DXF group-code/value pair with its 1-based source line. */
interface DxfPair {
  readonly code: number;
  readonly value: string;
  readonly line: number;
}

/**
 * Splits the text into group pairs: every even line an integer group code,
 * the odd line after it its value, verbatim. Anything else is not DXF.
 */
function scanPairs(
  text: string,
  bytes: Uint8Array,
): ParseResult<readonly DxfPair[], DxfImportError> {
  const lines = text.split(/\r\n|\r|\n/);
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  const pairs: DxfPair[] = [];
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const codeText = (lines[i] ?? "").trim();
    const value = lines[i + 1] ?? "";
    if (codeText.length === 0 || !/^-?\d+$/.test(codeText)) {
      return fail(
        dxfError(
          DXF_IMPORT_ERROR_CODES.notDxf,
          `Expected a group code at line ${i + 1}, found ${JSON.stringify(codeText.slice(0, 32))}; the input is not ASCII DXF group pairs.`,
          bytes,
        ),
      );
    }
    pairs.push({
      code: Number.parseInt(codeText, 10),
      value,
      line: i + 1,
    });
  }
  return ok(pairs);
}

/** DXF double reader: decimal/exponent forms, finiteness enforced. */
function readDouble(value: string): number | null {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** DXF integer reader for flag/counter codes. */
function readInt(value: string): number | null {
  const trimmed = value.trim();
  return /^-?\d+$/.test(trimmed) ? Number.parseInt(trimmed, 10) : null;
}

// ---------------------------------------------------------------------------
// The ENTITIES-section model
// ---------------------------------------------------------------------------

/** One framing-level entity: kind keyword, handle, layer, value pairs. */
interface RawEntity {
  readonly kind: string;
  readonly handle: string | null;
  readonly layer: string | null;
  readonly pairs: readonly DxfPair[];
}

/** An entity record keyed for id minting (handle, or the `dxf<N>` counter). */
interface KeyedEntity {
  readonly raw: RawEntity;
  readonly key: string;
}

/** The double-valued group codes the converters read. */
const DOUBLE_CODES: ReadonlySet<number> = new Set([
  10, 11, 20, 21, 40, 42, 50, 51,
]);

/**
 * Walks the pairs and lifts ENTITIES-section records. The legacy
 * POLYLINE header, its VERTEX entities (only their 10/20/42 geometry
 * groups — the vertex records' own flags are framing), and SEQEND fold
 * into ONE merged record whose pairs are the header's followed by each
 * vertex's geometry: the chain converter sees one uniform stream, and the
 * header's own 70 flag stays authoritative.
 */
function liftEntities(pairs: readonly DxfPair[]): readonly RawEntity[] {
  const entities: RawEntity[] = [];
  let section: string | null = null;
  let expectSectionName = false;
  let current: RawEntity | null = null;
  let foldingLegacy = false;

  const flush = (): void => {
    if (current !== null) {
      entities.push(current);
      current = null;
    }
  };

  for (const pair of pairs) {
    if (pair.code === 0) {
      const keyword = pair.value.trim();
      if (keyword === "SECTION") {
        section = null;
        expectSectionName = true;
        flush();
        foldingLegacy = false;
        continue;
      }
      if (keyword === "ENDSEC") {
        section = null;
        expectSectionName = false;
        flush();
        foldingLegacy = false;
        continue;
      }
      if (section === "ENTITIES") {
        if (keyword === "SEQEND") {
          // Closes the legacy fold; carries no geometry itself.
          flush();
          foldingLegacy = false;
          continue;
        }
        if (keyword === "VERTEX" && foldingLegacy && current !== null) {
          // A legacy vertex: its geometry groups append to the open
          // POLYLINE record; the vertex record never stands alone.
          continue;
        }
        flush();
        current = { kind: keyword, handle: null, layer: null, pairs: [] };
        foldingLegacy = keyword === "POLYLINE";
        continue;
      }
      flush();
      foldingLegacy = false;
      continue;
    }
    if (expectSectionName) {
      if (pair.code === 2) {
        section = pair.value.trim();
        expectSectionName = false;
      }
      continue;
    }
    if (current === null) continue;
    if (pair.code === 5 || pair.code === 105) {
      if (current.handle === null) {
        current = { ...current, handle: pair.value.trim() };
      }
      continue;
    }
    if (pair.code === 8) {
      if (current.layer === null) {
        current = { ...current, layer: pair.value.trim() };
      }
      continue;
    }
    // While folding, only vertex geometry appends — the vertex records'
    // own 70 flags are framing and must not override the header's.
    if (foldingLegacy && current.kind === "POLYLINE") {
      if (pair.code === 10 || pair.code === 20 || pair.code === 42) {
        current = { ...current, pairs: [...current.pairs, pair] };
      }
      continue;
    }
    if (DOUBLE_CODES.has(pair.code) || isFlagCode(pair.code)) {
      current = { ...current, pairs: [...current.pairs, pair] };
    }
  }
  flush();
  return entities;
}

/** The integer-valued flag/counter codes the converters read. */
function isFlagCode(code: number): boolean {
  return (
    code === 70 || code === 71 || code === 73 || code === 74 || code === 90
  );
}

/** Reads every double group of a record as finiteness-checked values. */
function numbersOf(raw: RawEntity): Map<number, number> | null {
  const numbers = new Map<number, number>();
  for (const pair of raw.pairs) {
    if (!DOUBLE_CODES.has(pair.code)) continue;
    const value = readDouble(pair.value);
    if (value === null) return null;
    numbers.set(pair.code, value);
  }
  return numbers;
}

/** Reads one integer code: `undefined` when absent, null when malformed. */
function intOf(raw: RawEntity, code: number): number | null | undefined {
  let found: number | null | undefined;
  for (const pair of raw.pairs) {
    if (pair.code === code) found = readInt(pair.value);
  }
  return found;
}

// ---------------------------------------------------------------------------
// Converters (one per pinned kind)
// ---------------------------------------------------------------------------

const TWO_PI = Math.PI * 2;

/** Canonicalizes an angle into [0, 2π) — cad-sketch's arc convention. */
function canonicalAngle(radians: number): number {
  const wrapped = radians % TWO_PI;
  return wrapped < 0 ? wrapped + TWO_PI : wrapped;
}

/**
 * Mints branded sketch ids from an entity key. Hex handles lowercase
 * into the id vocabulary; the `-s<N>` chain suffixes can never collide
 * with a real handle (`-` is not a hex digit); the handleless `dxf<N>`
 * counter never collides either (`x` is not a hex digit).
 */
function mintId(key: string): SketchEntityId {
  return createSketchEntityId(`skent_${key.toLowerCase()}`);
}

/** The shared conversion context: the millimetre scale. */
interface ConvertContext {
  readonly scale: number;
}

type ConvertOutcome =
  | { readonly tag: "entities"; readonly entities: readonly SketchEntity[] }
  | { readonly tag: "declined"; readonly reason: DxfDeclinedEntity["reason"] }
  | { readonly tag: "invalid"; readonly message: string };

function invalid(raw: RawEntity, message: string): ConvertOutcome {
  return {
    tag: "invalid",
    message: `Entity ${raw.kind} (handle ${raw.handle ?? "none"}): ${message}`,
  };
}

/** LINE: 10/20 → 11/21. */
function convertLine(ctx: ConvertContext, keyed: KeyedEntity): ConvertOutcome {
  const raw = keyed.raw;
  const numbers = numbersOf(raw);
  const x1 = numbers === null ? undefined : numbers.get(10);
  const y1 = numbers === null ? undefined : numbers.get(20);
  const x2 = numbers === null ? undefined : numbers.get(11);
  const y2 = numbers === null ? undefined : numbers.get(21);
  if (
    numbers === null ||
    x1 === undefined ||
    y1 === undefined ||
    x2 === undefined ||
    y2 === undefined
  ) {
    return invalid(raw, "missing or non-finite endpoints");
  }
  try {
    return {
      tag: "entities",
      entities: [
        createLineEntity(
          mintId(keyed.key),
          { x: x1 * ctx.scale, y: y1 * ctx.scale },
          { x: x2 * ctx.scale, y: y2 * ctx.scale },
        ),
      ],
    };
  } catch (error) {
    return invalid(raw, error instanceof Error ? error.message : String(error));
  }
}

/** CIRCLE: 10/20 center, 40 radius. */
function convertCircle(
  ctx: ConvertContext,
  keyed: KeyedEntity,
): ConvertOutcome {
  const raw = keyed.raw;
  const numbers = numbersOf(raw);
  const cx = numbers === null ? undefined : numbers.get(10);
  const cy = numbers === null ? undefined : numbers.get(20);
  const radius = numbers === null ? undefined : numbers.get(40);
  if (
    numbers === null ||
    cx === undefined ||
    cy === undefined ||
    radius === undefined
  ) {
    return invalid(raw, "missing or non-finite center/radius");
  }
  try {
    return {
      tag: "entities",
      entities: [
        createCircleEntity(
          mintId(keyed.key),
          { x: cx * ctx.scale, y: cy * ctx.scale },
          radius * ctx.scale,
        ),
      ],
    };
  } catch (error) {
    return invalid(raw, error instanceof Error ? error.message : String(error));
  }
}

/** ARC: CIRCLE's geometry plus 50/51 degrees, CCW start→end. */
function convertArc(ctx: ConvertContext, keyed: KeyedEntity): ConvertOutcome {
  const raw = keyed.raw;
  const numbers = numbersOf(raw);
  const cx = numbers === null ? undefined : numbers.get(10);
  const cy = numbers === null ? undefined : numbers.get(20);
  const radius = numbers === null ? undefined : numbers.get(40);
  const startDeg = numbers === null ? undefined : numbers.get(50);
  const endDeg = numbers === null ? undefined : numbers.get(51);
  if (
    numbers === null ||
    cx === undefined ||
    cy === undefined ||
    radius === undefined ||
    startDeg === undefined ||
    endDeg === undefined
  ) {
    return invalid(raw, "missing or non-finite center/radius/angles");
  }
  try {
    return {
      tag: "entities",
      entities: [
        createArcEntity(
          mintId(keyed.key),
          { x: cx * ctx.scale, y: cy * ctx.scale },
          radius * ctx.scale,
          (startDeg * Math.PI) / 180,
          (endDeg * Math.PI) / 180,
        ),
      ],
    };
  } catch (error) {
    return invalid(raw, error instanceof Error ? error.message : String(error));
  }
}

/** One polyline vertex: position plus the outgoing segment's bulge. */
interface PolyVertex {
  readonly x: number;
  readonly y: number;
  readonly bulge: number;
}

/**
 * Reads the uniform (10, 20[, 42]) stream of a merged polyline record —
 * LWPOLYLINE's own pairs, or the legacy fold's header+vertex merge — into
 * vertices. A 42 belongs to the vertex before it (the bulge of the
 * segment STARTING at that vertex); a vertex may carry at most one.
 */
function polyVertices(raw: RawEntity): readonly PolyVertex[] | null {
  const vertices: PolyVertex[] = [];
  let pendingX: number | null = null;
  let current: PolyVertex | null = null;
  for (const pair of raw.pairs) {
    if (pair.code === 10) {
      if (current !== null) vertices.push(current);
      const x = readDouble(pair.value);
      if (x === null) return null;
      pendingX = x;
    } else if (pair.code === 20) {
      if (pendingX === null) return null;
      const y = readDouble(pair.value);
      if (y === null) return null;
      current = { x: pendingX, y, bulge: 0 };
      pendingX = null;
    } else if (pair.code === 42) {
      // A bulge always rides the vertex its 10/20 opened (the next 10
      // pushes it), so the pending vertex is the owner — no pop.
      if (current === null) return null;
      const bulge = readDouble(pair.value);
      if (bulge === null) return null;
      current = { x: current.x, y: current.y, bulge };
    }
  }
  if (pendingX !== null) return null;
  if (current !== null) vertices.push(current);
  return vertices;
}

/**
 * Converts a bulged segment to its exact arc. The DXF bulge is tan(θ/4)
 * with θ the signed enclosed angle (CCW positive); the radius spans the
 * chord, and the center sits on the chord's perpendicular r·cos(θ/2)
 * from the midpoint — left of the chord's travel direction for positive
 * (CCW) bulges.
 */
function bulgeArc(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  bulge: number,
): {
  readonly cx: number;
  readonly cy: number;
  readonly radius: number;
  readonly start: number;
  readonly end: number;
} | null {
  const theta = 4 * Math.atan(bulge);
  const dx = x2 - x1;
  const dy = y2 - y1;
  const chord = Math.hypot(dx, dy);
  if (chord === 0 || !Number.isFinite(chord)) return null;
  const radius = chord / (2 * Math.sin(Math.abs(theta) / 2));
  if (!Number.isFinite(radius) || radius <= 0) return null;
  const apothem = radius * Math.cos(theta / 2);
  const midX = (x1 + x2) / 2;
  const midY = (y1 + y2) / 2;
  const ux = dx / chord;
  const uy = dy / chord;
  const sign = theta > 0 ? 1 : -1;
  const cx = midX + uy * apothem * sign;
  const cy = midY - ux * apothem * sign;
  return {
    cx,
    cy,
    radius,
    start: canonicalAngle(Math.atan2(y1 - cy, x1 - cx)),
    end: canonicalAngle(Math.atan2(y2 - cy, x2 - cx)),
  };
}

/** Converts a vertex chain (open, or closed by appending the first point). */
function convertVertexChain(
  ctx: ConvertContext,
  keyed: KeyedEntity,
  closed: boolean,
): ConvertOutcome {
  const raw = keyed.raw;
  const vertices = polyVertices(raw);
  if (vertices === null) {
    return invalid(raw, "missing or non-finite vertex coordinates");
  }
  if (vertices.length < 2) {
    return invalid(raw, "a polyline needs at least two vertices");
  }
  const points = [...vertices];
  if (closed) {
    const first = points[0];
    if (first !== undefined) points.push(first);
  }
  const { scale } = ctx;
  const entities: SketchEntity[] = [];
  try {
    for (let i = 0; i + 1 < points.length; i += 1) {
      const a = points[i];
      const b = points[i + 1];
      if (a === undefined || b === undefined) continue;
      const ax = a.x * scale;
      const ay = a.y * scale;
      const bx = b.x * scale;
      const by = b.y * scale;
      if (ax === bx && ay === by) continue;
      const id = mintId(i === 0 ? keyed.key : `${keyed.key}-s${String(i)}`);
      if (a.bulge !== 0) {
        const arc = bulgeArc(ax, ay, bx, by, a.bulge);
        if (arc === null) {
          return invalid(raw, `degenerate bulged segment ${String(i)}`);
        }
        entities.push(
          createArcEntity(
            id,
            { x: arc.cx, y: arc.cy },
            arc.radius,
            arc.start,
            arc.end,
          ),
        );
      } else {
        entities.push(createLineEntity(id, { x: ax, y: ay }, { x: bx, y: by }));
      }
    }
  } catch (error) {
    return invalid(raw, error instanceof Error ? error.message : String(error));
  }
  return { tag: "entities", entities };
}

/** LWPOLYLINE: repeated 10/20/42 vertices, 70 bit 1 = closed. */
function convertLwpolyline(
  ctx: ConvertContext,
  keyed: KeyedEntity,
): ConvertOutcome {
  const flags = intOf(keyed.raw, 70) ?? 0;
  return convertVertexChain(ctx, keyed, (flags & 1) === 1);
}

/**
 * Legacy POLYLINE: the walker merged header + VERTEX records into one;
 * 70 bit 1 = closed, and the mesh/polyface bits (16/32/64) are out of
 * subset — declined, their VERTEX records carry face/edge semantics this
 * importer does not read.
 */
function convertLegacyPolyline(
  ctx: ConvertContext,
  keyed: KeyedEntity,
): ConvertOutcome {
  const flags = intOf(keyed.raw, 70) ?? 0;
  if ((flags & (16 | 32 | 64)) !== 0) {
    return { tag: "declined", reason: "kind-out-of-subset" };
  }
  return convertVertexChain(ctx, keyed, (flags & 1) === 1);
}

/**
 * SPLINE → `spline` (control flavor) exactly when the file describes a
 * cubic Bézier chain (see the module header); anything else declines with
 * `spline-out-of-subset`.
 */
function convertSpline(
  ctx: ConvertContext,
  keyed: KeyedEntity,
): ConvertOutcome {
  const raw = keyed.raw;
  const degree = intOf(raw, 71);
  const fitCount = intOf(raw, 74);
  const controlCount = intOf(raw, 73);
  const flags = intOf(raw, 70) ?? 0;
  const hasFitPoints =
    raw.pairs.some((pair) => pair.code === 11 || pair.code === 21) ||
    (fitCount !== undefined && fitCount !== null && fitCount > 0);
  if (
    (flags & 1) === 1 ||
    degree !== 3 ||
    hasFitPoints ||
    controlCount === undefined ||
    controlCount === null ||
    (controlCount - 1) % 3 !== 0
  ) {
    return { tag: "declined", reason: "spline-out-of-subset" };
  }
  const controls: { readonly x: number; readonly y: number }[] = [];
  let pendingX: number | null = null;
  for (const pair of raw.pairs) {
    if (pair.code === 10) {
      if (pendingX !== null) return invalid(raw, "control x without y");
      const x = readDouble(pair.value);
      if (x === null) return invalid(raw, "non-finite control x");
      pendingX = x;
    } else if (pair.code === 20) {
      if (pendingX === null) return invalid(raw, "control y without x");
      const y = readDouble(pair.value);
      if (y === null) return invalid(raw, "non-finite control y");
      controls.push({ x: pendingX, y });
      pendingX = null;
    }
  }
  if (pendingX !== null) return invalid(raw, "control x without y");
  if (controlCount !== null && controls.length !== controlCount) {
    return invalid(
      raw,
      `declares ${String(controlCount)} control points but carries ${String(controls.length)}`,
    );
  }
  const knots: number[] = [];
  for (const pair of raw.pairs) {
    if (pair.code === 40) {
      const knot = readDouble(pair.value);
      if (knot === null) return invalid(raw, "non-finite knot");
      knots.push(knot);
    }
  }
  if (
    knots.length > 0 &&
    controlCount !== null &&
    !isBezierChainKnots(knots, controlCount)
  ) {
    return { tag: "declined", reason: "spline-out-of-subset" };
  }
  try {
    return {
      tag: "entities",
      entities: [
        createSplineEntity(
          mintId(keyed.key),
          "control",
          controls.map((point) => ({
            x: point.x * ctx.scale,
            y: point.y * ctx.scale,
          })),
        ),
      ],
    };
  } catch (error) {
    return invalid(raw, error instanceof Error ? error.message : String(error));
  }
}

/**
 * Whether `knots` is the clamped cubic Bézier-chain vector for the
 * `controlCount` controls: length 3k+5 (k segments), four equal knots at
 * each end, an exact triple at each of the k−1 interior joins,
 * non-decreasing throughout.
 */
function isBezierChainKnots(
  knots: readonly number[],
  controlCount: number,
): boolean {
  const segmentCount = (controlCount - 1) / 3;
  const n = knots.length;
  if (n !== 3 * segmentCount + 5) return false;
  const at = (index: number): number => knots[index] ?? 0;
  for (let i = 1; i < n; i += 1) {
    if (at(i) < at(i - 1)) return false;
  }
  if (at(0) !== at(1) || at(1) !== at(2) || at(2) !== at(3)) return false;
  if (
    at(n - 1) !== at(n - 2) ||
    at(n - 2) !== at(n - 3) ||
    at(n - 3) !== at(n - 4)
  ) {
    return false;
  }
  for (let join = 1; join < segmentCount; join += 1) {
    const base = 3 * join + 1;
    if (at(base) !== at(base + 1) || at(base + 1) !== at(base + 2)) {
      return false;
    }
  }
  return true;
}

/** The pinned converters, keyed by DXF keyword. */
const CONVERTERS: Readonly<
  Record<string, (ctx: ConvertContext, keyed: KeyedEntity) => ConvertOutcome>
> = {
  LINE: convertLine,
  CIRCLE: convertCircle,
  ARC: convertArc,
  LWPOLYLINE: convertLwpolyline,
  POLYLINE: convertLegacyPolyline,
  SPLINE: convertSpline,
};

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Imports `bytes` as an ASCII DXF file into an {@link ImportedDxfSketch}:
 * cad-sketch entities in canonical millimetres with the pinned subset's
 * provenance. Total over byte inputs: either imports or fails with a
 * structured `dxf-import/*` code — never a throw. Deterministic: one
 * pass, fixed order, no time, no randomness.
 */
export function importDxf(
  bytes: Uint8Array,
  options: Readonly<DxfImportOptions> = {},
): DxfImportResult {
  if (bytes.byteLength === 0) {
    return fail(
      dxfError(
        DXF_IMPORT_ERROR_CODES.empty,
        "The input is empty (0 bytes); there is no DXF to import.",
        bytes,
      ),
    );
  }
  // The binary-DXF sentinel opens "\r\n\x1A\x00AutoCAD Binary DXF…"; the
  // 0x1A byte alone already fails the text test, so both arms decline
  // through the same structured code.
  if (!isDecodableText(bytes)) {
    return fail(
      dxfError(
        DXF_IMPORT_ERROR_CODES.binaryUnsupported,
        "The input is binary DXF (or carries bytes no ASCII DXF can); this importer reads ASCII DXF only.",
        bytes,
      ),
    );
  }
  const text = new TextDecoder("latin1").decode(bytes);
  const scanned = scanPairs(text, bytes);
  if (!scanned.ok) return scanned;
  const lifted = liftEntities(scanned.value);

  // --- Units: the HEADER's $INSUNITS (group 9 name, group 70 code). ---
  let unitsSource: DxfUnitsSource = "default-mm";
  let unitName: DxfUnitName | null = null;
  let scale = 1;
  const headerScan = scanned.value;
  for (let i = 0; i + 1 < headerScan.length; i += 1) {
    const pair = headerScan[i];
    const next = headerScan[i + 1];
    if (
      pair?.code === 9 &&
      pair.value.trim() === "$INSUNITS" &&
      next?.code === 70
    ) {
      const code = readInt(next.value);
      if (code === null) {
        return fail(
          dxfError(
            DXF_IMPORT_ERROR_CODES.syntax,
            `HEADER $INSUNITS at line ${String(next.line)} is not an integer.`,
            bytes,
          ),
        );
      }
      if (code !== 0) {
        const name = INSUNITS_TABLE[code];
        if (name === undefined) {
          return fail(
            dxfError(
              DXF_IMPORT_ERROR_CODES.unsupportedUnit,
              `HEADER $INSUNITS value ${String(code)} is outside the documented unit table; refusing to guess a scale.`,
              bytes,
            ),
          );
        }
        unitName = name;
        scale = DXF_UNIT_TO_MILLIMETER_FACTORS[name];
        unitsSource = "insunits";
      }
      break;
    }
  }

  // --- Keys: handles (or the dxf<N> counter), unique before minting. ---
  const keys = new Set<string>();
  const keyed: KeyedEntity[] = [];
  for (let index = 0; index < lifted.length; index += 1) {
    const raw = lifted[index];
    if (raw === undefined) continue;
    if (raw.handle === null) {
      keyed.push({ raw, key: `dxf${String(index)}` });
      continue;
    }
    const key = raw.handle.toLowerCase();
    if (keys.has(key)) {
      return fail(
        dxfError(
          DXF_IMPORT_ERROR_CODES.duplicateHandle,
          `Two ENTITIES-section records claim handle ${JSON.stringify(raw.handle)}; ids mint from handles and could not be trusted.`,
          bytes,
        ),
      );
    }
    keys.add(key);
    keyed.push({ raw, key });
  }

  // --- Convert the pinned subset; record every scope boundary. ---
  const filter =
    options.layers === undefined || options.layers.length === 0
      ? null
      : new Set(options.layers.map((name) => name.toLowerCase()));
  const ctx: ConvertContext = { scale };
  const entities: SketchEntity[] = [];
  const declined: DxfDeclinedEntity[] = [];
  const layers: string[] = [];
  const layerSeen = new Set<string>();
  for (const record of keyed) {
    const raw = record.raw;
    if (raw.kind === "SEQEND") continue;
    const layer = raw.layer ?? "0";
    if (filter !== null && !filter.has(layer.toLowerCase())) continue;
    const convert = CONVERTERS[raw.kind];
    if (convert === undefined) {
      declined.push({
        kind: raw.kind,
        handle: raw.handle,
        layer: raw.layer,
        reason: "kind-out-of-subset",
      });
      continue;
    }
    const outcome = convert(ctx, record);
    if (outcome.tag === "invalid") {
      return fail(
        dxfError(
          DXF_IMPORT_ERROR_CODES.entityInvalid,
          `${outcome.message} — an in-subset entity failed its strict conversion, so the import refuses the file.`,
          bytes,
        ),
      );
    }
    if (outcome.tag === "declined") {
      declined.push({
        kind: raw.kind,
        handle: raw.handle,
        layer: raw.layer,
        reason: outcome.reason,
      });
      continue;
    }
    if (!layerSeen.has(layer.toLowerCase())) {
      layerSeen.add(layer.toLowerCase());
      layers.push(layer);
    }
    entities.push(...outcome.entities);
  }

  return ok({
    entities,
    units: "mm",
    unitsSource,
    unitName,
    layers,
    declined,
  });
}
