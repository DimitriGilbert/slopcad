/**
 * Persistent-reference model tests (Phase 22): provenance derivation and
 * integrity, minting preconditions, the resolution protocol's every outcome
 * (valid / missing / ambiguous / invalid with each structural reason, the
 * transient-kernel honest report), the validity-transition table, the two
 * bounded repair strategies and their refusals, explicit disambiguation,
 * the Phase 12 transient bridge, and serialization round-trips.
 *
 * Snapshots here are kernel-neutral DATA (hand-built in the shapes the
 * cad-kernel-occt experiments measured real kernels producing); the OCCT
 * package's tests pin that its snapshot producer emits exactly these shapes
 * and that the protocol holds end-to-end against the real kernel.
 */

import { describe, expect, it } from "vitest";

import {
  addBody,
  addFeature,
  createDocument,
  type CadDocument,
} from "./document";
import {
  createBodyId,
  createDocumentId,
  createFeatureId,
  createReferenceId,
} from "./ids";
import {
  applyReferenceValidity,
  disambiguateTopologyReference,
  mintTopologyReference,
  parseTopologyReference,
  provenanceIntact,
  REFERENCE_ERROR_CODES,
  referenceProvenance,
  repairTopologyReference,
  resolveDocumentReference,
  resolveTopologyReference,
  type ReferenceError,
  serializeTopologyReference,
  TOPOLOGY_REFERENCE_KINDS,
  type TopologyReferenceKind,
  topologyGeometryMatches,
  topologyIdentityPayloadEqual,
  transientSelectionOf,
  type TopologyEntityReference,
  type TopologySnapshot,
  type TopologyView,
} from "./persistent-reference";
import { ok, type ParseResult } from "./result";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const bodyId = createBodyId("body_plate");
const toolBodyId = createBodyId("body_tool");
const boxFeature = createFeatureId("feat_box");
const cutFeature = createFeatureId("feat_cut");

function documentWithChain(): CadDocument {
  let document = createDocument(createDocumentId("doc_1"));
  const plate = addBody(document, { id: bodyId, name: "Plate" });
  if (!plate.ok) throw new Error(plate.error.message);
  document = plate.value.document;
  const tool = addBody(document, { id: toolBodyId, name: "Bore" });
  if (!tool.ok) throw new Error(tool.error.message);
  document = tool.value.document;
  const box = addFeature(document, {
    id: boxFeature,
    kind: "box",
    inputs: [],
    outputs: [bodyId],
  });
  if (!box.ok) throw new Error(box.error.message);
  document = box.value.document;
  const cut = addFeature(document, {
    id: cutFeature,
    kind: "subtract",
    inputs: [{ kind: "feature", id: boxFeature }],
    outputs: [toolBodyId],
  });
  if (!cut.ok) throw new Error(cut.error.message);
  return cut.value.document;
}

/** A persistent-kernel snapshot in the exact shape OCCT's producer emits. */
function snapshotOf(
  entities: TopologySnapshot["entities"],
  overrides: Partial<TopologySnapshot> = {},
): TopologySnapshot {
  return Object.freeze({
    kernelId: "opencascade",
    persistentTopology: true,
    identitySchemas: ["occt-shape-hash-v1"],
    bodyId,
    regeneration: 1,
    entities: Object.freeze(entities),
    ...overrides,
  });
}

interface EntityInput {
  kind: "face" | "edge" | "vertex";
  ordinal: number;
  hash: number;
  areaMm2?: number;
  lengthMm?: number;
  centroidAbsoluteMm?: readonly [number, number, number];
  centroidRelativeMm?: readonly [number, number, number];
  pointAbsoluteMm?: readonly [number, number, number];
  pointRelativeMm?: readonly [number, number, number];
}

function entityOf(input: EntityInput): TopologySnapshot["entities"][number] {
  const geometry: {
    areaMm2?: number;
    lengthMm?: number;
    centroidAbsoluteMm?: readonly [number, number, number];
    centroidRelativeMm?: readonly [number, number, number];
    pointAbsoluteMm?: readonly [number, number, number];
    pointRelativeMm?: readonly [number, number, number];
  } = {};
  if (input.areaMm2 !== undefined) geometry.areaMm2 = input.areaMm2;
  if (input.lengthMm !== undefined) geometry.lengthMm = input.lengthMm;
  if (input.centroidAbsoluteMm !== undefined)
    geometry.centroidAbsoluteMm = input.centroidAbsoluteMm;
  if (input.centroidRelativeMm !== undefined)
    geometry.centroidRelativeMm = input.centroidRelativeMm;
  if (input.pointAbsoluteMm !== undefined)
    geometry.pointAbsoluteMm = input.pointAbsoluteMm;
  if (input.pointRelativeMm !== undefined)
    geometry.pointRelativeMm = input.pointRelativeMm;
  return Object.freeze({
    kind: input.kind,
    ordinal: input.ordinal,
    identity: Object.freeze({
      kernelId: "opencascade",
      schema: "occt-shape-hash-v1",
      data: Object.freeze({ hash: input.hash }),
    }),
    geometry: Object.freeze(geometry),
  });
}

/** Rebuilds entities with all-fresh identity hashes (the rebuild finding). */
function rehashAll(
  entities: readonly TopologySnapshot["entities"][number][],
  base: number,
): TopologySnapshot["entities"] {
  return Object.freeze(
    entities.map((entity, index) =>
      entity.identity === null
        ? entity
        : {
            ...entity,
            identity: { ...entity.identity, data: { hash: base + index } },
          },
    ),
  );
}

