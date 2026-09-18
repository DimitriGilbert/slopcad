/**
 * The `/worker-occt` fixture's parametric scene (Phase 21.2): a drilled
 * plate — 12 through bores on a grid — placed by the transform's ROTATION
 * extension, all rebuilt as wire-protocol worker operations against the
 * real OpenCascade kernel in the real worker.
 *
 * The scene exercises the worker operation matrix with OCCT's own
 * characteristics on display: a primitive pair (`solid.createBox`,
 * `solid.createCylinder`), twelve placement transforms, twelve exact BREP
 * subtracts, one rotation+translation transform (the Phase 21.2 wire
 * extension), and the measurements (`solid.volume`, `solid.area`,
 * `solid.bounds`, `solid.tessellate`). Every quantity is analytic: the plate minus twelve
 * cylinders integrates exactly under OCCT's BREP volume computation, and
 * the rigid placement preserves it — the fixture's exactness assertions are
 * the point (Manifold's fixture tolerates its mesh divergence; this one
 * does not).
 *
 * Twelve bores also make the computation heavy enough to span several
 * animation frames — the off-thread evidence the phase gate demands.
 */

import { angle, length } from "@slopcad/cad-core";
import type {
  ComputationContext,
  KernelBounds,
  Tessellation,
} from "@slopcad/cad-kernel";

/** The plate's x extent (mm): `solid.createBox` width. */
const PLATE_WIDTH_MM = 60;
/** The plate's y extent (mm): `solid.createBox` depth. */
const PLATE_DEPTH_MM = 40;
/** The plate's z extent (mm): `solid.createBox` height — also each bore's. */
const PLATE_HEIGHT_MM = 10;

/**
 * Bore centres (mm): a 4×3 grid, spacing 12 mm in x and 10 mm in y — every
 * bore clear of its neighbours and of the plate's edges for the full
 * accepted diameter range below.
 */
const BORE_X_MM: readonly number[] = [10, 22, 34, 46];
const BORE_Y_MM: readonly number[] = [10, 20, 30];
/** The number of bores the scene drills. */
export const OCCT_BORE_COUNT = BORE_X_MM.length * BORE_Y_MM.length;

/** The bore diameters the fixture accepts (radius ≤ 4.5 keeps bores disjoint). */
export const OCCT_HOLE_DIAMETER_MIN_MM = 3;
export const OCCT_HOLE_DIAMETER_MAX_MM = 9;

/** The document default. */
export const OCCT_HOLE_DIAMETER_DEFAULT_MM = 6;

/** The placement: 90° about z, then +60 mm along x (the contract's order). */
const ROTATION_DEG = 90;
const TRANSLATION_X_MM = 60;

/** What one computation returns: measurements of the placed plate. */
export interface OcctPlateMeasurement {
  /** The placed plate's volume in mm³, measured by `solid.volume`. */
  readonly volume: number;
  /** The placed plate's surface area in mm², measured by `solid.area` (Phase 27.4). */
  readonly area: number;
  /** The placed plate's axis-aligned bounds in mm, measured by `solid.bounds`. */
  readonly bounds: KernelBounds;
  /** The tessellation's triangle count (`indices.length / 3`). */
  readonly triangles: number;
  /** The tessellation itself (kernel crease-exact normals included). */
  readonly tessellation: Tessellation;
}

const mm = (value: number) => length(value, "mm");

/** The analytic volume of the drilled plate (mm³): box minus twelve cylinders. */
export function analyticOcctPlateVolume(holeDiameterMm: number): number {
  return (
    PLATE_WIDTH_MM * PLATE_DEPTH_MM * PLATE_HEIGHT_MM -
    OCCT_BORE_COUNT * Math.PI * (holeDiameterMm / 2) ** 2 * PLATE_HEIGHT_MM
  );
}

/**
 * The placed plate's exact bounds: the 60×40×10 footprint rotated 90° about
 * the world-origin z axis (x ∈ [−40, 0], y ∈ [0, 60]) then translated +60 mm
 * along x — x ∈ [20, 60], y ∈ [0, 60], z ∈ [0, 10].
 */
export const OCCT_PLACED_BOUNDS: {
  readonly min: readonly [number, number, number];
  readonly max: readonly [number, number, number];
} = {
  min: [20, 0, 0],
  max: [60, 60, 10],
};

/**
 * Builds the drilled, rotated, translated plate through the computation
 * context — every request the computation issues is stamped with the
 * coordinator's revision identity, so a superseded computation is cancelled
 * and its solids released by the coordinator, not by this scene.
 */
export async function computeOcctDrilledPlate(
  context: ComputationContext,
  holeDiameterMm: number,
): Promise<OcctPlateMeasurement> {
  let acc = await context.request("solid.createBox", {
    width: mm(PLATE_WIDTH_MM),
    depth: mm(PLATE_DEPTH_MM),
    height: mm(PLATE_HEIGHT_MM),
  });
  for (const boreX of BORE_X_MM) {
    for (const boreY of BORE_Y_MM) {
      const boreAtOrigin = await context.request("solid.createCylinder", {
        radius: mm(holeDiameterMm / 2),
        height: mm(PLATE_HEIGHT_MM),
      });
      const bore = await context.request("solid.transform", {
        solid: boreAtOrigin.solid,
        translation: { x: mm(boreX), y: mm(boreY), z: mm(0) },
      });
      acc = await context.request("solid.subtract", {
        target: acc.solid,
        tools: [bore.solid],
      });
    }
  }
  // The rotation extension over the wire: rotate FIRST about the
  // world-origin z axis, translate SECOND in world space.
  const placed = await context.request("solid.transform", {
    solid: acc.solid,
    translation: { x: mm(TRANSLATION_X_MM), y: mm(0), z: mm(0) },
    rotation: { axis: [0, 0, 1], angle: angle(ROTATION_DEG, "deg") },
  });
  const volume = await context.request("solid.volume", {
    solid: placed.solid,
  });
  const area = await context.request("solid.area", {
    solid: placed.solid,
  });
  const bounds = await context.request("solid.bounds", {
    solid: placed.solid,
  });
  const tessellation = await context.request("solid.tessellate", {
    solid: placed.solid,
  });
  return {
    volume: volume.volume,
    area: area.area,
    bounds: bounds.bounds,
    triangles: tessellation.tessellation.indices.length / 3,
    tessellation: tessellation.tessellation,
  };
}
