/**
 * The structured hole feature's bridge tests on a REAL kernel (Phase 42,
 * the flat hole file's twin): the cad-kernel suite pins the structured
 * form's execution and failure taxonomy on the fake kernel; these tests
 * execute the same bridge kind against the OpenCascade kernel, whose exact
 * BREP revolves (analytic cylinders/cones) and boolean subtraction make
 * every hole type's parameter semantics measurable at FULL precision —
 * the ANALYTIC pins the validator re-derives (cylinders + cones +
 * frustums; the threaded ridge against Phase 40's exact screw volume).
 *
 * Fixture: a 30×20×10 box, holes on its +z face. Every expectation is
 * re-derived inline (the validator-re-derives discipline — no call into
 * the planner's own helpers).
 */

import { beforeAll, describe, it } from "vitest";
import {
  addBody,
  addDocumentParameter,
  addDocumentSketch,
  addFeature,
  angle,
  type AnyDimensionalValue,
  type CadDocument,
  createBodyId,
  createDocument,
  createDocumentId,
  createFeatureId,
  createParameterId,
  createSketchDocumentId,
  dimensionless,
  type FeatureRecordInput,
  initialRegenerationStates,
  length,
  regenerate,
} from "@slopcad/cad-core";
import {
  assertVolumeClose,
  createKernelFeatureExecutor,
  unwrapKernelResult,
} from "@slopcad/cad-kernel";
import { EXACT_VOLUME_TOLERANCE } from "@slopcad/cad-kernel/contract-suite";
import {
  structuredHoleRoles,
  structuredHoleTypeOf,
  type StructuredHoleSpec,
} from "@slopcad/cad-kernel";
import { helixProfilePolygon, helixScrewVolume } from "@slopcad/cad-kernel";
import {
  isoThreadMinorDiameter,
  isoThreadToolLoop,
  threadHelixSpine,
} from "@slopcad/cad-kernel";

import { occtKernelFromRuntime, type OcctKernel } from "./occt-kernel";
import { createOcctRuntime, type OcctRuntime } from "./occt-runtime";

let runtime: OcctRuntime;

beforeAll(async () => {
  runtime = await createOcctRuntime();
});

/** The fixture target box's extents (mm). */
const BOX = { w: 30, d: 20, h: 10 } as const;
const BOX_VOLUME = BOX.w * BOX.d * BOX.h;

const pBoxWidth = createParameterId("param_occt_shole_box_w");
const pBoxDepth = createParameterId("param_occt_shole_box_d");
const pBoxHeight = createParameterId("param_occt_shole_box_h");

const bBox = createBodyId("body_occt_shole_box");
const bHole = createBodyId("body_occt_shole_result");
const fBox = createFeatureId("feat_occt_shole_box");
const fHole = createFeatureId("feat_occt_shole");

const skPositions = createSketchDocumentId("skd_occt_shole_positions");

const BASE_SPEC: StructuredHoleSpec = {
  type: 1,
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
  x: number,
  y: number,
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
      return length(x);
    case "positionY":
      return length(y);
    case "axis":
      return dimensionless(3);
    default:
      throw new Error(`unknown role ${role}`);
  }
}

