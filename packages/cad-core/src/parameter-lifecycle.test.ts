/**
 * The Phase 24 parameter-lifecycle suite: rename and delete as first-class
 * vocabulary, end to end. Covered here, on real documents through the
 * single `applyCommand` interpreter and its substrate:
 *
 * - the lexical rewrite — `renameExpressionIdentifier` rewrites identifier
 *   nodes only (function callees are structurally distinct), preserves
 *   reference identity where nothing matched, and reaches every nesting
 *   depth;
 * - `parameter.rename` — the name moves AND every stored expression
 *   referencing the old name is rewritten in the same pure transition;
 *   feature inputs (BY ID) ride untouched; cached values are unchanged
 *   (the dependency graph is name-isomorphic under rename — pinned by
 *   comparing the edge map before and after); the identifier, reserved,
 *   and uniqueness rules refuse structurally; the one reachable cycle
 *   refusal is the pre-existing-dangling-reference corner;
 * - `parameter.delete` — refused with `document/in-use` while ANY reference
 *   remains, the single structured refusal naming every blocker (the
 *   variables whose stored expressions read it, by name; the features whose
 *   declared inputs consume it, by id and kind); an unreferenced parameter
 *   deletes cleanly;
 * - the wire — strict `parseCommand` shapes, `serializeCommand` round-trips;
 * - the native format — a log carrying both types replays and round-trips
 *   byte-identically, a v7-stamped copy of the same content migrates
 *   (identity) and replays through the new commands, and identical command
 *   runs land on byte-identical documents.
 */

import { describe, expect, it } from "vitest";

import {
  addDocumentParameter,
  addFeature,
  applyCommand,
  applySessionTransaction,
  CAD_NATIVE_FORMAT_VERSION,
  COMMAND_ERROR_CODES,
  createDocument,
  createDocumentId,
  createFeatureId,
  createNativeCadDocument,
  createParameterId,
  createSession,
  DOCUMENT_ERROR_CODES,
  encodeNativeCadDocument,
  extractExpressionDependencies,
  findParameterCycle,
  getParameter,
  length,
  migrateNativeCadDocument,
  parseCommand,
  parseExpression,
  parameterDependencyEdges,
  parseNativeCadDocumentFromBytes,
  parseNativeCadDocumentFromString,
  printExpression,
  removeDocumentParameter,
  renameDocumentParameter,
  renameExpressionIdentifier,
  renameParameter,
  serializeCadDocument,
  serializeCommand,
  serializeNativeCadDocument,
  stringifyNativeCadDocument,
  updateParameterExpression,
  validateNativeCadDocument,
  type CadCommand,
  type CadDocument,
  type DocumentId,
  type ExpressionNode,
  type ParameterDeleteBlockers,
  type ParameterId,
  type ParseFailure,
  type ParseResult,
  PARAMETER_ERROR_CODES,
} from "./index";

const docId: DocumentId = createDocumentId("doc_lifecycle");
const baseId = createParameterId("param_base");
const dependentId = createParameterId("param_dependent");
const otherId = createParameterId("param_other");
const featId = createFeatureId("feat_consumer");

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

function requireDocumentParameter(
  document: CadDocument,
  id: ParameterId,
  what: string,
): { readonly name: string; readonly value: number } {
  const parameter = getParameter(document.parameters, id);
  if (parameter === undefined) {
    throw new Error(`The fixture lost ${what}.`);
  }
  return { name: parameter.name, value: parameter.value.value };
}

/** The names a parameter's stored expression reads, in source order. */
function dependenciesOf(
  document: CadDocument,
  id: ParameterId,
): readonly string[] {
  const parameter = getParameter(document.parameters, id);
  if (parameter === undefined || parameter.expression === null) return [];
  return [...extractExpressionDependencies(parameter.expression)];
}

/**
 * The lifecycle fixture: `plateWidth` = 20 (literal), `plateDepth` =
 * plateWidth / 2 (expression-driven, cached 10), `spare` = 5 (literal).
 */
