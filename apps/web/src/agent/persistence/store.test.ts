// @vitest-environment node
// The store runs on the injected node persistence; jsdom adds nothing.

/**
 * The agent chat store's lifecycle contract (PLAN-AGENT-CHAT Phase 3.4,
 * D3): create/append/load(resume)/list/delete-clears-rows, keyed
 * client-side, durable across a full reopen (a fresh persistence +
 * collections over the same temp file — the reload simulation), with the
 * tRPC-mirroring input bounds, collection-id isolation (the collection id
 * IS the SQLite table), and the opt-in-sync OFF default (a configured
 * transport is never called until enabled).
 */

import type { UIMessage } from "@tanstack/ai";
import { AGENT_MESSAGE_PARTS_MAX_SERIALIZED_LENGTH } from "@slopcad/api/limits";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { AgentSyncTransport } from "./sync";

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

/** Deterministic ids and timestamps: sequential counters over a fixed epoch. */
function fixedSequence(): {
  readonly now: () => Date;
  readonly newId: () => string;
} {
  let tick = 0;
  return {
    now: () => new Date(Date.UTC(2026, 9, 4, 12, 0, 0) + tick++ * 1000),
    newId: () => `id-${String(tick).padStart(3, "0")}`,
  };
}

function textMessage(
  id: string,
  content: string,
  role: UIMessage["role"],
): UIMessage {
  return { id, role, parts: [{ type: "text", content }] };
}

/**
 * A transport that must never be called — every method is a vi.fn so the
 * "sync off" test can assert the opt-in held.
 */
function untouchedTransport(): {
  readonly transport: AgentSyncTransport;
  readonly createConversation: ReturnType<typeof vi.fn>;
  readonly appendMessage: ReturnType<typeof vi.fn>;
  readonly deleteConversation: ReturnType<typeof vi.fn>;
} {
  const refuse = (where: string) =>
    vi.fn((): Promise<never> =>
      Promise.reject(
        new Error(`TEST: sync transport (${where}) called while sync is off`),
      ),
    );
  const createConversation = refuse("create");
  const appendMessage = refuse("append");
  const deleteConversation = refuse("delete");
  return {
    transport: { createConversation, appendMessage, deleteConversation },
    createConversation,
    appendMessage,
    deleteConversation,
  };
}

