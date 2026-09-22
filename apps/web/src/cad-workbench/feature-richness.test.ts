/**
 * The workbench Phase 41 feature-richness wiring tests: the document
 * readers that turn the rib, scale, thicken, and split features into
 * their worker-scene requests (each paired with the LAST extrude, the
 * thread precedent), the extrude reader's optional taper parameter, and
 * the action-time validation batteries' structured refusals.
 */

import { describe, expect, it } from "vitest";
import {
  addBody,
  addDocumentDatum,
  addDocumentParameter,
  addDocumentSketch,
  addFeature,
  angle,
  createBodyId,
  createDocument,
  createDocumentId,
  createFeatureId,
  createParameterId,
  createSketchDocumentId,
  dimensionless,
  length,
  type CadDocument,
  type FeatureRecordInput,
} from "@slopcad/cad-core";
import {
  createLineEntity,
  createSketch,
  createSketchEntityId,
  serializeSketch,
  xyWorkplane,
  type Sketch,
} from "@slopcad/cad-sketch";

import { documentExtrudeRequest } from "./extrude";
import { documentRibSceneRequest, validateRibSubmission } from "./rib";
import {
  documentScaleSceneRequest,
  documentThickenSceneRequest,
  validateScaleSubmission,
  validateSplitSubmission,
  validateThickenSubmission,
} from "./scale-thicken";
import { documentSplitSceneRequest } from "./split";

function squareSketch(half: number): Sketch {
  const created = createSketch(
    xyWorkplane(),
    [
      createLineEntity(
        createSketchEntityId(`skent_${half}-a`),
        { x: -half, y: -half },
        { x: half, y: -half },
      ),
      createLineEntity(
        createSketchEntityId(`skent_${half}-b`),
        { x: half, y: -half },
        { x: half, y: half },
      ),
      createLineEntity(
        createSketchEntityId(`skent_${half}-c`),
        { x: half, y: half },
        { x: -half, y: half },
      ),
      createLineEntity(
        createSketchEntityId(`skent_${half}-d`),
        { x: -half, y: half },
        { x: -half, y: -half },
      ),
    ],
    [],
  );
  if (!created.ok) throw new Error(created.error.message);
  return created.value;
}

const pDepth = createParameterId("param_fr_depth");
const bBase = createBodyId("body_fr_base");
const fBase = createFeatureId("feat_fr_base");

/** The base document: one saved sketch, one extrude feature. */
function baseDocument(taperDeg?: number): CadDocument {
  let document = createDocument(createDocumentId("doc_workbench_richness"));
  const added = addDocumentSketch(document, {
    id: createSketchDocumentId("skd_profile"),
    name: "profile",
    sketch: serializeSketch(squareSketch(3)) as unknown as Record<
      string,
      unknown
    >,
  });
  if (!added.ok) throw new Error(added.error.message);
  document = added.value.document;
  const parameter = addDocumentParameter(document, {
    id: pDepth,
    name: "depth",
    value: length(10),
  });
  if (!parameter.ok) throw new Error(parameter.error.message);
  document = parameter.value.document;
  const body = addBody(document, { id: bBase, name: "base" });
  if (!body.ok) throw new Error(body.error.message);
  document = body.value.document;
  const baseInputs: FeatureRecordInput["inputs"] = [
    { kind: "sketch", id: createSketchDocumentId("skd_profile") },
    { kind: "parameter", id: pDepth },
  ];
  const pTaper = createParameterId("param_fr_taper");
  if (taperDeg !== undefined) {
    const taper = addDocumentParameter(document, {
      id: pTaper,
      name: "taper",
      value: angle(taperDeg, "deg"),
    });
    if (!taper.ok) throw new Error(taper.error.message);
    document = taper.value.document;
  }
  const inputs: FeatureRecordInput["inputs"] =
    taperDeg === undefined
      ? baseInputs
      : [...baseInputs, { kind: "parameter", id: pTaper }];
  const featured = addFeature(document, {
    id: fBase,
    kind: "extrude",
    inputs,
    outputs: [bBase],
  });
  if (!featured.ok) throw new Error(featured.error.message);
  return featured.value.document;
}

