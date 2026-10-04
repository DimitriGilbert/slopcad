/**
 * The value fields' parameter-reference seam (Phase 21) and its Phase 30
 * negated route: the resolution accepts a literal byte-identically, a bare
 * `$name` reference, and now a `-$name` token resolving the SAME parameter
 * under a distinct kind; the emission mirrors the auto-parameter pattern —
 * the negated slot's `parameter.create` rides the vocabulary's defining
 * expression (`-name`, the seed the negated cache) so a feature input can
 * reference the fresh parameter while the DAG re-derives it from the source
 * variable. The re-drive leg applies the commands to a REAL document and
 * edits the source to prove the negated cache follows.
 */

import { describe, expect, it } from "vitest";
import {
  addDocumentParameter,
  applyCommand,
  createDocument,
  createDocumentId,
  createParameterId,
  findParameterByName,
  length,
  parseExpression,
  printExpression,
  type CadDocument,
} from "@slopcad/cad-core";

import {
  featureSlotCreateCommand,
  featureSlotInputId,
  negatedReferenceCreateCommand,
  resolveFeatureNumberValue,
  type FeatureValueSlot,
} from "./parameter-reference";

const SOURCE_ID = createParameterId("param_case_depth");

/** A document with one length variable, `caseDepth` = 25 mm. */
function buildDocument(): CadDocument {
  const created = addDocumentParameter(
    createDocument(createDocumentId("doc_param_ref")),
    { id: SOURCE_ID, name: "caseDepth", value: length(25) },
  );
  if (!created.ok) throw new Error(created.error.message);
  return created.value.document;
}

const ROLE = { dimension: "length" as const, label: "The extrusion depth" };

/** The slot shape the draft action builds for one value role. */
function slotFor(
  resolution: ReturnType<typeof resolveFeatureNumberValue>,
): FeatureValueSlot {
  if (!resolution.ok || resolution.kind === "number") {
    throw new Error("the fixture resolution must be a reference shape");
  }
  return {
    resolution,
    literalId: createParameterId("param_extrude_depth1"),
    literalName: "extrudeDepth1",
    toLiteralValue: length,
  };
}

describe("resolveFeatureNumberValue", () => {
  it("passes a literal through byte-identically", () => {
    const resolved = resolveFeatureNumberValue(
      4,
      buildDocument().parameters,
      ROLE,
    );
    expect(resolved).toEqual({ ok: true, kind: "number", value: 4 });
  });

  it("resolves a bare token to the existing parameter", () => {
    const resolved = resolveFeatureNumberValue(
      "$caseDepth",
      buildDocument().parameters,
      ROLE,
    );
    if (!resolved.ok || resolved.kind !== "reference") {
      throw new Error("the bare token must resolve as a reference");
    }
    expect(resolved.parameter.name).toBe("caseDepth");
    expect(resolved.parameter.id).toBe(SOURCE_ID);
  });

  it("resolves a negated token to the SAME parameter under the negated kind", () => {
    const resolved = resolveFeatureNumberValue(
      "-$caseDepth",
      buildDocument().parameters,
      ROLE,
    );
    if (!resolved.ok || resolved.kind !== "negatedReference") {
      throw new Error("the negated token must resolve as the negated kind");
    }
    expect(resolved.parameter.name).toBe("caseDepth");
    expect(resolved.parameter.id).toBe(SOURCE_ID);
  });

  it("keeps the refusals byte-identical across the token forms", () => {
    const parameters = buildDocument().parameters;
    const unknown = resolveFeatureNumberValue("-$missing", parameters, ROLE);
    expect(unknown).toEqual({
      ok: false,
      code: "kernel/parameter-invalid",
      message:
        'The extrusion depth: the parameter "missing" does not exist in this document.',
    });
    const malformed = resolveFeatureNumberValue("-$nope!", parameters, ROLE);
    expect(malformed).toEqual({
      ok: false,
      code: "kernel/parameter-invalid",
      message:
        'The extrusion depth: "-$nope!" is neither a finite number nor a $name parameter reference.',
    });
  });
});

