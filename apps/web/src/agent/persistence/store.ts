/**
 * The agent chat store (PLAN-AGENT-CHAT Phase 3.4, D3): the conversation
 * lifecycle over the persisted collections — create / append / load
 * (resume) / list / delete-clears-rows / remove-messages — for
 * CLIENT-EMITTED chat, keyed entirely client-side (`crypto.randomUUID`):
 * ids are minted here and never taken from the server (the server mirror,
 * when the opt-in sync is on, records its OWN ids on the rows through the
 * outbox in `sync.ts`).
 *
 * Lifecycle mutations are SERIALIZED: create, append, delete and
 * removeMessages chain through one store-level promise queue, so two
 * mutations can never interleave at the persist awaits (the collection
 * writes settle OPFS/SQLite I/O inside `tx.when("settled")` — a real
 * await). Without the lock, an append racing a delete persists an orphan
 * message row (which the sync outbox counts forever and never delivers)
 * and the post-insert `updatedAt` stamp hits a vanished key and throws.
 * Each queued mutation runs to completion before the next starts; a
 * rejection belongs to its caller only — the queue itself never rejects.
 *
 * Resume is `loadConversation`: the same `UIMessage` objects the live chat
 * runs on (see `rows.ts` — parts verbatim, the row-level `createdAt`
 * revived), in per-conversation `seq` order, so reopening the chat panel
 * restores the transcript exactly. Delete clears BOTH tables' rows
 * (messages then the conversation) and, for an already-synced
 * conversation, queues the server-side delete on the outbox. For a
 * conversation whose create is still in flight (`serverId === null`) the
 * row removal IS the pending-create tombstone: the sync layer's create
 * path re-checks the local row when the ack lands and cleans the
 * just-created server copy up instead of stamping a dead row.
 *
 * Sync is OPT-IN (D3): `sync` in the deps carries the injected tRPC
 * transport plus the `enabled` flag (a boolean or a live reader, so the UI
 * can wire it to the agent config store's `syncEnabled` without remounting
 * the store). When enabled, every create/append/delete auto-triggers a
 * drain; {@link AgentChatStore.syncNow} is the explicit retry the chat UI
 * calls (its typed result is what the UI shows — failures never throw and
 * never go silent). When sync is absent or disabled the store is purely
 * local and every status reports idle.
 */

import type { UIMessage } from "@tanstack/ai";
import {
  AGENT_CONVERSATION_TITLE_MAX_LENGTH,
  AGENT_MESSAGE_MAX_PARTS,
  AGENT_MESSAGE_PARTS_MAX_SERIALIZED_LENGTH,
} from "@slopcad/api/limits";

import {
  commitAgentWrite,
  openAgentCollections,
  type AgentCollections,
  type AgentPersistence,
} from "./collections";
import {
  messageToRow,
  rowToMessage,
  type AgentConversationRow,
  type AgentMessageRow,
} from "./rows";
import {
  createAgentSyncOutbox,
  type AgentSyncStatus,
  type AgentSyncTransport,
} from "./sync";

/** The opt-in sync wiring: the injected tRPC seam plus its on/off switch. */
export interface AgentChatSyncConfig {
  readonly transport: AgentSyncTransport;
  /** Static flag or a live reader (e.g. the agent config's `syncEnabled`). */
  readonly enabled: boolean | (() => boolean);
}

export interface AgentChatStoreDeps {
  /** The injected persistence (browser OPFS in production, node in tests). */
  readonly persistence: AgentPersistence;
  /** Absent = client-only storage, no sync surface at all. */
  readonly sync?: AgentChatSyncConfig;
  /** Injectable clock (tests); defaults to real time. */
  readonly now?: () => Date;
  /** Injectable id mint (tests); defaults to `crypto.randomUUID()`. */
  readonly newId?: () => string;
}

/** One conversation plus its resumed messages, in order. */
export interface AgentLoadedConversation {
  readonly conversation: AgentConversationRow;
  readonly messages: readonly UIMessage[];
}

/**
 * Thrown when a message row was persisted but its conversation row vanished
 * before the post-insert `updatedAt` stamp could land. The store removes
 * the just-inserted message row BEFORE throwing, so this failure never
 * refers to data that is still there and no orphan row is left counting
 * against the sync backlog.
 */
export class AgentChatOrphanMessageError extends Error {
  constructor(conversationId: string, messageId: string) {
    super(
      `appendMessage: the conversation "${conversationId}" vanished while message "${messageId}" was being persisted; the orphan message row was removed.`,
    );
    this.name = "AgentChatOrphanMessageError";
  }
}

