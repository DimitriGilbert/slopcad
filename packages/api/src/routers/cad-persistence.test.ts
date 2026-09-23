/**
 * Phase 31 persistence tests: the project/document/version stack against
 * the ephemeral migrated database (`createInMemoryDb` — committed
 * migrations, temp file, no network), driven through the REAL router
 * factories — the same factories the served `appRouter` composes, with the
 * fixture database injected in place of the process singleton. The battery:
 *
 * - CRUD — an authenticated user creates a project, a document inside it,
 *   lists both, and reads them back;
 * - ownership/isolation — user B's caller cannot see, open, or save into
 *   user A's project or documents (NOT_FOUND, and B's list stays empty);
 *   anonymous callers are rejected outright (UNAUTHORIZED);
 * - version history — every save appends exactly one immutable
 *   `document_version` row with the next 1-based ordinal;
 * - native round-trip — what `save` persists is the NATIVE document
 *   format's canonical text, validated with the format's own machinery on
 *   the way in and deserialized with the full replay check on the way out
 *   (the DB returns a document whose transaction log replays, whose undo
 *   depth matches the edits, and whose re-serialization is byte-identical);
 * - store integrity — a structurally invalid payload never enters the
 *   database (BAD_REQUEST, version count unchanged).
 */

import {
  addBody,
  addDocumentParameter,
  addFeature,
  applySessionTransaction,
  createBodyId,
  createDocument,
  createDocumentId,
  createFeatureId,
  createParameterId,
  createSession,
  length,
  parseNativeCadDocumentFromString,
  serializeNativeCadDocument,
  stringifyNativeCadDocument,
  type CadDocument,
  type CadSession,
  type NativeCadDocument,
} from "@slopcad/cad-core";
import { createInMemoryDb } from "@slopcad/db";
import { user as userTable } from "@slopcad/db/schema/auth";
import { describe, expect, it } from "vitest";

import { router, t } from "../index";
import { NATIVE_CONTENT_MAX_LENGTH } from "../limits";
import { createDocumentsRouter } from "./documents";
import { createProjectsRouter } from "./projects";

const ALICE_ID = "user-alice";
const BOB_ID = "user-bob";

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

/** Anonymous caller (the UNAUTHORIZED gate). */
function anonymousCaller(db: Awaited<ReturnType<typeof createInMemoryDb>>) {
  return t.createCallerFactory(buildPersistenceRouter(db))({
    auth: null,
    session: null,
  });
}

/** Caller speaking as one of the fixture users. */
function callerFor(
  userId: string,
  db: Awaited<ReturnType<typeof createInMemoryDb>>,
) {
  return t.createCallerFactory(buildPersistenceRouter(db))({
    auth: null,
    session: testSession(userId),
  });
}

function buildPersistenceRouter(
  db: Awaited<ReturnType<typeof createInMemoryDb>>,
) {
  return router({
    projects: createProjectsRouter({ db }),
    documents: createDocumentsRouter({ db }),
  });
}

/**
 * The shared fixture database: committed migrations applied to a temp
 * file, plus real user rows for the two fixture users (the project
 * table's owner FK needs them).
 */
async function createPersistenceFixture() {
  const db = await createInMemoryDb();
  await db.insert(userTable).values([
    { id: ALICE_ID, name: "Alice", email: "alice@slopcad.test" },
    { id: BOB_ID, name: "Bob", email: "bob@slopcad.test" },
  ]);
  return db;
}

/** Creates one project owned by the user, returning its id. */
async function createOwnedProject(
  userId: string,
  db: Awaited<ReturnType<typeof createInMemoryDb>>,
  name = "Bracket redesign",
): Promise<string> {
  const created = await callerFor(userId, db).projects.create({
    name,
  });
  return created.id;
}

/** Creates one empty document inside the project, returning its id. */
async function createOwnedDocument(
  userId: string,
  projectId: string,
  db: Awaited<ReturnType<typeof createInMemoryDb>>,
  name = "carrier-plate",
): Promise<string> {
  const created = await callerFor(userId, db).documents.create({
    projectId,
    name,
  });
  return created.id;
}

/** Unwraps a document-builder result, failing the test process on refusal. */
function requireAdd(
  result:
    | { readonly ok: true; readonly value: { readonly document: CadDocument } }
    | { readonly ok: false; readonly error: { readonly message: string } },
): CadDocument {
  if (!result.ok) {
    throw new Error(
      `The fixture document build was refused: ${result.error.message}`,
    );
  }
  return result.value.document;
}

