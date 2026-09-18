import { describe, expect, it } from "vitest";

import {
  addBody,
  addDocumentParameter,
  addFeature,
  type Body,
  type BodyAddResult,
  type BodyId,
  type CadDocument,
  createBodyId,
  createDocument,
  createDocumentId,
  createFeatureId,
  createParameterId,
  createReferenceId,
  DOCUMENT_ERROR_CODES,
  type FeatureAddResult,
  type FeatureId,
  type FeatureInputRef,
  type FeatureRecord,
  getBody,
  getDocumentEntity,
  getDocumentParameter,
  getFeature,
  length,
  parseCadDocument,
  PARAMETER_ERROR_CODES,
  type ParseFailure,
  type ParseResult,
  removeBody,
  removeDocumentParameter,
  removeFeature,
  serializeCadDocument,
  updateFeature,
  type SerializedCadDocument,
} from "./index";

const docId = createDocumentId("doc_root");
const widthId = createParameterId("param_width");
const bodySolidId = createBodyId("body_solid");
const featSketchId = createFeatureId("feat_sketch");
const featExtrudeId = createFeatureId("feat_extrude");

function unwrap<T, F extends ParseFailure>(
  result: ParseResult<T, F>,
  action: string,
): T {
  if (!result.ok) throw new Error(`${action}: ${JSON.stringify(result.error)}`);
  return result.value;
}

function expectError(
  result: {
    readonly ok: boolean;
    readonly error?: { readonly code: string };
  },
  code: string,
): void {
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.error?.code).toBe(code);
}

function addBodyOrDie(
  document: CadDocument,
  input: { readonly id?: BodyId; readonly name: string },
): BodyAddResult {
  return unwrap(addBody(document, input), "addBody");
}

function addFeatureOrDie(
  document: CadDocument,
  input: {
    readonly id?: FeatureId;
    readonly kind: string;
    readonly inputs?: readonly FeatureInputRef[];
    readonly outputs?: readonly BodyId[];
  },
): FeatureAddResult {
  return unwrap(
    addFeature(document, { inputs: [], outputs: [], ...input }),
    "addFeature",
  );
}

function addParameterOrDie(
  document: CadDocument,
  input: Parameters<typeof addDocumentParameter>[1],
): CadDocument {
  return unwrap(addDocumentParameter(document, input), "addDocumentParameter")
    .document;
}

/**
 * Deliberately ill-typed feature input, used to exercise addFeature's own
 * validation of the fields it is handed (the same validators parseCadDocument
 * applies to untrusted serialization).
 */
function illTypedFeatureInput(
  input: unknown,
): Parameters<typeof addFeature>[1] {
  return input as Parameters<typeof addFeature>[1];
}

/** A document with one parameter, one body, and one feature consuming both. */
function sampleDocument(): CadDocument {
  let document = createDocument(docId);
  document = addParameterOrDie(document, {
    id: widthId,
    name: "width",
    value: length(25.4, "mm"),
  });
  document = addBodyOrDie(document, {
    id: bodySolidId,
    name: "Solid",
  }).document;
  document = addFeatureOrDie(document, {
    id: featSketchId,
    kind: "sketch",
    inputs: [{ kind: "parameter", id: widthId }],
    outputs: [bodySolidId],
  }).document;
  return document;
}

describe("createDocument", () => {
  it("creates an empty frozen document with a stable id and zeroed generator state", () => {
    const document = createDocument(docId);
    expect(document.id).toBe(docId);
    expect(document.parameters.parameters).toEqual([]);
    expect(document.bodies).toEqual([]);
    expect(document.features).toEqual([]);
    expect(document.idGeneratorState).toEqual({
      document: 0,
      parameter: 0,
      feature: 0,
      body: 0,
      reference: 0,
      sketch: 0,
    });
    expect(Object.isFrozen(document)).toBe(true);
    expect(Object.isFrozen(document.bodies)).toBe(true);
    expect(Object.isFrozen(document.features)).toBe(true);
  });

  it("claims the document counter for a numeric explicit document id", () => {
    const document = createDocument(createDocumentId("doc_000007"));
    expect(document.idGeneratorState.document).toBe(7);
  });
});

