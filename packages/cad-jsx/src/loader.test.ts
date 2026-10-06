/**
 * The canonical TSX loader's tests (Phase 4): the sandbox's authoring
 * surface (imported and global elements both work; every element kind
 * re-exported from the package index the sandbox resolves), the
 * structured refusals (oversized source, broken TSX, forbidden imports,
 * evaluation failures under the vm budget, invalid default exports,
 * compile-error pass-through), the happy path's native text passing
 * the format's own parser, and the sandbox-escape regression suite
 * (verified report 8, finding 1): no host-realm value is reachable from
 * the model's globalThis by property traversal.
 */

import { describe, expect, it } from "vitest";
import { parseNativeCadDocumentFromString } from "@slopcad/cad-core";
import type { CadElementKind } from "./elements";
import type * as CadJsxSurface from "./index";
import type { TsxCompileFailure } from "./loader";
import { createElement } from "react";

import { resolveModelExport } from "./cli";
import { compileToNative } from "./native";
import {
  TSX_EVAL_TIMEOUT_MS,
  TSX_LOAD_ERROR_CODES,
  TSX_SOURCE_MAX_BYTES,
  compileTsxSource,
} from "./loader";
import { Box, Cylinder, Union } from "./index";
import { CAD_ELEMENT_KINDS, isCadElementTag } from "./elements";

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

/**
 * Builds one escape-probe model: `payload` is an expression the model
 * evaluates under a guard, and if it yields something process-like (the
 * escape witness — a host `process` with `getBuiltinModule`), the model
 * THROWS. A probe model that compiles cleanly therefore PROVES the payload
 * reached nothing host-realm.
 */
function processProbeModel(payload: string): string {
  return `const escaped = (function () {
  try {
    const process = ${payload};
    return (
      process !== undefined &&
      process !== null &&
      typeof process.getBuiltinModule === "function" &&
      typeof process.version === "string"
    );
  } catch {
    return false;
  }
})();
if (escaped) throw new Error("ESCAPED: host process obtained");
export default <Box width={10} depth={10} height={10} />;
`;
}

/** Runs one probe model and asserts it compiled — the payload found nothing host-realm. */
async function expectProbeClean(payload: string): Promise<void> {
  const result = await compileTsxSource({ source: processProbeModel(payload) });
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.error.message);
  expect(parseNativeCadDocumentFromString(result.value).ok).toBe(true);
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

  it("reports a throwing default-export component with the CLI's byte-identical message", async () => {
    const failure = await expectFailure(
      'export default function () {\n  throw new Error("boom");\n}',
      "cadjsx-cli/model-component-threw",
    );
    // The vm bridge derives the thrown reason the same way the CLI's
    // host-side render does (`error.message` for Errors), so both entry
    // points emit the same message for the same authoring mistake.
    const hostResolved = resolveModelExport(function () {
      throw new Error("boom");
    });
    expect(hostResolved.ok).toBe(false);
    if (hostResolved.ok) throw new Error("expected a failure");
    expect(failure.message).toBe(hostResolved.error.message);
    expect(failure.message).toContain("boom");
  });

  it("passes the compiler's structured rejections through verbatim", async () => {
    const failure = await expectFailure(
      'export default <div id="not-a-model" />;',
      "cadjsx/string-tag-rejected",
    );
    expect("path" in failure).toBe(true);
  });
});

