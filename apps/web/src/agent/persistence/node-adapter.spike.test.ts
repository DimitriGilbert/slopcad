// @vitest-environment node
// The node adapter drives better-sqlite3 natively; jsdom adds nothing.

/**
 * Phase 3.1 spike evidence (PLAN-AGENT-CHAT §3.1c, adr-agent-chat.md
 * "Persistence spike results"): the node-env test adapter for TanStack DB
 * persisted collections is the official `@tanstack/node-db-sqlite-persistence`
 * (`createNodeSQLitePersistence`) over a real better-sqlite3 database file —
 * NOT a `:memory:` VFS shim — so a round-trip across two independent
 * collection/database instances proves the same durable-write contract the
 * browser OPFS adapter must satisfy. This file is deliberately KEPT: Phase
 * 3.4's persistence glue injects this exact adapter into node tests, and this
 * suite is the standing proof that the injection seam works.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCollection, createTransaction } from "@tanstack/db";
import {
  createNodeSQLitePersistence,
  persistedCollectionOptions,
} from "@tanstack/node-db-sqlite-persistence";
import Database from "better-sqlite3";
import { afterAll, describe, expect, it } from "vitest";

type SpikeRow = { id: string; token: string };

const tempDir = mkdtempSync(join(tmpdir(), "slopcad-tanstack-db-node-spike-"));
const databasePath = join(tempDir, "spike-roundtrip.sqlite");

afterAll(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

/**
 * Mirrors the seam Phase 3.4 will inject: each call mints a FRESH database
 * handle + persistence + collection over the same file, so the second call
 * only sees rows the first call durably wrote.
 */
function openSpikeCollection() {
  const persistence = createNodeSQLitePersistence({
    database: new Database(databasePath),
  });
  return createCollection(
    persistedCollectionOptions<SpikeRow, string>({
      id: "spike-roundtrip",
      getKey: (row) => row.id,
      persistence,
      schemaVersion: 1,
    }),
  );
}

async function insertRow(
  collection: ReturnType<typeof openSpikeCollection>,
  row: SpikeRow,
): Promise<void> {
  const tx = createTransaction({
    mutationFn: async ({ transaction }) => {
      await collection.utils.acceptMutations(transaction);
    },
  });
  tx.mutate(() => {
    collection.insert(row);
  });
  await tx.when("settled");
}

describe("node-env TanStack DB persistence adapter (Phase 3.1 spike)", () => {
  it("round-trips a row through a reopened database and collection", async () => {
    const token = `spike-${Math.random().toString(36).slice(2)}`;

    const writer = openSpikeCollection();
    await writer.preload();
    await insertRow(writer, { id: "spike-1", token });
    expect(writer.toArray.map((row) => row.token)).toEqual([token]);

    const reader = openSpikeCollection();
    await reader.preload();
    expect(reader.toArray.map((row) => row.token)).toEqual([token]);
  });

  it("isolates rows by the configured collection id (the id IS the table)", async () => {
    const otherIdPersistence = createNodeSQLitePersistence({
      database: new Database(databasePath),
    });
    const otherId = createCollection(
      persistedCollectionOptions<SpikeRow, string>({
        id: "spike-other-collection",
        getKey: (row) => row.id,
        persistence: otherIdPersistence,
        schemaVersion: 1,
      }),
    );
    await otherId.preload();
    expect(otherId.toArray).toEqual([]);
  });
});
