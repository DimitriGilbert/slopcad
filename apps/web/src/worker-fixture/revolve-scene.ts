/**
 * The workbench's revolve scene (Phase 26.2): the REAL kernel execution of
 * the document's revolve feature inside the browser worker — one
 * `solid.revolve` request with the sketch-resolved profile loop, the
 * in-plane axis line, the sweep angle, and the workplane placement, then
 * the same measurements the plate and extrude scenes return
 * (`solid.volume`, `solid.area`, `solid.bounds`, `solid.tessellate`).
 *
 * The placement rotation is pre-converted to an axis-angle pair the kernel
 * contract expects (cad-sketch's `workplaneToPlacement` supplies the values
 * — see `../cad-workbench/revolve`); the worker itself stays a pure carrier
 * of the operation matrix, exactly like every other scene.
 */

import { angle } from "@slopcad/cad-core";
import type {
  ComputationContext,
  ProfileRevolveInput,
} from "@slopcad/cad-kernel";
import type { PlateMeasurement } from "./plate-scene";

/**
 * The revolve request the workbench dispatches (see
 * `../cad-workbench/revolve`): the loop, the axis line, the sweep in
 * radians, and the placement.
 */
export interface RevolveSceneRequest {
  readonly loop: ProfileRevolveInput["loop"];
  readonly axis: ProfileRevolveInput["axis"];
  readonly angleRad: number;
  readonly placement: ProfileRevolveInput["placement"];
}

/**
 * Revolves the profile with the REAL kernel through the worker operation
 * matrix and measures the result. A structured kernel rejection (a profile
 * crossing the axis that resolution could not catch, an out-of-domain
 * sweep, a degenerate placement) rejects the computation, which the session
 * surfaces as the page's error text.
 */
export async function computeRevolveScene(
  context: ComputationContext,
  request: RevolveSceneRequest,
): Promise<PlateMeasurement> {
  const revolved = await context.request("solid.revolve", {
    loop: request.loop,
    axis: request.axis,
    angle: angle(request.angleRad, "rad"),
    placement: request.placement,
  });
  const volume = await context.request("solid.volume", {
    solid: revolved.solid,
  });
  const area = await context.request("solid.area", {
    solid: revolved.solid,
  });
  const bounds = await context.request("solid.bounds", {
    solid: revolved.solid,
  });
  const tessellation = await context.request("solid.tessellate", {
    solid: revolved.solid,
  });
  return {
    volume: volume.volume,
    area: area.area,
    bounds: bounds.bounds,
    triangles: tessellation.tessellation.indices.length / 3,
    tessellation: tessellation.tessellation,
  };
}
