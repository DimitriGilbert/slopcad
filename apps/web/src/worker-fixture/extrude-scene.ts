/**
 * The workbench's extrude scene (Phase 26.1): the REAL kernel execution of
 * the document's extrude feature inside the browser worker — one
 * `solid.extrude` request with the sketch-resolved profile loop, the signed
 * distance, and the workplane placement, then the same measurements the
 * plate scene returns (`solid.volume`, `solid.area`, `solid.bounds`,
 * `solid.tessellate`).
 *
 * The placement rotation is pre-converted to an axis-angle pair the kernel
 * contract expects (cad-sketch's `workplaneToPlacement` supplies the values
 * — see `../cad-workbench/extrude`); the worker itself stays a pure carrier
 * of the operation matrix, exactly like every other scene.
 */

import { angle, length } from "@slopcad/cad-core";
import type {
  ComputationContext,
  ProfileExtrudeInput,
} from "@slopcad/cad-kernel";
import type { PlateMeasurement } from "./plate-scene";

/** The extrude request the workbench dispatches (see cad-workbench/extrude). */
export interface ExtrudeSceneRequest {
  readonly loop: ProfileExtrudeInput["loop"];
  readonly placement: ProfileExtrudeInput["placement"];
  readonly distanceMm: number;
  /** The optional draft taper (Phase 41), canonical radians. */
  readonly taperRad?: number;
}

const mm = (value: number) => length(value, "mm");

/**
 * Extrudes the profile with the REAL kernel through the worker operation
 * matrix and measures the result. A structured kernel rejection (an invalid
 * profile that resolution could not catch, a degenerate placement) rejects
 * the computation, which the session surfaces as the page's error text.
 */
export async function computeExtrudeScene(
  context: ComputationContext,
  request: ExtrudeSceneRequest,
): Promise<PlateMeasurement> {
  const extruded = await context.request("solid.extrude", {
    loop: request.loop,
    height: mm(Math.abs(request.distanceMm)),
    direction: request.distanceMm > 0 ? 1 : -1,
    placement: request.placement,
    // The Phase 41 draft taper rides exactly when present — the wire's
    // optional-field discipline, so untapered scenes keep their bytes.
    ...(request.taperRad === undefined
      ? {}
      : { taper: angle(request.taperRad) }),
  });
  const volume = await context.request("solid.volume", {
    solid: extruded.solid,
  });
  const area = await context.request("solid.area", {
    solid: extruded.solid,
  });
  const bounds = await context.request("solid.bounds", {
    solid: extruded.solid,
  });
  const tessellation = await context.request("solid.tessellate", {
    solid: extruded.solid,
  });
  return {
    volume: volume.volume,
    area: area.area,
    bounds: bounds.bounds,
    triangles: tessellation.tessellation.indices.length / 3,
    tessellation: tessellation.tessellation,
  };
}

/** The extruded body's rendered id: `rend_<body payload>`. */
export function extrudeRenderId(bodyId: string): string {
  return `rend_${bodyId.replace(/^body_/, "")}`;
}
