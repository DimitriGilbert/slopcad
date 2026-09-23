/**
 * Assembly resolution tests (Phase 50): instance walking with composed
 * path transforms, sub-assembly nesting, cycle and depth guards, datum
 * placement resolution, and the cross-document staleness rule. Fixtures
 * are analytic — expected transforms are hand-derived from the fixed
 * outermost-first composition order.
 */

import { describe, expect, it } from "vitest";

import {
  addBody,
  addDocumentDatum,
  addOccurrence,
  ASSEMBLY_ERROR_CODES,
  ASSEMBLY_INSTANCE_DEPTH_LIMIT,
  computeAssemblyStaleness,
  createDocument,
  createDocumentId,
  createOccurrenceId,
  resolveAssemblyInstances,
  resolveOccurrencePlacement,
  transformPlacementPoint,
  type CadDocument,
} from "./index";

const CSYS_PAYLOAD = {
  formatVersion: 1,
  datumType: "cSys" as const,
  origin: [100, 0, 0] as const,
  xAxis: [0, 1, 0] as const,
  normal: [0, 0, 1] as const,
};

/** A document with one solid body, built through the real add doors. */
function partDocument(name: string): CadDocument {
  const document = createDocument(createDocumentId(name));
  const added = addBody(document, { name: "Base" });
  if (!added.ok) throw new Error("expected body add");
  return added.value.document;
}

/** The first body id of a document (tests index through this one guard). */
function firstBodyId(document: CadDocument) {
  const body = document.bodies[0];
  if (body === undefined) throw new Error("expected a body");
  return body.id;
}

/** The first datum id of a document (same single guard). */
function firstDatumId(document: CadDocument) {
  const datum = document.datums[0];
  if (datum === undefined) throw new Error("expected a datum");
  return datum.id;
}

