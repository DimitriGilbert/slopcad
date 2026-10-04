/**
 * The workbench's scale and thicken wiring (Phase 41): the document readers
 * and validation seams for the two single-parameter features — the direct
 * kernel transforms the bridge's `runScaleOperation`/`runThickenOperation`
 * compose, mirrored here as the worker-scene matrix the session executes.
 * Both target the document's LAST EXTRUDE (the thread/rib precedent: the
 * workbench's base solid), and each carries exactly one parameter (the
 * dimensionless factor; the length wall thickness).
 */

import { valueIn, type AnyDimensionalValue } from "@slopcad/cad-core";
import type { FeatureRecord } from "@slopcad/cad-core";

import { documentExtrudeRequest, type ExtrudeSceneRequest } from "./extrude";

/** The scale feature's authoring number. */
export interface ScaleInput {
  /** The uniform factor (dimensionless, strictly positive). */
  readonly factor: number;
}

/**
 * The form's scale submission (Phase 21): the factor is a literal number or
 * a `$name` reference to an existing document parameter.
 */
export interface ScaleInputRef {
  readonly factor: number | string;
}

/** The form's defaults: a uniform ×2. */
export const SCALE_DEFAULTS: ScaleInput = { factor: 2 };

/** The thicken feature's authoring number. */
export interface ThickenInput {
  /** The wall thickness (mm, strictly positive). */
  readonly thicknessMm: number;
}

/**
 * The form's thicken submission (Phase 21): the thickness is a literal
 * number or a `$name` reference to an existing document parameter.
 */
export interface ThickenInputRef {
  readonly thicknessMm: number | string;
}

/** The form's defaults: 2 mm walls. */
export const THICKEN_DEFAULTS: ThickenInput = { thicknessMm: 2 };

/** The outcome of one validation attempt (the structured refusal). */
export type FeatureRichnessValidation =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: string; readonly message: string };

/**
 * Refuses the impossible scale submissions BEFORE any commit: a
 * non-positive factor mirrors or annihilates the solid, and uniform
 * scaling is all the contract carries.
 */
export function validateScaleSubmission(
  input: ScaleInput,
): FeatureRichnessValidation {
  if (!Number.isFinite(input.factor) || !(input.factor > 0)) {
    return {
      ok: false,
      code: "kernel/parameter-invalid",
      message: `The scale factor must be a finite, strictly positive number (got ${String(input.factor)}); non-uniform scaling is out of contract scope.`,
    };
  }
  return { ok: true };
}

/** Refuses the impossible thicken submissions BEFORE any commit. */
export function validateThickenSubmission(
  input: ThickenInput,
): FeatureRichnessValidation {
  if (!(input.thicknessMm > 0)) {
    return {
      ok: false,
      code: "kernel/parameter-invalid",
      message: `The wall thickness must be strictly positive (got ${String(input.thicknessMm)} mm).`,
    };
  }
  return { ok: true };
}

/** The outcome of one split validation attempt (the same refusal shape). */
export type SplitValidation = FeatureRichnessValidation;

/** The split feature's authoring number. */
export interface SplitInput {
  /** `+1` keeps the side the plane's normal points to, `−1` the opposite. */
  readonly side: 1 | -1;
}

/** The form's defaults: keep the normal's side. */
export const SPLIT_DEFAULTS: SplitInput = { side: 1 };

/** Refuses the impossible split submissions BEFORE any commit. */
export function validateSplitSubmission(input: SplitInput): SplitValidation {
  if (input.side !== 1 && input.side !== -1) {
    return {
      ok: false,
      code: "kernel/feature-input-invalid",
      message: "The split's keep side must be +1 (the normal's side) or −1.",
    };
  }
  return { ok: true };
}

/**
 * The document's LAST extrude feature — the solid the next scale or
 * thicken acts on (the thread precedent).
 */
export function richnessTargetFeatureOf(
  document: Parameters<typeof documentExtrudeRequest>[0],
): FeatureRecord | undefined {
  const bases = document.features.filter((entry) => entry.kind === "extrude");
  return bases[bases.length - 1];
}

/** Reads a parameter's canonical magnitude, or `null` off-dimension. */
function magnitudeIn(
  value: AnyDimensionalValue | undefined,
  dimension: "length" | "dimensionless",
  unit: "mm" | "1",
): number | null {
  if (value === undefined || value.dimension !== dimension) return null;
  const magnitude = valueIn(value, unit);
  return Number.isFinite(magnitude) ? magnitude : null;
}

/** The worker-scene payload one scale feature executes as. */
export interface ScaleSceneRequest {
  /** The base extrusion the feature scales. */
  readonly base: ExtrudeSceneRequest;
  /** The uniform factor (dimensionless, strictly positive). */
  readonly factor: number;
  /** The feature's output body id (the rendered body). */
  readonly bodyId: string;
}

/** The worker-scene payload one thicken feature executes as. */
export interface ThickenSceneRequest {
  /** The base extrusion the feature hollows. */
  readonly base: ExtrudeSceneRequest;
  /** The uniform wall thickness (mm, strictly positive). */
  readonly thicknessMm: number;
  /** The feature's output body id (the rendered body). */
  readonly bodyId: string;
}

/**
 * Reads the document's FIRST feature of `kind` ("scale" or "thicken") into
 * its worker-scene request, pairing it with the base extrusion (the last
 * extrude — the engine's create action guarantees the pairing). `null`
 * when the document carries none, the base no longer resolves, or the
 * parameter no longer reads — callers render the prior scene.
 */
export function documentSingleParameterSceneRequest(
  document: Parameters<typeof documentExtrudeRequest>[0],
  kind: "scale" | "thicken",
  dimension: "dimensionless" | "length",
  unit: "1" | "mm",
): ScaleSceneRequest | ThickenSceneRequest | null {
  const feature = document.features.find((entry) => entry.kind === kind);
  if (feature === undefined) return null;
  const bodyId = feature.outputs[0];
  const parameterRefs = feature.inputs.filter(
    (ref) => ref.kind === "parameter",
  );
  if (bodyId === undefined || parameterRefs.length !== 1) return null;
  const parameter = document.parameters.parameters.find(
    (entry) => entry.id === parameterRefs[0]?.id,
  );
  const magnitude = magnitudeIn(parameter?.value, dimension, unit);
  if (magnitude === null || !(magnitude > 0)) return null;
  const base = documentExtrudeRequest(document);
  if (base === null) return null;
  if (kind === "scale") {
    return { base, factor: magnitude, bodyId };
  }
  return { base, thicknessMm: magnitude, bodyId };
}

/** Reads the document's scale scene request (see the reader above). */
export function documentScaleSceneRequest(
  document: Parameters<typeof documentExtrudeRequest>[0],
): ScaleSceneRequest | null {
  return documentSingleParameterSceneRequest(
    document,
    "scale",
    "dimensionless",
    "1",
  ) as ScaleSceneRequest | null;
}

/** Reads the document's thicken scene request (see the reader above). */
export function documentThickenSceneRequest(
  document: Parameters<typeof documentExtrudeRequest>[0],
): ThickenSceneRequest | null {
  return documentSingleParameterSceneRequest(
    document,
    "thicken",
    "length",
    "mm",
  ) as ThickenSceneRequest | null;
}
