/**
 * The drawing sheet's combined recovery (Phase 54): the workbench seam that
 * composes the parametric-source recoveries — cad-core's feature-parameter
 * dimensions, cad-sketch's sketch-constraint dimensions, and the hole/
 * thread callouts read here through the SAME feature readers the hole
 * scenes use (`structuredHoleCutInputOfFeature` / the flat five-number
 * layout) plus the thread parameter layout `documentThreadSceneRequest`
 * reads and the kernel's ISO designation table — into one deterministic
 * dimension/annotation set for a sheet view.
 *
 * ## Reuse, not re-reading
 *
 * Hole recovery never re-parses parameters ad hoc: the structured reader
 * is the hole scene's own, and the flat form reads its documented
 * five-number layout (diameter, depth, positionX, positionY, axis) with
 * the same first-parameter LENGTH discriminator
 * `isStructuredHoleFeature` uses. The thread callout reads the documented
 * six-slot layout (major, pitch, length, mode, handedness, optional axis).
 * The ISO designation comes from the kernel's pinned table — the same
 * string the hole dialog's picker displays — with the table's own
 * `M<major>x<pitch>` format as the off-table fallback.
 *
 * ## Determinism
 *
 * One pass, document order, fixed sheet anchors, fixed ids
 * (`drann_callout-<n>`). Identical documents recover identical entities,
 * and the result round-trips through the annotation parser unchanged.
 */

import {
  parseDrawingAnnotationId,
  recoverFeatureDimensions,
  valueIn,
  type AnyDimensionalValue,
  type CadDocument,
  type DrawingAnnotation,
  type DrawingAnnotationId,
  type DrawingDimension,
  type FeatureRecord,
} from "@slopcad/cad-core";
import type { DrawingDimensionRecoveryOptions } from "@slopcad/cad-core";
import type { SketchDimensionRecoveryOptions } from "@slopcad/cad-sketch";
import { recoverSketchDimensions } from "@slopcad/cad-sketch";
import { ISO_METRIC_THREAD_TABLE } from "@slopcad/cad-kernel";

import {
  isStructuredHoleFeature,
  structuredHoleCutInputOfFeature,
} from "./hole";

/** The pinned ISO designation for a thread spec (table, then format). */
export function threadDesignationFor(majorMm: number, pitchMm: number): string {
  const row = ISO_METRIC_THREAD_TABLE.find(
    (entry) => entry.majorDiameterMm === majorMm && entry.pitchMm === pitchMm,
  );
  if (row !== undefined) return row.designation;
  return pitchMm === 0
    ? `M${trim(majorMm)}`
    : `M${trim(majorMm)}x${trim(pitchMm)}`;
}

function trim(value: number): string {
  return String(Math.round(value * 1000) / 1000);
}

/** Options for the combined recovery pass. */
export interface DrawingRecoveryOptions {
  /** The view the recovered entities attach to. */
  readonly viewId: string;
  /** The view frame's sheet-space origin (mm, bottom-left). */
  readonly originXMm: number;
  readonly originYMm: number;
  /**
   * The sketch-constraint stack's origin (mm): the view frame's TOP edge —
   * the rows stack upward from there, clear of the frame.
   */
  readonly sketchOriginYMm: number;
  /** The view frame's model-space span (mm, before scale). */
  readonly viewWidthMm: number;
  readonly viewHeightMm: number;
  /** The view scale (model mm → sheet mm). */
  readonly scale: number;
  /** The stack step between recovered dimensions (mm). */
  readonly stackStepMm: number;
}

/** Everything one pass recovered, in document order within each group. */
export interface DrawingRecoveryResult {
  readonly dimensions: readonly DrawingDimension[];
  readonly annotations: readonly DrawingAnnotation[];
}

function magnitudeIn(
  value: AnyDimensionalValue | undefined,
  dimension: "length" | "dimensionless",
  unit: "mm" | "1",
): number | null {
  if (value === undefined || value.dimension !== dimension) return null;
  const magnitude = valueIn(value, unit);
  return Number.isFinite(magnitude) ? magnitude : null;
}

/** The flat five-number hole layout: diameter, depth, posX, posY, axis. */
function flatHoleOfFeature(
  document: CadDocument,
  feature: FeatureRecord,
): { readonly diameterMm: number; readonly depthMm: number } | null {
  const parameterRefs = feature.inputs.filter(
    (ref) => ref.kind === "parameter",
  );
  if (parameterRefs.length !== 5) return null;
  const valueAt = (index: number): AnyDimensionalValue | undefined => {
    const ref = parameterRefs[index];
    if (ref === undefined || ref.kind !== "parameter") return undefined;
    return document.parameters.parameters.find(
      (candidate) => candidate.id === ref.id,
    )?.value;
  };
  const diameter = magnitudeIn(valueAt(0), "length", "mm");
  const depth = magnitudeIn(valueAt(1), "length", "mm");
  if (diameter === null || depth === null) return null;
  return { diameterMm: diameter, depthMm: depth };
}

