/**
 * Vitest global setup. Runs before any test module is imported.
 *
 * Importing `@slopcad/auth` constructs the better-auth singleton over
 * `createDb()`, which reads `env.DATABASE_URL`. A unique temp-file database is
 * assigned per run so the tests can apply the committed migrations to that
 * same file (libsql `file:` clients over one path share the database, unlike
 * pooled `:memory:` connections).
 */
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.SKIP_ENV_VALIDATION = "1";
// Unconditional (never `??=`): an inherited DATABASE_URL from the ambient
// shell must NOT be migrated against — tests own their database outright.
process.env.DATABASE_URL = `file:${join(tmpdir(), `slopcad-auth-test-${randomUUID()}.db`)}`;
process.env.BETTER_AUTH_SECRET ??=
  "unit-test-secret-0123456789abcdef0123456789abcdef";
process.env.BETTER_AUTH_URL ??= "http://localhost:3001";
