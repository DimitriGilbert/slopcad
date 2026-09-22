/**
 * The Phase 43 pattern & mirror completion's bridge tests — the roadmap's
 * validation battery:
 *
 * - FEATURE-LEVEL ARRAYS (`patternFeature`): the asymmetric leg grid, the
 *   FEATURE RANGE (several solids repeated as one group), the
 *   SKIP-INSTANCE list and its re-drive, and the instance-count ×
 *   geometry equivalence pin — N manually-composed unions measure and
 *   tessellate BYTE-IDENTICALLY to the single pattern (the fake kernel's
 *   determinism makes composition equality provable, not approximate).
 * - PATH PATTERNS (`patternPath`): arc-length stations along a resolved
 *   sketch chain, fixed orientation on the plain fake kernel, and the
 *   tangent-follow composition pinned through the RECORDING double (the
 *   Phase 26.8 discipline — the fake kernel declares no rotation, and
 *   the bridge's capability gate is itself under test).
 * - PATTERN ON FACE (`patternFace`): the grid clipped to the referenced
 *   face's tessellated boundary through the fillet battery's reference
 *   records, the fixture TopologyView, and the datum seam's plane — on a
 *   PRISMATIC box (the whole-solid projection on the face's plane IS the
 *   face) and on a TAPERED extrusion whose projection strictly contains
 *   it, so the coplanar cut — not the projection — is what clips.
 * - THE GENERALIZED DIRECTION INPUTS: patternLinear along a DATUM AXIS
 *   and along a SKETCH LINE (the resolved chain's end−start direction).
 * - THE MIRROR MERGE OPTION: the datum-plane mirror's standalone copy
 *   (Phase 39 behavior unchanged) and its merged form (one union with
 *   the original).
 *
 * The failure taxonomy (leg bounds, skip domain, station overflow,
 * orientation domain, merge domain, capability gates, the reference and
 * datum seams) is pinned case by case as structured diagnostics.
 */

import { describe, expect, it } from "vitest";
import {
  addBody,
  addDocumentDatum,
  addDocumentParameter,
  addDocumentReference,
  addDocumentSketch,
  addFeature,
  applyCommand,
  type CadDocument,
  createBodyId,
  createDatumId,
  createDocument,
  createDocumentId,
  createFeatureId,
  createParameterId,
  createReferenceId,
  createSketchDocumentId,
  DATUM_FORMAT_VERSION,
  dimensionless,
  type DatumTopologyResolver,
  type FeatureRecordInput,
  initialRegenerationStates,
  length,
  angle as angleValue,
  mintTopologyReference,
  regenerate,
  serializeTopologyReference,
  type TopologyEntitySnapshot,
  type TopologySnapshot,
  type TopologyView,
  valueIn,
} from "@slopcad/cad-core";

