import { describe, expect, it } from "vitest";

import {
  addBody,
  addDocumentParameter,
  addFeature,
  affectedFeatures,
  createBodyId,
  createDocument,
  createDocumentId,
  createFeatureId,
  createParameterId,
  type BodyId,
  type FeatureInputRef,
  featureDependencyEdges,
  featureEvaluationOrder,
  type FeatureId,
  type FeatureRecord,
  findFeatureCycle,
  length,
  type ParameterId,
} from "./index";

const pWidth = createParameterId("param_width");
const pOther = createParameterId("param_other");
const bBase = createBodyId("body_base");

const fSketch = createFeatureId("feat_sketch");
const fPad = createFeatureId("feat_pad");
const fShell = createFeatureId("feat_shell");
const fBore = createFeatureId("feat_bore");
const fA = createFeatureId("feat_a");
const fB = createFeatureId("feat_b");
const fC = createFeatureId("feat_c");
const fD = createFeatureId("feat_d");
const fX = createFeatureId("feat_x");
const fY = createFeatureId("feat_y");

const param = (id: ParameterId): FeatureInputRef => ({ kind: "parameter", id });
const feat = (id: FeatureId): FeatureInputRef => ({ kind: "feature", id });
const body = (id: BodyId): FeatureInputRef => ({ kind: "body", id });

function feature(
  id: FeatureId,
  inputs: readonly FeatureInputRef[] = [],
): FeatureRecord {
  return { id, kind: "solid", inputs, outputs: [] };
}

function orderOf(features: readonly FeatureRecord[]): readonly FeatureId[] {
  const order = featureEvaluationOrder(features);
  if (!order.ok) throw new Error(order.error.message);
  return order.value;
}

describe("featureDependencyEdges", () => {
  it("returns an empty map for no features", () => {
    expect(featureDependencyEdges([]).size).toBe(0);
  });

  it("maps every feature to its declared inputs in declared order", () => {
    const edges = featureDependencyEdges([
      feature(fSketch),
      feature(fPad, [param(pWidth), body(bBase), feat(fSketch)]),
    ]);
    expect(edges.size).toBe(2);
    expect(edges.get(fSketch)).toEqual([]);
    expect(edges.get(fPad)).toEqual([
      param(pWidth),
      body(bBase),
      feat(fSketch),
    ]);
  });

  it("drops feature inputs that reference an absent feature", () => {
    const edges = featureDependencyEdges([feature(fPad, [feat(fSketch)])]);
    expect(edges.get(fPad)).toEqual([]);
  });

  it("preserves duplicate declared inputs as declared", () => {
    const edges = featureDependencyEdges([
      feature(fPad, [param(pWidth), param(pWidth)]),
    ]);
    expect(edges.get(fPad)).toEqual([param(pWidth), param(pWidth)]);
  });
});

describe("findFeatureCycle", () => {
  it("returns null for acyclic feature lists", () => {
    expect(findFeatureCycle([])).toBeNull();
    expect(
      findFeatureCycle([feature(fPad, [feat(fSketch)]), feature(fSketch)]),
    ).toBeNull();
  });

  it("does not treat shared dependencies (diamonds) as cycles", () => {
    const diamond = [
      feature(fA),
      feature(fB, [feat(fA)]),
      feature(fC, [feat(fA)]),
      feature(fD, [feat(fB), feat(fC)]),
    ];
    expect(findFeatureCycle(diamond)).toBeNull();
  });

  it("detects a self-referencing feature", () => {
    expect(findFeatureCycle([feature(fA, [feat(fA)])])).toEqual([fA, fA]);
  });

  it("detects two- and three-feature cycles", () => {
    const two = [feature(fA, [feat(fB)]), feature(fB, [feat(fA)])];
    expect(findFeatureCycle(two)).toEqual([fA, fB, fA]);

    const three = [
      feature(fA, [feat(fB)]),
      feature(fB, [feat(fC)]),
      feature(fC, [feat(fA)]),
    ];
    expect(findFeatureCycle(three)).toEqual([fA, fB, fC, fA]);
  });

  it("returns the first cycle in insertion order", () => {
    const both = [
      feature(fA, [feat(fB)]),
      feature(fB, [feat(fA)]),
      feature(fX, [feat(fY)]),
      feature(fY, [feat(fX)]),
    ];
    expect(findFeatureCycle(both)).toEqual([fA, fB, fA]);
  });
});

