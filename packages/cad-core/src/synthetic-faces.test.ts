/**
 * Unit tests for synthetic face grouping: the 30° adjacency rule, exact
 * planar grouping with kernel normals, the geometric fallback, connectivity
 * (disconnected coplanar triangles never group), smooth-region chaining,
 * degenerate handling, and the documented determinism (same input → same
 * groups, ordinals by first-triangle order).
 */

import { describe, expect, it } from "vitest";
import type { RenderObject } from "./projection";
import type { SyntheticFaceGrouping } from "./synthetic-faces";

import { createBodyId } from "./ids";
import { projectTessellation } from "./projection";
import {
  groupSyntheticFaces,
  syntheticFaceAnchor,
  syntheticFaceMeanNormal,
  syntheticFaceOfTriangle,
  SYNTHETIC_FACE_GROUPING_THRESHOLD_DEGREES,
} from "./synthetic-faces";


interface RawTessellation {
  readonly positions: readonly number[];
  readonly indices: readonly number[];
  readonly normals?: readonly number[];
}

function objectOf(tessellation: RawTessellation): RenderObject {
  const result = projectTessellation(createBodyId("body_cube"), tessellation);
  if (!result.ok) {
    throw new Error(`Fixture rejected: ${result.error.message}`);
  }
  return result.value;
}

/** Outward-wound unit cube faces with duplicated per-face vertices. */
const CUBE_FACES: readonly {
  readonly corners: readonly (readonly [number, number, number])[];
  readonly normal: readonly [number, number, number];
}[] = [
  { corners: [[0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]], normal: [0, 0, 1] },
  { corners: [[0, 0, 0], [0, 1, 0], [1, 1, 0], [1, 0, 0]], normal: [0, 0, -1] },
  { corners: [[1, 0, 0], [1, 1, 0], [1, 1, 1], [1, 0, 1]], normal: [1, 0, 0] },
  { corners: [[0, 0, 0], [0, 0, 1], [0, 1, 1], [0, 1, 0]], normal: [-1, 0, 0] },
  { corners: [[0, 1, 0], [0, 1, 1], [1, 1, 1], [1, 1, 0]], normal: [0, 1, 0] },
  { corners: [[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1]], normal: [0, -1, 0] },
];

function cubeTessellation(withNormals: boolean): RawTessellation {
  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];
  for (const face of CUBE_FACES) {
    const base = positions.length / 3;
    for (const corner of face.corners) {
      positions.push(...corner);
      normals.push(...face.normal);
    }
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  return withNormals ? { positions, indices, normals } : { positions, indices };
}

/**
 * Two triangles sharing the edge (0,0,0)-(1,0,0), the second folded by
 * `angleDeg` about the x axis. Kernel normals (when requested) are the
 * exact face normals, mirroring how crease-aware kernels split normals.
 */
function foldPair(angleDeg: number, withNormals: boolean): RawTessellation {
  const rad = (angleDeg * Math.PI) / 180;
  const positions = [
    0, 0, 0, 1, 0, 0, 0, 1, 0,
    0, 0, 0, 1, 0, 0, 0, Math.cos(rad), -Math.sin(rad),
  ];
  const secondNormal = [0, Math.sin(rad), Math.cos(rad)];
  const normals = [
    0, 0, 1, 0, 0, 1, 0, 0, 1,
    ...secondNormal, ...secondNormal, ...secondNormal,
  ];
  return withNormals
    ? { positions, indices: [0, 1, 2, 3, 4, 5], normals }
    : { positions, indices: [0, 1, 2, 3, 4, 5] };
}

/**
 * A strip of `steps` triangles over the helix w(i) = (i, cos(i·d), sin(i·d)):
 * consecutive triangles share an edge and their normals turn by a small,
 * computable step, so the strip pins the smooth-region chaining rule (and
 * its threshold behavior) exactly.
 */
