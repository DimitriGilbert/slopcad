/**
 * The workbench's pattern & mirror wiring (Phase 43): the document readers
 * and validation seams for the three workbench-authored pattern features —
 * the pattern editor's asymmetric leg array with its skip-instance list
 * (`patternFeature`), the sketch-path distribution (`patternPath`), and
 * the datum-plane mirror with its merge option (`mirror`). Each mirrors
 * the bridge executor's own composition as the worker-scene matrix the
 * session executes, and each targets the document's LAST EXTRUDE (the
 * thread/rib precedent: the workbench's base solid).
 *
 * The ONE-SOURCE-OF-TRUTH planners are the kernel package's own: the leg
 * grid rides `planArrayPatternInstances`, the path stations ride
 * `sweepPathStationAt`/`sweepPathTotalLength` (`@slopcad/cad-kernel`'s
 * path-geometry walk), and the reflection rides `planDatumMirror` — the
 * bridge and the scene compose identical arrangements by construction
 * (the `planHoleCut`/`planSplitCut` precedent).
 */

import type {
  AnyDimensionalValue,
  CadDocument,
  FeatureRecord,
  TopologyEntityReference,
} from "@slopcad/cad-core";
import type { ArrayPatternLeg } from "@slopcad/cad-kernel";
import type { SweepPathSegmentInput } from "@slopcad/cad-kernel";
import {
  PATTERN_COUNT_LIMIT,
  sweepPathProblem,
  sweepPathStationAt,
  sweepPathTotalLength,
} from "@slopcad/cad-kernel";

import { resolveSessionDatumAxis, resolveSessionDatumPlane } from "./datum";
import {
  documentExtrudeRequest,
  sceneOperandOfBody,
  type ExtrudeSceneRequest,
  type SceneOperand,
} from "./extrude";
import { magnitudeIn, parameterValueOf } from "./parameter-magnitude";
import { sketchPathResolverOf } from "./sweep";
import { topologyCutTargetBodyIdOf, topologyReferenceOf } from "./topology-cut";

/** The pattern editor's authoring numbers, in the feature's leg order. */
export interface PatternLegInput {
  /** The direction angle (degrees, counter-clockwise in the world XY plane). */
  readonly directionDeg: number;
  /** The copies along this leg (a whole number ≥ 2). */
  readonly count: number;
  /** The spacing between neighbouring copies (mm, > 0). */
  readonly spacingMm: number;
}

/** The pattern editor's full submission: the legs plus the skip list. */
export interface PatternFeatureInput {
  readonly legs: readonly PatternLegInput[];
  /** The instance ordinals to skip (0 = the untranslated group). */
  readonly skips: readonly number[];
}

/** The editor's defaults: a 3 × 20 mm row along +x, nothing skipped. */
export const PATTERN_DEFAULTS: PatternFeatureInput = {
  legs: [{ directionDeg: 0, count: 3, spacingMm: 20 }],
  skips: [],
};

/**
 * The circular pattern's total-angle ceiling — the bridge's own domain
 * (core-bridge's `FULL_CIRCLE_RAD + ANGLE_DOMAIN_TOLERANCE_RAD`): the
 * sweep is `(0, 2π]`, the 1e-9 float round-trip slack included.
 */
const PATTERN_TOTAL_ANGLE_MAX_RAD = Math.PI * 2 + 1e-9;

/** The path pattern's authoring numbers. */
export interface PatternPathInput {
  /** The count of instances distributed along the chain (≥ 2). */
  readonly count: number;
  /** The arc-length step between instances (mm, > 0). */
  readonly spacingMm: number;
  /**
   * 1 = fixed orientation, 2 = tangent-follow. The VALIDATION seam types
   * this as a bare number (a re-driven parameter may hold anything); the
   * scene request narrows to `1 | 2` after the seam's own refusal.
   */
  readonly orientation: number;
}

/** The path-pattern form's defaults: four copies every 10 mm, fixed. */
export const PATTERN_PATH_DEFAULTS: PatternPathInput = {
  count: 4,
  spacingMm: 10,
  orientation: 1,
};

