/**
 * The agent chat palette commands (PLAN-AGENT-CHAT Phase 4.4, D16/m4):
 * the four user-facing commands as {@link CadCommandDescriptor} values —
 * the same host-data shape every sibling command in the workbench's
 * palette uses, so registration is one `list.push(...)` and the
 * command-surface manifest can pin these ids exactly (the checklist
 * entries themselves land in Phase 6).
 *
 * - `agent-chat-toggle` — switches the right sidebar between its panels
 *   and the chat (and back), through the shared view-state module; always
 *   enabled, its label names the view it switches TO.
 * - `agent-settings` — opens the host's agent settings surface.
 * - `agent-catalog-refresh` — force-refreshes the model catalog (D7).
 * - `agent-conversation-clear` — clears the active conversation.
 *
 * The last three dispatch through the live {@link AgentChatSession} the
 * mounted chat panel reports; with no panel mounted (chat view closed)
 * they render honestly disabled rather than dispatching into nothing.
 */

import type { CadCommandDescriptor } from "@slopcad/ui/components/cad/cad-command-menu";
import type { AgentChatSession } from "./session-slot";

import { nextAgentChatView, type AgentChatView } from "./view-state";

/** Switches the right sidebar to/from the agent chat (D16). */
export const AGENT_CHAT_TOGGLE_COMMAND_ID = "agent-chat-toggle";
/** Opens the agent settings surface. */
export const AGENT_SETTINGS_COMMAND_ID = "agent-settings";
/** Force-refreshes the models.dev catalog cache (D7). */
export const AGENT_CATALOG_REFRESH_COMMAND_ID = "agent-catalog-refresh";
/** Clears the active agent conversation. */
export const AGENT_CONVERSATION_CLEAR_COMMAND_ID = "agent-conversation-clear";

/** Everything the command factory binds; every handler is injected. */
export interface AgentChatCommandsInput {
  /** The live right-sidebar view (drives the toggle's label + target). */
  readonly view: AgentChatView;
  /** The mounted chat panel's session, or null while the chat view is closed. */
  readonly session: AgentChatSession | null;
  /** Receives the next view (the view-state module's setter). */
  readonly onViewChange: (view: AgentChatView) => void;
}

/** The group token the four commands render under (first-seen order). */
export const AGENT_CHAT_COMMAND_GROUP = "Agent";

/**
 * Builds the four descriptors. Pure in its inputs: the same
 * `{ view, session, onViewChange }` always yields descriptors that
 * dispatch to exactly those targets.
 */
export function createAgentChatCommands(
  input: AgentChatCommandsInput,
): readonly CadCommandDescriptor[] {
  const { session, view } = input;
  return [
    {
      id: AGENT_CHAT_TOGGLE_COMMAND_ID,
      group: AGENT_CHAT_COMMAND_GROUP,
      label: view === "chat" ? "Show workbench panels" : "Show agent chat",
      keywords:
        "agent chat assistant ai right sidebar panel panels switch toggle show hide",
      run: () => {
        input.onViewChange(nextAgentChatView(view));
      },
    },
    {
      id: AGENT_SETTINGS_COMMAND_ID,
      group: AGENT_CHAT_COMMAND_GROUP,
      label: "Open agent settings",
      keywords:
        "agent settings configure provider model api key reasoning system prompt mode sync",
      disabled: session === null,
      run: () => {
        session?.openSettings();
      },
    },
    {
      id: AGENT_CATALOG_REFRESH_COMMAND_ID,
      group: AGENT_CHAT_COMMAND_GROUP,
      label: "Force-refresh model catalog",
      keywords: "agent model catalog refresh cache update fetch force",
      disabled: session === null,
      run: () => {
        session?.forceRefreshCatalog();
      },
    },
    {
      id: AGENT_CONVERSATION_CLEAR_COMMAND_ID,
      group: AGENT_CHAT_COMMAND_GROUP,
      label: "Clear agent conversation",
      keywords: "agent conversation clear delete reset history chat messages",
      disabled: session === null || !session.hasConversation,
      run: () => {
        session?.clearConversation();
      },
    },
  ];
}
