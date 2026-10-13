// @vitest-environment node
// Pure storage/persistence wiring; jsdom adds nothing.

/**
 * The chat view state's persistence contract (PLAN-AGENT-CHAT Phase 4.4,
 * D16): the right-sidebar chat ↔ panels switch persists per browser under
 * one namespaced key, reads tolerate stripped or corrupt storage by
 * falling back to the panels view (never throwing, never defaulting INTO
 * the chat), and the toggle is the pure flip both palette commands and
 * the sidebar mount ride.
 */

import { describe, expect, it } from "vitest";

import {
  AGENT_CHAT_VIEW_STORAGE_KEY,
  nextAgentChatView,
  persistAgentChatView,
  readAgentChatView,
  type AgentChatViewStorage,
} from "./view-state";

/** An in-memory localStorage stand-in. */
function memoryStorage(
  initial = new Map<string, string>(),
): AgentChatViewStorage {
  return {
    getItem: (name) => initial.get(name) ?? null,
    setItem: (name, value) => {
      initial.set(name, value);
    },
  };
}

/** A storage whose every access throws (stripped/private context). */
function refusingStorage(): AgentChatViewStorage {
  const refuse = (): never => {
    throw new Error("storage unavailable");
  };
  return { getItem: refuse, setItem: refuse };
}

describe("readAgentChatView", () => {
  it("defaults to the panels view when nothing is stored", () => {
    expect(readAgentChatView(memoryStorage())).toBe("sidebar");
  });

  it("restores a persisted chat view", () => {
    const storage = memoryStorage(
      new Map([[AGENT_CHAT_VIEW_STORAGE_KEY, "chat"]]),
    );
    expect(readAgentChatView(storage)).toBe("chat");
  });

  it("restores a persisted panels view", () => {
    const storage = memoryStorage(
      new Map([[AGENT_CHAT_VIEW_STORAGE_KEY, "sidebar"]]),
    );
    expect(readAgentChatView(storage)).toBe("sidebar");
  });

  it("treats unknown stored values as the panels view, never the chat", () => {
    const storage = memoryStorage(
      new Map([[AGENT_CHAT_VIEW_STORAGE_KEY, "chatty-chat"]]),
    );
    expect(readAgentChatView(storage)).toBe("sidebar");
  });

  it("never throws when storage is stripped", () => {
    expect(readAgentChatView(refusingStorage())).toBe("sidebar");
  });
});

describe("persistAgentChatView", () => {
  it("round-trips both views through the namespaced key", () => {
    const storage = memoryStorage();
    persistAgentChatView(storage, "chat");
    expect(storage.getItem(AGENT_CHAT_VIEW_STORAGE_KEY)).toBe("chat");
    expect(readAgentChatView(storage)).toBe("chat");

    persistAgentChatView(storage, "sidebar");
    expect(storage.getItem(AGENT_CHAT_VIEW_STORAGE_KEY)).toBe("sidebar");
    expect(readAgentChatView(storage)).toBe("sidebar");
  });

  it("tolerates a stripped context without throwing", () => {
    expect(() => {
      persistAgentChatView(refusingStorage(), "chat");
    }).not.toThrow();
  });
});

describe("nextAgentChatView", () => {
  it("flips each view to the other one", () => {
    expect(nextAgentChatView("sidebar")).toBe("chat");
    expect(nextAgentChatView("chat")).toBe("sidebar");
  });
});
