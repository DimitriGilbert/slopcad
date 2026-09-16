/**
 * Worker protocol identifiers (Phase 10.1): wire format, brand discipline,
 * and the deterministic generator that mints correlation-safe request ids and
 * worker-solid ids.
 */

import { describe, expect, it } from "vitest";
import { type ParseResult } from "@slopcad/cad-core";

import {
  createWorkerIdGenerator,
  createWorkerRequestId,
  createWorkerSolidId,
  type WorkerIdParseError,
  parseAnyWorkerId,
  parseWorkerRequestId,
  parseWorkerSolidId,
  WorkerIdGeneratorExhaustedError,
  WorkerIdValidationError,
  WORKER_ID_ERROR_CODES,
  WORKER_ID_GENERATOR_ERROR_CODES,
  WORKER_ID_KINDS,
  WORKER_ID_MAX_PAYLOAD_LENGTH,
  WORKER_ID_PREFIXES,
} from "./worker-ids";

function failureOf(
  result: ParseResult<unknown, WorkerIdParseError>,
): WorkerIdParseError {
  if (result.ok) throw new Error("Expected the parse to fail.");
  return result.error;
}

describe("worker id wire format", () => {
  it("uses the canonical wire prefix for each kind", () => {
    expect(WORKER_ID_PREFIXES).toEqual({ request: "req", solid: "wsol" });
    expect(WORKER_ID_KINDS).toEqual(["request", "solid"]);
  });

  it("round-trips both id kinds through JSON", () => {
    const request = createWorkerRequestId("req_000042");
    const solid = createWorkerSolidId("wsol_clamp-pad.1");
    expect(JSON.parse(JSON.stringify(request))).toBe(request);
    expect(JSON.parse(JSON.stringify(solid))).toBe(solid);
  });

  it("accepts payloads up to the documented maximum and rejects longer ones", () => {
    const atLimit = `req_${"a".repeat(WORKER_ID_MAX_PAYLOAD_LENGTH)}`;
    const beyondLimit = `req_${"a".repeat(WORKER_ID_MAX_PAYLOAD_LENGTH + 1)}`;
    expect(parseWorkerRequestId(atLimit).ok).toBe(true);
    expect(parseWorkerRequestId(beyondLimit).ok).toBe(false);
  });
});

describe("worker id parsing", () => {
  it("parses valid ids of each kind", () => {
    expect(parseWorkerRequestId("req_1")).toEqual({
      ok: true,
      value: "req_1",
    });
    expect(parseWorkerSolidId("wsol_000007")).toEqual({
      ok: true,
      value: "wsol_000007",
    });
  });

  it("rejects non-strings with the not-a-string code", () => {
    for (const input of [null, 42, {}, [], true]) {
      expect(failureOf(parseWorkerRequestId(input)).code).toBe(
        WORKER_ID_ERROR_CODES.notAString,
      );
    }
  });

  it("rejects empty strings with the empty code", () => {
    expect(failureOf(parseWorkerSolidId("")).code).toBe(
      WORKER_ID_ERROR_CODES.empty,
    );
  });

  it("rejects the wrong prefix with the wrong-prefix code", () => {
    expect(failureOf(parseWorkerRequestId("wsol_000001")).code).toBe(
      WORKER_ID_ERROR_CODES.wrongPrefix,
    );
  });

  it("rejects invalid payloads with the invalid-payload code", () => {
    for (const input of ["req_", "req_1 spaced", "req_-dash", "req_#hash"]) {
      expect(failureOf(parseWorkerRequestId(input)).code).toBe(
        WORKER_ID_ERROR_CODES.invalidPayload,
      );
    }
  });

  it("classifies ids of any kind by prefix", () => {
    expect(parseAnyWorkerId("req_alpha")).toEqual({
      ok: true,
      value: { kind: "request", id: "req_alpha" },
    });
    expect(parseAnyWorkerId("wsol_beta")).toEqual({
      ok: true,
      value: { kind: "solid", id: "wsol_beta" },
    });
  });

  it("rejects unknown prefixes when classifying", () => {
    expect(failureOf(parseAnyWorkerId("other_gamma")).code).toBe(
      WORKER_ID_ERROR_CODES.wrongPrefix,
    );
  });

  it("rejects non-strings, empty strings, and missing separators when classifying", () => {
    expect(failureOf(parseAnyWorkerId(42)).code).toBe(
      WORKER_ID_ERROR_CODES.notAString,
    );
    expect(failureOf(parseAnyWorkerId("")).code).toBe(
      WORKER_ID_ERROR_CODES.empty,
    );
    expect(failureOf(parseAnyWorkerId("req")).code).toBe(
      WORKER_ID_ERROR_CODES.wrongPrefix,
    );
  });
});