/** The lifecycle + sync surface the chat UI drives. */
export interface AgentChatStore {
  /** Creates a conversation row (title validated like the tRPC `create`). */
  createConversation(title: string): Promise<AgentConversationRow>;
  /**
   * Persists one message and stamps the conversation's `updatedAt`;
   * validates the same bounds the tRPC `append` enforces (parts count and
   * serialized length) BEFORE anything persists; triggers a sync drain
   * when sync is enabled.
   */
  appendMessage(
    conversationId: string,
    message: UIMessage,
  ): Promise<AgentMessageRow>;
  /** The resume read: conversation + revived messages in `seq` order, or null. */
  loadConversation(
    conversationId: string,
  ): Promise<AgentLoadedConversation | null>;
  /** All conversations, newest-updated first (the tRPC `list` order). */
  listConversations(): Promise<readonly AgentConversationRow[]>;
  /**
   * Clears the conversation's message rows and its own row; for an
   * already-synced conversation (and sync configured) queues the
   * server-side delete. For a still-unsynced conversation the row removal
   * itself is the pending-create tombstone the sync layer understands.
   * Returns whether the conversation existed.
   */
  deleteConversation(conversationId: string): Promise<boolean>;
  /**
   * Removes exactly the given persisted message rows in one transaction —
   * unknown ids are ignored, conversation rows are untouched. Returns when
   * the removal is durable.
   */
  removeMessages(messageIds: readonly string[]): Promise<void>;
  /** Explicit sync drain/retry; a no-op status when sync is off. */
  syncNow(): Promise<AgentSyncStatus>;
  getSyncStatus(): AgentSyncStatus;
  onSyncStatusChange(listener: (status: AgentSyncStatus) => void): () => void;
}

/** The status reported when no sync is configured: idle, nothing queued. */
const UNSYNCED_STATUS: AgentSyncStatus = {
  state: "idle",
  pending: 0,
  failure: null,
  stall: null,
};

