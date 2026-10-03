/**
 * The workbench boolean wiring tests (Phase 44): the validation seam's
 * structured refusals (unknown operation, missing target, empty or
 * overlapping tool lists, duplicates), the document reader that derives
 * the worker-scene request from the committed boolean features — EVERY
 * one, in document order, each operand a plain-extrude derivation or a
 * composed body's computed-solid reference — and the end-to-end bridge
 * execution of a subtract against the fake kernel exactly as the page
 * wires it — the plate-with-hole arrangement's volume.
 */

import { describe, expect, it } from "vitest";
import {
  addBody,
  addDocumentSketch,
  addFeature,
  applyCommand,
  createBodyId,
  createDocument,
  createDocumentId,
  createFeatureId,
  createParameterId,
  createSketchDocumentId,
  dimensionless,
  length,
  type CadDocument,
} from "@slopcad/cad-core";
import {
  createLineEntity,
  createRectangleEntity,
  createSketch,
  createSketchEntityId,
  serializeSketch,
  xyWorkplane,
} from "@slopcad/cad-sketch";
import { createFakeKernel } from "@slopcad/cad-kernel";
import { createKernelFeatureExecutor } from "@slopcad/cad-kernel";
import { initialRegenerationStates, regenerate } from "@slopcad/cad-react";

import {
  documentBooleanSceneRequest,
  documentBooleanSceneRequests,
  featureProducingBody,
  validateBooleanSubmission,
} from "./boolean";
import { documentExtrudeRequest, sketchProfileResolverOf } from "./extrude";
import { validateMoveBodySubmission } from "./move-body";
import { validateBodyRenameSubmission } from "./body-management";

const DOC = createDocumentId("doc_boolean_wiring");
const SKETCH_PLATE = createSketchDocumentId("skd_boolean_plate");
const SKETCH_TOOL = createSketchDocumentId("skd_boolean_tool");
const SKETCH_TOOL_2 = createSketchDocumentId("skd_boolean_tool_2");
const BODY_PLATE = createBodyId("body_boolean_plate");
const BODY_TOOL = createBodyId("body_boolean_tool");
const BODY_TOOL_2 = createBodyId("body_boolean_tool_2");
const BODY_HOLE = createBodyId("body_boolean_hole");
const BODY_RESULT = createBodyId("body_boolean_result");
const BODY_RESULT_2 = createBodyId("body_boolean_result_2");
const DEPTH_PLATE = createParameterId("param_boolean_plate_depth");
const DEPTH_TOOL = createParameterId("param_boolean_tool_depth");
const DEPTH_TOOL_2 = createParameterId("param_boolean_tool_2_depth");
const HOLE_DIAMETER = createParameterId("param_boolean_hole_diameter");
const HOLE_DEPTH = createParameterId("param_boolean_hole_depth");
const HOLE_X = createParameterId("param_boolean_hole_x");
const HOLE_Y = createParameterId("param_boolean_hole_y");
const HOLE_AXIS = createParameterId("param_boolean_hole_axis");
const FEATURE_PLATE = createFeatureId("feat_boolean_plate");
const FEATURE_TOOL = createFeatureId("feat_boolean_tool");
const FEATURE_TOOL_2 = createFeatureId("feat_boolean_tool_2");
const FEATURE_HOLE = createFeatureId("feat_boolean_hole");
const FEATURE_BOOLEAN = createFeatureId("feat_boolean_subtract");
const FEATURE_BOOLEAN_2 = createFeatureId("feat_boolean_subtract_2");

