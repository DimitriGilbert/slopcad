/**
 * The primitive scene computation: ONE in-domain primitive request
 * (`../cad-workbench/primitive` reads it from the document) executes
 * through the kernel's own primitive operation — `solid.createBox`,
 * `solid.createSphere`, `solid.createCylinder`, `solid.createCone` — with
 * the canonical mm dimensions, and the resulting solid is measured the
 * way every scene does. The solid rides the result so a consuming
 * boolean or pattern composes from the primitive's computed geometry.
 *
 * The computation stays a pure carrier of the operation matrix like every
 * other scene: no Date, no random, results derive from the request alone.
 */

import { length } from "@slopcad/cad-core";
import type { ComputationContext, WorkerSolidId } from "@slopcad/cad-kernel";
import type {
  PrimitiveSceneRequest,
  PrimitiveShape,
} from "../cad-workbench/primitive";
import type { ComposedSceneResult } from "./body-ops-scenes";

import { measure } from "./body-ops-scenes";

/** Builds the primitive's solid through its kernel operation. */
async function createPrimitive(
  context: ComputationContext,
  shape: PrimitiveShape,
  featureId: string,
): Promise<WorkerSolidId> {
  switch (shape.kind) {
    case "box":
      return (
        await context.request("solid.createBox", {
          featureId,
          width: length(shape.widthMm, "mm"),
          depth: length(shape.depthMm, "mm"),
          height: length(shape.heightMm, "mm"),
        })
      ).solid;
    case "sphere":
      return (
        await context.request("solid.createSphere", {
          featureId,
          radius: length(shape.radiusMm, "mm"),
        })
      ).solid;
    case "cylinder":
      return (
        await context.request("solid.createCylinder", {
          featureId,
          radius: length(shape.radiusMm, "mm"),
          height: length(shape.heightMm, "mm"),
        })
      ).solid;
    case "cone":
      return (
        await context.request("solid.createCone", {
          featureId,
          bottomRadius: length(shape.bottomRadiusMm, "mm"),
          topRadius: length(shape.topRadiusMm, "mm"),
          height: length(shape.heightMm, "mm"),
        })
      ).solid;
  }
}

/** Computes one primitive body: the kernel solid plus its measurement. */
export async function computePrimitiveScene(
  context: ComputationContext,
  request: PrimitiveSceneRequest,
): Promise<ComposedSceneResult> {
  const solid = await createPrimitive(
    context,
    request.shape,
    request.featureId,
  );
  const measurement = await measure(context, solid);
  return { measurement, solid };
}
