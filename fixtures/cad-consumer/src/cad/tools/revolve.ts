import {
  angle,
  length,
  valueIn,
  type AnyDimensionalValue,
  type CadDocument,
  type FeatureRecord,
} from "@slopcad/cad-core";
import type {
  ProfileRevolveAxisInput,
  ProfileRevolveInput,
} from "@slopcad/cad-kernel";
import {
  normalizeRevolveAxis,
  revolveCrossesAxis,
  revolveSignedExtremes,
} from "@slopcad/cad-kernel";
import type {
  SerializedSketch,
  SketchEntity,
  Workplane,
} from "@slopcad/cad-sketch";
import {
  resolveExtrudeProfile,
  workplaneToPlacement,
} from "@slopcad/cad-sketch";

import { kernelSegment, sketchProfileResolverOf } from "./extrude";

/** The default sweep the action creates the sweep parameter with: a full turn. */
export const REVOLVE_DEFAULT_SWEEP_RAD = Math.PI * 2;

/** The workplane X axis selector's direction angle (rad, CCW from +x). */
export const REVOLVE_AXIS_X_RAD = 0;

/** The workplane Y axis selector's direction angle (rad, CCW from +x). */
export const REVOLVE_AXIS_Y_RAD = Math.PI / 2;

/** The submission a resolved revolve action hands to the host. */
export interface SketchRevolveSubmission {
  /** The canonical serialized sketch (stored as the document sketch record). */
  readonly sketch: SerializedSketch;
  /** The resolved profile loop in kernel-contract form. */
  readonly loop: ProfileRevolveInput["loop"];
  /** The workplane placement in kernel-contract form. */
  readonly placement: ProfileRevolveInput["placement"];
  /** The revolve axis line through the workplane origin. */
  readonly axis: ProfileRevolveAxisInput;
  /** The axis direction angle (rad) — the axis parameter's initial value. */
  readonly axisDirectionRad: number;
  /** The sweep (rad) — the sweep parameter's initial value. */
  readonly sweepRad: number;
}

/** The outcome of one revolve resolution attempt (the machine surface). */
export type RevolveResolution =
  | {
      readonly ok: true;
      readonly value: SketchRevolveSubmission;
    }
  | {
      readonly ok: false;
      readonly code: string;
      readonly message: string;
    };

/**
 * Resolves the sketch's entities against an axis direction (rad, CCW from
 * the workplane +x) into a revolve submission: the closed-loop resolution
 * first (the sketch domain's structured failures verbatim), then the
 * kernel's axis validation — crossing profiles refuse with
 * `kernel/profile-axis-crossing` before anything reaches the document.
 */
export function resolveRevolveSubmission(input: {
  readonly sketch: SerializedSketch;
  readonly entities: readonly SketchEntity[];
  readonly workplane: Workplane;
  readonly axisDirectionRad: number;
}): RevolveResolution {
  const { sketch, entities, workplane, axisDirectionRad } = input;
  const profile = resolveExtrudeProfile(entities);
  if (!profile.ok) {
    return {
      ok: false,
      code: profile.error.code,
      message: profile.error.message,
    };
  }
  const loop = profile.value.segments.map(kernelSegment);
  const axis: ProfileRevolveAxisInput = {
    point: [0, 0],
    direction: [Math.cos(axisDirectionRad), Math.sin(axisDirectionRad)],
  };
  const frame = normalizeRevolveAxis(axis);
  if (frame === null) {
    return {
      ok: false,
      code: "kernel/invalid-rotation",
      message: "The revolve axis direction is degenerate (zero or non-finite).",
    };
  }
  if (revolveCrossesAxis(loop, frame)) {
    const extremes = revolveSignedExtremes(loop, frame);
    return {
      ok: false,
      code: "kernel/profile-axis-crossing",
      message: `The profile crosses the revolve axis (signed distances span [${extremes.min.toFixed(3)}, ${extremes.max.toFixed(3)}] mm). Move the profile fully to one side of the axis; touching the axis is allowed.`,
    };
  }
  const placement = workplaneToPlacement(workplane);
  return {
    ok: true,
    value: {
      sketch,
      loop,
      placement: {
        rotation: {
          axis: placement.rotation.axis,
          angle: angle(placement.rotation.angleRad, "rad"),
        },
        translation: {
          x: length(placement.translation.x),
          y: length(placement.translation.y),
          z: length(placement.translation.z),
        },
      },
      axis,
      axisDirectionRad,
      sweepRad: REVOLVE_DEFAULT_SWEEP_RAD,
    },
  };
}

