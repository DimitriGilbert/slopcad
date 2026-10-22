/**
 * The browser-side models.dev model catalog (agent chat, D7/D14 — the
 * BYOK fix): the settings picker's catalog loads IN THE BROWSER straight
 * from `https://models.dev/api.json`. The product is BYOK — no account
 * required — so the catalog may not ride `modelCatalog.list` (a
 * protected tRPC procedure that answers unauthenticated callers with an
 * auth error). The server-side router stays for authenticated
 * server-side consumers; this module is the picker's source of truth.
 *
 * Caching mirrors the server cache's recipe
 * (docs/research/models-dev-api.md §5) adapted to what a browser can
 * actually do:
 *
 * - ONE blob fetch per 24h TTL window. models.dev answers CORS
 *   (`access-control-allow-origin: *`) but refuses the OPTIONS preflight
 *   a conditional `If-None-Match` request requires (verified 405), so
 *   revalidation is a plain GET and "not-modified" is detected by
 *   comparing the filtered result to the stored document — honest about
 *   what changed, never dependent on a header the CDN won't expose.
 * - Stale-on-error: an unreachable upstream serves the last good rows,
 *   labelled; only with nothing cached at all does the caller see
 *   `unavailable` with the readable reason.
 * - An empty-but-valid filtered provider list never wipes prior rows —
 *   indistinguishable from a transient upstream anomaly.
 * - The cache lives in localStorage (namespaced key, same discipline as
 *   the agent config store); a denied backend degrades to an in-memory
 *   document so the session still caches.
 * - `VITE_AGENT_MODEL_CATALOG_URL` points the fetch at a self-hosted
 *   mirror — the session harness's loopback fixture — and defaults to
 *   models.dev.
 *
 * The picker filter itself is `@slopcad/api`'s
 * `model-catalog-filter` verbatim (dependency-free by design): browser
 * and server apply the same vision/recency/deprecation rules.
 */

import type { NamedProviderId } from "@slopcad/api/providers";
import { NAMED_PROVIDER_IDS } from "@slopcad/api/providers";
import type {
  ModelCatalogEntryDto,
  ModelCatalogRefreshOutcome,
  ModelCatalogRefreshResultDto,
} from "@slopcad/api/routers/model-catalog";
import {
  extractProviderModels,
  filterProviderModels,
  isProviderMap,
  parseReasoningOptions,
  type FilteredCatalogEntry,
} from "@slopcad/api/routers/model-catalog-filter";
import type { AgentConfigStorage } from "@slopcad/ui/agent/config/store";
import { getBrowserAgentConfigStorage } from "@slopcad/ui/agent/config/store";

/** The catalog source — the models.dev API unless the build overrides it. */
export const AGENT_MODEL_CATALOG_URL =
  (
    import.meta as {
      env?: Record<string, string | undefined>;
    }
  ).env?.VITE_AGENT_MODEL_CATALOG_URL ?? "https://models.dev/api.json";

/**
 * Cache lifetime of a fetched catalog: 24 hours — the same window the
 * server cache holds (`MODEL_CATALOG_TTL_MS` is router-internal, so the
 * number is pinned here to keep the server stack out of the bundle).
 */
export const AGENT_MODEL_CATALOG_TTL_MS = 24 * 60 * 60 * 1000;

/** The namespaced localStorage key the catalog cache persists under. */
export const AGENT_MODEL_CATALOG_STORAGE_KEY = "slopcad.agent.model-catalog.v1";

/** The React Query key prefix the catalog queries + refresh invalidation share. */
export const AGENT_MODEL_CATALOG_QUERY_KEY = ["agent-model-catalog"] as const;

/**
 * The persisted document: one blob fetch refreshes EVERY named provider's
 * filtered rows at once (they all derive from the same `api.json`), so
 * the cache is a single document rather than per-provider records.
 */
