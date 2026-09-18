/**
 * The workbench's hole scene (Phase 26.10): the REAL kernel execution of
 * the document's solid → hole composition inside the browser worker — the
 * base extrusion (`solid.extrude`, the 26.1 request), then one planned
 * tool per hole feature (`planHoleCut`, the bridge's ONE tool-geometry
 * source of truth, carried out as a circle `solid.extrude` so the axis
 * orientation rides the extrude placement every kernel implements), then
 * one `solid.subtract` of every tool from the base, then the same
 * measurements the plate and extrude scenes return (`solid.volume`,
 * `solid.bounds`, `solid.tessellate`).
 *
 * The worker stays a pure carrier of the operation matrix, exactly like
 * every other scene; the through/blind semantic, the in-plane position
 * mapping, and the overshoot all live in `planHoleCut` (see
 * `../cad-workbench/hole` for the document reading).
 */

import { angle, length } from "@slopcad/cad-core";
import type { ComputationContext, WorkerSolidId } from "@slopcad/cad-kernel";
import { planHoleCut } from "@slopcad/cad-kernel";
import type { PlateMeasurement } from "./plate-scene";
import type { ExtrudeSceneRequest } from "./extrude-scene";

/** One hole's five numbers (the feature's parameter roles, in order). */
export interface HoleCutInput {
  readonly diameterMm: number;
  readonly depthMm: number;
  readonly positionXMm: number;
  readonly positionYMm: number;
  readonly axis: 1 | 2 | 3;
}

/**
 * The hole request the workbench dispatches (see
 * `../cad-workbench/hole`): the base extrusion plus one entry per hole
 * feature, in document order.
 */
export interface HoleSceneRequest {
  readonly base: ExtrudeSceneRequest;
  readonly holes: readonly HoleCutInput[];
}

const mm = (value: number) => length(value, "mm");

/**
 * The no-op post-condition's worker-side carrier (the shell precedent; the
 * same rule the bridge's `runHoleOperation` enforces on document
 * regeneration): a subtract whose tool misses the target returns the target
 * UNCHANGED, and the worker surface has no diagnostics channel — so the
 * volume-must-strictly-decrease check rides the computation REJECTION,
 * which the session writes to the page's error surface. Never a silent
 * unchanged scene.
 */
const NOOP_EPSILON_RELATIVE = 1e-9;

/**
 * Extrudes the base, cuts every planned hole tool, and measures the result.
 * A structured kernel rejection (an unresolvable base, a degenerate tool,
 * a subtract the kernel refuses) or a no-op cut (every tool missed — the
 * volume did not strictly decrease) rejects the computation, which the
 * session surfaces as the page's error text.
 */
export async function computeHoleScene(
  context: ComputationContext,
  request: HoleSceneRequest,
): Promise<PlateMeasurement> {
  const extruded = await context.request("solid.extrude", {
    loop: request.base.loop,
    height: mm(Math.abs(request.base.distanceMm)),
    direction: request.base.distanceMm > 0 ? 1 : -1,
    placement: request.base.placement,
  });
  // The tool plan reads the TARGET's bounds — the base solid as extruded.
  const measured = await context.request("solid.bounds", {
    solid: extruded.solid,
  });
  const baseVolume = await context.request("solid.volume", {
    solid: extruded.solid,
  });
  const tools: { readonly solid: WorkerSolidId }[] = [];
  for (const hole of request.holes) {
    const plan = planHoleCut({
      diameterMm: hole.diameterMm,
      depthMm: hole.depthMm,
      positionXMm: hole.positionXMm,
      positionYMm: hole.positionYMm,
      axis: hole.axis,
      bounds: measured.bounds,
    });
    const tool = await context.request("solid.extrude", {
      loop: [{ kind: "circle", center: [0, 0], radius: plan.toolRadiusMm }],
      height: mm(plan.toolHeightMm),
      direction: 1,
      placement: {
        rotation: {
          axis: plan.toolRotationAxis,
          angle: angle(plan.toolRotationAngleRad, "rad"),
        },
        translation: {
          x: mm(plan.toolTranslationMm[0]),
          y: mm(plan.toolTranslationMm[1]),
          z: mm(plan.toolTranslationMm[2]),
        },
      },
    });
    tools.push(tool);
  }
  const cut = await context.request("solid.subtract", {
    target: extruded.solid,
    tools: tools.map((tool) => tool.solid),
  });
  const volume = await context.request("solid.volume", {
    solid: cut.solid,
  });
  const epsilon = Math.max(
    1e-9,
    Math.abs(baseVolume.volume) * NOOP_EPSILON_RELATIVE,
  );
  if (volume.volume >= baseVolume.volume - epsilon) {
    throw new Error(
      `The hole removed no material: Ø${String(request.holes[0]?.diameterMm ?? 0)} × ${String(request.holes[0]?.depthMm ?? 0)} mm at in-plane (${String(request.holes[0]?.positionXMm ?? 0)}, ${String(request.holes[0]?.positionYMm ?? 0)}) misses the solid (bounds [${measured.bounds.min.join(", ")}] → [${measured.bounds.max.join(", ")}]). Move holeX/holeY onto the solid or grow the diameter — the subtract would otherwise silently return it unchanged.`,
    );
  }
  const bounds = await context.request("solid.bounds", {
    solid: cut.solid,
  });
  const tessellation = await context.request("solid.tessellate", {
    solid: cut.solid,
  });
  return {
    volume: volume.volume,
    bounds: bounds.bounds,
    triangles: tessellation.tessellation.indices.length / 3,
    tessellation: tessellation.tessellation,
  };
}
