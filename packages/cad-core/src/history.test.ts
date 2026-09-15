import { describe, expect, it } from "vitest";

import {
  addBody,
  addDocumentParameter,
  addFeature,
  applyTransaction,
  canRedo,
  canUndo,
  type CadDocument,
  type CadTransaction,
  createBodyId,
  createDocument,
  createDocumentId,
  createFeatureId,
  createParameterId,
  currentDocument,
  createDocumentHistory,
  getFeature,
  HISTORY_ERROR_CODES,
  type HistoryMove,
  length,
  parseCadDocument,
  type ParseFailure,
  type ParseResult,
  recordTransaction,
  redoHistory,
  serializeCadDocument,
  serializeCommand,
  undoHistory,
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

const setWidth: CadTransaction = {
  commands: [{ type: "parameter.set", id: widthId, value: length(50.8, "mm") }],
};

const createPad: CadTransaction = {
  commands: [
    {
      type: "feature.create",
      id: featPadId,
      kind: "pad",
      inputs: [{ kind: "feature", id: featSketchId }],
      outputs: [],
    },
  ],
};

const deletePad: CadTransaction = {
  commands: [
    { type: "feature.delete", id: featPadId },
  ],
};

/** Applies a transaction to a document and records it into the history. */
function commit(
  history: ReturnType<typeof createDocumentHistory>,
  document: CadDocument,
  transaction: CadTransaction,
): { history: ReturnType<typeof createDocumentHistory>; document: CadDocument } {
  const next = unwrap(applyTransaction(document, transaction), "applyTransaction");
  return {
    history: recordTransaction(history, transaction, next),
    document: next,
  };
}

function serializationOf(document: CadDocument): string {
  return JSON.stringify(serializeCadDocument(document));
}

describe("DocumentHistory", () => {
  it("starts at the base document with nothing to undo or redo", () => {
    const base = sampleDocument();
    const history = createDocumentHistory(base);
    expect(currentDocument(history)).toBe(base);
    expect(canUndo(history)).toBe(false);
    expect(canRedo(history)).toBe(false);
    expectError(undoHistory(history), HISTORY_ERROR_CODES.nothingToUndo);
    expectError(redoHistory(history), HISTORY_ERROR_CODES.nothingToRedo);
  });

  it("undo restores the exact prior state, including the id generator state", () => {
    const base = sampleDocument();
    const step = commit(createDocumentHistory(base), base, createPad);
    const undone = unwrap(undoHistory(step.history), "undoHistory");
    expect(serializationOf(undone.document)).toBe(serializationOf(base));
    expect(undone.document.idGeneratorState).toEqual(base.idGeneratorState);
    expect(canRedo(undone.history)).toBe(true);
    expect(canUndo(undone.history)).toBe(false);
  });

  it("rewinds the generator on undo, so generated ids regenerate identically", () => {
    const base = sampleDocument();
    const generated: CadTransaction = {
      commands: [{ type: "feature.create", kind: "fillet", inputs: [], outputs: [] }],
    };
    const step = commit(createDocumentHistory(base), base, generated);
    const createdId = step.document.features.at(-1)?.id;
    expect(createdId).toBeDefined();
    const undone = unwrap(undoHistory(step.history), "undoHistory");
    const recommit = commit(undone.history, undone.document, generated);
    expect(recommit.document.features.at(-1)?.id).toBe(createdId);
    expect(serializationOf(recommit.document)).toBe(serializationOf(step.document));
  });

  it("redo restores the exact next state and consumes the redo branch", () => {
    const base = sampleDocument();
    const step = commit(createDocumentHistory(base), base, createPad);
    const undone = unwrap(undoHistory(step.history), "undoHistory");
    const redone: HistoryMove = unwrap(redoHistory(undone.history), "redoHistory");
    expect(serializationOf(redone.document)).toBe(serializationOf(step.document));
    expect(redone.document).toBe(step.document);
    expect(redone.transaction).toEqual(createPad);
    expect(canRedo(redone.history)).toBe(false);
    expect(canUndo(redone.history)).toBe(true);
  });

  it("a new commit after undo discards the redo branch", () => {
    const base = sampleDocument();
    const step = commit(createDocumentHistory(base), base, createPad);
    const undone = unwrap(undoHistory(step.history), "undoHistory");
    const branched = commit(undone.history, undone.document, setWidth);
    expect(canRedo(branched.history)).toBe(false);
    expectError(redoHistory(branched.history), HISTORY_ERROR_CODES.nothingToRedo);
    // The discarded createPad entry is gone: undo goes straight to the base.
    const back = unwrap(undoHistory(branched.history), "undoHistory");
    expect(serializationOf(back.document)).toBe(serializationOf(base));
  });

  it("walks an interleaved undo, undo, redo, mutate, undo sequence exactly", () => {
    const base = sampleDocument();
    const after1 = commit(createDocumentHistory(base), base, setWidth);
    const after2 = commit(after1.history, after1.document, createPad);
    const after3 = commit(after2.history, after2.document, deletePad);

    const undo1 = unwrap(undoHistory(after3.history), "undoHistory");
    expect(serializationOf(undo1.document)).toBe(serializationOf(after2.document));
    const undo2 = unwrap(undoHistory(undo1.history), "undoHistory");
    expect(serializationOf(undo2.document)).toBe(serializationOf(after1.document));
    const redo1 = unwrap(redoHistory(undo2.history), "redoHistory");
    expect(serializationOf(redo1.document)).toBe(serializationOf(after2.document));
    const mutated = commit(redo1.history, redo1.document, setWidth);
    expect(canRedo(mutated.history)).toBe(false);
    const undo3 = unwrap(undoHistory(mutated.history), "undoHistory");
    expect(serializationOf(undo3.document)).toBe(serializationOf(after2.document));
  });

  it("restores the exact snapshot object on undo and redo, not a copy", () => {
    const base = sampleDocument();
    const after1 = commit(createDocumentHistory(base), base, setWidth);
    const after2 = commit(after1.history, after1.document, createPad);
    const undo1 = unwrap(undoHistory(after2.history), "undoHistory");
    expect(undo1.document).toBe(after1.document);
    const redo1 = unwrap(redoHistory(undo1.history), "redoHistory");
    expect(redo1.document).toBe(after2.document);
  });

  it("agrees with command-log replay: every snapshot equals replaying the log", () => {
    const base = sampleDocument();
    const after1 = commit(createDocumentHistory(base), base, setWidth);
    const after2 = commit(after1.history, after1.document, createPad);
    const after3 = commit(after2.history, after2.document, deletePad);

    let replayed = base;
    for (const entry of after3.history.entries) {
      replayed = unwrap(applyTransaction(replayed, entry.transaction), "replay");
      expect(serializationOf(replayed)).toBe(serializationOf(entry.document));
      expect(replayed.idGeneratorState).toEqual(entry.document.idGeneratorState);
    }
    expect(serializationOf(replayed)).toBe(serializationOf(after3.document));
  });

  it("survives base documents that were themselves rebuilt from serialization", () => {
    const base = unwrap(
      parseCadDocument(JSON.parse(JSON.stringify(serializeCadDocument(sampleDocument())))),
      "parseCadDocument",
    );
    const after1 = commit(createDocumentHistory(base), base, setWidth);
    const undo1 = unwrap(undoHistory(after1.history), "undoHistory");
    expect(undo1.document).toBe(base);
    const redo1 = unwrap(redoHistory(undo1.history), "redoHistory");
    expect(getFeature(redo1.document, featSketchId)?.id).toBe(featSketchId);
    expect(
      redo1.document.parameters.parameters.map((parameter) => parameter.value),
    ).toEqual([length(50.8, "mm")]);
  });

  it("serializes the commands it carries unchanged", () => {
    const base = sampleDocument();
    const after1 = commit(createDocumentHistory(base), base, createPad);
    const entry = after1.history.entries[0];
    expect(entry).toBeDefined();
    if (entry === undefined) return;
    expect(entry.transaction.commands.map(serializeCommand)).toEqual(
      createPad.commands.map(serializeCommand),
    );
  });
});
