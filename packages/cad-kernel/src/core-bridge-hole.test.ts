/**
 * The hole feature's bridge tests (Phase 26.10): a target box + five
 * parameters (diameter — LENGTH; depth — LENGTH; positionX/positionY —
 * LENGTH; axis — dimensionless 1/2/3) → the bridge's `hole` kind → the fake
 * kernel, whose cylinder/transform/subtract composition is exact.
 *
 * The plan's validation pin is every parameter: a `parameter.set` on the
 * diameter, the depth, the position, or the axis selector regenerates the
 * geometry — each pinned against its analytic volume (blind: box − π·r²·d;
 * through: box − π·r²·thickness; a hole exiting a side face: box − the
 * circular-segment remainder).
 *
 * The failure taxonomy (diameter/depth ≤ 0, axis selector outside 1..3,
 * wrong dimensions, layout) is pinned case by case as structured
 * diagnostics, and the silent-no-op trap gets its own pin: a hole whose
 * tool misses the target would otherwise return the target UNCHANGED from
 * the subtract (the disjoint-tool behavior of every kernel), so the bridge
 * enforces the shell post-condition precedent — the volume must strictly
 * decrease — and refuses the no-op as a structured feature diagnostic.
 */

import { describe, expect, it } from "vitest";
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
  HOLE_TOOL_OVERSHOOT_MM,
  type KernelExecutionBridge,
} from "./core-bridge";
import {
  type GeometryKernel,
  KERNEL_ERROR_CODES,
  type KernelSolid,
} from "./contract";
import {
  assertBoundsEqual,
  assertVolumeClose,
  unwrapKernelResult,
} from "./test-utils";

/** The fixture target box's extents (mm) — the plate-with-hole precedent. */
const BOX = { w: 30, d: 20, h: 10 } as const;
const BOX_VOLUME = BOX.w * BOX.d * BOX.h;

/** Relative volume band for the fake kernel's curved booleans. */
const FAKE_CURVED_BAND = 0.02;

const pBoxWidth = createParameterId("param_hole_box_w");
const pBoxDepth = createParameterId("param_hole_box_d");
const pBoxHeight = createParameterId("param_hole_box_h");
const pDiameter = createParameterId("param_hole_diameter");
const pDepth = createParameterId("param_hole_depth");
const pX = createParameterId("param_hole_x");
const pY = createParameterId("param_hole_y");
const pAxis = createParameterId("param_hole_axis");

const bBox = createBodyId("body_hole_box");
const bHole = createBodyId("body_hole_result");
const fBox = createFeatureId("feat_hole_box");
const fHole = createFeatureId("feat_hole");

/** A hole parameter override against the fixture defaults. */
interface HoleSpec {
  readonly diameterMm: number;
  readonly depthMm: number;
  readonly xMm: number;
  readonly yMm: number;
  readonly axis: number;
}

const HOLE_DEFAULTS: HoleSpec = {
  diameterMm: 8,
  depthMm: 4,
  xMm: BOX.w / 2,
  yMm: BOX.d / 2,
  axis: 3,
};

/** Builds the box → hole document with the given hole parameters. */
function buildHoleDocument(spec: Partial<HoleSpec> = {}): CadDocument {
  const hole = { ...HOLE_DEFAULTS, ...spec };
  let document = createDocument(createDocumentId("doc_bridge_hole"));
  for (const [id, name, value] of [
    [pBoxWidth, "boxWidth", length(BOX.w)],
    [pBoxDepth, "boxDepth", length(BOX.d)],
    [pBoxHeight, "boxHeight", length(BOX.h)],
    [pDiameter, "holeDiameter", length(hole.diameterMm)],
    [pDepth, "holeDepth", length(hole.depthMm)],
    [pX, "holeX", length(hole.xMm)],
    [pY, "holeY", length(hole.yMm)],
    [pAxis, "holeAxis", dimensionless(hole.axis)],
  ] as const) {
    const added = addDocumentParameter(document, { id, name, value });
    if (!added.ok) throw new Error(added.error.message);
    document = added.value.document;
  }
  for (const body of [
    { id: bBox, name: "box" },
    { id: bHole, name: "holed" },
  ]) {
    const added = addBody(document, body);
    if (!added.ok) throw new Error(added.error.message);
    document = added.value.document;
  }
  const features: readonly FeatureRecordInput[] = [
    {
      id: fBox,
      kind: "box",
      inputs: [
        { kind: "parameter", id: pBoxWidth },
        { kind: "parameter", id: pBoxDepth },
        { kind: "parameter", id: pBoxHeight },
      ],
      outputs: [bBox],
    },
    {
      id: fHole,
      kind: "hole",
      inputs: [
        { kind: "feature", id: fBox },
        { kind: "parameter", id: pDiameter },
        { kind: "parameter", id: pDepth },
        { kind: "parameter", id: pX },
        { kind: "parameter", id: pY },
        { kind: "parameter", id: pAxis },
      ],
      outputs: [bHole],
    },
  ];
  for (const feature of features) {
    const added = addFeature(document, feature);
    if (!added.ok) throw new Error(added.error.message);
    document = added.value.document;
  }
  return document;
}

