/**
 * Vitest global setup for the web app. Runs before any test module is
 * imported.
 *
 * 1. **No env validation at import time** for any transitive `@slopcad/env`
 *    import.
 * 2. **No live network.** The web app talks to the outside world only through
 *    the tRPC client and better-auth client (both default to global `fetch`).
 *    Guarding `fetch` fails loudly instead of silently hitting a dev server.
 */
process.env.SKIP_ENV_VALIDATION = "1";

import { vi } from "vitest";

vi.stubGlobal(
  "fetch",
  vi.fn(() => {
    throw new Error("TEST FORBIDS LIVE NETWORK: fetch was called");
  }),
);
