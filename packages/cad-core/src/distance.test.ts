/**
 * Distance-measurement tests (Phase 27.2): the geometric semantics per
 * reference pair — Euclidean point pairs, exact projection of a point onto
 * an edge's polyline or a face's triangles, sampled minima for entity
 * pairs — the canonical-millimetre unit contract, reference resolution
 * from the surfaces the current kernels actually carry, and every
 * structured decline of the documented matrix.
 *
 * The fixture truths are hand-computable: a vertex exactly 10 mm above the
 * plate's bottom plane, parallel edges offset by 4 mm, concentric sampled
 * circles whose chord sagitta shifts the sampled minimum by exactly
 * `r1 − r2·cos(π/n)`, and two bodies 4 mm apart at their nearest sampled
 * vertices.
 */

import { describe, expect, it } from "vitest";
import type {
  FeatureRecord,
  MeasureEntity,
  RenderObject,
  SelectionReference,
  TopologyEntitySnapshot,
} from "./index";

import {
  createBodyId,
  createFeatureId,
  DISTANCE_ERROR_CODES,
  edgeEntity,
  formatMeasureDistance,
  length,
  measureDistance,
  measureEntityOfReference,
  measureEntityOfSnapshotEntity,
  pointEntity,
  projectTessellation,
  selectionDistance,
  surfaceEntity,
  valueIn,
  vertexEntity,
} from "./index";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const QUAD_BODY = createBodyId("body_quad");
const OTHER_BODY = createBodyId("body_other");

/**
 * Two parallel 30 × 20 quads — top at z=10, bottom at z=0, both spanning
 * `[0,30] × [0,20]` — as one render object. The synthetic grouping yields
 * exactly two faces: face 0 (top), face 1 (bottom); the planes sit exactly
 * 10 mm apart.
 */
function quadObject(): RenderObject {
  const projected = projectTessellation(QUAD_BODY, {
    positions: [
      0, 0, 10, 30, 0, 10, 30, 20, 10, 0, 20, 10, 0, 0, 0, 30, 0, 0, 30, 20, 0,
      0, 20, 0,
    ],
    indices: [0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7],
  });
  expect(projected.ok).toBe(true);
  if (!projected.ok) throw new Error("unreachable: quad object asserted");
  return projected.value;
}

function faceRef(faceIndex: number): SelectionReference {
  return { kind: "face", bodyId: QUAD_BODY, regeneration: 0, faceIndex };
}

/** A closed axis-aligned box as one render object (12 triangles). */
function boxObject(
  bodyId: ReturnType<typeof createBodyId>,
  min: readonly [number, number, number],
  max: readonly [number, number, number],
): RenderObject {
  const [x0, y0, z0] = min;
  const [x1, y1, z1] = max;
  const projected = projectTessellation(bodyId, {
    positions: [
      x0,
      y0,
      z0,
      x1,
      y0,
      z0,
      x1,
      y1,
      z0,
      x0,
      y1,
      z0,
      x0,
      y0,
      z1,
      x1,
      y0,
      z1,
      x1,
      y1,
      z1,
      x0,
      y1,
      z1,
    ],
    indices: [
      0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2,
      3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7,
    ],
  });
  expect(projected.ok).toBe(true);
  if (!projected.ok) throw new Error("unreachable: box object asserted");
  return projected.value;
}

/** An OCCT-shaped vertex snapshot entity carrying an exact absolute point. */
function vertexSnapshotEntity(
  ordinal: number,
  position: readonly [number, number, number],
): TopologyEntitySnapshot {
  return {
    kind: "vertex",
    ordinal,
    identity: {
      kernelId: "occt-test",
      schema: "occt-shape-hash-v1",
      data: { hash: ordinal + 1 },
    },
    geometry: {
      pointAbsoluteMm: position,
      pointRelativeMm: [position[0], position[1], position[2] - 5],
    },
  };
}

/** An OCCT-shaped snapshot entity whose descriptor carries summary measures only. */
function summarySnapshotEntity(
  kind: "edge" | "face",
  ordinal: number,
): TopologyEntitySnapshot {
  return {
    kind,
    ordinal,
    identity: {
      kernelId: "occt-test",
      schema: "occt-shape-hash-v1",
      data: { hash: 100 + ordinal },
    },
    geometry:
      kind === "edge"
        ? { lengthMm: 30, centroidAbsoluteMm: [15, 0, 10] }
        : { areaMm2: 600, centroidAbsoluteMm: [15, 10, 10] },
  };
}

