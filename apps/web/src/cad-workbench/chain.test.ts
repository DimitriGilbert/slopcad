/**
 * The workbench chain wiring tests (Phase 26 phase-level): the document →
 * chain-scene request derivation — the base through the extrude reader,
 * each hole through the hole reader, each fillet's radius + picked edge
 * ordinal, the feature ids that carry failure attribution — the
 * parameter-edit paths for both the cascade (the extrude depth) and the
 * failure recovery (the fillet radius), the structured nulls for
 * unresolvable layouts — and the chain composition itself against the REAL
 * OpenCascade kernel (in-process over the in-memory worker transport — the
 * `hostOcctWorker` hosting the browser entry wires): every stage's exact
 * analytic volume, the snapshot's corner-edge address, and the oversized-
 * radius failure attributed to the fillet feature with the kernel's
 * structured code.
 */

import { describe, expect, it } from "vitest";
import {
  addBody,
  addDocumentParameter,
  addDocumentSketch,
  addFeature,
  angle,
  applyCommand,
  createBodyId,
  createDocument,
  createDocumentId,
  createFeatureId,
  createParameterId,
  createSketchDocumentId,
  dimensionless,
  length,
  type AnyDimensionalValue,
  type BodyId,
  type CadDocument,
  type FeatureInputRef,
  type FeatureRecord,
} from "@slopcad/cad-core";
import {
  createLineEntity,
  createRectangleEntity,
  createSketch,
  createSketchEntityId,
  serializeSketch,
  xyWorkplane,
} from "@slopcad/cad-sketch";
import {
  createInMemoryTransportPair,
  createStaleResultCoordinator,
  createWorkerClient,
} from "@slopcad/cad-kernel";
import type { WorkerServer } from "@slopcad/cad-kernel";
import { hostOcctWorker } from "@slopcad/cad-kernel-occt/occt-worker";

import {
  ChainStageFailure,
  computeChainScene,
  type ChainScene,
  type ChainSceneRequest,
} from "../worker-fixture/chain-scene";
import {
  chainFilletInputOf,
  documentChainSceneRequest,
  filletBaseFeatureOf,
  CHAIN_FILLET_DEFAULT_RADIUS_MM,
  nextExtrudeInvalidatesChain,
  nextHoleInvalidatesChain,
} from "./chain";
import {
  holeBaseFeatureOf,
  HOLE_DEFAULT_AXIS,
  HOLE_DEFAULT_DEPTH_MM,
  HOLE_DEFAULT_DIAMETER_MM,
} from "./hole";

const DOC = createDocumentId("doc_chain_wiring");
const SKETCH = createSketchDocumentId("skd_profile");
const BASE_BODY = createBodyId("body_pad");
const HOLE_BODY = createBodyId("body_holed");
const FILLET_BODY = createBodyId("body_rounded");
const DEPTH = createParameterId("param_extrude_depth");
const pDiameter = createParameterId("param_hole_diameter");
const pDepth = createParameterId("param_hole_depth");
const pX = createParameterId("param_hole_x");
const pY = createParameterId("param_hole_y");
const pAxis = createParameterId("param_hole_axis");
const pRadius = createParameterId("param_fillet_radius");
const pEdge = createParameterId("param_fillet_edge");
const EXTRUDE = createFeatureId("feat_extrude");
const HOLE = createFeatureId("feat_hole");
const FILLET = createFeatureId("feat_fillet");
/** A feature id no document feature carries (the retarget case). */
const ABSENT_BASE = createFeatureId("feat_absent_base");

/** A 20×15 rectangle sketch on the XY workplane, serialized (the payload). */
function rectangleSketchPayload(): Record<string, unknown> {
  const bottom = createSketchEntityId("skent_c-bottom");
  const right = createSketchEntityId("skent_c-right");
  const top = createSketchEntityId("skent_c-top");
  const left = createSketchEntityId("skent_c-left");
  const created = createSketch(
    xyWorkplane(),
    [
      createLineEntity(bottom, { x: 10, y: 10 }, { x: 30, y: 10 }),
      createLineEntity(right, { x: 30, y: 10 }, { x: 30, y: 25 }),
      createLineEntity(top, { x: 30, y: 25 }, { x: 10, y: 25 }),
      createLineEntity(left, { x: 10, y: 25 }, { x: 10, y: 10 }),
      createRectangleEntity(createSketchEntityId("skent_c-rect"), [
        bottom,
        right,
        top,
        left,
      ]),
    ],
    [],
  );
  if (!created.ok) throw new Error(created.error.message);
  return serializeSketch(created.value) as unknown as Record<string, unknown>;
}

