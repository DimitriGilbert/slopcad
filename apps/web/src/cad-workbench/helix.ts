/**
 * The workbench's helix wiring (Phase 40): the one module that bridges the
 * sketch domain, the document model, and the kernel contract for the
 * meridian-sketch → analytic-spine → screw-solid workflow — the helix
 * sibling of `./sweep`.
 *
 * ## The meridian mapping (documented)
 *
 * A helix feature consumes ONE sketch record (the meridian profile) and
 * SIX parameters (radius, pitch, turns, handedness, start angle, taper),
 * plus an optional datum axis input. The profile resolves through the
 * extrude seam for its LOOP only: sketch `(x, y)` becomes the helix
 * meridian `(u, v) = (radial, axial)` offset from the spine's start point
 * — coordinate identity, the sweep path-mapping precedent; the sketch's
 * own workplane does not carry (the helix frame is the spine's: the
 * world +z axis, or the datum axis's resolved line).
 *
 * ## The action's validation seam
 *
 * {@link validateHelixSubmission} runs the kernel contract's shared helix
 * battery BEFORE anything is committed — the sweep action's precedent:
 * spine degeneracy (`helixSweepProblem`), the axis-crossing rule, and the
 * turn-overlap check each refuse with the kernel's own structured code,
 * so a doomed helix never touches the document.
 */

import {
  angle as angleValue,
  length as lengthValue,
  valueIn,
  type AnyDimensionalValue,
} from "@slopcad/cad-core";
import type {
  HelixSweepInput,
  ProfilePlacementInput,
} from "@slopcad/cad-kernel";
import {
  helixSweepProblem,
  helixTurnsOverlap,
  rotationAligningZTo,
  type CanonicalHelixSpine,
} from "@slopcad/cad-kernel";

import { resolveSessionDatumAxis } from "./datum";
import { sketchProfileResolverOf } from "./extrude";

/** The helix authoring numbers the workbench's form collects. */
export interface HelixAuthoring {
  /** The spine's start radius (mm, strictly positive). */
  readonly radiusMm: number;
  /** The axial advance per turn (mm, non-negative). */
  readonly pitchMm: number;
  /** The turn count (strictly positive; fractional legal). */
  readonly turns: number;
  /** `+1` right-handed, `-1` left-handed. */
  readonly handedness: 1 | -1;
  /** The start angle (radians). */
  readonly startAngleRad: number;
  /** The total signed radius change (mm). */
  readonly taperMm: number;
}

/** The form's defaults: a right-handed 3-turn coil at radius 10, pitch 4. */
export const HELIX_DEFAULTS: HelixAuthoring = {
  radiusMm: 10,
  pitchMm: 4,
  turns: 3,
  handedness: 1,
  startAngleRad: 0,
  taperMm: 0,
};

/** The outcome of one helix validation attempt (the structured refusal). */
export type HelixValidation =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: string; readonly message: string };

/**
 * Runs the kernel contract's helix battery over the mapped loop + spine
 * BEFORE any commit (the sweep action's validation seam). Refusals carry
 * the kernel's own structured codes verbatim.
 */
export function validateHelixSubmission(input: {
  readonly loop: HelixSweepInput["loop"];
  readonly spine: CanonicalHelixSpine;
}): HelixValidation {
  const problem = helixSweepProblem(input.loop, input.spine);
  if (problem !== null) {
    return { ok: false, code: problem.code, message: problem.message };
  }
  if (helixTurnsOverlap(input.loop, input.spine)) {
    return {
      ok: false,
      code: "kernel/helix-turn-overlap",
      message:
        "The profile's axial extent exceeds one pitch over more than one turn, so consecutive turns' material overlaps — reduce the profile height or the turn count.",
    };
  }
  return { ok: true };
}

/** The canonical spine of one helix authoring (the form's numbers). */
export function helixSpineOf(authoring: HelixAuthoring): CanonicalHelixSpine {
  return {
    radiusMm: authoring.radiusMm,
    pitchMm: authoring.pitchMm,
    turns: authoring.turns,
    handedness: authoring.handedness,
    startAngleRad: authoring.startAngleRad,
    taperMm: authoring.taperMm,
  };
}

