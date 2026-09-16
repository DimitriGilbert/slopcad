/**
 * The CAD store (Phase 14): the React-free hub of `@slopcad/cad-react` —
 * a runtime composition of the CAD domain instances a host supplies
 * (session, selection state, tool registry) plus the scoped notification
 * model the React hooks subscribe to.
 *
 * ## The canonicality rule (pinned, enforced structurally)
 *
 * **The domain is canonical; React only mirrors it.** The store never holds
 * authoritative state of its own: every read is a domain value (the
 * immutable {@link CadSession}, {@link SelectionState}, tool-manager
 * surface), and every mutation is a domain operation — transactions through
 * the session commit, selection operations through the Phase 12 model,
 * history moves through the session's undo/redo, lifecycle ops through the
 * tool manager. There is no `setState` path into the domain: no method
 * accepts partial domain state, no React state value ever flows back in, and
 * the raw tool manager stays private so every lifecycle change rides a
 * store operation (and therefore a notification). Hosts that replace the
 * whole session (document load, external undo) must go through
 * {@link CadStore.replaceSession} — the one explicit whole-session door.
 *
 * ## Notification model
 *
 * Consumers subscribe per **concern** and the store diffs domain identity
 * after every operation: a concern's listeners fire only when the domain
 * value that concern mirrors changed (reference identity — domain values
 * are immutable and frozen). The concerns:
 *
 * - `document` — the session's document identity changed (commit, undo,
 *   redo, replace). Fires before `parameters` and `history`.
 * - `parameters` — the document's {@link ParameterCollection} identity
 *   changed (a subset of `document` changes).
 * - `history` — the history cursor or entry count changed.
 * - `selection` — the selection state identity changed (picks, hovers,
 *   regeneration advances — including ones issued by the ACTIVE TOOL through
 *   its context).
 * - `tools` — the tool manager's observable surface changed (phase, active
 *   id, tool state, completion, failure).
 *
 * The React hooks pair each concern with `useSyncExternalStore`, whose
 * snapshot identity check is a second, redundant safety net over the same
 * immutability — a selection change therefore cannot re-render a
 * document-only subscriber.
 *
 * {@link createCadStore} is the documented factory: it composes the
 * consumer-supplied domain instances into the cad-core reference
 * {@link ToolRuntime} host and {@link ToolManager} — it never invents
 * domain state.
 */

import {
  canRedo,
  canUndo,
  createSelectionState,
  createToolManager,
  createToolRuntime,
  redoSession,
  undoSession,
  type CadCommand,
  type CadDocument,
  type CadSession,
  type CadTransaction,
  type ParameterCollection,
  type RenderProjection,
  type SelectionReference,
  type SelectionState,
  type SerializedCadTransaction,
  type ToolCompletion,
  type ToolFailure,
  type ToolInputEvent,
  type ToolManager,
  type ToolManagerPhase,
  type ToolRegistryEntry,
  type ToolRuntime,
  type ToolSelectionOperation,
  type ToolStateBase,
} from "@slopcad/cad-core";

/** A concern a consumer (or hook) can subscribe to. */
export type CadStoreConcern =
  | "document"
  | "parameters"
  | "history"
  | "selection"
  | "tools";

/** All concerns, in emission order within one sync pass. */
export const CAD_STORE_CONCERNS: readonly CadStoreConcern[] = [
  "document",
  "parameters",
  "history",
  "selection",
  "tools",
];

/** The immutable history view the `history` concern mirrors. */
export interface CadHistoryView {
  /** Whether an undo move is available (the cursor is past the base). */
  readonly canUndo: boolean;
  /** Whether a redo move is available (entries remain past the cursor). */
  readonly canRedo: boolean;
  /** The history cursor (committed entries that are current). */
  readonly cursor: number;
  /** The total number of committed entries. */
  readonly depth: number;
}

/** The observable tool-manager surface the `tools` concern mirrors. */
export interface CadToolSurface {
  /** The manager lifecycle phase. */
  readonly phase: ToolManagerPhase;
  /** The tool of the current or last activation, or `null`. */
  readonly activeToolId: string | null;
  /** The active tool's live state; frozen at its final value when terminal. */
  readonly toolState: ToolStateBase | null;
  /** Non-null exactly when the phase is `completed`. */
  readonly completion: ToolCompletion | null;
  /** The last structured failure the active tool reported, if any. */
  readonly failure: ToolFailure | null;
}

