/**
 * The Phase 41 feature-richness bridge tests: the extrude's optional
 * draft-taper parameter, and the rib / scale / thicken / split feature
 * kinds — each executed against the fake kernel whose compositions are
 * exact, each pinned against its analytic volume (draft = the prismatoid;
 * rib = the symmetric double extrusion's union; thicken = the closed
 * hollow; split = the kept half's volume), with `parameter.set` re-drive
 * and the structured failure taxonomies (layout, domain, capability
 * gates, the rib/split post-conditions).
 */

import { describe, expect, it } from "vitest";
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
  dimensionless,
  DIAGNOSTIC_CODES,
  type Diagnostic,
  type FeatureId,
  type FeatureRecordInput,
  initialRegenerationStates,
  length,
  regenerate,
} from "@slopcad/cad-core";

import { createFakeKernel } from "./fake-kernel";
import {
  createKernelFeatureExecutor,
  type KernelExecutionBridge,
  type KernelProfileResolver,
} from "./core-bridge";
import {
  type GeometryKernel,
  KERNEL_ERROR_CODES,
  type KernelSolid,
} from "./contract";
import { assertVolumeClose, unwrapKernelResult } from "./test-utils";

/** The fixture target box's extents (mm). */
const BOX = { w: 30, d: 20, h: 10 } as const;
const BOX_VOLUME = BOX.w * BOX.d * BOX.h;

const XY_PLACEMENT = {
  rotation: { axis: [0, 0, 1] as const, angle: angle(0) },
  translation: { x: length(0), y: length(0), z: length(0) },
};

/** A stub profile resolver: a 4×4 square on the identity workplane. */
const stubProfileResolver: KernelProfileResolver = () => ({
  ok: true,
  value: {
    loop: [
      { kind: "line", start: [0, 0], end: [4, 0] },
      { kind: "line", start: [4, 0], end: [4, 4] },
      { kind: "line", start: [4, 4], end: [0, 4] },
      { kind: "line", start: [0, 4], end: [0, 0] },
    ],
    placement: XY_PLACEMENT,
  },
});

/**
 * The no-op rib's resolver: the same 4×4 profile lifted to the box's
 * mid-height (z = 5), so both symmetric extrusion halves land strictly
 * inside the 30×20×10 target and the union cannot grow.
 */
const embeddedProfileResolver: KernelProfileResolver = () => ({
  ok: true,
  value: {
    loop: [
      { kind: "line", start: [0, 0], end: [4, 0] },
      { kind: "line", start: [4, 0], end: [4, 4] },
      { kind: "line", start: [4, 4], end: [0, 4] },
      { kind: "line", start: [0, 4], end: [0, 0] },
    ],
    placement: {
      rotation: { axis: [0, 0, 1] as const, angle: angle(0) },
      translation: { x: length(0), y: length(0), z: length(5) },
    },
  },
});

/** The serialized sketch payload the document record stores. */
const SKETCH_PAYLOAD = {
  formatVersion: 1,
  workplane: {
    origin: { x: 0, y: 0, z: 0 },
    normal: { x: 0, y: 0, z: 1 },
    xAxis: { x: 1, y: 0, z: 0 },
  },
  entities: [],
  constraints: [],
};

const SKETCH_ID = createSketchDocumentId("skd_richness_profile");

interface BridgeRun {
  readonly kernel: GeometryKernel;
  readonly bridge: KernelExecutionBridge;
  readonly run: ReturnType<typeof regenerate>;
}

function runBridge(
  document: CadDocument,
  kernel: GeometryKernel = createFakeKernel(),
  profiles: KernelProfileResolver = stubProfileResolver,
): BridgeRun {
  const bridge = createKernelFeatureExecutor(kernel, {
    document,
    bodies: new Map(),
    profiles,
  });
  const run = regenerate({
    features: document.features,
    states: initialRegenerationStates(document.features),
    suppressed: [],
    execute: bridge.executor,
  });
  return { kernel, bridge, run };
}