describe("the negated slot's emission", () => {
  it("points the feature input at the fresh auto-parameter", () => {
    const resolved = resolveFeatureNumberValue(
      "-$caseDepth",
      buildDocument().parameters,
      ROLE,
    );
    const slot = slotFor(resolved);
    expect(featureSlotInputId(slot)).toBe("param_extrude_depth1");
  });

  it("keeps the input shapes for the literal and bare reference paths", () => {
    const parameters = buildDocument().parameters;
    const literalSlot: FeatureValueSlot = {
      resolution: { ok: true, kind: "number", value: 4 },
      literalId: createParameterId("param_extrude_depth1"),
      literalName: "extrudeDepth1",
      toLiteralValue: length,
    };
    expect(featureSlotInputId(literalSlot)).toBe("param_extrude_depth1");
    expect(featureSlotCreateCommand(literalSlot)).toEqual({
      type: "parameter.create",
      id: "param_extrude_depth1",
      name: "extrudeDepth1",
      value: { dimension: "length", unit: "mm", value: 4 },
    });
    const reference = resolveFeatureNumberValue("$caseDepth", parameters, ROLE);
    const referenceSlot = slotFor(reference);
    expect(featureSlotInputId(referenceSlot)).toBe(SOURCE_ID);
    expect(featureSlotCreateCommand(referenceSlot)).toBeNull();
  });

  it("creates the negated auto-parameter with the negated seed and the -name expression", () => {
    const resolved = resolveFeatureNumberValue(
      "-$caseDepth",
      buildDocument().parameters,
      ROLE,
    );
    const command = featureSlotCreateCommand(slotFor(resolved));
    // ONE command — the vocabulary's create-with-expression form: the seed
    // is the negation of the source's value (dimension preserved) and the
    // expression is unary minus over the source's name.
    expect(command).toEqual({
      type: "parameter.create",
      id: "param_extrude_depth1",
      name: "extrudeDepth1",
      value: { dimension: "length", unit: "mm", value: -25 },
      expression: {
        kind: "unary",
        operator: "-",
        operand: { kind: "identifier", name: "caseDepth" },
      },
    });
  });

  it("emits the same shape through the structured-hole path's entry point", () => {
    const parameters = buildDocument().parameters;
    const resolved = resolveFeatureNumberValue("-$caseDepth", parameters, ROLE);
    if (!resolved.ok || resolved.kind !== "negatedReference") {
      throw new Error("the fixture resolution must be the negated kind");
    }
    expect(
      negatedReferenceCreateCommand(
        resolved.parameter,
        createParameterId("param_shole_depth1"),
        "holeDepth1",
      ),
    ).toEqual({
      type: "parameter.create",
      id: "param_shole_depth1",
      name: "holeDepth1",
      value: { dimension: "length", unit: "mm", value: -25 },
      expression: {
        kind: "unary",
        operator: "-",
        operand: { kind: "identifier", name: "caseDepth" },
      },
    });
  });

  it("re-drives the negated auto-parameter when the source variable moves", () => {
    // The committed commands against a REAL document: the negated create,
    // then the user's later edits of the source variable.
    const source = findParameterByName(buildDocument().parameters, "caseDepth");
    if (source === undefined) throw new Error("the source parameter is absent");
    const created = applyCommand(
      buildDocument(),
      negatedReferenceCreateCommand(
        source,
        createParameterId("param_extrude_depth1"),
        "extrudeDepth1",
      ),
    );
    if (!created.ok) throw new Error(created.error.message);
    const named = findParameterByName(
      created.value.parameters,
      "extrudeDepth1",
    );
    if (named === undefined) throw new Error("the auto-parameter is absent");
    // The applied cache is the expression's evaluated value (−25), and the
    // stored expression prints as the typed sign.
    expect(named.value.value).toBe(-25);
    expect(
      named.expression === null ? null : printExpression(named.expression),
    ).toBe("-caseDepth");

    // The VALUE-ONLY source edit (the panel's literal arm) moves the
    // source's cache and — the domain's documented rule — recomputes
    // nothing: the negated cache reads stale until an expression commit.
    const literalEdited = applyCommand(created.value, {
      type: "parameter.set",
      id: SOURCE_ID,
      value: length(30),
    });
    if (!literalEdited.ok) throw new Error(literalEdited.error.message);
    const stale = findParameterByName(
      literalEdited.value.parameters,
      "extrudeDepth1",
    );
    if (stale === undefined) throw new Error("the auto-parameter is absent");
    expect(stale.value.value).toBe(-25);

    // THE RE-DRIVE: the source edit through the EXPRESSION arm (a constant
    // with the unit attached — the unit literal keeps the parameter's
    // dimension; the chapter-taught root edit) runs the topological
    // recompute in the same application, and the negated cache follows: −30.
    const parsed = parseExpression("30mm");
    if (!parsed.ok) throw new Error(parsed.error.message);
    const expressionEdited = applyCommand(literalEdited.value, {
      type: "parameter.set",
      id: SOURCE_ID,
      expression: parsed.value,
    });
    if (!expressionEdited.ok) throw new Error(expressionEdited.error.message);
    const redriven = findParameterByName(
      expressionEdited.value.parameters,
      "extrudeDepth1",
    );
    if (redriven === undefined) throw new Error("the auto-parameter is absent");
    expect(redriven.value.value).toBe(-30);
  });
});
