/**
 * Client agent config store (PLAN-AGENT-CHAT Phase 1.3, D5): a
 * localStorage-backed, namespaced persistence for the agent picker's user
 * choices — provider, per-provider API keys, model id, reasoning selection,
 * system prompt, OpenAI-compatible base URL (D14), mode, sync flag,
 * iteration budget.
 *
 * D5, both halves:
 *
 * - Nothing is preselected, ever: `provider` and `modelId` are `null` until
 *   the user chooses — "unconfigured" is a distinct type state
 *   (`AgentConfig`'s nullable fields + `isAgentConfigured`'s narrowing), not
 *   a runtime sentinel convention. No code path may read a default provider
 *   or model out of this store, because none exists.
 * - The picker remembers the user's last selection: every `set` persists
 *   immediately and round-trips.
 *
 * The stored API keys are the user's own BYOK secrets and only ever travel
 * from this store into the client-direct provider factories
 * (`apps/web/src/agent/providers`) — the relay fetcher (Phase 1.5) takes no
 * key parameter at all, so no key ever reaches the slopcad server (D1).
 *
 * The storage backend is injectable (the same seam pattern as the provider
 * factories' `fetch`): unit tests pass an in-memory backend, and
 * `getBrowserAgentConfigStore()` lazily binds `globalThis.localStorage` so
 * SSR renders never touch browser storage.
 */

import { AGENT_PROVIDER_IDS, type AgentProviderId } from "../providers";

/** The namespaced localStorage key the agent config persists under. */
export const AGENT_CONFIG_STORAGE_KEY = "slopcad.agent.config.v1";

/** Which execution path agent chats take (relay availability gated in 1.4/1.5). */
export type AgentChatMode = "client" | "server";

/** The remembered reasoning choice: an effort label or a token budget. */
export type AgentReasoningSelection =
  { type: "effort"; value: string } | { type: "budget_tokens"; value: number };

/** The full, validated agent config as the rest of the app may read it. */
export interface AgentConfig {
  /** Chosen provider — `null` until the user picks one (D5). */
  provider: AgentProviderId | null;
  /** The user's BYOK keys, keyed by catalog provider id. */
  apiKeyByProvider: Partial<Record<AgentProviderId, string>>;
  /** Chosen or raw-typed model id — `null` until chosen (D5). */
  modelId: string | null;
  /** Last reasoning selection — re-validated against the catalog on use. */
  reasoning: AgentReasoningSelection | null;
  /** The user's editable system prompt (D8); `null` until first edited. */
  systemPrompt: string | null;
  /**
   * The user's OpenAI-compatible endpoint (D14) — remembered so the picker
   * restores it; `null` until configured. Only the endpoint lives here, the
   * matching key rides in `apiKeyByProvider` under `"openai-compatible"`.
   */
  openAiCompatibleBaseUrl: string | null;
  mode: AgentChatMode;
  syncEnabled: boolean;
  /** Upper bound on model turns per agent run (TanStack's default: 5). */
  maxIterations: number;
}

/** The configured view of `AgentConfig`: provider AND model chosen (D5). */
export type ConfiguredAgentConfig = AgentConfig & {
  provider: AgentProviderId;
  modelId: string;
};

/**
 * Compile-level gate for the unconfigured state (D5): only a config with a
 * real provider and a real model id narrows to `ConfiguredAgentConfig`.
 */
export function isAgentConfigured(
  config: AgentConfig,
): config is ConfiguredAgentConfig {
  return config.provider !== null && config.modelId !== null;
}

/** The minimal storage surface the store needs (localStorage-shaped). */
export interface AgentConfigStorage {
  getItem(name: string): string | null;
  setItem(name: string, value: string): void;
  removeItem(name: string): void;
}

export interface AgentConfigStore {
  /** The current config — defaults whenever nothing valid is stored. */
  get(): AgentConfig;
  /**
   * Merges the patch into the config and persists immediately. Persistence
   * can genuinely fail (quota, private mode), so the outcome is returned
   * instead of thrown: a failed patch is not remembered, and the store keeps
   * serving the last successfully persisted config.
   */
  set(patch: Partial<AgentConfig>): AgentConfigSetResult;
  /** Forgets everything (used by "sign out of BYOK" style resets). */
  clear(): void;
}

/**
 * The outcome of a `set` write: `{ ok: false }` means the patch was merged
 * and validated but could not be persisted — surfaced, never thrown, never
 * mistaken for success.
 */
export type AgentConfigSetResult =
  { readonly ok: true } | { readonly ok: false; readonly error: unknown };

/** TanStack AI's own default agent-loop bound (docs/research/tanstack-ai.md §5). */
export const DEFAULT_MAX_ITERATIONS = 5;

const DEFAULT_MODE: AgentChatMode = "client";

