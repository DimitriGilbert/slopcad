/**
 * Production database migration, run at container start before the Nitro
 * server boots (see docker-compose.yml). Applies the committed Drizzle
 * migration files in `packages/db/src/migrations/` to the libsql database at
 * DATABASE_URL, tracking applied files by tag in `_slopcad_migrations` so
 * restarts are no-ops. Each file is applied inside a transaction together
 * with its journal insert, so a failed migration leaves the database
 * untouched and the container refuses to boot a half-migrated schema.
 *
 * Plain node + `@libsql/client` only (a runtime dependency) — no tsx, no
 * workspace TS imports — because this runs in the image ahead of anything
 * bundled. Statement splitting mirrors `createInMemoryDb` in @slopcad/db.
 */

import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createClient } from "@libsql/client";

const migrationsFolder = fileURLToPath(
  new URL("../../../packages/db/src/migrations", import.meta.url),
);
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("DATABASE_URL is not set; refusing to migrate.");
  process.exit(1);
}

const client = createClient({ url: databaseUrl });

await client.execute(
  "CREATE TABLE IF NOT EXISTS `_slopcad_migrations` (`tag` text PRIMARY KEY NOT NULL, `applied_at` text NOT NULL)",
);
const applied = new Set(
  (await client.execute("SELECT `tag` FROM `_slopcad_migrations`")).rows.map(
    (row) => row.tag,
  ),
);

const files = (await readdir(migrationsFolder))
  .filter((file) => file.endsWith(".sql"))
  .sort();
if (files.length === 0) {
  console.error(`no migration files found in ${migrationsFolder}`);
  process.exit(1);
}

for (const file of files) {
  if (applied.has(file)) {
    continue;
  }
  const content = await readFile(`${migrationsFolder}/${file}`, "utf8");
  const statements = content
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
  const tx = await client.transaction("write");
  try {
    for (const statement of statements) {
      await tx.execute(statement);
    }
    await tx.execute({
      sql: "INSERT INTO `_slopcad_migrations` (`tag`, `applied_at`) VALUES (?, ?)",
      args: [file, new Date().toISOString()],
    });
    await tx.commit();
  } catch (error) {
    await tx.rollback();
    console.error(`migration ${file} failed; database left untouched.`);
    throw error;
  }
  console.log(`applied ${file}`);
}

client.close();
console.log(
  `migrations up to date: ${files.length} committed, ${files.length - applied.size} newly applied`,
);
