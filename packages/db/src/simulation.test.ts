/**
 * Phase 61c schema tests: the `simulation_run` table through the committed
 * migrations (`createInMemoryDb` — the generated 0003 SQL applied like
 * production would). What is pinned here is the STORE's contract with the
 * database, independent of any router: the binary payload column round-trips
 * SMR1 bytes byte-identically (blob in, blob out — never text-mangled), the
 * JSON columns round-trip verbatim, and deleting a document version cascades
 * its runs away (the version-keyed provenance pair's lifetime rule).
 */

import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { createInMemoryDb } from "./index";
import {
  document as documentTable,
  documentVersion as documentVersionTable,
  project as projectTable,
} from "./schema/projects";
import { simulationRun as simulationRunTable } from "./schema/simulation";
import { user as userTable } from "./schema/auth";

/** A minimal SMR1-shaped payload: magic "SMR1", version 1, zero blocks. */
function headerOnlyPayload(): Uint8Array {
  const bytes = new Uint8Array(12);
  bytes.set([0x53, 0x4d, 0x52, 0x31], 0);
  new DataView(bytes.buffer).setUint32(4, 1, true);
  new DataView(bytes.buffer).setUint32(8, 0, true);
  return bytes;
}

describe("simulation_run", () => {
  it("round-trips payload bytes and JSON columns byte-identically", async () => {
    const db = await createInMemoryDb();
    await db
      .insert(userTable)
      .values({ id: "user-sim-1", name: "Sim", email: "sim@slopcad.dev" });
    await db.insert(projectTable).values({
      id: "project-sim-1",
      ownerId: "user-sim-1",
      name: "Tunnel",
    });
    await db.insert(documentTable).values({
      id: "document-sim-1",
      projectId: "project-sim-1",
      name: "bracket",
    });
    await db.insert(documentVersionTable).values({
      id: "version-sim-1",
      documentId: "document-sim-1",
      version: 1,
      nativeContent: "{}",
    });

    const payload = headerOnlyPayload();
    const inserted = await db
      .insert(simulationRunTable)
      .values({
        id: "run-sim-1",
        documentVersionId: "version-sim-1",
        scenarioSnapshotHash: "0a1b2c3d",
        status: "completed",
        summary: '{"schemaVersion":1}',
        histories: "[]",
        payload: Buffer.from(payload),
      })
      .returning();
    expect(inserted).toHaveLength(1);
    expect(inserted[0]?.createdAt).toBeInstanceOf(Date);

    const found = await db
      .select()
      .from(simulationRunTable)
      .where(eq(simulationRunTable.id, "run-sim-1"));
    expect(found).toHaveLength(1);
    const row = found[0];
    if (row === undefined) return;
    expect(row.scenarioSnapshotHash).toBe("0a1b2c3d");
    expect(row.status).toBe("completed");
    expect(row.summary).toBe('{"schemaVersion":1}');
    expect(row.histories).toBe("[]");
    expect(row.payload.byteLength).toBe(payload.byteLength);
    expect(Buffer.from(row.payload)).toEqual(Buffer.from(payload));
  });

  it("cascades run deletion with the document version", async () => {
    const db = await createInMemoryDb();
    await db.insert(userTable).values({
      id: "user-sim-2",
      name: "Cascade",
      email: "cascade@slopcad.dev",
    });
    await db.insert(projectTable).values({
      id: "project-sim-2",
      ownerId: "user-sim-2",
      name: "Fans",
    });
    await db.insert(documentTable).values({
      id: "document-sim-2",
      projectId: "project-sim-2",
      name: "impeller",
    });
    await db.insert(documentVersionTable).values({
      id: "version-sim-2",
      documentId: "document-sim-2",
      version: 1,
      nativeContent: "{}",
    });
    await db.insert(simulationRunTable).values({
      id: "run-sim-2",
      documentVersionId: "version-sim-2",
      scenarioSnapshotHash: "deadbeef",
      status: "failed",
      summary: "{}",
      histories: "[]",
      payload: Buffer.from(headerOnlyPayload()),
    });

    await db
      .delete(documentVersionTable)
      .where(eq(documentVersionTable.id, "version-sim-2"));

    const remaining = await db
      .select()
      .from(simulationRunTable)
      .where(eq(simulationRunTable.id, "run-sim-2"));
    expect(remaining).toHaveLength(0);
  });
});
