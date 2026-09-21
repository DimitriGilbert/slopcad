/**
 * The loft feature's bridge tests (Phase 38): ordered section sketches plus
 * their station-z length parameters → the bridge's `loft` kind → the fake
 * kernel → semantic volume/bounds assertions at the Simpson-exact ruled
 * values, the one-frame rule (a section off the first section's workplane
 * refuses), the capability gate, the failure taxonomy, station re-drive
 * through `parameter.set`, and a three-station collection.
 */

import { describe, expect, it } from "vitest";
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
import type { ProfileExtrudeInput, ProfileLoftInput } from "./contract";
import type { GeometryKernel } from "./contract";

import {
  createKernelFeatureExecutor,
  type KernelProfileResolver,
} from "./core-bridge";
import { createFakeKernel, FAKE_KERNEL_CAPABILITIES } from "./fake-kernel";
import {
  assertBoundsEqual,
  assertVolumeClose,
  unwrapKernelResult,
} from "./test-utils";

const bLoft = createBodyId("body_loft");
const fLoft = createFeatureId("feat_loft");
const skSection1 = createSketchDocumentId("skd_loft_s1");
const skSection2 = createSketchDocumentId("skd_loft_s2");
const skSection3 = createSketchDocumentId("skd_loft_s3");
const st0 = createParameterId("param_loft_z0");
const st1 = createParameterId("param_loft_z1");
const st2 = createParameterId("param_loft_z2");

/** A square loop of the given half-extent, centered on the local origin. */
function squareLoop(
  half: number,
): ProfileLoftInput["sections"][number]["loop"] {
  return [
    { kind: "line", start: [-half, -half], end: [half, -half] },
    { kind: "line", start: [half, -half], end: [half, half] },
    { kind: "line", start: [half, half], end: [-half, half] },
    { kind: "line", start: [-half, half], end: [-half, -half] },
  ];
}

/** The XY-workplane placement every fixture section sketch carries. */
const XY_PLACEMENT: ProfileExtrudeInput["placement"] = {
  rotation: { axis: [0, 0, 1], angle: angle(0) },
  translation: { x: length(0), y: length(0), z: length(0) },
};

/** A placement lifted to the given model z (a DIFFERENT workplane frame). */
const liftedPlacement = (z: number): ProfileExtrudeInput["placement"] => ({
  rotation: { axis: [0, 0, 1], angle: angle(0) },
  translation: { x: length(0), y: length(0), z: length(z) },
});

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

interface SectionFixture {
  readonly sketchId: ReturnType<typeof createSketchDocumentId>;
  readonly parameterId: ReturnType<typeof createParameterId>;
  readonly half: number;
  readonly placement?: ProfileExtrudeInput["placement"];
}

/** Builds the loft document: sketch records, station parameters, feature. */
function buildLoftDocument(sections: readonly SectionFixture[]): CadDocument {
  let document = createDocument(createDocumentId("doc_bridge_loft"));
  for (const section of sections) {
    const sketched = addDocumentSketch(document, {
      id: section.sketchId,
      name: `loft section ${String(section.sketchId)}`,
      sketch: SKETCH_PAYLOAD,
    });
    if (!sketched.ok) throw new Error(sketched.error.message);
    document = sketched.value.document;
    const parameter = addDocumentParameter(document, {
      id: section.parameterId,
      name: `loftStation${String(section.sketchId)}`,
      value: length(0),
    });
    if (!parameter.ok) throw new Error(parameter.error.message);
    document = parameter.value.document;
  }
  const body = addBody(document, { id: bLoft, name: "loft" });
  if (!body.ok) throw new Error(body.error.message);
  document = body.value.document;
  const feature: FeatureRecordInput = {
    id: fLoft,
    kind: "loft",
    inputs: sections.flatMap((section) => [
      { kind: "sketch" as const, id: section.sketchId },
      { kind: "parameter" as const, id: section.parameterId },
    ]),
    outputs: [bLoft],
  };
  const featured = addFeature(document, feature);
  if (!featured.ok) throw new Error(featured.error.message);
  document = featured.value.document;
  return document;
}

/** A resolver over the fixture section sketches (half-extent squares). */
function resolverOf(
  sections: readonly SectionFixture[],
): KernelProfileResolver {
  const byId = new Map(
    sections.map((section) => [
      section.sketchId,
      {
        loop: squareLoop(section.half),
        placement: section.placement ?? XY_PLACEMENT,
      },
    ]),
  );
  return (sketchId) => {
    const value = byId.get(sketchId);
    if (value === undefined) {
      return {
        ok: false,
        error: {
          code: "document/not-found",
          message: `no sketch ${String(sketchId)}`,
          input: sketchId,
        },
      };
    }
    return { ok: true, value };
  };
}

