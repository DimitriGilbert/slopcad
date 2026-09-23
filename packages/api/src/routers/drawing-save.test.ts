/**
 * The drawing save-flow fixtures (Phase 55 round 2): the persistence
 * invariants the /drawings page's Save button relies on. Two rapid saves
 * — the "second Save within the cache window" scenario that used to fork
 * a duplicate project + document off stale cached list empties — MUST
 * land on the SAME document as version 1 then version 2, with the
 * document list (the cache the page invalidates on create/save success)
 * reporting the bumped versions. Driven through the REAL router
 * factories over the ephemeral migrated database.
 */

import {
  createDocument,
  createDocumentId,
  createNativeCadDocument,
  createSheetId,
  parseNativeCadDocumentFromString,
  serializeNativeCadDocument,
  stringifyNativeCadDocument,
  type DrawingDocument,
} from "@slopcad/cad-core";
import { createInMemoryDb } from "@slopcad/db";
import { user as userTable } from "@slopcad/db/schema/auth";
import { describe, expect, it } from "vitest";

import { router, t } from "../index";
import { createDocumentsRouter } from "./documents";
import { createProjectsRouter } from "./projects";

const ALICE_ID = "user-alice";

function callerFor(db: Awaited<ReturnType<typeof createInMemoryDb>>) {
  return t.createCallerFactory(
    router({
      projects: createProjectsRouter({ db }),
      documents: createDocumentsRouter({ db }),
    }),
  )({
    auth: null,
    session: {
      session: {
        id: `session-${ALICE_ID}`,
        expiresAt: new Date("2030-01-01T00:00:00.000Z"),
        token: `token-${ALICE_ID}`,
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
        updatedAt: new Date("2026-01-01T00:00:00.000Z"),
        ipAddress: null,
        userAgent: null,
        userId: ALICE_ID,
      },
      user: {
        id: ALICE_ID,
        name: ALICE_ID,
        email: `${ALICE_ID}@slopcad.test`,
        emailVerified: false,
        image: null,
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
        updatedAt: new Date("2026-01-01T00:00:00.000Z"),
      },
    },
  });
}

const drawingSheet: DrawingDocument = {
  sheets: [
    {
      id: createSheetId("sht_main"),
      size: "A3",
      orientation: "landscape",
      scale: { numerator: 1, denominator: 2 },
      views: [],
    },
  ],
};

/** Builds one valid drawing-envelope payload (the page's Save body). */
function drawingEnvelope(): string {
  const created = createNativeCadDocument(
    createDocument(createDocumentId("doc_drawings")),
  );
  if (!created.ok) {
    throw new Error(`The envelope build was refused: ${created.error.message}`);
  }
  const native = { ...created.value, drawing: drawingSheet };
  return stringifyNativeCadDocument(serializeNativeCadDocument(native));
}

describe("drawing save flow (the second-save-within-the-cache-window law)", () => {
  it("lands rapid saves on the SAME document as versions 1 then 2", async () => {
    const db = await createInMemoryDb();
    await db
      .insert(userTable)
      .values([{ id: ALICE_ID, name: "Alice", email: "alice@slopcad.test" }]);
    const alice = callerFor(db);

    // The page's Save: one project, one "Drawings" document inside it.
    const project = await alice.projects.create({ name: "Drawings" });
    const document = await alice.documents.create({
      projectId: project.id,
      name: "Drawings",
    });

    // First save (the create-success path immediately saves), then a
    // second save within any cache window.
    const first = await alice.documents.save({
      documentId: document.id,
      nativeContent: drawingEnvelope(),
    });
    expect(first.documentId).toBe(document.id);
    expect(first.version).toBe(1);

    const second = await alice.documents.save({
      documentId: document.id,
      nativeContent: drawingEnvelope(),
    });
    expect(second.documentId).toBe(document.id);
    expect(second.version).toBe(2);

    // The latest version's envelope round-trips with the drawing intact.
    const fetched = await alice.documents.get({ documentId: document.id });
    expect(fetched.latest?.version).toBe(2);
    const parsed = parseNativeCadDocumentFromString(
      fetched.latest?.nativeContent ?? "",
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.drawing?.sheets[0]?.id).toBe(
      drawingSheet.sheets[0]?.id,
    );
  });

  it("reports the bumped versions through documents.list (the invalidated cache)", async () => {
    const db = await createInMemoryDb();
    await db
      .insert(userTable)
      .values([{ id: ALICE_ID, name: "Alice", email: "alice@slopcad.test" }]);
    const alice = callerFor(db);

    const project = await alice.projects.create({ name: "Drawings" });
    const document = await alice.documents.create({
      projectId: project.id,
      name: "Drawings",
    });
    await alice.documents.save({
      documentId: document.id,
      nativeContent: drawingEnvelope(),
    });
    await alice.documents.save({
      documentId: document.id,
      nativeContent: drawingEnvelope(),
    });

    // What the page's refetch sees after invalidation: exactly ONE
    // document, versionCount/latestVersion = 2 — never a duplicate row.
    const documents = await alice.documents.list({ projectId: project.id });
    expect(documents).toHaveLength(1);
    const row = documents[0];
    expect(row?.id).toBe(document.id);
    expect(row?.versionCount).toBe(2);
    expect(row?.latestVersion).toBe(2);
    const projects = await alice.projects.list();
    expect(projects).toHaveLength(1);
  });
});
