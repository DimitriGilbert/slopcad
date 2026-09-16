/**
 * `useCadHistory` (Phase 14): the history hook. Mirrors the session
 * history's availability view through the `history` concern and exposes
 * the two history moves — undo and redo — as store operations through the
 * session's own functions.
 *
 * Notification model: re-renders exactly when the history cursor or entry
 * count changes (commit, undo, redo). A transaction that fails
 * validation changes neither and notifies nothing; the document hook
 * mirrors the documents themselves.
 */

import { useSyncExternalStore } from "react";
import type { CadSession, HistoryError, ParseResult } from "@slopcad/cad-core";

import { useCadStore } from "./provider";

/** What {@link useCadHistory} exposes. */
export interface CadHistoryApi {
  /** Whether an undo move is available. */
  readonly canUndo: boolean;
  /** Whether a redo move is available. */
  readonly canRedo: boolean;
  /** The history cursor (committed entries that are current). */
  readonly cursor: number;
  /** The total number of committed entries. */
  readonly depth: number;
  /** Moves back one commit; refused structurally at the base. */
  readonly undo: () => ParseResult<CadSession, HistoryError>;
  /** Moves forward one commit; refused structurally at the head. */
  readonly redo: () => ParseResult<CadSession, HistoryError>;
}

/** Subscribes to the `history` concern and mirrors the availability view. */
export function useCadHistory(): CadHistoryApi {
  const store = useCadStore("useCadHistory");
  const view = useSyncExternalStore(
    store.subscribeHistory,
    store.getHistoryView,
    // Server snapshot: the same getter — the store runs headless (see
    // use-cad-document.ts).
    store.getHistoryView,
  );
  return {
    canUndo: view.canUndo,
    canRedo: view.canRedo,
    cursor: view.cursor,
    depth: view.depth,
    undo: store.undo,
    redo: store.redo,
  };
}
