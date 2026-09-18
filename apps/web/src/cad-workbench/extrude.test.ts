/**
 * The workbench extrude wiring tests (Phase 26.1): the document → profile
 * resolution adapter (the bridge's resolver seam) and the worker-scene
 * request derivation — including structured failure codes riding through,
 * the parameter-edit path, and an end-to-end bridge execution against the
 * fake kernel exactly as the page wires it.
 */

import { describe, expect, it } from "vitest";
import {
  addBody,
  addDocumentParameter,
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
  frontWorkplane,
  serializeSketch,
  xyWorkplane,
} from "@slopcad/cad-sketch";
import { createFakeKernel } from "@slopcad/cad-kernel";
import { createKernelFeatureExecutor } from "@slopcad/cad-kernel";
import { regenerate, initialRegenerationStates } from "@slopcad/cad-react";

import { documentExtrudeRequest, sketchProfileResolverOf } from "./extrude";

const DOC = createDocumentId("doc_extrude_wiring");
const SKETCH = createSketchDocumentId("skd_profile");
const BODY = createBodyId("body_pad");
const DEPTH = createParameterId("param_extrude_depth");
const FEATURE = createFeatureId("feat_extrude");

/** A 20×15 rectangle sketch on the XY workplane, serialized (the payload). */
function rectangleSketchPayload(): Record<string, unknown> {
  const bottom = createSketchEntityId("skent_w-bottom");
  const right = createSketchEntityId("skent_w-right");
  const top = createSketchEntityId("skent_w-top");
  const left = createSketchEntityId("skent_w-left");
  const created = createSketch(
    xyWorkplane(),
    [
      createLineEntity(bottom, { x: 10, y: 10 }, { x: 30, y: 10 }),
      createLineEntity(right, { x: 30, y: 10 }, { x: 30, y: 25 }),
      createLineEntity(top, { x: 30, y: 25 }, { x: 10, y: 25 }),
      createLineEntity(left, { x: 10, y: 25 }, { x: 10, y: 10 }),
      createRectangleEntity(createSketchEntityId("skent_w-rect"), [
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

/** An open-chain sketch payload (two disconnected lines). */
function openSketchPayload(): Record<string, unknown> {
  const created = createSketch(
    xyWorkplane(),
    [
      createLineEntity(
        createSketchEntityId("skent_o-a"),
        { x: 0, y: 0 },
        { x: 10, y: 0 },
      ),
      createLineEntity(
        createSketchEntityId("skent_o-b"),
        { x: 10, y: 0 },
        { x: 10, y: 7 },
      ),
    ],
    [],
  );
  if (!created.ok) throw new Error(created.error.message);
  return serializeSketch(created.value) as unknown as Record<string, unknown>;
}

/** Builds the wired extrude document with the given sketch payload. */
function buildDocument(
  sketchPayload: Record<string, unknown>,
  depthMm: number,
): CadDocument {
  let document = createDocument(DOC);
  const sketched = addDocumentSketch(document, {
    id: SKETCH,
    name: "profile",
    sketch: sketchPayload,
  });
  if (!sketched.ok) throw new Error(sketched.error.message);
  document = sketched.value.document;
  const parameter = addDocumentParameter(document, {
    id: DEPTH,
    name: "extrudeDepth",
    value: length(depthMm),
  });
  if (!parameter.ok) throw new Error(parameter.error.message);
  document = parameter.value.document;
  const body = addBody(document, { id: BODY, name: "pad" });
  if (!body.ok) throw new Error(body.error.message);
  document = body.value.document;
  const featured = addFeature(document, {
    id: FEATURE,
    kind: "extrude",
    inputs: [
      { kind: "sketch", id: SKETCH },
      { kind: "parameter", id: DEPTH },
    ],
    outputs: [BODY],
  });
  if (!featured.ok) throw new Error(featured.error.message);
  return featured.value.document;
}

describe("sketchProfileResolverOf", () => {
  it("resolves a rectangle sketch into the kernel loop and XY placement", () => {
    const resolved = sketchProfileResolverOf(
      buildDocument(rectangleSketchPayload(), 10),
    )(SKETCH);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.value.loop.length).toBe(4);
    expect(resolved.value.loop[0]?.kind).toBe("line");
    expect(resolved.value.placement.rotation.angle.value).toBe(0);
    expect(resolved.value.placement.translation.x.value).toBe(0);
  });

  it("carries the sketch domain's structured failure codes verbatim", () => {
    const resolved = sketchProfileResolverOf(
      buildDocument(openSketchPayload(), 10),
    )(SKETCH);
    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.error.code).toBe("sketch/profile-open-chain");
  });

  it("fails with document/not-found for an unknown sketch id", () => {
    const resolved = sketchProfileResolverOf(
      buildDocument(rectangleSketchPayload(), 10),
    )(createSketchDocumentId("skd_absent"));
    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.error.code).toBe("document/not-found");
  });

  it("resolves a front-workplane sketch into the −y-normal placement", () => {
    const created = createSketch(
      frontWorkplane(4),
      [
        createLineEntity(
          createSketchEntityId("skent_f-a"),
          { x: 0, y: 0 },
          { x: 10, y: 0 },
        ),
        createLineEntity(
          createSketchEntityId("skent_f-b"),
          { x: 10, y: 0 },
          { x: 10, y: 10 },
        ),
        createLineEntity(
          createSketchEntityId("skent_f-c"),
          { x: 10, y: 10 },
          { x: 0, y: 10 },
        ),
        createLineEntity(
          createSketchEntityId("skent_f-d"),
          { x: 0, y: 10 },
          { x: 0, y: 0 },
        ),
      ],
      [],
    );
    if (!created.ok) throw new Error(created.error.message);
    let document = createDocument(DOC);
    const sketched = addDocumentSketch(document, {
      id: SKETCH,
      name: "profile",
      sketch: serializeSketch(created.value) as unknown as Record<
        string,
        unknown
      >,
    });
    if (!sketched.ok) throw new Error(sketched.error.message);
    document = sketched.value.document;
    const resolved = sketchProfileResolverOf(document)(SKETCH);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.value.placement.rotation.angle.value).toBeCloseTo(
      Math.PI / 2,
      9,
    );
    expect(resolved.value.placement.translation.y.value).toBe(4);
  });
});

describe("documentExtrudeRequest", () => {
  it("derives the worker-scene request: loop, placement, signed distance, body", () => {
    const request = documentExtrudeRequest(
      buildDocument(rectangleSketchPayload(), 12),
    );
    expect(request).not.toBeNull();
    expect(request?.loop.length).toBe(4);
    expect(request?.distanceMm).toBe(12);
    expect(request?.bodyId).toBe(BODY);
  });

  it("carries a NEGATIVE distance after a parameter.set (direction edit)", () => {
    const document = buildDocument(rectangleSketchPayload(), 12);
    const flipped = applyCommand(document, {
      type: "parameter.set",
      id: DEPTH,
      value: length(-8),
    });
    expect(flipped.ok).toBe(true);
    if (!flipped.ok) return;
    const request = documentExtrudeRequest(flipped.value);
    expect(request?.distanceMm).toBe(-8);
  });

  it("returns null for a document without an extrude feature", () => {
    expect(documentExtrudeRequest(createDocument(DOC))).toBeNull();
  });
});

describe("the wired resolver executes against the fake kernel", () => {
  it("runs the page's exact executor composition end to end", () => {
    const document = buildDocument(rectangleSketchPayload(), 10);
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
    expect(volume.value).toBeCloseTo(20 * 15 * 10, 6);
  });

  it("surfaces an open chain as a failed feature with the profile code", () => {
    const document = buildDocument(openSketchPayload(), 10);
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
    const state = run.value.states.get(FEATURE);
    expect(state?.state).toBe("failed");
    expect(
      (state?.diagnostics[0]?.data as { profileCode?: string } | undefined)
        ?.profileCode,
    ).toBe("sketch/profile-open-chain");
  });
});
