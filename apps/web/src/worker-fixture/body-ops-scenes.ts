/**
 * The workbench's Phase 44 body-operation scenes: the REAL kernel
 * executions of the user-level boolean command and the move-body
 * feature inside the browser worker — each carried through the worker
 * operation matrix every kernel implements, no new kernel surface:
 *
 * - BOOLEAN: the target extrusion, the tool extrusion, one
 *   `solid.union` / `solid.subtract` / `solid.intersect`, and the
 *   no-op guards the composed features keep (a union that added nothing
 *   never settles; a subtract that removed nothing never settles).
 * - MOVE BODY: the base extrusion, one `solid.transform` carrying the
 *   translation (and, when the form authored one, the world-axis
 *   rotation the Phase 44 bridge growth carries — rotation-capable
 *   kernels only, the transform contract's own gate).
 */

import { angle, length } from "@slopcad/cad-core";
import type { ComputationContext, WorkerSolidId } from "@slopcad/cad-kernel";
import type { PlateMeasurement } from "./plate-scene";
import type { ExtrudeSceneRequest } from "./extrude-scene";
import type { BooleanSceneRequest } from "../cad-workbench/boolean";
import type { MoveBodySceneRequest } from "../cad-workbench/move-body";

const mm = (value: number) => length(value, "mm");

/** The no-op post-conditions' relative floor (the thread scene's value). */
const NOOP_EPSILON_RELATIVE = 1e-9;

/** Extrudes one operand of the boolean scene (the shared first step). */
async function extrudeOperand(
  context: ComputationContext,
  operand: ExtrudeSceneRequest,
) {
  return context.request("solid.extrude", {
    loop: operand.loop,
    height: mm(Math.abs(operand.distanceMm)),
    direction: operand.distanceMm > 0 ? 1 : -1,
    placement: operand.placement,
    ...(operand.taperRad === undefined
      ? {}
      : { taper: angle(operand.taperRad) }),
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
 * The boolean: the target and tool extrusions combined by the picked
 * operation. A structured kernel rejection or a degenerate combination
 * (a union that added nothing — coincident operands; a subtract that
 * removed nothing — a disjoint tool) rejects the computation, the
 * composed features' own guards.
 */
export async function computeBooleanScene(
  context: ComputationContext,
  request: BooleanSceneRequest,
): Promise<PlateMeasurement> {
  const target = await extrudeOperand(context, request.target);
  const tool = await extrudeOperand(context, request.tool);
  const targetVolume = await context.request("solid.volume", {
    solid: target.solid,
  });
  if (request.operation === "union") {
    const merged = await context.request("solid.union", {
      operands: [target.solid, tool.solid],
    });
    const after = await context.request("solid.volume", {
      solid: merged.solid,
    });
    if (after.volume <= targetVolume.volume * (1 + NOOP_EPSILON_RELATIVE)) {
      throw new Error(
        "union/no-op: the tool adds no material beyond the target — the operands already overlap completely. Pick distinct bodies.",
      );
    }
    return measure(context, merged.solid);
  }
  if (request.operation === "subtract") {
    const cut = await context.request("solid.subtract", {
      target: target.solid,
      tools: [tool.solid],
    });
    const after = await context.request("solid.volume", { solid: cut.solid });
    if (after.volume >= targetVolume.volume * (1 - NOOP_EPSILON_RELATIVE)) {
      throw new Error(
        "subtract/no-op: the tool removes no target material — the operands do not intersect. Position the tool through the target.",
      );
    }
    if (!(after.volume > 0)) {
      throw new Error(
        "subtract/removed-everything: the tool swallows the whole target — position it to leave material behind.",
      );
    }
    return measure(context, cut.solid);
  }
  const common = await context.request("solid.intersect", {
    operands: [target.solid, tool.solid],
  });
  const after = await context.request("solid.volume", {
    solid: common.solid,
  });
  if (!(after.volume > 0)) {
    throw new Error(
      "intersect/empty: the operands share no material — the honest result is the empty solid, and the scene refuses to settle a viewport on nothing. Reposition the operands to overlap.",
    );
  }
  return measure(context, common.solid);
}

/**
 * The move-body: one transform carrying the authored translation (and
 * the optional world-axis rotation — rotation-capable kernels only, the
 * transform contract's own gate; a structured refusal from a
 * non-rotating kernel crosses back through the ordinary failure path).
 */
export async function computeMoveBodyScene(
  context: ComputationContext,
  request: MoveBodySceneRequest,
): Promise<PlateMeasurement> {
  const extruded = await extrudeOperand(context, request.base);
  const moved = await context.request("solid.transform", {
    solid: extruded.solid,
    translation: {
      x: mm(request.offsetMm[0]),
      y: mm(request.offsetMm[1]),
      z: mm(request.offsetMm[2]),
    },
    ...(request.rotation === undefined
      ? {}
      : {
          rotation: {
            axis: request.rotation.axis,
            angle: angle(request.rotation.angleRad),
          },
        }),
  });
  return measure(context, moved.solid);
}
