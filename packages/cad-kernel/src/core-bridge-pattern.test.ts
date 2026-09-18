/**
 * The pattern features' bridge tests (Phase 26.8): a target box + three
 * parameters (count — dimensionless; spacing/direction or totalAngle/axis)
 * → the bridge's `patternLinear`/`patternCircular` kinds → the fake kernel.
 *
 * Linear patterns run REAL semantics on the fake kernel (translation +
 * union are its exact ops — volumes in the documented voxel band, tight
 * union bounds), including the plan's validation pin: a 3×20 pattern edited
 * by `parameter.set` to 5×15 regenerates to exactly five copies at 15 mm.
 *
 * Circular patterns cannot run on the fake kernel (it declares no
 * `transformRotation`, and the bridge refuses to compose rotations on a
 * kernel that might ignore them — that gate is itself under test), so
 * their composition is pinned through a RECORDING double: a fake-kernel
 * wrapper that declares rotation and logs every `transform` (translation +
 * rotation) and `union` the bridge issues. The double delegates
 * translation only, so it proves WHAT the bridge composes (angles i·Δ,
 * axis, union arity) — the geometry of rotations is the real rotating
 * kernels' own suites and the cross-kernel equivalence suite.
 *
 * The failure taxonomy (count < 2 / non-integer / > limit / wrong
 * dimension, spacing ≤ 0, direction/total-angle domain, axis selector,
 * layout, the rotation capability gate) is pinned case by case as
 * structured diagnostics.
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
  dimensionless,
  type FeatureRecordInput,
  initialRegenerationStates,
  length,
  regenerate,
  valueIn,
} from "@slopcad/cad-core";
import type { GeometryKernel, KernelSolid, TransformInput } from "./contract";

import {
  createKernelFeatureExecutor,
  PATTERN_COUNT_LIMIT,
} from "./core-bridge";
import { createFakeKernel } from "./fake-kernel";
import {
  assertBoundsEqual,
  assertVolumeClose,
  unwrapKernelResult,
} from "./test-utils";

/** The fixture target box's extents (mm). */
const BOX = { w: 10, d: 10, h: 10 } as const;

const pWidth = createParameterId("param_pattern_box_w");
const pDepth = createParameterId("param_pattern_box_d");
const pHeight = createParameterId("param_pattern_box_h");
const pCount = createParameterId("param_pattern_count");
const pSpacing = createParameterId("param_pattern_spacing");
const pDirection = createParameterId("param_pattern_direction");
const pTotalAngle = createParameterId("param_pattern_total_angle");
const pAxis = createParameterId("param_pattern_axis");

const bTarget = createBodyId("body_pattern_target");
const bPattern = createBodyId("body_pattern_result");
const fBox = createFeatureId("feat_pattern_box");
const fPattern = createFeatureId("feat_pattern");

/** Adds the fixture's box feature and parameters to a fresh document. */
function newPatternDocument(): CadDocument {
  let document = createDocument(createDocumentId("doc_bridge_pattern"));
  for (const [id, name, value] of [
    [pWidth, "boxWidth", length(BOX.w)],
    [pDepth, "boxDepth", length(BOX.d)],
    [pHeight, "boxHeight", length(BOX.h)],
  ] as const) {
    const added = addDocumentParameter(document, { id, name, value });
    if (!added.ok) throw new Error(added.error.message);
    document = added.value.document;
  }
  for (const body of [
    { id: bTarget, name: "target" },
    { id: bPattern, name: "pattern" },
  ]) {
    const added = addBody(document, body);
    if (!added.ok) throw new Error(added.error.message);
    document = added.value.document;
  }
  const box = addFeature(document, {
    id: fBox,
    kind: "box",
    inputs: [
      { kind: "parameter", id: pWidth },
      { kind: "parameter", id: pDepth },
      { kind: "parameter", id: pHeight },
    ],
    outputs: [bTarget],
  });
  if (!box.ok) throw new Error(box.error.message);
  return box.value.document;
}

