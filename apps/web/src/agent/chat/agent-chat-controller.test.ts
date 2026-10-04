// @vitest-environment node
// The controller runs over injected chat/store doubles; jsdom adds nothing.

/**
 * The persistence controller's wiring contract (PLAN-AGENT-CHAT Phase
 * 4.4): the chat hook and the Phase 3.4 store are mocked at their seams
 * — an {@link AgentChatSurface} double plus a store double — and the
 * controller must drive exactly the lifecycle the chat panel renders:
 * resume-on-start from the newest saved conversation, one append per new
 * message at RUN COMPLETION (never mid-stream, so parts persist
 * complete), lazily creating the conversation titled from the first user
 * text, strictly ordered, idempotent on repeats), failures surfaced in
 * the snapshot with the unsaved tail left to retry (including through
 * the at-rest retry), and the new/clear split (detach keeps the row;
 * clear deletes it) with lifecycle steps fencing in-flight appends.
 */

import type { UIMessage } from "@tanstack/ai";
import type { ChatClientState } from "@tanstack/ai-client";
import { describe, expect, it, vi } from "vitest";
import type { AgentChatStore } from "../persistence/store";
import type { AgentConversationRow } from "../persistence/rows";
import type { AgentChatSurface } from "./agent-chat-controller";

import { createAgentChatController } from "./agent-chat-controller";

/** A mutable chat-surface double recording what the controller drove. */
function fakeChat() {
  const state = {
    cleared: 0,
    messages: [] as UIMessage[],
    setMessagesCalls: [] as UIMessage[][],
    status: "ready" as ChatClientState,
  };
  const chat: AgentChatSurface = {
    get messages() {
      return state.messages;
    },
    setMessages: (messages) => {
      state.setMessagesCalls.push(messages);
      state.messages = messages;
    },
    clear: () => {
      state.cleared += 1;
      state.messages = [];
    },
    get status() {
      return state.status;
    },
  };
  return { chat, state };
}

/** One conversation-shaped row the store double can hold. */
interface HeldConversation {
  readonly row: AgentConversationRow;
  readonly messages: UIMessage[];
}

/** One persisted message row (the controller never reads its fields). */
function heldRow(message: UIMessage, conversationId: string, seq: number) {
  return {
    id: message.id,
    conversationId,
    createdAt: "2026-10-04T12:00:01.000Z",
    metadata: null,
    name: null,
    parts: "[]",
    role: message.role,
    seq,
    syncedAt: null,
  };
}

/**
 * A store double over plain memory: the Phase 3.4 interface, with every
 * method a spy the tests can script (failures included). The doubles
 * return resolved promises directly (no `async` without `await`).
 */
function fakeStore(seed: HeldConversation[] = []) {
  const conversations = new Map<string, HeldConversation>(
    seed.map((held) => [held.row.id, held]),
  );
  const createConversation = vi.fn((title: string) => {
    const row: AgentConversationRow = {
      id: `conv-${String(conversations.size + 1)}`,
      title,
      createdAt: "2026-10-04T12:00:00.000Z",
      updatedAt: "2026-10-04T12:00:00.000Z",
      serverId: null,
    };
    conversations.set(row.id, { messages: [], row });
    return Promise.resolve(row);
  });
  const baseAppend = (
    conversationId: string,
    message: UIMessage,
  ): Promise<ReturnType<typeof heldRow>> => {
    const held = conversations.get(conversationId);
    if (held === undefined) {
      return Promise.reject(
        new RangeError(
          `appendMessage: unknown conversation "${conversationId}".`,
        ),
      );
    }
    held.messages.push(message);
    return Promise.resolve(
      heldRow(message, conversationId, held.messages.length),
    );
  };
  const appendMessage = vi.fn(baseAppend);
  const deleteConversation = vi.fn((conversationId: string) =>
    Promise.resolve(conversations.delete(conversationId)),
  );
  const store: AgentChatStore = {
    appendMessage: (conversationId, message) =>
      appendMessage(conversationId, message),
    createConversation: (title) => createConversation(title),
    deleteConversation: (conversationId) => deleteConversation(conversationId),
    getSyncStatus: () => ({ state: "idle", pending: 0, failure: null }),
    listConversations: () =>
      Promise.resolve(
        [...conversations.values()]
          .map((held) => held.row)
          .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
      ),
    loadConversation: (conversationId) => {
      const held = conversations.get(conversationId);
      return Promise.resolve(
        held === undefined
          ? null
          : { conversation: held.row, messages: [...held.messages] },
      );
    },
    onSyncStatusChange: () => () => {},
    syncNow: () =>
      Promise.resolve({ state: "idle", pending: 0, failure: null }),
  };
  return {
    appendMessage,
    baseAppend,
    conversations,
    createConversation,
    deleteConversation,
    store,
  };
}

