/**
 * The datum feature forms' bridge tests (Phase 39), on the fake kernel.
 * The datum-plane mirror's AXIS-ALIGNED form rides the direct kernel.mirror
 * call — the fake kernel's reflection is exact, so the datum form and the
 * compat world-axis selector form must produce IDENTICAL bounds for the
 * same plane (the shim's equivalence pin). The oblique composition and the
 * datum-axis circular pattern need rotations, which the fake kernel does
 * not declare — their capability refusal is pinned as a structured
 * diagnostic naming the missing capability (the pattern rotation gate's
 * precedent), with the positive oblique paths proven on OCCT in
 * cad-kernel-occt's datum bridge suite.
 *
 * Also pinned here: the datum resolution seam (unknown datum, wrong datum
 * kind, face-referencing definitions without a topology seam → structured
 * diagnostics carrying the datum layer's code), the revolve datum-axis
 * mapping (a coplanar datum axis produces the compat form's identical
 * solid; an out-of-plane axis is refused structurally), and the hole's
 * datum-axis form (the +z datum reproduces the selector form's plan — the
 * planner's equivalence pin — and a +x datum drills the analytic
 * side-wall hole).
 */

import { describe, expect, it } from "vitest";
import {
  addBody,
  addDocumentDatum,
  addDocumentParameter,
  addDocumentSketch,
  addFeature,
  angle,
  dimensionless,
  type CadDocument,
  createBodyId,
  createDatumId,
  type DatumId,
  createDocument,
  createDocumentId,
  createFeatureId,
  createParameterId,
  createSketchDocumentId,
  DIAGNOSTIC_CODES,
  type FeatureRecordInput,
  initialRegenerationStates,
  length,
  regenerate,
} from "@slopcad/cad-core";
import type { GeometryKernel } from "./contract";

import { createFakeKernel } from "./fake-kernel";
import {
  createKernelFeatureExecutor,
  type KernelExecutorContext,
} from "./core-bridge";
import { assertVolumeClose } from "./test-utils";

const BOX = { w: 20, d: 10, h: 10 } as const;
const BOX_VOLUME = BOX.w * BOX.d * BOX.h;
/** Relative volume band for the fake kernel's curved booleans. */
const FAKE_CURVED_BAND = 0.02;

const pWidth = createParameterId("param_datum_w");
const pDepth = createParameterId("param_datum_d");
const pHeight = createParameterId("param_datum_h");
const pPlane = createParameterId("param_datum_mirror_plane");
const pOffset = createParameterId("param_datum_mirror_offset");
const pCount = createParameterId("param_datum_pattern_count");
const pAngle = createParameterId("param_datum_pattern_angle");
const pAxis = createParameterId("param_datum_pattern_axis");
const pSweep = createParameterId("param_datum_revolve_sweep");
const pAxisDir = createParameterId("param_datum_revolve_axisdir");
const pHoleDiameter = createParameterId("param_datum_hole_diameter");
const pHoleDepth = createParameterId("param_datum_hole_depth");
const pHoleX = createParameterId("param_datum_hole_x");
const pHoleY = createParameterId("param_datum_hole_y");

const bBox = createBodyId("body_datum_box");
const bPlaced = createBodyId("body_datum_placed");
const bResult = createBodyId("body_datum_result");
const fBox = createFeatureId("feat_datum_box");
const fPlace = createFeatureId("feat_datum_place");
const fAction = createFeatureId("feat_datum_action");

const dtmYZ = createDatumId("dtm_datum_yz");
const dtmOblique = createDatumId("dtm_datum_oblique");
const dtmAxisZ = createDatumId("dtm_datum_axis_z");
const dtmAxisX = createDatumId("dtm_datum_axis_x");
const dtmOutOfPlane = createDatumId("dtm_datum_axis_oop");
const dtmAxisOffset = createDatumId("dtm_datum_axis_offset");
const dtmPoint = createDatumId("dtm_datum_point");
const dtmFace = createDatumId("dtm_datum_face");

const YZ_PLANE_PAYLOAD = {
  formatVersion: 1,
  datumType: "plane",
  definition: "originFrame",
  origin: [0, 0, 0],
  normal: [1, 0, 0],
  xAxis: [0, 1, 0],
} as const;

const OBLIQUE_PLANE_PAYLOAD = {
  formatVersion: 1,
  datumType: "plane",
  definition: "originFrame",
  origin: [0, 0, 0],
  normal: [Math.SQRT1_2, 0, Math.SQRT1_2],
  xAxis: [0, 1, 0],
} as const;

