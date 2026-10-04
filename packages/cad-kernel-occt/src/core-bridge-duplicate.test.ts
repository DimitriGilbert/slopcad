/**
 * The duplicate feature's bridge tests on a REAL rotating kernel (Phase
 * 60's semantic close of the loop): the cad-kernel suite pins translate-
 * only duplicates on the fake kernel and the rotation composition on a
 * recording double (the fake kernel cannot rotate); these tests execute
 * the duplicate kind against the OpenCascade kernel, whose exact BREP
 * transforms make the cumulative T^i semantics — the translate ×3 ladder
 * and the four-body 90°-step corner arrangement — measurable end to end,
 * per copy body, alongside the identity-transform refusal and the
 * `parameter.set` re-drive.
 *
 * Fixture: a 10 mm cube translated to x ∈ [20, 30], y ∈ [−5, 5] — off
 * every axis, so 90° z-rotations land the copies in separate quadrants
 * (per-copy volumes and bounds then exact, the `EXACT_*` tolerances).
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

const pWidth = createParameterId("param_occt_duplicate_w");
const pDepth = createParameterId("param_occt_duplicate_d");
const pHeight = createParameterId("param_occt_duplicate_h");
const pPlaceX = createParameterId("param_occt_duplicate_place_x");
const pPlaceY = createParameterId("param_occt_duplicate_place_y");
const pPlaceZ = createParameterId("param_occt_duplicate_place_z");
const pDx = createParameterId("param_occt_duplicate_dx");
const pCount = createParameterId("param_occt_duplicate_count");
const pAxis = createParameterId("param_occt_duplicate_axis");
const pAngle = createParameterId("param_occt_duplicate_angle");

const bCube = createBodyId("body_occt_duplicate_cube");
const bPlaced = createBodyId("body_occt_duplicate_placed");
const bCopy1 = createBodyId("body_occt_duplicate_copy1");
const bCopy2 = createBodyId("body_occt_duplicate_copy2");
const bCopy3 = createBodyId("body_occt_duplicate_copy3");
const fCube = createFeatureId("feat_occt_duplicate_cube");
const fPlace = createFeatureId("feat_occt_duplicate_place");
const fDuplicate = createFeatureId("feat_occt_duplicate");

/** Adds the cube + translate features and the shared parameters. */
function newDuplicateDocument(): CadDocument {
  let document = createDocument(createDocumentId("doc_occt_bridge_duplicate"));
  for (const [id, name, value] of [
    [pWidth, "cubeWidth", length(10)],
    [pDepth, "cubeDepth", length(10)],
    [pHeight, "cubeHeight", length(10)],
    [pPlaceX, "placeX", length(20)],
    [pPlaceY, "placeY", length(-5)],
    [pPlaceZ, "placeZ", length(0)],
  ] as const) {
    const added = addDocumentParameter(document, { id, name, value });
    if (!added.ok) throw new Error(added.error.message);
    document = added.value.document;
  }
  for (const body of [
    { id: bCube, name: "cube" },
    { id: bPlaced, name: "placed" },
    { id: bCopy1, name: "copy 1" },
    { id: bCopy2, name: "copy 2" },
    { id: bCopy3, name: "copy 3" },
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
        { kind: "parameter", id: pPlaceX },
        { kind: "parameter", id: pPlaceY },
        { kind: "parameter", id: pPlaceZ },
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

/** Adds the duplicate feature (+ its parameters) and returns the document. */
function buildDuplicateDocument(spec: {
  readonly dxMm: number;
  readonly count: number;
  readonly axis: number;
  readonly angleDeg: number;
}): CadDocument {
  let document = newDuplicateDocument();
  for (const [id, name, value] of [
    [pDx, "duplicateDx", length(spec.dxMm)],
    [pCount, "duplicateCount", dimensionless(spec.count)],
    [pAxis, "duplicateAxis", dimensionless(spec.axis)],
    [pAngle, "duplicateAngle", angle(spec.angleDeg, "deg")],
  ] as const) {
    const added = addDocumentParameter(document, { id, name, value });
    if (!added.ok) throw new Error(added.error.message);
    document = added.value.document;
  }
  // dy/dz ride zero-valued parameters the document layout requires.
  const dyAdded = addDocumentParameter(document, {
    id: createParameterId("param_occt_duplicate_dy"),
    name: "duplicateDy",
    value: length(0),
  });
  if (!dyAdded.ok) throw new Error(dyAdded.error.message);
  document = dyAdded.value.document;
  const dzAdded = addDocumentParameter(document, {
    id: createParameterId("param_occt_duplicate_dz"),
    name: "duplicateDz",
    value: length(0),
  });
  if (!dzAdded.ok) throw new Error(dzAdded.error.message);
  document = dzAdded.value.document;
  const feature: FeatureRecordInput = {
    id: fDuplicate,
    kind: "duplicate",
    inputs: [
      { kind: "feature", id: fPlace },
      { kind: "parameter", id: pDx },
      { kind: "parameter", id: createParameterId("param_occt_duplicate_dy") },
      { kind: "parameter", id: createParameterId("param_occt_duplicate_dz") },
      { kind: "parameter", id: pCount },
      { kind: "parameter", id: pAxis },
      { kind: "parameter", id: pAngle },
    ],
    outputs: [bCopy1, bCopy2, bCopy3].slice(0, spec.count),
  };
  const added = addFeature(document, feature);
  if (!added.ok) throw new Error(added.error.message);
  return added.value.document;
}

/** Regenerates a duplicate document against a fresh OCCT kernel. */
function runDuplicate(document: CadDocument) {
  const kernel = occtKernelFromRuntime(runtime);
  const bridge = createKernelFeatureExecutor(kernel, {
    document,
    bodies: new Map(),
    profiles: () => ({
      ok: false,
      error: {
        code: "document/not-found",
        message: "duplicates resolve no sketches",
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
  return { kernel, bridge, run: run.value };
}

/** One copy's solid, asserted present. */
function copySolidOf(
  bridge: ReturnType<typeof runDuplicate>["bridge"],
  bodyId: typeof bCopy1,
) {
  const solid = bridge.solidOf(bodyId);
  expect(solid).toBeDefined();
  if (solid === undefined) throw new Error("The copy body has no solid.");
  return solid;
}

describe("bridge duplicate on the OpenCascade kernel (real transforms)", () => {
  it("translate ×3: the copies step 15/30/45 mm, exact per-copy volumes", () => {
    const { kernel, bridge, run } = runDuplicate(
      buildDuplicateDocument({ dxMm: 15, count: 3, axis: 3, angleDeg: 0 }),
    );
    expect(run.executed).toEqual([fCube, fPlace, fDuplicate]);
    for (const [index, bodyId] of [bCopy1, bCopy2, bCopy3].entries()) {
      const solid = copySolidOf(bridge, bodyId);
      const offset = 20 + 15 * (index + 1);
      assertVolumeClose(
        unwrapKernelResult(kernel.volume(solid), `copy ${String(index + 1)}`),
        10 ** 3,
        EXACT_VOLUME_TOLERANCE,
      );
      assertBoundsEqual(
        unwrapKernelResult(kernel.bounds(solid), `copy ${String(index + 1)}`),
        { min: [offset, -5, 0], max: [offset + 10, 5, 10] },
        EXACT_BOUNDS_TOLERANCE,
      );
    }
    // The source remains: the placed cube's solid is untouched beside the
    // copies (the move/copy semantics the kind pins).
    const placed = bridge.solidOf(bPlaced);
    expect(placed).toBeDefined();
    if (placed === undefined) return;
    assertBoundsEqual(
      unwrapKernelResult(kernel.bounds(placed), "the placed source"),
      { min: [20, -5, 0], max: [30, 5, 10] },
      EXACT_BOUNDS_TOLERANCE,
    );
  });

  it("rotate 90° ×3: four bodies at the 90° steps, one per quadrant", () => {
    const { kernel, bridge } = runDuplicate(
      buildDuplicateDocument({ dxMm: 0, count: 3, axis: 3, angleDeg: 90 }),
    );
    // T = R ∘ translate with a zero translation: copy i is R^{i·90°} of
    // the placed cube — east source, then north, west, south.
    const expected: readonly {
      readonly bodyId: typeof bCopy1;
      readonly min: readonly [number, number, number];
      readonly max: readonly [number, number, number];
    }[] = [
      { bodyId: bCopy1, min: [-5, 20, 0], max: [5, 30, 10] },
      { bodyId: bCopy2, min: [-30, -5, 0], max: [-20, 5, 10] },
      { bodyId: bCopy3, min: [-5, -30, 0], max: [5, -20, 10] },
    ];
    for (const copy of expected) {
      const solid = copySolidOf(bridge, copy.bodyId);
      assertVolumeClose(
        unwrapKernelResult(kernel.volume(solid), "the rotated copy"),
        10 ** 3,
        EXACT_VOLUME_TOLERANCE,
      );
      assertBoundsEqual(
        unwrapKernelResult(kernel.bounds(solid), "the rotated copy"),
        { min: [...copy.min], max: [...copy.max] },
        EXACT_BOUNDS_TOLERANCE,
      );
    }
  });

  it("refuses the identity transform (zero offset, zero angle)", () => {
    const { run } = runDuplicate(
      buildDuplicateDocument({ dxMm: 0, count: 3, axis: 3, angleDeg: 0 }),
    );
    const state = run.states.get(fDuplicate);
    expect(state?.state).toBe("failed");
    expect(state?.diagnostics[0]?.code).toBe("kernel/parameter-invalid");
    expect(state?.diagnostics[0]?.message).toContain("identity transform");
  });

  it("re-drives: a parameter.set on the offset moves every copy", () => {
    const document = buildDuplicateDocument({
      dxMm: 15,
      count: 3,
      axis: 3,
      angleDeg: 0,
    });
    const edited = applyCommand(document, {
      type: "parameter.set",
      id: pDx,
      value: length(5),
    });
    if (!edited.ok) throw new Error(edited.error.message);
    const { kernel, bridge } = runDuplicate(edited.value);
    const solid = copySolidOf(bridge, bCopy3);
    assertBoundsEqual(
      unwrapKernelResult(kernel.bounds(solid), "copy 3 at 35"),
      { min: [35, -5, 0], max: [45, 5, 10] },
      EXACT_BOUNDS_TOLERANCE,
    );
  });
});
