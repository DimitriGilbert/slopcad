/**
 * The workbench's sweep scene (Phase 38): the REAL kernel execution of the
 * document's sweep feature inside the browser worker — one `solid.sweep`
 * request with the sketch-resolved profile loop, the mapped XZ path chain,
 * and the profile's workplane placement, then the same measurements the
 * plate and extrude scenes return (`solid.volume`, `solid.area`,
 * `solid.bounds`, `solid.tessellate`).
 *
 * The worker itself stays a pure carrier of the operation matrix, exactly
 * like every other scene; on a kernel that declares no `sweep` capability
 * (Manifold) the request settles with the structured
 * `kernel/unsupported-operation` and the session surfaces it as the page's
 * error text — the honest decline, visible where the user acts.
 */

import type {
  ComputationContext,
  ProfileSweepInput,
} from "@slopcad/cad-kernel";
import type { PlateMeasurement } from "./plate-scene";

/**
 * The sweep request the workbench dispatches (see
 * `../cad-workbench/sweep`): the loop, the XZ path chain, and the
 * placement.
 */
export interface SweepSceneRequest {
  readonly loop: ProfileSweepInput["loop"];
  readonly path: ProfileSweepInput["path"];
  readonly placement: ProfileSweepInput["placement"];
}

/**
 * Sweeps the profile along the path with the REAL kernel through the worker
 * operation matrix and measures the result. A structured kernel rejection
 * (an invalid path the action-time validation could not catch, an
 * unsupported kernel) rejects the computation, which the session surfaces as
 * the page's error text.
 */
export async function computeSweepScene(
  context: ComputationContext,
  request: SweepSceneRequest,
): Promise<PlateMeasurement> {
  const swept = await context.request("solid.sweep", {
    loop: request.loop,
    path: request.path,
    placement: request.placement,
  });
  const volume = await context.request("solid.volume", {
    solid: swept.solid,
  });
  const area = await context.request("solid.area", { solid: swept.solid });
  const bounds = await context.request("solid.bounds", { solid: swept.solid });
  const tessellation = await context.request("solid.tessellate", {
    solid: swept.solid,
  });
  return {
    volume: volume.volume,
    area: area.area,
    bounds: bounds.bounds,
    triangles: tessellation.tessellation.indices.length / 3,
    tessellation: tessellation.tessellation,
  };
}
