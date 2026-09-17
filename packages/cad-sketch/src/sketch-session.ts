/**
 * Sketch session (Phase 25): a sketch composed with its undo/redo history —
 * the cad-core Phase 7 session/history discipline applied to the Phase 25
 * sketch command vocabulary, so every sketch edit the browser makes rides
 * the same atomic-transaction-and-snapshot model as document edits.
 *
 * ## Mechanism: snapshots, not inverse commands (the Phase 7 decision, restated)
 *
 * {@link SketchHistory} holds committed transactions, each with the exact
 * sketch snapshot it produced, and a cursor. Undo and redo move the cursor
 * and restore the snapshot at it — exact by construction because sketches
 * are immutable values, so snapshots share structure and cost nothing to
 * hold or restore. Command-log replay stays consistent without duplicated
 * semantics: replaying a log re-applies the recorded commands through the
 * one interpreter ({@link applySketchTransaction}) onto the base sketch and
 * lands on serialization-identical states, because command application is a
 * pure deterministic function of (sketch, command). Committing after an undo
 * truncates the invalidated redo branch before appending.
 *
 * ## Last-known-good geometry (the Phase 20 discipline, mirrored)
 *
 * The session holds the AUTHORED sketch — what the user drew and
 * constrained. Solved geometry is derived state and deliberately lives
 * elsewhere (the host derives it per edit): a solve that fails with
 * conflicting/unsatisfiable diagnostics never corrupts the session, whose
 * history keeps describing exactly what was authored; the host retains the
 * last successful solve's geometry for display and surfaces the structured
 * diagnostics beside it. Undo/redo move the authored state and re-derive.
 */

import { type ParseResult, ok } from "@slopcad/cad-core";
import type { Sketch } from "./sketch";

import {
  applySketchTransaction,
  SKETCH_COMMAND_ERROR_CODES,
  type SketchCommandError,
  type SketchTransaction,
} from "./commands";

/** One committed transaction and the sketch snapshot it produced. */
export interface SketchHistoryEntry {
  /** The transaction exactly as applied. */
  readonly transaction: SketchTransaction;
  /** The sketch after the commit; undo and redo restore these by reference. */
  readonly sketch: Sketch;
}

/**
 * The sketch undo/redo model: a base sketch, the chain of committed
 * entries, and a cursor into it (`0` = at the base; every entry past the
 * cursor is the invalidated redo branch). The invariant
 * `0 <= cursor <= entries.length` holds by construction.
 */
export interface SketchHistory {
  readonly base: Sketch;
  readonly entries: readonly SketchHistoryEntry[];
  readonly cursor: number;
}

/** A sketch plus the undo/redo history of the commands applied to it. */
export interface SketchSession {
  /** The sketch at the history cursor. */
  readonly sketch: Sketch;
  /** Committed transactions, with the cursor marking the current position. */
  readonly history: SketchHistory;
}

/** Starts a session over a base sketch with an empty history. */
export function createSketchSession(base: Sketch): SketchSession {
  return Object.freeze({
    sketch: base,
    history: Object.freeze({ base, entries: Object.freeze([]), cursor: 0 }),
  });
}

/** Whether a transaction can be undone (the cursor is past the base). */
export function canUndoSketch(session: SketchSession): boolean {
  return session.history.cursor > 0;
}

/** Whether a transaction can be redone (entries remain past the cursor). */
export function canRedoSketch(session: SketchSession): boolean {
  return session.history.entries[session.history.cursor] !== undefined;
}

/**
 * Applies a transaction atomically and records it as one history entry. The
 * commands run in order through the single command interpreter; on any
 * failure the input session is returned from untouched (the failed
 * transaction never happened). Committing discards any redo branch that an
 * earlier undo had left.
 */
export function applySketchSessionTransaction(
  session: SketchSession,
  transaction: SketchTransaction,
): ParseResult<SketchSession, SketchCommandError> {
  const applied = applySketchTransaction(session.sketch, transaction);
  if (!applied.ok) return applied;
  const kept = session.history.entries.slice(0, session.history.cursor);
  const entries: SketchHistoryEntry[] = [
    ...kept,
    Object.freeze({ transaction, sketch: applied.value }),
  ];
  return ok(
    Object.freeze({
      sketch: applied.value,
      history: Object.freeze({
        base: session.history.base,
        entries: Object.freeze(entries),
        cursor: entries.length,
      }),
    }),
  );
}

/** The result of a sketch undo or redo move. */
export interface SketchHistoryMove {
  readonly session: SketchSession;
  /** The transaction being undone or redone. */
  readonly transaction: SketchTransaction;
}

function moveCursor(session: SketchSession, cursor: number): SketchSession {
  const entry =
    cursor > 0 ? session.history.entries[cursor - 1] : undefined;
  return Object.freeze({
    sketch: entry === undefined ? session.history.base : entry.sketch,
    history: Object.freeze({
      base: session.history.base,
      entries: session.history.entries,
      cursor,
    }),
  });
}

/**
 * Restores the exact previous sketch (the snapshot, by reference) and moves
 * the history cursor back one commit. Refused with
 * `sketch-command/nothing-to-undo` at the base.
 */
export function undoSketchSession(
  session: SketchSession,
): ParseResult<SketchHistoryMove, SketchCommandError> {
  const previous = session.history.cursor - 1;
  const entry = session.history.entries[previous];
  if (entry === undefined || previous < 0) {
    return {
      ok: false,
      error: {
        code: SKETCH_COMMAND_ERROR_CODES.nothingToUndo,
        message:
          "There is no committed transaction to undo: the sketch history sits at its base sketch.",
        input: session.history.cursor,
      },
    };
  }
  return ok({ session: moveCursor(session, previous), transaction: entry.transaction });
}

/**
 * Restores the exact next sketch along the remaining branch and moves the
 * history cursor forward one commit. Refused with
 * `sketch-command/nothing-to-redo` at the head (or after a new commit
 * invalidated the branch).
 */
export function redoSketchSession(
  session: SketchSession,
): ParseResult<SketchHistoryMove, SketchCommandError> {
  const entry = session.history.entries[session.history.cursor];
  if (entry === undefined) {
    return {
      ok: false,
      error: {
        code: SKETCH_COMMAND_ERROR_CODES.nothingToRedo,
        message:
          "There is no committed transaction to redo: the sketch history sits at its head (or the redo branch was invalidated by a new commit).",
        input: session.history.cursor,
      },
    };
  }
  return ok({
    session: moveCursor(session, session.history.cursor + 1),
    transaction: entry.transaction,
  });
}
