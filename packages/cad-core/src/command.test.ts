import { describe, expect, it } from "vitest";

import {
  addBody,
  addDocumentParameter,
  addFeature,
  applyCommand,
  applyTransaction,
  type CadCommand,
  type CadDocument,
  COMMAND_ERROR_CODES,
  createBodyId,
  createDocument,
  createDocumentId,
  createFeatureId,
  createParameterId,
  createReferenceId,
  type DocumentId,
  DOCUMENT_ERROR_CODES,
  type FeatureId,
  getDocumentParameter,
  getDocumentReference,
  getFeature,
  length,
  parseCadDocument,
  parseCommand,
  type ParseFailure,
  type ParseResult,
  PARAMETER_ERROR_CODES,
  serializeCadDocument,
  serializeCommand,
  TRANSACTION_ERROR_CODES,
} from "./index";

const docId: DocumentId = createDocumentId("doc_root");
const widthId = createParameterId("param_width");
const bodySolidId = createBodyId("body_solid");
const featSketchId = createFeatureId("feat_sketch");
const featPadId = createFeatureId("feat_pad");
const featFreeId = createFeatureId("feat_free");

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

/** A document with one parameter, one body, and two features: sketch, then pad (consuming sketch). */
function sampleDocument(): CadDocument {
  let document = createDocument(docId);
  document = unwrap(
    addDocumentParameter(document, {
      id: widthId,
      name: "width",
      value: length(25.4, "mm"),
    }),
    "addDocumentParameter",
  ).document;
  document = unwrap(
    addBody(document, { id: bodySolidId, name: "Solid" }),
    "addBody",
  ).document;
  document = unwrap(
    addFeature(document, {
      id: featSketchId,
      kind: "sketch",
      inputs: [{ kind: "parameter", id: widthId }],
      outputs: [bodySolidId],
    }),
    "addFeature",
  ).document;
  return unwrap(
    addFeature(document, {
      id: featPadId,
      kind: "pad",
      inputs: [{ kind: "feature", id: featSketchId }],
      outputs: [],
    }),
    "addFeature",
  ).document;
}

const setWidth: CadCommand = {
  type: "parameter.set",
  id: widthId,
  value: length(50.8, "mm"),
};

const createFillet: CadCommand = {
  type: "feature.create",
  kind: "fillet",
  inputs: [{ kind: "feature", id: featPadId }],
  outputs: [],
};

const updatePad: CadCommand = {
  type: "feature.update",
  id: featPadId,
  kind: "pad-deep",
  inputs: [{ kind: "parameter", id: widthId }],
  outputs: [bodySolidId],
};

const deleteSketch: CadCommand = { type: "feature.delete", id: featSketchId };

/** serialize → JSON → parse, the exact round trip persisted commands take. */
function roundTripCommand(command: CadCommand): CadCommand {
  return unwrap(
    parseCommand(JSON.parse(JSON.stringify(serializeCommand(command)))),
    "parseCommand",
  );
}

/** The same document value rebuilt through serialization, for replay tests. */
function rebuiltDocument(document: CadDocument): CadDocument {
  return unwrap(
    parseCadDocument(
      JSON.parse(JSON.stringify(serializeCadDocument(document))),
    ),
    "parseCadDocument",
  );
}

