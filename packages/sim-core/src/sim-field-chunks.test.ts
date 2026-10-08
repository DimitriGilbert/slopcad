/**
 * Field-chunk framing tests (Phase 61b): the lossless, deterministic
 * contract between a run's chunk stream and the 61a result payload blocks —
 * reassembly from gapless indices, structured declines on framing
 * violations, and the identity `split → reassemble → encode === the block's
 * own payload bytes` that law S6's committed applications ride on.
 */

import { describe, expect, it } from "vitest";
import type { SimEngineFieldChunk } from "./engine";

import {
  decodeSimFieldChunkValues,
  encodeSimFieldChunkValues,
  reassembleSimFieldChunks,
  splitSimFieldBlock,
} from "./sim-field-chunks";
import { SIM_ERROR_CODES } from "./errors";
import { encodeSimResultPayload } from "./sim-result";

function block(values: readonly number[]) {
  return {
    id: "velocity-magnitude",
    unit: "mm/s",
    extent: [values.length, 1, 1] as const,
    originMm: [0, 0, 0] as const,
    spacingMm: [2.5, 2.5, 2.5] as const,
    dataType: "float32" as const,
    values,
  };
}

/** NoUncheckedIndexedAccess-safe fixture access. */
function at<T>(items: readonly T[], index: number): T {
  const value = items[index];
  if (value === undefined) {
    throw new Error(`test fixture index ${String(index)} is out of range`);
  }
  return value;
}

describe("split → reassemble", () => {
  it("reassembles a split block to exactly the block, in any arrival order", () => {
    const source = block([1, 2, 3, 4, 5, 6, 7, 8]);
    const chunks = splitSimFieldBlock(source, 3);
    expect(chunks.map((chunk) => chunk.values)).toEqual([
      [1, 2, 3],
      [4, 5, 6],
      [7, 8],
    ]);
    const inOrder = reassembleSimFieldChunks(chunks);
    expect(inOrder.ok).toBe(true);
    if (!inOrder.ok) return;
    expect(inOrder.value).toEqual(source);
    // Indices are the truth, not arrival: a shuffled stream reassembles to
    // the same block.
    const shuffled = reassembleSimFieldChunks([
      at(chunks, 2),
      at(chunks, 0),
      at(chunks, 1),
    ]);
    expect(shuffled.ok && shuffled.value).toEqual(source);
  });

  it("reassembles the single-chunk stream of a one-value block", () => {
    const source = block([42]);
    const reassembled = reassembleSimFieldChunks(splitSimFieldBlock(source, 1));
    expect(reassembled.ok && reassembled.value).toEqual(source);
  });

  it("produces chunk streams whose concatenation encodes to the block's own payload bytes", () => {
    const source = block([0.5, -1.25, 3.75, -0.125, 8, 16, -32, 64]);
    const chunks: SimEngineFieldChunk[] = [...splitSimFieldBlock(source, 4)];
    const reassembled = reassembleSimFieldChunks(chunks);
    expect(reassembled.ok).toBe(true);
    if (!reassembled.ok) return;
    const fromStream = encodeSimResultPayload([reassembled.value]);
    const direct = encodeSimResultPayload([source]);
    expect(fromStream.ok && direct.ok).toBe(true);
    if (!fromStream.ok || !direct.ok) return;
    expect(fromStream.value).toEqual(direct.value);
  });
});

describe("framing violations decline structured", () => {
  const source = block([1, 2, 3, 4, 5, 6, 7, 8]);
  const chunks = splitSimFieldBlock(source, 4);

  function expectInvalid(
    result: ReturnType<typeof reassembleSimFieldChunks>,
  ): void {
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(SIM_ERROR_CODES.fieldChunksInvalid);
  }

  it("declines an empty stream", () => {
    expectInvalid(reassembleSimFieldChunks([]));
  });

  it("declines a gap (a missing chunk index)", () => {
    expectInvalid(
      reassembleSimFieldChunks([at(chunks, 0), at(chunks, 1), at(chunks, 3)]),
    );
  });

  it("declines a duplicate index", () => {
    expectInvalid(
      reassembleSimFieldChunks([
        at(chunks, 0),
        at(chunks, 1),
        at(chunks, 2),
        at(chunks, 2),
      ]),
    );
  });

  it("declines a count disagreement with the declared chunkCount", () => {
    expectInvalid(reassembleSimFieldChunks(chunks.slice(0, 3)));
  });

  it("declines a header that disagrees across chunks", () => {
    const rogue = {
      ...at(chunks, 3),
      spacingMm: [9, 9, 9] as const,
    };
    expectInvalid(
      reassembleSimFieldChunks([
        at(chunks, 0),
        at(chunks, 1),
        at(chunks, 2),
        rogue,
      ]),
    );
  });

  it("declines slices that do not sum to the extent product", () => {
    const short = chunks.map((chunk, index) =>
      index === 0 ? { ...chunk, values: chunk.values.slice(0, 1) } : chunk,
    );
    expectInvalid(reassembleSimFieldChunks(short));
  });

  it("declines a non-finite value", () => {
    const poisoned = chunks.map((chunk, index) =>
      index === 1 ? { ...chunk, values: [Number.NaN, 2] } : chunk,
    );
    expectInvalid(reassembleSimFieldChunks(poisoned));
  });
});

describe("value byte codec", () => {
  it("encodes and decodes the payload layout's little-endian float bytes", () => {
    const values = [1.5, -2.25, 1000.125];
    const bytes = encodeSimFieldChunkValues(values, "float64");
    expect(bytes.length).toBe(24);
    // A hand-checkable byte: 1.5 as float64 little-endian is 0x3FF8000000000000.
    expect([...bytes.slice(0, 8)]).toEqual([
      0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xf8, 0x3f,
    ]);
    const decoded = decodeSimFieldChunkValues(bytes, "float64", 3);
    expect(decoded.ok && decoded.value).toEqual(values);
  });

  it("round-trips the float32 width exactly for dyadic values", () => {
    const values = [0.5, -0.25, 1024.75];
    const bytes = encodeSimFieldChunkValues(values, "float32");
    expect(bytes.length).toBe(12);
    const decoded = decodeSimFieldChunkValues(bytes, "float32", 3);
    expect(decoded.ok && decoded.value).toEqual(values);
  });

  it("declines a count that does not match the byte length", () => {
    const bytes = encodeSimFieldChunkValues([1, 2, 3, 4], "float32");
    const wrong = decodeSimFieldChunkValues(bytes, "float32", 3);
    expect(wrong.ok).toBe(false);
    if (wrong.ok) return;
    expect(wrong.error.code).toBe(SIM_ERROR_CODES.fieldChunksInvalid);
  });

  it("declines bytes that decode to a non-finite float", () => {
    // All-0xFF bytes are a NaN pattern in both widths.
    const nanBytes = new Uint8Array(8).fill(0xff);
    const decoded = decodeSimFieldChunkValues(nanBytes, "float64", 1);
    expect(decoded.ok).toBe(false);
  });
});
