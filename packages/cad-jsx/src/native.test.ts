/**
 * The native emission suite (Phase 3): `compileToNative` — compile, fold
 * over a fresh empty document, serialize to the native format's canonical
 * text. Asserts the emission's three guarantees: byte-stable determinism,
 * the round trip (the emitted string re-parses through the format's own
 * parser to the exact document the fold built), and error discipline
 * (compile failures and fold failures return structured errors, never
 * throws). The server-validation test re-parses the output with the exact
 * helper the documents router's save path applies to `nativeContent`
 * payloads (`parseNativeCadDocumentFromString`, see
 * `packages/api/src/routers/documents.ts`). Pure data: no DOM, no
 * network, no database.
 */

import {
  CAD_NATIVE_FORMAT_VERSION,
  parseNativeCadDocumentFromString,
  serializeCadDocument,
} from "@slopcad/cad-core";
import { Fragment, createElement } from "react";
import { describe, expect, it } from "vitest";
import type { NativeEmitError } from "./native";

import { NATIVE_EMIT_ERROR_CODES, compileToNative } from "./native";
import { Box, Cylinder, Fillet, Parameter } from "./elements";

describe("compileToNative", () => {
  it("emits deterministic, byte-identical text for the same tree and options", () => {
    const model = () =>
      createElement(
        Fragment,
        null,
        createElement(Parameter, { name: "height", value: 10 }),
        createElement(Box, { width: 30, depth: 20, height: "param_height" }),
        createElement(Cylinder, { radius: 4, height: 10 }),
      );
    const first = compileToNative(model());
    const second = compileToNative(model());
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) throw new Error("unreachable");
    expect(second.value).toBe(first.value);
    // The canonical text form: two-space-indented JSON, trailing newline,
    // the native envelope's own version stamp.
    expect(first.value.endsWith("\n")).toBe(true);
    expect(JSON.parse(first.value)).toHaveProperty(
      "formatVersion",
      CAD_NATIVE_FORMAT_VERSION,
    );
  });

  it("round-trips: the emitted string re-parses to the exact folded document", () => {
    const native = compileToNative(
      createElement(
        Fragment,
        null,
        createElement(Parameter, { name: "height", value: 10 }),
        createElement(Box, { width: 30, depth: 20, height: "param_height" }),
      ),
    );
    expect(native.ok).toBe(true);
    if (!native.ok) throw new Error(native.error.message);
    const reopened = parseNativeCadDocumentFromString(native.value);
    expect(reopened.ok).toBe(true);
    if (!reopened.ok) throw new Error(reopened.error.message);
    // The parse itself replayed the log and checked the persisted state;
    // assert the document equality here against the same canonical form.
    const parsed = JSON.parse(native.value) as { document: unknown };
    expect(JSON.stringify(parsed.document)).toBe(
      JSON.stringify(serializeCadDocument(reopened.value.document)),
    );
    // One compile is one committed transaction in the persisted log.
    expect(reopened.value.history.entries).toHaveLength(1);
    expect(reopened.value.history.cursor).toBe(1);
    expect(
      reopened.value.document.features.map((feature) => feature.kind),
    ).toEqual(["box"]);
  });

  it("satisfies the validation the server's save path applies", () => {
    const native = compileToNative(
      createElement(Box, { width: 1, depth: 2, height: 3 }),
    );
    expect(native.ok).toBe(true);
    if (!native.ok) throw new Error(native.error.message);
    // The documents router's requireNativeDocument runs exactly this
    // parse over every `nativeContent` payload before it is stored.
    expect(parseNativeCadDocumentFromString(native.value).ok).toBe(true);
  });

  it("returns the compile error structurally for an invalid tree", () => {
    const native = compileToNative(createElement("div", null, "no"));
    expect(native.ok).toBe(false);
    if (native.ok) throw new Error("expected a failure");
    expect(native.error.code).toBe("cadjsx/string-tag-rejected");
    expect("path" in native.error && native.error.path).toEqual(["<root>"]);
  });

  it("returns a structured fold error (with cause) when a command does not apply", () => {
    // The fillet's edge reference names a record the tree never minted —
    // compiles fine, fails the fold at feature.create's input check.
    const native = compileToNative(
      createElement(
        Fillet,
        { radius: 2, edges: ["ref_missing-edge"] },
        createElement(Box, { width: 10, depth: 10, height: 10 }),
      ),
    );
    expect(native.ok).toBe(false);
    if (native.ok) throw new Error("expected a failure");
    const error = native.error as NativeEmitError;
    expect(error.code).toBe(NATIVE_EMIT_ERROR_CODES.commandFailed);
    expect(error.index).toBeTypeOf("number");
    expect(error.cause?.code).toBe("transaction/command-failed");
    expect(error.message).toContain("does not apply");
  });

  it("rejects an invalid document id structurally instead of throwing", () => {
    const native = compileToNative(
      createElement(Box, { width: 1, depth: 1, height: 1 }),
      { documentId: "not-a-document-id" },
    );
    expect(native.ok).toBe(false);
    if (native.ok) throw new Error("expected a failure");
    expect(native.error.code).toBe(NATIVE_EMIT_ERROR_CODES.documentIdInvalid);
  });

  it("carries a custom document id and custom metadata into the file", () => {
    const native = compileToNative(
      createElement(Box, { width: 1, depth: 1, height: 1 }),
      { documentId: "doc_custom", metadata: { note: "emission test" } },
    );
    expect(native.ok).toBe(true);
    if (!native.ok) throw new Error(native.error.message);
    const reopened = parseNativeCadDocumentFromString(native.value);
    expect(reopened.ok).toBe(true);
    if (!reopened.ok) throw new Error(reopened.error.message);
    expect(reopened.value.document.id).toBe("doc_custom");
    expect(reopened.value.metadata).toEqual({ note: "emission test" });
  });

  it("rejects non-JSON-safe metadata with the format's own classification", () => {
    const options = {
      metadata: { bad: { nested: true } },
    } as unknown as Parameters<typeof compileToNative>[1];
    const native = compileToNative(
      createElement(Box, { width: 1, depth: 1, height: 1 }),
      options,
    );
    expect(native.ok).toBe(false);
    if (native.ok) throw new Error("expected a failure");
    const error = native.error as NativeEmitError;
    expect(error.code).toBe(NATIVE_EMIT_ERROR_CODES.metadataInvalid);
    expect(error.cause?.code).toBe("native-format/metadata-invalid");
  });
});