function failureDiagnosticOf(
  scenario: BridgeRun,
  feature: FeatureId,
): Diagnostic {
  if (!scenario.run.ok) throw new Error(scenario.run.error.message);
  const status = scenario.run.value.states.get(feature);
  expect(status?.state).toBe("failed");
  const diagnostic = status?.diagnostics[0];
  if (diagnostic === undefined)
    throw new Error("a failure carries diagnostics");
  return diagnostic;
}

function solidOf(
  scenario: BridgeRun,
  body: ReturnType<typeof createBodyId>,
): KernelSolid {
  const solid = scenario.bridge.solidOf(body);
  if (solid === undefined) throw new Error("the body has no solid");
  return solid;
}

// ---------------------------------------------------------------------------
// The extrude's draft taper
// ---------------------------------------------------------------------------

const pTaperDist = createParameterId("param_rich_taper_dist");
const pTaperAngle = createParameterId("param_rich_taper_angle");
const bTaper = createBodyId("body_rich_tapered");
const fTaper = createFeatureId("feat_rich_taper");

function buildTaperDocument(taperDeg: number, distanceMm = 10): CadDocument {
  let document = createDocument(createDocumentId("doc_bridge_taper"));
  const sketched = addDocumentSketch(document, {
    id: SKETCH_ID,
    name: "profile",
    sketch: SKETCH_PAYLOAD,
  });
  if (!sketched.ok) throw new Error(sketched.error.message);
  document = sketched.value.document;
  for (const [id, name, value] of [
    [pTaperDist, "extrudeDistance", length(distanceMm)],
    [pTaperAngle, "extrudeTaper", angle(taperDeg, "deg")],
  ] as const) {
    const added = addDocumentParameter(document, { id, name, value });
    if (!added.ok) throw new Error(added.error.message);
    document = added.value.document;
  }
  const body = addBody(document, { id: bTaper, name: "tapered" });
  if (!body.ok) throw new Error(body.error.message);
  document = body.value.document;
  const feature: FeatureRecordInput = {
    id: fTaper,
    kind: "extrude",
    inputs: [
      { kind: "sketch", id: SKETCH_ID },
      { kind: "parameter", id: pTaperDist },
      { kind: "parameter", id: pTaperAngle },
    ],
    outputs: [bTaper],
  };
  const featured = addFeature(document, feature);
  if (!featured.ok) throw new Error(featured.error.message);
  return featured.value.document;
}

describe("bridge extrude draft taper (Phase 41)", () => {
  it("extrudes the drafted prism to the exact prismatoid volume", () => {
    const scenario = runBridge(buildTaperDocument(5));
    if (!scenario.run.ok) throw new Error(scenario.run.error.message);
    // The 4×4 square at h=10, α=5°: H = 10·tan5°, A(d) = (4−2d)².
    const inset = 10 * Math.tan((5 * Math.PI) / 180);
    const expected = 10 * (16 - (16 * inset) / 2 + (4 / 3) * inset * inset);
    assertVolumeClose(
      unwrapKernelResult(
        scenario.kernel.volume(solidOf(scenario, bTaper)),
        "volume",
      ),
      expected,
      1e-9,
    );
  });

  it("keeps the two-input footing the plain prism (compat)", () => {
    // A zero taper angle is the plain prism: same volume either way.
    const zero = runBridge(buildTaperDocument(0));
    if (!zero.run.ok) throw new Error(zero.run.error.message);
    expect(
      unwrapKernelResult(zero.kernel.volume(solidOf(zero, bTaper)), "volume"),
    ).toBe(160);
  });

  it("re-drives through parameter.set on the taper angle", () => {
    const scenario = runBridge(buildTaperDocument(5));
    if (!scenario.run.ok) throw new Error(scenario.run.error.message);
    const edited = applyCommand(buildTaperDocument(5), {
      type: "parameter.set",
      id: pTaperAngle,
      value: angle(0, "deg"),
    });
    if (!edited.ok) throw new Error(edited.error.message);
    const rerun = runBridge(edited.value);
    if (!rerun.run.ok) throw new Error(rerun.run.error.message);
    expect(
      unwrapKernelResult(rerun.kernel.volume(solidOf(rerun, bTaper)), "volume"),
    ).toBe(160);
  });

  it("surfaces the kernel's invalid-taper battery as the feature diagnostic", () => {
    const scenario = runBridge(buildTaperDocument(89));
    const diagnostic = failureDiagnosticOf(scenario, fTaper);
    expect(diagnostic.code).toBe(DIAGNOSTIC_CODES.kernelOperationFailed);
    expect(diagnostic.data?.kernelErrorCode).toBe(
      KERNEL_ERROR_CODES.invalidTaper,
    );
  });
});

