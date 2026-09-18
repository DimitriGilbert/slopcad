/**
 * The GPU boundary of the R3F renderer (Phase 11.2): maps the renderer-neutral
 * {@link RenderObject} data from `@slopcad/cad-core` into three.js
 * `BufferGeometry`, and owns the id-keyed geometry set across projection
 * updates. This module is the only place quantization happens: per the
 * Phase 11.1 documented decision, the projection carries float64 plain
 * arrays so semantic assertions compare real numbers, and uploading to the
 * GPU converts here — positions and normals to `Float32Array`, indices to
 * `Uint32Array` (the WebGPU-era-safe widening type; index counts above 65k
 * must not silently wrap through Uint16).
 *
 * ## Normals: kernel data is law
 *
 * When the projection carries normals they are used verbatim. Kernel normals
 * are per-face normals with sharp edges split into duplicated vertices, so
 * planar faces shade flat and creases stay crisp. They are never recomputed:
 * `computeVertexNormals` on indexed geometry averages normals across shared
 * vertices, which rounds every crease into the pillow shading the Phase 1.6
 * architecture spike documented. The one fallback — `computeVertexNormals`
 * when the projection has no normals at all — exists only so unlit data can
 * still shade under lit materials, and it inherits that smoothing caveat by
 * construction (an averaged normal is still well-defined and unit; a missing
 * normal attribute renders black under standard materials).
 *
 * ## Update semantics: replace by stable id, write in place when sensible
 *
 * {@link createRenderGeometryController} diffs each {@link RenderProjection}
 * against the previous one by {@link RenderObjectId} — the stable identity
 * the projection contract guarantees — so a regenerated body replaces its
 * previous result without touching other bodies:
 *
 * - vanished ids are disposed and removed;
 * - new ids are built;
 * - same-id objects with a changed shape signature (vertex count, index
 *   count, or normals presence) are rebuilt — new geometry, old one disposed;
 * - same-id objects with an unchanged shape are compared value-for-value and
 *   written into the existing buffers in place, flagging `needsUpdate` so
 *   three re-uploads only the changed attribute — same geometry instance,
 *   same GPU buffer objects, no disposal churn.
 *
 * Value comparison runs against the float64 source quantized with
 * `Math.fround`, which is exactly what the Float32 conversion does, so an
 * unchanged projection re-syncs as a true no-op (same snapshot, zero
 * uploads, zero disposals) regardless of the projection object's identity.
 *
 * The controller is React-free; {@link RenderGeometryController.dispose} is
 * safe to call twice and the controller resurrects on the next `sync`, which
 * is what React StrictMode's mount → cleanup → mount simulation requires.
 */

import * as THREE from "three";
import type {
  RenderObject,
  RenderProjection,
  RenderObjectId,
} from "@slopcad/cad-core";

/**
 * Absolute tolerance (mm) for comparing three-computed geometry bounds
 * (float32) against projection bounds (float64). Float32 quantization error
 * grows with coordinate magnitude (relative epsilon ~1.2e-7), so this covers
 * CAD-part-scale geometry (coordinates up to a few thousand millimetres)
 * with two orders of magnitude of headroom while still catching real
 * drift — a wrong vertex moves bounds by model-scale amounts, not 1e-3 mm.
 */
export const RENDER_GEOMETRY_FLOAT32_TOLERANCE_MM = 1e-3;

/** An id-keyed snapshot of the geometries currently rendered. */
export type RenderGeometrySnapshot = ReadonlyMap<
  RenderObjectId,
  THREE.BufferGeometry
>;

const EMPTY_SNAPSHOT: RenderGeometrySnapshot = new Map();

/**
 * Marks geometries whose `normal` attribute carries kernel normals (verbatim,
 * crease-aware). The fallback path also produces a `normal` attribute —
 * `computeVertexNormals` creates it — so the shape signature must not read
 * attribute presence: what decides rebuild-versus-in-place is whether the
 * KERNEL provided normals, and only that.
 */
const KERNEL_NORMAL_GEOMETRIES = new WeakMap<THREE.BufferGeometry, true>();

/**
 * Builds the three.js geometry for one render object: Float32 positions,
 * Float32 kernel normals when present (verbatim, see the module header),
 * `computeVertexNormals` fallback when not, Uint32 indices, and
 * precomputed bounding box and sphere so culling and bounds assertions are
 * deterministic from the moment of construction. The object must satisfy
 * the projection contract (validated by `projectTessellation` /
 * `parseRenderProjection`): non-empty flat xyz triples, indices in vertex
 * range, normals paired and unit.
 */
export function buildRenderObjectGeometry(
  object: RenderObject,
): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    "position",
    new THREE.BufferAttribute(new Float32Array(object.positions), 3),
  );
  // The index must exist before any normal computation: three's
  // computeVertexNormals takes its indexed (crease-averaging) path only when
  // geometry.index is set, and leaves untouched vertices of a partial
  // non-indexed pass as zero vectors — which normalize to NaN.
  geometry.setIndex(
    new THREE.BufferAttribute(new Uint32Array(object.indices), 1),
  );
  if (object.normals !== undefined) {
    geometry.setAttribute(
      "normal",
      new THREE.BufferAttribute(new Float32Array(object.normals), 3),
    );
    KERNEL_NORMAL_GEOMETRIES.set(geometry, true);
  } else {
    // Fallback rule: only when the kernel provided no normals. Indexed
    // averaging smooths creases (see the module header); that is the accepted
    // cost of shading data the projection does not carry — it is never
    // applied on top of kernel normals.
    geometry.computeVertexNormals();
  }
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}