/** A hole document with the feature's inputs replaced wholesale. */
function buildMalformedHole(inputs: FeatureRecordInput["inputs"]): CadDocument {
  let document = buildHoleDocument();
  document = {
    ...document,
    features: document.features.map((feature) =>
      feature.id === fHole ? { ...feature, inputs } : feature,
    ),
  };
  return document;
}

interface BridgeRun {
  readonly kernel: GeometryKernel;
  readonly bridge: KernelExecutionBridge;
  readonly run: ReturnType<typeof regenerate>;
}

function runBridge(
  document: CadDocument,
  kernel: GeometryKernel = createFakeKernel(),
): BridgeRun {
  const bridge = createKernelFeatureExecutor(kernel, {
    document,
    bodies: new Map(),
    profiles: () => ({
      ok: false,
      error: {
        code: "sketch/profile-empty",
        message: "no resolver here",
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
  return { kernel, bridge, run };
}

/** Extracts the first diagnostic of a failed feature from a bridge run. */
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

/** The hole result solid of a successful run (throws when absent). */
function holeSolidOf(scenario: BridgeRun): KernelSolid {
  const solid = scenario.bridge.solidOf(bHole);
  if (solid === undefined) throw new Error("the hole body has no solid");
  return solid;
}

/** The analytic blind-hole volume: box − π·r²·depth. */
function blindVolume(diameterMm: number, depthMm: number): number {
  return BOX_VOLUME - Math.PI * (diameterMm / 2) ** 2 * depthMm;
}

/** The analytic through-hole volume: box − π·r²·thickness. */
function throughVolume(diameterMm: number): number {
  return BOX_VOLUME - Math.PI * (diameterMm / 2) ** 2 * BOX.h;
}

describe("core bridge hole (Phase 26.10)", () => {
  it("executes the blind hole end-to-end at the analytic volume, bounds untouched", () => {
    const scenario = runBridge(buildHoleDocument());
    if (!scenario.run.ok) throw new Error(scenario.run.error.message);
    expect([...scenario.run.value.executed]).toEqual([fBox, fHole]);
    expect(scenario.run.value.states.get(fHole)).toEqual({
      state: "valid",
      diagnostics: [],
    });
    const solid = holeSolidOf(scenario);
    assertVolumeClose(
      unwrapKernelResult(scenario.kernel.volume(solid), "hole volume"),
      blindVolume(8, 4),
      FAKE_CURVED_BAND,
    );
    // A hole removes interior material: the target's bounds survive.
    assertBoundsEqual(
      unwrapKernelResult(scenario.kernel.bounds(solid), "hole bounds"),
      { min: [0, 0, 0], max: [BOX.w, BOX.d, BOX.h] },
      1e-6,
    );
  });

  it("regenerates from parameter.set on the diameter", () => {
    const document = buildHoleDocument();
    const set = applyCommand(document, {
      type: "parameter.set",
      id: pDiameter,
      value: length(12),
    });
    if (!set.ok) throw new Error(set.error.message);
    const scenario = runBridge(set.value);
    assertVolumeClose(
      unwrapKernelResult(
        scenario.kernel.volume(holeSolidOf(scenario)),
        "hole volume",
      ),
      blindVolume(12, 4),
      FAKE_CURVED_BAND,
    );
  });

  it("regenerates from parameter.set on the depth: blind → deeper blind", () => {
    const document = buildHoleDocument();
    const set = applyCommand(document, {
      type: "parameter.set",
      id: pDepth,
      value: length(7),
    });
    if (!set.ok) throw new Error(set.error.message);
    const scenario = runBridge(set.value);
    assertVolumeClose(
      unwrapKernelResult(
        scenario.kernel.volume(holeSolidOf(scenario)),
        "hole volume",
      ),
      blindVolume(8, 7),
      FAKE_CURVED_BAND,
    );
  });

  it("drills THROUGH when the depth reaches the remaining thickness (depth == extent)", () => {
    const document = buildHoleDocument({ diameterMm: 12, depthMm: BOX.h });
    const scenario = runBridge(document);
    assertVolumeClose(
      unwrapKernelResult(
        scenario.kernel.volume(holeSolidOf(scenario)),
        "hole volume",
      ),
      throughVolume(12),
      FAKE_CURVED_BAND,
    );
  });

  it("drills THROUGH when the depth exceeds the remaining thickness (no over-drill)", () => {
    const document = buildHoleDocument({ diameterMm: 12, depthMm: BOX.h + 5 });
    const scenario = runBridge(document);
    assertVolumeClose(
      unwrapKernelResult(
        scenario.kernel.volume(holeSolidOf(scenario)),
        "hole volume",
      ),
      throughVolume(12),
      FAKE_CURVED_BAND,
    );
  });

  it("regenerates from parameter.set on the position: the hole exits a side face", () => {
    // Ø12 at x = 28 (default blind depth 4): the circle reaches 4 mm past
    // the +x face (x = 30), so the removed area is the full disk MINUS the
    // circular segment beyond the face — segment area r²·acos(d/r) −
    // d·√(r²−d²) with the center 2 mm inside the face.
    const document = buildHoleDocument({ diameterMm: 12 });
    const set = applyCommand(document, {
      type: "parameter.set",
      id: pX,
      value: length(BOX.w - 2),
    });
    if (!set.ok) throw new Error(set.error.message);
    const scenario = runBridge(set.value);
    const radius = 6;
    const inFace = 2;
    const segmentArea =
      radius * radius * Math.acos(inFace / radius) -
      inFace * Math.sqrt(radius * radius - inFace * inFace);
    const removedArea = Math.PI * radius * radius - segmentArea;
    assertVolumeClose(
      unwrapKernelResult(
        scenario.kernel.volume(holeSolidOf(scenario)),
        "hole volume",
      ),
      BOX_VOLUME - removedArea * HOLE_DEFAULTS.depthMm,
      FAKE_CURVED_BAND,
    );
  });

  it("maps the axis selector's in-plane position: axis 1 (X) drills through the +x face", () => {
    // Axis 1: thickness along x is 30, so depth 35 drills through; the
    // position (10, 5) rides the (y, z) face — a misread axis would remove
    // a different π·r²·extent and fail the pin.
    const document = buildHoleDocument({
      axis: 1,
      depthMm: 35,
      xMm: 10,
      yMm: 5,
    });
    const scenario = runBridge(document);
    assertVolumeClose(
      unwrapKernelResult(
        scenario.kernel.volume(holeSolidOf(scenario)),
        "hole volume",
      ),
      BOX_VOLUME - Math.PI * 4 ** 2 * BOX.w,
      FAKE_CURVED_BAND,
    );
  });

  it("regenerates from parameter.set on the axis selector: 3 (Z) → 1 (X)", () => {
    const document = buildHoleDocument({ depthMm: 35, xMm: 10, yMm: 5 });
    const set = applyCommand(document, {
      type: "parameter.set",
      id: pAxis,
      value: dimensionless(1),
    });
    if (!set.ok) throw new Error(set.error.message);
    const scenario = runBridge(set.value);
    // Through-z removed π·16·10; through-x removes π·16·30 — the selector
    // changed which face the hole enters.
    assertVolumeClose(
      unwrapKernelResult(
        scenario.kernel.volume(holeSolidOf(scenario)),
        "hole volume",
      ),
      BOX_VOLUME - Math.PI * 4 ** 2 * BOX.w,
      FAKE_CURVED_BAND,
    );
  });

  it("fails a non-positive diameter with kernel/parameter-invalid", () => {
    for (const diameter of [0, -2]) {
      const scenario = runBridge(buildHoleDocument({ diameterMm: diameter }));
      const diagnostic = failureDiagnosticOf(scenario, fHole);
      expect(diagnostic.code, `diameter ${diameter}`).toBe(
        DIAGNOSTIC_CODES.kernelParameterInvalid,
      );
      expect(diagnostic.message).toContain("diameter");
      expect(scenario.bridge.solidOf(bHole)).toBeUndefined();
    }
  });

  it("fails a non-positive depth with kernel/parameter-invalid", () => {
    for (const depth of [0, -1]) {
      const scenario = runBridge(buildHoleDocument({ depthMm: depth }));
      const diagnostic = failureDiagnosticOf(scenario, fHole);
      expect(diagnostic.code, `depth ${depth}`).toBe(
        DIAGNOSTIC_CODES.kernelParameterInvalid,
      );
      expect(diagnostic.message).toContain("depth");
      expect(scenario.bridge.solidOf(bHole)).toBeUndefined();
    }
  });

  it("fails an axis selector outside 1..3 with kernel/parameter-invalid", () => {
    for (const axis of [0, 4, 2.5]) {
      const scenario = runBridge(buildHoleDocument({ axis }));
      const diagnostic = failureDiagnosticOf(scenario, fHole);
      expect(diagnostic.code, `axis ${axis}`).toBe(
        DIAGNOSTIC_CODES.kernelParameterInvalid,
      );
      expect(diagnostic.message).toContain("1 = X");
      expect(scenario.bridge.solidOf(bHole)).toBeUndefined();
    }
  });

  it("fails wrong-dimension parameters with kernel/parameter-invalid", () => {
    const mismatch = (
      parameter: typeof pDiameter,
      value:
        | ReturnType<typeof length>
        | ReturnType<typeof angle>
        | ReturnType<typeof dimensionless>,
    ): CadDocument => {
      let document = buildHoleDocument();
      document = {
        ...document,
        parameters: {
          ...document.parameters,
          parameters: document.parameters.parameters.map((entry) =>
            entry.id === parameter ? { ...entry, value } : entry,
          ),
        },
      };
      return document;
    };
    let scenario = runBridge(mismatch(pDiameter, angle(8, "deg")));
    expect(failureDiagnosticOf(scenario, fHole).message).toContain(
      "param_hole_diameter",
    );
    scenario = runBridge(mismatch(pDepth, dimensionless(4)));
    expect(failureDiagnosticOf(scenario, fHole).message).toContain(
      "param_hole_depth",
    );
    scenario = runBridge(mismatch(pX, angle(1)));
    expect(failureDiagnosticOf(scenario, fHole).message).toContain(
      "param_hole_x",
    );
    scenario = runBridge(mismatch(pAxis, length(3)));
    expect(failureDiagnosticOf(scenario, fHole).message).toContain(
      "param_hole_axis",
    );
  });

  it("fails malformed layouts with kernel/feature-input-invalid", () => {
    // Two targets.
    let scenario = runBridge(
      buildMalformedHole([
        { kind: "feature", id: fBox },
        { kind: "feature", id: fBox },
        { kind: "parameter", id: pDiameter },
        { kind: "parameter", id: pDepth },
        { kind: "parameter", id: pX },
        { kind: "parameter", id: pY },
        { kind: "parameter", id: pAxis },
      ]),
    );
    expect(failureDiagnosticOf(scenario, fHole).code).toBe(
      DIAGNOSTIC_CODES.kernelFeatureInputInvalid,
    );
    // One parameter short (the axis missing).
    scenario = runBridge(
      buildMalformedHole([
        { kind: "feature", id: fBox },
        { kind: "parameter", id: pDiameter },
        { kind: "parameter", id: pDepth },
        { kind: "parameter", id: pX },
        { kind: "parameter", id: pY },
      ]),
    );
    expect(failureDiagnosticOf(scenario, fHole).code).toBe(
      DIAGNOSTIC_CODES.kernelFeatureInputInvalid,
    );
    // One parameter over.
    scenario = runBridge(
      buildMalformedHole([
        { kind: "feature", id: fBox },
        { kind: "parameter", id: pDiameter },
        { kind: "parameter", id: pDepth },
        { kind: "parameter", id: pX },
        { kind: "parameter", id: pY },
        { kind: "parameter", id: pAxis },
        { kind: "parameter", id: pY },
      ]),
    );
    expect(failureDiagnosticOf(scenario, fHole).code).toBe(
      DIAGNOSTIC_CODES.kernelFeatureInputInvalid,
    );
    // A sketch input where the target belongs (the layout count still fits,
    // so the offender branch names the sketch input itself).
    scenario = runBridge(
      buildMalformedHole([
        { kind: "feature", id: fBox },
        { kind: "sketch", id: createSketchDocumentId("skd_hole_malformed") },
        { kind: "parameter", id: pDiameter },
        { kind: "parameter", id: pDepth },
        { kind: "parameter", id: pX },
        { kind: "parameter", id: pY },
        { kind: "parameter", id: pAxis },
      ]),
    );
    const diagnostic = failureDiagnosticOf(scenario, fHole);
    expect(diagnostic.code).toBe(DIAGNOSTIC_CODES.kernelFeatureInputInvalid);
    expect(diagnostic.message).toContain("cannot be holed");
  });

  it("refuses the silent no-op: a hole missing the target removes nothing", () => {
    // Probed trap: a subtract whose tool is disjoint from the target
    // returns the target UNCHANGED on every kernel — the volumes below
    // prove the tool landed nowhere before the guard refuses it.
    const scenario = runBridge(buildHoleDocument({ xMm: 100 }));
    const diagnostic = failureDiagnosticOf(scenario, fHole);
    expect(diagnostic.code).toBe(DIAGNOSTIC_CODES.kernelOperationFailed);
    expect(diagnostic.message).toContain("removed no material");
    expect(diagnostic.message).toContain("holeX");
    const data = diagnostic.data as {
      reason?: string;
      targetVolumeMm3?: number;
      resultVolumeMm3?: number;
    };
    expect(data.reason).toBe("hole/no-op");
    expect(data.targetVolumeMm3).toBeCloseTo(BOX_VOLUME, 6);
    expect(data.resultVolumeMm3).toBeCloseTo(BOX_VOLUME, 6);
    expect(scenario.bridge.solidOf(bHole)).toBeUndefined();
  });

  it("rides a kernel rejection through as kernel/operation-failed with the code in data", () => {
    const inner = createFakeKernel();
    const rejecting: GeometryKernel = {
      ...inner,
      subtract: () => ({
        ok: false,
        error: {
          code: KERNEL_ERROR_CODES.solidNotOwned,
          message: "fixture rejection",
          input: null,
        },
      }),
    };
    const scenario = runBridge(buildHoleDocument(), rejecting);
    const diagnostic = failureDiagnosticOf(scenario, fHole);
    expect(diagnostic.code).toBe(DIAGNOSTIC_CODES.kernelOperationFailed);
    expect(diagnostic.data?.kernelErrorCode).toBe("kernel/solid-not-owned");
    expect(scenario.bridge.solidOf(bHole)).toBeUndefined();
  });

  it("keeps the tool's overshoot strictly off the geometry it defines", () => {
    // The blind tool extends HOLE_TOOL_OVERSHOOT_MM past the entry face so
    // the cut opens cleanly, but the hole BOTTOM stays exactly at depth —
    // a deepened blind hole (depth 4 → 4+ε never crosses the floor before
    // its parameter says so). Pinned via the blind volume at depth 4.5 on
    // the same face: the overshoot may not deepen the cut.
    const scenario = runBridge(buildHoleDocument({ depthMm: 4.5 }));
    assertVolumeClose(
      unwrapKernelResult(
        scenario.kernel.volume(holeSolidOf(scenario)),
        "hole volume",
      ),
      blindVolume(8, 4.5),
      FAKE_CURVED_BAND,
    );
    expect(HOLE_TOOL_OVERSHOOT_MM).toBeGreaterThan(0);
  });
});
