/**
 * The TSX model import endpoint's request handling (Phase 4): the
 * `@slopcad/cad-jsx` canonical loader — transpile, sandbox evaluate,
 * compile to the native `slopcad` format — behind the same two gates the
 * 3MF endpoint established for public POST bodies (Phase 35 hardening),
 * then the loader's own source-size cap.
 *
 * - **Authentication.** The Better Auth session check the tRPC context
 *   runs: no session, no compile — a 401 with the structured failure
 *   envelope. The in-page import surface (same-origin fetch) carries the
 *   signed-in user's cookie, so the workbench journey is unchanged.
 * - **Body cap.** `IMPORT_TSX_MAX_BODY_BYTES` (64 MiB, the 3MF
 *   precedent's cap — an order of magnitude above any realistic model
 *   file) is checked against the declared `content-length` BEFORE the
 *   body is read; the body is then buffered incrementally and the read
 *   CANCELLED the moment the running byte count passes the cap. Oversize
 *   is a 413.
 * - **The loader.** The buffered bytes decode as UTF-8 and run through
 *   `compileTsxSource` (`@slopcad/cad-jsx/loader`): the ONE transpile →
 *   evaluate → compile pipeline, shared with the package's round-trip
 *   tests, whose vm sandbox exposes only React's createElement/Fragment,
 *   the cad-jsx element runtime, and a `require` resolving exactly
 *   `"react"` and `"@slopcad/cad-jsx"`. Every structured refusal — a
 *   forbidden import, a transpile or evaluation failure, a compile error
 *   (with its tree path), a native emission failure — passes through
 *   verbatim with HTTP 422.
 *
 * Success returns the native document's canonical TEXT (the exact string
 * `documents.save` stores as `nativeContent` and the workbench's
 * persistence bridge parses), so the client feeds it through the SAME
 * native apply path an opened document takes.
 *
 * The session lookup is injected (the routers' dependency-injection
 * convention) so the unit tests drive every gate without the auth
 * package's import-time database singleton.
 */

import { compileTsxSource } from "@slopcad/cad-jsx/loader";

/**
 * The largest TSX body the endpoint buffers: authored models are
 * kilobytes; 64 MiB matches the 3MF precedent's cap and bounds the
 * buffering and the sandbox work.
 */
export const IMPORT_TSX_MAX_BODY_BYTES = 64 * 1024 * 1024;

/** The successful import response: the native document's canonical text. */
export interface ImportTsxSuccess {
  readonly ok: true;
  /** The native `slopcad` document format's canonical text (the apply path's input). */
  readonly native: string;
}

/** The structured rejection, verbatim from the endpoint's gates or the loader. */
export interface ImportTsxFailure {
  readonly ok: false;
  /** The stable failure code (the gates' `io-import/…`, or the loader's own codes). */
  readonly code: string;
  /** The human-readable rejection message. */
  readonly message: string;
  /** The compile failure's element tree path, when the refusal carries one. */
  readonly path?: readonly string[];
}

/** Everything the endpoint returns. */
export type ImportTsxResponse = ImportTsxSuccess | ImportTsxFailure;

/**
 * Reads the caller's session from the request headers — the auth
 * package's `auth.api.getSession` shape, injected by the route.
 */
export type ImportTsxSessionLookup = (
  headers: Headers,
) => Promise<{ readonly user: { readonly id: string } } | null>;

/** Writes one of the endpoint's own gate failures (the wire envelope). */
function gateFailure(status: number, code: string, message: string): Response {
  const payload: ImportTsxFailure = { ok: false, code, message };
  return Response.json(payload, { status });
}

/** Writes a loader refusal verbatim (HTTP 422, the tree path when present). */
function loaderFailure(error: {
  readonly code: string;
  readonly message: string;
  readonly path?: readonly string[];
}): Response {
  const payload: ImportTsxFailure = {
    ok: false,
    code: error.code,
    message: error.message,
    ...(error.path === undefined ? {} : { path: error.path }),
  };
  return Response.json(payload, { status: 422 });
}

/** The outcome of an incrementally capped body read. */
type CappedBodyRead =
  | { readonly overCap: false; readonly bytes: Uint8Array }
  | { readonly overCap: true; readonly received: number };

/**
 * Buffers the request body chunk by chunk — never one unbounded
 * `arrayBuffer()` — aborting the read the moment the running byte count
 * passes the cap (the reader is cancelled so the transport stops sending).
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
    if (received > IMPORT_TSX_MAX_BODY_BYTES) {
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

/** The endpoint's POST handling: gates, buffer, load, respond. */
export async function handleImportTsxRequest(
  request: Request,
  getSession: ImportTsxSessionLookup,
): Promise<Response> {
  const session = await getSession(request.headers);
  if (session === null) {
    return gateFailure(
      401,
      "io-import/authentication-required",
      "A signed-in session is required to import a TSX model.",
    );
  }

  const declaredLengthHeader = request.headers.get("content-length");
  if (declaredLengthHeader !== null) {
    const declaredLength = Number(declaredLengthHeader);
    if (
      Number.isFinite(declaredLength) &&
      declaredLength > IMPORT_TSX_MAX_BODY_BYTES
    ) {
      return gateFailure(
        413,
        "io-import/payload-too-large",
        `The TSX model exceeds the import limit of ${String(IMPORT_TSX_MAX_BODY_BYTES)} bytes (declared ${declaredLengthHeader}).`,
      );
    }
  }

  const body = await readCappedBody(request);
  if (body.overCap) {
    return gateFailure(
      413,
      "io-import/payload-too-large",
      `The TSX model exceeds the import limit of ${String(IMPORT_TSX_MAX_BODY_BYTES)} bytes (received ${String(body.received)}).`,
    );
  }
  const source = new TextDecoder().decode(body.bytes);
  const loaded = await compileTsxSource({ source });
  if (!loaded.ok) {
    return loaderFailure(loaded.error);
  }
  const payload: ImportTsxSuccess = { ok: true, native: loaded.value };
  return Response.json(payload);
}