/** The plate-with-hole-like face set the experiments measured. */
function plateEntities(): TopologySnapshot["entities"] {
  return [
    // faces: bottom, top, front, back, left, right, bore wall — absolute
    // and body-relative centroids of the 30×20×10 plate (centre (15,10,5)).
    entityOf({
      kind: "face",
      ordinal: 0,
      hash: 101,
      areaMm2: 549.73,
      centroidAbsoluteMm: [15, 10, 0],
      centroidRelativeMm: [0, 0, -5],
    }),
    entityOf({
      kind: "face",
      ordinal: 1,
      hash: 102,
      areaMm2: 549.73,
      centroidAbsoluteMm: [15, 10, 10],
      centroidRelativeMm: [0, 0, 5],
    }),
    entityOf({
      kind: "face",
      ordinal: 2,
      hash: 103,
      areaMm2: 300,
      centroidAbsoluteMm: [15, 0, 5],
      centroidRelativeMm: [0, -10, 0],
    }),
    entityOf({
      kind: "face",
      ordinal: 3,
      hash: 104,
      areaMm2: 300,
      centroidAbsoluteMm: [15, 20, 5],
      centroidRelativeMm: [0, 10, 0],
    }),
    entityOf({
      kind: "face",
      ordinal: 4,
      hash: 105,
      areaMm2: 200,
      centroidAbsoluteMm: [0, 10, 5],
      centroidRelativeMm: [-15, 0, 0],
    }),
    entityOf({
      kind: "face",
      ordinal: 5,
      hash: 106,
      areaMm2: 200,
      centroidAbsoluteMm: [30, 10, 5],
      centroidRelativeMm: [15, 0, 0],
    }),
    entityOf({
      kind: "face",
      ordinal: 6,
      hash: 107,
      areaMm2: 251.32,
      centroidAbsoluteMm: [15, 10, 5],
      centroidRelativeMm: [0, 0, 0],
    }),
  ];
}

function mintedReference(
  ordinal: number,
  entities: TopologySnapshot["entities"] = plateEntities(),
  kind: TopologyReferenceKind = "face",
): ParseResult<TopologyEntityReference, ReferenceError> {
  const provenance = referenceProvenance(documentWithChain(), bodyId);
  if (!provenance.ok) throw new Error(provenance.error.message);
  return mintTopologyReference(
    snapshotOf(entities),
    ordinal,
    provenance.value,
    {
      id: createReferenceId("ref_probe_face"),
      kind,
    },
  );
}

/** A ref id for references minted outside the shared helper. */
const refId = (): TopologyEntityReference["id"] =>
  createReferenceId("ref_probe_other");

describe("provenance", () => {
  it("derives the producing feature plus upstream ancestors in evaluation order", () => {
    // The chain produces body_tool via feat_cut which consumes feat_box.
    const provenance = referenceProvenance(documentWithChain(), toolBodyId);
    expect(provenance.ok).toBe(true);
    if (!provenance.ok) return;
    expect(provenance.value.bodyId).toBe(toolBodyId);
    expect(provenance.value.featurePath).toEqual([boxFeature, cutFeature]);
  });

  it("yields the empty path for an imported body with no producing feature", () => {
    let document = createDocument(createDocumentId("doc_1"));
    const added = addBody(document, { id: bodyId, name: "Imported" });
    if (!added.ok) throw new Error(added.error.message);
    document = added.value.document;
    const provenance = referenceProvenance(document, bodyId);
    expect(provenance.ok).toBe(true);
    if (!provenance.ok) return;
    expect(provenance.value.featurePath).toEqual([]);
    expect(provenanceIntact(document, provenance.value)).toBe(true);
  });

  it("fails structurally for an absent body", () => {
    const provenance = referenceProvenance(
      documentWithChain(),
      createBodyId("body_ghost"),
    );
    expect(provenance.ok).toBe(false);
    if (provenance.ok) return;
    expect(provenance.error.code).toBe(REFERENCE_ERROR_CODES.unknownEntity);
  });

  it("fails when two features produce the same body", () => {
    let document = createDocument(createDocumentId("doc_1"));
    const added = addBody(document, { id: bodyId, name: "Shared" });
    if (!added.ok) throw new Error(added.error.message);
    document = added.value.document;
    for (const id of [boxFeature, cutFeature]) {
      const feature = addFeature(document, {
        id,
        kind: "box",
        inputs: [],
        outputs: [bodyId],
      });
      if (!feature.ok) throw new Error(feature.error.message);
      document = feature.value.document;
    }
    const provenance = referenceProvenance(document, bodyId);
    expect(provenance.ok).toBe(false);
    if (provenance.ok) return;
    expect(provenance.error.code).toBe(
      REFERENCE_ERROR_CODES.provenanceAmbiguous,
    );
  });

  it("intact while the producing chain still outputs the body; broken when it does not", () => {
    const document = documentWithChain();
    const provenance = referenceProvenance(document, bodyId);
    if (!provenance.ok) throw new Error(provenance.error.message);
    expect(provenanceIntact(document, provenance.value)).toBe(true);
    const wrongBody: typeof provenance.value = {
      bodyId,
      featurePath: [boxFeature],
    };
    // feat_box exists but outputs body_plate via a different last feature.
    const detached: typeof provenance.value = {
      bodyId: toolBodyId,
      featurePath: [boxFeature],
    };
    expect(provenanceIntact(document, detached)).toBe(false);
    expect(provenanceIntact(document, wrongBody)).toBe(true);
    expect(
      provenanceIntact(document, {
        bodyId,
        featurePath: [createFeatureId("feat_gone")],
      }),
    ).toBe(false);
  });
});