/** The mirror form's authoring numbers. */
export interface MirrorInput {
  /**
   * 1 = standalone copy, 2 = merge with the original. The VALIDATION seam
   * types this as a bare number (a re-driven parameter may hold
   * anything); the scene request narrows to `1 | 2` after the seam's own
   * refusal.
   */
  readonly merge: number;
}

/** The mirror form's defaults: the standalone reflection. */
export const MIRROR_DEFAULTS: MirrorInput = { merge: 1 };

/** The outcome of one validation attempt (the structured refusal). */
export type PatternValidation =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: string; readonly message: string };

/** Refuses the impossible leg submissions BEFORE any commit. */
function validateLeg(leg: PatternLegInput, index: number): PatternValidation {
  if (!Number.isFinite(leg.directionDeg)) {
    return {
      ok: false,
      code: "kernel/parameter-invalid",
      message: `Leg ${String(index + 1)}'s direction must be a finite angle in degrees (got ${String(leg.directionDeg)}).`,
    };
  }
  if (!Number.isInteger(leg.count) || leg.count < 2) {
    return {
      ok: false,
      code: "kernel/parameter-invalid",
      message: `Leg ${String(index + 1)}'s count must be a whole number of at least 2 (got ${String(leg.count)}) — a leg of one copy is no leg.`,
    };
  }
  if (!(leg.spacingMm > 0)) {
    return {
      ok: false,
      code: "kernel/parameter-invalid",
      message: `Leg ${String(index + 1)}'s spacing must be strictly positive (got ${String(leg.spacingMm)} mm).`,
    };
  }
  return { ok: true };
}

/**
 * Refuses the impossible pattern submissions BEFORE any commit: the leg
 * battery above, plus the skip list's domain (whole ordinals, no
 * duplicates, not skipping every instance) and the total-instance guard
 * (the bridge's own synchronous-regeneration limit).
 */
export function validatePatternSubmission(
  input: PatternFeatureInput,
): PatternValidation {
  if (input.legs.length < 1) {
    return {
      ok: false,
      code: "kernel/feature-input-invalid",
      message:
        "A pattern needs at least one leg (a direction, count, and spacing).",
    };
  }
  let total = 1;
  for (const [index, leg] of input.legs.entries()) {
    const legOutcome = validateLeg(leg, index);
    if (!legOutcome.ok) return legOutcome;
    total *= leg.count;
  }
  if (total > 1000) {
    return {
      ok: false,
      code: "kernel/parameter-invalid",
      message: `The pattern's total instance count (the legs' product) must be at most 1000 (got ${String(total)}) — regeneration issues one kernel transform per copy synchronously.`,
    };
  }
  const seen = new Set<number>();
  for (const skip of input.skips) {
    if (!Number.isInteger(skip) || skip < 0 || skip >= total) {
      return {
        ok: false,
        code: "kernel/parameter-invalid",
        message: `Skip ordinals must be whole instance numbers in [0, ${String(total)}) (got ${String(skip)}) — a skip that addresses no instance is a stale authoring artifact.`,
      };
    }
    if (seen.has(skip)) {
      return {
        ok: false,
        code: "kernel/parameter-invalid",
        message: `Instance ${String(skip)} is skipped more than once — a duplicate skip is an authoring error.`,
      };
    }
    seen.add(skip);
  }
  if (input.skips.length >= total) {
    return {
      ok: false,
      code: "kernel/parameter-invalid",
      message: `The pattern skips every one of its ${String(total)} instances — nothing would remain.`,
    };
  }
  return { ok: true };
}

/** Refuses the impossible path-pattern submissions BEFORE any commit. */
export function validatePatternPathSubmission(
  input: PatternPathInput,
): PatternValidation {
  if (!Number.isInteger(input.count) || input.count < 2) {
    return {
      ok: false,
      code: "kernel/parameter-invalid",
      message: `The instance count must be a whole number of at least 2 (got ${String(input.count)}) — a pattern of one copy is no pattern.`,
    };
  }
  if (!(input.spacingMm > 0)) {
    return {
      ok: false,
      code: "kernel/parameter-invalid",
      message: `The spacing must be strictly positive (got ${String(input.spacingMm)} mm).`,
    };
  }
  if (input.orientation !== 1 && input.orientation !== 2) {
    return {
      ok: false,
      code: "kernel/parameter-invalid",
      message: "The orientation must be 1 (fixed) or 2 (tangent-follow).",
    };
  }
  return { ok: true };
}