describe("applyCommand", () => {
  it("applies parameter.set and leaves every other field alone", () => {
    const document = sampleDocument();
    const applied = unwrap(applyCommand(document, setWidth), "applyCommand");
    const parameter = getDocumentParameter(applied, widthId);
    expect(parameter?.value).toEqual(length(50.8, "mm"));
    expect(applied.parameters.parameters.length).toBe(1);
    expect(applied.bodies.length).toBe(1);
    expect(applied.features.length).toBe(2);
  });

  it("fails parameter.set with parameter/not-found on an unknown id", () => {
    const command: CadCommand = {
      type: "parameter.set",
      id: createParameterId("param_missing"),
      value: length(1, "mm"),
    };
    expectError(
      applyCommand(sampleDocument(), command),
      PARAMETER_ERROR_CODES.notFound,
    );
  });

  it("fails parameter.set with parameter/invalid-value on a non-finite value", () => {
    const command: CadCommand = {
      type: "parameter.set",
      id: widthId,
      value: { dimension: "length", unit: "mm", value: Number.NaN },
    };
    expectError(
      applyCommand(sampleDocument(), command),
      PARAMETER_ERROR_CODES.invalidValue,
    );
  });

  it("applies feature.create with an explicit id", () => {
    const command: CadCommand = {
      type: "feature.create",
      id: createFeatureId("feat_fillet"),
      kind: "fillet",
      inputs: [{ kind: "feature", id: featPadId }],
      outputs: [],
    };
    const applied = unwrap(
      applyCommand(sampleDocument(), command),
      "applyCommand",
    );
    expect(applied.features.length).toBe(3);
    expect(getFeature(applied, createFeatureId("feat_fillet"))?.kind).toBe(
      "fillet",
    );
  });

  it("generates deterministic feature ids: the same command on the same state makes the same id", () => {
    const first = unwrap(
      applyCommand(sampleDocument(), createFillet),
      "applyCommand",
    );
    const second = unwrap(
      applyCommand(sampleDocument(), createFillet),
      "applyCommand",
    );
    const firstId: FeatureId | undefined = first.features.at(-1)?.id;
    expect(firstId).toBeDefined();
    expect(second.features.at(-1)?.id).toBe(firstId);
    expect(serializeCadDocument(first)).toEqual(serializeCadDocument(second));
  });

  it("propagates the substrate's structured failures for feature.create", () => {
    const conflict: CadCommand = {
      type: "feature.create",
      id: featSketchId,
      kind: "sketch",
      inputs: [],
      outputs: [],
    };
    expectError(
      applyCommand(sampleDocument(), conflict),
      DOCUMENT_ERROR_CODES.idConflict,
    );
    const unknownInput: CadCommand = {
      type: "feature.create",
      kind: "sketch",
      inputs: [{ kind: "body", id: createBodyId("body_missing") }],
      outputs: [],
    };
    expectError(
      applyCommand(sampleDocument(), unknownInput),
      DOCUMENT_ERROR_CODES.inputUnknown,
    );
  });

  it("applies feature.update by replacing kind, inputs, and outputs in place", () => {
    const document = sampleDocument();
    const applied = unwrap(applyCommand(document, updatePad), "applyCommand");
    expect(applied.features.length).toBe(2);
    expect(applied.features[1]?.id).toBe(featPadId);
    expect(applied.features[1]?.kind).toBe("pad-deep");
    expect(applied.features[1]?.inputs).toEqual([
      { kind: "parameter", id: widthId },
    ]);
    expect(applied.features[1]?.outputs).toEqual([bodySolidId]);
    // The generator state is untouched: an update mutes no counters.
    expect(applied.idGeneratorState).toEqual(document.idGeneratorState);
  });

  it("fails feature.update with document/not-found on an unknown feature", () => {
    const command: CadCommand = {
      type: "feature.update",
      id: createFeatureId("feat_missing"),
      kind: "pad",
      inputs: [],
      outputs: [],
    };
    expectError(
      applyCommand(sampleDocument(), command),
      DOCUMENT_ERROR_CODES.notFound,
    );
  });

  it("keeps feature.update referential integrity: order and resolution", () => {
    const document = sampleDocument();
    const selfReference: CadCommand = {
      type: "feature.update",
      id: featSketchId,
      kind: "sketch",
      inputs: [{ kind: "feature", id: featSketchId }],
      outputs: [bodySolidId],
    };
    expectError(
      applyCommand(document, selfReference),
      DOCUMENT_ERROR_CODES.inputOrderInvalid,
    );
    const forwardReference: CadCommand = {
      type: "feature.update",
      id: featSketchId,
      kind: "sketch",
      inputs: [{ kind: "feature", id: featPadId }],
      outputs: [bodySolidId],
    };
    expectError(
      applyCommand(document, forwardReference),
      DOCUMENT_ERROR_CODES.inputOrderInvalid,
    );
    const unresolvable: CadCommand = {
      type: "feature.update",
      id: featSketchId,
      kind: "sketch",
      inputs: [{ kind: "parameter", id: createParameterId("param_missing") }],
      outputs: [bodySolidId],
    };
    expectError(
      applyCommand(document, unresolvable),
      DOCUMENT_ERROR_CODES.inputUnknown,
    );
  });

  it("applies feature.delete and propagates in-use and not-found failures", () => {
    const document = sampleDocument();
    expectError(
      applyCommand(document, deleteSketch),
      DOCUMENT_ERROR_CODES.inUse,
    );
    const applied = unwrap(
      applyCommand(document, { type: "feature.delete", id: featPadId }),
      "applyCommand",
    );
    expect(applied.features.length).toBe(1);
    expectError(
      applyCommand(applied, { type: "feature.delete", id: featPadId }),
      DOCUMENT_ERROR_CODES.notFound,
    );
    const withoutPad = unwrap(
      applyCommand(applied, deleteSketch),
      "applyCommand",
    );
    expect(withoutPad.features.length).toBe(0);
  });

  it("leaves the input document untouched, applied or failed", () => {
    for (const command of [setWidth, createFillet, updatePad, deleteSketch]) {
      const document = sampleDocument();
      const before = JSON.stringify(serializeCadDocument(document));
      applyCommand(document, command);
      expect(JSON.stringify(serializeCadDocument(document))).toBe(before);
    }
  });

  it("rejects an object whose type is not a command with command/type-unknown", () => {
    const smuggled = {
      type: "body.delete",
      id: bodySolidId,
    } as unknown as CadCommand;
    expectError(
      applyCommand(sampleDocument(), smuggled),
      COMMAND_ERROR_CODES.typeUnknown,
    );
    expect(() => serializeCommand(smuggled)).toThrow(
      "Invariant violation: a serialized command must carry a known command type.",
    );
  });
});

