/**
 * The workbench's Phase 41 feature-richness scenes: the REAL kernel
 * executions of the document's rib, scale, thicken, and split features
 * inside the browser worker — each the same composition the executor
 * bridge runs (the one-source-of-truth planners shared verbatim), carried
 * through the worker operation matrix:
 *
 * - RIB: the base extrusion, the rib profile's symmetric half-thickness
 *   extrusion pair, one `solid.union`, and the no-op post-condition (a
 *   rib that added nothing never settles — the thread scene's carrier).
 * - SCALE: the base extrusion, one `solid.transform` carrying the
 *   uniform `scale` field (capability-gated kernels answer the structured
 *   unsupported through the ordinary failure path).
 * - THICKEN: the base extrusion, one `solid.thicken`.
 * - SPLIT: the base extrusion, the bridge's own `planSplitCut` covering
 *   box built by `solid.extrude`, one `solid.subtract`, and the
 *   both-ways post-condition (removed nothing / removed everything).
 */

import { angle, length } from "@slopcad/cad-core";
import type { ComputationContext, WorkerSolidId } from "@slopcad/cad-kernel";
import { planSplitCut } from "@slopcad/cad-kernel";
import type { PlateMeasurement } from "./plate-scene";
import type { ExtrudeSceneRequest } from "./extrude-scene";
import type { RibSceneRequest } from "../cad-workbench/rib";
import type {
  ScaleSceneRequest,
  ThickenSceneRequest,
} from "../cad-workbench/scale-thicken";
import type { SplitSceneRequest } from "../cad-workbench/split";

const mm = (value: number) => length(value, "mm");

/** The no-op post-conditions' relative floor (the thread scene's value). */
const NOOP_EPSILON_RELATIVE = 1e-9;

/** Extrudes the base of any composed scene (the shared first step). */
async function extrudeBase(
  context: ComputationContext,
  base: ExtrudeSceneRequest,
) {
  return context.request("solid.extrude", {
    loop: base.loop,
    height: mm(Math.abs(base.distanceMm)),
    direction: base.distanceMm > 0 ? 1 : -1,
    placement: base.placement,
    ...(base.taperRad === undefined ? {} : { taper: angle(base.taperRad) }),
  });
}

/** Measures a settled solid the way every scene does. */
async function measure(
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
 * The rib: the symmetric extrusion pair of the picked cross-section,
 * unioned with the base. A structured kernel rejection or a no-op union
 * (the rib lies entirely inside the target — the volume did not strictly
 * grow) rejects the computation.
 */
export async function computeRibScene(
  context: ComputationContext,
  request: RibSceneRequest,
): Promise<PlateMeasurement> {
  const extruded = await extrudeBase(context, request.base);
  const half = request.thicknessMm / 2;
  const ribUp = await context.request("solid.extrude", {
    loop: request.loop,
    height: mm(half),
    direction: 1,
    placement: request.placement,
  });
  const ribDown = await context.request("solid.extrude", {
    loop: request.loop,
    height: mm(half),
    direction: -1,
    placement: request.placement,
  });
  const baseVolume = await context.request("solid.volume", {
    solid: extruded.solid,
  });
  const merged = await context.request("solid.union", {
    operands: [extruded.solid, ribUp.solid, ribDown.solid],
  });
  const after = await context.request("solid.volume", { solid: merged.solid });
  if (after.volume <= baseVolume.volume * (1 + NOOP_EPSILON_RELATIVE)) {
    throw new Error(
      "rib/no-op: the rib cross-section lies entirely inside the target — the union's volume did not grow. Draw the rib's profile reaching outside the part it strengthens.",
    );
  }
  return measure(context, merged.solid);
}

/** The scale: one transform carrying the uniform factor. */
export async function computeScaleScene(
  context: ComputationContext,
  request: ScaleSceneRequest,
): Promise<PlateMeasurement> {
  const extruded = await extrudeBase(context, request.base);
  const scaled = await context.request("solid.transform", {
    solid: extruded.solid,
    translation: { x: mm(0), y: mm(0), z: mm(0) },
    scale: request.factor,
  });
  return measure(context, scaled.solid);
}

/** The thicken: one closed-hollow call. */
export async function computeThickenScene(
  context: ComputationContext,
  request: ThickenSceneRequest,
): Promise<PlateMeasurement> {
  const extruded = await extrudeBase(context, request.base);
  const thickened = await context.request("solid.thicken", {
    target: extruded.solid,
    thickness: mm(request.thicknessMm),
  });
  return measure(context, thickened.solid);
}

/** The split: the bridge's covering-box cut, with the both-ways guard. */
export async function computeSplitScene(
  context: ComputationContext,
  request: SplitSceneRequest,
): Promise<PlateMeasurement> {
  const extruded = await extrudeBase(context, request.base);
  const measured = await context.request("solid.bounds", {
    solid: extruded.solid,
  });
  const before = await context.request("solid.volume", {
    solid: extruded.solid,
  });
  const plan = planSplitCut({
    planeOrigin: request.plane.origin,
    planeNormal: request.plane.normal,
    keepSide: request.side,
    bounds: measured.bounds,
  });
  const tool = await context.request("solid.extrude", {
    loop: plan.toolLoop,
    height: mm(plan.toolHeightMm),
    direction: 1,
    placement: {
      rotation: {
        axis: plan.toolRotationAxis,
        angle: angle(plan.toolRotationAngleRad),
      },
      translation: {
        x: mm(plan.toolTranslationMm[0]),
        y: mm(plan.toolTranslationMm[1]),
        z: mm(plan.toolTranslationMm[2]),
      },
    },
  });
  const cut = await context.request("solid.subtract", {
    target: extruded.solid,
    tools: [tool.solid],
  });
  const after = await context.request("solid.volume", { solid: cut.solid });
  if (after.volume >= before.volume * (1 - NOOP_EPSILON_RELATIVE)) {
    throw new Error(
      "split/no-op: the plane's removed side holds no target material — flip the keep side or move the datum plane through the solid.",
    );
  }
  if (!(after.volume > 0)) {
    throw new Error(
      "split/removed-everything: the kept side of the datum plane holds no target material — flip the keep side or move the datum plane through the solid.",
    );
  }
  return measure(context, cut.solid);
}