/** Builds a real session with one committed transaction in its history. */
function buildAuthoredSession(): CadSession {
  let document = createDocument(createDocumentId("doc_persistence_test"));
  const bodyId = createBodyId("body_plate");
  const parameterId = createParameterId("param_plate_thickness");
  document = requireAdd(addBody(document, { id: bodyId, name: "plate" }));
  document = requireAdd(
    addDocumentParameter(document, {
      id: parameterId,
      name: "plateThickness",
      value: length(8),
    }),
  );
  document = requireAdd(
    addFeature(document, {
      id: createFeatureId("feat_extrude_plate"),
      kind: "extrude",
      inputs: [{ kind: "parameter", id: parameterId }],
      outputs: [bodyId],
    }),
  );
  const session = createSession(document);
  const edited = applySessionTransaction(session, {
    commands: [{ type: "parameter.set", id: parameterId, value: length(12) }],
  });
  if (!edited.ok) {
    throw new Error(`The fixture edit was refused: ${edited.error.message}`);
  }
  return edited.value;
}

/** Serializes a session exactly the way the workbench's Save path will. */
function serializeSession(session: CadSession): string {
  const native: NativeCadDocument = {
    document: session.document,
    history: session.history,
    regeneration: new Map(),
    metadata: {},
    rollback: null,
    drawing: null,
  };
  return stringifyNativeCadDocument(serializeNativeCadDocument(native));
}

