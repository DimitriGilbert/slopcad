/**
 * The Phase 49 surface-scene plan reader: the document's LATEST
 * surface-family feature becomes a {@link SheetBuildPlan} whose node
 * shapes mirror the executor bridge's input layouts verbatim — the patch
 * leaf (datum placement + u/v bounds), and the trim/thicken/knit/offset
 * inner nodes over their operand plans. The unit under test is the PLAN
 * MIRROR (the sheet-scene tests execute the plans); these tests pin the
 * document-reading side: parameter resolution, operand chaining, the
 * latest-feature selection, and the honest null ladder.
 */

import { describe, expect, it } from "vitest";
import {
  addBody,
  addDocumentDatum,
  addDocumentParameter,
  addFeature,
  createBodyId,
  createDatumId,
  createDocument,
  createDocumentId,
  createFeatureId,
  createParameterId,
  dimensionless,
  length as lengthValue,
  type BodyId,
  type CadDocument,
  type FeatureId,
  type ParameterId,
} from "@slopcad/cad-core";

import { documentSheetSceneRequest } from "./surface-scene";

const DOC_ID = createDocumentId("doc_surface_scene");
const DATUM_ID = createDatumId("dtm_surface_scene");

const bBase = createBodyId("body_surface_base");
const bTool = createBodyId("body_surface_tool");
const bTrim = createBodyId("body_surface_trim");
const bWall = createBodyId("body_surface_wall");
const bKnit = createBodyId("body_surface_knit");
const bOffset = createBodyId("body_surface_offset");

const fBase = createFeatureId("feat_scene_base");
const fTool = createFeatureId("feat_scene_tool");
const fTrim = createFeatureId("feat_scene_trim");
const fThicken = createFeatureId("feat_scene_thicken");
const fKnit = createFeatureId("feat_scene_knit");
const fOffset = createFeatureId("feat_scene_offset");

const pKind = createParameterId("param_scene_kind");
const pUMin = createParameterId("param_scene_umin");
const pUMax = createParameterId("param_scene_umax");
const pVMin = createParameterId("param_scene_vmin");
const pVMax = createParameterId("param_scene_vmax");
const pKeep = createParameterId("param_scene_keep");
const pKeepOut = createParameterId("param_scene_keep_out");
const pThickness = createParameterId("param_scene_wall");
const pSide = createParameterId("param_scene_side");
const pSideDown = createParameterId("param_scene_side_down");
const pTolerance = createParameterId("param_scene_tol");
const pDistance = createParameterId("param_scene_distance");
const pDistanceIn = createParameterId("param_scene_distance_in");
const pKindCylinder = createParameterId("param_scene_kind_cylinder");

/** The shared document: one datum plane, every parameter the family reads. */
function baseDocument(): CadDocument {
  let document = createDocument(DOC_ID);
  const datum = addDocumentDatum(document, {
    id: DATUM_ID,
    name: "Base plane",
    datum: {
      formatVersion: 1,
      datumType: "plane",
      definition: "originFrame",
      origin: [0, 0, 0],
      normal: [0, 0, 1],
      xAxis: [1, 0, 0],
    } as const,
  });
  if (!datum.ok) throw new Error(datum.error.message);
  document = datum.value.document;
  const params: readonly {
    readonly id: typeof pKind;
    readonly dimension: "length" | "dimensionless";
    readonly value: number;
  }[] = [
    { id: pKind, dimension: "dimensionless", value: 0 },
    { id: pKindCylinder, dimension: "dimensionless", value: 1 },
    { id: pUMin, dimension: "length", value: 0 },
    { id: pUMax, dimension: "length", value: 30 },
    { id: pVMin, dimension: "length", value: 0 },
    { id: pVMax, dimension: "length", value: 20 },
    { id: pKeep, dimension: "dimensionless", value: 1 },
    { id: pKeepOut, dimension: "dimensionless", value: 0 },
    { id: pThickness, dimension: "length", value: 2 },
    { id: pSide, dimension: "dimensionless", value: 1 },
    { id: pSideDown, dimension: "dimensionless", value: -1 },
    { id: pTolerance, dimension: "length", value: 0.001 },
    { id: pDistance, dimension: "length", value: 3 },
    { id: pDistanceIn, dimension: "length", value: -3 },
  ];
  for (const parameter of params) {
    const added = addDocumentParameter(document, {
      id: parameter.id,
      name: parameter.id.slice(-6),
      value:
        parameter.dimension === "length"
          ? lengthValue(parameter.value)
          : dimensionless(parameter.value),
    });
    if (!added.ok) throw new Error(added.error.message);
    document = added.value.document;
  }
  // Every body the features below output (addFeature requires the body
  // record to exist — the bridge test's own discipline).
  const bodies: readonly { readonly id: BodyId; readonly name: string }[] = [
    { id: bBase, name: "base sheet" },
    { id: bTool, name: "tool sheet" },
    { id: bTrim, name: "trimmed sheet" },
    { id: bWall, name: "thickened wall" },
    { id: bKnit, name: "knitted sheet" },
    { id: bOffset, name: "offset sheet" },
  ];
  for (const body of bodies) {
    const added = addBody(document, { id: body.id, name: body.name });
    if (!added.ok) throw new Error(added.error.message);
    document = added.value.document;
  }
  return document;
}