const AXIS_Z_PAYLOAD = {
  formatVersion: 1,
  datumType: "axis",
  definition: "twoPoints",
  first: [0, 0, 0],
  second: [0, 0, 5],
} as const;

const AXIS_X_PAYLOAD = {
  formatVersion: 1,
  datumType: "axis",
  definition: "twoPoints",
  first: [0, 0, 0],
  second: [7, 0, 0],
} as const;

const AXIS_OUT_OF_PLANE_PAYLOAD = {
  formatVersion: 1,
  datumType: "axis",
  definition: "twoPoints",
  first: [0, 0, 0],
  second: [1, 0, 1],
} as const;

const AXIS_OFFSET_ALONG_NORMAL_PAYLOAD = {
  formatVersion: 1,
  datumType: "axis",
  definition: "twoPoints",
  first: [0, 0, 3],
  second: [7, 0, 3],
} as const;

const POINT_PAYLOAD = {
  formatVersion: 1,
  datumType: "point",
  position: [1, 1, 1],
} as const;

const FACE_PLANE_PAYLOAD = {
  formatVersion: 1,
  datumType: "plane",
  definition: "faceOffset",
  reference: { kind: "face", bodyId: "body_datum_placed", ordinal: 2 },
  normalAtDefinition: [0, 0, 1],
  offsetMm: 0,
} as const;

/** A stub profile resolver: a 4x4 square on the identity workplane. */
function stubProfileResolver(): KernelExecutorContext["profiles"] {
  return () => ({
    ok: true,
    value: {
      loop: [
        { kind: "line", start: [0, 0], end: [4, 0] },
        { kind: "line", start: [4, 0], end: [4, 4] },
        { kind: "line", start: [4, 4], end: [0, 4] },
        { kind: "line", start: [0, 4], end: [0, 0] },
      ],
      placement: {
        rotation: { axis: [0, 0, 1], angle: angle(0, "rad") },
        translation: { x: length(0), y: length(0), z: length(0) },
      },
    },
  });
}

