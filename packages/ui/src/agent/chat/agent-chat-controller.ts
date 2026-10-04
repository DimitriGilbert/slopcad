/**
 * The chat persistence controller (PLAN-AGENT-CHAT Phase 4.4): the glue
 * between the Phase 3.3 runtime hook and the Phase 3.4 store — the
 * conversation lifecycle the chat panel drives:
 *
 * - `start()` resumes: loads the newest persisted conversation into the
 *   chat (`loadConversation`, the store's revived `UIMessage` form);
 * - `receiveMessages()` appends every message the hook has produced and
 *   the store does not yet hold — but only once the OWNING RUN HAS
 *   COMPLETED. While a run is live (`submitted`/`streaming`) the hook
 *   re-reports the same ids delta by delta, so an append at first id
 *   sighting would snapshot one delta of a still-growing message; the
 *   pass at completion (status `ready`/`error`) appends each message
 *   once, with its complete parts — creating the conversation lazily on
 *   the first message, titled from that message's text, appends
 *   strictly ordered through an internal queue (never interleaved),
 *   failures surfaced in the snapshot (`error`, never silent) with the
 *   failed message left unpersisted so a later pass — or the at-rest
 *   `retryPersistence()` — retries exactly the unsaved tail;
 * - `newConversation()` detaches (the old row stays, resumable later)
 *   and clears the transcript;
 * - `clearConversation()` deletes the active conversation's rows (the
 *   store clears messages then the conversation, and queues the
 *   server-side delete when sync is on) and clears the transcript.
 *
 * Both lifecycle steps FENCE the serialized queue with a generation
 * counter: a batch enqueued before the step belongs to a conversation
 * the controller no longer owns, so at drain time it is dropped (never
 * re-targeted, and never allowed to mint a phantom conversation after a
 * detach), and a store rejection that answers a fenced batch — a write
 * the user just cleared — is swallowed silently instead of surfacing
 * "could not save".
 *
 * The controller is framework-free and node-testable: the chat arrives
 * as {@link AgentChatSurface} — the exact subset of the hook's return it
 * drives — and the store is the {@link AgentChatPersistenceStore}
 * structural contract (the slopcad app's Phase 3.4 interface satisfies it
 * verbatim), so tests mock both at their seams.
 */

import type { UIMessage } from "@tanstack/ai";
import type { ChatClientState } from "@tanstack/ai-client";
import type { AgentChatSyncStatus } from "./status-lines";

/** One persisted conversation, as the controller's lifecycle needs it. */
export interface AgentChatConversationSummary {
  /** The row id the store minted (the host owns the id space). */
  readonly id: string;
  /** The conversation's title as saved. */
  readonly title: string;
}

/** One conversation plus its resumed messages, in order. */
export interface AgentChatPersistedConversation {
  readonly conversation: AgentChatConversationSummary;
  readonly messages: readonly UIMessage[];
}

/**
 * The persistence surface the controller drives (D12's host-injected
 * store). Structural on purpose: the slopcad app passes its Phase 3.4
 * `AgentChatStore` (OPFS-backed with opt-in tRPC sync) verbatim — its row
 * types carry more fields than this summary — and a registry consumer
 * implements whatever persistence they own against this shape. `null` at
 * the panel seam means ephemeral chat: nothing persists.
 */
export interface AgentChatPersistenceStore {
  /** Creates a conversation row (the host validates titles its own way). */
  createConversation(title: string): Promise<AgentChatConversationSummary>;
  /** Persists one message and stamps the conversation's `updatedAt`. */
  appendMessage(conversationId: string, message: UIMessage): Promise<unknown>;
  /** The resume read: conversation + messages in order, or null. */
  loadConversation(
    conversationId: string,
  ): Promise<AgentChatPersistedConversation | null>;
  /** All conversations, newest-updated first. */
  listConversations(): Promise<readonly AgentChatConversationSummary[]>;
  /** Clears the conversation's rows; returns whether it existed. */
  deleteConversation(conversationId: string): Promise<boolean>;
  /** Explicit sync drain/retry; a no-op status when the host has no sync. */
  syncNow(): Promise<AgentChatSyncStatus>;
  getSyncStatus(): AgentChatSyncStatus;
  onSyncStatusChange(
    listener: (status: AgentChatSyncStatus) => void,
  ): () => void;
}

/**
 * The chat seam: the subset of the Phase 3.3 hook's return the
 * controller drives (the hook's return satisfies this structurally).
 */
export interface AgentChatSurface {
  readonly messages: readonly UIMessage[];
  readonly setMessages: (messages: UIMessage[]) => void;
  readonly clear: () => void;
  /**
   * The hook's run/status signal: `submitted`/`streaming` means a run is
   * live, `ready`/`error` are the completion states (a run that ended in
   * an error still completed — its partial parts are final).
   */
  readonly status: ChatClientState;
}

