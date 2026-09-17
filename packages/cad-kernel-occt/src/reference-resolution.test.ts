/**
 * Phase 22 reference resolution and repair against the REAL OpenCascade
 * kernel: the document-level scenarios the plan's validation criteria name,
 * built through the kernel contract (`createBox`/`createCylinder`/
 * `subtract`/`transform`), snapshotted through the kernel's
 * `topologySnapshot` operation, and resolved through cad-core's
 * `resolveDocumentReference`/`repairTopologyReference` protocol via
 * `occtTopologyView` — the OCCT implementation of the `TopologyView`
 * interface. Together with cad-core's `persistent-reference.test.ts` (the
 * model's pure outcomes, hand-built snapshots) and
 * `topology-identity.test.ts` (the identity experiments), this pins the
 * whole Phase 22 surface:
 *
 * - identity survives harmless changes through EXPLICIT repair
 *   (geometric re-anchoring), after dying at the rebuild — the measured
 *   behavior, not an assumption;
 * - untouched faces keep identity within a live lineage (no rebuild), and
 *   the provenance-identity repair strategy consumes exactly that;
 * - a topology-changing split invalidates the split face EXPLICITLY
 *   (repair refuses: no candidate within bounds);
 * - document-level structural breaks (body removed, provenance feature
 *   removed) mark references terminally invalid;
 * - a view answering for a body with no solid reports missing, and a
 *   disposed solid likewise has no current topology.
 */

import { beforeAll, describe, expect, it } from "vitest";
import {
  addBody,
  addFeature,
  createBodyId,
  createDocument,
  createDocumentId,
  createFeatureId,
  createReferenceId,
  type CadDocument,
  length,
  mintTopologyReference,
  parseTopologyReference,
  referenceProvenance,
  removeFeature,
  repairTopologyReference,
  resolveDocumentReference,
  resolveTopologyReference,
  serializeTopologyReference,
  transientSelectionOf,
  type TopologyEntityReference,
  type TopologySnapshot,
} from "@slopcad/cad-core";
import {
  KERNEL_ERROR_CODES,
  type KernelSolid,
  unwrapKernelResult,
} from "@slopcad/cad-kernel";

import { occtKernelFromRuntime } from "./occt-kernel";
import { createOcctRuntime, type OcctRuntime } from "./occt-runtime";
import { occtTopologyView } from "./occt-topology";

let runtime: OcctRuntime;

beforeAll(async () => {
  runtime = await createOcctRuntime();
});

// --- the document: feat_box → feat_drill → (feat_slot) ----------------------

const plateBody = createBodyId("body_plate");
const drilledBody = createBodyId("body_drilled");
const slottedBody = createBodyId("body_slotted");
const boxFeature = createFeatureId("feat_box");
const drillFeature = createFeatureId("feat_drill");
const slotFeature = createFeatureId("feat_slot");

function referenceDocument(): CadDocument {
  let document = createDocument(createDocumentId("doc_refs"));
  for (const [id, name] of [
    [plateBody, "Plate"],
    [drilledBody, "Drilled"],
    [slottedBody, "Slotted"],
  ] as const) {
    const added = addBody(document, { id, name });
    if (!added.ok) throw new Error(added.error.message);
    document = added.value.document;
  }
  const box = addFeature(document, {
    id: boxFeature,
    kind: "box",
    inputs: [],
    outputs: [plateBody],
  });
  if (!box.ok) throw new Error(box.error.message);
  document = box.value.document;
  const drill = addFeature(document, {
    id: drillFeature,
    kind: "subtract",
    inputs: [{ kind: "feature", id: boxFeature }],
    outputs: [drilledBody],
  });
  if (!drill.ok) throw new Error(drill.error.message);
  document = drill.value.document;
  const slot = addFeature(document, {
    id: slotFeature,
    kind: "subtract",
    inputs: [{ kind: "feature", id: drillFeature }],
    outputs: [slottedBody],
  });
  if (!slot.ok) throw new Error(slot.error.message);
  return slot.value.document;
}

// --- kernel scene builders (the feature graph, executed by hand) ------------

type Kernel = ReturnType<typeof occtKernelFromRuntime>;

function box(
  kernel: Kernel,
  width: number,
  depth: number,
  height: number,
): KernelSolid {
  return unwrapKernelResult(
    kernel.createBox({
      width: length(width),
      depth: length(depth),
      height: length(height),
    }),
    "createBox",
  );
}