/** Builds the placed-box document (box + translate) with datums and parameters. */
function buildDocument(
  datums: readonly {
    readonly id: DatumId;
    readonly payload: Record<string, unknown>;
  }[] = [],
  holePosition: { readonly xMm: number; readonly yMm: number } = {
    xMm: 10,
    yMm: 5,
  },
): CadDocument {
  let document = createDocument(createDocumentId("doc_bridge_datum"));
  const parameters: readonly [
    ReturnType<typeof createParameterId>,
    string,
    (
      | ReturnType<typeof length>
      | ReturnType<typeof dimensionless>
      | ReturnType<typeof angle>
    ),
  ][] = [
    [pWidth, "boxWidth", length(BOX.w)],
    [pDepth, "boxDepth", length(BOX.d)],
    [pHeight, "boxHeight", length(BOX.h)],
    [pPlane, "mirrorPlane", dimensionless(1)],
    [pOffset, "mirrorOffset", length(0)],
    [pCount, "patternCount", dimensionless(3)],
    [pAngle, "patternAngle", angle(120, "deg")],
    [pAxis, "patternAxis", dimensionless(3)],
    [pSweep, "revolveSweep", angle(360, "deg")],
    [pAxisDir, "revolveAxisDir", angle(0, "deg")],
    [pHoleDiameter, "holeDiameter", length(6)],
    [pHoleDepth, "holeDepth", length(99)],
    [pHoleX, "holeX", length(holePosition.xMm)],
    [pHoleY, "holeY", length(holePosition.yMm)],
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
  {
    // The revolve features' sketch input must resolve in the DOCUMENT even
    // though this suite's profile resolver is a stub (cad-kernel never
    // parses the payload — the seam is caller-supplied).
    const added = addDocumentSketch(document, {
      id: createSketchDocumentId("skd_datum_profile"),
      name: "datum profile",
      sketch: {
        formatVersion: 2,
        workplane: {},
        entities: [],
        constraints: [],
      },
    });
    if (!added.ok) throw new Error(added.error.message);
    document = added.value.document;
  }
  for (const body of [
    { id: bBox, name: "box" },
    { id: bPlaced, name: "placed" },
    { id: bResult, name: "result" },
  ]) {
    const added = addBody(document, body);
    if (!added.ok) throw new Error(added.error.message);
    document = added.value.document;
  }
  for (const feature of [
    {
      id: fBox,
      kind: "box",
      inputs: [
        { kind: "parameter", id: pWidth },
        { kind: "parameter", id: pDepth },
        { kind: "parameter", id: pHeight },
      ],
      outputs: [bBox],
    },
    {
      id: fPlace,
      kind: "translate",
      inputs: [
        { kind: "feature", id: fBox },
        { kind: "parameter", id: pWidth },
        { kind: "parameter", id: pDepth },
        { kind: "parameter", id: pHeight },
      ],
      outputs: [bPlaced],
    },
  ] as const) {
    document = addFeatureOrThrow(document, feature);
  }
  return document;
}

/** addFeature that throws on refusal (test convenience). */
function addFeatureOrThrow(
  document: CadDocument,
  feature: FeatureRecordInput,
): CadDocument {
  const added = addFeature(document, feature);
  if (!added.ok) throw new Error(added.error.message);
  return added.value.document;
}

interface ActionOutcome {
  readonly ok: boolean;
  readonly message: string;
  readonly code?: string;
  readonly datumCode?: string;
  readonly volume?: number;
  readonly boundsMin?: readonly number[];
}

/** Regenerates the document with the action feature appended, on `kernel`. */
function executeAction(
  datums: readonly {
    readonly id: DatumId;
    readonly payload: Record<string, unknown>;
  }[],
  feature: FeatureRecordInput,
  kernel: GeometryKernel = createFakeKernel(),
  holePosition: { readonly xMm: number; readonly yMm: number } = {
    xMm: 10,
    yMm: 5,
  },
): ActionOutcome {
  if (feature.id === undefined)
    throw new Error("the action feature needs an id");
  const document = addFeatureOrThrow(
    buildDocument(datums, holePosition),
    feature,
  );
  const bridge = createKernelFeatureExecutor(kernel, {
    document,
    bodies: new Map(),
    profiles: stubProfileResolver(),
  });
  const result = regenerate({
    features: document.features,
    states: initialRegenerationStates(document.features),
    suppressed: [],
    execute: bridge.executor,
  });
  if (!result.ok) throw new Error(result.error.message);
  const state = result.value.states.get(feature.id);
  if (state === undefined) throw new Error("no state for the action feature");
  if (state.state === "valid") {
    const solid = bridge.solidOf(bResult);
    const volume =
      solid === undefined ? undefined : unwrapNumber(kernel.volume(solid));
    const bounds =
      solid === undefined ? undefined : unwrapBounds(kernel.bounds(solid));
    return { ok: true, message: "", volume, boundsMin: bounds?.min };
  }
  const diagnostic = state.diagnostics[0];
  return {
    ok: false,
    message: diagnostic?.message ?? "",
    code: diagnostic?.code,
    datumCode: (diagnostic?.data as { datumCode?: string } | undefined)
      ?.datumCode,
  };
}

/** Unwraps a kernel measurement, throwing on refusal (test convenience). */
function unwrapNumber(result: {
  readonly ok: boolean;
  readonly value?: number;
  readonly error?: { readonly message: string };
}): number {
  if (!result.ok)
    throw new Error(result.error?.message ?? "kernel measurement refused");
  return result.value as number;
}

function unwrapBounds(result: {
  readonly ok: boolean;
  readonly value?: {
    readonly min: readonly number[];
    readonly max: readonly number[];
  };
  readonly error?: { readonly message: string };
}): { readonly min: readonly number[]; readonly max: readonly number[] } {
  if (!result.ok)
    throw new Error(result.error?.message ?? "kernel bounds refused");
  return result.value as {
    readonly min: readonly number[];
    readonly max: readonly number[];
  };
}

describe("mirror about a datum plane (the compat shim)", () => {
  const datumMirror: FeatureRecordInput = {
    id: fAction,
    kind: "mirror",
    inputs: [
      { kind: "feature", id: fPlace },
      { kind: "datum", id: dtmYZ },
    ],
    outputs: [bResult],
  };
  const compatMirror: FeatureRecordInput = {
    id: fAction,
    kind: "mirror",
    inputs: [
      { kind: "feature", id: fPlace },
      { kind: "parameter", id: pPlane },
      { kind: "parameter", id: pOffset },
    ],
    outputs: [bResult],
  };

  it("executes an axis-aligned datum plane identically to the selector form", () => {
    const datumRun = executeAction(
      [{ id: dtmYZ, payload: YZ_PLANE_PAYLOAD }],
      datumMirror,
    );
    expect(datumRun.ok, datumRun.message).toBe(true);
    const compatRun = executeAction([], compatMirror);
    expect(compatRun.ok, compatRun.message).toBe(true);
    // Identical planes → identical reflected geometry (exact fake mirror).
    expect(datumRun.volume).toBe(compatRun.volume);
    expect(datumRun.boundsMin).toEqual(compatRun.boundsMin);
    assertVolumeClose(datumRun.volume ?? 0, compatRun.volume ?? 0, 1e-9);
  });

  it("refuses an oblique datum plane on a rotation-less kernel, structurally", () => {
    const outcome = executeAction(
      [{ id: dtmOblique, payload: OBLIQUE_PLANE_PAYLOAD }],
      {
        id: fAction,
        kind: "mirror",
        inputs: [
          { kind: "feature", id: fPlace },
          { kind: "datum", id: dtmOblique },
        ],
        outputs: [bResult],
      },
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.code).toBe(DIAGNOSTIC_CODES.kernelFeatureInputInvalid);
    expect(outcome.message).toContain("transformRotation");
  });

  it("refuses a non-plane datum and an unresolvable face datum, structurally", () => {
    const wrongKind = executeAction(
      [{ id: dtmPoint, payload: POINT_PAYLOAD }],
      {
        id: fAction,
        kind: "mirror",
        inputs: [
          { kind: "feature", id: fPlace },
          { kind: "datum", id: dtmPoint },
        ],
        outputs: [bResult],
      },
    );
    expect(wrongKind.ok).toBe(false);
    expect(wrongKind.datumCode).toBe("datum/kind-invalid");
    expect(wrongKind.message).toContain("mirror plane");

    const facePlane = executeAction(
      [{ id: dtmFace, payload: FACE_PLANE_PAYLOAD }],
      {
        id: fAction,
        kind: "mirror",
        inputs: [
          { kind: "feature", id: fPlace },
          { kind: "datum", id: dtmFace },
        ],
        outputs: [bResult],
      },
    );
    expect(facePlane.ok).toBe(false);
    expect(facePlane.datumCode).toBe("datum/reference-invalid");
    expect(facePlane.message).toContain("no datum topology resolver");
  });
});

describe("pattern circular about a datum axis", () => {
  const patternWith = (datumId: DatumId): FeatureRecordInput => ({
    id: fAction,
    kind: "patternCircular",
    inputs: [
      { kind: "feature", id: fPlace },
      { kind: "parameter", id: pCount },
      { kind: "parameter", id: pAngle },
      { kind: "datum", id: datumId },
    ],
    outputs: [bResult],
  });

  it("refuses on a rotation-less kernel, structurally (the rotation gate)", () => {
    const outcome = executeAction(
      [{ id: dtmAxisZ, payload: AXIS_Z_PAYLOAD }],
      patternWith(dtmAxisZ),
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.code).toBe(DIAGNOSTIC_CODES.kernelFeatureInputInvalid);
    expect(outcome.message).toContain("transformRotation");
  });

  it("gates the rotation capability BEFORE datum resolution (the sweep convention)", () => {
    // Even a mis-kinded datum cannot outrun the capability gate: the
    // rotation refusal fires first, exactly as the sweep/pattern gates do.
    const outcome = executeAction(
      [{ id: dtmPoint, payload: POINT_PAYLOAD }],
      patternWith(dtmPoint),
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.message).toContain("transformRotation");
  });

  it("keeps the compat selector form working beside the datum form", () => {
    const outcome = executeAction([], {
      id: fAction,
      kind: "patternCircular",
      inputs: [
        { kind: "feature", id: fPlace },
        { kind: "parameter", id: pCount },
        { kind: "parameter", id: pAngle },
        { kind: "parameter", id: pAxis },
      ],
      outputs: [bResult],
    });
    // The fake kernel refuses rotations — the same structured gate the
    // datum form gets; the selector form's positive path lives on OCCT.
    expect(outcome.ok).toBe(false);
    expect(outcome.message).toContain("transformRotation");
  });
});

describe("revolve about a datum axis", () => {
  const revolveWith = (datumId: DatumId): FeatureRecordInput => ({
    id: fAction,
    kind: "revolve",
    inputs: [
      { kind: "sketch", id: createSketchDocumentId("skd_datum_profile") },
      { kind: "parameter", id: pSweep },
      { kind: "datum", id: datumId },
    ],
    outputs: [bResult],
  });
  const compatRevolve: FeatureRecordInput = {
    id: fAction,
    kind: "revolve",
    inputs: [
      { kind: "sketch", id: createSketchDocumentId("skd_datum_profile") },
      { kind: "parameter", id: pSweep },
      { kind: "parameter", id: pAxisDir },
    ],
    outputs: [bResult],
  };

  it("maps a coplanar datum axis onto the sketch-plane axis (compat-equivalent)", () => {
    // Axis X through the origin with the identity placement: the datum
    // form must produce the compat form's axis-direction-0 revolution.
    const datumRun = executeAction(
      [{ id: dtmAxisX, payload: AXIS_X_PAYLOAD }],
      revolveWith(dtmAxisX),
    );
    expect(datumRun.ok, datumRun.message).toBe(true);
    const compatRun = executeAction([], compatRevolve);
    expect(compatRun.ok, compatRun.message).toBe(true);
    expect(datumRun.volume).toBeGreaterThan(0);
    expect(datumRun.volume).toBeCloseTo(compatRun.volume ?? Number.NaN, 6);
  });

  it("refuses an out-of-plane datum axis, structurally", () => {
    const outcome = executeAction(
      [{ id: dtmOutOfPlane, payload: AXIS_OUT_OF_PLANE_PAYLOAD }],
      revolveWith(dtmOutOfPlane),
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.code).toBe(DIAGNOSTIC_CODES.kernelFeatureInputInvalid);
    expect(outcome.message).toContain("lie IN the sketch plane");
  });

  it("refuses a datum axis parallel to the plane but offset along its normal, structurally", () => {
    // Direction z = 0 (parallel) with origin z = 3 (offset): the direction
    // gate alone would pass it and the revolve would silently run about the
    // projected in-plane line — the origin half of the coplanarity gate.
    const outcome = executeAction(
      [
        {
          id: dtmAxisOffset,
          payload: AXIS_OFFSET_ALONG_NORMAL_PAYLOAD,
        },
      ],
      revolveWith(dtmAxisOffset),
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.code).toBe(DIAGNOSTIC_CODES.kernelFeatureInputInvalid);
    expect(outcome.datumCode).toBe("datum/definition-invalid");
    expect(outcome.message).toContain("lie IN the sketch plane");
    expect(outcome.message).toContain("offset");
  });
});

describe("hole along a datum axis", () => {
  // The placed box occupies x ∈ [20, 40], y ∈ [10, 20], z ∈ [10, 20].
  const holeWith = (datumId: DatumId): FeatureRecordInput => ({
    id: fAction,
    kind: "hole",
    inputs: [
      { kind: "feature", id: fPlace },
      { kind: "parameter", id: pHoleDiameter },
      { kind: "parameter", id: pHoleDepth },
      { kind: "parameter", id: pHoleX },
      { kind: "parameter", id: pHoleY },
      { kind: "datum", id: datumId },
    ],
    outputs: [bResult],
  });

  it("reproduces the selector form's plan for the +z datum", () => {
    // +z datum, identity rotation: the position rides world x/y directly,
    // so (30, 15) is the box's top-face center — the selector form's exact
    // convention.
    const outcome = executeAction(
      [{ id: dtmAxisZ, payload: AXIS_Z_PAYLOAD }],
      holeWith(dtmAxisZ),
      createFakeKernel(),
      { xMm: 30, yMm: 15 },
    );
    expect(outcome.ok, outcome.message).toBe(true);
    // A through hole along z removes π·r²·height from the box.
    const expected = BOX_VOLUME - Math.PI * 9 * BOX.h;
    assertVolumeClose(outcome.volume ?? Number.NaN, expected, FAKE_CURVED_BAND);
  });

  it("drills an analytic side-wall hole along the +x datum", () => {
    // +x datum: the tool rotation carries local +z onto +x and the position
    // rides the rotated frame — localX = −z, localY = +y. Position
    // (−15, 15) puts the tool center at world (along-axis, y=15, z=15) —
    // the mid-height center of the +x face. Depth 99 > the 20 mm extent
    // drills through along x; the analytic removal is π·r²·w.
    const outcome = executeAction(
      [{ id: dtmAxisX, payload: AXIS_X_PAYLOAD }],
      holeWith(dtmAxisX),
      createFakeKernel(),
      { xMm: -15, yMm: 15 },
    );
    expect(outcome.ok, outcome.message).toBe(true);
    const expected = BOX_VOLUME - Math.PI * 9 * BOX.w;
    assertVolumeClose(outcome.volume ?? Number.NaN, expected, FAKE_CURVED_BAND);
  });

  it("refuses a non-axis datum, structurally", () => {
    const outcome = executeAction(
      [{ id: dtmYZ, payload: YZ_PLANE_PAYLOAD }],
      holeWith(dtmYZ),
      createFakeKernel(),
      { xMm: 30, yMm: 15 },
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.datumCode).toBe("datum/kind-invalid");
    expect(outcome.message).toContain("datum AXIS");
  });
});
