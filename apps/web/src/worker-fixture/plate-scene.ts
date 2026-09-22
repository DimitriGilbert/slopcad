/**
 * The `/worker` fixture's parametric scene (Phase 10): a plate with one
 * through bore — the Phase 1.6 spike scene, rebuilt as wire-protocol worker
 * operations instead of direct kernel calls, so every value the fixture
 * displays is computed by the REAL Manifold kernel inside the REAL worker.
 *
 * The scene exercises the worker operation matrix the plan's phase gate
 * demands of a browser round trip: a primitive (`solid.createBox`,
 * `solid.createCylinder`), the placement transform, a boolean
 * (`solid.subtract`), and the measurements (`solid.volume`,
 * `solid.area`, `solid.bounds`, `solid.tessellate`). Under the kernel contract's
 * placement conventions the box occupies `[0,30] × [0,20] × [0,10]` and the
 * cylinder rests on `z = 0` centred on the z axis, so the bore is
 * translated to the plate's centre and spans the plate's full height — a
 * through hole whose analytic volume reads straight off the parameters.
 */

import { length } from "@slopcad/cad-core";
import type {
  ComputationContext,
  KernelBounds,
  Tessellation,
  WorkerSolidId,
} from "@slopcad/cad-kernel";

/** The plate's x extent (mm): `solid.createBox` width. */
const PLATE_WIDTH_MM = 30;
/** The plate's y extent (mm): `solid.createBox` depth. */
const PLATE_DEPTH_MM = 20;
/** The plate's z extent (mm): `solid.createBox` height — also the bore's. */
const PLATE_HEIGHT_MM = 10;

/** The bore diameters the fixture accepts (radius ≤ 8 stays in the footprint). */
export const PLATE_HOLE_DIAMETER_MIN_MM = 1;
export const PLATE_HOLE_DIAMETER_MAX_MM = 16;

/** The document default: the spike's original 8 mm bore. */
export const PLATE_HOLE_DIAMETER_DEFAULT_MM = 8;

/** The section plane one sectioned computation cuts on (Phase 46). */
export interface PlateSectionPlane {
  readonly origin: readonly [number, number, number];
  readonly normal: readonly [number, number, number];
  readonly keepSide: 1 | -1;
}

/**
 * What one sectioned computation returns (Phase 46): the WHOLE plate's
 * measurements (the unsectioned display's own numbers, byte-unchanged),
 * the cross-section face's kernel measurements (`solid.section` —
 * `kernel/section-empty` and friends cross as the request's structured
 * failure, which the caller catches to a section-less settle), and the
 * CUT solid's own measurements — the section view mode's displayed body,
 * cap faces included in its boundary.
 */
export interface SectionedPlateMeasurement {
  readonly measurement: PlateMeasurement;
  readonly section: {
    readonly areaMm2: number;
    readonly centroidMm: readonly [number, number, number];
  };
  readonly cut: PlateMeasurement;
}

/** What one computation returns: measurements of the finished plate. */
export interface PlateMeasurement {
  /** The plate's volume in mm³, measured by `solid.volume`. */
  readonly volume: number;
  /**
   * The plate's total surface area in mm², measured by `solid.area`
   * (Phase 27.4) with the booted kernel's own semantics.
   */
  readonly area: number;
  /** The plate's axis-aligned bounds in mm, measured by `solid.bounds`. */
  readonly bounds: KernelBounds;
  /** The tessellation's triangle count (`indices.length / 3`). */
  readonly triangles: number;
  /**
   * The tessellation itself (kernel crease-aware normals included). It
   * already crosses the worker boundary for the triangle count; keeping the
   * reference lets the render fixture (Phase 11.3) project the SAME soup
   * the measurements describe, instead of asking the worker to recompute.
   */
  readonly tessellation: Tessellation;
}

const mm = (value: number) => length(value, "mm");