describe("the extrude reader's draft taper (Phase 41)", () => {
  it("carries the angle parameter's radians into the scene request", () => {
    const request = documentExtrudeRequest(baseDocument(5));
    expect(request).not.toBeNull();
    expect(request?.taperRad).toBeCloseTo((5 * Math.PI) / 180, 12);
  });

  it("omits the field for the plain extrude and the zero angle", () => {
    const plain = documentExtrudeRequest(baseDocument());
    expect(plain?.taperRad).toBeUndefined();
    const zero = documentExtrudeRequest(baseDocument(0));
    expect(zero?.taperRad).toBeUndefined();
  });
});

describe("documentRibSceneRequest: the scene reader", () => {
  function ribDocument(thicknessMm: number): CadDocument {
    let document = baseDocument();
    const ribSketch = addDocumentSketch(document, {
      id: createSketchDocumentId("skd_rib"),
      name: "rib",
      sketch: serializeSketch(squareSketch(2)) as unknown as Record<
        string,
        unknown
      >,
    });
    if (!ribSketch.ok) throw new Error(ribSketch.error.message);
    document = ribSketch.value.document;
    const pThickness = createParameterId("param_fr_rib");
    const parameter = addDocumentParameter(document, {
      id: pThickness,
      name: "ribThickness",
      value: length(thicknessMm),
    });
    if (!parameter.ok) throw new Error(parameter.error.message);
    document = parameter.value.document;
    const bRib = createBodyId("body_fr_rib");
    const body = addBody(document, { id: bRib, name: "ribbed" });
    if (!body.ok) throw new Error(body.error.message);
    document = body.value.document;
    const featured = addFeature(document, {
      id: createFeatureId("feat_fr_rib"),
      kind: "rib",
      inputs: [
        { kind: "feature", id: fBase },
        { kind: "sketch", id: createSketchDocumentId("skd_rib") },
        { kind: "parameter", id: pThickness },
      ],
      outputs: [bRib],
    });
    if (!featured.ok) throw new Error(featured.error.message);
    return featured.value.document;
  }

  it("pairs the rib with the base extrusion and the profile sketch", () => {
    const request = documentRibSceneRequest(ribDocument(2));
    expect(request).not.toBeNull();
    expect(request?.base.bodyId).toBe(bBase);
    expect(request?.thicknessMm).toBe(2);
    expect(request?.loop).toHaveLength(4);
    expect(request?.bodyId).toBe("body_fr_rib");
  });

  it("returns null without a base extrusion to grow from", () => {
    const document = ribDocument(2);
    const stripped: CadDocument = {
      ...document,
      features: document.features.filter((feature) => feature.id !== fBase),
    };
    expect(documentRibSceneRequest(stripped)).toBeNull();
  });

  it("refuses the non-positive thickness at the action seam", () => {
    expect(validateRibSubmission({ thicknessMm: 0 }).ok).toBe(false);
    expect(validateRibSubmission({ thicknessMm: 2 }).ok).toBe(true);
  });
});