/** Refuses the impossible mirror submissions BEFORE any commit. */
export function validateMirrorSubmission(
  input: MirrorInput,
): PatternValidation {
  if (input.merge !== 1 && input.merge !== 2) {
    return {
      ok: false,
      code: "kernel/parameter-invalid",
      message:
        "The merge option must be 1 (standalone copy) or 2 (merge with the original).",
    };
  }
  return { ok: true };
}

/**
 * The document's LAST extrude feature — the solid the next pattern repeats
 * (the thread/rib precedent: the workbench's base solid).
 */
export function patternTargetFeatureOf(
  document: CadDocument,
): FeatureRecord | undefined {
  const bases = document.features.filter((entry) => entry.kind === "extrude");
  return bases[bases.length - 1];
}

/** The worker-scene payload one patternFeature feature executes as. */
export interface PatternFeatureSceneRequest {
  /** The base extrusion every instance repeats. */
  readonly base: ExtrudeSceneRequest;
  /** The leg grid (the bridge's own planner consumes these verbatim). */
  readonly legs: readonly ArrayPatternLeg[];
  /** The instance ordinals to skip. */
  readonly skips: readonly number[];
  /** The feature's output body id (the rendered body). */
  readonly bodyId: string;
}

/**
 * Reads the document's FIRST patternFeature feature into its worker-scene
 * request, parsing its parameters with the bridge's own greedy leg rule
 * (leading (direction, count, spacing) triples, then the trailing skip
 * ordinals). `null` when the document carries none, the base no longer
 * resolves, or a parameter no longer reads — callers render the prior
 * scene rather than fabricate geometry.
 */
export function documentPatternFeatureSceneRequest(
  document: CadDocument,
): PatternFeatureSceneRequest | null {
  const feature = document.features.find(
    (entry) => entry.kind === "patternFeature",
  );
  if (feature === undefined) return null;
  const bodyId = feature.outputs[0];
  if (bodyId === undefined) return null;
  const parameterRefs = feature.inputs.filter(
    (ref) => ref.kind === "parameter",
  );
  const valueOf = (index: number): AnyDimensionalValue | undefined => {
    const ref = parameterRefs[index];
    if (ref === undefined || ref.kind !== "parameter") return undefined;
    return document.parameters.parameters.find((entry) => entry.id === ref.id)
      ?.value;
  };
  const legs: ArrayPatternLeg[] = [];
  let cursor = 0;
  while (
    valueOf(cursor)?.dimension === "angle" &&
    valueOf(cursor + 1)?.dimension === "dimensionless" &&
    valueOf(cursor + 2)?.dimension === "length"
  ) {
    const direction = magnitudeIn(valueOf(cursor), "angle", "rad");
    const count = magnitudeIn(valueOf(cursor + 1), "dimensionless", "1");
    const spacing = magnitudeIn(valueOf(cursor + 2), "length", "mm");
    if (direction === null || count === null || spacing === null) return null;
    legs.push({ directionRad: direction, count, spacingMm: spacing });
    cursor += 3;
  }
  if (legs.length === 0) return null;
  const skips: number[] = [];
  for (; cursor < parameterRefs.length; cursor += 1) {
    const skip = magnitudeIn(valueOf(cursor), "dimensionless", "1");
    if (skip === null || !Number.isInteger(skip)) return null;
    skips.push(skip);
  }
  const base = documentExtrudeRequest(document);
  if (base === null) return null;
  return { base, legs, skips, bodyId };
}

