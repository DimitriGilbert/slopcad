/**
 * The agent chat view state (PLAN-AGENT-CHAT Phase 4.4, D16): which of the
 * two right-sidebar views is active — the sidebar's panels (properties,
 * vars, …) or the agent chat that replaces them while active. The state is
 * owned HERE so the Phase 4.5 mount point and the palette commands share
 * ONE source; neither re-derives it.
 *
 * Persistence follows the workbench's sibling panel-state idiom (the
 * first-run sketch hint): the choice persists per browser under one
 * namespaced key, reads tolerate stripped or corrupt storage (falling
 * back to the sidebar view), and the React hook applies the stored value
 * AFTER hydration in an effect — the first render never depends on
 * storage, so server and client markup agree.
 */

import { useCallback, useEffect, useState } from "react";

/** Which right-sidebar view is active (D16: chat REPLACES the panels). */
export type AgentChatView = "sidebar" | "chat";

/** The namespaced localStorage key the view choice persists under. */
export const AGENT_CHAT_VIEW_STORAGE_KEY = "slopcad.agent.chat-view.v1";

/** The minimal storage surface the view state needs (localStorage-shaped). */
export interface AgentChatViewStorage {
  getItem(name: string): string | null;
  setItem(name: string, value: string): void;
}

/** Reads the persisted view, tolerating stripped or corrupt storage. */
export function readAgentChatView(
  storage: AgentChatViewStorage,
): AgentChatView {
  try {
    return storage.getItem(AGENT_CHAT_VIEW_STORAGE_KEY) === "chat"
      ? "chat"
      : "sidebar";
  } catch {
    // A stripped context reads as the default view — never throws.
    return "sidebar";
  }
}

/** Persists the view, tolerating stripped storage (session-only then). */
export function persistAgentChatView(
  storage: AgentChatViewStorage,
  view: AgentChatView,
): void {
  try {
    storage.setItem(AGENT_CHAT_VIEW_STORAGE_KEY, view);
  } catch {
    // A stripped context cannot persist; the in-memory state still holds.
  }
}

/** The pure toggle: each view switches to the other one. */
export function nextAgentChatView(view: AgentChatView): AgentChatView {
  return view === "chat" ? "sidebar" : "chat";
}

/**
 * The browser backend binding: `globalThis.localStorage` when it exists,
 * `null` otherwise (SSR, node). Same seam shape as the config store's.
 */
export function getBrowserAgentChatViewStorage(): AgentChatViewStorage | null {
  if (typeof globalThis.localStorage === "undefined") {
    return null;
  }
  return globalThis.localStorage;
}

/** The hook's public surface: the reactive view plus its setter. */
export interface UseAgentChatViewReturn {
  readonly view: AgentChatView;
  readonly setView: (view: AgentChatView) => void;
}

/**
 * The reactive view state for whichever host mounts the chat (the Phase
 * 4.5 workbench mount and the palette commands both read this ONE hook's
 * output — the host calls it once and flows the result down). Starts at
 * the sidebar view on both server and client (hydration-safe); the stored
 * choice applies in an effect; every set persists immediately.
 */
export function useAgentChatView(): UseAgentChatViewReturn {
  const [view, setViewState] = useState<AgentChatView>("sidebar");

  // The stored choice applies after hydration, never at render time.
  useEffect(() => {
    const storage = getBrowserAgentChatViewStorage();
    if (storage === null) {
      return;
    }
    setViewState(readAgentChatView(storage));
  }, []);

  const setView = useCallback((next: AgentChatView) => {
    setViewState(next);
    const storage = getBrowserAgentChatViewStorage();
    if (storage !== null) {
      persistAgentChatView(storage, next);
    }
  }, []);

  return { setView, view };
}