function textMessage(
  id: string,
  content: string,
  role: UIMessage["role"],
): UIMessage {
  return { id, role, parts: [{ type: "text", content }] };
}

/** Drains the controller's serialized append queue (a macrotask hop). */
async function settle(): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

describe("start (resume)", () => {
  it("loads the newest saved conversation into the chat and tracks its ids", async () => {
    const { chat } = fakeChat();
    const saved: HeldConversation = {
      messages: [textMessage("u1", "hello", "user")],
      row: {
        id: "conv-saved",
        title: "hello",
        createdAt: "2026-10-04T12:00:00.000Z",
        updatedAt: "2026-10-04T12:00:02.000Z",
        serverId: null,
      },
    };
    const controller = createAgentChatController({
      getChat: () => chat,
      store: fakeStore([saved]).store,
    });

    await controller.start();

    expect(chat.messages.map((message) => message.id)).toEqual(["u1"]);
    expect(controller.getSnapshot()).toEqual({
      conversationId: "conv-saved",
      conversationTitle: "hello",
      error: null,
    });

    // A repeated start never double-loads (idempotent).
    await controller.start();
    expect(chat.messages).toHaveLength(1);
  });

  it("does nothing when nothing is saved", async () => {
    const { chat, state } = fakeChat();
    const controller = createAgentChatController({
      getChat: () => chat,
      store: fakeStore().store,
    });

    await controller.start();

    expect(state.setMessagesCalls).toHaveLength(0);
    expect(controller.getSnapshot().conversationId).toBeNull();
  });

  it("surfaces a resume failure instead of throwing", async () => {
    const { chat } = fakeChat();
    const { store } = fakeStore();
    store.listConversations = () =>
      Promise.reject(new Error("store unavailable"));
    const controller = createAgentChatController({
      getChat: () => chat,
      store,
    });

    await controller.start();

    const snapshot = controller.getSnapshot();
    expect(snapshot.error).toContain("Could not resume");
    expect(snapshot.error).toContain("store unavailable");
  });

  it("is a no-op without a store (ephemeral chat)", async () => {
    const { chat, state } = fakeChat();
    const controller = createAgentChatController({
      getChat: () => chat,
      store: null,
    });

    await controller.start();
    controller.receiveMessages([textMessage("u1", "hi", "user")]);
    await settle();

    expect(state.setMessagesCalls).toHaveLength(0);
    expect(controller.getSnapshot()).toEqual({
      conversationId: null,
      conversationTitle: null,
      error: null,
    });
  });
});

