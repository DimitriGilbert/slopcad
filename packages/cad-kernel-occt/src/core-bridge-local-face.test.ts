/**
 * The local face operation kinds' bridge tests on the OCCT kernel (Phase
 * 44): the POSITIVE paths the fake kernel cannot carry — `moveFace`
 * (axis selector + signed distance through document parameters, with
 * `parameter.set` re-drives) and `replaceFace` (the datum-plane re-close
 * through the reference + datum resolution battery) — executed end to
 * end through the document/bridge/regeneration machinery with REAL
 * topology: the face reference is minted against the kernel's own
 * snapshot of the box the first regeneration produced, exactly the
 * minting path a picking layer drives, and the second regeneration
 * resolves it against the current topology before the kernel call.
 */

import { beforeAll, describe, expect, it } from "vitest";
import {
  addBody,
  addDocumentDatum,
  addDocumentParameter,
  addDocumentReference,
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
  dimensionless,
  type FeatureRecordInput,
  initialRegenerationStates,
  length,
  mintTopologyReference,
  referenceProvenance,
  regenerate,
  serializeTopologyReference,
} from "@slopcad/cad-core";
import type { Diagnostic } from "@slopcad/cad-core";
import {
  createKernelFeatureExecutor,
  type KernelExecutorContext,
} from "@slopcad/cad-kernel";
import { EXACT_VOLUME_TOLERANCE } from "@slopcad/cad-kernel/contract-suite";
import type { KernelSolid } from "@slopcad/cad-kernel";

import { occtKernelFromRuntime, type OcctKernel } from "./occt-kernel";
import { createOcctRuntime, type OcctRuntime } from "./occt-runtime";
import { occtTopologyView } from "./occt-topology";

let runtime: OcctRuntime;

beforeAll(async () => {
  runtime = await createOcctRuntime();
});

const pWidth = createParameterId("param_occt_lf_w");
const pDepth = createParameterId("param_occt_lf_d");
const pHeight = createParameterId("param_occt_lf_h");
const pAxis = createParameterId("param_occt_lf_axis");
const pDistance = createParameterId("param_occt_lf_distance");
const pHeal = createParameterId("param_occt_lf_heal");
const bBlock = createBodyId("body_occt_lf_block");
const bAction = createBodyId("body_occt_lf_action");
const fBox = createFeatureId("feat_occt_lf_box");
const fAction = createFeatureId("feat_occt_lf_action");
const rTop = createReferenceId("ref_occt_lf_top");
const dtmReplace = createDatumId("dtm_occt_lf_replace");

const BOX = { w: 30, d: 20, h: 10 } as const;

/** The replace fixture's plane: parallel, at z = 8 (the shrink station). */
const REPLACE_PLANE_PAYLOAD = {
  formatVersion: 1,
  datumType: "plane",
  definition: "originFrame",
  origin: [0, 0, 8],
  normal: [0, 0, 1],
  xAxis: [1, 0, 0],
} as const;

const BOX_ONLY_PARAMETERS: readonly [
  ReturnType<typeof createParameterId>,
  string,
  ReturnType<typeof length> | ReturnType<typeof dimensionless>,
][] = [
  [pWidth, "boxWidth", length(BOX.w)],
  [pDepth, "boxDepth", length(BOX.d)],
  [pHeight, "boxHeight", length(BOX.h)],
  [pAxis, "moveAxis", dimensionless(3)],
  [pDistance, "moveDistance", length(2)],
];

