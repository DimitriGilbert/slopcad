/**
 * End-to-end tests of the core-executes-against-kernel bridge: parameters
 * → document features → cad-core regeneration executor → fake kernel →
 * semantic assertions on the executed geometry. This is the Phase 8
 * validation criterion "core can execute against fake kernel" made
 * executable: cad-core's own `regenerate` orchestration drives the bridge,
 * and the resulting solids are judged with the kernel-neutral semantic
 * utilities.
 */

import { describe, expect, it } from "vitest";
import {
  addBody,
  addDocumentParameter,
  addFeature,
  angle,
  type BodyId,
  type CadDocument,
  createBodyId,
  createDocument,
  createDocumentId,
  createFeatureId,
  createParameterId,
  DIAGNOSTIC_CODES,
  type Diagnostic,
  type FeatureGraphError,
  type FeatureId,
  type FeatureRecordInput,
  initialRegenerationStates,
  length,
  type ParseResult,
  type RegenerationError,
  type RegenerationRun,
  regenerate,
} from "@slopcad/cad-core";

import { createFakeKernel } from "./fake-kernel";
import {
  BRIDGE_FEATURE_KINDS,
  createKernelFeatureExecutor,
  type KernelExecutionBridge,
} from "./core-bridge";
import { type GeometryKernel, type KernelSolid } from "./contract";
import {
  assertBoundsEqual,
  assertTessellationValid,
  assertVolumeClose,
  assertVolumeLessThan,
  unwrapKernelResult,
} from "./test-utils";

const pWidth = createParameterId("param_width");
const pDepth = createParameterId("param_depth");
const pHeight = createParameterId("param_height");
const pHoleRadius = createParameterId("param_hole_radius");
const pHoleX = createParameterId("param_hole_x");
const pHoleY = createParameterId("param_hole_y");
const pHoleZ = createParameterId("param_hole_z");

const bPlate = createBodyId("body_plate");
const bBore = createBodyId("body_bore");
const bBoreMoved = createBodyId("body_bore_moved");
const bResult = createBodyId("body_result");

const fPlate = createFeatureId("feat_plate");
const fBore = createFeatureId("feat_bore");
const fBoreMoved = createFeatureId("feat_bore_moved");
const fResult = createFeatureId("feat_result");

/**
 * Builds the plate-with-hole document: a box (width × depth × height) minus
 * a translated cylinder bore. `depth` is given in centimetres to prove unit
 * conversion through the bridge; the hole radius is parameterized for the
 * two-state scenario.
 */
function buildPlateDocument(holeRadiusMm: number): CadDocument {
  let document = createDocument(createDocumentId("doc_bridge_e2e"));
  const parameters: readonly (readonly [
    ReturnType<typeof createParameterId>,
    ReturnType<typeof length> | ReturnType<typeof angle>,
  ])[] = [
    [pWidth, length(30)],
    [pDepth, length(2, "cm")],
    [pHeight, length(10)],
    [pHoleRadius, length(holeRadiusMm)],
    [pHoleX, length(15)],
    [pHoleY, length(10)],
    [pHoleZ, length(0)],
  ];
  for (const [id, value] of parameters) {
    const added = addDocumentParameter(document, { id, name: id, value });
    if (!added.ok) throw new Error(added.error.message);
    document = added.value.document;
  }
  for (const body of [
    { id: bPlate, name: "plate" },
    { id: bBore, name: "bore" },
    { id: bBoreMoved, name: "bore-moved" },
    { id: bResult, name: "result" },
  ]) {
    const added = addBody(document, body);
    if (!added.ok) throw new Error(added.error.message);
    document = added.value.document;
  }
  const features: readonly FeatureRecordInput[] = [
    {
      id: fPlate,
      kind: "box",
      inputs: [
        { kind: "parameter", id: pWidth },
        { kind: "parameter", id: pDepth },
        { kind: "parameter", id: pHeight },
      ],
      outputs: [bPlate],
    },
    {
      id: fBore,
      kind: "cylinder",
      inputs: [
        { kind: "parameter", id: pHoleRadius },
        { kind: "parameter", id: pHeight },
      ],
      outputs: [bBore],
    },
    {
      id: fBoreMoved,
      kind: "translate",
      inputs: [
        { kind: "feature", id: fBore },
        { kind: "parameter", id: pHoleX },
        { kind: "parameter", id: pHoleY },
        { kind: "parameter", id: pHoleZ },
      ],
      outputs: [bBoreMoved],
    },
    {
      id: fResult,
      kind: "subtract",
      inputs: [
        { kind: "feature", id: fPlate },
        { kind: "feature", id: fBoreMoved },
      ],
      outputs: [bResult],
    },
  ];
  for (const feature of features) {
    const added = addFeature(document, feature);
    if (!added.ok) throw new Error(added.error.message);
    document = added.value.document;
  }
  return document;
}

