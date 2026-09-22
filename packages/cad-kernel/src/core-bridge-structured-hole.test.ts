/**
 * The structured hole form's bridge tests (Phase 42): the type-directed
 * parameter schema → the bridge's `hole` kind (structured dispatch) → the
 * fake kernel, whose revolve is Pappus-exact over straight meridians — so
 * every hole type's removed volume pins against the ANALYTIC expectation
 * re-derived here (cylinders, cones, frustums; the threaded ridge against
 * Phase 40's exact screw volume), the validator-re-derives discipline.
 *
 * The failure taxonomy pins: the type selector's domain, the role-count
 * layout refusal, the empty positions sketch, the tip/entry-feature fit
 * verdicts, the threaded capability gate (a helix-less kernel declines
 * BEFORE any geometry), and the composed cut's post-condition — a cut that
 * removed nothing refuses with `hole/no-op` (the flat form's contract,
 * unchanged).
 */

import { describe, expect, it } from "vitest";
import {
  addBody,
  addDocumentParameter,
  addDocumentDatum,
  addDocumentSketch,
  addFeature,
  angle,
  type AnyDimensionalValue,
  type CadDocument,
  createBodyId,
  createDatumId,
  createDocument,
  createDocumentId,
  createFeatureId,
  createParameterId,
  createSketchDocumentId,
  dimensionless,
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
  type KernelSketchPointsResolver,
} from "./core-bridge";
import { type GeometryKernel, type KernelSolid } from "./contract";
import {
  structuredHoleRoles,
  structuredHoleTypeOf,
  type StructuredHoleSpec,
  HOLE_TYPE_VALUES,
} from "./hole-specification";
import { helixProfilePolygon, helixScrewVolume } from "./helix-geometry";
import {
  isoThreadMinorDiameter,
  isoThreadToolLoop,
  threadHelixSpine,
} from "./thread-profile";
import { assertVolumeClose, unwrapKernelResult } from "./test-utils";

/** The fixture target box's extents (mm) — the flat hole test's precedent. */
const BOX = { w: 30, d: 20, h: 10 } as const;
const BOX_VOLUME = BOX.w * BOX.d * BOX.h;

/** Relative band for the fake kernel's boolean (voxel) volumes. */
const FAKE_BOOLEAN_BAND = 0.02;

const pBoxWidth = createParameterId("param_shole_box_w");
const pBoxDepth = createParameterId("param_shole_box_d");
const pBoxHeight = createParameterId("param_shole_box_h");

const bBox = createBodyId("body_shole_box");
const bHole = createBodyId("body_shole_result");
const fBox = createFeatureId("feat_shole_box");
const fHole = createFeatureId("feat_shole");

const skPositions = createSketchDocumentId("skd_shole_positions");

/** The structured spec with every field set (overrides per case). */
const BASE_SPEC: StructuredHoleSpec = {
  type: HOLE_TYPE_VALUES.straight,
  diameterMm: 8,
  depthMm: 6,
  tipAngleDeg: 180,
  cboreDiameterMm: 14,
  cboreDepthMm: 3,
  csinkDiameterMm: 14,
  csinkAngleDeg: 90,
  taperAngleDeg: 30,
  threadMajorMm: 6,
  threadPitchMm: 1,
};

/** One authoring value of a role, as the parameter record carries it. */
function roleValue(
  spec: StructuredHoleSpec,
  role: string,
  position: { readonly x: number; readonly y: number },
  axis: number,
): AnyDimensionalValue {
  switch (role) {
    case "type":
      return dimensionless(spec.type);
    case "diameter":
      return length(spec.diameterMm);
    case "depth":
      return length(spec.depthMm);
    case "tipAngle":
      return angle(spec.tipAngleDeg, "deg");
    case "cboreDiameter":
      return length(spec.cboreDiameterMm);
    case "cboreDepth":
      return length(spec.cboreDepthMm);
    case "csinkDiameter":
      return length(spec.csinkDiameterMm);
    case "csinkAngle":
      return angle(spec.csinkAngleDeg, "deg");
    case "taperAngle":
      return angle(spec.taperAngleDeg, "deg");
    case "threadMajor":
      return length(spec.threadMajorMm);
    case "threadPitch":
      return length(spec.threadPitchMm);
    case "positionX":
      return length(position.x);
    case "positionY":
      return length(position.y);
    case "axis":
      return dimensionless(axis);
    default:
      throw new Error(`unknown role ${role}`);
  }
}

