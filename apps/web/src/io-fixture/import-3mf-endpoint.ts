/**
 * The 3MF import endpoint's request handling (Phase 35 hardening): the
 * Phase 18.4 server-side `importThreeMf` behind the two gates a public
 * POST body must pass BEFORE the app spends unbounded work on it —
 * authentication and a body-size cap.
 *
 * The endpoint is reachable cookie-less on a server that binds 0.0.0.0 by
 * design, so the gates live ahead of the buffering:
 *
 * - **Authentication.** The same Better Auth session check the tRPC
 *   context runs (`auth.api.getSession`): no session, no parse — a 401
 *   with the endpoint's structured failure envelope. The in-page import
 *   surface (same-origin fetch) carries the session cookie of a signed-in
 *   user, so the fixture journey is unchanged for authenticated sessions.
 * - **Body cap.** `IMPORT_3MF_MAX_BODY_BYTES` (64 MiB — an order of
 *   magnitude above any realistic 3MF document) is checked against the
 *   declared `content-length` BEFORE the body is read; the body is then
 *   buffered incrementally, chunk by chunk, and the read is CANCELLED the
 *   moment the running byte count passes the cap — a lying or absent
 *   (chunked) content-length can therefore buffer at most the cap plus one
 *   chunk in memory, never an unbounded whole body. Oversize is a 413.
 *
 * Both gates answer in the wire contract's failure shape
 * (`@/io-fixture/io-protocol`) so the browser surfaces them through the
 * same `code: message` path as the parser's own rejections. The parser's
 * structured failures still pass through verbatim with HTTP 422 — the
 * server adds no parsing vocabulary of its own.
 *
 * The session lookup is injected (the routers' dependency-injection
 * convention) so the unit tests drive every gate without the auth
 * package's import-time database singleton.
 */

// The local TYPE import stays in eslint's first import group (the repo's
// import/order config ranks type-only imports with external/workspace
// imports — see fixture-session.ts); the blank line separates local VALUE
// imports, of which this module has none.
import { importThreeMf } from "@slopcad/cad-io";
import type { ThreeMfImportResponse } from "./io-protocol";

/**
 * The largest 3MF body the endpoint buffers: real 3MF documents (the /io
 * fixture's own exports included) are kilobytes-to-megabytes; 64 MiB
 * bounds the buffer and the Node-targeted parse without excluding any
 * realistic document.
 */
export const IMPORT_3MF_MAX_BODY_BYTES = 64 * 1024 * 1024;

/**
 * Reads the caller's session from the request headers — the auth
 * package's `auth.api.getSession` shape, injected by the route.
 */
export type Import3mfSessionLookup = (
  headers: Headers,
) => Promise<{ readonly user: { readonly id: string } } | null>;

/** Writes one of the endpoint's own gate failures (the wire envelope). */
function gateFailure(status: number, code: string, message: string): Response {
  const payload: ThreeMfImportResponse = { ok: false, code, message };
  return Response.json(payload, { status });
}

/** The outcome of an incrementally capped body read. */
type CappedBodyRead =
  | { readonly overCap: false; readonly bytes: Uint8Array }
  | { readonly overCap: true; readonly received: number };

/**
 * Buffers the request body chunk by chunk — never one unbounded
 * `arrayBuffer()` — aborting the read the moment the running byte count
 * passes the cap (the reader is cancelled so the transport stops sending).
 * A request without a body stream (null) reads as empty, exactly as
 * `arrayBuffer()` would have.
 */
async function readCappedBody(request: Request): Promise<CappedBodyRead> {
  if (request.body === null) {
    return { overCap: false, bytes: new Uint8Array(0) };
  }
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    received += value.byteLength;
    if (received > IMPORT_3MF_MAX_BODY_BYTES) {
      // The stream may already be broken mid-transfer (a cancelled or
      // errored upload); the refusal stands either way.
      await reader.cancel().catch(() => undefined);
      return { overCap: true, received };
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { overCap: false, bytes };
}

/** The endpoint's POST handling: gates, buffer, parse, respond. */
export async function handleImportThreeMfRequest(
  request: Request,
  getSession: Import3mfSessionLookup,
): Promise<Response> {
  const session = await getSession(request.headers);
  if (session === null) {
    return gateFailure(
      401,
      "io-import/authentication-required",
      "A signed-in session is required to import a 3MF document.",
    );
  }

  const declaredLengthHeader = request.headers.get("content-length");
  if (declaredLengthHeader !== null) {
    const declaredLength = Number(declaredLengthHeader);
    if (
      Number.isFinite(declaredLength) &&
      declaredLength > IMPORT_3MF_MAX_BODY_BYTES
    ) {
      return gateFailure(
        413,
        "io-import/payload-too-large",
        `The 3MF document exceeds the import limit of ${String(IMPORT_3MF_MAX_BODY_BYTES)} bytes (declared ${declaredLengthHeader}).`,
      );
    }
  }

  const body = await readCappedBody(request);
  if (body.overCap) {
    return gateFailure(
      413,
      "io-import/payload-too-large",
      `The 3MF document exceeds the import limit of ${String(IMPORT_3MF_MAX_BODY_BYTES)} bytes (received ${String(body.received)}).`,
    );
  }
  const bytes = body.bytes;

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
}
