/**
 * The local face operation kinds' bridge tests (Phase 44): the layout
 * battery, the face-reference resolution battery (the fillet/shell
 * executor path's steps — a fixture {@link TopologyView} over a
 * hand-built snapshot proves the bridge's reference handling without a
 * BREP kernel), and the HONEST DECLINES — the fake kernel declares
 * `localFaceOps: false`, so `moveFace`/`replaceFace` refuse at the
 * capability gate BEFORE any kernel call, and `deleteFace` runs its call
 * and surfaces the kernel's structured unsupported refusal as the
 * feature's diagnostic (the probed-out operation's honest surface). The
 * POSITIVE paths live in the OCCT package's twin suite
 * (`core-bridge-local-face.test.ts` there) — the one kernel that builds
 * the family.
 */

import { describe, expect, it } from "vitest";
import {
  addBody,
  addDocumentDatum,
  addDocumentParameter,
  addDocumentReference,
  addFeature,
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
  type TopologyEntitySnapshot,
  type TopologySnapshot,
  type TopologyView,
} from "@slopcad/cad-core";
import type { Diagnostic } from "@slopcad/cad-core";

import { createKernelFeatureExecutor } from "./core-bridge";
import { createFakeKernel } from "./fake-kernel";

const pWidth = createParameterId("param_lf_box_w");
const pDepth = createParameterId("param_lf_box_d");
const pHeight = createParameterId("param_lf_box_h");
const pAxis = createParameterId("param_lf_axis");
const pDistance = createParameterId("param_lf_distance");
const pHeal = createParameterId("param_lf_heal");
const bBlock = createBodyId("body_lf_block");
const bAction = createBodyId("body_lf_action");
const fBox = createFeatureId("feat_lf_box");
const fAction = createFeatureId("feat_lf_action");
const rFace = createReferenceId("ref_lf_top_face");
const dtmPlane = createDatumId("dtm_lf_plane");

const BOX = { w: 30, d: 20, h: 10 } as const;
const FACE_ORDINAL = 5;
const FIXTURE_KERNEL_ID = "fixture-kernel";
const FIXTURE_SCHEMA = "fixture-snapshot-v1";
const FIXTURE_HASH = 4444;

function fixtureSnapshot(
  bodyId: ReturnType<typeof createBodyId>,
  hash: number = FIXTURE_HASH,
): TopologySnapshot {
  const entity: TopologyEntitySnapshot = {
    kind: "face",
    ordinal: FACE_ORDINAL,
    identity: {
      kernelId: FIXTURE_KERNEL_ID,
      schema: FIXTURE_SCHEMA,
      data: { hash },
    },
    geometry: {
      areaMm2: BOX.w * BOX.d,
      centroidAbsoluteMm: [BOX.w / 2, BOX.d / 2, BOX.h],
      centroidRelativeMm: [0, 0, BOX.h / 2],
    },
  };
  return {
    kernelId: FIXTURE_KERNEL_ID,
    persistentTopology: true,
    identitySchemas: [FIXTURE_SCHEMA],
    bodyId,
    regeneration: 0,
    entities: [entity],
  };
}

function fixtureView(
  bodyId: ReturnType<typeof createBodyId>,
  hash: number = FIXTURE_HASH,
): TopologyView {
  return {
    kernelId: FIXTURE_KERNEL_ID,
    persistentTopology: true,
    identitySchemas: [FIXTURE_SCHEMA],
    snapshotOf: (id) => (id === bodyId ? fixtureSnapshot(bodyId, hash) : null),
  };
}

/**
 * Builds the local face document: the box, the minted face reference, an
 * optional datum plane, and the action feature of the given kind.
 */
