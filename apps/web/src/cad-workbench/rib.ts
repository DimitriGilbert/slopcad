/**
 * The workbench's rib wiring (Phase 41): the document reader and validation
 * seam for the rib feature — the rib sibling of `./thread`. The feature
 * targets the document's LAST EXTRUDE (the thread/hole precedent: the
 * workbench's base solid), carries its thickness as one length parameter,
 * and takes its closed cross-section from a SAVED sketch (the sweep form's
 * saved-pool precedent): the rib is that profile extruded symmetrically by
 * the thickness about the sketch's own workplane and unioned with the
 * target — the bridge's `runRibOperation` composition, mirrored here as
 * the worker-scene matrix the session executes.
 *
 * The composition's no-op post-condition rides the computation REJECTION
 * (the thread scene's carrier): a rib that added nothing never settles.
 */

import { valueIn, type AnyDimensionalValue } from "@slopcad/cad-core";
import type { FeatureRecord } from "@slopcad/cad-core";

import {
  documentExtrudeRequest,
  sketchProfileResolverOf,
  type ExtrudeSceneRequest,
} from "./extrude";

/** One rib's authoring number, in the feature's declared parameter order. */
export interface RibCutInput {
  readonly thicknessMm: number;
}

/** The form's defaults: a 2 mm rib. */
export const RIB_DEFAULTS: RibCutInput = { thicknessMm: 2 };

/** The outcome of one rib validation attempt (the structured refusal). */
export type RibValidation =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: string; readonly message: string };

/**
 * Refuses the impossible rib submissions BEFORE any commit (the thread
 * action's validation seam): a non-positive thickness extrudes nothing.
 */
export function validateRibSubmission(input: RibCutInput): RibValidation {
  if (!(input.thicknessMm > 0)) {
    return {
      ok: false,
      code: "kernel/parameter-invalid",
      message: `The rib's thickness must be strictly positive (got ${String(input.thicknessMm)} mm).`,
    };
  }
  return { ok: true };
}

/**
 * The document's LAST extrude feature — the solid the next rib grows from
 * (the thread precedent: the workbench's base solid).
 */
export function ribTargetFeatureOf(
  document: Parameters<typeof documentExtrudeRequest>[0],
): FeatureRecord | undefined {
  const bases = document.features.filter((entry) => entry.kind === "extrude");
  return bases[bases.length - 1];
}

/** The worker-scene payload the document's rib feature executes as. */
export interface RibSceneRequest {
  /** The base extrusion the rib merges with. */
  readonly base: ExtrudeSceneRequest;
  /** The rib profile's closed loop (kernel contract form). */
  readonly loop: ExtrudeSceneRequest["loop"];
  /** The rib profile's workplane placement (the rib's symmetry plane). */
  readonly placement: ExtrudeSceneRequest["placement"];
  /** The rib thickness (mm) — the symmetric extrusion pair's total. */
  readonly thicknessMm: number;
  /** The rib feature's output body id (the rendered body). */
  readonly bodyId: string;
}

/** Reads a parameter's canonical magnitude, or `null` off-dimension. */
function magnitudeIn(
  value: AnyDimensionalValue | undefined,
  dimension: "length",
  unit: "mm",
): number | null {
  if (value === undefined || value.dimension !== dimension) return null;
  const magnitude = valueIn(value, unit);
  return Number.isFinite(magnitude) ? magnitude : null;
}

/**
 * Reads the document's FIRST rib feature into its worker-scene request,
 * pairing it with the base extrusion its target names (the last extrude —
 * the engine's create action guarantees the pairing). `null` when the
 * document carries no rib feature, the base no longer resolves, the
 * profile sketch no longer resolves, or the thickness no longer reads —
 * callers render the prior scene rather than fabricate geometry.
 */
export function documentRibSceneRequest(
  document: Parameters<typeof documentExtrudeRequest>[0],
): RibSceneRequest | null {
  const feature = document.features.find((entry) => entry.kind === "rib");
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
    parameterRefs.length !== 1
  ) {
    return null;
  }
  const parameter = document.parameters.parameters.find(
    (entry) => entry.id === parameterRefs[0]?.id,
  );
  const thickness = magnitudeIn(parameter?.value, "length", "mm");
  if (thickness === null || !(thickness > 0)) return null;
  const profile = sketchProfileResolverOf(document)(sketchRef.id);
  if (!profile.ok) return null;
  const base = documentExtrudeRequest(document);
  if (base === null) return null;
  return {
    base,
    loop: profile.value.loop,
    placement: profile.value.placement,
    thicknessMm: thickness,
    bodyId,
  };
}
