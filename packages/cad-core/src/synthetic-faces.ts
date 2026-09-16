/**
 * Synthetic face grouping (Phase 12): partitions a render object's triangles
 * into **synthetic faces** — connected, smooth surface regions — so a picker
 * can speak of "the top face" in a world where the kernel persists no
 * topology (`persistentTopology: false` in both current kernels' capability
 * declarations). Pure, kernel-free, renderer-free: the input is a
 * {@link RenderObject} (the Phase 11 projection data) and the output is
 * plain, deterministic, serializable data.
 *
 * ## Grouping rule (documented, deterministic)
 *
 * Two triangles belong to the same synthetic face exactly when they are
 * ADJACENT (they share a mesh edge) and their surface orientations differ by
 * at most {@link SYNTHETIC_FACE_GROUPING_THRESHOLD_DEGREES} (30°). Groups are
 * then the connected components of that relation — region-growing by
 * adjacency, so curvature may accumulate along a face (a cylinder wall whose
 * neighboring triangle normals differ by well under 30° groups as ONE face
 * even where the wall's overall turn exceeds the threshold), while a sharp
 * crease separates faces. Two coplanar triangles that share no edge never
 * group: connectivity is part of the definition.
 *
 * - **Threshold — 30°, aligned with the kernel's crease convention.** The
 *   Manifold adapter splits vertex normals at edges sharper than 30°
 *   (`MANIFOLD_NORMALS_MIN_SHARP_ANGLE_DEGREES`, the value the Phase 1.6
 *   spike validated); grouping at the same angle means the kernel's own
 *   normal splits mark exactly the boundaries synthetic faces respect. The
 *   constant is defined here independently — cad-core never imports the
 *   kernel — with this note as the recorded alignment.
 * - **Representative normal.** When the object carries kernel normals, a
 *   triangle's representative is the normalized mean of its three vertex
 *   normals (on kernel output, all three are identical on planar faces, so
 *   planar groups are exact). Without kernel normals the representative is
 *   the normalized geometric face normal. A triangle whose representatives
 *   are all degenerate (zero area and no usable normals) joins no group and
 *   forms its own singleton.
 * - **Adjacency is by vertex POSITION equality** (all three components
 *   exactly equal, `-0` normalized to `0`), not vertex-index equality:
 *   crease-aware kernels duplicate vertices at sharp edges to carry split
 *   normals, so the two triangles of a 90° corner share coordinates but not
 *   indices — and must still be candidates, so the ANGLE test (not a broken
 *   adjacency test) is what separates them.
 * - **Determinism.** Same input → same groups, always: all arithmetic is
 *   IEEE float64 (`+ - * / sqrt`, no randomness, no clock), the union-find
 *   links the larger root to the smaller (so representatives — and group
 *   membership, which partition union-find — are independent of union
 *   order), and face indices are assigned by scanning triangles in ascending
 *   order, giving **stable group indices ordered by first-triangle index**.
 *
 * ## What picking gets from here
 *
 * {@link groupSyntheticFaces} exposes the triangle → face mapping used to
 * turn a raycast triangle index into a synthetic face reference;
 * {@link syntheticFaceAnchor} exposes a guaranteed-on-face world point (the
 * centroid of the face's largest triangle — strictly inside that triangle,
 * hence inside the face) for test hooks and framing;
 * {@link syntheticFaceMeanNormal} exposes the face's mean representative
 * normal for semantic identification of planar faces ("the face whose
 * normal is +z"), reporting `null` for closed curved faces whose normals
 * wrap and cancel.
 *
 * ## Scope
 *
 * Faces only. Edge and vertex categories exist in the selection model
 * (`selection.ts`) and the plan names them, but Phase 12's browser criterion
 * is face selection; deriving cheap, stable edges/vertices from the face
 * adjacency here is deferred rather than half-done — the selection model
 * already carries their transient references for the phase that adds them.
 */

import type { RenderObject, RenderVector3 } from "./projection";

/**
 * Maximum angle (degrees) between adjacent triangles' representative normals
 * for them to group into one synthetic face. 30° — the kernel crease
 * convention (see the module header).
 */
export const SYNTHETIC_FACE_GROUPING_THRESHOLD_DEGREES = 30;

/** One synthetic face: a connected smooth region of triangles. */
export interface SyntheticFace {
  /** Face ordinal, 0-based, assigned by first-triangle order (stable). */
  readonly index: number;
  /** The face's triangle indices, ascending. */
  readonly triangleIndices: readonly number[];
}

/**
 * The synthetic face partition of one render object: the faces (ordered by
 * first-triangle index) and the flat triangle → face-ordinal mapping the
 * picker resolves raycast hits through.
 */
