/**
 * Radius/diameter measurement tests (Phase 27.3): the support matrix's
 * semantic values and units — the EXACT stored radius of circular entities
 * (the sketch circle/arc path), the EXACT cylindrical-face radius of a
 * persistent topology snapshot (the OCCT surface-typing path), the
 * least-squares axis+circle FIT over a tessellated cylindrical region (the
 * transient synthetic-face path, band-documented), and every structured
 * decline of the matrix.
 *
 * The fixture truths are hand-computable: a stored radius of 5 mm carries
 * diameter 10 mm; a 63-segment bore wall of radius 4 (the shared mesh
 * convention — vertices ON the true cylinder) fits to its true radius
 * within float precision, while the wall's linear FACETS deviate from the
 * true surface by the chord sagitta `r·(1 − cos(π/63))`; a plane and a
 * sphere patch decline as not cylindrical. The fit is deterministic — an
 * identical buffer fitted twice yields byte-identical fit details.
 */

import { describe, expect, it } from "vitest";
import type {
  FeatureRecord,
  RenderObject,
  SelectionReference,
  TopologyEntitySnapshot,
} from "./index";

import {
  createBodyId,
  createFeatureId,
  formatRadiusMeasure,
  fitCylindricalRadius,
  projectTessellation,
  RADIUS_ERROR_CODES,
  selectionRadius,
  snapshotEntityRadius,
  storedRadius,
  valueIn,
} from "./index";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const BORE_BODY = createBodyId("body_bore");

/**
 * A cylinder wall as one render object: `segments` chords around radius 4,
 * height 10 along +z, the shared mesh convention's VERTICES ON the true
 * cylinder (the kernels subdivide circular profiles at a 0.1 rad ceiling —
 * 63 chords per full turn — without chord-midpoint off-surface samples).
 */
function boreWallObject(
  radius = 4,
  height = 10,
  segments = 63,
  bodyId: ReturnType<typeof createBodyId> = BORE_BODY,
): RenderObject {
  const positions: number[] = [];
  const indices: number[] = [];
  for (let i = 0; i < segments; i += 1) {
    const angle = (2 * Math.PI * i) / segments;
    positions.push(radius * Math.cos(angle), radius * Math.sin(angle), 0);
  }
  for (let i = 0; i < segments; i += 1) {
    const angle = (2 * Math.PI * i) / segments;
    positions.push(radius * Math.cos(angle), radius * Math.sin(angle), height);
  }
  for (let i = 0; i < segments; i += 1) {
    const next = (i + 1) % segments;
    const bottomA = i;
    const bottomB = next;
    const topA = segments + i;
    const topB = segments + next;
    indices.push(bottomA, bottomB, topB, bottomA, topB, topA);
  }
  const projected = projectTessellation(bodyId, { positions, indices });
  expect(projected.ok).toBe(true);
  if (!projected.ok) throw new Error("unreachable: wall object asserted");
  return projected.value;
}

/** A partial (half-turn) wall of the same convention. */
function halfWallObject(): RenderObject {
  const segments = 32;
  const positions: number[] = [];
  const indices: number[] = [];
  for (let i = 0; i <= segments; i += 1) {
    const angle = (Math.PI * i) / segments;
    positions.push(6 * Math.cos(angle), 6 * Math.sin(angle), 0);
  }
  const ring = segments + 1;
  for (let i = 0; i <= segments; i += 1) {
    const angle = (Math.PI * i) / segments;
    positions.push(6 * Math.cos(angle), 6 * Math.sin(angle), 5);
  }
  for (let i = 0; i < segments; i += 1) {
    indices.push(i, i + 1, ring + i + 1, i, ring + i + 1, ring + i);
  }
  const projected = projectTessellation(BORE_BODY, { positions, indices });
  expect(projected.ok).toBe(true);
  if (!projected.ok) throw new Error("unreachable: half wall asserted");
  return projected.value;
}

