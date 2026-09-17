/**
 * The deterministic fake kernel (Phase 8): a fast, dependency-free
 * reference implementation of the kernel contract. It exists so the
 * contract, the contract suite, and the cad-core executor bridge can be
 * exercised in tests without a real geometry engine, and it defines the
 * baseline semantics every real kernel (Manifold in Phase 9, OpenCascade
 * later) must reproduce.
 *
 * ## Representation
 *
 * Solids are symbolic CSG trees of the four primitives plus boolean nodes
 * and translation nodes — every operation is a pure tree construction, so
 * the kernel is trivially deterministic: no meshes are built until
 * `tessellate` asks for one, and every measurement is a pure function of
 * the tree.
 *
 * ## Measurement semantics
 *
 * - Primitive volumes are analytic (exact): `w·d·h`, `4/3·π·r³`, `π·r²·h`,
 *   and the frustum formula `π·h·(rb²+rb·rt+rt²)/3` (which degenerates to
 *   the sharp-cone formula at `rt = 0`).
 * - Primitive bounds are exact axis-aligned boxes per the contract's
 *   placement conventions.
 * - Boolean volumes are measured by deterministic voxel quadrature: a fixed
 *   {@link FAKE_KERNEL_VOLUME_RESOLUTION}³ grid of cell-centre sample points
 *   over the node's conservative bounds, each classified by exact
 *   point-in-primitive tests, volume = inside-count × cell volume. This is
 *   exact when boolean boundaries align with the sample box (axis-aligned
 *   box booleans) and carries small documented error on curved boundaries —
 *   hence `exactBooleanVolumes: false` in the capabilities.
 * - Boolean bounds: exact (tight) for unions — the hull of operand boxes is
 *   always the tight union box; conservative (containing) for subtract (the
 *   target's box) and intersect (the operand boxes' intersection) — hence
 *   `tightBooleanBounds: false`. Translation shifts bounds exactly.
 * - An empty solid (sampled inside-count 0) has volume 0, an empty
 *   tessellation, and `bounds` fails with `kernel/bounds-empty`. Emptiness
 *   by sampling is one-sided: a non-empty sample proves the solid exists,
 *   while a solid smaller than one sample cell of its own bounds may
 *   quantify as empty.
 *
 * ## Tessellation semantics
 *
 * Primitives produce fixed canonical meshes (a 12-triangle box; a UV sphere
 * of {@link FAKE_KERNEL_TESSELLATION_SEGMENTS} segments ×
 * {@link FAKE_KERNEL_TESSELLATION_RINGS} rings; segment-based cylinder and
 * cone fans) — triangle counts are closed-form functions of those constants.
 * Every canonical triangle is wound counter-clockwise seen from outside the
 * solid, so the per-facet normal (the normalized cross product of a
 * triangle's edges) always points away from the material: honest kernel
 * normals require consistent winding, and the fake kernel's normals are
 * exactly those per-facet normals, one per triangle corner — flat shading,
 * truthful for the faceted meshes it serves. Booleans emit the depth-first
 * concatenation of their primitive leaves' triangles, keeping exactly the
 * triangles fully inside the node's conservative bounds: a deterministic
 * candidate soup that is contract-valid (indexed, finite, inside bounds)
 * but not the exact boolean surface — semantic truth for booleans lives in
 * `volume`/`bounds`, never in the soup. Translations shift triangles (and
 * their unchanged normals) exactly.
 *
 * Volume is memoized per handle (WeakMap), so repeated `volume` calls are
 * cheap; `tessellate` recomputes from the tree on every call, which
 * determinism guarantees to agree.
 */

import { type LengthValue, fail, ok, valueIn } from "@slopcad/cad-core";
import type { KernelCapabilities } from "./capabilities";

import { type KernelBackendId } from "./backend-ids";
import {
  type BoxInput,
  type ConeInput,
  type CylinderInput,
  type GeometryKernel,
  type KernelBounds,
  type KernelError,
  type KernelErrorCode,
  type KernelResult,
  KERNEL_ERROR_CODES,
  type KernelSolid,
  type SphereInput,
  type Tessellation,
  type TransformInput,
} from "./contract";
import { createSolidTag } from "./opaque";

