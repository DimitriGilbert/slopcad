/**
 * The workbench's Phase 43 pattern scenes: the REAL kernel executions of
 * the document's patternFeature, patternPath, and mirror features inside
 * the browser worker — each the same composition the executor bridge
 * runs, carried through the worker operation matrix:
 *
 * - PATTERNFEATURE: the base extrusion, the leg grid's per-instance
 *   `solid.transform` copies (the shared `planArrayPatternInstances`
 *   offsets, skips dropped), one `solid.union`.
 * - PATTERNPATH: the base extrusion, the per-station transforms from the
 *   shared path-geometry walk (fixed translation; tangent-follow adds
 *   the +z→tangent rotation), one `solid.union`.
 * - MIRROR: the base extrusion, the shared `planDatumMirror` recipe (the
 *   direct world-axis mirror or the composed oblique chain), and — for
 *   the merge option — one `solid.union` with the original.
 */

import { angle, length } from "@slopcad/cad-core";
import type { ComputationContext, WorkerSolidId } from "@slopcad/cad-kernel";
import {
  planArrayPatternInstances,
  planDatumMirror,
  rotationFromTo,
  sweepPathStationAt,
  sweepPathTotalLength,
} from "@slopcad/cad-kernel";
import type { PlateMeasurement } from "./plate-scene";
import type { ExtrudeSceneRequest } from "./extrude-scene";
import type {
  MirrorSceneRequest,
  PatternFeatureSceneRequest,
  PatternPathSceneRequest,
} from "../cad-workbench/pattern";

const mm = (value: number) => length(value, "mm");

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

/** One translated copy of `solid` (the zero offset returns the solid itself). */
async function translatedCopy(
  context: ComputationContext,
  solid: WorkerSolidId,
  offset: readonly [number, number, number],
): Promise<WorkerSolidId> {
  if (offset[0] === 0 && offset[1] === 0 && offset[2] === 0) return solid;
  const placed = await context.request("solid.transform", {
    solid,
    translation: { x: mm(offset[0]), y: mm(offset[1]), z: mm(offset[2]) },
  });
  return placed.solid;
}

/**
 * The feature-level array: the leg grid's unskipped instances, one union.
 * The offsets come from the bridge's own planner, so the scene and the
 * executor compose identical arrangements.
 */
export async function computePatternFeatureScene(
  context: ComputationContext,
  request: PatternFeatureSceneRequest,
): Promise<PlateMeasurement> {
  const extruded = await extrudeBase(context, request.base);
  const plan = planArrayPatternInstances(request.legs);
  const skips = new Set(request.skips);
  const copies: WorkerSolidId[] = [];
  for (let ordinal = 0; ordinal < plan.total; ordinal += 1) {
    if (skips.has(ordinal)) continue;
    const offset = plan.offsets[ordinal];
    if (offset === undefined) continue;
    copies.push(await translatedCopy(context, extruded.solid, offset));
  }
  const merged = await context.request("solid.union", { operands: copies });
  return measure(context, merged.solid);
}

/**
 * The path pattern: the arc-length stations of the resolved chain, fixed
 * or tangent-following. The stations come from the shared path-geometry
 * walk; tangent-follow's rotation carries world +z onto each station's
 * tangent (the bridge's documented frame — local (x, z) → world (x, 0,
 * z), the contract's initial-tangent rule starting the walk at +z).
 */
export async function computePatternPathScene(
  context: ComputationContext,
  request: PatternPathSceneRequest,
): Promise<PlateMeasurement> {
  const extruded = await extrudeBase(context, request.base);
  const totalLength = sweepPathTotalLength(request.path);
  const lastStation = (request.count - 1) * request.spacingMm;
  if (lastStation > totalLength + 1e-9) {
    throw new Error(
      `patternPath/past-end: the last instance stands at ${lastStation.toFixed(6)} mm of arc length but the chain spans only ${totalLength.toFixed(6)} mm — lower the count or the spacing.`,
    );
  }
  const copies: WorkerSolidId[] = [extruded.solid];
  for (let i = 1; i < request.count; i += 1) {
    const station = sweepPathStationAt(request.path, i * request.spacingMm);
    const translation = {
      x: mm(station.point[0]),
      y: mm(0),
      z: mm(station.point[1]),
    };
    if (request.orientation === 1) {
      const placed = await context.request("solid.transform", {
        solid: extruded.solid,
        translation,
      });
      copies.push(placed.solid);
      continue;
    }
    // Tangent-follow: the shared rotation carrying world +z onto the
    // station's tangent (the bridge's own `rotationFromTo` — parallel
    // stations answer the identity, antiparallel a half turn about world
    // +x, deterministic picks).
    const turn = rotationFromTo(
      [0, 0, 1],
      [station.tangent[0], 0, station.tangent[1]],
      [1, 0, 0],
    );
    const placed = await context.request("solid.transform", {
      solid: extruded.solid,
      translation,
      rotation: { axis: turn.axis, angle: angle(turn.angle) },
    });
    copies.push(placed.solid);
  }
  const merged = await context.request("solid.union", { operands: copies });
  return measure(context, merged.solid);
}

/**
 * The datum-plane mirror: the shared `planDatumMirror` recipe — the
 * direct world-axis mirror for axis-aligned planes, the composed
 * translate/rotate/mirror/rotate/translate chain for oblique ones — with
 * the merge option's closing union (the symmetric-part route).
 */
export async function computeMirrorScene(
  context: ComputationContext,
  request: MirrorSceneRequest,
): Promise<PlateMeasurement> {
  const extruded = await extrudeBase(context, request.base);
  const plan = planDatumMirror({
    origin: request.plane.origin,
    normal: request.plane.normal,
  });
  let working = extruded.solid;
  if (plan.kind === "direct") {
    const mirrored = await context.request("solid.mirror", {
      target: working,
      axis: plan.axis,
      offset: mm(plan.offsetMm),
    });
    working = mirrored.solid;
  } else {
    const toOrigin = await context.request("solid.transform", {
      solid: working,
      translation: {
        x: mm(plan.toOriginMm[0]),
        y: mm(plan.toOriginMm[1]),
        z: mm(plan.toOriginMm[2]),
      },
    });
    const aligned = await context.request("solid.transform", {
      solid: toOrigin.solid,
      translation: { x: mm(0), y: mm(0), z: mm(0) },
      rotation: { axis: plan.align.axis, angle: angle(plan.align.angleRad) },
    });
    const reflected = await context.request("solid.mirror", {
      target: aligned.solid,
      axis: "x",
      offset: mm(0),
    });
    const backTurn = await context.request("solid.transform", {
      solid: reflected.solid,
      translation: { x: mm(0), y: mm(0), z: mm(0) },
      rotation: { axis: plan.align.axis, angle: angle(-plan.align.angleRad) },
    });
    const fromOrigin = await context.request("solid.transform", {
      solid: backTurn.solid,
      translation: {
        x: mm(plan.fromOriginMm[0]),
        y: mm(plan.fromOriginMm[1]),
        z: mm(plan.fromOriginMm[2]),
      },
    });
    working = fromOrigin.solid;
  }
  if (request.merge === 1) {
    return measure(context, working);
  }
  const merged = await context.request("solid.union", {
    operands: [extruded.solid, working],
  });
  return measure(context, merged.solid);
}
