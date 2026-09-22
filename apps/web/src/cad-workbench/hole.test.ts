/**
 * The workbench hole wiring tests (Phase 26.10): the document → hole-scene
 * request derivation — base resolution through the extrude reader, each
 * hole's five parameters in role order, the parameter-edit path, the
 * structured nulls for unresolvable layouts — and an end-to-end bridge
 * execution against the fake kernel exactly as the page wires it, at the
 * analytic plate-with-hole volume.
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
  dimensionless,
  initialRegenerationStates,
  length,
  regenerate,
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
import {
  createFakeKernel,
  createKernelFeatureExecutor,
} from "@slopcad/cad-kernel";

import {
  extrudeSceneRequestOfFeature,
  sketchProfileResolverOf,
} from "./extrude";
import {
  defaultHolePosition,
  documentHoleSceneRequest,
  holeBaseFeatureOf,
  HOLE_DEFAULT_AXIS,
  HOLE_DEFAULT_DIAMETER_MM,
  HOLE_DEFAULT_DEPTH_MM,
  type HoleCutInput,
  type HoleSceneRequest,
} from "./hole";

/** The request's flat-form entry at `index` (undefined for structured). */
function flatHoleAt(
  request: HoleSceneRequest,
  index: number,
): HoleCutInput | undefined {
  const entry = request.holes[index];
  return entry !== undefined && !("kind" in entry) ? entry : undefined;
}

const DOC = createDocumentId("doc_hole_wiring");
const SKETCH = createSketchDocumentId("skd_profile");
const BASE_BODY = createBodyId("body_pad");
const DEPTH = createParameterId("param_extrude_depth");
const EXTRUDE = createFeatureId("feat_extrude");

const pDiameter = createParameterId("param_hole_diameter");
const pDepth = createParameterId("param_hole_depth");
const pX = createParameterId("param_hole_x");
const pY = createParameterId("param_hole_y");
const pAxis = createParameterId("param_hole_axis");

const HOLE_BODY = createBodyId("body_holed");
const HOLE = createFeatureId("feat_hole");
/** A feature id no document feature carries (the retarget case). */
const ABSENT_BASE = createFeatureId("feat_hole_absent_base");

