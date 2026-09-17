/**
 * Phase 17 tests: the canonical native document format — determinism,
 * round-trips (including history replay equivalence: load → undo/redo
 * works), unknown-field tolerance, version gating, the structural validator's
 * malformed matrix (one code per failure class), the no-derived-geometry and
 * no-synthetic-references rules, and the dual-persistence integrity check.
 */

import { describe, expect, it } from "vitest";

import {
  addBody,
  addDocumentParameter,
  applySessionTransaction,
  canRedo,
  canUndo,
  createBodyId,
  createDocument,
  createDocumentId,
  createFeatureId,
  createNativeCadDocument,
  createParameterId,
  createSession,
  CAD_NATIVE_FORMAT_VERSION,
  encodeNativeCadDocument,
  initialRegenerationStates,
  length,
  NATIVE_FORMAT_ERROR_CODES,
  NATIVE_FORMAT_ISSUE_CODES,
  parseDiagnostic,
  parseNativeCadDocument,
  parseNativeCadDocumentFromBytes,
  parseNativeCadDocumentFromString,
  redoHistory,
  regenerate,
  serializeCadDocument,
  serializeNativeCadDocument,
  serializeRegenerationStates,
  stringifyNativeCadDocument,
  undoHistory,
  undoSession,
  validateNativeCadDocument,
  type CadDocument,
  type NativeCadDocument,
} from "./index";

// ---------------------------------------------------------------------------
// Builder: a compact plate-with-hole, saved mid-history (a redo branch
// exists), with one feature id generated at apply time.
// ---------------------------------------------------------------------------

const WIDTH = createParameterId("param_width");
const THICKNESS = createParameterId("param_thickness");
const PLATE_BODY = createBodyId("body_plate");
const HOLE_BODY = createBodyId("body_hole");
const PLATE_FEATURE = createFeatureId("feat_plate");
const DOC_ID = createDocumentId("doc_native_test");

function requireOk<T>(
  result:
    | { readonly ok: true; readonly value: T }
    | { readonly ok: false; readonly error: { readonly message: string } },
  what: string,
): T {
  if (!result.ok) {
    throw new Error(`The native format test builder rejected ${what}: ${result.error.message}`);
  }
  return result.value;
}

function baseDocument(): CadDocument {
  let document = createDocument(DOC_ID);
  for (const [id, name] of [
    [WIDTH, "width"],
    [THICKNESS, "thickness"],
  ] as const) {
    document = requireOk(
      addDocumentParameter(document, { id, name, value: length(10) }),
      `the ${name} parameter`,
    ).document;
  }
  for (const [id, name] of [
    [PLATE_BODY, "plate"],
    [HOLE_BODY, "bore"],
  ] as const) {
    document = requireOk(addBody(document, { id, name }), `the ${name} body`)
      .document;
  }
  return document;
}

function buildNative(): NativeCadDocument {
  let session = createSession(baseDocument());
  session = requireOk(
    applySessionTransaction(session, {
      commands: [
        {
          type: "feature.create",
          id: PLATE_FEATURE,
          kind: "box",
          inputs: [{ kind: "parameter", id: WIDTH }],
          outputs: [PLATE_BODY],
        },
      ],
    }),
    "the plate feature commit",
  );
  // No explicit id: the document's generator emits one deterministically, so
  // the serialized command replays onto the very id it produced.
  session = requireOk(
    applySessionTransaction(session, {
      commands: [
        {
          type: "feature.create",
          kind: "subtract",
          inputs: [
            { kind: "feature", id: PLATE_FEATURE },
            { kind: "parameter", id: THICKNESS },
          ],
          outputs: [HOLE_BODY],
        },
      ],
    }),
    "the hole feature commit",
  );
  session = requireOk(
    applySessionTransaction(session, {
      commands: [{ type: "parameter.set", id: THICKNESS, value: length(12) }],
    }),
    "the thickness edit",
  );
  // Undo the edit: cursor 2 of 3 entries, the redo branch survives the file
  // boundary.
  session = requireOk(undoSession(session), "the undo");
  const run = requireOk(
    regenerate({
      features: session.document.features,
      states: initialRegenerationStates(session.document.features),
      suppressed: [],
      execute: () => ({ ok: true }),
    }),
    "the regeneration run",
  );
  return {
    document: session.document,
    history: session.history,
    regeneration: run.states,
    metadata: { zeta: "last", alpha: "first" },
    rollback: null,
  };
}

function nativeText(native: NativeCadDocument = buildNative()): string {
  return stringifyNativeCadDocument(serializeNativeCadDocument(native));
}

/** A revived-JSON deep copy of the canonical serialized form. */
function revived(native: NativeCadDocument = buildNative()): Record<string, unknown> {
  return JSON.parse(nativeText(native)) as Record<string, unknown>;
}