describe("addBody", () => {
  it("adds a body with an explicit id that resolves via getBody", () => {
    const added = addBodyOrDie(createDocument(docId), {
      id: bodySolidId,
      name: "Solid",
    });
    expect(added.body).toEqual({ id: bodySolidId, name: "Solid" });
    expect(Object.isFrozen(added.body)).toBe(true);
    expect(Object.isFrozen(added.document.bodies)).toBe(true);
    expect(getBody(added.document, bodySolidId)).toEqual(added.body);
  });

  it("generates a deterministic id and advances the generator state", () => {
    const added = addBodyOrDie(createDocument(docId), { name: "Solid" });
    expect(added.body.id).toBe(createBodyId("body_000001"));
    expect(added.document.idGeneratorState.body).toBe(1);
    const second = addBodyOrDie(added.document, { name: "Cut" });
    expect(second.body.id).toBe(createBodyId("body_000002"));
  });

  it("rejects an invalid name", () => {
    expectError(
      addBody(createDocument(docId), { id: bodySolidId, name: "" }),
      DOCUMENT_ERROR_CODES.bodyNameInvalid,
    );
    expectError(
      addBody(createDocument(docId), {
        id: bodySolidId,
        name: "x".repeat(65),
      }),
      DOCUMENT_ERROR_CODES.bodyNameInvalid,
    );
  });

  it("rejects a duplicate explicit id (explicit-explicit collision)", () => {
    const document = addBodyOrDie(createDocument(docId), {
      id: bodySolidId,
      name: "Solid",
    }).document;
    expectError(
      addBody(document, { id: bodySolidId, name: "Solid again" }),
      DOCUMENT_ERROR_CODES.idConflict,
    );
  });

  it("claims the generator counter for explicit numeric ids (explicit-vs-generated collision)", () => {
    const first = addBodyOrDie(createDocument(docId), {
      id: createBodyId("body_000001"),
      name: "Explicit",
    });
    expect(first.document.idGeneratorState.body).toBe(1);
    const second = addBodyOrDie(first.document, { name: "Generated" });
    expect(second.body.id).toBe(createBodyId("body_000002"));

    const unpadded = addBodyOrDie(createDocument(docId), {
      id: createBodyId("body_5"),
      name: "Unpadded",
    });
    expect(addBodyOrDie(unpadded.document, { name: "Generated" }).body.id).toBe(
      createBodyId("body_000006"),
    );
  });

  it("never advances the generator for a non-numeric explicit id", () => {
    const document = addBodyOrDie(createDocument(docId), {
      id: bodySolidId,
      name: "Solid",
    }).document;
    expect(document.idGeneratorState.body).toBe(0);
    expect(addBodyOrDie(document, { name: "Generated" }).body.id).toBe(
      createBodyId("body_000001"),
    );
  });

  it("rejects a numeric payload above MAX_SAFE_INTEGER as unclaimable (2^53 repro)", () => {
    // 2^53 is wire-valid but inside the generator's exact emission range,
    // so it could be re-emitted as a generated id while being impossible to
    // claim; registering it explicitly must be impossible by construction.
    expectError(
      addBody(createDocument(docId), {
        id: createBodyId("body_9007199254740992"),
        name: "Unclaimable",
      }),
      DOCUMENT_ERROR_CODES.idInvalid,
    );
    expectError(
      addBody(createDocument(docId), {
        id: createBodyId("body_999999999999999999"),
        name: "Far beyond the safe range",
      }),
      DOCUMENT_ERROR_CODES.idInvalid,
    );
  });

  it("claims the boundary neighbor MAX_SAFE_INTEGER (2^53 - 1) normally", () => {
    const boundary = addBodyOrDie(createDocument(docId), {
      id: createBodyId("body_9007199254740991"),
      name: "Boundary",
    });
    expect(boundary.document.idGeneratorState.body).toBe(
      Number.MAX_SAFE_INTEGER,
    );
  });

  it("refuses generated emission past the claimed 2^53 - 1 boundary instead of duplicating (3-call repro)", () => {
    // (1) The highest claimable payload, 2^53 - 1, legally claims the
    // counter. (2) A generated add must fail structured: emitting 2^53
    // would be unclaimable, and the next generated add would round
    // 2^53 + 1 back to 2^53 and silently re-emit the same id. (3) The
    // document stays untouched and retries fail cleanly the same way, so no
    // sequence of legal calls can produce a duplicate id.
    const boundary = addBodyOrDie(createDocument(docId), {
      id: createBodyId("body_9007199254740991"),
      name: "Boundary",
    }).document;
    expect(boundary.idGeneratorState.body).toBe(Number.MAX_SAFE_INTEGER);
    expectError(
      addBody(boundary, { name: "Generated at 2^53" }),
      DOCUMENT_ERROR_CODES.generatorExhausted,
    );
    expect(boundary.bodies).toHaveLength(1);
    expectError(
      addBody(boundary, { name: "Retried at 2^53" }),
      DOCUMENT_ERROR_CODES.generatorExhausted,
    );
    expect(boundary.bodies).toHaveLength(1);
    expect(boundary.idGeneratorState.body).toBe(Number.MAX_SAFE_INTEGER);
    // The 2^53 payload stays unregistrable on the explicit path too, so the
    // generated and explicit boundaries agree.
    expectError(
      addBody(boundary, {
        id: createBodyId("body_9007199254740992"),
        name: "Explicit at 2^53",
      }),
      DOCUMENT_ERROR_CODES.idInvalid,
    );
  });

  it("keeps generator exhaustion structured, per-kind, and recoverable", () => {
    const boundary = addBodyOrDie(createDocument(docId), {
      id: createBodyId("body_9007199254740991"),
      name: "Boundary",
    }).document;
    const exhausted = addBody(boundary, { name: "Generated" });
    expect(exhausted.ok).toBe(false);
    if (exhausted.ok) return;
    expect(exhausted.error.code).toBe(DOCUMENT_ERROR_CODES.generatorExhausted);
    expect(exhausted.error.input).toEqual(boundary.idGeneratorState);
    // The refusal leaves the document untouched and poisons nothing: other
    // kinds keep generating and explicit ids keep registering.
    expect(Object.isFrozen(boundary)).toBe(true);
    expect(
      unwrap(
        addDocumentParameter(boundary, {
          name: "width",
          value: length(1, "mm"),
        }),
        "addDocumentParameter",
      ).parameter.id,
    ).toBe(createParameterId("param_000001"));
    const explicit = addBodyOrDie(boundary, {
      id: createBodyId("body_extra"),
      name: "Explicit after exhaustion",
    });
    expect(explicit.document.bodies).toHaveLength(2);
  });
});

