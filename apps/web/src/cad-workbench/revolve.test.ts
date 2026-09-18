/**
 * The workbench revolve wiring tests (Phase 26.2): the document → profile
 * resolution adapter with the axis-validation seam (crossing refuses with
 * the structured code BEFORE anything resolves), the worker-scene request
 * derivation (sweep and axis parameter edits re-drive it), and an
 * end-to-end bridge execution against the fake kernel exactly as the page
 * wires it.
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
import { createFakeKernel, KERNEL_ERROR_CODES } from "@slopcad/cad-kernel";
import { createKernelFeatureExecutor } from "@slopcad/cad-kernel";
import { regenerate, initialRegenerationStates } from "@slopcad/cad-react";

import {
  documentRevolveRequest,
  resolveRevolveSubmission,
  REVOLVE_AXIS_X_RAD,
  REVOLVE_AXIS_Y_RAD,
  REVOLVE_DEFAULT_SWEEP_RAD,
} from "./revolve";
import { sketchProfileResolverOf } from "./extrude";

const DOC = createDocumentId("doc_revolve_wiring");
const SKETCH = createSketchDocumentId("skd_revolve_profile");
const BODY = createBodyId("body_revolved");
const SWEEP = createParameterId("param_revolve_sweep");
const AXIS = createParameterId("param_revolve_axis");
const FEATURE = createFeatureId("feat_revolve");

/**
 * A 30×25 rectangle sketch touching the workplane origin along its bottom
 * edge — revolving about the X axis gives the exact cylinder (radius 25,
 * length 30); about the Y axis it crosses.
 */
function touchingRectangleSketch(): {
  readonly serialized: ReturnType<typeof serializeSketch>;
  readonly entities: ReturnType<typeof buildEntities>;
} {
  const entities = buildEntities();
  const created = createSketch(xyWorkplane(), entities, []);
  if (!created.ok) throw new Error(created.error.message);
  return { serialized: serializeSketch(created.value), entities };
}

function buildEntities() {
  const bottom = createSketchEntityId("skent_r-bottom");
  const right = createSketchEntityId("skent_r-right");
  const top = createSketchEntityId("skent_r-top");
  const left = createSketchEntityId("skent_r-left");
  return [
    createLineEntity(bottom, { x: 0, y: 0 }, { x: 30, y: 0 }),
    createLineEntity(right, { x: 30, y: 0 }, { x: 30, y: 25 }),
    createLineEntity(top, { x: 30, y: 25 }, { x: 0, y: 25 }),
    createLineEntity(left, { x: 0, y: 25 }, { x: 0, y: 0 }),
    createRectangleEntity(createSketchEntityId("skent_r-rect"), [
      bottom,
      right,
      top,
      left,
    ]),
  ];
}

/** A rectangle straddling the y axis (material on both x signs). */
function straddlingSketch(): {
  readonly serialized: ReturnType<typeof serializeSketch>;
  readonly entities: ReturnType<typeof buildStraddler>;
} {
  const entities = buildStraddler();
  const created = createSketch(xyWorkplane(), entities, []);
  if (!created.ok) throw new Error(created.error.message);
  return { serialized: serializeSketch(created.value), entities };
}

function buildStraddler() {
  return [
    createLineEntity(
      createSketchEntityId("skent_s-a"),
      { x: -10, y: 5 },
      { x: 10, y: 5 },
    ),
    createLineEntity(
      createSketchEntityId("skent_s-b"),
      { x: 10, y: 5 },
      { x: 10, y: 20 },
    ),
    createLineEntity(
      createSketchEntityId("skent_s-c"),
      { x: 10, y: 20 },
      { x: -10, y: 20 },
    ),
    createLineEntity(
      createSketchEntityId("skent_s-d"),
      { x: -10, y: 20 },
      { x: -10, y: 5 },
    ),
  ];
}