function lifecycleDocument(): CadDocument {
  let document = createDocument(docId);
  for (const [id, name, magnitude] of [
    [baseId, "plateWidth", 20],
    [dependentId, "plateDepth", 10],
    [otherId, "spare", 5],
  ] as const) {
    document = requireOk(
      addDocumentParameter(document, { id, name, value: length(magnitude) }),
      `parameter ${name}`,
    ).document;
  }
  document = requireOk(
    applyCommand(document, {
      type: "parameter.set",
      id: dependentId,
      expression: requireExpression("plateWidth / 2"),
    }),
    "the dependent's expression",
  );
  return document;
}

describe("renameExpressionIdentifier", () => {
  it("rewrites identifier nodes at every depth and preserves the rest", () => {
    const rewritten = renameExpressionIdentifier(
      requireExpression("-(plateWidth + sqrt(plateWidth * 2)) + 1mm"),
      "plateWidth",
      "shelfWidth",
    );
    expect(printExpression(rewritten)).toBe(
      "-(shelfWidth + sqrt(shelfWidth * 2)) + 1mm",
    );
  });

  it("returns the identical AST when nothing matches", () => {
    const expression = requireExpression("plateWidth / 2");
    expect(renameExpressionIdentifier(expression, "spare", "other")).toBe(
      expression,
    );
  });

  it("never matches a call's callee (identifier nodes only)", () => {
    // The rename source is a validated parameter name — never a reserved
    // function — and the callee field is not an identifier node regardless.
    const rewritten = renameExpressionIdentifier(
      requireExpression("sqrt(plateWidth)"),
      "plateWidth",
      "shelfWidth",
    );
    expect(printExpression(rewritten)).toBe("sqrt(shelfWidth)");
  });
});

describe("the renameParameter substrate", () => {
  it("renames the parameter and rewrites every referencing expression in one transition", () => {
    const document = lifecycleDocument();
    const renamed = requireOk(
      renameParameter(document.parameters, baseId, "shelfWidth"),
      "the rename",
    );
    const base = requireDocumentParameter(
      { ...document, parameters: renamed },
      baseId,
      "the base",
    );
    expect(base.name).toBe("shelfWidth");
    expect(base.value).toBe(20);
    // The dependent's stored expression reads the NEW name; its cache is
    // untouched (the rewrite is lexical, values are name-isomorphic).
    expect(
      dependenciesOf({ ...document, parameters: renamed }, dependentId),
    ).toEqual(["shelfWidth"]);
    expect(
      requireDocumentParameter(
        { ...document, parameters: renamed },
        dependentId,
        "the dependent",
      ).value,
    ).toBe(10);
    // The unrelated parameter's expression-less record is untouched, and
    // order is preserved.
    expect(renamed.parameters.map((parameter) => parameter.name)).toEqual([
      "shelfWidth",
      "plateDepth",
      "spare",
    ]);
  });

  it("refuses the name rules and uniqueness with the collection's codes", () => {
    const document = lifecycleDocument();
    const cases: readonly [name: string, code: string][] = [
      ["1bad", PARAMETER_ERROR_CODES.nameInvalid],
      ["sqrt", PARAMETER_ERROR_CODES.nameReserved],
      ["plateDepth", PARAMETER_ERROR_CODES.nameConflict],
    ];
    for (const [name, code] of cases) {
      const refused = renameParameter(document.parameters, baseId, name);
      expect(refused.ok).toBe(false);
      if (refused.ok) continue;
      expect(refused.error.code).toBe(code);
    }
    const unknown = renameParameter(
      document.parameters,
      createParameterId("param_ghost"),
      "anything",
    );
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) {
      expect(unknown.error.code).toBe(PARAMETER_ERROR_CODES.notFound);
    }
  });

  it("renaming a parameter to its own current name changes nothing", () => {
    const document = lifecycleDocument();
    const renamed = requireOk(
      renameParameter(document.parameters, baseId, "plateWidth"),
      "the no-op rename",
    );
    expect(renamed.parameters.map((parameter) => parameter.name)).toEqual([
      "plateWidth",
      "plateDepth",
      "spare",
    ]);
    expect(
      dependenciesOf({ ...document, parameters: renamed }, dependentId),
    ).toEqual(["plateWidth"]);
  });

  it("leaves the original collection untouched (purity)", () => {
    const document = lifecycleDocument();
    renameParameter(document.parameters, baseId, "shelfWidth");
    expect(requireDocumentParameter(document, baseId, "the base").name).toBe(
      "plateWidth",
    );
    expect(dependenciesOf(document, dependentId)).toEqual(["plateWidth"]);
  });

  it("the dependency graph is name-isomorphic: edges are identical before and after", () => {
    // The no-cycle-preserved argument, pinned: edges are derived by
    // resolving expression names to ids, and the rename moves the name and
    // the references together, so resolution is unchanged — a diamond over
    // `base` keeps its exact edge map through the rename.
    let document = lifecycleDocument();
    document = requireOk(
      applyCommand(document, {
        type: "parameter.set",
        id: otherId,
        expression: requireExpression("plateWidth + plateDepth"),
      }),
      "the diamond's second branch",
    );
    const before = parameterDependencyEdges(document.parameters);
    const renamed = requireOk(
      renameDocumentParameter(document, baseId, "shelfWidth"),
      "the rename",
    );
    const after = parameterDependencyEdges(renamed.parameters);
    expect([...after.entries()]).toEqual([...before.entries()]);
    expect(after.get(baseId)).toEqual([]);
    expect([...(after.get(dependentId) ?? [])]).toEqual([baseId]);
    expect([...(after.get(otherId) ?? [])]).toEqual([baseId, dependentId]);
    expect(findParameterCycle(renamed.parameters)).toBeNull();
  });
});

