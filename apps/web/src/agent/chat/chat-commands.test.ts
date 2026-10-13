// @vitest-environment node
// Pure command-descriptor and session-slot wiring; jsdom adds nothing.

/**
 * The four agent chat palette commands' contract (PLAN-AGENT-CHAT Phase
 * 4.4, m4): the descriptors exist with stable ids, dispatch to exactly
 * the injected targets, gate honestly on the live session, and the
 * session slot they read through notifies its subscribers on every
 * change (the reactive bridge between the mounted panel and the
 * registration site).
 */

import { describe, expect, it, vi } from "vitest";
import {
  createAgentChatSessionSlot,
  type AgentChatSession,
} from "@slopcad/ui/agent/chat/session-slot";

import {
  AGENT_CATALOG_REFRESH_COMMAND_ID,
  AGENT_CHAT_COMMAND_GROUP,
  AGENT_CHAT_TOGGLE_COMMAND_ID,
  AGENT_CONVERSATION_CLEAR_COMMAND_ID,
  AGENT_SETTINGS_COMMAND_ID,
  createAgentChatCommands,
} from "./chat-commands";

/** A scripted live session double. */
function session(overrides: Partial<AgentChatSession> = {}): AgentChatSession {
  return {
    clearConversation: vi.fn(),
    forceRefreshCatalog: vi.fn(),
    hasConversation: true,
    openSettings: vi.fn(),
    ...overrides,
  };
}

/** Finds one descriptor by id (ids are the manifest's stable targets). */
function byId(
  commands: ReturnType<typeof createAgentChatCommands>,
  id: string,
) {
  const found = commands.find((command) => command.id === id);
  if (found === undefined) {
    throw new Error(`missing command descriptor "${id}"`);
  }
  return found;
}

describe("createAgentChatCommands", () => {
  it("returns exactly the four descriptors under the Agent group", () => {
    const commands = createAgentChatCommands({
      session: session(),
      view: "sidebar",
      onViewChange: vi.fn(),
    });
    expect(commands.map((command) => command.id)).toEqual([
      AGENT_CHAT_TOGGLE_COMMAND_ID,
      AGENT_SETTINGS_COMMAND_ID,
      AGENT_CATALOG_REFRESH_COMMAND_ID,
      AGENT_CONVERSATION_CLEAR_COMMAND_ID,
    ]);
    expect(
      commands.every((command) => command.group === AGENT_CHAT_COMMAND_GROUP),
    ).toBe(true);
    expect(commands.every((command) => command.label.length > 0)).toBe(true);
  });

  it("dispatches the toggle to the injected view setter with the flipped view", () => {
    const onViewChange = vi.fn();
    const commands = createAgentChatCommands({
      session: null,
      view: "sidebar",
      onViewChange,
    });
    byId(commands, AGENT_CHAT_TOGGLE_COMMAND_ID).run();
    expect(onViewChange).toHaveBeenCalledWith("chat");
  });

  it("labels the toggle by the view it switches TO and dispatches back", () => {
    const onViewChange = vi.fn();
    const commands = createAgentChatCommands({
      session: null,
      view: "chat",
      onViewChange,
    });
    const toggle = byId(commands, AGENT_CHAT_TOGGLE_COMMAND_ID);
    expect(toggle.label).toBe("Show workbench panels");
    toggle.run();
    expect(onViewChange).toHaveBeenCalledWith("sidebar");

    const back = createAgentChatCommands({
      session: null,
      view: "sidebar",
      onViewChange,
    });
    expect(byId(back, AGENT_CHAT_TOGGLE_COMMAND_ID).label).toBe(
      "Show agent chat",
    );
  });

  it("keeps the toggle enabled with no live session", () => {
    const commands = createAgentChatCommands({
      session: null,
      view: "sidebar",
      onViewChange: vi.fn(),
    });
    expect(byId(commands, AGENT_CHAT_TOGGLE_COMMAND_ID).disabled).toBeFalsy();
  });

  it("dispatches each session command to its injected session target", () => {
    const live = session();
    const commands = createAgentChatCommands({
      session: live,
      view: "chat",
      onViewChange: vi.fn(),
    });
    byId(commands, AGENT_SETTINGS_COMMAND_ID).run();
    expect(live.openSettings).toHaveBeenCalledOnce();

    byId(commands, AGENT_CATALOG_REFRESH_COMMAND_ID).run();
    expect(live.forceRefreshCatalog).toHaveBeenCalledOnce();

    byId(commands, AGENT_CONVERSATION_CLEAR_COMMAND_ID).run();
    expect(live.clearConversation).toHaveBeenCalledOnce();
  });

  it("disables the session commands honestly while no panel is mounted", () => {
    const commands = createAgentChatCommands({
      session: null,
      view: "sidebar",
      onViewChange: vi.fn(),
    });
    for (const id of [
      AGENT_SETTINGS_COMMAND_ID,
      AGENT_CATALOG_REFRESH_COMMAND_ID,
      AGENT_CONVERSATION_CLEAR_COMMAND_ID,
    ]) {
      expect(byId(commands, id).disabled).toBe(true);
      // Disabled means it must not dispatch into nothing either.
      expect(() => byId(commands, id).run()).not.toThrow();
    }
  });

  it("gates the clear command on the session's conversation existing", () => {
    const empty = session({ hasConversation: false });
    const commands = createAgentChatCommands({
      session: empty,
      view: "chat",
      onViewChange: vi.fn(),
    });
    expect(byId(commands, AGENT_CONVERSATION_CLEAR_COMMAND_ID).disabled).toBe(
      true,
    );

    const populated = session({ hasConversation: true });
    const enabled = createAgentChatCommands({
      session: populated,
      view: "chat",
      onViewChange: vi.fn(),
    });
    expect(
      byId(enabled, AGENT_CONVERSATION_CLEAR_COMMAND_ID).disabled,
    ).toBeFalsy();
  });
});

describe("createAgentChatSessionSlot", () => {
  it("starts null and notifies subscribers on set and clear", () => {
    const slot = createAgentChatSessionSlot();
    const listener = vi.fn();
    const unsubscribe = slot.subscribe(listener);

    expect(slot.get()).toBeNull();

    const live = session();
    slot.set(live);
    expect(slot.get()).toBe(live);
    expect(listener).toHaveBeenCalledOnce();

    slot.set(null);
    expect(slot.get()).toBeNull();
    expect(listener).toHaveBeenCalledTimes(2);

    unsubscribe();
  });

  it("stops notifying after unsubscribe", () => {
    const slot = createAgentChatSessionSlot();
    const listener = vi.fn();
    const unsubscribe = slot.subscribe(listener);
    unsubscribe();

    slot.set(session());
    expect(listener).not.toHaveBeenCalled();
  });
});
