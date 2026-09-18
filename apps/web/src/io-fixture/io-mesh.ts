/**
 * Mesh-side helpers for the /io fixture (Phase 18 phase-level browser
 * deliverable): everything the imported-mesh viewport needs between "bytes
 * parsed" and "pixels settled", derived from the imported tessellation
 * alone so the scene stays deterministic.
 *
 * - `meshSignedVolume` — the divergence-theorem volume of an indexed
 *   triangle soup. The imported mesh's volume readout is computed HERE,
 *   in the browser, from the exact triangles the importer returned — the
 *   fixture never pretends a mesh body carries a kernel solid.
 * - `meshBounds` — the axis-aligned bounds of a soup, from its positions.
 * - `fitCameraToBounds` — the deterministic camera for the imported-mesh
 *   viewport: the workbench home-view DIRECTION (the (+x, −y, +z) octant
 *   the render fixture authors its camera in, z-up) at a distance that
 *   frames the mesh's bounding sphere through the fixture's 40° vertical
 *   fov. Pure function of the bounds: identical soup, identical camera,
 *   identical pixels.
 * - `buildImportedMeshState` — validates the imported soup through the
 *   public `projectTessellation` boundary under the stable body id
 *   `body_imported_mesh` and assembles the projection with the fitted
 *   camera. This is the honest rendering contract for imported meshes:
 *   they render exactly like any other tessellation, with no feature id —
 *   an imported mesh is a mesh body, never a parametric feature.
 */

import {
  createBodyId,
  createRenderProjection,
  projectTessellation,
  type ParseResult,
  type ProjectionError,
  type RenderCamera,
  type RenderProjection,
} from "@slopcad/cad-core";
import type { Tessellation } from "@slopcad/cad-kernel";

/** The imported mesh body's stable id (distinct from `body_plate`). */
const IMPORTED_MESH_BODY_ID = createBodyId("body_imported_mesh");

/** The imported-mesh viewport's vertical fov, the render fixture's value. */
const FIT_FOV_DEG = 40;

/**
 * The home-view direction, normalized: the render fixture's camera eye
 * sits at its target plus a positive multiple of this vector, so the
 * imported mesh is viewed from the same CAD "home" octant as the source
 * plate — the two viewports are directly comparable.
 */
const HOME_VIEW_DIRECTION: readonly [number, number, number] = (() => {
  // The render fixture's eye-to-target offset: [44,-30,47] - [15,10,5].
  const raw = [29, -40, 42] as const;
  const length = Math.hypot(raw[0], raw[1], raw[2]);
  return [raw[0] / length, raw[1] / length, raw[2] / length];
})();

/** The fitted camera's z-up, the CAD convention every fixture uses. */
const FIT_UP: readonly [number, number, number] = [0, 0, 1];

/** Axis-aligned bounds of a triangle soup, from its flat positions. */
export interface MeshBounds {
  readonly min: readonly [number, number, number];
  readonly max: readonly [number, number, number];
}

/**
 * The enclosed volume of an indexed triangle soup in cubic millimetres,
 * by the divergence theorem: one sixth of the sum of the signed tetrahe-
 * dron volumes `a · (b × c)` over every triangle, absolute value at the
 * end (outward winding makes the sum negative; the magnitude IS the
 * volume, so a winding flip cannot turn the readout negative).
 */
export function meshSignedVolume(tessellation: Tessellation): number {
  const { positions, indices } = tessellation;
  let total = 0;
  for (let t = 0; t < indices.length; t += 3) {
    const ia = (indices[t] ?? 0) * 3;
    const ib = (indices[t + 1] ?? 0) * 3;
    const ic = (indices[t + 2] ?? 0) * 3;
    const ax = positions[ia] ?? 0;
    const ay = positions[ia + 1] ?? 0;
    const az = positions[ia + 2] ?? 0;
    const bx = positions[ib] ?? 0;
    const by = positions[ib + 1] ?? 0;
    const bz = positions[ib + 2] ?? 0;
    const cx = positions[ic] ?? 0;
    const cy = positions[ic + 1] ?? 0;
    const cz = positions[ic + 2] ?? 0;
    total +=
      ax * (by * cz - bz * cy) +
      ay * (bz * cx - bx * cz) +
      az * (bx * cy - by * cx);
  }
  return Math.abs(total / 6);
}