/**
 * Builds the box → structured hole document: the type's parameter list in
 * the schema's declared order, optionally positioned by a sketch (its
 * declared input present) instead of the positionX/positionY pair.
 */
function buildStructuredHoleDocument(
  spec: StructuredHoleSpec,
  options: {
    readonly position?: { readonly x: number; readonly y: number };
    readonly axis?: number;
    readonly sketchPositions?: boolean;
    readonly valueOverrides?: Record<string, AnyDimensionalValue>;
  } = {},
): CadDocument {
  const position = options.position ?? { x: BOX.w / 2, y: BOX.d / 2 };
  const axis = options.axis ?? 3;
  const type = structuredHoleTypeOf(spec.type);
  if (type === null) throw new Error("the fixture spec's type must be 1–5");
  const roles = structuredHoleRoles(type, {
    sketchPositions: options.sketchPositions === true,
  });
  const roleIds = roles.map((role) =>
    createParameterId(`param_shole_${role.name}`),
  );
  let document = createDocument(createDocumentId("doc_bridge_shole"));
  if (options.sketchPositions) {
    const sketched = addDocumentSketch(document, {
      id: skPositions,
      name: "hole positions",
      sketch: { formatVersion: 1 },
    });
    if (!sketched.ok) throw new Error(sketched.error.message);
    document = sketched.value.document;
  }
  const boxParameters: readonly [
    ReturnType<typeof createParameterId>,
    string,
    AnyDimensionalValue,
  ][] = [
    [pBoxWidth, "boxWidth", length(BOX.w)],
    [pBoxDepth, "boxDepth", length(BOX.d)],
    [pBoxHeight, "boxHeight", length(BOX.h)],
  ];
  for (const [id, name, value] of boxParameters) {
    const added = addDocumentParameter(document, { id, name, value });
    if (!added.ok) throw new Error(added.error.message);
    document = added.value.document;
  }
  for (let index = 0; index < roles.length; index += 1) {
    const role = roles[index];
    const id = roleIds[index];
    if (role === undefined || id === undefined) continue;
    const value =
      options.valueOverrides?.[role.name] ??
      roleValue(spec, role.name, position, axis);
    const added = addDocumentParameter(document, {
      id,
      name: role.name,
      value,
    });
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
  const holeInputs: FeatureRecordInput["inputs"] = [
    { kind: "feature", id: fBox },
    ...roleIds.map((id) => ({ kind: "parameter" as const, id })),
    ...(options.sketchPositions
      ? [{ kind: "sketch" as const, id: skPositions }]
      : []),
  ];
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
      inputs: holeInputs,
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

interface BridgeRun {
  readonly kernel: GeometryKernel;
  readonly bridge: KernelExecutionBridge;
  readonly run: ReturnType<typeof regenerate>;
}

/** The sketch-points stub: the seam's contract, fixed points per call. */
function pointsResolverOf(
  points: readonly { readonly x: number; readonly y: number }[],
): KernelSketchPointsResolver {
  return () => ({ ok: true, value: { points } });
}

function runBridge(
  document: CadDocument,
  kernel: GeometryKernel = createFakeKernel(),
  points?: KernelSketchPointsResolver,
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
    ...(points === undefined ? {} : { points }),
  });
  const run = regenerate({
    features: document.features,
    states: initialRegenerationStates(document.features),
    suppressed: [],
    execute: bridge.executor,
  });
  return { kernel, bridge, run };
}

