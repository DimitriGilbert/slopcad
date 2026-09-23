/**
 * The Phase 49 surface feature kinds of the kernel feature bridge:
 * `create-sheet` (one datum plane + kind + the kind's parameters), and the
 * sheet-consuming family `trim-surface` / `thicken-surface` /
 * `knit-surface` / `offset-surface` (the `sheetInput` operand gate's
 * consumers). The bridge's own job is input validation, the operand gate,
 * the capability gate, and the pass-through — the GEOMETRY is the OCCT
 * adapter's suite's province (the `surfaceOps` analytic fixtures), so the
 * positive executions here ride a test-double kernel whose surface
 * operations answer stand-in handles while RECORDING the kernel-level
 * arguments they received.
 */

import { describe, expect, it } from "vitest";
import {
  addBody,
  addDocumentDatum,
  addDocumentParameter,
  addFeature,
  createBodyId,
  createDatumId,
  createDocument,
  createDocumentId,
  createFeatureId,
  createParameterId,
  dimensionless,
  initialRegenerationStates,
  regenerate,
  length as lengthValue,
  ok,
  type CadDocument,
} from "@slopcad/cad-core";
import type {
  KernelSolid,
  SheetKnitInput,
  SheetOffsetInput,
  SheetSurfaceInput,
  SheetTrimInput,
} from "./contract";

import { createKernelFeatureExecutor } from "./core-bridge";
import { createFakeKernel } from "./fake-kernel";

const DOC_ID = createDocumentId("doc_surface_bridge");
const DATUM_ID = createDatumId("dtm_surface_base");
const bSheet = createBodyId("body_surface_base");
const bSheet2 = createBodyId("body_surface_tool");
const fCreate = createFeatureId("feat_create_sheet");
const fTrim = createFeatureId("feat_trim_surface");
const fThicken = createFeatureId("feat_thicken_surface");
const fKnit = createFeatureId("feat_knit_surface");
const fOffset = createFeatureId("feat_offset_surface");

const pKind = createParameterId("param_sheet_kind");
const pUMin = createParameterId("param_sheet_umin");
const pUMax = createParameterId("param_sheet_umax");
const pVMin = createParameterId("param_sheet_vmin");
const pVMax = createParameterId("param_sheet_vmax");
const pKeep = createParameterId("param_trim_keep");
const pThickness = createParameterId("param_thicken_wall");
const pSide = createParameterId("param_thicken_side");
const pTolerance = createParameterId("param_knit_tol");
const pDistance = createParameterId("param_offset_distance");

function baseDocument(): CadDocument {
  let document = createDocument(DOC_ID);
  const datum = addDocumentDatum(document, {
    id: DATUM_ID,
    name: "Base plane",
    datum: {
      formatVersion: 1,
      datumType: "plane",
      definition: "originFrame",
      origin: [0, 0, 0],
      normal: [0, 0, 1],
      xAxis: [1, 0, 0],
    } as const,
  });
  if (!datum.ok) throw new Error(datum.error.message);
  document = datum.value.document;
  const params: readonly {
    readonly id: typeof pKind;
    readonly dimension: "length" | "angle" | "dimensionless";
    readonly value: number;
  }[] = [
    { id: pKind, dimension: "dimensionless", value: 0 },
    { id: pUMin, dimension: "length", value: 0 },
    { id: pUMax, dimension: "length", value: 30 },
    { id: pVMin, dimension: "length", value: 0 },
    { id: pVMax, dimension: "length", value: 20 },
    { id: pKeep, dimension: "dimensionless", value: 1 },
    { id: pThickness, dimension: "length", value: 2 },
    { id: pSide, dimension: "dimensionless", value: 1 },
    { id: pTolerance, dimension: "length", value: 0.001 },
    { id: pDistance, dimension: "length", value: 3 },
  ];
  for (const parameter of params) {
    const added = addDocumentParameter(document, {
      id: parameter.id,
      name: parameter.id.slice(-6),
      value:
        parameter.dimension === "length"
          ? lengthValue(parameter.value)
          : parameter.dimension === "angle"
            ? { dimension: "angle", unit: "rad", value: parameter.value }
            : dimensionless(parameter.value),
    });
    if (!added.ok) throw new Error(added.error.message);
    document = added.value.document;
  }
  return document;
}

/**
 * The test-double surface kernel: the fake kernel with the sheet
 * capabilities declared, every surface operation answered by a stand-in
 * box handle, and every call RECORDED so the assertions pin the
 * kernel-level arguments the bridge passed through.
 */
