import { describe, expect, it } from "vitest";

import {
  addBody,
  addDocumentParameter,
  addFeature,
  applyTransaction,
  type CadDocument,
  type CadTransaction,
  createBodyId,
  createDocument,
  createDocumentId,
  createFeatureId,
  createParameterId,
  DOCUMENT_ERROR_CODES,
  getDocumentParameter,
  getFeature,
  length,
  parseCadDocument,
  parseTransaction,
  type ParseFailure,
  type ParseResult,
  serializeCadDocument,
  serializeTransaction,
  TRANSACTION_ERROR_CODES,
} from "./index";

const docId = createDocumentId("doc_root");
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

/** A document with one parameter, one body, and one feature consuming both. */
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
  return unwrap(
    addFeature(document, {
      id: featSketchId,
      kind: "sketch",
      inputs: [{ kind: "parameter", id: widthId }],
      outputs: [bodySolidId],
    }),
    "addFeature",
  ).document;
}

function roundTripTransaction(transaction: CadTransaction): CadTransaction {
  return unwrap(
    parseTransaction(JSON.parse(JSON.stringify(serializeTransaction(transaction)))),
    "parseTransaction",
  );
}

describe("applyTransaction", () => {
  it("commits an empty transaction to the identical document value", () => {
    const document = sampleDocument();
    const applied = unwrap(applyTransaction(document, { commands: [] }), "applyTransaction");
    expect(applied).toBe(document);
  });

  it("applies commands in order, each seeing the previous command's effect", () => {
    const recreateSketch: CadTransaction = {
      commands: [
        { type: "feature.delete", id: featSketchId },
        {
          type: "feature.create",
          id: featSketchId,
          kind: "sketch-2",
          inputs: [{ kind: "parameter", id: widthId }],
          outputs: [bodySolidId],
        },
        { type: "parameter.set", id: widthId, value: length(12.7, "mm") },
      ],
    };
    const applied = unwrap(
      applyTransaction(sampleDocument(), recreateSketch),
      "applyTransaction",
    );
    expect(applied.features.length).toBe(1);
    expect(applied.features[0]?.kind).toBe("sketch-2");
    expect(getDocumentParameter(applied, widthId)?.value).toEqual(length(12.7, "mm"));
  });

  it("supports chaining updates onto a feature created in the same transaction", () => {
    const transaction: CadTransaction = {
      commands: [
        {
          type: "feature.create",
          id: featPadId,
          kind: "pad",
          inputs: [],
          outputs: [],
        },
        {
          type: "feature.update",
          id: featPadId,
          kind: "pad-deep",
          inputs: [{ kind: "parameter", id: widthId }],
          outputs: [],
        },
      ],
    };
    const applied = unwrap(applyTransaction(sampleDocument(), transaction), "applyTransaction");
    const feature = getFeature(applied, featPadId);
    expect(feature?.kind).toBe("pad-deep");
    expect(feature?.inputs).toEqual([{ kind: "parameter", id: widthId }]);
  });

  it("fails atomically: first structured error, its index, and an untouched document", () => {    const document = sampleDocument();
    const before = JSON.stringify(serializeCadDocument(document));
    const failing: CadTransaction = {
      commands: [
        { type: "parameter.set", id: widthId, value: length(76.2, "mm") },
        { type: "feature.delete", id: featSketchId }, // succeeds: nothing references it
        { type: "feature.delete", id: featSketchId }, // fails: already removed above
      ],
    };
    const result = applyTransaction(document, failing);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(TRANSACTION_ERROR_CODES.commandFailed);
    expect(result.error.index).toBe(2);
    expect(result.error.cause?.code).toBe(DOCUMENT_ERROR_CODES.notFound);
    // Atomicity: the never-mutated input document is unchanged — no partial
    // effect of the first two commands is visible on it.
    expect(JSON.stringify(serializeCadDocument(document))).toBe(before);
    expect(getDocumentParameter(document, widthId)?.value).toEqual(length(25.4, "mm"));
    expect(getFeature(document, featSketchId)?.id).toBe(featSketchId);
  });

  it("reports the first failing command when several would fail", () => {
    const failing: CadTransaction = {
      commands: [
        { type: "feature.delete", id: featPadId }, // not found (only sketch exists)
        { type: "feature.delete", id: featSketchId },
      ],
    };
    const result = applyTransaction(sampleDocument(), failing);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.index).toBe(0);
    expect(result.error.cause?.code).toBe(DOCUMENT_ERROR_CODES.notFound);
  });

  it("rejects a smuggled non-array commands field with transaction/malformed", () => {
    const smuggled = {
      commands: "parameter.set",
    } as unknown as CadTransaction;
    const result = applyTransaction(sampleDocument(), smuggled);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(TRANSACTION_ERROR_CODES.malformed);
    expect(result.error.index).toBe(-1);
  });

  it("replays deterministically: serialize → parse → apply equals direct apply", () => {
    const transaction: CadTransaction = {
      commands: [
        { type: "parameter.set", id: widthId, value: length(1, "in") },
        {
          type: "feature.create",
          kind: "fillet",
          inputs: [{ kind: "feature", id: featSketchId }],
          outputs: [],
        },
        { type: "parameter.set", id: widthId, value: length(2, "in") },
      ],
    };
    const document = sampleDocument();
    const rebuilt = unwrap(
      parseCadDocument(JSON.parse(JSON.stringify(serializeCadDocument(document)))),
      "parseCadDocument",
    );
    const direct = unwrap(applyTransaction(document, transaction), "applyTransaction");
    const replayed = unwrap(
      applyTransaction(rebuilt, roundTripTransaction(transaction)),
      "applyTransaction",
    );
    expect(serializeCadDocument(replayed)).toEqual(serializeCadDocument(direct));
  });
});

