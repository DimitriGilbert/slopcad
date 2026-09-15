import { describe, expect, it } from "vitest";

import {
  angle,
  CONVERSION_TOLERANCE,
  createParameterId,
  dimensionless,
  EMPTY_PARAMETER_COLLECTION,
  evaluateExpression,
  type ExpressionNode,
  length,
  addParameter,
  findParameterByName,
  getParameter,
  parseExpression,
  parseParameter,
  parseParameterCollection,
  type Parameter,
  type ParameterCollection,
  PARAMETER_ERROR_CODES,
  parameterEnvironment,
  removeParameter,
  serializeParameter,
  serializeParameterCollection,
  updateParameterValue,
  updateParameterExpression,
  updateParameterMetadata,
} from "./index";

const widthId = createParameterId("param_width");
const heightId = createParameterId("param_height");
const countId = createParameterId("param_count");

function parse(source: string): ExpressionNode {
  const parsed = parseExpression(source);
  if (!parsed.ok) throw new Error(parsed.error.message);
  return parsed.value;
}

function collectionWith(...parameters: readonly Parameter[]): ParameterCollection {
  let collection: ParameterCollection = EMPTY_PARAMETER_COLLECTION;
  for (const parameter of parameters) {
    const added = addParameter(collection, parameter);
    if (!added.ok) throw new Error(added.error.message);
    collection = added.value;
  }
  return collection;
}

function expectError(
  result: { readonly ok: boolean; readonly error?: { readonly code: string } },
  code: string,
): void {
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.error?.code).toBe(code);
}

function expectClose(actual: number, expected: number): void {
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(
    CONVERSION_TOLERANCE * Math.max(1, Math.abs(expected)),
  );
}