describe("removeBody", () => {
  it("removes a body by id", () => {
    const document = addBodyOrDie(createDocument(docId), {
      id: bodySolidId,
      name: "Solid",
    }).document;
    const removed = removeBody(document, bodySolidId);
    expect(removed.ok).toBe(true);
    if (!removed.ok) return;
    expect(getBody(removed.value, bodySolidId)).toBeUndefined();
    expect(removed.value.bodies).toEqual([]);
  });

  it("fails with notFound for an unknown id", () => {
    expectError(
      removeBody(createDocument(docId), bodySolidId),
      DOCUMENT_ERROR_CODES.notFound,
    );
  });

  it("refuses to remove a body consumed by a feature input", () => {
    const document = addFeatureOrDie(sampleDocument(), {
      id: featExtrudeId,
      kind: "extrude",
      inputs: [{ kind: "body", id: bodySolidId }],
      outputs: [],
    }).document;
    expectError(removeBody(document, bodySolidId), DOCUMENT_ERROR_CODES.inUse);
  });

  it("refuses to remove a body declared as a feature output", () => {
    expectError(
      removeBody(sampleDocument(), bodySolidId),
      DOCUMENT_ERROR_CODES.inUse,
    );
  });
});

describe("document-level parameters", () => {
  it("adds a parameter the document owns and resolves it by id", () => {
    const added = unwrap(
      addDocumentParameter(createDocument(docId), {
        id: widthId,
        name: "width",
        value: length(25.4, "mm"),
      }),
      "addDocumentParameter",
    );
    expect(added.parameter.name).toBe("width");
    expect(added.document.parameters.parameters).toHaveLength(1);
    expect(getDocumentParameter(added.document, widthId)?.value).toEqual(
      length(25.4, "mm"),
    );
  });

  it("generates a parameter id when none is given", () => {
    const added = unwrap(
      addDocumentParameter(createDocument(docId), {
        name: "width",
        value: length(10, "mm"),
      }),
      "addDocumentParameter",
    );
    expect(added.parameter.id).toBe(createParameterId("param_000001"));
    expect(added.document.idGeneratorState.parameter).toBe(1);
  });

  it("rejects a duplicate id against the document registry before delegating", () => {
    const document = addParameterOrDie(createDocument(docId), {
      id: widthId,
      name: "width",
      value: length(10, "mm"),
    });
    expectError(
      addDocumentParameter(document, {
        id: widthId,
        name: "other",
        value: length(10, "mm"),
      }),
      DOCUMENT_ERROR_CODES.idConflict,
    );
  });

  it("propagates the collection's structured name conflict", () => {
    const document = addParameterOrDie(createDocument(docId), {
      id: widthId,
      name: "width",
      value: length(10, "mm"),
    });
    expectError(
      addDocumentParameter(document, {
        id: createParameterId("param_height"),
        name: "width",
        value: length(10, "mm"),
      }),
      PARAMETER_ERROR_CODES.nameConflict,
    );
  });

  it("claims the generator counter for explicit numeric parameter ids", () => {
    const document = addParameterOrDie(createDocument(docId), {
      id: createParameterId("param_000002"),
      name: "width",
      value: length(10, "mm"),
    });
    const generated = unwrap(
      addDocumentParameter(document, {
        name: "height",
        value: length(5, "mm"),
      }),
      "addDocumentParameter",
    );
    expect(generated.parameter.id).toBe(createParameterId("param_000003"));
  });

  it("rejects a numeric payload above MAX_SAFE_INTEGER as unclaimable", () => {
    expectError(
      addDocumentParameter(createDocument(docId), {
        id: createParameterId("param_9007199254740992"),
        name: "width",
        value: length(10, "mm"),
      }),
      DOCUMENT_ERROR_CODES.idInvalid,
    );
  });

  it("removes a parameter and reports unknown ids with the collection code", () => {
    const document = addParameterOrDie(createDocument(docId), {
      id: widthId,
      name: "width",
      value: length(25.4, "mm"),
    });
    const removed = removeDocumentParameter(document, widthId);
    expect(removed.ok).toBe(true);
    if (!removed.ok) return;
    expect(getDocumentParameter(removed.value, widthId)).toBeUndefined();
    expectError(
      removeDocumentParameter(removed.value, widthId),
      PARAMETER_ERROR_CODES.notFound,
    );
  });

  it("refuses to remove a parameter consumed by a feature input", () => {
    expectError(
      removeDocumentParameter(sampleDocument(), widthId),
      DOCUMENT_ERROR_CODES.inUse,
    );
  });
});