/** Voxel-quadrature resolution (samples per axis) for boolean volumes. */
export const FAKE_KERNEL_VOLUME_RESOLUTION = 64;

/** Longitude segments of the fake kernel's canonical curved meshes. */
export const FAKE_KERNEL_TESSELLATION_SEGMENTS = 16;

/** Latitude rings of the fake kernel's canonical sphere mesh. */
export const FAKE_KERNEL_TESSELLATION_RINGS = 8;

/**
 * Capabilities of the fake kernel: full contract support with
 * translation-only transforms (a rotation input is rejected outright, not
 * silently dropped — the axis-aligned shape model cannot honour it);
 * primitive volumes analytic; boolean volumes voxel-quantized; boolean
 * bounds conservative outside unions; no persistent topology (that arrives
 * with the OpenCascade backend).
 */
export const FAKE_KERNEL_CAPABILITIES: KernelCapabilities = Object.freeze({
  booleans: true,
  transformTranslation: true,
  transformRotation: false,
  transformScale: false,
  exactPrimitiveVolumes: true,
  exactBooleanVolumes: false,
  tightBooleanBounds: false,
  persistentTopology: false,
});

/** The fake kernel's backend id. */
export const FAKE_KERNEL_ID: KernelBackendId = "fake";

/** The triangle count of the fake kernel's canonical box mesh. */
export const FAKE_BOX_TRIANGLE_COUNT = 12;

type Axis = 0 | 1 | 2;
type Vec3 = readonly [number, number, number];

/** Reads a canonical vector component; internal vectors are always triples. */
function at(vector: Vec3, axis: Axis): number {
  const value = vector[axis];
  if (value === undefined) {
    throw new Error(
      "Invariant violation: a canonical vector always has three components.",
    );
  }
  return value;
}

/** Reads a bounds corner component; internal bounds are always triples. */
function boundsAt(
  bounds: KernelBounds,
  corner: "min" | "max",
  axis: Axis,
): number {
  const value = bounds[corner][axis];
  if (value === undefined) {
    throw new Error(
      "Invariant violation: kernel bounds always have three components.",
    );
  }
  return value;
}

/** The four primitive tree nodes. */
type Primitive =
  | { readonly kind: "box"; readonly size: Vec3 }
  | { readonly kind: "sphere"; readonly radius: number }
  | {
      readonly kind: "cylinder";
      readonly radius: number;
      readonly height: number;
    }
  | {
      readonly kind: "cone";
      readonly bottomRadius: number;
      readonly topRadius: number;
      readonly height: number;
    };

/** The symbolic CSG tree a fake-kernel handle wraps. */
type FakeShape =
  | Primitive
  | { readonly kind: "union"; readonly operands: readonly FakeShape[] }
  | {
      readonly kind: "subtract";
      readonly target: FakeShape;
      readonly tools: readonly FakeShape[];
    }
  | { readonly kind: "intersect"; readonly operands: readonly FakeShape[] }
  | {
      readonly kind: "translate";
      readonly source: FakeShape;
      readonly offset: Vec3;
    };

/** A triangle of three canonical-space corners. */
type Triangle = readonly [Vec3, Vec3, Vec3];

function boundsOf(min: Vec3, max: Vec3): KernelBounds {
  return { min, max };
}

function shifted(vector: Vec3, offset: Vec3): Vec3 {
  return [
    at(vector, 0) + at(offset, 0),
    at(vector, 1) + at(offset, 1),
    at(vector, 2) + at(offset, 2),
  ];
}

function hullBounds(a: KernelBounds, b: KernelBounds): KernelBounds {
  return boundsOf(
    [
      Math.min(boundsAt(a, "min", 0), boundsAt(b, "min", 0)),
      Math.min(boundsAt(a, "min", 1), boundsAt(b, "min", 1)),
      Math.min(boundsAt(a, "min", 2), boundsAt(b, "min", 2)),
    ],
    [
      Math.max(boundsAt(a, "max", 0), boundsAt(b, "max", 0)),
      Math.max(boundsAt(a, "max", 1), boundsAt(b, "max", 1)),
      Math.max(boundsAt(a, "max", 2), boundsAt(b, "max", 2)),
    ],
  );
}

