/**
 * Provider factories for the agent chat surface: one module per supported
 * provider, each building the TanStack AI adapter from
 * `{ apiKey, modelId, baseURL?, fetch? }` with that provider's
 * browser-direct flags (PLAN-AGENT-CHAT D1/D5/D6, Phase 1.2). Every factory
 * takes an injectable `fetch` transport — no call site may use a
 * non-injected fetch.
 *
 * The provider-id universe (D6) is declared HERE — the registry item's own
 * copy, external-dependency-free by the registry's rules. The slopcad app
 * keeps its single source in `@slopcad/api/providers`; the app-side parity
 * test (`apps/web/src/agent/provider-id-parity.test.ts`) fails the build if
 * the two lists ever drift apart. The only other provider strings under
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

import { createAnthropicAdapter } from "./anthropic";
import { createGoogleAdapter } from "./google";
import { createOpenAiCompatibleAdapter } from "./openai-compatible";
import { createOpenaiAdapter } from "./openai";
import { createOpenRouterAdapter } from "./openrouter";

/** The BYO-endpoint provider — never catalog-backed (D14). */
export const OPENAI_COMPATIBLE_PROVIDER_ID = "openai-compatible";

/**
 * The providers whose models the models.dev catalog lists (D14) — every
 * supported id except the BYO-endpoint one.
 */
export const NAMED_PROVIDER_IDS = [
  "openai",
  "anthropic",
  "google",
  "openrouter",
] as const;

/** A provider whose models the models.dev catalog lists. */
export type NamedAgentProviderId = (typeof NAMED_PROVIDER_IDS)[number];

/**
 * The five catalog provider ids — the picker's provider universe (D6).
 */
export const AGENT_PROVIDER_IDS = [
  ...NAMED_PROVIDER_IDS,
  OPENAI_COMPATIBLE_PROVIDER_ID,
] as const;

export type AgentProviderId = (typeof AGENT_PROVIDER_IDS)[number];

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
