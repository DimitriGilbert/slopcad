/**
 * Production database migration, run at container start before the Nitro
 * server boots (see docker-compose.yml). Applies the committed Drizzle
 * migrations listed in `packages/db/src/migrations/meta/_journal.json` to the
 * libsql database at DATABASE_URL, tracked in drizzle-kit's own
 * `__drizzle_migrations` journal table — the same table, columns, sha256
 * hashes and epoch-millis `created_at` values written by `db:migrate`
 * (drizzle-orm's libsql migrator) — so a database managed by either runner is
 * seen as up to date by the other and restarts are no-ops. Each migration
 * file is applied inside a transaction together with its journal insert, so
 * a failed migration leaves the database untouched and the container refuses
 * to boot a half-migrated schema.
 *
 * Plain node + `@libsql/client` only (a runtime dependency) — no tsx, no
 * workspace TS imports — because this runs in the image ahead of anything
 * bundled. Statement splitting mirrors `createInMemoryDb` in @slopcad/db; the
 * pending check and journal format mirror drizzle-orm's libsql migrator
 * (apply entries whose `when` is newer than the newest applied `created_at`).
 */

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
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

const journal = JSON.parse(
  await readFile(`${migrationsFolder}/meta/_journal.json`, "utf8"),
);
const entries = journal.entries;
if (!Array.isArray(entries) || entries.length === 0) {
  console.error(
    `no migration entries in ${migrationsFolder}/meta/_journal.json`,
  );
  process.exit(1);
}

const client = createClient({ url: databaseUrl });

// The exact table drizzle-kit's `migrate` (drizzle-orm/libsql/migrator)
// creates and consults: the newest `created_at` decides what is pending.
await client.execute(
  "CREATE TABLE IF NOT EXISTS `__drizzle_migrations` (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at numeric)",
);
// Databases migrated before the runner switched to drizzle-kit's journal
// tracked applied files (`<tag>.sql`) in `_slopcad_migrations`; adopt those rows (with the
// hash/created_at drizzle-kit would have written) once, so the committed
// migrations they already ran are not re-applied.
const legacy = await client.execute(
  "SELECT `name` FROM `sqlite_master` WHERE `type` = 'table' AND `name` = '_slopcad_migrations'",
);
const tracked = await client.execute(
  "SELECT COUNT(*) AS `count` FROM `__drizzle_migrations`",
);
if (legacy.rows.length > 0 && Number(tracked.rows[0].count) === 0) {
  const appliedTags = new Set(
    (await client.execute("SELECT `tag` FROM `_slopcad_migrations`")).rows.map(
      (row) => String(row.tag),
    ),
  );
  const tx = await client.transaction("write");
  try {
    for (const entry of entries) {
      if (!appliedTags.has(`${entry.tag}.sql`)) continue;
      const content = await readFile(
        `${migrationsFolder}/${entry.tag}.sql`,
        "utf8",
      );
      await tx.execute({
        sql: "INSERT INTO `__drizzle_migrations` (`hash`, `created_at`) VALUES (?, ?)",
        args: [createHash("sha256").update(content).digest("hex"), entry.when],
      });
      console.log(`adopted ${entry.tag} from _slopcad_migrations`);
    }
    await tx.commit();
  } catch (error) {
    await tx.rollback();
    console.error(
      "adopting _slopcad_migrations failed; database left untouched.",
    );
    throw error;
  }
}

const newest = await client.execute(
  "SELECT `created_at` FROM `__drizzle_migrations` ORDER BY `created_at` DESC LIMIT 1",
);
const newestCreatedAt =
  newest.rows[0] === undefined
    ? Number.NEGATIVE_INFINITY
    : Number(newest.rows[0].created_at);

let appliedCount = 0;
for (const entry of entries) {
  if (Number(entry.when) <= newestCreatedAt) {
    continue;
  }
  const file = `${entry.tag}.sql`;
  const content = await readFile(`${migrationsFolder}/${file}`, "utf8");
  const hash = createHash("sha256").update(content).digest("hex");
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
      sql: "INSERT INTO `__drizzle_migrations` (`hash`, `created_at`) VALUES (?, ?)",
      args: [hash, entry.when],
    });
    await tx.commit();
  } catch (error) {
    await tx.rollback();
    console.error(`migration ${file} failed; database left untouched.`);
    throw error;
  }
  console.log(`applied ${file}`);
  appliedCount += 1;
}

client.close();
console.log(
  `migrations up to date: ${entries.length} committed, ${appliedCount} newly applied`,
);
