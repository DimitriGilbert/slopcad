/**
 * Geometry-mapping and update-diff tests (Phase 11.2): the GPU-boundary
 * half of the renderer evidence. Buffer conversion is asserted against the
 * float64 projection source with `Math.fround` — the exact quantization
 * Float32Array applies — so "within float32 epsilon" is an exact equality
 * here, and bounds are asserted through three's own `computeBoundingBox`
 * against the projection bounds within the documented float32 tolerance.
 */

import * as THREE from "three";
import { describe, expect, it } from "vitest";
import type { RenderObjectId } from "@slopcad/cad-core";

import {
  buildRenderObjectGeometry,
  createRenderGeometryController,
  RENDER_GEOMETRY_FLOAT32_TOLERANCE_MM,
} from "./geometry";
import {
  FOLDED_SHEET_SHARED,
  FOLDED_SHEET_WITH_NORMALS,
  FRACTIONAL_TRIANGLE,
  makeObject,
  makeProjection,
} from "./render-fixtures";

/** Attaches a dispose counter to a geometry and returns its reader. */
function trackDisposals(geometry: THREE.BufferGeometry): () => number {
  let count = 0;
  geometry.addEventListener("dispose", () => {
    count += 1;
  });
  return () => count;
}

/** The single render object id of a one-object fixture projection. */
function onlyIdOf(projection: { readonly objects: readonly { readonly id: RenderObjectId }[] }): RenderObjectId {
  const object = projection.objects[0];
  if (object === undefined) {
    throw new Error("Expected exactly one render object.");
  }
  return object.id;
}

/** The second render object id of a two-object fixture projection. */
function secondIdOf(projection: { readonly objects: readonly { readonly id: RenderObjectId }[] }): RenderObjectId {
  const object = projection.objects[1];
  if (object === undefined) {
    throw new Error("Expected exactly two render objects.");
  }
  return object.id;
}

function requireBoundingBox(geometry: THREE.BufferGeometry): THREE.Box3 {
  if (geometry.boundingBox === null) {
    throw new Error("Expected a precomputed bounding box.");
  }
  return geometry.boundingBox;
}

/** Narrows an attribute to a plain BufferAttribute (renderer geometries are never interleaved). */
function bufferAttributeOf(geometry: THREE.BufferGeometry, name: string): THREE.BufferAttribute {
  const attribute = geometry.getAttribute(name);
  if (!(attribute instanceof THREE.BufferAttribute)) {
    throw new Error(`Expected a plain BufferAttribute for "${name}".`);
  }
  return attribute;
}

/** Reads one flat component of an attribute (getX is per-vertex, not per-component). */
function componentAt(
  attribute: THREE.BufferAttribute | THREE.InterleavedBufferAttribute,
  component: number,
): number {
  const value = attribute.array[component];
  if (value === undefined) {
    throw new Error(`Attribute has no component ${component}.`);
  }
  return value;
}