// ---------------------------------------------------------------------------
// The rib
// ---------------------------------------------------------------------------

const pRibBoxW = createParameterId("param_rib_box_w");
const pRibBoxD = createParameterId("param_rib_box_d");
const pRibBoxH = createParameterId("param_rib_box_h");
const pRibThickness = createParameterId("param_rib_thickness");
const bRib = createBodyId("body_rib");
const fRibBox = createFeatureId("feat_rib_box");
const fRib = createFeatureId("feat_rib");

function buildRibDocument(thicknessMm: number): CadDocument {
  let document = createDocument(createDocumentId("doc_bridge_rib"));
  const sketched = addDocumentSketch(document, {
    id: SKETCH_ID,
    name: "rib profile",
    sketch: SKETCH_PAYLOAD,
  });
  if (!sketched.ok) throw new Error(sketched.error.message);
  document = sketched.value.document;
  for (const [id, name, value] of [
    [pRibBoxW, "boxWidth", length(BOX.w)],
    [pRibBoxD, "boxDepth", length(BOX.d)],
    [pRibBoxH, "boxHeight", length(BOX.h)],
    [pRibThickness, "ribThickness", length(thicknessMm)],
  ] as const) {
    const added = addDocumentParameter(document, { id, name, value });
    if (!added.ok) throw new Error(added.error.message);
    document = added.value.document;
  }
  for (const body of [{ id: bRib, name: "ribbed" }]) {
    const added = addBody(document, body);
    if (!added.ok) throw new Error(added.error.message);
    document = added.value.document;
  }
  const features: readonly FeatureRecordInput[] = [
    {
      id: fRibBox,
      kind: "box",
      inputs: [
        { kind: "parameter", id: pRibBoxW },
        { kind: "parameter", id: pRibBoxD },
        { kind: "parameter", id: pRibBoxH },
      ],
      outputs: [bRib],
    },
    {
      id: fRib,
      kind: "rib",
      inputs: [
        { kind: "feature", id: fRibBox },
        { kind: "sketch", id: SKETCH_ID },
        { kind: "parameter", id: pRibThickness },
      ],
      outputs: [bRib],
    },
  ];
  for (const feature of features) {
    const added = addFeature(document, feature);
    if (!added.ok) throw new Error(added.error.message);
    document = added.value.document;
  }
  return document;
}