/** The controller's observable snapshot — what the panel renders from. */
export interface AgentChatControllerSnapshot {
  /** The active conversation's row id, once one exists or was resumed. */
  readonly conversationId: string | null;
  /** The resumed conversation's title, when `start()` loaded one. */
  readonly conversationTitle: string | null;
  /** The last surfaced persistence failure — never silent, never thrown. */
  readonly error: string | null;
}

/** Everything the controller binds; all of it injected. */
export interface AgentChatControllerDeps {
  /** Reads the live chat surface (the panel routes its hook through this). */
  readonly getChat: () => AgentChatSurface;
  /** The host-injected persistence store; `null` = ephemeral chat. */
  readonly store: AgentChatPersistenceStore | null;
  /**
   * Titles lazily created conversations from the transcript; the default
   * uses the first user message's text, bounded by
   * {@link AgentChatControllerDeps.titleMaxLength} when the host sets one.
   */
  readonly titleOf?: (messages: readonly UIMessage[]) => string;
  /**
   * The host's title bound (Phase 5's registry lift): the slopcad app
   * passes its `AGENT_CONVERSATION_TITLE_MAX_LENGTH` (the tRPC create
   * route's zod bound); absent means the default title is unbounded — a
   * host whose store has no title limit leaves it out.
   */
  readonly titleMaxLength?: number;
}

/** The lifecycle surface the panel (and the session it reports) drives. */
export interface AgentChatController {
  /** Resume: loads the newest conversation into the chat. Idempotent. */
  readonly start: () => Promise<void>;
  /**
   * Persists every not-yet-held message — called on every messages OR
   * status change; passes while the owning run is live are skipped, and
   * the completion pass appends each message with its complete parts.
   */
  readonly receiveMessages: (messages: readonly UIMessage[]) => void;
  /**
   * At-rest retry of the surfaced persistence failure: clears it and
   * re-runs the pass over the live transcript (the failed tail was left
   * unmarked for exactly this).
   */
  readonly retryPersistence: () => void;
  /** Detaches from the active conversation and clears the transcript. */
  readonly newConversation: () => void;
  /** Deletes the active conversation's rows and clears the transcript. */
  readonly clearConversation: () => Promise<boolean>;
  readonly getSnapshot: () => AgentChatControllerSnapshot;
  readonly subscribe: (listener: () => void) => () => void;
}

/**
 * The default title factory bound to the host's optional title limit: the
 * first user message's text, sliced to the bound when one was injected.
 */
function defaultTitleBoundTo(
  maxLength: number | undefined,
): (messages: readonly UIMessage[]) => string {
  return (messages) => {
    for (const message of messages) {
      if (message.role !== "user") {
        continue;
      }
      let text = "";
      for (const part of message.parts) {
        if (part.type === "text") {
          text += part.content;
        }
      }
      const trimmed = text.trim();
      if (trimmed.length > 0) {
        return maxLength === undefined ? trimmed : trimmed.slice(0, maxLength);
      }
    }
    return "Agent conversation";
  };
}

/** Reads one line of an unknown thrown value, for the surfaced error. */
function thrownText(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) {
    return error.message;
  }
  return "unknown persistence error";
}

/** True while the owning run is live — its messages' parts still growing. */
function isRunLive(status: ChatClientState): boolean {
  return status === "submitted" || status === "streaming";
}

