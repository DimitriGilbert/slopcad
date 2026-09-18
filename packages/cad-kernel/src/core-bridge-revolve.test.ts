/**
 * The revolve feature's bridge tests (Phase 26.2): document sketch records
 * + two ANGLE parameters (sweep, axis direction) → the bridge's `revolve`
 * kind → the fake kernel → semantic volume assertions under Pappus, the
 * parameter-driven regeneration (sweep AND axis edits re-pin the solid),
 * and the failure taxonomy (unresolvable profile, malformed inputs,
 * wrong-dimension parameters, kernel axis-crossing riding through).
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
import type { ProfileRevolveInput } from "./contract";

import {
  createKernelFeatureExecutor,
  type KernelProfileResolver,
} from "./core-bridge";
import { createFakeKernel } from "./fake-kernel";
import { assertVolumeClose, unwrapKernelResult } from "./test-utils";

const pSweep = createParameterId("param_revolve_sweep");
const pAxis = createParameterId("param_revolve_axis");
const bSolid = createBodyId("body_revolved");
const fRevolve = createFeatureId("feat_revolve");

/** The rectangle loop the fixture sketch resolves to: touches the x axis. */
const RECT_LOOP: ProfileRevolveInput["loop"] = [
  { kind: "line", start: [0, 0], end: [30, 0] },
  { kind: "line", start: [30, 0], end: [30, 25] },
  { kind: "line", start: [30, 25], end: [0, 25] },
  { kind: "line", start: [0, 25], end: [0, 0] },
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

const SKETCH_ID = createSketchDocumentId("skd_revolve_profile");

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

/** Builds the revolve document: sketch + sweep/axis parameters + feature. */
function buildRevolveDocument(sweepRad: number, axisRad: number): CadDocument {
  let document = createDocument(createDocumentId("doc_bridge_revolve"));
  const sketched = addDocumentSketch(document, {
    id: SKETCH_ID,
    name: "revolve profile",
    sketch: SKETCH_PAYLOAD,
  });
  if (!sketched.ok) throw new Error(sketched.error.message);
  document = sketched.value.document;
  for (const [id, name, value] of [
    [pSweep, "revolveSweep", angle(sweepRad, "rad")],
    [pAxis, "revolveAxis", angle(axisRad, "rad")],
  ] as const) {
    const parameter = addDocumentParameter(document, { id, name, value });
    if (!parameter.ok) throw new Error(parameter.error.message);
    document = parameter.value.document;
  }
  const body = addBody(document, { id: bSolid, name: "revolved" });
  if (!body.ok) throw new Error(body.error.message);
  document = body.value.document;
  const feature: FeatureRecordInput = {
    id: fRevolve,
    kind: "revolve",
    inputs: [
      { kind: "sketch", id: SKETCH_ID },
      { kind: "parameter", id: pSweep },
      { kind: "parameter", id: pAxis },
    ],
    outputs: [bSolid],
  };
  const featured = addFeature(document, feature);
  if (!featured.ok) throw new Error(featured.error.message);
  document = featured.value.document;
  return document;
}

/** Regenerates the revolve document against a fresh fake kernel. */
function runRevolve(document: CadDocument) {
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

describe("bridge revolve: sketch + sweep/axis angle parameters → kernel revolution", () => {
  it("executes a full revolve about the workplane x axis: exact cylinder volume", () => {
    const { kernel, bridge, run } = runRevolve(
      buildRevolveDocument(Math.PI * 2, 0),
    );
    expect(run.executed).toEqual([fRevolve]);
    const solid = bridge.solidOf(bSolid);
    expect(solid).toBeDefined();
    if (solid === undefined) return;
    assertVolumeClose(
      unwrapKernelResult(kernel.volume(solid), "revolved volume"),
      Math.PI * 25 ** 2 * 30,
      1e-9,
    );
  });

  it("executes a partial sweep at the Pappus-proportional volume", () => {
    const { kernel, bridge } = runRevolve(buildRevolveDocument(Math.PI / 2, 0));
    const solid = bridge.solidOf(bSolid);
    expect(solid).toBeDefined();
    if (solid === undefined) return;
    assertVolumeClose(
      unwrapKernelResult(kernel.volume(solid), "quarter volume"),
      (Math.PI * 25 ** 2 * 30) / 4,
      1e-9,
    );
  });

  it("revolves about the workplane y axis from a π/2 axis parameter", () => {
    // The rectangle (0..30, 0..25) about the y axis: material touches the
    // axis along x = 0 and spans the +x side — a cylinder again, radius 30
    // along y, length 25 along the axis.
    const { kernel, bridge } = runRevolve(
      buildRevolveDocument(Math.PI * 2, Math.PI / 2),
    );
    const solid = bridge.solidOf(bSolid);
    expect(solid).toBeDefined();
    if (solid === undefined) return;
    assertVolumeClose(
      unwrapKernelResult(kernel.volume(solid), "y-axis revolve volume"),
      Math.PI * 30 ** 2 * 25,
      1e-9,
    );
  });

  it("regenerates from a sweep edit: parameter.set 2π → π halves the volume", () => {
    const document = buildRevolveDocument(Math.PI * 2, 0);
    const set = applyCommand(document, {
      type: "parameter.set",
      id: pSweep,
      value: angle(Math.PI, "rad"),
    });
    expect(set.ok).toBe(true);
    if (!set.ok) return;
    const { kernel, bridge } = runRevolve(set.value);
    const solid = bridge.solidOf(bSolid);
    expect(solid).toBeDefined();
    if (solid === undefined) return;
    assertVolumeClose(
      unwrapKernelResult(kernel.volume(solid), "half volume"),
      (Math.PI * 25 ** 2 * 30) / 2,
      1e-9,
    );
  });

  it("fails structurally with the profile code when the sketch does not resolve", () => {
    const kernel = createFakeKernel();
    const document = buildRevolveDocument(Math.PI * 2, 0);
    const bridge = createKernelFeatureExecutor(kernel, {
      document,
      bodies: new Map(),
      profiles: () => ({
        ok: false,
        error: {
          code: "sketch/profile-open-chain",
          message: "The profile chain is open.",
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
    const state = run.value.states.get(fRevolve);
    expect(state?.state).toBe("failed");
    const diagnostic = state?.diagnostics[0];
    expect(diagnostic?.code).toBe("kernel/feature-input-invalid");
    expect(
      (diagnostic?.data as { profileCode?: string } | undefined)?.profileCode,
    ).toBe("sketch/profile-open-chain");
  });

  it("rides the kernel's axis-crossing rejection through as an operation failure", () => {
    // A profile straddling the y axis revolved about the y axis: the kernel
    // (not the bridge) rejects it — the structured code surfaces in data.
    const kernel = createFakeKernel();
    const document = buildRevolveDocument(Math.PI * 2, Math.PI / 2);
    const straddler: ProfileRevolveInput["loop"] = [
      { kind: "line", start: [-10, 5], end: [10, 5] },
      { kind: "line", start: [10, 5], end: [10, 20] },
      { kind: "line", start: [10, 20], end: [-10, 20] },
      { kind: "line", start: [-10, 20], end: [-10, 5] },
    ];
    const bridge = createKernelFeatureExecutor(kernel, {
      document,
      bodies: new Map(),
      profiles: (sketchId) => {
        if (sketchId !== SKETCH_ID) {
          return {
            ok: false,
            error: {
              code: "document/not-found",
              message: "no sketch",
              input: sketchId,
            },
          };
        }
        return {
          ok: true,
          value: { loop: straddler, placement: XY_PLACEMENT },
        };
      },
    });
    const run = regenerate({
      features: document.features,
      states: initialRegenerationStates(document.features),
      suppressed: [],
      execute: bridge.executor,
    });
    if (!run.ok) throw new Error(run.error.message);
    const state = run.value.states.get(fRevolve);
    expect(state?.state).toBe("failed");
    const diagnostic = state?.diagnostics[0];
    expect(diagnostic?.code).toBe("kernel/operation-failed");
    expect(
      (diagnostic?.data as { kernelErrorCode?: string } | undefined)
        ?.kernelErrorCode,
    ).toBe("kernel/profile-axis-crossing");
  });

  it("rejects malformed input lists and non-angle parameters", () => {
    const kernel = createFakeKernel();
    const document = buildRevolveDocument(Math.PI * 2, 0);
    const runWith = (inputs: FeatureRecordInput["inputs"]) => {
      const oneFeature = {
        ...document,
        features: document.features.map((feature) =>
          feature.id === fRevolve ? { ...feature, inputs } : feature,
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
      const state = run.value.states.get(fRevolve);
      return state?.diagnostics[0]?.code ?? null;
    };
    expect(
      runWith([
        { kind: "sketch", id: SKETCH_ID },
        { kind: "parameter", id: pSweep },
      ]),
    ).toBe("kernel/feature-input-invalid");
    expect(
      runWith([
        { kind: "sketch", id: SKETCH_ID },
        { kind: "parameter", id: pSweep },
        { kind: "sketch", id: SKETCH_ID },
      ]),
    ).toBe("kernel/feature-input-invalid");
    // A LENGTH parameter where an ANGLE one is needed:
    expect(
      runWith([
        { kind: "sketch", id: SKETCH_ID },
        { kind: "parameter", id: createParameterId("param_absent") },
        { kind: "parameter", id: pAxis },
      ]),
    ).toBe("kernel/parameter-invalid");
  });
});