function surfaceTestKernel() {
  const fake = createFakeKernel();
  const seen: {
    readonly trim: SheetTrimInput[];
    knit: SheetKnitInput | undefined;
    offset: SheetOffsetInput | undefined;
    readonly created: string[];
  } = { trim: [], knit: undefined, offset: undefined, created: [] };
  const box = (): KernelSolid => {
    const handle = fake.createBox({
      width: lengthValue(1),
      depth: lengthValue(1),
      height: lengthValue(1),
    });
    if (!handle.ok) throw new Error(handle.error.message);
    return handle.value;
  };
  const kernel = {
    ...fake,
    capabilities: { ...fake.capabilities, sheets: true, surfaceOps: true },
    createSheet: (input: SheetSurfaceInput) => {
      seen.created.push(input.kind);
      return ok(box());
    },
    trimSheet: (input: SheetTrimInput) => {
      seen.trim.push(input);
      return ok(box());
    },
    thickenSheet: () => ok(box()),
    knit: (input: SheetKnitInput) => {
      seen.knit = input;
      return ok(box());
    },
    offsetSheet: (input: SheetOffsetInput) => {
      seen.offset = input;
      return ok(box());
    },
  };
  return { kernel, seen };
}

function runExecutor(
  document: CadDocument,
  kernel: ReturnType<typeof createFakeKernel>,
  bodies: ReadonlyMap<ReturnType<typeof createBodyId>, KernelSolid> = new Map(),
) {
  const bridge = createKernelFeatureExecutor(kernel, {
    document,
    bodies: new Map(bodies),
    profiles: () => ({
      ok: false,
      error: {
        code: "kernel/invalid-profile",
        message: "no profiles",
        input: null,
      },
    }),
  });
  return regenerate({
    features: document.features,
    states: initialRegenerationStates(document.features),
    suppressed: [],
    execute: bridge.executor,
  });
}

