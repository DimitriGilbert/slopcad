/**
 * The opt-in sync outbox for client-emitted agent chat (PLAN-AGENT-CHAT
 * Phase 3.4, D3): when the user enables sync, conversation creates and
 * message appends are pushed through the Phase 1.4 tRPC
 * `agentConversations` router — the SAME rows local persistence stores,
 * via the SAME row state. The rows ARE the durable queue:
 *
 * - a conversation row with `serverId === null` is a pending CREATE (the
 *   router mints its own ids, so the mapping local→server is durably
 *   recorded on the row once the create is acknowledged);
 * - a message row with `syncedAt === null` is a pending APPEND;
 * - a server-side DELETE of an already-synced conversation is a transient
 *   tombstone in memory (the local rows are already cleared — the
 *   lifecycle contract — so there is nothing durable left to carry it;
 *   a reload before delivery leaves the server copy in place, the honest
 *   boundary of an opt-in one-way mirror).
 *
 * Delivery is STRICTLY ORDERED (creates → appends → deletes; seq order
 * within a conversation) and AT-LEAST-ONCE: the router's `append` carries
 * no client idempotency key (the server mints its own message ids), so a
 * crash between an acknowledged append and the local `syncedAt` stamp can
 * re-deliver that one append. Failing ops STAY queued (head-of-line, which
 * is what preserves ordering) and the failure surfaces as a TYPED result —
 * {@link AgentSyncStatus}/{@link AgentSyncFailure} — never a throw, never
 * a silent drop; the next `flush()` is the retry.
 *
 * The transport is INJECTED as plain async functions
 * ({@link AgentSyncTransport}) mirroring the router's zod input/output
 * shapes exactly, because the page-level tRPC proxy
 * (`@trpc/tanstack-react-query`'s `useTRPC()`) exposes only
 * `mutationOptions()`/`mutationKey()` — no page-agnostic `mutate` — so the
 * chat panel binds its own client calls into this seam (e.g. a
 * `useMutation(...)` handle's `mutateAsync`).
 */

import type {
  AgentConversationDto,
  AgentMessageDto,
  AgentMessageRole,
} from "@slopcad/api/routers/agent-conversations";

import { commitAgentWrite, type AgentCollections } from "./collections";
import {
  messageRowPartsToWire,
  type AgentConversationRow,
  type AgentMessageRow,
} from "./rows";

/**
 * The `create` input — mirrors the router's zod shape for `title` (bounds
 * enforced server-side), and DELIBERATELY omits the router's optional
 * `projectId`: the client-side row this outbox syncs from
 * ({@link AgentConversationRow}) carries no project id, so client-emitted
 * conversations are always created unscoped (server `projectId: null`).
 */
export interface AgentSyncCreateInput {
  readonly title: string;
}

/**
 * The `append` input — mirrors the router's `agentAppendInput` exactly
 * (conversationId + role enum + opaque parts array).
 */
export interface AgentSyncAppendInput {
  readonly conversationId: string;
  readonly role: AgentMessageRole;
  readonly parts: unknown[];
}

/** The `delete` input — mirrors the router's shape. */
export interface AgentSyncDeleteInput {
  readonly conversationId: string;
}

/**
 * The injected server seam: one function per tRPC mutation the outbox
 * drives. Inputs/outputs are the router's own DTO shapes.
 */
export interface AgentSyncTransport {
  readonly createConversation: (
    input: AgentSyncCreateInput,
  ) => Promise<AgentConversationDto>;
  readonly appendMessage: (
    input: AgentSyncAppendInput,
  ) => Promise<AgentMessageDto>;
  readonly deleteConversation: (input: AgentSyncDeleteInput) => Promise<void>;
}

/** Which outbox operation a failure belongs to. */
export type AgentSyncOpKind =
  | "create-conversation"
  | "append-message"
  | "delete-conversation"
  | "unexpected";

/**
 * One surfaced sync failure: the operation kind, the LOCAL conversation
 * (and message) it belongs to, and the thrown value (a tRPC client error,
 * a corrupt-row TypeError, …) for the UI to render.
 */
