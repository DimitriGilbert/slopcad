/**
 * Vitest global setup. Runs before any test module is imported.
 *
 * Importing `@slopcad/db` constructs its singleton client, which reads
 * `env.DATABASE_URL` via `@t3-oss/env-core`. A local temp-file libsql URL
 * keeps the singleton off any real server; tests themselves use
 * `createInMemoryDb()` for isolated, migrated databases.
 */
process.env.SKIP_ENV_VALIDATION = "1";
// Unconditional (never `??=`): an inherited DATABASE_URL from the ambient
// shell must not leak into the singleton client under test.
process.env.DATABASE_URL = "file:/tmp/slopcad-db-singleton.db";
