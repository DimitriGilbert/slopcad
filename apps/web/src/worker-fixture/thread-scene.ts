/**
 * The workbench's thread scene (Phase 40): the REAL kernel execution of
 * the document's thread feature inside the browser worker — the base
 * extrusion (`solid.extrude`), the planned ISO tool (`planThreadCut`, the
 * bridge's ONE tool-geometry source of truth, swept by
 * `solid.helixSweep`), one `solid.subtract` of the tool from the base,
 * then the same measurements the hole scene returns. The cosmetic mode
 * needs no geometry at all: the request resolves to the base alone (the
 * annotation rides the feature's own parameters).
 *
 * The worker stays a pure carrier of the operation matrix; the no-op
 * post-condition rides the computation REJECTION (the hole scene's
 * carrier — a cut that removed nothing never silently settles).
 */

import { length } from "@slopcad/cad-core";
import type { ComputationContext, WorkerSolidId } from "@slopcad/cad-kernel";
import { planThreadCut } from "@slopcad/cad-kernel";
import type { PlateMeasurement } from "./plate-scene";
import type { ExtrudeSceneRequest } from "./extrude-scene";
import type { ThreadCutInput } from "../cad-workbench/thread";

/**
 * The thread request the workbench dispatches (see
 * `../cad-workbench/thread`): the base extrusion, the thread's numbers,
 * and — when the feature declared a datum axis input — the session's
 * RESOLVED datum line the cut frames on (the world-axis selector is the
 * no-datum form's axis; a datum that fails to resolve never reaches the
 * scene, the reader declines it first).
 */
export interface ThreadSceneRequest {
  readonly base: ExtrudeSceneRequest;
  readonly thread: ThreadCutInput;
  readonly datumAxis?: {
    readonly origin: readonly [number, number, number];
    readonly direction: readonly [number, number, number];
  };
}

/** The no-op post-condition's relative floor (the hole scene's value). */
const NOOP_EPSILON_RELATIVE = 1e-9;

/**
 * Extrudes the base, sweeps the planned ISO tool along its helix, cuts,
 * and measures the result. A structured kernel rejection or a no-op cut
 * (the tool missed the base — the volume did not strictly decrease)
 * rejects the computation, which the session surfaces as the page's error
 * text.
 */
export async function computeThreadScene(
  context: ComputationContext,
  request: ThreadSceneRequest,
): Promise<PlateMeasurement> {
  const mm = (value: number) => length(value, "mm");
  const extruded = await context.request("solid.extrude", {
    loop: request.base.loop,
    height: mm(Math.abs(request.base.distanceMm)),
    direction: request.base.distanceMm > 0 ? 1 : -1,
    placement: request.base.placement,
  });
  const measured = await context.request("solid.bounds", {
    solid: extruded.solid,
  });
  const baseVolume = await context.request("solid.volume", {
    solid: extruded.solid,
  });
  // The cosmetic mode cuts nothing: the base IS the thread feature's
  // answer (annotation data, no geometry — every kernel runs it).
  const cosmetic = request.thread.mode === 3;
  let solid: WorkerSolidId = extruded.solid;
  if (!cosmetic) {
    // The thread axis: the resolved datum line when the feature declared
    // one (the executor bridge's own rule — axis DIRECTION and the line's
    // ORIGIN), else the world-axis selector's axis through the world
    // origin (the workbench action's selector form). Either way the
    // thread enters through the target's + face along the axis and
    // advances IN (the hole precedent), so the plan's direction is the
    // negated axis.
    const axisDirection: readonly [number, number, number] =
      request.datumAxis?.direction ??
      (request.thread.axis === 1
        ? ([1, 0, 0] as const)
        : request.thread.axis === 2
          ? ([0, 1, 0] as const)
          : ([0, 0, 1] as const));
    const axisThrough: readonly [number, number, number] = request.datumAxis
      ?.origin ?? [0, 0, 0];
    const entry = extremeProjection(measured.bounds, axisDirection);
    const plan = planThreadCut({
      majorDiameterMm: request.thread.majorDiameterMm,
      pitchMm: request.thread.pitchMm,
      lengthMm: request.thread.lengthMm,
      mode: request.thread.mode === 1 ? "external" : "internal",
      handedness: request.thread.handedness === -1 ? -1 : 1,
      startAngleRad: 0,
      advanceDirection: [
        -axisDirection[0],
        -axisDirection[1],
        -axisDirection[2],
      ],
      axisBaseMm: [
        axisThrough[0] + entry * axisDirection[0],
        axisThrough[1] + entry * axisDirection[1],
        axisThrough[2] + entry * axisDirection[2],
      ],
    });
    const tool = await context.request("solid.helixSweep", {
      loop: plan.tool.loop,
      spine: plan.tool.spine,
      placement: plan.tool.placement,
    });
    const cut = await context.request("solid.subtract", {
      target: extruded.solid,
      tools: [tool.solid],
    });
    const after = await context.request("solid.volume", { solid: cut.solid });
    if (after.volume >= baseVolume.volume * (1 - NOOP_EPSILON_RELATIVE)) {
      throw new Error(
        "thread/empty-cut: the thread tool removed nothing from the target — check the major diameter against the target's size.",
      );
    }
    solid = cut.solid;
  }
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
 * The bounds corner projection's extreme along `direction` — the entry
 * face the thread starts at (the same rule the bridge's
 * `extremeBoundsProjection` applies on document regeneration; carried
 * here because the worker scene measures the base itself).
 */
function extremeProjection(
  bounds: {
    readonly min: readonly [number, number, number];
    readonly max: readonly [number, number, number];
  },
  direction: readonly [number, number, number],
): number {
  let best = -Infinity;
  for (const x of [bounds.min[0], bounds.max[0]]) {
    for (const y of [bounds.min[1], bounds.max[1]]) {
      for (const z of [bounds.min[2], bounds.max[2]]) {
        const projection =
          x * direction[0] + y * direction[1] + z * direction[2];
        best = Math.max(best, projection);
      }
    }
  }
  return best;
}