/** Parameter values a pattern document is built with. */
interface LinearPatternSpec {
  readonly count: number;
  readonly spacingMm: number;
  readonly directionRad: number;
}

/** Builds the linear pattern document: box + count/spacing/direction. */
function buildLinearDocument(spec: LinearPatternSpec): CadDocument {
  let document = newPatternDocument();
  for (const [id, name, value] of [
    [pCount, "patternCount", dimensionless(spec.count)],
    [pSpacing, "patternSpacing", length(spec.spacingMm)],
    [pDirection, "patternDirection", angle(spec.directionRad, "rad")],
  ] as const) {
    const added = addDocumentParameter(document, { id, name, value });
    if (!added.ok) throw new Error(added.error.message);
    document = added.value.document;
  }
  return withPatternFeature(document, "patternLinear", [
    { kind: "parameter", id: pCount },
    { kind: "parameter", id: pSpacing },
    { kind: "parameter", id: pDirection },
  ]);
}

/** Parameter values a circular pattern document is built with. */
interface CircularPatternSpec {
  readonly count: number;
  readonly totalAngleRad: number;
  readonly axis: number;
}

/** Builds the circular pattern document: box + count/totalAngle/axis. */
function buildCircularDocument(spec: CircularPatternSpec): CadDocument {
  let document = newPatternDocument();
  for (const [id, name, value] of [
    [pCount, "patternCount", dimensionless(spec.count)],
    [pTotalAngle, "patternTotalAngle", angle(spec.totalAngleRad, "rad")],
    [pAxis, "patternAxis", dimensionless(spec.axis)],
  ] as const) {
    const added = addDocumentParameter(document, { id, name, value });
    if (!added.ok) throw new Error(added.error.message);
    document = added.value.document;
  }
  return withPatternFeature(document, "patternCircular", [
    { kind: "parameter", id: pCount },
    { kind: "parameter", id: pTotalAngle },
    { kind: "parameter", id: pAxis },
  ]);
}

/** Adds the pattern feature over the fixture box to the document. */
function withPatternFeature(
  document: CadDocument,
  kind: "patternLinear" | "patternCircular",
  parameters: FeatureRecordInput["inputs"],
): CadDocument {
  const feature: FeatureRecordInput = {
    id: fPattern,
    kind,
    inputs: [{ kind: "feature", id: fBox }, ...parameters],
    outputs: [bPattern],
  };
  const added = addFeature(document, feature);
  if (!added.ok) throw new Error(added.error.message);
  return added.value.document;
}

