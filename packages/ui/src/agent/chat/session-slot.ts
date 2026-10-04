/**
 * The live agent chat session slot (PLAN-AGENT-CHAT Phase 4.4): the tiny
 * shared cell through which the chat panel reports its live surface —
 * clear-conversation, open-settings, force-refresh-catalog — to whoever
 * dispatches the palette commands. The panel is page-agnostic and mounts
 * only while the chat view is active (D16), so the commands cannot reach
 * it through props alone; the slot is the ONE source both sides share,
 * owned next to the view state for the same reason.
 *
 * While no panel is mounted the slot holds `null` and the session-scoped
 * palette commands render honestly disabled (exactly like the workbench's
 * `disabled: applied === null` export commands) — a null slot is never
 * papered over with a no-op handler.
 */

import { useSyncExternalStore } from "react";

/**
 * The live chat surface a mounted panel reports: the conversation
 * lifecycle the "clear conversation" command drives, plus the two host
 * affordances the panel relays (the host injects both as panel props).
 */
export interface AgentChatSession {
  /** True once a conversation exists to clear (rows or live transcript). */
  readonly hasConversation: boolean;
  /** Clears the active conversation (local rows + transcript). */
  readonly clearConversation: () => void;
  /** Opens the host's agent settings surface. */
  readonly openSettings: () => void;
  /** Force-refreshes the host's model catalog. */
  readonly forceRefreshCatalog: () => void;
}

/** The observable cell itself: get/set/subscribe, nothing more. */
export interface AgentChatSessionSlot {
  get(): AgentChatSession | null;
  /** Sets the live session (or clears it on unmount); notifies listeners. */
  set(session: AgentChatSession | null): void;
  subscribe(listener: () => void): () => void;
}

/** Creates one slot — the host keeps it for the page's lifetime. */
export function createAgentChatSessionSlot(): AgentChatSessionSlot {
  let current: AgentChatSession | null = null;
  const listeners = new Set<() => void>();
  return {
    get: () => current,
    set(session) {
      current = session;
      for (const listener of listeners) {
        listener();
      }
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/**
 * The reactive read for command registration: re-renders on every session
 * change (panel mount/unmount, hasConversation flips) through
 * `useSyncExternalStore` over the slot. The slot's current value doubles
 * as the SERVER snapshot (null there — no panel is ever mounted during
 * SSR), so server-rendered workbench routes never hit React's
 * missing-getServerSnapshot error.
 */
export function useAgentChatSession(
  slot: AgentChatSessionSlot,
): AgentChatSession | null {
  return useSyncExternalStore(
    (listener) => slot.subscribe(listener),
    () => slot.get(),
    () => slot.get(),
  );
}