function thicknessOf(document: CadDocument): number {
  const parameter = document.parameters.parameters.find(
    (entry) => entry.id === THICKNESS,
  );
  if (parameter === undefined) {
    throw new Error("The test lost the thickness parameter.");
  }
  return parameter.value.value;
}

// ---------------------------------------------------------------------------
// Deterministic serialization
// ---------------------------------------------------------------------------

describe("native document serialization is deterministic", () => {
  it("serializes the same document to identical bytes across builds", () => {
    expect(nativeText(buildNative())).toBe(nativeText(buildNative()));
    const first = encodeNativeCadDocument(buildNative());
    const second = encodeNativeCadDocument(buildNative());
    expect(Array.from(first)).toEqual(Array.from(second));
  });

  it("emits the top-level keys in the fixed canonical order", () => {
    expect(Object.keys(serializeNativeCadDocument(buildNative()))).toEqual([
      "formatVersion",
      "metadata",
      "document",
      "history",
      "regeneration",
    ]);
  });

  it("canonicalizes metadata keys to sorted order", () => {
    const serialized = serializeNativeCadDocument(buildNative());
    expect(Object.keys(serialized.metadata)).toEqual(["alpha", "zeta"]);
    const unsorted = { zulu: 1, bravo: true, alpha: null };
    const native = requireOk(
      createNativeCadDocument(baseDocument(), unsorted),
      "the unsorted metadata",
    );
    expect(
      Object.keys(serializeNativeCadDocument(native).metadata),
    ).toEqual(["alpha", "bravo", "zulu"]);
  });

  it("keeps body records as pure id-and-name data", () => {
    const serialized = serializeNativeCadDocument(buildNative());
    for (const body of serialized.document.bodies) {
      expect(Object.keys(body)).toEqual(["id", "name"]);
    }
  });
});

// ---------------------------------------------------------------------------
// Round trips
// ---------------------------------------------------------------------------

describe("native documents round-trip exactly", () => {
  it("re-serializes a parsed document to byte-identical output", () => {
    const text = nativeText();
    const parsed = requireOk(parseNativeCadDocumentFromString(text), "the parse");
    expect(stringifyNativeCadDocument(serializeNativeCadDocument(parsed))).toBe(text);
  });

  it("preserves domain equality, not just bytes", () => {
    const native = buildNative();
    const parsed = requireOk(
      parseNativeCadDocumentFromString(nativeText(native)),
      "the parse",
    );
    expect(JSON.stringify(serializeCadDocument(parsed.document))).toBe(
      JSON.stringify(serializeCadDocument(native.document)),
    );
    expect(parsed.history.entries).toHaveLength(native.history.entries.length);
    expect(parsed.history.cursor).toBe(native.history.cursor);
    expect(parsed.history.base.id).toBe(native.history.base.id);
    expect(JSON.stringify(serializeRegenerationStates(parsed.regeneration))).toBe(
      JSON.stringify(serializeRegenerationStates(native.regeneration)),
    );
    expect(parsed.metadata).toEqual(native.metadata);
    expect(parsed.regeneration.get(PLATE_FEATURE)?.state).toBe("valid");
  });

  it("replays id-generating commands onto the ids they produced", () => {
    const native = buildNative();
    const authoredId = native.document.features
      .map((feature) => feature.id)
      .find((id) => id !== PLATE_FEATURE);
    if (authoredId === undefined) {
      throw new Error("The builder lost the generated hole feature id.");
    }
    const parsed = requireOk(
      parseNativeCadDocumentFromString(nativeText(native)),
      "the parse",
    );
    expect(parsed.document.features.map((feature) => feature.id)).toContain(authoredId);
  });

  it("restores undo and redo exactly (history replay equivalence)", () => {
    const native = buildNative();
    expect(native.history.cursor).toBe(2);
    const parsed = requireOk(
      parseNativeCadDocumentFromString(nativeText(native)),
      "the parse",
    );
    expect(canUndo(parsed.history)).toBe(true);
    expect(canRedo(parsed.history)).toBe(true);

    const redone = requireOk(redoHistory(parsed.history), "the redo");
    expect(thicknessOf(redone.document)).toBe(12);
    // Redo restores the very snapshot the entry recorded, not a copy.
    expect(redone.document).toBe(parsed.history.entries[2]?.document);

    const undoneOnce = requireOk(undoHistory(parsed.history), "the undo");
    expect(thicknessOf(undoneOnce.document)).toBe(10);
    const undoneToBase = requireOk(undoHistory(undoneOnce.history), "the second undo");
    expect(undoneToBase.document.features).toHaveLength(0);
    expect(canUndo(undoneToBase.history)).toBe(false);
    const refused = undoHistory(undoneToBase.history);
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.error.code).toBe("history/nothing-to-undo");
    }
  });

  it("round-trips an empty native document", () => {
    const native = requireOk(
      createNativeCadDocument(createDocument(DOC_ID)),
      "the empty document",
    );
    const text = nativeText(native);
    const parsed = requireOk(parseNativeCadDocumentFromString(text), "the parse");
    expect(stringifyNativeCadDocument(serializeNativeCadDocument(parsed))).toBe(text);
    expect(parsed.history.entries).toHaveLength(0);
    expect(parsed.history.cursor).toBe(0);
    expect(parsed.metadata).toEqual({});
  });

  it("ignores unknown fields at every level (forward tolerance)", () => {
    const text = nativeText();
    const input = JSON.parse(text) as Record<string, unknown>;
    const document = input.document as Record<string, unknown>;
    const parameters = document.parameters as Record<string, unknown>;
    const parameterEntries = parameters.parameters as Record<string, unknown>[];
    const features = document.features as Record<string, unknown>[];
    const history = input.history as Record<string, unknown>;
    const transactions = history.transactions as Record<string, unknown>[];
    const regeneration = input.regeneration as Record<string, unknown>;
    const regenerationFeatures = regeneration.features as Record<string, unknown>[];
    const firstOf = (
      entries: readonly Record<string, unknown>[],
      what: string,
    ): Record<string, unknown> => {
      const entry = entries[0];
      if (entry === undefined) {
        throw new Error(`The test lost the first of the ${what}.`);
      }
      return entry;
    };
    input.unknownTopLevel = { any: "shape" };
    document.unknownSection = 1;
    firstOf(parameterEntries, "parameters").unknownField = "x";
    firstOf(features, "features").unknownField = "x";
    history.unknownField = "x";
    firstOf(transactions, "transactions").unknownField = "x";
    regeneration.unknownField = "x";
    firstOf(regenerationFeatures, "regeneration entries").unknownField = "x";
    const parsed = requireOk(parseNativeCadDocument(input), "the parse");
    // Dropped on re-serialization: the canonical form is unchanged bytes.
    expect(stringifyNativeCadDocument(serializeNativeCadDocument(parsed))).toBe(text);
  });

  it("round-trips through the byte form and rejects invalid bytes and JSON", () => {
    const bytes = encodeNativeCadDocument(buildNative());
    const parsed = requireOk(parseNativeCadDocumentFromBytes(bytes), "the byte parse");
    expect(stringifyNativeCadDocument(serializeNativeCadDocument(parsed))).toBe(
      nativeText(),
    );
    const invalidUtf8 = new Uint8Array([0x7b, 0x22, 0xff, 0xfe, 0x7d]);
    expect(parseNativeCadDocumentFromBytes(invalidUtf8)).toMatchObject({
      ok: false,
      error: { code: NATIVE_FORMAT_ERROR_CODES.malformed },
    });
    expect(parseNativeCadDocumentFromString("{")).toMatchObject({
      ok: false,
      error: { code: NATIVE_FORMAT_ERROR_CODES.malformed },
    });
  });
});

