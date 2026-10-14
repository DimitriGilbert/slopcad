/**
 * The session harness's model-catalog seed (PLAN-AGENT-CHAT Phase 6, B1):
 * harness tooling run in the webServer chain, once migrations have applied,
 * against the REAL `DATABASE_URL` (the same SQLite file the production
 * server opens — `createInMemoryDb()` does not exist in that habitat).
 *
 * For each of the four named providers it inserts `model_catalog_entries`
 * rows plus the provider's `model_catalog_meta` row from the committed
 * trimmed fixture (`packages/api/src/routers/model-catalog.fixture.json`),
 * so the picker and the catalog-driven parts of the walk work with zero
 * network. The FILTER is the router's own module (`model-catalog-filter`),
 * pinned to the fixture's recorded capture date — NOT the wall clock — so
 * the seeded row set is deterministic forever, exactly the counts the
 * Phase 1.1 unit tests pin.
 *
 * One transaction replaces the whole catalog cache (the harness database
 * is the harness's own): no drizzle operators are needed, which keeps this
 * script inside apps/web's strict-pnpm dependency closure (drizzle-orm is
 * not a web dependency; `@slopcad/db`'s handle and schema are).
 *
 * Run (from apps/web, the playwright webServer cwd):
 * `node --env-file-if-exists=.env --import tsx e2e-session/scripts/seed-agent-catalog.ts`
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { db } from "@slopcad/db";
import {
  modelCatalogEntries,
  modelCatalogMeta,
} from "@slopcad/db/schema/model-catalog";
import { NAMED_PROVIDER_IDS } from "@slopcad/api/providers";
import {
  extractProviderModels,
  filterProviderModels,
} from "@slopcad/api/routers/model-catalog-filter";
const FIXTURE_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../packages/api/src/routers/model-catalog.fixture.json",
);

async function main(): Promise<void> {
  const fixture: unknown = JSON.parse(readFileSync(FIXTURE_PATH, "utf8"));
  const captureDate = readCaptureDate(fixture);
  const now = new Date(`${captureDate}T00:00:00.000Z`);

  await db.transaction(async (tx) => {
    await tx.delete(modelCatalogEntries);
    for (const provider of NAMED_PROVIDER_IDS) {
      const filtered = filterProviderModels(
        provider,
        extractProviderModels(fixture, provider),
        now,
      );
      if (filtered.length === 0) {
        throw new Error(
          `seed-agent-catalog: the fixture yielded no ${provider} entries — the walk's catalog-backed stages need at least one`,
        );
      }
      await tx
        .insert(modelCatalogEntries)
        .values(filtered.map((entry) => ({ ...entry, fetchedAt: now })));
      await tx
        .insert(modelCatalogMeta)
        .values({ provider, etag: null, fetchedAt: now })
        .onConflictDoUpdate({
          target: modelCatalogMeta.provider,
          set: { etag: null, fetchedAt: now },
        });
      console.log(
        `[seed-agent-catalog] ${provider}: ${String(filtered.length)} entries @ ${captureDate}`,
      );
    }
  });
}

/** Reads the fixture's recorded capture date (the pinned filter `now`). */
function readCaptureDate(fixture: unknown): string {
  if (typeof fixture !== "object" || fixture === null) {
    throw new Error("seed-agent-catalog: the fixture is not an object");
  }
  const captureDate = (fixture as Record<string, unknown>)["$captureDate"];
  if (
    typeof captureDate !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(captureDate)
  ) {
    throw new Error(
      "seed-agent-catalog: the fixture carries no valid $captureDate",
    );
  }
  return captureDate;
}

main()
  .then(() => {
    process.exit(0);
  })
  .catch((error: unknown) => {
    console.error("[seed-agent-catalog] failed:", error);
    process.exit(1);
  });