function cylinderAt(
  kernel: Kernel,
  radius: number,
  height: number,
  x: number,
  y: number,
): KernelSolid {
  const raw = unwrapKernelResult(
    kernel.createCylinder({
      radius: length(radius),
      height: length(height),
    }),
    "createCylinder",
  );
  return unwrapKernelResult(
    kernel.transform(raw, { x: length(x), y: length(y), z: length(0) }),
    "transform",
  );
}

function drilledPlate(kernel: Kernel): KernelSolid {
  const plate = box(kernel, 30, 20, 10);
  const bore = cylinderAt(kernel, 4, 10, 15, 10);
  return unwrapKernelResult(kernel.subtract(plate, [bore]), "subtract");
}

/** The wall that splits the plate's top face: 2×20×4 at x ∈ [14,16], z ∈ [6,10]. */
function wall(kernel: Kernel): KernelSolid {
  const raw = box(kernel, 2, 20, 4);
  return unwrapKernelResult(
    kernel.transform(raw, { x: length(14), y: length(0), z: length(6) }),
    "transform",
  );
}

function snapshotOf(
  kernel: Kernel,
  solid: KernelSolid,
  bodyId: typeof plateBody,
  regeneration: number,
): TopologySnapshot {
  return unwrapKernelResult(
    kernel.topologySnapshot(solid, { bodyId, regeneration, kinds: ["face"] }),
    "topologySnapshot",
  );
}

/** The snapshot face of area `area` (mm²) whose absolute centroid z ≈ `z`. */
function faceByAreaAndZ(
  snapshot: TopologySnapshot,
  area: number,
  z: number,
): { ordinal: number; area: number } {
  const face = snapshot.entities.find(
    (entity) =>
      entity.kind === "face" &&
      entity.geometry.areaMm2 !== undefined &&
      Math.abs(entity.geometry.areaMm2 - area) < 1e-6 &&
      entity.geometry.centroidAbsoluteMm !== undefined &&
      Math.abs(entity.geometry.centroidAbsoluteMm[2] - z) < 1e-6,
  );
  if (face === undefined) {
    throw new Error(
      `No face of area ${String(area)} at z=${String(z)} in the snapshot.`,
    );
  }
  return { ordinal: face.ordinal, area: face.geometry.areaMm2 ?? area };
}

/** The snapshot entity closest to `area` (mm²), with its ordinal. */
function faceByArea(
  snapshot: TopologySnapshot,
  area: number,
): { ordinal: number; area: number } {
  const face = snapshot.entities.find(
    (entity) =>
      entity.kind === "face" &&
      entity.geometry.areaMm2 !== undefined &&
      Math.abs(entity.geometry.areaMm2 - area) < 1e-6,
  );
  if (face === undefined) {
    throw new Error(`No face of area ${String(area)} in the snapshot.`);
  }
  return { ordinal: face.ordinal, area: face.geometry.areaMm2 ?? area };
}

const PLATE_TOP_AREA = 600 - Math.PI * 16; // 549.734…
const BORE_WALL_AREA = 2 * Math.PI * 4 * 10; // 251.327…