export interface SyntheticFaceGrouping {
  /** The triangle count the grouping was computed over. */
  readonly triangleCount: number;
  /** Number of synthetic faces; face ordinals are `0 .. faceCount - 1`. */
  readonly faceCount: number;
  /** The faces, ordered by first-triangle index. `faces[i].index === i`. */
  readonly faces: readonly SyntheticFace[];
  /** Flat map: triangle index → face ordinal; length `=== triangleCount`. */
  readonly triangleFaces: readonly number[];
}

/** Squared-length floor under which a normal candidate counts as degenerate. */
const DEGENERATE_NORMAL_LENGTH_SQUARED = 1e-24;

/** dot(a, b) at the grouping threshold; angles ≤ threshold compare `≥`. */
const COS_GROUPING_THRESHOLD = Math.cos(
  (SYNTHETIC_FACE_GROUPING_THRESHOLD_DEGREES * Math.PI) / 180,
);

/**
 * Reads one buffer component. The projection contract guarantees every
 * index in range, but `noUncheckedIndexedAccess` is honest about array
 * reads — this is the loud, checked accessor for internal math that must
 * never silently substitute a default for a missing component.
 */
function component(buffer: readonly number[], index: number): number {
  const value = buffer[index];
  if (value === undefined) {
    throw new RangeError(
      `Synthetic face grouping indexed buffer component ${String(index)} of a ${String(buffer.length)}-length buffer.`,
    );
  }
  return value;
}

/** Normalizes a direction; `null` when degenerate (at or near zero length). */
function normalized(
  x: number,
  y: number,
  z: number,
): readonly [number, number, number] | null {
  const lengthSquared = x * x + y * y + z * z;
  if (lengthSquared <= DEGENERATE_NORMAL_LENGTH_SQUARED) return null;
  const length = Math.sqrt(lengthSquared);
  return [x / length, y / length, z / length];
}

/** Component-exact position key; `-0` is normalized so keys never alias. */
function positionKey(positions: readonly number[], vertex: number): string {
  const x = component(positions, vertex * 3) + 0;
  const y = component(positions, vertex * 3 + 1) + 0;
  const z = component(positions, vertex * 3 + 2) + 0;
  return `${String(x)},${String(y)},${String(z)}`;
}

/** Normalized cross product of the triangle's edge vectors, or `null`. */
function geometricNormal(
  positions: readonly number[],
  a: number,
  b: number,
  c: number,
): readonly [number, number, number] | null {
  const ax = component(positions, a * 3);
  const ay = component(positions, a * 3 + 1);
  const az = component(positions, a * 3 + 2);
  const bx = component(positions, b * 3);
  const by = component(positions, b * 3 + 1);
  const bz = component(positions, b * 3 + 2);
  const cx = component(positions, c * 3);
  const cy = component(positions, c * 3 + 1);
  const cz = component(positions, c * 3 + 2);
  return normalized(
    (by - ay) * (cz - az) - (bz - az) * (cy - ay),
    (bz - az) * (cx - ax) - (bx - ax) * (cz - az),
    (bx - ax) * (cy - ay) - (by - ay) * (cx - ax),
  );
}

/**
 * Computes every triangle's representative normal (kernel-mean when the
 * object carries normals, geometric fallback, `null` when degenerate).
 */
function representativeNormals(
  object: RenderObject,
): readonly (readonly [number, number, number] | null)[] {
  const triangleCount = object.indices.length / 3;
  const result: (readonly [number, number, number] | null)[] = [];
  for (let t = 0; t < triangleCount; t += 1) {
    const a = component(object.indices, t * 3);
    const b = component(object.indices, t * 3 + 1);
    const c = component(object.indices, t * 3 + 2);
    let normal: readonly [number, number, number] | null = null;
    if (object.normals !== undefined) {
      const mean = normalized(
        (component(object.normals, a * 3) +
          component(object.normals, b * 3) +
          component(object.normals, c * 3)) /
          3,
        (component(object.normals, a * 3 + 1) +
          component(object.normals, b * 3 + 1) +
          component(object.normals, c * 3 + 1)) /
          3,
        (component(object.normals, a * 3 + 2) +
          component(object.normals, b * 3 + 2) +
          component(object.normals, c * 3 + 2)) /
          3,
      );
      if (mean !== null) normal = mean;
    }
    if (normal === null) {
      normal = geometricNormal(object.positions, a, b, c);
    }
    result.push(normal);
  }
  return result;
}

/** Minimal union-find over triangle indices; links larger roots to smaller. */
class TriangleUnionFind {
  private readonly parent: number[];

