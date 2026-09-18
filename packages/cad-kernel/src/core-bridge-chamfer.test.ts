/**
 * The chamfer feature's bridge tests (Phase 26.6): the fillet bridge
 * layout carried to the chamfer — a target feature + a document REFERENCE
 * record (the Phase 22 persistent edge reference) + a distance parameter
 * → the bridge's `chamfer` kind → the fake kernel's analytic box chamfer.
 * The edge-reference resolution battery itself is the SHARED executor path
 * (`runEdgeCutOperation`) the fillet tests prove case by case; these tests
 * pin the chamfer-specific surfaces: semantic volume, distance-driven
 * regeneration, the layout failure, the absent-view failure, and the
 * stale-reference decline.
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

const pWidth = createParameterId("param_chamfer_box_w");
const pDepth = createParameterId("param_chamfer_box_d");
const pHeight = createParameterId("param_chamfer_box_h");
const pDistance = createParameterId("param_chamfer_distance");
const bBlock = createBodyId("body_chamfer_block");
const bBeveled = createBodyId("body_beveled");
const fBox = createFeatureId("feat_chamfer_box");
const fChamfer = createFeatureId("feat_chamfer");
const rEdge = createReferenceId("ref_chamfer_corner_edge");

/** The fixture box's extents (mm) — the fake kernel's analytic chamfer domain. */
const BOX = { w: 30, d: 20, h: 10 } as const;

/**
 * The fixture edge: ordinal 5 of the fake kernel's box-edge table — the
 * y-direction edge at (x = width, z = 0), length = depth.
 */
const EDGE_ORDINAL = 5;
const EDGE_LENGTH_MM = BOX.d;

/** The fixture snapshot identity payload the reference is minted against. */
const FIXTURE_KERNEL_ID = "fixture-kernel";
const FIXTURE_SCHEMA = "fixture-snapshot-v1";
const FIXTURE_HASH = 7171;