/** A planar quad as one render object (the plate top's shape). */
function quadObject(): RenderObject {
  const projected = projectTessellation(BORE_BODY, {
    positions: [0, 0, 10, 30, 0, 10, 30, 20, 10, 0, 20, 10],
    indices: [0, 1, 2, 0, 2, 3],
  });
  expect(projected.ok).toBe(true);
  if (!projected.ok) throw new Error("unreachable: quad object asserted");
  return projected.value;
}

/** A sphere patch (lat-long grid, radius 5) as one render object. */
function spherePatchObject(): RenderObject {
  const latitudes = 8;
  const longitudes = 12;
  const positions: number[] = [];
  const indices: number[] = [];
  const at = (i: number, j: number): number => i * (longitudes + 1) + j;
  for (let i = 0; i <= latitudes; i += 1) {
    const theta = 0.3 + (0.9 * i) / latitudes;
    for (let j = 0; j <= longitudes; j += 1) {
      const phi = (2 * Math.PI * j) / longitudes;
      positions.push(
        5 * Math.sin(theta) * Math.cos(phi),
        5 * Math.sin(theta) * Math.sin(phi),
        5 * Math.cos(theta),
      );
    }
  }
  for (let i = 0; i < latitudes; i += 1) {
    for (let j = 0; j < longitudes; j += 1) {
      indices.push(
        at(i, j),
        at(i, j + 1),
        at(i + 1, j + 1),
        at(i, j),
        at(i + 1, j + 1),
        at(i + 1, j),
      );
    }
  }
  const projected = projectTessellation(BORE_BODY, { positions, indices });
  expect(projected.ok).toBe(true);
  if (!projected.ok) throw new Error("unreachable: sphere patch asserted");
  return projected.value;
}

function faceRef(faceIndex: number, regeneration = 0): SelectionReference {
  return { kind: "face", bodyId: BORE_BODY, regeneration, faceIndex };
}

/** An OCCT-shaped face snapshot whose descriptor carries the exact radius. */
function cylindricalFaceSnapshot(radiusMm: number): TopologyEntitySnapshot {
  return {
    kind: "face",
    ordinal: 0,
    identity: {
      kernelId: "occt-test",
      schema: "occt-shape-hash-v1",
      data: { hash: 11 },
    },
    geometry: {
      areaMm2: 2 * Math.PI * radiusMm * 10,
      centroidAbsoluteMm: [radiusMm, 0, 5],
      centroidRelativeMm: [0, 0, 0],
      cylinderRadiusMm: radiusMm,
    },
  };
}

/** An OCCT-shaped face snapshot with summary measures only (a plane). */
function planarFaceSnapshot(): TopologyEntitySnapshot {
  return {
    kind: "face",
    ordinal: 0,
    identity: {
      kernelId: "occt-test",
      schema: "occt-shape-hash-v1",
      data: { hash: 12 },
    },
    geometry: {
      areaMm2: 600,
      centroidAbsoluteMm: [15, 10, 10],
      centroidRelativeMm: [0, 0, 0],
    },
  };
}

// ---------------------------------------------------------------------------
// The exact stored path: circular entities that carry their radius
// ---------------------------------------------------------------------------

describe("storedRadius — the exact path", () => {
  it("measures a stored 5 mm radius exactly, with its 10 mm diameter dual", () => {
    const measured = storedRadius(5);
    expect(measured.ok).toBe(true);
    if (!measured.ok) return;
    expect(measured.value.precision).toBe("exact");
    expect(measured.value.radius.unit).toBe("mm");
    expect(valueIn(measured.value.radius, "mm")).toBe(5);
    expect(valueIn(measured.value.diameter, "mm")).toBe(10);
  });

  it("derives the diameter through the shared dimensional infrastructure", () => {
    const measured = storedRadius(25.4);
    expect(measured.ok).toBe(true);
    if (!measured.ok) return;
    // The dual presentation converts like any length: 50.8 mm is 2 in.
    expect(valueIn(measured.value.diameter, "in")).toBeCloseTo(2, 12);
    expect(valueIn(measured.value.radius, "in")).toBeCloseTo(1, 12);
  });

  it("declines a stored radius that is not a positive finite number", () => {
    for (const invalid of [0, -3, Number.NaN, Number.POSITIVE_INFINITY]) {
      const declined = storedRadius(invalid);
      expect(declined.ok).toBe(false);
      if (declined.ok) continue;
      expect(declined.error.code).toBe(RADIUS_ERROR_CODES.radiusInvalid);
    }
  });
});