describe("serializeCommand / parseCommand", () => {
  it("round-trips each command exactly through JSON", () => {
    for (const command of [setWidth, createFillet, updatePad, deleteSketch]) {
      const once = serializeCommand(command);
      const twice = serializeCommand(roundTripCommand(command));
      expect(twice).toEqual(once);
    }
  });

  it("carries formatVersion and a fixed key set per type", () => {
    expect(serializeCommand(deleteSketch)).toEqual({
      formatVersion: 1,
      type: "feature.delete",
      id: featSketchId,
    });
    expect(Object.keys(serializeCommand(setWidth))).toEqual([
      "formatVersion",
      "type",
      "id",
      "value",
    ]);
    expect(Object.keys(serializeCommand(createFillet))).toEqual([
      "formatVersion",
      "type",
      "kind",
      "inputs",
      "outputs",
    ]);
  });

  it("serializes dimensional values canonically, so replay stores the equal canonical quantity", () => {
    const command: CadCommand = {
      type: "parameter.set",
      id: widthId,
      value: length(1, "in"),
    };
    const serialized = serializeCommand(command);
    expect(serialized.type === "parameter.set" && serialized.value).toEqual({
      dimension: "length",
      unit: "mm",
      value: 25.4,
    });
    const direct = unwrap(
      applyCommand(sampleDocument(), command),
      "applyCommand",
    );
    const replayed = unwrap(
      applyCommand(sampleDocument(), roundTripCommand(command)),
      "applyCommand",
    );
    expect(serializeCadDocument(replayed)).toEqual(
      serializeCadDocument(direct),
    );
  });
});