// ---------------------------------------------------------------------------
// Geometric semantics: the hand-computable fixture truths
// ---------------------------------------------------------------------------

describe("measureDistance — point semantics", () => {
  it("measures point↔point as the Euclidean distance (3-4-5)", () => {
    const a = pointEntity([0, 0, 0]);
    const b = pointEntity([3, 4, 0]);
    const measured = measureDistance(a, b);
    expect(measured.ok).toBe(true);
    if (!measured.ok) return;
    expect(valueIn(measured.value, "mm")).toBe(5);
  });

  it("measures a point to an edge as the exact projection onto the polyline", () => {
    const point = pointEntity([5, 3, 5]);
    const edge = edgeEntity([
      [0, 0, 5],
      [10, 0, 5],
    ]);
    const measured = measureDistance(point, edge);
    expect(measured.ok).toBe(true);
    if (!measured.ok) return;
    expect(valueIn(measured.value, "mm")).toBe(3);
  });

  it("measures a point to a face as the exact projection onto the triangulated plane", () => {
    const point = pointEntity([5, 2, 7]);
    const quad = surfaceEntity(
      "face",
      [0, 0, 0, 10, 0, 0, 10, 4, 0, 0, 4, 0],
      [0, 1, 2, 0, 2, 3],
    );
    const measured = measureDistance(point, quad);
    expect(measured.ok).toBe(true);
    if (!measured.ok) return;
    expect(valueIn(measured.value, "mm")).toBe(7);
  });

  it("measures a point to a face's boundary when its projection misses the face", () => {
    const point = pointEntity([15, 2, 7]);
    const quad = surfaceEntity(
      "face",
      [0, 0, 0, 10, 0, 0, 10, 4, 0, 0, 4, 0],
      [0, 1, 2, 0, 2, 3],
    );
    const measured = measureDistance(point, quad);
    expect(measured.ok).toBe(true);
    if (!measured.ok) return;
    // The projection (15, 2, 0) is 5 mm beyond the x=10 boundary edge;
    // the nearest face point is the boundary point (10, 2, 0): a
    // 3-4-5 hypotenuse.
    expect(valueIn(measured.value, "mm")).toBeCloseTo(Math.hypot(5, 7), 12);
  });
});