function intersectBounds(a: KernelBounds, b: KernelBounds): KernelBounds {
  return boundsOf(
    [
      Math.max(boundsAt(a, "min", 0), boundsAt(b, "min", 0)),
      Math.max(boundsAt(a, "min", 1), boundsAt(b, "min", 1)),
      Math.max(boundsAt(a, "min", 2), boundsAt(b, "min", 2)),
    ],
    [
      Math.min(boundsAt(a, "max", 0), boundsAt(b, "max", 0)),
      Math.min(boundsAt(a, "max", 1), boundsAt(b, "max", 1)),
      Math.min(boundsAt(a, "max", 2), boundsAt(b, "max", 2)),
    ],
  );
}

function shapeBounds(shape: FakeShape): KernelBounds {
  switch (shape.kind) {
    case "box":
      return boundsOf([0, 0, 0], shape.size);
    case "sphere":
      return boundsOf(
        [-shape.radius, -shape.radius, -shape.radius],
        [shape.radius, shape.radius, shape.radius],
      );
    case "cylinder":
      return boundsOf(
        [-shape.radius, -shape.radius, 0],
        [shape.radius, shape.radius, shape.height],
      );
    case "cone": {
      const reach = Math.max(shape.bottomRadius, shape.topRadius);
      return boundsOf([-reach, -reach, 0], [reach, reach, shape.height]);
    }
    case "union":
      return shape.operands.map(shapeBounds).reduce(hullBounds);
    case "subtract":
      return shapeBounds(shape.target);
    case "intersect":
      return shape.operands.map(shapeBounds).reduce(intersectBounds);
    case "translate": {
      const source = shapeBounds(shape.source);
      return boundsOf(
        [
          boundsAt(source, "min", 0) + at(shape.offset, 0),
          boundsAt(source, "min", 1) + at(shape.offset, 1),
          boundsAt(source, "min", 2) + at(shape.offset, 2),
        ],
        [
          boundsAt(source, "max", 0) + at(shape.offset, 0),
          boundsAt(source, "max", 1) + at(shape.offset, 1),
          boundsAt(source, "max", 2) + at(shape.offset, 2),
        ],
      );
    }
  }
}

/** Exact point-in-shape classification (inclusive primitive boundaries). */
function contains(shape: FakeShape, x: number, y: number, z: number): boolean {
  switch (shape.kind) {
    case "box":
      return (
        x >= 0 &&
        x <= at(shape.size, 0) &&
        y >= 0 &&
        y <= at(shape.size, 1) &&
        z >= 0 &&
        z <= at(shape.size, 2)
      );
    case "sphere":
      return x * x + y * y + z * z <= shape.radius * shape.radius;
    case "cylinder":
      return (
        x * x + y * y <= shape.radius * shape.radius &&
        z >= 0 &&
        z <= shape.height
      );
    case "cone": {
      if (z < 0 || z > shape.height) return false;
      const t = shape.height === 0 ? 0 : z / shape.height;
      const radius =
        shape.bottomRadius + (shape.topRadius - shape.bottomRadius) * t;
      return x * x + y * y <= radius * radius;
    }
    case "union":
      return shape.operands.some((operand) => contains(operand, x, y, z));
    case "subtract":
      return (
        contains(shape.target, x, y, z) &&
        !shape.tools.some((tool) => contains(tool, x, y, z))
      );
    case "intersect":
      return shape.operands.every((operand) => contains(operand, x, y, z));
    case "translate":
      return contains(
        shape.source,
        x - at(shape.offset, 0),
        y - at(shape.offset, 1),
        z - at(shape.offset, 2),
      );
  }
}