describe("parseCommand rejects malformed input", () => {
  it("rejects non-objects with command/malformed", () => {
    for (const input of [null, 42, "parameter.set", [], undefined]) {
      expectError(parseCommand(input), COMMAND_ERROR_CODES.malformed);
    }
  });

  it("rejects a wrong formatVersion with command/version-unsupported", () => {
    expectError(
      parseCommand({ ...serializeCommand(deleteSketch), formatVersion: 0 }),
      COMMAND_ERROR_CODES.versionUnsupported,
    );
    expectError(
      parseCommand({
        formatVersion: 2,
        type: "feature.delete",
        id: featSketchId,
      }),
      COMMAND_ERROR_CODES.versionUnsupported,
    );
  });

  it("rejects an unknown type with command/type-unknown", () => {
    expectError(
      parseCommand({ formatVersion: 1, type: "body.delete", id: "body_x" }),
      COMMAND_ERROR_CODES.typeUnknown,
    );
    expectError(
      parseCommand({ formatVersion: 1, type: 7 }),
      COMMAND_ERROR_CODES.typeUnknown,
    );
  });

  it("rejects malformed payloads with command/malformed", () => {
    const badPayloads: readonly unknown[] = [
      {
        formatVersion: 1,
        type: "parameter.set",
        id: "width",
        value: { dimension: "length", unit: "mm", value: 1 },
      },
      {
        formatVersion: 1,
        type: "parameter.set",
        id: "param_width",
        value: { dimension: "length", unit: "mm", value: "1" },
      },
      {
        formatVersion: 1,
        type: "feature.create",
        id: "feat_x!",
        kind: "sketch",
        inputs: [],
        outputs: [],
      },
      {
        formatVersion: 1,
        type: "feature.create",
        id: "feat_x",
        kind: "1sketch",
        inputs: [],
        outputs: [],
      },
      {
        formatVersion: 1,
        type: "feature.create",
        kind: "sketch",
        inputs: {},
        outputs: [],
      },
      {
        formatVersion: 1,
        type: "feature.create",
        kind: "sketch",
        inputs: [{ kind: "body", id: "param_width" }],
        outputs: [],
      },
      {
        formatVersion: 1,
        type: "feature.create",
        kind: "sketch",
        inputs: [],
        outputs: "body_solid",
      },
      {
        formatVersion: 1,
        type: "feature.create",
        kind: "sketch",
        inputs: [],
        outputs: ["body_!"],
      },
      {
        formatVersion: 1,
        type: "feature.update",
        id: "body_solid",
        kind: "sketch",
        inputs: [],
        outputs: [],
      },
      {
        formatVersion: 1,
        type: "feature.update",
        id: "feat_x",
        kind: "1sketch",
        inputs: [],
        outputs: [],
      },
      { formatVersion: 1, type: "feature.delete", id: "feat_" },
    ];
    for (const input of badPayloads) {
      expectError(parseCommand(input), COMMAND_ERROR_CODES.malformed);
    }
  });

  it("tolerates unknown fields for forward compatibility", () => {
    const parsed = unwrap(
      parseCommand({
        formatVersion: 1,
        type: "feature.delete",
        id: featSketchId,
        futureField: { note: "added in a later format" },
      }),
      "parseCommand",
    );
    expect(parsed).toEqual({ type: "feature.delete", id: featSketchId });
  });

  it("parses feature.create with and without an explicit id", () => {
    const generated = unwrap(
      parseCommand({
        formatVersion: 1,
        type: "feature.create",
        kind: "sketch",
        inputs: [],
        outputs: [],
      }),
      "parseCommand",
    );
    expect(generated).toEqual({
      type: "feature.create",
      kind: "sketch",
      inputs: [],
      outputs: [],
    });
    const explicit = unwrap(
      parseCommand({
        formatVersion: 1,
        type: "feature.create",
        id: featSketchId,
        kind: "sketch",
        inputs: [],
        outputs: [],
      }),
      "parseCommand",
    );
    expect(explicit).toEqual({
      type: "feature.create",
      id: featSketchId,
      kind: "sketch",
      inputs: [],
      outputs: [],
    });
  });
});

describe("command replay determinism", () => {
  it("serialize → parse → apply equals direct apply, including onto a rebuilt document", () => {
    const commands: readonly CadCommand[] = [
      setWidth,
      createFillet,
      updatePad,
      { type: "feature.delete", id: featPadId },
    ];
    for (const command of commands) {
      const document = sampleDocument();
      const rebuilt = rebuiltDocument(document);
      const direct = unwrap(applyCommand(document, command), "applyCommand");
      const replayed = unwrap(
        applyCommand(rebuilt, roundTripCommand(command)),
        "applyCommand",
      );
      expect(serializeCadDocument(replayed)).toEqual(
        serializeCadDocument(direct),
      );
      // The replayed document itself still round-trips exactly.
      expect(
        serializeCadDocument(
          unwrap(
            parseCadDocument(
              JSON.parse(JSON.stringify(serializeCadDocument(replayed))),
            ),
            "re-reparse",
          ),
        ),
      ).toEqual(serializeCadDocument(replayed));
    }
  });

  it("replays a generated-id feature.create onto the identical id", () => {
    const document = sampleDocument();
    const direct = unwrap(applyCommand(document, createFillet), "applyCommand");
    const replayed = unwrap(
      applyCommand(rebuiltDocument(document), roundTripCommand(createFillet)),
      "applyCommand",
    );
    const directId = direct.features.at(-1)?.id;
    expect(replayed.features.at(-1)?.id).toBe(directId);
  });
});

