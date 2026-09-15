import { describe, expect, it } from "vitest";

import {
  addBody,
  addDocumentParameter,
  addFeature,
  applyCommand,
  type CadCommand,
  type CadDocument,
  COMMAND_ERROR_CODES,
  createBodyId,
  createDocument,
  createDocumentId,
  createFeatureId,
  createParameterId,
  type DocumentId,
  DOCUMENT_ERROR_CODES,
  type FeatureId,
  getDocumentParameter,
  getFeature,
  length,
  parseCadDocument,
  parseCommand,
  type ParseFailure,
  type ParseResult,
  PARAMETER_ERROR_CODES,
  serializeCadDocument,
  serializeCommand,
} from "./index";

const docId: DocumentId = createDocumentId("doc_root");
const widthId = createParameterId("param_width");
const bodySolidId = createBodyId("body_solid");
const featSketchId = createFeatureId("feat_sketch");
const featPadId = createFeatureId("feat_pad");

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
    expectError(applyCommand(sampleDocument(), command), PARAMETER_ERROR_CODES.notFound);
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
    const applied = unwrap(applyCommand(sampleDocument(), command), "applyCommand");
    expect(applied.features.length).toBe(3);
    expect(getFeature(applied, createFeatureId("feat_fillet"))?.kind).toBe("fillet");
  });

  it("generates deterministic feature ids: the same command on the same state makes the same id", () => {
    const first = unwrap(applyCommand(sampleDocument(), createFillet), "applyCommand");
    const second = unwrap(applyCommand(sampleDocument(), createFillet), "applyCommand");
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
    expectError(applyCommand(document, unresolvable), DOCUMENT_ERROR_CODES.inputUnknown);
  });

  it("applies feature.delete and propagates in-use and not-found failures", () => {
    const document = sampleDocument();
    expectError(applyCommand(document, deleteSketch), DOCUMENT_ERROR_CODES.inUse);
    const applied = unwrap(
      applyCommand(document, { type: "feature.delete", id: featPadId }),
      "applyCommand",
    );
    expect(applied.features.length).toBe(1);
    expectError(
      applyCommand(applied, { type: "feature.delete", id: featPadId }),
      DOCUMENT_ERROR_CODES.notFound,
    );
    const withoutPad = unwrap(applyCommand(applied, deleteSketch), "applyCommand");
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
      type: "body.create",
      id: bodySolidId,
    } as unknown as CadCommand;
    expectError(applyCommand(sampleDocument(), smuggled), COMMAND_ERROR_CODES.typeUnknown);
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
    const direct = unwrap(applyCommand(sampleDocument(), command), "applyCommand");
    const replayed = unwrap(
      applyCommand(sampleDocument(), roundTripCommand(command)),
      "applyCommand",
    );
    expect(serializeCadDocument(replayed)).toEqual(serializeCadDocument(direct));
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
      parseCommand({ formatVersion: 2, type: "feature.delete", id: featSketchId }),
      COMMAND_ERROR_CODES.versionUnsupported,
    );
  });

  it("rejects an unknown type with command/type-unknown", () => {
    expectError(
      parseCommand({ formatVersion: 1, type: "body.create", id: "body_x" }),
      COMMAND_ERROR_CODES.typeUnknown,
    );
    expectError(
      parseCommand({ formatVersion: 1, type: 7 }),
      COMMAND_ERROR_CODES.typeUnknown,
    );
  });

  it("rejects malformed payloads with command/malformed", () => {
    const badPayloads: readonly unknown[] = [
      { formatVersion: 1, type: "parameter.set", id: "width", value: { dimension: "length", unit: "mm", value: 1 } },
      { formatVersion: 1, type: "parameter.set", id: "param_width", value: { dimension: "length", unit: "mm", value: "1" } },
      { formatVersion: 1, type: "feature.create", id: "feat_x!", kind: "sketch", inputs: [], outputs: [] },
      { formatVersion: 1, type: "feature.create", id: "feat_x", kind: "1sketch", inputs: [], outputs: [] },
      { formatVersion: 1, type: "feature.create", kind: "sketch", inputs: {}, outputs: [] },
      { formatVersion: 1, type: "feature.create", kind: "sketch", inputs: [{ kind: "body", id: "param_width" }], outputs: [] },
      { formatVersion: 1, type: "feature.create", kind: "sketch", inputs: [], outputs: "body_solid" },
      { formatVersion: 1, type: "feature.create", kind: "sketch", inputs: [], outputs: ["body_!"] },
      { formatVersion: 1, type: "feature.update", id: "body_solid", kind: "sketch", inputs: [], outputs: [] },
      { formatVersion: 1, type: "feature.update", id: "feat_x", kind: "1sketch", inputs: [], outputs: [] },
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
      parseCommand({ formatVersion: 1, type: "feature.create", kind: "sketch", inputs: [], outputs: [] }),
      "parseCommand",
    );
    expect(generated).toEqual({ type: "feature.create", kind: "sketch", inputs: [], outputs: [] });
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
      expect(serializeCadDocument(replayed)).toEqual(serializeCadDocument(direct));
      // The replayed document itself still round-trips exactly.
      expect(serializeCadDocument(unwrap(
        parseCadDocument(JSON.parse(JSON.stringify(serializeCadDocument(replayed)))),
        "re-reparse",
      ))).toEqual(serializeCadDocument(replayed));
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