describe("assembly instance resolution", () => {
  it("places a body-source occurrence at its composed offset", () => {
    let document = partDocument("doc_root");
    const withOccurrence = addOccurrence(document, {
      name: "Bolt",
      source: { kind: "body", bodyId: firstBodyId(document) },
      placement: { kind: "offset", translation: [50, 0, 0] },
    });
    if (!withOccurrence.ok) throw new Error("expected occurrence add");
    document = withOccurrence.value.document;
    const resolution = resolveAssemblyInstances(document);
    expect(resolution.ok).toBe(true);
    if (!resolution.ok) return;
    expect(resolution.instances).toHaveLength(1);
    const instance = resolution.instances[0];
    expect(instance).toBeDefined();
    if (instance === undefined) return;
    expect(instance.path).toEqual([withOccurrence.value.occurrence.id]);
    expect(instance.bodyId).toBe(firstBodyId(document));
    expect(transformPlacementPoint(instance.transform, [0, 0, 0])).toEqual([
      50, 0, 0,
    ]);
  });

  it("excludes direct root content and includes sub-assembly direct content placed", () => {
    // Root: two bodies (one claimed by an occurrence), plus a document
    // occurrence of a sub-assembly that carries one direct body.
    let root = partDocument("doc_assembly");
    const sub = partDocument("doc_bracket");
    const rootAdvanced = addBody(root, { name: "Second" });
    if (!rootAdvanced.ok) throw new Error("expected body add");
    root = rootAdvanced.value.document;
    const linked = addOccurrence(root, {
      name: "Bracket",
      source: { kind: "document", documentId: "persistence-bracket-1" },
      placement: { kind: "offset", translation: [0, 30, 0] },
    });
    if (!linked.ok) throw new Error("expected occurrence add");
    root = linked.value.document;
    const resolution = resolveAssemblyInstances(root, {
      document: (documentId) =>
        documentId === "persistence-bracket-1" ? sub : undefined,
    });
    expect(resolution.ok).toBe(true);
    if (!resolution.ok) return;
    // The sub-assembly's DIRECT body is the only instance: the root's own
    // bodies render as the document's own objects, not placed instances.
    expect(resolution.instances).toHaveLength(1);
    const placed = resolution.instances[0];
    expect(placed).toBeDefined();
    if (placed === undefined) return;
    expect(placed.bodyId).toBe(firstBodyId(sub));
    expect(transformPlacementPoint(placed.transform, [0, 0, 0])).toEqual([
      0, 30, 0,
    ]);
  });

  it("nests two document levels composing transforms in path order", () => {
    const leaf = partDocument("doc_leaf");
    let middle = partDocument("doc_middle");
    const toLeaf = addOccurrence(middle, {
      name: "Leaf",
      source: { kind: "document", documentId: "doc-leaf" },
      placement: { kind: "offset", translation: [10, 0, 0] },
    });
    if (!toLeaf.ok) throw new Error("expected occurrence add");
    middle = toLeaf.value.document;
    let root = partDocument("doc_top");
    const toMiddle = addOccurrence(root, {
      name: "Middle",
      source: { kind: "document", documentId: "doc-middle" },
      placement: { kind: "offset", translation: [100, 0, 0] },
    });
    if (!toMiddle.ok) throw new Error("expected occurrence add");
    root = toMiddle.value.document;
    const resolution = resolveAssemblyInstances(root, {
      document: (id) =>
        id === "doc-middle" ? middle : id === "doc-leaf" ? leaf : undefined,
    });
    expect(resolution.ok).toBe(true);
    if (!resolution.ok) return;
    // Two placed instances: the MIDDLE document's direct body (placed at
    // the root's 100x hop) and the LEAF's direct body (placed at the
    // middle's 10x hop composed under it).
    expect(resolution.instances).toHaveLength(2);
    const instance = resolution.instances.find(
      (candidate) => candidate.path.length === 2,
    );
    expect(instance).toBeDefined();
    if (instance === undefined) return;
    // Path order: root occurrence first, middle's occurrence second.
    expect(instance.path).toEqual([
      toMiddle.value.occurrence.id,
      toLeaf.value.occurrence.id,
    ]);
    // Outermost-first composition: leaf body lands at 110x, not 10x.
    expect(transformPlacementPoint(instance.transform, [0, 0, 0])).toEqual([
      110, 0, 0,
    ]);
  });

  it("nests two levels through ROTATED datum anchors composing in path order", () => {
    // The Phase 50 carry-in: the nesting test above only walks commuting
    // x-translations, which compose identically in either order. This
    // fixture anchors BOTH levels to cSys datums that rotate, so the
    // composed world transform proves the fixed outermost-first order:
    // world = M(level 1) ∘ M(level 2).
    let root = partDocument("doc_two_level_root");
    const withRootDatum = addDocumentDatum(root, {
      name: "Root anchor",
      datum: CSYS_PAYLOAD,
    });
    if (!withRootDatum.ok) throw new Error("expected root datum add");
    root = withRootDatum.value.document;

    const leaf = partDocument("doc_two_level_leaf");
    let sub = partDocument("doc_two_level_sub");
    const withSubDatum = addDocumentDatum(sub, {
      name: "Sub anchor",
      datum: {
        formatVersion: 1,
        datumType: "cSys" as const,
        origin: [0, 10, 0] as const,
        xAxis: [0, 0, 1] as const,
        normal: [1, 0, 0] as const,
      },
    });
    if (!withSubDatum.ok) throw new Error("expected sub datum add");
    sub = withSubDatum.value.document;
    const toLeaf = addOccurrence(sub, {
      name: "Leaf",
      source: { kind: "document", documentId: "doc-two-level-leaf" },
      placement: {
        kind: "datum",
        datumId: firstDatumId(sub),
        translation: [0, 0, 7],
      },
    });
    if (!toLeaf.ok) throw new Error("expected occurrence add");
    sub = toLeaf.value.document;
    const toSub = addOccurrence(root, {
      name: "Sub",
      source: { kind: "document", documentId: "doc-two-level-sub" },
      placement: { kind: "datum", datumId: firstDatumId(root) },
    });
    if (!toSub.ok) throw new Error("expected occurrence add");
    root = toSub.value.document;

    const resolution = resolveAssemblyInstances(root, {
      document: (id) =>
        id === "doc-two-level-sub"
          ? sub
          : id === "doc-two-level-leaf"
            ? leaf
            : undefined,
    });
    expect(resolution.ok).toBe(true);
    if (!resolution.ok) return;
    // The sub's direct body (placed at the root anchor) plus the leaf's
    // body (placed at the composed two-level transform).
    expect(resolution.instances).toHaveLength(2);
    const leafInstance = resolution.instances.find(
      (candidate) => candidate.path.length === 2,
    );
    expect(leafInstance).toBeDefined();
    if (leafInstance === undefined) return;
    expect(leafInstance.path).toEqual([
      toSub.value.occurrence.id,
      toLeaf.value.occurrence.id,
    ]);
    // Level 1 (the root anchor): origin (100,0,0) with x->y, y->−x, z->z.
    // Level 2 (the sub anchor): origin (0,10,0) with x->z, y->x, z->y, and
    // the in-frame translation (0,0,7) the sub's rotated frame maps to
    // world (7,10,0) BEFORE level 1's rotation composes on top. World
    // origin: (100,0,0) + R1 · (7,10,0) = (100,0,0) + (−10, 7, 0)
    // = (90, 7, 0).
    expect(transformPlacementPoint(leafInstance.transform, [0, 0, 0])).toEqual([
      90, 7, 0,
    ]);
    // A rotated direction distinguishes the composition order: the leaf's
    // local x maps under R2 to world z, then R1 keeps z as z; the reverse
    // composition order would send it along world y instead.
    expect(transformPlacementPoint(leafInstance.transform, [1, 0, 0])).toEqual([
      90, 7, 1,
    ]);
    // The sub's direct body sits at the level-1 transform alone.
    const subDirect = resolution.instances.find(
      (candidate) => candidate.path.length === 1,
    );
    expect(subDirect).toBeDefined();
    if (subDirect === undefined) return;
    expect(transformPlacementPoint(subDirect.transform, [1, 0, 0])).toEqual([
      100, 1, 0,
    ]);
  });

  it("carries BOM flags along the path, absent = default", () => {
    const sub = partDocument("doc_kit");
    const inSub = addOccurrence(sub, {
      name: "Washer",
      source: { kind: "body", bodyId: firstBodyId(sub) },
      bomFlag: "purchased",
    });
    if (!inSub.ok) throw new Error("expected occurrence add");
    let root = partDocument("doc_bom");
    const linked = addOccurrence(root, {
      name: "Kit",
      source: { kind: "document", documentId: "doc-kit" },
      bomFlag: "phantom",
    });
    if (!linked.ok) throw new Error("expected occurrence add");
    root = linked.value.document;
    const resolution = resolveAssemblyInstances(root, {
      document: (id) => (id === "doc-kit" ? inSub.value.document : undefined),
    });
    expect(resolution.ok).toBe(true);
    if (!resolution.ok) return;
    // The phantom kit's flag rides outermost; the purchased washer innermost.
    const instance = resolution.instances[0];
    expect(instance).toBeDefined();
    if (instance === undefined) return;
    expect(instance.bomFlags).toEqual(["phantom", "purchased"]);
  });

  it("resolves component sources through the component seam", () => {
    let root = partDocument("doc_comp");
    const extra = addBody(root, { name: "Extra" });
    if (!extra.ok) throw new Error("expected body add");
    root = extra.value.document;
    const linked = addOccurrence(root, {
      name: "Motor",
      source: { kind: "component", componentId: "nema17-mount" },
    });
    if (!linked.ok) throw new Error("expected occurrence add");
    root = linked.value.document;
    const secondBody = root.bodies[1];
    if (secondBody === undefined) throw new Error("expected the extra body");
    const componentBodies = [firstBodyId(root), secondBody.id];
    const resolution = resolveAssemblyInstances(root, {
      component: (id) => (id === "nema17-mount" ? componentBodies : undefined),
    });
    expect(resolution.ok).toBe(true);
    if (!resolution.ok) return;
    expect(resolution.instances).toHaveLength(2);
    expect(resolution.instances.map((instance) => instance.bodyId)).toEqual(
      componentBodies,
    );
  });

  it("refuses unresolved sources, cycles, and runaway depth structurally", () => {
    const root = partDocument("doc_cycle");
    const unlinked = addOccurrence(root, {
      name: "Ghost",
      source: { kind: "document", documentId: "nowhere" },
    });
    if (!unlinked.ok) throw new Error("expected occurrence add");
    const unresolved = resolveAssemblyInstances(unlinked.value.document);
    expect(unresolved).toMatchObject({
      ok: false,
      error: { code: ASSEMBLY_ERROR_CODES.sourceUnresolved },
    });

    // Self-containing assembly: the persistence id repeats on the chain.
    const cycle = addOccurrence(root, {
      name: "Self",
      source: { kind: "document", documentId: "me" },
    });
    if (!cycle.ok) throw new Error("expected occurrence add");
    const cycled = resolveAssemblyInstances(cycle.value.document, {
      document: (id) => (id === "me" ? cycle.value.document : undefined),
    });
    expect(cycled).toMatchObject({
      ok: false,
      error: { code: ASSEMBLY_ERROR_CODES.cycleDetected },
    });

    // Runaway depth: a genuine CHAIN — each sub-document contains the
    // occurrence that pulls the next one in, built deepest-first (the
    // immutable adds mean the root is completed last).
    const seam: Record<string, CadDocument> = {};
    let deeper: CadDocument | undefined;
    for (
      let index = ASSEMBLY_INSTANCE_DEPTH_LIMIT + 1;
      index >= 0;
      index -= 1
    ) {
      let entry = partDocument(`doc_chain${index}`);
      if (deeper !== undefined) {
        const linked = addOccurrence(entry, {
          name: `Hop ${index}`,
          source: { kind: "document", documentId: `chain-${index + 1}` },
        });
        if (!linked.ok) throw new Error("expected occurrence add");
        entry = linked.value.document;
      }
      seam[`chain-${index}`] = entry;
      deeper = entry;
    }
    const chainRoot = partDocument("doc_chain_root");
    const rootLink = addOccurrence(chainRoot, {
      name: "Hop root",
      source: { kind: "document", documentId: "chain-0" },
    });
    if (!rootLink.ok) throw new Error("expected occurrence add");
    const deep = resolveAssemblyInstances(rootLink.value.document, {
      document: (id) => seam[id],
    });
    expect(deep).toMatchObject({
      ok: false,
      error: { code: ASSEMBLY_ERROR_CODES.depthExceeded },
    });
  });
});