describe("feature.reorder (Phase 20)", () => {
  const reorderFree = (afterFeatureId: FeatureId | null): CadCommand => ({
    type: "feature.reorder",
    id: featFreeId,
    afterFeatureId,
  });

  function documentWithFreeFeature(): CadDocument {
    return unwrap(
      applyCommand(sampleDocument(), {
        type: "feature.create",
        id: featFreeId,
        kind: "datum",
        inputs: [],
        outputs: [],
      }),
      "feature.create(datum)",
    );
  }

  it("moves the feature to immediately after the anchor", () => {
    const document = documentWithFreeFeature();
    const applied = unwrap(
      applyCommand(document, reorderFree(featSketchId)),
      "feature.reorder",
    );
    expect(applied.features.map((feature) => feature.id)).toEqual([
      featSketchId,
      featFreeId,
      featPadId,
    ]);
  });

  it("moves the feature to the front with a null anchor", () => {
    const document = documentWithFreeFeature();
    const applied = unwrap(
      applyCommand(document, reorderFree(null)),
      "feature.reorder",
    );
    expect(applied.features.map((feature) => feature.id)).toEqual([
      featFreeId,
      featSketchId,
      featPadId,
    ]);
  });

  it("is deterministic and pure: the same command applies identically, input untouched", () => {
    const document = documentWithFreeFeature();
    const first = unwrap(
      applyCommand(document, reorderFree(featSketchId)),
      "feature.reorder",
    );
    const second = unwrap(
      applyCommand(document, reorderFree(featSketchId)),
      "feature.reorder",
    );
    expect(serializeCadDocument(first)).toEqual(serializeCadDocument(second));
    expect(document.features.map((feature) => feature.id)).toEqual([
      featSketchId,
      featPadId,
      featFreeId,
    ]);
  });

  it("replays through document parse: a reordered list round-trips in order", () => {
    const document = documentWithFreeFeature();
    const applied = unwrap(
      applyCommand(document, reorderFree(null)),
      "feature.reorder",
    );
    const reparsed = unwrap(
      parseCadDocument(serializeCadDocument(applied)),
      "parse",
    );
    expect(reparsed.features.map((feature) => feature.id)).toEqual(
      applied.features.map((feature) => feature.id),
    );
  });

  it("rejects unknown features, self anchors, and order violations, structurally", () => {
    const document = documentWithFreeFeature();
    expectError(
      applyCommand(document, {
        type: "feature.reorder",
        id: createFeatureId("feat_ghost"),
        afterFeatureId: null,
      }),
      DOCUMENT_ERROR_CODES.notFound,
    );
    expectError(
      applyCommand(document, {
        type: "feature.reorder",
        id: featFreeId,
        afterFeatureId: featFreeId,
      }),
      DOCUMENT_ERROR_CODES.reorderInvalid,
    );
    expectError(
      applyCommand(document, {
        type: "feature.reorder",
        id: featSketchId,
        afterFeatureId: featPadId,
      }),
      DOCUMENT_ERROR_CODES.reorderInvalid,
    );
    expectError(
      applyCommand(document, reorderFree(createFeatureId("feat_ghost"))),
      DOCUMENT_ERROR_CODES.reorderInvalid,
    );
  });

  it("serializes to a fixed shape and round-trips, anchor and null alike", () => {
    const anchored = roundTripCommand(reorderFree(featPadId));
    expect(anchored).toEqual({
      type: "feature.reorder",
      id: featFreeId,
      afterFeatureId: featPadId,
    });
    expect(Object.keys(serializeCommand(reorderFree(featPadId)))).toEqual([
      "formatVersion",
      "type",
      "id",
      "afterFeatureId",
    ]);
    const toFront = roundTripCommand(reorderFree(null));
    expect(toFront).toEqual({
      type: "feature.reorder",
      id: featFreeId,
      afterFeatureId: null,
    });
  });
});