/** Options of {@link createCadStore}. */
export interface CadStoreOptions {
  /** The initial session (document + history). Consumer-supplied. */
  readonly session: CadSession;
  /** The initial selection state. Defaults to an empty state at regeneration 0. */
  readonly selection?: SelectionState;
  /** The initial render projection (tool read access). Defaults to `null`. */
  readonly projection?: RenderProjection | null;
  /** The tool registry entries. Defaults to an empty registry. */
  readonly tools?: readonly ToolRegistryEntry[];
  /**
   * Called with the canonical serialization of every transaction that was
   * successfully issued through this store's runtime, in issue order — the
   * machine-readable command log hosts surface for tests. Undo/redo are
   * history moves, not issues, and add no entries.
   */
  readonly onTransaction?: (transaction: SerializedCadTransaction) => void;
}

type Listener = () => void;

/**
 * Runtime guard for a session-shaped value at the replaceSession door —
 * the same smuggled-input discipline cad-core applies to serialized
 * transactions. Structural only: it checks the domain's two fields, never
 * their content (the domain validated that already).
 */
function isSessionShaped(value: unknown): value is CadSession {
  if (typeof value !== "object" || value === null) return false;
  const candidate: { document?: unknown; history?: unknown } = value;
  return (
    typeof candidate.document === "object" &&
    candidate.document !== null &&
    typeof candidate.history === "object" &&
    candidate.history !== null
  );
}

function sameHistoryView(a: CadHistoryView, b: CadHistoryView): boolean {
  return (
    a.canUndo === b.canUndo &&
    a.canRedo === b.canRedo &&
    a.cursor === b.cursor &&
    a.depth === b.depth
  );
}

function sameToolSurface(a: CadToolSurface, b: CadToolSurface): boolean {
  return (
    a.phase === b.phase &&
    a.activeToolId === b.activeToolId &&
    a.toolState === b.toolState &&
    a.completion === b.completion &&
    a.failure === b.failure
  );
}

/**
 * The CAD store: the runtime composition plus scoped subscriptions. All
 * operations are stable arrow-function fields, so hooks can return them as
 * event handlers without rebinding. Every mutating operation applies the
 * domain change first and diffs/notifies concerns afterwards.
 */
export class CadStore {
  private readonly runtime: ToolRuntime;

  private readonly manager: ToolManager;

  private readonly toolIdsValue: readonly string[];

  private readonly onTransaction?: (transaction: SerializedCadTransaction) => void;

  private readonly listeners: ReadonlyMap<CadStoreConcern, Set<Listener>>;

  /** The last value each concern's listeners were notified of. */
  private readonly mirrored: {
    document: CadDocument;
    parameters: ParameterCollection;
    history: CadHistoryView;
    selection: SelectionState;
    tools: CadToolSurface;
  };

  private commandLogEntries: readonly SerializedCadTransaction[] = Object.freeze(
    [],
  );

  constructor(options: CadStoreOptions) {
    this.onTransaction = options.onTransaction;
    this.runtime = createToolRuntime({
      session: options.session,
      selection: options.selection ?? createSelectionState(0),
      projection: options.projection ?? null,
      onTransaction: (transaction) => {
        this.commandLogEntries = Object.freeze([
          ...this.commandLogEntries,
          transaction,
        ]);
        this.onTransaction?.(transaction);
      },
    });
    const entries = options.tools ?? [];
    this.manager = createToolManager({ tools: entries, context: this.runtime });
    this.toolIdsValue = Object.freeze(entries.map((entry) => entry.id));
    const session = this.runtime.session;
    this.listeners = new Map(
      CAD_STORE_CONCERNS.map((concern) => [concern, new Set<Listener>()]),
    );
    this.mirrored = {
      document: session.document,
      parameters: session.document.parameters,
      history: this.computeHistoryView(),
      selection: this.runtime.selection,
      tools: this.computeToolSurface(),
    };
  }

  // -------------------------------------------------------------------------
  // Reads (stable snapshots for useSyncExternalStore)
  // -------------------------------------------------------------------------

  /** The current session (document + history). Immutable domain value. */
  readonly getSession = (): CadSession => this.runtime.session;

  /** The current document. Immutable domain value. */
  readonly getDocument = (): CadDocument => this.runtime.session.document;

  /** The current parameter collection. Immutable domain value. */
  readonly getParameters = (): ParameterCollection =>
    this.runtime.session.document.parameters;

  /** The current selection state. Immutable domain value. */
  readonly getSelection = (): SelectionState => this.runtime.selection;