describe("minting", () => {
  it("mints a valid reference carrying identity, geometry, and provenance", () => {
    const minted = mintedReference(6);
    expect(minted.ok).toBe(true);
    if (!minted.ok) return;
    expect(minted.value.kind).toBe("face");
    expect(minted.value.validity).toEqual({
      state: "valid",
      regeneration: 1,
      ordinal: 6,
    });
    expect(minted.value.identity.data).toEqual({ hash: 107 });
    expect(minted.value.geometry.areaMm2).toBeCloseTo(251.32);
  });

  it("mints within the addressed kind when ordinals restart per kind (face 0, edge 0, and vertex 0 all exist)", () => {
    // The default OCCT snapshot shape: every kind's exploration numbers
    // from 0, so ordinal 0 is live in all three kinds AT ONCE — the
    // ordinal alone can never pick the entity.
    const entities: TopologySnapshot["entities"] = [
      entityOf({
        kind: "face",
        ordinal: 0,
        hash: 301,
        areaMm2: 600,
        centroidAbsoluteMm: [15, 10, 10],
        centroidRelativeMm: [0, 0, 5],
      }),
      entityOf({
        kind: "edge",
        ordinal: 0,
        hash: 302,
        lengthMm: 30,
        centroidAbsoluteMm: [15, 10, 10],
        centroidRelativeMm: [0, 0, 5],
      }),
      entityOf({
        kind: "vertex",
        ordinal: 0,
        hash: 303,
        pointAbsoluteMm: [0, 0, 0],
        pointRelativeMm: [-15, -10, -5],
      }),
    ];
    const face = mintedReference(0, entities, "face");
    expect(face.ok).toBe(true);
    if (!face.ok) return;
    expect(face.value.kind).toBe("face");
    expect(face.value.geometry.areaMm2).toBeCloseTo(600);
    expect(face.value.identity.data).toEqual({ hash: 301 });
    const edge = mintedReference(0, entities, "edge");
    expect(edge.ok).toBe(true);
    if (!edge.ok) return;
    expect(edge.value.kind).toBe("edge");
    expect(edge.value.geometry.lengthMm).toBeCloseTo(30);
    expect(edge.value.identity.data).toEqual({ hash: 302 });
    const vertex = mintedReference(0, entities, "vertex");
    expect(vertex.ok).toBe(true);
    if (!vertex.ok) return;
    expect(vertex.value.kind).toBe("vertex");
    expect(vertex.value.geometry.pointAbsoluteMm).toEqual([0, 0, 0]);
    expect(vertex.value.identity.data).toEqual({ hash: 303 });
  });

  it("rejects an ordinal outside the addressed kind's numbering with unknown-entity", () => {
    // Faces number 0..6 (plateEntities); edges stop at 1 — ordinal 6 is a
    // FACE's ordinal, never an edge's.
    const entities: TopologySnapshot["entities"] = [
      ...plateEntities(),
      entityOf({
        kind: "edge",
        ordinal: 0,
        hash: 501,
        lengthMm: 30,
        centroidRelativeMm: [0, 0, 5],
      }),
      entityOf({
        kind: "edge",
        ordinal: 1,
        hash: 502,
        lengthMm: 20,
        centroidRelativeMm: [0, 10, 0],
      }),
    ];
    const minted = mintedReference(6, entities, "edge");
    expect(minted.ok).toBe(false);
    if (minted.ok) return;
    expect(minted.error.code).toBe(REFERENCE_ERROR_CODES.unknownEntity);
  });

  it("rejects an unknown ordinal", () => {
    const minted = mintedReference(99);
    expect(minted.ok).toBe(false);
    if (minted.ok) return;
    expect(minted.error.code).toBe(REFERENCE_ERROR_CODES.unknownEntity);
  });

  it("rejects an entity without identity (a kernel that cannot label topology)", () => {
    const entities = [
      {
        ...entityOf({ kind: "face", ordinal: 0, hash: 1, areaMm2: 1 }),
        identity: null,
      },
    ];
    const minted = mintedReference(0, entities);
    expect(minted.ok).toBe(false);
    if (minted.ok) return;
    expect(minted.error.code).toBe(REFERENCE_ERROR_CODES.mintUnavailable);
  });

  it("rejects an entity without geometric descriptor fields", () => {
    const minted = mintedReference(0, [
      entityOf({ kind: "face", ordinal: 0, hash: 1 }),
    ]);
    expect(minted.ok).toBe(false);
    if (minted.ok) return;
    expect(minted.error.code).toBe(REFERENCE_ERROR_CODES.mintUnavailable);
  });
});

