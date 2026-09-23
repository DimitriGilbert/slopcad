import { describe, expect, it } from "vitest";

import {
  CAD_ID_MAX_PAYLOAD_LENGTH,
  CAD_ID_PREFIXES,
  CadIdGeneratorExhaustedError,
  createBodyId,
  createDocumentId,
  createFeatureId,
  createIdGenerator,
  createParameterId,
  createReferenceId,
  ID_GENERATOR_ERROR_CODES,
  parseAnyCadId,
  parseBodyId,
  parseDatumId,
  parseDocumentId,
  parseOccurrenceId,
  parseFeatureId,
  parseParameterId,
  parseReferenceId,
  parseSketchDocumentId,
  type DocumentId,
  type FeatureId,
  type IdGeneratorState,
  type ParsedCadId,
} from "./index";

describe("explicit CAD ids", () => {
  it("keeps user-provided ids exactly as given", () => {
    expect(createDocumentId("doc_root")).toBe("doc_root");
    expect(createParameterId("param_width.2-mm")).toBe("param_width.2-mm");
    expect(createFeatureId("feat_fillet-upper")).toBe("feat_fillet-upper");
    expect(createBodyId("body_main-sol0id")).toBe("body_main-sol0id");
    expect(createReferenceId("ref_face-top")).toBe("ref_face-top");
  });

  it("round-trips every id kind through JSON", () => {
    const ids = [
      createDocumentId("doc_root"),
      createParameterId("param_width"),
      createFeatureId("feat_extrude-1"),
      createBodyId("body_solid"),
      createReferenceId("ref_edge-top.1"),
    ];
    for (const id of ids) {
      expect(JSON.parse(JSON.stringify(id))).toBe(id);
    }
  });

  it("accepts payloads up to the documented maximum and rejects longer ones", () => {
    const atLimit = `doc_${"a".repeat(CAD_ID_MAX_PAYLOAD_LENGTH)}`;
    const beyondLimit = `doc_${"a".repeat(CAD_ID_MAX_PAYLOAD_LENGTH + 1)}`;
    expect(parseDocumentId(atLimit).ok).toBe(true);
    expect(parseDocumentId(beyondLimit).ok).toBe(false);
  });
});

describe("id wire format parsing", () => {
  it("uses the canonical wire prefix for each kind", () => {
    expect(CAD_ID_PREFIXES).toEqual({
      document: "doc",
      parameter: "param",
      feature: "feat",
      body: "body",
      reference: "ref",
      sketch: "skd",
      datum: "dtm",
      section: "sec",
      occurrence: "occ",
      curve: "crv",
      sheet: "sht",
      drawingView: "dwv",
      mate: "mat",
      joint: "jnt",
    });
    expect(parseDatumId("dtm_a").ok).toBe(true);
    expect(parseOccurrenceId("occ_a").ok).toBe(true);
    expect(parseDocumentId("doc_a").ok).toBe(true);
    expect(parseParameterId("param_a").ok).toBe(true);
    expect(parseFeatureId("feat_a").ok).toBe(true);
    expect(parseBodyId("body_a").ok).toBe(true);
    expect(parseReferenceId("ref_a").ok).toBe(true);
    expect(parseSketchDocumentId("skd_a").ok).toBe(true);
  });

  it("rejects non-string input with id/not-a-string", () => {
    for (const input of [null, undefined, 42, true, {}, []]) {
      const result = parseParameterId(input);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("id/not-a-string");
        expect(result.error.input).toBe(input);
      }
    }
  });

  it("rejects the empty string with id/empty", () => {
    const result = parseDocumentId("");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("id/empty");
      expect(result.error.input).toBe("");
    }
  });

  it("rejects ids without a kind prefix with id/wrong-prefix", () => {
    for (const input of ["extrude", "extrude_1", "_doc", "DOC_1"]) {
      const result = parseFeatureId(input);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("id/wrong-prefix");
        expect(result.error.input).toBe(input);
      }
    }
  });

  it("rejects ids carrying another kind's prefix with id/wrong-prefix", () => {
    const result = parseFeatureId("param_width");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("id/wrong-prefix");
      expect(result.error.message).toContain("feat_");
    }
  });

  it("rejects invalid payloads with id/invalid-payload", () => {
    for (const input of [
      "feat_", // empty payload
      "feat_-leading-dash", // payload must start alphanumeric
      "feat_has space",
      "feat_has$sign",
      "feat_ümlaut",
    ]) {
      const result = parseFeatureId(input);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("id/invalid-payload");
        expect(result.error.input).toBe(input);
      }
    }
  });
});