/** Adds the parameters, bodies, and the box feature to a fresh document. */
function baseDocument(distanceMm: number): CadDocument {
  let document = createDocument(createDocumentId("doc_occt_bridge_lf"));
  for (const [id, name, value] of [
    ...BOX_ONLY_PARAMETERS.slice(0, 3),
    [pAxis, "moveAxis", dimensionless(3)],
    [pDistance, "moveDistance", length(distanceMm)],
    [pHeal, "deleteHeal", dimensionless(0)],
  ] as const) {
    const added = addDocumentParameter(document, { id, name, value });
    if (!added.ok) throw new Error(added.error.message);
    document = added.value.document;
  }
  for (const body of [
    { id: bBlock, name: "block" },
    { id: bAction, name: "action" },
  ]) {
    const added = addBody(document, body);
    if (!added.ok) throw new Error(added.error.message);
    document = added.value.document;
  }
  const boxed = addFeature(document, {
    id: fBox,
    kind: "box",
    inputs: [
      { kind: "parameter", id: pWidth },
      { kind: "parameter", id: pDepth },
      { kind: "parameter", id: pHeight },
    ],
    outputs: [bBlock],
  } satisfies FeatureRecordInput);
  if (!boxed.ok) throw new Error(boxed.error.message);
  document = boxed.value.document;
  return document;
}

const NO_PROFILES: Pick<KernelExecutorContext, "profiles"> = {
  profiles: () => ({
    ok: false,
    error: {
      code: "document/not-found",
      message: "the local face suite resolves no sketches",
      input: null,
    },
  }),
};

/** One full regeneration against a fresh kernel, topology view included. */
function regenerateWith(
  kernel: OcctKernel,
  document: CadDocument,
  view: KernelExecutorContext["topology"],
) {
  const bridge = createKernelFeatureExecutor(kernel, {
    document,
    bodies: new Map(),
    ...NO_PROFILES,
    ...(view === undefined ? {} : { topology: view }),
  });
  const run = regenerate({
    features: document.features,
    states: initialRegenerationStates(document.features),
    suppressed: [],
    execute: bridge.executor,
  });
  if (!run.ok) throw new Error(run.error.message);
  const states = new Map<
    ReturnType<typeof createFeatureId>,
    { state: string; diagnostics: readonly Diagnostic[] }
  >();
  for (const [id, status] of run.value.states) {
    states.set(id, { state: status.state, diagnostics: status.diagnostics });
  }
  return { bridge, states };
}

/**
 * Phase A of the two-phase minting: run the BOX alone on a fresh kernel
 * and mint the top-face reference against its REAL snapshot — the
 * picking layer's path. Returns the kernel (the SAME instance phase B
 * must regenerate on — the identity hash is per-build, so the reference
 * resolves against the minting kernel's own shapes) and the solid the
 * view stands over.
 */
function mintTopFaceReference(
  kernel: OcctKernel,
  document: CadDocument,
): { readonly document: CadDocument; readonly block: KernelSolid } {
  const { bridge } = regenerateWith(kernel, document, undefined);
  const block = bridge.solidOf(bBlock);
  if (block === undefined) throw new Error("the box feature built nothing");
  const snapshot = kernel.topologySnapshot(block, {
    bodyId: bBlock,
    regeneration: 1,
    kinds: ["face"],
  });
  if (!snapshot.ok) throw new Error(snapshot.error.message);
  const top = snapshot.value.entities.find(
    (entity) =>
      entity.geometry.centroidAbsoluteMm !== undefined &&
      Math.abs(entity.geometry.centroidAbsoluteMm[2] - BOX.h) < 1e-9,
  );
  if (top === undefined) throw new Error("no top face in the snapshot");
  const provenance = referenceProvenance(document, bBlock);
  if (!provenance.ok) throw new Error(provenance.error.message);
  const minted = mintTopologyReference(
    snapshot.value,
    top.ordinal,
    provenance.value,
    { id: rTop, kind: "face" },
  );
  if (!minted.ok) throw new Error(minted.error.message);
  const referenced = addDocumentReference(document, {
    id: rTop,
    name: "top face",
    reference: { ...serializeTopologyReference(minted.value) },
  });
  if (!referenced.ok) throw new Error(referenced.error.message);
  return { document: referenced.value.document, block };
}

