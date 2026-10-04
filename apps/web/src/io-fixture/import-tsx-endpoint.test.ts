// @vitest-environment node
// The loader under test pulls esbuild and node:vm — both require the real
// node globals (esbuild's startup invariant refuses jsdom's TextEncoder,
// and the vm sandbox is meaningless there). The suite drives the handler
// through node's own Request/Response, exactly like the server runtime.

/**
 * The TSX import endpoint's tests (Phase 4): every gate a public POST
 * body must pass — session (401), declared content-length cap (413,
 * before buffering), streamed-byte cap (413, aborted mid-read) — the
 * loader's structured refusals through the endpoint (422, including the
 * forbidden-import sandbox refusal), the happy path's native text passing
 * the format's own parser, and the INTEGRATION EQUALITY: the endpoint's
 * output for a fixture model equals `compileToNative`'s output for the
 * same model — one pipeline, two doors.
 *
 * The before-buffering gates are proven with an UNREADABLE body and the
 * streamed-cap gate with a THROWING-AFTER-THE-FIRST-CHUNK body (the 3MF
 * endpoint tests' discipline): streams that fail loudly the moment anyone
 * buffers past the point the handler should have stopped.
 */

import { describe, expect, it } from "vitest";
import { parseNativeCadDocumentFromString } from "@slopcad/cad-core";
import {
  Body,
  Box,
  Circle,
  Extrude,
  Sketch,
  Union,
  Use,
  compileToNative,
} from "@slopcad/cad-jsx";
import { Fragment, createElement } from "react";

import {
  IMPORT_TSX_MAX_BODY_BYTES,
  handleImportTsxRequest,
  type ImportTsxResponse,
  type ImportTsxSessionLookup,
} from "./import-tsx-endpoint";

const signedIn: ImportTsxSessionLookup = () =>
  Promise.resolve({ user: { id: "user-io-endpoint-test" } });

const anonymous: ImportTsxSessionLookup = () => Promise.resolve(null);

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
  return new Request("http://slopcad.test/api/io/import-tsx", {
    method: "POST",
    ...options,
  });
}

async function readFailure(
  response: Response,
): Promise<{ readonly code: string; readonly message: string }> {
  expect(response.headers.get("content-type")).toContain("application/json");
  const payload = (await response.json()) as ImportTsxResponse;
  expect(payload.ok).toBe(false);
  if (payload.ok) throw new Error("expected a failure envelope");
  return { code: payload.code, message: payload.message };
}

/** The fixture model: the guide's authoring shape, as source text. */
const FIXTURE_TSX = `import { Body, Box, Circle, Extrude, Sketch, Union, Use } from "@slopcad/cad-jsx";

export default (
  <>
    <Sketch id={"skd_plate"} name={"plate profile"}>
      <Circle id={"skent_plate"} cx={0} cy={0} radius={10} />
    </Sketch>
    <Extrude id={"feat_plate"} sketch={"skd_plate"} height={4} />
    <Body id={"body_mount"} name={"mount"}>
      <Union id={"feat_mount"}>
        <Use feature={"feat_plate"} />
        <Box width={6} depth={6} height={12} />
      </Union>
    </Body>
  </>
);
`;

