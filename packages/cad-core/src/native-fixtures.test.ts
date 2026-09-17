/**
 * Phase 17 golden fixture tests: the committed fixture documents under
 * `packages/cad-core/fixtures/` are real native documents (a parametric
 * plate with a hole and an expression-driven parameter; a document whose
 * translate feature failed with diagnostics). These tests pin that a fixture
 * loads, validates structurally, and round-trips to byte-identical output —
 * the format-stability contract across code changes: any serializer change
 * that alters output breaks the byte-identity pin here, so regenerating a
 * fixture is always a deliberate act, never an accident.
 *
 * Fixture location decision (documented): the committed files live at
 * `packages/cad-core/fixtures/` — package-local, outside `src/` — so the
 * test discovery glob and the coverage instrumentation (both scoped to the
 * src tree) treat them as data, never as code.
 */

import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

import {
  canRedo,
  canUndo,
  createFeatureId,
  currentDocument,
  encodeNativeCadDocument,
  parseNativeCadDocumentFromBytes,
  parseNativeCadDocumentFromString,
  printExpression,
  redoHistory,
  serializeNativeCadDocument,
  stringifyNativeCadDocument,
  undoHistory,
  validateNativeCadDocument,
  type CadDocument,
  type NativeCadDocument,
} from "./index";

const FIXTURES = new URL("../fixtures/", import.meta.url);

function requireOk<T>(
  result:
    | { readonly ok: true; readonly value: T }
    | { readonly ok: false; readonly error: { readonly message: string } },
  what: string,
): T {
  if (!result.ok) {
    throw new Error(`The fixture test rejected ${what}: ${result.error.message}`);
  }
  return result.value;
}

async function readFixture(name: string): Promise<string> {
  return readFile(new URL(name, FIXTURES), "utf8");
}

function parameterValue(document: CadDocument, name: string): number {
  const parameter = document.parameters.parameters.find(
    (entry) => entry.name === name,
  );
  if (parameter === undefined) {
    throw new Error(`The fixture lost the "${name}" parameter.`);
  }
  return parameter.value.value;
}

for (const name of [
  "plate-with-hole.native.json",
  "failed-feature.native.json",
  "rolled-back.native.json",
]) {
  describe(`the ${name} golden fixture`, () => {
    it("loads and validates structurally", async () => {
      const text = await readFixture(name);
      const parsed = requireOk(
        parseNativeCadDocumentFromString(text),
        `parsing ${name}`,
      );
      expect(parsed.document.id).toMatch(/^doc_/);
      const validation = validateNativeCadDocument(JSON.parse(text));
      expect(validation.valid).toBe(true);
      expect(validation.issues).toEqual([]);
      expect(validation.formatVersion).toBe(1);
    });

    it("round-trips to byte-identical output", async () => {
      const text = await readFixture(name);
      const parsed = requireOk(
        parseNativeCadDocumentFromString(text),
        `parsing ${name}`,
      );
      expect(stringifyNativeCadDocument(serializeNativeCadDocument(parsed))).toBe(text);
      const fromBytes = requireOk(
        parseNativeCadDocumentFromBytes(encodeNativeCadDocument(parsed)),
        `the byte round trip of ${name}`,
      );
      expect(stringifyNativeCadDocument(serializeNativeCadDocument(fromBytes))).toBe(text);
    });
  });
}