describe("payload comparison", () => {
  it("identity equality is kernel + schema + data", () => {
    expect(
      topologyIdentityPayloadEqual(
        { kernelId: "k", schema: "s", data: { hash: 1 } },
        { kernelId: "k", schema: "s", data: { hash: 1 } },
      ),
    ).toBe(true);
    expect(
      topologyIdentityPayloadEqual(
        { kernelId: "k", schema: "s", data: { hash: 1 } },
        { kernelId: "k", schema: "s", data: { hash: 2 } },
      ),
    ).toBe(false);
    expect(
      topologyIdentityPayloadEqual(
        { kernelId: "k", schema: "s", data: { hash: 1 } },
        { kernelId: "k", schema: "s", data: { hash: 1, extra: 0 } },
      ),
    ).toBe(false);
    expect(
      topologyIdentityPayloadEqual(
        { kernelId: "k", schema: "s", data: { hash: 1 } },
        { kernelId: "j", schema: "s", data: { hash: 1 } },
      ),
    ).toBe(false);
  });

  it("geometry matching requires every recorded field to match within bounds", () => {
    const reference = {
      areaMm2: 300,
      centroidRelativeMm: [0, 10, 0] as const,
    };
    expect(
      topologyGeometryMatches(reference, {
        areaMm2: 300 + 3e-9,
        centroidRelativeMm: [0, 10 + 5e-7, 0],
      }),
    ).toBe(true);
    expect(
      topologyGeometryMatches(reference, {
        areaMm2: 301,
        centroidRelativeMm: [0, 10, 0],
      }),
    ).toBe(false);
    expect(
      topologyGeometryMatches(reference, {
        areaMm2: 300,
        centroidRelativeMm: [0, 10.001, 0],
      }),
    ).toBe(false);
    expect(topologyGeometryMatches(reference, { areaMm2: 300 })).toBe(false);
  });
});

describe("resolution (snapshot protocol)", () => {
  it("resolves a matching identity to valid at the snapshot's regeneration", () => {
    const minted = mintedReference(6);
    if (!minted.ok) throw new Error(minted.error.message);
    const resolved = resolveTopologyReference(
      minted.value,
      snapshotOf(plateEntities()),
    );
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.value.validity).toEqual({
      state: "valid",
      regeneration: 1,
      ordinal: 6,
    });
  });

  it("resolves a rebuild (all-fresh identity) to missing — never to a guess", () => {
    const minted = mintedReference(6);
    if (!minted.ok) throw new Error(minted.error.message);
    const rebuilt = snapshotOf(rehashAll(plateEntities(), 1000));
    const resolved = resolveTopologyReference(minted.value, rebuilt);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.value.validity.state).toBe("missing");
    expect(resolved.value.validity.regeneration).toBe(1);
  });

  it("resolves an identity collision to ambiguous with every candidate", () => {
    // The measured compound case: one TShape carried twice.
    const twin = snapshotOf([
      entityOf({
        kind: "face",
        ordinal: 0,
        hash: 42,
        areaMm2: 100,
        centroidRelativeMm: [0, 0, 0],
      }),
      entityOf({
        kind: "face",
        ordinal: 1,
        hash: 42,
        areaMm2: 100,
        centroidRelativeMm: [0, 0, 0],
      }),
    ]);
    const provenance = referenceProvenance(documentWithChain(), bodyId);
    if (!provenance.ok) throw new Error(provenance.error.message);
    const minted = mintTopologyReference(twin, 0, provenance.value, {
      id: refId(),
      kind: "face",
    });
    if (!minted.ok) throw new Error(minted.error.message);
    const resolved = resolveTopologyReference(minted.value, twin);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.value.validity.state).toBe("ambiguous");
    expect(resolved.value.validity.candidates).toEqual([0, 1]);
  });

  it("matches only the reference's own kind", () => {
    const minted = mintedReference(6);
    if (!minted.ok) throw new Error(minted.error.message);
    const edgeOnly = snapshotOf([
      entityOf({ kind: "edge", ordinal: 0, hash: 107, lengthMm: 1 }),
    ]);
    const resolved = resolveTopologyReference(minted.value, edgeOnly);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.value.validity.state).toBe("missing");
  });

  it("reports a null snapshot (no current regeneration) as missing", () => {
    const minted = mintedReference(6);
    if (!minted.ok) throw new Error(minted.error.message);
    const resolved = resolveTopologyReference(minted.value, null);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.value.validity.state).toBe("missing");
  });

  it("reports a non-persistent kernel honestly as invalid/transient", () => {
    const minted = mintedReference(6);
    if (!minted.ok) throw new Error(minted.error.message);
    const transient = snapshotOf([], {
      kernelId: "manifold",
      persistentTopology: false,
      identitySchemas: [],
    });
    const resolved = resolveTopologyReference(minted.value, transient);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.value.validity.state).toBe("invalid");
    expect(resolved.value.validity.reason).toBe("kernel-transient-topology");
  });

  it("rejects a foreign kernel and an unknown schema as terminal invalid", () => {
    const minted = mintedReference(6);
    if (!minted.ok) throw new Error(minted.error.message);
    const foreign = resolveTopologyReference(
      minted.value,
      snapshotOf(plateEntities(), { kernelId: "manifold" }),
    );
    expect(foreign.ok).toBe(true);
    if (foreign.ok)
      expect(foreign.value.validity.reason).toBe("kernel-mismatch");
    const unknownSchema = resolveTopologyReference(
      minted.value,
      snapshotOf(plateEntities(), { identitySchemas: ["other-v1"] }),
    );
    expect(unknownSchema.ok).toBe(true);
    if (unknownSchema.ok)
      expect(unknownSchema.value.validity.reason).toBe("schema-unknown");
  });

  it("fails structurally on a snapshot of a different body", () => {
    const minted = mintedReference(6);
    if (!minted.ok) throw new Error(minted.error.message);
    const wrong = resolveTopologyReference(
      minted.value,
      snapshotOf(plateEntities(), { bodyId: toolBodyId }),
    );
    expect(wrong.ok).toBe(false);
    if (wrong.ok) return;
    expect(wrong.error.code).toBe(REFERENCE_ERROR_CODES.fieldInvalid);
  });
});

