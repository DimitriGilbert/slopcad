/**
 * The opt-in sync outbox for client-emitted agent chat (PLAN-AGENT-CHAT
 * Phase 3.4, D3): when the user enables sync, conversation creates and
 * message appends are pushed through the Phase 1.4 tRPC
 * `agentConversations` router — the SAME rows local persistence stores,
 * via the SAME row state. The rows ARE the durable queue:
 *
 * - a conversation row with `serverId === null` is a pending CREATE (the
 *   router mints its own ids, so the mapping local→server is durably
 *   recorded on the row once the create is acknowledged). When such a
 *   conversation is deleted before its ack, the row's absence is the
 *   pending-create tombstone: the create path re-checks the local row when
 *   the ack lands and queues the just-created server copy for deletion
 *   instead of stamping a dead row;
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
 * DETERMINISTIC rejections are carved out at the transport seam
 * ({@link classifyTransportError}) instead of retried, because no retry
 * can change their verdict:
 *
 * - a delete answered `NOT_FOUND` is IDEMPOTENT SUCCESS (the server copy
 *   is already gone — deleted on another device, or a redelivery whose
 *   ack was lost): the tombstone drops and later deletes proceed;
 * - an append answered `NOT_FOUND` means its conversation no longer
 *   exists server-side (there is no pull path), and one answered
 *   `BAD_REQUEST` means the server's serialized-parts bound refused it.
 *   Both terminally mark the affected message row(s) UNSYNCABLE (a typed
 *   reason on the outbox's mark; the row data itself is never touched) and
 *   leave derivation, so the rest of the queue keeps flowing.
 *
 * The settle bound: a drain that ends with pending rows nothing can derive
 * (unsyncable marks, or rows orphaned outside the lifecycle) resolves into
 * the terminal `stalled` state — surfaced once, with its typed reason —
 * instead of re-arming a pure-microtask flush loop that would starve the
 * page and never resolve a single `flush()` await.
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

/** The seam's classification of one transport throw. */
type TransportErrorClass = "not-found" | "bad-request" | "retryable";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Reads the tRPC procedure code ("NOT_FOUND", "BAD_REQUEST", …) off a
 * thrown value — the installed client carries it at `error.data.code` and
 * the raw response envelope at `error.shape.data.code` — probed
 * structurally, so plain Errors (and anything else the injected seam
 * throws) classify as codeless. Null when no string code is carried.
 */
function transportErrorCode(error: unknown): string | null {
  if (!isRecord(error)) return null;
  const data = error["data"];
  if (isRecord(data) && typeof data["code"] === "string") {
    return data["code"];
  }
  const shape = error["shape"];
  if (isRecord(shape)) {
    const shapeData = shape["data"];
    if (isRecord(shapeData) && typeof shapeData["code"] === "string") {
      return shapeData["code"];
    }
  }
  return null;
}

/**
 * The transport seam's error classes, decided once here:
 *
 * - `not-found` / `bad-request` are DETERMINISTIC — retrying re-derives
 *   the identical op and earns the identical verdict forever — so the
 *   engine retires the affected rows instead of head-of-line-blocking on
 *   them;
 * - `retryable` (5xx codes, network failures, anything codeless) keeps
 *   the at-least-once re-queue.
 */
function classifyTransportError(error: unknown): TransportErrorClass {
  switch (transportErrorCode(error)) {
    case "NOT_FOUND":
      return "not-found";
    case "BAD_REQUEST":
      return "bad-request";
    default:
      return "retryable";
  }
}

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

export type AgentSyncState = "idle" | "syncing" | "failed" | "stalled";

/**
 * Why the server's rejection of a message row is PERMANENT — the two
 * deterministic verdicts no retry can change. The row's data is never
 * touched; only its delivery is abandoned.
 */
export type AgentSyncUnsyncableReason =
  /** The conversation no longer exists server-side (deleted elsewhere). */
  | "conversation-deleted-remotely"
  /** The serialized parts exceed the server's bound. */
  | "parts-too-large";

/**
 * Why a `stalled` outbox can never drain: the head-of-line pending row no
 * derivation can reach. `unsyncable-message` is a row the server
 * deterministically refused; `orphan-message` is a row whose conversation
 * row is gone (never derivable, never deliverable).
 */
export type AgentSyncStallReason =
  | {
      readonly kind: "unsyncable-message";
      readonly conversationId: string;
      readonly messageId: string;
      readonly reason: AgentSyncUnsyncableReason;
    }
  | {
      readonly kind: "orphan-message";
      readonly conversationId: string;
      readonly messageId: string;
    };