  /** The cached history view. Identity-stable until history changes. */
  readonly getHistoryView = (): CadHistoryView => this.mirrored.history;

  /** The cached tool surface. Identity-stable until the manager changes. */
  readonly getToolSurface = (): CadToolSurface => this.mirrored.tools;

  /** The static tool registry ids (registry membership never changes). */
  get toolIds(): readonly string[] {
    return this.toolIdsValue;
  }

  /** The canonical serializations of every issued transaction, in order. */
  get commandLog(): readonly SerializedCadTransaction[] {
    return this.commandLogEntries;
  }

  // -------------------------------------------------------------------------
  // Document mutations (the ONLY write paths — data in, domain decides)
  // -------------------------------------------------------------------------

  /**
   * Applies a transaction atomically through the session commit. On failure
   * nothing changed (and nothing notified — the identity diff finds no
   * change).
   */
  readonly applyTransaction = (
    transaction: CadTransaction,
  ): ReturnType<ToolRuntime["issue"]> => {
    const applied = this.runtime.issue(transaction);
    this.sync();
    return applied;
  };

  /** Applies one command as a one-command transaction. */
  readonly applyCommand = (
    command: CadCommand,
  ): ReturnType<ToolRuntime["issue"]> =>
    this.applyTransaction({ commands: [command] });

  /**
   * Moves history back one commit. Refused with the domain's
   * `history/nothing-to-undo` at the base.
   */
  readonly undo = (): ReturnType<typeof undoSession> => {
    const moved = undoSession(this.runtime.session);
    if (moved.ok) this.runtime.setSession(moved.value);
    this.sync();
    return moved;
  };

  /**
   * Moves history forward one commit. Refused with the domain's
   * `history/nothing-to-redo` at the head (or after an invalidating commit).
   */
  readonly redo = (): ReturnType<typeof redoSession> => {
    const moved = redoSession(this.runtime.session);
    if (moved.ok) this.runtime.setSession(moved.value);
    this.sync();
    return moved;
  };

  /**
   * Replaces the whole session — the one explicit door for host-driven
   * whole-document changes (document load, external undo engines). Not a
   * partial-state write: the input is a complete, immutable domain value.
   * The door is guarded: anything that is not a session-shaped value (e.g.
   * mirrored document or selection state smuggled past the compiler) is
   * refused with a `RangeError` — the domain changes through operations,
   * never through state feeds.
   */
  readonly replaceSession = (session: CadSession): void => {
    if (!isSessionShaped(session)) {
      throw new RangeError(
        "replaceSession accepts a CadSession only: the input must carry the domain's document and history. Feeding mirrored state (a bare document, a selection state) back into the domain is not a store operation.",
      );
    }
    this.runtime.setSession(session);
    this.sync();
  };

  // -------------------------------------------------------------------------
  // Selection mutations (Phase 12 operations — data in, domain decides)
  // -------------------------------------------------------------------------

  /** Applies a selection operation (pick / clear / hover). */
  readonly applySelection = (
    operation: ToolSelectionOperation,
  ): ReturnType<ToolRuntime["applySelection"]> => {
    const applied = this.runtime.applySelection(operation);
    this.sync();
    return applied;
  };

  /** Picks a reference (single mode replaces, multi mode toggles). */
  readonly pick = (
    reference: SelectionReference,
    additive: boolean,
  ): ReturnType<ToolRuntime["applySelection"]> =>
    this.applySelection({ type: "pick", reference, additive });

  /** Sets the hover (pointer feedback; never touches the selection). */
  readonly hover = (
    reference: SelectionReference | null,
  ): ReturnType<ToolRuntime["applySelection"]> =>
    this.applySelection({ type: "hover", reference });

  /** Clears the selection. The hover is left untouched (domain semantics). */
  readonly clearSelection = (): SelectionState => {
    this.runtime.applySelection({ type: "clear" });
    this.sync();
    return this.runtime.selection;
  };

  /**
   * Advances the selection state's regeneration identity — synthetic
   * references die with the old regeneration, stable ones persist.
   */
  readonly beginSelectionRegeneration = (
    regeneration: number,
  ): ReturnType<ToolRuntime["beginSelectionRegeneration"]> => {
    const advanced = this.runtime.beginSelectionRegeneration(regeneration);
    this.sync();
    return advanced;
  };

  // -------------------------------------------------------------------------
  // Projection push (host-side state; a tool read, never a mirrored concern)
  // -------------------------------------------------------------------------