function buildDocument(
  kind: "moveFace" | "replaceFace" | "deleteFace",
  options: {
    readonly distanceMm?: number;
    readonly heal?: 0 | 1;
    readonly planePayload?: Record<string, unknown>;
    readonly malformedInputs?: FeatureRecordInput["inputs"];
  } = {},
): CadDocument {
  let document = createDocument(createDocumentId("doc_bridge_local_face"));
  const parameters: readonly [
    ReturnType<typeof createParameterId>,
    string,
    ReturnType<typeof length> | ReturnType<typeof dimensionless>,
  ][] = [
    [pWidth, "boxWidth", length(BOX.w)],
    [pDepth, "boxDepth", length(BOX.d)],
    [pHeight, "boxHeight", length(BOX.h)],
    [pAxis, "moveAxis", dimensionless(3)],
    [pDistance, "moveDistance", length(options.distanceMm ?? 2)],
    [pHeal, "deleteHeal", dimensionless(options.heal ?? 0)],
  ];
  for (const [id, name, value] of parameters) {
    const added = addDocumentParameter(document, { id, name, value });
    if (!added.ok) throw new Error(added.error.message);
    document = added.value.document;
  }
  const plane = addDocumentDatum(document, {
    id: dtmPlane,
    name: "replace plane",
    datum: options.planePayload ?? {
      formatVersion: 1,
      datumType: "plane",
      definition: "originFrame",
      origin: [0, 0, BOX.h - 2],
      normal: [0, 0, 1],
      xAxis: [1, 0, 0],
    },
  });
  if (!plane.ok) throw new Error(plane.error.message);
  document = plane.value.document;
  for (const body of [
    { id: bBlock, name: "block" },
    { id: bAction, name: "action" },
  ]) {
    const added = addBody(document, body);
    if (!added.ok) throw new Error(added.error.message);
    document = added.value.document;
  }
  const box: FeatureRecordInput = {
    id: fBox,
    kind: "box",
    inputs: [
      { kind: "parameter", id: pWidth },
      { kind: "parameter", id: pDepth },
      { kind: "parameter", id: pHeight },
    ],
    outputs: [bBlock],
  };
  const boxed = addFeature(document, box);
  if (!boxed.ok) throw new Error(boxed.error.message);
  document = boxed.value.document;

  const snapshot = fixtureSnapshot(bBlock);
  const provenance = referenceProvenance(document, bBlock);
  if (!provenance.ok) throw new Error(provenance.error.message);
  const minted = mintTopologyReference(
    snapshot,
    FACE_ORDINAL,
    provenance.value,
    { id: rFace, kind: "face" },
  );
  if (!minted.ok) throw new Error(minted.error.message);
  const referenced = addDocumentReference(document, {
    id: rFace,
    name: "top face",
    reference: { ...serializeTopologyReference(minted.value) },
  });
  if (!referenced.ok) throw new Error(referenced.error.message);
  document = referenced.value.document;

  const inputs: FeatureRecordInput["inputs"] =
    options.malformedInputs ??
    (kind === "moveFace"
      ? [
          { kind: "feature", id: fBox },
          { kind: "reference", id: rFace },
          { kind: "parameter", id: pAxis },
          { kind: "parameter", id: pDistance },
        ]
      : kind === "replaceFace"
        ? [
            { kind: "feature", id: fBox },
            { kind: "reference", id: rFace },
            { kind: "datum", id: dtmPlane },
          ]
        : [
            { kind: "feature", id: fBox },
            { kind: "reference", id: rFace },
            { kind: "parameter", id: pHeal },
          ]);
  const featured = addFeature(document, {
    id: fAction,
    kind,
    inputs,
    outputs: [bAction],
  });
  if (!featured.ok) throw new Error(featured.error.message);
  document = featured.value.document;
  return document;
}