/** Appends a `create-sheet` feature (the given output body + kind parameter). */
function withSheetFeature(
  document: CadDocument,
  featureId: FeatureId,
  output: BodyId,
  kindParameter: ParameterId,
): CadDocument {
  const featured = addFeature(document, {
    id: featureId,
    kind: "create-sheet",
    inputs: [
      { kind: "datum", id: DATUM_ID },
      { kind: "parameter", id: kindParameter },
      { kind: "parameter", id: pUMin },
      { kind: "parameter", id: pUMax },
      { kind: "parameter", id: pVMin },
      { kind: "parameter", id: pVMax },
    ],
    outputs: [output],
  });
  if (!featured.ok) throw new Error(featured.error.message);
  return featured.value.document;
}

describe("documentSheetSceneRequest: the plan mirror (Phase 49)", () => {
  it("reads a create-sheet feature as the datum-bound patch leaf", () => {
    const document = withSheetFeature(baseDocument(), fBase, bBase, pKind);
    const request = documentSheetSceneRequest(document);
    expect(request?.bodyId).toBe(bBase);
    expect(request?.plan.kind).toBe("patch");
    if (request?.plan.kind !== "patch") return;
    expect(request.plan.input.kind).toBe("plane");
    if (request.plan.input.kind !== "plane") return;
    const input = request.plan.input;
    // The datum frame at the identity: translation zero, z-axis rotation 0.
    expect(input.placement.translation).toEqual({
      x: lengthValue(0),
      y: lengthValue(0),
      z: lengthValue(0),
    });
    expect(input.placement.rotation.angle.value).toBe(0);
    expect(input.placement.rotation.axis).toEqual([0, 0, 1]);
    // The four bounds, in the bridge's own input order.
    expect(input.uMin).toEqual(lengthValue(0));
    expect(input.uMax).toEqual(lengthValue(30));
    expect(input.vMin).toEqual(lengthValue(0));
    expect(input.vMax).toEqual(lengthValue(20));
  });

  it("reads a trim feature as the nested plan over both operands, keep side 1 = inside", () => {
    let document = withSheetFeature(baseDocument(), fBase, bBase, pKind);
    document = withSheetFeature(document, fTool, bTool, pKind);
    const featured = addFeature(document, {
      id: fTrim,
      kind: "trim-surface",
      inputs: [
        { kind: "body", id: bBase },
        { kind: "body", id: bTool },
        { kind: "parameter", id: pKeep },
      ],
      outputs: [bTrim],
    });
    if (!featured.ok) throw new Error(featured.error.message);
    const request = documentSheetSceneRequest(featured.value.document);
    expect(request?.bodyId).toBe(bTrim);
    const plan = request?.plan;
    expect(plan?.kind).toBe("trim");
    if (plan?.kind !== "trim") return;
    expect(plan.keepInside).toBe(true);
    // The operands mirror their producing features' patch plans.
    expect(plan.sheet.kind).toBe("patch");
    if (plan.sheet.kind !== "patch") return;
    expect(plan.sheet.input.kind).toBe("plane");
    expect(plan.tool.kind).toBe("patch");
    if (plan.tool.kind !== "patch") return;
    expect(plan.tool.input.kind).toBe("plane");
  });

  it("reads keep side 0 as keepInside false (the inverted keep)", () => {
    let document = withSheetFeature(baseDocument(), fBase, bBase, pKind);
    document = withSheetFeature(document, fTool, bTool, pKind);
    const featured = addFeature(document, {
      id: fTrim,
      kind: "trim-surface",
      inputs: [
        { kind: "body", id: bBase },
        { kind: "body", id: bTool },
        { kind: "parameter", id: pKeepOut },
      ],
      outputs: [bTrim],
    });
    if (!featured.ok) throw new Error(featured.error.message);
    const request = documentSheetSceneRequest(featured.value.document);
    const plan = request?.plan;
    expect(plan?.kind).toBe("trim");
    if (plan?.kind !== "trim") return;
    expect(plan.keepInside).toBe(false);
  });

  it("reads a thicken feature over the trimmed chain with the wall and side", () => {
    let document = withSheetFeature(baseDocument(), fBase, bBase, pKind);
    document = withSheetFeature(document, fTool, bTool, pKind);
    const trimmed = addFeature(document, {
      id: fTrim,
      kind: "trim-surface",
      inputs: [
        { kind: "body", id: bBase },
        { kind: "body", id: bTool },
        { kind: "parameter", id: pKeep },
      ],
      outputs: [bTrim],
    });
    if (!trimmed.ok) throw new Error(trimmed.error.message);
    const thickened = addFeature(trimmed.value.document, {
      id: fThicken,
      kind: "thicken-surface",
      inputs: [
        { kind: "body", id: bTrim },
        { kind: "parameter", id: pThickness },
        { kind: "parameter", id: pSide },
      ],
      outputs: [bWall],
    });
    if (!thickened.ok) throw new Error(thickened.error.message);
    const request = documentSheetSceneRequest(thickened.value.document);
    expect(request?.bodyId).toBe(bWall);
    const plan = request?.plan;
    expect(plan?.kind).toBe("thicken");
    if (plan?.kind !== "thicken") return;
    expect(plan.thicknessMm).toBe(2);
    expect(plan.side).toBe(1);
    // The operand chain keeps its depth: thicken(trim(patch, patch)).
    expect(plan.sheet.kind).toBe("trim");

    // The mirrored side: −1 reads verbatim.
    const down = addFeature(trimmed.value.document, {
      id: fThicken,
      kind: "thicken-surface",
      inputs: [
        { kind: "body", id: bTrim },
        { kind: "parameter", id: pThickness },
        { kind: "parameter", id: pSideDown },
      ],
      outputs: [bWall],
    });
    if (!down.ok) throw new Error(down.error.message);
    const downPlan = documentSheetSceneRequest(down.value.document)?.plan;
    expect(downPlan?.kind).toBe("thicken");
    if (downPlan?.kind !== "thicken") return;
    expect(downPlan.side).toBe(-1);
  });

  it("reads a knit feature as the multi-operand node with the sewing tolerance", () => {
    let document = withSheetFeature(baseDocument(), fBase, bBase, pKind);
    document = withSheetFeature(document, fTool, bTool, pKind);
    const featured = addFeature(document, {
      id: fKnit,
      kind: "knit-surface",
      inputs: [
        { kind: "body", id: bBase },
        { kind: "body", id: bTool },
        { kind: "parameter", id: pTolerance },
      ],
      outputs: [bKnit],
    });
    if (!featured.ok) throw new Error(featured.error.message);
    const request = documentSheetSceneRequest(featured.value.document);
    expect(request?.bodyId).toBe(bKnit);
    const plan = request?.plan;
    expect(plan?.kind).toBe("knit");
    if (plan?.kind !== "knit") return;
    expect(plan.bodies).toHaveLength(2);
    expect(plan.bodies.every((body) => body.kind === "patch")).toBe(true);
    expect(plan.toleranceMm).toBe(0.001);
  });

  it("reads an offset feature with the signed distance verbatim", () => {
    const document = withSheetFeature(baseDocument(), fBase, bBase, pKind);
    const outward = addFeature(document, {
      id: fOffset,
      kind: "offset-surface",
      inputs: [
        { kind: "body", id: bBase },
        { kind: "parameter", id: pDistance },
      ],
      outputs: [bOffset],
    });
    if (!outward.ok) throw new Error(outward.error.message);
    const outwardPlan = documentSheetSceneRequest(outward.value.document)?.plan;
    expect(outwardPlan?.kind).toBe("offset");
    if (outwardPlan?.kind !== "offset") return;
    expect(outwardPlan.distanceMm).toBe(3);

    const inward = addFeature(document, {
      id: fOffset,
      kind: "offset-surface",
      inputs: [
        { kind: "body", id: bBase },
        { kind: "parameter", id: pDistanceIn },
      ],
      outputs: [bOffset],
    });
    if (!inward.ok) throw new Error(inward.error.message);
    const inwardPlan = documentSheetSceneRequest(inward.value.document)?.plan;
    expect(inwardPlan?.kind).toBe("offset");
    if (inwardPlan?.kind !== "offset") return;
    expect(inwardPlan.distanceMm).toBe(-3);
  });

  it("selects the LAST surface feature's output body", () => {
    let document = withSheetFeature(baseDocument(), fBase, bBase, pKind);
    document = withSheetFeature(document, fTool, bTool, pKind);
    const request = documentSheetSceneRequest(document);
    expect(request?.bodyId).toBe(bTool);
  });

  it("answers null for a document with no surface features", () => {
    expect(documentSheetSceneRequest(baseDocument())).toBeNull();
  });

  it("answers null for a kind the tab does not author (the honest ladder)", () => {
    // The cylinder kind index: deeper analytic kinds are not authored by
    // the plan reader yet — the honest null, not a fabricated plan.
    const document = withSheetFeature(
      baseDocument(),
      fBase,
      bBase,
      pKindCylinder,
    );
    expect(documentSheetSceneRequest(document)).toBeNull();
  });
});
