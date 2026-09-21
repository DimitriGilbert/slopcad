/**
 * The workbench's pad scene (Phase 39): the REAL kernel execution of the
 * sketch-on-face composition inside the browser worker — the base extrusion
 * (`solid.extrude`), the pad extrusion anchored on the driving face's datum
 * (a second `solid.extrude` whose placement is the datum's RE-RESOLVED
 * frame), one `solid.union`, then the same measurements every scene
 * returns (`solid.volume`, `solid.area`, `solid.bounds`,
 * `solid.tessellate`).
 *
 * The union is what makes "edit driving face — geometry follows"
 * measurable in the settle volume: moving the base's depth parameter moves
 * the datum-resolved pad placement, and the composed volume changes by
 * exactly the base's analytic delta — a face-driven change no single-solid
 * extrude scene could show.
 *
 * The worker stays a pure carrier of the operation matrix; the datum
 * resolution and the placement override live in `../cad-workbench/datum`
 * and `../cad-workbench/extrude`.
 */

import { length } from "@slopcad/cad-core";
import type { ComputationContext } from "@slopcad/cad-kernel";
import type { PlateMeasurement } from "./plate-scene";
import type { ExtrudeSceneRequest } from "./extrude-scene";

/** The pad request the workbench dispatches (see cad-workbench/datum). */
export interface PadSceneRequest {
  /** The base extrusion (the driving body). */
  readonly base: ExtrudeSceneRequest;
  /** The pad extrusion, placed on the datum's re-resolved frame. */
  readonly pad: ExtrudeSceneRequest;
}

const mm = (value: number) => length(value, "mm");

/**
 * Extrudes the base, extrudes the pad on its (datum-resolved) placement,
 * unions them, and measures the result. A structured kernel rejection —
 * including a union the kernel refuses — rejects the computation, which
 * the session surfaces as the page's error text.
 */
export async function computePadScene(
  context: ComputationContext,
  request: PadSceneRequest,
): Promise<PlateMeasurement> {
  const baseSolid = await context.request("solid.extrude", {
    loop: request.base.loop,
    height: mm(Math.abs(request.base.distanceMm)),
    direction: request.base.distanceMm > 0 ? 1 : -1,
    placement: request.base.placement,
  });
  const padSolid = await context.request("solid.extrude", {
    loop: request.pad.loop,
    height: mm(Math.abs(request.pad.distanceMm)),
    direction: request.pad.distanceMm > 0 ? 1 : -1,
    placement: request.pad.placement,
  });
  const merged = await context.request("solid.union", {
    operands: [baseSolid.solid, padSolid.solid],
  });
  const volume = await context.request("solid.volume", {
    solid: merged.solid,
  });
  const area = await context.request("solid.area", { solid: merged.solid });
  const bounds = await context.request("solid.bounds", {
    solid: merged.solid,
  });
  const tessellation = await context.request("solid.tessellate", {
    solid: merged.solid,
  });
  return {
    volume: volume.volume,
    area: area.area,
    bounds: bounds.bounds,
    triangles: tessellation.tessellation.indices.length / 3,
    tessellation: tessellation.tessellation,
  };
}