/** One fillet feature's numbers. */
interface FilletNumbers {
  readonly radiusMm: number;
  readonly edgeOrdinal: number;
}

/**
 * Builds the sketch → extrude → hole → fillet document. `fillet` null
 * builds the chain WITHOUT the fillet feature (the pre-pick stage).
 */
function buildDocument(
  fillet: FilletNumbers | null = {
    radiusMm: CHAIN_FILLET_DEFAULT_RADIUS_MM,
    edgeOrdinal: 2,
  },
): CadDocument {
  let document = createDocument(DOC);
  const sketched = addDocumentSketch(document, {
    id: SKETCH,
    name: "profile",
    sketch: rectangleSketchPayload(),
  });
  if (!sketched.ok) throw new Error(sketched.error.message);
  document = sketched.value.document;
  const parameters: readonly (readonly [
    ParameterIdLike,
    string,
    AnyDimensionalValue,
  ])[] = [
    [DEPTH, "extrudeDepth", length(10)],
    [pDiameter, "holeDiameter", length(HOLE_DEFAULT_DIAMETER_MM)],
    [pDepth, "holeDepth", length(HOLE_DEFAULT_DEPTH_MM)],
    [pX, "holeX", length(20)],
    [pY, "holeY", length(17.5)],
    [pAxis, "holeAxis", dimensionless(HOLE_DEFAULT_AXIS)],
    ...(fillet === null
      ? []
      : [
          [pRadius, "filletRadius", length(fillet.radiusMm)] as const,
          [pEdge, "filletEdge", dimensionless(fillet.edgeOrdinal)] as const,
        ]),
  ];
  for (const [id, name, value] of parameters) {
    const parameter = addDocumentParameter(document, { id, name, value });
    if (!parameter.ok) throw new Error(parameter.error.message);
    document = parameter.value.document;
  }
  for (const body of [
    { id: BASE_BODY, name: "pad" },
    { id: HOLE_BODY, name: "holed" },
    ...(fillet === null ? [] : [{ id: FILLET_BODY, name: "rounded" }]),
  ]) {
    const added = addBody(document, body);
    if (!added.ok) throw new Error(added.error.message);
    document = added.value.document;
  }
  const features: {
    readonly id: typeof EXTRUDE;
    readonly kind: string;
    readonly inputs: FeatureInputRefList;
    readonly outputs: readonly BodyId[];
  }[] = [
    {
      id: EXTRUDE,
      kind: "extrude",
      inputs: [
        { kind: "sketch", id: SKETCH },
        { kind: "parameter", id: DEPTH },
      ],
      outputs: [BASE_BODY],
    },
    {
      id: HOLE,
      kind: "hole",
      inputs: [
        { kind: "feature", id: EXTRUDE },
        { kind: "parameter", id: pDiameter },
        { kind: "parameter", id: pDepth },
        { kind: "parameter", id: pX },
        { kind: "parameter", id: pY },
        { kind: "parameter", id: pAxis },
      ],
      outputs: [HOLE_BODY],
    },
  ];
  if (fillet !== null) {
    features.push({
      id: FILLET,
      kind: "fillet",
      inputs: [
        { kind: "feature", id: HOLE },
        { kind: "parameter", id: pRadius },
        { kind: "parameter", id: pEdge },
      ],
      outputs: [FILLET_BODY],
    });
  }
  for (const feature of features) {
    const featured = addFeature(document, {
      id: feature.id,
      kind: feature.kind,
      inputs: feature.inputs,
      outputs: feature.outputs,
    });
    if (!featured.ok) throw new Error(featured.error.message);
    document = featured.value.document;
  }
  return document;
}

/** Type alias keeping the parameter list's tuples honest. */
type ParameterIdLike = ReturnType<typeof createParameterId>;

/** The feature-input list form addFeature consumes. */
type FeatureInputRefList = readonly FeatureInputRef[];

/** The document's feature with the given id, or a test failure. */
function featureOf(document: CadDocument, id: typeof FILLET): FeatureRecord {
  const feature = document.features.find((candidate) => candidate.id === id);
  if (feature === undefined) throw new Error(`Feature ${id} missing`);
  return feature;
}