describe("featureEvaluationOrder", () => {
  it("orders an empty list successfully", () => {
    expect(orderOf([])).toEqual([]);
  });

  it("orders a linear chain declared in reverse", () => {
    const chain = [
      feature(fShell, [feat(fPad)]),
      feature(fPad, [feat(fSketch)]),
      feature(fSketch),
    ];
    expect(orderOf(chain)).toEqual([fSketch, fPad, fShell]);
  });

  it("breaks ties by document insertion order, not id order", () => {
    const independents = [feature(fC), feature(fA), feature(fB)];
    expect(orderOf(independents)).toEqual([fC, fA, fB]);
  });

  it("orders a branched graph with each feature exactly once", () => {
    const branched = [
      feature(fA),
      feature(fB, [feat(fA)]),
      feature(fC, [feat(fA)]),
      feature(fD, [feat(fB), feat(fC)]),
    ];
    const order = orderOf(branched);
    expect(order).toEqual([fA, fB, fC, fD]);
    expect(new Set(order).size).toBe(4);
  });

  it("orders disconnected components deterministically", () => {
    const disconnected = [
      feature(fA),
      feature(fX),
      feature(fB, [feat(fA)]),
      feature(fY, [feat(fX)]),
    ];
    expect(orderOf(disconnected)).toEqual([fA, fX, fB, fY]);
  });

  it("is a pure function of its input", () => {
    const first = [feature(fB, [feat(fA)]), feature(fA), feature(fC)];
    const second = [feature(fB, [feat(fA)]), feature(fA), feature(fC)];
    expect(orderOf(first)).toEqual([fA, fB, fC]);
    expect(orderOf(second)).toEqual(orderOf(first));
  });

  it("rejects a cycle with its path as a structured failure", () => {
    const cyclic = [
      feature(fA, [feat(fB)]),
      feature(fB, [feat(fA)]),
      feature(fC),
    ];
    const order = featureEvaluationOrder(cyclic);
    expect(order.ok).toBe(false);
    if (order.ok) throw new Error("expected a cycle failure");
    expect(order.error.code).toBe("graph/cycle");
    expect(order.error.cycle).toEqual([fA, fB, fA]);
    expect(order.error.message).toContain("cycle");
  });

  it("rejects a self-referencing feature", () => {
    const order = featureEvaluationOrder([feature(fA, [feat(fA)])]);
    expect(order.ok).toBe(false);
    if (order.ok) throw new Error("expected a cycle failure");
    expect(order.error.cycle).toEqual([fA, fA]);
  });
});

describe("affectedFeatures", () => {
  it("follows a linear chain downstream from a parameter", () => {
    const chain = [
      feature(fSketch, [param(pWidth)]),
      feature(fPad, [feat(fSketch)]),
      feature(fShell, [feat(fPad)]),
    ];
    expect(affectedFeatures(chain, pWidth)).toEqual([fSketch, fPad, fShell]);
    expect(affectedFeatures(chain, fSketch)).toEqual([fPad, fShell]);
    expect(affectedFeatures(chain, fShell)).toEqual([]);
  });

  it("invalidates downstream features only in a branched graph", () => {
    const branched = [
      feature(fSketch, [param(pWidth)]),
      feature(fPad, [feat(fSketch)]),
      feature(fBore, [feat(fPad)]),
      feature(fShell, [param(pWidth)]),
    ];
    const affected = affectedFeatures(branched, fPad);
    expect(affected).toEqual([fBore]);
    expect(affected).not.toContain(fSketch);
    expect(affected).not.toContain(fShell);
  });

  it("does not double-count diamond re-joins", () => {
    const diamond = [
      feature(fA),
      feature(fB, [feat(fA)]),
      feature(fC, [feat(fA)]),
      feature(fD, [feat(fB), feat(fC)]),
    ];
    expect(affectedFeatures(diamond, fA)).toEqual([fB, fC, fD]);
  });

  it("treats a changed body as a source driving its consumers", () => {
    const graph = [
      feature(fSketch, [body(bBase)]),
      feature(fPad, [feat(fSketch)]),
    ];
    expect(affectedFeatures(graph, bBase)).toEqual([fSketch, fPad]);
  });

  it("returns an empty set for nodes nothing depends on", () => {
    const graph = [feature(fSketch, [param(pWidth)])];
    expect(affectedFeatures(graph, pOther)).toEqual([]);
    expect(affectedFeatures([], fA)).toEqual([]);
  });

  it("stays total on a cyclic graph and never reports the changed node", () => {
    const cyclic = [feature(fA, [feat(fB)]), feature(fB, [feat(fA)])];
    expect(affectedFeatures(cyclic, fA)).toEqual([fB]);
  });

  it("excludes a self-referencing changed feature from its own invalidation set", () => {
    const selfLoopWithDependent = [
      feature(fA, [feat(fA)]),
      feature(fB, [feat(fA)]),
    ];
    expect(affectedFeatures(selfLoopWithDependent, fA)).toEqual([fB]);

    const pureSelfLoop = [feature(fA, [feat(fA)])];
    expect(affectedFeatures(pureSelfLoop, fA)).toEqual([]);
  });
});

describe("feature graph over a CadDocument", () => {
  it("derives edges, order, and invalidation from document.features", () => {
    let document = createDocument(createDocumentId("doc_graph"));
    const addedBody = addBody(document, { id: bBase, name: "Base" });
    if (!addedBody.ok) throw new Error(addedBody.error.message);
    document = addedBody.value.document;
    const addedParameter = addDocumentParameter(document, {
      name: "width",
      value: length(10),
    });
    if (!addedParameter.ok) throw new Error(addedParameter.error.message);
    document = addedParameter.value.document;
    const width = addedParameter.value.parameter.id;

    const steps: readonly [FeatureId, readonly FeatureInputRef[]][] = [
      [fSketch, []],
      [fPad, [param(width), feat(fSketch)]],
      [fShell, [feat(fPad), body(bBase)]],
    ];
    for (const [id, inputs] of steps) {
      const added = addFeature(document, {
        id,
        kind: "solid",
        inputs,
        outputs: [],
      });
      if (!added.ok) throw new Error(added.error.message);
      document = added.value.document;
    }

    expect(featureEvaluationOrder(document.features)).toMatchObject({
      ok: true,
      value: [fSketch, fPad, fShell],
    });
    expect(affectedFeatures(document.features, width)).toEqual([fPad, fShell]);
    expect(affectedFeatures(document.features, bBase)).toEqual([fShell]);
  });
});