describe("the document rename substrate", () => {
  it("renames through the document, leaving feature inputs (BY ID) untouched", () => {
    let document = lifecycleDocument();
    document = requireOk(
      addFeature(document, {
        id: featId,
        kind: "box",
        inputs: [{ kind: "parameter", id: baseId }],
        outputs: [],
      }),
      "the consuming feature",
    ).document;
    const renamed = requireOk(
      renameDocumentParameter(document, baseId, "shelfWidth"),
      "the rename",
    );
    expect(requireDocumentParameter(renamed, baseId, "the base").name).toBe(
      "shelfWidth",
    );
    expect(dependenciesOf(renamed, dependentId)).toEqual(["shelfWidth"]);
    // The feature's input still names the SAME parameter id — rename is
    // expression-lexical, the id space is untouched.
    expect(renamed.features[0]?.inputs).toEqual([
      { kind: "parameter", id: baseId },
    ]);
  });

  it("refuses with parameter/cycle when a pre-existing dangling reference closes", () => {
    // The one reachable cycle corner: a stored expression referencing a name
    // NO parameter owns (possible only through the bulk substrate, never the
    // command vocabulary) starts resolving once the rename gives that name
    // an owner. The guard refuses with the closing chain instead of
    // completing a silently-cycling graph.
    let document = lifecycleDocument();
    // plateDepth := spare * 2 (resolves), spare := ghost * 2 (dangling),
    // plateWidth := plateDepth * 2 — acyclic while ghost is free.
    document = requireOk(
      applyCommand(document, {
        type: "parameter.set",
        id: dependentId,
        expression: requireExpression("spare * 2"),
      }),
      "the middle link",
    );
    const dangling = requireOk(
      updateParameterExpression(
        document.parameters,
        otherId,
        requireExpression("ghost * 2"),
      ),
      "the dangling expression",
    );
    const prepared = requireOk(
      applyCommand(
        { ...document, parameters: dangling },
        {
          type: "parameter.set",
          id: baseId,
          expression: requireExpression("plateDepth * 2"),
        },
      ),
      "the closing link",
    );
    expect(findParameterCycle(prepared.parameters)).toBeNull();
    const refused = renameDocumentParameter(prepared, baseId, "ghost");
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.error.code).toBe(PARAMETER_ERROR_CODES.cycle);
      expect(refused.error.message).toContain(
        "ghost → plateDepth → spare → ghost",
      );
    }
    // The refusal discarded the whole pure transition.
    expect(requireDocumentParameter(prepared, baseId, "the base").name).toBe(
      "plateWidth",
    );
  });
});