describe("bridge create-sheet (Phase 49)", () => {
  it("builds the datum-bound plane patch through the kind index", () => {
    let document = baseDocument();
    const sheetBody = addBody(document, {
      id: bSheet,
      name: "wall",
      kind: "sheet",
    });
    if (!sheetBody.ok) throw new Error(sheetBody.error.message);
    document = sheetBody.value.document;
    const featured = addFeature(document, {
      id: fCreate,
      kind: "create-sheet",
      inputs: [
        { kind: "datum", id: DATUM_ID },
        { kind: "parameter", id: pKind },
        { kind: "parameter", id: pUMin },
        { kind: "parameter", id: pUMax },
        { kind: "parameter", id: pVMin },
        { kind: "parameter", id: pVMax },
      ],
      outputs: [bSheet],
    });
    if (!featured.ok) throw new Error(featured.error.message);
    document = featured.value.document;
    const { kernel, seen } = surfaceTestKernel();
    const run = runExecutor(document, kernel);
    if (!run.ok) throw new Error(run.error.message);
    expect(run.value.executed).toEqual([fCreate]);
    expect(seen.created).toEqual(["plane"]);
  });

  it("declines a solid body operand of a sheet-consuming kind (the sheetInput gate)", () => {
    let document = baseDocument();
    const sheetBody0 = addBody(document, {
      id: bSheet,
      name: "out",
      kind: "sheet",
    });
    if (!sheetBody0.ok) throw new Error(sheetBody0.error.message);
    document = sheetBody0.value.document;
    const solidBody = addBody(document, { id: bSheet2, name: "block" });
    if (!solidBody.ok) throw new Error(solidBody.error.message);
    document = solidBody.value.document;
    const featured = addFeature(document, {
      id: fTrim,
      kind: "trim-surface",
      inputs: [
        { kind: "body", id: bSheet2 },
        { kind: "body", id: bSheet2 },
        { kind: "parameter", id: pKeep },
      ],
      outputs: [bSheet],
    });
    if (!featured.ok) throw new Error(featured.error.message);
    document = featured.value.document;
    const { kernel } = surfaceTestKernel();
    const run = runExecutor(document, kernel);
    if (!run.ok) throw new Error(run.error.message);
    const state = run.value.states.get(fTrim);
    expect(state?.state).toBe("failed");
    expect(state?.diagnostics[0]?.message).toContain("SHEET");
  });

  it("passes the trim operands and keep side through to the kernel", () => {
    let document = baseDocument();
    const sheetBody = addBody(document, {
      id: bSheet,
      name: "wall",
      kind: "sheet",
    });
    if (!sheetBody.ok) throw new Error(sheetBody.error.message);
    document = sheetBody.value.document;
    const toolBody = addBody(document, {
      id: bSheet2,
      name: "tool",
      kind: "sheet",
    });
    if (!toolBody.ok) throw new Error(toolBody.error.message);
    document = toolBody.value.document;
    const featured = addFeature(document, {
      id: fTrim,
      kind: "trim-surface",
      inputs: [
        { kind: "body", id: bSheet },
        { kind: "body", id: bSheet2 },
        { kind: "parameter", id: pKeep },
      ],
      outputs: [bSheet],
    });
    if (!featured.ok) throw new Error(featured.error.message);
    document = featured.value.document;
    const { kernel, seen } = surfaceTestKernel();
    const handle = kernel.createBox({
      width: lengthValue(1),
      depth: lengthValue(1),
      height: lengthValue(1),
    });
    if (!handle.ok) throw new Error(handle.error.message);
    const run = runExecutor(
      document,
      kernel,
      new Map([
        [bSheet, handle.value],
        [bSheet2, handle.value],
      ]),
    );
    if (!run.ok) throw new Error(run.error.message);
    expect(run.value.executed).toEqual([fTrim]);
    const trim = seen.trim[0];
    expect(trim?.keepInside).toBe(true);
  });

  it("passes the knit operands and sewing tolerance through to the kernel", () => {
    let document = baseDocument();
    const sheetBody = addBody(document, {
      id: bSheet,
      name: "wall",
      kind: "sheet",
    });
    if (!sheetBody.ok) throw new Error(sheetBody.error.message);
    document = sheetBody.value.document;
    const toolBody = addBody(document, {
      id: bSheet2,
      name: "tool",
      kind: "sheet",
    });
    if (!toolBody.ok) throw new Error(toolBody.error.message);
    document = toolBody.value.document;
    const featured = addFeature(document, {
      id: fKnit,
      kind: "knit-surface",
      inputs: [
        { kind: "body", id: bSheet },
        { kind: "body", id: bSheet2 },
        { kind: "parameter", id: pTolerance },
      ],
      outputs: [bSheet],
    });
    if (!featured.ok) throw new Error(featured.error.message);
    document = featured.value.document;
    const { kernel, seen } = surfaceTestKernel();
    const handle = kernel.createBox({
      width: lengthValue(1),
      depth: lengthValue(1),
      height: lengthValue(1),
    });
    if (!handle.ok) throw new Error(handle.error.message);
    const run = runExecutor(
      document,
      kernel,
      new Map([
        [bSheet, handle.value],
        [bSheet2, handle.value],
      ]),
    );
    if (!run.ok) throw new Error(run.error.message);
    expect(run.value.executed).toEqual([fKnit]);
    expect(seen.knit?.bodies).toHaveLength(2);
    expect(seen.knit?.tolerance.value).toBe(0.001);
  });

  it("passes the offset target and signed distance through to the kernel", () => {
    let document = baseDocument();
    const sheetBody = addBody(document, {
      id: bSheet,
      name: "wall",
      kind: "sheet",
    });
    if (!sheetBody.ok) throw new Error(sheetBody.error.message);
    document = sheetBody.value.document;
    const featured = addFeature(document, {
      id: fOffset,
      kind: "offset-surface",
      inputs: [
        { kind: "body", id: bSheet },
        { kind: "parameter", id: pDistance },
      ],
      outputs: [bSheet],
    });
    if (!featured.ok) throw new Error(featured.error.message);
    document = featured.value.document;
    const { kernel, seen } = surfaceTestKernel();
    const handle = kernel.createBox({
      width: lengthValue(1),
      depth: lengthValue(1),
      height: lengthValue(1),
    });
    if (!handle.ok) throw new Error(handle.error.message);
    const run = runExecutor(
      document,
      kernel,
      new Map([[bSheet, handle.value]]),
    );
    if (!run.ok) throw new Error(run.error.message);
    expect(run.value.executed).toEqual([fOffset]);
    expect(seen.offset?.distance.value).toBe(3);
  });

  it("gates the whole family on a surfaceOps:false kernel", () => {
    let document = baseDocument();
    const sheetBody = addBody(document, {
      id: bSheet,
      name: "wall",
      kind: "sheet",
    });
    if (!sheetBody.ok) throw new Error(sheetBody.error.message);
    document = sheetBody.value.document;
    const featured = addFeature(document, {
      id: fThicken,
      kind: "thicken-surface",
      inputs: [
        { kind: "body", id: bSheet },
        { kind: "parameter", id: pThickness },
        { kind: "parameter", id: pSide },
      ],
      outputs: [bSheet],
    });
    if (!featured.ok) throw new Error(featured.error.message);
    document = featured.value.document;
    const fake = createFakeKernel();
    const handle = fake.createBox({
      width: lengthValue(1),
      depth: lengthValue(1),
      height: lengthValue(1),
    });
    if (!handle.ok) throw new Error(handle.error.message);
    const bridge = createKernelFeatureExecutor(fake, {
      document,
      bodies: new Map([[bSheet, handle.value]]),
      profiles: () => ({
        ok: false,
        error: {
          code: "kernel/invalid-profile",
          message: "no profiles",
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
    const state = run.value.states.get(fThicken);
    expect(state?.state).toBe("failed");
    expect(state?.diagnostics[0]?.message).toContain("surfaceOps");
  });
});
