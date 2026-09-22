/**
 * The workbench boolean wiring tests (Phase 44): the validation seam's
 * structured refusals (unknown operation, missing target, empty or
 * overlapping tool lists, duplicates), the document reader that derives
 * the worker-scene request from a committed boolean feature (two extrude
 * operands), and the end-to-end bridge execution of a subtract against
 * the fake kernel exactly as the page wires it — the plate-with-hole
 * arrangement's volume.
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
  featureProducingBody,
  validateBooleanSubmission,
} from "./boolean";
import { documentExtrudeRequest, sketchProfileResolverOf } from "./extrude";
import { validateMoveBodySubmission } from "./move-body";
import { validateBodyRenameSubmission } from "./body-management";

const DOC = createDocumentId("doc_boolean_wiring");
const SKETCH_PLATE = createSketchDocumentId("skd_boolean_plate");
const SKETCH_TOOL = createSketchDocumentId("skd_boolean_tool");
const BODY_PLATE = createBodyId("body_boolean_plate");
const BODY_TOOL = createBodyId("body_boolean_tool");
const BODY_RESULT = createBodyId("body_boolean_result");
const DEPTH_PLATE = createParameterId("param_boolean_plate_depth");
const DEPTH_TOOL = createParameterId("param_boolean_tool_depth");
const FEATURE_PLATE = createFeatureId("feat_boolean_plate");
const FEATURE_TOOL = createFeatureId("feat_boolean_tool");
const FEATURE_BOOLEAN = createFeatureId("feat_boolean_subtract");

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
    // The operands ride their OWN extrusions: the plate 40×20 and the
    // 20×10 tool inside it.
    expect(request.target.distanceMm).toBe(10);
    expect(request.tool.distanceMm).toBe(10);
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