/** The axis-aligned bounds of a soup's positions (min/max per axis). */
export function meshBounds(tessellation: Tessellation): MeshBounds {
  const { positions } = tessellation;
  const min: [number, number, number] = [
    Number.POSITIVE_INFINITY,
    Number.POSITIVE_INFINITY,
    Number.POSITIVE_INFINITY,
  ];
  const max: [number, number, number] = [
    Number.NEGATIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
  ];
  for (let index = 0; index < positions.length; index += 3) {
    const x = positions[index] ?? 0;
    const y = positions[index + 1] ?? 0;
    const z = positions[index + 2] ?? 0;
    if (x < min[0]) min[0] = x;
    if (y < min[1]) min[1] = y;
    if (z < min[2]) min[2] = z;
    if (x > max[0]) max[0] = x;
    if (y > max[1]) max[1] = y;
    if (z > max[2]) max[2] = z;
  }
  return { min, max };
}

/**
 * The deterministic imported-mesh camera: the home-view direction through
 * the bounds centre, at `radius / sin(fov/2)` distance (a bounding-sphere
 * fit — every point of the mesh is on screen for ANY view direction), with
 * a 5% margin so antialiased silhouette pixels never touch the frame edge.
 * Pure: identical bounds in, identical camera out.
 */
export function fitCameraToBounds(bounds: MeshBounds): RenderCamera {
  const center: [number, number, number] = [
    (bounds.min[0] + bounds.max[0]) / 2,
    (bounds.min[1] + bounds.max[1]) / 2,
    (bounds.min[2] + bounds.max[2]) / 2,
  ];
  const extents: [number, number, number] = [
    bounds.max[0] - bounds.min[0],
    bounds.max[1] - bounds.min[1],
    bounds.max[2] - bounds.min[2],
  ];
  const radius = Math.max(Math.hypot(...extents) / 2, 1e-6);
  const halfFovRad = ((FIT_FOV_DEG / 2) * Math.PI) / 180;
  const distance = (radius / Math.sin(halfFovRad)) * 1.05;
  return {
    kind: "perspective",
    position: [
      center[0] + HOME_VIEW_DIRECTION[0] * distance,
      center[1] + HOME_VIEW_DIRECTION[1] * distance,
      center[2] + HOME_VIEW_DIRECTION[2] * distance,
    ],
    target: center,
    up: [...FIT_UP],
    fovDeg: FIT_FOV_DEG,
  };
}

/** What one successful import leaves the fixture holding and rendering. */
export interface ImportedMeshState {
  /** The validated projection the imported-mesh viewport renders. */
  readonly projection: RenderProjection;
  /** The soup's triangle count (`indices.length / 3`). */
  readonly triangles: number;
  /** The soup's divergence-theorem volume in mm³. */
  readonly volume: number;
  /** The soup's axis-aligned bounds in mm. */
  readonly bounds: MeshBounds;
}

function unwrapProjection(
  result: ParseResult<RenderProjection, ProjectionError>,
): RenderProjection {
  if (!result.ok) {
    throw new Error(
      `Imported mesh projection rejected: ${result.error.message}`,
    );
  }
  return result.value;
}

/**
 * Validates an imported soup through the public projection boundary and
 * assembles the imported-mesh viewport's render state. Throws only when
 * cad-core rejects the soup (an implementation bug upstream: the format
 * adapters never return malformed geometry as success) — the fixtures'
 * `unwrap` discipline, so a rejection is loud instead of a blank viewport.
 */
export function buildImportedMeshState(
  tessellation: Tessellation,
): ImportedMeshState {
  const objectResult = projectTessellation(IMPORTED_MESH_BODY_ID, tessellation);
  if (!objectResult.ok) {
    throw new Error(`Imported mesh rejected: ${objectResult.error.message}`);
  }
  const projection = unwrapProjection(
    createRenderProjection(
      [objectResult.value],
      fitCameraToBounds(meshBounds(tessellation)),
    ),
  );
  return {
    projection,
    triangles: tessellation.indices.length / 3,
    volume: meshSignedVolume(tessellation),
    bounds: meshBounds(tessellation),
  };
}