/** A 20×15 rectangle sketch on the XY workplane, serialized (the payload). */
function rectangleSketchPayload(): Record<string, unknown> {
  const bottom = createSketchEntityId("skent_h-bottom");
  const right = createSketchEntityId("skent_h-right");
  const top = createSketchEntityId("skent_h-top");
  const left = createSketchEntityId("skent_h-left");
  const created = createSketch(
    xyWorkplane(),
    [
      createLineEntity(bottom, { x: 10, y: 10 }, { x: 30, y: 10 }),
      createLineEntity(right, { x: 30, y: 10 }, { x: 30, y: 25 }),
      createLineEntity(top, { x: 30, y: 25 }, { x: 10, y: 25 }),
      createLineEntity(left, { x: 10, y: 25 }, { x: 10, y: 10 }),
      createRectangleEntity(createSketchEntityId("skent_h-rect"), [
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

/** Builds the sketch → extrude → hole document with the given hole numbers. */
function buildDocument(hole: {
  readonly diameterMm: number;
  readonly depthMm: number;
  readonly xMm: number;
  readonly yMm: number;
  readonly axis: number;
}): CadDocument {
  let document = createDocument(DOC);
  const sketched = addDocumentSketch(document, {
    id: SKETCH,
    name: "profile",
    sketch: rectangleSketchPayload(),
  });
  if (!sketched.ok) throw new Error(sketched.error.message);
  document = sketched.value.document;
  for (const [id, name, value] of [
    [DEPTH, "extrudeDepth", length(10)],
    [pDiameter, "holeDiameter", length(hole.diameterMm)],
    [pDepth, "holeDepth", length(hole.depthMm)],
    [pX, "holeX", length(hole.xMm)],
    [pY, "holeY", length(hole.yMm)],
    [pAxis, "holeAxis", dimensionless(hole.axis)],
  ] as const) {
    const parameter = addDocumentParameter(document, { id, name, value });
    if (!parameter.ok) throw new Error(parameter.error.message);
    document = parameter.value.document;
  }
  const baseBody = addBody(document, { id: BASE_BODY, name: "pad" });
  if (!baseBody.ok) throw new Error(baseBody.error.message);
  document = baseBody.value.document;
  const holedBody = addBody(document, { id: HOLE_BODY, name: "holed" });
  if (!holedBody.ok) throw new Error(holedBody.error.message);
  document = holedBody.value.document;
  for (const feature of [
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
  ] as const) {
    const featured = addFeature(document, feature);
    if (!featured.ok) throw new Error(featured.error.message);
    document = featured.value.document;
  }
  return document;
}

function buildDefaultDocument(): CadDocument {
  return buildDocument({
    diameterMm: HOLE_DEFAULT_DIAMETER_MM,
    depthMm: HOLE_DEFAULT_DEPTH_MM,
    xMm: 20,
    yMm: 17.5,
    axis: HOLE_DEFAULT_AXIS,
  });
}

describe("holeBaseFeatureOf", () => {
  it("names the document's last extrude feature as the next hole's base", () => {
    const base = holeBaseFeatureOf(buildDefaultDocument());
    expect(base?.id).toBe(EXTRUDE);
  });

  it("is undefined before any solid exists", () => {
    expect(holeBaseFeatureOf(createDocument(DOC))).toBeUndefined();
  });
});

describe("defaultHolePosition", () => {
  it("centers the hole on the rendered top face", () => {
    const position = defaultHolePosition({
      min: [10, 10, 0],
      max: [30, 25, 10],
    });
    expect(position.x).toBe(20);
    expect(position.y).toBe(17.5);
  });
});

describe("documentHoleSceneRequest", () => {
  it("derives the scene request: base extrusion plus each hole's five numbers", () => {
    const derived = documentHoleSceneRequest(buildDefaultDocument());
    expect(derived).not.toBeNull();
    expect(derived?.bodyId).toBe(HOLE_BODY);
    expect(derived?.request.base.distanceMm).toBe(10);
    expect(derived?.request.base.loop.length).toBe(4);
    expect(derived?.request.holes).toEqual([
      {
        diameterMm: 8,
        depthMm: 4,
        positionXMm: 20,
        positionYMm: 17.5,
        axis: 3,
      },
    ]);
  });

  it("carries a diameter parameter.set into the request (the regeneration path)", () => {
    const document = buildDefaultDocument();
    const set = applyCommand(document, {
      type: "parameter.set",
      id: pDiameter,
      value: length(12),
    });
    if (!set.ok) throw new Error(set.error.message);
    const derived = documentHoleSceneRequest(set.value);
    expect(derived).not.toBeNull();
    if (derived === null) return;
    expect(flatHoleAt(derived.request, 0)?.diameterMm).toBe(12);
    expect(flatHoleAt(derived.request, 0)?.depthMm).toBe(4);
  });

  it("carries a position parameter.set into the request", () => {
    const document = buildDefaultDocument();
    const set = applyCommand(document, {
      type: "parameter.set",
      id: pX,
      value: length(24),
    });
    if (!set.ok) throw new Error(set.error.message);
    const derived = documentHoleSceneRequest(set.value);
    expect(derived).not.toBeNull();
    if (derived === null) return;
    expect(flatHoleAt(derived.request, 0)?.positionXMm).toBe(24);
  });

  it("returns null for a document without a hole feature", () => {
    let document = createDocument(DOC);
    const sketched = addDocumentSketch(document, {
      id: SKETCH,
      name: "profile",
      sketch: rectangleSketchPayload(),
    });
    if (!sketched.ok) throw new Error(sketched.error.message);
    document = sketched.value.document;
    expect(documentHoleSceneRequest(document)).toBeNull();
  });

  it("returns null when the hole's target is not the document's extrusion", () => {
    const document = buildDefaultDocument();
    const retargeted = {
      ...document,
      features: document.features.map((feature) =>
        feature.id === HOLE
          ? {
              ...feature,
              inputs: [
                { kind: "feature" as const, id: ABSENT_BASE },
                { kind: "parameter" as const, id: pDiameter },
                { kind: "parameter" as const, id: pDepth },
                { kind: "parameter" as const, id: pX },
                { kind: "parameter" as const, id: pY },
                { kind: "parameter" as const, id: pAxis },
              ],
            }
          : feature,
      ),
    };
    expect(documentHoleSceneRequest(retargeted)).toBeNull();
  });

  it("returns null when a hole parameter no longer resolves", () => {
    const document = buildDefaultDocument();
    const dropped = {
      ...document,
      parameters: {
        ...document.parameters,
        parameters: document.parameters.parameters.filter(
          (parameter) => parameter.id !== pDiameter,
        ),
      },
    };
    expect(documentHoleSceneRequest(dropped)).toBeNull();
  });
});

describe("the wired request executes against the fake kernel", () => {
  it("runs the page's exact composition end to end at the analytic volume", () => {
    const document = buildDefaultDocument();
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
    const solid = bridge.solidOf(HOLE_BODY);
    expect(solid).toBeDefined();
    if (solid === undefined) return;
    const volume = kernel.volume(solid);
    expect(volume.ok).toBe(true);
    if (!volume.ok) return;
    // 20×15×10 pad (3000 mm³) minus the Ø8×4 blind hole. The hole tool is
    // an extruded CIRCLE, which the fake kernel chords at its documented
    // angular deflection — the shared curved-profile band, not exactness.
    const analytic = 3000 - Math.PI * 4 ** 2 * 4;
    expect(Math.abs(volume.value - analytic) / analytic).toBeLessThan(0.02);
  });

  it("keeps the extrude reader's own path working through the feature-scoped refactor", () => {
    const document = buildDefaultDocument();
    const base = document.features.find((feature) => feature.id === EXTRUDE);
    if (base === undefined) throw new Error("the base extrude must exist");
    const request = extrudeSceneRequestOfFeature(document, base);
    expect(request?.distanceMm).toBe(10);
    expect(request?.loop.length).toBe(4);
  });
});