/** The thread feature's six-slot layout (major, pitch, length, ...). */
function threadOfFeature(
  document: CadDocument,
  feature: FeatureRecord,
): {
  readonly designation: string;
  readonly depthMm: number;
} | null {
  if (feature.kind !== "thread") return null;
  const parameterRefs = feature.inputs.filter(
    (ref) => ref.kind === "parameter",
  );
  const expected = feature.inputs.some((ref) => ref.kind === "datum") ? 5 : 6;
  if (parameterRefs.length !== expected) return null;
  const valueAt = (index: number): AnyDimensionalValue | undefined => {
    const ref = parameterRefs[index];
    if (ref === undefined || ref.kind !== "parameter") return undefined;
    return document.parameters.parameters.find(
      (candidate) => candidate.id === ref.id,
    )?.value;
  };
  const major = magnitudeIn(valueAt(0), "length", "mm");
  const pitch = magnitudeIn(valueAt(1), "length", "mm");
  const length = magnitudeIn(valueAt(2), "length", "mm");
  if (major === null || pitch === null || length === null) return null;
  return {
    designation: threadDesignationFor(major, pitch),
    depthMm: length,
  };
}

function calloutAnnotation(
  index: number,
  text: string,
  options: DrawingRecoveryOptions,
): DrawingAnnotation | null {
  const id = annotationId(`drann_callout-${String(index)}`);
  if (id === null) return null;
  const elbow = {
    x: options.originXMm + options.viewWidthMm * options.scale + 16,
    y:
      options.originYMm +
      options.viewHeightMm * options.scale -
      index * options.stackStepMm,
  };
  return {
    kind: "leader",
    id,
    viewId: options.viewId,
    tip: { x: elbow.x - 10, y: elbow.y - 4 },
    elbow,
    text,
  };
}

function annotationId(raw: string): DrawingAnnotationId | null {
  const parsed = parseDrawingAnnotationId(raw);
  return parsed.ok ? parsed.value : null;
}

/**
 * Runs the combined recovery: feature-parameter dimensions, then
 * sketch-constraint dimensions, then hole/thread callout annotations.
 */
export function recoverDrawingEntities(
  document: CadDocument,
  options: DrawingRecoveryOptions,
): DrawingRecoveryResult {
  const featureOptions: DrawingDimensionRecoveryOptions = {
    viewId: options.viewId,
    originXMm: options.originXMm,
    originYMm: options.originYMm,
    viewWidthMm: options.viewWidthMm,
    viewHeightMm: options.viewHeightMm,
    scale: options.scale,
    stackStepMm: options.stackStepMm,
  };
  const sketchOptions: SketchDimensionRecoveryOptions = {
    viewId: options.viewId,
    originXMm: options.originXMm,
    originYMm: options.sketchOriginYMm,
    scale: options.scale,
    stackStepMm: options.stackStepMm,
  };
  const dimensions = [
    ...recoverFeatureDimensions(document, featureOptions),
    ...recoverSketchDimensions(document, sketchOptions),
  ];
  const annotations: DrawingAnnotation[] = [];
  let calloutIndex = 0;
  for (const feature of document.features) {
    let text: string | null = null;
    if (feature.kind === "hole") {
      const callout = isStructuredHoleFeature(document, feature)
        ? structuredCalloutText(document, feature)
        : flatCalloutText(document, feature);
      text = callout;
    } else if (feature.kind === "thread") {
      const thread = threadOfFeature(document, feature);
      text =
        thread === null
          ? null
          : `${thread.designation} \u2193 ${trim(thread.depthMm)}`;
    }
    if (text === null) continue;
    const annotation = calloutAnnotation(calloutIndex, text, options);
    if (annotation !== null) {
      annotations.push(annotation);
      calloutIndex += 1;
    }
  }
  return { dimensions, annotations };
}

function structuredCalloutText(
  document: CadDocument,
  feature: FeatureRecord,
): string | null {
  const input = structuredHoleCutInputOfFeature(document, feature);
  if (input === null) return null;
  const spec = input.spec;
  if (spec.type === 5) {
    return `${threadDesignationFor(spec.threadMajorMm, spec.threadPitchMm)} \u2193 ${trim(spec.depthMm)}`;
  }
  return `\u2300${trim(spec.diameterMm)} \u2193 ${trim(spec.depthMm)}`;
}

function flatCalloutText(
  document: CadDocument,
  feature: FeatureRecord,
): string | null {
  const hole = flatHoleOfFeature(document, feature);
  if (hole === null) return null;
  return `\u2300${trim(hole.diameterMm)} \u2193 ${trim(hole.depthMm)}`;
}