describe("occurrence placement resolution", () => {
  it("anchors to a cSys datum with optional in-frame translation", () => {
    let document = partDocument("doc_anchor");
    const withDatum = addDocumentDatum(document, {
      name: "Anchor",
      datum: CSYS_PAYLOAD,
    });
    if (!withDatum.ok) throw new Error("expected datum add");
    document = withDatum.value.document;
    const datumId = firstDatumId(document);
    const anchored = resolveOccurrencePlacement(
      { kind: "datum", datumId },
      document.datums,
    );
    expect(anchored.ok).toBe(true);
    if (!anchored.ok) return;
    // The cSys origin is (100, 0, 0); local x maps onto world y.
    expect(transformPlacementPoint(anchored.value, [0, 0, 0])).toEqual([
      100, 0, 0,
    ]);
    expect(transformPlacementPoint(anchored.value, [1, 0, 0])).toEqual([
      100, 1, 0,
    ]);
    const offset = resolveOccurrencePlacement(
      { kind: "datum", datumId, translation: [0, 0, 5] },
      document.datums,
    );
    expect(offset.ok).toBe(true);
    if (!offset.ok) return;
    // The offset applies IN the anchor frame: local (0,0,1) shifted to
    // in-frame (0,0,6) -> world origin + 6z = (100, 0, 6).
    expect(transformPlacementPoint(offset.value, [0, 0, 1])).toEqual([
      100, 0, 6,
    ]);
    // The offset alone lands the frame origin at +5z.
    expect(transformPlacementPoint(offset.value, [0, 0, 0])).toEqual([
      100, 0, 5,
    ]);
  });

  it("refuses missing datums and topology-dependent anchors without a seam", () => {
    let document = partDocument("doc_missing");
    const withDatum = addDocumentDatum(document, {
      name: "Face anchor",
      datum: {
        formatVersion: 1,
        datumType: "plane",
        definition: "faceOffset",
        reference: { payload: true },
        normalAtDefinition: [0, 1, 0],
        offsetMm: 3,
      },
    });
    if (!withDatum.ok) throw new Error("expected datum add");
    document = withDatum.value.document;
    const missing = resolveOccurrencePlacement(
      { kind: "datum", datumId: firstDatumId(document) },
      [],
    );
    expect(missing).toMatchObject({
      ok: false,
      error: { code: ASSEMBLY_ERROR_CODES.datumUnresolved },
    });
    const seamNeeded = resolveOccurrencePlacement(
      { kind: "datum", datumId: firstDatumId(document) },
      document.datums,
    );
    expect(seamNeeded).toMatchObject({
      ok: false,
      error: { code: ASSEMBLY_ERROR_CODES.placementUnresolvable },
    });
  });
});