describe("the TSX import endpoint gates", () => {
  it("refuses a cookie-less request with 401 before reading the body", async () => {
    const response = await handleImportTsxRequest(
      postRequest({ body: unreadableBody(), duplex: "half" }),
      anonymous,
    );
    expect(response.status).toBe(401);
    const failure = await readFailure(response);
    expect(failure.code).toBe("io-import/authentication-required");
  });

  it("refuses an over-cap declared content-length with 413 before reading the body", async () => {
    const response = await handleImportTsxRequest(
      postRequest({
        body: unreadableBody(),
        duplex: "half",
        headers: {
          "content-length": String(IMPORT_TSX_MAX_BODY_BYTES + 1),
        },
      }),
      signedIn,
    );
    expect(response.status).toBe(413);
    const failure = await readFailure(response);
    expect(failure.code).toBe("io-import/payload-too-large");
  });

  it("refuses an over-cap buffered body with 413 even without a truthful header", async () => {
    const body = new Uint8Array(IMPORT_TSX_MAX_BODY_BYTES + 1);
    const request = postRequest({ body });
    expect(request.headers.get("content-length")).toBeNull();
    const response = await handleImportTsxRequest(request, signedIn);
    expect(response.status).toBe(413);
    const failure = await readFailure(response);
    expect(failure.code).toBe("io-import/payload-too-large");
  });

  it("aborts a headerless over-cap streamed body on the first over-cap read", async () => {
    let firstPull = true;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (firstPull) {
          firstPull = false;
          controller.enqueue(new Uint8Array(IMPORT_TSX_MAX_BODY_BYTES + 1));
          return;
        }
        throw new Error(
          "TEST: the over-cap stream must be cancelled after the first over-cap read",
        );
      },
    });
    const request = postRequest({ body, duplex: "half" });
    const response = await handleImportTsxRequest(request, signedIn);
    expect(response.status).toBe(413);
    const failure = await readFailure(response);
    expect(failure.code).toBe("io-import/payload-too-large");
    expect(failure.message).toContain(
      `(received ${String(IMPORT_TSX_MAX_BODY_BYTES + 1)})`,
    );
  });
});

describe("the TSX import endpoint loader pass-through", () => {
  it("refuses a model importing node:fs with the loader's structured code", async () => {
    const response = await handleImportTsxRequest(
      postRequest({
        body: 'import fs from "node:fs";\nexport default null;\nvoid fs;\n',
      }),
      signedIn,
    );
    expect(response.status).toBe(422);
    const failure = await readFailure(response);
    expect(failure.code).toBe("cadjsx-load/forbidden-import");
  });

  it("refuses a broken model with the compiler's structured code and tree path", async () => {
    const response = await handleImportTsxRequest(
      postRequest({
        body: 'import { Box } from "@slopcad/cad-jsx";\nexport default <Box width={1} />;\n',
      }),
      signedIn,
    );
    expect(response.status).toBe(422);
    const payload = (await response.json()) as ImportTsxResponse;
    expect(payload.ok).toBe(false);
    if (payload.ok) throw new Error("expected a failure envelope");
    expect(payload.code).toBe("cadjsx/prop-value-invalid");
    expect(payload.path).toBeDefined();
  });

  it("returns native text that passes the format's own parser", async () => {
    const response = await handleImportTsxRequest(
      postRequest({ body: FIXTURE_TSX }),
      signedIn,
    );
    expect(response.status).toBe(200);
    const payload = (await response.json()) as ImportTsxResponse;
    expect(payload.ok).toBe(true);
    if (!payload.ok) throw new Error(payload.message);
    const reopened = parseNativeCadDocumentFromString(payload.native);
    expect(reopened.ok).toBe(true);
    if (!reopened.ok) throw new Error(reopened.error.message);
    expect(
      reopened.value.document.features.map((feature) => feature.kind),
    ).toEqual(["extrude", "box", "union"]);
  });

  it("equals compileToNative's output for the same model (one pipeline, two doors)", async () => {
    // The same model, authored directly as an element tree and compiled
    // in-process: the endpoint's text must be byte-identical.
    const direct = compileToNative(
      createElement(
        Fragment,
        null,
        createElement(
          Sketch,
          {
            id: "skd_plate",
            name: "plate profile",
          },
          createElement(Circle, {
            id: "skent_plate",
            cx: 0,
            cy: 0,
            radius: 10,
          }),
        ),
        createElement(Extrude, {
          id: "feat_plate",
          sketch: "skd_plate",
          height: 4,
        }),
        createElement(
          Body,
          { id: "body_mount", name: "mount" },
          createElement(
            Union,
            { id: "feat_mount" },
            createElement(Use, { feature: "feat_plate" }),
            createElement(Box, { width: 6, depth: 6, height: 12 }),
          ),
        ),
      ),
    );
    expect(direct.ok).toBe(true);
    if (!direct.ok) throw new Error(direct.error.message);
    const response = await handleImportTsxRequest(
      postRequest({ body: FIXTURE_TSX }),
      signedIn,
    );
    const payload = (await response.json()) as ImportTsxResponse;
    expect(payload.ok).toBe(true);
    if (!payload.ok) throw new Error(payload.message);
    expect(payload.native).toBe(direct.value);
  });
});
