/**
 * The workbench's loft scene (Phase 38): the REAL kernel execution of the
 * document's loft feature inside the browser worker — one `solid.loft`
 * request with the ordered sketch-resolved section loops at their station
 * heights and the first section's workplane placement, then the same
 * measurements the plate and extrude scenes return (`solid.volume`,
 * `solid.area`, `solid.bounds`, `solid.tessellate`).
 *
 * On a kernel that declares no `loft` capability (Manifold) the request
 * settles with the structured `kernel/unsupported-operation` and the session
 * surfaces it as the page's error text — the honest decline, visible where
 * the user acts.
 */

import { length } from "@slopcad/cad-core";
import type { ComputationContext, ProfileLoftInput } from "@slopcad/cad-kernel";
import type { PlateMeasurement } from "./plate-scene";

/**
 * The loft request the workbench dispatches (see `../cad-workbench/loft`):
 * the ordered sections at their stations and the placement.
 */
export interface LoftSceneRequest {
  readonly sections: readonly {
    readonly loop: ProfileLoftInput["sections"][number]["loop"];
    readonly zMm: number;
  }[];
  readonly placement: ProfileLoftInput["placement"];
}

/**
 * Lofts the ordered sections with the REAL kernel through the worker
 * operation matrix and measures the result. A structured kernel rejection
 * (a collection problem the action-time validation could not catch, an
 * unsupported kernel) rejects the computation, which the session surfaces as
 * the page's error text.
 */
export async function computeLoftScene(
  context: ComputationContext,
  request: LoftSceneRequest,
): Promise<PlateMeasurement> {
  const lofted = await context.request("solid.loft", {
    sections: request.sections.map((section) => ({
      loop: section.loop,
      z: length(section.zMm, "mm"),
    })),
    placement: request.placement,
  });
  const volume = await context.request("solid.volume", {
    solid: lofted.solid,
  });
  const area = await context.request("solid.area", { solid: lofted.solid });
  const bounds = await context.request("solid.bounds", { solid: lofted.solid });
  const tessellation = await context.request("solid.tessellate", {
    solid: lofted.solid,
  });
  return {
    volume: volume.volume,
    area: area.area,
    bounds: bounds.bounds,
    triangles: tessellation.tessellation.indices.length / 3,
    tessellation: tessellation.tessellation,
  };
}