export interface AgentSyncFailure {
  readonly kind: AgentSyncOpKind;
  readonly conversationId: string;
  readonly messageId: string | null;
  readonly error: unknown;
}

export type AgentSyncState = "idle" | "syncing" | "failed";

/** The typed sync result the chat UI shows — never a throw. */
export interface AgentSyncStatus {
  readonly state: AgentSyncState;
  /** Ops still queued for delivery (creates + appends + deletes). */
  readonly pending: number;
  /** The failure that stalled the queue, when `state === "failed"`. */
  readonly failure: AgentSyncFailure | null;
}

export interface AgentSyncOutboxDeps {
  readonly collections: AgentCollections;
  readonly transport: AgentSyncTransport;
  readonly now?: () => Date;
}

/** The outbox surface the chat store (and through it the UI) consumes. */
export interface AgentSyncOutbox {
  /**
   * Drains the queue in order. Never rejects; every failure — transport
   * or local-write — surfaces as the returned status. Concurrent calls
   * coalesce onto the in-flight drain, and work that arrives while a drain
   * is finishing is picked up by a trailing drain instead of being missed.
   */
  flush(): Promise<AgentSyncStatus>;
  /** Queues a server-side delete for an already-synced conversation. */
  enqueueDelete(conversationId: string, serverId: string): void;
  /** Ops currently queued for delivery. */
  pendingCount(): number;
  getStatus(): AgentSyncStatus;
  /** Subscribes to status changes; returns the unsubscribe function. */
  onStatusChange(listener: (status: AgentSyncStatus) => void): () => void;
}

/** One derived queue entry — re-derived from live rows on every step. */
type AgentSyncOp =
  | {
      readonly kind: "create-conversation";
      readonly conversation: AgentConversationRow;
    }
  | {
      readonly kind: "append-message";
      readonly message: AgentMessageRow;
      /** The SERVER conversation id (derivation guarantees it is resolved). */
      readonly serverConversationId: string;
    }
  | {
      readonly kind: "delete-conversation";
      readonly conversationId: string;
      readonly serverId: string;
    };

interface PendingDelete {
  readonly conversationId: string;
  readonly serverId: string;
}

/** Conversations in create order (createdAt, then id as the tiebreak). */
function inCreationOrder(
  a: AgentConversationRow,
  b: AgentConversationRow,
): number {
  return a.createdAt === b.createdAt
    ? a.id.localeCompare(b.id)
    : a.createdAt.localeCompare(b.createdAt);
}

/**
 * Derives the NEXT op from the live row state — creates first (appends
 * need the serverId a create acks), then appends in per-conversation seq
 * order, then deletes. `null` when the queue is drained. Deriving fresh on
 * every step is what makes the outbox see rows written mid-drain and rows
 * deleted mid-drain (a deleted conversation's messages vanish with it).
 */
function deriveNextOp(
  collections: AgentCollections,
  pendingDeletes: readonly PendingDelete[],
): AgentSyncOp | null {
  const uncreated = collections.conversations.toArray
    .filter((row) => row.serverId === null)
    .sort(inCreationOrder);
  const firstConversation = uncreated[0];
  if (firstConversation !== undefined) {
    return { kind: "create-conversation", conversation: firstConversation };
  }
  const conversationOrderBy = new Map(
    collections.conversations.toArray.map(
      (row) => [row.id, row.createdAt] as const,
    ),
  );
  const unsynced = collections.messages.toArray
    .filter((row) => row.syncedAt === null)
    .sort((a, b) => {
      const conversationDelta = (
        conversationOrderBy.get(a.conversationId) ?? ""
      ).localeCompare(conversationOrderBy.get(b.conversationId) ?? "");
      return conversationDelta !== 0
        ? conversationDelta
        : a.seq - b.seq || a.id.localeCompare(b.id);
    });
  for (const message of unsynced) {
    const conversation = collections.conversations.get(message.conversationId);
    if (conversation === undefined || conversation.serverId === null) continue;
    return {
      kind: "append-message",
      message,
      serverConversationId: conversation.serverId,
    };
  }
  const nextDelete = pendingDeletes[0];
  if (nextDelete !== undefined) {
    return {
      kind: "delete-conversation",
      conversationId: nextDelete.conversationId,
      serverId: nextDelete.serverId,
    };
  }
  return null;
}