describe("buildRenderObjectGeometry", () => {
  it("converts positions and indices through the float32/uint32 GPU boundary", () => {
    const geometry = buildRenderObjectGeometry(
      makeObject("fractional", FRACTIONAL_TRIANGLE),
    );
    const position = bufferAttributeOf(geometry, "position");
    expect(position.array).toBeInstanceOf(Float32Array);
    let componentIndex = 0;
    for (const expected of FRACTIONAL_TRIANGLE.positions) {
      expect(componentAt(position, componentIndex)).toBe(Math.fround(expected));
      componentIndex += 1;
    }
    const index = geometry.getIndex();
    if (index === null) {
      throw new Error("Expected an index buffer.");
    }
    expect(index.array).toBeInstanceOf(Uint32Array);
    let indexIndex = 0;
    for (const expected of FRACTIONAL_TRIANGLE.indices) {
      expect(index.getX(indexIndex)).toBe(expected);
      indexIndex += 1;
    }
  });

  it("has bounds agreeing with the projection bounds within the float32 tolerance", () => {
    const object = makeObject("fractional", FRACTIONAL_TRIANGLE);
    const box = requireBoundingBox(buildRenderObjectGeometry(object));
    const axes: readonly (readonly [number, number])[] = [
      [box.min.x, object.bounds.min[0]],
      [box.min.y, object.bounds.min[1]],
      [box.min.z, object.bounds.min[2]],
      [box.max.x, object.bounds.max[0]],
      [box.max.y, object.bounds.max[1]],
      [box.max.z, object.bounds.max[2]],
    ];
    for (const [actual, expected] of axes) {
      expect(Math.abs(actual - expected)).toBeLessThanOrEqual(
        RENDER_GEOMETRY_FLOAT32_TOLERANCE_MM,
      );
    }
  });

  it("uses kernel normals verbatim — crease normals are never averaged", () => {
    const geometry = buildRenderObjectGeometry(
      makeObject("crease", FOLDED_SHEET_WITH_NORMALS),
    );
    expect(geometry.hasAttribute("normal")).toBe(true);
    const normal = bufferAttributeOf(geometry, "normal");
    let componentIndex = 0;
    for (const expected of FOLDED_SHEET_WITH_NORMALS.normals) {
      expect(componentAt(normal, componentIndex)).toBe(Math.fround(expected));
      componentIndex += 1;
    }
  });

  it("falls back to averaged vertex normals only when the projection has none", () => {
    const geometry = buildRenderObjectGeometry(
      makeObject("shared", FOLDED_SHEET_SHARED),
    );
    expect(geometry.hasAttribute("normal")).toBe(true);
    const normal = geometry.getAttribute("normal");
    // Vertex 0 carries the fold edge: an averaged normal tilts away from
    // face A's (0, 0, 1) — the accepted smoothing cost of the fallback.
    const nz = normal.getZ(0);
    expect(nz).toBeLessThan(0.99);
    expect(nz).toBeGreaterThan(0);
    const length = Math.hypot(normal.getX(0), normal.getY(0), nz);
    expect(Math.abs(length - 1)).toBeLessThanOrEqual(1e-3);
  });
});