/**
 * Builds the plate with a through bore of `holeDiameterMm` through the
 * computation context — every request the computation issues is stamped
 * with the coordinator's revision identity, so a superseded computation is
 * cancelled and its solids released by the coordinator, not by this scene.
 */
async function measurePlate(
  context: ComputationContext,
  solid: WorkerSolidId,
): Promise<PlateMeasurement> {
  const volume = await context.request("solid.volume", { solid });
  const area = await context.request("solid.area", { solid });
  const bounds = await context.request("solid.bounds", { solid });
  const tessellation = await context.request("solid.tessellate", { solid });
  return {
    volume: volume.volume,
    area: area.area,
    bounds: bounds.bounds,
    triangles: tessellation.tessellation.indices.length / 3,
    tessellation: tessellation.tessellation,
  };
}

/**
 * Computes the drilled plate AND its section on `plane` (Phase 46): one
 * `solid.section` on the drilled solid, then the whole plate's and the
 * cut solid's measurements — every value the REAL kernel measured in the
 * REAL worker.
 */
export async function computeSectionedPlateWithHole(
  context: ComputationContext,
  holeDiameterMm: number,
  plane: PlateSectionPlane,
): Promise<SectionedPlateMeasurement> {
  const plate = await context.request("solid.createBox", {
    width: mm(PLATE_WIDTH_MM),
    depth: mm(PLATE_DEPTH_MM),
    height: mm(PLATE_HEIGHT_MM),
  });
  const boreAtOrigin = await context.request("solid.createCylinder", {
    radius: mm(holeDiameterMm / 2),
    height: mm(PLATE_HEIGHT_MM),
  });
  const bore = await context.request("solid.transform", {
    solid: boreAtOrigin.solid,
    translation: {
      x: mm(PLATE_WIDTH_MM / 2),
      y: mm(PLATE_DEPTH_MM / 2),
      z: mm(0),
    },
  });
  const drilled = await context.request("solid.subtract", {
    target: plate.solid,
    tools: [bore.solid],
  });
  const section = await context.request("solid.section", {
    target: drilled.solid,
    origin: [mm(plane.origin[0]), mm(plane.origin[1]), mm(plane.origin[2])],
    normal: [plane.normal[0], plane.normal[1], plane.normal[2]],
    keepSide: plane.keepSide,
  });
  const measurement = await measurePlate(context, drilled.solid);
  const cut = await measurePlate(context, section.solid);
  return { measurement, section: section.section, cut };
}

export async function computePlateWithHole(
  context: ComputationContext,
  holeDiameterMm: number,
): Promise<PlateMeasurement> {
  const plate = await context.request("solid.createBox", {
    width: mm(PLATE_WIDTH_MM),
    depth: mm(PLATE_DEPTH_MM),
    height: mm(PLATE_HEIGHT_MM),
  });
  const boreAtOrigin = await context.request("solid.createCylinder", {
    radius: mm(holeDiameterMm / 2),
    height: mm(PLATE_HEIGHT_MM),
  });
  const bore = await context.request("solid.transform", {
    solid: boreAtOrigin.solid,
    translation: {
      x: mm(PLATE_WIDTH_MM / 2),
      y: mm(PLATE_DEPTH_MM / 2),
      z: mm(0),
    },
  });
  const drilled = await context.request("solid.subtract", {
    target: plate.solid,
    tools: [bore.solid],
  });
  const volume = await context.request("solid.volume", {
    solid: drilled.solid,
  });
  const area = await context.request("solid.area", {
    solid: drilled.solid,
  });
  const bounds = await context.request("solid.bounds", {
    solid: drilled.solid,
  });
  const tessellation = await context.request("solid.tessellate", {
    solid: drilled.solid,
  });
  return {
    volume: volume.volume,
    area: area.area,
    bounds: bounds.bounds,
    triangles: tessellation.tessellation.indices.length / 3,
    tessellation: tessellation.tessellation,
  };
}
