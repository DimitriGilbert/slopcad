/**
 * The model-catalog router (agent chat, Phase 1.1 — PLAN-AGENT-CHAT.md
 * §1.1, D7/D14): the server-side models.dev cache behind the model picker.
 *
 * The catalog is strictly PROVIDER-SCOPED (D14): `list({ provider })`
 * returns entries for the caller's configured provider alone and nothing
 * here ever aggregates models across providers. The `openai-compatible`
 * provider is served client-side instead (Phase 1.2 queries the endpoint's
 * own `/models` API browser-direct), so `list` answers it with an empty
 * array and `refresh` refuses it outright.
 *
 * Caching (docs/research/models-dev-api.md §5): the whole `api.json` blob
 * is fetched at most once per 24h per provider (TTL), revalidated with the
 * stored `If-None-Match` ETag (a 304 keeps the rows and only bumps
 * `fetchedAt`), `force` bypasses the TTL, and an upstream failure serves
 * the last good rows — a typed BAD_GATEWAY surfaces only when there are
 * no rows to serve at all.
 *
 * ATTRIBUTION: the catalog data originates from models.dev (MIT License,
 * github.com/anomalyco/models.dev), cached server-side and served to
 * signed-in users as filtered subsets — permitted by the license with this
 * notice retained; the settings UI repeats it as a footnote (Phase 4.5).
 */

import { type SlopcadDatabase } from "@slopcad/db";
import {
  modelCatalogEntries,
  modelCatalogMeta,
  type ModelReasoningOption,
} from "@slopcad/db/schema/model-catalog";
import { env } from "@slopcad/env/server";
import { TRPCError } from "@trpc/server";
import { asc, desc, eq } from "drizzle-orm";
import { z } from "zod";

import { protectedProcedure } from "../index";
import {
  OPENAI_COMPATIBLE_PROVIDER_ID,
  PROVIDER_IDS,
  type NamedProviderId,
} from "../providers";
import {
  extractProviderModels,
  filterProviderModels,
} from "./model-catalog-filter";

/** Cache lifetime of a fetched catalog: 24 hours (D7). */
export const MODEL_CATALOG_TTL_MS = 24 * 60 * 60 * 1000;

/** A provider whose models the models.dev catalog lists. */
export type NamedCatalogProvider = NamedProviderId;

/**
 * Every provider id the model-catalog surface accepts (D6) — the shared
 * single source verbatim (`../providers`), so this module carries no
 * provider literals of its own and no default is ever picked for anyone
 * (D5).
 */
export const CATALOG_PROVIDERS = PROVIDER_IDS;

const catalogProviderInput = z.enum(CATALOG_PROVIDERS);

/** The wire form of a `model_catalog_entries` row (timestamps as ISO). */
export interface ModelCatalogEntryDto {
  readonly provider: NamedCatalogProvider;
  readonly modelId: string;
  readonly name: string;
  readonly releaseDate: string;
  readonly vision: boolean;
  readonly contextLimit: number | null;
  readonly reasoningOptions: ModelReasoningOption[] | null;
  readonly deprecated: boolean;
  readonly fetchedAt: string;
}

/** What one refresh did — drives the picker's refresh affordance. */
export type ModelCatalogRefreshOutcome =
  "fresh-cache" | "refetched" | "not-modified" | "stale-served";

export interface ModelCatalogRefreshResultDto {
  readonly outcome: ModelCatalogRefreshOutcome;
  readonly entries: ModelCatalogEntryDto[];
}

export interface ModelCatalogRouterDeps {
  readonly db: SlopcadDatabase;
  /** Clock for the TTL and the recency filter; production uses the wall clock. */
  readonly now?: () => Date;
  /** Transport; production uses the global fetch (tests inject a mock). */
  readonly fetch?: typeof globalThis.fetch;
  /** Catalog source; production reads `MODEL_CATALOG_URL` from the env. */
  readonly catalogUrl?: string;
}

/** Reads the cached rows for one provider, newest release first (D14). */
async function selectCatalogEntries(
  db: SlopcadDatabase,
  provider: NamedCatalogProvider,
): Promise<ModelCatalogEntryDto[]> {
  const rows = await db
    .select()
    .from(modelCatalogEntries)
    .where(eq(modelCatalogEntries.provider, provider))
    .orderBy(
      desc(modelCatalogEntries.releaseDate),
      asc(modelCatalogEntries.modelId),
    );
  return rows.map((row) => ({
    provider,
    modelId: row.modelId,
    name: row.name,
    releaseDate: row.releaseDate,
    vision: row.vision,
    contextLimit: row.contextLimit,
    reasoningOptions: row.reasoningOptions,
    deprecated: row.deprecated,
    fetchedAt: row.fetchedAt.toISOString(),
  }));
}

/**
 * Stale-on-error: an unreachable/failed upstream keeps the last good rows
 * (and their `fetchedAt`, so the next call retries). Only when there is
 * nothing cached at all does the caller see a typed error.
 */