/** The worker-scene payload one revolve feature executes as. */
export interface RevolveSceneRequest {
  /** The closed profile loop (kernel contract form). */
  readonly loop: ProfileRevolveInput["loop"];
  /** The revolve axis line (kernel contract form). */
  readonly axis: ProfileRevolveAxisInput;
  /** The sweep angle in radians (contract domain (0, 2π]). */
  readonly angleRad: number;
  /** The placement (rotation axis/angle + translation). */
  readonly placement: ProfileRevolveInput["placement"];
  /** The revolve feature's output body id (the rendered body). */
  readonly bodyId: string;
}

function angleParameterRad(value: AnyDimensionalValue): number | null {
  return value.dimension === "angle" ? valueIn(value, "rad") : null;
}

/**
 * Reads ONE revolve feature into its worker-scene request, resolving the
 * profile through the same path the executor bridge uses. `null` when the
 * feature's inputs no longer resolve — callers render the prior scene
 * rather than fabricate geometry. The per-feature extraction the document
 * readers share (`documentRevolveRequest` here, the document-scene
 * builder's per-body requests in `./document-scene`).
 */
export function revolveSceneRequestOfFeature(
  document: CadDocument,
  feature: FeatureRecord,
): RevolveSceneRequest | null {
  const sketchRef = feature.inputs.find((ref) => ref.kind === "sketch");
  const parameterRefs = feature.inputs.filter(
    (ref) => ref.kind === "parameter",
  );
  const bodyId = feature.outputs[0];
  if (
    sketchRef === undefined ||
    sketchRef.kind !== "sketch" ||
    parameterRefs.length !== 2 ||
    bodyId === undefined
  ) {
    return null;
  }
  const sweepRef = parameterRefs[0];
  const axisRef = parameterRefs[1];
  if (sweepRef === undefined || axisRef === undefined) return null;
  const sweepParameter = document.parameters.parameters.find(
    (candidate) => candidate.id === sweepRef.id,
  );
  const axisParameter = document.parameters.parameters.find(
    (candidate) => candidate.id === axisRef.id,
  );
  if (sweepParameter === undefined || axisParameter === undefined) return null;
  const sweepRad = angleParameterRad(sweepParameter.value);
  const axisRad = angleParameterRad(axisParameter.value);
  if (sweepRad === null || axisRad === null) return null;
  const resolved = sketchProfileResolverOf(document)(sketchRef.id);
  if (!resolved.ok) return null;
  return {
    loop: resolved.value.loop,
    axis: {
      point: [0, 0],
      direction: [Math.cos(axisRad), Math.sin(axisRad)],
    },
    angleRad: sweepRad,
    placement: resolved.value.placement,
    bodyId,
  };
}

/**
 * Reads the document's first revolve feature into its worker-scene request.
 * `null` when the document carries no revolve feature or the feature's
 * inputs no longer resolve — callers render the prior scene rather than
 * fabricate geometry.
 */
export function documentRevolveRequest(
  document: CadDocument,
): RevolveSceneRequest | null {
  const feature = document.features.find((entry) => entry.kind === "revolve");
  if (feature === undefined) return null;
  return revolveSceneRequestOfFeature(document, feature);
}
