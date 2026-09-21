/**
 * The workbench's loft wiring (Phase 38): the loft sibling of `./sweep` —
 * ordered section sketch records plus their station-z length parameters,
 * the document model → kernel contract bridge for the sections → loft →
 * solid workflow.
 *
 * ## The station model (documented)
 *
 * A loft's sections must share ONE workplane frame (the contract's
 * one-placement rule), and each section sits at its station `z` along the
 * frame's normal. The workbench authors sections on the SAME sketch
 * workplane (every sketch record the sketch mode saves carries it) and
 * models the stations as LENGTH document parameters, one per section in the
 * feature's declared input order — the pattern/hole parameter-roles
 * precedent. `parameter.set` on a station re-drives the loft through
 * regeneration, exactly like an extrude depth or a hole diameter.
 *
 * ## The action's validation seam
 *
 * {@link validateLoftSubmission} refuses, before anything is committed: a
 * collection of fewer than two sections; sections on differing workplane
 * frames (the placement-equality rule the bridge enforces, mirrored here so
 * the refusal happens at the form); and non-strictly-increasing stations
 * (the kernel's `kernel/loft-unordered-stations` rule, surfaced with the
 * same code at the action).
 */

import {
  valueIn,
  type AnyDimensionalValue,
  type CadDocument,
} from "@slopcad/cad-core";
import type {
  ProfileExtrudeInput,
  ProfileLoftInput,
} from "@slopcad/cad-kernel";

import { sketchProfileResolverOf } from "./extrude";

/** The default station spacing the loft form seeds new sections with (mm). */
export const LOFT_DEFAULT_STATION_STEP_MM = 20;

/** One authored section of a loft submission: sketch reference + station. */
export interface LoftSectionChoice {
  /** The document sketch record id resolving to this section's loop. */
  readonly sketchId: string;
  /** The section's station z, in millimetres. */
  readonly stationMm: number;
}

/** The outcome of one loft validation attempt (the structured refusal). */
export type LoftValidation =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: string; readonly message: string };

/** Canonical placement-equality tolerance (the bridge's own constant). */
const PLACEMENT_EQUALITY_TOLERANCE = 1e-9;

function placementMatches(
  a: ProfileExtrudeInput["placement"],
  b: ProfileExtrudeInput["placement"],
): boolean {
  const axisA = a.rotation.axis;
  const axisB = b.rotation.axis;
  const sameAxis =
    axisA.length === axisB.length &&
    axisA.every((component, index) => component === (axisB[index] ?? NaN));
  if (
    !sameAxis ||
    Math.abs(
      valueIn(a.rotation.angle, "rad") - valueIn(b.rotation.angle, "rad"),
    ) > PLACEMENT_EQUALITY_TOLERANCE
  ) {
    return false;
  }
  return (
    Math.abs(valueIn(a.translation.x, "mm") - valueIn(b.translation.x, "mm")) <=
      PLACEMENT_EQUALITY_TOLERANCE &&
    Math.abs(valueIn(a.translation.y, "mm") - valueIn(b.translation.y, "mm")) <=
      PLACEMENT_EQUALITY_TOLERANCE &&
    Math.abs(valueIn(a.translation.z, "mm") - valueIn(b.translation.z, "mm")) <=
      PLACEMENT_EQUALITY_TOLERANCE
  );
}

function lengthParameterMm(value: AnyDimensionalValue): number | null {
  return value.dimension === "length" ? valueIn(value, "mm") : null;
}

/**
 * Validates a loft submission before any commit: at least two sections, all
 * resolving on the FIRST section's workplane frame, stations strictly
 * increasing along the list. Refusals carry the kernel's structured codes.
 */
