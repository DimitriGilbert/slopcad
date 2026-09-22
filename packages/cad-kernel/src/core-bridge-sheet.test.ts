/**
 * The Phase 48 sheet seams of the kernel feature bridge: the
 * `extrude-surface` feature kind (one sketch + one signed distance → the
 * kernel's `sheet: true` extrude) and the SOLID-INPUT gate (every
 * solid-consuming feature declines a sheet body before the kernel is
 * asked — the per-op "does this accept sheets?" answer the roadmap's risk
 * note demands, answered once in `solidInput` for the whole boolean and
 * feature family).
 *
 * The fake kernel declares `sheets: false` (its engine is closed-solid —
 * the cross-kernel decline the capability documents), so the POSITIVE
 * execution test rides a test-double kernel whose sheet extrude answers
 * a solid handle: the bridge's own job here is input validation, the
 * capability gate, and the sheet flag's pass-through — the GEOMETRY is
 * the OCCT adapter's own suite's province (exact-area fixtures).
 */

import { describe, expect, it } from "vitest";
import { angle, length } from "@slopcad/cad-core";
import {
  addBody,
  addDocumentParameter,
  addDocumentSketch,
  addFeature,
  createBodyId,
  createDocument,
  createDocumentId,
  createFeatureId,
  createParameterId,
  createSketchDocumentId,
  initialRegenerationStates,
  regenerate,
  type CadDocument,
  type FeatureRecordInput,
} from "@slopcad/cad-core";
import type { ProfileExtrudeInput } from "./contract";
import type { KernelProfileResolver } from "./core-bridge";

import { createKernelFeatureExecutor } from "./core-bridge";
import { createFakeKernel } from "./fake-kernel";

const pDistance = createParameterId("param_sheet_distance");
const bSheet = createBodyId("body_sheet");
const bSolid = createBodyId("body_solid");
const fSheet = createFeatureId("feat_sheet");
const fUnion = createFeatureId("feat_union");
const SKETCH_ID = createSketchDocumentId("skd_sheet_profile");

const RECT_LOOP: ProfileExtrudeInput["loop"] = [
  { kind: "line", start: [10, 10], end: [30, 10] },
  { kind: "line", start: [30, 10], end: [30, 25] },
  { kind: "line", start: [30, 25], end: [10, 25] },
  { kind: "line", start: [10, 25], end: [10, 10] },
];

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
  return { ok: true, value: { loop: RECT_LOOP, placement: XY_PLACEMENT } };
};

/** The sheet fixture document: sketch, distance, sheet body + feature. */
function buildSheetDocument(): CadDocument {
  let document = createDocument(createDocumentId("doc_bridge_sheet"));
  const sketched = addDocumentSketch(document, {
    id: SKETCH_ID,
    name: "profile",
    sketch: SKETCH_PAYLOAD,
  });
  if (!sketched.ok) throw new Error(sketched.error.message);
  document = sketched.value.document;
  const parameter = addDocumentParameter(document, {
    id: pDistance,
    name: "sheetDistance",
    value: length(10),
  });
  if (!parameter.ok) throw new Error(parameter.error.message);
  document = parameter.value.document;
  const body = addBody(document, {
    id: bSheet,
    name: "wall",
    kind: "sheet",
  });
  if (!body.ok) throw new Error(body.error.message);
  document = body.value.document;
  const feature: FeatureRecordInput = {
    id: fSheet,
    kind: "extrude-surface",
    inputs: [
      { kind: "sketch", id: SKETCH_ID },
      { kind: "parameter", id: pDistance },
    ],
    outputs: [bSheet],
  };
  const featured = addFeature(document, feature);
  if (!featured.ok) throw new Error(featured.error.message);
  return featured.value.document;
}

/**
 * The test-double sheets kernel: the fake kernel with the `sheets`
 * capability declared and the sheet extrude answered by a stand-in solid
 * handle (the bridge passes the handle through untouched — its own
 * behavior under test is validation, the gate, and the flag pass-through).
 */
function sheetsTestKernel() {
  const fake = createFakeKernel();
  const base = fake.extrude.bind(fake);
  return {
    kernel: {
      ...fake,
      capabilities: { ...fake.capabilities, sheets: true },
      extrude: (input: ProfileExtrudeInput) =>
        input.sheet === true
          ? fake.createBox({
              width: length(1),
              depth: length(1),
              height: length(1),
            })
          : base(input),
    } as typeof fake,
  };
}

describe("bridge extrude-surface (Phase 48 sheet seam)", () => {
  it("declines on a sheets:false kernel with the capability diagnostic", () => {
    const document = buildSheetDocument();
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
    // "executed" counts the attempt; the OUTCOME is the failed state.
    const states = run.value.states;
    const state = states.get(fSheet);
    expect(state?.state).toBe("failed");
    expect(state?.diagnostics[0]?.message).toContain("sheets");
  });

  it("executes on a sheets kernel: two inputs, sheet flag to the kernel", () => {
    const document = buildSheetDocument();
    const { kernel } = sheetsTestKernel();
    const seen: boolean[] = [];
    const extrude = kernel.extrude.bind(kernel);
    kernel.extrude = (input: ProfileExtrudeInput) => {
      seen.push(input.sheet === true);
      return extrude(input);
    };
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
    expect(run.value.executed).toEqual([fSheet]);
    expect(seen).toEqual([true]);
    expect(bridge.solidOf(bSheet)).toBeDefined();
  });

  it("declines a sheet body feeding a solid-consuming feature", () => {
    let document = buildSheetDocument();
    const solidBody = addBody(document, { id: bSolid, name: "block" });
    if (!solidBody.ok) throw new Error(solidBody.error.message);
    document = solidBody.value.document;
    const unionFeature: FeatureRecordInput = {
      id: fUnion,
      kind: "union",
      inputs: [
        { kind: "body", id: bSheet },
        { kind: "body", id: bSolid },
      ],
      outputs: [bSolid],
    };
    const featured = addFeature(document, unionFeature);
    if (!featured.ok) throw new Error(featured.error.message);
    document = featured.value.document;
    const { kernel } = sheetsTestKernel();
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
    const unionState = run.value.states.get(fUnion);
    expect(unionState?.state).toBe("failed");
    expect(unionState?.diagnostics[0]?.message).toContain("SHEET");
  });
});
