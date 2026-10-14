/**
 * The persisted TanStack DB collections behind client-emitted agent chat
 * (PLAN-AGENT-CHAT Phase 3.4, D3): `agentConversations`/`agentMessages` as
 * LOCAL-ONLY persisted collections over the exact adapter path the Phase
 * 3.1 spike proved (`docs/architecture/adr-agent-chat.md`, "Persistence
 * spike results").
 *
 * The persistence layer is INJECTED ({@link AgentPersistence}) so the SAME
 * factory serves both runtimes: the browser binds
 * `@tanstack/browser-db-sqlite-persistence`'s OPFS adapter
 * (`browser.ts` here), and node tests bind the official
 * `@tanstack/node-db-sqlite-persistence` over a temp-file better-sqlite3
 * database — the spike pattern (`node-adapter.spike.test.ts` is the
 * standing proof the seam works). The `persistedCollectionOptions` import
 * below is node-safe: the browser package's module scope executes nothing
 * worker-touching (verified by the spike's SSR build AND by these tests
 * importing this module under vitest's node environment).
 *
 * Write protocol (the spike's load-bearing correction to the research
 * doc's example): every write goes through {@link commitAgentWrite} —
 * `createTransaction` with `collection.utils.acceptMutations(transaction)`
 * AWAITED inside `mutationFn`, the mutation in `tx.mutate(...)`, then
 * `tx.when("settled")`. Reading uses the `toArray` GETTER (never a call),
 * after `preload()` has hydrated the persisted rows.
 *
 * The collection ids are the STABLE SQLite table names — a random id would
 * silently abandon data on every reload (the spike's pinned mistake), so
 * they are exported constants and never minted.
 */

import { createCollection, createTransaction } from "@tanstack/db";
import { persistedCollectionOptions } from "@tanstack/browser-db-sqlite-persistence";
import type { PersistedCollectionPersistence } from "@tanstack/browser-db-sqlite-persistence";
import type { AgentConversationRow, AgentMessageRow } from "./rows";

/**
 * The injectable persistence seam: what
 * `createBrowserWASQLitePersistence` (browser) and
 * `createNodeSQLitePersistence` (node tests) both return.
 */
export type AgentPersistence = PersistedCollectionPersistence;

/** The stable table name of the conversations collection. */
export const AGENT_CONVERSATIONS_COLLECTION_ID = "agent-conversations";

/** The stable table name of the messages collection. */
export const AGENT_MESSAGES_COLLECTION_ID = "agent-messages";

/** Row format version of both collections (bump on row-shape changes). */
export const AGENT_COLLECTIONS_SCHEMA_VERSION = 1;

/** The conversations collection (the `AgentConversationRow` table). */
export type AgentConversationsCollection = ReturnType<
  typeof createAgentConversationsCollection
>;

/** The messages collection (the `AgentMessageRow` table). */
export type AgentMessagesCollection = ReturnType<
  typeof createAgentMessagesCollection
>;

/** The two collections agent chat persists through, already preloaded. */
export interface AgentCollections {
  readonly conversations: AgentConversationsCollection;
  readonly messages: AgentMessagesCollection;
}

function createAgentConversationsCollection(persistence: AgentPersistence) {
  return createCollection(
    persistedCollectionOptions<AgentConversationRow, string>({
      id: AGENT_CONVERSATIONS_COLLECTION_ID,
      getKey: (row) => row.id,
      persistence,
      schemaVersion: AGENT_COLLECTIONS_SCHEMA_VERSION,
    }),
  );
}

function createAgentMessagesCollection(persistence: AgentPersistence) {
  return createCollection(
    persistedCollectionOptions<AgentMessageRow, string>({
      id: AGENT_MESSAGES_COLLECTION_ID,
      getKey: (row) => row.id,
      persistence,
      schemaVersion: AGENT_COLLECTIONS_SCHEMA_VERSION,
    }),
  );
}

/**
 * Creates both collections over ONE shared persistence instance (the
 * adapters' documented multi-collection shape) and preloads them, so the
 * caller — the store factory, a test, the browser binding — receives rows
 * that already include everything durably written by any earlier session.
 */
export async function openAgentCollections(
  persistence: AgentPersistence,
): Promise<AgentCollections> {
  const conversations = createAgentConversationsCollection(persistence);
  const messages = createAgentMessagesCollection(persistence);
  await Promise.all([conversations.preload(), messages.preload()]);
  return { conversations, messages };
}

/**
 * The local-only write protocol as one helper (the spike's verified
 * sequence). `mutate` performs the `insert`/`update`/`delete` calls on the
 * collection; this function owns the transaction, the AWAITED
 * `acceptMutations` (without it the transaction settles before the persist
 * lands), and settling. `tx.mutate` auto-commits — `commit()` is never
 * called here.
 */
export async function commitAgentWrite(
  collection: AgentConversationsCollection | AgentMessagesCollection,
  mutate: () => void,
): Promise<void> {
  const tx = createTransaction({
    mutationFn: async ({ transaction }) => {
      await collection.utils.acceptMutations(transaction);
    },
  });
  tx.mutate(mutate);
  await tx.when("settled");
}