describe("addFeature", () => {
  it("adds a feature record with declared inputs and outputs", () => {
    const added = addFeatureOrDie(sampleDocument(), {
      id: featExtrudeId,
      kind: "extrude",
      inputs: [
        { kind: "parameter", id: widthId },
        { kind: "feature", id: featSketchId },
        { kind: "body", id: bodySolidId },
      ],
      outputs: [bodySolidId],
    });
    expect(added.feature).toEqual({
      id: featExtrudeId,
      kind: "extrude",
      inputs: [
        { kind: "parameter", id: widthId },
        { kind: "feature", id: featSketchId },
        { kind: "body", id: bodySolidId },
      ],
      outputs: [bodySolidId],
    });
    expect(Object.isFrozen(added.feature)).toBe(true);
    expect(Object.isFrozen(added.feature.inputs)).toBe(true);
    expect(getFeature(added.document, featExtrudeId)).toEqual(added.feature);
  });

  it("generates a deterministic feature id and claims explicit numeric ids", () => {
    const generated = addFeatureOrDie(createDocument(docId), {
      kind: "sketch",
    });
    expect(generated.feature.id).toBe(createFeatureId("feat_000001"));
    expect(generated.document.idGeneratorState.feature).toBe(1);

    const explicit = addFeatureOrDie(createDocument(docId), {
      id: createFeatureId("feat_000003"),
      kind: "sketch",
    });
    const next = addFeatureOrDie(explicit.document, { kind: "sketch" });
    expect(next.feature.id).toBe(createFeatureId("feat_000004"));
  });

  it("rejects a numeric payload above MAX_SAFE_INTEGER as unclaimable", () => {
    expectError(
      addFeature(createDocument(docId), {
        id: createFeatureId("feat_9007199254740992"),
        kind: "sketch",
        inputs: [],
        outputs: [],
      }),
      DOCUMENT_ERROR_CODES.idInvalid,
    );
  });

  it("rejects an invalid feature kind", () => {
    const document = addBodyOrDie(createDocument(docId), {
      id: bodySolidId,
      name: "Solid",
    }).document;
    expectError(
      addFeature(document, { kind: "", inputs: [], outputs: [] }),
      DOCUMENT_ERROR_CODES.featureKindInvalid,
    );
    expectError(
      addFeature(document, { kind: "1extrude", inputs: [], outputs: [] }),
      DOCUMENT_ERROR_CODES.featureKindInvalid,
    );
    expectError(
      addFeature(document, { kind: "x".repeat(65), inputs: [], outputs: [] }),
      DOCUMENT_ERROR_CODES.featureKindInvalid,
    );
  });

  it("rejects input references with an unknown kind or wrong shape", () => {
    expectError(
      addFeature(
        createDocument(docId),
        illTypedFeatureInput({
          kind: "extrude",
          inputs: [{ kind: "spline", id: "curve_top" }],
          outputs: [],
        }),
      ),
      DOCUMENT_ERROR_CODES.inputKindInvalid,
    );
    expectError(
      addFeature(
        createDocument(docId),
        illTypedFeatureInput({
          kind: "extrude",
          inputs: ["param_width"],
          outputs: [],
        }),
      ),
      DOCUMENT_ERROR_CODES.malformed,
    );
  });

  it("rejects an input whose id prefix contradicts its declared kind", () => {
    expectError(
      addFeature(
        createDocument(docId),
        illTypedFeatureInput({
          kind: "extrude",
          inputs: [{ kind: "body", id: widthId }],
          outputs: [],
        }),
      ),
      DOCUMENT_ERROR_CODES.idInvalid,
    );
  });

  it("rejects inputs that do not resolve to live entities", () => {
    expectError(
      addFeature(createDocument(docId), {
        kind: "extrude",
        inputs: [{ kind: "parameter", id: widthId }],
        outputs: [],
      }),
      DOCUMENT_ERROR_CODES.inputUnknown,
    );
    expectError(
      addFeature(createDocument(docId), {
        kind: "extrude",
        inputs: [{ kind: "feature", id: featSketchId }],
        outputs: [],
      }),
      DOCUMENT_ERROR_CODES.inputUnknown,
    );
    expectError(
      addFeature(createDocument(docId), {
        kind: "extrude",
        inputs: [{ kind: "body", id: bodySolidId }],
        outputs: [],
      }),
      DOCUMENT_ERROR_CODES.inputUnknown,
    );
  });

  it("rejects outputs that do not resolve to existing bodies", () => {
    expectError(
      addFeature(createDocument(docId), {
        kind: "extrude",
        inputs: [],
        outputs: [bodySolidId],
      }),
      DOCUMENT_ERROR_CODES.outputUnknown,
    );
  });

  it("rejects a duplicate feature id", () => {
    expectError(
      addFeature(sampleDocument(), {
        id: featSketchId,
        kind: "extrude",
        inputs: [],
        outputs: [],
      }),
      DOCUMENT_ERROR_CODES.idConflict,
    );
  });
});