/** Adds one parameter, failing the test on refusal. */
function withParameter(
  document: CadDocument,
  id: ParameterIdLike,
  name: string,
  value: AnyDimensionalValue,
): CadDocument {
  const parameter = addDocumentParameter(document, { id, name, value });
  if (!parameter.ok) throw new Error(parameter.error.message);
  return parameter.value.document;
}

/** Adds one body, failing the test on refusal. */
function withBody(
  document: CadDocument,
  id: ReturnType<typeof createBodyId>,
  name: string,
): CadDocument {
  const body = addBody(document, { id, name });
  if (!body.ok) throw new Error(body.error.message);
  return body.value.document;
}

/** Adds one feature, failing the test on refusal. */
function withFeature(
  document: CadDocument,
  id: ReturnType<typeof createFeatureId>,
  kind: string,
  inputs: FeatureInputRefList,
  outputs: readonly BodyId[],
): CadDocument {
  const featured = addFeature(document, { id, kind, inputs, outputs });
  if (!featured.ok) throw new Error(featured.error.message);
  return featured.value.document;
}

/** Builds the sketch → extrude document (the first solid stage). */
function buildExtrudeOnlyDocument(): CadDocument {
  let document = createDocument(DOC);
  const sketched = addDocumentSketch(document, {
    id: SKETCH,
    name: "profile",
    sketch: rectangleSketchPayload(),
  });
  if (!sketched.ok) throw new Error(sketched.error.message);
  document = sketched.value.document;
  document = withParameter(document, DEPTH, "extrudeDepth", length(10));
  document = withBody(document, BASE_BODY, "pad");
  return withFeature(
    document,
    EXTRUDE,
    "extrude",
    [
      { kind: "sketch", id: SKETCH },
      { kind: "parameter", id: DEPTH },
    ],
    [BASE_BODY],
  );
}

/**
 * Builds the extrude → fillet document WITHOUT any hole: the fillet stage
 * the chain reaches when the corner is rounded before any hole is cut (the
 * fillet targets the pad itself).
 */
function buildNoHoleFilletDocument(): CadDocument {
  let document = buildExtrudeOnlyDocument();
  document = withParameter(
    document,
    pRadius,
    "filletRadius",
    length(CHAIN_FILLET_DEFAULT_RADIUS_MM),
  );
  document = withParameter(document, pEdge, "filletEdge", dimensionless(2));
  document = withBody(document, FILLET_BODY, "rounded");
  return withFeature(
    document,
    FILLET,
    "fillet",
    [
      { kind: "feature", id: EXTRUDE },
      { kind: "parameter", id: pRadius },
      { kind: "parameter", id: pEdge },
    ],
    [FILLET_BODY],
  );
}

/**
 * Commits one more extrude action onto the document — the page action's
 * second-extrude transaction (fresh sketch, depth, body, feature ids).
 */
function withSecondExtrude(document: CadDocument): CadDocument {
  const sketch = createSketchDocumentId("skd_profile2");
  const depth = createParameterId("param_extrude_depth2");
  const body = createBodyId("body_pad2");
  const extrude = createFeatureId("feat_extrude2");
  let next = document;
  const sketched = addDocumentSketch(next, {
    id: sketch,
    name: "extrude sketch 2",
    sketch: rectangleSketchPayload(),
  });
  if (!sketched.ok) throw new Error(sketched.error.message);
  next = sketched.value.document;
  next = withParameter(next, depth, "extrudeDepth2", length(10));
  next = withBody(next, body, "pad 2");
  return withFeature(
    next,
    extrude,
    "extrude",
    [
      { kind: "sketch", id: sketch },
      { kind: "parameter", id: depth },
    ],
    [body],
  );
}

/** Commits one more hole action onto the document (the page's transaction). */
function withSecondHole(document: CadDocument): CadDocument {
  const base = holeBaseFeatureOf(document);
  if (base === undefined) throw new Error("The base extrude is missing.");
  const diameter = createParameterId("param_hole_diameter2");
  const depth = createParameterId("param_hole_depth2");
  const x = createParameterId("param_hole_x2");
  const y = createParameterId("param_hole_y2");
  const axis = createParameterId("param_hole_axis2");
  const body = createBodyId("body_hole2");
  const hole = createFeatureId("feat_hole2");
  let next = document;
  next = withParameter(next, diameter, "holeDiameter2", length(6));
  next = withParameter(next, depth, "holeDepth2", length(3));
  next = withParameter(next, x, "holeX2", length(15));
  next = withParameter(next, y, "holeY2", length(12));
  next = withParameter(
    next,
    axis,
    "holeAxis2",
    dimensionless(HOLE_DEFAULT_AXIS),
  );
  next = withBody(next, body, "holed 2");
  return withFeature(
    next,
    hole,
    "hole",
    [
      { kind: "feature", id: base.id },
      { kind: "parameter", id: diameter },
      { kind: "parameter", id: depth },
      { kind: "parameter", id: x },
      { kind: "parameter", id: y },
      { kind: "parameter", id: axis },
    ],
    [body],
  );
}

