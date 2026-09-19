/**
 * The /io fixture's 3MF import endpoint: runs the Phase 18.4
 * `importThreeMf` adapter — which is Node-targeted (deflate ZIP entries
 * inflate through `node:zlib`; see the cad-io module header's documented
 * browser constraint) — on the app's own server and returns the parsed
 * mesh as JSON (see `@/io-fixture/io-protocol` for the wire contract).
 * The browser fixture exports 3MF in-page, posts those exact bytes here,
 * and projects the returned soup locally; STL import never touches this
 * endpoint (the STL adapter is pure JS and runs fully in the browser).
 *
 * The handling itself lives in `@/io-fixture/import-3mf-endpoint`
 * (Phase 35 hardening): a session gate (401) and a 64 MiB body cap (413)
 * ahead of the buffering, then the adapter verbatim. The adapter's own
 * structured failures still pass through with HTTP 422 — the browser
 * surfaces `three-mf-import/<cause>` unchanged, so the parsing failure
 * vocabulary stays the adapter's alone.
 */

import { auth } from "@slopcad/auth";
import { createFileRoute } from "@tanstack/react-router";

import { handleImportThreeMfRequest } from "@/io-fixture/import-3mf-endpoint";

export const Route = createFileRoute("/api/io/import-3mf")({
  server: {
    handlers: {
      POST: async ({ request }: { request: Request }): Promise<Response> =>
        handleImportThreeMfRequest(request, (headers) =>
          auth.api.getSession({ headers }),
        ),
    },
  },
});
