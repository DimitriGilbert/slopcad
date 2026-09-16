/**
 * Tool contract and manager (Phase 13): the deterministic lifecycle every
 * CAD tool lives in, and the manager that drives exactly one active tool.
 *
 * ## Lifecycle (deterministic, no implicit transitions)
 *
 * The manager's phases are `inactive → active → completed | cancelled`,
 * returning to `inactive` only through an explicit {@link ToolManager.reset}
 * from a terminal phase. Every transition is an explicit call:
 *
 * - {@link ToolManager.activate} is the ONLY way a tool becomes active —
 *   and only from `inactive` (a stale activation attempt from `active`, or
 *   a re-activation from a terminal phase without `reset`, is refused). The
 *   tool begins at its {@link CadTool.initialState}.
 * - {@link ToolManager.dispatch} routes one normalized
 *   {@link ToolInputEvent} to the active tool's reducer — never to any
 *   other tool, and never when no tool is active (a caller error, refused).
 *   A tool completes ONLY by its own explicit decision: its reducer returns
 *   phase `completed`, carrying its completion detail.
 * - {@link ToolManager.cancel} is the ONLY way a live activation ends
 *   without the tool's consent — an explicit host decision (Escape, tool
 *   switch, viewport teardown), never a timeout or an implicit side effect.
 * - {@link ToolManager.reset} retires a terminal phase back to `inactive`.
 *   It refuses while a tool is active (`cancel` first), so a live tool can
 *   never be silently dropped under a reset.
 *
 * Only one tool is active at a time — the manager holds one registry entry
 * as THE active tool, and dispatch is undefined otherwise.
 *
 * ## The atomicity rule (pinned)
 *
 * **A tool's effects on the document are exactly the transactions it issues
 * through its context while its activation is live; every issue is an
 * atomic all-or-nothing session commit; and a cancelled activation issues
 * nothing further.** A tool accumulates in-flight gesture state (a drag's
 * current vector, a first picked point) in its OWN tool state — plain data
 * inside the manager — never in the document, and emits a complete
 * transaction only at an explicit decision point (drag release, second
 * pick). Cancellation stops event delivery to the tool, so the in-flight
 * state is discarded without any partial emission: there is no buffered
 * half-transaction anywhere in this design, and a cancelled tool leaves the
 * document and its history byte-identical. Selection operations issued by
 * an active tool commit immediately through the context (they are session
 * data, not document data — see `tool-context.ts`); like commands, they are
 * whole operations, never fragments.
 */

import type { ToolContext } from "./tool-context";
import type { ToolInputEvent } from "./tool-events";

import { type LengthValue } from "./dimensional";
import { type RenderVector3 } from "./projection";
import { type CadTransaction } from "./transaction";

/** The manager lifecycle phases. */
export const TOOL_MANAGER_PHASES = [
  "inactive",
  "active",
  "completed",
  "cancelled",
] as const;

export type ToolManagerPhase = (typeof TOOL_MANAGER_PHASES)[number];

/**
 * The base every tool state stands on: a `stage` tag naming where the
 * gesture stands, plus plain serializable data. Tool states are plain data
 * so the manager can expose them on machine-readable surfaces and
 * headless tests can assert them exactly.
 */
export interface ToolStateBase {
  readonly stage: string;
}

/** A structured, tool-reported failure (domain codes pass through verbatim). */
export interface ToolFailure {
  readonly code: string;
  readonly message: string;
}

/** Stable failure codes the built-in tools report for tool-level problems. */
export const TOOL_FAILURE_CODES = {
  /** No document target could be resolved for the gesture. */
  targetUnresolved: "tool/target-unresolved",
  /** The gesture was degenerate (zero-length drag, missing world point). */
  degenerateGesture: "tool/degenerate-gesture",
} as const;

export type ToolFailureCode =
  (typeof TOOL_FAILURE_CODES)[keyof typeof TOOL_FAILURE_CODES];

