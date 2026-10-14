/**
 * Anthropic provider factory: builds the TanStack AI Anthropic text adapter
 * for browser-direct BYOK calls (PLAN-AGENT-CHAT D1/D6, Phase 1.2).
 *
 * The adapter config extends the Anthropic SDK's `ClientOptions`, so the
 * browser-direct opt-in — the `anthropic-dangerous-direct-browser-access`
 * header — the injected `fetch` transport, and an optional `baseURL` all
 * pass straight through to `new Anthropic(...)`. The API key travels only
 * to Anthropic itself, never to the slopcad server (D1).
 */

import { createAnthropicChat } from "@tanstack/ai-anthropic";
import type {
  AnthropicChatModel,
  AnthropicTextAdapter,
} from "@tanstack/ai-anthropic";

export interface AnthropicAdapterConfig {
  /** The user's Anthropic API key, from browser-local storage. */
  apiKey: string;
  /** Raw model id as picked or typed by the user (D5: never defaulted). */
  modelId: string;
  /** Optional endpoint override; the SDK's own default is used when absent. */
  baseURL?: string;
  /** Injectable transport; defaults to the global `fetch`. */
  fetch?: typeof globalThis.fetch;
}

export function createAnthropicAdapter(
  config: AnthropicAdapterConfig,
): AnthropicTextAdapter<AnthropicChatModel> {
  // See ./openai.ts: the model union widening happens once at this factory
  // boundary because the library's constraint is compile-time only.
  const modelId = config.modelId as AnthropicChatModel;
  return createAnthropicChat(modelId, config.apiKey, {
    defaultHeaders: { "anthropic-dangerous-direct-browser-access": "true" },
    baseURL: config.baseURL,
    fetch: config.fetch ?? globalThis.fetch,
  });
}
