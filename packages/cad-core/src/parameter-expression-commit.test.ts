/**
 * The Phase 22 expression-commit suite: the command vocabulary's expression
 * payloads end to end. Covered here, on real documents through the single
 * `applyCommand` interpreter:
 *
 * - the three `parameter.set` forms — value-only (the pre-expression
 *   semantics, pinned recompute-free), clear (`expression: null` + the
 *   literal it lands on), and define (an AST, no value);
 * - `parameter.create` with a defining expression beside its value;
 * - the refusals — unknown identifiers named, closing cycles listed by
 *   chain — with the document left untouched;
 * - the recompute: multi-level transitive re-drive in ONE application,
 *   deterministic topological order, and the warning-level honesty of a
 *   dependent whose evaluation fails (prior cache kept, install succeeds);
 * - the wire: strict `parseCommand` form rules and `serializeCommand`
 *   round-trips (old commands byte-stable, no `expression` key);
 * - the native format: a log carrying expression payloads replays and
 *   round-trips byte-identically, a v6-stamped file migrates (identity) and
 *   a v7 file needs no migration, and identical command runs land on
 *   byte-identical documents.
 */

import { describe, expect, it } from "vitest";

import {
  addDocumentParameter,
  applyCommand,
  applySessionTransaction,
  createDocument,
  createDocumentId,
  createNativeCadDocument,
  createParameterId,
  createSession,
  encodeNativeCadDocument,
  getParameter,
  installParameterExpression,
  length,
  migrateNativeCadDocument,
  parseCommand,
  parseExpression,
  parseNativeCadDocumentFromBytes,
  printExpression,
  serializeCadDocument,
  serializeCommand,
  stringifyNativeCadDocument,
  serializeNativeCadDocument,
  undoSession,
  readNativeFormatVersion,
  type CadCommand,
  type CadDocument,
  type DocumentId,
  type ExpressionNode,
  type ParameterId,
  type ParseFailure,
  type ParseResult,
  PARAMETER_ERROR_CODES,
} from "./index";

const docId: DocumentId = createDocumentId("doc_expr");
const aId = createParameterId("param_a");
const bId = createParameterId("param_b");
const cId = createParameterId("param_c");
const dId = createParameterId("param_d");

/** Unwraps a result the fixture depends on. */
function requireOk<T, F extends ParseFailure>(
  result: ParseResult<T, F>,
  what: string,
): T {
  if (!result.ok) {
    throw new Error(`The fixture rejected ${what}: ${result.error.message}`);
  }
  return result.value;
}

/** Parses source text the fixture depends on. */
function requireExpression(source: string): ExpressionNode {
  const parsed = parseExpression(source);
  if (!parsed.ok) {
    throw new Error(`Test expression rejected: ${parsed.error.message}`);
  }
  return parsed.value;
}

/**
 * The chain fixture: three literal lengths a = 2, b = 4, c = 8 — every test
 * wires its own expressions over them.
 */
function chainDocument(): CadDocument {
  let document = createDocument(docId);
  for (const [id, name, magnitude] of [
    [aId, "a", 2],
    [bId, "b", 4],
    [cId, "c", 8],
  ] as const) {
    document = requireOk(
      addDocumentParameter(document, { id, name, value: length(magnitude) }),
      `parameter ${name}`,
    ).document;
  }
  return document;
}

/** A define-form command for `id`. */
function define(id: ParameterId, source: string): CadCommand {
  return {
    type: "parameter.set",
    id,
    expression: requireExpression(source),
  };
}

function parameterOf(
  document: CadDocument,
  id: ParameterId,
): {
  readonly value: { readonly dimension: string; readonly value: number };
  readonly expressionText: string | null;
} {
  const parameter = getParameter(document.parameters, id);
  if (parameter === undefined) {
    throw new Error("The fixture lost a parameter.");
  }
  return {
    value: parameter.value,
    expressionText:
      parameter.expression === null
        ? null
        : printExpression(parameter.expression),
  };
}

