/**
 * Model dimension recovery from the parametric source (Phase 54): the
 * feature-parameter half of the parametric-history advantage — an extrude's
 * depth or a fillet's radius becomes a drawing dimension whose value is
 * derived from the SAME parameter the geometry regenerates from, never
 * re-typed.
 *
 * ## The reader discipline
 *
 * Recovery reads only the documented parameter layouts (the chain module's
 * contracts): an `extrude` feature's first length-typed parameter input is
 * the depth; a `fillet` feature's first length-typed parameter is the
 * radius. A feature whose layout does not resolve (missing input, mistyped
 * value) is skipped — recovery declines honestly and never fabricates a
 * value. Unit conversion rides the dimensional-value machinery
 * (`valueIn(value, "mm")`), so a depth authored as `2 cm` recovers as a
 * 20 mm dimension — the validation fixture's exact shape.
 *
 * ## Deterministic placement
 *
 * Sheet placement is closed-form in the options: dimensions stack along
 * the view frame's right edge in feature order, at the view's scale (the
 * drawn geometry is `value × scale` sheet millimetres; the carried VALUE
 * stays the model value). Identical documents recover identically.
 */

import type { CadDocument } from "./document";
import type { FeatureRecord } from "./document";
import type { ParameterId } from "./ids";

import { valueIn } from "./dimensional";
import {
  parseDrawingDimensionId,
  type DrawingDimension,
  type DrawingDimensionOrigin,
} from "./drawing-annotations";

/** Options for one recovery pass. */
export interface DrawingDimensionRecoveryOptions {
  /** The view the recovered dimensions attach to. */
  readonly viewId: string;
  /** The view frame's sheet-space origin (mm, bottom-left). */
  readonly originXMm: number;
  readonly originYMm: number;
  /** The view frame's drawn span at sheet scale (mm). */
  readonly viewWidthMm: number;
  readonly viewHeightMm: number;
  /** The view scale (model mm → sheet mm). */
  readonly scale: number;
  /** Vertical distance between stacked dimensions (mm). */
  readonly stackStepMm: number;
}

/** The first length-typed parameter of a feature, with its id. */
function firstLengthParameter(
  document: CadDocument,
  feature: FeatureRecord,
): { readonly id: ParameterId; readonly valueMm: number } | null {
  for (const ref of feature.inputs) {
    if (ref.kind !== "parameter") continue;
    const parameter = document.parameters.parameters.find(
      (candidate) => candidate.id === ref.id,
    );
    if (parameter !== undefined && parameter.value.dimension === "length") {
      const valueMm = valueIn(parameter.value, "mm");
      if (Number.isFinite(valueMm)) {
        return { id: parameter.id, valueMm };
      }
    }
  }
  return null;
}

function modelParameterOrigin(
  feature: FeatureRecord,
  parameterId: ParameterId,
  parameterName: string,
): DrawingDimensionOrigin {
  return {
    source: "model",
    kind: "feature-parameter",
    featureId: feature.id,
    parameterId,
    parameterName,
  };
}

/**
 * Recovers one feature's dimension, or `null` when the feature's kind has
 * no pinned dimension plan or its layout does not resolve.
 */
function recoverFeatureDimension(
  document: CadDocument,
  feature: FeatureRecord,
  options: DrawingDimensionRecoveryOptions,
  stackIndex: number,
): DrawingDimension | null {
  const length = firstLengthParameter(document, feature);
  if (length === null) return null;
  const parameter = document.parameters.parameters.find(
    (candidate) => candidate.id === length.id,
  );
  if (parameter === undefined) return null;
  if (!feature.id.startsWith("feat_")) return null;
  const id = parseDrawingDimensionId(`drdim_${feature.id.slice(5)}`);
  if (!id.ok) return null;
  const stackX = options.originXMm + options.viewWidthMm * options.scale + 12;
  const stackY =
    options.originYMm +
    options.viewHeightMm * options.scale +
    8 +
    stackIndex * options.stackStepMm;
  if (feature.kind === "fillet") {
    const radiusMm = length.valueMm;
    return {
      kind: "radial",
      id: id.value,
      viewId: options.viewId,
      center: { x: stackX, y: stackY },
      rim: {
        x: stackX + radiusMm * options.scale,
        y: stackY + radiusMm * options.scale,
      },
      valueMm: radiusMm,
      origin: modelParameterOrigin(feature, parameter.id, parameter.name),
    };
  }
  // The extrude plan (the depth): a vertical linear dimension whose drawn
  // height is the depth at the view's scale, value carried in model mm.
  const depthMm = length.valueMm;
  return {
    kind: "linear",
    id: id.value,
    viewId: options.viewId,
    orientation: "vertical",
    from: { x: stackX, y: stackY },
    to: { x: stackX, y: stackY + depthMm * options.scale },
    offsetMm: 6,
    valueMm: depthMm,
    origin: modelParameterOrigin(feature, parameter.id, parameter.name),
  };
}

/**
 * Recovers dimensions from every feature the pinned plans cover, in
 * document feature order. Features without a plan or with an unresolvable
 * layout are skipped (honest decline); everything else carries its value's
 * parameter provenance.
 */
export function recoverFeatureDimensions(
  document: CadDocument,
  options: DrawingDimensionRecoveryOptions,
): readonly DrawingDimension[] {
  const dimensions: DrawingDimension[] = [];
  let stackIndex = 0;
  for (const feature of document.features) {
    if (feature.kind !== "extrude" && feature.kind !== "fillet") continue;
    const dimension = recoverFeatureDimension(
      document,
      feature,
      options,
      stackIndex,
    );
    if (dimension !== null) {
      dimensions.push(dimension);
      stackIndex += 1;
    }
  }
  return dimensions;
}