describe("bridge rib (Phase 41)", () => {
  it("unions the symmetric double extrusion with the box, exactly", () => {
    const scenario = runBridge(buildRibDocument(2));
    if (!scenario.run.ok) throw new Error(scenario.run.error.message);
    // The 4×4 profile at z=0 sits ON the box's bottom face (z∈[0,10]):
    // the rib up-half merges into the box; the down-half (z∈[−1,0]) is a
    // disjoint 4×4×1 slab, so the union adds exactly that slab.
    // The union's volume is the fake kernel's voxel-quantized boolean
    // measure: judged against the analytic value within the suite's
    // boolean band, like every fake-kernel boolean fixture.
    assertVolumeClose(
      unwrapKernelResult(
        scenario.kernel.volume(solidOf(scenario, bRib)),
        "volume",
      ),
      BOX_VOLUME + 16,
      0.02,
    );
  });

  it("re-drives through parameter.set on the thickness", () => {
    const edited = applyCommand(buildRibDocument(2), {
      type: "parameter.set",
      id: pRibThickness,
      value: length(4),
    });
    if (!edited.ok) throw new Error(edited.error.message);
    const scenario = runBridge(edited.value);
    if (!scenario.run.ok) throw new Error(scenario.run.error.message);
    assertVolumeClose(
      unwrapKernelResult(
        scenario.kernel.volume(solidOf(scenario, bRib)),
        "volume",
      ),
      BOX_VOLUME + 32,
      0.02,
    );
  });

  it("refuses the rib whose profile adds no material (the no-op guard)", () => {
    // The embedded resolver's profile extrudes both halves strictly inside
    // the box, so the union's volume cannot grow — the post-condition must
    // refuse the no-op rib as a structured decline instead of settling a
    // silently unchanged solid (the split no-op test's rib sibling).
    const diagnostic = failureDiagnosticOf(
      runBridge(
        buildRibDocument(2),
        createFakeKernel(),
        embeddedProfileResolver,
      ),
      fRib,
    );
    expect(diagnostic.code).toBe(DIAGNOSTIC_CODES.kernelOperationFailed);
    expect(diagnostic.message).toContain("added nothing");
  });

  it("refuses the domain and layout battery as structured diagnostics", () => {
    // A zero thickness degenerates the rib before any kernel call.
    const zero = runBridge(buildRibDocument(0));
    const diagnostic = failureDiagnosticOf(zero, fRib);
    expect(diagnostic.code).toBe(DIAGNOSTIC_CODES.kernelParameterInvalid);
    // A missing parameter input is a layout refusal.
    const base = buildRibDocument(2);
    const malformed = {
      ...base,
      features: base.features.map((feature) =>
        feature.id === fRib
          ? { ...feature, inputs: feature.inputs.slice(0, 2) }
          : feature,
      ),
    } as CadDocument;
    const layout = runBridge(malformed);
    const layoutDiagnostic = failureDiagnosticOf(layout, fRib);
    expect(layoutDiagnostic.code).toBe(
      DIAGNOSTIC_CODES.kernelFeatureInputInvalid,
    );
  });
});

// ---------------------------------------------------------------------------
// The scale
// ---------------------------------------------------------------------------

const pScaleBoxW = createParameterId("param_scale_box_w");
const pScaleBoxD = createParameterId("param_scale_box_d");
const pScaleBoxH = createParameterId("param_scale_box_h");
const pScaleFactor = createParameterId("param_scale_factor");
const bScaled = createBodyId("body_scaled");
const fScaleBox = createFeatureId("feat_scale_box");
const fScale = createFeatureId("feat_scale");

function buildScaleDocument(factor: number): CadDocument {
  let document = createDocument(createDocumentId("doc_bridge_scale"));
  for (const [id, name, value] of [
    [pScaleBoxW, "boxWidth", length(BOX.w)],
    [pScaleBoxD, "boxDepth", length(BOX.d)],
    [pScaleBoxH, "boxHeight", length(BOX.h)],
    [pScaleFactor, "scaleFactor", dimensionless(factor)],
  ] as const) {
    const added = addDocumentParameter(document, { id, name, value });
    if (!added.ok) throw new Error(added.error.message);
    document = added.value.document;
  }
  const added = addBody(document, { id: bScaled, name: "scaled" });
  if (!added.ok) throw new Error(added.error.message);
  document = added.value.document;
  const features: readonly FeatureRecordInput[] = [
    {
      id: fScaleBox,
      kind: "box",
      inputs: [
        { kind: "parameter", id: pScaleBoxW },
        { kind: "parameter", id: pScaleBoxD },
        { kind: "parameter", id: pScaleBoxH },
      ],
      outputs: [bScaled],
    },
    {
      id: fScale,
      kind: "scale",
      inputs: [
        { kind: "feature", id: fScaleBox },
        { kind: "parameter", id: pScaleFactor },
      ],
      outputs: [bScaled],
    },
  ];
  for (const feature of features) {
    const addedFeature = addFeature(document, feature);
    if (!addedFeature.ok) throw new Error(addedFeature.error.message);
    document = addedFeature.value.document;
  }
  return document;
}