describe("filletBaseFeatureOf", () => {
  it("names the last hole's output when holes exist", () => {
    const base = filletBaseFeatureOf(buildDocument());
    expect(base?.id).toBe(HOLE);
    expect(base?.outputs[0]).toBe(HOLE_BODY);
  });

  it("falls back to the last extrude before any hole exists", () => {
    // The pre-hole stage: sketch + depth + pad body + the extrude feature.
    let document = createDocument(DOC);
    const sketched = addDocumentSketch(document, {
      id: SKETCH,
      name: "profile",
      sketch: rectangleSketchPayload(),
    });
    if (!sketched.ok) throw new Error(sketched.error.message);
    document = sketched.value.document;
    const depth = addDocumentParameter(document, {
      id: DEPTH,
      name: "extrudeDepth",
      value: length(10),
    });
    if (!depth.ok) throw new Error(depth.error.message);
    document = depth.value.document;
    const body = addBody(document, { id: BASE_BODY, name: "pad" });
    if (!body.ok) throw new Error(body.error.message);
    document = body.value.document;
    const featured = addFeature(document, {
      id: EXTRUDE,
      kind: "extrude",
      inputs: [
        { kind: "sketch", id: SKETCH },
        { kind: "parameter", id: DEPTH },
      ],
      outputs: [BASE_BODY],
    });
    if (!featured.ok) throw new Error(featured.error.message);
    document = featured.value.document;
    const base = filletBaseFeatureOf(document);
    expect(base?.id).toBe(EXTRUDE);
  });

  it("is undefined before any solid exists", () => {
    expect(filletBaseFeatureOf(createDocument(DOC))).toBeUndefined();
  });
});

describe("chainFilletInputOf", () => {
  it("reads the radius and the picked edge ordinal in role order", () => {
    const document = buildDocument();
    expect(chainFilletInputOf(document, featureOf(document, FILLET))).toEqual({
      radiusMm: CHAIN_FILLET_DEFAULT_RADIUS_MM,
      edgeOrdinal: 2,
    });
  });

  it("refuses a zero radius", () => {
    const document = buildDocument({ radiusMm: 0, edgeOrdinal: 2 });
    expect(
      chainFilletInputOf(document, featureOf(document, FILLET)),
    ).toBeNull();
  });

  it("refuses a fractional edge ordinal", () => {
    const document = buildDocument({ radiusMm: 3, edgeOrdinal: 2.5 });
    expect(
      chainFilletInputOf(document, featureOf(document, FILLET)),
    ).toBeNull();
  });
});

