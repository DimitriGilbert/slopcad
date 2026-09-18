/**
 * The shell feature's bridge tests (Phase 26.7): the fillet/chamfer bridge
 * layout carried to the FACE-addressed hollow — a target feature + a
 * document REFERENCE record (the Phase 22 persistent FACE reference) + a
 * thickness parameter → the bridge's `shell` kind → the fake kernel's
 * analytic open-box shell. The reference-resolution battery itself is the
 * SHARED executor path (`runEdgeCutOperation`) the fillet tests prove case
 * by case; these tests pin the shell-specific surfaces: semantic volume,
 * thickness-driven regeneration, the wrong-KIND reference decline (an
 * edge reference is not a face selection), the absent-view failure, and
 * the stale-reference decline.
 *
 * The TopologyView here is a FIXTURE view (cad-core's interface over a
 * hand-built snapshot): the resolution protocol is pure, so the bridge's
 * reference handling is provable without a BREP kernel — the OCCT-adapter
 * tests cover the real snapshot side.
 */

import { describe, expect, it } from "vitest";
import {
  addBody,
  addDocumentParameter,
  addDocumentReference,
  addFeature,
  applyCommand,
  type CadDocument,
  createBodyId,
  createDocument,
  createDocumentId,
  createFeatureId,
  createParameterId,
  createReferenceId,
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
import { assertVolumeClose, unwrapKernelResult } from "./test-utils";

const pWidth = createParameterId("param_shell_box_w");
const pDepth = createParameterId("param_shell_box_d");
const pHeight = createParameterId("param_shell_box_h");
const pThickness = createParameterId("param_shell_thickness");
const bBlock = createBodyId("body_shell_block");
const bHollow = createBodyId("body_hollow");
const fBox = createFeatureId("feat_shell_box");
const fShell = createFeatureId("feat_shell");
const rFace = createReferenceId("ref_shell_top_face");

/** The fixture box's extents (mm) — the fake kernel's analytic shell domain. */
const BOX = { w: 30, d: 20, h: 10 } as const;

/**
 * The fixture face: ordinal 5 of the fake kernel's box-face table — the
 * z-high face (the top), area = width × depth.
 */
const FACE_ORDINAL = 5;

/** The fixture snapshot identity payload the reference is minted against. */
const FIXTURE_KERNEL_ID = "fixture-kernel";
const FIXTURE_SCHEMA = "fixture-snapshot-v1";
const FIXTURE_HASH = 7272;

/** The hand-built snapshot the fixture view answers with. */
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

/** The fixture view: persistent, answering only for the fixture body. */
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

/** Builds the shell document: box feature + reference record + shell feature. */
function buildShellDocument(thicknessMm: number): CadDocument {
  let document = createDocument(createDocumentId("doc_bridge_shell"));
  for (const [id, name, value] of [
    [pWidth, "boxWidth", BOX.w],
    [pDepth, "boxDepth", BOX.d],
    [pHeight, "boxHeight", BOX.h],
    [pThickness, "shellThickness", thicknessMm],
  ] as const) {
    const parameter = addDocumentParameter(document, {
      id,
      name,
      value: length(value),
    });
    if (!parameter.ok) throw new Error(parameter.error.message);
    document = parameter.value.document;
  }
  const body = addBody(document, { id: bBlock, name: "block" });
  if (!body.ok) throw new Error(body.error.message);
  document = body.value.document;
  const hollow = addBody(document, { id: bHollow, name: "hollow" });
  if (!hollow.ok) throw new Error(hollow.error.message);
  document = hollow.value.document;
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

  // Mint the persistent reference against the fixture snapshot, exactly the
  // minting path a picking layer drives (Phase 22).
  const snapshot = fixtureSnapshot(bBlock);
  const provenance = referenceProvenance(document, bBlock);
  if (!provenance.ok) throw new Error(provenance.error.message);
  const minted = mintTopologyReference(
    snapshot,
    FACE_ORDINAL,
    provenance.value,
    {
      id: rFace,
      kind: "face",
    },
  );
  if (!minted.ok) throw new Error(minted.error.message);
  const referenced = addDocumentReference(document, {
    id: rFace,
    name: "top face",
    reference: { ...serializeTopologyReference(minted.value) },
  });
  if (!referenced.ok) throw new Error(referenced.error.message);
  document = referenced.value.document;

  const shell: FeatureRecordInput = {
    id: fShell,
    kind: "shell",
    inputs: [
      { kind: "feature", id: fBox },
      { kind: "reference", id: rFace },
      { kind: "parameter", id: pThickness },
    ],
    outputs: [bHollow],
  };
  const featured = addFeature(document, shell);
  if (!featured.ok) throw new Error(featured.error.message);
  document = featured.value.document;
  return document;
}

/** Regenerates the shell document against a fresh fake kernel + fixture view. */
function runShell(
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

describe("bridge shell: target + face references + thickness → kernel shell", () => {
  it("resolves the face reference and executes the analytic open-box shell", () => {
    const { kernel, bridge, states } = runShell(buildShellDocument(2));
    expect(states.get(fShell)?.state).toBe("valid");
    const solid = bridge.solidOf(bHollow);
    expect(solid).toBeDefined();
    if (solid === undefined) return;
    // Ordinal 5 addresses the top face: the analytic cavity is
    // (w−2t)(d−2t)(h−t) with t = 2.
    assertVolumeClose(
      unwrapKernelResult(kernel.volume(solid), "shell volume"),
      BOX.w * BOX.d * BOX.h - (BOX.w - 4) * (BOX.d - 4) * (BOX.h - 2),
      1e-9,
    );
  });

  it("re-drives the shell from a thickness parameter edit", () => {
    const document = buildShellDocument(2);
    const set = applyCommand(document, {
      type: "parameter.set",
      id: pThickness,
      value: length(3),
    });
    expect(set.ok).toBe(true);
    if (!set.ok) return;
    const { kernel, bridge, states } = runShell(set.value);
    expect(states.get(fShell)?.state).toBe("valid");
    const solid = bridge.solidOf(bHollow);
    expect(solid).toBeDefined();
    if (solid === undefined) return;
    assertVolumeClose(
      unwrapKernelResult(kernel.volume(solid), "regenerated shell volume"),
      BOX.w * BOX.d * BOX.h - (BOX.w - 6) * (BOX.d - 6) * (BOX.h - 3),
      1e-9,
    );
  });

  it("fails with a structured stale-reference diagnostic when the face vanished", () => {
    // A view whose snapshot carries a DIFFERENT hash: the minted identity
    // died (the Phase 22 rebuild finding) → the reference stands missing →
    // the shell feature fails regeneration with the state named.
    const stale = fixtureView(bBlock, 999999);
    const { states } = runShell(buildShellDocument(2), { view: stale });
    const status = states.get(fShell);
    expect(status?.state).toBe("failed");
    const diagnostic = status?.diagnostics[0];
    expect(diagnostic).toBeDefined();
    expect(diagnostic?.severity).toBe("error");
    expect(JSON.stringify(diagnostic?.data ?? {})).toContain("missing");
    expect(diagnostic?.message).toContain("unresolved face reference");
  });

  it("fails structured when the context carries no topology view", () => {
    const { states } = runShell(buildShellDocument(2), { omitView: true });
    const status = states.get(fShell);
    expect(status?.state).toBe("failed");
    const diagnostic = status?.diagnostics[0];
    expect(diagnostic?.message).toContain("no topology view");
  });

  it("fails structured on the malformed layout (a second cut-size parameter)", () => {
    let document = buildShellDocument(2);
    // The malformed feature's output body must exist as a document body
    // before the feature record can declare it.
    const malformedBody = createBodyId("body_malformed_shell");
    const body = addBody(document, { id: malformedBody, name: "malformed" });
    expect(body.ok).toBe(true);
    if (!body.ok) return;
    document = body.value.document;
    // Two parameter inputs instead of one: the layout check fires before
    // any resolution or kernel call.
    const malformed = addFeature(document, {
      id: createFeatureId("feat_shell_malformed"),
      kind: "shell",
      inputs: [
        { kind: "feature", id: fBox },
        { kind: "reference", id: rFace },
        { kind: "parameter", id: pThickness },
        { kind: "parameter", id: pWidth },
      ],
      outputs: [malformedBody],
    });
    expect(malformed.ok).toBe(true);
    if (!malformed.ok) return;
    document = malformed.value.document;
    const { states } = runShell(document);
    const status = states.get(createFeatureId("feat_shell_malformed"));
    expect(status?.state).toBe("failed");
    expect(status?.diagnostics[0]?.message).toContain(
      "exactly one parameter input (the thickness)",
    );
  });

  it("fails structured when the reference addresses an EDGE, not a face", () => {
    // The wrong-KIND decline — the shell's own guard the edge cutters
    // mirror: an edge reference cannot drive a face selection.
    let document = buildShellDocument(2);
    const edgeBody = createBodyId("body_edge_ref_shell");
    const body = addBody(document, { id: edgeBody, name: "edge-driven" });
    expect(body.ok).toBe(true);
    if (!body.ok) return;
    document = body.value.document;
    const rEdge = createReferenceId("ref_shell_edge_ref");
    const snapshot: TopologySnapshot = {
      kernelId: FIXTURE_KERNEL_ID,
      persistentTopology: true,
      identitySchemas: [FIXTURE_SCHEMA],
      bodyId: bBlock,
      regeneration: 0,
      entities: [
        {
          kind: "edge",
          ordinal: 0,
          identity: {
            kernelId: FIXTURE_KERNEL_ID,
            schema: FIXTURE_SCHEMA,
            data: { hash: 5151 },
          },
          geometry: {
            lengthMm: BOX.d,
            centroidAbsoluteMm: [BOX.w, BOX.d / 2, 0],
            centroidRelativeMm: [BOX.w / 2, 0, -BOX.h / 2],
          },
        },
      ],
    };
    const provenance = referenceProvenance(document, bBlock);
    if (!provenance.ok) throw new Error(provenance.error.message);
    const minted = mintTopologyReference(snapshot, 0, provenance.value, {
      id: rEdge,
      kind: "edge",
    });
    if (!minted.ok) throw new Error(minted.error.message);
    const referenced = addDocumentReference(document, {
      id: rEdge,
      name: "an edge, not a face",
      reference: { ...serializeTopologyReference(minted.value) },
    });
    expect(referenced.ok).toBe(true);
    if (!referenced.ok) return;
    document = referenced.value.document;
    const featured = addFeature(document, {
      id: createFeatureId("feat_shell_edge_driven"),
      kind: "shell",
      inputs: [
        { kind: "feature", id: fBox },
        { kind: "reference", id: rEdge },
        { kind: "parameter", id: pThickness },
      ],
      outputs: [edgeBody],
    });
    expect(featured.ok).toBe(true);
    if (!featured.ok) return;
    document = featured.value.document;
    const { states } = runShell(document);
    const status = states.get(createFeatureId("feat_shell_edge_driven"));
    expect(status?.state).toBe("failed");
    expect(status?.diagnostics[0]?.message).toContain("needs FACE references");
  });
});
