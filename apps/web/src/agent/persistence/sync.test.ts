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
import type {
  AgentSyncAppendInput,
  AgentSyncCreateInput,
  AgentSyncDeleteInput,
  AgentSyncStatus,
  AgentSyncTransport,
} from "./sync";

import {
  openNodeAgentStore,
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
} {
  let on = false;
  return { config: () => on, turnOn: () => (on = true) };
}

/** The recording, failure-injecting transport double. */
interface TransportHarness {
  readonly transport: AgentSyncTransport;
  readonly creates: AgentSyncCreateInput[];
  readonly appends: AgentSyncAppendInput[];
  readonly deletes: AgentSyncDeleteInput[];
  readonly failNextCreate: (error: Error) => void;
  readonly failNextAppend: (error: Error) => void;
}

function transportHarness(): TransportHarness {
  const creates: AgentSyncCreateInput[] = [];
  const appends: AgentSyncAppendInput[] = [];
  const deletes: AgentSyncDeleteInput[] = [];
  const createFailures: Error[] = [];
  const appendFailures: Error[] = [];
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

    expect(final).toEqual({ state: "idle", pending: 0, failure: null });
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
    await vi.waitFor(() => {
      expect(harness.appends).toHaveLength(1);
    });
    expect(store.getSyncStatus()).toEqual({
      state: "idle",
      pending: 0,
      failure: null,
    });
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
    expect(retried).toEqual({ state: "idle", pending: 0, failure: null });
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
});