describe("receiveMessages (append on message completion)", () => {
  it("lazily creates the conversation titled from the first user text", async () => {
    const { chat } = fakeChat();
    const doubles = fakeStore();
    const controller = createAgentChatController({
      getChat: () => chat,
      store: doubles.store,
    });
    await controller.start();

    controller.receiveMessages([
      textMessage("u1", "  extrude the base  ", "user"),
    ]);
    await settle();

    expect(doubles.createConversation).toHaveBeenCalledOnce();
    expect(doubles.createConversation.mock.calls[0]?.[0]).toBe(
      "extrude the base",
    );
    expect(controller.getSnapshot().conversationTitle).toBe("extrude the base");
  });

  it("bounds the derived title to the store's own limit", async () => {
    const { chat } = fakeChat();
    const doubles = fakeStore();
    const controller = createAgentChatController({
      getChat: () => chat,
      store: doubles.store,
    });
    await controller.start();

    controller.receiveMessages([textMessage("u1", "x".repeat(500), "user")]);
    await settle();

    expect(
      doubles.createConversation.mock.calls[0]?.[0].length,
    ).toBeLessThanOrEqual(200);
  });

  it("appends each message exactly once, in order, to one conversation", async () => {
    const { chat } = fakeChat();
    const doubles = fakeStore();
    const controller = createAgentChatController({
      getChat: () => chat,
      store: doubles.store,
    });
    await controller.start();

    controller.receiveMessages([
      textMessage("u1", "extrude the base", "user"),
      textMessage("a1", "Done.", "assistant"),
    ]);
    await settle();

    expect(doubles.createConversation).toHaveBeenCalledOnce();
    expect(doubles.appendMessage).toHaveBeenCalledTimes(2);
    expect(doubles.appendMessage.mock.calls[0]?.[1].id).toBe("u1");
    expect(doubles.appendMessage.mock.calls[1]?.[1].id).toBe("a1");
    const conversationId = doubles.appendMessage.mock.calls[0]?.[0];
    expect(
      doubles.appendMessage.mock.calls.every(
        (call) => call[0] === conversationId,
      ),
    ).toBe(true);

    // The same messages again (a re-render) append nothing new.
    controller.receiveMessages([
      textMessage("u1", "extrude the base", "user"),
      textMessage("a1", "Done.", "assistant"),
    ]);
    await settle();
    expect(doubles.appendMessage).toHaveBeenCalledTimes(2);

    // A later message appends only itself.
    controller.receiveMessages([
      textMessage("u1", "extrude the base", "user"),
      textMessage("a1", "Done.", "assistant"),
      textMessage("u2", "and a hole", "user"),
    ]);
    await settle();
    expect(doubles.appendMessage).toHaveBeenCalledTimes(3);
    expect(doubles.appendMessage.mock.calls[2]?.[1].id).toBe("u2");
  });

  it("surfaces an append failure and retries exactly the unsaved tail", async () => {
    const { chat } = fakeChat();
    const doubles = fakeStore();
    let failNext = true;
    doubles.appendMessage.mockImplementation(
      (conversationId: string, message: UIMessage) => {
        if (failNext) {
          failNext = false;
          return Promise.reject(new Error("write failed"));
        }
        return doubles.baseAppend(conversationId, message);
      },
    );
    const controller = createAgentChatController({
      getChat: () => chat,
      store: doubles.store,
    });
    await controller.start();

    controller.receiveMessages([
      textMessage("u1", "hello", "user"),
      textMessage("a1", "hi", "assistant"),
    ]);
    await settle();

    // The first append failed: the failure surfaced, never thrown.
    expect(controller.getSnapshot().error).toContain("Could not save");
    expect(controller.getSnapshot().error).toContain("write failed");

    // The retry pass saves the whole unsaved batch, in order.
    controller.receiveMessages([
      textMessage("u1", "hello", "user"),
      textMessage("a1", "hi", "assistant"),
    ]);
    await settle();
    expect(doubles.appendMessage).toHaveBeenCalledTimes(3);
    expect(doubles.appendMessage.mock.calls[1]?.[1].id).toBe("u1");
    expect(doubles.appendMessage.mock.calls[2]?.[1].id).toBe("a1");
    const held = [...doubles.conversations.values()][0];
    expect(held).toBeDefined();
    expect(held?.messages.map((message) => message.id)).toEqual(["u1", "a1"]);
  });

  it("skips live-run passes and appends each message once, with its complete parts, at run completion", async () => {
    const { chat, state } = fakeChat();
    const doubles = fakeStore();
    const controller = createAgentChatController({
      getChat: () => chat,
      store: doubles.store,
    });
    await controller.start();

    // Three stream deltas under ONE assistant id — the panel effect
    // fires once per delta, each while the owning run is live (first as
    // "submitted", then "streaming").
    const run = (assistantText: string): UIMessage[] => [
      textMessage("u1", "make a box", "user"),
      textMessage("a1", assistantText, "assistant"),
    ];
    state.status = "submitted";
    controller.receiveMessages(run("Mak"));
    state.status = "streaming";
    controller.receiveMessages(run("Makes a b"));
    controller.receiveMessages(run("Makes a box with a hole."));
    await settle();

    // Nothing was snapshotted mid-run: no conversation, no rows.
    expect(doubles.createConversation).not.toHaveBeenCalled();
    expect(doubles.appendMessage).not.toHaveBeenCalled();

    // The run completes (the effect re-fires on the status settling):
    // the one completion pass appends each message exactly once, with
    // its full final parts.
    state.status = "ready";
    controller.receiveMessages(run("Makes a box with a hole."));
    await settle();

    expect(doubles.createConversation).toHaveBeenCalledOnce();
    expect(doubles.appendMessage).toHaveBeenCalledTimes(2);
    expect(doubles.appendMessage.mock.calls[0]?.[1].id).toBe("u1");
    expect(doubles.appendMessage.mock.calls[1]?.[1].id).toBe("a1");
    const held = [...doubles.conversations.values()][0];
    expect(held).toBeDefined();
    expect(held?.messages).toHaveLength(2);
    expect(held?.messages[1]?.parts).toEqual([
      { type: "text", content: "Makes a box with a hole." },
    ]);
  });
});

