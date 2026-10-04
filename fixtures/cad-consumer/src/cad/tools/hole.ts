import type {
  AnyDimensionalValue,
  CadDocument,
  FeatureRecord,
  ParameterId,
} from "@slopcad/cad-core";
import { valueIn } from "@slopcad/cad-core";
import type { StructuredHoleSpec } from "@slopcad/cad-kernel";
import { structuredHoleRoles, structuredHoleTypeOf } from "@slopcad/cad-kernel";
import { parseSketch } from "@slopcad/cad-sketch";
import type { SceneOperand } from "./extrude";

import { sceneOperandOfBody } from "./extrude";
import { resolveSessionDatumAxis } from "./datum";

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
  /**
   * The base's operand source: a plain extrusion rides its own derivation
   * (the established composition, byte-identical), a composition's output
   * (pad, boolean, moved body) references the computed solid the document
   * pass hands over — a hole drilled into a consumed body cuts its CURRENT
   * geometry, never a re-derivation that would erase the earlier features.
   */
  readonly base: SceneOperand;
  /** One entry per hole feature, in document order (flat or structured). */
  readonly holes: readonly HoleSceneEntry[];
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
 * The target ref of one hole feature (its single feature/body input), or
 * `null` when the layout is malformed.
 */
function holeTargetRefOf(
  feature: FeatureRecord,
): { readonly kind: string; readonly id: string } | null {
  const targetRefs = feature.inputs.filter(
    (ref) => ref.kind === "feature" || ref.kind === "body",
  );
  const target = targetRefs[0];
  return target ?? null;
}

/** The target ref's id (the same-base comparison's key). */
function holeTargetIdOf(feature: FeatureRecord): string | null {
  return holeTargetRefOf(feature)?.id ?? null;
}

/**
 * Reads the document's hole features into the worker-scene request: the
 * FIRST hole's target picks the base — its operand source resolved through
 * `sceneOperandOfBody` (a plain extrusion's derivation, or a composition
 * output's computed solid) — every hole must cut that same base, and each
 * hole's five numbers ride in document order. The rendered body is the
 * LAST hole feature's output (the newest cut). `null` when the document
 * carries no hole feature, the base no longer resolves, or any hole's
 * inputs no longer resolve — callers render the prior scene rather than
 * fabricate geometry.
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
  const baseRef = holeTargetRefOf(firstHole);
  if (baseId === null || baseRef === null) return null;
  const baseBodyId =
    baseRef.kind === "body"
      ? baseRef.id
      : document.features.find((entry) => entry.id === baseRef.id)?.outputs[0];
  if (baseBodyId === undefined) return null;
  const base = sceneOperandOfBody(document, baseBodyId);
  if (base === null) return null;
  const holes: HoleSceneEntry[] = [];
  for (const holeFeature of holeFeatures) {
    if (holeTargetIdOf(holeFeature) !== baseId) return null;
    // Phase 42: a hole feature whose FIRST parameter is the dimensionless
    // type selector rides the structured form (the bridge's own dispatch
    // rule); the flat five-parameter form stays byte-compatible.
    if (isStructuredHoleFeature(document, holeFeature)) {
      const structured = structuredHoleCutInputOfFeature(document, holeFeature);
      if (structured === null) return null;
      holes.push(structured);
      continue;
    }
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

// ---------------------------------------------------------------------------
// The structured hole form (Phase 42)
// ---------------------------------------------------------------------------

/** One structured hole's scene payload: the spec, its positions, its axis. */
export interface StructuredHoleCutInput {
  readonly kind: "structured";
  readonly spec: StructuredHoleSpec;
  /**
   * The positions in the form's own in-plane convention (the positionX/
   * positionY pair, or the positions sketch's points) — many per feature.
   */
  readonly positions: readonly {
    readonly x: number;
    readonly y: number;
  }[];
  /** The world-axis selector (1–3); unused when `datumAxis` is present. */
  readonly axis: number;
  /** The session-resolved datum axis line, present exactly when declared. */
  readonly datumAxis?: {
    readonly origin: readonly [number, number, number];
    readonly direction: readonly [number, number, number];
  };
}

/** One hole scene entry: the flat five-parameter form or the structured. */
export type HoleSceneEntry = HoleCutInput | StructuredHoleCutInput;

/**
 * Whether a hole feature rides the STRUCTURED form (Phase 42): its first
 * parameter input carries a DIMENSIONLESS value — the type selector — where
 * the flat form's first parameter is the LENGTH diameter. The bridge's own
 * dispatch rule, read here so the worker scene composes the same cut the
 * bridge would.
 */
export function isStructuredHoleFeature(
  document: CadDocument,
  feature: FeatureRecord,
): boolean {
  const firstParameter = feature.inputs.find((ref) => ref.kind === "parameter");
  if (firstParameter === undefined) return false;
  const parameter = document.parameters.parameters.find(
    (candidate) => candidate.id === firstParameter.id,
  );
  return parameter?.value.dimension === "dimensionless";
}

/** Reads a parameter's canonical magnitude, or `null` off-dimension. */
function magnitudeIn(
  value: AnyDimensionalValue | undefined,
  dimension: "length" | "angle" | "dimensionless",
  unit: "mm" | "rad" | "1",
): number | null {
  if (value === undefined || value.dimension !== dimension) return null;
  const magnitude = valueIn(value, unit);
  return Number.isFinite(magnitude) ? magnitude : null;
}

/**
 * The workbench's sketch-POINTS resolver (the bridge's caller-supplied seam,
 * the sweep path resolver's twin): the sketch record's POINT entities as
 * workplane (x, y) pairs. The sketch's own workplane placement does not
 * carry — the points are the position LIST in the hole's in-plane basis
 * (the path seam's simplification precedent).
 */
