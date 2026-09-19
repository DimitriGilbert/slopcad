/**
 * The `features` (history half) guide's runnable example
 * (docs/guides/features.md): the session/transaction/undo-redo surface —
 * one transaction carrying three commands (the sketch record, its
 * parameter, and the output body), committed atomically, then undone and
 * redone through the same history the native format persists.
 */

import {
  applySessionTransaction,
  canUndo,
  createBodyId,
  createDocument,
  createDocumentId,
  createParameterId,
  createSession,
  createSketchDocumentId,
  length,
  redoSession,
  serializeTransaction,
  undoSession,
  type CadSession,
  type CadTransaction,
} from "@slopcad/cad-core";
import {
  createSketch,
  serializeSketch,
  xyWorkplane,
} from "@slopcad/cad-sketch";

import { unwrap } from "./document";

/** What the example reports back to the guide and the docs page. */
export interface HistoryExampleSummary {
  readonly commandCount: number;
  readonly undoRemovedParameters: number;
  readonly redoRestoredParameters: number;
  readonly canUndoAfterBothMoves: boolean;
  readonly serializedCommandTypes: readonly string[];
}

/**
 * Commits a three-command transaction, undoes it, redoes it, and reports
 * the document states the moves produce — the undo restores the
 * pre-transaction parameter set, the redo re-applies it.
 */
export function runHistoryExample(): HistoryExampleSummary {
  let session: CadSession = createSession(
    createDocument(createDocumentId("doc_guide_history")),
  );

  // The sketch record the transaction carries: a real sketch, serialized
  // through cad-sketch's own serializer (the same wire form the
  // workbench's extrude commit carries).
  const sketch = createSketch(xyWorkplane(), [], []);
  if (!sketch.ok) {
    throw new Error(`The guide's sketch was rejected: ${sketch.error.message}`);
  }

  // One atomic transaction: the sketch, its depth parameter, and the
  // output body.
  const transaction: CadTransaction = {
    commands: [
      {
        type: "sketch.create",
        id: createSketchDocumentId("skd_guide_pad"),
        name: "pad sketch",
        sketch: serializeSketch(sketch.value) as unknown as Record<
          string,
          unknown
        >,
      },
      {
        type: "parameter.create",
        id: createParameterId("param_pad_depth"),
        name: "padDepth",
        value: length(6),
      },
      {
        type: "body.create",
        id: createBodyId("body_pad"),
        name: "pad",
      },
    ],
  };

  session = unwrap(
    applySessionTransaction(session, transaction),
    "the pad transaction",
  );
  const parametersAfterCommit = session.document.parameters.parameters.length;

  const undone = unwrap(undoSession(session), "undo");
  const parametersAfterUndo = undone.document.parameters.parameters.length;

  const redone = unwrap(redoSession(undone), "redo");
  const parametersAfterRedo = redone.document.parameters.parameters.length;

  // The machine-readable command log a host can record (the store's
  // `onTransaction` callback receives exactly this serialization).
  const serialized = serializeTransaction(transaction);

  return {
    commandCount: transaction.commands.length,
    undoRemovedParameters: parametersAfterCommit - parametersAfterUndo,
    redoRestoredParameters: parametersAfterRedo - parametersAfterUndo,
    canUndoAfterBothMoves: canUndo(redone.history),
    serializedCommandTypes: serialized.commands.map((command) => command.type),
  };
}