/** Regenerates the loft document; station overrides ride `overrides`. */
function runLoft(
  document: CadDocument,
  options: {
    readonly resolver?: KernelProfileResolver;
    readonly kernel?: GeometryKernel;
    readonly stations?: Readonly<Record<string, number>>;
  } = {},
) {
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
  const kernel = options.kernel ?? createFakeKernel();
  const bridge = createKernelFeatureExecutor(kernel, {
    document: effective,
    bodies: new Map(),
    profiles: options.resolver ?? resolverOf([]),
  });
  const run = regenerate({
    features: effective.features,
    states: initialRegenerationStates(effective.features),
    suppressed: [],
    execute: bridge.executor,
  });
  if (!run.ok) throw new Error(run.error.message);
  return { kernel, bridge, run: run.value };
}

const TWO_SECTIONS: readonly SectionFixture[] = [
  { sketchId: skSection1, parameterId: st0, half: 10 },
  { sketchId: skSection2, parameterId: st1, half: 10 },
];

describe("bridge loft: ordered sections + stations → kernel loft", () => {
  it("executes a prismatic two-section loft: volume = area × height, bounds exact", () => {
    const document = buildLoftDocument(TWO_SECTIONS);
    const { kernel, bridge, run } = runLoft(document, {
      resolver: resolverOf(TWO_SECTIONS),
      stations: { [st0]: 0, [st1]: 20 },
    });
    expect(run.executed).toEqual([fLoft]);
    const solid = bridge.solidOf(bLoft);
    expect(solid).toBeDefined();
    if (solid === undefined) return;
    assertVolumeClose(
      unwrapKernelResult(kernel.volume(solid), "loft volume"),
      400 * 20,
      1e-9,
    );
    assertBoundsEqual(
      unwrapKernelResult(kernel.bounds(solid), "loft bounds"),
      { min: [-10, -10, 0], max: [10, 10, 20] },
      1e-9,
    );
  });

  it("executes a tapering loft at the Simpson-exact ruled volume", () => {
    const fixtures: readonly SectionFixture[] = [
      { sketchId: skSection1, parameterId: st0, half: 10 },
      { sketchId: skSection2, parameterId: st1, half: 5 },
    ];
    const document = buildLoftDocument(fixtures);
    const { kernel, bridge } = runLoft(document, {
      resolver: resolverOf(fixtures),
      stations: { [st0]: 0, [st1]: 15 },
    });
    const solid = bridge.solidOf(bLoft);
    expect(solid).toBeDefined();
    if (solid === undefined) return;
    // Cross-section side 20 − (20/3)t is linear in t, so the area is
    // quadratic and the prismoidal formula is exact:
    // 15/6 · (400 + 4·225 + 100) = 3500.
    assertVolumeClose(
      unwrapKernelResult(kernel.volume(solid), "taper loft volume"),
      3500,
      1e-9,
    );
    assertBoundsEqual(
      unwrapKernelResult(kernel.bounds(solid), "taper loft bounds"),
      { min: [-10, -10, 0], max: [10, 10, 15] },
      1e-9,
    );
  });

  it("lofts three stations in declared order (negative station legal)", () => {
    const fixtures: readonly SectionFixture[] = [
      { sketchId: skSection1, parameterId: st0, half: 10 },
      { sketchId: skSection2, parameterId: st1, half: 10 },
      { sketchId: skSection3, parameterId: st2, half: 10 },
    ];
    const document = buildLoftDocument(fixtures);
    const { kernel, bridge } = runLoft(document, {
      resolver: resolverOf(fixtures),
      stations: { [st0]: -5, [st1]: 5, [st2]: 15 },
    });
    const solid = bridge.solidOf(bLoft);
    expect(solid).toBeDefined();
    if (solid === undefined) return;
    assertVolumeClose(
      unwrapKernelResult(kernel.volume(solid), "three-station volume"),
      400 * 20,
      1e-9,
    );
    assertBoundsEqual(
      unwrapKernelResult(kernel.bounds(solid), "three-station bounds"),
      { min: [-10, -10, -5], max: [10, 10, 15] },
      1e-9,
    );
  });

  it("re-drives from a station parameter.set: 20 → 50 re-executes into the new solid", () => {
    const document = buildLoftDocument(TWO_SECTIONS);
    const first = runLoft(document, {
      resolver: resolverOf(TWO_SECTIONS),
      stations: { [st0]: 0, [st1]: 20 },
    });
    const firstSolid = first.bridge.solidOf(bLoft);
    expect(firstSolid).toBeDefined();
    if (firstSolid === undefined) return;
    assertVolumeClose(
      unwrapKernelResult(first.kernel.volume(firstSolid), "first volume"),
      400 * 20,
      1e-9,
    );
    const second = runLoft(document, {
      resolver: resolverOf(TWO_SECTIONS),
      stations: { [st0]: 0, [st1]: 50 },
    });
    const solid = second.bridge.solidOf(bLoft);
    expect(solid).toBeDefined();
    if (solid === undefined) return;
    assertVolumeClose(
      unwrapKernelResult(second.kernel.volume(solid), "second volume"),
      400 * 50,
      1e-9,
    );
  });

  it("enforces the one-frame rule: a section off section 1's workplane refuses", () => {
    const fixtures: readonly SectionFixture[] = [
      { sketchId: skSection1, parameterId: st0, half: 10 },
      {
        sketchId: skSection2,
        parameterId: st1,
        half: 10,
        placement: liftedPlacement(12),
      },
    ];
    const document = buildLoftDocument(fixtures);
    const { bridge, run } = runLoft(document, {
      resolver: resolverOf(fixtures),
      stations: { [st0]: 0, [st1]: 20 },
    });
    const state = run.states.get(fLoft);
    expect(state?.state).toBe("failed");
    const diagnostic = state?.diagnostics[0];
    expect(diagnostic?.code).toBe("kernel/feature-input-invalid");
    expect(diagnostic?.message).toContain("different workplane frame");
    expect(bridge.solidOf(bLoft)).toBeUndefined();
  });

  it("gates the capability: a kernel without loft refuses before resolution", () => {
    const kernel: GeometryKernel = {
      ...createFakeKernel(),
      capabilities: { ...FAKE_KERNEL_CAPABILITIES, loft: false },
    };
    const document = buildLoftDocument(TWO_SECTIONS);
    const bridge = createKernelFeatureExecutor(kernel, {
      document,
      bodies: new Map(),
      profiles: resolverOf(TWO_SECTIONS),
    });
    const run = regenerate({
      features: document.features,
      states: initialRegenerationStates(document.features),
      suppressed: [],
      execute: bridge.executor,
    });
    expect(run.ok).toBe(true);
    if (!run.ok) return;
    const state = run.value.states.get(fLoft);
    expect(state?.state).toBe("failed");
    const diagnostic = state?.diagnostics[0];
    expect(diagnostic?.code).toBe("kernel/feature-input-invalid");
    expect(diagnostic?.message).toContain("loft capability");
    expect(bridge.solidOf(bLoft)).toBeUndefined();
  });

  it("surfaces the kernel's collection failures verbatim", () => {
    // Equal stations: the kernel's station-ordering rule.
    const unordered = buildLoftDocument(TWO_SECTIONS);
    const unorderedRun = runLoft(unordered, {
      resolver: resolverOf(TWO_SECTIONS),
      stations: { [st0]: 20, [st1]: 20 },
    });
    const unorderedState = unorderedRun.run.states.get(fLoft);
    expect(
      (
        unorderedState?.diagnostics[0]?.data as
          { kernelErrorCode?: string } | undefined
      )?.kernelErrorCode,
    ).toBe("kernel/loft-unordered-stations");
  });

  it("rejects malformed layouts: one section, mismatched parameter count", () => {
    const document = buildLoftDocument(TWO_SECTIONS);
    const badInputs = (inputs: FeatureRecordInput["inputs"]): string | null => {
      const oneFeature = {
        ...document,
        features: document.features.map((feature) =>
          feature.id === fLoft ? { ...feature, inputs } : feature,
        ),
      };
      const tryBridge = createKernelFeatureExecutor(createFakeKernel(), {
        document: oneFeature,
        bodies: new Map(),
        profiles: resolverOf(TWO_SECTIONS),
      });
      const run = regenerate({
        features: oneFeature.features,
        states: initialRegenerationStates(oneFeature.features),
        suppressed: [],
        execute: tryBridge.executor,
      });
      if (!run.ok) return run.error.message;
      const state = run.value.states.get(fLoft);
      return state?.diagnostics[0]?.code ?? null;
    };
    expect(
      badInputs([
        { kind: "sketch", id: skSection1 },
        { kind: "parameter", id: st0 },
      ]),
    ).toBe("kernel/feature-input-invalid");
    expect(
      badInputs([
        { kind: "sketch", id: skSection1 },
        { kind: "sketch", id: skSection2 },
        { kind: "parameter", id: st0 },
      ]),
    ).toBe("kernel/feature-input-invalid");
    // A dimension parameter cannot stand where a section belongs.
    expect(
      badInputs([
        { kind: "sketch", id: skSection1 },
        { kind: "sketch", id: skSection2 },
        { kind: "parameter", id: st0 },
        { kind: "parameter", id: st1 },
        { kind: "parameter", id: st2 },
      ]),
    ).toBe("kernel/feature-input-invalid");
  });

  it("fails with the section's profile code when a section sketch does not resolve", () => {
    const document = buildLoftDocument(TWO_SECTIONS);
    const failing: KernelProfileResolver = (sketchId) =>
      sketchId === skSection2
        ? {
            ok: false,
            error: {
              code: "sketch/profile-open-chain",
              message: "The profile chain is open.",
              input: sketchId,
            },
          }
        : resolverOf(TWO_SECTIONS)(sketchId);
    const { run } = runLoft(document, { resolver: failing });
    const state = run.states.get(fLoft);
    expect(state?.state).toBe("failed");
    const diagnostic = state?.diagnostics[0];
    expect(diagnostic?.code).toBe("kernel/feature-input-invalid");
    expect(
      (diagnostic?.data as { profileCode?: string } | undefined)?.profileCode,
    ).toBe("sketch/profile-open-chain");
    expect(diagnostic?.message).toContain("section 2");
  });
});