  constructor(size: number) {
    this.parent = Array.from({ length: size }, (_, index) => index);
  }

  find(index: number): number {
    let root = index;
    while (this.parent[root] !== root) {
      const parent = this.parent[root];
      if (parent === undefined) {
        throw new RangeError(
          `Union-find lost root ${String(root)} while searching.`,
        );
      }
      root = parent;
    }
    let cursor = index;
    while (this.parent[cursor] !== root) {
      const next = this.parent[cursor];
      this.parent[cursor] = root;
      if (next === undefined) {
        throw new RangeError(
          `Union-find lost node ${String(cursor)} while compressing.`,
        );
      }
      cursor = next;
    }
    return root;
  }

  union(a: number, b: number): void {
    const rootA = this.find(a);
    const rootB = this.find(b);
    if (rootA === rootB) return;
    if (rootA < rootB) {
      this.parent[rootB] = rootA;
    } else {
      this.parent[rootA] = rootB;
    }
  }
}

/**
 * Groups the render object's triangles into synthetic faces (see the module
 * header for the rule and its determinism argument). Total over
 * contract-valid render objects: degenerate triangles become singleton
 * faces rather than failures.
 */
export function groupSyntheticFaces(
  object: RenderObject,
): SyntheticFaceGrouping {
  const triangleCount = object.indices.length / 3;
  const normals = representativeNormals(object);
  const unionFind = new TriangleUnionFind(triangleCount);

  // Edge adjacency by exact vertex-position keys (crease-duplicated vertices
  // share coordinates — see the module header).
  const edges = new Map<string, number[]>();
  for (let t = 0; t < triangleCount; t += 1) {
    for (let corner = 0; corner < 3; corner += 1) {
      const a = component(object.indices, t * 3 + corner);
      const b = component(object.indices, t * 3 + ((corner + 1) % 3));
      const keyA = positionKey(object.positions, a);
      const keyB = positionKey(object.positions, b);
      const key = keyA < keyB ? `${keyA}|${keyB}` : `${keyB}|${keyA}`;
      const bucket = edges.get(key);
      if (bucket === undefined) {
        edges.set(key, [t]);
      } else {
        bucket.push(t);
      }
    }
  }
  for (const bucket of edges.values()) {
    for (let i = 0; i < bucket.length; i += 1) {
      const triangleA = bucket[i];
      if (triangleA === undefined) continue;
      for (let j = i + 1; j < bucket.length; j += 1) {
        const triangleB = bucket[j];
        if (triangleB === undefined) continue;
        const normalA = normals[triangleA];
        const normalB = normals[triangleB];
        if (
          normalA === null ||
          normalA === undefined ||
          normalB === null ||
          normalB === undefined
        ) {
          continue;
        }
        const dot =
          normalA[0] * normalB[0] + normalA[1] * normalB[1] + normalA[2] * normalB[2];
        if (dot >= COS_GROUPING_THRESHOLD) {
          unionFind.union(triangleA, triangleB);
        }
      }
    }
  }

  // Face ordinals by first-triangle order (stable, documented).
  const triangleFaces: number[] = new Array<number>(triangleCount).fill(0);
  const rootToFace = new Map<number, number>();
  const trianglesByFace: number[][] = [];
  for (let t = 0; t < triangleCount; t += 1) {
    const root = unionFind.find(t);
    const assigned = rootToFace.get(root);
    const face = assigned ?? trianglesByFace.length;
    if (assigned === undefined) {
      rootToFace.set(root, face);
      trianglesByFace.push([]);
    }
    triangleFaces[t] = face;
    const bucket = trianglesByFace[face];
    if (bucket === undefined) {
      throw new RangeError(
        `Synthetic face grouping lost face bucket ${String(face)}.`,
      );
    }
    bucket.push(t);
  }
  return Object.freeze({
    triangleCount,
    faceCount: trianglesByFace.length,
    faces: Object.freeze(
      trianglesByFace.map((triangles, index) =>
        Object.freeze({ index, triangleIndices: Object.freeze([...triangles]) }),
      ),
    ),
    triangleFaces: Object.freeze([...triangleFaces]),
  });
}

/**
 * The synthetic face a triangle belongs to. Throws a `RangeError` for a
 * triangle index outside the grouping — callers pass raycast triangle
 * indices, and an out-of-range one means the caller and the grouping
 * disagree about the same object, which must fail loudly, not map to face 0.
 */
