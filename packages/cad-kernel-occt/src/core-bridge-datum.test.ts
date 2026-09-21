/**
 * The datum feature forms' bridge tests on the OCCT kernel (Phase 39): the
 * positive paths the fake kernel cannot carry — the OBLIQUE datum-plane
 * mirror (the rotation composition) and the datum-axis circular pattern
 * (rotations about a line off the origin) — executed on the exact BREP
 * kernel, with the datum plane/axis resolved from document records.
 *
 * Fixture: the mirror twin's 10 mm cube translated to x ∈ [20, 30],
 * y ∈ [−5, 5], z ∈ [0, 10].
 *
 * - The oblique datum plane with normal (1, 0, 1)/√2 through the origin
 *   reflects each point to (−z, y, −x), so the reflected bounds are exactly
 *   x ∈ [−10, 0], y ∈ [−5, 5], z ∈ [−30, −20] — an exact pin the rotation
 *   composition must reproduce.
 * - The datum-axis circular pattern rotates the cube about the +z line
 *   through (0, 5, 0); three copies at 120° are far apart, so the union's
 *   volume is exactly 3 × 1000.
 * - The datum-axis hole along +z must produce the selector form's exact
 *   volume (the planners' equivalence, on exact booleans).
 */

import { beforeAll, describe, expect, it } from "vitest";
import {
  addBody,
  addDocumentDatum,
  addDocumentParameter,
  addFeature,
  angle,
  type AngleValue,
  dimensionless,
  type DimensionlessValue,
  type LengthValue,
  type ParameterId,
  type CadDocument,
  createBodyId,
  createDatumId,
  type DatumId,
  createDocument,
  createDocumentId,
  createFeatureId,
  createParameterId,
  type FeatureRecordInput,
  initialRegenerationStates,
  length,
  regenerate,
} from "@slopcad/cad-core";
import {
  createKernelFeatureExecutor,
  type KernelExecutorContext,
} from "@slopcad/cad-kernel";
import { EXACT_VOLUME_TOLERANCE } from "@slopcad/cad-kernel/contract-suite";

import { occtKernelFromRuntime } from "./occt-kernel";
import { createOcctRuntime, type OcctRuntime } from "./occt-runtime";

let runtime: OcctRuntime;

beforeAll(async () => {
  runtime = await createOcctRuntime();
});

const pWidth = createParameterId("param_occt_datum_w");
const pDepth = createParameterId("param_occt_datum_d");
const pHeight = createParameterId("param_occt_datum_h");
const pOffsetX = createParameterId("param_occt_datum_off_x");
const pOffsetY = createParameterId("param_occt_datum_off_y");
const pOffsetZ = createParameterId("param_occt_datum_off_z");
const pPlane = createParameterId("param_occt_datum_plane");
const pMirrorOffset = createParameterId("param_occt_datum_mirror_offset");
const pCount = createParameterId("param_occt_datum_count");
const pTotalAngle = createParameterId("param_occt_datum_total_angle");
const pAxisSelector = createParameterId("param_occt_datum_axis_selector");
const pHoleDiameter = createParameterId("param_occt_datum_hole_diameter");
const pHoleDepth = createParameterId("param_occt_datum_hole_depth");
const pHoleX = createParameterId("param_occt_datum_hole_x");
const pHoleY = createParameterId("param_occt_datum_hole_y");
const pHoleAxis = createParameterId("param_occt_datum_hole_axis");

const bCube = createBodyId("body_occt_datum_cube");
const bPlaced = createBodyId("body_occt_datum_placed");
const bAction = createBodyId("body_occt_datum_action");
const fCube = createFeatureId("feat_occt_datum_cube");
const fPlace = createFeatureId("feat_occt_datum_place");
const fAction = createFeatureId("feat_occt_datum_action");

const dtmOblique = createDatumId("dtm_occt_oblique");
const dtmPatternAxis = createDatumId("dtm_occt_pattern_axis");
const dtmHoleAxis = createDatumId("dtm_occt_hole_axis");

