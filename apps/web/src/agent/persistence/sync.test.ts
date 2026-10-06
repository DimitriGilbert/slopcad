// @vitest-environment node
// The outbox runs on the injected node persistence; jsdom adds nothing.

/**
 * The opt-in sync outbox's contract (PLAN-AGENT-CHAT Phase 3.4, D3):
 * when enabled, conversation creates and message appends push the SAME
 * rows through the injected tRPC-shaped transport — strictly ordered
 * (create before its appends, seq order within a conversation, deletes
 * last), durable across a reopen (serverId/syncedAt stamped on the rows),
 * failing ops stay queued with a TYPED status (never a throw, never
 * silent), and the next flush is the retry. The `enabled` seam is a live
 * toggle here so every drain is explicit and deterministic — no race with
 * the store's auto-drain.
 */

import type { UIMessage } from "@tanstack/ai";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { AgentChatSyncConfig } from "./store";
import type { AgentMessageRow } from "./rows";

import { commitAgentWrite, openAgentCollections } from "./collections";
import {
  createAgentSyncOutbox,
  type AgentSyncAppendInput,
  type AgentSyncCreateInput,
  type AgentSyncDeleteInput,
  type AgentSyncStatus,
  type AgentSyncTransport,
} from "./sync";
import {
  openNodeAgentStore,
  openNodePersistence,
  tempAgentDatabase,
  type TempAgentDatabase,
} from "./testing-node";

const databases: TempAgentDatabase[] = [];
afterAll(() => {
  for (const database of databases) {
    database.cleanup();
  }
});

function database(label: string): string {
  const databaseHandle = tempAgentDatabase(label);
  databases.push(databaseHandle);
  return databaseHandle.path;
}

/** Off by default; tests flip it on exactly when they want drains to run. */
function syncToggle(): {
  readonly config: AgentChatSyncConfig["enabled"];
  readonly turnOn: () => void;
  readonly turnOff: () => void;
} {
  let on = false;
  return {
    config: () => on,
    turnOn: () => (on = true),
    turnOff: () => (on = false),
  };
}

/**
 * A thrown value shaped like the installed tRPC client's errors: the
 * procedure code rides at `data.code` (the seam's classification reads
 * exactly that spot).
 */
function trpcClientError(code: string, message: string): Error {
  return Object.assign(new Error(message), { data: { code } });
}

/**
 * A second-resolution monotonic clock over a fixed epoch: consecutive
 * calls mint strictly increasing ISO timestamps, so creation order (the
 * outbox's cross-conversation derivation order) is deterministic.
 */
function monotonicClock(): { readonly now: () => Date } {
  let second = 0;
  return { now: () => new Date(Date.UTC(2026, 9, 4, 12, 30, second++)) };
}

/** The recording, failure-injecting transport double. */
interface TransportHarness {
  readonly transport: AgentSyncTransport;
  readonly creates: AgentSyncCreateInput[];
  readonly appends: AgentSyncAppendInput[];
  readonly deletes: AgentSyncDeleteInput[];
  readonly failNextCreate: (error: Error) => void;
  readonly failNextAppend: (error: Error) => void;
  readonly failNextDelete: (error: Error) => void;
}

function transportHarness(): TransportHarness {
  const creates: AgentSyncCreateInput[] = [];
  const appends: AgentSyncAppendInput[] = [];
  const deletes: AgentSyncDeleteInput[] = [];
  const createFailures: Error[] = [];
  const appendFailures: Error[] = [];
  const deleteFailures: Error[] = [];
  const iso = "2026-10-04T12:30:00.000Z";
  const transport: AgentSyncTransport = {
    createConversation(input) {
      creates.push(input);
      const failure = createFailures.shift();
      if (failure !== undefined) return Promise.reject(failure);
      return Promise.resolve({
        id: `srv-conv-${creates.length}`,
        projectId: null,
        title: input.title,
        createdAt: iso,
        updatedAt: iso,
      });
    },
    appendMessage(input) {
      appends.push(input);
      const failure = appendFailures.shift();
      if (failure !== undefined) return Promise.reject(failure);
      return Promise.resolve({
        id: `srv-msg-${appends.length}`,
        conversationId: input.conversationId,
        role: input.role,
        parts: input.parts,
        createdAt: iso,
      });
    },
    deleteConversation(input) {
      deletes.push(input);
      const failure = deleteFailures.shift();
      if (failure !== undefined) return Promise.reject(failure);
      return Promise.resolve();
    },
  };
  return {
    transport,
    creates,
    appends,
    deletes,
    failNextCreate: (error) => createFailures.push(error),
    failNextAppend: (error) => appendFailures.push(error),
    failNextDelete: (error) => deleteFailures.push(error),
  };
}