describe("removeFeature", () => {
  it("removes a feature by id without cascading to its output bodies", () => {
    const removed = removeFeature(sampleDocument(), featSketchId);
    expect(removed.ok).toBe(true);
    if (!removed.ok) return;
    expect(getFeature(removed.value, featSketchId)).toBeUndefined();
    expect(getBody(removed.value, bodySolidId)).toBeDefined();
  });

  it("fails with notFound for an unknown id", () => {
    expectError(
      removeFeature(createDocument(docId), featSketchId),
      DOCUMENT_ERROR_CODES.notFound,
    );
  });

  it("refuses to remove a feature consumed by a downstream feature", () => {
    const document = addFeatureOrDie(sampleDocument(), {
      id: featExtrudeId,
      kind: "extrude",
      inputs: [{ kind: "feature", id: featSketchId }],
      outputs: [],
    }).document;
    expectError(
      removeFeature(document, featSketchId),
      DOCUMENT_ERROR_CODES.inUse,
    );
  });
});

describe("updateFeature", () => {
  /** sampleDocument plus a downstream `extrude` feature referencing the sketch. */
  function chainedDocument(): CadDocument {
    return addFeatureOrDie(sampleDocument(), {
      id: featExtrudeId,
      kind: "extrude",
      inputs: [{ kind: "feature", id: featSketchId }],
      outputs: [],
    }).document;
  }

  it("replaces kind, inputs, and outputs in place, keeping id, position, and generator state", () => {
    const document = chainedDocument();
    const updated = updateFeature(document, featSketchId, {
      kind: "sketch-deep",
      inputs: [{ kind: "parameter", id: widthId }],
      outputs: [],
    });
    expect(updated.ok).toBe(true);
    if (!updated.ok) return;
    expect(updated.value.feature).toEqual({
      id: featSketchId,
      kind: "sketch-deep",
      inputs: [{ kind: "parameter", id: widthId }],
      outputs: [],
    });
    expect(updated.value.document.features.length).toBe(
      document.features.length,
    );
    expect(updated.value.document.features[0]?.id).toBe(featSketchId);
    expect(updated.value.document.features[1]?.id).toBe(featExtrudeId);
    expect(updated.value.document.idGeneratorState).toEqual(
      document.idGeneratorState,
    );
    // The downstream reference survives: it points at the stable id.
    expect(updated.value.document.features[1]?.inputs).toEqual([
      { kind: "feature", id: featSketchId },
    ]);
  });

  it("accepts a no-op update and round-trips the result through serialization", () => {
    const document = sampleDocument();
    const updated = updateFeature(document, featSketchId, {
      kind: "sketch",
      inputs: [{ kind: "parameter", id: widthId }],
      outputs: [bodySolidId],
    });
    expect(updated.ok).toBe(true);
    if (!updated.ok) return;
    expect(serializeCadDocument(updated.value.document)).toEqual(
      serializeCadDocument(document),
    );
    const revived = parseCadDocument(
      JSON.parse(JSON.stringify(serializeCadDocument(updated.value.document))),
    );
    expect(revived.ok).toBe(true);
    if (!revived.ok) return;
    expect(serializeCadDocument(revived.value)).toEqual(
      serializeCadDocument(updated.value.document),
    );
  });

  it("fails with notFound for an unknown id", () => {
    expectError(
      updateFeature(sampleDocument(), createFeatureId("feat_missing"), {
        kind: "sketch",
        inputs: [],
        outputs: [],
      }),
      DOCUMENT_ERROR_CODES.notFound,
    );
  });

  it("validates the replacement like an add", () => {
    expectError(
      updateFeature(sampleDocument(), featSketchId, {
        kind: "1sketch",
        inputs: [],
        outputs: [],
      }),
      DOCUMENT_ERROR_CODES.featureKindInvalid,
    );
    expectError(
      updateFeature(sampleDocument(), featSketchId, {
        kind: "sketch",
        inputs: [
          { kind: "nonsense", id: widthId } as unknown as FeatureInputRef,
        ],
        outputs: [],
      }),
      DOCUMENT_ERROR_CODES.inputKindInvalid,
    );
    expectError(
      updateFeature(sampleDocument(), featSketchId, {
        kind: "sketch",
        inputs: [{ kind: "parameter", id: createParameterId("param_missing") }],
        outputs: [],
      }),
      DOCUMENT_ERROR_CODES.inputUnknown,
    );
    expectError(
      updateFeature(sampleDocument(), featSketchId, {
        kind: "sketch",
        inputs: [],
        outputs: [createBodyId("body_missing")],
      }),
      DOCUMENT_ERROR_CODES.outputUnknown,
    );
  });

  it("keeps the feature list replayable: no self or forward feature inputs", () => {
    const document = chainedDocument();
    expectError(
      updateFeature(document, featSketchId, {
        kind: "sketch",
        inputs: [{ kind: "feature", id: featSketchId }],
        outputs: [bodySolidId],
      }),
      DOCUMENT_ERROR_CODES.inputOrderInvalid,
    );
    expectError(
      updateFeature(document, featSketchId, {
        kind: "sketch",
        inputs: [{ kind: "feature", id: featExtrudeId }],
        outputs: [bodySolidId],
      }),
      DOCUMENT_ERROR_CODES.inputOrderInvalid,
    );
    // A backward reference is fine — and the result still re-parses exactly.
    const updated = updateFeature(document, featExtrudeId, {
      kind: "extrude",
      inputs: [{ kind: "feature", id: featSketchId }],
      outputs: [bodySolidId],
    });
    expect(updated.ok).toBe(true);
    if (!updated.ok) return;
    const revived = parseCadDocument(
      JSON.parse(JSON.stringify(serializeCadDocument(updated.value.document))),
    );
    expect(revived.ok).toBe(true);
    if (!revived.ok) return;
    expect(serializeCadDocument(revived.value)).toEqual(
      serializeCadDocument(updated.value.document),
    );
  });
});

