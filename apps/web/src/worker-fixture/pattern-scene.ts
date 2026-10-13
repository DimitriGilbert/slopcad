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

import {
  angle,
  datumAdd,
  datumCross,
  datumDot,
  datumSubtract,
  length,
  orthonormalDatumFrame,
  unitDatumVec3,
} from "@slopcad/cad-core";
import type { DatumVec3, ResolvedDatumPlane } from "@slopcad/cad-core";
import type {
  ComputationContext,
  Tessellation,
  WorkerSolidId,
} from "@slopcad/cad-kernel";
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
  PatternFaceSceneRequest,
  PatternFeatureSceneRequest,
  PatternPathSceneRequest,
  PatternTransformSceneRequest,
} from "../cad-workbench/pattern";

import { inPlaneXAxisOf } from "../cad-workbench/datum";
import {
  type ComposedSceneResult,
  type ComputedSolids,
  NO_COMPUTED_SOLIDS,
  operandSolid,
} from "./body-ops-scenes";
import { resolveReferenceOrdinals } from "./topology-cut-scene";

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
): Promise<ComposedSceneResult> {
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
  return {
    measurement: await measure(context, merged.solid),
    solid: merged.solid,
  };
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
): Promise<ComposedSceneResult> {
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
  return {
    measurement: await measure(context, merged.solid),
    solid: merged.solid,
  };
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
): Promise<ComposedSceneResult> {
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
    return { measurement: await measure(context, working), solid: working };
  }
  const merged = await context.request("solid.union", {
    operands: [extruded.solid, working],
  });
  return {
    measurement: await measure(context, merged.solid),
    solid: merged.solid,
  };
}

/**
 * The transform patterns (patternLinear / patternCircular): the target's
 * computed solid (any solid — the operand seam, never the last-extrude
 * assumption) copied by one transform per instance and unioned, the
 * bridge's own composition — instance 0 is the target itself, copies
 * 1..count−1 march the direction by i·spacing (linear) or rotate by
 * i·(totalAngle ÷ count) about the axis (circular — the datum-axis form
 * recentering on the axis origin first, the contract's rotation-then-
 * translation order carrying the way back). One `solid.union` merges
 * every instance; a structured kernel rejection surfaces as the scene's
 * error.
 */
export async function computePatternTransformScene(
  context: ComputationContext,
  request: PatternTransformSceneRequest,
  computed: ComputedSolids = NO_COMPUTED_SOLIDS,
): Promise<ComposedSceneResult> {
  const target = await operandSolid(
    context,
    request.target,
    computed,
    "target",
  );
  const copies: WorkerSolidId[] = [target];
  if (request.pattern.kind === "linear") {
    const { count, spacingMm, direction } = request.pattern;
    for (let i = 1; i < count; i += 1) {
      copies.push(
        await translatedCopy(context, target, [
          direction[0] * spacingMm * i,
          direction[1] * spacingMm * i,
          direction[2] * spacingMm * i,
        ]),
      );
    }
  } else {
    const { count, totalAngleRad, axis, axisOrigin } = request.pattern;
    const step = totalAngleRad / count;
    const offAxis =
      axisOrigin[0] !== 0 || axisOrigin[1] !== 0 || axisOrigin[2] !== 0;
    for (let i = 1; i < count; i += 1) {
      const source = offAxis
        ? await translatedCopy(context, target, [
            -axisOrigin[0],
            -axisOrigin[1],
            -axisOrigin[2],
          ])
        : target;
      const placed = await context.request("solid.transform", {
        solid: source,
        translation: {
          x: mm(axisOrigin[0]),
          y: mm(axisOrigin[1]),
          z: mm(axisOrigin[2]),
        },
        rotation: { axis, angle: angle(i * step, "rad") },
      });
      copies.push(placed.solid);
    }
  }
  const merged = await context.request("solid.union", { operands: copies });
  return {
    measurement: await measure(context, merged.solid),
    solid: merged.solid,
  };
}

/** The bridge's on-plane tolerance for the face's tessellated region. */
const PATTERN_FACE_COPLANAR_TOLERANCE_MM = 1e-6;

/** The bridge's barycentric slack for the point-in-region test. */
const PATTERN_FACE_CONTAINMENT_EPSILON = 1e-9;

/** The tessellation's triangles as world-space vertex triples. */
function trianglesOf(
  tessellation: Tessellation,
): readonly [DatumVec3, DatumVec3, DatumVec3][] {
  const { positions, indices } = tessellation;
  const vertex = (index: number): DatumVec3 => [
    positions[index * 3] ?? 0,
    positions[index * 3 + 1] ?? 0,
    positions[index * 3 + 2] ?? 0,
  ];
  const triangles: [DatumVec3, DatumVec3, DatumVec3][] = [];
  for (let triangle = 0; triangle < indices.length / 3; triangle += 1) {
    triangles.push([
      vertex(indices[triangle * 3] ?? 0),
      vertex(indices[triangle * 3 + 1] ?? 0),
      vertex(indices[triangle * 3 + 2] ?? 0),
    ]);
  }
  return triangles;
}

/** Whether `point` lies on the plane through `origin` with unit `normal`. */
function onPlane(
  point: DatumVec3,
  origin: DatumVec3,
  normal: DatumVec3,
): boolean {
  return (
    Math.abs(datumDot(datumSubtract(point, origin), normal)) <=
    PATTERN_FACE_COPLANAR_TOLERANCE_MM
  );
}