describe("reference.create (Phase 26.5)", () => {
  /**
   * A canonical serialized persistent-reference payload — the form
   * `serializeTopologyReference` emits for an edge reference (pinned
   * parseable by the persistent-reference module's own tests). Its schema
   * is this module's neighbour's, validated there on use; the command and
   * document layers carry it verbatim.
   */
  const referencePayload = Object.freeze({
    id: "ref_edge_seam",
    kind: "edge",
    bodyId: "body_solid",
    provenance: Object.freeze({
      bodyId: "body_solid",
      featurePath: Object.freeze(["feat_sketch", "feat_pad"]),
    }),
    identity: Object.freeze({
      kernelId: "opencascade",
      schema: "occt-shape-hash-v1",
      data: Object.freeze({ hash: 123456789 }),
    }),
    geometry: Object.freeze({
      lengthMm: 10,
      centroidAbsoluteMm: Object.freeze([0, 5, 5]),
      centroidRelativeMm: Object.freeze([0, 5, 0]),
    }),
    validity: Object.freeze({ state: "valid", regeneration: 3, ordinal: 1 }),
  });

  const referenceId = createReferenceId("ref_edge_seam");
  const createReference: CadCommand = {
    type: "reference.create",
    id: referenceId,
    name: "seam edge",
    reference: referencePayload,
  };

  it("adds the reference record through the command layer, payload verbatim", () => {
    const applied = unwrap(
      applyCommand(sampleDocument(), createReference),
      "applyCommand",
    );
    expect(applied.references.length).toBe(1);
    const stored = getDocumentReference(applied, referenceId);
    expect(stored?.name).toBe("seam edge");
    expect(stored?.reference).toEqual(referencePayload);
  });

  it("round-trips reference.create through serialize → JSON → parse", () => {
    const once = serializeCommand(createReference);
    expect(Object.keys(once)).toEqual([
      "formatVersion",
      "type",
      "id",
      "name",
      "reference",
    ]);
    const revived = roundTripCommand(createReference);
    expect(revived).toEqual(createReference);
    expect(serializeCommand(revived)).toEqual(once);
    // The replayed command applies to the identical stored record.
    const applied = unwrap(
      applyCommand(sampleDocument(), revived),
      "applyCommand",
    );
    expect(getDocumentReference(applied, referenceId)?.reference).toEqual(
      referencePayload,
    );
  });

  it("commits [reference.create, feature.create] atomically: a mid-transaction failure leaves the base untouched", () => {
    const consumeReference: CadCommand = {
      type: "feature.create",
      id: createFeatureId("feat_fillet"),
      kind: "fillet",
      inputs: [{ kind: "reference", id: referenceId }],
      outputs: [],
    };
    const base = sampleDocument();
    const committed = unwrap(
      applyTransaction(base, {
        commands: [createReference, consumeReference],
      }),
      "applyTransaction",
    );
    expect(committed.references.length).toBe(1);
    expect(committed.features.at(-1)?.inputs).toEqual([
      { kind: "reference", id: referenceId },
    ]);

    // The same transaction with a colliding feature id fails at the second
    // command — and the reference the fold had already added to its private
    // intermediate state is nowhere in the caller's document: a failed
    // transaction is a never-happened transaction.
    const conflicting: CadCommand = { ...consumeReference, id: featSketchId };
    const before = JSON.stringify(serializeCadDocument(base));
    const failed = applyTransaction(base, {
      commands: [createReference, conflicting],
    });
    expectError(failed, TRANSACTION_ERROR_CODES.commandFailed);
    if (failed.ok) return;
    expect(failed.error.index).toBe(1);
    expect(failed.error.cause?.code).toBe(DOCUMENT_ERROR_CODES.idConflict);
    expect(JSON.stringify(serializeCadDocument(base))).toBe(before);
  });

  it("rejects an invalid reference payload or name at both layers, structurally", () => {
    // The parse layer: structure only — a plain-object payload, a valid id,
    // a non-empty name.
    expectError(
      parseCommand({
        formatVersion: 1,
        type: "reference.create",
        name: "bad",
        reference: 42,
      }),
      COMMAND_ERROR_CODES.malformed,
    );
    expectError(
      parseCommand({
        formatVersion: 1,
        type: "reference.create",
        id: "reference_x",
        name: "x",
        reference: {},
      }),
      COMMAND_ERROR_CODES.malformed,
    );
    expectError(
      parseCommand({
        formatVersion: 1,
        type: "reference.create",
        name: "",
        reference: {},
      }),
      COMMAND_ERROR_CODES.malformed,
    );
    // The apply layer re-validates smuggled input at the substrate: the
    // document codes, not a corrupted record.
    const smuggledName = {
      type: "reference.create",
      id: referenceId,
      name: "",
      reference: referencePayload,
    } as unknown as CadCommand;
    expectError(
      applyCommand(sampleDocument(), smuggledName),
      DOCUMENT_ERROR_CODES.referenceNameInvalid,
    );
    const smuggledPayload = {
      type: "reference.create",
      id: referenceId,
      name: "ok",
      reference: [1, 2, 3],
    } as unknown as CadCommand;
    expectError(
      applyCommand(sampleDocument(), smuggledPayload),
      DOCUMENT_ERROR_CODES.referencePayloadInvalid,
    );
  });
});
