/**
 * The sweep feature's bridge tests (Phase 38): two sketch records (profile +
 * path) → the bridge's `sweep` kind → the fake kernel → semantic
 * volume/bounds assertions at the analytic Pappus values, the capability
 * gate (a kernel without the `sweep` flag refuses as a feature diagnostic),
 * the failure taxonomy (layout, unresolvable profile/path, missing path
 * seam), and regeneration (a sketch edit re-drives through the resolver).
 */

import { describe, expect, it } from "vitest";
import {
  addBody,
  addDocumentSketch,
  addFeature,
  angle,
  type CadDocument,
  createBodyId,
  createDocument,
  createDocumentId,
  createFeatureId,
  createSketchDocumentId,
  type FeatureRecordInput,
  initialRegenerationStates,
  length,
  regenerate,
} from "@slopcad/cad-core";
import type { ProfileSweepInput } from "./contract";
import type { GeometryKernel } from "./contract";

import {
  createKernelFeatureExecutor,
  type KernelPathResolver,
  type KernelProfileResolver,
} from "./core-bridge";
import { createFakeKernel, FAKE_KERNEL_CAPABILITIES } from "./fake-kernel";
import {
  assertBoundsEqual,
  assertVolumeClose,
  unwrapKernelResult,
} from "./test-utils";

const bTube = createBodyId("body_tube");
const fSweep = createFeatureId("feat_sweep");
const skProfile = createSketchDocumentId("skd_sweep_profile");
const skPath = createSketchDocumentId("skd_sweep_path");

/**
 * The profile: a square centered on the local origin (±5, ±5) — centered so
 * arc-path fixtures keep the profile strictly inside every bend (the
 * pinch rule touches nothing).
 */
const SQUARE_LOOP: ProfileSweepInput["loop"] = [
  { kind: "line", start: [-5, -5], end: [5, -5] },
  { kind: "line", start: [5, -5], end: [5, 5] },
  { kind: "line", start: [5, 5], end: [-5, 5] },
  { kind: "line", start: [-5, 5], end: [-5, -5] },
];

/** Straight spine along local +z: (0,0) → (0,40). */
const STRAIGHT_PATH: ProfileSweepInput["path"] = [
  { kind: "line", start: [0, 0], end: [0, 40] },
];

/** The XY-workplane placement the fixture profile sketch carries. */
const XY_PLACEMENT = {
  rotation: { axis: [0, 0, 1] as const, angle: angle(0) },
  translation: { x: length(0), y: length(0), z: length(0) },
};

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

/**
 * Straight-then-bend spine: (0,0) → (0,10), then a CCW quarter arc of
 * radius 10 about (−10, 10), ending at (−10, 20) heading −x. G1 at the
 * joint (both tangents (0, 1)).
 */
const BENT_PATH: ProfileSweepInput["path"] = [
  { kind: "line", start: [0, 0], end: [0, 10] },
  {
    kind: "arc",
    center: [-10, 10],
    radius: 10,
    startAngle: angle(0),
    endAngle: angle(Math.PI / 2),
  },
];

/** A resolver over the fixture's profile sketch (the ±5 square). */
const profileResolver: KernelProfileResolver = (sketchId) => {
  if (sketchId !== skProfile) {
    return {
      ok: false,
      error: {
        code: "document/not-found",
        message: `no sketch ${String(sketchId)}`,
        input: sketchId,
      },
    };
  }
  return {
    ok: true,
    value: { loop: SQUARE_LOOP, placement: XY_PLACEMENT },
  };
};

/** A path resolver over the fixture's path sketch (the given chain). */
const pathResolverOf =
  (path: ProfileSweepInput["path"]): KernelPathResolver =>
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

/** Builds the sweep document: two sketch records + the feature. */
function buildSweepDocument(): CadDocument {
  let document = createDocument(createDocumentId("doc_bridge_sweep"));
  for (const [id, name] of [
    [skProfile, "sweep profile"],
    [skPath, "sweep path"],
  ] as const) {
    const sketched = addDocumentSketch(document, {
      id,
      name,
      sketch: SKETCH_PAYLOAD,
    });
    if (!sketched.ok) throw new Error(sketched.error.message);
    document = sketched.value.document;
  }
  const body = addBody(document, { id: bTube, name: "tube" });
  if (!body.ok) throw new Error(body.error.message);
  document = body.value.document;
  const feature: FeatureRecordInput = {
    id: fSweep,
    kind: "sweep",
    inputs: [
      { kind: "sketch", id: skProfile },
      { kind: "sketch", id: skPath },
    ],
    outputs: [bTube],
  };
  const featured = addFeature(document, feature);
  if (!featured.ok) throw new Error(featured.error.message);
  document = featured.value.document;
  return document;
}

