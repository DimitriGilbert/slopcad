/**
 * The agent chat store (PLAN-AGENT-CHAT Phase 3.4, D3): the conversation
 * lifecycle over the persisted collections — create / append / load
 * (resume) / list / delete-clears-rows — for CLIENT-EMITTED chat, keyed
 * entirely client-side (`crypto.randomUUID`): ids are minted here and
 * never taken from the server (the server mirror, when the opt-in sync is
 * on, records its OWN ids on the rows through the outbox in `sync.ts`).
 *
 * Resume is `loadConversation`: the same `UIMessage` objects the live chat
 * runs on (see `rows.ts` — Dates revived, unknown parts verbatim), in
 * per-conversation `seq` order, so reopening the chat panel restores the
 * transcript exactly. Delete clears BOTH tables' rows (messages then the
 * conversation) and, for an already-synced conversation, queues the
 * server-side delete on the outbox.
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

/** The lifecycle + sync surface the chat UI drives. */
export interface AgentChatStore {
  /** Creates a conversation row (title validated like the tRPC `create`). */
  createConversation(title: string): Promise<AgentConversationRow>;
  /**
   * Persists one message and stamps the conversation's `updatedAt`;
   * triggers a sync drain when sync is enabled.
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
   * server-side delete. Returns whether the conversation existed.
   */
  deleteConversation(conversationId: string): Promise<boolean>;
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

  return {
    async createConversation(title) {
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
    },

    async appendMessage(conversationId, message) {
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
      const highestSeq = collections.messages.toArray.reduce(
        (max, row) =>
          row.conversationId === conversationId ? Math.max(max, row.seq) : max,
        0,
      );
      const row = messageToRow(message, conversationId, highestSeq + 1);
      await commitAgentWrite(collections.messages, () => {
        collections.messages.insert(row);
      });
      await commitAgentWrite(collections.conversations, () => {
        collections.conversations.update(conversationId, (draft) => {
          draft.updatedAt = row.createdAt;
        });
      });
      maybeAutoFlush();
      return row;
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

    async deleteConversation(conversationId) {
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
      await commitAgentWrite(collections.conversations, () => {
        collections.conversations.delete(conversationId);
      });
      if (conversation.serverId !== null && outbox !== null) {
        outbox.enqueueDelete(conversationId, conversation.serverId);
        maybeAutoFlush();
      }
      return true;
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