describe("projects persistence", () => {
  it("creates a project for the authenticated user and lists it back", async () => {
    const db = await createPersistenceFixture();
    const alice = callerFor(ALICE_ID, db);

    const created = await alice.projects.create({
      name: "Bracket redesign",
      description: "The Q3 bracket family",
    });
    expect(created.id).toMatch(/[0-9a-f-]{36}/);
    expect(created.name).toBe("Bracket redesign");
    expect(created.description).toBe("The Q3 bracket family");

    const listed = await alice.projects.list();
    expect(listed).toHaveLength(1);
    expect(listed[0]?.id).toBe(created.id);
    expect(listed[0]?.documentCount).toBe(0);

    const fetched = await alice.projects.get({ projectId: created.id });
    expect(fetched.name).toBe("Bracket redesign");
  });

  it("rejects an anonymous caller with UNAUTHORIZED on every procedure", async () => {
    const db = await createPersistenceFixture();
    const anonymous = anonymousCaller(db);

    await expect(
      anonymous.projects.create({ name: "Nope" }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(anonymous.projects.list()).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
    await expect(
      anonymous.documents.create({ projectId: "p", name: "d" }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(
      anonymous.documents.save({ documentId: "d", nativeContent: "{}" }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("hides user A's project from user B and rejects B's reads and writes", async () => {
    const db = await createPersistenceFixture();
    const projectId = await createOwnedProject(ALICE_ID, db);
    const documentId = await createOwnedDocument(ALICE_ID, projectId, db);
    const bob = callerFor(BOB_ID, db);

    // Reads: NOT_FOUND (existence is not leaked across users).
    await expect(bob.projects.get({ projectId })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(bob.documents.get({ documentId })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(bob.documents.list({ projectId })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(
      bob.documents.listVersions({ documentId }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      bob.documents.getVersion({ documentId, version: 1 }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    // Writes: creating a document in A's project and saving into A's
    // document are both refused.
    await expect(
      bob.documents.create({ projectId, name: "intruder-doc" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      bob.documents.save({
        documentId,
        nativeContent: serializeSession(buildAuthoredSession()),
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    // B's own surface stays empty.
    const bobProjects = await callerFor(BOB_ID, db).projects.list();
    expect(bobProjects).toHaveLength(0);
  });

  it("keeps same-named projects of different users isolated", async () => {
    const db = await createPersistenceFixture();
    const aliceId = await createOwnedProject(ALICE_ID, db, "Shared name");
    const bobId = await createOwnedProject(BOB_ID, db, "Shared name");
    expect(aliceId).not.toBe(bobId);

    const aliceList = await callerFor(ALICE_ID, db).projects.list();
    expect(aliceList.map((project) => project.id)).toEqual([aliceId]);
    const bobList = await callerFor(BOB_ID, db).projects.list();
    expect(bobList.map((project) => project.id)).toEqual([bobId]);
  });
});

describe("document version history", () => {
  it("grows by one immutable version per save with 1-based ordinals", async () => {
    const db = await createPersistenceFixture();
    const alice = callerFor(ALICE_ID, db);
    const projectId = await createOwnedProject(ALICE_ID, db);
    const documentId = await createOwnedDocument(ALICE_ID, projectId, db);

    const first = await alice.documents.save({
      documentId,
      nativeContent: serializeSession(buildAuthoredSession()),
    });
    expect(first.version).toBe(1);
    const second = await alice.documents.save({
      documentId,
      nativeContent: serializeSession(buildAuthoredSession()),
    });
    expect(second.version).toBe(2);

    const versions = await alice.documents.listVersions({ documentId });
    expect(versions.map((version) => version.version)).toEqual([1, 2]);
    expect(versions[0]?.id).not.toBe(versions[1]?.id);

    const documents = await alice.documents.list({ projectId });
    expect(documents[0]?.versionCount).toBe(2);
    expect(documents[0]?.latestVersion).toBe(2);
  });

  it("starts a new document's history at zero versions (nothing saved yet)", async () => {
    const db = await createPersistenceFixture();
    const alice = callerFor(ALICE_ID, db);
    const projectId = await createOwnedProject(ALICE_ID, db);
    const documentId = await createOwnedDocument(ALICE_ID, projectId, db);

    const fetched = await alice.documents.get({ documentId });
    expect(fetched.document.id).toBe(documentId);
    expect(fetched.latest).toBeNull();
    expect(await alice.documents.listVersions({ documentId })).toEqual([]);
  });
});

describe("native document round-trip", () => {
  it("returns what was saved: a valid native document that replays byte-identically", async () => {
    const db = await createPersistenceFixture();
    const alice = callerFor(ALICE_ID, db);
    const projectId = await createOwnedProject(ALICE_ID, db);
    const documentId = await createOwnedDocument(ALICE_ID, projectId, db);

    const authored = buildAuthoredSession();
    const persistedText = serializeSession(authored);
    await alice.documents.save({ documentId, nativeContent: persistedText });

    const fetched = await alice.documents.get({ documentId });
    expect(fetched.latest?.version).toBe(1);
    expect(fetched.latest?.nativeContent).toBe(persistedText);

    // The format's own machinery on what the DATABASE returned: the full
    // parse replays the transaction log over the base and checks the
    // state at the cursor against it.
    const parsed = parseNativeCadDocumentFromString(
      fetched.latest?.nativeContent ?? "",
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.document.parameters.parameters[0]?.value.value).toBe(
      12,
    );
    // The dual-persisted history survived: one committed entry, undoable.
    expect(parsed.value.history.entries).toHaveLength(1);
    expect(parsed.value.history.cursor).toBe(1);
    // Byte-stability: what came back re-serializes to the exact bytes.
    expect(
      stringifyNativeCadDocument(serializeNativeCadDocument(parsed.value)),
    ).toBe(persistedText);
  });

  it("loads an older version's content through getVersion", async () => {
    const db = await createPersistenceFixture();
    const alice = callerFor(ALICE_ID, db);
    const projectId = await createOwnedProject(ALICE_ID, db);
    const documentId = await createOwnedDocument(ALICE_ID, projectId, db);

    const session = buildAuthoredSession();
    await alice.documents.save({
      documentId,
      nativeContent: serializeSession(session),
    });
    const edited = applySessionTransaction(session, {
      commands: [
        {
          type: "parameter.set",
          id: createParameterId("param_plate_thickness"),
          value: length(20),
        },
      ],
    });
    if (!edited.ok) {
      throw new Error(`The second edit was refused: ${edited.error.message}`);
    }
    const secondText = serializeSession(edited.value);
    await alice.documents.save({ documentId, nativeContent: secondText });

    const v1 = await alice.documents.getVersion({ documentId, version: 1 });
    expect(v1.nativeContent).not.toBe(secondText);
    const parsedV1 = parseNativeCadDocumentFromString(v1.nativeContent);
    expect(parsedV1.ok).toBe(true);
    if (parsedV1.ok) {
      expect(
        parsedV1.value.document.parameters.parameters[0]?.value.value,
      ).toBe(12);
    }
    const v2 = await alice.documents.getVersion({ documentId, version: 2 });
    expect(v2.nativeContent).toBe(secondText);
    await expect(
      alice.documents.getVersion({ documentId, version: 3 }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("refuses an invalid native payload and leaves the store untouched", async () => {
    const db = await createPersistenceFixture();
    const alice = callerFor(ALICE_ID, db);
    const projectId = await createOwnedProject(ALICE_ID, db);
    const documentId = await createOwnedDocument(ALICE_ID, projectId, db);

    await expect(
      alice.documents.save({
        documentId,
        nativeContent: '{"formatVersion":1,"bogus":true}',
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      alice.documents.save({ documentId, nativeContent: "not json at all" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    expect(await alice.documents.listVersions({ documentId })).toEqual([]);
  });

  it("refuses an oversized native payload before parsing and leaves the store untouched", async () => {
    const db = await createPersistenceFixture();
    const alice = callerFor(ALICE_ID, db);
    const projectId = await createOwnedProject(ALICE_ID, db);
    const documentId = await createOwnedDocument(ALICE_ID, projectId, db);

    // One character over the input cap: the input boundary must refuse it
    // (BAD_REQUEST) without ever reaching the parse-and-replay machinery,
    // and no version row may exist afterwards.
    const oversized = "x".repeat(NATIVE_CONTENT_MAX_LENGTH + 1);
    await expect(
      alice.documents.save({ documentId, nativeContent: oversized }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    expect(await alice.documents.listVersions({ documentId })).toEqual([]);
  });
});
