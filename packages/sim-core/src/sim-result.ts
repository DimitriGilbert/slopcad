/**
 * The SimResult model (law S7's data half): a run persists as a summary
 * JSON — status, the S9 regime fields, the scenario-snapshot hash, the
 * projected quantities — plus COMPACT BINARY payload blocks for field
 * data, never inside the document and never inside JSON. The binary
 * codec is deterministic: identical blocks encode to identical bytes,
 * bytes decode back to the identical blocks (within the float32 path's
 * stated precision), and any deviation from the layout declines
 * structured (`sim/result-payload-malformed`).
 *
 * ## Binary layout (little-endian throughout)
 *
 * ```
 * u8[4]  magic "SMR1"
 * u32    payload version (1)
 * u32    block count
 * per block:
 *   u16   id byte length, then the id (UTF-8, [A-Za-z0-9._-], ≤ 64 chars)
 *   u8    has-unit flag; when 1: u16 unit byte length, then the unit bytes
 *   u32×3 extent (sample counts per axis, x-fastest value order)
 *   f64×3 origin (mm) and f64×3 spacing (mm) — document space
 *   u8    data type code (0 = float32, 1 = float64)
 *   u32   value count (must equal the extent product)
 *   value count × f32 or f64
 * ```
 *
 * The float32 path is the compact exchange form: encoding rounds each
 * value to IEEE-754 binary32, so a float64 round-trip through a float32
 * block is lossy BY DESIGN (deterministically so), while the float64
 * path round-trips exactly.
 */

import type { SimRegimeReport } from "./regime";
import type { SimProjectedQuantity } from "./units";

import { type SimError, SIM_ERROR_CODES, simError } from "./errors";
import { type SimParseResult, simFail, simOk } from "./result";

/** The summary JSON's schema version. */
export const SIM_RESULT_SUMMARY_VERSION = 1;

/** The binary payload's layout version. */
export const SIM_RESULT_PAYLOAD_VERSION = 1;

/** The run statuses a persisted result may carry. */
export const SIM_RESULT_STATUSES = [
  "completed",
  "failed",
  "cancelled",
] as const;

export type SimResultStatus = (typeof SIM_RESULT_STATUSES)[number];

/**
 * One uniform field data block in document space: sample counts per axis,
 * origin and spacing in millimetres, and the values in x-fastest order
 * (VTK's ImageData order — the .vti exporter writes them verbatim).
 */
export interface SimResultFieldBlock {
  /** The field's id — [A-Za-z0-9._-], the binary id budget's charset. */
  readonly id: string;
  /** The values' unit label (e.g. "mm/s"); absent = dimensionless. */
  readonly unit?: string;
  readonly extent: readonly [number, number, number];
  readonly originMm: readonly [number, number, number];
  readonly spacingMm: readonly [number, number, number];
  readonly dataType: "float32" | "float64";
  /** Exactly extent[0]·extent[1]·extent[2] finite values, x-fastest. */
  readonly values: readonly number[];
}

/** One history series: uniformly sampled scalar samples with their unit. */
export interface SimHistorySeries {
  readonly name: string;
  readonly unit: string;
  readonly samples: readonly number[];
}

/** Which kernel family executed the run — the honest backend record. */
export type SimServedBackend = "cpu" | "gpu";

/** The summary JSON a run persists (schema version, status, S9, provenance). */
export interface SimResultSummary {
  readonly schemaVersion: number;
  /** The scenario record's content hash at run time (§7.11 provenance). */
  readonly scenarioSnapshotHash: string;
  readonly status: SimResultStatus;
  /** The S9 regime fields, computed at compile time and carried here. */
  readonly regime: SimRegimeReport;
  /** The projected quantities with explicit units (the S4 output). */
  readonly quantities: readonly SimProjectedQuantity[];
  /**
   * Which backend EXECUTED the run — distinct from the scenario's
   * backend PREFERENCE (a gpu-preferred run on a GPU-less host serves
   * `"cpu"` here through the router's documented fallback, Phase 64b's
   * honest marker). Optional: summaries written before the field exists
   * (and the fake engine's thermal placeholders) carry none.
   */
  readonly servedBackend?: SimServedBackend;
  /** On a failed run: the `sim/*` decline code and message. */
  readonly failureCode?: string;
  readonly failureMessage?: string;
}