describe("bridge scale (Phase 41)", () => {
  it("scales the box by factor³ exactly", () => {
    const scenario = runBridge(buildScaleDocument(2));
    if (!scenario.run.ok) throw new Error(scenario.run.error.message);
    assertVolumeClose(
      unwrapKernelResult(
        scenario.kernel.volume(solidOf(scenario, bScaled)),
        "volume",
      ),
      BOX_VOLUME * 8,
      1e-9,
    );
  });

  it("re-drives through parameter.set on the factor", () => {
    const edited = applyCommand(buildScaleDocument(2), {
      type: "parameter.set",
      id: pScaleFactor,
      value: dimensionless(0.5),
    });
    if (!edited.ok) throw new Error(edited.error.message);
    const scenario = runBridge(edited.value);
    if (!scenario.run.ok) throw new Error(scenario.run.error.message);
    assertVolumeClose(
      unwrapKernelResult(
        scenario.kernel.volume(solidOf(scenario, bScaled)),
        "volume",
      ),
      BOX_VOLUME / 8,
      1e-9,
    );
  });

  it("refuses non-positive factors before any kernel call", () => {
    const diagnostic = failureDiagnosticOf(
      runBridge(buildScaleDocument(0)),
      fScale,
    );
    expect(diagnostic.code).toBe(DIAGNOSTIC_CODES.kernelParameterInvalid);
  });
});

// ---------------------------------------------------------------------------
// The thicken
// ---------------------------------------------------------------------------

const pThickenBoxW = createParameterId("param_thicken_box_w");
const pThickenBoxD = createParameterId("param_thicken_box_d");
const pThickenBoxH = createParameterId("param_thicken_box_h");
const pThickenThickness = createParameterId("param_thicken_thickness");
const bThickened = createBodyId("body_thickened");
const fThickenBox = createFeatureId("feat_thicken_box");
const fThicken = createFeatureId("feat_thicken");

function buildThickenDocument(thicknessMm: number): CadDocument {
  let document = createDocument(createDocumentId("doc_bridge_thicken"));
  for (const [id, name, value] of [
    [pThickenBoxW, "boxWidth", length(BOX.w)],
    [pThickenBoxD, "boxDepth", length(BOX.d)],
    [pThickenBoxH, "boxHeight", length(BOX.h)],
    [pThickenThickness, "wallThickness", length(thicknessMm)],
  ] as const) {
    const added = addDocumentParameter(document, { id, name, value });
    if (!added.ok) throw new Error(added.error.message);
    document = added.value.document;
  }
  const added = addBody(document, { id: bThickened, name: "hollowed" });
  if (!added.ok) throw new Error(added.error.message);
  document = added.value.document;
  const features: readonly FeatureRecordInput[] = [
    {
      id: fThickenBox,
      kind: "box",
      inputs: [
        { kind: "parameter", id: pThickenBoxW },
        { kind: "parameter", id: pThickenBoxD },
        { kind: "parameter", id: pThickenBoxH },
      ],
      outputs: [bThickened],
    },
    {
      id: fThicken,
      kind: "thicken",
      inputs: [
        { kind: "feature", id: fThickenBox },
        { kind: "parameter", id: pThickenThickness },
      ],
      outputs: [bThickened],
    },
  ];
  for (const feature of features) {
    const addedFeature = addFeature(document, feature);
    if (!addedFeature.ok) throw new Error(addedFeature.error.message);
    document = addedFeature.value.document;
  }
  return document;
}