describe("documentChainSceneRequest", () => {
  it("derives the whole chain: base, holes, fillets, and the newest body", () => {
    const derived = documentChainSceneRequest(buildDocument());
    expect(derived).not.toBeNull();
    expect(derived?.bodyId).toBe(FILLET_BODY);
    expect(derived?.request.baseFeatureId).toBe(EXTRUDE);
    expect(derived?.request.base.distanceMm).toBe(10);
    expect(derived?.request.base.loop.length).toBe(4);
    expect(derived?.request.targetBodyId).toBe(HOLE_BODY);
    expect(derived?.request.holes).toEqual([
      {
        featureId: HOLE,
        diameterMm: HOLE_DEFAULT_DIAMETER_MM,
        depthMm: HOLE_DEFAULT_DEPTH_MM,
        positionXMm: 20,
        positionYMm: 17.5,
        axis: 3,
      },
    ]);
    expect(derived?.request.fillets).toEqual([
      {
        featureId: FILLET,
        edgeOrdinal: 2,
        radiusMm: CHAIN_FILLET_DEFAULT_RADIUS_MM,
      },
    ]);
  });

  it("derives the pre-fillet chain when no fillet feature exists", () => {
    const derived = documentChainSceneRequest(buildDocument(null));
    expect(derived).not.toBeNull();
    expect(derived?.bodyId).toBe(HOLE_BODY);
    expect(derived?.request.fillets).toEqual([]);
  });

  it("composes a STRUCTURED hole beside the flat one (the Phase 52 chain composition)", () => {
    // The structured straight hole: type selector first (the dispatch
    // rule), the straight type's roles in declared order — a flat-tip
    // (180°) Ø8×4 blind hole at the same position, so the analytic delta
    // matches the flat fixture's.
    const sType = createParameterId("param_shole_type");
    const sDiameter = createParameterId("param_shole_diameter");
    const sDepth = createParameterId("param_shole_depth");
    const sTip = createParameterId("param_shole_tipAngle");
    const sX = createParameterId("param_shole_positionX");
    const sY = createParameterId("param_shole_positionY");
    const sAxis = createParameterId("param_shole_axis");
    const sBody = createBodyId("body_sholed");
    const sFeature = createFeatureId("feat_shole");
    // The pre-fillet document: the structured hole becomes the newest
    // solid stage, so a fillet targeting the flat hole would refuse the
    // chain (the retarget guard), which is not this test's subject.
    let document = buildDocument(null);
    const structuredParameters: readonly (readonly [
      ParameterIdLike,
      string,
      AnyDimensionalValue,
    ])[] = [
      [sType, "holeType", dimensionless(1)],
      [sDiameter, "holeDiameter2", length(HOLE_DEFAULT_DIAMETER_MM)],
      [sDepth, "holeDepth2", length(HOLE_DEFAULT_DEPTH_MM)],
      [sTip, "holeTipAngle", angle(Math.PI)],
      [sX, "holeX2", length(20)],
      [sY, "holeY2", length(17.5)],
      [sAxis, "holeAxis2", dimensionless(3)],
    ];
    for (const [id, name, value] of structuredParameters) {
      const parameter = addDocumentParameter(document, { id, name, value });
      if (!parameter.ok) throw new Error(parameter.error.message);
      document = parameter.value.document;
    }
    const addedBody = addBody(document, { id: sBody, name: "sholed" });
    if (!addedBody.ok) throw new Error(addedBody.error.message);
    document = addedBody.value.document;
    const addedFeature = addFeature(document, {
      id: sFeature,
      kind: "hole",
      inputs: [
        { kind: "feature", id: EXTRUDE },
        { kind: "parameter", id: sType },
        { kind: "parameter", id: sDiameter },
        { kind: "parameter", id: sDepth },
        { kind: "parameter", id: sTip },
        { kind: "parameter", id: sX },
        { kind: "parameter", id: sY },
        { kind: "parameter", id: sAxis },
      ],
      outputs: [sBody],
    });
    if (!addedFeature.ok) throw new Error(addedFeature.error.message);
    document = addedFeature.value.document;

    const derived = documentChainSceneRequest(document);
    expect(derived).not.toBeNull();
    expect(derived?.bodyId).toBe(sBody);
    expect(derived?.request.holes).toHaveLength(2);
    const structured = derived?.request.holes[1];
    expect("kind" in (structured ?? {})).toBe(true);
    if (structured === undefined || !("kind" in structured)) return;
    expect(structured.featureId).toBe(sFeature);
    expect(structured.spec.type).toBe(1);
    expect(structured.spec.diameterMm).toBe(HOLE_DEFAULT_DIAMETER_MM);
    expect(structured.spec.depthMm).toBe(HOLE_DEFAULT_DEPTH_MM);
    expect(structured.spec.tipAngleDeg).toBe(180);
    expect(structured.positions).toEqual([{ x: 20, y: 17.5 }]);
    expect(structured.axis).toBe(3);
  });

  it("declines the chain when a structured hole's layout is malformed", () => {
    // A hole whose first parameter is dimensionless (structured dispatch)
    // but whose role count does not match any type's schema.
    const badType = createParameterId("param_badhole_type");
    let document = buildDocument(null);
    const parameter = addDocumentParameter(document, {
      id: badType,
      name: "holeTypeBad",
      value: dimensionless(1),
    });
    if (!parameter.ok) throw new Error(parameter.error.message);
    document = parameter.value.document;
    const featured = addFeature(document, {
      id: createFeatureId("feat_badhole"),
      kind: "hole",
      inputs: [
        { kind: "feature", id: EXTRUDE },
        { kind: "parameter", id: badType },
      ],
      outputs: [HOLE_BODY],
    });
    if (!featured.ok) throw new Error(featured.error.message);
    document = featured.value.document;
    expect(documentChainSceneRequest(document)).toBeNull();
  });

  it("carries an extrude depth parameter.set into the request (the cascade)", () => {
    const document = buildDocument();
    const set = applyCommand(document, {
      type: "parameter.set",
      id: DEPTH,
      value: length(12),
    });
    if (!set.ok) throw new Error(set.error.message);
    const derived = documentChainSceneRequest(set.value);
    expect(derived?.request.base.distanceMm).toBe(12);
    expect(derived?.request.fillets[0]?.radiusMm).toBe(
      CHAIN_FILLET_DEFAULT_RADIUS_MM,
    );
  });

  it("carries a fillet radius parameter.set into the request (the recovery)", () => {
    const document = buildDocument();
    const set = applyCommand(document, {
      type: "parameter.set",
      id: pRadius,
      value: length(5),
    });
    if (!set.ok) throw new Error(set.error.message);
    const derived = documentChainSceneRequest(set.value);
    expect(derived?.request.fillets[0]?.radiusMm).toBe(5);
  });

  it("returns null for a document without any extrude", () => {
    expect(documentChainSceneRequest(createDocument(DOC))).toBeNull();
  });

  it("returns null when the fillet targets another solid", () => {
    const document = buildDocument();
    const retargeted = {
      ...document,
      features: document.features.map((feature) =>
        feature.id === FILLET
          ? {
              ...feature,
              inputs: [
                { kind: "feature" as const, id: ABSENT_BASE },
                { kind: "parameter" as const, id: pRadius },
                { kind: "parameter" as const, id: pEdge },
              ],
            }
          : feature,
      ),
    };
    expect(documentChainSceneRequest(retargeted)).toBeNull();
  });

  it("returns null when the fillet's edge parameter is gone", () => {
    const document = buildDocument();
    const dropped = {
      ...document,
      parameters: {
        ...document.parameters,
        parameters: document.parameters.parameters.filter(
          (parameter) => parameter.id !== pEdge,
        ),
      },
    };
    expect(documentChainSceneRequest(dropped)).toBeNull();
  });
});