export function createAgentSyncOutbox(
  deps: AgentSyncOutboxDeps,
): AgentSyncOutbox {
  const { collections, transport } = deps;
  const now = deps.now ?? (() => new Date());
  const pendingDeletes: PendingDelete[] = [];
  const listeners = new Set<(status: AgentSyncStatus) => void>();
  let state: AgentSyncState = "idle";
  let failure: AgentSyncFailure | null = null;
  let inFlight: Promise<AgentSyncStatus> | null = null;

  const pendingCount = (): number =>
    collections.conversations.toArray.filter((row) => row.serverId === null)
      .length +
    collections.messages.toArray.filter((row) => row.syncedAt === null).length +
    pendingDeletes.length;

  const getStatus = (): AgentSyncStatus => ({
    state,
    pending: pendingCount(),
    failure,
  });

  const notify = (): void => {
    const status = getStatus();
    for (const listener of listeners) {
      listener(status);
    }
  };

  const fail = (
    kind: AgentSyncOpKind,
    conversationId: string,
    messageId: string | null,
    error: unknown,
  ): AgentSyncStatus => {
    state = "failed";
    failure = { kind, conversationId, messageId, error };
    notify();
    return getStatus();
  };

  /** Delivers one op; marks its row/tombstone done on success. */
  async function deliver(op: AgentSyncOp): Promise<AgentSyncStatus | null> {
    try {
      if (op.kind === "create-conversation") {
        const server = await transport.createConversation({
          title: op.conversation.title,
        });
        await commitAgentWrite(collections.conversations, () => {
          collections.conversations.update(op.conversation.id, (draft) => {
            draft.serverId = server.id;
          });
        });
        return null;
      }
      if (op.kind === "append-message") {
        await transport.appendMessage({
          conversationId: op.serverConversationId,
          role: op.message.role,
          parts: messageRowPartsToWire(op.message),
        });
        await commitAgentWrite(collections.messages, () => {
          collections.messages.update(op.message.id, (draft) => {
            draft.syncedAt = now().toISOString();
          });
        });
        return null;
      }
      await transport.deleteConversation({ conversationId: op.serverId });
      pendingDeletes.shift();
      return null;
    } catch (error) {
      const conversationId =
        op.kind === "append-message"
          ? op.message.conversationId
          : op.kind === "create-conversation"
            ? op.conversation.id
            : op.conversationId;
      return fail(
        op.kind,
        conversationId,
        op.kind === "append-message" ? op.message.id : null,
        error,
      );
    }
  }

  /**
   * One full drain: syncing → ops until empty or failed → idle. The loop
   * re-derives per step, so rows written mid-drain are delivered in the
   * same run.
   */
  async function runFlush(): Promise<AgentSyncStatus> {
    state = "syncing";
    failure = null;
    notify();
    for (;;) {
      const op = deriveNextOp(collections, pendingDeletes);
      if (op === null) break;
      const outcome = await deliver(op);
      if (outcome !== null) return outcome;
    }
    state = "idle";
    failure = null;
    notify();
    return getStatus();
  }

  /** The defense-in-depth arm: runFlush is structured never to throw. */
  function unexpectedFailure(error: unknown): AgentSyncStatus {
    return fail("unexpected", "", null, error);
  }

  function settle(
    status: AgentSyncStatus,
  ): AgentSyncStatus | Promise<AgentSyncStatus> {
    inFlight = null;
    if (status.state === "idle" && pendingCount() > 0) {
      // Work arrived in the derive gap at the end of the drain — run a
      // trailing drain so a concurrent trigger is never silently missed.
      return flush();
    }
    return status;
  }

  const flush = (): Promise<AgentSyncStatus> => {
    if (inFlight !== null) return inFlight;
    inFlight = runFlush().then(settle, (error: unknown) =>
      settle(unexpectedFailure(error)),
    );
    return inFlight;
  };

  return {
    flush,
    enqueueDelete(conversationId, serverId) {
      pendingDeletes.push({ conversationId, serverId });
      notify();
    },
    pendingCount,
    getStatus,
    onStatusChange(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