export function validateLoftSubmission(input: {
  readonly sections: readonly {
    readonly choice: LoftSectionChoice;
    readonly placement: ProfileExtrudeInput["placement"];
  }[];
}): LoftValidation {
  const { sections } = input;
  if (sections.length < 2) {
    return {
      ok: false,
      code: "kernel/invalid-operands",
      message:
        "A loft needs at least two section sketches; pick two or more in order.",
    };
  }
  const first = sections[0];
  if (first === undefined) {
    return {
      ok: false,
      code: "kernel/invalid-operands",
      message: "A loft needs at least two section sketches.",
    };
  }
  for (let index = 1; index < sections.length; index += 1) {
    const section = sections[index];
    if (section === undefined) continue;
    if (!placementMatches(first.placement, section.placement)) {
      return {
        ok: false,
        code: "kernel/feature-input-invalid",
        message: `Section ${String(index + 1)} ("${section.choice.sketchId}") resolves on a different workplane frame than section 1; a loft places all sections through ONE frame — sketch the sections on a shared workplane.`,
      };
    }
  }
  for (let index = 1; index < sections.length; index += 1) {
    const previous = sections[index - 1];
    const section = sections[index];
    if (previous === undefined || section === undefined) continue;
    if (!(section.choice.stationMm > previous.choice.stationMm)) {
      return {
        ok: false,
        code: "kernel/loft-unordered-stations",
        message: `Stations must strictly increase along the section order: section ${String(index)} is at ${String(previous.choice.stationMm)} mm but section ${String(index + 1)} is at ${String(section.choice.stationMm)} mm.`,
      };
    }
  }
  return { ok: true };
}

/** The worker-scene payload one loft feature executes as. */
export interface LoftSceneRequest {
  /** The ordered sections: loop + station z (mm). */
  readonly sections: readonly {
    readonly loop: ProfileLoftInput["sections"][number]["loop"];
    readonly zMm: number;
  }[];
  /** The placement from the FIRST section (the one-frame rule). */
  readonly placement: ProfileLoftInput["placement"];
  /** The loft feature's output body id (the rendered body). */
  readonly bodyId: string;
}

/**
 * Reads the document's FIRST loft feature into its worker-scene request.
 * Sections come from the feature's sketch inputs in declared order, each
 * with its station parameter (matched by declared position among the
 * parameter inputs — the bridge's layout). `null` when the feature's inputs
 * no longer resolve — callers render the prior scene rather than fabricate
 * geometry.
 */
export function documentLoftRequest(
  document: CadDocument,
): LoftSceneRequest | null {
  const feature = document.features.find((entry) => entry.kind === "loft");
  if (feature === undefined) return null;
  const sketchRefs = feature.inputs.filter((ref) => ref.kind === "sketch");
  const parameterRefs = feature.inputs.filter(
    (ref) => ref.kind === "parameter",
  );
  const bodyId = feature.outputs[0];
  if (
    sketchRefs.length < 2 ||
    parameterRefs.length !== sketchRefs.length ||
    bodyId === undefined
  ) {
    return null;
  }
  const resolveProfile = sketchProfileResolverOf(document);
  const sections: {
    readonly loop: ProfileLoftInput["sections"][number]["loop"];
    readonly zMm: number;
  }[] = [];
  let placement: ProfileExtrudeInput["placement"] | null = null;
  for (let index = 0; index < sketchRefs.length; index += 1) {
    const sketchRef = sketchRefs[index];
    const parameterRef = parameterRefs[index];
    if (sketchRef === undefined || parameterRef === undefined) return null;
    if (sketchRef.kind !== "sketch" || parameterRef.kind !== "parameter") {
      return null;
    }
    const parameter = document.parameters.parameters.find(
      (candidate) => candidate.id === parameterRef.id,
    );
    if (parameter === undefined) return null;
    const stationMm = lengthParameterMm(parameter.value);
    if (stationMm === null) return null;
    const resolved = resolveProfile(sketchRef.id);
    if (!resolved.ok) return null;
    if (placement === null) placement = resolved.value.placement;
    sections.push({ loop: resolved.value.loop, zMm: stationMm });
  }
  if (placement === null) return null;
  return { sections, placement, bodyId };
}