const OBLIQUE_PAYLOAD = {
  formatVersion: 1,
  datumType: "plane",
  definition: "originFrame",
  origin: [0, 0, 0],
  normal: [Math.SQRT1_2, 0, Math.SQRT1_2],
  xAxis: [0, 1, 0],
} as const;

const PATTERN_AXIS_PAYLOAD = {
  formatVersion: 1,
  datumType: "axis",
  definition: "twoPoints",
  first: [0, 5, 0],
  second: [0, 5, 10],
} as const;

const HOLE_AXIS_PAYLOAD = {
  formatVersion: 1,
  datumType: "axis",
  definition: "twoPoints",
  first: [0, 0, 0],
  second: [0, 0, 10],
} as const;

/** The placed cube document plus the given datums and action feature. */
function buildDocument(
  datums: readonly {
    readonly id: DatumId;
    readonly payload: Record<string, unknown>;
  }[],
  action: FeatureRecordInput,
  numericOverrides: readonly [
    ReturnType<typeof createParameterId>,
    string,
    number,
  ][] = [],
): CadDocument {
  let document = createDocument(createDocumentId("doc_occt_bridge_datum"));
  const parameters: readonly [
    ReturnType<typeof createParameterId>,
    string,
    (
      | ReturnType<typeof length>
      | ReturnType<typeof angle>
      | ReturnType<typeof dimensionless>
    ),
  ][] = [
    [pWidth, "cubeWidth", length(10)],
    [pDepth, "cubeDepth", length(10)],
    [pHeight, "cubeHeight", length(10)],
    [pOffsetX, "offsetX", length(20)],
    [pOffsetY, "offsetY", length(-5)],
    [pOffsetZ, "offsetZ", length(0)],
    [pPlane, "mirrorPlane", dimensionless(1)],
    [pMirrorOffset, "mirrorOffset", length(0)],
    [pCount, "patternCount", dimensionless(3)],
    [pTotalAngle, "patternTotalAngle", angle(360, "deg")],
    [pAxisSelector, "patternAxisSelector", dimensionless(3)],
    [pHoleDiameter, "holeDiameter", length(6)],
    [pHoleDepth, "holeDepth", length(99)],
    [pHoleX, "holeX", length(25)],
    [pHoleY, "holeY", length(0)],
    [pHoleAxis, "holeAxisSelector", dimensionless(3)],
    ...numericOverrides.map(
      ([id, name, value]) =>
        [id, name, length(value)] as [
          ParameterId,
          string,
          LengthValue | AngleValue | DimensionlessValue,
        ],
    ),
  ];
  for (const [id, name, value] of parameters) {
    const added = addDocumentParameter(document, { id, name, value });
    if (!added.ok) throw new Error(added.error.message);
    document = added.value.document;
  }
  for (const datum of datums) {
    const added = addDocumentDatum(document, {
      id: datum.id,
      name: datum.id,
      datum: datum.payload,
    });
    if (!added.ok) throw new Error(added.error.message);
    document = added.value.document;
  }
  for (const body of [
    { id: bCube, name: "cube" },
    { id: bPlaced, name: "placed" },
    { id: bAction, name: "action" },
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
    action,
  ] as const) {
    const added = addFeature(document, feature);
    if (!added.ok) throw new Error(added.error.message);
    document = added.value.document;
  }
  return document;
}

/** The resolver context every datum run carries (no sketches, no topology). */
function resolverContext(): Pick<KernelExecutorContext, "profiles"> {
  return {
    profiles: () => ({
      ok: false,
      error: {
        code: "document/not-found",
        message: "the datum suite resolves no sketches",
        input: null,
      },
    }),
  };
}

