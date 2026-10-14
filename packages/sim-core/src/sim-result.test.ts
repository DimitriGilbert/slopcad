/**
 * SimResult model tests: the binary payload codec's deterministic
 * encode/decode round-trip, its strict refusals, and byte-determinism of
 * repeated encodes.
 */

import { describe, expect, it } from "vitest";

import { SIM_ERROR_CODES } from "./errors";
import {
  type SimResultFieldBlock,
  decodeSimResultPayload,
  encodeSimResultPayload,
} from "./sim-result";

function requireOk<T, E extends { readonly message: string }>(
  result:
    | { readonly ok: true; readonly value: T }
    | { readonly ok: false; readonly error: E },
  what: string,
): T {
  if (!result.ok) {
    throw new Error(
      `The result test rejected ${what}: ${result.error.message}`,
    );
  }
  return result.value;
}

function block(
  overrides: Partial<SimResultFieldBlock> = {},
): SimResultFieldBlock {
  return {
    id: "velocityMagnitude",
    unit: "mm/s",
    extent: [2, 2, 1],
    originMm: [0, 0, 0],
    spacingMm: [1, 1, 1],
    dataType: "float64",
    values: [1.5, 2.5, 3.5, 4.5],
    ...overrides,
  };
}

describe("the binary payload codec", () => {
  it("round-trips float64 blocks exactly and re-encodes byte-identically", () => {
    const blocks = [
      block(),
      block({
        id: "pressure",
        unit: "Pa",
        values: [101325, 101300, 101250, 101000],
      }),
    ];
    const bytes = requireOk(encodeSimResultPayload(blocks), "the encode");
    const decoded = requireOk(decodeSimResultPayload(bytes), "the decode");
    expect(decoded).toEqual(blocks);
    const reencoded = requireOk(
      encodeSimResultPayload(decoded),
      "the re-encode",
    );
    expect(reencoded).toEqual(bytes);
  });

  it("is byte-deterministic across repeated encodes", () => {
    const first = requireOk(encodeSimResultPayload([block()]), "encode one");
    const second = requireOk(encodeSimResultPayload([block()]), "encode two");
    expect(second).toEqual(first);
  });

  it("round-trips float32 blocks deterministically (lossy by design)", () => {
    const f32 = block({
      dataType: "float32",
      values: [0.1, 0.2, 0.30000001, 1],
    });
    const bytes = requireOk(encodeSimResultPayload([f32]), "the f32 encode");
    const decoded = requireOk(decodeSimResultPayload(bytes), "the f32 decode");
    const value = decoded[0]?.values[0];
    expect(value).not.toBe(0.1);
    expect(value).toBeCloseTo(0.1, 7);
    const reencoded = requireOk(
      encodeSimResultPayload(decoded),
      "the f32 re-encode",
    );
    expect(reencoded).toEqual(bytes);
  });

  it("omits the unit field when absent and preserves it when present", () => {
    const unitless = block({ unit: undefined });
    const decoded = requireOk(
      decodeSimResultPayload(
        requireOk(encodeSimResultPayload([unitless]), "the encode"),
      ),
      "the decode",
    );
    expect(decoded[0]?.unit).toBeUndefined();
    expect(decoded[0]?.id).toBe("velocityMagnitude");
  });

  it("refuses wrong magic, unknown versions, truncation, and trailing bytes", () => {
    const bytes = requireOk(encodeSimResultPayload([block()]), "the encode");
    const badMagic = new Uint8Array(bytes);
    badMagic.set([0x58, 0x58, 0x58, 0x58], 0);
    expect(decodeSimResultPayload(badMagic).ok).toBe(false);

    const badVersion = new Uint8Array(bytes);
    badVersion.set([0, 0, 0, 2], 4);
    const versionResult = decodeSimResultPayload(badVersion);
    expect(versionResult.ok).toBe(false);
    if (versionResult.ok) return;
    expect(versionResult.error.code).toBe(
      SIM_ERROR_CODES.resultPayloadMalformed,
    );

    const truncated = decodeSimResultPayload(
      bytes.subarray(0, bytes.length - 1),
    );
    expect(truncated.ok).toBe(false);

    const trailing = decodeSimResultPayload(new Uint8Array([...bytes, 0]));
    expect(trailing.ok ? true : trailing.error.code).toBe(
      SIM_ERROR_CODES.resultPayloadMalformed,
    );
  });

  it("refuses blocks whose labels or extents violate the layout", () => {
    const badId = encodeSimResultPayload([block({ id: "not a valid id!" })]);
    expect(badId.ok).toBe(false);
    const badCount = encodeSimResultPayload([block({ values: [1, 2, 3] })]);
    expect(badCount.ok).toBe(false);
    const badValues = encodeSimResultPayload([
      block({ values: [1, Number.NaN, 3, 4] }),
    ]);
    expect(badValues.ok).toBe(false);
  });
});
