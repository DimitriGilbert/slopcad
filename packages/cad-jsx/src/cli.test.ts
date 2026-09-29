/**
 * The compile CLI's logic suite (Phase 3): argument parsing, output-path
 * resolution, document-id derivation, and default-export rendering — the
 * decisions `scripts/compile.ts` shells. The repo has no precedent for
 * spawning package scripts inside unit tests, so the end-to-end
 * invocation is exercised for real against the docs example (see the
 * package README's CLI section) while this suite pins the pure logic.
 * Pure data: no DOM, no network, no database.
 */

import { createElement } from "react";
import { describe, expect, it } from "vitest";

import { Box } from "./elements";
import {
  CLI_MODEL_ERROR_CODES,
  compileCliHelp,
  deriveDocumentId,
  NATIVE_OUTPUT_EXTENSION,
  parseCompileArguments,
  resolveModelExport,
  resolveOutPath,
} from "./cli";
import { DEFAULT_NATIVE_DOCUMENT_ID } from "./native";

describe("parseCompileArguments", () => {
  it("parses one model path and an optional --out value", () => {
    expect(parseCompileArguments(["model.tsx"])).toEqual({
      kind: "parsed",
      arguments: { modelPath: "model.tsx", outPath: undefined },
    });
    expect(
      parseCompileArguments(["model.tsx", "--out", "build/model.json"]),
    ).toEqual({
      kind: "parsed",
      arguments: {
        modelPath: "model.tsx",
        outPath: "build/model.json",
      },
    });
  });

  it("answers --help and -h without touching the rest of the line", () => {
    expect(parseCompileArguments(["--help"])).toEqual({ kind: "help" });
    expect(parseCompileArguments(["-h", "--out", "x.json"])).toEqual({
      kind: "help",
    });
  });

  it("rejects every malformed line as a usage error with a message", () => {
    expect(parseCompileArguments([]).kind).toBe("usageError");
    expect(parseCompileArguments(["a.tsx", "b.tsx"]).kind).toBe("usageError");
    expect(parseCompileArguments(["--wat"]).kind).toBe("usageError");
    expect(parseCompileArguments(["model.tsx", "--out"]).kind).toBe(
      "usageError",
    );
    expect(parseCompileArguments(["model.tsx", "--out", "--help"]).kind).toBe(
      "usageError",
    );
    expect(
      parseCompileArguments(["m.tsx", "--out", "a", "--out", "b"]).kind,
    ).toBe("usageError");
  });

  it("exposes the full contract in the help text", () => {
    expect(compileCliHelp).toContain("pnpm --filter @slopcad/cad-jsx compile");
    expect(compileCliHelp).toContain(NATIVE_OUTPUT_EXTENSION);
    expect(compileCliHelp).toContain("Exit codes: 0 success");
  });
});

describe("resolveOutPath", () => {
  it("keeps paths that already carry an extension", () => {
    expect(resolveOutPath("build/model.json")).toBe("build/model.json");
    expect(resolveOutPath("build/model.native.json")).toBe(
      "build/model.native.json",
    );
    expect(resolveOutPath("build/.hidden")).toBe("build/.hidden");
  });

  it("gains the repo's native-fixture extension when extensionless", () => {
    expect(resolveOutPath("build/model")).toBe(
      `build/model${NATIVE_OUTPUT_EXTENSION}`,
    );
    expect(resolveOutPath("model")).toBe(`model${NATIVE_OUTPUT_EXTENSION}`);
  });
});

describe("deriveDocumentId", () => {
  it("derives a stable doc id from the file's basename", () => {
    expect(deriveDocumentId("hub-mount.tsx")).toBe("doc_hub-mount");
    expect(deriveDocumentId("models/hub-mount.tsx")).toBe("doc_hub-mount");
    expect(deriveDocumentId("/abs/path/plate.final.tsx")).toBe(
      "doc_plate.final",
    );
  });

  it("sanitizes unusable characters into the id payload charset", () => {
    expect(deriveDocumentId("My Model.tsx")).toBe("doc_My-Model");
    expect(deriveDocumentId("1 plate v2.tsx")).toBe("doc_1-plate-v2");
  });

  it("truncates long stems to the id payload limit", () => {
    const long = "x".repeat(100);
    const derived = deriveDocumentId(`${long}.tsx`);
    expect(derived.length).toBe("doc_".length + 64);
  });

  it("falls back to the default id when nothing usable remains", () => {
    expect(deriveDocumentId("__-.tsx")).toBe(DEFAULT_NATIVE_DOCUMENT_ID);
    expect(deriveDocumentId("...tsx")).toBe(DEFAULT_NATIVE_DOCUMENT_ID);
  });
});

describe("resolveModelExport", () => {
  it("passes a React element through", () => {
    const element = createElement(Box, { width: 1, depth: 2, height: 3 });
    const resolved = resolveModelExport(element);
    expect(resolved.ok).toBe(true);
    expect(resolved.ok && resolved.value).toBe(element);
  });

  it("invokes a component function once with no props", () => {
    const Model = () => createElement(Box, { width: 1, depth: 2, height: 3 });
    const resolved = resolveModelExport(Model);
    expect(resolved.ok).toBe(true);
    // The rendered root is the component's returned element (the Box tag).
    expect(resolved.ok ? resolved.value.type : undefined).toBe(Box);
  });

  it("rejects a throwing component structurally", () => {
    const Throwing = () => {
      throw new Error("boom");
    };
    const resolved = resolveModelExport(Throwing);
    expect(resolved.ok).toBe(false);
    if (resolved.ok) throw new Error("expected a failure");
    expect(resolved.error.code).toBe(CLI_MODEL_ERROR_CODES.componentThrew);
    expect(resolved.error.message).toContain("boom");
  });

  it("rejects a component that returns a non-element", () => {
    const Bad = () => "not a model";
    const resolved = resolveModelExport(Bad);
    expect(resolved.ok).toBe(false);
    if (resolved.ok) throw new Error("expected a failure");
    expect(resolved.error.code).toBe(
      CLI_MODEL_ERROR_CODES.componentReturnInvalid,
    );
  });

  it("rejects non-element, non-function exports", () => {
    const resolved = resolveModelExport(42);
    expect(resolved.ok).toBe(false);
    if (resolved.ok) throw new Error("expected a failure");
    expect(resolved.error.code).toBe(CLI_MODEL_ERROR_CODES.defaultInvalid);
  });
});