interface BridgeRun {
  readonly kernel: GeometryKernel;
  readonly bridge: KernelExecutionBridge;
  readonly run: ParseResult<
    RegenerationRun,
    RegenerationError | FeatureGraphError
  >;
}

/** Unwraps a successful regeneration run (fixtures never fail orchestration). */
function runOf(scenario: BridgeRun): RegenerationRun {
  if (!scenario.run.ok) throw new Error(scenario.run.error.message);
  return scenario.run.value;
}

function runBridge(
  document: CadDocument,
  kernel: GeometryKernel = createFakeKernel(),
  bodies: ReadonlyMap<BodyId, KernelSolid> = new Map(),
): BridgeRun {
  const bridge = createKernelFeatureExecutor(kernel, { document, bodies });
  const run = regenerate({
    features: document.features,
    states: initialRegenerationStates(document.features),
    suppressed: [],
    execute: bridge.executor,
  });
  return { kernel, bridge, run };
}

describe("core bridge end-to-end: parameters → features → executor → fake kernel", () => {
  it("executes the full plate-with-hole graph in evaluation order", () => {
    const scenario = runBridge(buildPlateDocument(4));
    runOf(scenario);
    expect([...runOf(scenario).executed]).toEqual([
      fPlate,
      fBore,
      fBoreMoved,
      fResult,
    ]);
    for (const feature of [fPlate, fBore, fBoreMoved, fResult]) {
      expect(runOf(scenario).states.get(feature)).toEqual({
        state: "valid",
        diagnostics: [],
      });
    }
    const result = scenario.bridge.solidOf(bResult);
    expect(result).toBeDefined();
    if (result === undefined) return;
    const { kernel } = scenario;
    assertVolumeClose(
      unwrapKernelResult(kernel.volume(result), "result volume"),
      30 * 20 * 10 - Math.PI * 4 ** 2 * 10,
      0.02,
    );
    assertBoundsEqual(
      unwrapKernelResult(kernel.bounds(result), "result bounds"),
      { min: [0, 0, 0], max: [30, 20, 10] },
      1e-9,
    );
    assertTessellationValid(
      unwrapKernelResult(kernel.tessellate(result), "result tessellation"),
      { bounds: { min: [0, 0, 0], max: [30, 20, 10] } },
    );
  });

  it("re-executes with a changed parameter and produces the changed geometry", () => {
    const narrow = runBridge(buildPlateDocument(4));
    const wide = runBridge(buildPlateDocument(7));
    runOf(narrow);
    runOf(wide);
    const narrowSolid = narrow.bridge.solidOf(bResult);
    const wideSolid = wide.bridge.solidOf(bResult);
    if (narrowSolid === undefined || wideSolid === undefined) {
      throw new Error("both runs must produce the result solid");
    }
    const narrowVolume = unwrapKernelResult(
      narrow.kernel.volume(narrowSolid),
      "narrow volume",
    );
    const wideVolume = unwrapKernelResult(
      wide.kernel.volume(wideSolid),
      "wide volume",
    );
    assertVolumeClose(wideVolume, 30 * 20 * 10 - Math.PI * 7 ** 2 * 10, 0.02);
    assertVolumeLessThan(wideVolume, narrowVolume);
  });

  it("executes sphere, cone, union, and intersect features end-to-end", () => {
    const pRadius = createParameterId("param_radius");
    const pBottom = createParameterId("param_bottom");
    const pTop = createParameterId("param_top");
    const pConeHeight = createParameterId("param_cone_height");
    const bSphere = createBodyId("body_sphere");
    const bCone = createBodyId("body_cone");
    const bUnion = createBodyId("body_union");
    const bIntersection = createBodyId("body_intersection");
    const fSphere = createFeatureId("feat_sphere");
    const fCone = createFeatureId("feat_cone");
    const fUnion = createFeatureId("feat_union");
    const fIntersection = createFeatureId("feat_intersection");

    let document = createDocument(createDocumentId("doc_bridge_kinds"));
    for (const [id, value] of [
      [pRadius, length(10)],
      [pBottom, length(5)],
      [pTop, length(2)],
      [pConeHeight, length(12)],
    ] as const) {
      const added = addDocumentParameter(document, { id, name: id, value });
      if (!added.ok) throw new Error(added.error.message);
      document = added.value.document;
    }
    for (const body of [
      { id: bSphere, name: "sphere" },
      { id: bCone, name: "cone" },
      { id: bUnion, name: "union" },
      { id: bIntersection, name: "intersection" },
    ]) {
      const added = addBody(document, body);
      if (!added.ok) throw new Error(added.error.message);
      document = added.value.document;
    }
    for (const feature of [
      {
        id: fSphere,
        kind: "sphere",
        inputs: [{ kind: "parameter" as const, id: pRadius }],
        outputs: [bSphere],
      },
      {
        id: fCone,
        kind: "cone",
        inputs: [
          { kind: "parameter" as const, id: pBottom },
          { kind: "parameter" as const, id: pTop },
          { kind: "parameter" as const, id: pConeHeight },
        ],
        outputs: [bCone],
      },
      {
        id: fUnion,
        kind: "union",
        inputs: [
          { kind: "feature" as const, id: fSphere },
          { kind: "feature" as const, id: fCone },
        ],
        outputs: [bUnion],
      },
      {
        id: fIntersection,
        kind: "intersect",
        inputs: [
          { kind: "feature" as const, id: fSphere },
          { kind: "feature" as const, id: fCone },
        ],
        outputs: [bIntersection],
      },
    ] as const) {
      const added = addFeature(document, feature);
      if (!added.ok) throw new Error(added.error.message);
      document = added.value.document;
    }

    const scenario = runBridge(document);
    const run = runOf(scenario);
    expect(run.executed).toEqual([fSphere, fCone, fUnion, fIntersection]);
    for (const feature of [fSphere, fCone, fUnion, fIntersection]) {
      expect(run.states.get(feature)?.state).toBe("valid");
    }
    const { kernel, bridge } = scenario;
    const sphere = bridge.solidOf(bSphere);
    const cone = bridge.solidOf(bCone);
    const union = bridge.solidOf(bUnion);
    const intersection = bridge.solidOf(bIntersection);
    if (!sphere || !cone || !union || !intersection) {
      throw new Error("every feature must produce its output solid");
    }
    assertVolumeClose(
      unwrapKernelResult(kernel.volume(sphere), "sphere volume"),
      (4 / 3) * Math.PI * 10 ** 3,
      1e-12,
    );
    assertVolumeClose(
      unwrapKernelResult(kernel.volume(cone), "cone volume"),
      (Math.PI * 12 * (25 + 10 + 4)) / 3,
      1e-12,
    );
    const unionVolume = unwrapKernelResult(
      kernel.volume(union),
      "union volume",
    );
    const intersectionVolume = unwrapKernelResult(
      kernel.volume(intersection),
      "intersection volume",
    );
    assertVolumeLessThan(intersectionVolume, unionVolume);
    assertTessellationValid(
      unwrapKernelResult(kernel.tessellate(union), "union tessellation"),
    );
  });

  it("resolves body inputs through the prior-solids map", () => {
    const kernel = createFakeKernel();
    const imported = unwrapKernelResult(
      kernel.createBox({
        width: length(10),
        depth: length(10),
        height: length(10),
      }),
      "createBox",
    );
    let document = createDocument(createDocumentId("doc_bridge_bodies"));
    for (const body of [
      { id: bPlate, name: "imported" },
      { id: bResult, name: "result" },
    ]) {
      const added = addBody(document, body);
      if (!added.ok) throw new Error(added.error.message);
      document = added.value.document;
    }
    const difference = createFeatureId("feat_difference");
    const added = addFeature(document, {
      id: difference,
      kind: "subtract",
      inputs: [
        { kind: "body", id: bPlate },
        { kind: "body", id: bPlate },
      ],
      outputs: [bResult],
    });
    if (!added.ok) throw new Error(added.error.message);
    document = added.value.document;
    const scenario = runBridge(document, kernel, new Map([[bPlate, imported]]));
    runOf(scenario);
    expect(runOf(scenario).states.get(difference)?.state).toBe("valid");
    const result = scenario.bridge.solidOf(bResult);
    if (result === undefined)
      throw new Error("the difference must produce a solid");
    assertVolumeClose(
      unwrapKernelResult(kernel.volume(result), "self-cut volume"),
      0,
      1e-9,
    );
  });
});