export async function createAgentChatStore(
  deps: AgentChatStoreDeps,
): Promise<AgentChatStore> {
  const collections: AgentCollections = await openAgentCollections(
    deps.persistence,
  );
  const now = deps.now ?? (() => new Date());
  const newId = deps.newId ?? (() => globalThis.crypto.randomUUID());
  const outbox =
    deps.sync === undefined
      ? null
      : createAgentSyncOutbox({
          collections,
          transport: deps.sync.transport,
          now,
        });

  const isSyncEnabled = (): boolean => {
    if (deps.sync === undefined) return false;
    return typeof deps.sync.enabled === "function"
      ? deps.sync.enabled()
      : deps.sync.enabled;
  };

  /** Fires a drain when (and only when) sync is opted in — never awaited. */
  const maybeAutoFlush = (): void => {
    if (outbox !== null && isSyncEnabled()) {
      void outbox.flush();
    }
  };

  /**
   * The store-level write lock: each mutation's promise is chained onto the
   * previous one, so its body — reads, writes, and every persist await —
   * runs to completion before the next mutation's body starts. The chain
   * itself swallows rejections (they belong to the caller's promise), so
   * one failed mutation never stalls the lifecycle.
   */
  let lastWrite: Promise<void> = Promise.resolve();
  const runExclusively = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = lastWrite.then(operation);
    lastWrite = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };

  return {
    createConversation(title) {
      return runExclusively(async () => {
        const trimmed = title.trim();
        if (trimmed.length === 0) {
          throw new RangeError(
            "createConversation: the title is empty after trimming.",
          );
        }
        if (trimmed.length > AGENT_CONVERSATION_TITLE_MAX_LENGTH) {
          throw new RangeError(
            `createConversation: the title exceeds ${AGENT_CONVERSATION_TITLE_MAX_LENGTH} characters.`,
          );
        }
        const timestamp = now().toISOString();
        const row: AgentConversationRow = {
          id: newId(),
          title: trimmed,
          createdAt: timestamp,
          updatedAt: timestamp,
          serverId: null,
        };
        await commitAgentWrite(collections.conversations, () => {
          collections.conversations.insert(row);
        });
        maybeAutoFlush();
        return row;
      });
    },

    appendMessage(conversationId, message) {
      return runExclusively(async () => {
        if (!collections.conversations.has(conversationId)) {
          throw new RangeError(
            `appendMessage: unknown conversation "${conversationId}".`,
          );
        }
        if (message.parts.length > AGENT_MESSAGE_MAX_PARTS) {
          throw new RangeError(
            `appendMessage: the message carries ${message.parts.length} parts (bound: ${AGENT_MESSAGE_MAX_PARTS}).`,
          );
        }
        // The third sibling bound — the same serialized measurement the
        // tRPC `append` enforces server-side. Rejecting here keeps an
        // over-cap message out of the persisted outbox, where its
        // deterministic server rejection would head-of-line-block the
        // whole sync queue forever.
        const serializedPartsLength = JSON.stringify(message.parts).length;
        if (serializedPartsLength > AGENT_MESSAGE_PARTS_MAX_SERIALIZED_LENGTH) {
          throw new RangeError(
            `appendMessage: the message parts serialize to ${serializedPartsLength} characters (bound: ${AGENT_MESSAGE_PARTS_MAX_SERIALIZED_LENGTH}).`,
          );
        }
        const highestSeq = collections.messages.toArray.reduce(
          (max, row) =>
            row.conversationId === conversationId
              ? Math.max(max, row.seq)
              : max,
          0,
        );
        const row = messageToRow(message, conversationId, highestSeq + 1);
        await commitAgentWrite(collections.messages, () => {
          collections.messages.insert(row);
        });
        if (!collections.conversations.has(conversationId)) {
          // Defense-in-depth under the write lock (no lifecycle mutation
          // can remove the row mid-append): if anything else ever does,
          // never leave the just-inserted row behind as an orphan — remove
          // it first, THEN fail, so the error never describes data that is
          // still persisted.
          await commitAgentWrite(collections.messages, () => {
            collections.messages.delete([row.id]);
          });
          throw new AgentChatOrphanMessageError(conversationId, row.id);
        }
        await commitAgentWrite(collections.conversations, () => {
          collections.conversations.update(conversationId, (draft) => {
            draft.updatedAt = row.createdAt;
          });
        });
        maybeAutoFlush();
        return row;
      });
    },

    async loadConversation(conversationId) {
      // First-sync-aware reads: the resume path must see the preloaded
      // rows, never an optimistic pre-hydration snapshot.
      const [conversationRows, messageRows] = await Promise.all([
        collections.conversations.toArrayWhenReady(),
        collections.messages.toArrayWhenReady(),
      ]);
      const conversation = conversationRows.find(
        (row) => row.id === conversationId,
      );
      if (conversation === undefined) return null;
      const messages = messageRows
        .filter((row) => row.conversationId === conversationId)
        .sort((a, b) => a.seq - b.seq || a.id.localeCompare(b.id))
        .map(rowToMessage);
      return { conversation, messages };
    },

    async listConversations() {
      const rows = await collections.conversations.toArrayWhenReady();
      return rows
        .slice()
        .sort(
          (a, b) =>
            b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id),
        );
    },

    deleteConversation(conversationId) {
      return runExclusively(async () => {
        const conversation = collections.conversations.get(conversationId);
        if (conversation === undefined) return false;
        const messageKeys = collections.messages.toArray
          .filter((row) => row.conversationId === conversationId)
          .map((row) => row.id);
        if (messageKeys.length > 0) {
          await commitAgentWrite(collections.messages, () => {
            collections.messages.delete(messageKeys);
          });
        }
        // Re-read right before the removal commit — no await between this
        // read and the optimistic delete below, so the decision is atomic
        // with the removal. If the sync engine's create ack landed while
        // the message rows were being cleared, the row now carries the
        // serverId the tombstone needs; skipping this re-read would delete
        // a row the ack just stamped and leave the server copy unremovable.
        const conversationNow = collections.conversations.get(conversationId);
        if (conversationNow === undefined) return false;
        await commitAgentWrite(collections.conversations, () => {
          collections.conversations.delete(conversationId);
        });
        if (conversationNow.serverId !== null && outbox !== null) {
          outbox.enqueueDelete(conversationId, conversationNow.serverId);
          maybeAutoFlush();
        }
        // For a still-unsynced conversation (serverId === null) nothing is
        // enqueued: the durable row removal IS the pending-create tombstone
        // — the sync layer's create path re-checks the local row when its
        // ack lands and cleans the just-created server copy up.
        return true;
      });
    },

    removeMessages(messageIds) {
      return runExclusively(async () => {
        const present = new Set(
          collections.messages.toArray.map((row) => row.id),
        );
        const keys = [...new Set(messageIds)].filter((id) => present.has(id));
        if (keys.length === 0) return;
        await commitAgentWrite(collections.messages, () => {
          collections.messages.delete(keys);
        });
      });
    },

    async syncNow() {
      if (outbox === null || !isSyncEnabled()) {
        return outbox === null ? UNSYNCED_STATUS : outbox.getStatus();
      }
      return outbox.flush();
    },

    getSyncStatus() {
      return outbox === null ? UNSYNCED_STATUS : outbox.getStatus();
    },

    onSyncStatusChange(listener) {
      if (outbox === null) return () => {};
      return outbox.onStatusChange(listener);
    },
  };
}