/** The worker-scene payload one patternPath feature executes as. */
export interface PatternPathSceneRequest {
  /** The base extrusion every instance repeats. */
  readonly base: ExtrudeSceneRequest;
  /** The resolved path chain (the kernel contract's local XZ vocabulary). */
  readonly path: readonly SweepPathSegmentInput[];
  /** The instance count. */
  readonly count: number;
  /** The arc-length step between instances (mm). */
  readonly spacingMm: number;
  /** 1 = fixed orientation, 2 = tangent-follow. */
  readonly orientation: 1 | 2;
  /** The feature's output body id (the rendered body). */
  readonly bodyId: string;
}

/**
 * Reads the document's FIRST patternPath feature into its worker-scene
 * request, resolving the path sketch through the same seam the executor
 * bridge rides. `null` when the document carries none, the sketch or the
 * base no longer resolves, or a parameter no longer reads.
 */
export function documentPatternPathSceneRequest(
  document: CadDocument,
): PatternPathSceneRequest | null {
  const feature = document.features.find(
    (entry) => entry.kind === "patternPath",
  );
  if (feature === undefined) return null;
  const bodyId = feature.outputs[0];
  const sketchRef = feature.inputs.find((ref) => ref.kind === "sketch");
  const parameterRefs = feature.inputs.filter(
    (ref) => ref.kind === "parameter",
  );
  if (
    bodyId === undefined ||
    sketchRef === undefined ||
    sketchRef.kind !== "sketch" ||
    parameterRefs.length !== 3
  ) {
    return null;
  }
  const count = magnitudeIn(
    document.parameters.parameters.find(
      (entry) => entry.id === parameterRefs[0]?.id,
    )?.value,
    "dimensionless",
    "1",
  );
  const spacing = magnitudeIn(
    document.parameters.parameters.find(
      (entry) => entry.id === parameterRefs[1]?.id,
    )?.value,
    "length",
    "mm",
  );
  const orientation = magnitudeIn(
    document.parameters.parameters.find(
      (entry) => entry.id === parameterRefs[2]?.id,
    )?.value,
    "dimensionless",
    "1",
  );
  if (
    count === null ||
    spacing === null ||
    orientation === null ||
    (orientation !== 1 && orientation !== 2)
  ) {
    return null;
  }
  const path = sketchPathResolverOf(document)(sketchRef.id);
  if (!path.ok) return null;
  const base = documentExtrudeRequest(document);
  if (base === null) return null;
  return {
    base,
    path: path.value.path,
    count,
    spacingMm: spacing,
    orientation,
    bodyId,
  };
}

/** The worker-scene payload one datum-plane mirror feature executes as. */
export interface MirrorSceneRequest {
  /** The base extrusion the feature reflects. */
  readonly base: ExtrudeSceneRequest;
  /** The resolved datum plane (the mirror's fixed plane). */
  readonly plane: {
    readonly origin: readonly [number, number, number];
    readonly normal: readonly [number, number, number];
  };
  /** 1 = standalone copy, 2 = merge with the original. */
  readonly merge: 1 | 2;
  /** The feature's output body id (the rendered body). */
  readonly bodyId: string;
}

/**
 * Reads the document's FIRST datum-form mirror feature into its
 * worker-scene request, resolving the datum plane through the session's
 * plane seam (the split reader's discipline — an unresolvable datum
 * declines the whole request, never a silent world-plane fallback).
 * `null` when the document carries none, the plane no longer resolves,
 * or the merge option no longer reads.
 */
export function documentMirrorSceneRequest(
  document: CadDocument,
): MirrorSceneRequest | null {
  const feature = document.features.find((entry) => entry.kind === "mirror");
  if (feature === undefined) return null;
  const bodyId = feature.outputs[0];
  const datumRef = feature.inputs.find((ref) => ref.kind === "datum");
  const parameterRefs = feature.inputs.filter(
    (ref) => ref.kind === "parameter",
  );
  if (
    bodyId === undefined ||
    datumRef === undefined ||
    datumRef.kind !== "datum" ||
    parameterRefs.length > 1
  ) {
    return null;
  }
  let merge: 1 | 2 = 1;
  if (parameterRefs.length === 1) {
    const value = magnitudeIn(
      document.parameters.parameters.find(
        (entry) => entry.id === parameterRefs[0]?.id,
      )?.value,
      "dimensionless",
      "1",
    );
    if (value !== 1 && value !== 2) return null;
    merge = value;
  }
  const resolved = resolveSessionDatumPlane(document, datumRef.id);
  if (!resolved.ok) return null;
  const base = documentExtrudeRequest(document);
  if (base === null) return null;
  return {
    base,
    plane: {
      origin: [resolved.origin[0], resolved.origin[1], resolved.origin[2]],
      normal: [resolved.normal[0], resolved.normal[1], resolved.normal[2]],
    },
    merge,
    bodyId,
  };
}

