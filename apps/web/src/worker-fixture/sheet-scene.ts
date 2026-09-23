/**
 * The workbench's Phase 49 sheet scene: the REAL kernel execution of the
 * document's surface-family feature tree inside the browser worker. The
 * rebuild plan ({@link SheetBuildPlan}, the scene-side mirror of the
 * executor bridge's input layouts) is evaluated call by call through the
 * worker operation matrix — `solid.createSheet` for the base patch, the
 * `sheet.*` family for the sheet-consuming operations — and the settled
 * body's measurement + projection become the visible scene.
 *
 * Honesty rules carried from the solid scenes: an open sheet's measurement
 * is its AREA (a sheet's `solid.volume` declines structurally — an open
 * shell bounds no material — so the volume reads its honest 0.000); a
 * thicken product is a CLOSED solid and measures its volume like any
 * other. The projection marks the open shells `openShell`, which the
 * render layer renders BOTH sides of (the Phase 48 backface discipline).
 */

import {
  createBodyId,
  createRenderProjection,
  length,
  projectTessellation,
  type RenderProjection,
} from "@slopcad/cad-core";
import type { ComputationContext, WorkerSolidId } from "@slopcad/cad-kernel";
import type {
  SheetBuildPlan,
  SheetSceneRequest,
} from "../cad-workbench/surface-scene";
import type { PlateMeasurement } from "./plate-scene";

import { extrudeCamera } from "../render-fixture/plate-render-scene";

const mm = (value: number) => length(value, "mm");

/**
 * Evaluates one rebuild plan node against the worker: leaves create the
 * base patches, inner nodes consume their operands' evaluated handles.
 * The structured kernel refusals surface through the ordinary failure
 * path (the session's error surface).
 */
async function evaluatePlan(
  context: ComputationContext,
  plan: SheetBuildPlan,
): Promise<WorkerSolidId> {
  if (plan.kind === "patch") {
    const created = await context.request("solid.createSheet", plan.input);
    return created.solid;
  }
  if (plan.kind === "trim") {
    const sheet = await evaluatePlan(context, plan.sheet);
    const tool = await evaluatePlan(context, plan.tool);
    const trimmed = await context.request("sheet.trim", {
      sheet,
      tool,
      keepInside: plan.keepInside,
    });
    return trimmed.solid;
  }
  if (plan.kind === "thicken") {
    const sheet = await evaluatePlan(context, plan.sheet);
    const thickened = await context.request("sheet.thicken", {
      sheet,
      thickness: mm(plan.thicknessMm),
      side: plan.side,
    });
    return thickened.solid;
  }
  if (plan.kind === "knit") {
    const bodies: WorkerSolidId[] = [];
    for (const operand of plan.bodies) {
      bodies.push(await evaluatePlan(context, operand));
    }
    const knitted = await context.request("sheet.knit", {
      bodies,
      tolerance: mm(plan.toleranceMm),
    });
    return knitted.solid;
  }
  const sheet = await evaluatePlan(context, plan.sheet);
  const offset = await context.request("sheet.offset", {
    sheet,
    distance: mm(plan.distanceMm),
  });
  return offset.solid;
}

/**
 * Computes the sheet scene: evaluates the plan, then measures. An open
 * sheet reports volume 0 (its volume call declines) and the AREA carries
 * the number; a thicken product is closed and measures its volume. The
 * `openShell` flag rides the plan's root kind — the honesty marker the
 * projection and the render layer both read.
 */
export async function computeSheetScene(
  context: ComputationContext,
  request: SheetSceneRequest,
): Promise<SheetSceneState> {
  const solid = await evaluatePlan(context, request.plan);
  const area = await context.request("solid.area", { solid });
  const bounds = await context.request("solid.bounds", { solid });
  const tessellation = await context.request("solid.tessellate", { solid });
  let volume = 0;
  if (request.plan.kind === "thicken") {
    const measured = await context.request("solid.volume", { solid });
    volume = measured.volume;
  }
  return {
    openShell: request.plan.kind !== "thicken",
    areaMm2: area.area,
    measurement: {
      volume,
      area: area.area,
      bounds: bounds.bounds,
      triangles: tessellation.tessellation.indices.length / 3,
      tessellation: tessellation.tessellation,
    },
  };
}

/** The computed sheet scene: the measurement plus its open-shell truth. */
export interface SheetSceneState {
  /** True when the settled body is an OPEN sheet (not a thicken solid). */
  readonly openShell: boolean;
  /** The sheet's surface area in mm² (the solid scenes' area twin). */
  readonly areaMm2: number;
  /** The measurement the session surface publishes. */
  readonly measurement: PlateMeasurement;
}

/**
 * Projects a computed sheet scene into its render state under the body id
 * the feature declares. Open shells carry `openShell` on their render
 * object — the render layer answers with a both-sides material.
 */
export function sheetRenderState(
  scene: SheetSceneState,
  bodyId: string,
): { measurement: PlateMeasurement; projection: RenderProjection } {
  const object = unwrap(
    projectTessellation(
      createBodyId(bodyId),
      scene.measurement.tessellation,
      undefined,
      scene.openShell,
    ),
  );
  return {
    measurement: scene.measurement,
    projection: unwrap(
      createRenderProjection([object], extrudeCamera(scene.measurement.bounds)),
    ),
  };
}

function unwrap<T>(
  result: { ok: true; value: T } | { ok: false; error: { message: string } },
): T {
  if (!result.ok) {
    throw new Error(`Sheet projection rejected: ${result.error.message}`);
  }
  return result.value;
}