describe("bridge thicken (Phase 41)", () => {
  it("hollows the box to the exact closed shell", () => {
    const scenario = runBridge(buildThickenDocument(2));
    if (!scenario.run.ok) throw new Error(scenario.run.error.message);
    assertVolumeClose(
      unwrapKernelResult(
        scenario.kernel.volume(solidOf(scenario, bThickened)),
        "volume",
      ),
      BOX_VOLUME - 26 * 16 * 6,
      1e-9,
    );
  });

  it("re-drives through parameter.set on the thickness", () => {
    const edited = applyCommand(buildThickenDocument(2), {
      type: "parameter.set",
      id: pThickenThickness,
      value: length(3),
    });
    if (!edited.ok) throw new Error(edited.error.message);
    const scenario = runBridge(edited.value);
    if (!scenario.run.ok) throw new Error(scenario.run.error.message);
    assertVolumeClose(
      unwrapKernelResult(
        scenario.kernel.volume(solidOf(scenario, bThickened)),
        "volume",
      ),
      BOX_VOLUME - 24 * 14 * 4,
      1e-9,
    );
  });

  it("surfaces the too-thick refusal as the feature diagnostic", () => {
    const diagnostic = failureDiagnosticOf(
      runBridge(buildThickenDocument(5)),
      fThicken,
    );
    expect(diagnostic.code).toBe(DIAGNOSTIC_CODES.kernelOperationFailed);
    expect(diagnostic.data?.kernelErrorCode).toBe(
      KERNEL_ERROR_CODES.thickenFailed,
    );
  });
});

// ---------------------------------------------------------------------------
// The split
// ---------------------------------------------------------------------------

const pSplitBoxW = createParameterId("param_split_box_w");
const pSplitBoxD = createParameterId("param_split_box_d");
const pSplitBoxH = createParameterId("param_split_box_h");
const pSplitSide = createParameterId("param_split_side");
const bSplit = createBodyId("body_split");
const fSplitBox = createFeatureId("feat_split_box");
const fSplit = createFeatureId("feat_split");
const dSplitPlane = createDatumId("dtm_split_plane");

/** The z = 5 datum plane payload (the fixture box's mid-height). */
const SPLIT_PLANE_PAYLOAD = {
  formatVersion: 1,
  datumType: "plane",
  definition: "originFrame",
  origin: [0, 0, 5],
  normal: [0, 0, 1],
  xAxis: [1, 0, 0],
} as const;

function buildSplitDocument(
  side: number,
  plane: Record<string, unknown> = SPLIT_PLANE_PAYLOAD,
): CadDocument {
  let document = createDocument(createDocumentId("doc_bridge_split"));
  // The datum record must exist before the feature that references it.
  document = withDatum(document, plane);
  for (const [id, name, value] of [
    [pSplitBoxW, "boxWidth", length(BOX.w)],
    [pSplitBoxD, "boxDepth", length(BOX.d)],
    [pSplitBoxH, "boxHeight", length(BOX.h)],
    [pSplitSide, "splitSide", dimensionless(side)],
  ] as const) {
    const added = addDocumentParameter(document, { id, name, value });
    if (!added.ok) throw new Error(added.error.message);
    document = added.value.document;
  }
  const added = addBody(document, { id: bSplit, name: "split" });
  if (!added.ok) throw new Error(added.error.message);
  document = added.value.document;
  const features: readonly FeatureRecordInput[] = [
    {
      id: fSplitBox,
      kind: "box",
      inputs: [
        { kind: "parameter", id: pSplitBoxW },
        { kind: "parameter", id: pSplitBoxD },
        { kind: "parameter", id: pSplitBoxH },
      ],
      outputs: [bSplit],
    },
    {
      id: fSplit,
      kind: "split",
      inputs: [
        { kind: "feature", id: fSplitBox },
        { kind: "datum", id: dSplitPlane },
        { kind: "parameter", id: pSplitSide },
      ],
      outputs: [bSplit],
    },
  ];
  for (const feature of features) {
    const addedFeature = addFeature(document, feature);
    if (!addedFeature.ok) throw new Error(addedFeature.error.message);
    document = addedFeature.value.document;
  }
  return document;
}