/** The hand-built snapshot the fixture view answers with. */
function fixtureSnapshot(
  bodyId: ReturnType<typeof createBodyId>,
  hash: number = FIXTURE_HASH,
): TopologySnapshot {
  const entity: TopologyEntitySnapshot = {
    kind: "edge",
    ordinal: EDGE_ORDINAL,
    identity: {
      kernelId: FIXTURE_KERNEL_ID,
      schema: FIXTURE_SCHEMA,
      data: { hash },
    },
    geometry: {
      lengthMm: EDGE_LENGTH_MM,
      centroidAbsoluteMm: [BOX.w, BOX.d / 2, 0],
      centroidRelativeMm: [BOX.w / 2, 0, -BOX.h / 2],
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

/** Builds the chamfer document: box feature + reference record + chamfer feature. */
function buildChamferDocument(distanceMm: number): CadDocument {
  let document = createDocument(createDocumentId("doc_bridge_chamfer"));
  for (const [id, name, value] of [
    [pWidth, "boxWidth", BOX.w],
    [pDepth, "boxDepth", BOX.d],
    [pHeight, "boxHeight", BOX.h],
    [pDistance, "chamferDistance", distanceMm],
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
  const beveled = addBody(document, { id: bBeveled, name: "beveled" });
  if (!beveled.ok) throw new Error(beveled.error.message);
  document = beveled.value.document;
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
    EDGE_ORDINAL,
    provenance.value,
    {
      id: rEdge,
      kind: "edge",
    },
  );
  if (!minted.ok) throw new Error(minted.error.message);
  const referenced = addDocumentReference(document, {
    id: rEdge,
    name: "corner edge",
    reference: { ...serializeTopologyReference(minted.value) },
  });
  if (!referenced.ok) throw new Error(referenced.error.message);
  document = referenced.value.document;

  const chamfer: FeatureRecordInput = {
    id: fChamfer,
    kind: "chamfer",
    inputs: [
      { kind: "feature", id: fBox },
      { kind: "reference", id: rEdge },
      { kind: "parameter", id: pDistance },
    ],
    outputs: [bBeveled],
  };
  const featured = addFeature(document, chamfer);
  if (!featured.ok) throw new Error(featured.error.message);
  document = featured.value.document;
  return document;
}

/** Regenerates the chamfer document against a fresh fake kernel + fixture view. */
function runChamfer(
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

describe("bridge chamfer: target + edge references + distance → kernel chamfer", () => {
  it("resolves the edge reference and executes the analytic corner chamfer", () => {
    const { kernel, bridge, states } = runChamfer(buildChamferDocument(2));
    expect(states.get(fChamfer)?.state).toBe("valid");
    const solid = bridge.solidOf(bBeveled);
    expect(solid).toBeDefined();
    if (solid === undefined) return;
    // Ordinal 5 addresses the y-edge of length 20: the analytic removal is
    // d²/2·20 with d = 2.
    assertVolumeClose(
      unwrapKernelResult(kernel.volume(solid), "chamfer volume"),
      BOX.w * BOX.d * BOX.h - ((2 * 2) / 2) * EDGE_LENGTH_MM,
      1e-9,
    );
  });

  it("re-drives the chamfer from a distance parameter edit", () => {
    const document = buildChamferDocument(2);
    const set = applyCommand(document, {
      type: "parameter.set",
      id: pDistance,
      value: length(4),
    });
    expect(set.ok).toBe(true);
    if (!set.ok) return;
    const { kernel, bridge, states } = runChamfer(set.value);
    expect(states.get(fChamfer)?.state).toBe("valid");
    const solid = bridge.solidOf(bBeveled);
    expect(solid).toBeDefined();
    if (solid === undefined) return;
    assertVolumeClose(
      unwrapKernelResult(kernel.volume(solid), "regenerated chamfer volume"),
      BOX.w * BOX.d * BOX.h - ((4 * 4) / 2) * EDGE_LENGTH_MM,
      1e-9,
    );
  });

  it("fails with a structured stale-reference diagnostic when the edge vanished", () => {
    // A view whose snapshot carries a DIFFERENT hash: the minted identity
    // died (the Phase 22 rebuild finding) → the reference stands missing →
    // the chamfer feature fails regeneration with the state named.
    const stale = fixtureView(bBlock, 999999);
    const { states } = runChamfer(buildChamferDocument(2), { view: stale });
    const status = states.get(fChamfer);
    expect(status?.state).toBe("failed");
    const diagnostic = status?.diagnostics[0];
    expect(diagnostic).toBeDefined();
    expect(diagnostic?.severity).toBe("error");
    expect(JSON.stringify(diagnostic?.data ?? {})).toContain("missing");
    expect(diagnostic?.message).toContain("unresolved edge reference");
  });

  it("fails structured when the context carries no topology view", () => {
    const { states } = runChamfer(buildChamferDocument(2), { omitView: true });
    const status = states.get(fChamfer);
    expect(status?.state).toBe("failed");
    const diagnostic = status?.diagnostics[0];
    expect(diagnostic?.message).toContain("no topology view");
  });

  it("fails structured on the malformed layout (a second cut-size parameter)", () => {
    let document = buildChamferDocument(2);
    // The malformed feature's output body must exist as a document body
    // before the feature record can declare it.
    const malformedBody = createBodyId("body_malformed_chamfer");
    const body = addBody(document, { id: malformedBody, name: "malformed" });
    expect(body.ok).toBe(true);
    if (!body.ok) return;
    document = body.value.document;
    // Two parameter inputs instead of one: the layout check fires before
    // any resolution or kernel call.
    const malformed = addFeature(document, {
      id: createFeatureId("feat_chamfer_malformed"),
      kind: "chamfer",
      inputs: [
        { kind: "feature", id: fBox },
        { kind: "reference", id: rEdge },
        { kind: "parameter", id: pDistance },
        { kind: "parameter", id: pWidth },
      ],
      outputs: [malformedBody],
    });
    expect(malformed.ok).toBe(true);
    if (!malformed.ok) return;
    document = malformed.value.document;
    const { states } = runChamfer(document);
    const status = states.get(createFeatureId("feat_chamfer_malformed"));
    expect(status?.state).toBe("failed");
    expect(status?.diagnostics[0]?.message).toContain(
      "exactly one parameter input (the distance)",
    );
  });
});
