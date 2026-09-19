import type {
  AnyDimensionalValue,
  CadDocument,
  FeatureRecord,
  ParameterId,
} from "@slopcad/cad-core";
import { valueIn } from "@slopcad/cad-core";
import type { ExtrudeSceneRequest } from "./extrude";

import { extrudeSceneRequestOfFeature } from "./extrude";

/** The diameter a hole action creates its diameter parameter with (mm). */
export const HOLE_DEFAULT_DIAMETER_MM = 8;

/**
 * The depth a hole action creates its depth parameter with (mm) — a blind
 * hole into the usual plate stock; depth ≥ the target's thickness drills
 * through (the bridge's documented through/blind semantic).
 */
export const HOLE_DEFAULT_DEPTH_MM = 4;

/** The axis a hole action creates its axis parameter with: 3 = Z (top face). */
export const HOLE_DEFAULT_AXIS = 3;

/** One hole's five numbers, in the feature's declared parameter role order. */
export interface HoleCutInput {
  readonly diameterMm: number;
  readonly depthMm: number;
  readonly positionXMm: number;
  readonly positionYMm: number;
  readonly axis: 1 | 2 | 3;
}

/** The worker-scene payload the document's holes execute as. */
export interface HoleSceneRequest {
  /** The base extrusion the holes are cut from. */
  readonly base: ExtrudeSceneRequest;
  /** One entry per hole feature, in document order. */
  readonly holes: readonly HoleCutInput[];
}

function lengthMm(value: AnyDimensionalValue): number | null {
  return value.dimension === "length" ? valueIn(value, "mm") : null;
}

/**
 * The document's LAST extrude feature — the solid the next hole cuts (the
 * scene composition's base). `undefined` when no extrusion exists yet.
 */
export function holeBaseFeatureOf(
  document: CadDocument,
): FeatureRecord | undefined {
  const bases = document.features.filter((entry) => entry.kind === "extrude");
  return bases[bases.length - 1];
}

/**
 * The center of a rendered solid's top face (axis Z) in world millimetres —
 * the default position a new hole is created at.
 */
export function defaultHolePosition(bounds: {
  readonly min: readonly [number, number, number];
  readonly max: readonly [number, number, number];
}): { readonly x: number; readonly y: number } {
  const x = (bounds.min[0] + bounds.max[0]) / 2;
  const y = (bounds.min[1] + bounds.max[1]) / 2;
  return { x, y };
}

/**
 * Reads one hole feature's five parameter inputs in declared role order.
 * `null` when the layout is malformed or any parameter no longer resolves
 * as a length (the axis reads as a dimensionless integer selector). Shared
 * with the Phase 26 chain reader, which composes the same holes into the
 * cross-feature scene request.
 */
export function holeCutInputOfFeature(
  document: CadDocument,
  feature: FeatureRecord,
): HoleCutInput | null {
  const targetRefs = feature.inputs.filter(
    (ref) => ref.kind === "feature" || ref.kind === "body",
  );
  const parameterRefs = feature.inputs.filter(
    (ref) => ref.kind === "parameter",
  );
  if (targetRefs.length !== 1 || parameterRefs.length !== 5) return null;
  const diameterRef = parameterRefs[0];
  const depthRef = parameterRefs[1];
  const xRef = parameterRefs[2];
  const yRef = parameterRefs[3];
  const axisRef = parameterRefs[4];
  if (
    diameterRef === undefined ||
    depthRef === undefined ||
    xRef === undefined ||
    yRef === undefined ||
    axisRef === undefined
  ) {
    return null;
  }
  const diameterMm = parameterLengthMmOf(document, diameterRef.id);
  const depthMm = parameterLengthMmOf(document, depthRef.id);
  const positionXMm = parameterLengthMmOf(document, xRef.id);
  const positionYMm = parameterLengthMmOf(document, yRef.id);
  const axisParameter = document.parameters.parameters.find(
    (candidate) => candidate.id === axisRef.id,
  );
  const axisRaw =
    axisParameter === undefined ||
    axisParameter.value.dimension !== "dimensionless"
      ? null
      : valueIn(axisParameter.value, "1");
  if (
    diameterMm === null ||
    depthMm === null ||
    positionXMm === null ||
    positionYMm === null ||
    axisRaw === null
  ) {
    return null;
  }
  if (axisRaw !== 1 && axisRaw !== 2 && axisRaw !== 3) return null;
  return {
    diameterMm,
    depthMm,
    positionXMm,
    positionYMm,
    axis: axisRaw,
  };
}

/** A parameter's length in canonical millimetres, or `null` when it does
 *  not resolve as a length. */
function parameterLengthMmOf(
  document: CadDocument,
  id: ParameterId,
): number | null {
  const parameter = document.parameters.parameters.find(
    (candidate) => candidate.id === id,
  );
  return parameter === undefined ? null : lengthMm(parameter.value);
}

/**
 * The target feature ref of one hole feature (its single feature/body
 * input), or `null` when the layout is malformed.
 */
function holeTargetIdOf(feature: FeatureRecord): string | null {
  const targetRefs = feature.inputs.filter(
    (ref) => ref.kind === "feature" || ref.kind === "body",
  );
  const target = targetRefs[0];
  return target === undefined ? null : target.id;
}

/**
 * Reads the document's hole features into the worker-scene request: the
 * FIRST hole's target picks the base extrusion, every hole must cut that
 * same base, and each hole's five numbers ride in document order. The
 * rendered body is the LAST hole feature's output (the newest cut).
 * `null` when the document carries no hole feature, the base no longer
 * resolves, or any hole's inputs no longer resolve — callers render the
 * prior scene rather than fabricate geometry.
 */
export function documentHoleSceneRequest(
  document: CadDocument,
): { readonly request: HoleSceneRequest; readonly bodyId: string } | null {
  const holeFeatures = document.features.filter(
    (entry) => entry.kind === "hole",
  );
  const lastHole = holeFeatures[holeFeatures.length - 1];
  const firstHole = holeFeatures[0];
  if (firstHole === undefined || lastHole === undefined) return null;
  const baseId = holeTargetIdOf(firstHole);
  if (baseId === null) return null;
  const baseFeature = document.features.find(
    (entry) => entry.kind === "extrude" && entry.id === baseId,
  );
  if (baseFeature === undefined) return null;
  const base = extrudeSceneRequestOfFeature(document, baseFeature);
  if (base === null) return null;
  const holes: HoleCutInput[] = [];
  for (const holeFeature of holeFeatures) {
    if (holeTargetIdOf(holeFeature) !== baseId) return null;
    const hole = holeCutInputOfFeature(document, holeFeature);
    if (hole === null) return null;
    holes.push(hole);
  }
  const bodyId = lastHole.outputs[0];
  if (bodyId === undefined) return null;
  return {
    request: { base, holes },
    bodyId,
  };
}
