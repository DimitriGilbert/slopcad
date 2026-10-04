/**
 * The TSX model import endpoint (Phase 4): runs the `@slopcad/cad-jsx`
 * canonical loader — esbuild transpile, `node:vm` sandbox evaluation, and
 * `compileToNative` — on the app's own server and returns the native
 * `slopcad` document's canonical text as JSON. The browser workbench
 * posts an authored `.tsx` model file here; the returned native string
 * then enters the session through the SAME apply path an opened document
 * takes (the persistence bridge's parse → `replaceSession`).
 *
 * The handling itself lives in `@/io-fixture/import-tsx-endpoint` (the
 * 3MF endpoint's file/route split): a session gate (401) and a 64 MiB
 * body cap (413) ahead of the buffering, then the loader verbatim. The
 * loader's structured failures — forbidden imports, transpile and
 * evaluation refusals, compile errors with their tree paths — pass
 * through with HTTP 422, so the failure vocabulary stays the loader's
 * alone.
 */

import { auth } from "@slopcad/auth";
import { createFileRoute } from "@tanstack/react-router";

import { handleImportTsxRequest } from "@/io-fixture/import-tsx-endpoint";

export const Route = createFileRoute("/api/io/import-tsx")({
  server: {
    handlers: {
      POST: async ({ request }: { request: Request }): Promise<Response> =>
        handleImportTsxRequest(request, (headers) =>
          auth.api.getSession({ headers }),
        ),
    },
  },
});
