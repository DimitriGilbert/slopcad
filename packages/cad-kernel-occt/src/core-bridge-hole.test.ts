/**
 * The hole feature's bridge tests on a REAL kernel (Phase 26.10's semantic
 * close of the loop, the mirror file's twin): the cad-kernel suite pins the
 * hole feature's execution and failure taxonomy on the fake kernel; these
 * tests execute the same bridge kind against the OpenCascade kernel, whose
 * exact BREP cylinder subtraction makes the parameter semantics — and the
 * plan's validation, `parameter.set` regenerating the geometry — measurable
 * at full precision (exact analytic volumes, exact bounds).
 *
 * Fixture: a 30×20×10 box with the hole on its +z face (axis 3) and, for
 * the axis selector, through the +x face (axis 1).
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

/** The fixture target box's extents (mm). */
const BOX = { w: 30, d: 20, h: 10 } as const;
const BOX_VOLUME = BOX.w * BOX.d * BOX.h;

const pBoxWidth = createParameterId("param_occt_hole_box_w");
const pBoxDepth = createParameterId("param_occt_hole_box_d");
const pBoxHeight = createParameterId("param_occt_hole_box_h");
const pDiameter = createParameterId("param_occt_hole_diameter");
const pDepth = createParameterId("param_occt_hole_depth");
const pX = createParameterId("param_occt_hole_x");
const pY = createParameterId("param_occt_hole_y");
const pAxis = createParameterId("param_occt_hole_axis");

const bBox = createBodyId("body_occt_hole_box");
const bHole = createBodyId("body_occt_hole_result");
const fBox = createFeatureId("feat_occt_hole_box");
const fHole = createFeatureId("feat_occt_hole");

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
  let document = createDocument(createDocumentId("doc_occt_bridge_hole"));
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

/** Regenerates a hole document against a fresh OCCT kernel. */
function runHole(document: CadDocument) {
  const kernel = occtKernelFromRuntime(runtime);
  const bridge = createKernelFeatureExecutor(kernel, {
    document,
    bodies: new Map(),
    profiles: () => ({
      ok: false,
      error: {
        code: "document/not-found",
        message: "holes resolve no sketches",
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
  const solid = bridge.solidOf(bHole);
  expect(solid).toBeDefined();
  if (solid === undefined) throw new Error("The hole body has no solid.");
  return { kernel, solid, run: run.value };
}

/** The analytic blind-hole volume: box − π·r²·depth. */
function blindVolume(diameterMm: number, depthMm: number): number {
  return BOX_VOLUME - Math.PI * (diameterMm / 2) ** 2 * depthMm;
}

/** The analytic through-hole volume: box − π·r²·thickness. */
function throughVolume(diameterMm: number): number {
  return BOX_VOLUME - Math.PI * (diameterMm / 2) ** 2 * BOX.h;
}

describe("bridge hole on the OpenCascade kernel (real BREP subtraction)", () => {
  it("executes the blind hole end-to-end: exact analytic volume, bounds untouched", () => {
    const { kernel, solid, run } = runHole(buildHoleDocument());
    expect(run.executed).toEqual([fBox, fHole]);
    assertVolumeClose(
      unwrapKernelResult(kernel.volume(solid), "hole volume"),
      blindVolume(8, 4),
      EXACT_VOLUME_TOLERANCE,
    );
    assertBoundsEqual(
      unwrapKernelResult(kernel.bounds(solid), "hole bounds"),
      { min: [0, 0, 0], max: [BOX.w, BOX.d, BOX.h] },
      EXACT_BOUNDS_TOLERANCE,
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
    const { kernel, solid } = runHole(set.value);
    assertVolumeClose(
      unwrapKernelResult(kernel.volume(solid), "hole volume"),
      blindVolume(12, 4),
      EXACT_VOLUME_TOLERANCE,
    );
  });

  it("regenerates from parameter.set on the depth: blind → THROUGH at extent", () => {
    const document = buildHoleDocument();
    const set = applyCommand(document, {
      type: "parameter.set",
      id: pDepth,
      value: length(BOX.h),
    });
    if (!set.ok) throw new Error(set.error.message);
    const { kernel, solid } = runHole(set.value);
    assertVolumeClose(
      unwrapKernelResult(kernel.volume(solid), "hole volume"),
      throughVolume(8),
      EXACT_VOLUME_TOLERANCE,
    );
  });

  it("regenerates from parameter.set on the position: the hole exits a side face", () => {
    // Ø12 at x = 28, blind depth 4: the removed area is the full disk minus
    // the circular segment beyond the +x face — r²·acos(d/r) − d·√(r²−d²)
    // with the center 2 mm inside the face.
    const document = buildHoleDocument({ diameterMm: 12 });
    const set = applyCommand(document, {
      type: "parameter.set",
      id: pX,
      value: length(BOX.w - 2),
    });
    if (!set.ok) throw new Error(set.error.message);
    const { kernel, solid } = runHole(set.value);
    const radius = 6;
    const inFace = 2;
    const segmentArea =
      radius * radius * Math.acos(inFace / radius) -
      inFace * Math.sqrt(radius * radius - inFace * inFace);
    const removedArea = Math.PI * radius * radius - segmentArea;
    assertVolumeClose(
      unwrapKernelResult(kernel.volume(solid), "hole volume"),
      BOX_VOLUME - removedArea * HOLE_DEFAULTS.depthMm,
      EXACT_VOLUME_TOLERANCE,
    );
  });

  it("regenerates from parameter.set on the axis selector: 3 (Z) → 1 (X)", () => {
    // Through-z removes π·16·10; through-x removes π·16·30 — the selector
    // changed which face the hole enters.
    const document = buildHoleDocument({ depthMm: 35, xMm: 10, yMm: 5 });
    const set = applyCommand(document, {
      type: "parameter.set",
      id: pAxis,
      value: dimensionless(1),
    });
    if (!set.ok) throw new Error(set.error.message);
    const { kernel, solid } = runHole(set.value);
    assertVolumeClose(
      unwrapKernelResult(kernel.volume(solid), "hole volume"),
      BOX_VOLUME - Math.PI * 4 ** 2 * BOX.w,
      EXACT_VOLUME_TOLERANCE,
    );
  });

  it("refuses the silent no-op: a hole missing the target removes nothing", () => {
    const document = buildHoleDocument({ xMm: 100 });
    const kernel = occtKernelFromRuntime(runtime);
    const bridge = createKernelFeatureExecutor(kernel, {
      document,
      bodies: new Map(),
      profiles: () => ({
        ok: false,
        error: {
          code: "document/not-found",
          message: "holes resolve no sketches",
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
    const status = run.value.states.get(fHole);
    expect(status?.state).toBe("failed");
    const diagnostic = status?.diagnostics[0];
    expect(diagnostic?.code).toBe("kernel/operation-failed");
    expect(diagnostic?.message).toContain("removed no material");
    expect(bridge.solidOf(bHole)).toBeUndefined();
  });
});