describe("minting and validity against the real kernel", () => {
  it("snapshots the plate with 7 identity-labeled, geometry-described faces", () => {
    const kernel = occtKernelFromRuntime(runtime);
    const snapshot = snapshotOf(kernel, drilledPlate(kernel), drilledBody, 1);
    expect(snapshot.kernelId).toBe("opencascade");
    expect(snapshot.persistentTopology).toBe(true);
    expect(snapshot.identitySchemas).toEqual(["occt-shape-hash-v1"]);
    expect(snapshot.entities).toHaveLength(7);
    for (const entity of snapshot.entities) {
      expect(entity.identity).not.toBeNull();
      expect(entity.geometry.areaMm2).toBeDefined();
      expect(entity.geometry.centroidRelativeMm).toBeDefined();
    }
    faceByArea(snapshot, PLATE_TOP_AREA);
    faceByArea(snapshot, BORE_WALL_AREA);
  });

  it("rebuild snapshots are identity-disjoint and geometry-identical", () => {
    const kernel = occtKernelFromRuntime(runtime);
    const first = snapshotOf(kernel, drilledPlate(kernel), drilledBody, 1);
    const second = snapshotOf(kernel, drilledPlate(kernel), drilledBody, 2);
    const firstHashes = new Set(
      first.entities.map((entity) => entity.identity?.data.hash),
    );
    const shared = second.entities.filter((entity) =>
      firstHashes.has(entity.identity?.data.hash),
    );
    expect(shared).toHaveLength(0);
    // Body-relative geometry survives bitwise (the repair heuristic's ground).
    expect(second.entities.map((entity) => entity.geometry)).toEqual(
      first.entities.map((entity) => entity.geometry),
    );
  });

  it("mints an EDGE and a VERTEX from a default (face+edge+vertex) snapshot — ordinals address within the kind", () => {
    const kernel = occtKernelFromRuntime(runtime);
    const document = referenceDocument();
    const provenance = referenceProvenance(document, drilledBody);
    if (!provenance.ok) throw new Error(provenance.error.message);
    // The DEFAULT kinds (no kinds override): faces, edges, and vertices,
    // each numbered from its own 0 — ordinal 0 is live in all three kinds
    // at once, so minting must resolve within the addressed kind.
    const v1 = unwrapKernelResult(
      kernel.topologySnapshot(drilledPlate(kernel), {
        bodyId: drilledBody,
        regeneration: 1,
      }),
      "topologySnapshot",
    );
    expect(
      v1.entities.some((entity) => entity.kind === "face" && entity.ordinal === 0),
    ).toBe(true);
    expect(
      v1.entities.some((entity) => entity.kind === "edge" && entity.ordinal === 0),
    ).toBe(true);
    expect(
      v1.entities.some((entity) => entity.kind === "vertex" && entity.ordinal === 0),
    ).toBe(true);

    const edge = mintTopologyReference(v1, 0, provenance.value, {
      id: createReferenceId("ref_first_edge"),
      kind: "edge",
    });
    expect(edge.ok).toBe(true);
    if (!edge.ok) return;
    expect(edge.value.kind).toBe("edge");
    expect(edge.value.geometry.lengthMm).toBeDefined();
    const edgeResolved = resolveTopologyReference(edge.value, v1);
    expect(edgeResolved.ok).toBe(true);
    if (edgeResolved.ok) {
      expect(edgeResolved.value.validity.state).toBe("valid");
      expect(edgeResolved.value.validity.ordinal).toBe(0);
    }
    expect(transientSelectionOf(edge.value)).toEqual({
      ok: true,
      value: { kind: "edge", bodyId: drilledBody, regeneration: 1, edgeIndex: 0 },
      error: undefined,
    });

    const vertex = mintTopologyReference(v1, 0, provenance.value, {
      id: createReferenceId("ref_first_vertex"),
      kind: "vertex",
    });
    expect(vertex.ok).toBe(true);
    if (!vertex.ok) return;
    expect(vertex.value.kind).toBe("vertex");
    expect(vertex.value.geometry.pointAbsoluteMm).toBeDefined();
    const vertexResolved = resolveTopologyReference(vertex.value, v1);
    expect(vertexResolved.ok).toBe(true);
    if (vertexResolved.ok) {
      expect(vertexResolved.value.validity.state).toBe("valid");
      expect(vertexResolved.value.validity.ordinal).toBe(0);
    }

    // An ordinal that exists only in the EDGE numbering is a structured
    // rejection for the vertex kind — never a silent mint of another kind.
    const vertexOrdinals = new Set(
      v1.entities
        .filter((entity) => entity.kind === "vertex")
        .map((entity) => entity.ordinal),
    );
    const edgeOnly = v1.entities.find(
      (entity) => entity.kind === "edge" && !vertexOrdinals.has(entity.ordinal),
    );
    if (edgeOnly === undefined) {
      throw new Error("Invariant violation: an edge-only ordinal exists.");
    }
    const outOfKind = mintTopologyReference(
      v1,
      edgeOnly.ordinal,
      provenance.value,
      { id: createReferenceId("ref_out_of_kind"), kind: "vertex" },
    );
    expect(outOfKind.ok).toBe(false);
    if (!outOfKind.ok) {
      expect(outOfKind.error.code).toBe("reference/unknown-entity");
    }
  });

  it("rejects a bad regeneration and a foreign/disposed handle structurally", () => {
    const kernel = occtKernelFromRuntime(runtime);
    const solid = drilledPlate(kernel);
    const badRegeneration = kernel.topologySnapshot(solid, {
      bodyId: drilledBody,
      regeneration: -1,
    });
    expect(badRegeneration.ok).toBe(false);
    if (!badRegeneration.ok) {
      expect(badRegeneration.error.code).toBe(
        KERNEL_ERROR_CODES.invalidOperands,
      );
    }
    kernel.dispose(solid);
    const disposed = kernel.topologySnapshot(solid, {
      bodyId: drilledBody,
      regeneration: 1,
    });
    expect(disposed.ok).toBe(false);
    if (!disposed.ok) {
      expect(disposed.error.code).toBe(KERNEL_ERROR_CODES.solidNotOwned);
    }
  });
});