/** The typed sync result the chat UI shows — never a throw. */
export interface AgentSyncStatus {
  readonly state: AgentSyncState;
  /**
   * Local changes not mirrored to the server: queued ops AND stalled rows
   * the engine gave up on. A stalled row never leaves this count, so the
   * number cannot quietly drop to zero while data remains undelivered.
   */
  readonly pending: number;
  /** The retryable failure that stopped the queue, when `state === "failed"`. */
  readonly failure: AgentSyncFailure | null;
  /** The terminal verdict, when `state === "stalled"`. */
  readonly stall: AgentSyncStallReason | null;
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

/**
 * One message row's terminal outbox mark: the server deterministically
 * refused it, so it is excluded from derivation while the row (and the
 * transcript it belongs to) stays intact. Keyed by message id.
 */
interface UnsyncableMark {
  readonly conversationId: string;
  readonly messageId: string;
  readonly reason: AgentSyncUnsyncableReason;
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
 * The outbox's per-message delivery order: by conversation creation order
 * first, then per-conversation `seq`. Shared by derivation and the stall
 * reporter, so the surfaced blocker is the row the engine would actually
 * meet next.
 */
function messageDeliveryOrder(
  conversationOrderBy: ReadonlyMap<string, string>,
): (a: AgentMessageRow, b: AgentMessageRow) => number {
  return (a, b) => {
    const conversationDelta = (
      conversationOrderBy.get(a.conversationId) ?? ""
    ).localeCompare(conversationOrderBy.get(b.conversationId) ?? "");
    return conversationDelta !== 0
      ? conversationDelta
      : a.seq - b.seq || a.id.localeCompare(b.id);
  };
}

/**
 * Derives the NEXT op from the live row state — creates first (appends
 * need the serverId a create acks), then appends in per-conversation seq
 * order, then deletes. `null` when the queue is drained — or when the only
 * pending rows are ones no op can be derived for (unsyncable marks, rows
 * orphaned outside the lifecycle). Deriving fresh on every step is what
 * makes the outbox see rows written mid-drain and rows deleted mid-drain
 * (a deleted conversation's messages vanish with it).
 */
function deriveNextOp(
  collections: AgentCollections,
  pendingDeletes: readonly PendingDelete[],
  unsyncable: ReadonlyMap<string, UnsyncableMark>,
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
    .filter((row) => row.syncedAt === null && !unsyncable.has(row.id))
    .sort(messageDeliveryOrder(conversationOrderBy));
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
  /**
   * The unsyncable marks, in memory by design: the rows themselves stay
   * untouched (data kept), and a reload re-derives a poisoned op once —
   * the seam re-classifies the same deterministic rejection and re-marks,
   * costing one round-trip and never a wrong delivery.
   */
  const unsyncable = new Map<string, UnsyncableMark>();
  const listeners = new Set<(status: AgentSyncStatus) => void>();
  let state: AgentSyncState = "idle";
  let failure: AgentSyncFailure | null = null;
  let stall: AgentSyncStallReason | null = null;
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
    stall,
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

  /**
   * A transport rejection of one append: the deterministic verdicts retire
   * rows (mark unsyncable, then let the drain CONTINUE — the rest of the
   * queue keeps flowing); everything retryable fails the drain
   * head-of-line exactly as before.
   */
  function settleAppendRejection(
    op: Extract<AgentSyncOp, { kind: "append-message" }>,
    error: unknown,
  ): AgentSyncStatus | null {
    switch (classifyTransportError(error)) {
      case "not-found": {
        // The conversation is gone server-side (deleted on another device;
        // no pull path exists). Terminal for EVERY pending message of that
        // conversation — per-conversation order would fail each remaining
        // one identically, so they are retired without wasted round-trips.
        // The rows keep their data.
        for (const row of collections.messages.toArray) {
          if (
            row.conversationId === op.message.conversationId &&
            row.syncedAt === null &&
            !unsyncable.has(row.id)
          ) {
            unsyncable.set(row.id, {
              conversationId: row.conversationId,
              messageId: row.id,
              reason: "conversation-deleted-remotely",
            });
          }
        }
        return null;
      }
      case "bad-request": {
        // The server's serialized-parts bound refused THIS message only
        // (the store's client-side bound prevents new ones).
        unsyncable.set(op.message.id, {
          conversationId: op.message.conversationId,
          messageId: op.message.id,
          reason: "parts-too-large",
        });
        return null;
      }
      case "retryable":
        return fail(
          "append-message",
          op.message.conversationId,
          op.message.id,
          error,
        );
    }
  }

  /**
   * Names the head-of-line pending row that made the queue underivable:
   * in derivation order, the first row carrying an unsyncable mark, else
   * the first row whose conversation row is gone. When derivation returned
   * null with a non-empty count, only rows of these two kinds can remain
   * (a pending create or tombstone would always be derivable).
   */
  function describeStall(): AgentSyncStallReason | null {
    const conversationOrderBy = new Map(
      collections.conversations.toArray.map(
        (row) => [row.id, row.createdAt] as const,
      ),
    );
    const blocked = collections.messages.toArray
      .filter((row) => row.syncedAt === null)
      .sort(messageDeliveryOrder(conversationOrderBy));
    for (const row of blocked) {
      const mark = unsyncable.get(row.id);
      if (mark !== undefined) {
        return {
          kind: "unsyncable-message",
          conversationId: mark.conversationId,
          messageId: row.id,
          reason: mark.reason,
        };
      }
      if (!collections.conversations.has(row.conversationId)) {
        return {
          kind: "orphan-message",
          conversationId: row.conversationId,
          messageId: row.id,
        };
      }
    }
    return null;
  }

  /** Delivers one op; marks its row/tombstone done on success. */
  async function deliver(op: AgentSyncOp): Promise<AgentSyncStatus | null> {
    try {
      if (op.kind === "create-conversation") {
        const server = await transport.createConversation({
          title: op.conversation.title,
        });
        if (!collections.conversations.has(op.conversation.id)) {
          // The conversation was deleted while its create was in flight —
          // the local row's absence IS the pending-create tombstone.
          // Stamping the dead row would throw (the key is gone) and leave
          // an unremovable server copy; instead queue the just-created
          // server id for deletion through the normal delete path, which
          // brings the retry semantics and the honest failure kind with it.
          pendingDeletes.unshift({
            conversationId: op.conversation.id,
            serverId: server.id,
          });
          notify();
          return null;
        }
        await commitAgentWrite(collections.conversations, () => {
          collections.conversations.update(op.conversation.id, (draft) => {
            draft.serverId = server.id;
          });
        });
        return null;
      }
      if (op.kind === "append-message") {
        try {
          await transport.appendMessage({
            conversationId: op.serverConversationId,
            role: op.message.role,
            parts: messageRowPartsToWire(op.message),
          });
        } catch (error) {
          return settleAppendRejection(op, error);
        }
        if (!collections.messages.has(op.message.id)) {
          // Discard wins: the row was removed while the append was in
          // flight (a retryRun discard, or the conversation delete that
          // takes its messages with it). The removal was deliberate, so
          // stamping the dead row would throw UpdateKeyNotFoundError and
          // surface a spurious "sync failed" for a row the user erased.
          // The op is CONSUMED, not requeued — the server copy stays (the
          // documented one-way-mirror divergence) — and the drain
          // continues.
          return null;
        }
        await commitAgentWrite(collections.messages, () => {
          collections.messages.update(op.message.id, (draft) => {
            draft.syncedAt = now().toISOString();
          });
        });
        return null;
      }
      try {
        await transport.deleteConversation({ conversationId: op.serverId });
      } catch (error) {
        if (classifyTransportError(error) === "not-found") {
          // Idempotent success (an encoded design decision): the server
          // copy is ALREADY gone — deleted on another device, or a
          // redelivered delete whose ack was lost. Drop the tombstone so
          // LATER deletes proceed instead of poisoning the tail.
          pendingDeletes.shift();
          return null;
        }
        return fail("delete-conversation", op.conversationId, null, error);
      }
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
   * One full drain: syncing → ops until empty, failed, or stalled. The
   * loop re-derives per step, so rows written mid-drain are delivered in
   * the same run.
   */
  async function runFlush(): Promise<AgentSyncStatus> {
    state = "syncing";
    failure = null;
    stall = null;
    notify();
    for (;;) {
      const op = deriveNextOp(collections, pendingDeletes, unsyncable);
      if (op === null) break;
      const outcome = await deliver(op);
      if (outcome !== null) return outcome;
    }
    if (pendingCount() > 0) {
      // The queue holds rows the engine can never deliver — unsyncable
      // marks and/or rows orphaned outside the lifecycle. Re-flushing
      // would re-derive null forever: a pure-microtask loop that starves
      // the page and never resolves a single flush() await. The terminal
      // verdict is surfaced ONCE per drain and every flush() resolves.
      state = "stalled";
      stall = describeStall();
      failure = null;
      notify();
      return getStatus();
    }
    state = "idle";
    failure = null;
    stall = null;
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
      // Work arrived in the derive gap at the very end of the drain (an
      // idle return means the queue was EMPTY at drain end, so these rows
      // landed in the closing microtasks) — run one trailing drain so a
      // concurrent trigger is never silently missed. The chain is bounded
      // by construction: a drain that faces pending rows nothing can
      // derive returns "stalled" instead of idle, so the self-sustaining
      // flush→settle→flush recursion (the unbounded pre-bound hang) cannot
      // re-arm — the next drain always either delivers real work or
      // terminates in the stalled verdict.
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