function helixStrip(stepDeg: number, steps: number): RawTessellation {
  const rad = (stepDeg * Math.PI) / 180;
  const positions: number[] = [];
  const indices: number[] = [];
  for (let i = 0; i <= steps + 1; i += 1) {
    positions.push(i, Math.cos(i * rad), Math.sin(i * rad));
  }
  for (let i = 0; i < steps; i += 1) {
    indices.push(i, i + 1, i + 2);
  }
  return { positions, indices };
}

function faceOf(grouping: SyntheticFaceGrouping, faceIndex: number) {
  const face = grouping.faces[faceIndex];
  if (face === undefined) throw new Error(`Missing face ${String(faceIndex)}.`);
  return face;
}

describe("groupSyntheticFaces", () => {
  it("groups the cube into six planar faces under kernel normals", () => {
    const grouping = groupSyntheticFaces(objectOf(cubeTessellation(true)));
    expect(grouping.triangleCount).toBe(12);
    expect(grouping.faceCount).toBe(6);
    expect(grouping.faces.map((face) => face.triangleIndices)).toEqual([
      [0, 1], [2, 3], [4, 5], [6, 7], [8, 9], [10, 11],
    ]);
  });

  it("groups identically without kernel normals (geometric fallback)", () => {
    const grouping = groupSyntheticFaces(objectOf(cubeTessellation(false)));
    expect(grouping.faceCount).toBe(6);
    expect(grouping.faces.map((face) => face.triangleIndices)).toEqual([
      [0, 1], [2, 3], [4, 5], [6, 7], [8, 9], [10, 11],
    ]);
  });

  it("assigns face ordinals by first-triangle order and maps every triangle", () => {
    const grouping = groupSyntheticFaces(objectOf(cubeTessellation(true)));
    expect(grouping.triangleFaces).toHaveLength(grouping.triangleCount);
    for (const face of grouping.faces) {
      expect(face.index).toBe(grouping.faces.indexOf(face));
      for (const triangle of face.triangleIndices) {
        expect(syntheticFaceOfTriangle(grouping, triangle)).toBe(face.index);
      }
    }
  });

  it("keeps a 10° fold in one face and splits a 45° fold (kernel normals)", () => {
    expect(groupSyntheticFaces(objectOf(foldPair(10, true))).faceCount).toBe(1);
    expect(groupSyntheticFaces(objectOf(foldPair(45, true))).faceCount).toBe(2);
  });

  it("applies the documented ≤ threshold with geometric normals", () => {
    expect(SYNTHETIC_FACE_GROUPING_THRESHOLD_DEGREES).toBe(30);
    expect(groupSyntheticFaces(objectOf(foldPair(25, false))).faceCount).toBe(1);
    expect(groupSyntheticFaces(objectOf(foldPair(35, false))).faceCount).toBe(2);
  });

  it("requires adjacency: coplanar disconnected triangles stay separate", () => {
    const grouping = groupSyntheticFaces(
      objectOf({
        positions: [
          0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 0, 0, 1, 1, 0, 0, 1, 0,
          2, 0, 0, 3, 0, 0, 3, 1, 0, 2, 0, 0, 3, 1, 0, 2, 1, 0,
        ],
        indices: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
      }),
    );
    expect(grouping.faceCount).toBe(2);
  });

  it("chains a smooth strip into one face while its normals span past 30°", () => {
    // Adjacent normals differ by 9.85° each (well under the threshold);
    // the strip's overall normal span is ~70°, and it is still ONE face:
    // curvature accumulates along a connected region by design.
    const grouping = groupSyntheticFaces(objectOf(helixStrip(10, 8)));
    expect(grouping.faceCount).toBe(1);
    expect(faceOf(grouping, 0).triangleIndices).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });

  it("splits a strip whose adjacent normal steps exceed the threshold", () => {
    // Adjacent normals differ by 30.24° — just past the 30° rule.
    const grouping = groupSyntheticFaces(objectOf(helixStrip(35, 8)));
    expect(grouping.faceCount).toBe(8);
  });

  it("groups a degenerate triangle through its kernel normals", () => {
    // Second triangle is collinear (zero geometric area) but carries the
    // first triangle's kernel normal and shares an edge with it.
    const grouping = groupSyntheticFaces(
      objectOf({
        positions: [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 2, 0, 0],
        indices: [0, 1, 2, 3, 4, 5],
        normals: [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1],
      }),
    );
    expect(grouping.faceCount).toBe(1);
  });

  it("quarantines a degenerate triangle without normals as its own face", () => {
    const grouping = groupSyntheticFaces(
      objectOf({
        positions: [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 2, 0, 0],
        indices: [0, 1, 2, 3, 4, 5],
      }),
    );
    expect(grouping.faceCount).toBe(2);
    expect(faceOf(grouping, 1).triangleIndices).toEqual([1]);
  });

  it("is deterministic: same input, same groups, every time", () => {
    const tessellation = cubeTessellation(true);
    const first = groupSyntheticFaces(objectOf(tessellation));
    const second = groupSyntheticFaces(objectOf(tessellation));
    expect(second).toEqual(first);
    expect(second.triangleFaces).toEqual(first.triangleFaces);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.faces)).toBe(true);
  });
});