describe("harmless change (translate tweak): identity dies, repair re-anchors", () => {
  it("resolves the reference missing after the rebuild and repairs it by geometry", () => {
    const kernel = occtKernelFromRuntime(runtime);
    const document = referenceDocument();
    const provenance = referenceProvenance(document, drilledBody);
    if (!provenance.ok) throw new Error(provenance.error.message);
    expect(provenance.value.featurePath).toEqual([boxFeature, drillFeature]);

    const v1 = snapshotOf(kernel, drilledPlate(kernel), drilledBody, 1);
    const boreFace = faceByArea(v1, BORE_WALL_AREA);
    const minted = mintTopologyReference(v1, boreFace.ordinal, provenance.value, {
      id: createReferenceId("ref_bore_wall"),
      kind: "face",
    });
    if (!minted.ok) throw new Error(minted.error.message);

    // The harmless change: the same graph with the plate translated 5 mm.
    const moved = unwrapKernelResult(
      kernel.transform(drilledPlate(kernel), {
        x: length(5),
        y: length(0),
        z: length(0),
      }),
      "transform",
    );
    const v2 = snapshotOf(kernel, moved, drilledBody, 2);
    const view = occtTopologyView(kernel, {
      regeneration: 2,
      bodies: new Map([[drilledBody, moved]]),
    });
    const resolved = resolveDocumentReference(document, minted.value, view);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.value.validity.state).toBe("missing");

    const repaired = repairTopologyReference(resolved.value, v2);
    expect(repaired.ok).toBe(true);
    if (!repaired.ok) return;
    expect(repaired.value.validity.state).toBe("repaired");
    expect(repaired.value.validity.repair?.strategy).toBe("geometric-reattach");
    // The from-anchor carries the regeneration of the record being repaired
    // (the missing measurement), the to-anchor the repair's snapshot.
    expect(repaired.value.validity.repair?.from.regeneration).toBe(2);
    expect(repaired.value.validity.repair?.to.regeneration).toBe(2);
    const repairedArea =
      v2.entities.find(
        (entity) => entity.ordinal === repaired.value.validity.ordinal,
      )?.geometry.areaMm2 ?? 0;
    expect(Math.abs(repairedArea - BORE_WALL_AREA)).toBeLessThanOrEqual(1e-6);

    // The repaired reference now resolves VALID against the same snapshot,
    // and maps to the Phase 12 synthetic selection of this regeneration.
    const reResolved = resolveDocumentReference(
      document,
      repaired.value,
      view,
    );
    expect(reResolved.ok).toBe(true);
    if (reResolved.ok) {
      expect(reResolved.value.validity.state).toBe("valid");
    }
    const transient = transientSelectionOf(repaired.value);
    expect(transient).toEqual({
      ok: true,
      value: {
        kind: "face",
        bodyId: drilledBody,
        regeneration: 2,
        faceIndex: repaired.value.validity.ordinal ?? -1,
      },
      error: undefined,
    });
  });

  it("serializes the repaired reference losslessly for persistence", () => {
    const kernel = occtKernelFromRuntime(runtime);
    const document = referenceDocument();
    const provenance = referenceProvenance(document, drilledBody);
    if (!provenance.ok) throw new Error(provenance.error.message);
    const v1 = snapshotOf(kernel, drilledPlate(kernel), drilledBody, 1);
    const minted = mintTopologyReference(
      v1,
      faceByArea(v1, BORE_WALL_AREA).ordinal,
      provenance.value,
      { id: createReferenceId("ref_persist"), kind: "face" },
    );
    if (!minted.ok) throw new Error(minted.error.message);
    // The rebuild: fresh identity, identical geometry — the reference
    // resolves missing and repairs by geometry.
    const v2 = snapshotOf(kernel, drilledPlate(kernel), drilledBody, 2);
    const missing = resolveTopologyReference(minted.value, v2);
    if (!missing.ok) throw new Error(missing.error.message);
    expect(missing.value.validity.state).toBe("missing");
    const repaired = repairTopologyReference(missing.value, v2);
    expect(repaired.ok).toBe(true);
    if (!repaired.ok) return;
    const parsed = parseTopologyReference(
      serializeTopologyReference(repaired.value),
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value).toEqual(repaired.value);
  });
});