describe("resolution (document protocol)", () => {
  const view = (snapshot: TopologySnapshot | null): TopologyView => ({
    kernelId: "opencascade",
    persistentTopology: true,
    identitySchemas: ["occt-shape-hash-v1"],
    snapshotOf: (id) => (id === bodyId ? snapshot : null),
  });

  it("resolves through the view after provenance checks", () => {
    const minted = mintedReference(6);
    if (!minted.ok) throw new Error(minted.error.message);
    const resolved = resolveDocumentReference(
      documentWithChain(),
      minted.value,
      view(snapshotOf(plateEntities())),
    );
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.value.validity.state).toBe("valid");
  });

  it("marks a deleted body invalid/body-absent (terminal)", () => {
    const minted = mintedReference(6);
    if (!minted.ok) throw new Error(minted.error.message);
    const emptyDocument = createDocument(createDocumentId("doc_2"));
    const resolved = resolveDocumentReference(
      emptyDocument,
      minted.value,
      view(snapshotOf(plateEntities())),
    );
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.value.validity.state).toBe("invalid");
    expect(resolved.value.validity.reason).toBe("body-absent");
  });

  it("marks broken provenance invalid/provenance-broken", () => {
    const minted = mintedReference(6);
    if (!minted.ok) throw new Error(minted.error.message);
    const document = documentWithChain();
    // provenance path referencing a feature that does not exist
    const broken: TopologyEntityReference = {
      ...minted.value,
      provenance: { bodyId, featurePath: [createFeatureId("feat_gone")] },
    };
    const resolved = resolveDocumentReference(document, broken, view(null));
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.value.validity.reason).toBe("provenance-broken");
  });

  it("reports a transient-topology view (the Manifold stance) as invalid", () => {
    const minted = mintedReference(6);
    if (!minted.ok) throw new Error(minted.error.message);
    const transientView: TopologyView = {
      kernelId: "manifold",
      persistentTopology: false,
      identitySchemas: [],
      snapshotOf: () => null,
    };
    const resolved = resolveDocumentReference(
      documentWithChain(),
      minted.value,
      transientView,
    );
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.value.validity.state).toBe("invalid");
    expect(resolved.value.validity.reason).toBe("kernel-transient-topology");
  });

  it("a body with no current solid resolves missing, not invalid", () => {
    const minted = mintedReference(6);
    if (!minted.ok) throw new Error(minted.error.message);
    const resolved = resolveDocumentReference(
      documentWithChain(),
      minted.value,
      view(null),
    );
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.value.validity.state).toBe("missing");
  });
});

describe("validity transitions", () => {
  const base = (): TopologyEntityReference => {
    const minted = mintedReference(6);
    if (!minted.ok) throw new Error(minted.error.message);
    return minted.value;
  };

  it("re-measures freely among valid, missing, and ambiguous", () => {
    const reference = base();
    const missing = applyReferenceValidity(reference, {
      state: "missing",
      regeneration: 2,
    });
    expect(missing.ok).toBe(true);
    if (!missing.ok) return;
    const ambiguous = applyReferenceValidity(missing.value, {
      state: "ambiguous",
      regeneration: 3,
      candidates: [1, 2],
    });
    expect(ambiguous.ok).toBe(true);
    if (!ambiguous.ok) return;
    const valid = applyReferenceValidity(ambiguous.value, {
      state: "valid",
      regeneration: 4,
      ordinal: 1,
    });
    expect(valid.ok).toBe(true);
  });

  it("forbids valid → repaired (identity must die visibly first)", () => {
    const reference = base();
    const jumped = applyReferenceValidity(reference, {
      state: "repaired",
      regeneration: 2,
      ordinal: 0,
      repair: {
        strategy: "geometric-reattach",
        from: {
          identity: reference.identity,
          geometry: reference.geometry,
          regeneration: 1,
        },
        to: {
          identity: reference.identity,
          geometry: reference.geometry,
          regeneration: 2,
          ordinal: 0,
        },
      },
    });
    expect(jumped.ok).toBe(false);
    if (jumped.ok) return;
    expect(jumped.error.code).toBe(REFERENCE_ERROR_CODES.transitionInvalid);
  });

  it("treats invalid as terminal", () => {
    const reference = base();
    const invalidated = applyReferenceValidity(reference, {
      state: "invalid",
      regeneration: 2,
      reason: "body-absent",
    });
    expect(invalidated.ok).toBe(true);
    if (!invalidated.ok) return;
    const revived = applyReferenceValidity(invalidated.value, {
      state: "valid",
      regeneration: 3,
      ordinal: 0,
    });
    expect(revived.ok).toBe(false);
    if (revived.ok) return;
    expect(revived.error.code).toBe(REFERENCE_ERROR_CODES.transitionInvalid);
  });

  it("rejects malformed records for their own state", () => {
    const reference = base();
    const noOrdinal = applyReferenceValidity(reference, {
      state: "valid",
      regeneration: 2,
    });
    expect(noOrdinal.ok).toBe(false);
    const noReason = applyReferenceValidity(reference, {
      state: "invalid",
      regeneration: 2,
    });
    expect(noReason.ok).toBe(false);
    const fewCandidates = applyReferenceValidity(reference, {
      state: "ambiguous",
      regeneration: 2,
      candidates: [0],
    });
    expect(fewCandidates.ok).toBe(false);
    const noRepair = applyReferenceValidity(
      { ...reference, validity: { state: "missing", regeneration: 1 } },
      { state: "repaired", regeneration: 2, ordinal: 0 },
    );
    expect(noRepair.ok).toBe(false);
    if (noRepair.ok) return;
    expect(noRepair.error.code).toBe(REFERENCE_ERROR_CODES.stateInvalid);
  });
});