async function staleOrError(
  db: SlopcadDatabase,
  provider: NamedCatalogProvider,
  cause: unknown,
): Promise<ModelCatalogRefreshResultDto> {
  const entries = await selectCatalogEntries(db, provider);
  if (entries.length === 0) {
    throw new TRPCError({
      code: "BAD_GATEWAY",
      message: `The model catalog for "${provider}" is unavailable upstream and no cached entries exist to serve.`,
      cause,
    });
  }
  return { outcome: "stale-served", entries };
}

export function createModelCatalogRouter(deps: ModelCatalogRouterDeps) {
  const { db } = deps;
  return {
    /**
     * The picker's model source for one provider — never an aggregate
     * (D14). An uncached provider answers an empty array, not an error,
     * and `openai-compatible` is always empty (served client-side).
     */
    list: protectedProcedure
      .input(z.object({ provider: catalogProviderInput }))
      .query(async ({ input }) => {
        if (input.provider === OPENAI_COMPATIBLE_PROVIDER_ID) {
          return [];
        }
        return selectCatalogEntries(db, input.provider);
      }),

    /**
     * Refetches `MODEL_CATALOG_URL` for one provider: TTL-gated unless
     * `force`, ETag-revalidated (304 keeps the rows, bumps `fetchedAt`),
     * stale-on-error upstream-side. The BYO-endpoint provider is refused
     * with a typed error — its models are never catalog-backed (D14).
     */
    refresh: protectedProcedure
      .input(
        z.object({
          provider: catalogProviderInput,
          force: z.boolean().optional(),
        }),
      )
      .mutation(async ({ input }) => {
        if (input.provider === OPENAI_COMPATIBLE_PROVIDER_ID) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message:
              'Provider "openai-compatible" has no catalog: its models are discovered from the configured endpoint itself.',
          });
        }
        const provider = input.provider;
        const force = input.force ?? false;
        const now = deps.now?.() ?? new Date();

        const metaRows = await db
          .select()
          .from(modelCatalogMeta)
          .where(eq(modelCatalogMeta.provider, provider))
          .limit(1);
        const meta = metaRows[0];
        const withinTtl =
          meta !== undefined &&
          now.getTime() - meta.fetchedAt.getTime() < MODEL_CATALOG_TTL_MS;
        if (withinTtl && !force) {
          return {
            outcome: "fresh-cache",
            entries: await selectCatalogEntries(db, provider),
          };
        }

        const storedEtag = meta?.etag;
        const headers: Record<string, string> =
          storedEtag !== null && storedEtag !== undefined
            ? { "If-None-Match": storedEtag }
            : {};
        let response: Response;
        try {
          response = await (deps.fetch ?? globalThis.fetch)(
            deps.catalogUrl ?? env.MODEL_CATALOG_URL,
            { headers },
          );
        } catch (cause) {
          return staleOrError(db, provider, cause);
        }

        // Unchanged upstream: keep the rows, refresh the TTL clock only.
        if (response.status === 304 && meta !== undefined) {
          await db
            .update(modelCatalogMeta)
            .set({ fetchedAt: now })
            .where(eq(modelCatalogMeta.provider, provider));
          return {
            outcome: "not-modified",
            entries: await selectCatalogEntries(db, provider),
          };
        }

        if (!response.ok) {
          return staleOrError(
            db,
            provider,
            `upstream responded with HTTP ${response.status}`,
          );
        }

        let payload: unknown;
        try {
          payload = JSON.parse(await response.text());
        } catch (cause) {
          return staleOrError(db, provider, cause);
        }

        const filtered = filterProviderModels(
          provider,
          extractProviderModels(payload, provider),
          now,
        );
        const etag = response.headers.get("etag");
        await db.transaction(async (tx) => {
          await tx
            .delete(modelCatalogEntries)
            .where(eq(modelCatalogEntries.provider, provider));
          if (filtered.length > 0) {
            await tx
              .insert(modelCatalogEntries)
              .values(filtered.map((entry) => ({ ...entry, fetchedAt: now })));
          }
          await tx
            .insert(modelCatalogMeta)
            .values({ provider, etag, fetchedAt: now })
            .onConflictDoUpdate({
              target: modelCatalogMeta.provider,
              set: { etag, fetchedAt: now },
            });
        });
        return {
          outcome: "refetched",
          entries: filtered.map((entry) => ({
            ...entry,
            provider,
            fetchedAt: now.toISOString(),
          })),
        };
      }),

    /**
     * Which of the supported provider ids have a catalog cache — drives
     * the picker's provider options (never defaults anything, D5).
     */
    providers: protectedProcedure.query(async () => {
      const rows = await db
        .select({ provider: modelCatalogMeta.provider })
        .from(modelCatalogMeta);
      const cached = new Set(rows.map((row) => row.provider));
      return CATALOG_PROVIDERS.filter((id) => cached.has(id));
    }),
  };
}
