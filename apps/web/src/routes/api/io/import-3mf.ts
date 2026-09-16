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
 * Rejections are the adapter's own structured failures passed through
 * verbatim with HTTP 422 — the browser surfaces `three-mf-import/<cause>`
 * unchanged, so the server adds no failure vocabulary of its own.
 */

import { importThreeMf } from "@slopcad/cad-io";
import { createFileRoute } from "@tanstack/react-router";
import type { ThreeMfImportResponse } from "@/io-fixture/io-protocol";

export const Route = createFileRoute("/api/io/import-3mf")({
  server: {
    handlers: {
      POST: async ({ request }: { request: Request }): Promise<Response> => {
        const bytes = new Uint8Array(await request.arrayBuffer());
        const result = importThreeMf(bytes);
        const payload: ThreeMfImportResponse = result.ok
          ? {
              ok: true,
              units: result.value.units,
              metadata: result.value.metadata,
              positions: [...result.value.tessellation.positions],
              indices: [...result.value.tessellation.indices],
            }
          : {
              ok: false,
              code: result.error.code,
              message: result.error.message,
            };
        return Response.json(payload, {
          status: result.ok ? 200 : 422,
        });
      },
    },
  },
});