describe("repair", () => {
  it("re-anchors a missing reference by the geometric heuristic and records old → new", () => {
    const minted = mintedReference(6); // bore wall, unique area
    if (!minted.ok) throw new Error(minted.error.message);
    const rebuilt = snapshotOf(rehashAll(plateEntities(), 2000), {
      regeneration: 2,
    });
    const resolved = resolveTopologyReference(minted.value, rebuilt);
    if (!resolved.ok) throw new Error(resolved.error.message);
    expect(resolved.value.validity.state).toBe("missing");
    const repaired = repairTopologyReference(resolved.value, rebuilt);
    expect(repaired.ok).toBe(true);
    if (!repaired.ok) return;
    const value = repaired.value;
    expect(value.validity.state).toBe("repaired");
    expect(value.validity.ordinal).toBe(6);
    expect(value.validity.repair?.strategy).toBe("geometric-reattach");
    expect(value.validity.repair?.from.identity.data.hash).toBe(107);
    expect(value.validity.repair?.to.identity.data.hash).toBe(2006);
    expect(value.identity.data.hash).toBe(2006);
    // Deterministic: the same inputs repair to the same output.
    const again = repairTopologyReference(resolved.value, rebuilt);
    expect(again.ok).toBe(true);
    if (again.ok) expect(again.value).toEqual(value);
    // The repaired reference now resolves valid by identity.
    const reResolved = resolveTopologyReference(value, rebuilt);
    expect(reResolved.ok).toBe(true);
    if (reResolved.ok) expect(reResolved.value.validity.state).toBe("valid");
  });

  it("prefers the provenance re-execution identity match when the lineage survives", () => {
    const minted = mintedReference(6);
    if (!minted.ok) throw new Error(minted.error.message);
    const current = snapshotOf(rehashAll(plateEntities(), 3000), {
      regeneration: 2,
    });
    // The re-executed path reproduced the original identity for ordinal 6.
    const reexecuted = snapshotOf(plateEntities(), { regeneration: 2 });
    const missing: TopologyEntityReference = {
      ...minted.value,
      validity: { state: "missing", regeneration: 1 },
    };
    const repaired = repairTopologyReference(missing, current, {
      reexecuted,
    });
    expect(repaired.ok).toBe(true);
    if (!repaired.ok) return;
    expect(repaired.value.validity.repair?.strategy).toBe(
      "provenance-identity",
    );
    expect(repaired.value.identity.data.hash).toBe(107);
  });

  it("anchors a provenance-identity repair WHOLE to the re-executed snapshot at a divergent regeneration", () => {
    const minted = mintedReference(6);
    if (!minted.ok) throw new Error(minted.error.message);
    // Divergence: the current regeneration moved on (3, all-fresh
    // identity) while the re-executed path's snapshot (2) still carries
    // the reference's identity at ordinal 6 — the repair must anchor to
    // the re-executed topology whole, never mix the two snapshots.
    const current = snapshotOf(rehashAll(plateEntities(), 7000), {
      regeneration: 3,
    });
    const reexecuted = snapshotOf(plateEntities(), { regeneration: 2 });
    const missing: TopologyEntityReference = {
      ...minted.value,
      validity: { state: "missing", regeneration: 1 },
    };
    const repaired = repairTopologyReference(missing, current, { reexecuted });
    expect(repaired.ok).toBe(true);
    if (!repaired.ok) return;
    const value = repaired.value;
    expect(value.validity.repair?.strategy).toBe("provenance-identity");
    // Coherent output: identity, geometry, ordinal, AND regeneration all
    // come from the re-executed snapshot — regeneration 3 never leaks in.
    expect(value.identity.data.hash).toBe(107);
    expect(value.geometry.areaMm2).toBeCloseTo(251.32);
    expect(value.validity.state).toBe("repaired");
    expect(value.validity.ordinal).toBe(6);
    expect(value.validity.regeneration).toBe(2);
    expect(value.validity.repair?.to.regeneration).toBe(2);
    expect(value.validity.repair?.to.ordinal).toBe(6);
    // The Phase 12 bridge addresses the regeneration whose topology
    // actually carries the entity — coherent coordinates, not mixed ones.
    expect(transientSelectionOf(value)).toEqual(
      ok({ kind: "face", bodyId, regeneration: 2, faceIndex: 6 }),
    );
  });

  it("re-anchors after a rigid body move through the body-relative anchoring", () => {
    // The translate finding: every absolute centroid moved by [5,0,0], every
    // body-relative position is unchanged, every identity is fresh.
    const moved = snapshotOf(
      plateEntities().map((entity) => ({
        ...entity,
        geometry: {
          ...entity.geometry,
          centroidAbsoluteMm:
            entity.geometry.centroidAbsoluteMm === undefined
              ? undefined
              : ([
                  entity.geometry.centroidAbsoluteMm[0] + 5,
                  entity.geometry.centroidAbsoluteMm[1],
                  entity.geometry.centroidAbsoluteMm[2],
                ] as const),
        },
      })),
      { regeneration: 2 },
    );
    const minted = mintedReference(6);
    if (!minted.ok) throw new Error(minted.error.message);
    const missing: TopologyEntityReference = {
      ...minted.value,
      validity: { state: "missing", regeneration: 1 },
    };
    const repaired = repairTopologyReference(missing, moved);
    expect(repaired.ok).toBe(true);
    if (!repaired.ok) return;
    expect(repaired.value.validity.ordinal).toBe(6);
  });

  it("refuses the equal-area twin after the referenced face was destroyed", () => {
    // The split finding as the model's hardest case: the top face (ordinal
    // 1) is gone, replaced by halves of a different area; its equal-area
    // bottom twin survives with an unchanged absolute position but a
    // drifted body-relative one (the split moved the body's centre of
    // mass). Matching the bottom face silently would be the forbidden
    // wrong-entity resolution — repair must refuse.
    const split = snapshotOf(
      [
        plateEntities()[0] as TopologySnapshot["entities"][number],
        // the two halves of the destroyed top face (fresh ordinals)
        entityOf({
          kind: "face",
          ordinal: 7,
          hash: 201,
          areaMm2: 262.78,
          centroidAbsoluteMm: [6.6, 10, 10],
          centroidRelativeMm: [-8.4, 0, 5.09],
        }),
        entityOf({
          kind: "face",
          ordinal: 8,
          hash: 202,
          areaMm2: 262.78,
          centroidAbsoluteMm: [23.4, 10, 10],
          centroidRelativeMm: [8.4, 0, 5.09],
        }),
        ...plateEntities()
          .slice(2)
          .map((entity) => ({
            ...entity,
            ordinal: entity.ordinal + 7,
          })),
      ],
      { regeneration: 2 },
    );
    const minted = mintedReference(1); // the top face
    if (!minted.ok) throw new Error(minted.error.message);
    const missing: TopologyEntityReference = {
      ...minted.value,
      validity: { state: "missing", regeneration: 1 },
    };
    const repaired = repairTopologyReference(missing, split);
    expect(repaired.ok).toBe(false);
    if (repaired.ok) return;
    expect(repaired.error.code).toBe(REFERENCE_ERROR_CODES.repairNoCandidate);
  });

  it("refuses several geometric candidates and never picks one", () => {
    // Two faces indistinguishable under BOTH position anchorings (the
    // coincident-duplicate case): equal area, equal absolute and relative
    // centroids, distinct identity payloads.
    const twins = snapshotOf(
      [
        entityOf({
          kind: "face",
          ordinal: 0,
          hash: 11,
          areaMm2: 100,
          centroidAbsoluteMm: [1, 1, 1],
          centroidRelativeMm: [1, 1, 1],
        }),
        entityOf({
          kind: "face",
          ordinal: 1,
          hash: 12,
          areaMm2: 100,
          centroidAbsoluteMm: [1, 1, 1],
          centroidRelativeMm: [1, 1, 1],
        }),
      ],
      { regeneration: 2 },
    );
    const provenance = referenceProvenance(documentWithChain(), bodyId);
    if (!provenance.ok) throw new Error(provenance.error.message);
    const minted = mintTopologyReference(
      snapshotOf([
        entityOf({
          kind: "face",
          ordinal: 0,
          hash: 9,
          areaMm2: 100,
          centroidAbsoluteMm: [1, 1, 1],
          centroidRelativeMm: [1, 1, 1],
        }),
      ]),
      0,
      provenance.value,
      { id: refId(), kind: "face" },
    );
    if (!minted.ok) throw new Error(minted.error.message);
    const missing: TopologyEntityReference = {
      ...minted.value,
      validity: { state: "missing", regeneration: 1 },
    };
    const repaired = repairTopologyReference(missing, twins);
    expect(repaired.ok).toBe(false);
    if (repaired.ok) return;
    expect(repaired.error.code).toBe(REFERENCE_ERROR_CODES.repairAmbiguous);
    expect(repaired.error.input).toEqual([0, 1]);
  });

  it("keeps the reference missing when no candidate is within bounds", () => {
    const minted = mintedReference(6);
    if (!minted.ok) throw new Error(minted.error.message);
    const changed = snapshotOf(
      rehashAll(plateEntities(), 4000).map((entity) => ({
        ...entity,
        // topology changed: the bore wall split, every area halved
        geometry: {
          ...entity.geometry,
          areaMm2: (entity.geometry.areaMm2 ?? 0) / 2,
        },
      })),
      { regeneration: 2 },
    );
    const missing: TopologyEntityReference = {
      ...minted.value,
      validity: { state: "missing", regeneration: 1 },
    };
    const repaired = repairTopologyReference(missing, changed);
    expect(repaired.ok).toBe(false);
    if (repaired.ok) return;
    expect(repaired.error.code).toBe(REFERENCE_ERROR_CODES.repairNoCandidate);
  });

  it("requires the missing precondition", () => {
    const minted = mintedReference(6);
    if (!minted.ok) throw new Error(minted.error.message);
    const repaired = repairTopologyReference(
      minted.value,
      snapshotOf(plateEntities()),
    );
    expect(repaired.ok).toBe(false);
    if (repaired.ok) return;
    expect(repaired.error.code).toBe(REFERENCE_ERROR_CODES.repairPrecondition);
  });

  it("refuses an empty geometric descriptor (it would match everything)", () => {
    const minted = mintedReference(6);
    if (!minted.ok) throw new Error(minted.error.message);
    const empty: TopologyEntityReference = {
      ...minted.value,
      geometry: {},
      validity: { state: "missing", regeneration: 1 },
    };
    const repaired = repairTopologyReference(
      empty,
      snapshotOf(plateEntities()),
    );
    expect(repaired.ok).toBe(false);
    if (repaired.ok) return;
    expect(repaired.error.code).toBe(REFERENCE_ERROR_CODES.repairPrecondition);
  });
});

