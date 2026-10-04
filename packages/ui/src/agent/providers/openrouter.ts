/**
 * OpenRouter provider factory: builds the TanStack AI OpenRouter text
 * adapter for browser-direct BYOK calls (PLAN-AGENT-CHAT D1/D6, Phase 1.2).
 *
 * OpenRouter's adapter config extends `@openrouter/sdk`'s `SDKOptions`,
 * which has NO `fetch` field: the injection point is `httpClient`. The SDK
 * base class funnels every request through `httpClient.request(request)`
 * (with auth already built onto the `Request`), so a structural client whose
 * `request` delegates to the injected transport honors the override
 * verbatim. The `HTTPClient` class itself is nominal over private fields and
 * lives in a transitive package pnpm forbids importing directly, so the
 * structural client is asserted once at that seam. The API key travels only
 * to OpenRouter itself, never to the slopcad server (D1).
 */

import { createOpenRouterText } from "@tanstack/ai-openrouter";
import type {
  OpenRouterConfig,
  OpenRouterTextAdapter,
} from "@tanstack/ai-openrouter";

export interface OpenRouterAdapterConfig {
  /** The user's OpenRouter API key, from browser-local storage. */
  apiKey: string;
  /** Raw model id as picked or typed by the user (D5: never defaulted). */
  modelId: string;
  /** Optional endpoint override (the SDK's `serverURL`); the SDK's own default is used when absent. */
  baseURL?: string;
  /** Injectable transport; defaults to the global `fetch`. */
  fetch?: typeof globalThis.fetch;
}

/** The factory's model-union parameter (not re-exported by the package root). */
type OpenRouterModelId = Parameters<typeof createOpenRouterText>[0];

/** The `httpClient` slot of the OpenRouter SDK options. */
type OpenRouterHttpClient = NonNullable<OpenRouterConfig["httpClient"]>;

function transportClient(
  transport: typeof globalThis.fetch,
): OpenRouterHttpClient {
  return {
    request: (request: Request) => transport(request),
  } as OpenRouterHttpClient;
}

export function createOpenRouterAdapter(
  config: OpenRouterAdapterConfig,
): OpenRouterTextAdapter<OpenRouterModelId> {
  // See ./openai.ts: the model union widening happens once at this factory
  // boundary because the library's constraint is compile-time only.
  const modelId = config.modelId as OpenRouterModelId;
  return createOpenRouterText(modelId, config.apiKey, {
    serverURL: config.baseURL,
    httpClient: transportClient(config.fetch ?? globalThis.fetch),
  });
}
