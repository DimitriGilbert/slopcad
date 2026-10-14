/**
 * The shares router's contract: a signed-in user uploads one native
 * document behind a fresh short id, anyone (an anonymous viewer page
 * included) reads it back by id, and the input boundaries hold — only
 * native documents the format's own parser accepts enter the store,
 * ids are exactly ten base62 characters, a missing share is the same
 * NOT_FOUND for everyone, and the creator link is severed (not
 * cascaded) when the account goes.
 */

import {
  createDocument,
  createDocumentId,
  createSession,
  serializeNativeCadDocument,
  stringifyNativeCadDocument,
  type NativeCadDocument,
} from "@slopcad/cad-core";
import { createInMemoryDb } from "@slopcad/db";
import { user as userTable } from "@slopcad/db/schema/auth";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { router, t } from "../index";
import { createSharesRouter } from "./shares";

const ALICE_ID = "user-alice";

/** The session half of the caller context, for the fixture user. */
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

type FixtureDb = Awaited<ReturnType<typeof createInMemoryDb>>;

/** An empty document serialized exactly the way the share path will. */
function serializeEmptyDocument(): string {
  const session = createSession(createDocument(createDocumentId("doc_share")));
  const native: NativeCadDocument = {
    document: session.document,
    history: session.history,
    regeneration: new Map(),
    metadata: {},
    rollback: null,
    suppressedFeatures: new Set(),
    drawing: null,
  };
  return stringifyNativeCadDocument(serializeNativeCadDocument(native));
}

/** Caller speaking as the fixture user. */
function signedInCaller(db: FixtureDb) {
  return t.createCallerFactory(router({ shares: createSharesRouter({ db }) }))({
    auth: null,
    session: testSession(ALICE_ID),
  });
}

/** Anonymous caller (the public viewer page's read path, the write gate). */
function anonymousCaller(db: FixtureDb) {
  return t.createCallerFactory(router({ shares: createSharesRouter({ db }) }))({
    auth: null,
    session: null,
  });
}

let db: FixtureDb;

beforeAll(async () => {
  db = await createInMemoryDb();
  await db
    .insert(userTable)
    .values({ id: ALICE_ID, name: "Alice", email: "alice@slopcad.test" });
});

describe("shares router", () => {
  it("creates a short id for a valid document and reads it back publicly", async () => {
    const nativeContent = serializeEmptyDocument();
    const created = await signedInCaller(db).shares.create({ nativeContent });
    expect(created.id).toMatch(/^[0-9A-Za-z]{10}$/);

    const read = await anonymousCaller(db).shares.get({ id: created.id });
    expect(read.nativeContent).toBe(nativeContent);
    expect(read.id).toBe(created.id);
    expect(typeof read.createdAt).toBe("string");
  });

  it("refuses an anonymous create (the write is an authenticated action)", async () => {
    await expect(
      anonymousCaller(db).shares.create({
        nativeContent: serializeEmptyDocument(),
      }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("refuses a payload the native format's parser rejects", async () => {
    await expect(
      signedInCaller(db).shares.create({ nativeContent: "{ not json" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      signedInCaller(db).shares.create({ nativeContent: JSON.stringify({}) }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("refuses an oversized payload before the parser runs", async () => {
    await expect(
      signedInCaller(db).shares.create({
        nativeContent: "x".repeat(10 * 1024 * 1024 + 1),
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("answers NOT_FOUND for a well-formed id no row matches", async () => {
    await expect(
      anonymousCaller(db).shares.get({ id: "zzzzzzzzzz" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("refuses malformed ids at the input boundary", async () => {
    const caller = anonymousCaller(db);
    await expect(caller.shares.get({ id: "short" })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    await expect(
      caller.shares.get({ id: "with space!" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      caller.shares.get({ id: "oneCharacterTooLong0" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("keeps serving a share after its creator's account is deleted", async () => {
    const nativeContent = serializeEmptyDocument();
    const created = await signedInCaller(db).shares.create({ nativeContent });

    await db.delete(userTable).where(eq(userTable.id, ALICE_ID));

    const read = await anonymousCaller(db).shares.get({ id: created.id });
    expect(read.nativeContent).toBe(nativeContent);
  });
});
