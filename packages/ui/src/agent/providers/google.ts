/**
 * Google (Gemini) provider factory: builds the TanStack AI Gemini text
 * adapter for browser-direct BYOK calls (PLAN-AGENT-CHAT D1/D6, Phase 1.2).
 *
 * The Gemini adapter config extends the Google GenAI SDK's options, and that
 * SDK is browser-safe by design — no browser opt-in flag exists. The
 * transport is injected through `httpOptions.fetch` (the SDK has no
 * top-level `fetch` option); the adapter's client factory preserves the
 * caller's `httpOptions` when mapping `baseURL` onto `httpOptions.baseUrl`.
 * The API key travels only to Google itself, never to the slopcad server
 * (D1).
 */

import { createGeminiChat } from "@tanstack/ai-gemini";
import type { GeminiTextAdapter, GeminiTextModel } from "@tanstack/ai-gemini";

export interface GoogleAdapterConfig {
  /** The user's Google AI Studio API key, from browser-local storage. */
  apiKey: string;
  /** Raw model id as picked or typed by the user (D5: never defaulted). */
  modelId: string;
  /** Optional endpoint override; the SDK's own default is used when absent. */
  baseURL?: string;
  /** Injectable transport; defaults to the global `fetch`. */
  fetch?: typeof globalThis.fetch;
}

export function createGoogleAdapter(
  config: GoogleAdapterConfig,
): GeminiTextAdapter<GeminiTextModel> {
  // See ./openai.ts: the model union widening happens once at this factory
  // boundary because the library's constraint is compile-time only.
  const modelId = config.modelId as GeminiTextModel;
  return createGeminiChat(modelId, config.apiKey, {
    baseURL: config.baseURL,
    httpOptions: { fetch: config.fetch ?? globalThis.fetch },
  });
}
