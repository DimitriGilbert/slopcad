/**
 * Field-chunk framing (Phase 61b): the lossless, deterministic bridge
 * between a run's streaming chunk emissions (law S6 — each applied update is
 * a committed application) and the 61a {@link SimResult} binary payload
 * blocks (law S7 — the persisted form).
 *
 * A field's chunk stream reassembles into EXACTLY the block the finalized
 * result carries: one header (id, unit, extent, origin, spacing, float
 * width) shared verbatim by every chunk, gapless zero-based chunk indices,
 * and value slices whose concatenation in chunk order is the block's full
 * x-fastest value array. Any deviation — a gap, a duplicate, a header that
 * disagrees across chunks, slices that do not sum to the extent product —
 * declines structured with `sim/field-chunks-invalid`; the reassembler
 * never guesses a partial block.
 *
 * The wire form carries each chunk's values as the raw little-endian float
 * bytes of the payload block layout (f32 or f64 per the chunk's data type),
 * base64-encoded through `./sim-base64` — so the bytes of a reassembled
 * block encode through {@link encodeSimResultPayload} to exactly the bytes
 * the worker's `sim.finalize` result carries. That identity is the
 * losslessness claim, and it is pinned by tests end to end.
 */

import type { SimEngineFieldChunk } from "./engine";
import type { SimError } from "./errors";
import type { SimResultFieldBlock } from "./sim-result";

import { SIM_ERROR_CODES, simError } from "./errors";
import { type SimParseResult, simFail, simOk } from "./result";

/** Sanity budget for one chunk's value count (mirrors the payload decoder). */
export const SIM_FIELD_CHUNK_MAX_VALUES = 100_000_000;

function invalid(message: string, at?: unknown): SimError {
  return simError(SIM_ERROR_CODES.fieldChunksInvalid, message, at ?? message);
}

function isFiniteNumber(input: unknown): input is number {
  return typeof input === "number" && Number.isFinite(input);
}

/**
 * The header every chunk of one field shares: everything but the slice.
 * Equality is exact — one disagreeing component fails the whole stream.
 */
interface SimFieldChunkHeader {
  readonly id: string;
  readonly unit: string | undefined;
  readonly extent: readonly [number, number, number];
  readonly originMm: readonly [number, number, number];
  readonly spacingMm: readonly [number, number, number];
  readonly dataType: "float32" | "float64";
}

function headerOf(chunk: SimEngineFieldChunk): SimFieldChunkHeader {
  return {
    id: chunk.id,
    unit: chunk.unit,
    extent: chunk.extent,
    originMm: chunk.originMm,
    spacingMm: chunk.spacingMm,
    dataType: chunk.dataType,
  };
}

function headersEqual(a: SimFieldChunkHeader, b: SimFieldChunkHeader): boolean {
  return (
    a.id === b.id &&
    a.unit === b.unit &&
    a.dataType === b.dataType &&
    a.extent.every((value, axis) => value === b.extent[axis]) &&
    a.originMm.every((value, axis) => value === b.originMm[axis]) &&
    a.spacingMm.every((value, axis) => value === b.spacingMm[axis])
  );
}

/**
 * Validates and sorts one field's chunks and reassembles them into the
 * document-space block they frame. The input order is the arrival order; the
 * chunks' own indices define the assembly order (a stream delivered out of
 * order still reassembles — indices are the truth, not arrival). Declines
 * structured on any framing violation, never returns a partial block.
 */
export function reassembleSimFieldChunks(
  chunks: readonly SimEngineFieldChunk[],
): SimParseResult<SimResultFieldBlock, SimError> {
  if (chunks.length === 0) {
    return simFail(
      invalid("A field-chunk stream must carry at least one chunk.", chunks),
    );
  }
  const first = chunks[0];
  if (first === undefined) {
    return simFail(
      invalid("A field-chunk stream must carry at least one chunk.", chunks),
    );
  }
  const header = headerOf(first);
  if (
    !Number.isInteger(first.chunkCount) ||
    first.chunkCount <= 0 ||
    first.chunkCount > 1_000_000
  ) {
    return simFail(
      invalid(
        "A field-chunk stream's chunk count must be a positive integer.",
        first.chunkCount,
      ),
    );
  }
  if (chunks.length !== first.chunkCount) {
    return simFail(
      invalid(
        `A field-chunk stream carries ${String(chunks.length)} chunks but declares ${String(first.chunkCount)}.`,
        chunks.map((chunk) => chunk.chunkIndex),
      ),
    );
  }
  const byIndex = new Map<number, SimEngineFieldChunk>();
  for (const chunk of chunks) {
    if (!headersEqual(headerOf(chunk), header)) {
      return simFail(
        invalid(
          `Every chunk of field "${header.id}" must carry the same header (id, unit, extent, origin, spacing, data type).`,
          chunk,
        ),
      );
    }
    if (
      !Number.isInteger(chunk.chunkIndex) ||
      chunk.chunkIndex < 0 ||
      chunk.chunkIndex >= first.chunkCount
    ) {
      return simFail(
        invalid(
          `A field chunk's index must be an integer in [0, ${String(first.chunkCount - 1)}].`,
          chunk.chunkIndex,
        ),
      );
    }
    if (byIndex.has(chunk.chunkIndex)) {
      return simFail(
        invalid(
          `Field "${header.id}" carries more than one chunk with index ${String(chunk.chunkIndex)}.`,
          chunk.chunkIndex,
        ),
      );
    }
    if (!Array.isArray(chunk.values)) {
      return simFail(
        invalid(
          `A chunk of field "${header.id}" must carry a values array.`,
          chunk,
        ),
      );
    }
    for (const value of chunk.values) {
      if (!isFiniteNumber(value)) {
        return simFail(
          invalid(
            `A chunk of field "${header.id}" carries a non-finite value.`,
            value,
          ),
        );
      }
    }
    byIndex.set(chunk.chunkIndex, chunk);
  }
  const [nx, ny, nz] = header.extent;
  if (
    !Number.isInteger(nx) ||
    !Number.isInteger(ny) ||
    !Number.isInteger(nz) ||
    nx <= 0 ||
    ny <= 0 ||
    nz <= 0
  ) {
    return simFail(
      invalid("A field-chunk stream's extent must be three positive integers."),
    );
  }
  const expected = nx * ny * nz;
  const values: number[] = [];
  for (let index = 0; index < first.chunkCount; index += 1) {
    const chunk = byIndex.get(index);
    if (chunk === undefined) {
      return simFail(
        invalid(
          `Field "${header.id}" is missing chunk ${String(index)}; chunk streams must be gapless.`,
          index,
        ),
      );
    }
    // Loop, not spread: chunk slices can be large, and a spread call would
    // put every element on the call stack at once.
    for (const value of chunk.values) {
      values.push(value);
    }
  }
  if (values.length !== expected) {
    return simFail(
      invalid(
        `Field "${header.id}" reassembles to ${String(values.length)} values; its extent product is ${String(expected)}.`,
        values.length,
      ),
    );
  }
  const block: SimResultFieldBlock = {
    id: header.id,
    ...(header.unit === undefined ? {} : { unit: header.unit }),
    extent: header.extent,
    originMm: header.originMm,
    spacingMm: header.spacingMm,
    dataType: header.dataType,
    values,
  };
  return simOk(block);
}