/** Adds the datum record a split document references. */
function withDatum(
  document: CadDocument,
  payload: Record<string, unknown>,
): CadDocument {
  const added = addDocumentDatum(document, {
    id: dSplitPlane,
    name: "split plane",
    datum: payload,
  });
  if (!added.ok) throw new Error(added.error.message);
  return added.value.document;
}

describe("bridge split (Phase 41)", () => {
  it("keeps the normal's side of the mid-height plane, exactly", () => {
    const scenario = runBridge(buildSplitDocument(1));
    if (!scenario.run.ok) throw new Error(scenario.run.error.message);
    assertVolumeClose(
      unwrapKernelResult(
        scenario.kernel.volume(solidOf(scenario, bSplit)),
        "volume",
      ),
      BOX.w * BOX.d * 5,
      0.02,
    );
  });

  it("keeps the opposite side on the flipped selector, re-driven", () => {
    const document = buildSplitDocument(1);
    const edited = applyCommand(document, {
      type: "parameter.set",
      id: pSplitSide,
      value: dimensionless(-1),
    });
    if (!edited.ok) throw new Error(edited.error.message);
    const scenario = runBridge(edited.value);
    if (!scenario.run.ok) throw new Error(scenario.run.error.message);
    assertVolumeClose(
      unwrapKernelResult(
        scenario.kernel.volume(solidOf(scenario, bSplit)),
        "volume",
      ),
      BOX.w * BOX.d * 5,
      0.02,
    );
  });

  it("splits by an oblique plane to the exact corner-cut volume", () => {
    // The plane through the origin with normal (√½, 0, √½): the kept side
    // is x + z ≥ 0 — for the box [0,30]×[0,20]×[0,10] the removed corner
    // wedge is {(x,z) : x + z < 0} ∩ the box = EMPTY... the plane touches
    // the box only at the origin edge, so this fixture keeps everything
    // (the no-op refusal's domain). Use the honest oblique cut instead:
    // normal (−√½, 0, √½) at the origin keeps x ≤ z — the removed wedge
    // is x > z over the xz footprint.
    const payload = {
      formatVersion: 1,
      datumType: "plane",
      definition: "originFrame",
      origin: [0, 0, 0],
      normal: [-Math.SQRT1_2, 0, Math.SQRT1_2],
      xAxis: [Math.SQRT1_2, 0, Math.SQRT1_2],
    } as const;
    const scenario = runBridge(buildSplitDocument(1, payload));
    if (!scenario.run.ok) throw new Error(scenario.run.error.message);
    // Kept: x ≤ z per (x,z) ∈ [0,30]×[0,10]: ∫₀¹₀ z dz · 20 (the voxel
    // boolean band, like every fake-kernel boolean fixture).
    const kept = 20 * ((10 * 10) / 2);
    assertVolumeClose(
      unwrapKernelResult(
        scenario.kernel.volume(solidOf(scenario, bSplit)),
        "volume",
      ),
      kept,
      0.02,
    );
  });

  it("refuses both degenerate splits and the bad side selector", () => {
    // A plane wholly above the box, keep +1: the kept side holds nothing.
    const above = {
      formatVersion: 1,
      datumType: "plane",
      definition: "originFrame",
      origin: [0, 0, 40],
      normal: [0, 0, 1],
      xAxis: [1, 0, 0],
    } as const;
    const everything = failureDiagnosticOf(
      runBridge(buildSplitDocument(1, above)),
      fSplit,
    );
    expect(everything.code).toBe(DIAGNOSTIC_CODES.kernelOperationFailed);
    expect(everything.message).toContain("removed everything");
    // The same plane, keep −1: the removed side holds nothing.
    const nothing = failureDiagnosticOf(
      runBridge(buildSplitDocument(-1, above)),
      fSplit,
    );
    expect(nothing.code).toBe(DIAGNOSTIC_CODES.kernelOperationFailed);
    expect(nothing.message).toContain("removed nothing");
    const side = failureDiagnosticOf(runBridge(buildSplitDocument(0)), fSplit);
    expect(side.code).toBe(DIAGNOSTIC_CODES.kernelParameterInvalid);
  });
});
