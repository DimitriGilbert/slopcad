import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@libsql/client";
import { env } from "@slopcad/env/server";
import { drizzle } from "drizzle-orm/libsql";

import * as schema from "./schema";

/** The drizzle handle the api layer's routers receive (see the routers' factories). */
export type SlopcadDatabase = ReturnType<typeof createDb>;

export function createDb() {
  const client = createClient({
    url: env.DATABASE_URL,
  });

  return drizzle({ client, schema });
}

/**
 * Build a Drizzle client over an ephemeral local libsql database with the
 * committed migrations applied, for use in unit tests (solard donor pattern).
 * No network I/O is performed — the `file:` scheme talks to a local SQLite
 * file only.
 *
 * Each call uses a unique temp file (cleaned up by the OS) so tests are fully
 * isolated. A plain libsql `:memory:` URL is unsuitable here because libsql
 * pools connections and a transaction may land on a different ephemeral
 * database than the reads that follow it.
 *
 * Pass an explicit `url` to share one prepared database across modules (the
 * auth tests point both `createInMemoryDb` and `createAuth` at the same file).
 */
export async function createInMemoryDb(
  url: string = `file:${join(tmpdir(), `slopcad-test-${randomUUID()}.db`)}`,
) {
  const client = createClient({ url });
  const here = dirname(fileURLToPath(import.meta.url));
  const migrationsFolder = resolve(here, "./migrations");
  const files = await readdir(migrationsFolder);
  const sqlFiles = files.filter((file) => file.endsWith(".sql")).sort();
  for (const file of sqlFiles) {
    const content = await readFile(resolve(migrationsFolder, file), "utf8");
    const statements = content
      .split("--> statement-breakpoint")
      .map((statement) => statement.trim())
      .filter((statement) => statement.length > 0);
    for (const statement of statements) {
      await client.execute(statement);
    }
  }
  return drizzle({ client, schema });
}

export const db = createDb();