export function syntheticFaceOfTriangle(
  grouping: SyntheticFaceGrouping,
  triangleIndex: number,
): number {
  if (
    !Number.isInteger(triangleIndex) ||
    triangleIndex < 0 ||
    triangleIndex >= grouping.triangleCount
  ) {
    throw new RangeError(
      `Triangle index ${String(triangleIndex)} is outside the grouping's 0..${String(grouping.triangleCount - 1)} range.`,
    );
  }
  const face = grouping.triangleFaces[triangleIndex];
  if (face === undefined) {
    throw new RangeError(
      `Synthetic face grouping has no mapping for triangle ${String(triangleIndex)}.`,
    );
  }
  return face;
}

function triangleArea(
  positions: readonly number[],
  indices: readonly number[],
  triangle: number,
): number {
  const a = component(indices, triangle * 3);
  const b = component(indices, triangle * 3 + 1);
  const c = component(indices, triangle * 3 + 2);
  const ux = component(positions, b * 3) - component(positions, a * 3);
  const uy =
    component(positions, b * 3 + 1) - component(positions, a * 3 + 1);
  const uz =
    component(positions, b * 3 + 2) - component(positions, a * 3 + 2);
  const vx = component(positions, c * 3) - component(positions, a * 3);
  const vy =
    component(positions, c * 3 + 1) - component(positions, a * 3 + 1);
  const vz =
    component(positions, c * 3 + 2) - component(positions, a * 3 + 2);
  const cx = uy * vz - uz * vy;
  const cy = uz * vx - ux * vz;
  const cz = ux * vy - uy * vx;
  return 0.5 * Math.sqrt(cx * cx + cy * cy + cz * cz);
}

/**
 * A world point guaranteed to lie on the face: the centroid of the face's
 * LARGEST triangle (largest area; ties resolve to the lowest triangle
 * index). A triangle's centroid is strictly inside it, and the triangle is
 * part of the face, so a ray through this point hits the face — the property
 * the fixture's face-anchor test hook and any framing code rely on. Throws a
 * `RangeError` for a face index outside the grouping.
 */
export function syntheticFaceAnchor(
  object: RenderObject,
  grouping: SyntheticFaceGrouping,
  faceIndex: number,
): RenderVector3 {
  const face = requireFace(grouping, faceIndex);
  let best: number | undefined;
  let bestArea = -1;
  for (const triangle of face.triangleIndices) {
    const area = triangleArea(object.positions, object.indices, triangle);
    if (area > bestArea) {
      bestArea = area;
      best = triangle;
    }
  }
  if (best === undefined || face.triangleIndices.length === 0) {
    throw new RangeError(
      `Synthetic face ${String(faceIndex)} has no triangles to anchor.`,
    );
  }
  const a = component(object.indices, best * 3);
  const b = component(object.indices, best * 3 + 1);
  const c = component(object.indices, best * 3 + 2);
  return [
    (component(object.positions, a * 3) +
      component(object.positions, b * 3) +
      component(object.positions, c * 3)) /
      3,
    (component(object.positions, a * 3 + 1) +
      component(object.positions, b * 3 + 1) +
      component(object.positions, c * 3 + 1)) /
      3,
    (component(object.positions, a * 3 + 2) +
      component(object.positions, b * 3 + 2) +
      component(object.positions, c * 3 + 2)) /
      3,
  ];
}

/**
 * The face's mean representative normal, normalized — the semantic handle
 * for identifying a PLANAR face ("the face whose normal is +z") without
 * triangle indices. Returns `null` when the face has no meaningful single
 * normal: the representatives cancel exactly when a face's orientations
 * wrap the full turn (a closed curved region such as a cylinder wall —
 * mathematically undefined, not an error), or when every triangle of the
 * face is degenerate. Throws a `RangeError` only for a face index outside
 * the grouping.
 */
export function syntheticFaceMeanNormal(
  object: RenderObject,
  grouping: SyntheticFaceGrouping,
  faceIndex: number,
): RenderVector3 | null {
  const face = requireFace(grouping, faceIndex);
  const representatives = representativeNormals(object);
  let x = 0;
  let y = 0;
  let z = 0;
  for (const triangle of face.triangleIndices) {
    const normal = representatives[triangle];
    if (normal === null || normal === undefined) continue;
    x += normal[0];
    y += normal[1];
    z += normal[2];
  }
  return normalized(x, y, z);
}

/** Face lookup with a loud, documented failure for out-of-range indices. */
function requireFace(
  grouping: SyntheticFaceGrouping,
  faceIndex: number,
): SyntheticFace {
  const face = grouping.faces[faceIndex];
  if (face === undefined || face.index !== faceIndex) {
    throw new RangeError(
      `Face index ${String(faceIndex)} is outside the grouping's 0..${String(grouping.faceCount - 1)} range.`,
    );
  }
  return face;
}