describe("core bridge failure paths", () => {
  function singleFeatureRun(feature: FeatureRecordInput): BridgeRun {
    let document = createDocument(createDocumentId("doc_bridge_failure"));
    const parameter = addDocumentParameter(document, {
      id: pWidth,
      name: pWidth,
      value: length(10),
    });
    if (!parameter.ok) throw new Error(parameter.error.message);
    document = parameter.value.document;
    const body = addBody(document, { id: bResult, name: "result" });
    if (!body.ok) throw new Error(body.error.message);
    document = body.value.document;
    const added = addFeature(document, feature);
    if (!added.ok) throw new Error(added.error.message);
    document = added.value.document;
    return runBridge(document);
  }

  function failureOf(scenario: BridgeRun, feature: FeatureId): Diagnostic {
    runOf(scenario);
    const status = runOf(scenario).states.get(feature);
    expect(status?.state).toBe("failed");
    const diagnostic = status?.diagnostics[0];
    if (diagnostic === undefined)
      throw new Error("a failure carries diagnostics");
    return diagnostic;
  }

  it("fails an unknown feature kind with kernel/unknown-feature-kind", () => {
    const loft = createFeatureId("feat_loft");
    const diagnostic = failureOf(
      singleFeatureRun({
        id: loft,
        kind: "loft",
        inputs: [],
        outputs: [bResult],
      }),
      loft,
    );
    expect(diagnostic.code).toBe(DIAGNOSTIC_CODES.kernelUnknownFeatureKind);
    expect(diagnostic.location.primary).toBe(loft);
  });

  it("fails a box whose width parameter is an angle with kernel/parameter-invalid", () => {
    const tilt = createParameterId("param_tilt");
    let document = createDocument(createDocumentId("doc_bridge_angle"));
    const parameter = addDocumentParameter(document, {
      id: tilt,
      name: tilt,
      value: angle(45, "deg"),
    });
    if (!parameter.ok) throw new Error(parameter.error.message);
    document = parameter.value.document;
    const body = addBody(document, { id: bResult, name: "result" });
    if (!body.ok) throw new Error(body.error.message);
    document = body.value.document;
    const boxFeature = createFeatureId("feat_box");
    const added = addFeature(document, {
      id: boxFeature,
      kind: "box",
      inputs: [
        { kind: "parameter", id: tilt },
        { kind: "parameter", id: tilt },
        { kind: "parameter", id: tilt },
      ],
      outputs: [bResult],
    });
    if (!added.ok) throw new Error(added.error.message);
    document = added.value.document;
    const diagnostic = failureOf(runBridge(document), boxFeature);
    expect(diagnostic.code).toBe(DIAGNOSTIC_CODES.kernelParameterInvalid);
    expect(diagnostic.message).toContain("to be a length");
  });

  it("fails a subtract whose body input has no supplied solid with kernel/feature-input-invalid", () => {
    const cutter = createFeatureId("feat_cutter");
    const diagnostic = failureOf(
      singleFeatureRun({
        id: cutter,
        kind: "subtract",
        inputs: [
          { kind: "body", id: bResult },
          { kind: "body", id: bResult },
        ],
        outputs: [bResult],
      }),
      cutter,
    );
    expect(diagnostic.code).toBe(DIAGNOSTIC_CODES.kernelFeatureInputInvalid);
  });

  it("fails when the kernel operation itself rejects input, gating downstream stale", () => {
    const scenario = runBridge(buildPlateDocument(0));
    runOf(scenario);
    const diagnostic = failureOf(scenario, fBore);
    expect(diagnostic.code).toBe(DIAGNOSTIC_CODES.kernelOperationFailed);
    expect(diagnostic.data?.kernelErrorCode).toBe("kernel/invalid-length");
    expect(runOf(scenario).states.get(fResult)?.state).toBe("stale");
    expect(runOf(scenario).states.get(fBoreMoved)?.state).toBe("stale");
    expect(runOf(scenario).executed).toEqual([fPlate, fBore]);
    expect(scenario.bridge.solidOf(bResult)).toBeUndefined();
  });
});

describe("bridge feature kinds", () => {
  it("lists exactly the kinds the bridge interprets", () => {
    expect([...BRIDGE_FEATURE_KINDS]).toEqual([
      "box",
      "sphere",
      "cylinder",
      "cone",
      "union",
      "subtract",
      "intersect",
      "translate",
    ]);
  });
});