describe("document-wide id registry and lookup", () => {
  it("allows the same payload across kinds while lookups stay kind-correct", () => {
    let document = createDocument(docId);
    document = addParameterOrDie(document, {
      id: createParameterId("param_shared"),
      name: "shared",
      value: length(1, "mm"),
    });
    document = addBodyOrDie(document, {
      id: createBodyId("body_shared"),
      name: "Shared",
    }).document;
    document = addFeatureOrDie(document, {
      id: createFeatureId("feat_shared"),
      kind: "sketch",
      inputs: [{ kind: "parameter", id: createParameterId("param_shared") }],
      outputs: [createBodyId("body_shared")],
    }).document;
    expect(document.parameters.parameters).toHaveLength(1);
    expect(document.bodies).toHaveLength(1);
    expect(document.features).toHaveLength(1);
  });

  it("getDocumentEntity resolves every entity kind and nothing else", () => {
    const document = sampleDocument();
    expect(getDocumentEntity(document, widthId)).toMatchObject({
      kind: "parameter",
    });
    expect(getDocumentEntity(document, bodySolidId)).toMatchObject({
      kind: "body",
    });
    expect(getDocumentEntity(document, featSketchId)).toMatchObject({
      kind: "feature",
    });
    expect(
      getDocumentEntity(document, createParameterId("param_missing")),
    ).toBeUndefined();
    expect(getDocumentEntity(document, docId)).toBeUndefined();
    expect(
      getDocumentEntity(document, createReferenceId("ref_top")),
    ).toBeUndefined();
  });
});

describe("serializeCadDocument", () => {
  it("writes the canonical fixed-key-order form", () => {
    expect(serializeCadDocument(sampleDocument())).toEqual({
      formatVersion: 1,
      id: "doc_root",
      idGenerator: {
        document: 0,
        parameter: 0,
        feature: 0,
        body: 0,
        reference: 0,
        // The additive sketch counter is emitted only when nonzero.
      },
      parameters: {
        parameters: [
          {
            id: "param_width",
            name: "width",
            value: { dimension: "length", unit: "mm", value: 25.4 },
            expression: null,
            metadata: {},
          },
        ],
      },
      bodies: [{ id: "body_solid", name: "Solid" }],
      features: [
        {
          id: "feat_sketch",
          kind: "sketch",
          inputs: [{ kind: "parameter", id: "param_width" }],
          outputs: ["body_solid"],
        },
      ],
    });
  });

  it("round-trips exactly through JSON with ids still resolving", () => {
    const serialized = serializeCadDocument(sampleDocument());
    const revived = parseCadDocument(
      JSON.parse(JSON.stringify(serialized)) as unknown,
    );
    expect(revived.ok).toBe(true);
    if (!revived.ok) return;
    expect(serializeCadDocument(revived.value)).toEqual(serialized);
    expect(getDocumentParameter(revived.value, widthId)?.name).toBe("width");
    expect(getBody(revived.value, bodySolidId)?.name).toBe("Solid");
    expect(getFeature(revived.value, featSketchId)?.kind).toBe("sketch");
  });

  it("round-trips generator state so ids stay unique across save/load", () => {
    let document = createDocument(docId);
    document = addBodyOrDie(document, { name: "Generated" }).document;
    document = addBodyOrDie(document, { name: "Generated" }).document;
    expect(document.idGeneratorState.body).toBe(2);
    const revived = parseCadDocument(
      JSON.parse(JSON.stringify(serializeCadDocument(document))) as unknown,
    );
    expect(revived.ok).toBe(true);
    if (!revived.ok) return;
    const next = addBodyOrDie(revived.value, { name: "After reload" });
    expect(next.body.id).toBe(createBodyId("body_000003"));
  });

  it("raises a tampered, lowered generator state past existing ids", () => {
    let document = createDocument(docId);
    document = addParameterOrDie(document, {
      id: widthId,
      name: "width",
      value: length(25.4, "mm"),
    });
    document = addBodyOrDie(document, {
      id: createBodyId("body_000001"),
      name: "Solid",
    }).document;
    document = addFeatureOrDie(document, {
      id: featSketchId,
      kind: "sketch",
      inputs: [{ kind: "parameter", id: widthId }],
      outputs: [createBodyId("body_000001")],
    }).document;
    const tampered: SerializedCadDocument = {
      ...serializeCadDocument(document),
      idGenerator: {
        document: 0,
        parameter: 0,
        feature: 0,
        body: 0,
        reference: 0,
        // The additive sketch counter is emitted only when nonzero.
      },
    };
    const revived = parseCadDocument(tampered);
    expect(revived.ok).toBe(true);
    if (!revived.ok) return;
    expect(revived.value.idGeneratorState.body).toBe(1);
    const next = addBodyOrDie(revived.value, { name: "After tamper" });
    expect(next.body.id).toBe(createBodyId("body_000002"));
  });

  it("round-trips the boundary document carrying the highest legal generated id", () => {
    // Claim 2^53 - 2, then let the generator emit its final id, 2^53 - 1 —
    // the highest a generated id can ever be. The resulting document must
    // survive its own serialization, and the revived document must refuse
    // further body generation structurally rather than re-emit it.
    let document = createDocument(docId);
    document = addBodyOrDie(document, {
      id: createBodyId("body_9007199254740990"),
      name: "Claimed at 2^53 - 2",
    }).document;
    document = addBodyOrDie(document, {
      name: "Generated at the cap",
    }).document;
    expect(document.bodies[1]?.id).toBe(createBodyId("body_9007199254740991"));
    expect(document.idGeneratorState.body).toBe(Number.MAX_SAFE_INTEGER);
    const serialized = serializeCadDocument(document);
    const revived = parseCadDocument(
      JSON.parse(JSON.stringify(serialized)) as unknown,
    );
    expect(revived.ok).toBe(true);
    if (!revived.ok) return;
    expect(serializeCadDocument(revived.value)).toEqual(serialized);
    expectError(
      addBody(revived.value, { name: "Beyond the cap" }),
      DOCUMENT_ERROR_CODES.generatorExhausted,
    );
  });
});