describe("nextExtrudeInvalidatesChain (the chain page's extrude action guard)", () => {
  it("keeps the extrude action enabled while nothing builds on the base", () => {
    expect(nextExtrudeInvalidatesChain(createDocument(DOC))).toBe(false);
    const extrudeOnly = buildExtrudeOnlyDocument();
    expect(nextExtrudeInvalidatesChain(extrudeOnly)).toBe(false);
    // The guard's honesty: a second extrude over the bare chain really
    // composes (the fresh base, nothing left on the old one).
    expect(
      documentChainSceneRequest(withSecondExtrude(extrudeOnly)),
    ).not.toBeNull();
  });

  it("guards the extrude action once a hole exists (the base changes under it)", () => {
    const holed = buildDocument(null);
    expect(nextExtrudeInvalidatesChain(holed)).toBe(true);
    // The guarded transaction really would invalidate the request.
    expect(documentChainSceneRequest(withSecondExtrude(holed))).toBeNull();
  });

  it("guards the extrude action once a fillet exists, holes or not (the fillet target changes)", () => {
    // Holes AND a fillet: the hole mismatch fires first.
    expect(nextExtrudeInvalidatesChain(buildDocument())).toBe(true);
    // A fillet with NO hole: the new extrude becomes the fillet target,
    // so the existing fillet's target no longer matches (chain.ts:176).
    const noHole = buildNoHoleFilletDocument();
    expect(nextExtrudeInvalidatesChain(noHole)).toBe(true);
    expect(documentChainSceneRequest(withSecondExtrude(noHole))).toBeNull();
  });
});

