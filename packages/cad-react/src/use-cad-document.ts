/**
 * `useCadDocument` (Phase 14): the document hook. Mirrors the session's
 * document (and the session itself) through the `document` concern and
 * exposes the transactional mutation surface — commands and transactions
 * only, applied through the store's session commit. There is no API here
 * that accepts document state: the domain changes exclusively through the
 * Phase 7 command vocabulary, and the returned document is an immutable
 * domain value.
 *
 * Notification model: re-renders exactly when the document identity
 * changes (commit, undo, redo, session replace) — never on selection,
 * hover, or tool lifecycle changes.
 */

import { useSyncExternalStore } from "react";
import type { CadStore } from "./store";

import { useCadStore } from "./provider";

/** What {@link useCadDocument} exposes. */
export interface CadDocumentApi {
  /** The current document (immutable domain value). */
  readonly document: ReturnType<CadStore["getDocument"]>;
  /** The current session (document + history). */
  readonly session: ReturnType<CadStore["getSession"]>;
  /**
   * Applies a transaction atomically through the session commit; on
   * failure the input is returned untouched by the domain and nothing
   * notifies.
   */
  readonly applyTransaction: CadStore["applyTransaction"];
  /** Applies one command as a one-command transaction. */
  readonly applyCommand: CadStore["applyCommand"];
}

/** Subscribes to the `document` concern and mirrors the current document. */
export function useCadDocument(): CadDocumentApi {
  const store = useCadStore("useCadDocument");
  const document = useSyncExternalStore(
    store.subscribeDocument,
    store.getDocument,
    // The store is headless-safe: the same immutable domain value serves as
    // the server snapshot (the store exists during SSR and reads the domain).
    store.getDocument,
  );
  return {
    document,
    session: store.getSession(),
    applyTransaction: store.applyTransaction,
    applyCommand: store.applyCommand,
  };
}