describe("parseCadDocument rejects malformed input", () => {
  function valid(): SerializedCadDocument {
    return serializeCadDocument(sampleDocument());
  }

  it.each([
    [
      "input that is not an object",
      "just a string",
      DOCUMENT_ERROR_CODES.malformed,
    ],
    [
      "wrong format version",
      { ...valid(), formatVersion: 2 },
      DOCUMENT_ERROR_CODES.versionUnsupported,
    ],
    [
      "missing format version",
      { ...valid(), formatVersion: undefined },
      DOCUMENT_ERROR_CODES.versionUnsupported,
    ],
    [
      "invalid document id",
      { ...valid(), id: "not-a-document-id" },
      DOCUMENT_ERROR_CODES.idInvalid,
    ],
    [
      "missing generator state",
      { ...valid(), idGenerator: undefined },
      DOCUMENT_ERROR_CODES.generatorStateInvalid,
    ],
    [
      "generator state not an object",
      { ...valid(), idGenerator: 3 },
      DOCUMENT_ERROR_CODES.generatorStateInvalid,
    ],
    [
      "negative generator counter",
      { ...valid(), idGenerator: { ...valid().idGenerator, body: -1 } },
      DOCUMENT_ERROR_CODES.generatorStateInvalid,
    ],
    [
      "fractional generator counter",
      { ...valid(), idGenerator: { ...valid().idGenerator, body: 1.5 } },
      DOCUMENT_ERROR_CODES.generatorStateInvalid,
    ],
    [
      "non-numeric generator counter",
      { ...valid(), idGenerator: { ...valid().idGenerator, feature: "2" } },
      DOCUMENT_ERROR_CODES.generatorStateInvalid,
    ],
    [
      "bodies not an array",
      { ...valid(), bodies: "none" },
      DOCUMENT_ERROR_CODES.malformed,
    ],
    [
      "body with invalid id",
      { ...valid(), bodies: [{ id: "x", name: "S" }] },
      DOCUMENT_ERROR_CODES.idInvalid,
    ],
    [
      "body with invalid name",
      { ...valid(), bodies: [{ id: "body_solid", name: "" }] },
      DOCUMENT_ERROR_CODES.bodyNameInvalid,
    ],
    [
      "body id with a numeric payload above MAX_SAFE_INTEGER",
      {
        ...valid(),
        bodies: [...valid().bodies, { id: "body_9007199254740992", name: "S" }],
      },
      DOCUMENT_ERROR_CODES.idInvalid,
    ],
    [
      "feature id with a numeric payload above MAX_SAFE_INTEGER",
      {
        ...valid(),
        features: [
          ...valid().features,
          {
            id: "feat_9007199254740992",
            kind: "sketch",
            inputs: [],
            outputs: [],
          },
        ],
      },
      DOCUMENT_ERROR_CODES.idInvalid,
    ],
    [
      "document id with a numeric payload above MAX_SAFE_INTEGER",
      { ...valid(), id: "doc_9007199254740992" },
      DOCUMENT_ERROR_CODES.idInvalid,
    ],
    [
      "duplicate body ids",
      {
        ...valid(),
        bodies: [
          { id: "body_solid", name: "A" },
          { id: "body_solid", name: "B" },
        ],
      },
      DOCUMENT_ERROR_CODES.idConflict,
    ],
    [
      "duplicate feature ids",
      {
        ...valid(),
        features: [
          ...valid().features,
          { id: "feat_sketch", kind: "sketch", inputs: [], outputs: [] },
        ],
      },
      DOCUMENT_ERROR_CODES.idConflict,
    ],
    [
      "features not an array",
      { ...valid(), features: 7 },
      DOCUMENT_ERROR_CODES.malformed,
    ],
    [
      "feature with invalid kind",
      {
        ...valid(),
        features: [{ id: "feat_sketch", kind: "!!", inputs: [], outputs: [] }],
      },
      DOCUMENT_ERROR_CODES.featureKindInvalid,
    ],
    [
      "feature inputs not an array",
      {
        ...valid(),
        features: [
          { id: "feat_sketch", kind: "sketch", inputs: "no", outputs: [] },
        ],
      },
      DOCUMENT_ERROR_CODES.malformed,
    ],
    [
      "feature input with unknown kind",
      {
        ...valid(),
        features: [
          {
            id: "feat_sketch",
            kind: "sketch",
            inputs: [{ kind: "document", id: "doc_root" }],
            outputs: [],
          },
        ],
      },
      DOCUMENT_ERROR_CODES.inputKindInvalid,
    ],
    [
      "feature input with contradicted id prefix",
      {
        ...valid(),
        features: [
          {
            id: "feat_sketch",
            kind: "sketch",
            inputs: [{ kind: "parameter", id: "body_solid" }],
            outputs: [],
          },
        ],
      },
      DOCUMENT_ERROR_CODES.idInvalid,
    ],
    [
      "feature outputs not an array",
      {
        ...valid(),
        features: [
          { id: "feat_sketch", kind: "sketch", inputs: [], outputs: "no" },
        ],
      },
      DOCUMENT_ERROR_CODES.malformed,
    ],
    [
      "dangling feature input after replay",
      {
        ...valid(),
        features: [
          {
            id: "feat_sketch",
            kind: "sketch",
            inputs: [{ kind: "parameter", id: "param_missing" }],
            outputs: ["body_solid"],
          },
        ],
      },
      DOCUMENT_ERROR_CODES.inputUnknown,
    ],
    [
      "dangling feature output after replay",
      {
        ...valid(),
        features: [
          {
            id: "feat_sketch",
            kind: "sketch",
            inputs: [],
            outputs: ["body_missing"],
          },
        ],
      },
      DOCUMENT_ERROR_CODES.outputUnknown,
    ],
    [
      "malformed parameters",
      { ...valid(), parameters: "nope" },
      PARAMETER_ERROR_CODES.malformed,
    ],
    [
      "duplicate parameter ids",
      {
        ...valid(),
        parameters: {
          parameters: [
            ...valid().parameters.parameters,
            {
              id: "param_width",
              name: "other",
              value: { dimension: "length", unit: "mm", value: 1 },
              expression: null,
              metadata: {},
            },
          ],
        },
      },
      PARAMETER_ERROR_CODES.idConflict,
    ],
  ] as readonly [string, unknown, string][])(
    "rejects %s with its documented code",
    (_label, input, code) => {
      expectError(parseCadDocument(input), code);
    },
  );

  it("ignores unknown fields so future format versions still load", () => {
    const extended = {
      ...valid(),
      futureField: { nested: true },
      bodies: valid().bodies.map((body) => ({ ...body, extra: 1 })),
    };
    const revived = parseCadDocument(extended);
    expect(revived.ok).toBe(true);
    if (!revived.ok) return;
    expect(getBody(revived.value, bodySolidId)?.name).toBe("Solid");
  });

  it("defaults missing generator counters to zero instead of failing", () => {
    const revived = parseCadDocument({
      ...valid(),
      idGenerator: { body: 2 },
    });
    expect(revived.ok).toBe(true);
    if (!revived.ok) return;
    expect(revived.value.idGeneratorState).toEqual({
      document: 0,
      parameter: 0,
      feature: 0,
      body: 2,
      reference: 0,
      sketch: 0,
    });
  });
});

