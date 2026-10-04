/**
 * OpenAI-compatible provider factory: builds the TanStack AI
 * OpenAI-compatible text adapter (Chat Completions) against an arbitrary
 * endpoint for browser-direct BYOK calls (PLAN-AGENT-CHAT D1/D6/D14,
 * Phase 1.2).
 *
 * The config extends the OpenAI SDK's `ClientOptions`, so the browser-direct
 * opt-in (`dangerouslyAllowBrowser`) and the injected `fetch` transport pass
 * straight through to `new OpenAI({ baseURL, ... })`. Unlike the named
 * providers, the endpoint is fully user-supplied: the model ids come from
 * the endpoint's own `GET {baseURL}/models` (see `listOpenAiCompatibleModels`)
 * with the raw-string input as the fallback (D14). The API key travels only
 * to the configured endpoint, never to the slopcad server (D1).
 */

import { openaiCompatibleText } from "@tanstack/ai-openai/compatible";

export interface OpenAiCompatibleAdapterConfig {
  /** The user's key for the configured endpoint, from browser-local storage. */
  apiKey: string;
  /** Raw model id as picked or typed by the user (D5: never defaulted). */
  modelId: string;
  /** The endpoint's OpenAI-compatible base URL. */
  baseURL: string;
  /** Injectable transport; defaults to the global `fetch`. */
  fetch?: typeof globalThis.fetch;
}

/** The adapter type produced by the library's one-shot compatible factory. */
export type OpenAiCompatibleAdapter = ReturnType<typeof openaiCompatibleText>;

export function createOpenAiCompatibleAdapter(
  config: OpenAiCompatibleAdapterConfig,
): OpenAiCompatibleAdapter {
  return openaiCompatibleText(config.modelId, {
    baseURL: config.baseURL,
    apiKey: config.apiKey,
    dangerouslyAllowBrowser: true,
    fetch: config.fetch ?? globalThis.fetch,
  });
}

export interface OpenAiCompatibleModelsQuery {
  /** The endpoint's OpenAI-compatible base URL. */
  baseURL: string;
  /** The user's key for the configured endpoint. */
  apiKey: string;
  /** Injectable transport; defaults to the global `fetch`. */
  fetch?: typeof globalThis.fetch;
}

export interface OpenAiCompatibleModelListing {
  /** Model ids exactly as the endpoint reports them; empty when listing is unavailable. */
  models: string[];
  /**
   * False when the endpoint exposes no usable `/models` (missing route,
   * auth refused, CORS blocked, unparseable body): the raw-string model
   * input is then the only source (D14).
   */
  listAvailable: boolean;
}

function rawStringOnly(): OpenAiCompatibleModelListing {
  return { models: [], listAvailable: false };
}

function modelsEndpoint(baseURL: string): string {
  return `${baseURL.replace(/\/+$/, "")}/models`;
}

function isModelRows(
  value: unknown,
): value is { data: Array<{ id: unknown }> } {
  if (typeof value !== "object" || value === null || !("data" in value)) {
    return false;
  }
  return Array.isArray(value.data);
}

/**
 * Lists the endpoint's models from its own OpenAI-compatible
 * `GET {baseURL}/models`, browser-direct with the user's key (D14).
 *
 * Never throws: any failure degrades to `{ models: [], listAvailable: false }`
 * so the picker can fall back to the raw model-string input inline instead
 * of surfacing an error wall.
 */
export async function listOpenAiCompatibleModels(
  query: OpenAiCompatibleModelsQuery,
): Promise<OpenAiCompatibleModelListing> {
  const transport = query.fetch ?? globalThis.fetch;
  try {
    const response = await transport(modelsEndpoint(query.baseURL), {
      headers: { Authorization: `Bearer ${query.apiKey}` },
    });
    if (!response.ok) {
      return rawStringOnly();
    }
    const payload: unknown = await response.json();
    if (!isModelRows(payload)) {
      return rawStringOnly();
    }
    const models: string[] = [];
    const seen = new Set<string>();
    for (const row of payload.data) {
      const id = row.id;
      if (typeof id !== "string" || id.length === 0 || seen.has(id)) {
        continue;
      }
      seen.add(id);
      models.push(id);
    }
    return { models, listAvailable: true };
  } catch {
    return rawStringOnly();
  }
}
