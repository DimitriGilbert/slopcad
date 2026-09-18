import { describe, expect, it } from "vitest";

import {
  addBody,
  addDocumentParameter,
  addFeature,
  applySessionCommand,
  applySessionTransaction,
  type CadCommand,
  type CadDocument,
  type CadSession,
  type CadTransaction,
  canRedo,
  canUndo,
  createBodyId,
  createDocument,
  createDocumentId,
  createFeatureId,
  createParameterId,
  createSession,
  DOCUMENT_ERROR_CODES,
  getDocumentParameter,
  getFeature,
  HISTORY_ERROR_CODES,
  length,
  type ParseFailure,
  type ParseResult,
  redoSession,
  serializeCadDocument,
  TRANSACTION_ERROR_CODES,
  undoSession,
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

const setWidth: CadCommand = {
  type: "parameter.set",
  id: widthId,
  value: length(50.8, "mm"),
};

const createPad: CadCommand = {
  type: "feature.create",
  id: featPadId,
  kind: "pad",
  inputs: [{ kind: "feature", id: featSketchId }],
  outputs: [],
};

function serializationOf(session: CadSession): string {
  return JSON.stringify(serializeCadDocument(session.document));
}

function applyOrDie(session: CadSession, command: CadCommand): CadSession {
  return unwrap(applySessionCommand(session, command), "applySessionCommand");
}

describe("createSession", () => {
  it("composes a document with an empty history over it", () => {
    const base = sampleDocument();
    const session = createSession(base);
    expect(session.document).toBe(base);
    expect(canUndo(session.history)).toBe(false);
    expect(canRedo(session.history)).toBe(false);
  });
});

describe("applySessionCommand / applySessionTransaction", () => {
  it("applies a single command and records exactly one history entry", () => {
    const session = applyOrDie(createSession(sampleDocument()), setWidth);
    expect(getDocumentParameter(session.document, widthId)?.value).toEqual(
      length(50.8, "mm"),
    );
    expect(session.history.entries.length).toBe(1);
    expect(canUndo(session.history)).toBe(true);
  });

  it("applies a transaction atomically and records it as one entry", () => {
    const transaction: CadTransaction = {
      commands: [
        setWidth,
        createPad,
        { type: "parameter.set", id: widthId, value: length(76.2, "mm") },
      ],
    };
    const session = unwrap(
      applySessionTransaction(createSession(sampleDocument()), transaction),
      "applySessionTransaction",
    );
    expect(session.history.entries.length).toBe(1);
    expect(getDocumentParameter(session.document, widthId)?.value).toEqual(
      length(76.2, "mm"),
    );
    expect(getFeature(session.document, featPadId)?.kind).toBe("pad");
  });

  it("leaves the session untouched when the transaction fails", () => {
    const session = applyOrDie(createSession(sampleDocument()), setWidth);
    const before = serializationOf(session);
    const entriesBefore = session.history.entries.length;
    const failing: CadTransaction = {
      commands: [
        { type: "parameter.set", id: widthId, value: length(5, "mm") },
        { type: "feature.delete", id: createFeatureId("feat_missing") },
      ],
    };
    const result = applySessionTransaction(session, failing);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(TRANSACTION_ERROR_CODES.commandFailed);
    expect(result.error.index).toBe(1);
    expect(result.error.cause?.code).toBe(DOCUMENT_ERROR_CODES.notFound);
    expect(serializationOf(session)).toBe(before);
    expect(session.history.entries.length).toBe(entriesBefore);
    expect(getDocumentParameter(session.document, widthId)?.value).toEqual(
      length(50.8, "mm"),
    );
  });
});

describe("undoSession / redoSession", () => {
  it("round-trips exact states, including the generator, for generated ids", () => {
    const generated: CadCommand = {
      type: "feature.create",
      kind: "fillet",
      inputs: [],
      outputs: [],
    };
    const base = sampleDocument();
    const afterSet = applyOrDie(createSession(base), setWidth);
    const session = applyOrDie(afterSet, generated);
    const createdId = session.document.features.at(-1)?.id;
    expect(createdId).toBeDefined();

    const undone = unwrap(undoSession(session), "undoSession");
    expect(serializationOf(undone)).toBe(serializationOf(afterSet));
    expect(undone.document.idGeneratorState).toEqual(
      afterSet.document.idGeneratorState,
    );

    const redone = unwrap(redoSession(undone), "redoSession");
    expect(serializationOf(redone)).toBe(serializationOf(session));

    // After undo, the same command regenerates the identical id.
    const recommitted = applyOrDie(undone, generated);
    expect(recommitted.document.features.at(-1)?.id).toBe(createdId);
    expect(canRedo(recommitted.history)).toBe(false);
  });

  it("undoes a single-command session back to the base document exactly", () => {
    const base = sampleDocument();
    const session = applyOrDie(createSession(base), setWidth);
    const undone = unwrap(undoSession(session), "undoSession");
    expect(undone.document).toBe(base);
    expect(canUndo(undone.history)).toBe(false);
    expectError(undoSession(undone), HISTORY_ERROR_CODES.nothingToUndo);
    expect(canRedo(undone.history)).toBe(true);
  });

  it("discards the redo branch on a new mutation after undo", () => {
    const session = applyOrDie(
      applyOrDie(createSession(sampleDocument()), setWidth),
      createPad,
    );
    const undone = unwrap(undoSession(session), "undoSession");
    const mutated = applyOrDie(undone, setWidth);
    expect(canRedo(mutated.history)).toBe(false);
    expectError(redoSession(mutated), HISTORY_ERROR_CODES.nothingToRedo);
  });

  it("walks an interleaved undo, undo, redo, mutate, undo sequence exactly", () => {
    const base = sampleDocument();
    const s1 = applyOrDie(createSession(base), setWidth);
    const s2 = applyOrDie(s1, createPad);
    const s3 = applyOrDie(s2, { type: "feature.delete", id: featPadId });

    const u1 = unwrap(undoSession(s3), "undoSession");
    expect(serializationOf(u1)).toBe(serializationOf(s2));
    const u2 = unwrap(undoSession(u1), "undoSession");
    expect(serializationOf(u2)).toBe(serializationOf(s1));
    const r1 = unwrap(redoSession(u2), "redoSession");
    expect(serializationOf(r1)).toBe(serializationOf(s2));
    const m1 = applyOrDie(r1, setWidth);
    const u3 = unwrap(undoSession(m1), "undoSession");
    expect(serializationOf(u3)).toBe(serializationOf(s2));
    expect(getFeature(u3.document, featPadId)?.id).toBe(featPadId);
  });

  it("refuses redo at the head of history", () => {
    const session = applyOrDie(createSession(sampleDocument()), setWidth);
    expectError(redoSession(session), HISTORY_ERROR_CODES.nothingToRedo);
  });
});
