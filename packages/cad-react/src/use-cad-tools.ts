/**
 * `useCadTools` (Phase 14): the tool hook. Mirrors the tool manager's
 * observable surface through the `tools` concern and exposes the
 * lifecycle operations — activate, the re-arm composition, cancel, reset,
 * dispatch — as store operations over the domain manager (which stays
 * private: every lifecycle change rides a store operation and therefore a
 * notification, so hooks can never miss a tool-driven transaction or
 * selection op).
 *
 * The manager's own misuse contract is preserved verbatim: `activate` only
 * from `inactive`, `dispatch` only while `active`, `reset` never while
 * `active` — violations throw the domain's `RangeError` (a caller bug, not
 * data). `arm` composes the documented host dance (cancel-if-active, reset,
 * activate) and `cancel` is the guarded, idempotent variant returning
 * whether a live activation was cancelled.
 *
 * Notification model: re-renders exactly when the manager surface changes
 * (phase, active id, tool state, completion, failure) — never on document
 * or selection changes.
 */

import { useSyncExternalStore } from "react";
import type { ToolInputEvent } from "@slopcad/cad-core";
import type { CadToolSurface } from "./store";

import { useCadStore } from "./provider";

/** What {@link useCadTools} exposes. */
export interface CadToolsApi {
  /** The registered tool ids (registry membership is static). */
  readonly toolIds: readonly string[];
  /** The manager lifecycle phase. */
  readonly phase: CadToolSurface["phase"];
  /** The tool of the current or last activation, or `null`. */
  readonly activeToolId: CadToolSurface["activeToolId"];
  /** The active tool's live state; frozen at its final value when terminal. */
  readonly toolState: CadToolSurface["toolState"];
  /** Non-null exactly when the phase is `completed`. */
  readonly completion: CadToolSurface["completion"];
  /** The last structured failure the active tool reported, if any. */
  readonly failure: CadToolSurface["failure"];
  /** Activates a tool; only legal from the `inactive` phase (domain rule). */
  readonly activate: (toolId: string) => void;
  /** Re-arms from any phase: cancel-if-active, reset, activate. */
  readonly arm: (toolId: string) => void;
  /** Cancels the live activation; returns whether one was cancelled. */
  readonly cancel: () => boolean;
  /** Retires a terminal phase back to `inactive` (domain rule applies). */
  readonly reset: () => void;
  /** Dispatches one normalized event to the active tool (domain rule applies). */
  readonly dispatch: (event: ToolInputEvent) => void;
}

/** Subscribes to the `tools` concern and mirrors the manager surface. */
export function useCadTools(): CadToolsApi {
  const store = useCadStore("useCadTools");
  const surface = useSyncExternalStore(
    store.subscribeTools,
    store.getToolSurface,
    // Server snapshot: the same getter — the store runs headless (see
    // use-cad-document.ts).
    store.getToolSurface,
  );
  return {
    toolIds: store.toolIds,
    phase: surface.phase,
    activeToolId: surface.activeToolId,
    toolState: surface.toolState,
    completion: surface.completion,
    failure: surface.failure,
    activate: store.activateTool,
    arm: store.armTool,
    cancel: store.cancelTool,
    reset: store.resetTool,
    dispatch: store.dispatchToolEvent,
  };
}