describe("retryPersistence (the at-rest retry)", () => {
  it("clears the surfaced failure and persists exactly the unsaved tail", async () => {
    const { chat } = fakeChat();
    const doubles = fakeStore();
    let failNext = true;
    doubles.appendMessage.mockImplementation(
      (conversationId: string, message: UIMessage) => {
        if (failNext) {
          failNext = false;
          return Promise.reject(new Error("write failed"));
        }
        return doubles.baseAppend(conversationId, message);
      },
    );
    const controller = createAgentChatController({
      getChat: () => chat,
      store: doubles.store,
    });
    await controller.start();
    chat.setMessages([textMessage("u1", "hello", "user")]);
    controller.receiveMessages(chat.messages);
    await settle();
    expect(controller.getSnapshot().error).toContain("Could not save");

    controller.retryPersistence();
    await settle();

    expect(controller.getSnapshot().error).toBeNull();
    const held = [...doubles.conversations.values()][0];
    expect(held).toBeDefined();
    expect(held?.messages.map((message) => message.id)).toEqual(["u1"]);
  });

  it("defers a retry requested while a run is live to that run's completion pass", async () => {
    const { chat, state } = fakeChat();
    const doubles = fakeStore();
    let failNext = true;
    doubles.appendMessage.mockImplementation(
      (conversationId: string, message: UIMessage) => {
        if (failNext) {
          failNext = false;
          return Promise.reject(new Error("write failed"));
        }
        return doubles.baseAppend(conversationId, message);
      },
    );
    const controller = createAgentChatController({
      getChat: () => chat,
      store: doubles.store,
    });
    await controller.start();
    chat.setMessages([textMessage("u1", "hello", "user")]);
    controller.receiveMessages(chat.messages);
    await settle();
    expect(controller.getSnapshot().error).toContain("Could not save");

    // The user sends again and clicks the retry while the run is live:
    // the retry clears the surfaced line but the pass waits (at-rest).
    state.status = "streaming";
    controller.retryPersistence();
    await settle();
    expect(controller.getSnapshot().error).toBeNull();
    expect(doubles.appendMessage).toHaveBeenCalledTimes(1);

    // The run's completion pass persists the whole unsaved tail.
    state.status = "ready";
    chat.setMessages([
      textMessage("u1", "hello", "user"),
      textMessage("a1", "hi", "assistant"),
    ]);
    controller.receiveMessages(chat.messages);
    await settle();
    expect(controller.getSnapshot().error).toBeNull();
    const held = [...doubles.conversations.values()][0];
    expect(held).toBeDefined();
    expect(held?.messages.map((message) => message.id)).toEqual(["u1", "a1"]);
  });
});

