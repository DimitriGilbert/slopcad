/**
 * The Phase 43 pattern & mirror completion's OCCT bridge tests — the
 * roadmap's INSTANCE-COUNT × GEOMETRY EQUIVALENCE pin on a REAL kernel:
 * the fake kernel proves the bridge composes deterministic arrangements;
 * OCCT's exact BREP transforms and unions prove those arrangements
 * MEASURE exact end to end, including the rotations the fake kernel
 * cannot make (tangent-follow's real geometry) and the mirror merge's
 * real union.
 *
 * Fixture: the Phase 26.8 pattern suite's placed cube — a 10 mm cube at
 * x ∈ [20, 30], y ∈ [−5, 5] — off the origin, so unions stay disjoint
 * and volumes/bounds read at the EXACT tolerances.
 */

import { beforeAll, describe, expect, it } from "vitest";
import {
  addBody,
  addDocumentDatum,
  addDocumentParameter,
  addDocumentSketch,
  addFeature,
  angle,
  applyCommand,
  type CadDocument,
  createBodyId,
  createDatumId,
  createDocument,
  createDocumentId,
  createFeatureId,
  createParameterId,
  createSketchDocumentId,
  DATUM_FORMAT_VERSION,
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

const pWidth = createParameterId("param_occt_p43_w");
const pDepth = createParameterId("param_occt_p43_d");
const pHeight = createParameterId("param_occt_p43_h");
const pOffsetX = createParameterId("param_occt_p43_offset_x");
const pOffsetY = createParameterId("param_occt_p43_offset_y");
const pOffsetZ = createParameterId("param_occt_p43_offset_z");
const pDirection = createParameterId("param_occt_p43_direction");
const pCount = createParameterId("param_occt_p43_count");
const pSpacing = createParameterId("param_occt_p43_spacing");
const pSkip = createParameterId("param_occt_p43_skip");
const pOrientation = createParameterId("param_occt_p43_orientation");
const pMerge = createParameterId("param_occt_p43_merge");

const bCube = createBodyId("body_occt_p43_cube");
const bPlaced = createBodyId("body_occt_p43_placed");
const bResult = createBodyId("body_occt_p43_result");
const fCube = createFeatureId("feat_occt_p43_cube");
const fPlace = createFeatureId("feat_occt_p43_place");
const fPattern = createFeatureId("feat_occt_p43_pattern");
const fMirror = createFeatureId("feat_occt_p43_mirror");
const dtmMirrorPlane = createDatumId("dtm_occt_p43_plane");

const CUBE_VOLUME = 1000;

/** Adds the placed-cube fixture (the Phase 26.8 pattern suite's shape). */
function newPlacedCubeDocument(): CadDocument {
  let document = createDocument(createDocumentId("doc_occt_p43"));
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
    { id: bResult, name: "result" },
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

/** Regenerates a document against one fresh OCCT kernel. */
function runBridge(
  document: CadDocument,
  paths?: Parameters<typeof createKernelFeatureExecutor>[1]["paths"],
) {
  const kernel = occtKernelFromRuntime(runtime);
  const bridge = createKernelFeatureExecutor(kernel, {
    document,
    bodies: new Map(),
    profiles: () => ({
      ok: false,
      error: {
        code: "document/not-found",
        message: "the Phase 43 OCCT fixtures resolve no profiles",
        input: null,
      },
    }),
    ...(paths === undefined ? {} : { paths }),
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

/** The feature's first diagnostic of a failed run. */
function failureOf(
  document: CadDocument,
  featureId: ReturnType<typeof createFeatureId>,
  paths?: Parameters<typeof createKernelFeatureExecutor>[1]["paths"],
) {
  const { run } = runBridge(document, paths);
  const state = run.states.get(featureId);
  expect(state?.state).toBe("failed");
  return state?.diagnostics[0];
}

/** Adds the patternFeature leg + optional skip parameters and the feature. */
function buildArrayDocument(
  count: number,
  spacingMm: number,
  skip: number | null,
): CadDocument {
  let document = newPlacedCubeDocument();
  for (const [id, name, value] of [
    [pDirection, "direction", angle(0)],
    [pCount, "count", dimensionless(count)],
    [pSpacing, "spacing", length(spacingMm)],
    ...(skip === null ? [] : ([[pSkip, "skip", dimensionless(skip)]] as const)),
  ] as const) {
    const added = addDocumentParameter(document, { id, name, value });
    if (!added.ok) throw new Error(added.error.message);
    document = added.value.document;
  }
  const inputs: FeatureRecordInput["inputs"] = [
    { kind: "feature", id: fPlace },
    { kind: "parameter", id: pDirection },
    { kind: "parameter", id: pCount },
    { kind: "parameter", id: pSpacing },
    ...(skip === null ? [] : [{ kind: "parameter" as const, id: pSkip }]),
  ];
  const added = addFeature(document, {
    id: fPattern,
    kind: "patternFeature",
    inputs,
    outputs: [bResult],
  });
  if (!added.ok) throw new Error(added.error.message);
  return added.value.document;
}

describe("OCCT patternFeature: the equivalence pin on a real kernel", () => {
  it("measures a 3×20 array exactly: three disjoint cubes, x ∈ [20, 60]", () => {
    const { kernel, bridge, run } = runBridge(buildArrayDocument(3, 20, null));
    expect(run.executed).toEqual([fCube, fPlace, fPattern]);
    const solid = bridge.solidOf(bResult);
    expect(solid).toBeDefined();
    if (solid === undefined) return;
    assertVolumeClose(
      unwrapKernelResult(kernel.volume(solid), "array volume"),
      3 * CUBE_VOLUME,
      EXACT_VOLUME_TOLERANCE,
    );
    assertBoundsEqual(
      unwrapKernelResult(kernel.bounds(solid), "array bounds"),
      { min: [20, -5, 0], max: [70, 5, 10] },
      EXACT_BOUNDS_TOLERANCE,
    );
  });

  it("equals N manually-composed unions exactly (volume and bounds)", () => {
    // The manual side drives the SAME kernel directly: the placed cube,
    // two transforms at 20 and 40, one union. Identical composition must
    // measure identically — OCCT's exact BREP makes the equality exact,
    // the roadmap's byte-level-equivalence criterion where the
    // compositions coincide.
    const kernel = occtKernelFromRuntime(runtime);
    const cube = unwrapKernelResult(
      kernel.createBox({
        width: length(10),
        depth: length(10),
        height: length(10),
      }),
      "cube",
    );
    const placed = unwrapKernelResult(
      kernel.transform(cube, {
        x: length(20),
        y: length(-5),
        z: length(0),
      }),
      "placed",
    );
    const copies = [placed];
    for (const x of [40, 60]) {
      copies.push(
        unwrapKernelResult(
          kernel.transform(cube, { x: length(x), y: length(-5), z: length(0) }),
          "copy",
        ),
      );
    }
    const manual = unwrapKernelResult(kernel.union(copies), "manual union");
    const patternRun = runBridge(buildArrayDocument(3, 20, null));
    const patterned = patternRun.bridge.solidOf(bResult);
    expect(patterned).toBeDefined();
    if (patterned === undefined) return;
    const patternKernel = patternRun.kernel;
    expect(
      unwrapKernelResult(patternKernel.volume(patterned), "pattern volume"),
    ).toBe(unwrapKernelResult(kernel.volume(manual), "manual volume"));
    expect(
      unwrapKernelResult(patternKernel.bounds(patterned), "pattern bounds"),
    ).toEqual(unwrapKernelResult(kernel.bounds(manual), "manual bounds"));
  });

  it("skips one instance: four of five cubes, exact volume", () => {
    const { kernel, bridge } = runBridge(buildArrayDocument(5, 20, 1));
    const solid = bridge.solidOf(bResult);
    expect(solid).toBeDefined();
    if (solid === undefined) return;
    assertVolumeClose(
      unwrapKernelResult(kernel.volume(solid), "skipped volume"),
      4 * CUBE_VOLUME,
      EXACT_VOLUME_TOLERANCE,
    );
    // Instances 0, 2, 3, 4 of five: cube left edges at 20, 60, 80, 100.
    assertBoundsEqual(
      unwrapKernelResult(kernel.bounds(solid), "skipped bounds"),
      { min: [20, -5, 0], max: [110, 5, 10] },
      EXACT_BOUNDS_TOLERANCE,
    );
  });

  it("re-drives skips and counts through parameter.set", () => {
    const document = buildArrayDocument(5, 20, 1);
    const setSkip = applyCommand(document, {
      type: "parameter.set",
      id: pSkip,
      value: dimensionless(2),
    });
    expect(setSkip.ok).toBe(true);
    if (!setSkip.ok) return;
    const setCount = applyCommand(setSkip.value, {
      type: "parameter.set",
      id: pCount,
      value: dimensionless(4),
    });
    expect(setCount.ok).toBe(true);
    if (!setCount.ok) return;
    const { kernel, bridge } = runBridge(setCount.value);
    const solid = bridge.solidOf(bResult);
    expect(solid).toBeDefined();
    if (solid === undefined) return;
    assertVolumeClose(
      unwrapKernelResult(kernel.volume(solid), "re-driven volume"),
      3 * CUBE_VOLUME,
      EXACT_VOLUME_TOLERANCE,
    );
  });

  it("declines an out-of-range skip structurally", () => {
    const diagnostic = failureOf(buildArrayDocument(3, 20, 9), fPattern);
    expect(diagnostic?.code).toBe("kernel/parameter-invalid");
  });
});

describe("OCCT patternPath: real stations, real rotations", () => {
  /** Adds the path sketch record + count/spacing/orientation + feature. */
  function buildPathDocument(
    count: number,
    spacingMm: number,
    orientation: number,
  ): CadDocument {
    let document = newPlacedCubeDocument();
    const sketch = addDocumentSketch(document, {
      id: createSketchDocumentId("skd_occt_p43_path"),
      name: "the path",
      sketch: {
        formatVersion: 2,
        workplane: {},
        entities: [],
        constraints: [],
      },
    });
    if (!sketch.ok) throw new Error(sketch.error.message);
    document = sketch.value.document;
    for (const [id, name, value] of [
      [pCount, "count", dimensionless(count)],
      [pSpacing, "spacing", length(spacingMm)],
      [pOrientation, "orientation", dimensionless(orientation)],
    ] as const) {
      const added = addDocumentParameter(document, { id, name, value });
      if (!added.ok) throw new Error(added.error.message);
      document = added.value.document;
    }
    const added = addFeature(document, {
      id: fPattern,
      kind: "patternPath",
      inputs: [
        { kind: "feature", id: fPlace },
        { kind: "sketch", id: createSketchDocumentId("skd_occt_p43_path") },
        { kind: "parameter", id: pCount },
        { kind: "parameter", id: pSpacing },
        { kind: "parameter", id: pOrientation },
      ],
      outputs: [bResult],
    });
    if (!added.ok) throw new Error(added.error.message);
    return added.value.document;
  }

  /** The path-seam stub resolving every sketch to the straight +z chain. */
  const straightPaths: Parameters<
    typeof createKernelFeatureExecutor
  >[1]["paths"] = () => ({
    ok: true,
    value: { path: [{ kind: "line", start: [0, 0], end: [0, 30] }] },
  });

  it("distributes fixed-orientation copies along a straight path, exact", () => {
    const { kernel, bridge } = runBridge(
      buildPathDocument(4, 10, 1),
      straightPaths,
    );
    const solid = bridge.solidOf(bResult);
    expect(solid).toBeDefined();
    if (solid === undefined) return;
    // Four cubes marching +z: z ∈ [0, 40], x ∈ [20, 30] preserved.
    assertVolumeClose(
      unwrapKernelResult(kernel.volume(solid), "path volume"),
      4 * CUBE_VOLUME,
      EXACT_VOLUME_TOLERANCE,
    );
    assertBoundsEqual(
      unwrapKernelResult(kernel.bounds(solid), "path bounds"),
      { min: [20, -5, 0], max: [30, 5, 40] },
      EXACT_BOUNDS_TOLERANCE,
    );
  });

  it("tangent-follows a straight path as the identity arrangement", () => {
    // On a straight +z path every tangent IS +z: tangent-follow composes
    // identity rotations, and the arrangement equals the fixed one.
    const { kernel, bridge } = runBridge(
      buildPathDocument(3, 10, 2),
      straightPaths,
    );
    const solid = bridge.solidOf(bResult);
    expect(solid).toBeDefined();
    if (solid === undefined) return;
    assertVolumeClose(
      unwrapKernelResult(kernel.volume(solid), "tangent volume"),
      3 * CUBE_VOLUME,
      EXACT_VOLUME_TOLERANCE,
    );
    assertBoundsEqual(
      unwrapKernelResult(kernel.bounds(solid), "tangent bounds"),
      { min: [20, -5, 0], max: [30, 5, 30] },
      EXACT_BOUNDS_TOLERANCE,
    );
  });

  it("declines a station past the path's end", () => {
    const diagnostic = failureOf(
      buildPathDocument(4, 11, 1),
      fPattern,
      straightPaths,
    );
    expect(diagnostic?.code).toBe("kernel/parameter-invalid");
    expect(diagnostic?.message).toContain("runs past its path");
  });
});

describe("OCCT patternLinear: the datum-axis direction", () => {
  it("marches along a datum axis in full 3D, exact", () => {
    const dtmAxis = createDatumId("dtm_occt_p43_axis");
    let document = newPlacedCubeDocument();
    const datum = addDocumentDatum(document, {
      id: dtmAxis,
      name: "the y axis",
      datum: {
        formatVersion: DATUM_FORMAT_VERSION,
        datumType: "axis",
        definition: "twoPoints",
        first: [0, 0, 0],
        second: [0, 40, 0],
      },
    });
    if (!datum.ok) throw new Error(datum.error.message);
    document = datum.value.document;
    for (const [id, name, value] of [
      [pCount, "count", dimensionless(3)],
      [pSpacing, "spacing", length(20)],
    ] as const) {
      const added = addDocumentParameter(document, { id, name, value });
      if (!added.ok) throw new Error(added.error.message);
      document = added.value.document;
    }
    const added = addFeature(document, {
      id: fPattern,
      kind: "patternLinear",
      inputs: [
        { kind: "feature", id: fPlace },
        { kind: "datum", id: dtmAxis },
        { kind: "parameter", id: pCount },
        { kind: "parameter", id: pSpacing },
      ],
      outputs: [bResult],
    });
    if (!added.ok) throw new Error(added.error.message);
    const { kernel, bridge } = runBridge(added.value.document);
    const solid = bridge.solidOf(bResult);
    expect(solid).toBeDefined();
    if (solid === undefined) return;
    // Three cubes marching +y: y ∈ [−5, 45].
    assertVolumeClose(
      unwrapKernelResult(kernel.volume(solid), "axis-directed volume"),
      3 * CUBE_VOLUME,
      EXACT_VOLUME_TOLERANCE,
    );
    assertBoundsEqual(
      unwrapKernelResult(kernel.bounds(solid), "axis-directed bounds"),
      { min: [20, -5, 0], max: [30, 45, 10] },
      EXACT_BOUNDS_TOLERANCE,
    );
  });
});

describe("OCCT mirror: the datum-plane merge", () => {
  /** Builds the mirror document over the placed cube + the x = 0 plane. */
  function buildMirrorDocument(merge: number | null): CadDocument {
    let document = newPlacedCubeDocument();
    const datum = addDocumentDatum(document, {
      id: dtmMirrorPlane,
      name: "the x = 0 plane",
      datum: {
        formatVersion: DATUM_FORMAT_VERSION,
        datumType: "plane",
        definition: "originFrame",
        origin: [0, 0, 0],
        normal: [1, 0, 0],
        xAxis: [0, 1, 0],
      },
    });
    if (!datum.ok) throw new Error(datum.error.message);
    document = datum.value.document;
    if (merge !== null) {
      const added = addDocumentParameter(document, {
        id: pMerge,
        name: "merge",
        value: dimensionless(merge),
      });
      if (!added.ok) throw new Error(added.error.message);
      document = added.value.document;
    }
    const inputs: FeatureRecordInput["inputs"] = [
      { kind: "feature", id: fPlace },
      { kind: "datum", id: dtmMirrorPlane },
      ...(merge === null ? [] : [{ kind: "parameter" as const, id: pMerge }]),
    ];
    const added = addFeature(document, {
      id: fMirror,
      kind: "mirror",
      inputs,
      outputs: [bResult],
    });
    if (!added.ok) throw new Error(added.error.message);
    return added.value.document;
  }

  it("merges the reflection with the original: exactly double, symmetric bounds", () => {
    const { kernel, bridge } = runBridge(buildMirrorDocument(2));
    const solid = bridge.solidOf(bResult);
    expect(solid).toBeDefined();
    if (solid === undefined) return;
    // The cube at x ∈ [20, 30] reflects to x ∈ [−30, −20]: disjoint,
    // exactly double the volume, symmetric about x = 0.
    assertVolumeClose(
      unwrapKernelResult(kernel.volume(solid), "merged volume"),
      2 * CUBE_VOLUME,
      EXACT_VOLUME_TOLERANCE,
    );
    assertBoundsEqual(
      unwrapKernelResult(kernel.bounds(solid), "merged bounds"),
      { min: [-30, -5, 0], max: [30, 5, 10] },
      EXACT_BOUNDS_TOLERANCE,
    );
  });

  it("stands alone without the merge parameter (the Phase 39 form)", () => {
    const { kernel, bridge } = runBridge(buildMirrorDocument(null));
    const solid = bridge.solidOf(bResult);
    expect(solid).toBeDefined();
    if (solid === undefined) return;
    assertVolumeClose(
      unwrapKernelResult(kernel.volume(solid), "standalone volume"),
      CUBE_VOLUME,
      EXACT_VOLUME_TOLERANCE,
    );
    assertBoundsEqual(
      unwrapKernelResult(kernel.bounds(solid), "standalone bounds"),
      { min: [-30, -5, 0], max: [-20, 5, 10] },
      EXACT_BOUNDS_TOLERANCE,
    );
  });

  it("re-drives the merge from parameter.set: 2 → 1 returns the reflection alone", () => {
    const document = buildMirrorDocument(2);
    const set = applyCommand(document, {
      type: "parameter.set",
      id: pMerge,
      value: dimensionless(1),
    });
    expect(set.ok).toBe(true);
    if (!set.ok) return;
    const { kernel, bridge } = runBridge(set.value);
    const solid = bridge.solidOf(bResult);
    expect(solid).toBeDefined();
    if (solid === undefined) return;
    assertVolumeClose(
      unwrapKernelResult(kernel.volume(solid), "re-driven volume"),
      CUBE_VOLUME,
      EXACT_VOLUME_TOLERANCE,
    );
  });

  it("declines a merge selector outside {1, 2}", () => {
    const diagnostic = failureOf(buildMirrorDocument(5), fMirror);
    expect(diagnostic?.code).toBe("kernel/parameter-invalid");
  });
});
