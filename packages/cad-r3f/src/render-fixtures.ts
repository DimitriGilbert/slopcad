/**
 * Shared projection fixtures for the renderer tests: tiny deterministic
 * tessellations converted through the public cad-core projection API, so
 * every renderer test exercises the real kernel-to-projection boundary
 * instead of hand-assembled render objects.
 */

import {
  CAD_ID_PREFIXES,
  createBodyId,
  createRenderProjection,
  projectTessellation,
  type ParseResult,
  type ProjectionError,
  type RenderCamera,
  type RenderObject,
  type RenderProjection,
} from "@slopcad/cad-core";

/** The deterministic test camera (spike scene values). */
export const TEST_CAMERA: RenderCamera = {
  kind: "perspective",
  position: [46, 34, 48],
  target: [0, 0, 0],
  up: [0, 1, 0],
  fovDeg: 40,
};

/**
 * Two triangles folded 90 degrees along a shared edge, with per-vertex kernel
 * normals on duplicated vertices. The second face's normal is deliberately
 * tilted off its geometric face normal to another unit vector — averaging
 * triangle normals can only ever reproduce the geometric one — so a renderer
 * that recomputes instead of forwarding kernel normals cannot pass a
 * component-exact comparison against this fixture.
 */
export const FOLDED_SHEET_WITH_NORMALS = {
  positions: [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 0, 0, 1, 0, 0, 1, 0, -1],
  indices: [0, 1, 2, 3, 4, 5],
  normals: [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0.6, 0.8, 0, 0.6, 0.8, 0, 0.6, 0.8],
} as const;

/** The same fold indexed with shared vertices and no kernel normals. */
export const FOLDED_SHEET_SHARED = {
  positions: [0, 0, 0, 1, 0, 0, 1, 1, 0, 1, 0, -1],
  indices: [0, 1, 2, 0, 1, 3],
} as const;

/** A single triangle including values float32 cannot represent exactly. */
export const FRACTIONAL_TRIANGLE = {
  positions: [0.1, -2.5, 3.25, 1.5, 0, 0.5, 2, 1.25, -0.75],
  indices: [0, 1, 2],
} as const;

function unwrap<T>(result: ParseResult<T, ProjectionError>): T {
  if (!result.ok) {
    throw new Error(`Fixture rejected: ${result.error.message}`);
  }
  return result.value;
}

/** Projects a tessellation body through the public cad-core boundary. */
export function makeObject(
  payload: string,
  buffers: {
    readonly positions: readonly number[];
    readonly indices: readonly number[];
    readonly normals?: readonly number[];
  },
): RenderObject {
  return unwrap(
    projectTessellation(
      createBodyId(`${CAD_ID_PREFIXES.body}_${payload}`),
      buffers,
    ),
  );
}

/** Assembles render objects into a validated projection with the test camera. */
export function makeProjection(
  objects: readonly RenderObject[],
): RenderProjection {
  return unwrap(createRenderProjection(objects, TEST_CAMERA));
}