describe("parseAnyCadId", () => {
  it("classifies each id kind by its wire prefix", () => {
    const cases: ReadonlyArray<[ParsedCadId["kind"], string]> = [
      ["document", "doc_root"],
      ["parameter", "param_width"],
      ["feature", "feat_extrude-1"],
      ["body", "body_solid"],
      ["reference", "ref_face-top"],
    ];
    for (const [kind, raw] of cases) {
      const result = parseAnyCadId(raw);
      expect(result.ok).toBe(true);
      if (!result.ok) continue;
      expect(result.value.kind).toBe(kind);
      expect(result.value.id).toBe(raw);
    }
  });

  it("rejects unknown prefixes and malformed input", () => {
    for (const input of ["blob_1", "nounderscore", "", 7, null]) {
      const result = parseAnyCadId(input);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.input).toBe(input);
      }
    }
  });
});

describe("createIdGenerator", () => {
  it("emits zero-padded sequential ids per kind", () => {
    const generator = createIdGenerator();
    expect(generator.nextFeatureId()).toBe("feat_000001");
    expect(generator.nextFeatureId()).toBe("feat_000002");
    expect(generator.nextBodyId()).toBe("body_000001");
    expect(generator.nextParameterId()).toBe("param_000001");
    expect(generator.nextReferenceId()).toBe("ref_000001");
    expect(generator.nextDocumentId()).toBe("doc_000001");
  });

  it("generates ids that parse back as their own kind", () => {
    const generator = createIdGenerator();
    expect(parseDocumentId(generator.nextDocumentId()).ok).toBe(true);
    expect(parseParameterId(generator.nextParameterId()).ok).toBe(true);
    expect(parseFeatureId(generator.nextFeatureId()).ok).toBe(true);
    expect(parseBodyId(generator.nextBodyId()).ok).toBe(true);
    expect(parseReferenceId(generator.nextReferenceId()).ok).toBe(true);
  });

  it("never repeats an id within document scope", () => {
    const generator = createIdGenerator();
    const seen = new Set<string>();
    for (let index = 0; index < 500; index += 1) {
      seen.add(generator.nextDocumentId());
      seen.add(generator.nextParameterId());
      seen.add(generator.nextFeatureId());
      seen.add(generator.nextBodyId());
      seen.add(generator.nextReferenceId());
    }
    expect(seen.size).toBe(2500);
  });

  it("is deterministic for identical starting state", () => {
    const first = createIdGenerator();
    const second = createIdGenerator();
    for (let index = 0; index < 25; index += 1) {
      expect(first.nextFeatureId()).toBe(second.nextFeatureId());
      expect(first.nextBodyId()).toBe(second.nextBodyId());
    }
  });

  it("resumes from a serialized state without regenerating ids", () => {
    const original = createIdGenerator();
    original.nextFeatureId();
    original.nextFeatureId();
    const state = JSON.parse(
      JSON.stringify(original.state()),
    ) as IdGeneratorState;
    const resumed = createIdGenerator(state);
    expect(resumed.nextFeatureId()).toBe("feat_000003");
  });

  it("state snapshots round-trip through JSON", () => {
    const generator = createIdGenerator();
    generator.nextBodyId();
    const state = generator.state();
    expect(JSON.parse(JSON.stringify(state))).toEqual({
      document: 0,
      parameter: 0,
      feature: 0,
      body: 1,
      reference: 0,
      sketch: 0,
      datum: 0,
      section: 0,
      occurrence: 0,
      curve: 0,
      sheet: 0,
      drawingView: 0,
      mate: 0,
      joint: 0,
    });
  });

  it("rejects generator state with invalid counts", () => {
    expect(() =>
      createIdGenerator({
        document: 0,
        parameter: 0,
        feature: -1,
        body: 0,
        reference: 0,
        sketch: 0,
        datum: 0,
        section: 0,
        occurrence: 0,
        curve: 0,
        sheet: 0,
        drawingView: 0,
        mate: 0,
        joint: 0,
      }),
    ).toThrow(RangeError);
    expect(() =>
      createIdGenerator({
        document: 0,
        parameter: Number.NaN,
        feature: 0,
        body: 0,
        reference: 0,
        sketch: 0,
        datum: 0,
        section: 0,
        occurrence: 0,
        curve: 0,
        sheet: 0,
        drawingView: 0,
        mate: 0,
        joint: 0,
      }),
    ).toThrow(RangeError);
  });

  it("refuses emission structurally once a counter reaches MAX_SAFE_INTEGER", () => {
    const generator = createIdGenerator({
      document: 0,
      parameter: 0,
      feature: 0,
      body: Number.MAX_SAFE_INTEGER,
      reference: 0,
      sketch: 0,
      datum: 0,
      section: 0,
      occurrence: 0,
      curve: 0,
      sheet: 0,
      drawingView: 0,
      mate: 0,
      joint: 0,
    });
    expect(() => generator.nextBodyId()).toThrow(CadIdGeneratorExhaustedError);
    try {
      generator.nextBodyId();
    } catch (error) {
      if (!(error instanceof CadIdGeneratorExhaustedError)) {
        throw new Error("expected CadIdGeneratorExhaustedError");
      }
      expect(error.code).toBe(ID_GENERATOR_ERROR_CODES.exhausted);
      expect(error.kind).toBe("body");
    }
    // The refusal is structural, not state-corrupting: the exhausted
    // counter stays put and every other kind keeps emitting.
    expect(generator.state().body).toBe(Number.MAX_SAFE_INTEGER);
    expect(generator.nextDocumentId()).toBe("doc_000001");
  });

  it("emits the highest safe payload 2^53 - 1 exactly once, then refuses", () => {
    const generator = createIdGenerator({
      document: 0,
      parameter: 0,
      feature: 0,
      body: Number.MAX_SAFE_INTEGER - 1,
      reference: 0,
      sketch: 0,
      datum: 0,
      section: 0,
      occurrence: 0,
      curve: 0,
      sheet: 0,
      drawingView: 0,
      mate: 0,
      joint: 0,
    });
    expect(generator.nextBodyId()).toBe("body_9007199254740991");
    expect(() => generator.nextBodyId()).toThrow(CadIdGeneratorExhaustedError);
  });
});

describe("branded id type separation", () => {
  it("prevents assigning one id kind where another is expected", () => {
    const parameterId = createParameterId("param_width");
    // @ts-expect-error a ParameterId must not be assignable to FeatureId
    const featureId: FeatureId = parameterId;
    // Runtime values are plain strings; only the static types differ.
    expect(featureId).toBe("param_width");
  });

  it("prevents passing an unbranded string where an id is expected", () => {
    const raw = "doc_root";
    // @ts-expect-error a plain string is not a DocumentId
    const documentId: DocumentId = raw;
    expect(documentId).toBe("doc_root");
  });

  it("still allows branded ids where plain strings are expected", () => {
    const documentId = createDocumentId("doc_root");
    const asString: string = documentId;
    expect(asString).toBe("doc_root");
  });
});
