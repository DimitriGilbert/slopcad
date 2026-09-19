/**
 * The 3MF import endpoint's gate tests (Phase 35 hardening): every gate a
 * public POST body must pass — session (401), declared content-length cap
 * (413, before buffering), streamed-byte cap (413, aborted mid-read) —
 * plus the parser pass-through (422), driven through the extracted
 * request handler with the session lookup injected (no auth package
 * import-time database).
 *
 * The before-buffering gates are proven with an UNREADABLE body, and the
 * streamed-cap gate with a THROWING-AFTER-THE-FIRST-CHUNK body: streams
 * that fail loudly the moment anyone buffers past the point the handler
 * should have stopped — if the handler buffered such a request the test
 * would fail loudly instead of asserting a gate response.
 */

import { describe, expect, it } from "vitest";

import {
  handleImportThreeMfRequest,
  IMPORT_3MF_MAX_BODY_BYTES,
  type Import3mfSessionLookup,
} from "./import-3mf-endpoint";

const signedIn: Import3mfSessionLookup = () =>
  Promise.resolve({ user: { id: "user-io-endpoint-test" } });

const anonymous: Import3mfSessionLookup = () => Promise.resolve(null);

/** A body stream that fails the moment anyone tries to buffer it. */
function unreadableBody(): ReadableStream<Uint8Array> {
  return new ReadableStream({
    pull() {
      throw new Error(
        "TEST: this request's body must not be buffered (the gate must answer first)",
      );
    },
  });
}

function postRequest(options: RequestInit & { duplex?: "half" }): Request {
  // `duplex: "half"` is required by the runtime for streaming bodies; it
  // rides along through the spread (this lib's RequestInit type predates
  // the option, and object-literal excess checks don't apply to spreads).
  return new Request("http://slopcad.test/api/io/import-3mf", {
    method: "POST",
    ...options,
  });
}

async function readFailure(
  response: Response,
): Promise<{ readonly code: string; readonly message: string }> {
  expect(response.headers.get("content-type")).toContain("application/json");
  const payload = (await response.json()) as {
    ok: boolean;
    code: string;
    message: string;
  };
  expect(payload.ok).toBe(false);
  return { code: payload.code, message: payload.message };
}

describe("the 3MF import endpoint gates", () => {
  it("refuses a cookie-less request with 401 before reading the body", async () => {
    const response = await handleImportThreeMfRequest(
      postRequest({ body: unreadableBody(), duplex: "half" }),
      anonymous,
    );
    expect(response.status).toBe(401);
    const failure = await readFailure(response);
    expect(failure.code).toBe("io-import/authentication-required");
  });

  it("refuses an over-cap declared content-length with 413 before reading the body", async () => {
    const response = await handleImportThreeMfRequest(
      postRequest({
        body: unreadableBody(),
        duplex: "half",
        headers: {
          "content-length": String(IMPORT_3MF_MAX_BODY_BYTES + 1),
        },
      }),
      signedIn,
    );
    expect(response.status).toBe(413);
    const failure = await readFailure(response);
    expect(failure.code).toBe("io-import/payload-too-large");
  });

  it("refuses an over-cap buffered body with 413 even without a truthful header", async () => {
    // No content-length header (a chunked upload): the byte count of the
    // buffered body is the only remaining truth.
    const body = new Uint8Array(IMPORT_3MF_MAX_BODY_BYTES + 1);
    const request = postRequest({ body });
    expect(request.headers.get("content-length")).toBeNull();
    const response = await handleImportThreeMfRequest(request, signedIn);
    expect(response.status).toBe(413);
    const failure = await readFailure(response);
    expect(failure.code).toBe("io-import/payload-too-large");
  });

  it("aborts a headerless over-cap streamed body on the first over-cap read", async () => {
    // A chunked upload (no content-length) whose FIRST chunk alone passes
    // the cap: the incremental read must cancel the stream right there
    // and answer 413 — not buffer the body to the end first. The sentinel
    // stream throws on every pull after the first, so a full buffering
    // (the reverted `arrayBuffer()` shape) fails this test loudly.
    let firstPull = true;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (firstPull) {
          firstPull = false;
          controller.enqueue(new Uint8Array(IMPORT_3MF_MAX_BODY_BYTES + 1));
          return;
        }
        throw new Error(
          "TEST: the over-cap stream must be cancelled after the first over-cap read",
        );
      },
    });
    const request = postRequest({ body, duplex: "half" });
    expect(request.headers.get("content-length")).toBeNull();
    const response = await handleImportThreeMfRequest(request, signedIn);
    expect(response.status).toBe(413);
    const failure = await readFailure(response);
    expect(failure.code).toBe("io-import/payload-too-large");
    // The reported count is exactly the first chunk: the read stopped the
    // moment the cap was crossed, with no further pull tolerated.
    expect(failure.message).toContain(
      `(received ${String(IMPORT_3MF_MAX_BODY_BYTES + 1)})`,
    );
  });

  it("passes the adapter's structured rejection through verbatim with 422", async () => {
    const response = await handleImportThreeMfRequest(
      postRequest({
        body: "this is not a zip archive, let alone a 3MF document",
      }),
      signedIn,
    );
    expect(response.status).toBe(422);
    const failure = await readFailure(response);
    expect(failure.code).toMatch(/^three-mf-import\//);
  });
});