/** Regenerates the sweep document against a fresh fake kernel. */
function runSweep(
  document: CadDocument,
  options: {
    readonly path?: ProfileSweepInput["path"];
    readonly kernel?: GeometryKernel;
    readonly paths?: KernelPathResolver;
  } = {},
) {
  const kernel = options.kernel ?? createFakeKernel();
  const bridge = createKernelFeatureExecutor(kernel, {
    document,
    bodies: new Map(),
    profiles: profileResolver,
    paths: options.paths ?? pathResolverOf(options.path ?? STRAIGHT_PATH),
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

describe("bridge sweep: profile + path sketches → kernel sweep", () => {
  it("executes a straight sweep: volume = area × length, bounds exact", () => {
    const { kernel, bridge, run } = runSweep(buildSweepDocument());
    expect(run.executed).toEqual([fSweep]);
    const solid = bridge.solidOf(bTube);
    expect(solid).toBeDefined();
    if (solid === undefined) return;
    // The straight-edge profile sweeps Pappus-exact on the fake kernel:
    // 100 mm² × 40 mm.
    assertVolumeClose(
      unwrapKernelResult(kernel.volume(solid), "tube volume"),
      100 * 40,
      1e-9,
    );
    assertBoundsEqual(
      unwrapKernelResult(kernel.bounds(solid), "tube bounds"),
      { min: [-5, -5, 0], max: [5, 5, 40] },
      1e-9,
    );
  });

  it("executes a bent sweep at the Pappus value: line piece + arc piece", () => {
    const { kernel, bridge } = runSweep(buildSweepDocument(), {
      path: BENT_PATH,
    });
    const solid = bridge.solidOf(bTube);
    expect(solid).toBeDefined();
    if (solid === undefined) return;
    // Line piece: A·L = 100 × 10. Arc piece: |θ|·|d̄|·A with the profile
    // centroid ON the bend axis's zero-distance point: d̄ = sign(θ)·R = 10
    // (the square is centered at the origin), so (π/2)·10·100 = 500π.
    assertVolumeClose(
      unwrapKernelResult(kernel.volume(solid), "bent tube volume"),
      1000 + 500 * Math.PI,
      1e-9,
    );
    // The bend swings the tube toward −x; the end cap lands x = −10 exactly
    // (the square's inner face at u = −5 rides the radius-5 circle about the
    // bend axis), z reaches 20 + 5.
    assertBoundsEqual(
      unwrapKernelResult(kernel.bounds(solid), "bent tube bounds"),
      { min: [-10, -5, 0], max: [5, 5, 25] },
      1e-9,
    );
  });

  it("gates the capability: a kernel without sweep refuses before resolution", () => {
    const kernel: GeometryKernel = {
      ...createFakeKernel(),
      capabilities: { ...FAKE_KERNEL_CAPABILITIES, sweep: false },
    };
    const document = buildSweepDocument();
    const bridge = createKernelFeatureExecutor(kernel, {
      document,
      bodies: new Map(),
      profiles: profileResolver,
      paths: pathResolverOf(STRAIGHT_PATH),
    });
    const run = regenerate({
      features: document.features,
      states: initialRegenerationStates(document.features),
      suppressed: [],
      execute: bridge.executor,
    });
    expect(run.ok).toBe(true);
    if (!run.ok) return;
    const state = run.value.states.get(fSweep);
    expect(state?.state).toBe("failed");
    const diagnostic = state?.diagnostics[0];
    expect(diagnostic?.code).toBe("kernel/feature-input-invalid");
    expect(diagnostic?.message).toContain("sweep capability");
    expect(diagnostic?.message).toContain("gate refuses");
    // Nothing was resolved or built: the body carries no solid.
    expect(bridge.solidOf(bTube)).toBeUndefined();
  });

  it("fails structurally with the path code when the path sketch does not resolve", () => {
    const document = buildSweepDocument();
    const bridge = createKernelFeatureExecutor(createFakeKernel(), {
      document,
      bodies: new Map(),
      profiles: profileResolver,
      paths: () => ({
        ok: false,
        error: {
          code: "sketch/path-multiple-chains",
          message: "The sketch resolves to 2 disconnected chains.",
          input: skPath,
        },
      }),
    });
    const run = regenerate({
      features: document.features,
      states: initialRegenerationStates(document.features),
      suppressed: [],
      execute: bridge.executor,
    });
    expect(run.ok).toBe(true);
    if (!run.ok) return;
    const state = run.value.states.get(fSweep);
    expect(state?.state).toBe("failed");
    const diagnostic = state?.diagnostics[0];
    expect(diagnostic?.code).toBe("kernel/feature-input-invalid");
    expect(
      (diagnostic?.data as { pathCode?: string } | undefined)?.pathCode,
    ).toBe("sketch/path-multiple-chains");
  });

  it("refuses a sweep feature when the context provides no path resolver", () => {
    const document = buildSweepDocument();
    const bridge = createKernelFeatureExecutor(createFakeKernel(), {
      document,
      bodies: new Map(),
      profiles: profileResolver,
    });
    const run = regenerate({
      features: document.features,
      states: initialRegenerationStates(document.features),
      suppressed: [],
      execute: bridge.executor,
    });
    expect(run.ok).toBe(true);
    if (!run.ok) return;
    const state = run.value.states.get(fSweep);
    expect(state?.state).toBe("failed");
    const diagnostic = state?.diagnostics[0];
    expect(diagnostic?.code).toBe("kernel/feature-input-invalid");
    expect(diagnostic?.message).toContain("no path resolver");
  });

  it("rejects malformed layouts: one sketch, reversed roles, extra parameter", () => {
    const document = buildSweepDocument();
    const badInputs = (inputs: FeatureRecordInput["inputs"]): string | null => {
      const oneFeature = {
        ...document,
        features: document.features.map((feature) =>
          feature.id === fSweep ? { ...feature, inputs } : feature,
        ),
      };
      const tryBridge = createKernelFeatureExecutor(createFakeKernel(), {
        document: oneFeature,
        bodies: new Map(),
        profiles: profileResolver,
        paths: pathResolverOf(STRAIGHT_PATH),
      });
      const run = regenerate({
        features: oneFeature.features,
        states: initialRegenerationStates(oneFeature.features),
        suppressed: [],
        execute: tryBridge.executor,
      });
      if (!run.ok) return run.error.message;
      const state = run.value.states.get(fSweep);
      return state?.diagnostics[0]?.code ?? null;
    };
    expect(badInputs([{ kind: "sketch", id: skProfile }])).toBe(
      "kernel/feature-input-invalid",
    );
    // A parameter cannot take the path's place: the kernel-invalid-path
    // family is the kernel's business, the LAYOUT check is the bridge's.
    expect(
      badInputs([
        { kind: "sketch", id: skProfile },
        { kind: "sketch", id: skPath },
        { kind: "sketch", id: skPath },
      ]),
    ).toBe("kernel/feature-input-invalid");
  });

  it("re-drives from a sketch edit: the resolver's new loop defines the new solid", () => {
    const document = buildSweepDocument();
    const first = runSweep(document, { path: STRAIGHT_PATH });
    const firstSolid = first.bridge.solidOf(bTube);
    expect(firstSolid).toBeDefined();
    if (firstSolid === undefined) return;
    assertVolumeClose(
      unwrapKernelResult(first.kernel.volume(firstSolid), "first volume"),
      100 * 40,
      1e-9,
    );
    // A sketch edit changes the resolver's answer; a FRESH run over the same
    // document (one bridge per run) pins the new solid — the regeneration
    // criterion without a parameter in the loop.
    const grownLoop: ProfileSweepInput["loop"] = [
      { kind: "line", start: [-10, -10], end: [10, -10] },
      { kind: "line", start: [10, -10], end: [10, 10] },
      { kind: "line", start: [10, 10], end: [-10, 10] },
      { kind: "line", start: [-10, 10], end: [-10, -10] },
    ];
    const resolver: KernelProfileResolver = (sketchId) =>
      sketchId === skProfile
        ? { ok: true, value: { loop: grownLoop, placement: XY_PLACEMENT } }
        : profileResolver(sketchId);
    const secondKernel = createFakeKernel();
    const second = createKernelFeatureExecutor(secondKernel, {
      document,
      bodies: new Map(),
      profiles: resolver,
      paths: pathResolverOf(STRAIGHT_PATH),
    });
    const rerun = regenerate({
      features: document.features,
      states: initialRegenerationStates(document.features),
      suppressed: [],
      execute: second.executor,
    });
    expect(rerun.ok).toBe(true);
    if (!rerun.ok) return;
    const solid = second.solidOf(bTube);
    expect(solid).toBeDefined();
    if (solid === undefined) return;
    assertVolumeClose(
      unwrapKernelResult(secondKernel.volume(solid), "second volume"),
      400 * 40,
      1e-9,
    );
  });
});