/** The transform patterns' resolved copy step (the bridge's own semantics). */
export type PatternTransformPlan =
  | {
      readonly kind: "linear";
      /** Copies along the direction, count ≥ 2 (the target is instance 0). */
      readonly count: number;
      /** The spacing between neighbouring copies (mm, > 0). */
      readonly spacingMm: number;
      /** The unit direction the copies march along. */
      readonly direction: readonly [number, number, number];
    }
  | {
      readonly kind: "circular";
      /** Copies around the axis, count ≥ 2 (the target is instance 0). */
      readonly count: number;
      /** The pattern's total sweep in radians (step = total ÷ count). */
      readonly totalAngleRad: number;
      /** The rotation axis's unit direction. */
      readonly axis: readonly [number, number, number];
      /** A point on the rotation axis (the world origin for the
       * compat axis-selector form, the datum's origin for the
       * datum-axis form). */
      readonly axisOrigin: readonly [number, number, number];
    };

/** The worker-scene payload one patternLinear/patternCircular executes as. */
export interface PatternTransformSceneRequest {
  /** The repeated solid's source (the feature's feature/body target). */
  readonly target: SceneOperand;
  /** The resolved copy plan. */
  readonly pattern: PatternTransformPlan;
  /** The feature's output body id (the rendered body). */
  readonly bodyId: string;
}

/**
 * Reads EVERY patternLinear/patternCircular feature into its
 * worker-scene request — the real-CAD forms the bridge validates:
 * three parameters (count, spacing/totalAngle, direction/axis) in the
 * compat forms, two parameters plus one direction input in the
 * datum-axis and sketch-line forms. The target resolves through the
 * shared operand seam (a plain extrusion re-derives, a composition's
 * output rides the computed pass) — a pattern may repeat ANY solid,
 * not only the last extrude. A feature whose target, plan, or
 * direction no longer resolves is skipped honestly, whole — the other
 * patterns still render.
 */