/** Builds the wired revolve document with the given parameters. */
function buildDocument(
  sketchPayload: Record<string, unknown>,
  sweepRad: number,
  axisRad: number,
): CadDocument {
  let document = createDocument(DOC);
  const sketched = addDocumentSketch(document, {
    id: SKETCH,
    name: "revolve profile",
    sketch: sketchPayload,
  });
  if (!sketched.ok) throw new Error(sketched.error.message);
  document = sketched.value.document;
  for (const [id, name, value] of [
    [SWEEP, "revolveSweep", angle(sweepRad, "rad")],
    [AXIS, "revolveAxis", angle(axisRad, "rad")],
  ] as const) {
    const parameter = addDocumentParameter(document, { id, name, value });
    if (!parameter.ok) throw new Error(parameter.error.message);
    document = parameter.value.document;
  }
  const body = addBody(document, { id: BODY, name: "revolved" });
  if (!body.ok) throw new Error(body.error.message);
  document = body.value.document;
  const featured = addFeature(document, {
    id: FEATURE,
    kind: "revolve",
    inputs: [
      { kind: "sketch", id: SKETCH },
      { kind: "parameter", id: SWEEP },
      { kind: "parameter", id: AXIS },
    ],
    outputs: [BODY],
  });
  if (!featured.ok) throw new Error(featured.error.message);
  return featured.value.document;
}

describe("resolveRevolveSubmission", () => {
  it("resolves the axis-touching rectangle about the X axis into the full submission", () => {
    const { serialized, entities } = touchingRectangleSketch();
    const created = createSketch(xyWorkplane(), entities, []);
    if (!created.ok) throw new Error(created.error.message);
    const resolution = resolveRevolveSubmission({
      sketch: serialized,
      entities: created.value.entities,
      workplane: created.value.workplane,
      axisDirectionRad: REVOLVE_AXIS_X_RAD,
    });
    expect(resolution.ok).toBe(true);
    if (!resolution.ok) return;
    expect(resolution.value.loop.length).toBe(4);
    expect(resolution.value.axis).toEqual({ point: [0, 0], direction: [1, 0] });
    expect(resolution.value.sweepRad).toBe(REVOLVE_DEFAULT_SWEEP_RAD);
    expect(resolution.value.axisDirectionRad).toBe(0);
    expect(resolution.value.placement.rotation.angle.value).toBe(0);
  });

  it("refuses the crossing profile about the Y axis with the structured code", () => {
    // The straddler spans x ∈ [−10, 10]: about the Y axis it has material
    // strictly on both sides — the structured refusal.
    const { serialized, entities } = straddlingSketch();
    const created = createSketch(xyWorkplane(), entities, []);
    if (!created.ok) throw new Error(created.error.message);
    const resolution = resolveRevolveSubmission({
      sketch: serialized,
      entities: created.value.entities,
      workplane: created.value.workplane,
      axisDirectionRad: REVOLVE_AXIS_Y_RAD,
    });
    expect(resolution.ok).toBe(false);
    if (resolution.ok) return;
    expect(resolution.code).toBe(KERNEL_ERROR_CODES.profileAxisCrossing);
    expect(resolution.message).toContain("crosses");
  });

  it("accepts the touching rectangle about the Y axis (touching is legal)", () => {
    const { serialized, entities } = touchingRectangleSketch();
    const created = createSketch(xyWorkplane(), entities, []);
    if (!created.ok) throw new Error(created.error.message);
    const resolution = resolveRevolveSubmission({
      sketch: serialized,
      entities: created.value.entities,
      workplane: created.value.workplane,
      axisDirectionRad: REVOLVE_AXIS_Y_RAD,
    });
    expect(resolution.ok).toBe(true);
  });

  it("carries the sketch domain's structured failure codes verbatim", () => {
    const openEntities = [
      createLineEntity(
        createSketchEntityId("skent_o-a"),
        { x: 0, y: 0 },
        { x: 10, y: 0 },
      ),
    ];
    const created = createSketch(xyWorkplane(), openEntities, []);
    if (!created.ok) throw new Error(created.error.message);
    const resolution = resolveRevolveSubmission({
      sketch: serializeSketch(created.value),
      entities: created.value.entities,
      workplane: created.value.workplane,
      axisDirectionRad: REVOLVE_AXIS_X_RAD,
    });
    expect(resolution.ok).toBe(false);
    if (resolution.ok) return;
    expect(resolution.code).toBe("sketch/profile-open-chain");
  });
});