// ---------------------------------------------------------------------------
// Chunk value bytes — the payload block's little-endian float layout
// ---------------------------------------------------------------------------

/**
 * Encodes one chunk's values to their raw little-endian float bytes — the
 * exact per-value layout of a {@link SimResultFieldBlock} payload entry at
 * the chunk's data-type width, so concatenated chunk bytes are a slice of
 * the block's payload bytes.
 */
export function encodeSimFieldChunkValues(
  values: readonly number[],
  dataType: "float32" | "float64",
): Uint8Array {
  const width = dataType === "float32" ? 4 : 8;
  const bytes = new Uint8Array(values.length * width);
  const view = new DataView(bytes.buffer);
  for (const [index, value] of values.entries()) {
    if (dataType === "float32") {
      view.setFloat32(index * width, value, true);
    } else {
      view.setFloat64(index * width, value, true);
    }
  }
  return bytes;
}

/**
 * Decodes raw little-endian float bytes back to values at the given width —
 * the inverse of {@link encodeSimFieldChunkValues}. Declines structured when
 * the byte length is not a whole multiple of the width or a count budget is
 * exceeded; decoded non-finite values (a NaN bit pattern crossed the wire)
 * decline too, mirroring the payload decoder's strictness.
 */
export function decodeSimFieldChunkValues(
  bytes: Uint8Array,
  dataType: "float32" | "float64",
  valueCount: number,
): SimParseResult<readonly number[], SimError> {
  const width = dataType === "float32" ? 4 : 8;
  if (
    !Number.isSafeInteger(valueCount) ||
    valueCount < 0 ||
    valueCount > SIM_FIELD_CHUNK_MAX_VALUES ||
    bytes.length !== valueCount * width
  ) {
    return simFail(
      invalid(
        `A field chunk declares ${String(valueCount)} values, which its byte length (${String(bytes.length)}) does not match at width ${String(width)}.`,
        valueCount,
      ),
    );
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const values = new Array<number>(valueCount);
  for (let index = 0; index < valueCount; index += 1) {
    const value =
      dataType === "float32"
        ? view.getFloat32(index * width, true)
        : view.getFloat64(index * width, true);
    if (!Number.isFinite(value)) {
      return simFail(
        invalid(
          "A field chunk's decoded values must be finite; the bytes decode to a non-finite float.",
          index,
        ),
      );
    }
    values[index] = value;
  }
  return simOk(values);
}

/**
 * Slices one field block into `chunkCount` chunks with contiguous, roughly
 * even value slices — the deterministic emitter-side twin of
 * {@link reassembleSimFieldChunks}: the chunks it produces reassemble to
 * exactly the input block. Slice boundaries are the floor-division split
 * (earlier chunks carry the remainder), so the split is a pure function of
 * the value count and chunk count.
 */
export function splitSimFieldBlock(
  block: SimResultFieldBlock,
  chunkCount: number,
): readonly SimEngineFieldChunk[] {
  if (!Number.isInteger(chunkCount) || chunkCount <= 0) {
    throw new RangeError(
      `chunkCount must be a positive integer, received ${String(chunkCount)}.`,
    );
  }
  if (chunkCount > block.values.length) {
    throw new RangeError(
      `chunkCount (${String(chunkCount)}) must not exceed the block's value count (${String(block.values.length)}).`,
    );
  }
  const base = Math.floor(block.values.length / chunkCount);
  const remainder = block.values.length % chunkCount;
  const chunks: SimEngineFieldChunk[] = [];
  let cursor = 0;
  for (let index = 0; index < chunkCount; index += 1) {
    const size = base + (index < remainder ? 1 : 0);
    chunks.push({
      id: block.id,
      ...(block.unit === undefined ? {} : { unit: block.unit }),
      extent: block.extent,
      originMm: block.originMm,
      spacingMm: block.spacingMm,
      dataType: block.dataType,
      chunkIndex: index,
      chunkCount,
      values: block.values.slice(cursor, cursor + size),
    });
    cursor += size;
  }
  return chunks;
}