export function documentPatternTransformSceneRequests(
  document: CadDocument,
): readonly PatternTransformSceneRequest[] {
  const requests: PatternTransformSceneRequest[] = [];
  const byId = new Map(document.features.map((entry) => [entry.id, entry]));
  for (const feature of document.features) {
    if (
      feature.kind !== "patternLinear" &&
      feature.kind !== "patternCircular"
    ) {
      continue;
    }
    const bodyId = feature.outputs[0];
    const targetRefs = feature.inputs.filter(
      (ref) => ref.kind === "feature" || ref.kind === "body",
    );
    const parameterRefs = feature.inputs.filter(
      (ref) => ref.kind === "parameter",
    );
    const datumRefs = feature.inputs.filter((ref) => ref.kind === "datum");
    const sketchRefs = feature.inputs.filter((ref) => ref.kind === "sketch");
    if (bodyId === undefined || targetRefs.length !== 1) continue;
    const targetRef = targetRefs[0];
    if (targetRef === undefined) continue;
    const targetBodyId =
      targetRef.kind === "body"
        ? targetRef.id
        : (byId.get(targetRef.id)?.outputs[0] ?? null);
    if (targetBodyId === null) continue;
    const target = sceneOperandOfBody(document, targetBodyId);
    if (target === null) continue;
    const parameterValue = (index: number) =>
      document.parameters.parameters.find(
        (entry) => entry.id === parameterRefs[index]?.id,
      )?.value;
    const count = magnitudeIn(parameterValue(0), "dimensionless", "1");
    // The bridge's count domain (core-bridge's pattern executor): a whole
    // number in [2, PATTERN_COUNT_LIMIT]. An out-of-domain pattern is a
    // refused feature — the scene must not compute it and present a
    // successful verdict over geometry regeneration rejected.
    if (
      count === null ||
      !Number.isInteger(count) ||
      count < 2 ||
      count > PATTERN_COUNT_LIMIT
    ) {
      continue;
    }
    const directionFromDatum = (): {
      readonly origin: readonly [number, number, number];
      readonly direction: readonly [number, number, number];
    } | null => {
      const datumRef = datumRefs[0];
      if (datumRef === undefined || datumRef.kind !== "datum") return null;
      const resolved = resolveSessionDatumAxis(document, datumRef.id);
      if (!resolved.ok) return null;
      return { origin: resolved.origin, direction: resolved.direction };
    };
    let pattern: PatternTransformPlan | null = null;
    if (feature.kind === "patternLinear") {
      const spacingMm = magnitudeIn(parameterValue(1), "length", "mm");
      // The bridge's linear domain: strictly positive spacing (zero or
      // negative stacks every copy and degenerates to the target).
      if (spacingMm === null || !(spacingMm > 0)) continue;
      if (datumRefs.length === 1 && parameterRefs.length === 2) {
        const axis = directionFromDatum();
        if (axis === null) continue;
        pattern = {
          kind: "linear",
          count,
          spacingMm,
          direction: axis.direction,
        };
      } else if (sketchRefs.length === 1 && parameterRefs.length === 2) {
        const sketchRef = sketchRefs[0];
        if (sketchRef === undefined || sketchRef.kind !== "sketch") continue;
        const path = sketchPathResolverOf(document)(sketchRef.id);
        if (!path.ok || sweepPathProblem(path.value.path) !== null) continue;
        const start = sweepPathStationAt(path.value.path, 0).point;
        const end = sweepPathStationAt(
          path.value.path,
          sweepPathTotalLength(path.value.path),
        ).point;
        const run: [number, number] = [end[0] - start[0], end[1] - start[1]];
        const norm = Math.hypot(run[0], run[1]);
        if (norm === 0) continue;
        pattern = {
          kind: "linear",
          count,
          spacingMm,
          direction: [run[0] / norm, 0, run[1] / norm],
        };
      } else {
        const directionRad = magnitudeIn(parameterValue(2), "angle", "rad");
        if (directionRad === null) continue;
        pattern = {
          kind: "linear",
          count,
          spacingMm,
          direction: [Math.cos(directionRad), Math.sin(directionRad), 0],
        };
      }
    } else {
      const totalAngleRad = magnitudeIn(parameterValue(1), "angle", "rad");
      // The bridge's circular domain: a strictly positive sweep of at most
      // one full turn (a longer sweep double-covers the circle).
      if (
        totalAngleRad === null ||
        !(totalAngleRad > 0) ||
        totalAngleRad > PATTERN_TOTAL_ANGLE_MAX_RAD
      ) {
        continue;
      }
      if (datumRefs.length === 1 && parameterRefs.length === 2) {
        const axis = directionFromDatum();
        if (axis === null) continue;
        pattern = {
          kind: "circular",
          count,
          totalAngleRad,
          axis: axis.direction,
          axisOrigin: axis.origin,
        };
      } else {
        const axisIndex = magnitudeIn(parameterValue(2), "dimensionless", "1");
        const axis: readonly [number, number, number] | undefined =
          axisIndex === 1
            ? [1, 0, 0]
            : axisIndex === 2
              ? [0, 1, 0]
              : axisIndex === 3
                ? [0, 0, 1]
                : undefined;
        if (axis === undefined) continue;
        pattern = {
          kind: "circular",
          count,
          totalAngleRad,
          axis,
          axisOrigin: [0, 0, 0],
        };
      }
    }
    if (pattern === null) continue;
    requests.push({ target, pattern, bodyId });
  }
  return requests;
}

