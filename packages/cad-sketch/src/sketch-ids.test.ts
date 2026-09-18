import { describe, expect, it } from "vitest";

import {
  SKETCH_ID_ERROR_CODES,
  SketchIdGeneratorExhaustedError,
  SketchIdValidationError,
  createSketchConstraintId,
  createSketchEntityId,
  createSketchIdGenerator,
  parseAnySketchId,
  parseSketchConstraintId,
  parseSketchEntityId,
} from "./sketch-ids";

describe("sketch ids", () => {
  it("adopts valid wire-format ids and rejects malformed ones", () => {
    expect(createSketchEntityId("skent_wall-start").toString()).toBe(
      "skent_wall-start",
    );
    expect(createSketchConstraintId("skcon_000001")).toBeDefined();
    expect(() => createSketchEntityId("skcon_wrong")).toThrow(
      SketchIdValidationError,
    );
    expect(() => createSketchEntityId("skent_")).toThrow(
      SketchIdValidationError,
    );
    expect(() => createSketchEntityId("skent_-leading")).toThrow(
      SketchIdValidationError,
    );
    expect(() => createSketchEntityId("skent_has space")).toThrow(
      SketchIdValidationError,
    );
    expect(() => createSketchConstraintId(`skcon_${"a".repeat(65)}`)).toThrow(
      SketchIdValidationError,
    );
  });

  it("parses untrusted ids with structured failures per code", () => {
    const notAString = parseSketchEntityId(7);
    expect(!notAString.ok && notAString.error.code).toBe(
      SKETCH_ID_ERROR_CODES.notAString,
    );
    const empty = parseSketchEntityId("");
    expect(!empty.ok && empty.error.code).toBe(SKETCH_ID_ERROR_CODES.empty);
    const wrongPrefix = parseSketchEntityId("doc_root");
    expect(!wrongPrefix.ok && wrongPrefix.error.code).toBe(
      SKETCH_ID_ERROR_CODES.wrongPrefix,
    );
    const invalidPayload = parseSketchConstraintId("skcon_bad!id");
    expect(!invalidPayload.ok && invalidPayload.error.code).toBe(
      SKETCH_ID_ERROR_CODES.invalidPayload,
    );
    expect(parseSketchEntityId("skent_a").ok).toBe(true);
  });

  it("classifies ids of either kind by prefix", () => {
    const entity = parseAnySketchId("skent_alpha");
    const constraint = parseAnySketchId("skcon_beta");
    expect(entity.ok && entity.value.kind).toBe("entity");
    expect(constraint.ok && constraint.value.kind).toBe("constraint");
    expect(parseAnySketchId("sktyp_gamma").ok).toBe(false);
  });

  it("generates deterministic, resumable id sequences", () => {
    const generator = createSketchIdGenerator();
    expect(generator.nextEntityId()).toBe("skent_000001");
    expect(generator.nextEntityId()).toBe("skent_000002");
    expect(generator.nextConstraintId()).toBe("skcon_000001");
    const state = generator.state();
    const resumed = createSketchIdGenerator(state);
    expect(resumed.nextEntityId()).toBe("skent_000003");
    expect(resumed.nextConstraintId()).toBe("skcon_000002");
    expect(resumed.state()).toEqual({ entity: 3, constraint: 2 });
    expect(createSketchIdGenerator().state()).toEqual({
      entity: 0,
      constraint: 0,
    });
  });

  it("rejects non-integer or negative generator state", () => {
    expect(() =>
      createSketchIdGenerator({ entity: -1, constraint: 0 }),
    ).toThrow(RangeError);
    expect(() =>
      createSketchIdGenerator({ entity: 1.5, constraint: 0 }),
    ).toThrow(RangeError);
  });

  it("refuses to emit ids past the exact-integer range", () => {
    const generator = createSketchIdGenerator({
      entity: Number.MAX_SAFE_INTEGER,
      constraint: 0,
    });
    expect(() => generator.nextEntityId()).toThrow(
      SketchIdGeneratorExhaustedError,
    );
    expect(generator.nextConstraintId()).toBe("skcon_000001");
    expect(generator.state().entity).toBe(Number.MAX_SAFE_INTEGER);
  });
});
