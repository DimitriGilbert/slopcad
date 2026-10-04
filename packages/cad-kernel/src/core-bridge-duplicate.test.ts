/**
 * The duplicate feature's bridge tests (Phase 60): a source box + six
 * parameters (dx/dy/dz lengths, count dimensionless, axis dimensionless,
 * angle) → the bridge's `duplicate` kind — the ONE multi-output kind.
 *
 * Translate-only duplicates run REAL semantics on the fake kernel
 * (translation is its exact op): copy i is the box at i·offset, each copy
 * its own output body solid, the source's solid untouched beside them —
 * including the re-drive pin: a `parameter.set` on the offset moves every
 * copy on the next regeneration.
 *
 * Rotating duplicates cannot run on the fake kernel (it declares no
 * `transformRotation`, and the duplicate's rotation gate is itself under
 * test), so their composition is pinned through the pattern suite's
 * RECORDING-double discipline: a fake-kernel wrapper that declares
 * rotation and logs every `transform` the bridge issues. The records pin
 * the analytic T^i composition (angles i·θ, the accumulated translations
 * Σ R^k·d, one transform per copy, no union) — the rotation GEOMETRY is
 * the real rotating kernels' own suite (the OCCT package's duplicate
 * bridge tests) and `planDuplicateInstances`' unit pins here.
 *
 * The failure taxonomy (layout, output/count mismatch, count domain,
 * axis selector, identity transform, rotation capability) is pinned case
 * by case as structured diagnostics.
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
  DUPLICATE_COUNT_LIMIT,
  planDuplicateInstances,
} from "./core-bridge";
import { createFakeKernel } from "./fake-kernel";
import { assertBoundsEqual, unwrapKernelResult } from "./test-utils";

/** The fixture source box's extents (mm). */
const BOX = { w: 10, d: 10, h: 10 } as const;

const pWidth = createParameterId("param_duplicate_box_w");
const pDepth = createParameterId("param_duplicate_box_d");
const pHeight = createParameterId("param_duplicate_box_h");
const pDx = createParameterId("param_duplicate_dx");
const pDy = createParameterId("param_duplicate_dy");
const pDz = createParameterId("param_duplicate_dz");
const pCount = createParameterId("param_duplicate_count");
const pAxis = createParameterId("param_duplicate_axis");
const pAngle = createParameterId("param_duplicate_angle");

const bSource = createBodyId("body_duplicate_source");
const bCopy1 = createBodyId("body_duplicate_copy1");
const bCopy2 = createBodyId("body_duplicate_copy2");
const bCopy3 = createBodyId("body_duplicate_copy3");
const fBox = createFeatureId("feat_duplicate_box");
const fDuplicate = createFeatureId("feat_duplicate");

/** Adds the fixture's box feature and parameters to a fresh document. */
function newDuplicateDocument(): CadDocument {
  let document = createDocument(createDocumentId("doc_bridge_duplicate"));
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
    { id: bSource, name: "source" },
    { id: bCopy1, name: "copy 1" },
    { id: bCopy2, name: "copy 2" },
    { id: bCopy3, name: "copy 3" },
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
    outputs: [bSource],
  });
  if (!box.ok) throw new Error(box.error.message);
  return box.value.document;
}

/** The duplicate feature's authored numbers. */
interface DuplicateSpec {
  readonly dxMm: number;
  readonly dyMm: number;
  readonly dzMm: number;
  readonly count: number;
  readonly axis: number;
  readonly angleDeg: number;
}

