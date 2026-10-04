/**
 * Agent-conversations tests (agent chat, Phase 1.4 — PLAN-AGENT-CHAT.md
 * §1.4, D2/D3/D13): the server-side persistence router and the
 * serverProviders availability query against the ephemeral migrated
 * database (`createInMemoryDb`), driven through the REAL router factories
 * the served `appRouter` composes. The battery:
 *
 * - CRUD scoping — every procedure is user-scoped: user B's caller cannot
 *   see, append into, or delete user A's conversation (NOT_FOUND, B's list
 *   stays empty); project-scoped creation only for owned projects;
 *   anonymous callers rejected outright (UNAUTHORIZED);
 * - append validation — the minimal shape contract (role enum + parts
 *   array) plus the count/serialized-size caps, refused without writing;
 * - access resolution — the serverProviders matrix: `user_options` row /
 *   allow-all env posture / neither, and provider ids listed only when
 *   the env key is present (key VALUES never travel).
 *
 * Zero network: the provider-key env shape and the allow-all posture are
 * injected per harness instead of read from the process env, and the
 * global fetch stays on its throwing test stub.
 */

import { randomUUID } from "node:crypto";
import { createInMemoryDb } from "@slopcad/db";
import {
  agentConversations as agentConversationsTable,
  agentMessages as agentMessagesTable,
} from "@slopcad/db/schema/agent";
import { user as userTable } from "@slopcad/db/schema/auth";
import { project as projectTable } from "@slopcad/db/schema/projects";
import { userOptions as userOptionsTable } from "@slopcad/db/schema/user-options";
import { asc, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { router, t } from "../index";
import {
  AGENT_CONVERSATION_TITLE_MAX_LENGTH,
  AGENT_MESSAGE_MAX_PARTS,
  AGENT_MESSAGE_PARTS_MAX_SERIALIZED_LENGTH,
} from "../limits";
import { readUserOption, SERVER_AI_OPTION_NAME } from "../user-options";
import {
  agentAppendInput,
  createAgentConversationsRouter,
  createServerProvidersProcedure,
  serverProviderIdsWithEnvKeys,
  type ServerProviderKeyEnv,
} from "./agent-conversations";
import { CATALOG_PROVIDERS } from "./model-catalog";

const ALICE_ID = "user-alice";
const BOB_ID = "user-bob";

type FixtureDb = Awaited<ReturnType<typeof createInMemoryDb>>;

/** The session half of the caller context, for one user id. */
function testSession(userId: string) {
  return {
    session: {
      id: `session-${userId}`,
      expiresAt: new Date("2030-01-01T00:00:00.000Z"),
      token: `token-${userId}`,
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      updatedAt: new Date("2026-01-01T00:00:00.000Z"),
      ipAddress: null,
      userAgent: null,
      userId,
    },
    user: {
      id: userId,
      name: userId,
      email: `${userId}@slopcad.test`,
      emailVerified: false,
      image: null,
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    },
  };
}

/**
 * One fresh migrated database plus real user rows (the FK targets) and a
 * router composed exactly like the served one, with the serverProviders
 * env posture injected per test.
 */
async function createHarness(
  options: {
    readonly providerKeys?: ServerProviderKeyEnv;
    readonly allowAll?: boolean;
  } = {},
) {
  const db = await createInMemoryDb();
  await db.insert(userTable).values([
    { id: ALICE_ID, name: "Alice", email: "alice@slopcad.test" },
    { id: BOB_ID, name: "Bob", email: "bob@slopcad.test" },
  ]);
  const appRouter = router({
    agentConversations: createAgentConversationsRouter({ db }),
    serverProviders: createServerProvidersProcedure({
      db,
      providerKeys: options.providerKeys ?? {},
      allowAll: options.allowAll ?? false,
    }),
  });
  const createCaller = t.createCallerFactory(appRouter);
  return {
    db,
    alice: createCaller({ auth: null, session: testSession(ALICE_ID) }),
    bob: createCaller({ auth: null, session: testSession(BOB_ID) }),
    anonymous: createCaller({ auth: null, session: null }),
  };
}

/** Inserts one user_options row (the write path deferred per D13). */
async function seedUserOption(
  db: FixtureDb,
  userId: string,
  name: string,
  value: string,
): Promise<void> {
  await db
    .insert(userOptionsTable)
    .values({ id: randomUUID(), userId, name, value });
}

/** Inserts one project owned by the user, returning its id. */
async function seedProject(
  db: FixtureDb,
  ownerId: string,
  name: string,
): Promise<string> {
  const id = randomUUID();
  await db.insert(projectTable).values({ id, ownerId, name });
  return id;
}

/** The stored messages of one conversation, arrival order. */
async function messageRows(db: FixtureDb, conversationId: string) {
  return db
    .select()
    .from(agentMessagesTable)
    .where(eq(agentMessagesTable.conversationId, conversationId))
    .orderBy(asc(agentMessagesTable.createdAt), asc(agentMessagesTable.id));
}

describe("agentConversations router", () => {
  it("rejects an anonymous caller with UNAUTHORIZED on every procedure", async () => {
    const { anonymous } = await createHarness();
    await expect(anonymous.agentConversations.list()).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
    await expect(
      anonymous.agentConversations.create({ title: "Nope" }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(
      anonymous.agentConversations.append({
        conversationId: "c",
        role: "user",
        parts: [],
      }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(
      anonymous.agentConversations.delete({ conversationId: "c" }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(anonymous.serverProviders()).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
  });

  it("creates a conversation for the authenticated user and lists it back", async () => {
    const { alice } = await createHarness();
    const created = await alice.agentConversations.create({
      title: "Bracket brainstorm",
    });
    expect(created.id).toMatch(/[0-9a-f-]{36}/);
    expect(created.title).toBe("Bracket brainstorm");
    expect(created.projectId).toBeNull();
    expect(Number.isNaN(Date.parse(created.createdAt))).toBe(false);
    expect(Number.isNaN(Date.parse(created.updatedAt))).toBe(false);

    const listed = await alice.agentConversations.list();
    expect(listed).toHaveLength(1);
    expect(listed[0]?.id).toBe(created.id);
    expect(listed[0]?.title).toBe("Bracket brainstorm");
  });

  it("scopes a conversation's project to one the caller owns", async () => {
    const { alice, db } = await createHarness();
    const aliceProject = await seedProject(db, ALICE_ID, "Alice's project");
    const bobProject = await seedProject(db, BOB_ID, "Bob's project");

    const scoped = await alice.agentConversations.create({
      title: "Project chat",
      projectId: aliceProject,
    });
    expect(scoped.projectId).toBe(aliceProject);

    await expect(
      alice.agentConversations.create({
        title: "Intruder",
        projectId: bobProject,
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      alice.agentConversations.create({
        title: "Ghost",
        projectId: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await alice.agentConversations.list()).toHaveLength(1);
  });

  it("hides user A's conversation from user B on every surface", async () => {
    const { alice, bob, db } = await createHarness();
    const created = await alice.agentConversations.create({
      title: "Alice's chat",
    });

    expect(await bob.agentConversations.list()).toEqual([]);
    await expect(
      bob.agentConversations.append({
        conversationId: created.id,
        role: "user",
        parts: [{ type: "text", text: "intruder" }],
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      bob.agentConversations.delete({ conversationId: created.id }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    // Alice's row survived every refused write, message-free.
    const listed = await alice.agentConversations.list();
    expect(listed.map((conversation) => conversation.id)).toEqual([created.id]);
    expect(await messageRows(db, created.id)).toEqual([]);
  });

  it("lists newest-updated first, with the id tiebreak keeping it deterministic", async () => {
    const { alice, db } = await createHarness();
    const first = await alice.agentConversations.create({ title: "first" });
    const second = await alice.agentConversations.create({ title: "second" });

    // Distinct fixed timestamps so the order assertion never races the clock.
    const past = (days: number) =>
      new Date(Date.parse("2026-01-01T00:00:00.000Z") + days * 86_400_000);
    await db
      .update(agentConversationsTable)
      .set({ updatedAt: past(0) })
      .where(eq(agentConversationsTable.id, first.id));
    await db
      .update(agentConversationsTable)
      .set({ updatedAt: past(1) })
      .where(eq(agentConversationsTable.id, second.id));

    // Appending stamps the conversation's updatedAt now → newest, listed first.
    await alice.agentConversations.append({
      conversationId: first.id,
      role: "user",
      parts: [{ type: "text", text: "hello" }],
    });
    const listed = await alice.agentConversations.list();
    expect(listed.map((conversation) => conversation.id)).toEqual([
      first.id,
      second.id,
    ]);
  });

  it("appends messages verbatim, stamps the conversation, and keeps arrival order", async () => {
    const { alice, db } = await createHarness();
    const conversation = await alice.agentConversations.create({
      title: "Chat",
    });

    const userParts = [
      { type: "text", text: "Extrude the plate 8mm" },
      { type: "tool-result", toolName: "cad_apply_commands", state: "output" },
    ];
    const appended = await alice.agentConversations.append({
      conversationId: conversation.id,
      role: "user",
      parts: userParts,
    });
    expect(appended.conversationId).toBe(conversation.id);
    expect(appended.role).toBe("user");
    expect(appended.parts).toEqual(userParts);
    expect(Number.isNaN(Date.parse(appended.createdAt))).toBe(false);

    const second = await alice.agentConversations.append({
      conversationId: conversation.id,
      role: "assistant",
      parts: [{ type: "text", text: "Done." }],
    });
    expect(second.id).not.toBe(appended.id);

    const rows = await messageRows(db, conversation.id);
    expect(rows.map((row) => row.id)).toEqual([appended.id, second.id]);
    expect(rows[0]?.parts).toEqual(userParts);

    // The conversation's updatedAt moved to (at least) the append time.
    const stamped = (
      await db
        .select()
        .from(agentConversationsTable)
        .where(eq(agentConversationsTable.id, conversation.id))
    )[0];
    expect(stamped?.updatedAt.getTime()).toBeGreaterThanOrEqual(
      stamped?.createdAt.getTime() ?? Number.NEGATIVE_INFINITY,
    );
  });

  it("refuses an append past the caps or to a foreign/missing conversation, writing nothing", async () => {
    const { alice, bob, db } = await createHarness();
    const created = await alice.agentConversations.create({
      title: "Alice's chat",
    });

    await expect(
      alice.agentConversations.append({
        conversationId: created.id,
        role: "user",
        parts: Array.from(
          { length: AGENT_MESSAGE_MAX_PARTS + 1 },
          (_, index) => index,
        ),
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      alice.agentConversations.append({
        conversationId: created.id,
        role: "user",
        parts: ["x".repeat(AGENT_MESSAGE_PARTS_MAX_SERIALIZED_LENGTH + 1)],
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      alice.agentConversations.append({
        conversationId: randomUUID(),
        role: "user",
        parts: [],
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      bob.agentConversations.append({
        conversationId: created.id,
        role: "user",
        parts: [],
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    expect(await messageRows(db, created.id)).toEqual([]);
  });

  it("refuses empty and oversized titles without writing", async () => {
    const { alice } = await createHarness();
    await expect(
      alice.agentConversations.create({ title: "" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      alice.agentConversations.create({ title: "   " }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      alice.agentConversations.create({
        title: "x".repeat(AGENT_CONVERSATION_TITLE_MAX_LENGTH + 1),
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(await alice.agentConversations.list()).toEqual([]);
  });

  it("deletes an owned conversation and cascades its messages", async () => {
    const { alice, db } = await createHarness();
    const conversation = await alice.agentConversations.create({
      title: "Doomed",
    });
    await alice.agentConversations.append({
      conversationId: conversation.id,
      role: "user",
      parts: [{ type: "text", text: "hi" }],
    });
    await alice.agentConversations.append({
      conversationId: conversation.id,
      role: "assistant",
      parts: [],
    });

    await alice.agentConversations.delete({
      conversationId: conversation.id,
    });
    expect(await alice.agentConversations.list()).toEqual([]);
    expect(await messageRows(db, conversation.id)).toEqual([]);
    await expect(
      alice.agentConversations.delete({ conversationId: conversation.id }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("append input schema (minimal shape contract, D3)", () => {
  it("accepts the three UIMessage roles with any JSON parts array", () => {
    for (const role of ["system", "user", "assistant"] as const) {
      const parsed = agentAppendInput.safeParse({
        conversationId: "c",
        role,
        parts: [
          { type: "text", text: "hi" },
          { type: "image", mediaType: "image/png", data: "aGk=" },
        ],
      });
      expect(parsed.success).toBe(true);
    }
  });

  it("rejects a role outside the enum, non-array parts, and too many parts", () => {
    expect(
      agentAppendInput.safeParse({
        conversationId: "c",
        role: "tool",
        parts: [],
      }).success,
    ).toBe(false);
    expect(
      agentAppendInput.safeParse({
        conversationId: "c",
        role: "user",
        parts: "just text",
      }).success,
    ).toBe(false);
    expect(
      agentAppendInput.safeParse({
        conversationId: "c",
        role: "user",
        parts: { type: "text" },
      }).success,
    ).toBe(false);
    expect(
      agentAppendInput.safeParse({
        conversationId: "c",
        role: "user",
        parts: Array.from(
          { length: AGENT_MESSAGE_MAX_PARTS + 1 },
          (_, index) => index,
        ),
      }).success,
    ).toBe(false);
  });
});

describe("serverProviders access matrix (D13)", () => {
  it("allows nobody when there is no user_options row and no allow-all", async () => {
    const { alice, bob } = await createHarness({
      providerKeys: {},
      allowAll: false,
    });
    expect(await alice.serverProviders()).toEqual({
      providers: [],
      allowed: false,
    });
    expect(await bob.serverProviders()).toEqual({
      providers: [],
      allowed: false,
    });
  });

  it("allows exactly the user holding the agent.server-ai = true row", async () => {
    const { alice, bob, db } = await createHarness({
      providerKeys: {},
      allowAll: false,
    });
    await seedUserOption(db, ALICE_ID, SERVER_AI_OPTION_NAME, "true");
    expect(await alice.serverProviders()).toEqual({
      providers: [],
      allowed: true,
    });
    expect(await bob.serverProviders()).toEqual({
      providers: [],
      allowed: false,
    });
  });

  it("the allow-all env posture allows every authenticated user without any row", async () => {
    const { alice, bob } = await createHarness({
      providerKeys: {},
      allowAll: true,
    });
    expect((await alice.serverProviders()).allowed).toBe(true);
    expect((await bob.serverProviders()).allowed).toBe(true);
  });

  it("requires the exact value 'true' under the exact option name", async () => {
    const { alice, bob, db } = await createHarness({
      providerKeys: {},
      allowAll: false,
    });
    await seedUserOption(db, ALICE_ID, SERVER_AI_OPTION_NAME, "false");
    expect((await alice.serverProviders()).allowed).toBe(false);
    // Another user's row with a different option name grants nothing.
    await seedUserOption(db, BOB_ID, "some.other-option", "true");
    expect((await bob.serverProviders()).allowed).toBe(false);
  });

  it("lists exactly the env-keyed providers, in catalog order, never the key values", async () => {
    const { alice } = await createHarness({
      providerKeys: {
        OPENROUTER_KEY: "sk-leak-openrouter",
        OPENAI_KEY: "sk-leak-openai",
        ANTHROPIC_KEY: "sk-leak-anthropic",
        GOOGLE_KEY: "sk-leak-google",
        OPENAI_COMPATIBLE_KEY: "sk-leak-compatible",
      },
    });
    const result = await alice.serverProviders();
    expect(result.providers).toEqual([...CATALOG_PROVIDERS]);
    expect(JSON.stringify(result)).not.toContain("sk-leak");

    const subset = await createHarness({
      providerKeys: { OPENAI_KEY: "k", GOOGLE_KEY: "k" },
    });
    expect((await subset.alice.serverProviders()).providers).toEqual([
      "openai",
      "google",
    ]);

    // An empty-string env var must not surface its provider either: the
    // picker must never offer a provider the relay would refuse with 422.
    const blank = await createHarness({
      providerKeys: { OPENAI_KEY: "", GOOGLE_KEY: "k" },
    });
    expect((await blank.alice.serverProviders()).providers).toEqual(["google"]);
  });
});

describe("serverProviderIdsWithEnvKeys (default derivation from the env)", () => {
  it("derives availability from the env shape in the catalog's fixed order", () => {
    expect(serverProviderIdsWithEnvKeys({})).toEqual([]);
    expect(serverProviderIdsWithEnvKeys({ OPENAI_KEY: undefined })).toEqual([]);
    expect(serverProviderIdsWithEnvKeys({ ANTHROPIC_KEY: "k" })).toEqual([
      "anthropic",
    ]);
    expect(
      serverProviderIdsWithEnvKeys({
        OPENROUTER_KEY: "a",
        OPENAI_KEY: "b",
        ANTHROPIC_KEY: "c",
        GOOGLE_KEY: "d",
        OPENAI_COMPATIBLE_KEY: "e",
      }),
    ).toEqual([...CATALOG_PROVIDERS]);
  });

  it("treats an EMPTY-string env key exactly like an unset one", () => {
    expect(serverProviderIdsWithEnvKeys({ OPENAI_KEY: "" })).toEqual([]);
    expect(
      serverProviderIdsWithEnvKeys({
        OPENROUTER_KEY: "",
        OPENAI_KEY: "",
        ANTHROPIC_KEY: "",
        GOOGLE_KEY: "",
        OPENAI_COMPATIBLE_KEY: "",
      }),
    ).toEqual([]);
    // Only the var carrying a real value counts.
    expect(
      serverProviderIdsWithEnvKeys({ OPENAI_KEY: "", GOOGLE_KEY: "k" }),
    ).toEqual(["google"]);
  });
});

describe("readUserOption", () => {
  it("reads one user's option and never another user's row", async () => {
    const { db } = await createHarness();
    await seedUserOption(db, ALICE_ID, SERVER_AI_OPTION_NAME, "true");
    expect(await readUserOption(db, ALICE_ID, SERVER_AI_OPTION_NAME)).toBe(
      "true",
    );
    expect(await readUserOption(db, BOB_ID, SERVER_AI_OPTION_NAME)).toBe(
      undefined,
    );
    expect(await readUserOption(db, ALICE_ID, "nope.option")).toBe(undefined);
  });
});