describe("cross-document staleness", () => {
  it("marks an assembly stale when a source revision is newer", () => {
    const staleness = computeAssemblyStaleness(
      [
        {
          documentId: "asm",
          revision: 1,
          sources: [
            {
              occurrenceId: createOccurrenceId("occ_a"),
              sourceDocumentId: "part",
            },
          ],
        },
        { documentId: "part", revision: 2, sources: [] },
      ],
      "asm",
    );
    expect(staleness.stale).toBe(true);
    expect(staleness.staleSources).toHaveLength(1);
    expect(staleness.staleSources[0]).toMatchObject({
      documentId: "asm",
      sourceDocumentId: "part",
      sourceRevision: 2,
      consumerRevision: 1,
    });
  });

  it("propagates transitively: a sub-sub edit marks the whole chain stale", () => {
    const staleness = computeAssemblyStaleness(
      [
        {
          documentId: "asm",
          revision: 5,
          sources: [
            {
              occurrenceId: createOccurrenceId("occ_m"),
              sourceDocumentId: "mid",
            },
          ],
        },
        {
          documentId: "mid",
          revision: 5,
          sources: [
            {
              occurrenceId: createOccurrenceId("occ_p"),
              sourceDocumentId: "part",
            },
          ],
        },
        { documentId: "part", revision: 9, sources: [] },
      ],
      "asm",
    );
    expect(staleness.stale).toBe(true);
    // Both consuming edges learn about the newer part.
    expect(staleness.staleSources).toHaveLength(2);
  });

  it("is fresh when everything is current, cycle-safe, and gap-tolerant", () => {
    const fresh = computeAssemblyStaleness(
      [
        {
          documentId: "asm",
          revision: 3,
          sources: [
            {
              occurrenceId: createOccurrenceId("occ_a"),
              sourceDocumentId: "part",
            },
          ],
        },
        { documentId: "part", revision: 3, sources: [] },
      ],
      "asm",
    );
    expect(fresh).toEqual({ stale: false, staleSources: [] });

    // A source cycle must not loop: mutual references terminate.
    const cyclic = computeAssemblyStaleness(
      [
        {
          documentId: "a",
          revision: 1,
          sources: [
            {
              occurrenceId: createOccurrenceId("occ_b"),
              sourceDocumentId: "b",
            },
          ],
        },
        {
          documentId: "b",
          revision: 1,
          sources: [
            {
              occurrenceId: createOccurrenceId("occ_a2"),
              sourceDocumentId: "a",
            },
          ],
        },
      ],
      "a",
    );
    expect(cyclic.stale).toBe(false);

    // An unknown source document contributes nothing and cannot go stale.
    const gapped = computeAssemblyStaleness(
      [
        {
          documentId: "asm",
          revision: 1,
          sources: [
            {
              occurrenceId: createOccurrenceId("occ_x"),
              sourceDocumentId: "ghost",
            },
          ],
        },
      ],
      "asm",
    );
    expect(gapped).toEqual({ stale: false, staleSources: [] });
  });
});

