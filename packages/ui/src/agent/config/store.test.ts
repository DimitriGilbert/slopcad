// @vitest-environment node

/**
 * Config store contract (PLAN-AGENT-CHAT Phase 1.3, D5): the store
 * round-trips, remembers the user's last selection, never defaults a
 * provider or model (unconfigured is a distinct type state), and survives
 * corrupt or malformed storage by falling back to defaults. Storage is
 * injected, so node-env tests run on an in-memory backend.
 */

import { describe, expect, it } from "vitest";

import {
  AGENT_CONFIG_STORAGE_KEY,
  createAgentConfigStore,
  DEFAULT_MAX_ITERATIONS,
  getBrowserAgentConfigStorage,
  isAgentConfigured,
  type AgentConfig,
  type AgentConfigStorage,
  type ConfiguredAgentConfig,
} from "./store";

function memoryStorage(): AgentConfigStorage & {
  keys(): string[];
  peek(): string | null;
} {
  const entries = new Map<string, string>();
  return {
    getItem: (name) => entries.get(name) ?? null,
    setItem: (name, value) => {
      entries.set(name, value);
    },
    removeItem: (name) => {
      entries.delete(name);
    },
    keys: () => [...entries.keys()],
    peek: () => entries.get(AGENT_CONFIG_STORAGE_KEY) ?? null,
  };
}

/** A backend whose writes fail like an over-quota localStorage would. */
function quotaExceededStorage(
  fallback: AgentConfigStorage,
): AgentConfigStorage {
  return {
    getItem: (name) => fallback.getItem(name),
    setItem: () => {
      throw new DOMException("quota exceeded", "QuotaExceededError");
    },
    removeItem: (name) => fallback.removeItem(name),
  };
}

const FULL_PATCH: Partial<AgentConfig> = {
  provider: "anthropic",
  apiKeyByProvider: { anthropic: "sk-ant-test" },
  modelId: "claude-sonnet-5",
  reasoning: { type: "effort", value: "high" },
  systemPrompt: "You are a CAD copilot.",
  openAiCompatibleBaseUrl: "https://compat.example.test/v1",
  mode: "server",
  syncEnabled: true,
  maxIterations: 12,
};

describe("fresh store", () => {
  it("starts unconfigured with documented defaults", () => {
    const config = createAgentConfigStore(memoryStorage()).get();
    expect(config.provider).toBeNull();
    expect(config.modelId).toBeNull();
    expect(config.apiKeyByProvider).toEqual({});
    expect(config.reasoning).toBeNull();
    expect(config.systemPrompt).toBeNull();
    expect(config.openAiCompatibleBaseUrl).toBeNull();
    expect(config.mode).toBe("client");
    expect(config.syncEnabled).toBe(false);
    expect(config.maxIterations).toBe(DEFAULT_MAX_ITERATIONS);
  });

  it("keeps unconfigured a distinct type state (D5, compile-level)", () => {
    const config = createAgentConfigStore(memoryStorage()).get();
    if (isAgentConfigured(config)) {
      // A configured provider is a real id, never null — this assignment
      // must not typecheck.
      // @ts-expect-error — configured provider is AgentProviderId, not null
      const notNull: null = config.provider;
      expect(notNull).toBeNull();
    } else {
      // @ts-expect-error — provider: null does not satisfy ConfiguredAgentConfig
      const unconfigured: ConfiguredAgentConfig = config;
      expect(unconfigured).toBeDefined();
    }
  });
});