describe("addParameter", () => {
  it("creates an immutable parameter with defaults", () => {
    const created = addParameter(EMPTY_PARAMETER_COLLECTION, {
      id: widthId,
      name: "width",
      value: length(25.4, "mm"),
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const parameter = getParameter(created.value, widthId);
    expect(parameter).toEqual({
      id: widthId,
      name: "width",
      value: length(25.4, "mm"),
      expression: null,
      metadata: {},
    });
    expect(Object.isFrozen(parameter)).toBe(true);
    expect(Object.isFrozen(created.value.parameters)).toBe(true);
  });

  it("keeps expression and metadata", () => {
    const expression = parse("height * 2");
    const created = addParameter(EMPTY_PARAMETER_COLLECTION, {
      id: widthId,
      name: "width",
      value: length(20),
      expression,
      metadata: { description: "plate width", order: 1 },
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const parameter = getParameter(created.value, widthId);
    expect(parameter?.expression).toEqual(expression);
    expect(parameter?.metadata).toEqual({
      description: "plate width",
      order: 1,
    });
  });

  it("rejects a __proto__ metadata key on both typed and revived input", () => {
    expectError(
      addParameter(EMPTY_PARAMETER_COLLECTION, {
        id: widthId,
        name: "width",
        value: length(1),
        metadata: { ["__proto__"]: "hazard" },
      }),
      PARAMETER_ERROR_CODES.invalidMetadata,
    );
    const revived = JSON.parse(
      '{"id":"param_width","name":"width","value":{"dimension":"length","unit":"mm","value":1},"metadata":{"__proto__":"hazard"}}',
    ) as unknown;
    expectError(parseParameter(revived), PARAMETER_ERROR_CODES.invalidMetadata);
  });

  it("rejects invalid and reserved names", () => {
    for (const name of ["", "9width", "with space", "with-dash", "x".repeat(65)]) {
      const created = addParameter(EMPTY_PARAMETER_COLLECTION, {
        id: widthId,
        name,
        value: length(1),
      });
      expectError(created, PARAMETER_ERROR_CODES.nameInvalid);
    }
    for (const name of ["sqrt", "min", "max"]) {
      const created = addParameter(EMPTY_PARAMETER_COLLECTION, {
        id: widthId,
        name,
        value: length(1),
      });
      expectError(created, PARAMETER_ERROR_CODES.nameReserved);
    }
  });
});

describe("parameter collection CRUD", () => {
  const width: Parameter = {
    id: widthId,
    name: "width",
    value: length(10),
    expression: null,
    metadata: {},
  };
  const height: Parameter = {
    id: heightId,
    name: "height",
    value: length(20),
    expression: parse("width * 2"),
    metadata: {},
  };

  it("adds parameters and rejects duplicate ids and names", () => {
    const collection = collectionWith(width);
    expect(getParameter(collection, widthId)).toEqual(width);
    expect(getParameter(collection, heightId)).toBeUndefined();
    const sameId = addParameter(collection, { ...height, id: widthId });
    expectError(sameId, PARAMETER_ERROR_CODES.idConflict);
    const sameName = addParameter(collection, { ...height, name: "width" });
    expectError(sameName, PARAMETER_ERROR_CODES.nameConflict);
    expect(getParameter(collection, heightId)).toBeUndefined();
  });

  it("reads parameters by id and by name", () => {
    const collection = collectionWith(width, height);
    expect(getParameter(collection, heightId)?.name).toBe("height");
    expect(findParameterByName(collection, "width")?.id).toBe(widthId);
    expect(findParameterByName(collection, "depth")).toBeUndefined();
  });

  it("removes parameters without mutating the original", () => {
    const collection = collectionWith(width, height);
    const removed = removeParameter(collection, widthId);
    expect(removed.ok).toBe(true);
    if (!removed.ok) return;
    expect(getParameter(removed.value, widthId)).toBeUndefined();
    expect(getParameter(removed.value, heightId)).toEqual(height);
    expect(getParameter(collection, widthId)).toEqual(width);
    expectError(
      removeParameter(collection, createParameterId("param_missing")),
      PARAMETER_ERROR_CODES.notFound,
    );
  });

  it("updates values immutably, preserving identity and other fields", () => {
    const collection = collectionWith(width, height);
    const updated = updateParameterValue(collection, widthId, length(15, "cm"));
    expect(updated.ok).toBe(true);
    if (!updated.ok) return;
    expect(getParameter(updated.value, widthId)).toEqual({
      ...width,
      value: length(15, "cm"),
    });
    expect(getParameter(updated.value, heightId)).toEqual(height);
    expect(getParameter(collection, widthId)?.value).toEqual(length(10));
    expectError(
      updateParameterValue(collection, createParameterId("param_missing"), length(1)),
      PARAMETER_ERROR_CODES.notFound,
    );
  });

  it("sets and clears expressions immutably", () => {
    const collection = collectionWith(width);
    const expression = parse("width + 5mm");
    const set = updateParameterExpression(collection, widthId, expression);
    expect(set.ok).toBe(true);
    if (!set.ok) return;
    expect(getParameter(set.value, widthId)?.expression).toEqual(expression);
    expect(getParameter(collection, widthId)?.expression).toBeNull();
    const cleared = updateParameterExpression(set.value, widthId, null);
    expect(cleared.ok).toBe(true);
    if (!cleared.ok) return;
    expect(getParameter(cleared.value, widthId)?.expression).toBeNull();
  });

  it("replaces metadata immutably", () => {
    const collection = collectionWith(width);
    const updated = updateParameterMetadata(collection, widthId, {
      description: "outer width",
    });
    expect(updated.ok).toBe(true);
    if (!updated.ok) return;
    expect(getParameter(updated.value, widthId)?.metadata).toEqual({
      description: "outer width",
    });
    expect(getParameter(collection, widthId)?.metadata).toEqual({});
    expectError(
      updateParameterMetadata(collection, createParameterId("param_missing"), {}),
      PARAMETER_ERROR_CODES.notFound,
    );
  });
});

describe("parameter serialization", () => {
  const width: Parameter = {
    id: widthId,
    name: "width",
    value: length(2.5, "in"),
    expression: parse("height - 1cm"),
    metadata: { description: "plate width", order: 2 },
  };

  it("serializes values canonically and round-trips through JSON", () => {
    const serialized = serializeParameter(width);
    expect(serialized).toEqual({
      id: "param_width",
      name: "width",
      value: { dimension: "length", unit: "mm", value: 63.5 },
      expression: parse("height - 1cm"),
      metadata: { description: "plate width", order: 2 },
    });
    const revived = parseParameter(JSON.parse(JSON.stringify(serialized)));
    expect(revived.ok).toBe(true);
    if (!revived.ok) return;
    expect(revived.value).toEqual({ ...width, value: length(63.5) });
    expect(Object.isFrozen(revived.value)).toBe(true);
  });

  it("round-trips a whole collection preserving order", () => {
    const collection = collectionWith(width, {
      id: countId,
      name: "count",
      value: dimensionless(4),
      expression: null,
      metadata: {},
    });
    const serialized = serializeParameterCollection(collection);
    const revived = parseParameterCollection(
      JSON.parse(JSON.stringify(serialized)),
    );
    expect(revived.ok).toBe(true);
    if (!revived.ok) return;
    expect(revived.value.parameters.map((p) => p.id)).toEqual([
      widthId,
      countId,
    ]);
    const originalWidth = getParameter(collection, widthId);
    expect(originalWidth).toBeDefined();
    expect(getParameter(revived.value, widthId)).toEqual({
      ...originalWidth,
      value: length(63.5),
    });
    expect(getParameter(revived.value, countId)?.value).toEqual(
      dimensionless(4),
    );
  });

  it("rejects malformed persisted parameters", () => {
    expectError(parseParameter(null), PARAMETER_ERROR_CODES.malformed);
    expectError(parseParameter(42), PARAMETER_ERROR_CODES.malformed);
    expectError(
      parseParameter({ id: "nope", name: "width", value: null }),
      PARAMETER_ERROR_CODES.idInvalid,
    );
    expectError(
      parseParameter({
        id: "param_width",
        name: "9width",
        value: { dimension: "length", unit: "mm", value: 1 },
      }),
      PARAMETER_ERROR_CODES.nameInvalid,
    );
    expectError(
      parseParameter({
        id: "param_width",
        name: "sqrt",
        value: { dimension: "length", unit: "mm", value: 1 },
      }),
      PARAMETER_ERROR_CODES.nameReserved,
    );
    expectError(
      parseParameter({
        id: "param_width",
        name: "width",
        value: { dimension: "length", unit: "deg", value: 1 },
      }),
      PARAMETER_ERROR_CODES.invalidValue,
    );
    expectError(
      parseParameter({
        id: "param_width",
        name: "width",
        value: { dimension: "length", unit: "mm", value: Number.NaN },
      }),
      PARAMETER_ERROR_CODES.invalidValue,
    );
    expectError(
      parseParameter({
        id: "param_width",
        name: "width",
        value: { dimension: "length", unit: "mm", value: 1 },
        expression: { kind: "nope" },
      }),
      PARAMETER_ERROR_CODES.invalidExpression,
    );
    expectError(
      parseParameter({
        id: "param_width",
        name: "width",
        value: { dimension: "length", unit: "mm", value: 1 },
        metadata: { broken: [] },
      }),
      PARAMETER_ERROR_CODES.invalidMetadata,
    );
    expectError(
      parseParameter({
        id: "param_width",
        name: "width",
        value: { dimension: "length", unit: "mm", value: 1 },
        metadata: [],
      }),
      PARAMETER_ERROR_CODES.invalidMetadata,
    );
  });

  it("rejects persisted collections with duplicates or wrong shape", () => {
    expectError(
      parseParameterCollection(null),
      PARAMETER_ERROR_CODES.malformed,
    );
    expectError(
      parseParameterCollection({ parameters: "nope" }),
      PARAMETER_ERROR_CODES.malformed,
    );
    const single = serializeParameter(width);
    expectError(
      parseParameterCollection({
        parameters: [single, { ...single, id: "param_other" }],
      }),
      PARAMETER_ERROR_CODES.nameConflict,
    );
    expectError(
      parseParameterCollection({
        parameters: [single, { ...single, name: "other" }],
      }),
      PARAMETER_ERROR_CODES.idConflict,
    );
  });
});

describe("parameterEnvironment", () => {
  it("resolves names to current values without prototype fallthrough", () => {
    const collection = collectionWith(
      { id: widthId, name: "width", value: length(2.5, "in"), expression: null, metadata: {} },
      { id: countId, name: "count", value: dimensionless(3), expression: null, metadata: {} },
    );
    const resolve = parameterEnvironment(collection);
    expect(resolve("width")).toEqual(length(2.5, "in"));
    expect(resolve("__proto__")).toBeUndefined();
    expect(resolve("toString")).toBeUndefined();
    const result = evaluateExpression(parse("width * 2"), resolve);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual(length(127));
  });

  it("composes with expression evaluation end to end", () => {
    const collection = collectionWith(
      { id: widthId, name: "width", value: length(10), expression: null, metadata: {} },
      { id: heightId, name: "height", value: length(20), expression: parse("width * 2"), metadata: {} },
    );
    const resolve = parameterEnvironment(collection);
    const evaluated = evaluateExpression(
      parse("min(width, height) + sqrt(100mm2)"),
      resolve,
    );
    expect(evaluated.ok).toBe(true);
    if (!evaluated.ok) return;
    expect(evaluated.value).toEqual(length(20));
  });

  it("supports angle-typed parameters with unit conversion", () => {
    const collection = collectionWith({
      id: countId,
      name: "tilt",
      value: angle(45, "deg"),
      expression: null,
      metadata: {},
    });
    const resolve = parameterEnvironment(collection);
    const evaluated = evaluateExpression(parse("tilt + 45deg"), resolve);
    expect(evaluated.ok).toBe(true);
    if (!evaluated.ok) return;
    expect(evaluated.value.dimension).toBe("angle");
    expect(evaluated.value.unit).toBe("rad");
    expectClose(evaluated.value.value, Math.PI / 2);
  });
});