/** Runs the document's action feature against a fresh OCCT kernel. */
function runAction(document: CadDocument) {
  const kernel = occtKernelFromRuntime(runtime);
  const bridge = createKernelFeatureExecutor(kernel, {
    document,
    bodies: new Map(),
    ...resolverContext(),
  });
  const run = regenerate({
    features: document.features,
    states: initialRegenerationStates(document.features),
    suppressed: [],
    execute: bridge.executor,
  });
  if (!run.ok) throw new Error(run.error.message);
  const state = run.value.states.get(fAction);
  if (state === undefined) throw new Error("no state for the action feature");
  if (state.state !== "valid") {
    throw new Error(
      state.diagnostics[0]?.message ?? "the action feature failed",
    );
  }
  return {
    volume: kernel.volume(bridge.solidOf(bAction) as never),
    bounds: kernel.bounds(bridge.solidOf(bAction) as never),
  };
}

describe("mirror about an oblique datum plane (the rotation composition)", () => {
  const obliqueMirror: FeatureRecordInput = {
    id: fAction,
    kind: "mirror",
    inputs: [
      { kind: "feature", id: fPlace },
      { kind: "datum", id: dtmOblique },
    ],
    outputs: [bAction],
  };

  it("reflects the cube exactly through the datum plane", () => {
    const document = buildDocument(
      [{ id: dtmOblique, payload: OBLIQUE_PAYLOAD }],
      obliqueMirror,
    );
    const result = runAction(document);
    if (!result.volume.ok) throw new Error(result.volume.error.message);
    // Exact isometry: the composition must not lose a millimetre³.
    expect(Math.abs(result.volume.value - 1000)).toBeLessThanOrEqual(
      EXACT_VOLUME_TOLERANCE,
    );
    if (!result.bounds.ok) throw new Error(result.bounds.error.message);
    // (x, y, z) → (−z, y, −x) for the (1, 0, 1)/√2 plane through the origin.
    expect(result.bounds.value.min[0]).toBeCloseTo(-10, 6);
    expect(result.bounds.value.min[1]).toBeCloseTo(-5, 6);
    expect(result.bounds.value.min[2]).toBeCloseTo(-30, 6);
    expect(result.bounds.value.max[0]).toBeCloseTo(0, 6);
    expect(result.bounds.value.max[1]).toBeCloseTo(5, 6);
    expect(result.bounds.value.max[2]).toBeCloseTo(-20, 6);
  });
});