// ---------------------------------------------------------------------------
// Version gating
// ---------------------------------------------------------------------------

describe("native document parsing is version-gated", () => {
  it("rejects a future version predictably", () => {
    const input = revived();
    input.formatVersion = 2;
    const result = parseNativeCadDocument(input);
    expect(result).toMatchObject({
      ok: false,
      error: { code: "native-migration/version-unsupported" },
    });
    if (!result.ok) {
      expect(result.error.message).toContain("2");
    }
  });

  it("rejects an older version with a structured migration gap", () => {
    const input = revived();
    input.formatVersion = 0;
    expect(parseNativeCadDocument(input)).toMatchObject({
      ok: false,
      error: { code: "native-migration/no-path" },
    });
  });

  it("rejects a missing or malformed version stamp", () => {
    for (const formatVersion of ["1", 1.5, -1, null]) {
      const input = revived();
      input.formatVersion = formatVersion;
      expect(parseNativeCadDocument(input)).toMatchObject({
        ok: false,
        error: { code: NATIVE_FORMAT_ERROR_CODES.versionInvalid },
      });
    }
    const missing = revived();
    delete missing.formatVersion;
    expect(parseNativeCadDocument(missing)).toMatchObject({
      ok: false,
      error: { code: NATIVE_FORMAT_ERROR_CODES.versionInvalid },
    });
  });

  it("rejects JSON that is not an object", () => {
    expect(parseNativeCadDocumentFromString('"a string"')).toMatchObject({
      ok: false,
      error: { code: NATIVE_FORMAT_ERROR_CODES.malformed },
    });
  });
});

// ---------------------------------------------------------------------------
// History integrity (the dual-persistence check)
// ---------------------------------------------------------------------------

