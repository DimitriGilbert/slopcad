/**
 * The extrude feature's bridge tests (Phase 26.1): document sketch records +
 * a signed distance parameter → the bridge's `extrude` kind → the fake
 * kernel → semantic volume/bounds assertions, the failure taxonomy
 * (unresolvable profile, unknown sketch, malformed inputs, zero distance),
 * and parameter-driven regeneration (edit → regenerate → new solid pinned).
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
import type { ProfileExtrudeInput } from "./contract";

import {
  createKernelFeatureExecutor,
  type KernelProfileResolver,
} from "./core-bridge";
import { createFakeKernel } from "./fake-kernel";
import {
  assertBoundsEqual,
  assertVolumeClose,
  unwrapKernelResult,
} from "./test-utils";

const pDepth = createParameterId("param_extrude_depth");
const bPad = createBodyId("body_pad");
const fExtrude = createFeatureId("feat_extrude");

/** The rectangle loop the fixture sketch resolves to (mm). */
const RECT_LOOP: ProfileExtrudeInput["loop"] = [
  { kind: "line", start: [10, 10], end: [30, 10] },
  { kind: "line", start: [30, 10], end: [30, 25] },
  { kind: "line", start: [30, 25], end: [10, 25] },
  { kind: "line", start: [10, 25], end: [10, 10] },
];

/** The XY-workplane placement the fixture sketch carries. */
const XY_PLACEMENT = {
  rotation: { axis: [0, 0, 1] as const, angle: angle(0) },
  translation: { x: length(0), y: length(0), z: length(0) },
};

/** The serialized sketch payload the document record stores. */
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

const SKETCH_ID = createSketchDocumentId("skd_profile");

/** A resolver over the fixture's single sketch (the rectangle loop). */
const rectResolver: KernelProfileResolver = (sketchId) => {
  if (sketchId !== SKETCH_ID) {
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
    value: { loop: RECT_LOOP, placement: XY_PLACEMENT },
  };
};

/** Builds the extrude document: sketch record + distance parameter + feature. */
function buildExtrudeDocument(depthMm: number): CadDocument {
  let document = createDocument(createDocumentId("doc_bridge_extrude"));
  const sketched = addDocumentSketch(document, {
    id: SKETCH_ID,
    name: "profile",
    sketch: SKETCH_PAYLOAD,
  });
  if (!sketched.ok) throw new Error(sketched.error.message);
  document = sketched.value.document;
  const parameter = addDocumentParameter(document, {
    id: pDepth,
    name: "extrudeDepth",
    value: length(depthMm),
  });
  if (!parameter.ok) throw new Error(parameter.error.message);
  document = parameter.value.document;
  const body = addBody(document, { id: bPad, name: "pad" });
  if (!body.ok) throw new Error(body.error.message);
  document = body.value.document;
  const feature: FeatureRecordInput = {
    id: fExtrude,
    kind: "extrude",
    inputs: [
      { kind: "sketch", id: SKETCH_ID },
      { kind: "parameter", id: pDepth },
    ],
    outputs: [bPad],
  };
  const featured = addFeature(document, feature);
  if (!featured.ok) throw new Error(featured.error.message);
  document = featured.value.document;
  return document;
}