describe("nextHoleInvalidatesChain (the chain page's hole action guard)", () => {
  it("keeps the hole action enabled without a fillet — multiple holes compose", () => {
    const extrudeOnly = buildExtrudeOnlyDocument();
    expect(nextHoleInvalidatesChain(extrudeOnly)).toBe(false);
    const holed = buildDocument(null);
    expect(nextHoleInvalidatesChain(holed)).toBe(false);
    // The guard's honesty: a second hole over the fillet-free chain
    // really composes (every hole cuts the same base).
    expect(documentChainSceneRequest(withSecondHole(holed))).not.toBeNull();
  });

  it("guards the hole action once a fillet exists (its target stops being the last hole)", () => {
    const filleted = buildDocument();
    expect(nextHoleInvalidatesChain(filleted)).toBe(true);
    // The guarded transaction really would invalidate the request.
    expect(documentChainSceneRequest(withSecondHole(filleted))).toBeNull();
  });

  it("guards the hole action when a fillet targets the bare extrude (no holes yet)", () => {
    const noHole = buildNoHoleFilletDocument();
    expect(nextHoleInvalidatesChain(noHole)).toBe(true);
    expect(documentChainSceneRequest(withSecondHole(noHole))).toBeNull();
  });
});

describe("ChainStageFailure", () => {
  it("surfaces the structured code with the message", () => {
    const failure = new ChainStageFailure(
      "fillet",
      FILLET,
      "kernel/fillet-failed",
      "the radius outruns the adjacent faces",
    );
    expect(failure.stage).toBe("fillet");
    expect(failure.featureId).toBe(FILLET);
    expect(failure.kernelCode).toBe("kernel/fillet-failed");
    expect(failure.surfaceText()).toBe(
      "kernel/fillet-failed: the radius outruns the adjacent faces",
    );
  });

  it("is an Error, so the session's generic failure path still reads it", () => {
    const failure = new ChainStageFailure(
      "hole",
      HOLE,
      "kernel/operation-failed",
      "boom",
    );
    expect(failure).toBeInstanceOf(Error);
    expect(failure.message).toBe("boom");
  });
});