export function sketchPointsResolverOf(
  document: CadDocument,
): (
  sketchId: string,
) =>
  | { readonly ok: true; readonly points: readonly { x: number; y: number }[] }
  | { readonly ok: false; readonly code: string; readonly message: string } {
  return (sketchId) => {
    const record = document.sketches.find((entry) => entry.id === sketchId);
    if (record === undefined) {
      return {
        ok: false,
        code: "document/not-found",
        message: `No sketch record "${sketchId}" exists in the document.`,
      };
    }
    const sketch = parseSketch(record.sketch);
    if (!sketch.ok) {
      return {
        ok: false,
        code: sketch.error.code,
        message: sketch.error.message,
      };
    }
    const points: { x: number; y: number }[] = [];
    for (const entity of sketch.value.entities) {
      if (entity.kind !== "point") continue;
      if (!Number.isFinite(entity.x) || !Number.isFinite(entity.y)) continue;
      points.push({ x: entity.x, y: entity.y });
    }
    return { ok: true, points };
  };
}

/**
 * Reads one STRUCTURED hole feature into its scene payload: the type-
 * directed roles in declared order (the bridge's schema), the positions
 * from the positions sketch or the positionX/positionY pair, and the axis
 * from the datum input (session-resolved — an unresolvable datum declines
 * the request, the thread reader's discipline) or the world selector.
 * `null` when the layout is malformed, any parameter no longer resolves,
 * or a declared datum axis no longer resolves — callers render the prior
 * scene rather than fabricate geometry.
 */
export function structuredHoleCutInputOfFeature(
  document: CadDocument,
  feature: FeatureRecord,
): StructuredHoleCutInput | null {
  const parameterRefs = feature.inputs.filter(
    (ref) => ref.kind === "parameter",
  );
  const sketchRefs = feature.inputs.filter((ref) => ref.kind === "sketch");
  const datumRefs = feature.inputs.filter((ref) => ref.kind === "datum");
  const firstRef = parameterRefs[0];
  if (firstRef === undefined) return null;
  const typeParameter = document.parameters.parameters.find(
    (candidate) => candidate.id === firstRef.id,
  );
  const typeRaw = magnitudeIn(typeParameter?.value, "dimensionless", "1");
  if (typeRaw === null) return null;
  const type = structuredHoleTypeOf(typeRaw);
  if (type === null) return null;
  const sketchPositions = sketchRefs.length === 1;
  const roles = structuredHoleRoles(type, {
    sketchPositions,
    datumAxis: datumRefs.length === 1,
  });
  if (parameterRefs.length !== roles.length) return null;
  const valueOf = (name: string): number | null => {
    const index = roles.findIndex((role) => role.name === name);
    if (index < 0) return null;
    const ref = parameterRefs[index];
    if (ref === undefined) return null;
    const parameter = document.parameters.parameters.find(
      (candidate) => candidate.id === ref.id,
    );
    const role = roles[index];
    if (role === undefined) return null;
    if (role.kind === "length") {
      return magnitudeIn(parameter?.value, "length", "mm");
    }
    if (role.kind === "angle") {
      const rad = magnitudeIn(parameter?.value, "angle", "rad");
      return rad === null ? null : (rad * 180) / Math.PI;
    }
    return magnitudeIn(parameter?.value, "dimensionless", "1");
  };
  const diameter = valueOf("diameter");
  const depth = valueOf("depth");
  if (depth === null) return null;
  const spec: StructuredHoleSpec = {
    type: typeRaw,
    diameterMm: diameter ?? 0,
    depthMm: depth,
    tipAngleDeg: valueOf("tipAngle") ?? 180,
    cboreDiameterMm: valueOf("cboreDiameter") ?? 0,
    cboreDepthMm: valueOf("cboreDepth") ?? 0,
    csinkDiameterMm: valueOf("csinkDiameter") ?? 0,
    csinkAngleDeg: valueOf("csinkAngle") ?? 0,
    taperAngleDeg: valueOf("taperAngle") ?? 0,
    threadMajorMm: valueOf("threadMajor") ?? 0,
    threadPitchMm: valueOf("threadPitch") ?? 0,
  };
  // The positions: the sketch's points, else the parameter pair.
  let positions: StructuredHoleCutInput["positions"];
  if (sketchPositions) {
    const sketchRef = sketchRefs[0];
    if (sketchRef === undefined) return null;
    const resolved = sketchPointsResolverOf(document)(sketchRef.id);
    if (!resolved.ok) return null;
    positions = resolved.points;
    if (positions.length === 0) return null;
  } else {
    const x = valueOf("positionX");
    const y = valueOf("positionY");
    if (x === null || y === null) return null;
    positions = [{ x, y }];
  }
  // The axis: the session-resolved datum line, else the world selector.
  if (datumRefs.length === 1) {
    const datumRef = datumRefs[0];
    if (datumRef === undefined) return null;
    const resolved = resolveSessionDatumAxis(document, datumRef.id);
    if (!resolved.ok) return null;
    return {
      kind: "structured",
      spec,
      positions,
      axis: 3,
      datumAxis: {
        origin: [resolved.origin[0], resolved.origin[1], resolved.origin[2]],
        direction: [
          resolved.direction[0],
          resolved.direction[1],
          resolved.direction[2],
        ],
      },
    };
  }
  const axis = valueOf("axis");
  if (axis === null || (axis !== 1 && axis !== 2 && axis !== 3)) return null;
  return { kind: "structured", spec, positions, axis };
}