/** Creates the controller over the injected seams. */
export function createAgentChatController(
  deps: AgentChatControllerDeps,
): AgentChatController {
  const store = deps.store;
  const titleOf = deps.titleOf ?? defaultTitleBoundTo(deps.titleMaxLength);
  let started = false;
  let conversationId: string | null = null;
  let conversationTitle: string | null = null;
  let error: string | null = null;
  // Set the moment any lifecycle step acts on the chat; a late-finishing
  // `start()` must not clobber live work with a stale resume.
  let dirty = false;
  // The lifecycle fence: bumped by newConversation()/clearConversation()
  // so a batch enqueued before the step can be recognised (and dropped)
  // at drain time — it belongs to a conversation the controller no
  // longer owns.
  let generation = 0;
  // The ids this controller has handed to the store (or has in flight);
  // everything else in a `receiveMessages` batch is new.
  const persistedIds = new Set<string>();
  const listeners = new Set<() => void>();
  // Serialized appends: one chain, so batches never interleave.
  let queue: Promise<void> = Promise.resolve();
  // `getSnapshot` must return a STABLE identity between mutations (the
  // useSyncExternalStore contract), so the object is cached and rebuilt
  // only after a commit.
  let snapshotCache: AgentChatControllerSnapshot | null = null;

  const notify = (): void => {
    snapshotCache = null;
    for (const listener of listeners) {
      listener();
    }
  };

  const fail = (message: string): void => {
    error = message;
    notify();
  };

  // The one persistence pass both receiveMessages and the at-rest retry
  // run: append every message the store does not yet hold — never while
  // the owning run is live.
  const persistPass = (messages: readonly UIMessage[]): void => {
    if (store === null || messages.length === 0) {
      return;
    }
    // Any observed transcript marks the chat live, even when the pass
    // itself waits for completion: a late-finishing resume must not
    // clobber a run that has already started.
    dirty = true;
    if (isRunLive(deps.getChat().status)) {
      // The owning run is still streaming: ids arrive long before their
      // parts finish, and appending now would snapshot one delta. The
      // completion pass persists every message with its complete parts.
      return;
    }
    const fresh = messages.filter((message) => !persistedIds.has(message.id));
    if (fresh.length === 0) {
      return;
    }
    for (const message of fresh) {
      persistedIds.add(message.id);
    }
    const unmark = (): void => {
      for (const message of fresh) {
        persistedIds.delete(message.id);
      }
    };
    // Appends ride one chain: strictly ordered, never interleaved. A
    // failed append un-marks itself and everything after it, so the
    // next pass retries exactly the unsaved tail (at-least-once, like
    // the sync outbox); the failure surfaces in the snapshot. A batch
    // fenced by a lifecycle step (stale generation) is dropped instead.
    const passGeneration = generation;
    const boundStore = store;
    queue = queue
      .then(async () => {
        if (passGeneration !== generation) {
          // The conversation this batch belongs to was detached or
          // deleted while it waited: drop it, and leave its ids
          // retryable by a later pass of whatever transcript is live.
          unmark();
          return;
        }
        let activeId = conversationId;
        if (activeId === null) {
          const row = await boundStore.createConversation(titleOf(messages));
          if (passGeneration !== generation) {
            // Detached mid-create: never adopt the row into the fresh
            // state — remove the orphan best-effort and drop the batch.
            void boundStore.deleteConversation(row.id).catch(() => undefined);
            unmark();
            return;
          }
          conversationId = row.id;
          conversationTitle = row.title;
          notify();
          activeId = row.id;
        }
        let index = 0;
        try {
          for (const message of fresh) {
            await boundStore.appendMessage(activeId, message);
            index += 1;
          }
        } catch (caught) {
          for (let missed = index; missed < fresh.length; missed += 1) {
            const message = fresh[missed];
            if (message !== undefined) {
              persistedIds.delete(message.id);
            }
          }
          throw caught;
        }
      })
      .catch((caught: unknown) => {
        if (passGeneration !== generation) {
          // The rejection answers a batch the user already discarded
          // (the clear raced the write): silent, never "could not save".
          return;
        }
        fail(`Could not save the conversation: ${thrownText(caught)}`);
      });
  };

  // Every member is an arrow PROPERTY (not a method): the panel hands
  // `subscribe`/`getSnapshot` to `useSyncExternalStore` detached, and
  // closure functions carry no `this` to lose.
  return {
    start: async () => {
      if (started) {
        return;
      }
      started = true;
      if (store === null) {
        return;
      }
      try {
        const conversations = await store.listConversations();
        const newest = conversations[0];
        if (newest === undefined) {
          return;
        }
        const loaded = await store.loadConversation(newest.id);
        // A send or a lifecycle button raced the resume: live work wins.
        if (loaded !== null && !dirty) {
          if (loaded.messages.length > 0) {
            deps.getChat().setMessages([...loaded.messages]);
            for (const message of loaded.messages) {
              persistedIds.add(message.id);
            }
          }
          conversationId = newest.id;
          conversationTitle = newest.title;
          notify();
        }
      } catch (caught) {
        // A resume failure must not take the panel down; it surfaces.
        fail(`Could not resume the saved conversation: ${thrownText(caught)}`);
      }
    },

    receiveMessages: (messages: readonly UIMessage[]) => {
      persistPass(messages);
    },

    retryPersistence: () => {
      // The at-rest retry (the panel's persistence-failure button):
      // clear the surfaced failure, then re-run the pass over the live
      // transcript — while a new run is live the pass skips itself, so
      // this is genuinely an at-rest verb.
      error = null;
      notify();
      persistPass(deps.getChat().messages);
    },

    newConversation: () => {
      dirty = true;
      // Fence the queue first: a batch still draining belongs to the
      // detached conversation and must not mint a fresh phantom one.
      generation += 1;
      conversationId = null;
      conversationTitle = null;
      persistedIds.clear();
      error = null;
      deps.getChat().clear();
      notify();
    },

    clearConversation: async () => {
      dirty = true;
      const activeId = conversationId;
      // Fence the queue BEFORE the await: a write already draining
      // against this conversation must drop silently when the store
      // rejects it — the user just discarded those rows.
      generation += 1;
      let existed = false;
      if (store !== null && activeId !== null) {
        try {
          existed = await store.deleteConversation(activeId);
        } catch (caught) {
          fail(`Could not clear the conversation: ${thrownText(caught)}`);
          return false;
        }
      }
      conversationId = null;
      conversationTitle = null;
      persistedIds.clear();
      error = null;
      deps.getChat().clear();
      notify();
      return existed;
    },

    getSnapshot: () => {
      if (snapshotCache === null) {
        snapshotCache = { conversationId, conversationTitle, error };
      }
      return snapshotCache;
    },

    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