describe("the persisted state and the replayed log must agree", () => {
  it("fails structured when the document section is tampered", () => {
    const input = revived();
    const document = input.document as Record<string, unknown>;
    const parameters = document.parameters as Record<string, unknown>;
    const entries = parameters.parameters as Record<string, unknown>[];
    const width = entries[0] as Record<string, unknown>;
    const value = width.value as Record<string, unknown>;
    value.value = 99;
    expect(parseNativeCadDocument(input)).toMatchObject({
      ok: false,
      error: { code: NATIVE_FORMAT_ERROR_CODES.historyMismatch },
    });
  });

  it("fails structured when a committed transaction is tampered into divergence", () => {
    // Transaction 0 is inside the cursor, so tampering it replays to a
    // different state at the cursor than the persisted document section.
    const input = revived();
    const history = input.history as Record<string, unknown>;
    const transactions = history.transactions as Record<string, unknown>[];
    const first = transactions[0] as Record<string, unknown>;
    const commands = first.commands as Record<string, unknown>[];
    const command = commands[0] as Record<string, unknown>;
    command.kind = "cylinder";
    expect(parseNativeCadDocument(input)).toMatchObject({
      ok: false,
      error: { code: NATIVE_FORMAT_ERROR_CODES.historyMismatch },
    });
  });

  it("carries the replay failure as the cause when the log does not apply", () => {
    const input = revived();
    const history = input.history as Record<string, unknown>;
    const transactions = history.transactions as Record<string, unknown>[];
    const first = transactions[0] as Record<string, unknown>;
    const commands = first.commands as Record<string, unknown>[];
    const command = commands[0] as Record<string, unknown>;
    command.outputs = ["body_missing"];
    const result = parseNativeCadDocument(input);
    expect(result).toMatchObject({
      ok: false,
      error: { code: NATIVE_FORMAT_ERROR_CODES.historyMismatch },
    });
    if (!result.ok) {
      const error = result.error as { readonly cause?: { readonly code?: string } };
      expect(error.cause?.code).toBe("transaction/command-failed");
    }
  });

  it("rejects a cursor beyond the transaction log", () => {
    const input = revived();
    const history = input.history as Record<string, unknown>;
    history.cursor = 99;
    expect(parseNativeCadDocument(input)).toMatchObject({
      ok: false,
      error: { code: NATIVE_FORMAT_ERROR_CODES.malformed },
    });
  });

  it("rejects a missing history section and a non-array transaction log", () => {
    const missing = revived();
    delete missing.history;
    expect(parseNativeCadDocument(missing)).toMatchObject({
      ok: false,
      error: { code: NATIVE_FORMAT_ERROR_CODES.malformed },
    });
    const notAnArray = revived();
    (notAnArray.history as Record<string, unknown>).transactions = "nope";
    expect(parseNativeCadDocument(notAnArray)).toMatchObject({
      ok: false,
      error: { code: NATIVE_FORMAT_ERROR_CODES.malformed },
    });
  });

  it("propagates substrate failures from the log and the regeneration section", () => {
    const badTransaction = revived();
    const history = badTransaction.history as Record<string, unknown>;
    (history.transactions as Record<string, unknown>[])[0] = {};
    expect(parseNativeCadDocument(badTransaction)).toMatchObject({
      ok: false,
      error: { code: "transaction/version-unsupported" },
    });
    const badRegeneration = revived();
    badRegeneration.regeneration = "nope";
    expect(parseNativeCadDocument(badRegeneration)).toMatchObject({
      ok: false,
      error: { code: "regeneration/malformed" },
    });
  });
});

// ---------------------------------------------------------------------------
// Regeneration state
// ---------------------------------------------------------------------------

describe("regeneration state persists as loadable data", () => {
  function failedNative(): NativeCadDocument {
    const diagnostic = requireOk(
      parseDiagnostic({
        severity: "error",
        code: "kernel/operation-failed",
        message: "The subtraction produced an empty solid.",
        location: { primary: PLATE_FEATURE, related: [HOLE_BODY] },
        data: { reason: "empty-result" },
      }),
      "the failure diagnostic",
    );
    let session = createSession(baseDocument());
    session = requireOk(
      applySessionTransaction(session, {
        commands: [
          {
            type: "feature.create",
            id: PLATE_FEATURE,
            kind: "box",
            inputs: [{ kind: "parameter", id: WIDTH }],
            outputs: [PLATE_BODY],
          },
        ],
      }),
      "the plate feature commit",
    );
    const run = requireOk(
      regenerate({
        features: session.document.features,
        states: initialRegenerationStates(session.document.features),
        suppressed: [],
        execute: () => ({ ok: false, diagnostics: [diagnostic] }),
      }),
      "the regeneration run",
    );
    return {
      document: session.document,
      history: session.history,
      regeneration: run.states,
      metadata: {},
      rollback: null,
    };
  }

  it("round-trips failed states and their diagnostics", () => {
    const native = failedNative();
    const parsed = requireOk(
      parseNativeCadDocumentFromString(nativeText(native)),
      "the parse",
    );
    const status = parsed.regeneration.get(PLATE_FEATURE);
    expect(status?.state).toBe("failed");
    expect(status?.diagnostics[0]?.code).toBe("kernel/operation-failed");
    expect(status?.diagnostics[0]?.message).toBe(
      "The subtraction produced an empty solid.",
    );
    expect(stringifyNativeCadDocument(serializeNativeCadDocument(parsed))).toBe(
      nativeText(native),
    );
  });

  it("rejects regeneration entries naming absent features", () => {
    const input = revived();
    const regeneration = input.regeneration as Record<string, unknown>;
    const features = regeneration.features as Record<string, unknown>[];
    const entry = features[0] as Record<string, unknown>;
    entry.id = "feat_ghost";
    expect(parseNativeCadDocument(input)).toMatchObject({
      ok: false,
      error: { code: NATIVE_FORMAT_ERROR_CODES.regenerationUnknownFeature },
    });
  });
});