describe("syntheticFaceOfTriangle", () => {
  it("throws a RangeError for out-of-range triangle indices", () => {
    const grouping = groupSyntheticFaces(objectOf(cubeTessellation(true)));
    expect(() => syntheticFaceOfTriangle(grouping, 12)).toThrow(RangeError);
    expect(() => syntheticFaceOfTriangle(grouping, -1)).toThrow(RangeError);
    expect(() => syntheticFaceOfTriangle(grouping, 1.5)).toThrow(RangeError);
  });
});

describe("syntheticFaceAnchor", () => {
  it("anchors a cube face at its first (equal-largest) triangle's centroid", () => {
    const object = objectOf(cubeTessellation(true));
    const grouping = groupSyntheticFaces(object);
    // Face 0 is +z: triangles (0,0,1)(1,0,1)(1,1,1) and (0,0,1)(1,1,1)(0,1,1),
    // equal areas, so the tie resolves to the lower triangle index.
    expect(syntheticFaceAnchor(object, grouping, 0)).toEqual([2 / 3, 1 / 3, 1]);
  });

  it("anchors at the largest triangle when areas differ", () => {
    // A quad split unequally: t0 area 1.5, t1 area 4.5 — the anchor must be
    // t1's centroid, and it must lie strictly inside t1.
    const object = objectOf({
      positions: [0, 0, 0, 3, 0, 0, 3, 1, 0, 0, 3, 0],
      indices: [0, 1, 2, 0, 2, 3],
    });
    const grouping = groupSyntheticFaces(object);
    expect(grouping.faceCount).toBe(1);
    expect(syntheticFaceAnchor(object, grouping, 0)).toEqual([1, 4 / 3, 0]);
  });

  it("throws a RangeError for an out-of-range face index", () => {
    const object = objectOf(cubeTessellation(true));
    const grouping = groupSyntheticFaces(object);
    expect(() => syntheticFaceAnchor(object, grouping, 6)).toThrow(RangeError);
  });
});

describe("syntheticFaceMeanNormal", () => {
  it("reports a planar face's exact normal", () => {
    const object = objectOf(cubeTessellation(true));
    const grouping = groupSyntheticFaces(object);
    expect(syntheticFaceMeanNormal(object, grouping, 0)).toEqual([0, 0, 1]);
    expect(syntheticFaceMeanNormal(object, grouping, 5)).toEqual([0, -1, 0]);
  });

  it("reports null for a face whose normals cancel (closed curve or degenerate)", () => {
    const object = objectOf(cubeTessellation(true));
    const grouping = groupSyntheticFaces(object);
    expect(() => syntheticFaceMeanNormal(object, grouping, 9)).toThrow(RangeError);
    // A face whose only triangle is degenerate has no representative normal
    // to average — null, not a fabricated direction.
    const degenerate = objectOf({
      positions: [0, 0, 0, 1, 0, 0, 2, 0, 0],
      indices: [0, 1, 2],
    });
    const degenerateGrouping = groupSyntheticFaces(degenerate);
    expect(syntheticFaceMeanNormal(degenerate, degenerateGrouping, 0)).toBeNull();
  });
});
