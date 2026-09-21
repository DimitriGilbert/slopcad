/**
 * The Phase 38 cross-kernel equivalence suite: the SWEEP and LOFT FEATURES
 * — document records through the executor bridge, not raw kernel calls —
 * judged across the implementing kernels in the
 * `cross-kernel-equivalence.test.ts` style. The SAME documents (sketch
 * seams resolving the same loops/paths, the same feature input layouts)
 * run through `createKernelFeatureExecutor` on OCCT (exact BREP), the fake
 * kernel (the analytic Pappus/Simpson reference), and JSCAD (station
 * loft); Manifold, which declares neither capability, is asserted to
 * decline at the BRIDGE gate as a feature diagnostic.
 *
 * Band policy (the Phase 21 suite's, inherited):
 *
 * 1. Straight-edge profiles sweep/loft EXACTLY on every implementing
 *    kernel (fake Pappus/Simpson exact over straight-edge polygons; OCCT's
 *    pipe and ruled ThruSections probed exact; JSCAD's slice loft exact on
 *    planar-wall untwisted fixtures), so cross-kernel volume agreement and
 *    analytic agreement are pinned at the 1e-9 relative band and bounds at
 *    1e-9 mm.
 * 2. The quarter-bend sweep agrees at the Pappus value
 *    `A·L + |θ|·|d̄|·A` on the fake and OCCT kernels (JSCAD's curved-path
 *    station band keeps it out of the exact tier there — documented, not
 *    asserted).
 * 3. Manifold's verdict is structural: the bridge refuses with
 *    `kernel/feature-input-invalid` naming the sweep/loft capability —
 *    the feature-level gate, never a half-built solid.
 */

import { beforeAll, describe, expect, it } from "vitest";
import {
  addBody,
  addDocumentParameter,
  addDocumentSketch,
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
  type FeatureRecordInput,
  initialRegenerationStates,
  length,
  regenerate,
} from "@slopcad/cad-core";
import {
  createKernelFeatureExecutor,
  type KernelPathResolver,
  type KernelProfileResolver,
  type GeometryKernel,
  KERNEL_BACKEND_IDS,
  type KernelSolid,
  unwrapKernelResult,
} from "@slopcad/cad-kernel";
import {
  EXACT_BOUNDS_TOLERANCE,
  EXACT_VOLUME_TOLERANCE,
} from "@slopcad/cad-kernel/contract-suite";
import { createFakeKernel } from "@slopcad/cad-kernel";
import { createJscadKernel } from "@slopcad/cad-jscad";
import {
  createManifoldRuntime,
  manifoldKernelFromRuntime,
  type ManifoldRuntime,
} from "@slopcad/cad-kernel-manifold";
import {
  assertBoundsEqual,
  assertVolumeClose,
} from "@slopcad/cad-kernel/test-utils";

import { occtKernelFromRuntime } from "./occt-kernel";
import { createOcctRuntime, type OcctRuntime } from "./occt-runtime";

const bOutput = createBodyId("body_output");
const fFeature = createFeatureId("feat_feature");
const skProfile = createSketchDocumentId("skd_profile");
const skPath = createSketchDocumentId("skd_path");
const skSection1 = createSketchDocumentId("skd_s1");
const skSection2 = createSketchDocumentId("skd_s2");
const st0 = createParameterId("param_z0");
const st1 = createParameterId("param_z1");

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

const PLACEMENT = {
  rotation: { axis: [0, 0, 1] as const, angle: angle(0) },
  translation: { x: length(0), y: length(0), z: length(0) },
};

/** The ±5 square profile centered on the local origin. */
const SQUARE_LOOP = [
  { kind: "line" as const, start: [-5, -5] as const, end: [5, -5] as const },
  { kind: "line" as const, start: [5, -5] as const, end: [5, 5] as const },
  { kind: "line" as const, start: [5, 5] as const, end: [-5, 5] as const },
  { kind: "line" as const, start: [-5, 5] as const, end: [-5, -5] as const },
];

/** The ±10 square (the loft's section 1). */
const BIG_SQUARE_LOOP = [
  {
    kind: "line" as const,
    start: [-10, -10] as const,
    end: [10, -10] as const,
  },
  { kind: "line" as const, start: [10, -10] as const, end: [10, 10] as const },
  { kind: "line" as const, start: [10, 10] as const, end: [-10, 10] as const },
  {
    kind: "line" as const,
    start: [-10, 10] as const,
    end: [-10, -10] as const,
  },
];