describe("the scale and thicken readers (Phase 41)", () => {
  function singleParameterDocument(
    kind: "scale" | "thicken",
    value: number,
  ): CadDocument {
    let document = baseDocument();
    const pValue = createParameterId(`param_fr_${kind}`);
    const parameter = addDocumentParameter(document, {
      id: pValue,
      name: kind === "scale" ? "factor" : "thickness",
      value: kind === "scale" ? dimensionless(value) : length(value),
    });
    if (!parameter.ok) throw new Error(parameter.error.message);
    document = parameter.value.document;
    const bResult = createBodyId(`body_fr_${kind}`);
    const body = addBody(document, { id: bResult, name: kind });
    if (!body.ok) throw new Error(body.error.message);
    document = body.value.document;
    const featured = addFeature(document, {
      id: createFeatureId(`feat_fr_${kind}`),
      kind,
      inputs: [
        { kind: "feature", id: fBase },
        { kind: "parameter", id: pValue },
      ],
      outputs: [bResult],
    });
    if (!featured.ok) throw new Error(featured.error.message);
    return featured.value.document;
  }

  it("reads the factor against the base extrusion", () => {
    const request = documentScaleSceneRequest(
      singleParameterDocument("scale", 2),
    );
    expect(request).not.toBeNull();
    expect(request?.factor).toBe(2);
    expect(request?.base.bodyId).toBe(bBase);
    expect(request?.bodyId).toBe("body_fr_scale");
  });

  it("reads the wall thickness against the base extrusion", () => {
    const request = documentThickenSceneRequest(
      singleParameterDocument("thicken", 2),
    );
    expect(request).not.toBeNull();
    expect(request?.thicknessMm).toBe(2);
    expect(request?.base.bodyId).toBe(bBase);
    expect(request?.bodyId).toBe("body_fr_thicken");
  });

  it("refuses the impossible submissions at the action seam", () => {
    expect(validateScaleSubmission({ factor: 0 }).ok).toBe(false);
    expect(validateScaleSubmission({ factor: -1 }).ok).toBe(false);
    expect(validateScaleSubmission({ factor: 2 }).ok).toBe(true);
    expect(validateThickenSubmission({ thicknessMm: 0 }).ok).toBe(false);
    expect(validateThickenSubmission({ thicknessMm: 2 }).ok).toBe(true);
  });
});

describe("documentSplitSceneRequest: the scene reader (Phase 41)", () => {
  const SPLIT_PLANE_PAYLOAD = {
    formatVersion: 1,
    datumType: "plane",
    definition: "originFrame",
    origin: [0, 0, 5],
    normal: [0, 0, 1],
    xAxis: [1, 0, 0],
  } as const;

  function splitDocument(side: number): CadDocument {
    let document = baseDocument();
    const pSide = createParameterId("param_fr_split_side");
    const parameter = addDocumentParameter(document, {
      id: pSide,
      name: "splitSide",
      value: dimensionless(side),
    });
    if (!parameter.ok) throw new Error(parameter.error.message);
    document = parameter.value.document;
    const datum = addDocumentDatum(document, {
      id: "dtm_fr_split" as never,
      name: "split plane",
      datum: SPLIT_PLANE_PAYLOAD,
    });
    if (!datum.ok) throw new Error(datum.error.message);
    document = datum.value.document;
    const bSplit = createBodyId("body_fr_split");
    const body = addBody(document, { id: bSplit, name: "split" });
    if (!body.ok) throw new Error(body.error.message);
    document = body.value.document;
    const featured = addFeature(document, {
      id: createFeatureId("feat_fr_split"),
      kind: "split",
      inputs: [
        { kind: "feature", id: fBase },
        { kind: "datum", id: "dtm_fr_split" as never },
        { kind: "parameter", id: pSide },
      ],
      outputs: [bSplit],
    });
    if (!featured.ok) throw new Error(featured.error.message);
    return featured.value.document;
  }

  it("resolves the datum plane and the keep side against the base", () => {
    const request = documentSplitSceneRequest(splitDocument(1));
    expect(request).not.toBeNull();
    expect(request?.plane.origin).toEqual([0, 0, 5]);
    expect(request?.plane.normal).toEqual([0, 0, 1]);
    expect(request?.side).toBe(1);
    expect(request?.base.bodyId).toBe(bBase);
    expect(request?.bodyId).toBe("body_fr_split");
  });

  it("carries the flipped selector", () => {
    const request = documentSplitSceneRequest(splitDocument(-1));
    expect(request?.side).toBe(-1);
  });

  it("refuses the bad selector at the action seam", () => {
    expect(validateSplitSubmission({ side: 1 }).ok).toBe(true);
    expect(validateSplitSubmission({ side: -1 }).ok).toBe(true);
    expect(validateSplitSubmission({ side: 0 as unknown as 1 }).ok).toBe(false);
  });
});
