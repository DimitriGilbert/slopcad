import { relations, sql } from "drizzle-orm";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

import { user } from "./auth";
import { project } from "./projects";

/**
 * Server-emitted agent chat persistence (D3, Phase 1.4): conversations
 * belong to a user, optionally scoped to a project, and carry their messages
 * as JSON parts. Client-emitted chat never touches these tables (TanStack DB
 * on WASM SQLite instead); the opt-in sync path appends here when enabled.
 */
export const agentConversations = sqliteTable(
  "agent_conversations",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    projectId: text("project_id").references(() => project.id, {
      // Nullable scope: deleting the project detaches the conversation
      // rather than destroying the user's chat history.
      onDelete: "set null",
    }),
    title: text("title").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [
    index("agent_conversations_userId_idx").on(table.userId),
    index("agent_conversations_projectId_idx").on(table.projectId),
  ],
);

export const agentMessages = sqliteTable(
  "agent_messages",
  {
    id: text("id").primaryKey(),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => agentConversations.id, { onDelete: "cascade" }),
    role: text("role").notNull(),
    /**
     * The message parts, stored as JSON. The concrete part shapes belong to
     * the chat runtime (the TanStack AI parts model, Phase 3); the database
     * keeps them opaque, so `unknown` is the honest column type here.
     */
    parts: text("parts", { mode: "json" }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .notNull(),
  },
  (table) => [
    index("agent_messages_conversationId_idx").on(table.conversationId),
  ],
);

export const agentConversationsRelations = relations(
  agentConversations,
  ({ one, many }) => ({
    user: one(user, {
      fields: [agentConversations.userId],
      references: [user.id],
    }),
    project: one(project, {
      fields: [agentConversations.projectId],
      references: [project.id],
    }),
    messages: many(agentMessages),
  }),
);

export const agentMessagesRelations = relations(agentMessages, ({ one }) => ({
  conversation: one(agentConversations, {
    fields: [agentMessages.conversationId],
    references: [agentConversations.id],
  }),
}));
