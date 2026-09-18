/**
 * The fillet feature's bridge tests (Phase 26.5): a target feature + a
 * document REFERENCE record (the Phase 22 persistent edge reference) + a
 * radius parameter → the bridge's `fillet` kind → the fake kernel's
 * analytic box fillet — semantic volume assertions, the FULL resolution
 * failure taxonomy (stale reference → missing, transient-topology view →
 * invalid, absent view, cross-body reference, non-edge reference), the
 * failure gating (the fillet feature lands `failed` with its structured
 * diagnostic while upstream stays valid), and radius-driven regeneration.
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
  parseTopologyReference,
  referenceProvenance,
  regenerate,
  resolveDocumentReference,
  serializeTopologyReference,
  type TopologyEntitySnapshot,
  type TopologySnapshot,
  type TopologyView,
} from "@slopcad/cad-core";
import type { Diagnostic } from "@slopcad/cad-core";

import { createKernelFeatureExecutor } from "./core-bridge";
import { createFakeKernel } from "./fake-kernel";
import { assertVolumeClose, unwrapKernelResult } from "./test-utils";

const pWidth = createParameterId("param_box_w");
const pDepth = createParameterId("param_box_d");
const pHeight = createParameterId("param_box_h");
const pRadius = createParameterId("param_fillet_radius");
const bBlock = createBodyId("body_block");
const bRounded = createBodyId("body_rounded");
const fBox = createFeatureId("feat_box");
const fFillet = createFeatureId("feat_fillet");
const rEdge = createReferenceId("ref_corner_edge");

/** The fixture box's extents (mm) — the fake kernel's analytic fillet domain. */
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
const FIXTURE_HASH = 4242;

/** The hand-built snapshot the fixture view answers with. */
function fixtureSnapshot(
  bodyId: ReturnType<typeof createBodyId>,
  regeneration = 0,
  hash: number = FIXTURE_HASH,
): TopologySnapshot {
  const identity =
    hash === FIXTURE_HASH
      ? {
          kernelId: FIXTURE_KERNEL_ID,
          schema: FIXTURE_SCHEMA,
          data: { hash },
        }
      : {
          kernelId: FIXTURE_KERNEL_ID,
          schema: FIXTURE_SCHEMA,
          data: { hash },
        };
  const entity: TopologyEntitySnapshot = {
    kind: "edge",
    ordinal: EDGE_ORDINAL,
    identity,
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
    regeneration,
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
    snapshotOf: (id) =>
      id === bodyId ? fixtureSnapshot(bodyId, 0, hash) : null,
  };
}