describe("document state purity", () => {
  it("leaves the source document untouched by every mutation", () => {
    const source = sampleDocument();
    const added = addBodyOrDie(source, { name: "Extra" });
    expect(added.document.bodies).toHaveLength(2);
    expect(source.bodies).toHaveLength(1);
    expect(getBody(source, added.body.id)).toBeUndefined();
  });

  it("produces identical serialization for identical build sequences", () => {
    expect(serializeCadDocument(sampleDocument())).toEqual(
      serializeCadDocument(sampleDocument()),
    );
    expect(JSON.stringify(serializeCadDocument(sampleDocument()))).toBe(
      JSON.stringify(serializeCadDocument(sampleDocument())),
    );
  });
});

describe("feature records carry typed reference data", () => {
  it("preserves input order and duplicates as declared data", () => {
    const document = addBodyOrDie(createDocument(docId), {
      id: bodySolidId,
      name: "Solid",
    }).document;
    const added = addFeatureOrDie(document, {
      kind: "extrude",
      inputs: [
        { kind: "body", id: bodySolidId },
        { kind: "body", id: bodySolidId },
      ],
    });
    const feature: FeatureRecord | undefined = getFeature(
      added.document,
      added.feature.id,
    );
    expect(feature?.inputs).toEqual([
      { kind: "body", id: bodySolidId },
      { kind: "body", id: bodySolidId },
    ]);
    const body: Body | undefined = getBody(added.document, bodySolidId);
    expect(body?.id).toBe(bodySolidId);
  });
});
