// @vitest-environment node
/**
 * The browser-side models.dev catalog (BYOK — the picker no longer rides
 * the authed `modelCatalog.list`): the node suite pins the load +
 * force-refresh state machine against an injected transport and an
 * in-memory storage double — the live-network fetch guard is never
 * touched. The pinned rules mirror the server cache's contract:
 *
 * - one blob fetch per TTL window serves every named provider at once;
 * - a payload identical to the stored document reports "not-modified";
 * - an upstream failure serves the last good rows as `stale`, labelled
 *   with the reason, and reports `unavailable` only with nothing cached;
 * - an empty-but-valid filtered provider list never wipes prior rows;
 * - the force-refresh throws the typed error only at the true dead end.
 */

import type { AgentConfigStorage } from "@slopcad/ui/agent/config/store";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  AGENT_MODEL_CATALOG_STORAGE_KEY,
  AGENT_MODEL_CATALOG_TTL_MS,
  AgentModelCatalogError,
  loadAgentModelCatalog,
  refreshAgentModelCatalog,
  resetAgentModelCatalogMemory,
} from "./model-catalog";

/** The wall clock the suite pins every `now` to. */
const NOW = new Date("2026-10-15T12:00:00.000Z");

/** A models.dev-shaped model entry, overridable per fixture. */
function modelEntry(overrides: Record<string, unknown> = {}) {
  return {
    modalities: { input: ["text", "image"], output: ["text"] },
    name: "Fixture Model",
    release_date: "2026-09-01",
    ...overrides,
  };
}

/**
 * The fixture payload: openai carries one pass-filter model plus one
 * too-old and one text-only entry (both filtered out); anthropic carries
 * one; google/openrouter stay absent.
 */
function catalogPayload(overrides: Record<string, unknown> = {}) {
  return {
    anthropic: {
      models: {
        "claude-test": modelEntry({
          limit: { context: 200000 },
          name: "Claude Test",
          release_date: "2026-08-15",
        }),
      },
    },
    openai: {
      models: {
        "gpt-vision-new": modelEntry({
          limit: { context: 128000 },
          name: "GPT Vision New",
          reasoning_options: [{ type: "effort", values: ["low", "high"] }],
        }),
        "gpt-text-old": modelEntry({
          name: "GPT Text Old",
          release_date: "2020-01-01",
        }),
        "gpt-novision": modelEntry({
          modalities: { input: ["text"], output: ["text"] },
          name: "GPT NoVision",
        }),
      },
    },
    ...overrides,
  };
}

/** An in-memory localStorage double (the config store suite's shape). */
function memoryStorage(): AgentConfigStorage {
  const map = new Map<string, string>();
  return {
    getItem: (name) => map.get(name) ?? null,
    removeItem: (name) => {
      map.delete(name);
    },
    setItem: (name, value) => {
      map.set(name, value);
    },
  };
}

function deps(
  fetchImpl: typeof globalThis.fetch,
  storage?: AgentConfigStorage,
) {
  return {
    fetch: fetchImpl,
    now: () => NOW,
    storage: storage ?? memoryStorage(),
  };
}

function jsonFetch(payload: unknown): typeof globalThis.fetch {
  return vi.fn<typeof globalThis.fetch>(() =>
    Promise.resolve(new Response(JSON.stringify(payload), { status: 200 })),
  );
}

beforeEach(() => {
  resetAgentModelCatalogMemory();
});