/** Builds a frozen tool failure (tool-level codes and domain passthroughs). */
export function toolFailure(code: string, message: string): ToolFailure {
  return Object.freeze({ code, message });
}

/** What a tool completed with, as data. */
export type ToolCompletionDetail =
  | {
      readonly kind: "measurement";
      /** The measured distance (canonical millimetres). */
      readonly distance: LengthValue;
      readonly from: RenderVector3;
      readonly to: RenderVector3;
    }
  | {
      readonly kind: "commands";
      /** The complete transaction the tool issued at its decision point. */
      readonly transaction: CadTransaction;
      /** Human-readable summary of what the transaction does. */
      readonly summary: string;
    }
  | { readonly kind: "none" };

/** A completed activation: which tool, and what it completed with. */
export interface ToolCompletion {
  readonly toolId: string;
  readonly detail: ToolCompletionDetail;
}

/**
 * A tool reducer's outcome: the next plain-data state, the resulting phase
 * (`active` — keep going — or `completed` — the tool is done), an optional
 * completion detail (required when completing), and an optional structured
 * failure report (the tool stays active; the failure is diagnostic data).
 */
export interface ToolTransition<S extends ToolStateBase> {
  readonly state: S;
  readonly phase: "active" | "completed";
  readonly detail?: ToolCompletionDetail;
  readonly failure?: ToolFailure;
}

/** A CAD tool: an id, a start state, and a pure event reducer. */
export interface CadTool<S extends ToolStateBase> {
  /** The tool's stable id (also its registry key). */
  readonly id: string;
  /** The state an activation begins from. */
  readonly initialState: S;
  /**
   * Consumes one normalized event. The reducer receives the context and
   * issues its commands / selection ops through it — it never mutates
   * domain state directly. Given the same (state, event, context state),
   * the reducer is deterministic.
   */
  onEvent(
    state: S,
    event: ToolInputEvent,
    context: ToolContext,
  ): ToolTransition<S>;
}

/**
 * A tool registered for a manager: the type-erased, fully sound entry the
 * manager drives (the generic tool state never leaks — the entry owns a
 * closed cell of it). Create with {@link registerTool}; one entry belongs
 * to exactly one manager.
 */
export interface ToolRegistryEntry {
  readonly id: string;
  /** Resets the entry's state cell to the tool's initial state. */
  begin(): void;
  /** The entry's current state (covariant read). */
  readonly state: ToolStateBase;
  onEvent(
    event: ToolInputEvent,
    context: ToolContext,
  ): ToolTransition<ToolStateBase>;
}

/** Validates a tool id: 1-64 chars, letter first, then letters/digits/._-. */
function validateToolId(id: string): string {
  if (!/^[A-Za-z][A-Za-z0-9._-]{0,63}$/.test(id)) {
    throw new RangeError(
      `A tool id must be 1-64 characters, start with a letter, and use only letters, digits, dots, underscores, and hyphens, received "${id}".`,
    );
  }
  return id;
}

/**
 * Registers a typed tool as a sound, type-erased manager entry. The state
 * cell is closed over with its concrete type, so the manager never casts.
 */
export function registerTool<S extends ToolStateBase>(
  tool: CadTool<S>,
): ToolRegistryEntry {
  validateToolId(tool.id);
  let current: S = tool.initialState;
  return {
    id: tool.id,
    begin(): void {
      current = tool.initialState;
    },
    get state(): ToolStateBase {
      return current;
    },
    onEvent(
      event: ToolInputEvent,
      context: ToolContext,
    ): ToolTransition<ToolStateBase> {
      const transition = tool.onEvent(current, event, context);
      current = transition.state;
      return transition;
    },
  };
}

/** Options of {@link createToolManager}. */
export interface ToolManagerOptions {
  /** The registry entries (built with {@link registerTool}); ids unique. */
  readonly tools: readonly ToolRegistryEntry[];
  /** The context every active tool receives with every event. */
  readonly context: ToolContext;
}