/** Regenerates a pattern document against the given kernel. */
function runPattern(
  document: CadDocument,
  kernel: GeometryKernel = createFakeKernel(),
) {
  const bridge = createKernelFeatureExecutor(kernel, {
    document,
    bodies: new Map(),
    profiles: () => ({
      ok: false,
      error: {
        code: "document/not-found",
        message: "patterns resolve no sketches",
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

/** The pattern feature's first diagnostic after a failed run. */
function patternDiagnostic(document: CadDocument, kernel?: GeometryKernel) {
  const { run } = runPattern(document, kernel);
  const state = run.states.get(fPattern);
  expect(state?.state).toBe("failed");
  return state?.diagnostics[0];
}

/**
 * Asserts a recorded rotation-angle list equals the expected radian values
 * within double-precision noise (the bridge's `i·Δ` and the expectation's
 * `i·π/n` can group the same product one ulp apart).
 */
function expectAngleList(
  actual: readonly (number | undefined)[],
  expected: readonly number[],
): void {
  expect(actual).toHaveLength(expected.length);
  for (let i = 0; i < expected.length; i += 1) {
    const angleRad = actual[i];
    const expectedAngle = expected[i];
    expect(angleRad).toBeDefined();
    expect(expectedAngle).toBeDefined();
    if (angleRad === undefined || expectedAngle === undefined) continue;
    expect(Math.abs(angleRad - expectedAngle)).toBeLessThan(1e-12);
  }
}

/** One recorded `transform` call: its translation and optional rotation. */
interface TransformRecord {
  readonly translation: readonly [number, number, number];
  readonly rotation: {
    readonly axis: readonly [number, number, number];
    readonly angleRad: number;
  } | null;
}

/**
 * The recording double (see the module doc): a fake-kernel wrapper that
 * declares `transformRotation` and logs every transform and union the
 * bridge issues, delegating translation only. Rotation GEOMETRY is the
 * real rotating kernels' concern; this double pins the bridge's
 * composition — which angles, which axis, what union arity.
 */
function recordingRotatingKernel(): {
  readonly kernel: GeometryKernel;
  readonly transforms: TransformRecord[];
  readonly unionArities: number[];
} {
  const base = createFakeKernel();
  const transforms: TransformRecord[] = [];
  const unionArities: number[] = [];
  const kernel: GeometryKernel = {
    ...base,
    capabilities: { ...base.capabilities, transformRotation: true },
    transform: (solid: KernelSolid, input: TransformInput) => {
      transforms.push({
        translation: [
          valueIn(input.x, "mm"),
          valueIn(input.y, "mm"),
          valueIn(input.z, "mm"),
        ],
        rotation:
          input.rotation === undefined
            ? null
            : {
                axis: input.rotation.axis,
                angleRad: valueIn(input.rotation.angle, "rad"),
              },
      });
      return base.transform(solid, { x: input.x, y: input.y, z: input.z });
    },
    union: (operands: readonly KernelSolid[]) => {
      unionArities.push(operands.length);
      return base.union(operands);
    },
  };
  return { kernel, transforms, unionArities };
}

describe("bridge patternLinear: count × spacing along a direction angle", () => {
  it("executes a 3×20 pattern along +x: three copies, tight union bounds", () => {
    const { kernel, bridge, run } = runPattern(
      buildLinearDocument({ count: 3, spacingMm: 20, directionRad: 0 }),
    );
    expect(run.executed).toEqual([fBox, fPattern]);
    const solid = bridge.solidOf(bPattern);
    expect(solid).toBeDefined();
    if (solid === undefined) return;
    assertBoundsEqual(
      unwrapKernelResult(kernel.bounds(solid), "pattern bounds"),
      { min: [0, 0, 0], max: [50, BOX.d, BOX.h] },
    );
    // Disjoint copies: the true union volume is 3 boxes (the fake kernel's
    // voxel quadrature carries its documented ~1% boolean band).
    assertVolumeClose(
      unwrapKernelResult(kernel.volume(solid), "pattern volume"),
      3 * BOX.w * BOX.d * BOX.h,
      0.02,
    );
  });

  it("patterns along +y from a π/2 direction angle", () => {
    const { kernel, bridge } = runPattern(
      buildLinearDocument({
        count: 3,
        spacingMm: 20,
        directionRad: Math.PI / 2,
      }),
    );
    const solid = bridge.solidOf(bPattern);
    expect(solid).toBeDefined();
    if (solid === undefined) return;
    assertBoundsEqual(
      unwrapKernelResult(kernel.bounds(solid), "pattern bounds"),
      { min: [0, 0, 0], max: [BOX.w, 50, BOX.h] },
    );
  });

  it("patterns along the π/4 diagonal: bounds at 10 + 2·20·cos(π/4)", () => {
    const { kernel, bridge } = runPattern(
      buildLinearDocument({
        count: 3,
        spacingMm: 20,
        directionRad: Math.PI / 4,
      }),
    );
    const solid = bridge.solidOf(bPattern);
    expect(solid).toBeDefined();
    if (solid === undefined) return;
    const far = BOX.w + 2 * 20 * Math.cos(Math.PI / 4);
    assertBoundsEqual(
      unwrapKernelResult(kernel.bounds(solid), "pattern bounds"),
      { min: [0, 0, 0], max: [far, far, BOX.h] },
    );
  });

  it("regenerates from edits: parameter.set 3×20 → 5×15 yields five copies at 15", () => {
    // The plan's validation criterion, executable: BOTH pattern parameters
    // mutate through parameter.set and the regenerated solid is exactly
    // the 5×15 arrangement.
    const document = buildLinearDocument({
      count: 3,
      spacingMm: 20,
      directionRad: 0,
    });
    const setCount = applyCommand(document, {
      type: "parameter.set",
      id: pCount,
      value: dimensionless(5),
    });
    expect(setCount.ok).toBe(true);
    if (!setCount.ok) return;
    const setSpacing = applyCommand(setCount.value, {
      type: "parameter.set",
      id: pSpacing,
      value: length(15),
    });
    expect(setSpacing.ok).toBe(true);
    if (!setSpacing.ok) return;
    const { kernel, bridge, run } = runPattern(setSpacing.value);
    expect(run.executed).toEqual([fBox, fPattern]);
    const solid = bridge.solidOf(bPattern);
    expect(solid).toBeDefined();
    if (solid === undefined) return;
    // Five disjoint copies at 0/15/30/45/60: the union spans 70 in x.
    assertBoundsEqual(
      unwrapKernelResult(kernel.bounds(solid), "edited pattern bounds"),
      { min: [0, 0, 0], max: [70, BOX.d, BOX.h] },
    );
    assertVolumeClose(
      unwrapKernelResult(kernel.volume(solid), "edited pattern volume"),
      5 * BOX.w * BOX.d * BOX.h,
      0.02,
    );
  });

  it("accepts overlapping copies: a 5 mm spacing interpenetrates and unions cleanly", () => {
    // Probed: unions of overlapping (and even coincident) arrangements do
    // NOT fail — overlap is legal pattern input, judged by each kernel's
    // own boolean fidelity. Two 10 mm boxes at 5 mm offset union to the
    // exact 15×10×10 slab (boundaries aligned with the fake kernel's
    // sample grid).
    const { kernel, bridge } = runPattern(
      buildLinearDocument({ count: 2, spacingMm: 5, directionRad: 0 }),
    );
    const solid = bridge.solidOf(bPattern);
    expect(solid).toBeDefined();
    if (solid === undefined) return;
    assertVolumeClose(
      unwrapKernelResult(kernel.volume(solid), "overlapped volume"),
      15 * BOX.d * BOX.h,
      0.02,
    );
  });

  it("rejects a count below 2 with kernel/parameter-invalid", () => {
    const diagnostic = patternDiagnostic(
      buildLinearDocument({ count: 1, spacingMm: 20, directionRad: 0 }),
    );
    expect(diagnostic?.code).toBe("kernel/parameter-invalid");
    expect(diagnostic?.message).toContain("at least 2");
  });

  it("rejects a non-integer count (the dimensionless ride validates integrality)", () => {
    const document = buildLinearDocument({
      count: 3,
      spacingMm: 20,
      directionRad: 0,
    });
    const set = applyCommand(document, {
      type: "parameter.set",
      id: pCount,
      value: dimensionless(3.5),
    });
    expect(set.ok).toBe(true);
    if (!set.ok) return;
    const diagnostic = patternDiagnostic(set.value);
    expect(diagnostic?.code).toBe("kernel/parameter-invalid");
    expect(diagnostic?.message).toContain("whole number");
  });

  it("rejects a count over the regeneration guard limit", () => {
    const document = buildLinearDocument({
      count: 3,
      spacingMm: 20,
      directionRad: 0,
    });
    const set = applyCommand(document, {
      type: "parameter.set",
      id: pCount,
      value: dimensionless(PATTERN_COUNT_LIMIT + 1),
    });
    expect(set.ok).toBe(true);
    if (!set.ok) return;
    const diagnostic = patternDiagnostic(set.value);
    expect(diagnostic?.code).toBe("kernel/parameter-invalid");
    expect(diagnostic?.message).toContain(`at most ${PATTERN_COUNT_LIMIT}`);
  });

  it("rejects a count of the wrong dimension with the dimensionless message", () => {
    const document = buildLinearDocument({
      count: 3,
      spacingMm: 20,
      directionRad: 0,
    });
    const set = applyCommand(document, {
      type: "parameter.set",
      id: pCount,
      value: length(3),
    });
    expect(set.ok).toBe(true);
    if (!set.ok) return;
    const diagnostic = patternDiagnostic(set.value);
    expect(diagnostic?.code).toBe("kernel/parameter-invalid");
    expect(diagnostic?.message).toContain("dimensionless");
  });

  it("rejects zero and negative spacing as a degenerate (no-op) pattern", () => {
    for (const spacingMm of [0, -20]) {
      const diagnostic = patternDiagnostic(
        buildLinearDocument({ count: 3, spacingMm, directionRad: 0 }),
      );
      expect(diagnostic?.code).toBe("kernel/parameter-invalid");
      expect(diagnostic?.message).toContain("strictly positive spacing");
    }
  });

  it("rejects a direction parameter of the wrong dimension", () => {
    const document = buildLinearDocument({
      count: 3,
      spacingMm: 20,
      directionRad: 0,
    });
    const set = applyCommand(document, {
      type: "parameter.set",
      id: pDirection,
      value: length(10),
    });
    expect(set.ok).toBe(true);
    if (!set.ok) return;
    const diagnostic = patternDiagnostic(set.value);
    expect(diagnostic?.code).toBe("kernel/parameter-invalid");
    expect(diagnostic?.message).toContain("to be an angle");
  });

  it("rejects malformed layouts: two targets, missing parameters, a sketch input", () => {
    const base = buildLinearDocument({
      count: 3,
      spacingMm: 20,
      directionRad: 0,
    });
    const withInputs = (inputs: FeatureRecordInput["inputs"]) =>
      base.features.map((feature) =>
        feature.id === fPattern ? { ...feature, inputs } : feature,
      );
    const diagnosticsOf = (inputs: FeatureRecordInput["inputs"]) =>
      patternDiagnostic({ ...base, features: withInputs(inputs) });
    // Two targets:
    expect(
      diagnosticsOf([
        { kind: "feature", id: fBox },
        { kind: "body", id: bTarget },
        { kind: "parameter", id: pCount },
        { kind: "parameter", id: pSpacing },
        { kind: "parameter", id: pDirection },
      ]),
    ).toMatchObject({ code: "kernel/feature-input-invalid" });
    // Only two parameters:
    expect(
      diagnosticsOf([
        { kind: "feature", id: fBox },
        { kind: "parameter", id: pCount },
        { kind: "parameter", id: pSpacing },
      ]),
    ).toMatchObject({ code: "kernel/feature-input-invalid" });
  });
});

describe("bridge patternCircular: count copies at i·Δ about a world axis", () => {
  it("refuses on a kernel without transformRotation (the fake kernel)", () => {
    // The gate fires BEFORE any rotation is issued: the contract permits a
    // non-declaring kernel to IGNORE a rotation, which would silently
    // stack every copy on the target — the bridge refuses that wrong
    // answer structurally.
    const diagnostic = patternDiagnostic(
      buildCircularDocument({ count: 4, totalAngleRad: Math.PI * 2, axis: 3 }),
    );
    expect(diagnostic?.code).toBe("kernel/feature-input-invalid");
    expect(diagnostic?.message).toContain("transformRotation");
  });

  it("composes a full-circle pattern as i·2π/count rotations about the axis", () => {
    const recorder = recordingRotatingKernel();
    const { bridge, run } = runPattern(
      buildCircularDocument({ count: 4, totalAngleRad: Math.PI * 2, axis: 3 }),
      recorder.kernel,
    );
    expect(run.executed).toEqual([fBox, fPattern]);
    expect(bridge.solidOf(bPattern)).toBeDefined();
    // Three rotated copies (i = 1..3) at π/2, π, 3π/2 about world Z — no
    // duplicate at the full turn — then ONE union of all four solids.
    expect(recorder.transforms).toHaveLength(3);
    expectAngleList(
      recorder.transforms.map((record) => record.rotation?.angleRad),
      [Math.PI / 2, Math.PI, (Math.PI * 3) / 2],
    );
    for (const record of recorder.transforms) {
      expect(record.rotation?.axis).toEqual([0, 0, 1]);
      expect(record.translation).toEqual([0, 0, 0]);
    }
    expect(recorder.unionArities).toEqual([4]);
  });

  it("composes a partial pattern: three copies fanned across [0, π]", () => {
    const recorder = recordingRotatingKernel();
    runPattern(
      buildCircularDocument({ count: 3, totalAngleRad: Math.PI, axis: 1 }),
      recorder.kernel,
    );
    expectAngleList(
      recorder.transforms.map((record) => record.rotation?.angleRad),
      [Math.PI / 3, (Math.PI * 2) / 3],
    );
    for (const record of recorder.transforms) {
      expect(record.rotation?.axis).toEqual([1, 0, 0]);
    }
    expect(recorder.unionArities).toEqual([3]);
  });

  it("regenerates from edits: count 4→6 and 2π→π re-composes to i·π/6", () => {
    // The circular twin of the linear pin: both circular parameters mutate
    // through parameter.set and the recorded composition is exactly the
    // new arrangement — five rotations at multiples of π/6, one union of
    // six solids.
    const document = buildCircularDocument({
      count: 4,
      totalAngleRad: Math.PI * 2,
      axis: 3,
    });
    const setCount = applyCommand(document, {
      type: "parameter.set",
      id: pCount,
      value: dimensionless(6),
    });
    expect(setCount.ok).toBe(true);
    if (!setCount.ok) return;
    const setAngle = applyCommand(setCount.value, {
      type: "parameter.set",
      id: pTotalAngle,
      value: angle(Math.PI, "rad"),
    });
    expect(setAngle.ok).toBe(true);
    if (!setAngle.ok) return;
    const recorder = recordingRotatingKernel();
    const { run } = runPattern(setAngle.value, recorder.kernel);
    expect(run.executed).toEqual([fBox, fPattern]);
    expect(recorder.transforms).toHaveLength(5);
    expectAngleList(
      recorder.transforms.map((record) => record.rotation?.angleRad),
      [
        Math.PI / 6,
        (Math.PI * 2) / 6,
        (Math.PI * 3) / 6,
        (Math.PI * 4) / 6,
        (Math.PI * 5) / 6,
      ],
    );
    expect(recorder.unionArities).toEqual([6]);
  });

  it("rejects a zero total angle (Δ = 0) and one beyond a full turn", () => {
    // Domain validation runs on the rotation-capable double: the fake
    // kernel would answer the capability gate first.
    for (const totalAngleRad of [0, Math.PI * 4]) {
      const diagnostic = patternDiagnostic(
        buildCircularDocument({ count: 3, totalAngleRad, axis: 3 }),
        recordingRotatingKernel().kernel,
      );
      expect(diagnostic?.code).toBe("kernel/parameter-invalid");
    }
    const zero = patternDiagnostic(
      buildCircularDocument({ count: 3, totalAngleRad: 0, axis: 3 }),
      recordingRotatingKernel().kernel,
    );
    expect(zero?.message).toContain("strictly positive total angle");
    const over = patternDiagnostic(
      buildCircularDocument({ count: 3, totalAngleRad: Math.PI * 4, axis: 3 }),
      recordingRotatingKernel().kernel,
    );
    expect(over?.message).toContain("2π");
  });

  it("rejects an axis selector outside 1..3 and a non-integer one", () => {
    // On the rotation-capable double (the gate would answer first on the
    // fake kernel).
    for (const axis of [4, 2.5]) {
      const document = buildCircularDocument({
        count: 3,
        totalAngleRad: Math.PI,
        axis: 3,
      });
      const set = applyCommand(document, {
        type: "parameter.set",
        id: pAxis,
        value: dimensionless(axis),
      });
      expect(set.ok).toBe(true);
      if (!set.ok) return;
      const diagnostic = patternDiagnostic(
        set.value,
        recordingRotatingKernel().kernel,
      );
      expect(diagnostic?.code).toBe("kernel/parameter-invalid");
      expect(diagnostic?.message).toContain("1 = X, 2 = Y, 3 = Z");
    }
  });
});