// ---------------------------------------------------------------------------
// Metadata boundaries
// ---------------------------------------------------------------------------

describe("document metadata is validated at the parse boundary", () => {
  it("rejects non-scalar metadata values", () => {
    const input = revived();
    input.metadata = { deep: { nested: true } };
    expect(parseNativeCadDocument(input)).toMatchObject({
      ok: false,
      error: { code: NATIVE_FORMAT_ERROR_CODES.metadataInvalid },
    });
  });

  it("rejects metadata that is not a plain object", () => {
    const input = revived();
    input.metadata = "nope";
    expect(parseNativeCadDocument(input)).toMatchObject({
      ok: false,
      error: { code: NATIVE_FORMAT_ERROR_CODES.metadataInvalid },
    });
    expect(validateNativeCadDocument(input).issues).toContainEqual(
      expect.objectContaining({
        code: NATIVE_FORMAT_ISSUE_CODES.fieldInvalid,
        path: "metadata",
      }),
    );
  });

  it("rejects a __proto__ metadata key revived from JSON", () => {
    const input = revived();
    input.metadata = JSON.parse('{"__proto__": 1}');
    expect(parseNativeCadDocument(input)).toMatchObject({
      ok: false,
      error: { code: NATIVE_FORMAT_ERROR_CODES.metadataInvalid },
    });
  });

  it("accepts absent metadata as the empty record", () => {
    const input = revived();
    delete input.metadata;
    const parsed = requireOk(parseNativeCadDocument(input), "the parse");
    expect(parsed.metadata).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// The structural validator
// ---------------------------------------------------------------------------

describe("validateNativeCadDocument checks structure without replay", () => {
  it("accepts the canonical form with no issues", () => {
    const validation = validateNativeCadDocument(revived());
    expect(validation.valid).toBe(true);
    expect(validation.issues).toEqual([]);
    expect(validation.formatVersion).toBe(1);
  });

  it("rejects non-objects with the not-an-object class", () => {
    for (const input of [null, [], "document", 7]) {
      const validation = validateNativeCadDocument(input);
      expect(validation.valid).toBe(false);
      expect(validation.formatVersion).toBeNull();
      expect(validation.issues).toHaveLength(1);
      expect(validation.issues[0]?.code).toBe(
        NATIVE_FORMAT_ISSUE_CODES.notAnObject,
      );
      expect(validation.issues[0]?.path).toBe("$");
    }
  });

  it("rejects malformed version stamps with the version-invalid class", () => {
    for (const formatVersion of ["1", 1.5, -1, null]) {
      const input = revived();
      input.formatVersion = formatVersion;
      const validation = validateNativeCadDocument(input);
      expect(validation.valid).toBe(false);
      expect(validation.formatVersion).toBeNull();
      expect(validation.issues[0]?.code).toBe(
        NATIVE_FORMAT_ISSUE_CODES.versionInvalid,
      );
      expect(validation.issues[0]?.path).toBe("formatVersion");
    }
  });

  it("stops at a non-current version with the version-unsupported class", () => {
    const input = revived();
    input.formatVersion = 2;
    const validation = validateNativeCadDocument(input);
    expect(validation.valid).toBe(false);
    expect(validation.formatVersion).toBe(2);
    expect(validation.issues).toHaveLength(1);
    expect(validation.issues[0]).toMatchObject({
      code: NATIVE_FORMAT_ISSUE_CODES.versionUnsupported,
      path: "formatVersion",
    });
  });

  const FIELD_CASES: readonly {
    readonly name: string;
    readonly mutate: (input: Record<string, unknown>) => void;
    readonly path: string;
  }[] = [
    {
      name: "document id",
      mutate: (i) => {
        (i.document as Record<string, unknown>).id = "nope";
      },
      path: "document.id",
    },
    {
      name: "generator counter",
      mutate: (i) => {
        ((i.document as Record<string, unknown>).idGenerator as Record<string, unknown>).body = -1;
      },
      path: "document.idGenerator.body",
    },
    {
      name: "bodies not an array",
      mutate: (i) => {
        (i.document as Record<string, unknown>).bodies = {};
      },
      path: "document.bodies",
    },
    {
      name: "empty body name",
      mutate: (i) => {
        (((i.document as Record<string, unknown>).bodies as Record<string, unknown>[])[0] as Record<string, unknown>).name = "";
      },
      path: "document.bodies[0].name",
    },
    {
      name: "reserved parameter name",
      mutate: (i) => {
        const parameters = (i.document as Record<string, unknown>).parameters as Record<string, unknown>;
        const entry = (parameters.parameters as Record<string, unknown>[])[0] as Record<string, unknown>;
        entry.name = "sqrt";
      },
      path: "document.parameters.parameters[0].name",
    },
    {
      name: "dimensional value with a wrong-dimension unit",
      mutate: (i) => {
        const parameters = (i.document as Record<string, unknown>).parameters as Record<string, unknown>;
        const entry = (parameters.parameters as Record<string, unknown>[])[0] as Record<string, unknown>;
        (entry.value as Record<string, unknown>).unit = "kg";
      },
      path: "document.parameters.parameters[0].value",
    },
    {
      name: "malformed expression AST",
      mutate: (i) => {
        const parameters = (i.document as Record<string, unknown>).parameters as Record<string, unknown>;
        ((parameters.parameters as Record<string, unknown>[])[0] as Record<string, unknown>).expression = { kind: "bogus" };
      },
      path: "document.parameters.parameters[0].expression",
    },
    {
      name: "nested parameter metadata value",
      mutate: (i) => {
        const parameters = (i.document as Record<string, unknown>).parameters as Record<string, unknown>;
        ((parameters.parameters as Record<string, unknown>[])[0] as Record<string, unknown>).metadata = { deep: {} };
      },
      path: "document.parameters.parameters[0].metadata.deep",
    },
    {
      name: "feature kind",
      mutate: (i) => {
        const features = (i.document as Record<string, unknown>).features as Record<string, unknown>[];
        (features[0] as Record<string, unknown>).kind = "9bad";
      },
      path: "document.features[0].kind",
    },
    {
      name: "feature input of an unknown kind",
      mutate: (i) => {
        const features = (i.document as Record<string, unknown>).features as Record<string, unknown>[];
        ((features[0] as Record<string, unknown>).inputs as Record<string, unknown>[])[0] = { kind: "face", bodyId: "body_plate" };
      },
      path: "document.features[0].inputs[0]",
    },
    {
      name: "feature output id",
      mutate: (i) => {
        const features = (i.document as Record<string, unknown>).features as Record<string, unknown>[];
        ((features[0] as Record<string, unknown>).outputs as unknown[])[0] = "nope";
      },
      path: "document.features[0].outputs[0]",
    },
    {
      name: "history base id",
      mutate: (i) => {
        ((i.history as Record<string, unknown>).base as Record<string, unknown>).id = "nope";
      },
      path: "history.base.id",
    },
    {
      name: "transaction version stamp",
      mutate: (i) => {
        const transactions = (i.history as Record<string, unknown>).transactions as Record<string, unknown>[];
        (transactions[0] as Record<string, unknown>).formatVersion = 2;
      },
      path: "history.transactions[0].formatVersion",
    },
    {
      name: "unknown command type",
      mutate: (i) => {
        const transactions = (i.history as Record<string, unknown>).transactions as Record<string, unknown>[];
        const commands = (transactions[0] as Record<string, unknown>).commands as Record<string, unknown>[];
        (commands[0] as Record<string, unknown>).type = "feature.explode";
      },
      path: "history.transactions[0].commands[0].type",
    },
    {
      name: "command feature kind",
      mutate: (i) => {
        const transactions = (i.history as Record<string, unknown>).transactions as Record<string, unknown>[];
        const commands = (transactions[0] as Record<string, unknown>).commands as Record<string, unknown>[];
        (commands[0] as Record<string, unknown>).kind = "9bad";
      },
      path: "history.transactions[0].commands[0].kind",
    },
    {
      name: "cursor beyond the log",
      mutate: (i) => {
        (i.history as Record<string, unknown>).cursor = 99;
      },
      path: "history.cursor",
    },
    {
      name: "regeneration version stamp",
      mutate: (i) => {
        (i.regeneration as Record<string, unknown>).formatVersion = 2;
      },
      path: "regeneration.formatVersion",
    },
    {
      name: "unknown regeneration state",
      mutate: (i) => {
        const features = (i.regeneration as Record<string, unknown>).features as Record<string, unknown>[];
        (features[0] as Record<string, unknown>).state = "exploded";
      },
      path: "regeneration.features[0].state",
    },
    {
      name: "regeneration diagnostics not an array",
      mutate: (i) => {
        const features = (i.regeneration as Record<string, unknown>).features as Record<string, unknown>[];
        (features[0] as Record<string, unknown>).diagnostics = "nope";
      },
      path: "regeneration.features[0].diagnostics",
    },
    {
      name: "malformed regeneration diagnostic",
      mutate: (i) => {
        const features = (i.regeneration as Record<string, unknown>).features as Record<string, unknown>[];
        const entry = features[0] as Record<string, unknown>;
        entry.state = "failed";
        entry.diagnostics = [{ severity: "catastrophic", code: "kernel/operation-failed", message: "x", location: { primary: "feat_plate" } }];
      },
      path: "regeneration.features[0].diagnostics[0]",
    },
    {
      name: "document-level metadata value",
      mutate: (i) => {
        i.metadata = { deep: {} };
      },
      path: "metadata.deep",
    },
  ];

  it("reports the field-invalid class with the offending JSON path", () => {
    for (const field of FIELD_CASES) {
      const input = revived();
      field.mutate(input);
      const validation = validateNativeCadDocument(input);
      expect(validation.valid, field.name).toBe(false);
      const match = validation.issues.find(
        (candidate) =>
          candidate.code === NATIVE_FORMAT_ISSUE_CODES.fieldInvalid &&
          candidate.path === field.path,
      );
      expect(match, `${field.name}: expected a field-invalid issue at ${field.path}`).toBeDefined();
    }
  });

  it("reports the regeneration-unknown-feature class", () => {
    const input = revived();
    const features = (input.regeneration as Record<string, unknown>).features as Record<string, unknown>[];
    (features[0] as Record<string, unknown>).id = "feat_ghost";
    const validation = validateNativeCadDocument(input);
    expect(validation.valid).toBe(false);
    expect(validation.issues).toContainEqual(
      expect.objectContaining({
        code: NATIVE_FORMAT_ISSUE_CODES.regenerationUnknownFeature,
        path: "regeneration.features[0]",
      }),
    );
  });

  it("collects every issue instead of failing fast", () => {
    const input = revived();
    (input.document as Record<string, unknown>).id = "nope";
    (input.history as Record<string, unknown>).cursor = 99;
    const validation = validateNativeCadDocument(input);
    expect(validation.issues.length).toBeGreaterThanOrEqual(2);
    expect(validation.issues.map((entry) => entry.path)).toContain("document.id");
    expect(validation.issues.map((entry) => entry.path)).toContain("history.cursor");
  });

  it("does not replay: unresolvable references pass validation but fail the parse", () => {
    const input = revived();
    const removePlate = (section: unknown): void => {
      const document = section as Record<string, unknown>;
      document.bodies = (document.bodies as Record<string, unknown>[]).filter(
        (body) => body.id !== "body_plate",
      );
    };
    removePlate(input.document);
    removePlate((input.history as Record<string, unknown>).base);
    const validation = validateNativeCadDocument(input);
    expect(validation.valid).toBe(true);
    expect(parseNativeCadDocument(input)).toMatchObject({
      ok: false,
      error: { code: "document/output-unknown" },
    });
  });
});

// ---------------------------------------------------------------------------
// The hard rule: no derived kernel objects, no synthetic references
// ---------------------------------------------------------------------------

/** Keys no serialized native document may carry anywhere. */
const GEOMETRY_KEYS = [
  "mesh",
  "triangles",
  "vertices",
  "positions",
  "normals",
  "indices",
  "polygons",
  "solid",
  "solids",
  "geometry",
] as const;

/** Keys only synthetic (transient) selection references carry. */
const SYNTHETIC_REF_KEYS = ["faceIndex", "edgeIndex", "vertexIndex"] as const;

const SYNTHETIC_REF_KINDS = new Set(["face", "edge", "vertex"]);

function assertNoDerivedData(value: unknown): void {
  const walk = (current: unknown): void => {
    if (Array.isArray(current)) {
      for (const entry of current) walk(entry);
      return;
    }
    if (typeof current !== "object" || current === null) return;
    for (const [key, entry] of Object.entries(current)) {
      expect(GEOMETRY_KEYS, `geometry key "${key}"`).not.toContain(key);
      expect(SYNTHETIC_REF_KEYS, `synthetic reference key "${key}"`).not.toContain(key);
      if (key === "kind" && typeof entry === "string") {
        expect(SYNTHETIC_REF_KINDS.has(entry), `synthetic kind "${entry}"`).toBe(false);
      }
      walk(entry);
    }
  };
  walk(value);
}

describe("derived kernel objects never become canonical", () => {
  it("serializes no geometry after a regeneration run", () => {
    // The executor's outcome type cannot carry geometry at all — kernel
    // solids live outside the document — so the serialized form is checked
    // wholesale: no geometry keys, no synthetic reference data, anywhere.
    const native = buildNative();
    const serialized = serializeNativeCadDocument(native);
    assertNoDerivedData(JSON.parse(stringifyNativeCadDocument(serialized)));
    for (const body of serialized.document.bodies) {
      expect(Object.keys(body)).toEqual(["id", "name"]);
    }
  });

  it("serializes no synthetic selection references", () => {
    const native = buildNative();
    const text = nativeText(native);
    // The Phase 12 transience rule, enforced structurally: the format has no
    // field that could carry a face/edge/vertex reference, so even a session
    // that used synthetic selections persists none.
    expect(text).not.toContain("faceIndex");
    expect(text).not.toContain("edgeIndex");
    expect(text).not.toContain("vertexIndex");
  });
});

describe("the optional rollback field (Phase 20)", () => {
  it("round-trips a set marker byte-stably and omits the field entirely when null", () => {
    const rolled: NativeCadDocument = {
      ...buildNative(),
      rollback: { afterFeatureId: PLATE_FEATURE },
    };
    const text = nativeText(rolled);
    const parsed = requireOk(
      parseNativeCadDocumentFromString(text),
      "parsing the rolled-back native document",
    );
    expect(parsed.rollback).toEqual({ afterFeatureId: PLATE_FEATURE });
    expect(nativeText(parsed)).toBe(text);

    // Marker-free documents carry NO rollback key: the pre-Phase 20 byte
    // form is unchanged.
    const plain = buildNative();
    const plainText = nativeText(plain);
    const plainJson = JSON.parse(plainText) as Record<string, unknown>;
    expect(Object.keys(plainJson)).not.toContain("rollback");
    expect(plain.rollback).toBeNull();
    const parsedPlain = requireOk(
      parseNativeCadDocumentFromString(plainText),
      "parsing the marker-free native document",
    );
    expect(parsedPlain.rollback).toBeNull();
  });

  it("parses old-shaped files (no rollback key) as un-rolled", () => {
    const revived = JSON.parse(nativeText()) as Record<string, unknown>;
    expect(revived.rollback).toBeUndefined();
    const parsed = requireOk(
      parseNativeCadDocument(revived),
      "parsing a pre-Phase 20 native document",
    );
    expect(parsed.rollback).toBeNull();
  });

  it("tolerates unknown envelope fields — the mechanism old readers apply to rollback", () => {
    const revived = JSON.parse(nativeText()) as Record<string, unknown>;
    revived.someFutureField = { nested: true };
    const parsed = requireOk(
      parseNativeCadDocument(revived),
      "parsing a native document with an unknown envelope field",
    );
    expect(parsed.document.id).toBe(DOC_ID);
  });

  it("rejects a marker naming a feature the document does not have", () => {
    const ghost = createFeatureId("feat_ghost");
    const rolled: NativeCadDocument = {
      ...buildNative(),
      rollback: { afterFeatureId: ghost },
    };
    const parsed = parseNativeCadDocumentFromString(nativeText(rolled));
    expect(parsed.ok).toBe(false);
    if (parsed.ok) throw new Error("expected a rejection");
    expect(parsed.error.code).toBe(
      NATIVE_FORMAT_ERROR_CODES.rollbackUnknownFeature,
    );
  });

  it("rejects a mis-shaped rollback field, structurally", () => {
    const revived = JSON.parse(nativeText()) as Record<string, unknown>;
    revived.rollback = { afterFeatureId: 42 };
    const parsed = parseNativeCadDocument(revived);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) throw new Error("expected a rejection");
    expect(parsed.error.code).toBe(NATIVE_FORMAT_ERROR_CODES.malformed);
  });

  it("validates the field's shape and membership without replay", () => {
    const rolled: NativeCadDocument = {
      ...buildNative(),
      rollback: { afterFeatureId: PLATE_FEATURE },
    };
    expect(validateNativeCadDocument(JSON.parse(nativeText(rolled)))).toEqual({
      valid: true,
      formatVersion: CAD_NATIVE_FORMAT_VERSION,
      issues: [],
    });
    const ghost = JSON.parse(nativeText()) as Record<string, unknown>;
    ghost.rollback = { afterFeatureId: "feat_ghost" };
    const validation = validateNativeCadDocument(ghost);
    expect(validation.valid).toBe(false);
    expect(validation.issues.map((entry) => entry.code)).toContain(
      NATIVE_FORMAT_ISSUE_CODES.rollbackUnknownFeature,
    );
    const misShaped = JSON.parse(nativeText()) as Record<string, unknown>;
    misShaped.rollback = "rollback";
    const misShapedValidation = validateNativeCadDocument(misShaped);
    expect(misShapedValidation.valid).toBe(false);
    expect(
      misShapedValidation.issues.some(
        (entry) => entry.path === "rollback" && entry.code === "native-format/field-invalid",
      ),
    ).toBe(true);
  });
});
