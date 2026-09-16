/**
 * Tool context (Phase 13): the data-and-services object every tool receives.
 * A tool never owns domain state and never mutates it directly — it reads
 * the session and selection through the context and issues its changes back
 * through it, so a tool is portable across hosts (headless test runtime,
 * React fixture, future app shell) and its effects are exactly the
 * operations the host's facade accepted.
 *
 * ## The discipline, spelled out
 *
 * - **Document commands.** {@link ToolContext.issue} applies a
 *   {@link CadTransaction} — an ordered batch of Phase 7 commands — through
 *   the session's atomic commit. Either every command lands (document AND
 *   history advance together) or the failure propagates and nothing
 *   happened. There is no other document path on the context: a tool cannot
 *   touch a body, feature, or parameter except by issuing commands.
 * - **Selection operations.** Selection is Phase 12 session data, not
 *   document data — it has no transaction history — so its operations ride
 *   the same discipline one level up: a tool issues a serializable
 *   {@link ToolSelectionOperation} (pick / clear / hover) and the context
 *   applies it through the pure, immutable Phase 12 operations
 *   (`pickSelection` / `clearSelection` / `hoverSelection`). A structured
 *   failure (e.g. a stale synthetic reference) leaves the state untouched.
 *   The op is data, so a tool's selection behavior is replayable exactly
 *   like its command stream.
 * - **Projection access.** Measurements and arc geometry read the current
 *   {@link RenderProjection} (when the host has one) — read-only.
 *
 * {@link createToolRuntime} is the reference host: a minimal mutable holder
 * of immutable domain state that implements {@link ToolRuntime} and is the
 * entire harness a headless test needs — no DOM, no React, no renderer.
 */

import { type RenderProjection } from "./projection";
import { type ParseResult, ok } from "./result";
import {
  beginRegeneration,
  clearSelection,
  hoverSelection,
  pickSelection,
  type SelectionError,
  type SelectionReference,
  type SelectionState,
} from "./selection";
import { type CadSession, applySessionTransaction } from "./session";
import {
  type CadTransaction,
  type SerializedCadTransaction,
  serializeTransaction,
  type TransactionError,
} from "./transaction";

/**
 * A selection operation issued by a tool, as serializable data. `pick`
 * (single mode replaces, multi mode toggles), `clear`, and `hover` map
 * one-to-one onto the Phase 12 model's operations.
 */
export type ToolSelectionOperation =
  | {
      readonly type: "pick";
      readonly reference: SelectionReference;
      readonly additive: boolean;
    }
  | { readonly type: "clear" }
  | { readonly type: "hover"; readonly reference: SelectionReference | null };

/**
 * The services and read surface a tool receives. Everything is a plain
 * interface — hosts implement it; tools depend only on it.
 */
export interface ToolContext {
  /** Read-only view of the current session (document + history). */
  readonly session: CadSession;
  /** Read-only view of the current selection state. */
  readonly selection: SelectionState;
  /** The render projection for measurements, when the host has one. */
  readonly projection: RenderProjection | null;
  /**
   * Atomically applies a transaction to the host's session. On success the
   * host's session AND history advance together; on failure the session is
   * returned untouched.
   */
  issue(transaction: CadTransaction): ParseResult<CadSession, TransactionError>;
  /**
   * Applies a selection operation through the Phase 12 model. On failure
   * the selection state is returned untouched.
   */
  applySelection(
    operation: ToolSelectionOperation,
  ): ParseResult<SelectionState, SelectionError>;
}

/** Options of {@link createToolRuntime}. */
export interface ToolRuntimeOptions {
  /** The initial session. */
  readonly session: CadSession;
  /** The initial selection state. */
  readonly selection: SelectionState;
  /** The initial render projection, when the host has one. */
  readonly projection?: RenderProjection | null;
  /**
   * Called with the canonical serialization of every transaction that was
   * successfully issued through this runtime, in issue order — the
   * machine-readable command log hosts surface for tests.
   */
  readonly onTransaction?: (transaction: SerializedCadTransaction) => void;
}

/**
 * The reference tool host: a {@link ToolContext} the host can also push
 * state changes into (new projections, history moves, regeneration
 * advances). The runtime is a mutable holder of immutable states — after
 * every accepted operation its `session`/`selection` getters expose the
 * next immutable value.
 */
export interface ToolRuntime extends ToolContext {
  /** Replaces the session (e.g. after a host-driven undo/redo). */
  setSession(session: CadSession): void;
  /** Replaces the projection (e.g. after a regeneration settled). */
  setProjection(projection: RenderProjection | null): void;
  /**
   * Advances the selection state's regeneration identity (the Phase 12
   * transience boundary — synthetic references die, stable ones persist).
   */
  beginSelectionRegeneration(
    regeneration: number,
  ): ParseResult<SelectionState, SelectionError>;
}

/** Creates the reference headless tool runtime. */
export function createToolRuntime(options: ToolRuntimeOptions): ToolRuntime {
  let session: CadSession = options.session;
  let selection: SelectionState = options.selection;
  let projection: RenderProjection | null = options.projection ?? null;
  return {
    get session(): CadSession {
      return session;
    },
    get selection(): SelectionState {
      return selection;
    },
    get projection(): RenderProjection | null {
      return projection;
    },
    issue(
      transaction: CadTransaction,
    ): ParseResult<CadSession, TransactionError> {
      const applied = applySessionTransaction(session, transaction);
      if (applied.ok) {
        session = applied.value;
        options.onTransaction?.(serializeTransaction(transaction));
      }
      return applied;
    },
    applySelection(
      operation: ToolSelectionOperation,
    ): ParseResult<SelectionState, SelectionError> {
      const result =
        operation.type === "pick"
          ? pickSelection(selection, operation.reference, {
              additive: operation.additive,
            })
          : operation.type === "clear"
            ? ok(clearSelection(selection))
            : hoverSelection(selection, operation.reference);
      if (result.ok) {
        selection = result.value;
      }
      return result;
    },
    setSession(next: CadSession): void {
      session = next;
    },
    setProjection(next: RenderProjection | null): void {
      projection = next;
    },
    beginSelectionRegeneration(
      regeneration: number,
    ): ParseResult<SelectionState, SelectionError> {
      const next = beginRegeneration(selection, regeneration);
      if (next.ok) {
        selection = next.value;
      }
      return next;
    },
  };
}
