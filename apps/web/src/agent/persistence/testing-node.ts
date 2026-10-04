/**
 * Node-env test support for the agent chat persistence suite (Phase 3.4):
 * the EXACT injection seam production uses, bound to the Phase 3.1 spike's
 * proven node adapter — `@tanstack/node-db-sqlite-persistence` over a
 * real temp-FILE better-sqlite3 database (file-backed on purpose: reopening
 * the file proves the same durable-write contract the browser OPFS adapter
 * must satisfy; `node-adapter.spike.test.ts` is the standing evidence).
 *
 * Test support ONLY — never imported by production paths (the same
 * discipline as `apps/web/src/agent/testing/`). Importing suites carry
 * their own `@vitest-environment node` docblocks.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNodeSQLitePersistence } from "@tanstack/node-db-sqlite-persistence";
import Database from "better-sqlite3";
import type { AgentPersistence } from "./collections";
import type { AgentChatStore, AgentChatStoreDeps } from "./store";

import { createAgentChatStore } from "./store";

/** A unique temp database file plus its cleanup (registered by the caller). */
export interface TempAgentDatabase {
  readonly path: string;
  readonly cleanup: () => void;
}

/** Mints an isolated temp-file database; the caller wires `cleanup` into afterAll. */
export function tempAgentDatabase(label: string): TempAgentDatabase {
  const directory = mkdtempSync(join(tmpdir(), `slopcad-agent-${label}-`));
  const path = join(directory, "agent-chat.sqlite");
  return {
    path,
    cleanup: () => {
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

/**
 * A FRESH persistence handle over the given file — each call is an
 * independent database instance, so calling this twice simulates a reload:
 * the second handle only sees rows the first durably wrote.
 */
export function openNodePersistence(databasePath: string): AgentPersistence {
  return createNodeSQLitePersistence({
    database: new Database(databasePath),
  });
}

/** A chat store over a fresh node persistence (the injected seam in action). */
export async function openNodeAgentStore(
  deps: Omit<AgentChatStoreDeps, "persistence">,
  databasePath: string,
): Promise<AgentChatStore> {
  return createAgentChatStore({
    ...deps,
    persistence: openNodePersistence(databasePath),
  });
}