/** A persisted run: the summary, the field blocks, and the histories. */
export interface SimResult {
  readonly summary: SimResultSummary;
  readonly fields: readonly SimResultFieldBlock[];
  readonly histories: readonly SimHistorySeries[];
}

// ---------------------------------------------------------------------------
// Validation shared by the codec and the exporters
// ---------------------------------------------------------------------------

const FIELD_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

/** The binary id/unit length budget (u16 byte lengths; ids also ≤ 64 chars). */
export const SIM_FIELD_LABEL_MAX_BYTES = 255;

function validateFieldBlock(block: SimResultFieldBlock): SimError | undefined {
  if (
    typeof block.id !== "string" ||
    !FIELD_ID_PATTERN.test(block.id) ||
    block.id.length > 64
  ) {
    return simError(
      SIM_ERROR_CODES.resultPayloadMalformed,
      `A field block's id must match [A-Za-z0-9._-] and be 1-64 characters, received "${String(block.id)}".`,
      block.id,
    );
  }
  if (
    block.unit !== undefined &&
    (typeof block.unit !== "string" ||
      block.unit.length === 0 ||
      block.unit.length > SIM_FIELD_LABEL_MAX_BYTES)
  ) {
    return simError(
      SIM_ERROR_CODES.resultPayloadMalformed,
      "A field block's unit must be a non-empty label of at most 255 characters.",
      block.unit,
    );
  }
  const [nx, ny, nz] = block.extent;
  if (
    !Number.isInteger(nx) ||
    !Number.isInteger(ny) ||
    !Number.isInteger(nz) ||
    (nx ?? 0) <= 0 ||
    (ny ?? 0) <= 0 ||
    (nz ?? 0) <= 0
  ) {
    return simError(
      SIM_ERROR_CODES.resultPayloadMalformed,
      "A field block's extent must be three positive integers.",
      block.extent,
    );
  }
  const expected = (nx ?? 1) * (ny ?? 1) * (nz ?? 1);
  if (block.values.length !== expected) {
    return simError(
      SIM_ERROR_CODES.resultPayloadMalformed,
      `A field block's value count (${String(block.values.length)}) must equal its extent product (${String(expected)}).`,
      block,
    );
  }
  for (const triple of [block.originMm, block.spacingMm] as const) {
    if (
      triple.some(
        (entry) => typeof entry !== "number" || !Number.isFinite(entry),
      )
    ) {
      return simError(
        SIM_ERROR_CODES.resultPayloadMalformed,
        "A field block's origin and spacing must be finite triples.",
        triple,
      );
    }
  }
  for (const value of block.values) {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      return simError(
        SIM_ERROR_CODES.resultPayloadMalformed,
        "A field block's values must be finite numbers.",
        value,
      );
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Encode / decode
// ---------------------------------------------------------------------------

const MAGIC_0 = 0x53; // "S"
const MAGIC_1 = 0x4d; // "M"
const MAGIC_2 = 0x52; // "R"
const MAGIC_3 = 0x31; // "1"

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: true });

/**
 * Encodes field blocks to the compact binary payload. Deterministic:
 * identical blocks produce identical bytes, in the caller's block order.
 */
