/**
 * The workbench's hole scene (Phase 26.10 + Phase 42): the REAL kernel
 * execution of the document's solid → hole composition inside the browser
 * worker — the base extrusion (`solid.extrude`, the 26.1 request), then one
 * planned tool per hole feature (the flat form's `planHoleCut` extruded
 * circle; the structured form's `planStructuredHoleCut` revolved meridian
 * and, for the threaded type, the Phase 40 ridge `solid.helixSweep`), then
 * one `solid.subtract` of every tool from the base, then the same
 * measurements the plate and extrude scenes return (`solid.volume`,
 * `solid.area`, `solid.bounds`, `solid.tessellate`).
 *
 * The worker stays a pure carrier of the operation matrix, exactly like
 * every other scene; every semantic (through/blind, the meridian
 * conventions, the in-plane position mapping, the overshoot) lives in the
 * shared planners (see `../cad-workbench/hole` for the document reading).
 */

import { angle, length } from "@slopcad/cad-core";
import type { ComputationContext, WorkerSolidId } from "@slopcad/cad-kernel";
import {
  planHoleCut,
  planStructuredHoleCut,
  structuredHoleDatumInPlaneAxes,
  structuredHoleWorldInPlaneAxes,
} from "@slopcad/cad-kernel";
import type { PlateMeasurement } from "./plate-scene";
import type { ExtrudeSceneRequest } from "./extrude-scene";
import type {
  HoleCutInput,
  HoleSceneEntry,
  StructuredHoleCutInput,
} from "../cad-workbench/hole";

export type { HoleCutInput, HoleSceneEntry, StructuredHoleCutInput };

/**
 * The hole request the workbench dispatches (see
 * `../cad-workbench/hole`): the base extrusion plus one entry per hole
 * feature, in document order (flat five-parameter entries and structured
 * type-directed entries alike).
 */
export interface HoleSceneRequest {
  readonly base: ExtrudeSceneRequest;
  readonly holes: readonly HoleSceneEntry[];
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
    if ("kind" in hole) {
      // The structured form: the shared planner's revolved meridian per
      // position (+ the threaded type's ridge sweep), the bridge's own
      // axis/basis resolution rules — the identical cut document
      // regeneration composes.
      const axisDirection: readonly [number, number, number] =
        hole.datumAxis?.direction ??
        (hole.axis === 1
          ? ([1, 0, 0] as const)
          : hole.axis === 2
            ? ([0, 1, 0] as const)
            : ([0, 0, 1] as const));
      const basis = hole.datumAxis
        ? structuredHoleDatumInPlaneAxes(axisDirection)
        : structuredHoleWorldInPlaneAxes(
            hole.axis === 1 ? 1 : hole.axis === 2 ? 2 : 3,
          );
      const planned = planStructuredHoleCut({
        spec: hole.spec,
        positions: hole.positions.map((position) => ({
          u: position.x,
          v: position.y,
        })),
        axisDirection,
        inPlaneU: basis.u,
        inPlaneV: basis.v,
        bounds: measured.bounds,
      });
      if (!planned.ok) {
        throw new Error(
          `hole/specification-invalid: ${planned.problem.message}`,
        );
      }
      for (const position of planned.plan.positions) {
        const tool = await context.request("solid.revolve", {
          loop: position.revolveTool.loop,
          axis: position.revolveTool.axis,
          angle: position.revolveTool.angle,
          placement: position.revolveTool.placement,
        });
        tools.push(tool);
        if (position.threadTool !== undefined) {
          const thread = await context.request("solid.helixSweep", {
            loop: position.threadTool.loop,
            spine: position.threadTool.spine,
            placement: position.threadTool.placement,
          });
          tools.push(thread);
        }
      }
      continue;
    }
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
    const first = request.holes[0];
    const description =
      first === undefined
        ? "(no holes)"
        : "kind" in first
          ? `a type-${String(first.spec.type)} hole at ${String(first.positions.length)} position(s)`
          : `Ø${String(first.diameterMm)} × ${String(first.depthMm)} mm at in-plane (${String(first.positionXMm)}, ${String(first.positionYMm)})`;
    throw new Error(
      `The hole removed no material: ${description} misses the solid (bounds [${measured.bounds.min.join(", ")}] → [${measured.bounds.max.join(", ")}]). Move the positions onto the solid or grow the diameter — the subtract would otherwise silently return it unchanged.`,
    );
  }
  const area = await context.request("solid.area", {
    solid: cut.solid,
  });
  const bounds = await context.request("solid.bounds", {
    solid: cut.solid,
  });
  const tessellation = await context.request("solid.tessellate", {
    solid: cut.solid,
  });
  return {
    volume: volume.volume,
    area: area.area,
    bounds: bounds.bounds,
    triangles: tessellation.tessellation.indices.length / 3,
    tessellation: tessellation.tessellation,
  };
}