/** Analytic volume of a primitive or translated primitive chain, else `undefined`. */
function analyticVolume(shape: FakeShape): number | undefined {
  switch (shape.kind) {
    case "box":
      return at(shape.size, 0) * at(shape.size, 1) * at(shape.size, 2);
    case "sphere":
      return (4 / 3) * Math.PI * shape.radius ** 3;
    case "cylinder":
      return Math.PI * shape.radius ** 2 * shape.height;
    case "cone":
      return (
        (Math.PI *
          shape.height *
          (shape.bottomRadius ** 2 +
            shape.bottomRadius * shape.topRadius +
            shape.topRadius ** 2)) /
        3
      );
    case "translate":
      return analyticVolume(shape.source);
    default:
      return undefined;
  }
}

/** Deterministic voxel quadrature over the shape's conservative bounds. */
function voxelVolume(shape: FakeShape): number {
  const bounds = shapeBounds(shape);
  const minX = boundsAt(bounds, "min", 0);
  const minY = boundsAt(bounds, "min", 1);
  const minZ = boundsAt(bounds, "min", 2);
  const extentX = boundsAt(bounds, "max", 0) - minX;
  const extentY = boundsAt(bounds, "max", 1) - minY;
  const extentZ = boundsAt(bounds, "max", 2) - minZ;
  if (extentX <= 0 || extentY <= 0 || extentZ <= 0) return 0;
  const n = FAKE_KERNEL_VOLUME_RESOLUTION;
  const cellX = extentX / n;
  const cellY = extentY / n;
  const cellZ = extentZ / n;
  let inside = 0;
  for (let i = 0; i < n; i += 1) {
    const x = minX + (i + 0.5) * cellX;
    for (let j = 0; j < n; j += 1) {
      const y = minY + (j + 0.5) * cellY;
      for (let k = 0; k < n; k += 1) {
        const z = minZ + (k + 0.5) * cellZ;
        if (contains(shape, x, y, z)) inside += 1;
      }
    }
  }
  return inside * cellX * cellY * cellZ;
}

function shapeVolume(shape: FakeShape): number {
  return analyticVolume(shape) ?? voxelVolume(shape);
}

function quad(p1: Vec3, p2: Vec3, p3: Vec3, p4: Vec3): readonly Triangle[] {
  return [
    [p1, p2, p3],
    [p1, p3, p4],
  ];
}

function boxTriangles(w: number, d: number, h: number): readonly Triangle[] {
  return [
    ...quad([0, d, 0], [w, d, 0], [w, 0, 0], [0, 0, 0]),
    ...quad([0, 0, h], [w, 0, h], [w, d, h], [0, d, h]),
    ...quad([0, 0, 0], [w, 0, 0], [w, 0, h], [0, 0, h]),
    ...quad([w, d, 0], [0, d, 0], [0, d, h], [w, d, h]),
    ...quad([0, d, 0], [0, 0, 0], [0, 0, h], [0, d, h]),
    ...quad([w, 0, 0], [w, d, 0], [w, d, h], [w, 0, h]),
  ];
}

function sphereTriangles(radius: number): readonly Triangle[] {
  const segments = FAKE_KERNEL_TESSELLATION_SEGMENTS;
  const rings = FAKE_KERNEL_TESSELLATION_RINGS;
  const at = (ring: number, seg: number): Vec3 => {
    const phi = (Math.PI * ring) / rings;
    const theta = (2 * Math.PI * seg) / segments;
    return [
      radius * Math.sin(phi) * Math.cos(theta),
      radius * Math.sin(phi) * Math.sin(theta),
      radius * Math.cos(phi),
    ];
  };
  const top = at(0, 0);
  const bottom = at(rings, 0);
  const triangles: Triangle[] = [];
  for (let seg = 0; seg < segments; seg += 1) {
    // Cap fans are wound CCW seen from outside: increasing longitude at the
    // north pole, decreasing at the south (mirrored), so facet normals point
    // away from the sphere's centre.
    triangles.push([top, at(1, seg), at(1, seg + 1)]);
    triangles.push([bottom, at(rings - 1, seg + 1), at(rings - 1, seg)]);
    for (let ring = 1; ring < rings - 1; ring += 1) {
      triangles.push([at(ring, seg), at(ring + 1, seg), at(ring + 1, seg + 1)]);
      triangles.push([at(ring, seg), at(ring + 1, seg + 1), at(ring, seg + 1)]);
    }
  }
  return triangles;
}