const STRAIGHT_PATH = [
  { kind: "line" as const, start: [0, 0] as const, end: [0, 40] as const },
];

/** Straight leg then a radius-10 CCW quarter bend. */
const BENT_PATH = [
  { kind: "line" as const, start: [0, 0] as const, end: [0, 10] as const },
  {
    kind: "arc" as const,
    center: [-10, 10] as const,
    radius: 10,
    startAngle: angle(0),
    endAngle: angle(Math.PI / 2),
  },
];

const profileResolver: KernelProfileResolver = (sketchId) => {
  if (sketchId === skProfile) {
    return { ok: true, value: { loop: SQUARE_LOOP, placement: PLACEMENT } };
  }
  if (sketchId === skSection1) {
    return { ok: true, value: { loop: BIG_SQUARE_LOOP, placement: PLACEMENT } };
  }
  if (sketchId === skSection2) {
    return { ok: true, value: { loop: SQUARE_LOOP, placement: PLACEMENT } };
  }
  return {
    ok: false,
    error: {
      code: "document/not-found",
      message: `no sketch ${String(sketchId)}`,
      input: sketchId,
    },
  };
};

const pathResolverOf =
  (path: typeof STRAIGHT_PATH | typeof BENT_PATH): KernelPathResolver =>
  (sketchId) => {
    if (sketchId !== skPath) {
      return {
        ok: false,
        error: {
          code: "document/not-found",
          message: `no sketch ${String(sketchId)}`,
          input: sketchId,
        },
      };
    }
    return { ok: true, value: { path } };
  };

/** Builds the sweep feature document (two sketch records, no parameters). */
function sweepDocument(): CadDocument {
  let document = createDocument(createDocumentId("doc_xk_sweep"));
  for (const [id, name] of [
    [skProfile, "sweep profile"],
    [skPath, "sweep path"],
  ] as const) {
    const added = addDocumentSketch(document, {
      id,
      name,
      sketch: SKETCH_PAYLOAD,
    });
    if (!added.ok) throw new Error(added.error.message);
    document = added.value.document;
  }
  const body = addBody(document, { id: bOutput, name: "tube" });
  if (!body.ok) throw new Error(body.error.message);
  document = body.value.document;
  const feature: FeatureRecordInput = {
    id: fFeature,
    kind: "sweep",
    inputs: [
      { kind: "sketch", id: skProfile },
      { kind: "sketch", id: skPath },
    ],
    outputs: [bOutput],
  };
  const added = addFeature(document, feature);
  if (!added.ok) throw new Error(added.error.message);
  document = added.value.document;
  return document;
}

/** Builds the loft feature document (two sections + two station parameters). */
function loftDocument(z0: number, z1: number): CadDocument {
  let document = createDocument(createDocumentId("doc_xk_loft"));
  for (const [id, name] of [
    [skSection1, "section 1"],
    [skSection2, "section 2"],
  ] as const) {
    const added = addDocumentSketch(document, {
      id,
      name,
      sketch: SKETCH_PAYLOAD,
    });
    if (!added.ok) throw new Error(added.error.message);
    document = added.value.document;
  }
  for (const [id, name, value] of [
    [st0, "loftZ0", z0],
    [st1, "loftZ1", z1],
  ] as const) {
    const added = addDocumentParameter(document, {
      id,
      name,
      value: length(value),
    });
    if (!added.ok) throw new Error(added.error.message);
    document = added.value.document;
  }
  const body = addBody(document, { id: bOutput, name: "loft" });
  if (!body.ok) throw new Error(body.error.message);
  document = body.value.document;
  const feature: FeatureRecordInput = {
    id: fFeature,
    kind: "loft",
    inputs: [
      { kind: "sketch", id: skSection1 },
      { kind: "parameter", id: st0 },
      { kind: "sketch", id: skSection2 },
      { kind: "parameter", id: st1 },
    ],
    outputs: [bOutput],
  };
  const added = addFeature(document, feature);
  if (!added.ok) throw new Error(added.error.message);
  document = added.value.document;
  return document;
}

interface RunOutcome {
  readonly ok: boolean;
  readonly solid: KernelSolid | undefined;
  readonly diagnosticCode: string | null;
  readonly diagnosticMessage: string;
}

