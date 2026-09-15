/**
 * Undo/redo history (Phase 7.3): a cursor over committed transactions, each
 * recorded with the immutable document snapshot it produced.
 *
 * ## Mechanism decision: snapshots, not inverse commands
 *
 * Undo and redo move the cursor and restore the snapshot at it. Snapshots
 * are exact by construction — they ARE the documents the commits produced,
 * including `idGeneratorState`, which no inverse-command scheme could
 * restore (creating a feature advances the generator; an inverse "delete"
 * does not rewind it, so undo-by-inverses would leak counter state and
 * change which ids regenerate). Because documents are immutable, snapshots
 * share structure with the live document and cost nothing to hold or
 * restore — no copies, no diffing, O(1) moves.
 *
 * Command-log replay stays supported and consistent without duplicating
 * semantics: it reuses the very same interpreter ({@link applyTransaction}
 * over each entry's recorded command list, starting at the base document)
 * and lands on the same states because command application is a pure
 * deterministic function of (document, command). The history tests pin
 * that equivalence — every snapshot is serialization-equal (and generator-
 * equal) to replaying the log up to it. One mutation semantics, two
 * consumers: snapshots answer "what was the state", replay answers "how
 * was it reached".
 *
 * ## Branching
 *
 * {@link recordTransaction} truncates every entry after the cursor before
 * appending: a new mutation after an undo invalidates the redo branch
 * (the plan's explicit criterion), and the recorded log plus base document
 * always re-derive the current state through replay alone.
 */

import { type CadDocument } from "./document";
import { type ParseFailure, type ParseResult, fail, ok } from "./result";
import { type CadTransaction } from "./transaction";

/** One committed transaction and the document snapshot it produced. */
export interface HistoryEntry {
  /** The transaction exactly as applied (a generated-id create stays id-less; replay regenerates). */
  readonly transaction: CadTransaction;
  /** The document after the commit; undo and redo restore these by reference. */
  readonly document: CadDocument;
}

/**
 * The undo/redo model: a base document, the chain of committed entries,
 * and a cursor into it. `cursor` counts how many entries are current
 * (0 = at the base, `entries.length` = at the head); every entry past the
 * cursor is the invalidated redo branch. The invariant
 * `0 <= cursor <= entries.length` holds by construction for histories
 * produced here, and the functions below stay total for any cursor by
 * clamping to the base document.
 */
export interface DocumentHistory {
  readonly base: CadDocument;
  readonly entries: readonly HistoryEntry[];
  readonly cursor: number;
}

/** Stable failure codes produced when a history move is impossible. */
export const HISTORY_ERROR_CODES = {
  nothingToUndo: "history/nothing-to-undo",
  nothingToRedo: "history/nothing-to-redo",
} as const;

export type HistoryErrorCode =
  (typeof HISTORY_ERROR_CODES)[keyof typeof HISTORY_ERROR_CODES];

/** Structured failure describing why an undo or redo was refused. */
export interface HistoryError extends ParseFailure {
  readonly code: HistoryErrorCode;
}

function historyError(
  code: HistoryErrorCode,
  message: string,
  input: unknown,
): HistoryError {
  return { code, message, input };
}

/** Result of an undo or redo: the moved history, the restored document, and the moved transaction. */
export interface HistoryMove {
  readonly history: DocumentHistory;
  readonly document: CadDocument;
  readonly transaction: CadTransaction;
}

/** Starts an empty history over a base document: nothing to undo or redo. */
export function createDocumentHistory(base: CadDocument): DocumentHistory {
  return Object.freeze({
    base,
    entries: Object.freeze([]),
    cursor: 0,
  });
}

/**
 * The document at the cursor: the base document at cursor 0, otherwise the
 * snapshot of the entry the cursor rests on. The restored object is the
 * very snapshot reference, not a copy.
 */
export function currentDocument(history: DocumentHistory): CadDocument {
  const entry = history.cursor > 0
    ? history.entries[history.cursor - 1]
    : undefined;
  return entry === undefined ? history.base : entry.document;
}

/** Whether a transaction can be undone (the cursor is past the base). */
export function canUndo(history: DocumentHistory): boolean {
  return history.cursor > 0;
}

/** Whether a transaction can be redone (entries remain past the cursor). */
export function canRedo(history: DocumentHistory): boolean {
  return history.entries[history.cursor] !== undefined;
}

/**
 * Records an already-applied transaction as the newest commit: the entry
 * keeps the transaction (for replay) and the resulting document (the
 * snapshot undo/redo restore), and every entry after the cursor is
 * discarded — a new mutation after an undo invalidates the redo branch.
 * The caller applies the transaction first ({@link applyTransaction});
 * recording never re-applies anything.
 */
export function recordTransaction(
  history: DocumentHistory,
  transaction: CadTransaction,
  document: CadDocument,
): DocumentHistory {
  const kept = history.entries.slice(0, history.cursor);
  const entries: HistoryEntry[] = [
    ...kept,
    Object.freeze({ transaction, document }),
  ];
  return Object.freeze({
    base: history.base,
    entries: Object.freeze(entries),
    cursor: entries.length,
  });
}

/**
 * Moves back one commit, returning the moved history, the exact prior
 * document (the snapshot at the new cursor — same reference, including the
 * id generator state), and the transaction being undone. Refused with
 * `history/nothing-to-undo` at the base.
 */
export function undoHistory(
  history: DocumentHistory,
): ParseResult<HistoryMove, HistoryError> {
  const previous = history.cursor - 1;
  const entry = previous >= 0 ? history.entries[previous] : undefined;
  if (entry === undefined) {
    return fail(
      historyError(
        HISTORY_ERROR_CODES.nothingToUndo,
        "There is no committed transaction to undo: the history sits at its base document.",
        history.cursor,
      ),
    );
  }
  const moved: DocumentHistory = Object.freeze({
    base: history.base,
    entries: history.entries,
    cursor: previous,
  });
  return ok({
    history: moved,
    document: currentDocument(moved),
    transaction: entry.transaction,
  });
}

/**
 * Moves forward one commit along the remaining branch, restoring the exact
 * snapshot that commit produced (same reference) rather than re-applying —
 * equivalent by determinism, and exact without running anything. Refused
 * with `history/nothing-to-redo` at the head.
 */
export function redoHistory(
  history: DocumentHistory,
): ParseResult<HistoryMove, HistoryError> {
  const entry = history.entries[history.cursor];
  if (entry === undefined) {
    return fail(
      historyError(
        HISTORY_ERROR_CODES.nothingToRedo,
        "There is no transaction to redo: the history sits at its head (or the redo branch was invalidated by a new mutation).",
        history.cursor,
      ),
    );
  }
  const moved: DocumentHistory = Object.freeze({
    base: history.base,
    entries: history.entries,
    cursor: history.cursor + 1,
  });
  return ok({
    history: moved,
    document: entry.document,
    transaction: entry.transaction,
  });
}