function cylinderTriangles(
  radius: number,
  height: number,
): readonly Triangle[] {
  const segments = FAKE_KERNEL_TESSELLATION_SEGMENTS;
  const ringAt = (z: number, seg: number): Vec3 => {
    const theta = (2 * Math.PI * seg) / segments;
    return [radius * Math.cos(theta), radius * Math.sin(theta), z];
  };
  const triangles: Triangle[] = [];
  for (let seg = 0; seg < segments; seg += 1) {
    const bottom0 = ringAt(0, seg);
    const bottom1 = ringAt(0, seg + 1);
    const top0 = ringAt(height, seg);
    const top1 = ringAt(height, seg + 1);
    triangles.push([bottom0, bottom1, top1], [bottom0, top1, top0]);
    triangles.push([[0, 0, 0], bottom1, bottom0]);
    triangles.push([[0, 0, height], top0, top1]);
  }
  return triangles;
}

function coneTriangles(
  bottomRadius: number,
  topRadius: number,
  height: number,
): readonly Triangle[] {
  const segments = FAKE_KERNEL_TESSELLATION_SEGMENTS;
  const bottomAt = (seg: number): Vec3 => {
    const theta = (2 * Math.PI * seg) / segments;
    return [bottomRadius * Math.cos(theta), bottomRadius * Math.sin(theta), 0];
  };
  const triangles: Triangle[] = [];
  if (topRadius === 0) {
    const apex: Vec3 = [0, 0, height];
    for (let seg = 0; seg < segments; seg += 1) {
      // The apex fan follows the frustum side winding (increasing longitude)
      // so its facets face outward, away from the cone's axis.
      triangles.push([apex, bottomAt(seg), bottomAt(seg + 1)]);
      triangles.push([[0, 0, 0], bottomAt(seg + 1), bottomAt(seg)]);
    }
    return triangles;
  }
  const topAt = (seg: number): Vec3 => {
    const theta = (2 * Math.PI * seg) / segments;
    return [topRadius * Math.cos(theta), topRadius * Math.sin(theta), height];
  };
  for (let seg = 0; seg < segments; seg += 1) {
    triangles.push([bottomAt(seg), bottomAt(seg + 1), topAt(seg + 1)]);
    triangles.push([bottomAt(seg), topAt(seg + 1), topAt(seg)]);
    triangles.push([[0, 0, 0], bottomAt(seg + 1), bottomAt(seg)]);
    triangles.push([[0, 0, height], topAt(seg), topAt(seg + 1)]);
  }
  return triangles;
}

function primitiveTriangles(shape: Primitive): readonly Triangle[] {
  switch (shape.kind) {
    case "box":
      return boxTriangles(
        at(shape.size, 0),
        at(shape.size, 1),
        at(shape.size, 2),
      );
    case "sphere":
      return sphereTriangles(shape.radius);
    case "cylinder":
      return cylinderTriangles(shape.radius, shape.height);
    case "cone":
      return coneTriangles(shape.bottomRadius, shape.topRadius, shape.height);
  }
}

/** A primitive leaf paired with the accumulated translation along its path. */
interface Leaf {
  readonly primitive: Primitive;
  readonly offset: Vec3;
}

function collectLeaves(shape: FakeShape, offset: Vec3, out: Leaf[]): void {
  switch (shape.kind) {
    case "box":
    case "sphere":
    case "cylinder":
    case "cone":
      out.push({ primitive: shape, offset });
      return;
    case "union":
      for (const operand of shape.operands) collectLeaves(operand, offset, out);
      return;
    case "subtract":
      collectLeaves(shape.target, offset, out);
      for (const tool of shape.tools) collectLeaves(tool, offset, out);
      return;
    case "intersect":
      for (const operand of shape.operands) collectLeaves(operand, offset, out);
      return;
    case "translate":
      collectLeaves(shape.source, shifted(offset, shape.offset), out);
      return;
  }
}