describe("pattern circular about a datum axis (the line-off-origin composition)", () => {
  const datumPattern: FeatureRecordInput = {
    id: fAction,
    kind: "patternCircular",
    inputs: [
      { kind: "feature", id: fPlace },
      { kind: "parameter", id: pCount },
      { kind: "parameter", id: pTotalAngle },
      { kind: "datum", id: dtmPatternAxis },
    ],
    outputs: [bAction],
  };

  it("unions three disjoint rotated copies to exactly 3 × 1000", () => {
    const document = buildDocument(
      [{ id: dtmPatternAxis, payload: PATTERN_AXIS_PAYLOAD }],
      datumPattern,
    );
    const result = runAction(document);
    if (!result.volume.ok) throw new Error(result.volume.error.message);
    expect(Math.abs(result.volume.value - 3000)).toBeLessThanOrEqual(
      EXACT_VOLUME_TOLERANCE,
    );
    // The union BOUNDS pin the line-off-origin placement (volume alone is
    // invariant under a per-copy axis-origin composition error): rotating
    // the placed cube (x ∈ [20, 30], y ∈ [−5, 5], u = y − 5 ∈ [−10, 0])
    // about the +z line through (0, 5, 0) by θ maps (x, u) to
    // (x cos θ − u sin θ, x sin θ + u cos θ + 5). The three copies
    // (θ = 0°, 120°, 240°) then union to exactly:
    //   x ∈ [−15 − 5√3, 30], y ∈ [5 − 15√3, 10 + 15√3], z ∈ [0, 10]
    // — the same exact-pins discipline as the oblique mirror's bounds.
    // (The union is symmetric under the 120°/240° copy swap, so the pin is
    // rotation-direction-independent — it names the AXIS LINE, not the
    // handedness.)
    if (!result.bounds.ok) throw new Error(result.bounds.error.message);
    const root3 = Math.sqrt(3);
    expect(result.bounds.value.min[0]).toBeCloseTo(-15 - 5 * root3, 6);
    expect(result.bounds.value.min[1]).toBeCloseTo(5 - 15 * root3, 6);
    expect(result.bounds.value.min[2]).toBeCloseTo(0, 6);
    expect(result.bounds.value.max[0]).toBeCloseTo(30, 6);
    expect(result.bounds.value.max[1]).toBeCloseTo(10 + 15 * root3, 6);
    expect(result.bounds.value.max[2]).toBeCloseTo(10, 6);
    // The selector form (axis 3, the world z line through the ORIGIN)
    // produces a different arrangement for the same parameters — pin the
    // two are not silently the same computation by running the selector
    // form and comparing against ITS exact total.
    const selectorDocument = buildDocument([], {
      id: fAction,
      kind: "patternCircular",
      inputs: [
        { kind: "feature", id: fPlace },
        { kind: "parameter", id: pCount },
        { kind: "parameter", id: pTotalAngle },
        { kind: "parameter", id: pAxisSelector },
      ],
      outputs: [bAction],
    });
    const selector = runAction(selectorDocument);
    if (!selector.volume.ok) throw new Error(selector.volume.error.message);
    expect(Math.abs(selector.volume.value - 3000)).toBeLessThanOrEqual(
      EXACT_VOLUME_TOLERANCE,
    );
    // ...and a different ARRANGEMENT: rotating the same cube about the
    // ORIGIN line unions to y ∈ [−(15√3 + 2.5), 15√3 + 2.5] — distinct y
    // bounds from the off-origin axis's [5 − 15√3, 10 + 15√3], so the two
    // compositions can never silently agree.
    if (!selector.bounds.ok) throw new Error(selector.bounds.error.message);
    expect(selector.bounds.value.min[1]).toBeCloseTo(-15 * root3 - 2.5, 6);
    expect(selector.bounds.value.max[1]).toBeCloseTo(15 * root3 + 2.5, 6);
  });
});

describe("hole along a datum axis (the planner equivalence)", () => {
  it("reproduces the selector form's exact volume for the same +z axis", () => {
    const datumDocument = buildDocument(
      [{ id: dtmHoleAxis, payload: HOLE_AXIS_PAYLOAD }],
      {
        id: fAction,
        kind: "hole",
        inputs: [
          { kind: "feature", id: fPlace },
          { kind: "parameter", id: pHoleDiameter },
          { kind: "parameter", id: pHoleDepth },
          { kind: "parameter", id: pHoleX },
          { kind: "parameter", id: pHoleY },
          { kind: "datum", id: dtmHoleAxis },
        ],
        outputs: [bAction],
      },
    );
    const datumRun = runAction(datumDocument);
    if (!datumRun.volume.ok) throw new Error(datumRun.volume.error.message);
    const selectorDocument = buildDocument([], {
      id: fAction,
      kind: "hole",
      inputs: [
        { kind: "feature", id: fPlace },
        { kind: "parameter", id: pHoleDiameter },
        { kind: "parameter", id: pHoleDepth },
        { kind: "parameter", id: pHoleX },
        { kind: "parameter", id: pHoleY },
        { kind: "parameter", id: pHoleAxis },
      ],
      outputs: [bAction],
    });
    const selectorRun = runAction(selectorDocument);
    if (!selectorRun.volume.ok)
      throw new Error(selectorRun.volume.error.message);
    // Same plane position, same axis, exact booleans: identical volumes.
    expect(
      Math.abs(datumRun.volume.value - selectorRun.volume.value),
    ).toBeLessThanOrEqual(EXACT_VOLUME_TOLERANCE);
    // And the analytic removal (through hole along z): π·r²·h.
    const expected = 1000 - Math.PI * 9 * 10;
    expect(Math.abs(datumRun.volume.value - expected)).toBeLessThanOrEqual(
      EXACT_VOLUME_TOLERANCE,
    );
  });
});