describe("computeChainScene against the real OpenCascade kernel", () => {
  // The analytic pad: workplane (10,10) → (30,25), 10 mm tall.
  const PAD_VOLUME = 20 * 15 * 10;
  // The blind Ø8×4 hole at the top face's center.
  const HOLED_VOLUME = PAD_VOLUME - Math.PI * 4 * 4 * HOLE_DEFAULT_DEPTH_MM;
  // The corner fillet at (30, 25): one prism-quadrant removed.
  const cornerFilletVolume = (radiusMm: number): number =>
    HOLED_VOLUME - radiusMm * radiusMm * (1 - Math.PI / 4) * 10;

  /** The exact band the OCCT fillet fixture pins (BREP-exact kernels). */
  const EXACT_BAND = 1e-9;

  const preFilletRequest: ChainSceneRequest = {
    base: {
      loop: [
        { kind: "line", start: [10, 10], end: [30, 10] },
        { kind: "line", start: [30, 10], end: [30, 25] },
        { kind: "line", start: [30, 25], end: [10, 25] },
        { kind: "line", start: [10, 25], end: [10, 10] },
      ],
      placement: {
        rotation: { axis: [0, 0, 1], angle: angle(0) },
        translation: {
          x: length(0, "mm"),
          y: length(0, "mm"),
          z: length(0, "mm"),
        },
      },
      distanceMm: 10,
    },
    baseFeatureId: EXTRUDE,
    targetBodyId: HOLE_BODY,
    holes: [
      {
        featureId: HOLE,
        diameterMm: HOLE_DEFAULT_DIAMETER_MM,
        depthMm: HOLE_DEFAULT_DEPTH_MM,
        positionXMm: 20,
        positionYMm: 17.5,
        axis: 3,
      },
    ],
    fillets: [],
  };

  /**
   * The corner vertical edge of the pad at (30, 25): centroid (30, 25, 5),
   * length 10 — the edge the workflow picks from the snapshot anchors.
   */
  function cornerOrdinalOf(scene: ChainScene): number {
    for (const entity of scene.snapshot.entities) {
      const centroid = entity.geometry.centroidAbsoluteMm;
      if (entity.kind !== "edge" || centroid === undefined) continue;
      if (
        Math.abs(centroid[0] - 30) < 1e-6 &&
        Math.abs(centroid[1] - 25) < 1e-6 &&
        Math.abs(centroid[2] - 5) < 1e-6
      ) {
        return entity.ordinal;
      }
    }
    throw new Error("The pad's corner vertical edge is not in the snapshot.");
  }

  /** Runs one chain computation on the real OCCT kernel, in-process. */
  async function runChain(
    chainRequest: ChainSceneRequest,
  ): Promise<ChainScene> {
    const transport = createInMemoryTransportPair();
    const server: WorkerServer = await hostOcctWorker({
      transport: transport.server,
    });
    const client = createWorkerClient({ transport: transport.client });
    const coordinator = createStaleResultCoordinator<ChainScene>({ client });
    try {
      const outcome = await coordinator.update((context) =>
        computeChainScene(context, chainRequest),
      );
      if (outcome.outcome !== "applied") {
        throw new Error(
          `The chain computation was dropped (${outcome.reason}).`,
        );
      }
      return outcome.result;
    } finally {
      client.close();
      server.close();
    }
  }

  it("runs the pre-fillet chain at the exact analytic volumes with the snapshot", async () => {
    const scene = await runChain(preFilletRequest);
    expect(
      Math.abs(scene.extruded.volume - PAD_VOLUME) / PAD_VOLUME,
    ).toBeLessThan(EXACT_BAND);
    expect(scene.holed).not.toBeNull();
    const holed = scene.holed?.volume ?? 0;
    expect(Math.abs(holed - HOLED_VOLUME) / HOLED_VOLUME).toBeLessThan(
      EXACT_BAND,
    );
    expect(scene.filleted).toBeNull();
    expect(scene.snapshot.bodyId).toBe(HOLE_BODY);
    expect(scene.snapshot.persistentTopology).toBe(true);
    const corner = scene.snapshot.entities.find(
      (entity) =>
        entity.kind === "edge" && entity.ordinal === cornerOrdinalOf(scene),
    );
    expect(corner?.geometry.lengthMm).toBeCloseTo(10, 6);
  }, 120_000);

  it("fillets the snapshot's corner edge at the exact analytic volume", async () => {
    // The workflow's two-dispatch shape: pick the edge from the first
    // dispatch's snapshot, then fillet that ordinal.
    const pre = await runChain(preFilletRequest);
    const picked: ChainSceneRequest = {
      ...preFilletRequest,
      fillets: [
        { featureId: FILLET, edgeOrdinal: cornerOrdinalOf(pre), radiusMm: 3 },
      ],
    };
    const scene = await runChain(picked);
    expect(scene.filleted).not.toBeNull();
    const analytic = cornerFilletVolume(3);
    const filleted = scene.filleted?.volume ?? 0;
    expect(Math.abs(filleted - analytic) / analytic).toBeLessThan(EXACT_BAND);
    expect(scene.filletEdges).toEqual([cornerOrdinalOf(pre)]);
    expect(scene.filletRadii).toEqual([3]);
  }, 180_000);

  it("attributes an oversized radius to the fillet feature with the kernel code", async () => {
    const pre = await runChain(preFilletRequest);
    const oversized: ChainSceneRequest = {
      ...preFilletRequest,
      fillets: [
        { featureId: FILLET, edgeOrdinal: cornerOrdinalOf(pre), radiusMm: 25 },
      ],
    };
    await expect(runChain(oversized)).rejects.toMatchObject({
      name: "ChainStageFailure",
      stage: "fillet",
      featureId: FILLET,
      kernelCode: "kernel/fillet-failed",
    });
  }, 180_000);

  it("cuts a STRUCTURED hole in the same chain dispatch at the analytic volume", async () => {
    // A flat-tip (180°) straight Ø8×4 structured hole at the flat fixture's
    // position: the analytic removed volume is IDENTICAL to the flat
    // form's — the two forms compose the same cut.
    const structuredRequest: ChainSceneRequest = {
      ...preFilletRequest,
      holes: [
        {
          featureId: HOLE,
          kind: "structured",
          spec: {
            type: 1,
            diameterMm: HOLE_DEFAULT_DIAMETER_MM,
            depthMm: HOLE_DEFAULT_DEPTH_MM,
            tipAngleDeg: 180,
            cboreDiameterMm: 0,
            cboreDepthMm: 0,
            csinkDiameterMm: 0,
            csinkAngleDeg: 0,
            taperAngleDeg: 0,
            threadMajorMm: 0,
            threadPitchMm: 0,
          },
          positions: [{ x: 20, y: 17.5 }],
          axis: 3,
        },
      ],
    };
    const scene = await runChain(structuredRequest);
    expect(scene.holed).not.toBeNull();
    const holed = scene.holed?.volume ?? 0;
    expect(Math.abs(holed - HOLED_VOLUME) / HOLED_VOLUME).toBeLessThan(
      EXACT_BAND,
    );
  }, 180_000);
});
