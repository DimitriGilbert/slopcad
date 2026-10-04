/**
 * The part renderers' type surface (PLAN-AGENT-CHAT Phase 4.3): the exact
 * message/part shapes the Phase 3.3 runtime hook streams, derived ONCE from
 * {@link type UseChatReturn} so every renderer switches over the same
 * discriminated union the chat client produces. The exhaustive switches in
 * the renderers (and their `never` checks) are compile-enforced against
 * THIS union: a future `@tanstack/ai` part type fails the build here
 * instead of rendering nothing silently.
 */

import type { UseChatReturn } from "@tanstack/ai-react";
import type { AgentChatTool } from "../../use-agent-chat";

/** One message exactly as the agent chat hook streams it. */
export type AgentChatMessage = UseChatReturn<
  readonly AgentChatTool[]
>["messages"][number];

/** One part of an agent chat message — the renderers' whole surface. */
export type AgentChatMessagePart = AgentChatMessage["parts"][number];

/** The tool-call arm (request side) of {@link AgentChatMessagePart}. */
export type AgentChatToolCallPart = Extract<
  AgentChatMessagePart,
  { type: "tool-call" }
>;

/** The tool-result arm (answer side) of {@link AgentChatMessagePart}. */
export type AgentChatToolResultPart = Extract<
  AgentChatMessagePart,
  { type: "tool-result" }
>;
