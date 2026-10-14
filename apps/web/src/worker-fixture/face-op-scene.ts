/**
 * The worker-side moveFace/deleteFace/replaceFace scene computation: the
 * target's CURRENT solid (the shared operand seam — a computed upstream
 * body, or the raw extrusion), the persistent face reference resolved
 * against that solid's topology snapshot at this dispatch's regeneration
 * (the topology cuts' resolution, `./topology-cut-scene`), and the
 * kernel's own `solid.moveFace` / `solid.deleteFace` / `solid.replaceFace`
 * call — the bridge's `runLocalFaceOperation` composition. Any refusal
 * (an unresolved face, a kernel that declines) throws, and the document
 * pass falls back to the target's scene.
 */

import { length } from "@slopcad/cad-core";
import type { ComputationContext } from "@slopcad/cad-kernel";
import type { FaceOpSceneRequest } from "../cad-workbench/face-op";
import type { ComposedSceneResult, ComputedSolids } from "./body-ops-scenes";

import { measure, NO_COMPUTED_SOLIDS, operandSolid } from "./body-ops-scenes";
import { resolveReferenceOrdinals } from "./topology-cut-scene";

/** Computes one face-op body: the operated solid plus its measurement. */
export async function computeFaceOpScene(
  context: ComputationContext,
  request: FaceOpSceneRequest,
  computed: ComputedSolids = NO_COMPUTED_SOLIDS,
): Promise<ComposedSceneResult> {
  const target = await operandSolid(
    context,
    request.target,
    computed,
    "target",
  );
  const { operation } = request;
  const { ordinals } = await resolveReferenceOrdinals(
    context,
    target,
    request.targetBodyId,
    [request.face],
    "face",
    operation.kind,
  );
  const face = ordinals[0];
  if (face === undefined) {
    throw new Error(
      `reference-unresolved: the ${operation.kind}'s face reference resolved to no face of the target.`,
    );
  }
  const result =
    operation.kind === "moveFace"
      ? await context.request("solid.moveFace", {
          target,
          face,
          direction: operation.direction,
          distance: length(operation.distanceMm, "mm"),
        })
      : operation.kind === "deleteFace"
        ? await context.request("solid.deleteFace", {
            target,
            face,
            heal: operation.heal,
          })
        : await context.request("solid.replaceFace", {
            target,
            face,
            plane: {
              origin: {
                x: length(operation.plane.origin[0], "mm"),
                y: length(operation.plane.origin[1], "mm"),
                z: length(operation.plane.origin[2], "mm"),
              },
              normal: operation.plane.normal,
            },
          });
  const measurement = await measure(context, result.solid);
  return { measurement, solid: result.solid };
}