describe("loadAgentModelCatalog", () => {
  it("fetches the blob once and serves every named provider's filtered rows", async () => {
    const fetch = jsonFetch(catalogPayload());
    const storage = memoryStorage();

    const openai = await loadAgentModelCatalog("openai", deps(fetch, storage));
    expect(openai).toMatchObject({ kind: "ready", outcome: "refetched" });
    if (openai.kind !== "ready") throw new Error("expected a ready load");
    expect(openai.entries.map((entry) => entry.modelId)).toEqual([
      "gpt-vision-new",
    ]);
    expect(openai.entries[0]?.name).toBe("GPT Vision New");
    expect(openai.entries[0]?.contextLimit).toBe(128000);
    expect(openai.entries[0]?.reasoningOptions).toEqual([
      { type: "effort", values: ["low", "high"] },
    ]);

    // The SAME blob fetch populated the other providers — a second
    // provider read within the TTL never re-hits upstream.
    const anthropic = await loadAgentModelCatalog(
      "anthropic",
      deps(fetch, storage),
    );
    expect(anthropic).toMatchObject({ kind: "ready", outcome: "fresh-cache" });
    if (anthropic.kind !== "ready") throw new Error("expected a ready load");
    expect(anthropic.entries.map((entry) => entry.modelId)).toEqual([
      "claude-test",
    ]);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith("https://models.dev/api.json");
  });

  it("serves the cache inside the TTL and re-fetches past it", async () => {
    const fetch = jsonFetch(catalogPayload());
    const storage = memoryStorage();

    await loadAgentModelCatalog("openai", deps(fetch, storage));
    const within = await loadAgentModelCatalog("openai", {
      fetch,
      now: () => new Date(NOW.getTime() + AGENT_MODEL_CATALOG_TTL_MS - 1),
      storage,
    });
    expect(within).toMatchObject({ kind: "ready", outcome: "fresh-cache" });
    expect(fetch).toHaveBeenCalledTimes(1);

    const past = await loadAgentModelCatalog("openai", {
      fetch,
      now: () => new Date(NOW.getTime() + AGENT_MODEL_CATALOG_TTL_MS),
      storage,
    });
    // The identical payload revalidates to "not-modified".
    expect(past).toMatchObject({ kind: "ready", outcome: "not-modified" });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("reports refetched when the payload changed", async () => {
    const storage = memoryStorage();
    await loadAgentModelCatalog(
      "openai",
      deps(jsonFetch(catalogPayload()), storage),
    );
    const changed = await loadAgentModelCatalog("openai", {
      fetch: jsonFetch(
        catalogPayload({
          openai: {
            models: {
              "gpt-vision-newer": modelEntry({
                name: "GPT Vision Newer",
                release_date: "2026-10-01",
              }),
            },
          },
        }),
      ),
      now: () => new Date(NOW.getTime() + AGENT_MODEL_CATALOG_TTL_MS + 1),
      storage,
    });
    expect(changed).toMatchObject({ kind: "ready", outcome: "refetched" });
    if (changed.kind !== "ready") throw new Error("expected a ready load");
    expect(changed.entries.map((entry) => entry.modelId)).toEqual([
      "gpt-vision-newer",
    ]);
  });

  it("serves the stale list with the reason when upstream fails over a cache", async () => {
    const storage = memoryStorage();
    await loadAgentModelCatalog(
      "openai",
      deps(jsonFetch(catalogPayload()), storage),
    );
    const failing = vi.fn<typeof globalThis.fetch>(() =>
      Promise.reject(new Error("socket hangup")),
    );
    const stale = await loadAgentModelCatalog("openai", {
      fetch: failing,
      now: () => new Date(NOW.getTime() + AGENT_MODEL_CATALOG_TTL_MS + 1),
      storage,
    });
    expect(stale.kind).toBe("stale");
    if (stale.kind !== "stale") throw new Error("expected a stale load");
    expect(stale.entries.map((entry) => entry.modelId)).toEqual([
      "gpt-vision-new",
    ]);
    expect(stale.reason).toContain("socket hangup");
  });

  it("reports unavailable with the reason when upstream fails and nothing is cached", async () => {
    const result = await loadAgentModelCatalog(
      "openai",
      deps(
        vi.fn<typeof globalThis.fetch>(() =>
          Promise.reject(new Error("offline")),
        ),
      ),
    );
    expect(result).toMatchObject({ kind: "unavailable" });
    if (result.kind !== "unavailable") {
      throw new Error("expected an unavailable load");
    }
    expect(result.reason).toContain("models.dev could not be reached");
    expect(result.reason).toContain("offline");
  });

  it("treats a non-200 upstream answer as an upstream failure", async () => {
    const result = await loadAgentModelCatalog(
      "openai",
      deps(
        vi.fn<typeof globalThis.fetch>(() =>
          Promise.resolve(new Response("oops", { status: 503 })),
        ),
      ),
    );
    expect(result).toMatchObject({ kind: "unavailable" });
    if (result.kind !== "unavailable") {
      throw new Error("expected an unavailable load");
    }
    expect(result.reason).toContain("HTTP 503");
  });

  it("treats a parseable 200 that is not a provider map as an upstream failure", async () => {
    const result = await loadAgentModelCatalog(
      "openai",
      deps(jsonFetch({ error: "rate limited" })),
    );
    expect(result).toMatchObject({ kind: "unavailable" });
    if (result.kind !== "unavailable") {
      throw new Error("expected an unavailable load");
    }
    expect(result.reason).toContain('not a model catalog for "openai"');
  });

  it("keeps prior rows when a valid fetch filters the provider to empty", async () => {
    const storage = memoryStorage();
    await loadAgentModelCatalog(
      "openai",
      deps(jsonFetch(catalogPayload()), storage),
    );
    const emptied = await loadAgentModelCatalog("openai", {
      fetch: jsonFetch({ openai: { models: {} } }),
      now: () => new Date(NOW.getTime() + AGENT_MODEL_CATALOG_TTL_MS + 1),
      storage,
    });
    expect(emptied.kind).toBe("ready");
    if (emptied.kind !== "ready") throw new Error("expected a ready load");
    expect(emptied.entries.map((entry) => entry.modelId)).toEqual([
      "gpt-vision-new",
    ]);
  });

  it("still serves fetched rows when storage is denied", async () => {
    const result = await loadAgentModelCatalog("openai", {
      fetch: jsonFetch(catalogPayload()),
      now: () => NOW,
      storage: null,
    });
    expect(result).toMatchObject({ kind: "ready", outcome: "refetched" });
    if (result.kind !== "ready") throw new Error("expected a ready load");
    expect(result.entries).toHaveLength(1);

    // The memory fallback holds the cache: a denied-storage second call
    // within the TTL answers fresh-cache without another fetch.
    const again = await loadAgentModelCatalog("openai", {
      fetch: vi.fn<typeof globalThis.fetch>(() =>
        Promise.reject(new Error("must not run")),
      ),
      now: () => NOW,
      storage: null,
    });
    expect(again).toMatchObject({ kind: "ready", outcome: "fresh-cache" });
  });

  it("survives a corrupt stored document by refetching", async () => {
    const storage = memoryStorage();
    storage.setItem(AGENT_MODEL_CATALOG_STORAGE_KEY, "{not json");
    const result = await loadAgentModelCatalog(
      "openai",
      deps(jsonFetch(catalogPayload()), storage),
    );
    expect(result).toMatchObject({ kind: "ready", outcome: "refetched" });
  });
});

describe("refreshAgentModelCatalog", () => {
  it("bypasses the TTL and reports the outcome with entries", async () => {
    const storage = memoryStorage();
    await loadAgentModelCatalog(
      "openai",
      deps(jsonFetch(catalogPayload()), storage),
    );
    const fetch = jsonFetch(catalogPayload());
    const result = await refreshAgentModelCatalog("openai", {
      fetch,
      now: () => NOW,
      storage,
    });
    expect(result.outcome).toBe("not-modified");
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(result.entries.map((entry) => entry.modelId)).toEqual([
      "gpt-vision-new",
    ]);
  });

  it("reports stale-served when upstream fails over a cache", async () => {
    const storage = memoryStorage();
    await loadAgentModelCatalog(
      "openai",
      deps(jsonFetch(catalogPayload()), storage),
    );
    const result = await refreshAgentModelCatalog("openai", {
      fetch: vi.fn<typeof globalThis.fetch>(() =>
        Promise.reject(new Error("offline")),
      ),
      now: () => new Date(NOW.getTime() + AGENT_MODEL_CATALOG_TTL_MS + 1),
      storage,
    });
    expect(result.outcome).toBe("stale-served");
    expect(result.entries).toHaveLength(1);
  });

  it("throws the typed error when upstream fails and nothing is cached", async () => {
    await expect(
      refreshAgentModelCatalog("openai", {
        fetch: vi.fn<typeof globalThis.fetch>(() =>
          Promise.resolve(new Response("oops", { status: 502 })),
        ),
        now: () => NOW,
        storage: memoryStorage(),
      }),
    ).rejects.toBeInstanceOf(AgentModelCatalogError);
    await expect(
      refreshAgentModelCatalog("openai", {
        fetch: vi.fn<typeof globalThis.fetch>(() =>
          Promise.resolve(new Response("oops", { status: 502 })),
        ),
        now: () => NOW,
        storage: memoryStorage(),
      }),
    ).rejects.toThrow("HTTP 502");
  });
});