/** The first diagnostic message of a failed feature, if any. */
function firstDiagnostic(
  run: BridgeRun["run"],
  id: FeatureId,
): string | undefined {
  if (!run.ok) throw new Error(run.error.message);
  const status = run.value.states.get(id);
  return status?.state === "failed"
    ? status.diagnostics?.[0]?.message
    : undefined;
}

/** The failed feature's first diagnostic record (for data pins). */
function failureOf(
  run: BridgeRun["run"],
  id: FeatureId,
): Diagnostic | undefined {
  if (!run.ok) throw new Error(run.error.message);
  const status = run.value.states.get(id);
  return status?.state === "failed" ? status.diagnostics?.[0] : undefined;
}

/** The hole result solid of a successful run (throws when absent). */
function holeSolidOf(scenario: BridgeRun): KernelSolid {
  const solid = scenario.bridge.solidOf(bHole);
  if (solid === undefined) throw new Error("the hole body has no solid");
  return solid;
}

/** The analytic tip height of an included angle over a radius (mm). */
function tipHeight(radiusMm: number, tipAngleDeg: number): number {
  if (tipAngleDeg >= 180) return 0;
  return radiusMm / Math.tan(((tipAngleDeg / 2) * Math.PI) / 180);
}

/**
 * The RE-DERIVED analytic removed volume (mm³) of one structured hole
 * position in deep stock — the validator's independent arithmetic, not the
 * package's own helper.
 */
function removedVolumeMm3(spec: StructuredHoleSpec): number {
  const rad = (deg: number) => (deg * Math.PI) / 180;
  if (structuredHoleTypeOf(spec.type) === "taper") {
    const r0 = spec.diameterMm / 2;
    const slope = Math.tan(rad(spec.taperAngleDeg / 2));
    const depthEff = Math.min(spec.depthMm, r0 / slope);
    const r1 = r0 - depthEff * slope;
    return (Math.PI * depthEff * (r1 * r1 + r1 * r0 + r0 * r0)) / 3;
  }
  const pilot =
    structuredHoleTypeOf(spec.type) === "threaded"
      ? isoThreadMinorDiameter(spec.threadMajorMm, spec.threadPitchMm) / 2
      : spec.diameterMm / 2;
  const h = tipHeight(pilot, spec.tipAngleDeg);
  let removed =
    Math.PI * pilot * pilot * (spec.depthMm - h) +
    (Math.PI * pilot * pilot * h) / 3;
  if (structuredHoleTypeOf(spec.type) === "counterbore") {
    const R = spec.cboreDiameterMm / 2;
    removed += Math.PI * (R * R - pilot * pilot) * spec.cboreDepthMm;
  }
  if (structuredHoleTypeOf(spec.type) === "countersink") {
    const R = spec.csinkDiameterMm / 2;
    const hCs = (R - pilot) / Math.tan(rad(spec.csinkAngleDeg / 2));
    removed +=
      (Math.PI * hCs * (pilot * pilot + pilot * R + R * R)) / 3 -
      Math.PI * pilot * pilot * hCs;
  }
  if (structuredHoleTypeOf(spec.type) === "threaded") {
    removed += helixScrewVolume(
      helixProfilePolygon(
        isoThreadToolLoop({ pitchMm: spec.threadPitchMm, mode: "internal" }),
      ),
      threadHelixSpine({
        majorDiameterMm: spec.threadMajorMm,
        pitchMm: spec.threadPitchMm,
        lengthMm: spec.depthMm - h,
        handedness: 1,
        startAngleRad: 0,
      }),
    );
  }
  return removed;
}

