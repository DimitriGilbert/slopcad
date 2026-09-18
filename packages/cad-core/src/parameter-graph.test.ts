import { describe, expect, it } from "vitest";

import {
  createParameterId,
  EMPTY_PARAMETER_COLLECTION,
  findParameterCycle,
  length,
  type Parameter,
  parameterDependencyEdges,
  parseExpression,
  type ParameterCollection,
  addParameter,
} from "./index";

const widthId = createParameterId("param_width");
const heightId = createParameterId("param_height");
const depthId = createParameterId("param_depth");
const areaId = createParameterId("param_area");
const leftId = createParameterId("param_left");
const rightId = createParameterId("param_right");
const rootId = createParameterId("param_root");

function parse(source: string) {
  const parsed = parseExpression(source);
  if (!parsed.ok) throw new Error(parsed.error.message);
  return parsed.value;
}

function collectionWith(
  ...parameters: readonly Parameter[]
): ParameterCollection {
  let collection: ParameterCollection = EMPTY_PARAMETER_COLLECTION;
  for (const parameter of parameters) {
    const added = addParameter(collection, parameter);
    if (!added.ok) throw new Error(added.error.message);
    collection = added.value;
  }
  return collection;
}

const literal = (
  id: ReturnType<typeof createParameterId>,
  name: string,
): Parameter => ({
  id,
  name,
  value: length(10),
  expression: null,
  metadata: {},
});

describe("parameterDependencyEdges", () => {
  it("has no edges for literal-only parameters", () => {
    const collection = collectionWith(literal(widthId, "width"));
    const edges = parameterDependencyEdges(collection);
    expect(edges.get(widthId)).toEqual([]);
  });

  it("resolves expression identifiers to parameter ids", () => {
    const collection = collectionWith(
      literal(widthId, "width"),
      {
        id: heightId,
        name: "height",
        value: length(20),
        expression: parse("width * 2"),
        metadata: {},
      },
      {
        id: depthId,
        name: "depth",
        value: length(5),
        expression: parse("min(width, height) - 1mm"),
        metadata: {},
      },
    );
    const edges = parameterDependencyEdges(collection);
    expect(edges.get(heightId)).toEqual([widthId]);
    expect(edges.get(depthId)).toEqual([widthId, heightId]);
    expect(edges.get(widthId)).toEqual([]);
  });

  it("ignores references that resolve to no parameter", () => {
    const collection = collectionWith({
      id: heightId,
      name: "height",
      value: length(20),
      expression: parse("missing * 2"),
      metadata: {},
    });
    const edges = parameterDependencyEdges(collection);
    expect(edges.get(heightId)).toEqual([]);
  });

  it("covers every parameter including a diamond graph", () => {
    const collection = collectionWith(
      literal(widthId, "width"),
      {
        id: leftId,
        name: "left",
        value: length(1),
        expression: parse("width + 1mm"),
        metadata: {},
      },
      {
        id: rightId,
        name: "right",
        value: length(1),
        expression: parse("width - 1mm"),
        metadata: {},
      },
      {
        id: rootId,
        name: "root",
        value: length(2),
        expression: parse("left + right"),
        metadata: {},
      },
    );
    const edges = parameterDependencyEdges(collection);
    expect(edges.size).toBe(4);
    expect(edges.get(rootId)).toEqual([leftId, rightId]);
    expect(edges.get(leftId)).toEqual([widthId]);
    expect(edges.get(rightId)).toEqual([widthId]);
  });
});

describe("findParameterCycle", () => {
  it("returns null for acyclic collections", () => {
    const acyclic = collectionWith(
      literal(widthId, "width"),
      {
        id: heightId,
        name: "height",
        value: length(20),
        expression: parse("width * 2"),
        metadata: {},
      },
      {
        id: areaId,
        name: "area",
        value: length(200),
        expression: parse("height * width"),
        metadata: {},
      },
    );
    expect(findParameterCycle(acyclic)).toBeNull();
    expect(findParameterCycle(EMPTY_PARAMETER_COLLECTION)).toBeNull();
  });

  it("detects self-references", () => {
    const selfReferencing = collectionWith({
      id: widthId,
      name: "width",
      value: length(10),
      expression: parse("width + 1mm"),
      metadata: {},
    });
    expect(findParameterCycle(selfReferencing)).toEqual([widthId, widthId]);
  });

  it("detects two-parameter and three-parameter cycles", () => {
    const two = collectionWith(
      {
        id: widthId,
        name: "width",
        value: length(10),
        expression: parse("height + 1mm"),
        metadata: {},
      },
      {
        id: heightId,
        name: "height",
        value: length(20),
        expression: parse("width * 2"),
        metadata: {},
      },
    );
    expect(findParameterCycle(two)).toEqual([widthId, heightId, widthId]);

    const three = collectionWith(
      {
        id: widthId,
        name: "width",
        value: length(10),
        expression: parse("depth + 1mm"),
        metadata: {},
      },
      {
        id: heightId,
        name: "height",
        value: length(20),
        expression: parse("width * 2"),
        metadata: {},
      },
      {
        id: depthId,
        name: "depth",
        value: length(5),
        expression: parse("height - 1mm"),
        metadata: {},
      },
    );
    expect(findParameterCycle(three)).toEqual([
      widthId,
      depthId,
      heightId,
      widthId,
    ]);
  });

  it("returns the first cycle in collection order", () => {
    const both = collectionWith(
      {
        id: widthId,
        name: "width",
        value: length(10),
        expression: parse("height + 1mm"),
        metadata: {},
      },
      {
        id: heightId,
        name: "height",
        value: length(20),
        expression: parse("width * 2"),
        metadata: {},
      },
      {
        id: leftId,
        name: "left",
        value: length(1),
        expression: parse("right"),
        metadata: {},
      },
      {
        id: rightId,
        name: "right",
        value: length(1),
        expression: parse("left"),
        metadata: {},
      },
    );
    expect(findParameterCycle(both)).toEqual([widthId, heightId, widthId]);
  });

  it("does not treat shared dependencies as cycles", () => {
    const diamond = collectionWith(
      literal(widthId, "width"),
      {
        id: leftId,
        name: "left",
        value: length(1),
        expression: parse("width + 1mm"),
        metadata: {},
      },
      {
        id: rightId,
        name: "right",
        value: length(1),
        expression: parse("width - 1mm"),
        metadata: {},
      },
      {
        id: rootId,
        name: "root",
        value: length(2),
        expression: parse("left + right"),
        metadata: {},
      },
    );
    expect(findParameterCycle(diamond)).toBeNull();
  });
});
