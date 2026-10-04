/**
 * Provider factories for the agent chat surface: one module per supported
 * provider, each building the TanStack AI adapter from
 * `{ apiKey, modelId, baseURL?, fetch? }` with that provider's
 * browser-direct flags (PLAN-AGENT-CHAT D1/D5/D6, Phase 1.2). Every factory
 * takes an injectable `fetch` transport — no call site may use a
 * non-injected fetch.
 *
 * The provider-id universe lives in `@slopcad/api/providers` (the shared
 * single source) and is re-exported as `AGENT_PROVIDER_IDS` below — no
 * provider-id list is restated here. The only other provider strings under
 * `providers/` are the dispatch switch's `case` labels, which the compiler
 * pins to the `AgentProviderId` union exhaustively.
 */

export {
  createAnthropicAdapter,
  type AnthropicAdapterConfig,
} from "./anthropic";
export { createGoogleAdapter, type GoogleAdapterConfig } from "./google";
export {
  createOpenAiCompatibleAdapter,
  listOpenAiCompatibleModels,
  type OpenAiCompatibleAdapter,
  type OpenAiCompatibleAdapterConfig,
  type OpenAiCompatibleModelListing,
  type OpenAiCompatibleModelsQuery,
} from "./openai-compatible";
export { createOpenaiAdapter, type OpenaiAdapterConfig } from "./openai";
export {
  createOpenRouterAdapter,
  type OpenRouterAdapterConfig,
} from "./openrouter";

import { PROVIDER_IDS, type ProviderId } from "@slopcad/api/providers";

import { createAnthropicAdapter } from "./anthropic";
import { createGoogleAdapter } from "./google";
import { createOpenAiCompatibleAdapter } from "./openai-compatible";
import { createOpenaiAdapter } from "./openai";
import { createOpenRouterAdapter } from "./openrouter";

/**
 * The five catalog provider ids — the picker's provider universe (D6),
 * re-exported from the shared single source so consumers keep one name
 * and one list.
 */
export const AGENT_PROVIDER_IDS = PROVIDER_IDS;

export type AgentProviderId = ProviderId;

/** Any adapter produced by the per-provider factories; each satisfies `chat()`. */
export type AgentProviderAdapter =
  | ReturnType<typeof createOpenaiAdapter>
  | ReturnType<typeof createAnthropicAdapter>
  | ReturnType<typeof createGoogleAdapter>
  | ReturnType<typeof createOpenRouterAdapter>
  | ReturnType<typeof createOpenAiCompatibleAdapter>;

/** Dispatch input — the shared shape of the four named providers' configs. */
export interface AgentProviderAdapterConfig {
  apiKey: string;
  modelId: string;
  baseURL?: string;
  fetch?: typeof globalThis.fetch;
}

/** Builds the adapter for a configured provider id. */
export function createAgentProviderAdapter(
  providerId: AgentProviderId,
  config: AgentProviderAdapterConfig,
): AgentProviderAdapter {
  switch (providerId) {
    case "openai":
      return createOpenaiAdapter(config);
    case "anthropic":
      return createAnthropicAdapter(config);
    case "google":
      return createGoogleAdapter(config);
    case "openrouter":
      return createOpenRouterAdapter(config);
    case "openai-compatible": {
      if (config.baseURL === undefined) {
        throw new Error("The openai-compatible provider requires a baseURL.");
      }
      return createOpenAiCompatibleAdapter({
        ...config,
        baseURL: config.baseURL,
      });
    }
  }
}