interface StoredCatalogDocument {
  /** Epoch ms of the last successful upstream fetch — the TTL anchor. */
  readonly fetchedAt: number;
  /** Filtered picker rows per named provider (unstamped — `fetchedAt` is the document's). */
  readonly providers: Partial<
    Record<NamedProviderId, readonly FilteredCatalogEntry[]>
  >;
}

/**
 * What a catalog load resolved to. `ready` serves entries with the
 * upstream outcome; `stale` serves the last good rows alongside the
 * failure's readable reason; `unavailable` is the honest dead end —
 * upstream failed and nothing was cached to fall back on.
 */
export type AgentModelCatalogResult =
  | {
      readonly kind: "ready";
      readonly outcome: "fresh-cache" | "refetched" | "not-modified";
      readonly entries: readonly ModelCatalogEntryDto[];
    }
  | {
      readonly kind: "stale";
      readonly entries: readonly ModelCatalogEntryDto[];
      readonly reason: string;
    }
  | { readonly kind: "unavailable"; readonly reason: string };

/** The typed failure the force-refresh throws when nothing can be served. */
export class AgentModelCatalogError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentModelCatalogError";
  }
}

/** Injectable seams — tests pin transport, storage, and the clock. */
export interface AgentModelCatalogDeps {
  /** Transport; production uses the global fetch. */
  readonly fetch?: typeof globalThis.fetch;
  /** Cache backend; `null` simulates denied storage (memory fallback). */
  readonly storage?: AgentConfigStorage | null;
  /** Clock for the TTL and the recency filter; defaults to the wall clock. */
  readonly now?: () => Date;
  /** Catalog source; defaults to {@link AGENT_MODEL_CATALOG_URL}. */
  readonly catalogUrl?: string;
}

/**
 * The session-level fallback document: a denied or absent localStorage
 * (private mode, quota, SSR) still caches in memory so the picker does
 * not refetch on every provider switch.
 */
let memoryDocument: StoredCatalogDocument | null = null;

/**
 * Test hook: drops the in-memory fallback document so suites start from a
 * cold cache regardless of what earlier tests fetched. Production code
 * never calls this — the memory document is exactly a session cache.
 */