describe("round-trip and remember-last-selection", () => {
  it("round-trips every field through storage and reports success", () => {
    const storage = memoryStorage();
    expect(createAgentConfigStore(storage).set(FULL_PATCH)).toEqual({
      ok: true,
    });
    expect(createAgentConfigStore(storage).get()).toEqual(FULL_PATCH);
  });

  it("remembers the latest selection, not the first", () => {
    const storage = memoryStorage();
    const store = createAgentConfigStore(storage);
    store.set({ provider: "openai", modelId: "gpt-5.2" });
    expect(store.get().provider).toBe("openai");
    store.set({ provider: "google", modelId: "gemini-3.8-flash" });
    expect(store.get().provider).toBe("google");
    expect(store.get().modelId).toBe("gemini-3.8-flash");
  });

  it("merges patches instead of replacing the whole config", () => {
    const storage = memoryStorage();
    const store = createAgentConfigStore(storage);
    store.set(FULL_PATCH);
    store.set({ provider: "openrouter", modelId: "a/b/c" });
    const config = store.get();
    expect(config.provider).toBe("openrouter");
    expect(config.apiKeyByProvider).toEqual({ anthropic: "sk-ant-test" });
    expect(config.systemPrompt).toBe("You are a CAD copilot.");
  });

  it("persists under exactly one namespaced key", () => {
    const storage = memoryStorage();
    createAgentConfigStore(storage).set(FULL_PATCH);
    expect(storage.keys()).toEqual([AGENT_CONFIG_STORAGE_KEY]);
    expect(storage.peek()).toContain('"provider":"anthropic"');
  });

  it("forgets everything on clear", () => {
    const storage = memoryStorage();
    const store = createAgentConfigStore(storage);
    store.set(FULL_PATCH);
    store.clear();
    expect(storage.getItem(AGENT_CONFIG_STORAGE_KEY)).toBeNull();
    expect(store.get().provider).toBeNull();
    expect(store.get().modelId).toBeNull();
  });
});

describe("malformed storage", () => {
  it("falls back to defaults on corrupt JSON", () => {
    const storage = memoryStorage();
    storage.setItem(AGENT_CONFIG_STORAGE_KEY, "{not json");
    const config = createAgentConfigStore(storage).get();
    expect(config.provider).toBeNull();
    expect(config.modelId).toBeNull();
    expect(config.maxIterations).toBe(DEFAULT_MAX_ITERATIONS);
  });

  it("falls back to defaults on non-object JSON", () => {
    const storage = memoryStorage();
    storage.setItem(AGENT_CONFIG_STORAGE_KEY, "42");
    const config = createAgentConfigStore(storage).get();
    expect(config.provider).toBeNull();
  });

  it("drops unknown provider ids and unknown key entries", () => {
    const storage = memoryStorage();
    storage.setItem(
      AGENT_CONFIG_STORAGE_KEY,
      JSON.stringify({
        provider: "banana",
        apiKeyByProvider: { openai: "sk-test", banana: "sk-unknown" },
        modelId: "gpt-5.2",
      }),
    );
    const config = createAgentConfigStore(storage).get();
    expect(config.provider).toBeNull();
    expect(config.apiKeyByProvider).toEqual({ openai: "sk-test" });
    // A stored model id alone never becomes a selection (D5).
    expect(isAgentConfigured(config)).toBe(false);
  });

  it("rejects malformed reasoning selections", () => {
    const storage = memoryStorage();
    storage.setItem(
      AGENT_CONFIG_STORAGE_KEY,
      JSON.stringify({
        reasoning: { type: "effort", value: 2048 },
      }),
    );
    expect(createAgentConfigStore(storage).get().reasoning).toBeNull();
  });

  it("round-trips both reasoning selection variants", () => {
    const storage = memoryStorage();
    const store = createAgentConfigStore(storage);
    store.set({ reasoning: { type: "budget_tokens", value: 8192 } });
    expect(store.get().reasoning).toEqual({
      type: "budget_tokens",
      value: 8192,
    });
    store.set({ reasoning: { type: "effort", value: "xhigh" } });
    expect(store.get().reasoning).toEqual({ type: "effort", value: "xhigh" });
  });

  it("coerces invalid maxIterations to the default, keeps valid ones", () => {
    const storage = memoryStorage();
    const store = createAgentConfigStore(storage);
    for (const invalid of [0, -3, 2.5, "9", null]) {
      storage.setItem(
        AGENT_CONFIG_STORAGE_KEY,
        JSON.stringify({ maxIterations: invalid }),
      );
      expect(store.get().maxIterations).toBe(DEFAULT_MAX_ITERATIONS);
    }
    store.set({ maxIterations: 20 });
    expect(store.get().maxIterations).toBe(20);
  });

  it("distinguishes a cleared prompt from a never-edited one", () => {
    const storage = memoryStorage();
    const store = createAgentConfigStore(storage);
    expect(store.get().systemPrompt).toBeNull();
    store.set({ systemPrompt: "" });
    expect(store.get().systemPrompt).toBe("");
  });

  it("reports quota failures as a typed result, never a throw", () => {
    const store = createAgentConfigStore(quotaExceededStorage(memoryStorage()));
    expect(() => store.set(FULL_PATCH)).not.toThrow();
    const result = store.set(FULL_PATCH);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error instanceof Error).toBe(true);
    }
  });

  it("keeps serving the last persisted config after a failed write", () => {
    const storage = memoryStorage();
    const store = createAgentConfigStore(storage);
    store.set({ provider: "anthropic", modelId: "claude-sonnet-5" });
    const failing = createAgentConfigStore(quotaExceededStorage(storage));
    expect(failing.set({ modelId: "gpt-5.2" }).ok).toBe(false);
    // The failed patch is not remembered and no fake success is stored.
    expect(failing.get().provider).toBe("anthropic");
    expect(failing.get().modelId).toBe("claude-sonnet-5");
    expect(storage.peek()).toContain('"modelId":"claude-sonnet-5"');
  });

  it("survives an immediately-failing first write (nothing stored yet)", () => {
    const store = createAgentConfigStore(quotaExceededStorage(memoryStorage()));
    expect(store.set(FULL_PATCH).ok).toBe(false);
    expect(store.get()).toEqual({
      provider: null,
      apiKeyByProvider: {},
      modelId: null,
      reasoning: null,
      systemPrompt: null,
      openAiCompatibleBaseUrl: null,
      mode: "client",
      syncEnabled: false,
      maxIterations: DEFAULT_MAX_ITERATIONS,
    });
  });
});

