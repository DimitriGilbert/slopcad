/**
 * The browser binding for agent chat persistence (PLAN-AGENT-CHAT Phase
 * 3.4): the EXACT adapter path the Phase 3.1 spike proved through the
 * production vite/nitro pipeline and the session harness's headless
 * Chromium (`docs/architecture/adr-agent-chat.md`, "Persistence spike
 * results" (a)/(b)): `openBrowserWASQLiteOPFSDatabase` (the prebuilt
 * self-contained worker with embedded wa-sqlite WASM, OPFS-backed) wrapped
 * in `createBrowserWASQLitePersistence`.
 *
 * Single-tab wiring (the `SingleProcessCoordinator` default) per the spike's
 * decision — the session harness is one user in one context, and the
 * multi-tab `BrowserCollectionCoordinator` stays a deliberate later
 * decision. Node tests never import this module: they inject
 * `@tanstack/node-db-sqlite-persistence` through the same
 * {@link AgentPersistence} seam.
 */

import {
  createBrowserWASQLitePersistence,
  openBrowserWASQLiteOPFSDatabase,
} from "@tanstack/browser-db-sqlite-persistence";
import type { AgentPersistence } from "./collections";

import {
  createAgentChatStore,
  type AgentChatStore,
  type AgentChatStoreDeps,
} from "./store";

/** The OPFS database file agent chat persists to (one store per origin). */
export const AGENT_CHAT_DATABASE_NAME = "slopcad-agent-chat.sqlite";

/**
 * Opens the spike-proven OPFS persistence: one database, shared by both
 * collections (the adapters' documented multi-collection shape).
 */
export async function openBrowserAgentPersistence(): Promise<AgentPersistence> {
  const database = await openBrowserWASQLiteOPFSDatabase({
    databaseName: AGENT_CHAT_DATABASE_NAME,
  });
  return createBrowserWASQLitePersistence({ database });
}

/**
 * The page-facing one-call binding: OPFS persistence + the chat store over
 * it. `deps` is the store's own seam (sync transport/flag, clock, ids) —
 * only `persistence` is supplied here.
 */
export async function openBrowserAgentChatStore(
  deps: Omit<AgentChatStoreDeps, "persistence"> = {},
): Promise<AgentChatStore> {
  return createAgentChatStore({
    ...deps,
    persistence: await openBrowserAgentPersistence(),
  });
}