describe("assembly resolution determinism", () => {
  it("produces identical instance lists for identical inputs", () => {
    const build = (): {
      readonly document: CadDocument;
      readonly sub: CadDocument;
    } => {
      const sub = partDocument("doc_det_sub");
      let document = partDocument("doc_det_root");
      const first = addOccurrence(document, {
        name: "One",
        source: { kind: "body", bodyId: firstBodyId(document) },
        placement: { kind: "offset", translation: [1, 2, 3] },
      });
      if (!first.ok) throw new Error("expected occurrence add");
      document = first.value.document;
      const second = addOccurrence(document, {
        name: "Two",
        source: { kind: "document", documentId: "sub" },
        placement: { kind: "offset", translation: [4, 5, 6] },
      });
      if (!second.ok) throw new Error("expected occurrence add");
      return {
        document: second.value.document,
        sub,
      };
    };
    const a = build();
    const b = build();
    const resolvedA = resolveAssemblyInstances(a.document, {
      document: (id) => (id === "sub" ? a.sub : undefined),
    });
    const resolvedB = resolveAssemblyInstances(b.document, {
      document: (id) => (id === "sub" ? b.sub : undefined),
    });
    expect(resolvedA.ok && resolvedB.ok).toBe(true);
    if (!resolvedA.ok || !resolvedB.ok) return;
    expect(JSON.stringify(resolvedA.instances)).toBe(
      JSON.stringify(resolvedB.instances),
    );
  });
});