describe("measureDistance — entity pairs", () => {
  it("measures vertex↔vertex as the Euclidean distance", () => {
    const a = vertexEntity([0, 0, 0]);
    const b = vertexEntity([1, 2, 2]);
    const measured = measureDistance(a, b);
    expect(measured.ok).toBe(true);
    if (!measured.ok) return;
    expect(valueIn(measured.value, "mm")).toBe(3);
  });

  it("measures parallel edges at their exact offset (fixture truth: 4 mm)", () => {
    const a = edgeEntity([
      [0, 0, 0],
      [10, 0, 0],
    ]);
    const b = edgeEntity([
      [0, 0, 4],
      [10, 0, 4],
    ]);
    const measured = measureDistance(a, b);
    expect(measured.ok).toBe(true);
    if (!measured.ok) return;
    expect(valueIn(measured.value, "mm")).toBe(4);
  });

  it("measures parallel faces at their exact separation (fixture truth: 10 mm)", () => {
    const top = surfaceEntity(
      "face",
      [0, 0, 10, 30, 0, 10, 30, 20, 10, 0, 20, 10],
      [0, 1, 2, 0, 2, 3],
    );
    const bottom = surfaceEntity(
      "face",
      [0, 0, 0, 30, 0, 0, 30, 20, 0, 0, 20, 0],
      [0, 1, 2, 0, 2, 3],
    );
    const forward = measureDistance(top, bottom);
    const backward = measureDistance(bottom, top);
    expect(forward.ok && backward.ok).toBe(true);
    if (!forward.ok || !backward.ok) return;
    expect(valueIn(forward.value, "mm")).toBe(10);
    expect(valueIn(backward.value, "mm")).toBe(10);
  });

  it("measures concentric sampled circles at the chord-corrected radial gap", () => {
    // Two concentric 96-gons at radii 8 and 3, vertices aligned. The
    // sampled minimum: an inner vertex's perpendicular foot onto the
    // adjacent outer chord lands INTERIOR to it — t* = (R−r)/(2R) = 5/16
    // from the chord's nearer endpoint for this fixture — so the exact
    // sampled truth is the radial gap times the chord's half-angle cosine:
    // (r1 − r2)·cos(π/n) — hand-derived from the chord geometry, not the
    // ideal circles' bare radial gap.
    const n = 96;
    const circle = (radius: number): MeasureEntity =>
      edgeEntity(
        Array.from({ length: n }, (_, i) => {
          const angle = (2 * Math.PI * i) / n;
          return [radius * Math.cos(angle), radius * Math.sin(angle), 0] as [
            number,
            number,
            number,
          ];
        }),
      );
    const outer = circle(8);
    const inner = circle(3);
    const measured = measureDistance(outer, inner);
    expect(measured.ok).toBe(true);
    if (!measured.ok) return;
    const expected = (8 - 3) * Math.cos(Math.PI / n);
    expect(valueIn(measured.value, "mm")).toBeCloseTo(expected, 9);
  });

  it("measures body↔body at their nearest sampled vertices (fixture truth: 4 mm)", () => {
    const near = boxObject(QUAD_BODY, [0, 0, 0], [1, 1, 1]);
    const far = boxObject(OTHER_BODY, [5, 0, 0], [6, 1, 1]);
    const a = measureEntityOfReference(
      { kind: "body", bodyId: QUAD_BODY },
      [near, far],
      [],
    );
    const b = measureEntityOfReference(
      { kind: "body", bodyId: OTHER_BODY },
      [near, far],
      [],
    );
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    const measured = measureDistance(a.value, b.value);
    expect(measured.ok).toBe(true);
    if (!measured.ok) return;
    // The boxes are 5 mm apart along x; the nearest sampled vertices
    // (1, y, z) and (6, y, z) project exactly onto each other's faces.
    expect(valueIn(measured.value, "mm")).toBe(4);
  });

  it("is symmetric: d(a, b) equals d(b, a)", () => {
    const edge = edgeEntity([
      [0, 0, 0],
      [10, 0, 0],
    ]);
    const point = pointEntity([5, 3, 5]);
    const forward = measureDistance(edge, point);
    const backward = measureDistance(point, edge);
    expect(forward.ok && backward.ok).toBe(true);
    if (!forward.ok || !backward.ok) return;
    expect(forward.value).toEqual(backward.value);
  });

  it("measures a face to its own body as zero", () => {
    const object = quadObject();
    const body = measureEntityOfReference(
      { kind: "body", bodyId: QUAD_BODY },
      [object],
      [],
    );
    const face = measureEntityOfReference(faceRef(0), [object], []);
    expect(body.ok && face.ok).toBe(true);
    if (!body.ok || !face.ok) return;
    const measured = measureDistance(body.value, face.value);
    expect(measured.ok).toBe(true);
    if (!measured.ok) return;
    expect(valueIn(measured.value, "mm")).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Units: canonical millimetres through the shared dimensional infrastructure
// ---------------------------------------------------------------------------

describe("measureDistance — units", () => {
  it("returns a canonical-millimetre LengthValue", () => {
    const measured = measureDistance(
      pointEntity([0, 0, 10]),
      pointEntity([0, 0, 0]),
    );
    expect(measured.ok).toBe(true);
    if (!measured.ok) return;
    expect(measured.value.unit).toBe("mm");
    expect(valueIn(measured.value, "mm")).toBe(10);
    expect(measured.value.dimension).toBe("length");
  });

  it("formats through the shared dimensional API at three decimals", () => {
    expect(formatMeasureDistance(length(10))).toBe("10.000");
    expect(formatMeasureDistance(length(2.5))).toBe("2.500");
  });
});

// ---------------------------------------------------------------------------
// Resolution: references → entities, on the surfaces that carry them
// ---------------------------------------------------------------------------

describe("measureEntityOfReference", () => {
  it("resolves a face reference to its synthetic face's triangles", () => {
    const object = quadObject();
    const face = measureEntityOfReference(faceRef(0), [object], []);
    expect(face.ok).toBe(true);
    if (!face.ok) return;
    expect(face.value.kind).toBe("face");
    const bottom = measureEntityOfReference(faceRef(1), [object], []);
    expect(bottom.ok).toBe(true);
    if (!bottom.ok) return;
    const measured = measureDistance(face.value, bottom.value);
    expect(measured.ok).toBe(true);
    if (!measured.ok) return;
    // Fixture truth: the plate's top and bottom planes sit exactly 10 mm
    // apart — every top sample projects into the bottom quad's interior.
    expect(valueIn(measured.value, "mm")).toBe(10);
  });

  it("resolves solid references like body references", () => {
    const object = quadObject();
    const solid = measureEntityOfReference(
      { kind: "solid", bodyId: QUAD_BODY },
      [object],
      [],
    );
    expect(solid.ok).toBe(true);
    if (!solid.ok) return;
    expect(solid.value.kind).toBe("body");
  });

  it("declines a face reference outside the grouping", () => {
    const declined = measureEntityOfReference(faceRef(5), [quadObject()], []);
    expect(declined.ok).toBe(false);
    if (declined.ok) return;
    expect(declined.error.code).toBe(
      DISTANCE_ERROR_CODES.unresolvableReference,
    );
  });

  it("declines synthetic edge and vertex references — no producing surface", () => {
    for (const reference of [
      { kind: "edge", bodyId: QUAD_BODY, regeneration: 0, edgeIndex: 0 },
      { kind: "vertex", bodyId: QUAD_BODY, regeneration: 0, vertexIndex: 0 },
    ] as readonly SelectionReference[]) {
      const declined = measureEntityOfReference(reference, [quadObject()], []);
      expect(declined.ok).toBe(false);
      if (declined.ok) continue;
      expect(declined.error.code).toBe(
        DISTANCE_ERROR_CODES.unresolvableReference,
      );
    }
  });

  it("declines a body the passed scene does not carry", () => {
    const declined = measureEntityOfReference(
      { kind: "body", bodyId: OTHER_BODY },
      [quadObject()],
      [],
    );
    expect(declined.ok).toBe(false);
    if (declined.ok) return;
    expect(declined.error.code).toBe(
      DISTANCE_ERROR_CODES.unresolvableReference,
    );
  });

  it("resolves a feature through its single output body", () => {
    const feature: FeatureRecord = {
      id: createFeatureId("feat_pad"),
      kind: "extrude",
      inputs: [],
      outputs: [QUAD_BODY],
    };
    const entity = measureEntityOfReference(
      { kind: "feature", featureId: feature.id },
      [quadObject()],
      [feature],
    );
    expect(entity.ok).toBe(true);
    if (!entity.ok) return;
    expect(entity.value.kind).toBe("body");
  });

  it("declines a multi-output feature rather than guessing its body", () => {
    const feature: FeatureRecord = {
      id: createFeatureId("feat_split"),
      kind: "split",
      inputs: [],
      outputs: [QUAD_BODY, OTHER_BODY],
    };
    const declined = measureEntityOfReference(
      { kind: "feature", featureId: feature.id },
      [quadObject()],
      [feature],
    );
    expect(declined.ok).toBe(false);
    if (declined.ok) return;
    expect(declined.error.code).toBe(
      DISTANCE_ERROR_CODES.unresolvableReference,
    );
  });
});

describe("measureEntityOfSnapshotEntity — the OCCT persistent path", () => {
  it("resolves a vertex snapshot entity to its exact absolute point", () => {
    const entity = measureEntityOfSnapshotEntity(
      vertexSnapshotEntity(0, [3, 4, 0]),
    );
    expect(entity.ok).toBe(true);
    if (!entity.ok) return;
    expect(entity.value.kind).toBe("vertex");
    const origin = pointEntity([0, 0, 0]);
    const measured = measureDistance(entity.value, origin);
    expect(measured.ok).toBe(true);
    if (!measured.ok) return;
    expect(valueIn(measured.value, "mm")).toBe(5);
  });

  it("declines edge and face snapshot entities — summary measures are not geometry", () => {
    for (const entity of [
      summarySnapshotEntity("edge", 0),
      summarySnapshotEntity("face", 0),
    ]) {
      const declined = measureEntityOfSnapshotEntity(entity);
      expect(declined.ok).toBe(false);
      if (declined.ok) continue;
      expect(declined.error.code).toBe(
        DISTANCE_ERROR_CODES.unresolvableReference,
      );
    }
  });

  it("declines a vertex snapshot entity without an absolute point", () => {
    const declined = measureEntityOfSnapshotEntity({
      kind: "vertex",
      ordinal: 0,
      identity: {
        kernelId: "occt-test",
        schema: "occt-shape-hash-v1",
        data: { hash: 7 },
      },
      geometry: {},
    });
    expect(declined.ok).toBe(false);
    if (declined.ok) return;
    expect(declined.error.code).toBe(
      DISTANCE_ERROR_CODES.unresolvableReference,
    );
  });
});

describe("selectionDistance", () => {
  it("measures the distance of exactly two resolvable references", () => {
    const object = quadObject();
    const measured = selectionDistance([faceRef(0), faceRef(1)], [object], []);
    expect(measured.ok).toBe(true);
    if (!measured.ok) return;
    expect(valueIn(measured.value, "mm")).toBe(10);
  });

  it("declines selections that are not exactly a pair", () => {
    const object = quadObject();
    const body: SelectionReference = { kind: "body", bodyId: QUAD_BODY };
    const selections: readonly (readonly SelectionReference[])[] = [
      [],
      [faceRef(0)],
      [faceRef(0), faceRef(1), body],
    ];
    for (const selected of selections) {
      const declined = selectionDistance(selected, [object], []);
      expect(declined.ok).toBe(false);
      if (declined.ok) continue;
      expect(declined.error.code).toBe(DISTANCE_ERROR_CODES.notAPair);
    }
  });

  it("declines a pair containing an unresolvable reference", () => {
    const object = quadObject();
    const declined = selectionDistance(
      [
        faceRef(0),
        { kind: "edge", bodyId: QUAD_BODY, regeneration: 0, edgeIndex: 0 },
      ],
      [object],
      [],
    );
    expect(declined.ok).toBe(false);
    if (declined.ok) return;
    expect(declined.error.code).toBe(
      DISTANCE_ERROR_CODES.unresolvableReference,
    );
  });
});

// ---------------------------------------------------------------------------
// Structured declines: malformed geometry never computes silently
// ---------------------------------------------------------------------------

describe("measureDistance — structured declines", () => {
  it("declines a point with non-finite coordinates", () => {
    const declined = measureDistance(
      pointEntity([Number.NaN, 0, 0]),
      pointEntity([1, 0, 0]),
    );
    expect(declined.ok).toBe(false);
    if (declined.ok) return;
    expect(declined.error.code).toBe(DISTANCE_ERROR_CODES.geometryInvalid);
  });

  it("declines an edge polyline with fewer than two points", () => {
    const declined = measureDistance(
      edgeEntity([[0, 0, 0]]),
      pointEntity([1, 0, 0]),
    );
    expect(declined.ok).toBe(false);
    if (declined.ok) return;
    expect(declined.error.code).toBe(DISTANCE_ERROR_CODES.geometryInvalid);
  });

  it("declines a surface whose indices leave the vertex range", () => {
    const declined = measureDistance(
      surfaceEntity("face", [0, 0, 0, 1, 0, 0, 0, 1, 0], [0, 1, 9]),
      pointEntity([1, 0, 0]),
    );
    expect(declined.ok).toBe(false);
    if (declined.ok) return;
    expect(declined.error.code).toBe(DISTANCE_ERROR_CODES.geometryInvalid);
  });

  it("declines a surface whose index array is not flat triangles", () => {
    const declined = measureDistance(
      surfaceEntity("body", [0, 0, 0, 1, 0, 0, 0, 1, 0], [0, 1]),
      pointEntity([1, 0, 0]),
    );
    expect(declined.ok).toBe(false);
    if (declined.ok) return;
    expect(declined.error.code).toBe(DISTANCE_ERROR_CODES.geometryInvalid);
  });
});