describe("bridge moveFace on OCCT: axis + distance through parameters", () => {
  /** Mints the reference on its own kernel; phase B must reuse BOTH. */
  function moveFaceDocument(distanceMm: number): {
    readonly document: CadDocument;
    readonly kernel: OcctKernel;
    readonly block: KernelSolid;
  } {
    const kernel = occtKernelFromRuntime(runtime);
    const minted = mintTopFaceReference(kernel, baseDocument(distanceMm));
    const featured = addFeature(minted.document, {
      id: fAction,
      kind: "moveFace",
      inputs: [
        { kind: "feature", id: fBox },
        { kind: "reference", id: rTop },
        { kind: "parameter", id: pAxis },
        { kind: "parameter", id: pDistance },
      ],
      outputs: [bAction],
    } satisfies FeatureRecordInput);
    if (!featured.ok) throw new Error(featured.error.message);
    return {
      document: featured.value.document,
      kernel,
      block: minted.block,
    };
  }

  /**
   * Phase B — the REAL incremental flow: the box feature stands VALID from
   * the minting run (its prior state keeps regeneration from re-executing
   * it), its solid rides the context's prior-bodies map, and the view
   * stands over that SAME solid — the identity hash matches (it is
   * per-build), so the reference resolves VALID against the current
   * regeneration, exactly the session flow a picking layer drives.
   */
  function runMoveFace(setup: {
    readonly document: CadDocument;
    readonly kernel: OcctKernel;
    readonly block: KernelSolid;
  }): ReturnType<typeof regenerateWith> {
    const bridge = createKernelFeatureExecutor(setup.kernel, {
      document: setup.document,
      bodies: new Map([[bBlock, setup.block]]),
      ...NO_PROFILES,
      topology: occtTopologyView(setup.kernel, {
        regeneration: 1,
        bodies: new Map([[bBlock, setup.block]]),
      }),
    });
    const run = regenerate({
      features: setup.document.features,
      states: new Map([
        [fBox, { state: "valid", diagnostics: [] }],
        [fAction, { state: "stale", diagnostics: [] }],
      ]),
      suppressed: [],
      execute: bridge.executor,
    });
    if (!run.ok) throw new Error(run.error.message);
    const states = new Map<
      ReturnType<typeof createFeatureId>,
      { state: string; diagnostics: readonly Diagnostic[] }
    >();
    for (const [id, status] of run.value.states) {
      states.set(id, { state: status.state, diagnostics: status.diagnostics });
    }
    return { bridge, states };
  }

  it("moves the top face +2 mm along Z to the exact 7200 mm³", () => {
    const setup = moveFaceDocument(2);
    const { kernel, bridge, states } = {
      ...runMoveFace(setup),
      kernel: setup.kernel,
    };
    expect(states.get(fAction)?.state).toBe("valid");
    const solid = bridge.solidOf(bAction);
    expect(solid).toBeDefined();
    if (solid === undefined) return;
    const volume = kernel.volume(solid);
    if (!volume.ok) throw new Error(volume.error.message);
    expect(Math.abs(volume.value - 7200)).toBeLessThanOrEqual(
      EXACT_VOLUME_TOLERANCE,
    );
  });

  it("re-drives the move from a parameter edit (+2 → −2 = 4800 mm³)", () => {
    const setup = moveFaceDocument(2);
    const set = applyCommand(setup.document, {
      type: "parameter.set",
      id: pDistance,
      value: length(-2),
    });
    expect(set.ok).toBe(true);
    if (!set.ok) return;
    const edited = { ...setup, document: set.value };
    const { kernel, bridge, states } = {
      ...runMoveFace(edited),
      kernel: setup.kernel,
    };
    expect(states.get(fAction)?.state).toBe("valid");
    const solid = bridge.solidOf(bAction);
    expect(solid).toBeDefined();
    if (solid === undefined) return;
    const volume = kernel.volume(solid);
    if (!volume.ok) throw new Error(volume.error.message);
    expect(Math.abs(volume.value - 4800)).toBeLessThanOrEqual(
      EXACT_VOLUME_TOLERANCE,
    );
  });
});