describe("documentRevolveRequest", () => {
  it("derives the worker-scene request: loop, axis, sweep, body", () => {
    const { serialized } = touchingRectangleSketch();
    const request = documentRevolveRequest(
      buildDocument(
        serialized as unknown as Record<string, unknown>,
        Math.PI * 2,
        0,
      ),
    );
    expect(request).not.toBeNull();
    expect(request?.loop.length).toBe(4);
    expect(request?.axis).toEqual({ point: [0, 0], direction: [1, 0] });
    expect(request?.angleRad).toBe(Math.PI * 2);
    expect(request?.bodyId).toBe(BODY);
  });

  it("re-derives the axis line after an axis parameter edit", () => {
    const { serialized } = touchingRectangleSketch();
    const document = buildDocument(
      serialized as unknown as Record<string, unknown>,
      Math.PI * 2,
      0,
    );
    const flipped = applyCommand(document, {
      type: "parameter.set",
      id: AXIS,
      value: angle(Math.PI / 2, "rad"),
    });
    expect(flipped.ok).toBe(true);
    if (!flipped.ok) return;
    const request = documentRevolveRequest(flipped.value);
    expect(request?.axis.direction[0]).toBeCloseTo(0, 12);
    expect(request?.axis.direction[1]).toBeCloseTo(1, 12);
  });

  it("carries a partial sweep after a sweep parameter edit", () => {
    const { serialized } = touchingRectangleSketch();
    const document = buildDocument(
      serialized as unknown as Record<string, unknown>,
      Math.PI * 2,
      0,
    );
    const edited = applyCommand(document, {
      type: "parameter.set",
      id: SWEEP,
      value: angle(Math.PI, "rad"),
    });
    expect(edited.ok).toBe(true);
    if (!edited.ok) return;
    const request = documentRevolveRequest(edited.value);
    expect(request?.angleRad).toBe(Math.PI);
  });

  it("returns null for a document without a revolve feature", () => {
    expect(documentRevolveRequest(createDocument(DOC))).toBeNull();
  });
});

describe("the wired resolver executes against the fake kernel", () => {
  it("runs the page's exact executor composition end to end", () => {
    const { serialized } = touchingRectangleSketch();
    const document = buildDocument(
      serialized as unknown as Record<string, unknown>,
      Math.PI * 2,
      0,
    );
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
    expect(run.ok).toBe(true);
    if (!run.ok) return;
    const solid = bridge.solidOf(BODY);
    expect(solid).toBeDefined();
    if (solid === undefined) return;
    const volume = kernel.volume(solid);
    expect(volume.ok).toBe(true);
    if (!volume.ok) return;
    expect(volume.value).toBeCloseTo(Math.PI * 25 ** 2 * 30, 4);
  });

  it("halves the volume through a sweep parameter.set (the regeneration path)", () => {
    const { serialized } = touchingRectangleSketch();
    const document = buildDocument(
      serialized as unknown as Record<string, unknown>,
      Math.PI * 2,
      0,
    );
    const edited = applyCommand(document, {
      type: "parameter.set",
      id: SWEEP,
      value: angle(Math.PI, "rad"),
    });
    expect(edited.ok).toBe(true);
    if (!edited.ok) return;
    const kernel = createFakeKernel();
    const bridge = createKernelFeatureExecutor(kernel, {
      document: edited.value,
      bodies: new Map(),
      profiles: sketchProfileResolverOf(edited.value),
    });
    const run = regenerate({
      features: edited.value.features,
      states: initialRegenerationStates(edited.value.features),
      suppressed: [],
      execute: bridge.executor,
    });
    if (!run.ok) throw new Error(run.error.message);
    const solid = bridge.solidOf(BODY);
    expect(solid).toBeDefined();
    if (solid === undefined) return;
    const volume = kernel.volume(solid);
    expect(volume.ok).toBe(true);
    if (!volume.ok) return;
    expect(volume.value).toBeCloseTo((Math.PI * 25 ** 2 * 30) / 2, 4);
  });
});