function runAction(
  document: CadDocument,
  options: { readonly view?: TopologyView; readonly omitView?: boolean } = {},
) {
  const kernel = createFakeKernel();
  const bridge = createKernelFeatureExecutor(kernel, {
    document,
    bodies: new Map(),
    profiles: () => ({
      ok: false,
      error: {
        code: "document/not-found",
        message: "no sketches",
        input: null,
      },
    }),
    topology:
      options.omitView === true
        ? undefined
        : (options.view ?? fixtureView(bBlock)),
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
  return { kernel, bridge, states };
}

describe("bridge local face ops: the capability gate and honest declines", () => {
  it("refuses moveFace at the localFaceOps gate before any kernel call", () => {
    const { states } = runAction(buildDocument("moveFace"));
    const status = states.get(fAction);
    expect(status?.state).toBe("failed");
    expect(status?.diagnostics[0]?.message).toContain("localFaceOps: false");
  });

  it("refuses replaceFace at the same gate", () => {
    const { states } = runAction(buildDocument("replaceFace"));
    const status = states.get(fAction);
    expect(status?.state).toBe("failed");
    expect(status?.diagnostics[0]?.message).toContain("localFaceOps: false");
  });

  it("runs deleteFace's call and surfaces the structured unsupported refusal", () => {
    for (const heal of [0, 1] as const) {
      const { states } = runAction(buildDocument("deleteFace", { heal }));
      const status = states.get(fAction);
      expect(status?.state).toBe("failed");
      const diagnostic = status?.diagnostics[0];
      expect(diagnostic?.code).toBe("kernel/operation-failed");
      expect(JSON.stringify(diagnostic?.data ?? {})).toContain(
        "kernel/unsupported-operation",
      );
      expect(diagnostic?.message).toContain("deleteFace is unsupported");
    }
  });
});

describe("bridge local face ops: the reference battery", () => {
  it("fails with a structured stale-reference diagnostic when the face vanished", () => {
    const stale = fixtureView(bBlock, 999999);
    const { states } = runAction(buildDocument("deleteFace"), { view: stale });
    const status = states.get(fAction);
    expect(status?.state).toBe("failed");
    expect(status?.diagnostics[0]?.message).toContain(
      "unresolved face reference",
    );
  });

  it("fails structured when the context carries no topology view", () => {
    const { states } = runAction(buildDocument("moveFace"), {
      omitView: true,
    });
    const status = states.get(fAction);
    expect(status?.state).toBe("failed");
    expect(status?.diagnostics[0]?.message).toContain("no topology view");
  });

  it("fails structured on the malformed layouts", () => {
    const cases: readonly [
      string,
      "moveFace" | "replaceFace" | "deleteFace",
      FeatureRecordInput["inputs"],
    ][] = [
      [
        "moveFace without the distance parameter",
        "moveFace",
        [
          { kind: "feature", id: fBox },
          { kind: "reference", id: rFace },
          { kind: "parameter", id: pAxis },
        ],
      ],
      [
        "replaceFace carrying a parameter instead of the datum",
        "replaceFace",
        [
          { kind: "feature", id: fBox },
          { kind: "reference", id: rFace },
          { kind: "parameter", id: pDistance },
        ],
      ],
      [
        "deleteFace without the heal parameter",
        "deleteFace",
        [
          { kind: "feature", id: fBox },
          { kind: "reference", id: rFace },
        ],
      ],
      [
        "two face references where exactly one belongs",
        "moveFace",
        [
          { kind: "feature", id: fBox },
          { kind: "reference", id: rFace },
          { kind: "reference", id: rFace },
          { kind: "parameter", id: pAxis },
          { kind: "parameter", id: pDistance },
        ],
      ],
    ];
    for (const [label, kind, malformedInputs] of cases) {
      const { states } = runAction(buildDocument(kind, { malformedInputs }));
      const status = states.get(fAction);
      expect(status?.state, label).toBe("failed");
      expect(
        status?.diagnostics[0]?.message.includes(
          "needs exactly one feature/body input",
        ),
        label,
      ).toBe(true);
    }
  });
});

describe("bridge translate: the Phase 44 optional rotation pair", () => {
  it("refuses the rotation pair on a kernel without transformRotation", () => {
    // The fake kernel declares transformRotation: false — the gate fires
    // before the kernel could silently mis-apply the rotation.
    let document = buildDocument("moveFace");
    const rotatedBody = createBodyId("body_lf_rotated");
    const body = addBody(document, { id: rotatedBody, name: "rotated" });
    expect(body.ok).toBe(true);
    if (!body.ok) return;
    document = body.value.document;
    const rotated = addFeature(document, {
      id: createFeatureId("feat_lf_rotate"),
      kind: "translate",
      inputs: [
        { kind: "feature", id: fBox },
        { kind: "parameter", id: pDistance },
        { kind: "parameter", id: pDistance },
        { kind: "parameter", id: pDistance },
        { kind: "parameter", id: pAxis },
        { kind: "parameter", id: pDistance },
      ],
      outputs: [rotatedBody],
    });
    expect(rotated.ok).toBe(true);
    if (!rotated.ok) return;
    document = rotated.value.document;
    const { states } = runAction(document);
    const status = states.get(createFeatureId("feat_lf_rotate"));
    expect(status?.state).toBe("failed");
    expect(status?.diagnostics[0]?.message).toContain(
      "declares transformRotation: false",
    );
  });

  it("refuses a wrong-length parameter tail structured", () => {
    let document = buildDocument("moveFace");
    const shortBody = createBodyId("body_lf_short");
    const body = addBody(document, { id: shortBody, name: "short" });
    expect(body.ok).toBe(true);
    if (!body.ok) return;
    document = body.value.document;
    const malformed = addFeature(document, {
      id: createFeatureId("feat_lf_short"),
      kind: "translate",
      inputs: [
        { kind: "feature", id: fBox },
        { kind: "parameter", id: pDistance },
      ],
      outputs: [shortBody],
    });
    expect(malformed.ok).toBe(true);
    if (!malformed.ok) return;
    document = malformed.value.document;
    const { states } = runAction(document);
    const status = states.get(createFeatureId("feat_lf_short"));
    expect(status?.state).toBe("failed");
    expect(status?.diagnostics[0]?.message).toContain(
      "exactly three translation parameters",
    );
  });
});