/** Adds the duplicate feature (+ its six parameters) over the box. */
function buildDuplicateDocument(
  spec: DuplicateSpec,
  outputs: number = spec.count,
): CadDocument {
  let document = newDuplicateDocument();
  for (const [id, name, value] of [
    [pDx, "duplicateDx", length(spec.dxMm)],
    [pDy, "duplicateDy", length(spec.dyMm)],
    [pDz, "duplicateDz", length(spec.dzMm)],
    [pCount, "duplicateCount", dimensionless(spec.count)],
    [pAxis, "duplicateAxis", dimensionless(spec.axis)],
    [pAngle, "duplicateAngle", angle(spec.angleDeg, "deg")],
  ] as const) {
    const added = addDocumentParameter(document, { id, name, value });
    if (!added.ok) throw new Error(added.error.message);
    document = added.value.document;
  }
  const copyBodies = [bCopy1, bCopy2, bCopy3].slice(0, outputs);
  const feature: FeatureRecordInput = {
    id: fDuplicate,
    kind: "duplicate",
    inputs: [
      { kind: "feature", id: fBox },
      { kind: "parameter", id: pDx },
      { kind: "parameter", id: pDy },
      { kind: "parameter", id: pDz },
      { kind: "parameter", id: pCount },
      { kind: "parameter", id: pAxis },
      { kind: "parameter", id: pAngle },
    ],
    outputs: copyBodies,
  };
  const added = addFeature(document, feature);
  if (!added.ok) throw new Error(added.error.message);
  return added.value.document;
}