describe("createRenderGeometryController", () => {
  it("builds one geometry per render object, keyed by stable id", () => {
    const controller = createRenderGeometryController();
    const projection = makeProjection([
      makeObject("plate", FRACTIONAL_TRIANGLE),
      makeObject("block", FOLDED_SHEET_SHARED),
    ]);
    const snapshot = controller.sync(projection);
    expect(snapshot.size).toBe(2);
    for (const object of projection.objects) {
      expect(snapshot.has(object.id)).toBe(true);
    }
    controller.dispose();
  });

  it("re-syncs an equal projection as a true no-op with zero disposals", () => {
    const controller = createRenderGeometryController();
    const first = makeProjection([makeObject("plate", FRACTIONAL_TRIANGLE)]);
    const snapshot = controller.sync(first);
    const id = onlyIdOf(first);
    const geometry = snapshot.get(id);
    if (geometry === undefined) {
      throw new Error("Expected geometry for the plate object.");
    }
    const disposals = trackDisposals(geometry);
    const positionVersion = bufferAttributeOf(geometry, "position").version;
    const second = makeProjection([makeObject("plate", FRACTIONAL_TRIANGLE)]);
    const resynced = controller.sync(second);
    expect(resynced).toBe(snapshot);
    expect(disposals()).toBe(0);
    expect(bufferAttributeOf(geometry, "position").version).toBe(positionVersion);
    controller.dispose();
  });

  it("updates same-id geometry in place: same instance, new values, no disposal", () => {
    const controller = createRenderGeometryController();
    const before = makeProjection([makeObject("plate", FRACTIONAL_TRIANGLE)]);
    const snapshot = controller.sync(before);
    const id = onlyIdOf(before);
    const geometry = snapshot.get(id);
    if (geometry === undefined) {
      throw new Error("Expected geometry for the plate object.");
    }
    const disposals = trackDisposals(geometry);
    const updated = makeObject("plate", {
      positions: [0.1, -2.5, 3.25, 1.5, 0, 0.5, 2, 1.25, 4.5],
      indices: [0, 2, 1],
    });
    const after = controller.sync(makeProjection([updated]));
    const updatedGeometry = after.get(id);
    expect(updatedGeometry).toBe(geometry);
    expect(disposals()).toBe(0);
    const position = bufferAttributeOf(geometry, "position");
    expect(position.version).toBeGreaterThan(0);
    expect(componentAt(position, 8)).toBe(Math.fround(4.5));
    const index = geometry.getIndex();
    if (index === null) {
      throw new Error("Expected an index buffer.");
    }
    expect(index.getX(1)).toBe(2);
    expect(index.getX(2)).toBe(1);
    const box = requireBoundingBox(geometry);
    expect(Math.abs(box.max.z - 4.5)).toBeLessThanOrEqual(
      RENDER_GEOMETRY_FLOAT32_TOLERANCE_MM,
    );
    controller.dispose();
  });

  it("rebuilds and disposes the old geometry when the shape signature changes", () => {
    const controller = createRenderGeometryController();
    const before = makeProjection([makeObject("plate", FRACTIONAL_TRIANGLE)]);
    const snapshot = controller.sync(before);
    const id = onlyIdOf(before);
    const original = snapshot.get(id);
    if (original === undefined) {
      throw new Error("Expected geometry for the plate object.");
    }
    const disposals = trackDisposals(original);
    const grown = makeObject("plate", {
      positions: [0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 5],
      indices: [0, 1, 2, 0, 2, 3],
    });
    const after = controller.sync(makeProjection([grown]));
    const rebuilt = after.get(id);
    expect(rebuilt).toBeDefined();
    expect(rebuilt === original).toBe(false);
    expect(disposals()).toBe(1);
    controller.dispose();
  });

  it("rebuilds when kernel normals appear or vanish for a same-id object", () => {
    const controller = createRenderGeometryController();
    const foldWithoutNormals = {
      positions: FOLDED_SHEET_WITH_NORMALS.positions,
      indices: FOLDED_SHEET_WITH_NORMALS.indices,
    };
    const withNormals = makeProjection([
      makeObject("crease", FOLDED_SHEET_WITH_NORMALS),
    ]);
    const id = onlyIdOf(withNormals);
    const snapshot = controller.sync(withNormals);
    const original = snapshot.get(id);
    if (original === undefined) {
      throw new Error("Expected geometry for the crease object.");
    }
    const disposals = trackDisposals(original);
    const afterVanish = controller.sync(
      makeProjection([makeObject("crease", foldWithoutNormals)]),
    );
    const intermediate = afterVanish.get(id);
    if (intermediate === undefined) {
      throw new Error("Expected geometry for the crease object after rebuild.");
    }
    let intermediateDisposals = 0;
    intermediate.addEventListener("dispose", () => {
      intermediateDisposals += 1;
    });
    expect(intermediate === original).toBe(false);
    expect(disposals()).toBe(1);
    const afterReturn = controller.sync(
      makeProjection([makeObject("crease", FOLDED_SHEET_WITH_NORMALS)]),
    );
    expect(afterReturn.get(id) === original).toBe(false);
    expect(disposals()).toBe(1);
    expect(intermediateDisposals).toBe(1);
    controller.dispose();
  });

  it("disposes and removes vanished objects and rebuilds re-added ones fresh", () => {
    const controller = createRenderGeometryController();
    const both = makeProjection([
      makeObject("plate", FRACTIONAL_TRIANGLE),
      makeObject("block", FOLDED_SHEET_SHARED),
    ]);
    const blockId = secondIdOf(both);
    const snapshot = controller.sync(both);
    const block = snapshot.get(blockId);
    if (block === undefined) {
      throw new Error("Expected geometry for the block object.");
    }
    const disposals = trackDisposals(block);
    const plateOnly = controller.sync(
      makeProjection([makeObject("plate", FRACTIONAL_TRIANGLE)]),
    );
    expect(plateOnly.size).toBe(1);
    expect(plateOnly.has(blockId)).toBe(false);
    expect(disposals()).toBe(1);
    const revived = controller.sync(both);
    expect(revived.has(blockId)).toBe(true);
    expect(revived.get(blockId) === block).toBe(false);
    expect(disposals()).toBe(1);
    controller.dispose();
  });

  it("disposes everything on dispose, is idempotent, and resurrects on sync", () => {
    const controller = createRenderGeometryController();
    const projection = makeProjection([
      makeObject("plate", FRACTIONAL_TRIANGLE),
      makeObject("block", FOLDED_SHEET_SHARED),
    ]);
    const snapshot = controller.sync(projection);
    const readers: (() => number)[] = [];
    for (const geometry of snapshot.values()) {
      readers.push(trackDisposals(geometry));
    }
    controller.dispose();
    expect(readers.map((read) => read())).toEqual([1, 1]);
    expect(controller.geometries.size).toBe(0);
    controller.dispose();
    expect(readers.map((read) => read())).toEqual([1, 1]);
    const resurrected = controller.sync(projection);
    expect(resurrected.size).toBe(2);
    const originalFirst = [...snapshot.values()][0];
    const resurrectedFirst = [...resurrected.values()][0];
    expect(resurrectedFirst).toBeDefined();
    expect(resurrectedFirst === originalFirst).toBe(false);
    controller.dispose();
  });
});
