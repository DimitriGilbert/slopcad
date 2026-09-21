/**
 * The workbench's helix scene (Phase 40): the REAL kernel execution of the
 * document's helix feature inside the browser worker — one
 * `solid.helixSweep` request with the sketch-resolved meridian loop, the
 * analytic spine, and the helix frame placement, then the same
 * measurements the other feature scenes return (`solid.volume`,
 * `solid.area`, `solid.bounds`, `solid.tessellate`).
 *
 * The worker stays a pure carrier of the operation matrix; on a kernel
 * that declares no `helix` capability (Manifold, JSCAD) the request
 * settles with the structured `kernel/unsupported-operation` and the
 * session surfaces it as the page's error text — the honest decline,
 * visible where the user acts.
 */

import type { ComputationContext } from "@slopcad/cad-kernel";
import type { HelixSweepInput } from "@slopcad/cad-kernel";
import type { PlateMeasurement } from "./plate-scene";

/**
 * The helix request the workbench dispatches (see
 * `../cad-workbench/helix`): the loop, the spine, and the placement.
 */
export interface HelixSceneRequest {
  readonly loop: HelixSweepInput["loop"];
  readonly spine: HelixSweepInput["spine"];
  readonly placement: HelixSweepInput["placement"];
}

/**
 * Sweeps the meridian profile along the analytic spine with the REAL
 * kernel through the worker operation matrix and measures the result. A
 * structured kernel rejection (a degenerate spine the action-time
 * validation could not catch, an unsupported kernel) rejects the
 * computation, which the session surfaces as the page's error text.
 */
export async function computeHelixScene(
  context: ComputationContext,
  request: HelixSceneRequest,
): Promise<PlateMeasurement> {
  const swept = await context.request("solid.helixSweep", {
    loop: request.loop,
    spine: request.spine,
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