const KEEP_EPSILON_MM = 1e-9;

function pointWithinBox(point: Vec3, bounds: KernelBounds): boolean {
  for (const axis of [0, 1, 2] as const) {
    const value = at(point, axis);
    if (
      value < boundsAt(bounds, "min", axis) - KEEP_EPSILON_MM ||
      value > boundsAt(bounds, "max", axis) + KEEP_EPSILON_MM
    ) {
      return false;
    }
  }
  return true;
}

function cornerOf(triangle: Triangle, corner: 0 | 1 | 2): Vec3 {
  const value = triangle[corner];
  if (value === undefined) {
    throw new Error(
      "Invariant violation: a canonical triangle always has three corners.",
    );
  }
  return value;
}

function shiftedTriangle(triangle: Triangle, offset: Vec3): Triangle {
  return [
    shifted(cornerOf(triangle, 0), offset),
    shifted(cornerOf(triangle, 1), offset),
    shifted(cornerOf(triangle, 2), offset),
  ];
}

/**
 * The final triangle list of a shape's tessellation: canonical primitive
 * meshes, exactly shifted by translations, and for booleans the filtered
 * leaf concatenation (empty when the boolean quantifies as empty).
 */
function renderTriangles(shape: FakeShape): readonly Triangle[] {
  switch (shape.kind) {
    case "box":
    case "sphere":
    case "cylinder":
    case "cone":
      return primitiveTriangles(shape);
    case "translate":
      return renderTriangles(shape.source).map((triangle) =>
        shiftedTriangle(triangle, shape.offset),
      );
    default:
      break;
  }
  if (voxelVolume(shape) === 0) return [];
  const bounds = shapeBounds(shape);
  const leaves: Leaf[] = [];
  collectLeaves(shape, [0, 0, 0], leaves);
  const kept: Triangle[] = [];
  for (const leaf of leaves) {
    for (const triangle of primitiveTriangles(leaf.primitive)) {
      const candidate = shiftedTriangle(triangle, leaf.offset);
      if (candidate.every((corner) => pointWithinBox(corner, bounds))) {
        kept.push(candidate);
      }
    }
  }
  return kept;
}

/**
 * The outward unit normal of a canonical triangle: the normalized cross
 * product of two edge vectors, following the triangle's (consistently
 * outward, CCW-seen-from-outside) winding. Canonical meshes never contain
 * degenerate triangles, so the cross product is always non-zero.
 */
function triangleNormal(triangle: Triangle): Vec3 {
  const p1 = cornerOf(triangle, 0);
  const p2 = cornerOf(triangle, 1);
  const p3 = cornerOf(triangle, 2);
  const e1: Vec3 = [
    at(p2, 0) - at(p1, 0),
    at(p2, 1) - at(p1, 1),
    at(p2, 2) - at(p1, 2),
  ];
  const e2: Vec3 = [
    at(p3, 0) - at(p1, 0),
    at(p3, 1) - at(p1, 1),
    at(p3, 2) - at(p1, 2),
  ];
  const cx = at(e1, 1) * at(e2, 2) - at(e1, 2) * at(e2, 1);
  const cy = at(e1, 2) * at(e2, 0) - at(e1, 0) * at(e2, 2);
  const cz = at(e1, 0) * at(e2, 1) - at(e1, 1) * at(e2, 0);
  const length = Math.hypot(cx, cy, cz);
  if (!(length > 0)) {
    throw new Error(
      "Invariant violation: canonical triangles are never degenerate.",
    );
  }
  return [cx / length, cy / length, cz / length];
}

function shapeTessellation(shape: FakeShape): Tessellation {
  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];
  for (const triangle of renderTriangles(shape)) {
    const normal = triangleNormal(triangle);
    const base = positions.length / 3;
    for (const corner of triangle) {
      positions.push(at(corner, 0), at(corner, 1), at(corner, 2));
      normals.push(at(normal, 0), at(normal, 1), at(normal, 2));
    }
    indices.push(base, base + 1, base + 2);
  }
  return normals.length > 0
    ? { positions, indices, normals }
    : { positions, indices };
}