describe("agent chat store lifecycle", () => {
  it("validates titles exactly like the tRPC create it mirrors", async () => {
    const store = await openNodeAgentStore({}, database("titles"));
    await expect(store.createConversation("   ")).rejects.toThrow(RangeError);
    await expect(store.createConversation("x".repeat(201))).rejects.toThrow(
      RangeError,
    );
    const trimmed = await store.createConversation("  Bracket revision  ");
    expect(trimmed.title).toBe("Bracket revision");
  });

  it("lifecycle: create → append → resume in order, updatedAt stamped", async () => {
    const sequence = fixedSequence();
    const store = await openNodeAgentStore(
      { now: sequence.now, newId: sequence.newId },
      database("lifecycle"),
    );

    const conversation = await store.createConversation("First chat");
    await store.appendMessage(
      conversation.id,
      textMessage("m1", "extrude this", "user"),
    );
    await store.appendMessage(
      conversation.id,
      textMessage("m2", "applied the extrude", "assistant"),
    );
    await store.appendMessage(
      conversation.id,
      textMessage("m3", "capture a view", "user"),
    );

    const loaded = await store.loadConversation(conversation.id);
    const messages = loaded?.messages ?? [];
    expect(loaded?.conversation.title).toBe("First chat");
    expect(messages.map((m) => m.id)).toEqual(["m1", "m2", "m3"]);
    expect(messages[1]?.parts).toEqual([
      { type: "text", content: "applied the extrude" },
    ]);
    // The appends stamped updatedAt later than createdAt (fixed clock).
    const resumedConversation = loaded?.conversation;
    expect(
      resumedConversation !== undefined &&
        resumedConversation.updatedAt > resumedConversation.createdAt,
    ).toBe(true);
    expect(resumedConversation?.serverId).toBeNull();
  });

  it("resumes losslessly after a full reopen (persistence round-trip)", async () => {
    const path = database("resume");

    const writer = await openNodeAgentStore({}, path);
    const conversation = await writer.createConversation("Durable chat");
    const message: UIMessage = {
      id: "m-1",
      role: "assistant",
      parts: [
        { type: "text", content: "done" },
        {
          type: "tool-result",
          toolCallId: "call-1",
          content: "ok",
          state: "complete",
          createdAt: new Date("2026-10-04T12:00:05.000Z"),
        },
      ],
      createdAt: new Date("2026-10-04T12:00:05.000Z"),
    };
    await writer.appendMessage(conversation.id, message);

    // A FRESH persistence + collections over the same file: a reload.
    // Parts come back verbatim as stored JSON (a Date inside a part
    // persists as its ISO string — the JSON convention); the row-level
    // message createdAt is the one revived Date.
    const reader = await openNodeAgentStore({}, path);
    const resumed = await reader.loadConversation(conversation.id);
    expect(resumed?.messages).toEqual([
      {
        id: "m-1",
        role: "assistant",
        parts: [
          { type: "text", content: "done" },
          {
            type: "tool-result",
            toolCallId: "call-1",
            content: "ok",
            state: "complete",
            createdAt: "2026-10-04T12:00:05.000Z",
          },
        ],
        createdAt: new Date("2026-10-04T12:00:05.000Z"),
      },
    ]);
  });

  it("lists conversations newest-updated first with the id tiebreak", async () => {
    const sequence = fixedSequence();
    const store = await openNodeAgentStore(
      { now: sequence.now, newId: sequence.newId },
      database("list"),
    );
    const older = await store.createConversation("older");
    const newer = await store.createConversation("newer");
    await store.appendMessage(
      older.id,
      textMessage("m-old", "bump older", "user"),
    );
    const listed = await store.listConversations();
    expect(listed.map((row) => row.id)).toEqual([older.id, newer.id]);
  });

  it("delete clears rows durably (messages and conversation, after reopen too)", async () => {
    const sequence = fixedSequence();
    const path = database("delete");
    const store = await openNodeAgentStore(
      { now: sequence.now, newId: sequence.newId },
      path,
    );
    const conversation = await store.createConversation("to delete");
    await store.appendMessage(conversation.id, textMessage("m1", "x", "user"));
    await store.appendMessage(
      conversation.id,
      textMessage("m2", "y", "assistant"),
    );

    expect(await store.deleteConversation(conversation.id)).toBe(true);
    expect(await store.deleteConversation(conversation.id)).toBe(false);
    expect(await store.loadConversation(conversation.id)).toBeNull();
    expect(await store.listConversations()).toEqual([]);

    const reopened = await openNodeAgentStore({}, path);
    expect(await reopened.loadConversation(conversation.id)).toBeNull();
    expect(await reopened.listConversations()).toEqual([]);
  });

  it("isolates the two collections: the same key value coexists in both tables", async () => {
    const sequence = fixedSequence();
    const store = await openNodeAgentStore(
      { now: sequence.now, newId: () => "shared-key" },
      database("isolation"),
    );
    // The conversation AND the message deliberately carry the SAME id: the
    // two collections are separate SQLite tables (their ids ARE the table
    // names), so the keys cannot clash — pinning the spike's lesson.
    const conversation = await store.createConversation("collision chat");
    expect(conversation.id).toBe("shared-key");
    const row = await store.appendMessage(
      conversation.id,
      textMessage("shared-key", "hello", "user"),
    );
    expect(row.conversationId).toBe("shared-key");
    const loaded = await store.loadConversation(conversation.id);
    expect(loaded?.conversation.id).toBe("shared-key");
    expect(loaded?.messages.map((m) => m.id)).toEqual(["shared-key"]);
    // Scoping: deleting the conversation takes exactly its own message rows.
    expect(await store.deleteConversation(conversation.id)).toBe(true);
    expect(await store.loadConversation(conversation.id)).toBeNull();
  });

  it("rejects unknown conversations and over-limit parts counts", async () => {
    const sequence = fixedSequence();
    const store = await openNodeAgentStore(
      { now: sequence.now, newId: sequence.newId },
      database("bounds"),
    );
    await expect(
      store.appendMessage("missing", textMessage("m1", "x", "user")),
    ).rejects.toThrow(RangeError);
    const conversation = await store.createConversation("bounds chat");
    const oversized: UIMessage = {
      id: "m-big",
      role: "user",
      parts: Array.from({ length: 257 }, (_, index) => ({
        type: "text",
        content: `part ${index}`,
      })),
    };
    await expect(
      store.appendMessage(conversation.id, oversized),
    ).rejects.toThrow(RangeError);
  });

  it("rejects over-cap serialized parts locally before anything persists", async () => {
    const store = await openNodeAgentStore({}, database("serialized-bound"));
    const conversation = await store.createConversation("capped");
    const oversized: UIMessage = {
      id: "m-cap",
      role: "user",
      parts: [
        {
          type: "text",
          content: "x".repeat(AGENT_MESSAGE_PARTS_MAX_SERIALIZED_LENGTH),
        },
      ],
    };
    await expect(
      store.appendMessage(conversation.id, oversized),
    ).rejects.toThrow(RangeError);
    // Nothing was persisted: no message row, and the conversation's
    // updatedAt was never stamped. An accepted-but-doomed row would
    // deterministically poison the sync outbox forever.
    const loaded = await store.loadConversation(conversation.id);
    expect(loaded?.messages).toEqual([]);
    expect(loaded?.conversation.updatedAt).toBe(loaded?.conversation.createdAt);
  });

  it("serializes append against delete: no orphan row, no post-commit throw", async () => {
    const path = database("race");
    const store = await openNodeAgentStore(
      {
        sync: { transport: untouchedTransport().transport, enabled: false },
      },
      path,
    );
    const conversation = await store.createConversation("racy");

    // Append called first: the whole append (insert + updatedAt stamp)
    // runs to completion before the delete starts clearing, so both
    // succeed and nothing survives the delete.
    const appendPromise = store.appendMessage(
      conversation.id,
      textMessage("m1", "x", "user"),
    );
    const deletePromise = store.deleteConversation(conversation.id);
    expect(await appendPromise).toBeDefined();
    expect(await deletePromise).toBe(true);
    expect(await store.loadConversation(conversation.id)).toBeNull();
    // The backlog is empty — an orphan message row would be counted here
    // forever (and never delivered).
    expect((await store.syncNow()).pending).toBe(0);

    // Delete called first: the append finds no conversation and fails
    // with the typed RangeError — never a post-commit stamp crash over a
    // message that did persist.
    const second = await store.createConversation("racy 2");
    const secondDelete = store.deleteConversation(second.id);
    const secondAppend = store.appendMessage(
      second.id,
      textMessage("m2", "y", "user"),
    );
    expect(await secondDelete).toBe(true);
    await expect(secondAppend).rejects.toThrow(RangeError);
    expect((await store.syncNow()).pending).toBe(0);

    // Durable: a reopen shows no rows and no backlog either way.
    const reopened = await openNodeAgentStore(
      {
        sync: { transport: untouchedTransport().transport, enabled: false },
      },
      path,
    );
    expect(await reopened.listConversations()).toEqual([]);
    expect((await reopened.syncNow()).pending).toBe(0);
  });

  it("removeMessages removes exactly the given ids and survives a reopen", async () => {
    const path = database("remove-messages");
    const store = await openNodeAgentStore({}, path);
    const conversation = await store.createConversation("prune me");
    await store.appendMessage(
      conversation.id,
      textMessage("m1", "keep", "user"),
    );
    await store.appendMessage(
      conversation.id,
      textMessage("m2", "drop", "assistant"),
    );
    await store.appendMessage(
      conversation.id,
      textMessage("m3", "drop too", "user"),
    );

    await store.removeMessages(["m2", "m3", "m-unknown"]);
    const loaded = await store.loadConversation(conversation.id);
    expect(loaded?.messages.map((m) => m.id)).toEqual(["m1"]);
    expect(loaded?.conversation.id).toBe(conversation.id);
    // Empty and already-removed inputs are no-ops, not throws.
    await expect(store.removeMessages([])).resolves.toBeUndefined();
    await expect(
      store.removeMessages(["m2", "m-unknown"]),
    ).resolves.toBeUndefined();
    expect(await store.loadConversation(conversation.id)).not.toBeNull();

    const reopened = await openNodeAgentStore({}, path);
    const resumed = await reopened.loadConversation(conversation.id);
    expect(resumed?.messages.map((m) => m.id)).toEqual(["m1"]);
  });

  it("never calls a configured transport while sync is disabled", async () => {
    const sequence = fixedSequence();
    const harness = untouchedTransport();
    const store = await openNodeAgentStore(
      {
        now: sequence.now,
        newId: sequence.newId,
        sync: { transport: harness.transport, enabled: false },
      },
      database("off"),
    );
    const conversation = await store.createConversation("offline chat");
    await store.appendMessage(conversation.id, textMessage("m1", "x", "user"));
    // Sync is off, so syncNow is a no-op drain — but the backlog is honest:
    // one pending create + one pending append, surfaced, not pushed.
    const status = await store.syncNow();
    expect(status.state).toBe("idle");
    expect(status.pending).toBe(2);
    expect(status.failure).toBeNull();
    await store.deleteConversation(conversation.id);
    expect(store.getSyncStatus().pending).toBe(0);
    expect(harness.createConversation).not.toHaveBeenCalled();
    expect(harness.appendMessage).not.toHaveBeenCalled();
    expect(harness.deleteConversation).not.toHaveBeenCalled();
  });
});