/** One bridge run of the document against a kernel; the body's solid out. */
function runBridge(
  document: CadDocument,
  kernel: GeometryKernel,
  options: {
    readonly path?: typeof STRAIGHT_PATH | typeof BENT_PATH;
    readonly stations?: Readonly<Record<string, number>>;
  } = {},
): RunOutcome {
  let effective = document;
  for (const [id, mm] of Object.entries(options.stations ?? {})) {
    const set = applyCommand(effective, {
      type: "parameter.set",
      id: createParameterId(id),
      value: length(mm),
    });
    if (!set.ok) throw new Error(set.error.message);
    effective = set.value;
  }
  const bridge = createKernelFeatureExecutor(kernel, {
    document: effective,
    bodies: new Map(),
    profiles: profileResolver,
    paths:
      options.path === undefined ? undefined : pathResolverOf(options.path),
  });
  const run = regenerate({
    features: effective.features,
    states: initialRegenerationStates(effective.features),
    suppressed: [],
    execute: bridge.executor,
  });
  if (!run.ok) throw new Error(run.error.message);
  const state = run.value.states.get(fFeature);
  return {
    ok: state?.state === "valid",
    solid: bridge.solidOf(bOutput),
    diagnosticCode: state?.diagnostics[0]?.code ?? null,
    diagnosticMessage: state?.diagnostics[0]?.message ?? "",
  };
}