export function encodeSimResultPayload(
  blocks: readonly SimResultFieldBlock[],
): SimParseResult<Uint8Array, SimError> {
  for (const block of blocks) {
    const problem = validateFieldBlock(block);
    if (problem !== undefined) return simFail(problem);
  }
  const parts: Uint8Array[] = [];
  const header = new ArrayBuffer(12);
  const headerView = new DataView(header);
  new Uint8Array(header).set([MAGIC_0, MAGIC_1, MAGIC_2, MAGIC_3], 0);
  headerView.setUint32(4, SIM_RESULT_PAYLOAD_VERSION, true);
  headerView.setUint32(8, blocks.length, true);
  parts.push(new Uint8Array(header));
  for (const block of blocks) {
    const id = textEncoder.encode(block.id);
    const unit =
      block.unit === undefined ? undefined : textEncoder.encode(block.unit);
    const valueBytes =
      block.dataType === "float32"
        ? block.values.length * 4
        : block.values.length * 8;
    const blockHeader = new ArrayBuffer(
      2 +
        id.length +
        1 +
        (unit === undefined ? 0 : 2 + unit.length) +
        12 +
        48 +
        1 +
        4,
    );
    const view = new DataView(blockHeader);
    const bytes = new Uint8Array(blockHeader);
    let cursor = 0;
    view.setUint16(cursor, id.length, true);
    cursor += 2;
    bytes.set(id, cursor);
    cursor += id.length;
    if (unit === undefined) {
      view.setUint8(cursor, 0);
      cursor += 1;
    } else {
      view.setUint8(cursor, 1);
      cursor += 1;
      view.setUint16(cursor, unit.length, true);
      cursor += 2;
      bytes.set(unit, cursor);
      cursor += unit.length;
    }
    const [nx, ny, nz] = block.extent;
    view.setUint32(cursor, nx ?? 0, true);
    view.setUint32(cursor + 4, ny ?? 0, true);
    view.setUint32(cursor + 8, nz ?? 0, true);
    cursor += 12;
    for (const entry of block.originMm) {
      view.setFloat64(cursor, entry, true);
      cursor += 8;
    }
    for (const entry of block.spacingMm) {
      view.setFloat64(cursor, entry, true);
      cursor += 8;
    }
    view.setUint8(cursor, block.dataType === "float32" ? 0 : 1);
    cursor += 1;
    view.setUint32(cursor, block.values.length, true);
    cursor += 4;
    parts.push(bytes.subarray(0, cursor));
    const values = new ArrayBuffer(valueBytes);
    const valuesView = new DataView(values);
    const width = block.dataType === "float32" ? 4 : 8;
    for (const [index, value] of block.values.entries()) {
      if (block.dataType === "float32") {
        valuesView.setFloat32(index * width, value, true);
      } else {
        valuesView.setFloat64(index * width, value, true);
      }
    }
    parts.push(new Uint8Array(values));
  }
  let total = 0;
  for (const part of parts) total += part.length;
  const payload = new Uint8Array(total);
  let cursor = 0;
  for (const part of parts) {
    payload.set(part, cursor);
    cursor += part.length;
  }
  return simOk(payload);
}

/**
 * Decodes the compact binary payload back to field blocks. Strict: wrong
 * magic, unknown version, truncated or overlong input, malformed labels,
 * or non-finite decoded values decline with
 * `sim/result-payload-malformed` — never a partially guessed block.
 */