describe("the document delete substrate", () => {
  it("deletes an unreferenced parameter", () => {
    const document = lifecycleDocument();
    const removed = requireOk(
      removeDocumentParameter(document, otherId),
      "the delete",
    );
    expect(getParameter(removed.parameters, otherId)).toBeUndefined();
    expect(getParameter(removed.parameters, baseId)).toBeDefined();
  });

  it("refuses an expression-referenced parameter, naming the reader", () => {
    const document = lifecycleDocument();
    const refused = removeDocumentParameter(document, baseId);
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.error.code).toBe(DOCUMENT_ERROR_CODES.inUse);
      expect(refused.error.message).toBe(
        'Parameter "plateWidth" is still referenced: the variable "plateDepth" reads it in its stored expression.',
      );
      expect(refused.error.input).toEqual({
        variables: ["plateDepth"],
        features: [],
      } satisfies ParameterDeleteBlockers);
    }
  });

  it("refuses a feature-consumed parameter, naming the consumer by id and kind", () => {
    let document = lifecycleDocument();
    // Cut the expression reference so the feature is the only blocker.
    document = requireOk(
      applyCommand(document, {
        type: "parameter.set",
        id: dependentId,
        value: length(10),
        expression: null,
      }),
      "the clear",
    );
    document = requireOk(
      addFeature(document, {
        id: featId,
        kind: "pad",
        inputs: [{ kind: "parameter", id: baseId }],
        outputs: [],
      }),
      "the consuming feature",
    ).document;
    const refused = removeDocumentParameter(document, baseId);
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.error.code).toBe(DOCUMENT_ERROR_CODES.inUse);
      expect(refused.error.message).toBe(
        'Parameter "plateWidth" is still referenced: the feature "feat_consumer" (pad) consumes it as an input.',
      );
      expect(refused.error.input).toEqual({
        variables: [],
        features: [{ id: featId, kind: "pad" }],
      } satisfies ParameterDeleteBlockers);
    }
  });

  it("names every blocker of both classes in the ONE refusal", () => {
    let document = lifecycleDocument();
    document = requireOk(
      applyCommand(document, {
        type: "parameter.set",
        id: otherId,
        expression: requireExpression("plateWidth * 2"),
      }),
      "the second reader",
    );
    document = requireOk(
      addFeature(document, {
        id: featId,
        kind: "pad",
        inputs: [{ kind: "parameter", id: baseId }],
        outputs: [],
      }),
      "the consuming feature",
    ).document;
    const refused = removeDocumentParameter(document, baseId);
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.error.message).toBe(
        'Parameter "plateWidth" is still referenced: the variables "plateDepth", "spare" read it in their stored expressions; the feature "feat_consumer" (pad) consumes it as an input.',
      );
      expect(refused.error.input).toEqual({
        variables: ["plateDepth", "spare"],
        features: [{ id: featId, kind: "pad" }],
      } satisfies ParameterDeleteBlockers);
    }
  });

  it("reports unknown ids with the collection's not-found code", () => {
    const refused = removeDocumentParameter(
      lifecycleDocument(),
      createParameterId("param_ghost"),
    );
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.error.code).toBe(PARAMETER_ERROR_CODES.notFound);
    }
  });
});