describe("core bridge structured hole (Phase 42)", () => {
  it("executes the blind straight hole with a 118° tip at the analytic volume", () => {
    const spec = { ...BASE_SPEC, tipAngleDeg: 118 };
    const scenario = runBridge(buildStructuredHoleDocument(spec));
    if (!scenario.run.ok) throw new Error(scenario.run.error.message);
    expect(scenario.run.value.states.get(fHole)?.state).toBe("valid");
    const volume = unwrapKernelResult(
      scenario.kernel.volume(holeSolidOf(scenario)),
      "structured straight volume",
    );
    assertVolumeClose(
      volume,
      BOX_VOLUME - removedVolumeMm3(spec),
      FAKE_BOOLEAN_BAND,
    );
  });

  it("executes the through straight hole at the analytic through volume", () => {
    // Depth 10 on the 10 mm box: through; the flat tip's overshoot removes
    // nothing past the far face — the removed volume is the full cylinder.
    const spec = { ...BASE_SPEC, depthMm: 10 };
    const scenario = runBridge(buildStructuredHoleDocument(spec));
    if (!scenario.run.ok) throw new Error(scenario.run.error.message);
    const volume = unwrapKernelResult(
      scenario.kernel.volume(holeSolidOf(scenario)),
      "structured through volume",
    );
    assertVolumeClose(
      volume,
      BOX_VOLUME - Math.PI * 4 * 4 * BOX.h,
      FAKE_BOOLEAN_BAND,
    );
  });

  it("executes the counterbore at the analytic cylinder + annulus volume", () => {
    const spec = { ...BASE_SPEC, type: HOLE_TYPE_VALUES.counterbore };
    const scenario = runBridge(buildStructuredHoleDocument(spec));
    if (!scenario.run.ok) throw new Error(scenario.run.error.message);
    const volume = unwrapKernelResult(
      scenario.kernel.volume(holeSolidOf(scenario)),
      "counterbore volume",
    );
    assertVolumeClose(
      volume,
      BOX_VOLUME - removedVolumeMm3(spec),
      FAKE_BOOLEAN_BAND,
    );
  });

  it("executes the countersink at the analytic frustum volume", () => {
    const spec = { ...BASE_SPEC, type: HOLE_TYPE_VALUES.countersink };
    const scenario = runBridge(buildStructuredHoleDocument(spec));
    if (!scenario.run.ok) throw new Error(scenario.run.error.message);
    const volume = unwrapKernelResult(
      scenario.kernel.volume(holeSolidOf(scenario)),
      "countersink volume",
    );
    assertVolumeClose(
      volume,
      BOX_VOLUME - removedVolumeMm3(spec),
      FAKE_BOOLEAN_BAND,
    );
  });

  it("executes the truncated taper at the analytic frustum volume", () => {
    const spec = { ...BASE_SPEC, type: HOLE_TYPE_VALUES.taper };
    const scenario = runBridge(buildStructuredHoleDocument(spec));
    if (!scenario.run.ok) throw new Error(scenario.run.error.message);
    const volume = unwrapKernelResult(
      scenario.kernel.volume(holeSolidOf(scenario)),
      "taper volume",
    );
    assertVolumeClose(
      volume,
      BOX_VOLUME - removedVolumeMm3(spec),
      FAKE_BOOLEAN_BAND,
    );
  });

  it("executes the closing taper at the full-cone volume", () => {
    // Ø8 at 90° closes at 4 mm — a cone of volume ⅓·π·16·4.
    const spec = {
      ...BASE_SPEC,
      type: HOLE_TYPE_VALUES.taper,
      taperAngleDeg: 90,
    };
    const scenario = runBridge(buildStructuredHoleDocument(spec));
    if (!scenario.run.ok) throw new Error(scenario.run.error.message);
    const volume = unwrapKernelResult(
      scenario.kernel.volume(holeSolidOf(scenario)),
      "closing taper volume",
    );
    assertVolumeClose(
      volume,
      BOX_VOLUME - (Math.PI * 16 * 4) / 3,
      FAKE_BOOLEAN_BAND,
    );
  });

  it("executes the threaded hole at the pilot + ISO ridge volume", () => {
    const spec = { ...BASE_SPEC, type: HOLE_TYPE_VALUES.threaded };
    const scenario = runBridge(buildStructuredHoleDocument(spec));
    if (!scenario.run.ok) throw new Error(scenario.run.error.message);
    const volume = unwrapKernelResult(
      scenario.kernel.volume(holeSolidOf(scenario)),
      "threaded hole volume",
    );
    assertVolumeClose(
      volume,
      BOX_VOLUME - removedVolumeMm3(spec),
      FAKE_BOOLEAN_BAND,
    );
  });

  it("cuts every sketch-point position of ONE feature (one feature, many holes)", () => {
    const spec = { ...BASE_SPEC, diameterMm: 4 };
    const document = buildStructuredHoleDocument(spec, {
      sketchPositions: true,
    });
    const scenario = runBridge(
      document,
      createFakeKernel(),
      pointsResolverOf([
        { x: BOX.w / 4, y: BOX.d / 2 },
        { x: (3 * BOX.w) / 4, y: BOX.d / 2 },
      ]),
    );
    if (!scenario.run.ok) throw new Error(scenario.run.error.message);
    expect(scenario.run.value.states.get(fHole)?.state).toBe("valid");
    const volume = unwrapKernelResult(
      scenario.kernel.volume(holeSolidOf(scenario)),
      "two-position hole volume",
    );
    assertVolumeClose(
      volume,
      BOX_VOLUME - 2 * removedVolumeMm3(spec),
      FAKE_BOOLEAN_BAND,
    );
  });

  it("drills along a datum axis (the datum-axis structured form)", () => {
    // A +z datum axis; the datum form drops the axis selector parameter and
    // the positions ride the ROTATED frame's local axes. rotationAligningYTo
    // (+z) = +π/2 about x: local x → world x, local z → world −y — so the
    // rotated-frame position (8, −5) is the world-Z form's (8, 5), and the
    // volumes agree exactly.
    const spec = { ...BASE_SPEC };
    const type = structuredHoleTypeOf(spec.type);
    if (type === null) throw new Error("fixture type");
    const roles = structuredHoleRoles(type, { datumAxis: true });
    const roleIds = roles.map((role) =>
      createParameterId(`param_shole_d_${role.name}`),
    );
    const datumId = createDatumId("dtm_shole_z");
    let document = createDocument(createDocumentId("doc_bridge_shole_datum"));
    const added0 = addDocumentDatum(document, {
      id: datumId,
      name: "hole axis",
      datum: {
        formatVersion: 1,
        datumType: "axis",
        definition: "twoPoints",
        first: [0, 0, 0],
        second: [0, 0, 5],
      },
    });
    if (!added0.ok) throw new Error(added0.error.message);
    document = added0.value.document;
    for (const [id, name, value] of [
      [pBoxWidth, "boxWidth", length(BOX.w)],
      [pBoxDepth, "boxDepth", length(BOX.d)],
      [pBoxHeight, "boxHeight", length(BOX.h)],
    ] as const) {
      const added = addDocumentParameter(document, { id, name, value });
      if (!added.ok) throw new Error(added.error.message);
      document = added.value.document;
    }
    for (let index = 0; index < roles.length; index += 1) {
      const role = roles[index];
      const id = roleIds[index];
      if (role === undefined || id === undefined) continue;
      const value = roleValue(spec, role.name, { x: 8, y: -5 }, 3);
      const added = addDocumentParameter(document, {
        id,
        name: role.name,
        value,
      });
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
          ...roleIds.map((id) => ({ kind: "parameter" as const, id })),
          { kind: "datum", id: datumId },
        ],
        outputs: [bHole],
      },
    ];
    for (const feature of features) {
      const added = addFeature(document, feature);
      if (!added.ok) throw new Error(added.error.message);
      document = added.value.document;
    }
    const scenario = runBridge(document);
    if (!scenario.run.ok) throw new Error(scenario.run.error.message);
    expect(scenario.run.value.states.get(fHole)?.state).toBe("valid");
    const volume = unwrapKernelResult(
      scenario.kernel.volume(holeSolidOf(scenario)),
      "datum-axis structured volume",
    );
    assertVolumeClose(
      volume,
      BOX_VOLUME - removedVolumeMm3(spec),
      FAKE_BOOLEAN_BAND,
    );
  });

  it("refuses the composed cut that removed nothing (the unchanged contract)", () => {
    const scenario = runBridge(
      buildStructuredHoleDocument(BASE_SPEC, { position: { x: 100, y: 100 } }),
    );
    expect(scenario.run.ok).toBe(true);
    if (!scenario.run.ok) return;
    expect(scenario.run.value.states.get(fHole)?.state).toBe("failed");
    const diagnostic = failureOf(scenario.run, fHole);
    expect(diagnostic?.message).toContain("removed no material");
    expect(diagnostic?.data).toMatchObject({ reason: "hole/no-op" });
  });

  it("refuses the type selector outside 1–5 with the parameter code", () => {
    const scenario = runBridge(
      buildStructuredHoleDocument(BASE_SPEC, {
        valueOverrides: { type: dimensionless(9) },
      }),
    );
    expect(firstDiagnostic(scenario.run, fHole)).toContain(
      "1 = straight, 2 = counterbore, 3 = countersink, 4 = taper, 5 = threaded",
    );
  });

  it("refuses a parameter list that does not match the type's roles", () => {
    // A straight hole missing the tip angle: six parameters where the
    // schema demands seven.
    const full = buildStructuredHoleDocument(BASE_SPEC);
    const holeFeature = full.features.find((feature) => feature.id === fHole);
    if (holeFeature === undefined) throw new Error("the fixture feature");
    const dropped = {
      ...full,
      features: full.features.map((feature) =>
        feature.id === fHole
          ? {
              ...feature,
              inputs: feature.inputs.filter(
                (ref, index) => !(index === 4 && ref.kind === "parameter"),
              ),
            }
          : feature,
      ),
    };
    const scenario = runBridge(dropped);
    expect(firstDiagnostic(scenario.run, fHole)).toContain(
      "parameter inputs in declared order (type, diameter, depth, tipAngle, positionX, positionY, axis)",
    );
  });

  it("refuses the positions sketch with no points, and the missing seam", () => {
    const document = buildStructuredHoleDocument(BASE_SPEC, {
      sketchPositions: true,
    });
    const empty = runBridge(document, createFakeKernel(), pointsResolverOf([]));
    expect(firstDiagnostic(empty.run, fHole)).toContain("no positions");
    // A context with NO points resolver at all names the missing seam.
    const seamless = runBridge(document);
    expect(firstDiagnostic(seamless.run, fHole)).toContain(
      "no sketch-points resolver",
    );
  });

  it("refuses the tip that cannot fit the authored depth", () => {
    const scenario = runBridge(
      buildStructuredHoleDocument({
        ...BASE_SPEC,
        tipAngleDeg: 30,
      }),
    );
    expect(firstDiagnostic(scenario.run, fHole)).toContain(
      "still cut a straight section",
    );
  });

  it("declines the threaded hole on a kernel without the helix capability, before geometry", () => {
    const kernel = createFakeKernel();
    const declined: GeometryKernel = {
      ...kernel,
      capabilities: { ...kernel.capabilities, helix: false },
    };
    const scenario = runBridge(
      buildStructuredHoleDocument({
        ...BASE_SPEC,
        type: HOLE_TYPE_VALUES.threaded,
      }),
      declined,
    );
    expect(scenario.run.ok).toBe(true);
    if (!scenario.run.ok) return;
    expect(scenario.run.value.states.get(fHole)?.state).toBe("failed");
    expect(firstDiagnostic(scenario.run, fHole)).toContain(
      "does not declare the helix capability",
    );
  });
});