describe("serializeTransaction / parseTransaction", () => {
  it("round-trips exactly through JSON, unknown fields tolerated", () => {
    const transaction: CadTransaction = {
      commands: [
        { type: "parameter.set", id: widthId, value: length(5, "mm") },
        { type: "feature.delete", id: featSketchId },
      ],
    };
    const serialized = serializeTransaction(transaction);
    expect(Object.keys(serialized)).toEqual(["formatVersion", "commands"]);
    expect(Object.keys(serialized.commands[0] ?? {})).toEqual([
      "formatVersion",
      "type",
      "id",
      "value",
    ]);
    const reparsed = unwrap(
      parseTransaction({
        ...JSON.parse(JSON.stringify(serialized)),
        futureField: true,
      }),
      "parseTransaction",
    );
    expect(serializeTransaction(reparsed)).toEqual(serialized);
  });

  it("serializes an empty transaction to an empty command list", () => {
    expect(serializeTransaction({ commands: [] })).toEqual({
      formatVersion: 1,
      commands: [],
    });
  });

  it("rejects non-objects with transaction/malformed", () => {
    for (const input of [null, "tx", 7, [], undefined]) {
      expectError(parseTransaction(input), TRANSACTION_ERROR_CODES.malformed);
    }
  });

  it("rejects a wrong formatVersion with transaction/version-unsupported", () => {
    expectError(
      parseTransaction({ formatVersion: 0, commands: [] }),
      TRANSACTION_ERROR_CODES.versionUnsupported,
    );
    expectError(
      parseTransaction({ formatVersion: 2, commands: [] }),
      TRANSACTION_ERROR_CODES.versionUnsupported,
    );
  });

  it("rejects a missing or non-array commands field with transaction/malformed", () => {
    expectError(
      parseTransaction({ formatVersion: 1 }),
      TRANSACTION_ERROR_CODES.malformed,
    );
    expectError(
      parseTransaction({ formatVersion: 1, commands: "parameter.set" }),
      TRANSACTION_ERROR_CODES.malformed,
    );
  });

  it("rejects a malformed command with its index and the command's cause", () => {
    const result = parseTransaction({
      formatVersion: 1,
      commands: [
        { formatVersion: 1, type: "feature.delete", id: featSketchId },
        { formatVersion: 1, type: "feature.delete", id: "feat_" },
      ],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(TRANSACTION_ERROR_CODES.malformed);
    expect(result.error.index).toBe(1);
    expect(result.error.cause?.code).toBe("command/malformed");
  });

  it("applies its parsed output through the same path as direct apply", () => {
    const transaction: CadTransaction = {
      commands: [
        {
          type: "feature.update",
          id: featSketchId,
          kind: "sketch-deep",
          inputs: [{ kind: "parameter", id: widthId }],
          outputs: [bodySolidId],
        },
      ],
    };
    const document = sampleDocument();
    const direct = unwrap(applyTransaction(document, transaction), "applyTransaction");
    const replayed = unwrap(
      applyTransaction(document, roundTripTransaction(transaction)),
      "applyTransaction",
    );
    expect(serializeCadDocument(replayed)).toEqual(serializeCadDocument(direct));
  });
});
