/**
 * The mirror feature's bridge tests on a REAL kernel (Phase 26.9's semantic
 * close of the loop, the pattern file's twin): the cad-kernel suite pins
 * the mirror feature's execution and failure taxonomy on the fake kernel;
 * these tests execute the same bridge kind against the OpenCascade kernel,
 * whose exact BREP reflection makes the plane semantics — and the plan's
 * validation, `parameter.set` regenerating the geometry — measurable end
 * to end.
 *
 * Fixture: a 10 mm cube translated to x ∈ [20, 30], y ∈ [−5, 5],
 * z ∈ [0, 10] — off every candidate plane, so each reflected copy is
 * disjoint from its source (volumes and bounds then exact, `EXACT_*`
 * tolerances).
 */

import { beforeAll, describe, expect, it } from "vitest";
import {
  addBody,
  addDocumentParameter,
  addFeature,
  applyCommand,
  type CadDocument,
  createBodyId,
  createDocument,
  createDocumentId,
  createFeatureId,
  createParameterId,
  dimensionless,
  type FeatureRecordInput,
  initialRegenerationStates,
  length,
  regenerate,
} from "@slopcad/cad-core";
import {
  assertBoundsEqual,
  assertVolumeClose,
  createKernelFeatureExecutor,
  unwrapKernelResult,
} from "@slopcad/cad-kernel";
import {
  EXACT_BOUNDS_TOLERANCE,
  EXACT_VOLUME_TOLERANCE,
} from "@slopcad/cad-kernel/contract-suite";

import { occtKernelFromRuntime } from "./occt-kernel";
import { createOcctRuntime, type OcctRuntime } from "./occt-runtime";

let runtime: OcctRuntime;

beforeAll(async () => {
  runtime = await createOcctRuntime();
});

const pWidth = createParameterId("param_occt_mirror_w");
const pDepth = createParameterId("param_occt_mirror_d");
const pHeight = createParameterId("param_occt_mirror_h");
const pOffsetX = createParameterId("param_occt_mirror_offset_x");
const pOffsetY = createParameterId("param_occt_mirror_offset_y");
const pOffsetZ = createParameterId("param_occt_mirror_offset_z");
const pPlane = createParameterId("param_occt_mirror_plane");
const pMirrorOffset = createParameterId("param_occt_mirror_offset");

const bCube = createBodyId("body_occt_mirror_cube");
const bPlaced = createBodyId("body_occt_mirror_placed");
const bMirror = createBodyId("body_occt_mirror_result");
const bUnion = createBodyId("body_occt_mirror_union");
const fCube = createFeatureId("feat_occt_mirror_cube");
const fPlace = createFeatureId("feat_occt_mirror_place");
const fMirror = createFeatureId("feat_occt_mirror");
const fUnion = createFeatureId("feat_occt_mirror_union");

/** Adds the cube + translate features and the mirror's two parameters. */
function buildMirrorDocument(
  plane: number,
  offsetMm: number,
  withUnion: boolean,
): CadDocument {
  let document = createDocument(createDocumentId("doc_occt_bridge_mirror"));
  for (const [id, name, value] of [
    [pWidth, "cubeWidth", length(10)],
    [pDepth, "cubeDepth", length(10)],
    [pHeight, "cubeHeight", length(10)],
    [pOffsetX, "offsetX", length(20)],
    [pOffsetY, "offsetY", length(-5)],
    [pOffsetZ, "offsetZ", length(0)],
    [pPlane, "mirrorPlane", dimensionless(plane)],
    [pMirrorOffset, "mirrorOffset", length(offsetMm)],
  ] as const) {
    const added = addDocumentParameter(document, { id, name, value });
    if (!added.ok) throw new Error(added.error.message);
    document = added.value.document;
  }
  for (const body of [
    { id: bCube, name: "cube" },
    { id: bPlaced, name: "placed" },
    { id: bMirror, name: "mirror" },
    ...(withUnion ? [{ id: bUnion, name: "union" }] : []),
  ]) {
    const added = addBody(document, body);
    if (!added.ok) throw new Error(added.error.message);
    document = added.value.document;
  }
  const unionFeatures: readonly FeatureRecordInput[] = withUnion
    ? [
        {
          id: fUnion,
          kind: "union",
          inputs: [
            { kind: "feature", id: fPlace },
            { kind: "feature", id: fMirror },
          ],
          outputs: [bUnion],
        },
      ]
    : [];
  const features: readonly FeatureRecordInput[] = [
    {
      id: fCube,
      kind: "box",
      inputs: [
        { kind: "parameter", id: pWidth },
        { kind: "parameter", id: pDepth },
        { kind: "parameter", id: pHeight },
      ],
      outputs: [bCube],
    },
    {
      id: fPlace,
      kind: "translate",
      inputs: [
        { kind: "feature", id: fCube },
        { kind: "parameter", id: pOffsetX },
        { kind: "parameter", id: pOffsetY },
        { kind: "parameter", id: pOffsetZ },
      ],
      outputs: [bPlaced],
    },
    {
      id: fMirror,
      kind: "mirror",
      inputs: [
        { kind: "feature", id: fPlace },
        { kind: "parameter", id: pPlane },
        { kind: "parameter", id: pMirrorOffset },
      ],
      outputs: [bMirror],
    },
    ...unionFeatures,
  ];
  for (const feature of features) {
    const added = addFeature(document, feature);
    if (!added.ok) throw new Error(added.error.message);
    document = added.value.document;
  }
  return document;
}