/** Regenerates the extrude document against a fresh fake kernel. */
function runExtrude(document: CadDocument) {
  const kernel = createFakeKernel();
  const bridge = createKernelFeatureExecutor(kernel, {
    document,
    bodies: new Map(),
    profiles: rectResolver,
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

describe("bridge extrude: sketch + signed distance → kernel prism", () => {
  it("executes a positive extrusion: volume = area × |distance|, bounds above the plane", () => {
    const { kernel, bridge, run } = runExtrude(buildExtrudeDocument(12));
    expect(run.executed).toEqual([fExtrude]);
    const solid = bridge.solidOf(bPad);
    expect(solid).toBeDefined();
    if (solid === undefined) return;
    assertVolumeClose(
      unwrapKernelResult(kernel.volume(solid), "pad volume"),
      20 * 15 * 12,
      1e-9,
    );
    assertBoundsEqual(
      unwrapKernelResult(kernel.bounds(solid), "pad bounds"),
      { min: [10, 10, 0], max: [30, 25, 12] },
      1e-9,
    );
  });

  it("executes a negative extrusion below the sketch plane from a signed parameter", () => {
    const { kernel, bridge } = runExtrude(buildExtrudeDocument(-8));
    const solid = bridge.solidOf(bPad);
    expect(solid).toBeDefined();
    if (solid === undefined) return;
    assertVolumeClose(
      unwrapKernelResult(kernel.volume(solid), "pad volume"),
      20 * 15 * 8,
      1e-9,
    );
    assertBoundsEqual(
      unwrapKernelResult(kernel.bounds(solid), "pad bounds"),
      { min: [10, 10, -8], max: [30, 25, 0] },
      1e-9,
    );
  });

  it("regenerates from a parameter edit: parameter.set 12 → 20 re-executes into the new solid", () => {
    const first = runExtrude(buildExtrudeDocument(12));
    const firstSolid = first.bridge.solidOf(bPad);
    expect(firstSolid).toBeDefined();
    if (firstSolid === undefined) return;
    assertVolumeClose(
      unwrapKernelResult(first.kernel.volume(firstSolid), "first volume"),
      20 * 15 * 12,
      1e-9,
    );

    // parameter.set on the distance, then a FRESH run over the new document
    // (the documented one-bridge-per-run discipline) pins the new solid.
    const document = buildExtrudeDocument(12);
    const set = applyCommand(document, {
      type: "parameter.set",
      id: pDepth,
      value: length(20),
    });
    expect(set.ok).toBe(true);
    if (!set.ok) return;
    const second = runExtrude(set.value);
    const solid = second.bridge.solidOf(bPad);
    expect(solid).toBeDefined();
    if (solid === undefined) return;
    assertVolumeClose(
      unwrapKernelResult(second.kernel.volume(solid), "second volume"),
      20 * 15 * 20,
      1e-9,
    );
  });

  it("fails structurally with the profile code when the sketch does not resolve", () => {
    const kernel = createFakeKernel();
    const document = buildExtrudeDocument(10);
    const bridge = createKernelFeatureExecutor(kernel, {
      document,
      bodies: new Map(),
      profiles: () => ({
        ok: false,
        error: {
          code: "sketch/profile-open-chain",
          message: "The profile chain is open: its ends miss by 7.000000 mm.",
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
    expect(run.ok).toBe(true);
    if (!run.ok) return;
    const state = run.value.states.get(fExtrude);
    expect(state?.state).toBe("failed");
    const diagnostic = state?.diagnostics[0];
    expect(diagnostic?.code).toBe("kernel/feature-input-invalid");
    expect(
      (diagnostic?.data as { profileCode?: string } | undefined)?.profileCode,
    ).toBe("sketch/profile-open-chain");
    expect(diagnostic?.message).toContain("open");
  });

  it("rejects a malformed input list and a non-sketch profile source", () => {
    const kernel = createFakeKernel();
    const document = buildExtrudeDocument(10);
    const badInputs = (inputs: FeatureRecordInput["inputs"]): string | null => {
      const oneFeature = {
        ...document,
        features: document.features.map((feature) =>
          feature.id === fExtrude ? { ...feature, inputs } : feature,
        ),
      };
      const tryBridge = createKernelFeatureExecutor(kernel, {
        document: oneFeature,
        bodies: new Map(),
        profiles: rectResolver,
      });
      const run = regenerate({
        features: oneFeature.features,
        states: initialRegenerationStates(oneFeature.features),
        suppressed: [],
        execute: tryBridge.executor,
      });
      if (!run.ok) return run.error.message;
      const state = run.value.states.get(fExtrude);
      return state?.diagnostics[0]?.code ?? null;
    };
    expect(badInputs([{ kind: "sketch", id: SKETCH_ID }])).toBe(
      "kernel/feature-input-invalid",
    );
    expect(
      badInputs([
        { kind: "body", id: bPad },
        { kind: "parameter", id: pDepth },
      ]),
    ).toBe("kernel/feature-input-invalid");
    expect(
      badInputs([
        { kind: "sketch", id: SKETCH_ID },
        { kind: "sketch", id: SKETCH_ID },
      ]),
    ).toBe("kernel/feature-input-invalid");
  });

  it("rejects a zero distance with kernel/parameter-invalid", () => {
    const kernel = createFakeKernel();
    const document = buildExtrudeDocument(0);
    const bridge = createKernelFeatureExecutor(kernel, {
      document,
      bodies: new Map(),
      profiles: rectResolver,
    });
    const run = regenerate({
      features: document.features,
      states: initialRegenerationStates(document.features),
      suppressed: [],
      execute: bridge.executor,
    });
    if (!run.ok) throw new Error(run.error.message);
    const state = run.value.states.get(fExtrude);
    expect(state?.state).toBe("failed");
    expect(state?.diagnostics[0]?.code).toBe("kernel/parameter-invalid");
  });
});
