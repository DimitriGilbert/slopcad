/**
 * The canonical TSX loader's tests (Phase 4): the sandbox's authoring
 * surface (imported and global elements both work), the structured
 * refusals (oversized source, broken TSX, forbidden imports, evaluation
 * failures under the vm budget, invalid default exports, compile-error
 * pass-through), and the happy path's native text passing the format's
 * own parser.
 */

import { describe, expect, it } from "vitest";
import { parseNativeCadDocumentFromString } from "@slopcad/cad-core";
import type { TsxCompileFailure } from "./loader";
import { createElement } from "react";

import { compileToNative } from "./native";
import {
  TSX_EVAL_TIMEOUT_MS,
  TSX_LOAD_ERROR_CODES,
  TSX_SOURCE_MAX_BYTES,
  compileTsxSource,
} from "./loader";
import { Box, Cylinder, Union } from "./index";

const IMPORTED_MODEL = `
import { Box, Cylinder, Union } from "@slopcad/cad-jsx";

export default (
  <Union>
    <Box width={30} depth={20} height={10} />
    <Cylinder radius={4} height={10} />
  </Union>
);
`;

const COMPONENT_MODEL = `
import { Box } from "@slopcad/cad-jsx";

export function Plate() {
  return <Box id="feat_plate" width={20} depth={10} height={4} />;
}

export default Plate;
`;

/** The model the imported and component forms above compile to. */
function referenceModel() {
  return createElement(
    Union,
    null,
    createElement(Box, { width: 30, depth: 20, height: 10 }),
    createElement(Cylinder, { radius: 4, height: 10 }),
  );
}

/** Runs one source and asserts it fails with the given code. */
async function expectFailure(
  source: string,
  code: string,
): Promise<TsxCompileFailure> {
  const result = await compileTsxSource({ source });
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("expected a failure");
  expect(result.error.code).toBe(code);
  return result.error;
}

describe("compileTsxSource happy paths", () => {
  it("compiles an imported model to the same native text as compileToNative", async () => {
    const loaded = await compileTsxSource({ source: IMPORTED_MODEL });
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) throw new Error(loaded.error.message);
    const reference = compileToNative(referenceModel());
    if (!reference.ok) throw new Error(reference.error.message);
    expect(loaded.value).toBe(reference.value);
    expect(() => parseNativeCadDocumentFromString(loaded.value)).not.toThrow();
  });

  it("renders a component default export with no props", async () => {
    const loaded = await compileTsxSource({ source: COMPONENT_MODEL });
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) throw new Error(loaded.error.message);
    const reopened = parseNativeCadDocumentFromString(loaded.value);
    if (!reopened.ok) throw new Error(reopened.error.message);
    expect(
      reopened.value.document.features.map((feature) => feature.id),
    ).toEqual(["feat_plate"]);
  });

  it("compiles an import-free model through the sandbox globals", async () => {
    const result = await compileTsxSource({
      source: "export default <Box width={10} depth={10} height={10} />;",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.message);
    expect(parseNativeCadDocumentFromString(result.value).ok).toBe(true);
  });
});

describe("compileTsxSource structured refusals", () => {
  it("refuses an oversized source before transpiling", async () => {
    const failure = await expectFailure(
      `export default null; // ${"x".repeat(TSX_SOURCE_MAX_BYTES)}`,
      TSX_LOAD_ERROR_CODES.sourceTooLarge,
    );
    expect(failure.message).toContain(String(TSX_SOURCE_MAX_BYTES));
  });

  it("refuses source that does not transpile", async () => {
    await expectFailure(
      "export default <Box width={}",
      TSX_LOAD_ERROR_CODES.transformFailed,
    );
  });

  it("refuses a model importing node:fs", async () => {
    const failure = await expectFailure(
      'import fs from "node:fs";\nexport default <Box width={typeof fs === "undefined" ? 1 : 1} depth={1} height={1} />;',
      TSX_LOAD_ERROR_CODES.forbiddenImport,
    );
    expect(failure.message).toContain("node:fs");
  });

  it("refuses a model importing bare fs", async () => {
    await expectFailure(
      'import fs from "fs";\nexport default <Box width={typeof fs === "undefined" ? 1 : 1} depth={1} height={1} />;',
      TSX_LOAD_ERROR_CODES.forbiddenImport,
    );
  });

  it("refuses a model importing an unrelated package", async () => {
    await expectFailure(
      'import { z } from "zod";\nexport default <Box width={typeof z === "undefined" ? 1 : 1} depth={1} height={1} />;',
      TSX_LOAD_ERROR_CODES.forbiddenImport,
    );
  });

  it("terminates an endlessly looping model under the vm budget", async () => {
    const failure = await expectFailure(
      "for (;;) {}",
      TSX_LOAD_ERROR_CODES.evaluationFailed,
    );
    expect(failure.message).toContain(
      `${String(TSX_EVAL_TIMEOUT_MS)} ms evaluation budget`,
    );
  }, 10_000);

  it("surfaces a model that throws while evaluating", async () => {
    await expectFailure(
      'throw new Error("boom");',
      TSX_LOAD_ERROR_CODES.evaluationFailed,
    );
  });

  it("refuses a non-element default export", async () => {
    await expectFailure(
      "export default 42;",
      "cadjsx-cli/model-default-invalid",
    );
  });

  it("passes the compiler's structured rejections through verbatim", async () => {
    const failure = await expectFailure(
      'export default <div id="not-a-model" />;',
      "cadjsx/string-tag-rejected",
    );
    expect("path" in failure).toBe(true);
  });
});
