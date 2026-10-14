import { relations } from "drizzle-orm";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

import { user } from "./auth";

/**
 * The id-based share store: the server-side twin of the URL-fragment
 * share link. A row is one uploaded native `slopcad` document behind a
 * short public id — `/viewer?p=<id>` — for media that truncate long
 * URLs. The content is the same canonical native text the fragment
 * codec compresses (plain here; the database stores it uncompressed),
 * validated by the format's own parser before it ever enters the store.
 *
 * Reads are public (the viewer route is public); creation is an
 * authenticated action. The creator reference dissolves with the account
 * (`set null`) — a shared link outlives its author, exactly like a
 * fragment link would.
 */
export const shareLink = sqliteTable(
  "share_link",
  {
    /** The short public id a `/viewer?p=` link carries (base62, 10 chars). */
    id: text("id").primaryKey(),
    /** Who uploaded the share; severed (not cascaded) when the account goes. */
    createdBy: text("created_by").references(() => user.id, {
      onDelete: "set null",
    }),
    /** The serialized native document exactly as uploaded (canonical JSON text). */
    nativeContent: text("native_content").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .notNull(),
  },
  (table) => [index("share_link_createdBy_idx").on(table.createdBy)],
);

export const shareLinkRelations = relations(shareLink, ({ one }) => ({
  creator: one(user, {
    fields: [shareLink.createdBy],
    references: [user.id],
  }),
}));