/** A rectangle sketch payload at the given workplane coordinates. */
function rectangleSketchPayload(
  minX: number,
  minY: number,
  maxX: number,
  maxY: number,
): Record<string, unknown> {
  const bottom = createSketchEntityId("skent_b-bottom");
  const right = createSketchEntityId("skent_b-right");
  const top = createSketchEntityId("skent_b-top");
  const left = createSketchEntityId("skent_b-left");
  const created = createSketch(
    xyWorkplane(),
    [
      createLineEntity(bottom, { x: minX, y: minY }, { x: maxX, y: minY }),
      createLineEntity(right, { x: maxX, y: minY }, { x: maxX, y: maxY }),
      createLineEntity(top, { x: maxX, y: maxY }, { x: minX, y: maxY }),
      createLineEntity(left, { x: minX, y: maxY }, { x: minX, y: minY }),
      createRectangleEntity(createSketchEntityId("skent_b-rect"), [
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

/** The two-extrusion document with a subtract between them. */
function booleanDocument(): CadDocument {
  let document = createDocument(DOC);
  for (const [id, name, value] of [
    [DEPTH_PLATE, "plateDepth", length(10)],
    [DEPTH_TOOL, "toolDepth", length(10)],
  ] as const) {
    const parameter = applyCommand(document, {
      type: "parameter.create",
      id,
      name,
      value,
    });
    if (!parameter.ok) throw new Error(parameter.error.message);
    document = parameter.value;
  }
  for (const [id, payload] of [
    [SKETCH_PLATE, rectangleSketchPayload(0, 0, 40, 20)],
    [SKETCH_TOOL, rectangleSketchPayload(10, 5, 30, 15)],
  ] as const) {
    const sketch = addDocumentSketch(document, {
      id,
      name: "rect",
      sketch: payload,
    });
    if (!sketch.ok) throw new Error(sketch.error.message);
    document = sketch.value.document;
  }
  for (const body of [
    { id: BODY_PLATE, name: "plate" },
    { id: BODY_TOOL, name: "tool" },
    { id: BODY_RESULT, name: "result" },
  ]) {
    const added = addBody(document, body);
    if (!added.ok) throw new Error(added.error.message);
    document = added.value.document;
  }
  for (const feature of [
    {
      id: FEATURE_PLATE,
      kind: "extrude",
      inputs: [
        { kind: "sketch", id: SKETCH_PLATE },
        { kind: "parameter", id: DEPTH_PLATE },
      ],
      outputs: [BODY_PLATE],
    },
    {
      id: FEATURE_TOOL,
      kind: "extrude",
      inputs: [
        { kind: "sketch", id: SKETCH_TOOL },
        { kind: "parameter", id: DEPTH_TOOL },
      ],
      outputs: [BODY_TOOL],
    },
    {
      id: FEATURE_BOOLEAN,
      kind: "subtract",
      inputs: [
        { kind: "feature", id: FEATURE_PLATE },
        { kind: "feature", id: FEATURE_TOOL },
      ],
      outputs: [BODY_RESULT],
    },
  ] as const) {
    const added = addFeature(document, feature);
    if (!added.ok) throw new Error(added.error.message);
    document = added.value.document;
  }
  return document;
}

/** The page's parameter.create step (a throwaway commit helper). */
function createParameter(
  document: CadDocument,
  id: ReturnType<typeof createParameterId>,
  name: string,
  value: ReturnType<typeof length> | ReturnType<typeof dimensionless>,
): CadDocument {
  const committed = applyCommand(document, {
    type: "parameter.create",
    id,
    name,
    value,
  });
  if (!committed.ok) throw new Error(committed.error.message);
  return committed.value;
}

/** The page's body.create step. */
function createBody(
  document: CadDocument,
  id: ReturnType<typeof createBodyId>,
  name: string,
): CadDocument {
  const added = addBody(document, { id, name });
  if (!added.ok) throw new Error(added.error.message);
  return added.value.document;
}

/**
 * Block extrude → hole (through the block) → subtract (target = the HOLE's
 * output, tool = a plain extrude): the composition chain whose boolean
 * must consume the holed block's COMPUTED solid, never the raw derivation
 * that would erase the window.
 */
function holedTargetDocument(): CadDocument {
  let document = createDocument(DOC);
  document = createParameter(document, DEPTH_PLATE, "plateDepth", length(10));
  document = createParameter(document, DEPTH_TOOL, "toolDepth", length(10));
  document = createParameter(document, HOLE_DIAMETER, "holeD", length(8));
  document = createParameter(document, HOLE_DEPTH, "holeDepth", length(10));
  document = createParameter(document, HOLE_X, "holeX", length(20));
  document = createParameter(document, HOLE_Y, "holeY", length(10));
  document = createParameter(document, HOLE_AXIS, "holeAxis", dimensionless(3));
  for (const [id, payload] of [
    [SKETCH_PLATE, rectangleSketchPayload(0, 0, 40, 20)],
    [SKETCH_TOOL, rectangleSketchPayload(10, 5, 30, 15)],
  ] as const) {
    const sketch = addDocumentSketch(document, {
      id,
      name: "rect",
      sketch: payload,
    });
    if (!sketch.ok) throw new Error(sketch.error.message);
    document = sketch.value.document;
  }
  document = createBody(document, BODY_PLATE, "block");
  document = createBody(document, BODY_TOOL, "tool");
  document = createBody(document, BODY_HOLE, "holed");
  document = createBody(document, BODY_RESULT, "result");
  for (const feature of [
    {
      id: FEATURE_PLATE,
      kind: "extrude",
      inputs: [
        { kind: "sketch", id: SKETCH_PLATE },
        { kind: "parameter", id: DEPTH_PLATE },
      ],
      outputs: [BODY_PLATE],
    },
    {
      id: FEATURE_TOOL,
      kind: "extrude",
      inputs: [
        { kind: "sketch", id: SKETCH_TOOL },
        { kind: "parameter", id: DEPTH_TOOL },
      ],
      outputs: [BODY_TOOL],
    },
    {
      id: FEATURE_HOLE,
      kind: "hole",
      inputs: [
        { kind: "feature", id: FEATURE_PLATE },
        { kind: "parameter", id: HOLE_DIAMETER },
        { kind: "parameter", id: HOLE_DEPTH },
        { kind: "parameter", id: HOLE_X },
        { kind: "parameter", id: HOLE_Y },
        { kind: "parameter", id: HOLE_AXIS },
      ],
      outputs: [BODY_HOLE],
    },
    {
      id: FEATURE_BOOLEAN,
      kind: "subtract",
      inputs: [
        { kind: "feature", id: FEATURE_HOLE },
        { kind: "feature", id: FEATURE_TOOL },
      ],
      outputs: [BODY_RESULT],
    },
  ] as const) {
    const added = addFeature(document, feature);
    if (!added.ok) throw new Error(added.error.message);
    document = added.value.document;
  }
  return document;
}

/**
 * Block → subtract 1 (plain extrudes) → subtract 2 (target = subtract 1's
 * output, tool = a second plain extrude): both booleans must read, the
 * second consuming the first's computed solid.
 */
function chainedBooleanDocument(): CadDocument {
  let document = booleanDocument();
  document = createParameter(document, DEPTH_TOOL_2, "tool2Depth", length(10));
  const sketch = addDocumentSketch(document, {
    id: SKETCH_TOOL_2,
    name: "rect",
    sketch: rectangleSketchPayload(12, 7, 28, 13),
  });
  if (!sketch.ok) throw new Error(sketch.error.message);
  document = sketch.value.document;
  document = createBody(document, BODY_TOOL_2, "tool 2");
  document = createBody(document, BODY_RESULT_2, "result 2");
  for (const feature of [
    {
      id: FEATURE_TOOL_2,
      kind: "extrude",
      inputs: [
        { kind: "sketch", id: SKETCH_TOOL_2 },
        { kind: "parameter", id: DEPTH_TOOL_2 },
      ],
      outputs: [BODY_TOOL_2],
    },
    {
      id: FEATURE_BOOLEAN_2,
      kind: "subtract",
      inputs: [
        { kind: "feature", id: FEATURE_BOOLEAN },
        { kind: "feature", id: FEATURE_TOOL_2 },
      ],
      outputs: [BODY_RESULT_2],
    },
  ] as const) {
    const added = addFeature(document, feature);
    if (!added.ok) throw new Error(added.error.message);
    document = added.value.document;
  }
  return document;
}

describe("boolean validation seam", () => {
  it("accepts a well-formed subtract and refuses the impossible ones", () => {
    expect(
      validateBooleanSubmission({
        operation: "subtract",
        targetBodyId: BODY_PLATE,
        toolBodyIds: [BODY_TOOL],
        keepToolBodies: true,
      }).ok,
    ).toBe(true);
    expect(
      validateBooleanSubmission({
        operation: "combine" as "union",
        targetBodyId: BODY_PLATE,
        toolBodyIds: [BODY_TOOL],
        keepToolBodies: true,
      }).ok,
    ).toBe(false);
    expect(
      validateBooleanSubmission({
        operation: "union",
        targetBodyId: "",
        toolBodyIds: [BODY_TOOL],
        keepToolBodies: true,
      }).ok,
    ).toBe(false);
    expect(
      validateBooleanSubmission({
        operation: "union",
        targetBodyId: BODY_PLATE,
        toolBodyIds: [],
        keepToolBodies: true,
      }).ok,
    ).toBe(false);
    expect(
      validateBooleanSubmission({
        operation: "union",
        targetBodyId: BODY_PLATE,
        toolBodyIds: [BODY_PLATE],
        keepToolBodies: true,
      }).ok,
    ).toBe(false);
    expect(
      validateBooleanSubmission({
        operation: "union",
        targetBodyId: BODY_PLATE,
        toolBodyIds: [BODY_TOOL, BODY_TOOL],
        keepToolBodies: true,
      }).ok,
    ).toBe(false);
  });
});

describe("boolean document reader", () => {
  it("derives the scene request from the committed subtract", () => {
    const document = booleanDocument();
    const request = documentBooleanSceneRequest(document);
    expect(request).not.toBeNull();
    if (request === null) return;
    expect(request.operation).toBe("subtract");
    expect(request.bodyId).toBe(BODY_RESULT);
    // The operands ride their OWN extrusions (the derivation default):
    // the plate 40×20 and the 20×10 tool inside it.
    if (
      request.target.kind !== "extrude" ||
      request.tools[0]?.kind !== "extrude"
    ) {
      throw new Error("the plain-extrude operands must derive");
    }
    expect(request.target.request.distanceMm).toBe(10);
    expect(request.tools).toHaveLength(1);
    expect(request.tools[0]?.request.distanceMm).toBe(10);
  });

  it("finds each body's producing feature (the first-producer rule)", () => {
    const document = booleanDocument();
    expect(featureProducingBody(document, BODY_PLATE)?.id).toBe(FEATURE_PLATE);
    expect(featureProducingBody(document, BODY_RESULT)?.id).toBe(
      FEATURE_BOOLEAN,
    );
    expect(
      featureProducingBody(document, createBodyId("body_boolean_absent")),
    ).toBeUndefined();
  });

  it("answers null for a document without a boolean feature", () => {
    const document = createDocument(DOC);
    expect(documentBooleanSceneRequest(document)).toBeNull();
    expect(documentExtrudeRequest(document)).toBeNull();
  });

  it("reads every boolean feature in document order (never first-only)", () => {
    const document = chainedBooleanDocument();
    const requests = documentBooleanSceneRequests(document);
    expect(requests.length).toBe(2);
    // The first subtract: plain-extrude operands, the derivation default.
    const first = requests[0];
    if (first === undefined) throw new Error("the first subtract vanished");
    expect(first.operation).toBe("subtract");
    expect(first.bodyId).toBe(BODY_RESULT);
    expect(first.target.kind).toBe("extrude");
    expect(first.tools).toHaveLength(1);
    expect(first.tools[0]?.kind).toBe("extrude");
    // The second subtract consumes the FIRST's output: its target rides
    // the computed solid of that body, its tool derives.
    const second = requests[1];
    if (second === undefined) throw new Error("the second subtract vanished");
    expect(second.operation).toBe("subtract");
    expect(second.bodyId).toBe(BODY_RESULT_2);
    expect(second.target).toEqual({ kind: "computed", bodyId: BODY_RESULT });
    expect(second.tools).toHaveLength(1);
    expect(second.tools[0]?.kind).toBe("extrude");
    // The singular reader stays the plural's head.
    expect(documentBooleanSceneRequest(document)?.bodyId).toBe(BODY_RESULT);
  });

  it("references a composed operand's computed solid (hole output target)", () => {
    const document = holedTargetDocument();
    const requests = documentBooleanSceneRequests(document);
    expect(requests.length).toBe(1);
    const request = requests[0];
    if (request === undefined) throw new Error("the subtract vanished");
    // The target is the HOLE's output body: the boolean must consume its
    // computed solid — a re-derivation from the raw block extrusion would
    // erase the window.
    expect(request.target).toEqual({ kind: "computed", bodyId: BODY_HOLE });
    expect(request.tools).toHaveLength(1);
    expect(request.tools[0]?.kind).toBe("extrude");
  });

  it("skips a boolean whose operand no longer resolves — the rest render", () => {
    const document = chainedBooleanDocument();
    // The second tool's sketch disappears: its derivation fails, so the
    // second subtract declines alone.
    const broken = {
      ...document,
      sketches: document.sketches.filter(
        (sketch) => sketch.id !== SKETCH_TOOL_2,
      ),
    } as CadDocument;
    const requests = documentBooleanSceneRequests(broken);
    expect(requests.map((request) => request.bodyId)).toEqual([BODY_RESULT]);
  });
});

describe("the boolean executes through the bridge as the page wires it", () => {
  it("subtracts the tool extrusion from the plate at the analytic volume", () => {
    const document = booleanDocument();
    const kernel = createFakeKernel();
    const bridge = createKernelFeatureExecutor(kernel, {
      document,
      bodies: new Map(),
      profiles: sketchProfileResolverOf(document),
    });
    const run = regenerate({
      features: document.features,
      states: initialRegenerationStates(document.features),
      suppressed: [],
      execute: bridge.executor,
    });
    if (!run.ok) throw new Error(run.error.message);
    expect(run.value.states.get(FEATURE_BOOLEAN)?.state).toBe("valid");
    const solid = bridge.solidOf(BODY_RESULT);
    expect(solid).toBeDefined();
    if (solid === undefined) return;
    // The plate with the 20×10 tool cut through: (40·20 − 20·10)·10.
    const volume = kernel.volume(solid);
    expect(volume.ok).toBe(true);
    if (!volume.ok) return;
    expect(Math.abs(volume.value - (40 * 20 - 20 * 10) * 10)).toBeLessThan(
      0.02 * 6000,
    );
  });
});

describe("the move-body and rename validation seams", () => {
  it("refuses non-finite move offsets and bad rotations", () => {
    expect(
      validateMoveBodySubmission({
        offsetMm: [1, 2, 3],
        rotation: null,
      }).ok,
    ).toBe(true);
    expect(
      validateMoveBodySubmission({
        offsetMm: [Number.NaN, 2, 3],
        rotation: null,
      }).ok,
    ).toBe(false);
    expect(
      validateMoveBodySubmission({
        offsetMm: [1, 2, 3],
        rotation: { axis: 3, angleDeg: 90 },
      }).ok,
    ).toBe(true);
    expect(
      validateMoveBodySubmission({
        offsetMm: [1, 2, 3],
        rotation: { axis: 3, angleDeg: Number.NaN },
      }).ok,
    ).toBe(false);
  });

  it("refuses empty and whitespace-only rename submissions", () => {
    expect(validateBodyRenameSubmission({ name: "boss" }).ok).toBe(true);
    expect(validateBodyRenameSubmission({ name: "" }).ok).toBe(false);
    expect(validateBodyRenameSubmission({ name: "   " }).ok).toBe(false);
  });
});