function kernelError(code: KernelErrorCode, message: string): KernelError {
  return { code, message, input: null };
}

/**
 * Creates a fresh fake kernel instance. Handles are owned per instance;
 * create one per evaluation context (the executor bridge does).
 */
export function createFakeKernel(): GeometryKernel {
  const tag = createSolidTag<FakeShape>();
  const volumeCache = new WeakMap<KernelSolid, number>();

  const shapeOf = (
    solid: KernelSolid,
    operation: string,
  ): KernelResult<FakeShape> => {
    const shape = tag.unwrap(solid);
    if (shape === undefined) {
      return fail(
        kernelError(
          KERNEL_ERROR_CODES.solidNotOwned,
          `${operation} rejected a solid handle that this kernel instance did not create.`,
        ),
      );
    }
    return ok(shape);
  };

  const volumeOf = (solid: KernelSolid): KernelResult<number> => {
    const shape = tag.unwrap(solid);
    if (shape === undefined) {
      return fail(
        kernelError(
          KERNEL_ERROR_CODES.solidNotOwned,
          "volume rejected a solid handle that this kernel instance did not create.",
        ),
      );
    }
    const cached = volumeCache.get(solid);
    if (cached !== undefined) return ok(cached);
    const measured = shapeVolume(shape);
    volumeCache.set(solid, measured);
    return ok(measured);
  };

  const positiveLength = (
    value: LengthValue,
    name: string,
    operation: string,
  ): KernelResult<number> => {
    const mm = valueIn(value, "mm");
    if (!(mm > 0)) {
      return fail(
        kernelError(
          KERNEL_ERROR_CODES.invalidLength,
          `${operation} rejected ${name} ${mm} mm: it must be strictly positive.`,
        ),
      );
    }
    return ok(mm);
  };

  const nonNegativeLength = (
    value: LengthValue,
    name: string,
    operation: string,
  ): KernelResult<number> => {
    const mm = valueIn(value, "mm");
    if (!(mm >= 0)) {
      return fail(
        kernelError(
          KERNEL_ERROR_CODES.invalidLength,
          `${operation} rejected ${name} ${mm} mm: it must not be negative.`,
        ),
      );
    }
    return ok(mm);
  };

  const operandsOf = (
    solids: readonly KernelSolid[],
    minimum: number,
    operation: string,
  ): KernelResult<readonly FakeShape[]> => {
    if (solids.length < minimum) {
      return fail(
        kernelError(
          KERNEL_ERROR_CODES.invalidOperands,
          `${operation} rejected ${solids.length} operand(s): at least ${minimum} are required.`,
        ),
      );
    }
    const shapes: FakeShape[] = [];
    for (const solid of solids) {
      const shape = shapeOf(solid, operation);
      if (!shape.ok) return fail(shape.error);
      shapes.push(shape.value);
    }
    return ok(shapes);
  };

  return {
    id: FAKE_KERNEL_ID,
    capabilities: FAKE_KERNEL_CAPABILITIES,

    createBox(input: BoxInput): KernelResult<KernelSolid> {
      const width = positiveLength(input.width, "width", "createBox");
      if (!width.ok) return fail(width.error);
      const depth = positiveLength(input.depth, "depth", "createBox");
      if (!depth.ok) return fail(depth.error);
      const height = positiveLength(input.height, "height", "createBox");
      if (!height.ok) return fail(height.error);
      return ok(
        tag.wrap({
          kind: "box",
          size: [width.value, depth.value, height.value],
        }),
      );
    },

    createSphere(input: SphereInput): KernelResult<KernelSolid> {
      const radius = positiveLength(input.radius, "radius", "createSphere");
      if (!radius.ok) return fail(radius.error);
      return ok(tag.wrap({ kind: "sphere", radius: radius.value }));
    },

    createCylinder(input: CylinderInput): KernelResult<KernelSolid> {
      const radius = positiveLength(input.radius, "radius", "createCylinder");
      if (!radius.ok) return fail(radius.error);
      const height = positiveLength(input.height, "height", "createCylinder");
      if (!height.ok) return fail(height.error);
      return ok(
        tag.wrap({
          kind: "cylinder",
          radius: radius.value,
          height: height.value,
        }),
      );
    },

    createCone(input: ConeInput): KernelResult<KernelSolid> {
      const bottomRadius = positiveLength(
        input.bottomRadius,
        "bottomRadius",
        "createCone",
      );
      if (!bottomRadius.ok) return fail(bottomRadius.error);
      const topRadius = nonNegativeLength(
        input.topRadius,
        "topRadius",
        "createCone",
      );
      if (!topRadius.ok) return fail(topRadius.error);
      const height = positiveLength(input.height, "height", "createCone");
      if (!height.ok) return fail(height.error);
      return ok(
        tag.wrap({
          kind: "cone",
          bottomRadius: bottomRadius.value,
          topRadius: topRadius.value,
          height: height.value,
        }),
      );
    },

    union(operands: readonly KernelSolid[]): KernelResult<KernelSolid> {
      const shapes = operandsOf(operands, 2, "union");
      if (!shapes.ok) return fail(shapes.error);
      return ok(tag.wrap({ kind: "union", operands: shapes.value }));
    },

    subtract(
      target: KernelSolid,
      tools: readonly KernelSolid[],
    ): KernelResult<KernelSolid> {
      const targetShape = shapeOf(target, "subtract");
      if (!targetShape.ok) return fail(targetShape.error);
      const toolShapes = operandsOf(tools, 1, "subtract");
      if (!toolShapes.ok) return fail(toolShapes.error);
      return ok(
        tag.wrap({
          kind: "subtract",
          target: targetShape.value,
          tools: toolShapes.value,
        }),
      );
    },

    intersect(operands: readonly KernelSolid[]): KernelResult<KernelSolid> {
      const shapes = operandsOf(operands, 2, "intersect");
      if (!shapes.ok) return fail(shapes.error);
      return ok(tag.wrap({ kind: "intersect", operands: shapes.value }));
    },

    transform(
      solid: KernelSolid,
      input: TransformInput,
    ): KernelResult<KernelSolid> {
      const shape = shapeOf(solid, "transform");
      if (!shape.ok) return fail(shape.error);
      if (input.rotation !== undefined) {
        return fail(
          kernelError(
            KERNEL_ERROR_CODES.invalidRotation,
            "transform rejected a rotation: the fake kernel's axis-aligned shape model cannot honour rotations (transformRotation is false).",
          ),
        );
      }
      const offset: Vec3 = [
        valueIn(input.x, "mm"),
        valueIn(input.y, "mm"),
        valueIn(input.z, "mm"),
      ];
      return ok(tag.wrap({ kind: "translate", source: shape.value, offset }));
    },

    bounds(solid: KernelSolid): KernelResult<KernelBounds> {
      const shape = shapeOf(solid, "bounds");
      if (!shape.ok) return fail(shape.error);
      const volume = volumeOf(solid);
      if (!volume.ok) return fail(volume.error);
      if (volume.value === 0) {
        return fail(
          kernelError(
            KERNEL_ERROR_CODES.boundsEmpty,
            "bounds rejected an empty solid: an empty set has no bounding box.",
          ),
        );
      }
      return ok(shapeBounds(shape.value));
    },

    volume(solid: KernelSolid): KernelResult<number> {
      return volumeOf(solid);
    },

    tessellate(solid: KernelSolid): KernelResult<Tessellation> {
      const shape = shapeOf(solid, "tessellate");
      if (!shape.ok) return fail(shape.error);
      const volume = volumeOf(solid);
      if (!volume.ok) return fail(volume.error);
      if (volume.value === 0) return ok({ positions: [], indices: [] });
      return ok(shapeTessellation(shape.value));
    },

    dispose(solid: KernelSolid): void {
      volumeCache.delete(solid);
    },
  };
}