/** Regenerates a mirror document against a fresh OCCT kernel. */
function runMirror(document: CadDocument) {
  const kernel = occtKernelFromRuntime(runtime);
  const bridge = createKernelFeatureExecutor(kernel, {
    document,
    bodies: new Map(),
    profiles: () => ({
      ok: false,
      error: {
        code: "document/not-found",
        message: "mirrors resolve no sketches",
        input: null,
      },
    }),
  });
  const run = regenerate({
    features: document.features,
    states: initialRegenerationStates(document.features),
    suppressed: [],
    execute: bridge.executor,
  });
  if (!run.ok) throw new Error(run.error.message);
  const solid = bridge.solidOf(bMirror);
  expect(solid).toBeDefined();
  if (solid === undefined) throw new Error("The mirror body has no solid.");
  return { kernel, bridge, solid, run: run.value };
}

describe("bridge mirror on the OpenCascade kernel (real BREP reflection)", () => {
  it("executes the mirror feature through the YZ plane at x = 5: exact reflection", () => {
    // The placed cube spans x ∈ [20, 30]; through the plane x = 5 it flips
    // to [2·5 − 30, 2·5 − 20] = [−20, −10] — disjoint from the source, so
    // the union of source and mirror is exactly two cubes.
    const document = buildMirrorDocument(1, 5, true);
    const { kernel, bridge, solid, run } = runMirror(document);
    expect(run.executed).toEqual([fCube, fPlace, fMirror, fUnion]);
    assertVolumeClose(
      unwrapKernelResult(kernel.volume(solid), "mirror volume"),
      10 ** 3,
      EXACT_VOLUME_TOLERANCE,
    );
    assertBoundsEqual(
      unwrapKernelResult(kernel.bounds(solid), "mirror bounds"),
      { min: [-20, -5, 0], max: [-10, 5, 10] },
      EXACT_BOUNDS_TOLERANCE,
    );
    const union = bridge.solidOf(bUnion);
    expect(union).toBeDefined();
    if (union === undefined) return;
    assertVolumeClose(
      unwrapKernelResult(kernel.volume(union), "union volume"),
      2 * 10 ** 3,
      EXACT_VOLUME_TOLERANCE,
    );
    assertBoundsEqual(
      unwrapKernelResult(kernel.bounds(union), "union bounds"),
      { min: [-20, -5, 0], max: [30, 5, 10] },
      EXACT_BOUNDS_TOLERANCE,
    );
  });

  it("regenerates from parameter.set on the offset: the plane slides", () => {
    const document = buildMirrorDocument(1, 5, false);
    const set = applyCommand(document, {
      type: "parameter.set",
      id: pMirrorOffset,
      value: length(0),
    });
    if (!set.ok) throw new Error(set.error.message);
    // The same YZ family through the origin: x ∈ [20, 30] flips to [−30, −20].
    const { kernel, solid } = runMirror(set.value);
    assertBoundsEqual(
      unwrapKernelResult(kernel.bounds(solid), "mirror bounds"),
      { min: [-30, -5, 0], max: [-20, 5, 10] },
      EXACT_BOUNDS_TOLERANCE,
    );
    assertVolumeClose(
      unwrapKernelResult(kernel.volume(solid), "mirror volume"),
      10 ** 3,
      EXACT_VOLUME_TOLERANCE,
    );
  });

  it("regenerates from parameter.set on the plane selector: 1 (YZ) → 2 (XZ)", () => {
    const document = buildMirrorDocument(1, 0, false);
    const set = applyCommand(document, {
      type: "parameter.set",
      id: pPlane,
      value: dimensionless(2),
    });
    if (!set.ok) throw new Error(set.error.message);
    // Plane 2 = XZ (normal +y) through the origin: y ∈ [−5, 5] flips onto
    // itself — the cube straddles that plane, so the mirror IS the cube.
    // The MIRROR body's own reflected-onto-itself bounds prove the
    // selector changed the plane (a stale YZ mirror would flip x).
    const { kernel, solid } = runMirror(set.value);
    assertBoundsEqual(
      unwrapKernelResult(kernel.bounds(solid), "mirror bounds"),
      { min: [20, -5, 0], max: [30, 5, 10] },
      EXACT_BOUNDS_TOLERANCE,
    );
    assertVolumeClose(
      unwrapKernelResult(kernel.volume(solid), "mirror volume"),
      10 ** 3,
      EXACT_VOLUME_TOLERANCE,
    );
  });
});