describe("the rename and delete commands", () => {
  it("parameter.rename rewrites the stored expressions and changes no cached value", () => {
    const document = lifecycleDocument();
    const next = requireOk(
      applyCommand(document, {
        type: "parameter.rename",
        id: baseId,
        name: "shelfWidth",
      }),
      "the rename command",
    );
    expect(requireDocumentParameter(next, baseId, "the base").name).toBe(
      "shelfWidth",
    );
    expect(dependenciesOf(next, dependentId)).toEqual(["shelfWidth"]);
    expect(
      requireDocumentParameter(next, dependentId, "the dependent").value,
    ).toBe(10);
    expect(
      getParameter(next.parameters, dependentId)?.expression,
    ).not.toBeNull();
  });

  it("parameter.delete removes an unreferenced parameter", () => {
    const document = lifecycleDocument();
    const next = requireOk(
      applyCommand(document, { type: "parameter.delete", id: otherId }),
      "the delete command",
    );
    expect(getParameter(next.parameters, otherId)).toBeUndefined();
  });

  it("parameter.delete refuses while referenced, surfacing the blockers", () => {
    const document = lifecycleDocument();
    const refused = applyCommand(document, {
      type: "parameter.delete",
      id: baseId,
    });
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.error.code).toBe(DOCUMENT_ERROR_CODES.inUse);
      expect(refused.error.message).toContain("plateDepth");
    }
    // The refused delete was a never-happened delete.
    expect(getParameter(document.parameters, baseId)).toBeDefined();
  });

  it("parameter.rename refuses the name rules with the structured codes", () => {
    const document = lifecycleDocument();
    const refused = applyCommand(document, {
      type: "parameter.rename",
      id: baseId,
      name: "plateDepth",
    });
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.error.code).toBe(PARAMETER_ERROR_CODES.nameConflict);
    }
  });
});

describe("the rename and delete wire forms", () => {
  it("serializes to the fixed shape and round-trips through parseCommand", () => {
    const rename: CadCommand = {
      type: "parameter.rename",
      id: baseId,
      name: "shelfWidth",
    };
    expect(JSON.parse(JSON.stringify(serializeCommand(rename)))).toEqual({
      formatVersion: 1,
      type: "parameter.rename",
      id: baseId,
      name: "shelfWidth",
    });
    expect(requireOk(parseCommand(serializeCommand(rename)), "parse")).toEqual(
      rename,
    );
    const del: CadCommand = { type: "parameter.delete", id: baseId };
    expect(JSON.parse(JSON.stringify(serializeCommand(del)))).toEqual({
      formatVersion: 1,
      type: "parameter.delete",
      id: baseId,
    });
    expect(requireOk(parseCommand(serializeCommand(del)), "parse")).toEqual(
      del,
    );
  });

  it("parses strictly: bad ids, empty names, and unknown types refuse structurally", () => {
    const base = {
      formatVersion: 1,
      type: "parameter.rename",
      id: baseId,
      name: "shelfWidth",
    };
    expect(parseCommand({ ...base, id: "body_000001" }).ok).toBe(false);
    const badId = parseCommand({ ...base, id: "body_000001" });
    if (!badId.ok) {
      expect(badId.error.code).toBe(COMMAND_ERROR_CODES.malformed);
    }
    const emptyName = parseCommand({ ...base, name: "" });
    expect(emptyName.ok).toBe(false);
    if (!emptyName.ok) {
      expect(emptyName.error.code).toBe(COMMAND_ERROR_CODES.malformed);
    }
    const nonStringName = parseCommand({ ...base, name: 7 });
    expect(nonStringName.ok).toBe(false);
    const deleteBadId = parseCommand({
      formatVersion: 1,
      type: "parameter.delete",
      id: "not-an-id",
    });
    expect(deleteBadId.ok).toBe(false);
    if (!deleteBadId.ok) {
      expect(deleteBadId.error.code).toBe(COMMAND_ERROR_CODES.malformed);
    }
    const wrongVersion = parseCommand({ ...base, formatVersion: 2 });
    expect(wrongVersion.ok).toBe(false);
    if (!wrongVersion.ok) {
      expect(wrongVersion.error.code).toBe(
        COMMAND_ERROR_CODES.versionUnsupported,
      );
    }
    const unknownType = parseCommand({
      formatVersion: 1,
      type: "parameter.renam",
      id: baseId,
      name: "shelfWidth",
    });
    expect(unknownType.ok).toBe(false);
    if (!unknownType.ok) {
      expect(unknownType.error.code).toBe(COMMAND_ERROR_CODES.typeUnknown);
    }
    // Unknown fields stay ignored (forward compatibility).
    expect(
      requireOk(
        parseCommand({ ...base, futureField: 1 }),
        "the tolerant parse",
      ),
    ).toEqual({ type: "parameter.rename", id: baseId, name: "shelfWidth" });
  });
});