describe("topology-changing split: explicit invalidation, partial repair", () => {
  it("refuses repair for the SPLIT face (no candidate) — invalidation is explicit", () => {
    const kernel = occtKernelFromRuntime(runtime);
    const document = referenceDocument();
    const provenance = referenceProvenance(document, slottedBody);
    if (!provenance.ok) throw new Error(provenance.error.message);

    // Regeneration 1: the drilled plate.
    const drilled = drilledPlate(kernel);
    const v1 = snapshotOf(kernel, drilled, slottedBody, 1);
    // Regeneration 2: the full chain re-run plus the wall subtract.
    const rebuilt = unwrapKernelResult(
      kernel.subtract(drilledPlate(kernel), [wall(kernel)]),
      "subtract",
    );
    const v2 = snapshotOf(kernel, rebuilt, slottedBody, 2);

    const topFace = faceByAreaAndZ(v1, PLATE_TOP_AREA, 10);
    const minted = mintTopologyReference(v1, topFace.ordinal, provenance.value, {
      id: createReferenceId("ref_split_top"),
      kind: "face",
    });
    if (!minted.ok) throw new Error(minted.error.message);
    const resolved = resolveDocumentReference(
      document,
      minted.value,
      occtTopologyView(kernel, {
        regeneration: 2,
        bodies: new Map([[slottedBody, rebuilt]]),
      }),
    );
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.value.validity.state).toBe("missing");
    const repaired = repairTopologyReference(resolved.value, v2);
    expect(repaired.ok).toBe(false);
    if (repaired.ok) return;
    expect(repaired.error.code).toBe("reference/repair-no-candidate");
  });

  it("repairs the untouched bottom face by geometry after the same split", () => {
    const kernel = occtKernelFromRuntime(runtime);
    const document = referenceDocument();
    const provenance = referenceProvenance(document, slottedBody);
    if (!provenance.ok) throw new Error(provenance.error.message);
    const drilled = drilledPlate(kernel);
    const v1 = snapshotOf(kernel, drilled, slottedBody, 1);
    const rebuilt = unwrapKernelResult(
      kernel.subtract(drilledPlate(kernel), [wall(kernel)]),
      "subtract",
    );
    const v2 = snapshotOf(kernel, rebuilt, slottedBody, 2);
    // The BOTTOM face: same area as the destroyed top, distinguished by its
    // absolute position (z = 0) — the dual-anchoring rule's other half.
    const bottom = faceByAreaAndZ(v1, PLATE_TOP_AREA, 0);
    const minted = mintTopologyReference(v1, bottom.ordinal, provenance.value, {
      id: createReferenceId("ref_bottom"),
      kind: "face",
    });
    if (!minted.ok) throw new Error(minted.error.message);
    const missing: TopologyEntityReference = {
      ...minted.value,
      validity: { state: "missing", regeneration: 1 },
    };
    const repaired = repairTopologyReference(missing, v2);
    expect(repaired.ok).toBe(true);
    if (!repaired.ok) return;
    const repairedArea =
      v2.entities.find(
        (entity) => entity.ordinal === repaired.value.validity.ordinal,
      )?.geometry.areaMm2 ?? 0;
    expect(Math.abs(repairedArea - PLATE_TOP_AREA)).toBeLessThanOrEqual(1e-6);
  });

  it("keeps the bottom face's identity VALID within a live lineage (no rebuild)", () => {
    const kernel = occtKernelFromRuntime(runtime);
    const document = referenceDocument();
    const provenance = referenceProvenance(document, slottedBody);
    if (!provenance.ok) throw new Error(provenance.error.message);
    // One lineage: the drilled solid stays alive, the wall cuts IT directly.
    const drilled = drilledPlate(kernel);
    const v1 = snapshotOf(kernel, drilled, slottedBody, 1);
    const bottom = faceByAreaAndZ(v1, PLATE_TOP_AREA, 0);
    const minted = mintTopologyReference(v1, bottom.ordinal, provenance.value, {
      id: createReferenceId("ref_lineage"),
      kind: "face",
    });
    if (!minted.ok) throw new Error(minted.error.message);
    const lineageCut = unwrapKernelResult(
      kernel.subtract(drilled, [wall(kernel)]),
      "subtract",
    );
    const lineage = snapshotOf(kernel, lineageCut, slottedBody, 2);
    const resolved = resolveTopologyReference(minted.value, lineage);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    // The measured lineage case: untouched faces keep their kernel identity.
    expect(resolved.value.validity.state).toBe("valid");

    // And the same identity powers the provenance-identity repair strategy
    // when the CURRENT topology is a rebuild but the re-executed path's
    // snapshot is this lineage one.
    const rebuilt = unwrapKernelResult(
      kernel.subtract(drilledPlate(kernel), [wall(kernel)]),
      "subtract",
    );
    const rebuiltSnapshot = snapshotOf(kernel, rebuilt, slottedBody, 2);
    const missing: TopologyEntityReference = {
      ...minted.value,
      validity: { state: "missing", regeneration: 1 },
    };
    const repaired = repairTopologyReference(missing, rebuiltSnapshot, {
      reexecuted: lineage,
    });
    expect(repaired.ok).toBe(true);
    if (!repaired.ok) return;
    expect(repaired.value.validity.repair?.strategy).toBe(
      "provenance-identity",
    );
  });
});