describe("newConversation / clearConversation", () => {
  it("new detaches without deleting: the row survives, the next send opens a fresh one", async () => {
    const { chat, state } = fakeChat();
    const doubles = fakeStore();
    const controller = createAgentChatController({
      getChat: () => chat,
      store: doubles.store,
    });
    await controller.start();
    controller.receiveMessages([textMessage("u1", "hello", "user")]);
    await settle();
    expect(doubles.conversations).toHaveLength(1);

    controller.newConversation();

    expect(state.cleared).toBe(1);
    expect(controller.getSnapshot().conversationId).toBeNull();
    expect(doubles.deleteConversation).not.toHaveBeenCalled();
    expect(doubles.conversations).toHaveLength(1);

    controller.receiveMessages([textMessage("u2", "again", "user")]);
    await settle();
    expect(doubles.createConversation).toHaveBeenCalledTimes(2);
    expect(doubles.conversations).toHaveLength(2);
  });

  it("clear deletes the active conversation's rows and clears the transcript", async () => {
    const { chat, state } = fakeChat();
    const doubles = fakeStore();
    const controller = createAgentChatController({
      getChat: () => chat,
      store: doubles.store,
    });
    await controller.start();
    controller.receiveMessages([
      textMessage("u1", "hello", "user"),
      textMessage("a1", "hi", "assistant"),
    ]);
    await settle();
    const activeId = controller.getSnapshot().conversationId;

    const existed = await controller.clearConversation();

    expect(existed).toBe(true);
    expect(doubles.deleteConversation).toHaveBeenCalledWith(activeId);
    expect(doubles.conversations).toHaveLength(0);
    expect(state.cleared).toBe(1);
    expect(controller.getSnapshot().conversationId).toBeNull();
  });

  it("clear without an active conversation clears the transcript and deletes nothing", async () => {
    const { chat, state } = fakeChat();
    const doubles = fakeStore();
    const controller = createAgentChatController({
      getChat: () => chat,
      store: doubles.store,
    });
    await controller.start();

    const existed = await controller.clearConversation();

    expect(existed).toBe(false);
    expect(doubles.deleteConversation).not.toHaveBeenCalled();
    expect(state.cleared).toBe(1);
  });

  it("surfaces a delete failure instead of throwing", async () => {
    const { chat } = fakeChat();
    const doubles = fakeStore();
    doubles.deleteConversation.mockRejectedValue(new Error("delete refused"));
    const controller = createAgentChatController({
      getChat: () => chat,
      store: doubles.store,
    });
    await controller.start();
    controller.receiveMessages([textMessage("u1", "hello", "user")]);
    await settle();

    const existed = await controller.clearConversation();

    expect(existed).toBe(false);
    expect(controller.getSnapshot().error).toContain("delete refused");
  });

  it("drops an append queued before newConversation instead of minting a phantom conversation", async () => {
    const { chat } = fakeChat();
    const doubles = fakeStore();
    const controller = createAgentChatController({
      getChat: () => chat,
      store: doubles.store,
    });
    await controller.start();

    controller.receiveMessages([textMessage("u1", "hello", "user")]);
    // The detach lands BEFORE the serialized queue drains.
    controller.newConversation();
    await settle();

    expect(doubles.createConversation).not.toHaveBeenCalled();
    expect(doubles.appendMessage).not.toHaveBeenCalled();
    expect(controller.getSnapshot().conversationId).toBeNull();
    expect(controller.getSnapshot().error).toBeNull();

    // The next send of the fresh transcript opens its own conversation —
    // carrying only its own messages, never the detached batch.
    controller.receiveMessages([textMessage("u2", "again", "user")]);
    await settle();
    expect(doubles.createConversation).toHaveBeenCalledOnce();
    const held = [...doubles.conversations.values()][0];
    expect(held).toBeDefined();
    expect(held?.messages.map((message) => message.id)).toEqual(["u2"]);
  });

  it("never adopts a conversation whose create landed after the detach", async () => {
    const { chat } = fakeChat();
    const doubles = fakeStore();
    let resolveCreate: ((row: AgentConversationRow) => void) | undefined;
    doubles.createConversation.mockImplementationOnce(
      () =>
        new Promise<AgentConversationRow>((resolve) => {
          resolveCreate = resolve;
        }),
    );
    const controller = createAgentChatController({
      getChat: () => chat,
      store: doubles.store,
    });
    await controller.start();

    controller.receiveMessages([textMessage("u1", "hello", "user")]);
    // Drain until the batch sits on the deferred create.
    await settle();
    expect(resolveCreate).toBeDefined();

    controller.newConversation();
    resolveCreate?.({
      id: "conv-orphan",
      title: "hello",
      createdAt: "2026-10-04T12:00:00.000Z",
      updatedAt: "2026-10-04T12:00:00.000Z",
      serverId: null,
    });
    await settle();

    // The orphan row is neither adopted nor appended to (and is removed
    // best-effort); the controller stays detached with nothing surfaced.
    expect(controller.getSnapshot().conversationId).toBeNull();
    expect(controller.getSnapshot().error).toBeNull();
    expect(doubles.deleteConversation).toHaveBeenCalledWith("conv-orphan");
    expect(doubles.appendMessage).not.toHaveBeenCalled();
  });

  it("drops an in-flight append racing clearConversation — silent, never 'could not save'", async () => {
    const { chat } = fakeChat();
    const doubles = fakeStore();
    let rejectAppend: ((error: Error) => void) | undefined;
    doubles.appendMessage.mockImplementationOnce(
      () =>
        new Promise<ReturnType<typeof heldRow>>((_resolve, reject) => {
          rejectAppend = reject;
        }),
    );
    const controller = createAgentChatController({
      getChat: () => chat,
      store: doubles.store,
    });
    await controller.start();
    controller.receiveMessages([textMessage("u1", "hello", "user")]);
    // Drain until the batch sits on the deferred append.
    await settle();
    expect(rejectAppend).toBeDefined();

    const clearing = controller.clearConversation();
    // The store rejects the write whose target the clear just deleted.
    rejectAppend?.(
      new RangeError('appendMessage: unknown conversation "conv-1".'),
    );
    await clearing;
    await settle();

    expect(controller.getSnapshot().conversationId).toBeNull();
    expect(controller.getSnapshot().error).toBeNull();
  });
});

describe("subscribe", () => {
  it("notifies on snapshot commits and stops after unsubscribe", async () => {
    const { chat } = fakeChat();
    const listener = vi.fn();
    const controller = createAgentChatController({
      getChat: () => chat,
      store: fakeStore().store,
    });
    const unsubscribe = controller.subscribe(listener);

    await controller.start();
    controller.receiveMessages([textMessage("u1", "hello", "user")]);
    await settle();
    expect(listener).toHaveBeenCalled();

    // Stability between commits: the snapshot object is cached.
    const first = controller.getSnapshot();
    expect(controller.getSnapshot()).toBe(first);

    unsubscribe();
    controller.newConversation();
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