describe("bridge replaceFace on OCCT: the datum-plane re-close", () => {
  it("re-closes the top face at the parallel z = 8 plane (4800 mm³)", () => {
    const kernel = occtKernelFromRuntime(runtime);
    const minted = mintTopFaceReference(kernel, baseDocument(2));
    const datum = addDocumentDatum(minted.document, {
      id: dtmReplace,
      name: "replace plane",
      datum: REPLACE_PLANE_PAYLOAD,
    });
    if (!datum.ok) throw new Error(datum.error.message);
    const featured = addFeature(datum.value.document, {
      id: fAction,
      kind: "replaceFace",
      inputs: [
        { kind: "feature", id: fBox },
        { kind: "reference", id: rTop },
        { kind: "datum", id: dtmReplace },
      ],
      outputs: [bAction],
    } satisfies FeatureRecordInput);
    if (!featured.ok) throw new Error(featured.error.message);
    const document = featured.value.document;

    // The incremental flow: the box stands valid, its solid is the prior
    // body, the view stands over it (see runMoveFace's doc).
    const bridge = createKernelFeatureExecutor(kernel, {
      document,
      bodies: new Map([[bBlock, minted.block]]),
      ...NO_PROFILES,
      topology: occtTopologyView(kernel, {
        regeneration: 1,
        bodies: new Map([[bBlock, minted.block]]),
      }),
    });
    const run = regenerate({
      features: document.features,
      states: new Map([
        [fBox, { state: "valid", diagnostics: [] }],
        [fAction, { state: "stale", diagnostics: [] }],
      ]),
      suppressed: [],
      execute: bridge.executor,
    });
    if (!run.ok) throw new Error(run.error.message);
    expect(run.value.states.get(fAction)?.state).toBe("valid");
    const solid = bridge.solidOf(bAction);
    expect(solid).toBeDefined();
    if (solid === undefined) return;
    const volume = kernel.volume(solid);
    if (!volume.ok) throw new Error(volume.error.message);
    expect(Math.abs(volume.value - 4800)).toBeLessThanOrEqual(
      EXACT_VOLUME_TOLERANCE,
    );
  });
});

describe("bridge deleteFace on OCCT: the honest surface", () => {
  it("executes the call and surfaces the structured refusal as the feature diagnostic", () => {
    const kernel = occtKernelFromRuntime(runtime);
    const minted = mintTopFaceReference(kernel, baseDocument(2));
    const featured = addFeature(minted.document, {
      id: fAction,
      kind: "deleteFace",
      inputs: [
        { kind: "feature", id: fBox },
        { kind: "reference", id: rTop },
        { kind: "parameter", id: pHeal },
      ],
      outputs: [bAction],
    } satisfies FeatureRecordInput);
    if (!featured.ok) throw new Error(featured.error.message);
    const document = featured.value.document;

    const bridge = createKernelFeatureExecutor(kernel, {
      document,
      bodies: new Map([[bBlock, minted.block]]),
      ...NO_PROFILES,
      topology: occtTopologyView(kernel, {
        regeneration: 1,
        bodies: new Map([[bBlock, minted.block]]),
      }),
    });
    const run = regenerate({
      features: document.features,
      states: new Map([
        [fBox, { state: "valid", diagnostics: [] }],
        [fAction, { state: "stale", diagnostics: [] }],
      ]),
      suppressed: [],
      execute: bridge.executor,
    });
    if (!run.ok) throw new Error(run.error.message);
    const status = run.value.states.get(fAction);
    expect(status?.state).toBe("failed");
    const diagnostic = status?.diagnostics[0];
    expect(JSON.stringify(diagnostic?.data ?? {})).toContain(
      "kernel/unsupported-operation",
    );
    expect(diagnostic?.message).toContain("deleteFace is unsupported");
  });
});