  /** Replaces the projection the active tool can read. */
  readonly setProjection = (projection: RenderProjection | null): void => {
    this.runtime.setProjection(projection);
  };

  // -------------------------------------------------------------------------
  // Tool lifecycle ops (the raw manager stays private — every change notifies)
  // -------------------------------------------------------------------------

  /** Activates a tool. Only legal from the `inactive` phase (domain rule). */
  readonly activateTool = (toolId: string): void => {
    this.manager.activate(toolId);
    this.sync();
  };

  /**
   * The host's explicit re-arm composition: cancel-if-active, reset,
   * activate — three domain lifecycle ops in the documented order, so a
   * host can switch tools from any phase without hand-rolling the dance.
   */
  readonly armTool = (toolId: string): void => {
    if (this.manager.phase === "active") this.manager.cancel();
    this.manager.reset();
    this.manager.activate(toolId);
    this.sync();
  };

  /**
   * Cancels the live activation. Idempotent host convenience: returns
   * whether a live activation was actually cancelled (the domain refuses
   * terminal-phase cancels, so the store guards instead of throwing).
   */
  readonly cancelTool = (): boolean => {
    if (this.manager.phase !== "active") return false;
    this.manager.cancel();
    this.sync();
    return true;
  };

  /** Retires a terminal phase back to `inactive` (domain rule applies). */
  readonly resetTool = (): void => {
    this.manager.reset();
    this.sync();
  };

  /** Dispatches one normalized event to the active tool (domain rule applies). */
  readonly dispatchToolEvent = (event: ToolInputEvent): void => {
    this.manager.dispatch(event);
    this.sync();
  };

  // -------------------------------------------------------------------------
  // Subscriptions (per concern; returns the unsubscribe function)
  // -------------------------------------------------------------------------

  readonly subscribeDocument = (listener: Listener): (() => void) =>
    this.subscribe("document", listener);

  readonly subscribeParameters = (listener: Listener): (() => void) =>
    this.subscribe("parameters", listener);

  readonly subscribeHistory = (listener: Listener): (() => void) =>
    this.subscribe("history", listener);

  readonly subscribeSelection = (listener: Listener): (() => void) =>
    this.subscribe("selection", listener);

  readonly subscribeTools = (listener: Listener): (() => void) =>
    this.subscribe("tools", listener);

  private subscribe(concern: CadStoreConcern, listener: Listener): () => void {
    const set = this.listeners.get(concern);
    if (set === undefined) {
      throw new RangeError(`Unknown CAD store concern "${concern}".`);
    }
    set.add(listener);
    return () => {
      set.delete(listener);
    };
  }

  // -------------------------------------------------------------------------
  // The sync pass: diff domain identity, notify changed concerns in order
  // -------------------------------------------------------------------------

  private computeHistoryView(): CadHistoryView {
    const history = this.runtime.session.history;
    return Object.freeze({
      canUndo: canUndo(history),
      canRedo: canRedo(history),
      cursor: history.cursor,
      depth: history.entries.length,
    });
  }

  private computeToolSurface(): CadToolSurface {
    return Object.freeze({
      phase: this.manager.phase,
      activeToolId: this.manager.toolId,
      toolState: this.manager.toolState,
      completion: this.manager.completion,
      failure: this.manager.failure,
    });
  }

  private emit(concern: CadStoreConcern): void {
    const set = this.listeners.get(concern);
    if (set === undefined) return;
    for (const listener of [...set]) listener();
  }

  private sync(): void {
    const session = this.runtime.session;
    if (session.document !== this.mirrored.document) {
      this.mirrored.document = session.document;
      this.emit("document");
      if (session.document.parameters !== this.mirrored.parameters) {
        this.mirrored.parameters = session.document.parameters;
        this.emit("parameters");
      }
      const history = this.computeHistoryView();
      if (!sameHistoryView(history, this.mirrored.history)) {
        this.mirrored.history = history;
        this.emit("history");
      }
    }
    if (this.runtime.selection !== this.mirrored.selection) {
      this.mirrored.selection = this.runtime.selection;
      this.emit("selection");
    }
    const tools = this.computeToolSurface();
    if (!sameToolSurface(tools, this.mirrored.tools)) {
      this.mirrored.tools = tools;
      this.emit("tools");
    }
  }
}

/** Creates the store over consumer-supplied domain instances. */
export function createCadStore(options: CadStoreOptions): CadStore {
  return new CadStore(options);
}