describe("openAiCompatibleBaseUrl (D14)", () => {
  it("round-trips the endpoint and remembers it across store instances", () => {
    const storage = memoryStorage();
    const store = createAgentConfigStore(storage);
    store.set({
      openAiCompatibleBaseUrl: "https://compat.example.test/v1",
    });
    expect(store.get().openAiCompatibleBaseUrl).toBe(
      "https://compat.example.test/v1",
    );
    expect(createAgentConfigStore(storage).get().openAiCompatibleBaseUrl).toBe(
      "https://compat.example.test/v1",
    );
  });

  it("normalizes non-string, empty, and missing values to null", () => {
    const storage = memoryStorage();
    const store = createAgentConfigStore(storage);
    for (const invalid of [123, true, {}, "", null, undefined]) {
      storage.setItem(
        AGENT_CONFIG_STORAGE_KEY,
        JSON.stringify({ openAiCompatibleBaseUrl: invalid }),
      );
      expect(store.get().openAiCompatibleBaseUrl).toBeNull();
    }
    storage.setItem(
      AGENT_CONFIG_STORAGE_KEY,
      JSON.stringify({ modelId: "gpt-5.2" }),
    );
    expect(store.get().openAiCompatibleBaseUrl).toBeNull();
  });

  it("clears back to null when the user resets the endpoint", () => {
    const storage = memoryStorage();
    const store = createAgentConfigStore(storage);
    store.set({ openAiCompatibleBaseUrl: "https://compat.example.test/v1" });
    store.set({ openAiCompatibleBaseUrl: null });
    expect(store.get().openAiCompatibleBaseUrl).toBeNull();
  });
});

describe("getBrowserAgentConfigStorage", () => {
  it("binds nothing outside a browser (node env has no localStorage)", () => {
    expect(getBrowserAgentConfigStorage()).toBeNull();
  });
});