describe("the native format with the lifecycle commands", () => {
  /** Builds a session whose log carries a rename and a delete. */
  function lifecycleSession() {
    let session = createSession(lifecycleDocument());
    session = requireOk(
      applySessionTransaction(session, {
        commands: [
          {
            type: "parameter.rename",
            id: baseId,
            name: "shelfWidth",
          } satisfies CadCommand,
        ],
      }),
      "the rename commit",
    );
    session = requireOk(
      applySessionTransaction(session, {
        commands: [
          { type: "parameter.delete", id: otherId } satisfies CadCommand,
        ],
      }),
      "the delete commit",
    );
    return session;
  }

  it("replays a log carrying both commands and round-trips byte-identically", () => {
    const session = lifecycleSession();
    expect(
      requireDocumentParameter(session.document, baseId, "the base").name,
    ).toBe("shelfWidth");
    expect(dependenciesOf(session.document, dependentId)).toEqual([
      "shelfWidth",
    ]);
    expect(getParameter(session.document.parameters, otherId)).toBeUndefined();

    const native = requireOk(
      createNativeCadDocument(session.document),
      "the native wrap",
    );
    const carried = { ...native, history: session.history };
    const text = stringifyNativeCadDocument(
      serializeNativeCadDocument(carried),
    );
    expect(text).toContain('"parameter.rename"');
    expect(text).toContain('"parameter.delete"');
    const validation = validateNativeCadDocument(JSON.parse(text));
    expect(validation.valid).toBe(true);
    expect(validation.issues).toEqual([]);
    const reparsed = requireOk(
      parseNativeCadDocumentFromBytes(encodeNativeCadDocument(carried)),
      "the byte round trip",
    );
    expect(
      stringifyNativeCadDocument(serializeNativeCadDocument(reparsed)),
    ).toBe(text);
  });

  it("a v7-stamped copy migrates (identity) and replays through the new commands", () => {
    const session = lifecycleSession();
    const native = requireOk(
      createNativeCadDocument(session.document),
      "the native wrap",
    );
    const text = stringifyNativeCadDocument(
      serializeNativeCadDocument({ ...native, history: session.history }),
    );
    expect(CAD_NATIVE_FORMAT_VERSION).toBeGreaterThan(7);
    const asV7 = {
      ...(JSON.parse(text) as Record<string, unknown>),
      formatVersion: 7,
    };
    const migrated = requireOk(migrateNativeCadDocument(asV7), "the migration");
    expect(migrated).toMatchObject({
      formatVersion: CAD_NATIVE_FORMAT_VERSION,
    });
    const reparsed = requireOk(
      parseNativeCadDocumentFromString(
        stringifyNativeCadDocument(
          migrated as ReturnType<typeof serializeNativeCadDocument>,
        ),
      ),
      "the migrated parse",
    );
    expect(JSON.stringify(serializeCadDocument(reparsed.document))).toBe(
      JSON.stringify(serializeCadDocument(session.document)),
    );
  });

  it("identical command runs land on byte-identical documents (replay determinism)", () => {
    const commands: readonly CadCommand[] = [
      { type: "parameter.rename", id: baseId, name: "shelfWidth" },
      { type: "parameter.delete", id: otherId },
    ];
    const run = (): string => {
      let document = lifecycleDocument();
      for (const command of commands) {
        document = requireOk(applyCommand(document, command), "the run");
      }
      return JSON.stringify(serializeCadDocument(document));
    };
    expect(run()).toBe(run());
  });
});