describe("compileTsxSource sandbox escape regression (verified report 8, finding 1)", () => {
  it("keeps require.constructor from constructing the host Function", async () => {
    await expectProbeClean(`require.constructor("return process")()`);
  });

  it("keeps createElement.constructor from constructing the host Function", async () => {
    await expectProbeClean(`createElement.constructor("return process")()`);
  });

  it("keeps the host process global unreachable", async () => {
    await expectProbeClean(
      `typeof process === "undefined" ? undefined : process`,
    );
  });

  it("keeps every sandbox surface's constructor chain from reaching the host process", async () => {
    await expectProbeClean(`(function () {
      const element = <Box width={1} depth={1} height={1} />;
      const candidates = [
        Box,
        Union,
        length,
        angle,
        dimensionless,
        defineCadElement,
        isCadElementTag,
        CAD_ELEMENT_KINDS,
        module,
        exports,
        require,
        createElement,
        Fragment,
        require("react"),
        require("@slopcad/cad-jsx"),
        element,
        element.type,
        element.props,
      ];
      for (const candidate of candidates) {
        if (candidate === undefined || candidate === null) continue;
        const constructor = candidate.constructor;
        if (typeof constructor !== "function") continue;
        const recovered = constructor("return process")();
        if (
          recovered !== undefined &&
          recovered !== null &&
          typeof recovered.getBuiltinModule === "function"
        ) {
          return recovered;
        }
      }
      return undefined;
    })()`);
  });

  it("proves the probe harness detects a real escape (the probes are not vacuous)", async () => {
    const failure = await expectFailure(
      processProbeModel(
        `({ getBuiltinModule: function () { return {}; }, version: "probe" })`,
      ),
      TSX_LOAD_ERROR_CODES.evaluationFailed,
    );
    expect(failure.message).toContain("ESCAPED");
  });

  it("still refuses require(\"node:fs\") from model code at runtime", async () => {
    const failure = await expectFailure(
      'const fs = require("node:fs");\nexport default <Box width={1} depth={1} height={1} />;',
      TSX_LOAD_ERROR_CODES.forbiddenImport,
    );
    expect(failure.message).toContain("node:fs");
  });

  it("keeps a caught forbidden-import refusal from leaking the host gate error", async () => {
    const result = await compileTsxSource({
      source: `let escaped = false;
try {
  require("node:fs");
} catch (refusal) {
  try {
    const process = refusal.constructor.constructor("return process")();
    escaped =
      process !== undefined &&
      process !== null &&
      typeof process.getBuiltinModule === "function";
  } catch {
    escaped = false;
  }
}
if (escaped) throw new Error("ESCAPED: refusal error reached the host realm");
export default <Box width={10} depth={10} height={10} />;
`,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.message);
  });

  it("bounds a runaway default-export component with the vm budget", async () => {
    const failure = await expectFailure(
      "export default function Loop() {\n  for (;;) {}\n}",
      TSX_LOAD_ERROR_CODES.evaluationFailed,
    );
    expect(failure.message).toContain(
      `${String(TSX_EVAL_TIMEOUT_MS)} ms evaluation budget`,
    );
  }, 10_000);
});

/**
 * Every element kind mapped to the package index export that must carry
 * its tag — the surface the sandbox's `require("@slopcad/cad-jsx")`
 * resolves, so a model's ONLY import reaches every kind. Exhaustive
 * twice over at the type level: a kind added to `CAD_ELEMENT_KINDS`
 * without a row here fails check-types (a missing mapped key), and a
 * row naming an export the index does not carry fails check-types
 * (`keyof typeof CadJsxSurface`). The test below then fails at runtime
 * if the mapped export is missing or is not a tag carrying that exact
 * kind — the `<Thicken>` gap cannot recur quietly.
 */
const KIND_TAG_EXPORTS: {
  readonly [K in CadElementKind]: keyof typeof CadJsxSurface;
} = {
  parameter: "Parameter",
  body: "Body",
  box: "Box",
  sphere: "Sphere",
  cylinder: "Cylinder",
  cone: "Cone",
  translate: "Translate",
  union: "Union",
  subtract: "Subtract",
  intersect: "Intersect",
  use: "Use",
  extrude: "Extrude",
  revolve: "Revolve",
  sweep: "Sweep",
  sweepWire: "SweepWire",
  loft: "Loft",
  fillet: "Fillet",
  chamfer: "Chamfer",
  shell: "Shell",
  thicken: "Thicken",
  split: "Split",
  hole: "Hole",
  rib: "Rib",
  thread: "Thread",
  helix: "Helix",
  scale: "Scale",
  moveFace: "MoveFace",
  replaceFace: "ReplaceFace",
  deleteFace: "DeleteFace",
  patternLinear: "PatternLinear",
  patternCircular: "PatternCircular",
  patternPath: "PatternPath",
  mirror: "Mirror",
  sketch: "Sketch",
  point: "Point",
  line: "Line",
  rectangle: "Rectangle",
  circle: "Circle",
  arc: "Arc",
  ellipse: "Ellipse",
  slot: "Slot",
  polygon: "Polygon",
  spline: "Spline",
};

describe("the package index surface (what the sandbox's require resolves)", () => {
  it("re-exports a matching CAD element tag for every kind in CAD_ELEMENT_KINDS", async () => {
    const surface: Record<string, unknown> = await import("./index");
    for (const kind of CAD_ELEMENT_KINDS) {
      const exportName = KIND_TAG_EXPORTS[kind];
      const tag = surface[exportName];
      if (!isCadElementTag(tag)) {
        throw new Error(
          `The "${kind}" kind's tag is not exported from the package index as "${exportName}".`,
        );
      }
      expect(tag.kind).toBe(kind);
    }
  });
});
