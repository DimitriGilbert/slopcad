/**
 * Session (Phase 7.4): the supported mutation surface — a CAD document
 * composed with its undo/redo history. The four Phase 7 operations
 * (`parameter.set`, `feature.create`, `feature.update`, `feature.delete`)
 * are expressed as commands, wrapped in transactions, and applied through
 * {@link applySessionTransaction} / {@link applySessionCommand}; every
 * other method here is read-only or a history move ({@link undoSession},
 * {@link redoSession}).
 *
 * The Phase 6 document functions (`addFeature`, `removeFeature`,
 * `updateFeature`, …) remain exported as the substrate this layer
 * orchestrates — the kernel/worker phases build on them — but code that
 * wants undoable, replayable changes should go through the session: it is
 * the only API that keeps the document and the history in step. Mutating a
 * session's document through the raw substrate functions produces a
 * document the session's history no longer describes.
 *
 * A {@link CadSession} is immutable value state: applying, undoing, and
 * redoing return the next session and never modify the input, so sessions
 * thread through application code exactly like documents do. Later phases
 * (regeneration state, kernel execution) extend this composition without
 * changing the boundary.
 */

import { type CadCommand } from "./command";
import { type CadDocument } from "./document";
import {
  createDocumentHistory,
  type DocumentHistory,
  type HistoryError,
  redoHistory,
  recordTransaction,
  undoHistory,
} from "./history";
import { type ParseResult, ok } from "./result";
import {
  applyTransaction,
  type CadTransaction,
  type TransactionError,
} from "./transaction";

/** A document plus the undo/redo history of the commands applied to it. */
export interface CadSession {
  /** The document at the history cursor. */
  readonly document: CadDocument;
  /** Committed transactions, with the cursor marking the current position. */
  readonly history: DocumentHistory;
}

/** Starts a session over a base document with an empty history. */
export function createSession(base: CadDocument): CadSession {
  return Object.freeze({
    document: base,
    history: createDocumentHistory(base),
  });
}

/**
 * Applies a transaction atomically and records it as one history entry.
 * The commands run in order through the single command interpreter; on any
 * failure the input session is returned from untouched (immutable, with
 * its history exactly as it was — the failed transaction never happened).
 * Committing discards any redo branch that an earlier undo had left.
 */
export function applySessionTransaction(
  session: CadSession,
  transaction: CadTransaction,
): ParseResult<CadSession, TransactionError> {
  const applied = applyTransaction(session.document, transaction);
  if (!applied.ok) return applied;
  return ok(
    Object.freeze({
      document: applied.value,
      history: recordTransaction(session.history, transaction, applied.value),
    }),
  );
}

/**
 * Applies a single command as a one-command transaction — the ergonomic
 * path that stays inside the command/transaction boundary.
 */
export function applySessionCommand(
  session: CadSession,
  command: CadCommand,
): ParseResult<CadSession, TransactionError> {
  return applySessionTransaction(session, {
    commands: Object.freeze([command]),
  });
}

/**
 * Restores the exact previous document (the snapshot, including id
 * generator state) and moves the history cursor back one commit. Refused
 * with `history/nothing-to-undo` at the base.
 */
export function undoSession(
  session: CadSession,
): ParseResult<CadSession, HistoryError> {
  const moved = undoHistory(session.history);
  if (!moved.ok) return moved;
  return ok(
    Object.freeze({
      document: moved.value.document,
      history: moved.value.history,
    }),
  );
}

/**
 * Restores the exact next document along the remaining branch and moves
 * the history cursor forward one commit. Refused with
 * `history/nothing-to-redo` at the head or after a new mutation
 * invalidated the branch.
 */
export function redoSession(
  session: CadSession,
): ParseResult<CadSession, HistoryError> {
  const moved = redoHistory(session.history);
  if (!moved.ok) return moved;
  return ok(
    Object.freeze({
      document: moved.value.document,
      history: moved.value.history,
    }),
  );
}
