/**
 * OpenAI provider factory: builds the TanStack AI OpenAI text adapter
 * (Responses API) for browser-direct BYOK calls (PLAN-AGENT-CHAT D1/D6,
 * Phase 1.2).
 *
 * The adapter config extends the OpenAI SDK's `ClientOptions`, so the
 * browser-direct opt-in (`dangerouslyAllowBrowser`), the injected `fetch`
 * transport, and an optional `baseURL` all pass straight through to
 * `new OpenAI(...)`. The API key travels only to OpenAI itself — the
 * slopcad server is never on the path (D1).
 */

import { createOpenaiChat } from "@tanstack/ai-openai";
import type { OpenAIChatModel, OpenAITextAdapter } from "@tanstack/ai-openai";

export interface OpenaiAdapterConfig {
  /** The user's OpenAI API key, from browser-local storage. */
  apiKey: string;
  /** Raw model id as picked or typed by the user (D5: never defaulted). */
  modelId: string;
  /** Optional endpoint override; the SDK's own default is used when absent. */
  baseURL?: string;
  /** Injectable transport; defaults to the global `fetch`. */
  fetch?: typeof globalThis.fetch;
}

export function createOpenaiAdapter(
  config: OpenaiAdapterConfig,
): OpenAITextAdapter<OpenAIChatModel> {
  // The named-provider factories constrain `model` to their known-model
  // unions at the type level only — the library performs no runtime
  // validation (see `extendAdapter`'s pass-through contract). D5 requires a
  // raw model string to stay typable, so the widening happens once at this
  // factory boundary.
  const modelId = config.modelId as OpenAIChatModel;
  return createOpenaiChat(modelId, config.apiKey, {
    dangerouslyAllowBrowser: true,
    baseURL: config.baseURL,
    fetch: config.fetch ?? globalThis.fetch,
  });
}