/** Builds the fillet document: box feature + reference record + fillet feature. */
function buildFilletDocument(radiusMm: number): CadDocument {
  let document = createDocument(createDocumentId("doc_bridge_fillet"));
  for (const [id, name, value] of [
    [pWidth, "boxWidth", BOX.w],
    [pDepth, "boxDepth", BOX.d],
    [pHeight, "boxHeight", BOX.h],
    [pRadius, "filletRadius", radiusMm],
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
  const rounded = addBody(document, { id: bRounded, name: "rounded" });
  if (!rounded.ok) throw new Error(rounded.error.message);
  document = rounded.value.document;
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

  const fillet: FeatureRecordInput = {
    id: fFillet,
    kind: "fillet",
    inputs: [
      { kind: "feature", id: fBox },
      { kind: "reference", id: rEdge },
      { kind: "parameter", id: pRadius },
    ],
    outputs: [bRounded],
  };
  const featured = addFeature(document, fillet);
  if (!featured.ok) throw new Error(featured.error.message);
  document = featured.value.document;
  return document;
}

/** Regenerates the fillet document against a fresh fake kernel + fixture view. */
function runFillet(
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

describe("bridge fillet: target + edge references + radius → kernel fillet", () => {
  it("resolves the edge reference and executes the analytic corner fillet", () => {
    const { kernel, bridge, states } = runFillet(buildFilletDocument(2));
    expect(states.get(fFillet)?.state).toBe("valid");
    const solid = bridge.solidOf(bRounded);
    expect(solid).toBeDefined();
    if (solid === undefined) return;
    // Ordinal 5 addresses the y-edge of length 20: the analytic removal is
    // r²(1 − π/4)·20 with r = 2.
    assertVolumeClose(
      unwrapKernelResult(kernel.volume(solid), "fillet volume"),
      BOX.w * BOX.d * BOX.h - 4 * (1 - Math.PI / 4) * EDGE_LENGTH_MM,
      1e-9,
    );
  });

  it("re-drives the fillet from a radius parameter edit", () => {
    const document = buildFilletDocument(2);
    const set = applyCommand(document, {
      type: "parameter.set",
      id: pRadius,
      value: length(4),
    });
    expect(set.ok).toBe(true);
    if (!set.ok) return;
    const { kernel, bridge, states } = runFillet(set.value);
    expect(states.get(fFillet)?.state).toBe("valid");
    const solid = bridge.solidOf(bRounded);
    expect(solid).toBeDefined();
    if (solid === undefined) return;
    assertVolumeClose(
      unwrapKernelResult(kernel.volume(solid), "regenerated fillet volume"),
      BOX.w * BOX.d * BOX.h - 16 * (1 - Math.PI / 4) * EDGE_LENGTH_MM,
      1e-9,
    );
  });

  it("fails with a structured stale-reference diagnostic when the edge vanished", () => {
    // A view whose snapshot carries a DIFFERENT hash: the minted identity
    // died (the Phase 22 rebuild finding) → the reference stands missing →
    // the fillet feature fails regeneration with the state named.
    const stale = fixtureView(bBlock, 999999);
    const { states } = runFillet(buildFilletDocument(2), { view: stale });
    const status = states.get(fFillet);
    expect(status?.state).toBe("failed");
    const diagnostic = status?.diagnostics[0];
    expect(diagnostic).toBeDefined();
    expect(diagnostic?.severity).toBe("error");
    expect(JSON.stringify(diagnostic?.data ?? {})).toContain("missing");
    expect(diagnostic?.message).toContain("unresolved edge reference");
  });

  it("fails structured on a transient-topology view (the non-persistent kernel stance)", () => {
    // A persistentTopology: false kernel's view: every topology reference
    // resolves invalid/kernel-transient-topology — the honest declaration
    // that fillet is OCCT-executed, never silently approximated elsewhere.
    const transientView: TopologyView = {
      kernelId: "some-mesh-kernel",
      persistentTopology: false,
      identitySchemas: [],
      snapshotOf: () => null,
    };
    const { states } = runFillet(buildFilletDocument(2), {
      view: transientView,
    });
    const status = states.get(fFillet);
    expect(status?.state).toBe("failed");
    const diagnostic = status?.diagnostics[0];
    expect(JSON.stringify(diagnostic?.data ?? {})).toContain(
      "kernel-transient-topology",
    );
  });

  it("fails structured when the context carries no topology view", () => {
    const { states } = runFillet(buildFilletDocument(2), { omitView: true });
    const status = states.get(fFillet);
    expect(status?.state).toBe("failed");
    const diagnostic = status?.diagnostics[0];
    expect(diagnostic?.message).toContain("no topology view");
  });

  it("fails structured when the reference addresses another body", () => {
    let document = buildFilletDocument(2);
    // Re-point the record's payload at a foreign body id.
    const record = document.references.find((entry) => entry.id === rEdge);
    expect(record).toBeDefined();
    const parsed = parseTopologyReference(record?.reference);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok || record === undefined) return;
    const foreignBody = createBodyId("body_foreign");
    const foreignRounded = createBodyId("body_foreign_rounded");
    const body = addBody(document, { id: foreignBody, name: "foreign" });
    if (!body.ok) throw new Error(body.error.message);
    document = body.value.document;
    const rounded = addBody(document, {
      id: foreignRounded,
      name: "foreign rounded",
    });
    if (!rounded.ok) throw new Error(rounded.error.message);
    document = rounded.value.document;
    const foreign = {
      ...parsed.value,
      bodyId: foreignBody,
      provenance: { ...parsed.value.provenance, bodyId: foreignBody },
    };
    const reAdd = addDocumentReference(document, {
      id: createReferenceId("ref_foreign_edge"),
      name: "foreign edge",
      reference: { ...serializeTopologyReference(foreign) },
    });
    if (!reAdd.ok) throw new Error(reAdd.error.message);
    document = reAdd.value.document;
    const updated = addFeature(document, {
      id: createFeatureId("feat_fillet_foreign"),
      kind: "fillet",
      inputs: [
        { kind: "feature", id: fBox },
        { kind: "reference", id: createReferenceId("ref_foreign_edge") },
        { kind: "parameter", id: pRadius },
      ],
      outputs: [foreignRounded],
    });
    if (!updated.ok) throw new Error(updated.error.message);
    document = updated.value.document;
    const { states } = runFillet(document);
    const status = states.get(createFeatureId("feat_fillet_foreign"));
    expect(status?.state).toBe("failed");
    expect(status?.diagnostics[0]?.message).toContain("mixes bodies");
  });

  it("keeps the resolved-reference protocol's own codes visible end to end", () => {
    // The minted reference resolves VALID against the fixture view — the
    // protocol's happy path, asserted directly so the fixture itself is
    // proven (the bridge consumes exactly this outcome).
    const document = buildFilletDocument(2);
    const record = document.references.find((entry) => entry.id === rEdge);
    expect(record).toBeDefined();
    const parsed = parseTopologyReference(record?.reference);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const resolved = resolveDocumentReference(
      document,
      parsed.value,
      fixtureView(bBlock),
    );
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.value.validity.state).toBe("valid");
    expect(resolved.value.validity.ordinal).toBe(EDGE_ORDINAL);
  });
});
