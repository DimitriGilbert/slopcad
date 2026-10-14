import { relations, sql } from "drizzle-orm";
import {
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

import { user } from "./auth";

/**
 * Generic per-user key/value options (D13): a single store every per-user
 * toggle rides — never a dedicated flag table per feature. Server AI is
 * gated by the row `name = "agent.server-ai"`, `value = "true"`. The typed
 * read accessor ships with the API layer; how rows get written (admin UI,
 * entitlements) is deliberately deferred.
 */
export const userOptions = sqliteTable(
  "user_options",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    value: text("value").notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [
    uniqueIndex("user_options_userId_name_uidx").on(table.userId, table.name),
  ],
);

export const userOptionsRelations = relations(userOptions, ({ one }) => ({
  user: one(user, {
    fields: [userOptions.userId],
    references: [user.id],
  }),
}));
