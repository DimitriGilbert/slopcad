import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vi } from "vitest";

/**
 * Vitest global setup. Runs before any test module is imported.
 *
 * 1. **No env validation at import time.** Importing `@slopcad/env/server`
 *    validates `process.env`; skip it so tests run without a `.env`.
 * 2. **Known local database.** Modules that construct singletons (db, auth)
 *    read these values. Unconditional assignment (never `??=`): an inherited
 *    DATABASE_URL from the ambient shell must not leak into modules
 *    constructed under test.
 */
process.env.SKIP_ENV_VALIDATION = "1";
process.env.DATABASE_URL = `file:${join(tmpdir(), `slopcad-api-test-${randomUUID()}.db`)}`;
process.env.BETTER_AUTH_SECRET =
  "unit-test-secret-0123456789abcdef0123456789abcdef";
process.env.BETTER_AUTH_URL = "http://localhost:3001";

vi.stubGlobal(
  "fetch",
  vi.fn(() => {
    throw new Error("TEST FORBIDS LIVE NETWORK: fetch was called");
  }),
);
