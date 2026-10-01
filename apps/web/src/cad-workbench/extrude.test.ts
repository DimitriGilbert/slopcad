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
  getDocumentSketch,
  length,
  type CadDocument,
} from "@slopcad/cad-core";
import {
  createDistanceXConstraint,
  createHorizontalConstraint,
  createLineEntity,
  createRectangleEntity,
  createSketch,
  createSketchConstraintId,
  createSketchEntityId,
  createVerticalConstraint,
  frontWorkplane,
  parseSketch,
  pointTarget,
  serializeSketch,
  xyWorkplane,
} from "@slopcad/cad-sketch";
import { createFakeKernel } from "@slopcad/cad-kernel";
import { createKernelFeatureExecutor } from "@slopcad/cad-kernel";
import { regenerate, initialRegenerationStates } from "@slopcad/cad-react";

import {
  documentExtrudeRequest,
  resolveDocumentSketch,
  sketchIdsBoundToParameters,
  sketchProfileResolverOf,
} from "./extrude";

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

// ---------------------------------------------------------------------------
// Phase 26a: parameter-bound sketch dimensions
// ---------------------------------------------------------------------------

describe("parameter-bound sketch resolution", () => {
  const BOARD_L = createParameterId("param_boardL");

  /** A 20-wide rectangle whose distanceX width dimension binds `boardL`. */
  function boundSketchPayload(): Record<string, unknown> {
    const bottom = createSketchEntityId("skent_b-bottom");
    const right = createSketchEntityId("skent_b-right");
    const top = createSketchEntityId("skent_b-top");
    const left = createSketchEntityId("skent_b-left");
    const width = createSketchConstraintId("skcon_b-width");
    const created = createSketch(
      xyWorkplane(),
      [
        createLineEntity(bottom, { x: 10, y: 10 }, { x: 30, y: 10 }),
        createLineEntity(right, { x: 30, y: 10 }, { x: 30, y: 25 }),
        createLineEntity(top, { x: 30, y: 25 }, { x: 10, y: 25 }),
        createLineEntity(left, { x: 10, y: 25 }, { x: 10, y: 10 }),
        createRectangleEntity(createSketchEntityId("skent_b-rect"), [
          bottom,
          right,
          top,
          left,
        ]),
      ],
      [
        createHorizontalConstraint(
          createSketchConstraintId("skcon_b-h"),
          bottom,
        ),
        createHorizontalConstraint(createSketchConstraintId("skcon_b-t"), top),
        createVerticalConstraint(createSketchConstraintId("skcon_b-l"), left),
        createVerticalConstraint(createSketchConstraintId("skcon_b-r"), right),
        {
          ...createDistanceXConstraint(
            width,
            pointTarget(left, "center"),
            pointTarget(right, "center"),
            length(20),
          ),
          parameterId: BOARD_L,
        },
      ],
    );
    if (!created.ok) throw new Error(created.error.message);
    return serializeSketch(created.value) as unknown as Record<string, unknown>;
  }

  function documentWithParameter(
    sketchPayload: Record<string, unknown>,
    boardLMm: number,
  ): CadDocument {
    let document = createDocument(DOC);
    const sketched = addDocumentSketch(document, {
      id: SKETCH,
      name: "bound profile",
      sketch: sketchPayload,
    });
    if (!sketched.ok) throw new Error(sketched.error.message);
    document = sketched.value.document;
    const parameter = addDocumentParameter(document, {
      id: BOARD_L,
      name: "boardL",
      value: length(boardLMm),
    });
    if (!parameter.ok) throw new Error(parameter.error.message);
    return parameter.value.document;
  }

  it("an unbound sketch resolves reference-identically (the literal path unchanged)", () => {
    const document = documentWithParameter(rectangleSketchPayload(), 26);
    const parsed = parseSketch(getDocumentSketch(document, SKETCH)?.sketch);
    if (!parsed.ok) throw new Error(parsed.error.message);
    const resolved = resolveDocumentSketch(document, parsed.value);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.value).toBe(parsed.value);
  });

  it("a bound sketch re-solves against the CURRENT parameter value", () => {
    const document = documentWithParameter(boundSketchPayload(), 40);
    const parsed = parseSketch(getDocumentSketch(document, SKETCH)?.sketch);
    if (!parsed.ok) throw new Error(parsed.error.message);
    const resolved = resolveDocumentSketch(document, parsed.value);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    // The stored geometry holds the drawn 20; the re-solve widened the
    // rectangle to the parameter's 40 (the solver distributes the move
    // across the under-constrained edges).
    const centerX = (id: string): number => {
      const line = resolved.value.entities.find((entity) => entity.id === id);
      if (line === undefined || line.kind !== "line") {
        throw new Error(`unreachable: line ${id} re-solved`);
      }
      return (line.x1 + line.x2) / 2;
    };
    expect(centerX("skent_b-right") - centerX("skent_b-left")).toBeCloseTo(
      40,
      6,
    );
  });

  it("a bound profile re-drives the kernel loop when the parameter edits", () => {
    const document = documentWithParameter(boundSketchPayload(), 40);
    const resolved = sketchProfileResolverOf(document)(SKETCH);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    const width = resolved.value.loop
      .map((segment) =>
        segment.kind === "line" ? segment.start[0] - segment.end[0] : 0,
      )
      .filter((span) => Math.abs(Math.abs(span) - 40) < 1e-6);
    expect(width.length).toBe(2);
    // …and a parameter.set re-drives the same resolver to the new geometry.
    const edited = applyCommand(document, {
      type: "parameter.set",
      id: BOARD_L,
      value: length(60),
    });
    expect(edited.ok).toBe(true);
    if (!edited.ok) return;
    const redriven = sketchProfileResolverOf(edited.value)(SKETCH);
    expect(redriven.ok).toBe(true);
    if (!redriven.ok) return;
    const spans = redriven.value.loop
      .map((segment) =>
        segment.kind === "line"
          ? Math.abs(segment.start[0] - segment.end[0])
          : 0,
      )
      .filter((span) => Math.abs(span - 60) < 1e-6);
    expect(spans.length).toBe(2);
  });

  it("a dangling binding refuses with the structured diagnostic code", () => {
    // Bind to a parameter id the document does not carry.
    let document = createDocument(DOC);
    const sketched = addDocumentSketch(document, {
      id: SKETCH,
      name: "dangling",
      sketch: boundSketchPayload(),
    });
    if (!sketched.ok) throw new Error(sketched.error.message);
    document = sketched.value.document;
    const resolved = sketchProfileResolverOf(document)(SKETCH);
    expect(resolved).toMatchObject({
      ok: false,
      error: { code: "sketch/dimension-binding-unresolved" },
    });
  });

  it("sketchIdsBoundToParameters finds exactly the consuming-bound sketches", () => {
    const document = documentWithParameter(boundSketchPayload(), 26);
    expect(sketchIdsBoundToParameters(document, new Set())).toEqual([]);
    expect(sketchIdsBoundToParameters(document, new Set([BOARD_L]))).toEqual([
      SKETCH,
    ]);
    expect(sketchIdsBoundToParameters(document, new Set([DEPTH]))).toEqual([]);
  });
});