/** Shape signature deciding rebuild-versus-in-place for a same-id update. */
interface GeometryShape {
  readonly vertexCount: number;
  readonly indexCount: number;
  readonly hasNormals: boolean;
}

function shapeOfObject(object: RenderObject): GeometryShape {
  return {
    vertexCount: object.positions.length / 3,
    indexCount: object.indices.length,
    hasNormals: object.normals !== undefined,
  };
}

function shapeOfGeometry(geometry: THREE.BufferGeometry): GeometryShape {
  return {
    vertexCount: geometry.getAttribute("position").count,
    indexCount: geometry.getIndex()?.count ?? 0,
    hasNormals: KERNEL_NORMAL_GEOMETRIES.has(geometry),
  };
}

function shapesMatch(a: GeometryShape, b: GeometryShape): boolean {
  return (
    a.vertexCount === b.vertexCount &&
    a.indexCount === b.indexCount &&
    a.hasNormals === b.hasNormals
  );
}

/**
 * Whether every attribute element already equals its float64 source after
 * float32 quantization. Compares flat components through the attribute's
 * underlying typed array — `getX`/`setX` are per-VERTEX accessors scaled by
 * itemSize, not per-component ones. Iterates the source (never indexes it):
 * the shape match upstream guarantees source length equals the array length.
 */
function attributeMatchesSource(
  attribute: THREE.BufferAttribute | THREE.InterleavedBufferAttribute,
  source: readonly number[],
  quantize: (value: number) => number,
): boolean {
  const array = attribute.array;
  let component = 0;
  for (const value of source) {
    if (array[component] !== quantize(value)) {
      return false;
    }
    component += 1;
  }
  return true;
}

/** Writes the source values through and flags the attribute for re-upload. */
function overwriteAttribute(
  attribute: THREE.BufferAttribute | THREE.InterleavedBufferAttribute,
  source: readonly number[],
): void {
  const array = attribute.array;
  let component = 0;
  for (const value of source) {
    array[component] = value;
    component += 1;
  }
  attribute.needsUpdate = true;
}

function quantizeFloat32(value: number): number {
  return Math.fround(value);
}

function identity(value: number): number {
  return value;
}

/**
 * Writes a same-shape render object into an existing geometry in place.
 * Returns whether anything changed; unchanged data leaves the geometry
 * completely untouched (no `needsUpdate`, no bounds recompute, no upload).
 */
function writeObjectIntoGeometry(
  object: RenderObject,
  geometry: THREE.BufferGeometry,
): boolean {
  let changed = false;
  const position = geometry.getAttribute("position");
  if (!attributeMatchesSource(position, object.positions, quantizeFloat32)) {
    overwriteAttribute(position, object.positions);
    changed = true;
  }
  if (object.normals !== undefined) {
    const normal = geometry.getAttribute("normal");
    if (!attributeMatchesSource(normal, object.normals, quantizeFloat32)) {
      overwriteAttribute(normal, object.normals);
      changed = true;
    }
  }
  const index = geometry.getIndex();
  if (index === null) {
    // Unreachable: shapeOfGeometry counted the index (shapesMatch passed),
    // so the geometry was built with one. Fail loudly rather than skip.
    throw new TypeError(
      "Render geometry has no index attribute after a matching shape check.",
    );
  }
  if (!attributeMatchesSource(index, object.indices, identity)) {
    overwriteAttribute(index, object.indices);
    changed = true;
  }
  if (changed) {
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
  }
  return changed;
}

/**
 * A stateful, React-free owner of the rendered geometry set. One instance
 * per mounted renderer; `sync` applies a projection (see the module header
 * for the diff semantics) and returns the current snapshot — the same
 * instance when nothing changed, so callers can use snapshot identity to
 * detect real updates. `dispose` disposes every geometry and clears the
 * set; it is idempotent, and a later `sync` rebuilds from empty (the React
 * StrictMode simulated-remount contract).
 */
export interface RenderGeometryController {
  readonly geometries: RenderGeometrySnapshot;
  sync(projection: RenderProjection): RenderGeometrySnapshot;
  dispose(): void;
}

export function createRenderGeometryController(): RenderGeometryController {
  const byId = new Map<RenderObjectId, THREE.BufferGeometry>();
  let snapshot: RenderGeometrySnapshot = EMPTY_SNAPSHOT;
  return {
    get geometries(): RenderGeometrySnapshot {
      return snapshot;
    },
    sync(projection: RenderProjection): RenderGeometrySnapshot {
      let changed = false;
      const nextIds = new Set<RenderObjectId>();
      for (const object of projection.objects) {
        nextIds.add(object.id);
        const existing = byId.get(object.id);
        if (existing === undefined) {
          byId.set(object.id, buildRenderObjectGeometry(object));
          changed = true;
          continue;
        }
        if (!shapesMatch(shapeOfObject(object), shapeOfGeometry(existing))) {
          existing.dispose();
          byId.set(object.id, buildRenderObjectGeometry(object));
          changed = true;
          continue;
        }
        if (writeObjectIntoGeometry(object, existing)) {
          changed = true;
        }
      }
      for (const [id, geometry] of byId) {
        if (!nextIds.has(id)) {
          geometry.dispose();
          byId.delete(id);
          changed = true;
        }
      }
      if (changed) {
        snapshot = new Map(byId);
      }
      return snapshot;
    },
    dispose(): void {
      for (const geometry of byId.values()) {
        geometry.dispose();
      }
      byId.clear();
      snapshot = EMPTY_SNAPSHOT;
    },
  };
}