export function decodeSimResultPayload(
  bytes: Uint8Array,
): SimParseResult<readonly SimResultFieldBlock[], SimError> {
  const malformed = (
    message: string,
    at: unknown = bytes,
  ): SimParseResult<never, SimError> =>
    simFail(simError(SIM_ERROR_CODES.resultPayloadMalformed, message, at));
  if (bytes.length < 12) {
    return malformed(
      "A result payload must carry at least its 12-byte header.",
    );
  }
  if (
    bytes[0] !== MAGIC_0 ||
    bytes[1] !== MAGIC_1 ||
    bytes[2] !== MAGIC_2 ||
    bytes[3] !== MAGIC_3
  ) {
    return malformed(
      'A result payload must start with the magic bytes "SMR1".',
    );
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = view.getUint32(4, true);
  if (version !== SIM_RESULT_PAYLOAD_VERSION) {
    return malformed(
      `A result payload carries version ${String(version)}; this decoder knows version ${String(SIM_RESULT_PAYLOAD_VERSION)}.`,
    );
  }
  const blockCount = view.getUint32(8, true);
  if (blockCount > 1_000_000) {
    return malformed(
      "A result payload's block count exceeds the sanity budget.",
    );
  }
  let cursor = 12;
  const blocks: SimResultFieldBlock[] = [];
  for (let index = 0; index < blockCount; index += 1) {
    if (cursor + 2 > bytes.length) {
      return malformed(
        `The result payload truncated inside block ${String(index)}'s id length.`,
      );
    }
    const idLength = view.getUint16(cursor, true);
    cursor += 2;
    if (cursor + idLength + 1 > bytes.length) {
      return malformed(
        `The result payload truncated inside block ${String(index)}'s id.`,
      );
    }
    let id: string;
    try {
      id = textDecoder.decode(bytes.subarray(cursor, cursor + idLength));
    } catch {
      return malformed(`Block ${String(index)}'s id is not valid UTF-8.`);
    }
    cursor += idLength;
    const hasUnit = view.getUint8(cursor);
    cursor += 1;
    let unit: string | undefined;
    if (hasUnit === 1) {
      if (cursor + 2 > bytes.length) {
        return malformed(
          `The result payload truncated inside block ${String(index)}'s unit length.`,
        );
      }
      const unitLength = view.getUint16(cursor, true);
      cursor += 2;
      if (cursor + unitLength > bytes.length) {
        return malformed(
          `The result payload truncated inside block ${String(index)}'s unit.`,
        );
      }
      try {
        unit = textDecoder.decode(bytes.subarray(cursor, cursor + unitLength));
      } catch {
        return malformed(`Block ${String(index)}'s unit is not valid UTF-8.`);
      }
      cursor += unitLength;
    } else if (hasUnit !== 0) {
      return malformed(
        `Block ${String(index)}'s has-unit flag must be 0 or 1.`,
      );
    }
    if (cursor + 12 + 48 + 1 + 4 > bytes.length) {
      return malformed(
        `The result payload truncated inside block ${String(index)}'s header.`,
      );
    }
    const extent: [number, number, number] = [
      view.getUint32(cursor, true),
      view.getUint32(cursor + 4, true),
      view.getUint32(cursor + 8, true),
    ];
    cursor += 12;
    const originMm: [number, number, number] = [
      view.getFloat64(cursor, true),
      view.getFloat64(cursor + 8, true),
      view.getFloat64(cursor + 16, true),
    ];
    cursor += 24;
    const spacingMm: [number, number, number] = [
      view.getFloat64(cursor, true),
      view.getFloat64(cursor + 8, true),
      view.getFloat64(cursor + 16, true),
    ];
    cursor += 24;
    const typeCode = view.getUint8(cursor);
    cursor += 1;
    if (typeCode !== 0 && typeCode !== 1) {
      return malformed(
        `Block ${String(index)}'s data type code must be 0 (float32) or 1 (float64).`,
      );
    }
    const dataType: "float32" | "float64" =
      typeCode === 0 ? "float32" : "float64";
    const valueCount = view.getUint32(cursor, true);
    cursor += 4;
    const width = dataType === "float32" ? 4 : 8;
    if (
      !Number.isSafeInteger(valueCount) ||
      valueCount > 100_000_000 ||
      cursor + valueCount * width > bytes.length
    ) {
      return malformed(
        `Block ${String(index)}'s value count exceeds the payload's bytes.`,
      );
    }
    const values = new Array<number>(valueCount);
    for (let valueIndex = 0; valueIndex < valueCount; valueIndex += 1) {
      const value =
        dataType === "float32"
          ? view.getFloat32(cursor, true)
          : view.getFloat64(cursor, true);
      cursor += width;
      values[valueIndex] = value;
    }
    const block: SimResultFieldBlock = {
      id,
      ...(unit === undefined ? {} : { unit }),
      extent,
      originMm,
      spacingMm,
      dataType,
      values,
    };
    const problem = validateFieldBlock(block);
    if (problem !== undefined) return simFail(problem);
    blocks.push(Object.freeze(block));
  }
  if (cursor !== bytes.length) {
    return malformed(
      `The result payload carries ${String(bytes.length - cursor)} trailing bytes past its last block.`,
    );
  }
  return simOk(Object.freeze(blocks));
}