/** Builds the box → structured hole document (world form, +z face). */
function buildStructuredHoleDocument(
  spec: StructuredHoleSpec,
  options: {
    readonly x?: number;
    readonly y?: number;
    readonly sketchPositions?: boolean;
  } = {},
): CadDocument {
  const x = options.x ?? BOX.w / 2;
  const y = options.y ?? BOX.d / 2;
  const type = structuredHoleTypeOf(spec.type);
  if (type === null) throw new Error("the fixture spec's type must be 1–5");
  const roles = structuredHoleRoles(type, {
    sketchPositions: options.sketchPositions === true,
  });
  const roleIds = roles.map((role) =>
    createParameterId(`param_occt_shole_${role.name}`),
  );
  let document = createDocument(createDocumentId("doc_occt_shole"));
  if (options.sketchPositions) {
    const sketched = addDocumentSketch(document, {
      id: skPositions,
      name: "hole positions",
      sketch: { formatVersion: 1 },
    });
    if (!sketched.ok) throw new Error(sketched.error.message);
    document = sketched.value.document;
  }
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
    const added = addDocumentParameter(document, {
      id,
      name: role.name,
      value: roleValue(spec, role.name, x, y),
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

/** Runs the bridge regeneration and returns the hole's result volume. */
function holeVolumeMm3(
  spec: StructuredHoleSpec,
  kernel: OcctKernel,
  options: {
    readonly x?: number;
    readonly y?: number;
    readonly sketchPositions?: boolean;
    readonly sketchPoints?: readonly {
      readonly x: number;
      readonly y: number;
    }[];
  } = {},
): number {
  const document = buildStructuredHoleDocument(spec, options);
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
    ...(options.sketchPoints === undefined
      ? {}
      : {
          points: () => ({
            ok: true,
            value: { points: options.sketchPoints ?? [] },
          }),
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
  if (status?.state !== "valid") {
    throw new Error(
      `the structured hole feature failed: ${JSON.stringify(status?.diagnostics)}`,
    );
  }
  const solid = bridge.solidOf(bHole);
  if (solid === undefined) throw new Error("the hole body has no solid");
  return unwrapKernelResult(kernel.volume(solid), "structured hole volume");
}

/** The re-derived analytic removed volume (mm³) in deep stock. */
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
  const h =
    spec.tipAngleDeg >= 180 ? 0 : pilot / Math.tan(rad(spec.tipAngleDeg / 2));
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

describe("OCCT structured hole (Phase 42)", () => {
  it("pins the blind straight hole with a 118° tip at the exact analytic volume", () => {
    const kernel = occtKernelFromRuntime(runtime);
    const spec = { ...BASE_SPEC, tipAngleDeg: 118 };
    assertVolumeClose(
      holeVolumeMm3(spec, kernel),
      BOX_VOLUME - removedVolumeMm3(spec),
      EXACT_VOLUME_TOLERANCE,
    );
  });

  it("pins the through straight hole at the exact cylinder volume", () => {
    const kernel = occtKernelFromRuntime(runtime);
    const spec = { ...BASE_SPEC, depthMm: 10 };
    assertVolumeClose(
      holeVolumeMm3(spec, kernel),
      BOX_VOLUME - Math.PI * 4 * 4 * BOX.h,
      EXACT_VOLUME_TOLERANCE,
    );
  });

  it("pins the counterbore at the exact cylinder + annulus volume", () => {
    const kernel = occtKernelFromRuntime(runtime);
    const spec = { ...BASE_SPEC, type: 2 };
    assertVolumeClose(
      holeVolumeMm3(spec, kernel),
      BOX_VOLUME - removedVolumeMm3(spec),
      EXACT_VOLUME_TOLERANCE,
    );
  });

  it("pins the countersink at the exact frustum volume", () => {
    const kernel = occtKernelFromRuntime(runtime);
    const spec = { ...BASE_SPEC, type: 3 };
    assertVolumeClose(
      holeVolumeMm3(spec, kernel),
      BOX_VOLUME - removedVolumeMm3(spec),
      EXACT_VOLUME_TOLERANCE,
    );
  });

  it("pins the truncated taper at the exact frustum volume", () => {
    const kernel = occtKernelFromRuntime(runtime);
    const spec = { ...BASE_SPEC, type: 4 };
    assertVolumeClose(
      holeVolumeMm3(spec, kernel),
      BOX_VOLUME - removedVolumeMm3(spec),
      EXACT_VOLUME_TOLERANCE,
    );
  });

  it("pins the closing taper at the exact full-cone volume", () => {
    const kernel = occtKernelFromRuntime(runtime);
    const spec = { ...BASE_SPEC, type: 4, taperAngleDeg: 90 };
    assertVolumeClose(
      holeVolumeMm3(spec, kernel),
      BOX_VOLUME - (Math.PI * 16 * 4) / 3,
      EXACT_VOLUME_TOLERANCE,
    );
  });

  it(
    "pins the threaded hole at the exact pilot + ISO screw volume",
    { timeout: 60_000 },
    () => {
      const kernel = occtKernelFromRuntime(runtime);
      const spec = { ...BASE_SPEC, type: 5 };
      // The OCCT thread runs the documented ruled band (Phase 40); the pilot
      // is exact, the ridge rides that band.
      const volume = holeVolumeMm3(spec, kernel);
      const expected = BOX_VOLUME - removedVolumeMm3(spec);
      assertVolumeClose(volume, expected, 0.02);
    },
  );

  it("cuts every sketch-point position of one feature at the exact total", () => {
    const kernel = occtKernelFromRuntime(runtime);
    const spec = { ...BASE_SPEC, diameterMm: 4 };
    const volume = holeVolumeMm3(spec, kernel, {
      sketchPositions: true,
      sketchPoints: [
        { x: BOX.w / 4, y: BOX.d / 2 },
        { x: (3 * BOX.w) / 4, y: BOX.d / 2 },
      ],
    });
    assertVolumeClose(
      volume,
      BOX_VOLUME - 2 * removedVolumeMm3(spec),
      EXACT_VOLUME_TOLERANCE,
    );
  });
});