/** The placement of the world-frame helix (the no-datum default). */
export const WORLD_Z_HELIX_PLACEMENT: ProfilePlacementInput = {
  rotation: { axis: [0, 0, 1], angle: angleValue(0) },
  translation: {
    x: lengthValue(0),
    y: lengthValue(0),
    z: lengthValue(0),
  },
};

/**
 * The placement of a datum-axis frame: the deterministic rotation carrying
 * local +z onto the axis direction (the bridge's own construction, shared
 * through `rotationAligningZTo`), the translation at the axis origin.
 */
export function helixPlacementForAxis(
  origin: readonly [number, number, number],
  direction: readonly [number, number, number],
): ProfilePlacementInput {
  const rotation = rotationAligningZTo(direction);
  return {
    rotation: {
      axis: [rotation.axis[0], rotation.axis[1], rotation.axis[2]],
      angle: angleValue(rotation.angleRad),
    },
    translation: {
      x: lengthValue(origin[0]),
      y: lengthValue(origin[1]),
      z: lengthValue(origin[2]),
    },
  };
}

/** The worker-scene payload one helix feature executes as. */
export interface HelixSceneRequest {
  /** The meridian profile loop (kernel contract form). */
  readonly loop: HelixSweepInput["loop"];
  /** The analytic spine (kernel contract form). */
  readonly spine: HelixSweepInput["spine"];
  /** The placement (the datum axis's frame, or the world z default). */
  readonly placement: ProfilePlacementInput;
  /** The helix feature's output body id (the rendered body). */
  readonly bodyId: string;
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
 * Reads the document's FIRST helix feature into its worker-scene request,
 * resolving the profile sketch through the same seam the executor bridge
 * uses and the datum axis (when declared) through the session's axis
 * resolver. `null` when the document carries no helix feature or the
 * feature's inputs no longer resolve — callers render the prior scene
 * rather than fabricate geometry.
 */
export function documentHelixRequest(
  document: Parameters<typeof sketchProfileResolverOf>[0],
): HelixSceneRequest | null {
  const feature = document.features.find((entry) => entry.kind === "helix");
  if (feature === undefined) return null;
  const bodyId = feature.outputs[0];
  const sketchRef = feature.inputs.find((ref) => ref.kind === "sketch");
  const datumRef = feature.inputs.find((ref) => ref.kind === "datum");
  const parameterRefs = feature.inputs.filter(
    (ref) => ref.kind === "parameter",
  );
  if (
    bodyId === undefined ||
    sketchRef === undefined ||
    parameterRefs.length !== 6
  ) {
    return null;
  }
  const values = parameterRefs.map((ref) => {
    const parameter = document.parameters.parameters.find(
      (entry) => entry.id === ref.id,
    );
    return parameter === undefined ? undefined : parameter.value;
  });
  const radius = magnitudeIn(values[0], "length", "mm");
  const pitch = magnitudeIn(values[1], "length", "mm");
  const turns = magnitudeIn(values[2], "dimensionless", "1");
  const handedness = magnitudeIn(values[3], "dimensionless", "1");
  const startAngle = magnitudeIn(values[4], "angle", "rad");
  const taper = magnitudeIn(values[5], "length", "mm");
  if (
    radius === null ||
    pitch === null ||
    turns === null ||
    handedness === null ||
    startAngle === null ||
    taper === null ||
    (handedness !== 1 && handedness !== -1)
  ) {
    return null;
  }
  const profile = sketchProfileResolverOf(document)(sketchRef.id);
  if (!profile.ok) return null;
  let placement = WORLD_Z_HELIX_PLACEMENT;
  if (datumRef !== undefined) {
    const axis = resolveSessionDatumAxis(document, datumRef.id);
    if (!axis.ok) return null;
    placement = helixPlacementForAxis(axis.origin, axis.direction);
  }
  return {
    loop: profile.value.loop,
    spine: {
      radius: lengthValue(radius),
      pitch: lengthValue(pitch),
      turns,
      handedness,
      startAngle: angleValue(startAngle),
      taper: lengthValue(taper),
    },
    placement,
    bodyId,
  };
}