const ALL_PROVIDER_IDS: readonly string[] = AGENT_PROVIDER_IDS;

function isAgentProviderId(value: string): value is AgentProviderId {
  return ALL_PROVIDER_IDS.includes(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function providerOrNull(value: unknown): AgentProviderId | null {
  return typeof value === "string" && isAgentProviderId(value) ? value : null;
}

function keysByProvider(
  value: unknown,
): Partial<Record<AgentProviderId, string>> {
  if (!isRecord(value)) {
    return {};
  }
  const keys: Partial<Record<AgentProviderId, string>> = {};
  for (const providerId of AGENT_PROVIDER_IDS) {
    const key = value[providerId];
    if (typeof key === "string" && key.length > 0) {
      keys[providerId] = key;
    }
  }
  return keys;
}

function nonEmptyStringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function reasoningOrNull(value: unknown): AgentReasoningSelection | null {
  if (!isRecord(value)) {
    return null;
  }
  if (
    value.type === "effort" &&
    typeof value.value === "string" &&
    value.value.length > 0
  ) {
    return { type: "effort", value: value.value };
  }
  if (
    value.type === "budget_tokens" &&
    typeof value.value === "number" &&
    Number.isInteger(value.value)
  ) {
    return { type: "budget_tokens", value: value.value };
  }
  return null;
}

function systemPromptOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function modeOrDefault(value: unknown): AgentChatMode {
  return value === "server" ? "server" : DEFAULT_MODE;
}

function syncEnabledOrDefault(value: unknown): boolean {
  return value === true;
}

function maxIterationsOrDefault(value: unknown): number {
  if (typeof value === "number" && Number.isInteger(value) && value >= 1) {
    return value;
  }
  return DEFAULT_MAX_ITERATIONS;
}

/**
 * The single normalization gatekeeper: any raw shape (parsed storage JSON,
 * a merged patch) becomes a fully valid `AgentConfig` — unknown provider ids
 * and malformed fields fall back to the defaults, never throw.
 */
function normalizeAgentConfig(raw: unknown): AgentConfig {
  if (!isRecord(raw)) {
    return {
      provider: null,
      apiKeyByProvider: {},
      modelId: null,
      reasoning: null,
      systemPrompt: null,
      openAiCompatibleBaseUrl: null,
      mode: DEFAULT_MODE,
      syncEnabled: false,
      maxIterations: DEFAULT_MAX_ITERATIONS,
    };
  }
  return {
    provider: providerOrNull(raw.provider),
    apiKeyByProvider: keysByProvider(raw.apiKeyByProvider),
    modelId: nonEmptyStringOrNull(raw.modelId),
    reasoning: reasoningOrNull(raw.reasoning),
    systemPrompt: systemPromptOrNull(raw.systemPrompt),
    openAiCompatibleBaseUrl: nonEmptyStringOrNull(raw.openAiCompatibleBaseUrl),
    mode: modeOrDefault(raw.mode),
    syncEnabled: syncEnabledOrDefault(raw.syncEnabled),
    maxIterations: maxIterationsOrDefault(raw.maxIterations),
  };
}

/**
 * Creates a config store over the given backend — the injectable seam that
 * keeps unit tests on an in-memory map and production on localStorage.
 */
export function createAgentConfigStore(
  storage: AgentConfigStorage,
): AgentConfigStore {
  const get = (): AgentConfig => {
    let raw: unknown = null;
    try {
      const stored = storage.getItem(AGENT_CONFIG_STORAGE_KEY);
      if (stored !== null) {
        const parsed: unknown = JSON.parse(stored);
        raw = parsed;
      }
    } catch {
      // Corrupt or unreadable storage falls through to defaults — the store
      // never throws on read, and never preselects anything to compensate.
      raw = null;
    }
    return normalizeAgentConfig(raw);
  };

  return {
    get,
    set(patch) {
      const next = normalizeAgentConfig({ ...get(), ...patch });
      try {
        storage.setItem(AGENT_CONFIG_STORAGE_KEY, JSON.stringify(next));
      } catch (error) {
        // Quota and private-mode failures surface as a typed result, never
        // as a crash — but also never as fake success: the merged patch is
        // simply not persisted, so `get()` keeps serving what was stored.
        return { ok: false, error };
      }
      return { ok: true };
    },
    clear() {
      storage.removeItem(AGENT_CONFIG_STORAGE_KEY);
    },
  };
}

/**
 * The production backend binding: `globalThis.localStorage` when it exists
 * (browser), `null` otherwise (SSR, tests without storage). Callers on the
 * client create the store once with the result; `null` means "not a browser
 * right now" — no store, no reads, no writes.
 */
export function getBrowserAgentConfigStorage(): AgentConfigStorage | null {
  if (typeof globalThis.localStorage === "undefined") {
    return null;
  }
  return globalThis.localStorage;
}