describe("document-level structural breaks", () => {
  it("marks a reference invalid/body-absent once the body is removed", () => {
    const kernel = occtKernelFromRuntime(runtime);
    const document = referenceDocument();
    const provenance = referenceProvenance(document, drilledBody);
    if (!provenance.ok) throw new Error(provenance.error.message);
    const v1 = snapshotOf(kernel, drilledPlate(kernel), drilledBody, 1);
    const minted = mintTopologyReference(
      v1,
      faceByArea(v1, BORE_WALL_AREA).ordinal,
      provenance.value,
      { id: createReferenceId("ref_break"), kind: "face" },
    );
    if (!minted.ok) throw new Error(minted.error.message);
    // A document that never had the body (the removal equivalent).
    const empty = createDocument(createDocumentId("doc_empty"));
    const resolved = resolveDocumentReference(
      empty,
      minted.value,
      occtTopologyView(kernel, {
        regeneration: 1,
        bodies: new Map(),
      }),
    );
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.value.validity.state).toBe("invalid");
    expect(resolved.value.validity.reason).toBe("body-absent");
  });

  it("marks a reference invalid/provenance-broken once the producing feature is gone", () => {
    const kernel = occtKernelFromRuntime(runtime);
    const document = referenceDocument();
    const provenance = referenceProvenance(document, drilledBody);
    if (!provenance.ok) throw new Error(provenance.error.message);
    const v1 = snapshotOf(kernel, drilledPlate(kernel), drilledBody, 1);
    const minted = mintTopologyReference(
      v1,
      faceByArea(v1, BORE_WALL_AREA).ordinal,
      provenance.value,
      { id: createReferenceId("ref_prov"), kind: "face" },
    );
    if (!minted.ok) throw new Error(minted.error.message);
    // Remove the producing chain (the consumer first — removal is refused
    // while a downstream feature references it): the bodies survive
    // (removal never cascades), the provenance path no longer leads to the
    // drilled body.
    const withoutSlot = unwrapDocument(removeFeature(document, slotFeature));
    const pruned = unwrapDocument(removeFeature(withoutSlot, drillFeature));
    const resolved = resolveDocumentReference(
      pruned,
      minted.value,
      occtTopologyView(kernel, { regeneration: 1, bodies: new Map() }),
    );
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.value.validity.state).toBe("invalid");
    expect(resolved.value.validity.reason).toBe("provenance-broken");
  });

  it("reports missing (not invalid) for a body whose solid is not in the view", () => {
    const kernel = occtKernelFromRuntime(runtime);
    const document = referenceDocument();
    const provenance = referenceProvenance(document, drilledBody);
    if (!provenance.ok) throw new Error(provenance.error.message);
    const v1 = snapshotOf(kernel, drilledPlate(kernel), drilledBody, 1);
    const minted = mintTopologyReference(
      v1,
      faceByArea(v1, BORE_WALL_AREA).ordinal,
      provenance.value,
      { id: createReferenceId("ref_nosolid"), kind: "face" },
    );
    if (!minted.ok) throw new Error(minted.error.message);
    const resolved = resolveDocumentReference(
      document,
      minted.value,
      occtTopologyView(kernel, { regeneration: 2, bodies: new Map() }),
    );
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.value.validity.state).toBe("missing");
  });
});

function unwrapDocument(
  result: ReturnType<typeof removeFeature>,
): CadDocument {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}