describe("disambiguation", () => {
  it("repairs an ambiguous reference to the caller's explicit choice", () => {
    const minted = mintedReference(6);
    if (!minted.ok) throw new Error(minted.error.message);
    const ambiguous: TopologyEntityReference = {
      ...minted.value,
      validity: { state: "ambiguous", regeneration: 2, candidates: [0, 1] },
    };
    const picked = disambiguateTopologyReference(ambiguous, 1);
    expect(picked.ok).toBe(true);
    if (!picked.ok) return;
    expect(picked.value.validity.state).toBe("repaired");
    expect(picked.value.validity.ordinal).toBe(1);
    expect(picked.value.validity.repair?.strategy).toBe("disambiguated");
  });

  it("rejects an ordinal outside the candidates and non-ambiguous references", () => {
    const minted = mintedReference(6);
    if (!minted.ok) throw new Error(minted.error.message);
    const ambiguous: TopologyEntityReference = {
      ...minted.value,
      validity: { state: "ambiguous", regeneration: 2, candidates: [0, 1] },
    };
    const outside = disambiguateTopologyReference(ambiguous, 5);
    expect(outside.ok).toBe(false);
    if (outside.ok) return;
    expect(outside.error.code).toBe(REFERENCE_ERROR_CODES.stateInvalid);
    const notAmbiguous = disambiguateTopologyReference(minted.value, 0);
    expect(notAmbiguous.ok).toBe(false);
    if (notAmbiguous.ok) return;
    expect(notAmbiguous.error.code).toBe(
      REFERENCE_ERROR_CODES.repairPrecondition,
    );
  });
});