export function resetAgentModelCatalogMemory(): void {
  memoryDocument = null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Narrows one stored entry, dropping anything malformed rather than
 * trusting the JSON — a hand-edited or version-stale cache row must not
 * crash the picker.
 */
function narrowStoredEntry(value: unknown): FilteredCatalogEntry | null {
  if (!isRecord(value)) {
    return null;
  }
  const {
    contextLimit,
    deprecated,
    modelId,
    name,
    provider,
    reasoningOptions,
    releaseDate,
    vision,
  } = value;
  if (
    typeof modelId !== "string" ||
    modelId === "" ||
    typeof name !== "string" ||
    name === "" ||
    typeof releaseDate !== "string" ||
    releaseDate === "" ||
    typeof provider !== "string" ||
    provider === ""
  ) {
    return null;
  }
  return {
    provider,
    modelId,
    name,
    releaseDate,
    vision: vision === true,
    contextLimit:
      typeof contextLimit === "number" &&
      Number.isInteger(contextLimit) &&
      contextLimit > 0
        ? contextLimit
        : null,
    reasoningOptions: parseReasoningOptions(reasoningOptions),
    deprecated: deprecated === true,
  };
}

/** Narrows a parsed storage payload; anything wrong-shaped drops to null. */
function narrowStoredDocument(value: unknown): StoredCatalogDocument | null {
  if (
    !isRecord(value) ||
    typeof value.fetchedAt !== "number" ||
    !isRecord(value.providers)
  ) {
    return null;
  }
  const providers: StoredCatalogDocument["providers"] = {};
  for (const provider of NAMED_PROVIDER_IDS) {
    const raw = value.providers[provider];
    if (!Array.isArray(raw)) {
      continue;
    }
    const entries: FilteredCatalogEntry[] = [];
    for (const item of raw) {
      const entry = narrowStoredEntry(item);
      if (entry !== null) {
        entries.push(entry);
      }
    }
    providers[provider] = entries;
  }
  return { fetchedAt: value.fetchedAt, providers };
}

/** Reads the cache document: storage first, the memory fallback second. */
function readDocument(
  storage: AgentConfigStorage | null,
): StoredCatalogDocument | null {
  if (storage !== null) {
    try {
      const raw = storage.getItem(AGENT_MODEL_CATALOG_STORAGE_KEY);
      if (raw !== null) {
        const parsed: unknown = JSON.parse(raw);
        const document = narrowStoredDocument(parsed);
        if (document !== null) {
          return document;
        }
      }
    } catch {
      // Corrupt or unreadable storage falls through to the memory
      // fallback — a cache must never throw on read.
    }
  }
  return memoryDocument;
}

/**
 * Writes the cache document. The memory copy always lands; a denied
 * storage write (quota, private mode) is tolerated — the session keeps
 * its cache and the next load simply refetches.
 */
function writeDocument(
  storage: AgentConfigStorage | null,
  document: StoredCatalogDocument,
): void {
  memoryDocument = document;
  try {
    storage?.setItem(AGENT_MODEL_CATALOG_STORAGE_KEY, JSON.stringify(document));
  } catch {
    // Persistence is an optimization, not the truth — the fetched
    // entries still serve this call and the memory copy this session.
  }
}

/** The request-scoped stamped view of one provider's stored rows. */
function stampEntries(
  document: StoredCatalogDocument,
  provider: NamedProviderId,
): ModelCatalogEntryDto[] {
  const fetchedAt = new Date(document.fetchedAt).toISOString();
  return (document.providers[provider] ?? []).map((entry) => ({
    ...entry,
    provider,
    fetchedAt,
  }));
}

/** One readable clause naming why upstream could not serve. */
function upstreamReason(cause: unknown): string {
  if (cause instanceof Error && cause.message.trim() !== "") {
    return `models.dev could not be reached: ${cause.message.trim()}`;
  }
  return "models.dev could not be reached — the request never completed";
}

/**
 * The fetch-failed fork: prior rows for THIS provider serve as the stale
 * list (reason attached, labelled downstream); with nothing cached at
 * all the result is the honest `unavailable`.
 */
function staleOrUnavailable(
  document: StoredCatalogDocument | null,
  provider: NamedProviderId,
  reason: string,
): AgentModelCatalogResult {
  const entries = document === null ? [] : stampEntries(document, provider);
  if (entries.length === 0) {
    return { kind: "unavailable", reason };
  }
  return { entries, kind: "stale", reason };
}

/**
 * The shared fetch-filter-store core behind the picker's load and the
 * force-refresh. `force` bypasses the TTL gate; the fetch itself is
 * unconditional either way (see the module header — models.dev cannot
 * take a conditional request cross-origin).
 */
async function ensureCatalog(
  provider: NamedProviderId,
  deps: AgentModelCatalogDeps,
  force: boolean,
): Promise<AgentModelCatalogResult> {
  const storage =
    deps.storage === undefined ? getBrowserAgentConfigStorage() : deps.storage;
  const now = deps.now?.() ?? new Date();
  const document = readDocument(storage);

  if (
    !force &&
    document !== null &&
    now.getTime() - document.fetchedAt < AGENT_MODEL_CATALOG_TTL_MS
  ) {
    return {
      entries: stampEntries(document, provider),
      kind: "ready",
      outcome: "fresh-cache",
    };
  }

  const transport = deps.fetch ?? globalThis.fetch;
  const url = deps.catalogUrl ?? AGENT_MODEL_CATALOG_URL;
  let response: Response;
  try {
    response = await transport(url);
  } catch (cause) {
    return staleOrUnavailable(document, provider, upstreamReason(cause));
  }
  if (!response.ok) {
    return staleOrUnavailable(
      document,
      provider,
      `models.dev answered HTTP ${String(response.status)}`,
    );
  }
  let payload: unknown;
  try {
    payload = (await response.json()) as unknown;
  } catch {
    return staleOrUnavailable(
      document,
      provider,
      "models.dev answered a body that is not readable JSON",
    );
  }
  // A parseable 200 is only authoritative when it is actually shaped
  // like a models.dev entry for this provider — same gate as the server
  // refresh, so an error page can never license a cache wipe.
  if (!isProviderMap(payload, provider)) {
    return staleOrUnavailable(
      document,
      provider,
      `models.dev answered a body that is not a model catalog for "${provider}"`,
    );
  }

  // One blob refreshes every named provider's rows. The empty-filtered
  // rule holds per provider: a valid-but-empty result over prior rows is
  // indistinguishable from a transient anomaly, so the last good rows
  // stay and the document clock still advances.
  const providers: StoredCatalogDocument["providers"] = {};
  for (const id of NAMED_PROVIDER_IDS) {
    const filtered = filterProviderModels(
      id,
      extractProviderModels(payload, id),
      now,
    );
    const prior = document?.providers[id];
    providers[id] =
      filtered.length === 0 && prior !== undefined && prior.length > 0
        ? prior
        : filtered;
  }

  const outcome =
    document !== null &&
    JSON.stringify(document.providers) === JSON.stringify(providers)
      ? "not-modified"
      : "refetched";
  const next: StoredCatalogDocument = {
    fetchedAt: now.getTime(),
    providers,
  };
  writeDocument(storage, next);
  return {
    entries: stampEntries(next, provider),
    kind: "ready",
    outcome,
  };
}

/**
 * The picker's catalog read (D14): TTL-gated, stale-on-error. Resolves
 * rather than rejects — upstream failure is data (`unavailable`/`stale`),
 * so the sheet renders the honest reason instead of a thrown boundary.
 */
export async function loadAgentModelCatalog(
  provider: NamedProviderId,
  deps: AgentModelCatalogDeps = {},
): Promise<AgentModelCatalogResult> {
  return ensureCatalog(provider, deps, false);
}

/**
 * The force-refresh (D7) behind the shared refresh handle: unconditional
 * fetch, same stale-on-error fork, but `unavailable` throws — the
 * handle's error note carries the reason, matching the server refresh's
 * typed-error contract.
 */
export async function refreshAgentModelCatalog(
  provider: NamedProviderId,
  deps: AgentModelCatalogDeps = {},
): Promise<ModelCatalogRefreshResultDto> {
  const result = await ensureCatalog(provider, deps, true);
  if (result.kind === "unavailable") {
    throw new AgentModelCatalogError(result.reason);
  }
  const outcome: ModelCatalogRefreshOutcome =
    result.kind === "stale" ? "stale-served" : result.outcome;
  return { entries: [...result.entries], outcome };
}

/** The query key for one provider's catalog (or the shared prefix). */
export function agentModelCatalogQueryKey(
  provider?: NamedProviderId,
): readonly unknown[] {
  return provider === undefined
    ? AGENT_MODEL_CATALOG_QUERY_KEY
    : [...AGENT_MODEL_CATALOG_QUERY_KEY, provider];
}

/**
 * The query options the sheet's and chat view's `useQuery` spread —
 * provider-scoped key, browser-direct queryFn. `enabled`/`retry` stay
 * the caller's (both mount sites pass `enabled` on a named provider).
 */
export function agentModelCatalogQueryOptions(provider: NamedProviderId): {
  queryFn: () => Promise<AgentModelCatalogResult>;
  queryKey: readonly unknown[];
} {
  return {
    queryFn: () => loadAgentModelCatalog(provider),
    queryKey: agentModelCatalogQueryKey(provider),
  };
}
