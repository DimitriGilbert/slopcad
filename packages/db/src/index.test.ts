import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { createInMemoryDb } from "./index";
import * as schema from "./schema";

describe("db schema", () => {
  it("round-trips a user through the drizzle schema", async () => {
    const db = await createInMemoryDb();
    const inserted = await db
      .insert(schema.user)
      .values({
        id: "user-1",
        name: "Ada Lovelace",
        email: "ada@slopcad.dev",
      })
      .returning();

    expect(inserted).toHaveLength(1);
    expect(inserted[0]?.email).toBe("ada@slopcad.dev");
    expect(inserted[0]?.emailVerified).toBe(false);
    expect(inserted[0]?.createdAt).toBeInstanceOf(Date);

    const found = await db.query.user.findFirst({
      where: eq(schema.user.email, "ada@slopcad.dev"),
    });
    expect(found?.name).toBe("Ada Lovelace");
  });

  it("enforces the unique email constraint", async () => {
    const db = await createInMemoryDb();
    const row = { id: "user-2", name: "Duplicate", email: "dup@slopcad.dev" };
    await db.insert(schema.user).values(row);

    await expect(
      db.insert(schema.user).values({ ...row, id: "user-3" }),
    ).rejects.toThrow();
  });
});

describe("user_options", () => {
  it("round-trips the agent.server-ai flag and enforces unique(userId, name)", async () => {
    const db = await createInMemoryDb();
    const userId = "user-opt-1";
    await db.insert(schema.user).values({
      id: userId,
      name: "Grace Hopper",
      email: "grace@slopcad.dev",
    });

    const inserted = await db
      .insert(schema.userOptions)
      .values({ id: "opt-1", userId, name: "agent.server-ai", value: "true" })
      .returning();

    expect(inserted).toHaveLength(1);
    expect(inserted[0]?.value).toBe("true");
    expect(inserted[0]?.updatedAt).toBeInstanceOf(Date);

    await expect(
      db.insert(schema.userOptions).values({
        id: "opt-2",
        userId,
        name: "agent.server-ai",
        value: "false",
      }),
    ).rejects.toThrow();

    // A different name for the same user is a distinct option.
    const other = await db
      .insert(schema.userOptions)
      .values({ id: "opt-3", userId, name: "ui.theme", value: "dark" })
      .returning();
    expect(other).toHaveLength(1);
  });
});

describe("agent conversations", () => {
  it("round-trips conversations and JSON message parts with relations wired", async () => {
    const db = await createInMemoryDb();
    const userId = "user-agent-1";
    await db.insert(schema.user).values({
      id: userId,
      name: "Alan Turing",
      email: "alan@slopcad.dev",
    });
    await db
      .insert(schema.project)
      .values({ id: "proj-1", ownerId: userId, name: "Bracket" });

    const inserted = await db
      .insert(schema.agentConversations)
      .values({
        id: "conv-1",
        userId,
        projectId: "proj-1",
        title: "Fillet the top edge",
      })
      .returning();

    expect(inserted[0]?.projectId).toBe("proj-1");
    expect(inserted[0]?.createdAt).toBeInstanceOf(Date);

    const userParts = [{ type: "text", text: "fillet the top edge" }];
    await db.insert(schema.agentMessages).values({
      id: "msg-1",
      conversationId: "conv-1",
      role: "user",
      parts: userParts,
    });
    await db.insert(schema.agentMessages).values({
      id: "msg-2",
      conversationId: "conv-1",
      role: "assistant",
      parts: [{ type: "tool-call", name: "cad_apply_commands" }],
    });

    const conversation = await db.query.agentConversations.findFirst({
      where: eq(schema.agentConversations.id, "conv-1"),
      with: { messages: true, project: true },
    });

    expect(conversation?.messages).toHaveLength(2);
    expect(conversation?.messages[0]?.parts).toEqual(userParts);
    expect(conversation?.messages[1]?.parts).toEqual([
      { type: "tool-call", name: "cad_apply_commands" },
    ]);
    expect(conversation?.project?.name).toBe("Bracket");
  });

  it("detaches conversations when their project is deleted, cascades when the user is", async () => {
    const db = await createInMemoryDb();
    const userId = "user-agent-2";
    await db.insert(schema.user).values({
      id: userId,
      name: "Edsger Dijkstra",
      email: "edsger@slopcad.dev",
    });
    await db
      .insert(schema.project)
      .values({ id: "proj-2", ownerId: userId, name: "Gear" });
    await db.insert(schema.agentConversations).values({
      id: "conv-2",
      userId,
      projectId: "proj-2",
      title: "Extrude the gear",
    });
    await db.insert(schema.agentMessages).values({
      id: "msg-3",
      conversationId: "conv-2",
      role: "user",
      parts: [{ type: "text", text: "extrude 5mm" }],
    });

    await db.delete(schema.project).where(eq(schema.project.id, "proj-2"));
    const detached = await db.query.agentConversations.findFirst({
      where: eq(schema.agentConversations.id, "conv-2"),
    });
    expect(detached?.projectId).toBeNull();

    await db.delete(schema.user).where(eq(schema.user.id, userId));
    expect(await db.query.agentConversations.findMany()).toHaveLength(0);
    expect(await db.query.agentMessages.findMany()).toHaveLength(0);
  });
});

describe("model catalog", () => {
  it("round-trips entries keyed by (provider, modelId) with JSON reasoning options", async () => {
    const db = await createInMemoryDb();

    const inserted = await db
      .insert(schema.modelCatalogEntries)
      .values({
        provider: "anthropic",
        modelId: "claude-haiku-4-5",
        name: "Claude Haiku 4.5",
        releaseDate: "2025-10-15",
        vision: true,
        contextLimit: 200000,
        reasoningOptions: [{ type: "budget_tokens", min: 1024 }],
        deprecated: false,
      })
      .returning();

    expect(inserted[0]?.contextLimit).toBe(200000);
    expect(inserted[0]?.reasoningOptions).toEqual([
      { type: "budget_tokens", min: 1024 },
    ]);
    expect(inserted[0]?.fetchedAt).toBeInstanceOf(Date);

    // Nullable capability columns round-trip as null.
    const bare = await db
      .insert(schema.modelCatalogEntries)
      .values({
        provider: "openai",
        modelId: "gpt-bare",
        name: "GPT Bare",
        releaseDate: "2026-02-01",
        vision: false,
        contextLimit: null,
        reasoningOptions: null,
        deprecated: false,
      })
      .returning();
    expect(bare[0]?.contextLimit).toBeNull();
    expect(bare[0]?.reasoningOptions).toBeNull();

    await expect(
      db.insert(schema.modelCatalogEntries).values({
        provider: "anthropic",
        modelId: "claude-haiku-4-5",
        name: "Duplicate",
        releaseDate: "2025-10-15",
        vision: true,
        deprecated: false,
      }),
    ).rejects.toThrow();
  });

  it("round-trips one meta row per provider with its etag", async () => {
    const db = await createInMemoryDb();

    const meta = await db
      .insert(schema.modelCatalogMeta)
      .values({ provider: "anthropic", etag: '"abc123"' })
      .returning();

    expect(meta[0]?.etag).toBe('"abc123"');
    expect(meta[0]?.fetchedAt).toBeInstanceOf(Date);

    await expect(
      db
        .insert(schema.modelCatalogMeta)
        .values({ provider: "anthropic", etag: '"other"' }),
    ).rejects.toThrow();
  });
});