// ---------------------------------------------------------------------------
// The persistent snapshot path: surface-typed cylindrical faces
// ---------------------------------------------------------------------------

describe("snapshotEntityRadius — the OCCT persistent path", () => {
  it("measures a cylindrical face's descriptor radius exactly", () => {
    const measured = snapshotEntityRadius(cylindricalFaceSnapshot(4));
    expect(measured.ok).toBe(true);
    if (!measured.ok) return;
    expect(measured.value.precision).toBe("exact");
    expect(valueIn(measured.value.radius, "mm")).toBe(4);
    expect(valueIn(measured.value.diameter, "mm")).toBe(8);
  });

  it("declines a face snapshot without surface typing — summary measures are not a radius", () => {
    const declined = snapshotEntityRadius(planarFaceSnapshot());
    expect(declined.ok).toBe(false);
    if (declined.ok) return;
    expect(declined.error.code).toBe(RADIUS_ERROR_CODES.unresolvableReference);
  });

  it("declines edge and vertex snapshots — no surface to type", () => {
    for (const kind of ["edge", "vertex"] as const) {
      const declined = snapshotEntityRadius({
        kind,
        ordinal: 0,
        identity: {
          kernelId: "occt-test",
          schema: "occt-shape-hash-v1",
          data: { hash: 13 },
        },
        geometry:
          kind === "edge"
            ? { lengthMm: 30, centroidAbsoluteMm: [15, 0, 0] }
            : { pointAbsoluteMm: [0, 0, 0] },
      });
      expect(declined.ok).toBe(false);
      if (declined.ok) continue;
      expect(declined.error.code).toBe(
        RADIUS_ERROR_CODES.unresolvableReference,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// The tessellated path: least-squares axis + circle fit
// ---------------------------------------------------------------------------

describe("fitCylindricalRadius — the fit path", () => {
  it("fits the 63-segment bore wall to its true radius (the convention's vertices are on the cylinder)", () => {
    const wall = boreWallObject();
    const fitted = fitCylindricalRadius(wall.positions, wall.indices);
    expect(fitted.ok).toBe(true);
    if (!fitted.ok) return;
    expect(fitted.value.precision).toBe("fitted");
    expect(valueIn(fitted.value.radius, "mm")).toBeCloseTo(4, 9);
    expect(valueIn(fitted.value.diameter, "mm")).toBeCloseTo(8, 9);
    expect(fitted.value.fit?.axis[2]).toBeCloseTo(1, 9);
    expect(fitted.value.fit?.axis[0]).toBeCloseTo(0, 9);
    expect(fitted.value.fit?.axis[1]).toBeCloseTo(0, 9);
    expect(fitted.value.fit?.vertexCount).toBe(126);
    expect(fitted.value.fit?.residualMm).toBeLessThan(1e-6);
  });

  it("fits an identical buffer twice to byte-identical details — the fit is deterministic", () => {
    // The Jacobi sweeps, the sign fixing, and the in-plane frame are all
    // order-fixed: the same buffer must fit to the SAME axis, centre,
    // residual, and count — no run-to-run drift is ever acceptable.
    const wall = boreWallObject();
    const first = fitCylindricalRadius(wall.positions, wall.indices);
    const second = fitCylindricalRadius(wall.positions, wall.indices);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.value).toEqual(first.value);
    expect(JSON.stringify(second.value)).toBe(JSON.stringify(first.value));
  });

  it("the documented facet band: the mesh departs from the true cylinder by the chord sagitta while the fit stays exact", () => {
    // The 63-chord convention's sagitta — the FACETS' deviation from the
    // true surface — is r·(1 − cos(π/63)) ≈ 0.00124·r (≈ 5 µm at r = 4);
    // the VERTICES sit on the surface, so the fit reconstructs the true
    // radius and its error is float noise, orders below the facet band.
    const sagitta = 4 * (1 - Math.cos(Math.PI / 63));
    expect(sagitta).toBeCloseTo(0.004972, 6);
    const wall = boreWallObject();
    const fitted = fitCylindricalRadius(wall.positions, wall.indices);
    expect(fitted.ok).toBe(true);
    if (!fitted.ok) return;
    expect(fitted.value.fit?.residualMm ?? 1).toBeLessThan(sagitta / 100);
  });

  it("fits a partial (half-turn) wall and a coarse 6-segment wall exactly", () => {
    const half = fitCylindricalRadius(
      halfWallObject().positions,
      halfWallObject().indices,
    );
    expect(half.ok).toBe(true);
    if (half.ok) {
      expect(valueIn(half.value.radius, "mm")).toBeCloseTo(6, 9);
    }
    const coarse = fitCylindricalRadius(
      boreWallObject(2.5, 4, 6).positions,
      boreWallObject(2.5, 4, 6).indices,
    );
    expect(coarse.ok).toBe(true);
    if (coarse.ok) {
      expect(valueIn(coarse.value.radius, "mm")).toBeCloseTo(2.5, 9);
    }
  });

  it("fits a wall whose axis is not the z axis", () => {
    // The same bore wall rotated 90° about y: the axis runs along x —
    // (x, y, z) → (z, y, −x).
    const wall = boreWallObject();
    const rotated: number[] = [];
    for (let i = 0; i < wall.positions.length; i += 3) {
      const x = wall.positions[i];
      const y = wall.positions[i + 1];
      const z = wall.positions[i + 2];
      if (x === undefined || y === undefined || z === undefined) {
        throw new RangeError("fixture vertex out of range");
      }
      rotated.push(z, y, -x);
    }
    const fitted = fitCylindricalRadius(rotated, wall.indices);
    expect(fitted.ok).toBe(true);
    if (!fitted.ok) return;
    expect(valueIn(fitted.value.radius, "mm")).toBeCloseTo(4, 9);
    expect(Math.abs(fitted.value.fit?.axis[0] ?? 0)).toBeCloseTo(1, 9);
  });

  it("measures only the referenced vertices — a face slice may share its object's positions buffer", () => {
    // The synthetic-face slice carries its own triangle indices over the
    // OBJECT's positions (the real kernel meshes hold every face's
    // vertices in one buffer). A vertex the region's indices never
    // reference — even one far off the cylinder — must not enter the fit.
    const wall = boreWallObject();
    const positions = [...wall.positions, 1000, 1000, 1000];
    const fitted = fitCylindricalRadius(positions, wall.indices);
    expect(fitted.ok).toBe(true);
    if (!fitted.ok) return;
    expect(valueIn(fitted.value.radius, "mm")).toBeCloseTo(4, 9);
    expect(fitted.value.fit?.vertexCount).toBe(126);
  });

  it("declines a planar face as not cylindrical", () => {
    const quad = quadObject();
    const declined = fitCylindricalRadius(quad.positions, quad.indices);
    expect(declined.ok).toBe(false);
    if (declined.ok) return;
    expect(declined.error.code).toBe(RADIUS_ERROR_CODES.notCylindrical);
  });

  it("declines a sphere patch as not cylindrical", () => {
    const patch = spherePatchObject();
    const declined = fitCylindricalRadius(patch.positions, patch.indices);
    expect(declined.ok).toBe(false);
    if (declined.ok) return;
    expect(declined.error.code).toBe(RADIUS_ERROR_CODES.notCylindrical);
  });

  it("declines fewer than three distinct vertices — no circle is defined", () => {
    const declined = fitCylindricalRadius([0, 0, 0, 1, 0, 0], [0, 1, 0]);
    expect(declined.ok).toBe(false);
    if (declined.ok) return;
    expect(declined.error.code).toBe(RADIUS_ERROR_CODES.notCylindrical);
  });

  it("declines malformed buffers with the structured geometry code", () => {
    const badIndices = fitCylindricalRadius(
      [0, 0, 0, 1, 0, 0, 0, 1, 0],
      [0, 1, 9],
    );
    expect(badIndices.ok).toBe(false);
    if (!badIndices.ok) {
      expect(badIndices.error.code).toBe(RADIUS_ERROR_CODES.geometryInvalid);
    }
    const badPositions = fitCylindricalRadius([0, 0, 0, 1, 0], [0, 1, 0]);
    expect(badPositions.ok).toBe(false);
    if (!badPositions.ok) {
      expect(badPositions.error.code).toBe(RADIUS_ERROR_CODES.geometryInvalid);
    }
  });
});

// ---------------------------------------------------------------------------
// Selection entry: the Radius row's request semantics
// ---------------------------------------------------------------------------

describe("selectionRadius", () => {
  it("measures one selected cylindrical face", () => {
    const wall = boreWallObject();
    const measured = selectionRadius([faceRef(0)], [wall], []);
    expect(measured.ok).toBe(true);
    if (!measured.ok) return;
    expect(valueIn(measured.value.radius, "mm")).toBeCloseTo(4, 9);
    expect(valueIn(measured.value.diameter, "mm")).toBeCloseTo(8, 9);
  });

  it("declines selections that are not exactly one reference", () => {
    const wall = boreWallObject();
    for (const selected of [[], [faceRef(0), faceRef(0)]]) {
      const declined = selectionRadius(selected, [wall], []);
      expect(declined.ok).toBe(false);
      if (declined.ok) continue;
      expect(declined.error.code).toBe(RADIUS_ERROR_CODES.notSingleReference);
    }
  });

  it("declines body, feature, and synthetic edge/vertex references", () => {
    const wall = boreWallObject();
    const feature: FeatureRecord = {
      id: createFeatureId("feat_bore"),
      kind: "extrude",
      inputs: [],
      outputs: [BORE_BODY],
    };
    const declined = [
      { kind: "body", bodyId: BORE_BODY } as SelectionReference,
      { kind: "solid", bodyId: BORE_BODY } as SelectionReference,
      { kind: "feature", featureId: feature.id } as SelectionReference,
      {
        kind: "edge",
        bodyId: BORE_BODY,
        regeneration: 0,
        edgeIndex: 0,
      } as SelectionReference,
      {
        kind: "vertex",
        bodyId: BORE_BODY,
        regeneration: 0,
        vertexIndex: 0,
      } as SelectionReference,
    ].map((reference) => selectionRadius([reference], [wall], [feature]));
    for (const result of declined) {
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.error.code).toBe(RADIUS_ERROR_CODES.unresolvableReference);
    }
  });

  it("declines a face reference outside the grouping and a planar face", () => {
    const wall = boreWallObject();
    const quad = quadObject();
    const outside = selectionRadius([faceRef(9)], [wall], []);
    expect(outside.ok).toBe(false);
    if (!outside.ok) {
      expect(outside.error.code).toBe(RADIUS_ERROR_CODES.unresolvableReference);
    }
    const planar = selectionRadius([faceRef(0)], [quad], []);
    expect(planar.ok).toBe(false);
    if (!planar.ok) {
      expect(planar.error.code).toBe(RADIUS_ERROR_CODES.notCylindrical);
    }
  });
});

// ---------------------------------------------------------------------------
// Formatting: the dual presentation through the shared unit infrastructure
// ---------------------------------------------------------------------------

describe("formatRadiusMeasure", () => {
  it("formats radius and diameter at three canonical-millimetre decimals", () => {
    const measured = storedRadius(4);
    expect(measured.ok).toBe(true);
    if (!measured.ok) return;
    expect(formatRadiusMeasure(measured.value)).toEqual({
      radius: "4.000",
      diameter: "8.000",
    });
  });

  it("formats the fitted path like the exact one — the precision label is data, not formatting", () => {
    const wall = boreWallObject();
    const fitted = fitCylindricalRadius(wall.positions, wall.indices);
    expect(fitted.ok).toBe(true);
    if (!fitted.ok) return;
    expect(formatRadiusMeasure(fitted.value)).toEqual({
      radius: "4.000",
      diameter: "8.000",
    });
  });
});