/** Regenerates a duplicate document against the given kernel. */
function runDuplicate(
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
        message: "duplicates resolve no sketches",
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

/** The duplicate feature's first diagnostic after a failed run. */
function duplicateDiagnostic(document: CadDocument, kernel?: GeometryKernel) {
  const { run } = runDuplicate(document, kernel);
  const state = run.states.get(fDuplicate);
  expect(state?.state).toBe("failed");
  return state?.diagnostics[0];
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
 * The recording double (the pattern suite's discipline): a fake-kernel
 * wrapper that declares `transformRotation` and logs every transform the
 * bridge issues, delegating translation only. Rotation GEOMETRY is the
 * real rotating kernels' concern; this double pins WHAT the bridge
 * composes — the per-copy analytic plan verbatim.
 */
function recordingRotatingKernel(): {
  readonly kernel: GeometryKernel;
  readonly transforms: TransformRecord[];
} {
  const base = createFakeKernel();
  const transforms: TransformRecord[] = [];
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
  };
  return { kernel, transforms };
}

/** Expects a translation triple within double-precision noise. */
function expectTranslationNear(
  actual: readonly (number | undefined)[],
  expected: readonly [number, number, number],
): void {
  expect(actual).toHaveLength(3);
  for (let i = 0; i < 3; i += 1) {
    const component = actual[i];
    const expectedComponent = expected[i];
    expect(component).toBeDefined();
    expect(expectedComponent).toBeDefined();
    if (component === undefined || expectedComponent === undefined) continue;
    expect(Math.abs(component - expectedComponent)).toBeLessThan(1e-9);
  }
}

describe("planDuplicateInstances: the analytic T^i composition", () => {
  it("translation-only steps place copy i at i·d", () => {
    const plans = planDuplicateInstances({
      offsetMm: [15, 0, 0],
      axis: [0, 0, 1],
      angleRad: 0,
      count: 3,
    });
    expect(plans.map((plan) => plan.ordinal)).toEqual([1, 2, 3]);
    expectTranslationNear(plans[0]?.translationMm ?? [], [15, 0, 0]);
    expectTranslationNear(plans[1]?.translationMm ?? [], [30, 0, 0]);
    expectTranslationNear(plans[2]?.translationMm ?? [], [45, 0, 0]);
    for (const plan of plans) {
      expect(plan.rotationAngleRad).toBe(0);
    }
  });

  it("rotation-only steps keep zero translation and turn i·θ", () => {
    const plans = planDuplicateInstances({
      offsetMm: [0, 0, 0],
      axis: [0, 0, 1],
      angleRad: Math.PI / 2,
      count: 3,
    });
    for (const plan of plans) {
      expectTranslationNear(plan.translationMm, [0, 0, 0]);
    }
    expect(plans[0]?.rotationAngleRad).toBeCloseTo(Math.PI / 2, 12);
    expect(plans[1]?.rotationAngleRad).toBeCloseTo(Math.PI, 12);
    expect(plans[2]?.rotationAngleRad).toBeCloseTo((3 * Math.PI) / 2, 12);
  });

  it("combined steps accumulate Σ R^k·d: 15 mm x-offset at 90° z-steps", () => {
    // T(p) = R(p + d); copy i's translation is Σ_{k=1..i} R^k·d — the
    // four-corner walk: copy 1 → (0, 15), copy 2 → (−15, 15),
    // copy 3 → (−15, 0), copy 4 → (0, 0) (the full turn closes the square).
    const plans = planDuplicateInstances({
      offsetMm: [15, 0, 0],
      axis: [0, 0, 1],
      angleRad: Math.PI / 2,
      count: 4,
    });
    expectTranslationNear(plans[0]?.translationMm ?? [], [0, 15, 0]);
    expectTranslationNear(plans[1]?.translationMm ?? [], [-15, 15, 0]);
    expectTranslationNear(plans[2]?.translationMm ?? [], [-15, 0, 0]);
    expectTranslationNear(plans[3]?.translationMm ?? [], [0, 0, 0]);
  });
});

describe("bridge duplicate: translate-only copies on the fake kernel", () => {
  it("emits count output solids at i·offset; the source stays beside them", () => {
    const { kernel, bridge, run } = runDuplicate(
      buildDuplicateDocument({
        dxMm: 15,
        dyMm: 0,
        dzMm: 0,
        count: 3,
        axis: 3,
        angleDeg: 0,
      }),
    );
    expect(run.executed).toEqual([fBox, fDuplicate]);
    // The source body remains: its own solid is present and unmoved.
    const source = bridge.solidOf(bSource);
    expect(source).toBeDefined();
    if (source !== undefined) {
      assertBoundsEqual(
        unwrapKernelResult(kernel.bounds(source), "source bounds"),
        { min: [0, 0, 0], max: [BOX.w, BOX.d, BOX.h] },
      );
    }
    // Each copy is its own body solid at its cumulative offset.
    const offsets = [15, 30, 45];
    for (const [index, bodyId] of [bCopy1, bCopy2, bCopy3].entries()) {
      const copy = bridge.solidOf(bodyId);
      expect(copy).toBeDefined();
      if (copy === undefined) continue;
      const offset = offsets[index];
      expect(offset).toBeDefined();
      if (offset === undefined) continue;
      assertBoundsEqual(
        unwrapKernelResult(kernel.bounds(copy), `copy ${String(index + 1)}`),
        {
          min: [offset, 0, 0],
          max: [offset + BOX.w, BOX.d, BOX.h],
        },
      );
    }
  });

  it("count = 1 duplicates once: a single translated copy", () => {
    const { kernel, bridge } = runDuplicate(
      buildDuplicateDocument({
        dxMm: 0,
        dyMm: 12,
        dzMm: 0,
        count: 1,
        axis: 3,
        angleDeg: 0,
      }),
    );
    const copy = bridge.solidOf(bCopy1);
    expect(copy).toBeDefined();
    if (copy === undefined) return;
    assertBoundsEqual(
      unwrapKernelResult(kernel.bounds(copy), "the single copy"),
      { min: [0, 12, 0], max: [BOX.w, 12 + BOX.d, BOX.h] },
    );
    expect(bridge.solidOf(bCopy2)).toBeUndefined();
  });

  it("re-drives: a parameter.set on the offset moves every copy", () => {
    const document = buildDuplicateDocument({
      dxMm: 15,
      dyMm: 0,
      dzMm: 0,
      count: 3,
      axis: 3,
      angleDeg: 0,
    });
    const first = runDuplicate(document);
    let copy = first.bridge.solidOf(bCopy3);
    expect(copy).toBeDefined();
    if (copy !== undefined) {
      assertBoundsEqual(
        unwrapKernelResult(first.kernel.bounds(copy), "copy 3 at 45"),
        { min: [45, 0, 0], max: [45 + BOX.w, BOX.d, BOX.h] },
      );
    }
    const edited = applyCommand(document, {
      type: "parameter.set",
      id: pDx,
      value: length(5),
    });
    if (!edited.ok) throw new Error(edited.error.message);
    const second = runDuplicate(edited.value);
    copy = second.bridge.solidOf(bCopy3);
    expect(copy).toBeDefined();
    if (copy !== undefined) {
      assertBoundsEqual(
        unwrapKernelResult(second.kernel.bounds(copy), "copy 3 at 15"),
        { min: [15, 0, 0], max: [15 + BOX.w, BOX.d, BOX.h] },
      );
    }
  });
});

describe("bridge duplicate: the rotation composition on a recording kernel", () => {
  it("composes one transform per copy: angles i·θ, translations Σ R^k·d", () => {
    const { kernel, transforms } = recordingRotatingKernel();
    const { run } = runDuplicate(
      buildDuplicateDocument({
        dxMm: 15,
        dyMm: 0,
        dzMm: 0,
        count: 3,
        axis: 3,
        angleDeg: 90,
      }),
      kernel,
    );
    expect(run.states.get(fDuplicate)?.state).toBe("valid");
    expect(transforms).toHaveLength(3);
    // Copy 1: translation R·d = (0, 15, 0), rotation π/2 about z.
    expectTranslationNear(transforms[0]?.translation ?? [], [0, 15, 0]);
    expect(transforms[0]?.rotation?.axis).toEqual([0, 0, 1]);
    expect(transforms[0]?.rotation?.angleRad).toBeCloseTo(Math.PI / 2, 12);
    // Copy 2: translation R·d + R²·d = (−15, 15, 0), rotation π.
    expectTranslationNear(transforms[1]?.translation ?? [], [-15, 15, 0]);
    expect(transforms[1]?.rotation?.angleRad).toBeCloseTo(Math.PI, 12);
    // Copy 3: translation + R³·d = (0, −15, 0) more, rotation 3π/2.
    expectTranslationNear(transforms[2]?.translation ?? [], [-15, 0, 0]);
    expect(transforms[2]?.rotation?.angleRad).toBeCloseTo(
      (3 * Math.PI) / 2,
      12,
    );
  });

  it("a zero angle emits plain translations (no rotation field at all)", () => {
    const { kernel, transforms } = recordingRotatingKernel();
    const { run } = runDuplicate(
      buildDuplicateDocument({
        dxMm: 15,
        dyMm: 0,
        dzMm: 0,
        count: 2,
        axis: 3,
        angleDeg: 0,
      }),
      kernel,
    );
    expect(run.states.get(fDuplicate)?.state).toBe("valid");
    expect(transforms).toHaveLength(2);
    expect(transforms[0]?.rotation).toBeNull();
    expect(transforms[1]?.rotation).toBeNull();
    expectTranslationNear(transforms[1]?.translation ?? [], [30, 0, 0]);
  });
});

describe("bridge duplicate: the structured refusals", () => {
  it("refuses a layout that is not source + six parameters", () => {
    const document = buildDuplicateDocument({
      dxMm: 15,
      dyMm: 0,
      dzMm: 0,
      count: 1,
      axis: 3,
      angleDeg: 0,
    });
    // Drop the angle parameter input: six inputs, not seven.
    const broken = applyCommand(document, {
      type: "feature.update",
      id: fDuplicate,
      kind: "duplicate",
      inputs: [
        { kind: "feature", id: fBox },
        { kind: "parameter", id: pDx },
        { kind: "parameter", id: pDy },
        { kind: "parameter", id: pDz },
        { kind: "parameter", id: pCount },
        { kind: "parameter", id: pAxis },
      ],
      outputs: [bCopy1],
    });
    if (!broken.ok) throw new Error(broken.error.message);
    const diagnostic = duplicateDiagnostic(broken.value);
    expect(diagnostic?.code).toBe("kernel/feature-input-invalid");
    expect(diagnostic?.message).toContain("exactly seven inputs");
  });

  it("refuses a count outside 1..64", () => {
    const over = buildDuplicateDocument({
      dxMm: 15,
      dyMm: 0,
      dzMm: 0,
      count: DUPLICATE_COUNT_LIMIT + 1,
      axis: 3,
      angleDeg: 0,
    });
    const overDiagnostic = duplicateDiagnostic(over);
    expect(overDiagnostic?.code).toBe("kernel/parameter-invalid");
    expect(overDiagnostic?.message).toContain("between 1 and 64");

    // A count of 0 cannot even be declared honestly (an empty output list
    // is its own refusal at the execute gate — one output body per copy).
    const zero = buildDuplicateDocument({
      dxMm: 15,
      dyMm: 0,
      dzMm: 0,
      count: 0,
      axis: 3,
      angleDeg: 0,
    });
    const zeroDiagnostic = duplicateDiagnostic(zero);
    expect(zeroDiagnostic?.code).toBe("kernel/feature-input-invalid");
    expect(zeroDiagnostic?.message).toContain("one output body per copy");
  });

  it("refuses a non-integer count", () => {
    const document = buildDuplicateDocument({
      dxMm: 15,
      dyMm: 0,
      dzMm: 0,
      count: 2,
      axis: 3,
      angleDeg: 0,
    });
    const edited = applyCommand(document, {
      type: "parameter.set",
      id: pCount,
      value: dimensionless(2.5),
    });
    if (!edited.ok) throw new Error(edited.error.message);
    const diagnostic = duplicateDiagnostic(edited.value);
    expect(diagnostic?.code).toBe("kernel/parameter-invalid");
    expect(diagnostic?.message).toContain("whole number");
  });

  it("refuses an output list that disagrees with the count", () => {
    // Two declared outputs against count = 3: the copies ARE the outputs.
    const document = buildDuplicateDocument(
      {
        dxMm: 15,
        dyMm: 0,
        dzMm: 0,
        count: 3,
        axis: 3,
        angleDeg: 0,
      },
      2,
    );
    const diagnostic = duplicateDiagnostic(document);
    expect(diagnostic?.code).toBe("kernel/feature-input-invalid");
    expect(diagnostic?.message).toContain("3 copies but 2 output bodies");
  });

  it("refuses an axis selector outside 1..3", () => {
    const document = buildDuplicateDocument({
      dxMm: 15,
      dyMm: 0,
      dzMm: 0,
      count: 2,
      axis: 3,
      angleDeg: 0,
    });
    const edited = applyCommand(document, {
      type: "parameter.set",
      id: pAxis,
      value: dimensionless(7),
    });
    if (!edited.ok) throw new Error(edited.error.message);
    const diagnostic = duplicateDiagnostic(edited.value);
    expect(diagnostic?.code).toBe("kernel/parameter-invalid");
    expect(diagnostic?.message).toContain("1 = X, 2 = Y, 3 = Z");
  });

  it("refuses the identity transform (zero offset, zero angle)", () => {
    const diagnostic = duplicateDiagnostic(
      buildDuplicateDocument({
        dxMm: 0,
        dyMm: 0,
        dzMm: 0,
        count: 2,
        axis: 3,
        angleDeg: 0,
      }),
    );
    expect(diagnostic?.code).toBe("kernel/parameter-invalid");
    expect(diagnostic?.message).toContain("identity transform");
  });

  it("refuses a rotation on a kernel without transformRotation", () => {
    const diagnostic = duplicateDiagnostic(
      buildDuplicateDocument({
        dxMm: 0,
        dyMm: 0,
        dzMm: 0,
        count: 2,
        axis: 3,
        angleDeg: 90,
      }),
    );
    expect(diagnostic?.code).toBe("kernel/feature-input-invalid");
    expect(diagnostic?.message).toContain("transformRotation: false");
  });

  it("refuses a single-output record that carries the duplicate kind", () => {
    // The one multi-output kind may not ride the single-output gate: an
    // empty output list is refused before the operation runs.
    const document = buildDuplicateDocument(
      {
        dxMm: 15,
        dyMm: 0,
        dzMm: 0,
        count: 2,
        axis: 3,
        angleDeg: 0,
      },
      0,
    );
    const { run } = runDuplicate(document);
    const state = run.states.get(fDuplicate);
    expect(state?.state).toBe("failed");
    expect(state?.diagnostics[0]?.message).toContain(
      "one output body per copy",
    );
  });
});