/**
 * Whether `point` — taken as coplanar with the triangle — lies inside
 * it (the barycentric test, edges inclusive within the containment
 * epsilon). A degenerate triangle contains nothing.
 */
function triangleContains(
  [a, b, c]: readonly [DatumVec3, DatumVec3, DatumVec3],
  point: DatumVec3,
): boolean {
  const ab = datumSubtract(b, a);
  const ac = datumSubtract(c, a);
  const ap = datumSubtract(point, a);
  const d00 = datumDot(ab, ab);
  const d01 = datumDot(ab, ac);
  const d11 = datumDot(ac, ac);
  const d20 = datumDot(ap, ab);
  const d21 = datumDot(ap, ac);
  const denominator = d00 * d11 - d01 * d01;
  if (Math.abs(denominator) < 1e-18) return false;
  const w1 = (d11 * d20 - d01 * d21) / denominator;
  const w2 = (d00 * d21 - d01 * d20) / denominator;
  return (
    w1 >= -PATTERN_FACE_CONTAINMENT_EPSILON &&
    w2 >= -PATTERN_FACE_CONTAINMENT_EPSILON &&
    w1 + w2 <= 1 + PATTERN_FACE_CONTAINMENT_EPSILON
  );
}

/**
 * The bounding face's plane: the resolved face's centroid as the origin,
 * the unit normal of the tessellated triangle that carries that centroid
 * (on its plane and inside it), and the session's deterministic in-plane
 * x axis (`inPlaneXAxisOf` — the same frame the session's face-datum
 * planes carry, stable under float noise). `null` when no triangle
 * carries the centroid — a curved or non-convex face whose plane cannot
 * resolve honestly.
 */
function patternFacePlaneOf(
  triangles: readonly [DatumVec3, DatumVec3, DatumVec3][],
  centroid: DatumVec3,
): ResolvedDatumPlane | null {
  for (const triangle of triangles) {
    const [a, b, c] = triangle;
    const normal = unitDatumVec3(
      datumCross(datumSubtract(b, a), datumSubtract(c, a)),
      "face normal",
    );
    if (!normal.ok) continue;
    if (!onPlane(centroid, a, normal.value)) continue;
    if (!triangleContains(triangle, centroid)) continue;
    const frame = orthonormalDatumFrame(
      centroid,
      normal.value,
      inPlaneXAxisOf(normal.value),
    );
    return frame.ok ? frame.value : null;
  }
  return null;
}

/**
 * Computes one patternFace body — the bridge's `runPatternFaceOperation`
 * composition over the target's CURRENT solid: the face reference
 * resolved against the target's topology snapshot (the topology cuts'
 * resolution), the face's plane, its tessellated region (the target's
 * triangles on that plane), the shared
 * `planArrayPatternInstances` grid clipped to the region, one
 * `solid.transform` copy per qualifying non-origin point, one
 * `solid.union`. Fewer than two qualifying points refuse — the document
 * pass falls back to the target's scene.
 */
export async function computePatternFaceScene(
  context: ComputationContext,
  request: PatternFaceSceneRequest,
  computed: ComputedSolids = NO_COMPUTED_SOLIDS,
): Promise<ComposedSceneResult> {
  const target = await operandSolid(
    context,
    request.target,
    computed,
    "target",
  );
  const { ordinals, snapshot } = await resolveReferenceOrdinals(
    context,
    target,
    request.targetBodyId,
    [request.face],
    "face",
    "patternFace",
  );
  const faceOrdinal = ordinals[0];
  const centroid = snapshot.entities.find(
    (entity) => entity.kind === "face" && entity.ordinal === faceOrdinal,
  )?.geometry.centroidAbsoluteMm;
  if (centroid === undefined) {
    throw new Error(
      "face-plane-unresolved: the patternFace's bounding face carries no centroid in the target's topology snapshot.",
    );
  }
  const { tessellation } = await context.request("solid.tessellate", {
    solid: target,
  });
  const triangles = trianglesOf(tessellation);
  const plane = patternFacePlaneOf(triangles, centroid);
  if (plane === null) {
    throw new Error(
      "face-plane-unresolved: the patternFace's bounding face resolves to no single plane (a curved or non-convex face) — bound the grid with a planar face.",
    );
  }
  const xAxis = plane.xAxis;
  const yAxis = datumCross(plane.normal, xAxis);
  const region = triangles.filter((triangle) =>
    triangle.every((vertex) => onPlane(vertex, plane.origin, plane.normal)),
  );
  const plan = planArrayPatternInstances(request.legs);
  const copies: WorkerSolidId[] = [];
  for (const offset of plan.offsets) {
    const world: DatumVec3 = [
      offset[0] * xAxis[0] + offset[1] * yAxis[0],
      offset[0] * xAxis[1] + offset[1] * yAxis[1],
      offset[0] * xAxis[2] + offset[1] * yAxis[2],
    ];
    const point = datumAdd(plane.origin, world);
    if (!region.some((triangle) => triangleContains(triangle, point))) {
      continue;
    }
    copies.push(await translatedCopy(context, target, world));
  }
  if (copies.length < 2) {
    throw new Error(
      `patternFace/no-instance: the patternFace placed ${String(copies.length)} grid point(s) inside the bounding face (a pattern needs at least 2) — move the grid onto the face, widen its spacing, or raise its counts.`,
    );
  }
  const merged = await context.request("solid.union", { operands: copies });
  return {
    measurement: await measure(context, merged.solid),
    solid: merged.solid,
  };
}