/** The worker-scene payload one patternFace feature executes as. */
export interface PatternFaceSceneRequest {
  /** The repeated solid's source (the feature's feature/body target). */
  readonly target: SceneOperand;
  /** The target's body id — the snapshot label the reference resolves on. */
  readonly targetBodyId: string;
  /** The persistent bounding-face reference (resolved in the worker). */
  readonly face: TopologyEntityReference;
  /** The two grid legs, in declared order (the shared planner's input). */
  readonly legs: readonly [ArrayPatternLeg, ArrayPatternLeg];
  /** The feature's output body id (the rendered body). */
  readonly bodyId: string;
}

/**
 * Reads ONE patternFace leg triple at `cursor` (direction ANGLE, count
 * DIMENSIONLESS, spacing LENGTH), or `null` off the bridge's
 * `readArrayLeg` domain: a finite direction, a whole count of at least 2,
 * a positive finite spacing.
 */
function patternFaceLegOf(
  values: readonly (AnyDimensionalValue | undefined)[],
  cursor: number,
): ArrayPatternLeg | null {
  const directionRad = magnitudeIn(values[cursor], "angle", "rad");
  const count = magnitudeIn(values[cursor + 1], "dimensionless", "1");
  const spacingMm = magnitudeIn(values[cursor + 2], "length", "mm");
  if (directionRad === null || count === null || spacingMm === null) {
    return null;
  }
  if (!Number.isInteger(count) || count < 2) return null;
  if (spacingMm <= 0) return null;
  return { directionRad, count, spacingMm };
}

/**
 * Reads ONE patternFace feature into its worker-scene request, in the
 * bridge's canonical layout (`runPatternFaceOperation`): EXACTLY one
 * feature/body target, EXACTLY one FACE reference addressing the target's
 * own body (the shared battery, `./topology-cut`'s `topologyReferenceOf`),
 * and EXACTLY six parameters — two direction/count/spacing leg triples —
 * whose grid total stays within `PATTERN_COUNT_LIMIT`. `null` on any
 * breach (the refused feature renders nothing); the face's plane, its
 * tessellated region, and the at-least-two-qualifying-points rule resolve
 * against the target's CURRENT solid in the worker
 * (`../worker-fixture/pattern-scene`).
 */
export function patternFaceSceneRequestOfFeature(
  document: CadDocument,
  feature: FeatureRecord,
): PatternFaceSceneRequest | null {
  if (feature.kind !== "patternFace") return null;
  const bodyId = feature.outputs[0];
  if (bodyId === undefined || feature.outputs.length !== 1) return null;
  const targetBodyId = topologyCutTargetBodyIdOf(document, feature);
  if (targetBodyId === null || targetBodyId === bodyId) return null;
  const referenceRefs = feature.inputs.filter(
    (ref) => ref.kind === "reference",
  );
  const faceRef = referenceRefs[0];
  if (referenceRefs.length !== 1 || faceRef === undefined) return null;
  const face = topologyReferenceOf(document, faceRef.id, "face", targetBodyId);
  if (face === null) return null;
  const parameterRefs = feature.inputs.filter(
    (ref) => ref.kind === "parameter",
  );
  if (parameterRefs.length !== 6) return null;
  const values = parameterRefs.map((ref) => parameterValueOf(document, ref.id));
  const legOne = patternFaceLegOf(values, 0);
  const legTwo = patternFaceLegOf(values, 3);
  if (legOne === null || legTwo === null) return null;
  if (legOne.count * legTwo.count > PATTERN_COUNT_LIMIT) return null;
  const target = sceneOperandOfBody(document, targetBodyId);
  if (target === null) return null;
  return { target, targetBodyId, face, legs: [legOne, legTwo], bodyId };
}

/**
 * Reads EVERY patternFace feature of the document into its worker-scene
 * request, in document order. A feature whose target, layout, or domain
 * no longer resolves is skipped honestly — the other patterns still
 * render.
 */
export function documentPatternFaceSceneRequests(
  document: CadDocument,
): readonly PatternFaceSceneRequest[] {
  const requests: PatternFaceSceneRequest[] = [];
  for (const feature of document.features) {
    const request = patternFaceSceneRequestOfFeature(document, feature);
    if (request !== null) requests.push(request);
  }
  return requests;
}
