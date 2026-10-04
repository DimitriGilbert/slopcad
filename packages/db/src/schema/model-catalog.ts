import { sql } from "drizzle-orm";
import {
  integer,
  primaryKey,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core";

/**
 * The models.dev catalog cache (agent chat, Phase 1.1): one row per
 * (provider, model) that survives the picker filter, refreshed server-side
 * with ETag revalidation (PLAN-AGENT-CHAT.md §1.1). Plain cache data — no
 * user or project relations — so a provider's rows can be truncated and
 * refetched at any time.
 */

/** One models.dev `reasoning_options` entry, stored verbatim. */
export type ModelReasoningOption = {
  type: "effort" | "budget_tokens" | "toggle";
  /** Offered values for `effort`-type options, e.g. `["low","medium","high"]`. */
  values?: string[];
  /** Minimum for `budget_tokens`-type options. */
  min?: number;
};

export const modelCatalogEntries = sqliteTable(
  "model_catalog_entries",
  {
    /** models.dev provider id, e.g. `"anthropic"`. */
    provider: text("provider").notNull(),
    modelId: text("model_id").notNull(),
    name: text("name").notNull(),
    /** models.dev `release_date`, string `YYYY-MM-DD`, stored verbatim. */
    releaseDate: text("release_date").notNull(),
    vision: integer("vision", { mode: "boolean" }).notNull(),
    /** models.dev `limit.context`; null when the model declares none. */
    contextLimit: integer("context_limit"),
    /** models.dev `reasoning_options`; null when the model declares none. */
    reasoningOptions: text("reasoning_options", { mode: "json" }).$type<
      ModelReasoningOption[]
    >(),
    deprecated: integer("deprecated", { mode: "boolean" }).notNull(),
    fetchedAt: integer("fetched_at", { mode: "timestamp_ms" })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .notNull(),
  },
  (table) => [primaryKey({ columns: [table.provider, table.modelId] })],
);

export const modelCatalogMeta = sqliteTable("model_catalog_meta", {
  provider: text("provider").primaryKey(),
  /** Last-seen ETag for `If-None-Match` revalidation; null when upstream sent none. */
  etag: text("etag"),
  fetchedAt: integer("fetched_at", { mode: "timestamp_ms" })
    .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
    .notNull(),
});
