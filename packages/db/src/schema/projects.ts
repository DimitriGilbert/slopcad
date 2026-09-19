import { relations, sql } from "drizzle-orm";
import {
  sqliteTable,
  text,
  integer,
  index,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

import { user } from "./auth";

/**
 * The persistence core (Phase 31): projects own documents, documents own
 * their version history, and every row roots back to an authenticated
 * user. The CAD content itself is NOT modeled here beyond the native
 * document's canonical text: `documentVersion.nativeContent` stores the
 * serialized native `slopcad` document (the dual-persisted history, the
 * transaction log plus the state at the cursor) — plain data, never kernel
 * objects, so the database stays ignorant of geometry and the CAD packages
 * stay database-independent.
 */

export const project = sqliteTable(
  "project",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description"),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [index("project_ownerId_idx").on(table.ownerId)],
);

export const document = sqliteTable(
  "document",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => project.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [index("document_projectId_idx").on(table.projectId)],
);

export const documentVersion = sqliteTable(
  "document_version",
  {
    id: text("id").primaryKey(),
    documentId: text("document_id")
      .notNull()
      .references(() => document.id, { onDelete: "cascade" }),
    /** The 1-based save ordinal within the document; never reused. */
    version: integer("version").notNull(),
    /** The serialized native document (canonical JSON text). */
    nativeContent: text("native_content").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .notNull(),
  },
  (table) => [
    uniqueIndex("document_version_document_version_uidx").on(
      table.documentId,
      table.version,
    ),
  ],
);

export const projectRelations = relations(project, ({ one, many }) => ({
  owner: one(user, {
    fields: [project.ownerId],
    references: [user.id],
  }),
  documents: many(document),
}));

export const documentRelations = relations(document, ({ one, many }) => ({
  project: one(project, {
    fields: [document.projectId],
    references: [project.id],
  }),
  versions: many(documentVersion),
}));

export const documentVersionRelations = relations(
  documentVersion,
  ({ one }) => ({
    document: one(document, {
      fields: [documentVersion.documentId],
      references: [document.id],
    }),
  }),
);