describe("parameter.set's three forms", () => {
  it("value-only sets the cache and recomputes nothing (the pre-expression semantics)", () => {
    let document = chainDocument();
    document = requireOk(
      applyCommand(document, define(cId, "b * 2")),
      "the define commit",
    );
    expect(parameterOf(document, cId).value.value).toBe(8);

    // The value-only form: b's cache moves, c's stored expression and its
    // cached value are untouched — exactly the pre-expression behavior the
    // golden logs replayed under.
    const valueOnly: CadCommand = {
      type: "parameter.set",
      id: bId,
      value: length(6),
    };
    const next = requireOk(
      applyCommand(document, valueOnly),
      "the value-only set",
    );
    expect(parameterOf(next, bId).value.value).toBe(6);
    expect(parameterOf(next, cId).value.value).toBe(8);
    expect(parameterOf(next, cId).expressionText).toBe("b * 2");
  });

  it("the define form stores the AST and re-derives the parameter in the same application", () => {
    const document = chainDocument();
    const next = requireOk(
      applyCommand(document, define(cId, "a * 10")),
      "the define commit",
    );
    expect(parameterOf(next, cId).expressionText).toBe("a * 10");
    expect(parameterOf(next, cId).value.value).toBe(20);
    expect(parameterOf(next, cId).value.dimension).toBe("length");
  });

  it("an expression commit re-drives multi-level dependents in one application", () => {
    let document = chainDocument();
    // The chain c = b * 2, b = a * 2 over the literal a.
    document = requireOk(applyCommand(document, define(bId, "a * 2")), "b");
    document = requireOk(applyCommand(document, define(cId, "b * 2")), "c");
    expect(parameterOf(document, cId).value.value).toBe(8);
    // ONE commit on the root re-derives b AND c through the stored
    // expressions: a = 3 → b = 6 → c = 12. Wrong evaluation orders would
    // land c on a stale product; only topological order reaches 12.
    const next = requireOk(applyCommand(document, define(aId, "3mm")), "a");
    expect(parameterOf(next, aId).value.value).toBe(3);
    expect(parameterOf(next, bId).value.value).toBe(6);
    expect(parameterOf(next, cId).value.value).toBe(12);
  });

  it("clear (expression null + the literal) un-drives the parameter and re-derives its dependents", () => {
    let document = chainDocument();
    document = requireOk(applyCommand(document, define(cId, "b * 2")), "c");
    const clear: CadCommand = {
      type: "parameter.set",
      id: bId,
      value: length(5),
      expression: null,
    };
    // b is literal here; clearing is legal on any parameter (c stops being
    // expression-driven through a clear of its own, tested via the
    // substrate below). This clear lands b at 5 and re-derives c = 10.
    const next = requireOk(applyCommand(document, clear), "the clear");
    expect(parameterOf(next, bId).expressionText).toBeNull();
    expect(parameterOf(next, bId).value.value).toBe(5);
    expect(parameterOf(next, cId).value.value).toBe(10);

    // Clearing the expression-driven parameter itself: c stops tracking b
    // and keeps its current cache as the literal.
    const cleared = requireOk(
      applyCommand(next, {
        type: "parameter.set",
        id: cId,
        value: length(10),
        expression: null,
      }),
      "the c clear",
    );
    expect(parameterOf(cleared, cId).expressionText).toBeNull();
    expect(parameterOf(cleared, cId).value.value).toBe(10);
  });

  it("creates with a defining expression beside its initial cache", () => {
    const document = chainDocument();
    const command: CadCommand = {
      type: "parameter.create",
      id: dId,
      name: "d",
      value: length(0),
      expression: requireExpression("c + a"),
    };
    const next = requireOk(applyCommand(document, command), "the create");
    expect(parameterOf(next, dId).expressionText).toBe("c + a");
    // The initial cache (0) is re-derived in the same application.
    expect(parameterOf(next, dId).value.value).toBe(10);
  });

  it("refuses a create whose expression self-references (the cycle it is)", () => {
    const document = chainDocument();
    const result = applyCommand(document, {
      type: "parameter.create",
      name: "d",
      value: length(0),
      expression: requireExpression("d + 1"),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(PARAMETER_ERROR_CODES.cycle);
    expect(result.error.message).toContain("d → d");
    expect(getParameter(document.parameters, dId)).toBeUndefined();
  });
});

describe("the expression-commit refusals", () => {
  it("names an unknown identifier and changes nothing", () => {
    const document = chainDocument();
    const result = applyCommand(document, define(cId, "ghost + 1"));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(PARAMETER_ERROR_CODES.unknownIdentifier);
    expect(result.error.message).toContain('"ghost"');
    // The refused commit is a never-happened commit.
    expect(parameterOf(document, cId).expressionText).toBeNull();
  });

  it("refuses a closing cycle and lists the chain by name", () => {
    let document = chainDocument();
    document = requireOk(applyCommand(document, define(cId, "b * 2")), "c");
    const result = applyCommand(document, define(bId, "c / 2"));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(PARAMETER_ERROR_CODES.cycle);
    expect(result.error.message).toContain("b → c → b");
    // The refusal left the collection exactly as the DAG had it.
    expect(parameterOf(document, bId).expressionText).toBeNull();
    expect(parameterOf(document, cId).expressionText).toBe("b * 2");
  });

  it("refuses a self-reference as a one-node cycle", () => {
    const document = chainDocument();
    const result = applyCommand(document, define(cId, "c + 1"));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(PARAMETER_ERROR_CODES.cycle);
    expect(result.error.message).toContain("c → c");
  });
});

describe("the recompute's warning-level honesty", () => {
  it("a dependent whose evaluation fails keeps its prior cache; the install succeeds", () => {
    let document = chainDocument();
    document = requireOk(applyCommand(document, define(bId, "a * 2")), "b");
    // sqrt of a length is dimensionally inexpressible: the evaluator fails.
    document = requireOk(applyCommand(document, define(cId, "sqrt(b)")), "c");
    // The install SUCCEEDED (c's expression is stored); the cache could not
    // be re-derived and stayed at its prior value — never fabricated.
    expect(parameterOf(document, cId).expressionText).toBe("sqrt(b)");
    expect(parameterOf(document, cId).value.value).toBe(8);

    // A dependent OF the failed parameter evaluates against the kept cache.
    document = requireOk(
      applyCommand(document, {
        type: "parameter.create",
        id: dId,
        name: "d",
        value: length(0),
        expression: requireExpression("c * 2"),
      }),
      "d",
    );
    expect(parameterOf(document, dId).value.value).toBe(16);

    // Re-committing d under the still-failing c: the failure CASCADES — c
    // keeps its cache, and d (reading it) fails dimensionally too, so both
    // are named stale and both keep their prior values. Warning-level, by
    // contract: no throw, no fabricated value.
    const commit = requireOk(
      installParameterExpression(
        document.parameters,
        dId,
        requireExpression("c + 1"),
      ),
      "the d re-commit",
    );
    expect(commit.stale).toEqual([cId, dId]);
    expect(
      parameterOf({ parameters: commit.collection } as CadDocument, dId).value
        .value,
    ).toBe(16);

    // Healing the root (a = 3mm re-derives b = 6) re-drives the chain in
    // one application: c = sqrt(6mm) still fails and keeps its cache, and
    // d (= c * 2) re-derives against that KEPT cache — the honest cascade,
    // never a fabricated c.
    const healed = requireOk(
      applyCommand(document, define(aId, "3mm")),
      "the heal",
    );
    expect(parameterOf(healed, bId).value.value).toBe(6);
    expect(parameterOf(healed, cId).value.value).toBe(8);
    expect(parameterOf(healed, dId).value.value).toBe(16);
  });

  it("the substrate's stale list names the parameters that kept their caches", () => {
    let document = chainDocument();
    document = requireOk(applyCommand(document, define(bId, "a * 2")), "b");
    document = requireOk(applyCommand(document, define(cId, "sqrt(b)")), "c");
    const commit = requireOk(
      installParameterExpression(
        document.parameters,
        aId,
        requireExpression("2mm"),
      ),
      "the a re-commit",
    );
    // b re-derives fine; c keeps its cache and is named.
    expect(commit.stale).toEqual([cId]);
    const healed: CadDocument = { ...document, parameters: commit.collection };
    expect(parameterOf(healed, bId).value.value).toBe(4);
    expect(parameterOf(healed, cId).value.value).toBe(8);
  });
});

describe("the wire: parseCommand and serializeCommand", () => {
  it("round-trips the define form through serialize → parse deep-equal", () => {
    const command = define(cId, "b * 2 + 1mm");
    const serialized = serializeCommand(command);
    expect(
      serialized.type === "parameter.set" && "expression" in serialized,
    ).toBe(true);
    const parsed = requireOk(parseCommand(serialized), "parseCommand");
    expect(parsed).toEqual(command);
  });

  it("rejects the ambiguity: a value beside a defining expression", () => {
    const result = parseCommand({
      formatVersion: 1,
      type: "parameter.set",
      id: cId,
      value: { dimension: "length", unit: "mm", value: 1 },
      expression: requireExpression("b * 2"),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("command/malformed");
    expect(result.error.message).toContain("cannot carry both");
  });

  it("rejects a clear without the literal it lands on", () => {
    const result = parseCommand({
      formatVersion: 1,
      type: "parameter.set",
      id: cId,
      expression: null,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("command/malformed");
  });

  it("rejects a set that carries neither a value nor an expression", () => {
    const result = parseCommand({
      formatVersion: 1,
      type: "parameter.set",
      id: cId,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("command/malformed");
  });

  it("rejects a malformed expression AST in the define form", () => {
    const result = parseCommand({
      formatVersion: 1,
      type: "parameter.set",
      id: cId,
      expression: { kind: "wat" },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("command/malformed");
    expect(result.error.message).toContain("valid expression AST");
  });

  it("keeps the pre-expression wire forms byte-stable: no expression key unless carried", () => {
    const valueOnly = serializeCommand({
      type: "parameter.set",
      id: cId,
      value: length(6),
    });
    expect(JSON.stringify(valueOnly)).not.toContain("expression");
    const clear = serializeCommand({
      type: "parameter.set",
      id: cId,
      value: length(6),
      expression: null,
    });
    expect(JSON.stringify(clear)).toContain('"expression":null');
    const create = serializeCommand({
      type: "parameter.create",
      name: "d",
      value: length(6),
    });
    expect(JSON.stringify(create)).not.toContain("expression");
  });

  it("round-trips a create-with-expression through serialize → parse deep-equal", () => {
    const command: CadCommand = {
      type: "parameter.create",
      id: dId,
      name: "d",
      value: length(0),
      expression: requireExpression("c + a"),
    };
    const parsed = requireOk(
      parseCommand(serializeCommand(command)),
      "parseCommand",
    );
    expect(parsed).toEqual(command);
  });

  it("rejects an expression: null on create (a create is total; omit the field)", () => {
    const result = parseCommand({
      formatVersion: 1,
      type: "parameter.create",
      name: "d",
      value: { dimension: "length", unit: "mm", value: 1 },
      expression: null,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("command/malformed");
  });
});

describe("the native format with expression payloads", () => {
  /** Builds a session whose log carries both expression forms. */
  function expressionSession() {
    let session = createSession(chainDocument());
    session = requireOk(
      applySessionTransaction(session, { commands: [define(cId, "b * 2")] }),
      "the define commit",
    );
    session = requireOk(
      applySessionTransaction(session, {
        commands: [
          {
            type: "parameter.create",
            id: dId,
            name: "d",
            value: length(0),
            expression: requireExpression("c + a"),
          },
        ],
      }),
      "the create commit",
    );
    session = requireOk(
      applySessionTransaction(session, {
        commands: [
          {
            type: "parameter.set",
            id: aId,
            value: length(3),
            expression: null,
          },
        ],
      }),
      "the clear commit",
    );
    return session;
  }

  it("replays a log carrying expression payloads and round-trips byte-identically", () => {
    const session = expressionSession();
    // The replayed state: a = 3 (cleared to a literal), b = 4, c = b * 2,
    // d = c + a.
    expect(parameterOf(session.document, aId).value.value).toBe(3);
    expect(parameterOf(session.document, cId).value.value).toBe(8);
    expect(parameterOf(session.document, dId).value.value).toBe(11);

    const native = requireOk(
      createNativeCadDocument(session.document),
      "the native wrap",
    );
    const text = stringifyNativeCadDocument(serializeNativeCadDocument(native));
    expect(text).toContain('"expression"');
    const reparsed = requireOk(
      parseNativeCadDocumentFromBytes(encodeNativeCadDocument(native)),
      "the byte round trip",
    );
    expect(
      stringifyNativeCadDocument(serializeNativeCadDocument(reparsed)),
    ).toBe(text);
    // The revived history restores the commit exactly.
    const undone = requireOk(undoSession(session), "the undo");
    expect(parameterOf(undone.document, aId).value.value).toBe(2);
    expect(parameterOf(undone.document, dId).value.value).toBe(10);
  });

  it("migrates v6- and v7-stamped files (identity steps) and keeps v8 native", () => {
    const session = expressionSession();
    const native = requireOk(
      createNativeCadDocument(session.document),
      "the native wrap",
    );
    const serialized = serializeNativeCadDocument(native);
    const text = stringifyNativeCadDocument(serialized);
    expect(readNativeFormatVersion(JSON.parse(text))).toBe(8);

    // The same content stamped 6 or 7 migrates (the identity) and
    // re-stamps 8 — the two vocabulary-growth steps rewrite nothing.
    const asV6 = {
      ...(JSON.parse(text) as Record<string, unknown>),
      formatVersion: 6,
    };
    const migrated = requireOk(migrateNativeCadDocument(asV6), "the migration");
    expect(readNativeFormatVersion(migrated)).toBe(8);
    const asV7 = {
      ...(JSON.parse(text) as Record<string, unknown>),
      formatVersion: 7,
    };
    const migratedV7 = requireOk(
      migrateNativeCadDocument(asV7),
      "the v7 migration",
    );
    expect(readNativeFormatVersion(migratedV7)).toBe(8);
    const reparsed = requireOk(
      parseNativeCadDocumentFromBytes(
        encodeNativeCadDocument({
          ...native,
        }),
      ),
      "the parse",
    );
    expect(
      stringifyNativeCadDocument(serializeNativeCadDocument(reparsed)),
    ).toBe(text);
    // The v7 native parse of the identical text matches the migrated parse:
    // byte-determinism across the version boundary.
    const direct = requireOk(
      parseNativeCadDocumentFromBytes(new TextEncoder().encode(text)),
      "the direct parse",
    );
    expect(stringifyNativeCadDocument(serializeNativeCadDocument(direct))).toBe(
      stringifyNativeCadDocument(serializeNativeCadDocument(reparsed)),
    );
  });

  it("lands identical command runs on byte-identical documents", () => {
    const commands: readonly CadCommand[] = [
      define(bId, "a * 2"),
      define(cId, "b * 2"),
      { type: "parameter.set", id: aId, value: length(5), expression: null },
      define(aId, "2mm"),
      {
        type: "parameter.create",
        id: dId,
        name: "d",
        value: length(0),
        expression: requireExpression("c + a"),
      },
    ];
    const first = commands.reduce(
      (document, command) =>
        requireOk(applyCommand(document, command), "run one"),
      chainDocument(),
    );
    const second = commands.reduce(
      (document, command) =>
        requireOk(applyCommand(document, command), "run two"),
      chainDocument(),
    );
    expect(JSON.stringify(serializeCadDocument(first))).toBe(
      JSON.stringify(serializeCadDocument(second)),
    );
    expect(parameterOf(first, cId).value.value).toBe(8);
    expect(parameterOf(first, dId).value.value).toBe(10);
  });
});