function textMessage(id: string, content: string): UIMessage {
  return { id, role: "user", parts: [{ type: "text", content }] };
}

describe("agent chat sync outbox", () => {
  it("drains in order: create once, appends in seq order, rows stamped", async () => {
    const path = database("success");
    const harness = transportHarness();
    const toggle = syncToggle();
    const store = await openNodeAgentStore(
      { sync: { transport: harness.transport, enabled: toggle.config } },
      path,
    );

    const conversation = await store.createConversation("Synced chat");
    await store.appendMessage(conversation.id, textMessage("m1", "first"));
    await store.appendMessage(conversation.id, textMessage("m2", "second"));
    toggle.turnOn();
    const final = await store.syncNow();

    expect(final).toEqual({
      state: "idle",
      pending: 0,
      failure: null,
      stall: null,
    });
    expect(harness.creates).toEqual([{ title: "Synced chat" }]);
    expect(harness.appends).toHaveLength(2);
    // Appends target the SERVER conversation id, in seq order.
    expect(harness.appends.map((input) => input.conversationId)).toEqual([
      "srv-conv-1",
      "srv-conv-1",
    ]);
    expect(
      harness.appends.map(
        (input) => (input.parts[0] as { content: string }).content,
      ),
    ).toEqual(["first", "second"]);
    expect(harness.deletes).toEqual([]);

    // The stamps are durable: a fresh store over the same file has no
    // backlog left (serverId and syncedAt both landed).
    const readerHarness = transportHarness();
    const readerToggle = syncToggle();
    const reader = await openNodeAgentStore(
      {
        sync: {
          transport: readerHarness.transport,
          enabled: readerToggle.config,
        },
      },
      path,
    );
    expect(reader.getSyncStatus().pending).toBe(0);
    const resumed = await reader.loadConversation(conversation.id);
    expect(resumed?.conversation.serverId).toBe("srv-conv-1");
  });

  it("auto-drains on append once sync is enabled (no explicit syncNow)", async () => {
    const harness = transportHarness();
    const toggle = syncToggle();
    const store = await openNodeAgentStore(
      { sync: { transport: harness.transport, enabled: toggle.config } },
      database("auto"),
    );
    toggle.turnOn();
    const conversation = await store.createConversation("auto chat");
    await store.appendMessage(conversation.id, textMessage("m1", "x"));
    // Wait for the SETTLED status, not the transport call: the append can
    // be observed while the drain is still finishing its syncedAt stamp.
    await vi.waitFor(() => {
      expect(store.getSyncStatus()).toEqual({
        state: "idle",
        pending: 0,
        failure: null,
        stall: null,
      });
    });
    expect(harness.appends).toHaveLength(1);
  });

  it("surfaces a failed create typed, keeps everything queued, retries clean", async () => {
    const harness = transportHarness();
    const toggle = syncToggle();
    const store = await openNodeAgentStore(
      { sync: { transport: harness.transport, enabled: toggle.config } },
      database("create-failure"),
    );
    const conversation = await store.createConversation("flaky");
    await store.appendMessage(conversation.id, textMessage("m1", "x"));

    const boom = new Error("server unreachable");
    harness.failNextCreate(boom);
    toggle.turnOn();
    const failed = await store.syncNow();
    expect(failed.state).toBe("failed");
    expect(failed.pending).toBe(2);
    expect(failed.failure).toEqual({
      kind: "create-conversation",
      conversationId: conversation.id,
      messageId: null,
      error: boom,
    });
    // Nothing was lost or silently dropped: the rows are all still there.
    const loaded = await store.loadConversation(conversation.id);
    expect(loaded?.messages.map((m) => m.id)).toEqual(["m1"]);

    // The next flush is the retry — one more create attempt succeeds.
    const retried = await store.syncNow();
    expect(retried).toEqual({
      state: "idle",
      pending: 0,
      failure: null,
      stall: null,
    });
    expect(harness.creates).toHaveLength(2);
    expect(harness.appends).toHaveLength(1);
  });

  it("blocks head-of-line on a failed append, then delivers both in order", async () => {
    const harness = transportHarness();
    const toggle = syncToggle();
    const store = await openNodeAgentStore(
      { sync: { transport: harness.transport, enabled: toggle.config } },
      database("append-failure"),
    );
    const conversation = await store.createConversation("ordered");
    await store.appendMessage(conversation.id, textMessage("m1", "first"));
    await store.appendMessage(conversation.id, textMessage("m2", "second"));

    const boom = new Error("append rejected");
    harness.failNextAppend(boom);
    toggle.turnOn();
    const failed = await store.syncNow();
    // The create succeeded; m1's append failed; m2 stayed behind it.
    expect(harness.creates).toHaveLength(1);
    expect(harness.appends).toHaveLength(1);
    expect(failed.state).toBe("failed");
    expect(failed.pending).toBe(2);
    expect(failed.failure).toEqual({
      kind: "append-message",
      conversationId: conversation.id,
      messageId: "m1",
      error: boom,
    });

    const retried = await store.syncNow();
    expect(retried.state).toBe("idle");
    expect(retried.pending).toBe(0);
    expect(
      harness.appends.map(
        (input) => (input.parts[0] as { content: string }).content,
      ),
    ).toEqual(["first", "first", "second"]);
  });

  it("pushes a server delete for an already-synced conversation, never for an unsynced one", async () => {
    const path = database("deletes");
    const harness = transportHarness();
    const toggle = syncToggle();
    const store = await openNodeAgentStore(
      { sync: { transport: harness.transport, enabled: toggle.config } },
      path,
    );
    const synced = await store.createConversation("synced then deleted");
    await store.appendMessage(synced.id, textMessage("m1", "x"));
    toggle.turnOn();
    await store.syncNow();
    expect(harness.deletes).toEqual([]);

    await store.deleteConversation(synced.id);
    await vi.waitFor(() => {
      expect(harness.deletes).toHaveLength(1);
    });
    // The SERVER id is what the router can resolve, not the local key.
    expect(harness.deletes).toEqual([{ conversationId: "srv-conv-1" }]);
    expect(store.getSyncStatus().pending).toBe(0);

    // An unsynced conversation (sync toggled back off before any drain)
    // deletes with NO server traffic at all.
    const secondToggle = syncToggle();
    const secondStore = await openNodeAgentStore(
      { sync: { transport: harness.transport, enabled: secondToggle.config } },
      path,
    );
    const unsynced = await secondStore.createConversation("never synced");
    await secondStore.appendMessage(unsynced.id, textMessage("m2", "y"));
    await secondStore.deleteConversation(unsynced.id);
    expect(harness.creates).toHaveLength(1);
    expect(harness.appends).toHaveLength(1);
    expect(harness.deletes).toHaveLength(1);
  });

  it("cleans the server copy up when a conversation is deleted mid-create", async () => {
    const path = database("mid-create-delete");
    // A create transport gated by the test, so the delete can race the
    // in-flight create deterministically.
    let releaseCreate!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseCreate = resolve;
    });
    const creates: AgentSyncCreateInput[] = [];
    const deletes: AgentSyncDeleteInput[] = [];
    const iso = "2026-10-04T12:30:00.000Z";
    const transport: AgentSyncTransport = {
      createConversation(input) {
        creates.push(input);
        return gate.then(() => ({
          id: "srv-conv-gated",
          projectId: null,
          title: input.title,
          createdAt: iso,
          updatedAt: iso,
        }));
      },
      appendMessage(input) {
        return Promise.resolve({
          id: `srv-msg-${creates.length}`,
          conversationId: input.conversationId,
          role: input.role,
          parts: input.parts,
          createdAt: iso,
        });
      },
      deleteConversation(input) {
        deletes.push(input);
        return Promise.resolve();
      },
    };
    const store = await openNodeAgentStore(
      { sync: { transport, enabled: true } },
      path,
    );

    const conversation = await store.createConversation("deleted mid-create");
    // The auto-drain is now awaiting the gated create; syncNow coalesces
    // onto that in-flight drain.
    const draining = store.syncNow();
    await vi.waitFor(() => {
      expect(creates).toHaveLength(1);
    });
    expect(deletes).toHaveLength(0);

    // The user deletes while the create is in flight. The row was still
    // unsynced (serverId null), so no delete tombstone existed — the local
    // rows simply go.
    expect(await store.deleteConversation(conversation.id)).toBe(true);
    expect(await store.loadConversation(conversation.id)).toBeNull();

    // The ack lands on a deleted conversation: no spurious create failure,
    // and the just-created server copy is cleaned up through the delete
    // path — no permanent server residue.
    releaseCreate();
    expect(await draining).toEqual({
      state: "idle",
      pending: 0,
      failure: null,
      stall: null,
    });
    expect(creates).toEqual([{ title: "deleted mid-create" }]);
    expect(deletes).toEqual([{ conversationId: "srv-conv-gated" }]);
    expect(store.getSyncStatus()).toEqual({
      state: "idle",
      pending: 0,
      failure: null,
      stall: null,
    });
  });

  it("survives a message removed while its append is in flight: discard wins, no spurious failure", async () => {
    const path = database("append-removed-mid-flight");
    // An append transport gated by the test, so the removal can race the
    // in-flight append deterministically (the retryRun-discard shape).
    let releaseAppend!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseAppend = resolve;
    });
    const appends: AgentSyncAppendInput[] = [];
    const iso = "2026-10-04T12:30:00.000Z";
    const transport: AgentSyncTransport = {
      createConversation(input) {
        return Promise.resolve({
          id: "srv-conv-gated-append",
          projectId: null,
          title: input.title,
          createdAt: iso,
          updatedAt: iso,
        });
      },
      appendMessage(input) {
        appends.push(input);
        return gate.then(() => ({
          id: `srv-msg-${appends.length}`,
          conversationId: input.conversationId,
          role: input.role,
          parts: input.parts,
          createdAt: iso,
        }));
      },
      deleteConversation() {
        return Promise.resolve();
      },
    };
    const store = await openNodeAgentStore(
      { sync: { transport, enabled: true } },
      path,
    );

    const conversation = await store.createConversation("removed mid-append");
    await store.appendMessage(conversation.id, textMessage("m1", "doomed"));
    // The auto-drain created the conversation and is now awaiting the
    // gated append; syncNow coalesces onto that in-flight drain.
    const draining = store.syncNow();
    await vi.waitFor(() => {
      expect(appends).toHaveLength(1);
    });

    // The user discards the message while its append is in flight: the
    // row (and its pending mark) is gone when the transport resolves.
    await store.removeMessages(["m1"]);
    const afterRemoval = await store.loadConversation(conversation.id);
    expect(afterRemoval?.messages.map((message) => message.id)).toEqual([]);

    // The ack lands on a removed row: no spurious "sync failed at message
    // append", the op is consumed — never requeued, never re-sent — and
    // the drain settles clean.
    releaseAppend();
    expect(await draining).toEqual({
      state: "idle",
      pending: 0,
      failure: null,
      stall: null,
    });
    expect(appends).toHaveLength(1);

    // Later ops still proceed: a new append flows and is stamped (pending
    // 0 means its syncedAt landed).
    await store.appendMessage(conversation.id, textMessage("m2", "survivor"));
    await vi.waitFor(() => {
      expect(store.getSyncStatus()).toEqual({
        state: "idle",
        pending: 0,
        failure: null,
        stall: null,
      });
    });
    expect(appends).toHaveLength(2);
    expect(appends[1]?.conversationId).toBe("srv-conv-gated-append");
    const after = await store.loadConversation(conversation.id);
    expect(after?.messages.map((message) => message.id)).toEqual(["m2"]);
  });

  it("sends the envelope-stripped wire form (Dates as ISO strings)", async () => {
    const harness = transportHarness();
    const toggle = syncToggle();
    const store = await openNodeAgentStore(
      { sync: { transport: harness.transport, enabled: toggle.config } },
      database("wire"),
    );
    const conversation = await store.createConversation("wire form");
    const message: UIMessage = {
      id: "m-date",
      role: "assistant",
      parts: [
        {
          type: "tool-result",
          toolCallId: "call-1",
          content: "ok",
          state: "complete",
          createdAt: new Date("2026-10-04T12:00:09.000Z"),
        },
      ],
      createdAt: new Date("2026-10-04T12:00:09.000Z"),
    };
    await store.appendMessage(conversation.id, message);
    toggle.turnOn();
    await store.syncNow();
    expect(harness.appends).toHaveLength(1);
    expect(harness.appends[0]?.parts).toEqual([
      {
        type: "tool-result",
        toolCallId: "call-1",
        content: "ok",
        state: "complete",
        createdAt: "2026-10-04T12:00:09.000Z",
      },
    ]);
    expect(JSON.stringify(harness.appends)).not.toContain("__slopcadDateIso");
  });

  it("reports status transitions to subscribers", async () => {
    const harness = transportHarness();
    const toggle = syncToggle();
    const store = await openNodeAgentStore(
      { sync: { transport: harness.transport, enabled: toggle.config } },
      database("status"),
    );
    const conversation = await store.createConversation("status chat");
    await store.appendMessage(conversation.id, textMessage("m1", "x"));

    const observed: AgentSyncStatus[] = [];
    store.onSyncStatusChange((status) => {
      observed.push(status);
    });
    toggle.turnOn();
    await store.syncNow();
    expect(observed.map((status) => status.state)).toEqual(["syncing", "idle"]);
    // Unsubscribed listeners stop hearing.
    const unsubscribe = store.onSyncStatusChange(() => {
      throw new Error("TEST: listener called after unsubscribe");
    });
    unsubscribe();
    await store.deleteConversation(conversation.id);
    await vi.waitFor(() => {
      expect(harness.deletes).toHaveLength(1);
    });
  });

  it("resolves a stalled flush once when pending rows are underivable, instead of looping", async () => {
    const harness = transportHarness();
    const collections = await openAgentCollections(
      openNodePersistence(database("stall-orphan")),
    );
    // An orphan message row: its conversation row is gone, so no drain can
    // ever derive it — exactly the shape that used to arm the infinite
    // settle loop (pendingCount counts it; deriveNextOp skips it).
    const orphan: AgentMessageRow = {
      id: "orphan-1",
      conversationId: "ghost-conversation",
      seq: 1,
      role: "user",
      parts: JSON.stringify([{ type: "text", content: "lost" }]),
      name: null,
      metadata: null,
      createdAt: "2026-10-04T12:30:00.000Z",
      syncedAt: null,
    };
    await commitAgentWrite(collections.messages, () => {
      collections.messages.insert(orphan);
    });
    const outbox = createAgentSyncOutbox({
      collections,
      transport: harness.transport,
    });

    const observed: AgentSyncStatus[] = [];
    outbox.onStatusChange((status) => observed.push(status));

    // Bounded await: before the settle bound this promise never resolved
    // (pure-microtask recursion); the test's own timeout is the bound.
    const stalled = await outbox.flush();
    expect(stalled.state).toBe("stalled");
    expect(stalled.pending).toBe(1);
    expect(stalled.failure).toBeNull();
    expect(stalled.stall).toEqual({
      kind: "orphan-message",
      conversationId: "ghost-conversation",
      messageId: "orphan-1",
    });
    // Surfaced exactly once per drain — no per-microtask notify churn.
    expect(observed.map((status) => status.state)).toEqual([
      "syncing",
      "stalled",
    ]);
    // Nothing was derivable, so the transport was never called.
    expect(harness.creates).toHaveLength(0);
    expect(harness.appends).toHaveLength(0);

    // A retry resolves too — the terminal verdict is stable, not a loop.
    const again = await outbox.flush();
    expect(again.state).toBe("stalled");
    expect(again.pending).toBe(1);
    expect(again.stall).toEqual(stalled.stall);
  }, 2_000);

  it("treats a NOT_FOUND delete as idempotent success: the tombstone drops, later deletes proceed", async () => {
    const harness = transportHarness();
    const toggle = syncToggle();
    const store = await openNodeAgentStore(
      { sync: { transport: harness.transport, enabled: toggle.config } },
      database("delete-not-found"),
    );
    const first = await store.createConversation("deleted there too");
    await store.appendMessage(first.id, textMessage("m1", "x"));
    const second = await store.createConversation("deleted here");
    await store.appendMessage(second.id, textMessage("m2", "y"));
    toggle.turnOn();
    await store.syncNow();
    expect(store.getSyncStatus().pending).toBe(0);

    // Queue two tombstones while sync is OFF (no auto-drain races), then
    // answer the FIRST delete NOT_FOUND: the conversation was already
    // deleted on another device (a redelivered delete whose ack was lost
    // is the same shape).
    toggle.turnOff();
    await store.deleteConversation(first.id);
    await store.deleteConversation(second.id);
    expect(store.getSyncStatus().pending).toBe(2);
    harness.failNextDelete(
      trpcClientError("NOT_FOUND", "Conversation not found"),
    );
    toggle.turnOn();
    const settled = await store.syncNow();

    expect(settled).toEqual({
      state: "idle",
      pending: 0,
      failure: null,
      stall: null,
    });
    // Both deletes were sent; the NOT_FOUND one did not poison the tail —
    // the LATER tombstone was delivered in the SAME drain.
    expect(harness.deletes).toEqual([
      { conversationId: "srv-conv-1" },
      { conversationId: "srv-conv-2" },
    ]);
  });

  it("retires a remotely-deleted conversation's pending rows on NOT_FOUND; others keep flowing", async () => {
    const harness = transportHarness();
    const toggle = syncToggle();
    const store = await openNodeAgentStore(
      {
        sync: { transport: harness.transport, enabled: toggle.config },
        now: monotonicClock().now,
      },
      database("append-not-found"),
    );
    // The ghost is created first, so its appends derive first and meet the
    // NOT_FOUND at the head of the append phase.
    const ghost = await store.createConversation("a remote ghost");
    await store.appendMessage(ghost.id, textMessage("g1", "ghost one"));
    await store.appendMessage(ghost.id, textMessage("g2", "ghost two"));
    const healthy = await store.createConversation("healthy");
    await store.appendMessage(healthy.id, textMessage("h1", "healthy one"));

    // The ghost's SERVER copy is gone (deleted on another device; no pull
    // path exists) — its first append is answered NOT_FOUND forever.
    harness.failNextAppend(
      trpcClientError("NOT_FOUND", "Conversation not found"),
    );
    toggle.turnOn();
    const stalled = await store.syncNow();

    expect(stalled.state).toBe("stalled");
    expect(stalled.pending).toBe(2);
    expect(stalled.failure).toBeNull();
    expect(stalled.stall).toEqual({
      kind: "unsyncable-message",
      conversationId: ghost.id,
      messageId: "g1",
      reason: "conversation-deleted-remotely",
    });
    // g1 was attempted; g2 was retired WITHOUT a wasted round-trip; the
    // healthy conversation's append still flowed in the same drain.
    expect(harness.creates).toHaveLength(2);
    expect(
      harness.appends.map(
        (input) => (input.parts[0] as { content: string }).content,
      ),
    ).toEqual(["ghost one", "healthy one"]);

    // The data is NOT silently dropped: both ghost rows still load.
    const loaded = await store.loadConversation(ghost.id);
    expect(loaded?.messages.map((message) => message.id)).toEqual(["g1", "g2"]);

    // And the retired rows are excluded from future derivation: another
    // flush stalls on the same verdict with no new append traffic.
    const appendsBefore = harness.appends.length;
    const again = await store.syncNow();
    expect(again.state).toBe("stalled");
    expect(again.stall).toEqual(stalled.stall);
    expect(harness.appends).toHaveLength(appendsBefore);
  });

  it("retires exactly the refused message row on a BAD_REQUEST append", async () => {
    const harness = transportHarness();
    const toggle = syncToggle();
    const store = await openNodeAgentStore(
      { sync: { transport: harness.transport, enabled: toggle.config } },
      database("append-bad-request"),
    );
    const conversation = await store.createConversation("size-refused");
    await store.appendMessage(
      conversation.id,
      textMessage("big", "too large for the server"),
    );
    await store.appendMessage(conversation.id, textMessage("small", "fine"));

    // The server's serialized-parts bound refuses deterministically (this
    // row predates the store's client-side bound).
    harness.failNextAppend(
      trpcClientError(
        "BAD_REQUEST",
        "The message parts exceed the 10485760-character serialized limit.",
      ),
    );
    toggle.turnOn();
    const stalled = await store.syncNow();

    expect(stalled.state).toBe("stalled");
    expect(stalled.pending).toBe(1);
    expect(stalled.failure).toBeNull();
    expect(stalled.stall).toEqual({
      kind: "unsyncable-message",
      conversationId: conversation.id,
      messageId: "big",
      reason: "parts-too-large",
    });
    // Terminal for THAT row only — the small append behind it still flowed.
    expect(
      harness.appends.map(
        (input) => (input.parts[0] as { content: string }).content,
      ),
    ).toEqual(["too large for the server", "fine"]);
    const loaded = await store.loadConversation(conversation.id);
    expect(loaded?.messages.map((message) => message.id)).toEqual([
      "big",
      "small",
    ]);

    // Later appends to the same conversation still sync; the retired row
    // keeps its pending count and the verdict stays surfaced.
    await store.appendMessage(conversation.id, textMessage("m3", "later"));
    await vi.waitFor(() => {
      expect(
        harness.appends.map(
          (input) => (input.parts[0] as { content: string }).content,
        ),
      ).toEqual(["too large for the server", "fine", "later"]);
      const status = store.getSyncStatus();
      expect(status.state).toBe("stalled");
      expect(status.pending).toBe(1);
    });
  });

  it("keeps a 5xx append retryable: re-queued head-of-line, next flush is the retry", async () => {
    const harness = transportHarness();
    const toggle = syncToggle();
    const store = await openNodeAgentStore(
      { sync: { transport: harness.transport, enabled: toggle.config } },
      database("append-5xx"),
    );
    const conversation = await store.createConversation("flaky server");
    await store.appendMessage(conversation.id, textMessage("m1", "first"));
    await store.appendMessage(conversation.id, textMessage("m2", "second"));

    harness.failNextAppend(
      trpcClientError("INTERNAL_SERVER_ERROR", "the server fell over"),
    );
    toggle.turnOn();
    const failed = await store.syncNow();
    expect(failed.state).toBe("failed");
    expect(failed.pending).toBe(2);
    expect(failed.stall).toBeNull();
    expect(failed.failure).toMatchObject({
      kind: "append-message",
      conversationId: conversation.id,
      messageId: "m1",
    });
    expect(harness.appends).toHaveLength(1);

    // The next flush is the retry: m1 re-delivered (at-least-once), then
    // m2 — head-of-line ordering intact.
    const retried = await store.syncNow();
    expect(retried).toEqual({
      state: "idle",
      pending: 0,
      failure: null,
      stall: null,
    });
    expect(
      harness.appends.map(
        (input) => (input.parts[0] as { content: string }).content,
      ),
    ).toEqual(["first", "first", "second"]);
  });
});