/** The tool manager: deterministic lifecycle over exactly one active tool. */
export interface ToolManager {
  /** The current lifecycle phase. */
  readonly phase: ToolManagerPhase;
  /** The tool of the current or last activation, or `null` when inactive. */
  readonly toolId: string | null;
  /** The active tool's live state; frozen at its final value when terminal. */
  readonly toolState: ToolStateBase | null;
  /** Non-null exactly when the phase is `completed`. */
  readonly completion: ToolCompletion | null;
  /** The last structured failure the active tool reported, if any. */
  readonly failure: ToolFailure | null;
  /** Activates a tool from the `inactive` phase. */
  activate(toolId: string): void;
  /** Routes one normalized event to the active tool. */
  dispatch(event: ToolInputEvent): void;
  /** Cancels the live activation (explicit host decision). */
  cancel(): void;
  /** Retires a terminal (`completed`/`cancelled`) or already-`inactive` phase. */
  reset(): void;
}

/**
 * Creates a tool manager over the given registry entries and context.
 * Lifecycle misuse (activating while active, dispatching while inactive,
 * …) is a caller bug and throws a `RangeError` naming the phase — the
 * data-level integrity of documents and events is handled with structured
 * failures elsewhere; the lifecycle is code, not data.
 */
export function createToolManager(options: ToolManagerOptions): ToolManager {
  const registry = new Map<string, ToolRegistryEntry>();
  for (const entry of options.tools) {
    validateToolId(entry.id);
    if (registry.has(entry.id)) {
      throw new RangeError(
        `A tool manager registry carries the tool id "${entry.id}" twice.`,
      );
    }
    registry.set(entry.id, entry);
  }
  const context = options.context;

  let phase: ToolManagerPhase = "inactive";
  let active: ToolRegistryEntry | null = null;
  let toolId: string | null = null;
  let completion: ToolCompletion | null = null;
  let failure: ToolFailure | null = null;

  function requireInactive(operation: string): void {
    if (phase !== "inactive") {
      throw new RangeError(
        `A tool cannot be activated from the "${phase}" phase (${operation}); only the "inactive" phase activates a tool.`,
      );
    }
  }

  return {
    get phase(): ToolManagerPhase {
      return phase;
    },
    get toolId(): string | null {
      return toolId;
    },
    get toolState(): ToolStateBase | null {
      return active === null ? null : active.state;
    },
    get completion(): ToolCompletion | null {
      return completion;
    },
    get failure(): ToolFailure | null {
      return failure;
    },
    activate(next: string): void {
      requireInactive("activate");
      const entry = registry.get(next);
      if (entry === undefined) {
        throw new RangeError(
          `No tool "${next}" is registered; registered tools: ${[...registry.keys()].join(", ") || "none"}.`,
        );
      }
      entry.begin();
      active = entry;
      toolId = next;
      phase = "active";
      completion = null;
      failure = null;
    },
    dispatch(event: ToolInputEvent): void {
      if (phase !== "active" || active === null) {
        throw new RangeError(
          `A tool event can only be dispatched while a tool is active, received phase "${phase}".`,
        );
      }
      const transition = active.onEvent(event, context);
      if (transition.failure !== undefined) {
        failure = transition.failure;
      }
      if (transition.phase === "completed") {
        if (transition.detail === undefined) {
          throw new RangeError(
            `Invariant violation: the tool "${String(toolId)}" completed without a completion detail.`,
          );
        }
        completion = { toolId: active.id, detail: transition.detail };
        phase = "completed";
        return;
      }
    },
    cancel(): void {
      if (phase !== "active" || active === null) {
        throw new RangeError(
          `Only a live activation can be cancelled, received phase "${phase}".`,
        );
      }
      phase = "cancelled";
    },
    reset(): void {
      if (phase === "active") {
        throw new RangeError(
          'A tool cannot be reset while it is active; cancel it first ("cancelled" is a terminal phase).',
        );
      }
      active = null;
      toolId = null;
      phase = "inactive";
      completion = null;
      failure = null;
    },
  };
}
