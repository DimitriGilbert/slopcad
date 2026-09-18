/**
 * The pattern features' bridge tests on a REAL rotating kernel (Phase
 * 26.8's semantic close of the loop): the cad-kernel suite pins the linear
 * pattern's geometry on the fake kernel and the circular pattern's
 * COMPOSITION on a recording double (the fake kernel cannot rotate);
 * these tests execute both bridge kinds against the OpenCascade kernel,
 * whose exact BREP transforms and unions make the rotated-copy semantics
 * — and the plan's validation, `parameter.set` regenerating the
 * arrangement — measurable end to end.
 *
 * Fixture: a 10 mm cube translated to x ∈ [20, 30], y ∈ [−5, 5] — off the
 * origin, so circular copies land in separate quadrants and unions stay
 * disjoint (volumes and bounds then exact, `EXACT_*` tolerances).
 */

import { beforeAll, describe, expect, it } from "vitest";
import {
  addBody,
  addDocumentParameter,
  addFeature,
  angle,
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

const pWidth = createParameterId("param_occt_pattern_w");
const pDepth = createParameterId("param_occt_pattern_d");
const pHeight = createParameterId("param_occt_pattern_h");
const pOffsetX = createParameterId("param_occt_pattern_offset_x");
const pOffsetY = createParameterId("param_occt_pattern_offset_y");
const pOffsetZ = createParameterId("param_occt_pattern_offset_z");
const pCount = createParameterId("param_occt_pattern_count");
const pSpacing = createParameterId("param_occt_pattern_spacing");
const pDirection = createParameterId("param_occt_pattern_direction");
const pTotalAngle = createParameterId("param_occt_pattern_total_angle");
const pAxis = createParameterId("param_occt_pattern_axis");

const bCube = createBodyId("body_occt_pattern_cube");
const bPlaced = createBodyId("body_occt_pattern_placed");
const bPattern = createBodyId("body_occt_pattern_result");
const fCube = createFeatureId("feat_occt_pattern_cube");
const fPlace = createFeatureId("feat_occt_pattern_place");
const fPattern = createFeatureId("feat_occt_pattern");

/** Adds the cube + translate features and shared parameters. */
function newPatternDocument(): CadDocument {
  let document = createDocument(createDocumentId("doc_occt_bridge_pattern"));
  for (const [id, name, value] of [
    [pWidth, "cubeWidth", length(10)],
    [pDepth, "cubeDepth", length(10)],
    [pHeight, "cubeHeight", length(10)],
    [pOffsetX, "offsetX", length(20)],
    [pOffsetY, "offsetY", length(-5)],
    [pOffsetZ, "offsetZ", length(0)],
  ] as const) {
    const added = addDocumentParameter(document, { id, name, value });
    if (!added.ok) throw new Error(added.error.message);
    document = added.value.document;
  }
  for (const body of [
    { id: bCube, name: "cube" },
    { id: bPlaced, name: "placed" },
    { id: bPattern, name: "pattern" },
  ]) {
    const added = addBody(document, body);
    if (!added.ok) throw new Error(added.error.message);
    document = added.value.document;
  }
  for (const feature of [
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
  ] as const satisfies readonly FeatureRecordInput[]) {
    const added = addFeature(document, feature);
    if (!added.ok) throw new Error(added.error.message);
    document = added.value.document;
  }
  return document;
}

/** Adds the linear pattern feature + parameters and returns the document. */
function buildLinearDocument(count: number, spacingMm: number): CadDocument {
  let document = newPatternDocument();
  for (const [id, name, value] of [
    [pCount, "patternCount", dimensionless(count)],
    [pSpacing, "patternSpacing", length(spacingMm)],
    [pDirection, "patternDirection", angle(0)],
  ] as const) {
    const added = addDocumentParameter(document, { id, name, value });
    if (!added.ok) throw new Error(added.error.message);
    document = added.value.document;
  }
  const feature: FeatureRecordInput = {
    id: fPattern,
    kind: "patternLinear",
    inputs: [
      { kind: "feature", id: fPlace },
      { kind: "parameter", id: pCount },
      { kind: "parameter", id: pSpacing },
      { kind: "parameter", id: pDirection },
    ],
    outputs: [bPattern],
  };
  const added = addFeature(document, feature);
  if (!added.ok) throw new Error(added.error.message);
  return added.value.document;
}

/** Adds the circular pattern feature + parameters and returns the document. */
function buildCircularDocument(
  count: number,
  totalAngleRad: number,
): CadDocument {
  let document = newPatternDocument();
  for (const [id, name, value] of [
    [pCount, "patternCount", dimensionless(count)],
    [pTotalAngle, "patternTotalAngle", angle(totalAngleRad, "rad")],
    [pAxis, "patternAxis", dimensionless(3)],
  ] as const) {
    const added = addDocumentParameter(document, { id, name, value });
    if (!added.ok) throw new Error(added.error.message);
    document = added.value.document;
  }
  const feature: FeatureRecordInput = {
    id: fPattern,
    kind: "patternCircular",
    inputs: [
      { kind: "feature", id: fPlace },
      { kind: "parameter", id: pCount },
      { kind: "parameter", id: pTotalAngle },
      { kind: "parameter", id: pAxis },
    ],
    outputs: [bPattern],
  };
  const added = addFeature(document, feature);
  if (!added.ok) throw new Error(added.error.message);
  return added.value.document;
}

/** Regenerates a pattern document against a fresh OCCT kernel. */
function runPattern(document: CadDocument) {
  const kernel = occtKernelFromRuntime(runtime);
  const bridge = createKernelFeatureExecutor(kernel, {
    document,
    bodies: new Map(),
    profiles: () => ({
      ok: false,
      error: {
        code: "document/not-found",
        message: "patterns resolve no sketches",
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
  const solid = bridge.solidOf(bPattern);
  expect(solid).toBeDefined();
  if (solid === undefined) throw new Error("The pattern body has no solid.");
  return { kernel, solid, run: run.value };
}

describe("bridge patterns on the OpenCascade kernel (real rotated unions)", () => {
  it("executes a 3×20 linear pattern along +x: exact three-cube volume", () => {
    const { kernel, solid, run } = runPattern(buildLinearDocument(3, 20));
    expect(run.executed).toEqual([fCube, fPlace, fPattern]);
    assertVolumeClose(
      unwrapKernelResult(kernel.volume(solid), "pattern volume"),
      3 * 10 ** 3,
      EXACT_VOLUME_TOLERANCE,
    );
    assertBoundsEqual(
      unwrapKernelResult(kernel.bounds(solid), "pattern bounds"),
      { min: [20, -5, 0], max: [70, 5, 10] },
      EXACT_BOUNDS_TOLERANCE,
    );
  });

  it("regenerates the linear pattern from parameter.set 3×20 → 5×15", () => {
    const document = buildLinearDocument(3, 20);
    const setCount = applyCommand(document, {
      type: "parameter.set",
      id: pCount,
      value: dimensionless(5),
    });
    if (!setCount.ok) throw new Error(setCount.error.message);
    const setSpacing = applyCommand(setCount.value, {
      type: "parameter.set",
      id: pSpacing,
      value: length(15),
    });
    if (!setSpacing.ok) throw new Error(setSpacing.error.message);
    const { kernel, solid } = runPattern(setSpacing.value);
    assertVolumeClose(
      unwrapKernelResult(kernel.volume(solid), "pattern volume"),
      5 * 10 ** 3,
      EXACT_VOLUME_TOLERANCE,
    );
    assertBoundsEqual(
      unwrapKernelResult(kernel.bounds(solid), "pattern bounds"),
      { min: [20, -5, 0], max: [90, 5, 10] },
      EXACT_BOUNDS_TOLERANCE,
    );
  });

  it("executes a full-circle 4×2π pattern about Z: four quadrant cubes", () => {
    // The cube at x ∈ [20,30], y ∈ [−5,5] rotates into one cube per
    // quadrant at 0/90/180/270° — disjoint, so the union is exactly four
    // cubes and its bounds the four-quadrant hull.
    const { kernel, solid } = runPattern(buildCircularDocument(4, Math.PI * 2));
    assertVolumeClose(
      unwrapKernelResult(kernel.volume(solid), "pattern volume"),
      4 * 10 ** 3,
      EXACT_VOLUME_TOLERANCE,
    );
    assertBoundsEqual(
      unwrapKernelResult(kernel.bounds(solid), "pattern bounds"),
      { min: [-30, -30, 0], max: [30, 30, 10] },
      EXACT_BOUNDS_TOLERANCE,
    );
  });

  it("regenerates the circular pattern from a count edit 4 → 6", () => {
    const document = buildCircularDocument(4, Math.PI * 2);
    const setCount = applyCommand(document, {
      type: "parameter.set",
      id: pCount,
      value: dimensionless(6),
    });
    if (!setCount.ok) throw new Error(setCount.error.message);
    // Six copies at 60° spacing, centres 25 mm from the origin — pairwise
    // centre distance 2·25·sin(30°) = 25 mm > the cube diagonal √200 ≈
    // 14.1 mm, so still disjoint: exactly six cubes.
    const { kernel, solid } = runPattern(setCount.value);
    assertVolumeClose(
      unwrapKernelResult(kernel.volume(solid), "pattern volume"),
      6 * 10 ** 3,
      EXACT_VOLUME_TOLERANCE,
    );
    // x extent 30 (the 0° copy's far corner); y extent the corner (30, 5)
    // rotated 60°: 30·sin 60° + 5·cos 60°.
    const fanY = 30 * Math.sin(Math.PI / 3) + 5 * Math.cos(Math.PI / 3);
    assertBoundsEqual(
      unwrapKernelResult(kernel.bounds(solid), "pattern bounds"),
      { min: [-30, -fanY, 0], max: [30, fanY, 10] },
      EXACT_BOUNDS_TOLERANCE,
    );
  });
});