describe("cross-kernel feature equivalence: bridge sweep and loft", () => {
  let occtRuntime: OcctRuntime;
  let manifoldRuntime: ManifoldRuntime;

  beforeAll(async () => {
    [occtRuntime, manifoldRuntime] = await Promise.all([
      createOcctRuntime(),
      createManifoldRuntime(),
    ]);
  });

  const makeOcct = (): GeometryKernel => occtKernelFromRuntime(occtRuntime);
  const makeManifold = (): GeometryKernel =>
    manifoldKernelFromRuntime(manifoldRuntime);
  const makeJscad = (): GeometryKernel => createJscadKernel();

  it("runs the same sweep document on three distinct registry kernels", () => {
    const occt = makeOcct();
    const fake = createFakeKernel();
    const jscad = makeJscad();
    const manifold = makeManifold();
    for (const kernel of [occt, fake, jscad, manifold]) {
      expect(KERNEL_BACKEND_IDS).toContain(kernel.id);
    }
    // The capability matrix the bridge gates on: Manifold declines both,
    // the other three implement both.
    expect(manifold.capabilities.sweep).toBe(false);
    expect(manifold.capabilities.loft).toBe(false);
    expect(occt.capabilities.sweep).toBe(true);
    expect(occt.capabilities.loft).toBe(true);
    expect(fake.capabilities.sweep).toBe(true);
    expect(fake.capabilities.loft).toBe(true);
    expect(jscad.capabilities.sweep).toBe(true);
    expect(jscad.capabilities.loft).toBe(true);
  });

  it("sweeps the straight-spine document identically: analytic prism, exact bounds", () => {
    const document = sweepDocument();
    const expectedVolume = 100 * 40;
    const expectedBounds = {
      min: [-5, -5, 0] as const,
      max: [5, 5, 40] as const,
    };
    for (const kernel of [makeOcct(), createFakeKernel(), makeJscad()]) {
      const outcome = runBridge(document, kernel, { path: STRAIGHT_PATH });
      expect(outcome.ok, `${kernel.id} run`).toBe(true);
      if (!outcome.ok || outcome.solid === undefined) continue;
      assertVolumeClose(
        unwrapKernelResult(kernel.volume(outcome.solid), `${kernel.id} volume`),
        expectedVolume,
        EXACT_VOLUME_TOLERANCE,
      );
      assertBoundsEqual(
        unwrapKernelResult(kernel.bounds(outcome.solid), `${kernel.id} bounds`),
        expectedBounds,
        EXACT_BOUNDS_TOLERANCE,
      );
    }
  });

  it("sweeps the bent document at the Pappus value on the exact kernels", () => {
    const document = sweepDocument();
    // Line piece A·L = 100×10 plus the quarter-bend |θ|·|d̄|·A = (π/2)·10·100.
    const expectedVolume = 1000 + 500 * Math.PI;
    const expectedBounds = {
      min: [-10, -5, 0] as const,
      max: [5, 5, 25] as const,
    };
    for (const kernel of [makeOcct(), createFakeKernel()]) {
      const outcome = runBridge(document, kernel, { path: BENT_PATH });
      expect(outcome.ok, `${kernel.id} run`).toBe(true);
      if (!outcome.ok || outcome.solid === undefined) continue;
      assertVolumeClose(
        unwrapKernelResult(kernel.volume(outcome.solid), `${kernel.id} volume`),
        expectedVolume,
        EXACT_VOLUME_TOLERANCE,
      );
      assertBoundsEqual(
        unwrapKernelResult(kernel.bounds(outcome.solid), `${kernel.id} bounds`),
        expectedBounds,
        EXACT_BOUNDS_TOLERANCE,
      );
    }
    // JSCAD's curved-path station loft sits in its documented band of the
    // same Pappus value — agreement, not exactness. One instance runs the
    // bridge AND the measurement: handles are instance-owned.
    const jscad = makeJscad();
    const jscadOutcome = runBridge(document, jscad, { path: BENT_PATH });
    expect(jscadOutcome.ok).toBe(true);
    if (jscadOutcome.ok && jscadOutcome.solid !== undefined) {
      assertVolumeClose(
        unwrapKernelResult(jscad.volume(jscadOutcome.solid), "jscad volume"),
        expectedVolume,
        0.02,
      );
    }
  });

  it("lofts the same two-section document identically across stations", () => {
    // The section pair is ±10 → ±5 (area 400 → 100): the cross-section side
    // is linear in t, so the ruled morph's volume is Simpson-exact —
    // 1400·h/6 for station height h — on every implementing kernel.
    const prism = loftDocument(0, 20);
    const expectedPrism = {
      volume: (1400 * 20) / 6,
      bounds: { min: [-10, -10, 0] as const, max: [10, 10, 20] as const },
    };
    const taper = loftDocument(0, 15);
    const expectedTaper = {
      volume: (1400 * 15) / 6,
      bounds: { min: [-10, -10, 0] as const, max: [10, 10, 15] as const },
    };
    // Volumes agree at the exact tier on all three. Bounds do not: OCCT's
    // BREP bounding containers carry the shape tolerance (probed 1e-7 mm
    // here; the Phase 21 suite uses a 0.05 mm cross-kernel loft band for
    // the same reason) and JSCAD's BSP output is a float-precision
    // approximation of the true ruled boundary — both ride a documented
    // 1e-6 mm band, the fake kernel's analytic bounds stay exact.
    const boundsToleranceOf = (kernel: GeometryKernel): number =>
      kernel.id === "fake" ? EXACT_BOUNDS_TOLERANCE : 1e-6;
    for (const kernel of [makeOcct(), createFakeKernel(), makeJscad()]) {
      for (const [document, expected] of [
        [prism, expectedPrism],
        [taper, expectedTaper],
      ] as const) {
        const outcome = runBridge(document, kernel);
        expect(outcome.ok, `${kernel.id} run`).toBe(true);
        if (!outcome.ok || outcome.solid === undefined) continue;
        assertVolumeClose(
          unwrapKernelResult(
            kernel.volume(outcome.solid),
            `${kernel.id} volume`,
          ),
          expected.volume,
          EXACT_VOLUME_TOLERANCE,
        );
        assertBoundsEqual(
          unwrapKernelResult(
            kernel.bounds(outcome.solid),
            `${kernel.id} bounds`,
          ),
          expected.bounds,
          boundsToleranceOf(kernel),
        );
      }
    }
  });

  it("re-drives the loft document identically on both exact kernels after parameter.set", () => {
    const document = loftDocument(0, 20);
    for (const kernel of [makeOcct(), createFakeKernel()]) {
      const outcome = runBridge(document, kernel, { stations: { [st1]: 50 } });
      expect(outcome.ok, `${kernel.id} run`).toBe(true);
      if (!outcome.ok || outcome.solid === undefined) continue;
      assertVolumeClose(
        unwrapKernelResult(kernel.volume(outcome.solid), `${kernel.id} volume`),
        (1400 * 50) / 6,
        EXACT_VOLUME_TOLERANCE,
      );
    }
  });

  it("declines the sweep and loft documents on Manifold at the bridge gate", () => {
    const manifold = makeManifold();
    const sweepOutcome = runBridge(sweepDocument(), manifold, {
      path: STRAIGHT_PATH,
    });
    expect(sweepOutcome.ok).toBe(false);
    expect(sweepOutcome.solid).toBeUndefined();
    expect(sweepOutcome.diagnosticCode).toBe("kernel/feature-input-invalid");
    expect(sweepOutcome.diagnosticMessage).toContain("sweep capability");
    const loftOutcome = runBridge(loftDocument(0, 20), manifold);
    expect(loftOutcome.ok).toBe(false);
    expect(loftOutcome.solid).toBeUndefined();
    expect(loftOutcome.diagnosticCode).toBe("kernel/feature-input-invalid");
    expect(loftOutcome.diagnosticMessage).toContain("loft capability");
  });
});