describe("the Phase 12 bridge", () => {
  it("maps a resolved reference to the synthetic selection reference", () => {
    const minted = mintedReference(6);
    if (!minted.ok) throw new Error(minted.error.message);
    const mapped = transientSelectionOf(minted.value);
    expect(mapped).toEqual(
      ok({
        kind: "face",
        bodyId,
        regeneration: 1,
        faceIndex: 6,
      }),
    );
  });

  it("refuses unresolved references — no coordinates to give", () => {
    const minted = mintedReference(6);
    if (!minted.ok) throw new Error(minted.error.message);
    const missing: TopologyEntityReference = {
      ...minted.value,
      validity: { state: "missing", regeneration: 1 },
    };
    const mapped = transientSelectionOf(missing);
    expect(mapped.ok).toBe(false);
    if (mapped.ok) return;
    expect(mapped.error.code).toBe(REFERENCE_ERROR_CODES.stateInvalid);
  });
});

describe("serialization", () => {
  it("round-trips a repaired reference exactly", () => {
    const minted = mintedReference(6);
    if (!minted.ok) throw new Error(minted.error.message);
    const rebuilt = snapshotOf(rehashAll(plateEntities(), 5000), {
      regeneration: 2,
    });
    const missing: TopologyEntityReference = {
      ...minted.value,
      validity: { state: "missing", regeneration: 1 },
    };
    const repaired = repairTopologyReference(missing, rebuilt);
    if (!repaired.ok) throw new Error(repaired.error.message);
    const serialized = serializeTopologyReference(repaired.value);
    const parsed = parseTopologyReference(serialized);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value).toEqual(repaired.value);
    expect(serializeTopologyReference(parsed.value)).toEqual(serialized);
  });

  it("rejects malformed input structurally", () => {
    expect(parseTopologyReference(null).ok).toBe(false);
    expect(parseTopologyReference({ kind: "solid" }).ok).toBe(false);
    const minted = mintedReference(6);
    if (!minted.ok) throw new Error(minted.error.message);
    const serialized = serializeTopologyReference(minted.value);
    const badId = parseTopologyReference({
      ...serialized,
      id: "not-a-ref-id",
    });
    expect(badId.ok).toBe(false);
    if (!badId.ok)
      expect(badId.error.code).toBe(REFERENCE_ERROR_CODES.idInvalid);
    const badVector = parseTopologyReference({
      ...serialized,
      geometry: { centroidRelativeMm: [0, Infinity, 0] },
    });
    expect(badVector.ok).toBe(false);
    const badState = parseTopologyReference({
      ...serialized,
      validity: { state: "unknown", regeneration: 1 },
    });
    expect(badState.ok).toBe(false);
    const mismatchedProvenance = parseTopologyReference({
      ...serialized,
      provenance: {
        bodyId: toolBodyId,
        featurePath: [boxFeature],
      },
    });
    expect(mismatchedProvenance.ok).toBe(false);
  });

  it("parses untrusted primitives strictly in identity data", () => {
    const minted = mintedReference(6);
    if (!minted.ok) throw new Error(minted.error.message);
    const serialized = serializeTopologyReference(minted.value);
    const badData = parseTopologyReference({
      ...serialized,
      identity: {
        kernelId: "opencascade",
        schema: "occt-shape-hash-v1",
        data: { hash: { nested: true } },
      },
    });
    expect(badData.ok).toBe(false);
    if (!badData.ok)
      expect(badData.error.code).toBe(REFERENCE_ERROR_CODES.fieldInvalid);
  });
});

describe("kind surface", () => {
  it("exposes exactly the plan's topology kinds", () => {
    expect([...TOPOLOGY_REFERENCE_KINDS]).toEqual(["face", "edge", "vertex"]);
  });
});