import {
  type GeometryKernel,
  KERNEL_ERROR_CODES,
  type KernelSolid,
  type SweepPathSegmentInput,
  type TransformInput,
} from "./contract";
import {
  createKernelFeatureExecutor,
  type KernelPathResolution,
  type KernelProfileResolver,
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

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const pWidth = createParameterId("param_p43_box_w");
const pDepth = createParameterId("param_p43_box_d");
const pHeight = createParameterId("param_p43_box_h");
const bTarget = createBodyId("body_p43_target");
const bResult = createBodyId("body_p43_result");
const fBox = createFeatureId("feat_p43_box");

/** A fresh document with the fixture box feature and its parameters. */
function newBoxDocument(): CadDocument {
  let document = createDocument(createDocumentId("doc_p43"));
  for (const [id, name, value] of [
    [pWidth, "boxWidth", length(BOX.w)],
    [pDepth, "boxDepth", length(BOX.d)],
    [pHeight, "boxHeight", length(BOX.h)],
  ] as const) {
    const added = addDocumentParameter(document, { id, name, value });
    if (!added.ok) throw new Error(added.error.message);
    document = added.value.document;
  }
  const body = addBody(document, { id: bTarget, name: "target" });
  if (!body.ok) throw new Error(body.error.message);
  document = body.value.document;
  const result = addBody(document, { id: bResult, name: "result" });
  if (!result.ok) throw new Error(result.error.message);
  document = result.value.document;
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

/** One authoring number committed as a document parameter. */
type ParameterSpec =
  | { readonly kind: "length"; readonly value: number }
  | { readonly kind: "angle"; readonly value: number }
  | { readonly kind: "dimensionless"; readonly value: number };

/** Adds parameters (named p0, p1, …) and returns their ids in order. */
function addParameters(
  document: CadDocument,
  prefix: string,
  specs: readonly ParameterSpec[],
): {
  readonly document: CadDocument;
  readonly ids: ReturnType<typeof createParameterId>[];
} {
  let working = document;
  const ids: ReturnType<typeof createParameterId>[] = [];
  specs.forEach((spec, index) => {
    const id = createParameterId(`param_p43_${prefix}${String(index)}`);
    const value =
      spec.kind === "length"
        ? length(spec.value)
        : spec.kind === "angle"
          ? angleValue(spec.value, "rad")
          : dimensionless(spec.value);
    const added = addDocumentParameter(working, {
      id,
      name: `${prefix}${String(index)}`,
      value,
    });
    if (!added.ok) throw new Error(added.error.message);
    working = added.value.document;
    ids.push(id);
  });
  return { document: working, ids };
}

/** Adds an empty sketch record so feature sketch inputs resolve in-document. */
function withSketchRecord(document: CadDocument, id: string): CadDocument {
  const added = addDocumentSketch(document, {
    id: createSketchDocumentId(id),
    name: id,
    sketch: {
      formatVersion: 2,
      workplane: {},
      entities: [],
      constraints: [],
    },
  });
  if (!added.ok) throw new Error(added.error.message);
  return added.value.document;
}

/** The executor run's context options (the seams each kind needs). */
interface RunOptions {
  readonly paths?: (sketchId: string) => KernelPathResolution;
  readonly topology?: TopologyView;
  readonly datumTopology?: DatumTopologyResolver;
  readonly profiles?: KernelProfileResolver;
}

/** Regenerates a document against the fake kernel through the bridge. */
function runBridge(
  document: CadDocument,
  options: RunOptions = {},
  kernel: GeometryKernel = createFakeKernel(),
) {
  const bridge = createKernelFeatureExecutor(kernel, {
    document,
    bodies: new Map(),
    profiles:
      options.profiles ??
      (() => ({
        ok: false,
        error: {
          code: "document/not-found",
          message: "the Phase 43 fixtures resolve no profiles",
          input: null,
        },
      })),
    ...(options.paths === undefined ? {} : { paths: options.paths }),
    ...(options.topology === undefined ? {} : { topology: options.topology }),
    ...(options.datumTopology === undefined
      ? {}
      : { datumTopology: options.datumTopology }),
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

/** The feature's first diagnostic after a failed run. */
function failureOf(
  document: CadDocument,
  featureId: ReturnType<typeof createFeatureId>,
  options: RunOptions = {},
) {
  const { run } = runBridge(document, options);
  const state = run.states.get(featureId);
  expect(state?.state).toBe("failed");
  return state?.diagnostics[0];
}

/** Replaces one feature's inputs (the malformed-layout fixtures). */
function withFeatureInputs(
  document: CadDocument,
  featureId: ReturnType<typeof createFeatureId>,
  inputs: FeatureRecordInput["inputs"],
): CadDocument {
  return {
    ...document,
    features: document.features.map((feature) =>
      feature.id === featureId ? { ...feature, inputs } : feature,
    ),
  };
}

// ---------------------------------------------------------------------------
// The zero-ride spy (the M6 pin)
// ---------------------------------------------------------------------------

/**
 * A double over the fake kernel whose `transform` records every issued
 * translation and REJECTS an all-zero one. The pattern kinds ride their
 * zero-offset instance on the target UNTRANSLATED (`copies.push(
 * target.solid)`) rather than issuing a zero transform — on the fake
 * kernel a zero transform is byte-transparent, so the equivalence pins
 * cannot see which path ran. The double makes the discipline observable
 * both ways: a regression that starts transforming the zero instance
 * fails the feature outright here (the rejection rides through as the
 * feature's own kernel diagnostic), and the recorded list pins exactly
 * which instances the bridge did transform — the exact instance set.
 */
function zeroRideSpy(): {
  readonly kernel: GeometryKernel;
  readonly translations: readonly (readonly [number, number, number])[];
} {
  const translations: (readonly [number, number, number])[] = [];
  const base = createFakeKernel();
  const kernel: GeometryKernel = {
    ...base,
    transform: (solid: KernelSolid, input: TransformInput) => {
      const translation = [
        valueIn(input.x, "mm"),
        valueIn(input.y, "mm"),
        valueIn(input.z, "mm"),
      ] as const;
      if (
        translation[0] === 0 &&
        translation[1] === 0 &&
        translation[2] === 0
      ) {
        return {
          ok: false,
          error: {
            code: KERNEL_ERROR_CODES.unsupportedOperation,
            message:
              "the zero-ride spy rejects an all-zero transform: a pattern's zero-offset instance rides the target untranslated, it is never transformed",
            input: null,
          },
        };
      }
      translations.push(translation);
      return base.transform(solid, { x: input.x, y: input.y, z: input.z });
    },
  };
  return { kernel, translations };
}

/**
 * Asserts a recorded instance set against its expected translations: same
 * length, each world offset equal to 1e-9 — the leg directions' cos/sin
 * carry unit-rounding (cos(π/2) = 6.1e-17, so a "zero" in-plane
 * coordinate reads as a few times 1e-16), which an exact `toEqual` would
 * flag.
 */
function expectTranslations(
  recorded: readonly (readonly [number, number, number])[],
  expected: readonly (readonly [number, number, number])[],
): void {
  expect(recorded).toHaveLength(expected.length);
  for (const [index, want] of expected.entries()) {
    const got = recorded[index];
    if (got === undefined) throw new Error("a recorded translation is absent");
    expect(got[0]).toBeCloseTo(want[0], 9);
    expect(got[1]).toBeCloseTo(want[1], 9);
    expect(got[2]).toBeCloseTo(want[2], 9);
  }
}

// ---------------------------------------------------------------------------
// patternFeature: the feature-level array
// ---------------------------------------------------------------------------

const fArray = createFeatureId("feat_p43_array");

/** Builds the array document: box + one leg (count, spacing, direction) + skips. */
function buildArrayDocument(spec: {
  readonly count: number;
  readonly spacingMm: number;
  readonly directionRad: number;
  readonly skips?: readonly number[];
}): CadDocument {
  let document = newBoxDocument();
  const parameters = addParameters(document, "arr", [
    { kind: "angle", value: spec.directionRad },
    { kind: "dimensionless", value: spec.count },
    { kind: "length", value: spec.spacingMm },
    ...(spec.skips ?? []).map((skip): ParameterSpec => ({
      kind: "dimensionless",
      value: skip,
    })),
  ]);
  document = parameters.document;
  const added = addFeature(document, {
    id: fArray,
    kind: "patternFeature",
    inputs: [
      { kind: "feature", id: fBox },
      ...parameters.ids.map((id) => ({ kind: "parameter" as const, id })),
    ],
    outputs: [bResult],
  });
  if (!added.ok) throw new Error(added.error.message);
  return added.value.document;
}

describe("bridge patternFeature: the asymmetric leg array with skips", () => {
  it("executes a one-leg 3×20 array along +x (the patternLinear equivalent)", () => {
    const { kernel, bridge, run } = runBridge(
      buildArrayDocument({ count: 3, spacingMm: 20, directionRad: 0 }),
    );
    expect(run.executed).toEqual([fBox, fArray]);
    const solid = bridge.solidOf(bResult);
    expect(solid).toBeDefined();
    if (solid === undefined) return;
    assertBoundsEqual(
      unwrapKernelResult(kernel.bounds(solid), "array bounds"),
      { min: [0, 0, 0], max: [50, BOX.d, BOX.h] },
    );
    assertVolumeClose(
      unwrapKernelResult(kernel.volume(solid), "array volume"),
      3 * BOX.w * BOX.d * BOX.h,
      0.02,
    );
  });

  it("equals N manually-composed unions byte for byte (the equivalence pin)", () => {
    // The manual side: the SAME fake kernel driven directly — three boxes
    // at 0/20/40 unioned. The pattern side: one patternFeature. The fake
    // kernel is deterministic, so identical composition reads identical
    // bytes: volume, bounds, and the serialized tessellation.
    const { kernel, bridge } = runBridge(
      buildArrayDocument({ count: 3, spacingMm: 20, directionRad: 0 }),
    );
    const patterned = bridge.solidOf(bResult);
    expect(patterned).toBeDefined();
    if (patterned === undefined) return;
    const manual: ReturnType<typeof createFakeKernel> = createFakeKernel();
    const boxes = [0, 20, 40].map((x) => {
      const box = manual.createBox({
        width: length(BOX.w),
        depth: length(BOX.d),
        height: length(BOX.h),
      });
      if (!box.ok) throw new Error(box.error.message);
      if (x === 0) return box.value;
      const placed = manual.transform(box.value, {
        x: length(x),
        y: length(0),
        z: length(0),
      });
      if (!placed.ok) throw new Error(placed.error.message);
      return placed.value;
    });
    const merged = manual.union(boxes);
    if (!merged.ok) throw new Error(merged.error.message);
    expect(unwrapKernelResult(kernel.volume(patterned), "pattern volume")).toBe(
      unwrapKernelResult(manual.volume(merged.value), "manual volume"),
    );
    expect(
      unwrapKernelResult(kernel.bounds(patterned), "pattern bounds"),
    ).toEqual(unwrapKernelResult(manual.bounds(merged.value), "manual bounds"));
    expect(
      unwrapKernelResult(kernel.tessellate(patterned), "pattern soup"),
    ).toEqual(
      unwrapKernelResult(manual.tessellate(merged.value), "manual soup"),
    );
  });

  it("builds an asymmetric two-leg grid: 3 × 20 along x and 2 × 15 along y", () => {
    let document = newBoxDocument();
    const parameters = addParameters(document, "grid", [
      { kind: "angle", value: 0 },
      { kind: "dimensionless", value: 3 },
      { kind: "length", value: 20 },
      { kind: "angle", value: Math.PI / 2 },
      { kind: "dimensionless", value: 2 },
      { kind: "length", value: 15 },
    ]);
    document = parameters.document;
    const added = addFeature(document, {
      id: fArray,
      kind: "patternFeature",
      inputs: [
        { kind: "feature", id: fBox },
        ...parameters.ids.map((id) => ({ kind: "parameter" as const, id })),
      ],
      outputs: [bResult],
    });
    if (!added.ok) throw new Error(added.error.message);
    const { kernel, bridge } = runBridge(added.value.document);
    const solid = bridge.solidOf(bResult);
    expect(solid).toBeDefined();
    if (solid === undefined) return;
    // Six disjoint copies: x ∈ [0, 50], y ∈ [0, 25].
    assertBoundsEqual(unwrapKernelResult(kernel.bounds(solid), "grid bounds"), {
      min: [0, 0, 0],
      max: [50, 25, BOX.h],
    });
    assertVolumeClose(
      unwrapKernelResult(kernel.volume(solid), "grid volume"),
      6 * BOX.w * BOX.d * BOX.h,
      0.02,
    );
  });

  it("repeats the FEATURE RANGE as one group (two features per instance)", () => {
    // A second solid (a translated copy of the box) joins the range: each
    // instance transforms BOTH members, so the union covers 2 × count
    // solids — 2 members × 3 instances, all disjoint.
    const bSecond = createBodyId("body_p43_second");
    const fSecond = createFeatureId("feat_p43_second");
    let document = newBoxDocument();
    const lift = addParameters(document, "lift", [
      { kind: "length", value: 0 },
      { kind: "length", value: 0 },
      { kind: "length", value: 40 },
    ]);
    document = lift.document;
    const secondBody = addBody(document, { id: bSecond, name: "second" });
    if (!secondBody.ok) throw new Error(secondBody.error.message);
    document = secondBody.value.document;
    const second = addFeature(document, {
      id: fSecond,
      kind: "translate",
      inputs: [
        { kind: "feature", id: fBox },
        ...lift.ids.map((id) => ({ kind: "parameter" as const, id })),
      ],
      outputs: [bSecond],
    });
    if (!second.ok) throw new Error(second.error.message);
    document = second.value.document;
    const parameters = addParameters(document, "range", [
      { kind: "angle", value: 0 },
      { kind: "dimensionless", value: 3 },
      { kind: "length", value: 30 },
    ]);
    document = parameters.document;
    const added = addFeature(document, {
      id: fArray,
      kind: "patternFeature",
      inputs: [
        { kind: "feature", id: fBox },
        { kind: "feature", id: fSecond },
        ...parameters.ids.map((id) => ({ kind: "parameter" as const, id })),
      ],
      outputs: [bResult],
    });
    if (!added.ok) throw new Error(added.error.message);
    const { kernel, bridge } = runBridge(added.value.document);
    const solid = bridge.solidOf(bResult);
    expect(solid).toBeDefined();
    if (solid === undefined) return;
    // The pair spans z ∈ [0, 50] per instance; three instances along x.
    assertBoundsEqual(
      unwrapKernelResult(kernel.bounds(solid), "range bounds"),
      { min: [0, 0, 0], max: [70, BOX.d, 50] },
    );
    // Six disjoint boxes; the fake kernel's voxel quadrature carries its
    // documented band, which widens with the union's extent (the 70 × 10 ×
    // 50 span versus the single-leg fixture's 50 × 10 × 10).
    assertVolumeClose(
      unwrapKernelResult(kernel.volume(solid), "range volume"),
      6 * BOX.w * BOX.d * BOX.h,
      0.05,
    );
  });

  it("skips instances: skip 1 of 5 leaves four copies at 0/2·s/3·s/4·s", () => {
    const { kernel, bridge } = runBridge(
      buildArrayDocument({
        count: 5,
        spacingMm: 10,
        directionRad: 0,
        skips: [1],
      }),
    );
    const solid = bridge.solidOf(bResult);
    expect(solid).toBeDefined();
    if (solid === undefined) return;
    // Copies at 0, 20, 30, 40: the union spans [0, 50) — the far extent
    // is the copy at 40 plus its own 10.
    assertVolumeClose(
      unwrapKernelResult(kernel.volume(solid), "skipped volume"),
      4 * BOX.w * BOX.d * BOX.h,
      0.02,
    );
    assertBoundsEqual(
      unwrapKernelResult(kernel.bounds(solid), "skipped bounds"),
      { min: [0, 0, 0], max: [50, BOX.d, BOX.h] },
    );
  });

  it("re-drives from parameter.set: skip 1→3 and count 5→6 recomposes", () => {
    // The roadmap's skip-instances re-drive, pinned at the kernel seam:
    // BOTH the skip ordinal and the count mutate through parameter.set
    // and the regenerated arrangement is exactly the new one.
    const document = buildArrayDocument({
      count: 5,
      spacingMm: 10,
      directionRad: 0,
      skips: [1],
    });
    const skipParameter = document.features
      .find((feature) => feature.id === fArray)
      ?.inputs.filter((ref) => ref.kind === "parameter")[3];
    const countParameter = document.features
      .find((feature) => feature.id === fArray)
      ?.inputs.filter((ref) => ref.kind === "parameter")[1];
    expect(skipParameter).toBeDefined();
    expect(countParameter).toBeDefined();
    if (skipParameter === undefined || countParameter === undefined) return;
    const setSkip = applyCommand(document, {
      type: "parameter.set",
      id: skipParameter.id,
      value: dimensionless(3),
    });
    expect(setSkip.ok).toBe(true);
    if (!setSkip.ok) return;
    const setCount = applyCommand(setSkip.value, {
      type: "parameter.set",
      id: countParameter.id,
      value: dimensionless(6),
    });
    expect(setCount.ok).toBe(true);
    if (!setCount.ok) return;
    const { kernel, bridge } = runBridge(setCount.value);
    const solid = bridge.solidOf(bResult);
    expect(solid).toBeDefined();
    if (solid === undefined) return;
    // Five copies of six (instance 3 skipped): volume 5 boxes.
    assertVolumeClose(
      unwrapKernelResult(kernel.volume(solid), "re-driven volume"),
      5 * BOX.w * BOX.d * BOX.h,
      0.02,
    );
    assertBoundsEqual(
      unwrapKernelResult(kernel.bounds(solid), "re-driven bounds"),
      { min: [0, 0, 0], max: [60, BOX.d, BOX.h] },
    );
  });

  it("declines the malformed layouts: no targets, no legs, stray sketch inputs", () => {
    const base = buildArrayDocument({
      count: 3,
      spacingMm: 20,
      directionRad: 0,
    });
    const parameters =
      base.features
        .find((feature) => feature.id === fArray)
        ?.inputs.filter((ref) => ref.kind === "parameter") ?? [];
    // No target:
    expect(
      failureOf(
        withFeatureInputs(base, fArray, [
          ...parameters.map((ref) => ({ ...ref })),
        ]),
        fArray,
      ),
    ).toMatchObject({ code: "kernel/feature-input-invalid" });
    // A sketch input among the range:
    expect(
      failureOf(
        withFeatureInputs(base, fArray, [
          { kind: "feature", id: fBox },
          { kind: "sketch", id: createSketchDocumentId("skd_stray") },
          ...parameters.map((ref) => ({ ...ref })),
        ]),
        fArray,
      ),
    ).toMatchObject({ code: "kernel/feature-input-invalid" });
    // Leading parameters that do not read (angle, dimensionless, length):
    let document = newBoxDocument();
    const bad = addParameters(document, "bad", [
      { kind: "length", value: 10 },
      { kind: "dimensionless", value: 3 },
      { kind: "length", value: 20 },
    ]);
    document = bad.document;
    const added = addFeature(document, {
      id: fArray,
      kind: "patternFeature",
      inputs: [
        { kind: "feature", id: fBox },
        ...bad.ids.map((id) => ({ kind: "parameter" as const, id })),
      ],
      outputs: [bResult],
    });
    if (!added.ok) throw new Error(added.error.message);
    expect(failureOf(added.value.document, fArray)).toMatchObject({
      code: "kernel/feature-input-invalid",
    });
  });

  it("declines the leg battery: count below 2, non-integer count, zero spacing", () => {
    for (const spec of [
      { count: 1, spacingMm: 20, directionRad: 0 },
      { count: 2.5, spacingMm: 20, directionRad: 0 },
      { count: 3, spacingMm: 0, directionRad: 0 },
      { count: 3, spacingMm: -5, directionRad: 0 },
    ]) {
      const diagnostic = failureOf(buildArrayDocument(spec), fArray);
      expect(diagnostic?.code).toBe("kernel/parameter-invalid");
    }
    expect(
      failureOf(
        buildArrayDocument({ count: 1, spacingMm: 20, directionRad: 0 }),
        fArray,
      )?.message,
    ).toContain("at least 2");
    expect(
      failureOf(
        buildArrayDocument({ count: 3, spacingMm: 0, directionRad: 0 }),
        fArray,
      )?.message,
    ).toContain("strictly positive spacing");
  });

  it("declines the skip battery: out of range, duplicated, everything skipped", () => {
    expect(
      failureOf(
        buildArrayDocument({
          count: 3,
          spacingMm: 20,
          directionRad: 0,
          skips: [3],
        }),
        fArray,
      ),
    ).toMatchObject({ code: "kernel/parameter-invalid" });
    expect(
      failureOf(
        buildArrayDocument({
          count: 3,
          spacingMm: 20,
          directionRad: 0,
          skips: [1, 1],
        }),
        fArray,
      )?.message,
    ).toContain("more than once");
    expect(
      failureOf(
        buildArrayDocument({
          count: 3,
          spacingMm: 20,
          directionRad: 0,
          skips: [0, 1, 2],
        }),
        fArray,
      )?.message,
    ).toContain("skips every one");
  });

  it("declines a total over the regeneration guard limit", () => {
    expect(
      failureOf(
        buildArrayDocument({
          count: PATTERN_COUNT_LIMIT + 1,
          spacingMm: 1,
          directionRad: 0,
        }),
        fArray,
      )?.message,
    ).toContain(`at most ${PATTERN_COUNT_LIMIT}`);
  });

  it("rides instance 0 on the target untranslated (the zero-ride pin)", () => {
    // The M6 pin: the fake kernel's zero transform is byte-transparent, so
    // geometry alone cannot tell a ride from a transform. The spy rejects
    // any all-zero transform outright — the run only survives because the
    // bridge never issues one — and records the rest: exactly instances
    // 1 and 2 of the 3 × 20 array, while instance 0 rides the target into
    // the union (the volume still measures three boxes).
    const spy = zeroRideSpy();
    const { bridge, run } = runBridge(
      buildArrayDocument({ count: 3, spacingMm: 20, directionRad: 0 }),
      {},
      spy.kernel,
    );
    expect(run.executed).toEqual([fBox, fArray]);
    const solid = bridge.solidOf(bResult);
    expect(solid).toBeDefined();
    if (solid === undefined) return;
    expect(spy.translations).toEqual([
      [20, 0, 0],
      [40, 0, 0],
    ]);
    assertVolumeClose(
      unwrapKernelResult(spy.kernel.volume(solid), "ridden volume"),
      3 * BOX.w * BOX.d * BOX.h,
      0.02,
    );
  });
});

// ---------------------------------------------------------------------------
// patternPath: instances along a sketch path
// ---------------------------------------------------------------------------

const fPath = createFeatureId("feat_p43_path");

/** A stub path resolver answering one fixed chain for any sketch id. */
function pathResolverOf(
  path: readonly SweepPathSegmentInput[],
): NonNullable<RunOptions["paths"]> {
  return () => ({ ok: true, value: { path } });
}

/** Builds the path-pattern document: box + count/spacing/orientation. */
function buildPathDocument(spec: {
  readonly count: number;
  readonly spacingMm: number;
  readonly orientation: number;
}): CadDocument {
  let document = withSketchRecord(newBoxDocument(), "skd_p43_path");
  const parameters = addParameters(document, "pth", [
    { kind: "dimensionless", value: spec.count },
    { kind: "length", value: spec.spacingMm },
    { kind: "dimensionless", value: spec.orientation },
  ]);
  document = parameters.document;
  const added = addFeature(document, {
    id: fPath,
    kind: "patternPath",
    inputs: [
      { kind: "feature", id: fBox },
      { kind: "sketch", id: createSketchDocumentId("skd_p43_path") },
      ...parameters.ids.map((id) => ({ kind: "parameter" as const, id })),
    ],
    outputs: [bResult],
  });
  if (!added.ok) throw new Error(added.error.message);
  return added.value.document;
}

describe("bridge patternPath: arc-length stations along a chain", () => {
  it("distributes four copies every 10 mm up a 30 mm straight path (fixed)", () => {
    // The chain: (0,0) → (0,30) in the local XZ plane — world +z.
    const { kernel, bridge } = runBridge(
      buildPathDocument({ count: 4, spacingMm: 10, orientation: 1 }),
      {
        paths: pathResolverOf([{ kind: "line", start: [0, 0], end: [0, 30] }]),
      },
    );
    const solid = bridge.solidOf(bResult);
    expect(solid).toBeDefined();
    if (solid === undefined) return;
    // Copies stack along z: the union spans z ∈ [0, 40).
    assertBoundsEqual(unwrapKernelResult(kernel.bounds(solid), "path bounds"), {
      min: [0, 0, 0],
      max: [BOX.w, BOX.d, 40],
    });
    assertVolumeClose(
      unwrapKernelResult(kernel.volume(solid), "path volume"),
      4 * BOX.w * BOX.d * BOX.h,
      0.02,
    );
  });

  it("walks a bent chain: 10 mm up then the quarter turn (fixed)", () => {
    // Line (0,0)→(0,10), then the arc about (−10, 10) from θ=0 to θ=π/2
    // (ending at (−10, 20)). Spacing (10 + 5π)/2 puts instance 2 exactly
    // at the chain's end, instance 1 inside the bend.
    const { kernel, bridge } = runBridge(
      buildPathDocument({
        count: 3,
        spacingMm: (10 + 5 * Math.PI) / 2,
        orientation: 1,
      }),
      {
        paths: pathResolverOf([
          { kind: "line", start: [0, 0], end: [0, 10] },
          {
            kind: "arc",
            center: [-10, 10],
            radius: 10,
            startAngle: angleValue(0, "rad"),
            endAngle: angleValue(Math.PI / 2, "rad"),
          },
        ]),
      },
    );
    const solid = bridge.solidOf(bResult);
    expect(solid).toBeDefined();
    if (solid === undefined) return;
    // Instance 2 sits at the path's end (−10, 20): world x = −10, z = 20.
    assertBoundsEqual(unwrapKernelResult(kernel.bounds(solid), "bent bounds"), {
      min: [-10, 0, 0],
      max: [BOX.w, BOX.d, 30],
    });
  });

  it("refuses tangent-follow on the rotation-less fake kernel (the gate)", () => {
    const diagnostic = failureOf(
      buildPathDocument({ count: 3, spacingMm: 10, orientation: 2 }),
      fPath,
      {
        paths: pathResolverOf([{ kind: "line", start: [0, 0], end: [0, 30] }]),
      },
    );
    expect(diagnostic?.code).toBe("kernel/feature-input-invalid");
    expect(diagnostic?.message).toContain("transformRotation");
  });

  it("composes tangent-follow as +z→tangent rotations on the recording double", () => {
    // The Phase 26.8 recording discipline: the fake kernel declares no
    // rotation, so a double declares it and logs every transform the
    // bridge issues — translation only, so the pin is WHAT the bridge
    // composes (the rotation carrying world +z onto each station's
    // tangent), not the rotation geometry itself.
    const bentChain = [
      { kind: "line", start: [0, 0], end: [0, 10] },
      {
        kind: "arc",
        center: [-10, 10],
        radius: 10,
        startAngle: angleValue(0, "rad"),
        endAngle: angleValue(Math.PI / 2, "rad"),
      },
    ] as const;
    const records: {
      readonly translation: readonly [number, number, number];
      readonly rotationAngleRad: number | null;
    }[] = [];
    const base = createFakeKernel();
    const kernel: GeometryKernel = {
      ...base,
      capabilities: { ...base.capabilities, transformRotation: true },
      transform: (solid: KernelSolid, input: TransformInput) => {
        records.push({
          translation: [
            valueIn(input.x, "mm"),
            valueIn(input.y, "mm"),
            valueIn(input.z, "mm"),
          ],
          rotationAngleRad:
            input.rotation === undefined
              ? null
              : valueIn(input.rotation.angle, "rad"),
        });
        return base.transform(solid, { x: input.x, y: input.y, z: input.z });
      },
    };
    const document = buildPathDocument({
      count: 3,
      spacingMm: (10 + 5 * Math.PI) / 2,
      orientation: 2,
    });
    const bridge = createKernelFeatureExecutor(kernel, {
      document,
      bodies: new Map(),
      profiles: () => ({
        ok: false,
        error: { code: "document/not-found", message: "none", input: null },
      }),
      paths: pathResolverOf([...bentChain]),
    });
    const run = regenerate({
      features: document.features,
      states: initialRegenerationStates(document.features),
      suppressed: [],
      execute: bridge.executor,
    });
    if (!run.ok) throw new Error(run.error.message);
    expect(bridge.solidOf(bResult)).toBeDefined();
    // Two transforms (instances 1 and 2; instance 0 is the target itself):
    // instance 1 mid-bend carries the +z→tangent rotation (a right-hand
    // quarter-turnish angle about +x... measured against the analytic
    // tangent), instance 2 at the path's end rotates +z onto (−1, 0) —
    // the half turn about the world x axis.
    expect(records).toHaveLength(2);
    const endTangent = records[1]?.rotationAngleRad ?? 0;
    expect(Math.abs(Math.abs(endTangent) - Math.PI / 2)).toBeLessThan(1e-9);
    // Instance 2's station: the path's end (−10, 20) — world (−10, 0, 20).
    expect(records[1]?.translation).toEqual([-10, 0, 20]);
    // The mid-bend rotation is strictly between 0 and the end angle.
    const midTangent = Math.abs(records[0]?.rotationAngleRad ?? 0);
    expect(midTangent).toBeGreaterThan(0);
    expect(midTangent).toBeLessThan(Math.PI / 2);
  });

  it("declines stations past the chain's end", () => {
    const diagnostic = failureOf(
      buildPathDocument({ count: 4, spacingMm: 11, orientation: 1 }),
      fPath,
      {
        paths: pathResolverOf([{ kind: "line", start: [0, 0], end: [0, 30] }]),
      },
    );
    expect(diagnostic?.code).toBe("kernel/parameter-invalid");
    expect(diagnostic?.message).toContain("runs past its path");
  });

  it("declines the battery: count 1, zero spacing, orientation 3, no path seam", () => {
    const paths = pathResolverOf([
      { kind: "line", start: [0, 0], end: [0, 30] },
    ]);
    for (const spec of [
      { count: 1, spacingMm: 10, orientation: 1 },
      { count: 3, spacingMm: 0, orientation: 1 },
      { count: 3, spacingMm: 10, orientation: 3 },
    ]) {
      expect(
        failureOf(buildPathDocument(spec), fPath, { paths }),
      ).toMatchObject({
        code: "kernel/parameter-invalid",
      });
    }
    expect(
      failureOf(
        buildPathDocument({ count: 3, spacingMm: 10, orientation: 1 }),
        fPath,
      ),
    ).toMatchObject({ code: "kernel/feature-input-invalid" });
  });
});

// ---------------------------------------------------------------------------
// patternLinear's generalized direction inputs (datum axis + sketch line)
// ---------------------------------------------------------------------------

const fDirected = createFeatureId("feat_p43_directed");
const dtmAxis = createDatumId("dtm_p43_axis");

/** Adds the datum axis record (two points, origin → +z). */
function withAxisDatum(document: CadDocument): CadDocument {
  const added = addDocumentDatum(document, {
    id: dtmAxis,
    name: "the z axis",
    datum: {
      formatVersion: DATUM_FORMAT_VERSION,
      datumType: "axis",
      definition: "twoPoints",
      first: [0, 0, 0],
      second: [0, 0, 30],
    },
  });
  if (!added.ok) throw new Error(added.error.message);
  return added.value.document;
}

/** Builds the two-parameter directed pattern: box + count + spacing. */
function buildDirectedDocument(): CadDocument {
  let document = withAxisDatum(newBoxDocument());
  const parameters = addParameters(document, "dir", [
    { kind: "dimensionless", value: 3 },
    { kind: "length", value: 20 },
  ]);
  document = parameters.document;
  const added = addFeature(document, {
    id: fDirected,
    kind: "patternLinear",
    inputs: [
      { kind: "feature", id: fBox },
      { kind: "datum", id: dtmAxis },
      ...parameters.ids.map((id) => ({ kind: "parameter" as const, id })),
    ],
    outputs: [bResult],
  });
  if (!added.ok) throw new Error(added.error.message);
  return added.value.document;
}

describe("bridge patternLinear: the generalized direction inputs", () => {
  it("marches along a datum axis: the z-direction axis lifts the copies", () => {
    const { kernel, bridge } = runBridge(buildDirectedDocument());
    const solid = bridge.solidOf(bResult);
    expect(solid).toBeDefined();
    if (solid === undefined) return;
    // Three copies up the world z axis at 0/20/40.
    assertBoundsEqual(
      unwrapKernelResult(kernel.bounds(solid), "datum-directed bounds"),
      { min: [0, 0, 0], max: [BOX.w, BOX.d, 50] },
    );
  });

  it("marches along a sketch line: the chain's end−start direction", () => {
    // The chain (0,0) → (0,30): world direction (0, 0, 1) — the same
    // arrangement as the datum-axis form, arrived at through the path seam.
    let document = withSketchRecord(newBoxDocument(), "skd_p43_line");
    const parameters = addParameters(document, "ln", [
      { kind: "dimensionless", value: 3 },
      { kind: "length", value: 20 },
    ]);
    document = parameters.document;
    const added = addFeature(document, {
      id: fDirected,
      kind: "patternLinear",
      inputs: [
        { kind: "feature", id: fBox },
        { kind: "sketch", id: createSketchDocumentId("skd_p43_line") },
        ...parameters.ids.map((id) => ({ kind: "parameter" as const, id })),
      ],
      outputs: [bResult],
    });
    if (!added.ok) throw new Error(added.error.message);
    const { kernel, bridge } = runBridge(added.value.document, {
      paths: pathResolverOf([{ kind: "line", start: [0, 0], end: [0, 30] }]),
    });
    const solid = bridge.solidOf(bResult);
    expect(solid).toBeDefined();
    if (solid === undefined) return;
    assertBoundsEqual(
      unwrapKernelResult(kernel.bounds(solid), "sketch-directed bounds"),
      { min: [0, 0, 0], max: [BOX.w, BOX.d, 50] },
    );
  });

  it("declines an invalid direction sketch and a datum of the wrong kind", () => {
    // A ring whose first tangent is +x: the sweep contract's structural
    // battery answers before any direction is read — the honest reachable
    // decline for closed chains (a G1 chain starting +z at the origin
    // cannot return to it, so the battery carries the closed-ring cases).
    let document = withSketchRecord(newBoxDocument(), "skd_p43_ring");
    const parameters = addParameters(document, "cl", [
      { kind: "dimensionless", value: 3 },
      { kind: "length", value: 20 },
    ]);
    document = parameters.document;
    const added = addFeature(document, {
      id: fDirected,
      kind: "patternLinear",
      inputs: [
        { kind: "feature", id: fBox },
        { kind: "sketch", id: createSketchDocumentId("skd_p43_ring") },
        ...parameters.ids.map((id) => ({ kind: "parameter" as const, id })),
      ],
      outputs: [bResult],
    });
    if (!added.ok) throw new Error(added.error.message);
    const ring = pathResolverOf([
      { kind: "line", start: [0, 0], end: [10, 0] },
      { kind: "line", start: [10, 0], end: [10, 10] },
      { kind: "line", start: [10, 10], end: [0, 10] },
      { kind: "line", start: [0, 10], end: [0, 0] },
    ]);
    expect(
      failureOf(added.value.document, fDirected, { paths: ring })?.message,
    ).toContain("invalid direction sketch");

    // A datum PLANE where the direction needs an axis.
    const planeDatum = addDocumentDatum(newBoxDocument(), {
      id: dtmAxis,
      name: "a plane, wrongly",
      datum: {
        formatVersion: DATUM_FORMAT_VERSION,
        datumType: "plane",
        definition: "originFrame",
        origin: [0, 0, 0],
        normal: [0, 0, 1],
        xAxis: [1, 0, 0],
      },
    });
    if (!planeDatum.ok) throw new Error(planeDatum.error.message);
    const planeParameters = addParameters(planeDatum.value.document, "pl", [
      { kind: "dimensionless", value: 3 },
      { kind: "length", value: 20 },
    ]);
    const planeDirected = addFeature(planeParameters.document, {
      id: fDirected,
      kind: "patternLinear",
      inputs: [
        { kind: "feature", id: fBox },
        { kind: "datum", id: dtmAxis },
        ...planeParameters.ids.map((id) => ({
          kind: "parameter" as const,
          id,
        })),
      ],
      outputs: [bResult],
    });
    if (!planeDirected.ok) throw new Error(planeDirected.error.message);
    expect(
      failureOf(planeDirected.value.document, fDirected)?.message,
    ).toContain("datum AXIS");
  });
});

// ---------------------------------------------------------------------------
// mirror's merge option (the datum-plane form)
// ---------------------------------------------------------------------------

const fMirror = createFeatureId("feat_p43_mirror");
const dtmMirrorPlane = createDatumId("dtm_p43_mirror_plane");

/** The mirror document: box + the x = 0 datum plane (+ optional merge). */
function buildMirrorDocument(merge: number | null): CadDocument {
  let document = newBoxDocument();
  const plane = addDocumentDatum(document, {
    id: dtmMirrorPlane,
    name: "the x = 0 plane",
    datum: {
      formatVersion: DATUM_FORMAT_VERSION,
      datumType: "plane",
      definition: "originFrame",
      origin: [0, 0, 0],
      normal: [1, 0, 0],
      xAxis: [0, 1, 0],
    },
  });
  if (!plane.ok) throw new Error(plane.error.message);
  document = plane.value.document;
  const mergeParameters =
    merge === null
      ? { document, ids: [] as ReturnType<typeof createParameterId>[] }
      : addParameters(document, "mrg", [
          { kind: "dimensionless", value: merge },
        ]);
  document = mergeParameters.document;
  const added = addFeature(document, {
    id: fMirror,
    kind: "mirror",
    inputs: [
      { kind: "feature", id: fBox },
      { kind: "datum", id: dtmMirrorPlane },
      ...mergeParameters.ids.map((id) => ({ kind: "parameter" as const, id })),
    ],
    outputs: [bResult],
  });
  if (!added.ok) throw new Error(added.error.message);
  return added.value.document;
}

describe("bridge mirror: the datum-plane form's merge option", () => {
  it("stands alone without the merge parameter (Phase 39 unchanged)", () => {
    const { kernel, bridge } = runBridge(buildMirrorDocument(null));
    const solid = bridge.solidOf(bResult);
    expect(solid).toBeDefined();
    if (solid === undefined) return;
    // The reflection alone: x ∈ [−10, 0].
    assertVolumeClose(
      unwrapKernelResult(kernel.volume(solid), "mirror volume"),
      BOX.w * BOX.d * BOX.h,
      1e-9,
    );
    assertBoundsEqual(
      unwrapKernelResult(kernel.bounds(solid), "mirror bounds"),
      { min: [-10, 0, 0], max: [0, BOX.d, BOX.h] },
    );
  });

  it("merges with merge = 2: the union of the target and its reflection", () => {
    const { kernel, bridge } = runBridge(buildMirrorDocument(2));
    const solid = bridge.solidOf(bResult);
    expect(solid).toBeDefined();
    if (solid === undefined) return;
    // Disjoint halves about x = 0: exactly double.
    assertVolumeClose(
      unwrapKernelResult(kernel.volume(solid), "merged volume"),
      2 * BOX.w * BOX.d * BOX.h,
      0.02,
    );
    assertBoundsEqual(
      unwrapKernelResult(kernel.bounds(solid), "merged bounds"),
      { min: [-10, 0, 0], max: [BOX.w, BOX.d, BOX.h] },
    );
  });

  it("re-drives the merge from parameter.set: 2 → 1 returns the standalone copy", () => {
    const document = buildMirrorDocument(2);
    const mergeParameter = document.features
      .find((feature) => feature.id === fMirror)
      ?.inputs.filter((ref) => ref.kind === "parameter")[0];
    expect(mergeParameter).toBeDefined();
    if (mergeParameter === undefined) return;
    const set = applyCommand(document, {
      type: "parameter.set",
      id: mergeParameter.id,
      value: dimensionless(1),
    });
    expect(set.ok).toBe(true);
    if (!set.ok) return;
    const { kernel, bridge } = runBridge(set.value);
    const solid = bridge.solidOf(bResult);
    expect(solid).toBeDefined();
    if (solid === undefined) return;
    const volume = unwrapKernelResult(
      kernel.volume(solid),
      "standalone volume",
    );
    expect(volume).toBeCloseTo(BOX.w * BOX.d * BOX.h, 9);
  });

  it("declines a merge selector outside {1, 2}", () => {
    const diagnostic = failureOf(buildMirrorDocument(3), fMirror);
    expect(diagnostic?.code).toBe("kernel/parameter-invalid");
    expect(diagnostic?.message).toContain("1 = standalone copy or 2 = merge");
  });
});

// ---------------------------------------------------------------------------
// patternFace: the face-bounded grid
// ---------------------------------------------------------------------------

const fFace = createFeatureId("feat_p43_face");
const rFace = createReferenceId("ref_p43_top_face");

const FACE_KERNEL_ID = "fixture-kernel-p43";
const FACE_SCHEMA = "fixture-face-v1";
const FACE_ORDINAL = 2;

/** The hand-built snapshot the fixture view answers with (one face). */
function faceSnapshot(
  bodyId: ReturnType<typeof createBodyId>,
): TopologySnapshot {
  const entity: TopologyEntitySnapshot = {
    kind: "face",
    ordinal: FACE_ORDINAL,
    identity: {
      kernelId: FACE_KERNEL_ID,
      schema: FACE_SCHEMA,
      data: { hash: 77 },
    },
    geometry: {
      areaMm2: BOX.w * BOX.d,
      centroidAbsoluteMm: [BOX.w / 2, BOX.d / 2, BOX.h],
      centroidRelativeMm: [0, 0, BOX.h / 2],
    },
  };
  return {
    kernelId: FACE_KERNEL_ID,
    persistentTopology: true,
    identitySchemas: [FACE_SCHEMA],
    bodyId,
    regeneration: 0,
    entities: [entity],
  };
}

/** The fixture topology view (the fillet fixture's discipline). */
function faceView(bodyId: ReturnType<typeof createBodyId>): TopologyView {
  return {
    kernelId: FACE_KERNEL_ID,
    persistentTopology: true,
    identitySchemas: [FACE_SCHEMA],
    snapshotOf: (id) => (id === bodyId ? faceSnapshot(bodyId) : null),
  };
}

/** The datum-seam stub: the box's top face plane (z = 10, +z, +x). */
function facePlaneSeam(): NonNullable<RunOptions["datumTopology"]> {
  return {
    facePlane: () => ({
      ok: true,
      value: {
        origin: [0, 0, BOX.h],
        normal: [0, 0, 1],
        xAxis: [1, 0, 0],
      },
    }),
    faceCylinderAxis: () => ({
      ok: false,
      error: {
        code: "datum/face-not-planar",
        message: "the fixture seam resolves planes only",
        input: null,
      },
    }),
    edgeLine: () => ({
      ok: false,
      error: {
        code: "datum/face-not-planar",
        message: "the fixture seam resolves planes only",
        input: null,
      },
    }),
  };
}

/** Builds the face-pattern document: box + face reference + two leg triples. */
function buildFaceDocument(spec: {
  readonly countOne: number;
  readonly spacingOneMm: number;
  readonly directionOneRad: number;
  readonly countTwo: number;
  readonly spacingTwoMm: number;
  readonly directionTwoRad: number;
}): CadDocument {
  let document = newBoxDocument();
  const parameters = addParameters(document, "fce", [
    { kind: "angle", value: spec.directionOneRad },
    { kind: "dimensionless", value: spec.countOne },
    { kind: "length", value: spec.spacingOneMm },
    { kind: "angle", value: spec.directionTwoRad },
    { kind: "dimensionless", value: spec.countTwo },
    { kind: "length", value: spec.spacingTwoMm },
  ]);
  document = parameters.document;
  // Mint the persistent face reference against the fixture snapshot (the
  // fillet fixture's exact minting path).
  const snapshot = faceSnapshot(bTarget);
  const provenance = {
    bodyId: bTarget,
    featurePath: [fBox],
  };
  const minted = mintTopologyReference(snapshot, FACE_ORDINAL, provenance, {
    id: rFace,
    kind: "face",
  });
  if (!minted.ok) throw new Error(minted.error.message);
  const referenced = addDocumentReference(document, {
    id: rFace,
    name: "the top face",
    reference: { ...serializeTopologyReference(minted.value) },
  });
  if (!referenced.ok) throw new Error(referenced.error.message);
  document = referenced.value.document;
  const added = addFeature(document, {
    id: fFace,
    kind: "patternFace",
    inputs: [
      { kind: "feature", id: fBox },
      { kind: "reference", id: rFace },
      ...parameters.ids.map((id) => ({ kind: "parameter" as const, id })),
    ],
    outputs: [bResult],
  });
  if (!added.ok) throw new Error(added.error.message);
  return added.value.document;
}

const faceRunOptions: RunOptions = {
  topology: faceView(bTarget),
  datumTopology: facePlaneSeam(),
};

// ---------------------------------------------------------------------------
// patternFace's NON-PRISMATIC fixture: the tapered extrusion whose
// whole-solid projection strictly contains the referenced face
// ---------------------------------------------------------------------------

/** The tapered target's extents (mm): base square, far inset, height. */
const TAPER = { base: 20, inset: 5, height: 10 } as const;

const bTapered = createBodyId("body_p43_tapered");
const fTapered = createFeatureId("feat_p43_tapered");
const rTaperedFace = createReferenceId("ref_p43_taper_top_face");

const TAPERED_KERNEL_ID = "fixture-kernel-p43-tapered";
const TAPERED_SCHEMA = "fixture-face-v1";
const TAPERED_FACE_ORDINAL = 2;
const TAPERED_SKETCH = "skd_p43_taper";

/**
 * The taper angle whose far-end inset is exactly `TAPER.inset`:
 * inset = height · tan(angle), so the angle is atan(inset / height) — the
 * top face is the TAPER.base square inset by 5 on every side.
 */
const TAPER_ANGLE_RAD = Math.atan(TAPER.inset / TAPER.height);

/** The profile resolver: the base square on the identity workplane. */
const taperedProfileResolver: KernelProfileResolver = () => ({
  ok: true,
  value: {
    loop: [
      { kind: "line", start: [0, 0], end: [TAPER.base, 0] },
      { kind: "line", start: [TAPER.base, 0], end: [TAPER.base, TAPER.base] },
      {
        kind: "line",
        start: [TAPER.base, TAPER.base],
        end: [0, TAPER.base],
      },
      { kind: "line", start: [0, TAPER.base], end: [0, 0] },
    ],
    placement: {
      rotation: { axis: [0, 0, 1] as const, angle: angleValue(0, "rad") },
      translation: { x: length(0), y: length(0), z: length(0) },
    },
  },
});

/** The tapered target's hand-built snapshot (one face: the inset top). */
function taperedFaceSnapshot(
  bodyId: ReturnType<typeof createBodyId>,
): TopologySnapshot {
  const side = TAPER.base - 2 * TAPER.inset;
  const entity: TopologyEntitySnapshot = {
    kind: "face",
    ordinal: TAPERED_FACE_ORDINAL,
    identity: {
      kernelId: TAPERED_KERNEL_ID,
      schema: TAPERED_SCHEMA,
      data: { hash: 78 },
    },
    geometry: {
      areaMm2: side * side,
      centroidAbsoluteMm: [TAPER.base / 2, TAPER.base / 2, TAPER.height],
      centroidRelativeMm: [0, 0, TAPER.height / 2],
    },
  };
  return {
    kernelId: TAPERED_KERNEL_ID,
    persistentTopology: true,
    identitySchemas: [TAPERED_SCHEMA],
    bodyId,
    regeneration: 0,
    entities: [entity],
  };
}

/** The tapered fixture's topology view. */
function taperedFaceView(
  bodyId: ReturnType<typeof createBodyId>,
): TopologyView {
  return {
    kernelId: TAPERED_KERNEL_ID,
    persistentTopology: true,
    identitySchemas: [TAPERED_SCHEMA],
    snapshotOf: (id) => (id === bodyId ? taperedFaceSnapshot(bodyId) : null),
  };
}

/** The tapered fixture's datum seam: the inset top face's plane (z = 10). */
function taperedPlaneSeam(): NonNullable<RunOptions["datumTopology"]> {
  return {
    facePlane: () => ({
      ok: true,
      value: {
        origin: [0, 0, TAPER.height],
        normal: [0, 0, 1],
        xAxis: [1, 0, 0],
      },
    }),
    faceCylinderAxis: () => ({
      ok: false,
      error: {
        code: "datum/face-not-planar",
        message: "the fixture seam resolves planes only",
        input: null,
      },
    }),
    edgeLine: () => ({
      ok: false,
      error: {
        code: "datum/face-not-planar",
        message: "the fixture seam resolves planes only",
        input: null,
      },
    }),
  };
}

/** The tapered face-pattern document: drafted extrude + reference + grid. */
function buildTaperedFaceDocument(): CadDocument {
  let document = withSketchRecord(
    createDocument(createDocumentId("doc_p43_taper_face")),
    TAPERED_SKETCH,
  );
  const parameters = addParameters(document, "tpr", [
    { kind: "length", value: TAPER.height },
    { kind: "angle", value: TAPER_ANGLE_RAD },
    { kind: "angle", value: 0 },
    { kind: "dimensionless", value: 3 },
    { kind: "length", value: 7 },
    { kind: "angle", value: Math.PI / 2 },
    { kind: "dimensionless", value: 3 },
    { kind: "length", value: 7 },
  ]);
  document = parameters.document;
  const [pDistance, pTaper, ...gridIds] = parameters.ids;
  if (pDistance === undefined || pTaper === undefined) {
    throw new Error("the tapered fixture mints its extrude parameters");
  }
  const taperedBody = addBody(document, { id: bTapered, name: "tapered" });
  if (!taperedBody.ok) throw new Error(taperedBody.error.message);
  document = taperedBody.value.document;
  const resultBody = addBody(document, { id: bResult, name: "result" });
  if (!resultBody.ok) throw new Error(resultBody.error.message);
  document = resultBody.value.document;
  const extrude = addFeature(document, {
    id: fTapered,
    kind: "extrude",
    inputs: [
      { kind: "sketch", id: createSketchDocumentId(TAPERED_SKETCH) },
      { kind: "parameter", id: pDistance },
      { kind: "parameter", id: pTaper },
    ],
    outputs: [bTapered],
  });
  if (!extrude.ok) throw new Error(extrude.error.message);
  document = extrude.value.document;
  const snapshot = taperedFaceSnapshot(bTapered);
  const minted = mintTopologyReference(
    snapshot,
    TAPERED_FACE_ORDINAL,
    { bodyId: bTapered, featurePath: [fTapered] },
    { id: rTaperedFace, kind: "face" },
  );
  if (!minted.ok) throw new Error(minted.error.message);
  const referenced = addDocumentReference(document, {
    id: rTaperedFace,
    name: "the tapered top face",
    reference: { ...serializeTopologyReference(minted.value) },
  });
  if (!referenced.ok) throw new Error(referenced.error.message);
  document = referenced.value.document;
  const added = addFeature(document, {
    id: fFace,
    kind: "patternFace",
    inputs: [
      { kind: "feature", id: fTapered },
      { kind: "reference", id: rTaperedFace },
      ...gridIds.map((id) => ({ kind: "parameter" as const, id })),
    ],
    outputs: [bResult],
  });
  if (!added.ok) throw new Error(added.error.message);
  return added.value.document;
}

const taperedRunOptions: RunOptions = {
  topology: taperedFaceView(bTapered),
  datumTopology: taperedPlaneSeam(),
  profiles: taperedProfileResolver,
};

describe("bridge patternFace: the grid clipped to the face boundary", () => {
  it("places the full in-face grid: 3 × 2 candidates at 4 mm all inside", () => {
    const { kernel, bridge } = runBridge(
      buildFaceDocument({
        countOne: 3,
        spacingOneMm: 4,
        directionOneRad: 0,
        countTwo: 2,
        spacingTwoMm: 4,
        directionTwoRad: Math.PI / 2,
      }),
      faceRunOptions,
    );
    const solid = bridge.solidOf(bResult);
    expect(solid).toBeDefined();
    if (solid === undefined) return;
    // Six overlapping copies tile [0, 18] × [0, 14] × [0, 10] exactly.
    assertVolumeClose(
      unwrapKernelResult(kernel.volume(solid), "face grid volume"),
      18 * 14 * 10,
      0.02,
    );
    assertBoundsEqual(
      unwrapKernelResult(kernel.bounds(solid), "face grid bounds"),
      { min: [0, 0, 0], max: [18, 14, 10] },
    );
  });

  it("clips the off-face candidates: spacing 8 drops the far row and column", () => {
    const { kernel, bridge } = runBridge(
      buildFaceDocument({
        countOne: 3,
        spacingOneMm: 8,
        directionOneRad: 0,
        countTwo: 3,
        spacingTwoMm: 8,
        directionTwoRad: Math.PI / 2,
      }),
      faceRunOptions,
    );
    const solid = bridge.solidOf(bResult);
    expect(solid).toBeDefined();
    if (solid === undefined) return;
    // Candidates at u, v ∈ {0, 8, 16}: only {0, 8} × {0, 8} fall inside the
    // 10 × 10 face — four copies tile [0, 18] × [0, 18].
    assertVolumeClose(
      unwrapKernelResult(kernel.volume(solid), "clipped volume"),
      18 * 18 * 10,
      0.02,
    );
  });

  it("declines a grid that misses the face entirely", () => {
    const diagnostic = failureOf(
      buildFaceDocument({
        countOne: 2,
        spacingOneMm: 200,
        directionOneRad: 0,
        countTwo: 2,
        spacingTwoMm: 200,
        directionTwoRad: Math.PI / 2,
      }),
      fFace,
      faceRunOptions,
    );
    expect(diagnostic?.code).toBe("kernel/operation-failed");
    expect(diagnostic?.message).toContain("inside the bounding face");
  });

  it("declines without the resolution seams (no view, no datum seam)", () => {
    const document = buildFaceDocument({
      countOne: 3,
      spacingOneMm: 4,
      directionOneRad: 0,
      countTwo: 2,
      spacingTwoMm: 4,
      directionTwoRad: Math.PI / 2,
    });
    const withoutView = failureOf(document, fFace, {
      datumTopology: facePlaneSeam(),
    });
    expect(withoutView?.message).toContain("no topology view");
    const withoutSeam = failureOf(document, fFace, {
      topology: faceView(bTarget),
    });
    expect(withoutSeam?.message).toContain("no datum topology resolver");
  });

  it("declines the leg battery on the face grid (count 1, zero spacing)", () => {
    for (const spec of [
      {
        countOne: 1,
        spacingOneMm: 4,
        directionOneRad: 0,
        countTwo: 2,
        spacingTwoMm: 4,
        directionTwoRad: Math.PI / 2,
      },
      {
        countOne: 3,
        spacingOneMm: 0,
        directionOneRad: 0,
        countTwo: 2,
        spacingTwoMm: 4,
        directionTwoRad: Math.PI / 2,
      },
    ]) {
      expect(
        failureOf(buildFaceDocument(spec), fFace, faceRunOptions),
      ).toMatchObject({ code: "kernel/parameter-invalid" });
    }
  });

  it("clips a TAPERED target to the face, not its whole-solid projection", () => {
    // THE NON-PRISMATIC DISCRIMINATOR: the Phase 41 drafted extrusion's
    // base (20 × 20 at z = 0) strictly contains its inset top face
    // (10 × 10 at z = 10), so the boundary the coplanar cut keeps — the
    // top face alone — is a strict subset of the solid's projection onto
    // the plane. The grid's nine candidates {0, 7, 14} × {0, 7, 14} split:
    // exactly (7, 7), (7, 14), (14, 7), (14, 14) fall inside the FACE; the
    // axes-hugging candidates fall inside only the PROJECTION, so a
    // boundary test that leaned on it (a loosened coplanar tolerance
    // admitting the side and base triangles) would place nine instances
    // where the face places four. The spy records the exact instance set;
    // the union's bounds carry it geometrically — min (7, 7, 0), never
    // the projection's (0, 0, 0).
    const spy = zeroRideSpy();
    const { bridge } = runBridge(
      buildTaperedFaceDocument(),
      taperedRunOptions,
      spy.kernel,
    );
    const solid = bridge.solidOf(bResult);
    expect(solid).toBeDefined();
    if (solid === undefined) return;
    expectTranslations(spy.translations, [
      [7, 7, 0],
      [7, 14, 0],
      [14, 7, 0],
      [14, 14, 0],
    ]);
    assertBoundsEqual(
      unwrapKernelResult(spy.kernel.bounds(solid), "tapered face bounds"),
      { min: [7, 7, 0], max: [34, 34, TAPER.height] },
    );
  });

  it("rides the grid's zero-offset instance on the target (the zero-ride pin)", () => {
    // The M6 pin on the face grid: candidate (0, 0) always qualifies, and
    // it rides the target UNTRANSLATED — never a zero transform (the spy
    // rejects one outright). Only the five in-face, non-zero candidates
    // transform, and the union still tiles the full 18 × 14 region.
    const spy = zeroRideSpy();
    const { bridge } = runBridge(
      buildFaceDocument({
        countOne: 3,
        spacingOneMm: 4,
        directionOneRad: 0,
        countTwo: 2,
        spacingTwoMm: 4,
        directionTwoRad: Math.PI / 2,
      }),
      faceRunOptions,
      spy.kernel,
    );
    const solid = bridge.solidOf(bResult);
    expect(solid).toBeDefined();
    if (solid === undefined) return;
    expectTranslations(spy.translations, [
      [0, 4, 0],
      [4, 0, 0],
      [4, 4, 0],
      [8, 0, 0],
      [8, 4, 0],
    ]);
    assertVolumeClose(
      unwrapKernelResult(spy.kernel.volume(solid), "ridden face volume"),
      18 * 14 * 10,
      0.02,
    );
  });
});