describe("the plate-with-hole fixture", () => {
  const load = async (): Promise<NativeCadDocument> =>
    requireOk(
      parseNativeCadDocumentFromString(await readFixture("plate-with-hole.native.json")),
      "parsing the plate fixture",
    );

  it("persists the parametric intent: parameters, expression, features, log", async () => {
    const native = await load();
    const document = native.document;
    expect(document.parameters.parameters.map((entry) => entry.name)).toEqual([
      "width",
      "length",
      "thickness",
      "holeDiameter",
      "volumeHint",
    ]);
    // The head state carries the edits the log applied.
    expect(parameterValue(document, "thickness")).toBe(12);
    expect(parameterValue(document, "holeDiameter")).toBe(18);
    // The expression-driven parameter survives with its AST.
    const volumeHint = document.parameters.parameters.find(
      (entry) => entry.name === "volumeHint",
    );
    if (volumeHint?.expression === undefined || volumeHint.expression === null) {
      throw new Error("The plate fixture lost the volumeHint expression.");
    }
    expect(printExpression(volumeHint.expression)).toBe(
      "width * length * thickness / 1000",
    );
    expect(volumeHint.value.dimension).toBe("volume");
    expect(document.features.map((feature) => feature.kind)).toEqual([
      "box",
      "subtract",
    ]);
    // The hole feature declares its parametric upstream.
    expect(document.features[1]?.inputs).toEqual([
      { kind: "feature", id: "feat_plate" },
      { kind: "parameter", id: "param_hole_diameter" },
    ]);
    expect(native.metadata).toEqual({
      name: "plate-with-hole",
      unitSystem: "metric",
    });
    expect(native.history.entries).toHaveLength(4);
    expect(native.history.cursor).toBe(4);
    for (const entry of native.regeneration.values()) {
      expect(entry.state).toBe("valid");
    }
  });

  it("restores working undo and redo over the replayed log", async () => {
    const native = await load();
    expect(canUndo(native.history)).toBe(true);
    expect(canRedo(native.history)).toBe(false);

    // Undo the holeDiameter edit, then the thickness edit.
    const undoneOnce = requireOk(undoHistory(native.history), "the first undo");
    expect(parameterValue(undoneOnce.document, "holeDiameter")).toBe(15);
    const undoneTwice = requireOk(
      undoHistory(undoneOnce.history),
      "the second undo",
    );
    expect(parameterValue(undoneTwice.document, "thickness")).toBe(10);

    // Undo past the feature creations lands on the base document.
    const undoneThrice = requireOk(
      undoHistory(undoneTwice.history),
      "the third undo",
    );
    const atBase = requireOk(undoHistory(undoneThrice.history), "the undo to the base");
    expect(atBase.document.features).toHaveLength(0);
    expect(canUndo(atBase.history)).toBe(false);

    // Redo the whole log: the head state returns exactly.
    let redone = atBase.history;
    for (let index = 0; index < 4; index += 1) {
      redone = requireOk(redoHistory(redone), `redo ${String(index)}`).history;
    }
    expect(canRedo(redone)).toBe(false);
    const head = currentDocument(redone);
    expect(parameterValue(head, "thickness")).toBe(12);
    expect(parameterValue(head, "holeDiameter")).toBe(18);
  });
});

describe("the failed-feature fixture", () => {
  it("persists the failed regeneration state with its diagnostics", async () => {
    const native = requireOk(
      parseNativeCadDocumentFromString(
        await readFixture("failed-feature.native.json"),
      ),
      "parsing the failed-feature fixture",
    );
    expect(native.document.features.map((feature) => feature.kind)).toEqual([
      "sphere",
      "translate",
    ]);
    const sphere = native.regeneration.get(createFeatureId("feat_sphere"));
    expect(sphere?.state).toBe("valid");
    const translate = native.regeneration.get(createFeatureId("feat_translate"));
    expect(translate?.state).toBe("failed");
    const diagnostic = translate?.diagnostics[0];
    expect(diagnostic?.severity).toBe("error");
    expect(diagnostic?.code).toBe("kernel/operation-failed");
    expect(diagnostic?.location).toEqual({
      primary: "feat_translate",
      related: ["body_moved"],
    });
    expect(diagnostic?.data).toEqual({ axis: "z", limitExceeded: true });
    expect(native.history.entries).toHaveLength(2);
    expect(native.history.cursor).toBe(2);
  });
});

describe("the rolled-back fixture", () => {
  const load = async (): Promise<NativeCadDocument> =>
    requireOk(
      parseNativeCadDocumentFromString(
        await readFixture("rolled-back.native.json"),
      ),
      "parsing the rolled-back fixture",
    );

  it("persists the rollback marker as an optional envelope field", async () => {
    const text = await readFixture("rolled-back.native.json");
    const parsed = JSON.parse(text) as Record<string, unknown>;
    // The field is present, last in key order, and carries the marker shape.
    expect(Object.keys(parsed)).toEqual([
      "formatVersion",
      "metadata",
      "document",
      "history",
      "regeneration",
      "rollback",
    ]);
    expect(parsed.rollback).toEqual({ afterFeatureId: "feat_box" });
    const native = await load();
    expect(native.rollback).toEqual({ afterFeatureId: "feat_box" });
  });

  it("keeps the parked feature's persisted state in the four-state vocabulary", async () => {
    const native = await load();
    expect(native.regeneration.get(createFeatureId("feat_box"))?.state).toBe(
      "valid",
    );
    // Beyond the marker, the durable state is plain stale — parking is
    // positional and derived from the marker, never a stored state.
    expect(native.regeneration.get(createFeatureId("feat_hole"))?.state).toBe(
      "stale",
    );
  });

  it("restores the marker on a fresh parse with byte-identical round trip", async () => {
    const native = await load();
    const again = requireOk(
      parseNativeCadDocumentFromBytes(encodeNativeCadDocument(native)),
      "the byte round trip",
    );
    expect(again.rollback).toEqual(native.rollback);
    expect(stringifyNativeCadDocument(serializeNativeCadDocument(again))).toBe(
      await readFixture("rolled-back.native.json"),
    );
  });
});