describe("worker id constructors", () => {
  it("adopts explicit ids exactly as given", () => {
    expect(createWorkerRequestId("req_from-ui.2")).toBe("req_from-ui.2");
    expect(createWorkerSolidId("wsol_imported")).toBe("wsol_imported");
  });

  it("throws WorkerIdValidationError on wire-format violations", () => {
    expect(() => createWorkerRequestId("req_ bad")).toThrow(
      WorkerIdValidationError,
    );
    expect(() => createWorkerSolidId("req_000001")).toThrow(
      WorkerIdValidationError,
    );
  });
});

describe("worker id generator", () => {
  it("mints zero-padded ids from a monotonic counter", () => {
    const generator = createWorkerIdGenerator();
    expect(generator.nextRequestId()).toBe("req_000001");
    expect(generator.nextRequestId()).toBe("req_000002");
    expect(generator.nextSolidId()).toBe("wsol_000001");
  });

  it("produces identical sequences from identical state", () => {
    const first = createWorkerIdGenerator({ request: 7, solid: 0 });
    const second = createWorkerIdGenerator({ request: 7, solid: 0 });
    for (let i = 0; i < 5; i += 1) {
      expect(first.nextRequestId()).toBe(second.nextRequestId());
    }
    expect(first.nextSolidId()).toBe(second.nextSolidId());
  });

  it("never re-emits an id: counters and snapshots round-trip", () => {
    const generator = createWorkerIdGenerator();
    generator.nextRequestId();
    generator.nextRequestId();
    generator.nextSolidId();
    const state = generator.state();
    expect(JSON.parse(JSON.stringify(state))).toEqual(state);
    const resumed = createWorkerIdGenerator(state);
    expect(resumed.nextRequestId()).toBe("req_000003");
    expect(resumed.nextSolidId()).toBe("wsol_000002");
  });

  it("emits ids that parse under their own wire format", () => {
    const generator = createWorkerIdGenerator();
    for (let i = 0; i < 10; i += 1) {
      expect(parseWorkerRequestId(generator.nextRequestId()).ok).toBe(true);
      expect(parseWorkerSolidId(generator.nextSolidId()).ok).toBe(true);
    }
  });

  it("rejects invalid generator state with a RangeError", () => {
    expect(() => createWorkerIdGenerator({ request: -1, solid: 0 })).toThrow(
      RangeError,
    );
    expect(() => createWorkerIdGenerator({ request: 1.5, solid: 0 })).toThrow(
      RangeError,
    );
  });

  it("refuses to emit ids past the exact-integer range", () => {
    const generator = createWorkerIdGenerator({
      request: Number.MAX_SAFE_INTEGER,
      solid: 0,
    });
    expect(() => generator.nextRequestId()).toThrow(
      WorkerIdGeneratorExhaustedError,
    );
    // The exhausted counter is untouched; the other kind keeps emitting.
    expect(generator.nextSolidId()).toBe("wsol_000001");
    expect(generator.state().request).toBe(Number.MAX_SAFE_INTEGER);
  });

  it("carries the stable exhausted error code", () => {
    let caught: WorkerIdGeneratorExhaustedError | undefined;
    try {
      createWorkerIdGenerator({
        request: Number.MAX_SAFE_INTEGER,
        solid: 0,
      }).nextRequestId();
    } catch (error) {
      if (error instanceof WorkerIdGeneratorExhaustedError) caught = error;
    }
    expect(caught).toBeDefined();
    expect(caught?.code).toBe(WORKER_ID_GENERATOR_ERROR_CODES.exhausted);
    expect(caught?.kind).toBe("request");
  });
});
