/**
 * The workbench's law-S7 store bootstrap (Phase 63c): the LOCAL backend
 * by default — client-first is a mode, not a degradation — over the real
 * IndexedDB adapter, with the decline surfaced to the caller when the
 * host has no IndexedDB (the adapter throws; the panel shows the
 * structured refusal instead of pretending). A server backend, when one
 * is configured for the host, plugs into the same selection seam
 * (`selectSimResultStore`); today the workbench runs client-only.
 */

import type { SimResultStore } from "@slopcad/sim-core";
import {
  createIndexedDbSimResultStorage,
  createLocalSimResultStore,
} from "@slopcad/sim-core";

/**
 * Boots the workbench's local result store over the host's IndexedDB.
 * Rejects when the host has none or the open fails — the caller decides
 * what the panel shows; there is no silent in-memory masquerade (the
 * adapter's own stance, kept honest here).
 */
export async function createWorkbenchSimResultStore(): Promise<SimResultStore> {
  return createLocalSimResultStore({
    storage: await createIndexedDbSimResultStorage(),
  });
}
