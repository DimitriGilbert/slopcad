/**
 * Sketch-constraint dimension recovery for drawings (Phase 54): the sketch
 * half of the parametric-source recovery — a sketch's dimensional
 * constraints (the Phase 36 vocabulary's `distance`, `distanceX`,
 * `distanceY`, `radius`, `diameter`, `angle`) become drawing dimensions
 * whose values are derived from the same constraint records the solver
 * consumes.
 *
 * ## The module split (dependency arrows)
 *
 * This lives in cad-sketch, not cad-core: document sketches embed the
 * sketch domain's serialized payloads, and only this package can parse
 * them (cad-core cannot depend on cad-sketch). The web workbench combines
 * this module's output with cad-core's feature-parameter recovery.
 *
 * ## Deterministic placement
 *
 * The constraints' sheet GEOMETRY is not resolved here — that is the view
 * projection's job (Phase 53). Recovery places each dimension in a
 * deterministic stack along the view frame's bottom edge, in the sketch's
 * constraint order, with the drawn geometry at the view's scale and the
 * carried VALUE the constraint's model value unit-converted through
 * `valueIn` (a `2 cm` distance constraint recovers as a 20 mm dimension).
 * Constraint geometry anchoring joins the drawing model when Phase 53's
 * views land; until then the stack is the honest deterministic layout.
 */

import {
  type CadDocument,
  type DocumentSketch,
  parseDrawingDimensionId,
  valueIn,
  type DrawingDimension,
  type DrawingDimensionOrigin,
} from "@slopcad/cad-core";
import type { SketchConstraint } from "./constraints";

import { parseSketch } from "./sketch";

/** Options for one sketch-constraint recovery pass. */
export interface SketchDimensionRecoveryOptions {
  /** The view the recovered dimensions attach to. */
  readonly viewId: string;
  /** The view frame's sheet-space origin (mm, bottom-left). */
  readonly originXMm: number;
  readonly originYMm: number;
  /** The view scale (model mm → sheet mm). */
  readonly scale: number;
  /** Horizontal distance between stacked dimensions (mm). */
  readonly stackStepMm: number;
}

const DIMENSIONAL_CONSTRAINT_KINDS = new Set([
  "distance",
  "distanceX",
  "distanceY",
  "radius",
  "diameter",
  "angle",
]);

function sketchConstraintOrigin(
  sketch: DocumentSketch,
  constraintId: string,
): DrawingDimensionOrigin {
  return {
    source: "model",
    kind: "sketch-constraint",
    sketchId: sketch.id,
    constraintId,
  };
}

/**
 * Recovers dimensions from every dimensional constraint in every document
 * sketch, document order then constraint order. Non-dimensional
 * constraints and unparsable payloads are skipped (honest decline).
 */
export function recoverSketchDimensions(
  document: CadDocument,
  options: SketchDimensionRecoveryOptions,
): readonly DrawingDimension[] {
  const dimensions: DrawingDimension[] = [];
  let stackIndex = 0;
  for (const sketch of document.sketches) {
    const parsed = parseSketch(sketch.sketch);
    if (!parsed.ok) continue;
    for (const constraint of parsed.value.constraints) {
      const dimension = sketchConstraintDimension(
        sketch,
        constraint,
        options,
        stackIndex,
      );
      if (dimension !== null) {
        dimensions.push(dimension);
        stackIndex += 1;
      }
    }
  }
  return dimensions;
}

function sketchConstraintDimension(
  sketch: DocumentSketch,
  constraint: SketchConstraint,
  options: SketchDimensionRecoveryOptions,
  stackIndex: number,
): DrawingDimension | null {
  if (!DIMENSIONAL_CONSTRAINT_KINDS.has(constraint.kind)) return null;
  const value = "value" in constraint ? constraint.value : undefined;
  if (value === undefined) return null;
  const origin = sketchConstraintOrigin(sketch, constraint.id);
  // One row per recovered constraint: the caller passes the VIEW FRAME'S
  // TOP edge as the origin, and rows stack UP the sheet from there — so a
  // long dimension never crosses the frame or another row; distanceY dims
  // extend UPWARD from their row base for the same reason.
  const stackX = options.originXMm + 8;
  const baseY = options.originYMm + 10 + stackIndex * options.stackStepMm;
  const id = parseDrawingDimensionId(`drdim_sk${stackIndex}`);
  if (!id.ok) return null;
  switch (constraint.kind) {
    case "distance": {
      const valueMm = valueIn(value, "mm");
      if (!Number.isFinite(valueMm)) return null;
      return {
        kind: "linear",
        id: id.value,
        viewId: options.viewId,
        orientation: "aligned",
        from: { x: stackX, y: baseY },
        to: {
          x: stackX + valueMm * options.scale,
          y: baseY,
        },
        offsetMm: 6,
        valueMm,
        origin,
      };
    }
    case "distanceX": {
      const valueMm = valueIn(value, "mm");
      if (!Number.isFinite(valueMm)) return null;
      return {
        kind: "linear",
        id: id.value,
        viewId: options.viewId,
        orientation: "horizontal",
        from: { x: stackX, y: baseY },
        to: { x: stackX + valueMm * options.scale, y: baseY },
        offsetMm: 6,
        valueMm,
        origin,
      };
    }
    case "distanceY": {
      const valueMm = valueIn(value, "mm");
      if (!Number.isFinite(valueMm)) return null;
      return {
        kind: "linear",
        id: id.value,
        viewId: options.viewId,
        orientation: "vertical",
        from: { x: stackX, y: baseY },
        to: { x: stackX, y: baseY + valueMm * options.scale },
        offsetMm: 6,
        valueMm,
        origin,
      };
    }
    case "radius": {
      const valueMm = valueIn(value, "mm");
      if (!Number.isFinite(valueMm)) return null;
      return {
        kind: "radial",
        id: id.value,
        viewId: options.viewId,
        center: { x: stackX, y: baseY },
        rim: {
          x: stackX + valueMm * options.scale,
          y: baseY + valueMm * options.scale,
        },
        valueMm,
        origin,
      };
    }
    case "diameter": {
      const valueMm = valueIn(value, "mm");
      if (!Number.isFinite(valueMm)) return null;
      return {
        kind: "diameter",
        id: id.value,
        viewId: options.viewId,
        center: { x: stackX, y: baseY },
        radiusMm: (valueMm / 2) * options.scale,
        anchorAngleRad: Math.PI / 4,
        valueMm,
        origin,
      };
    }
    case "angle": {
      const valueDeg = valueIn(value, "deg");
      if (!Number.isFinite(valueDeg)) return null;
      const arcRadiusMm = 10;
      const startRad = 0;
      const endRad = valueIn(value, "rad");
      return {
        kind: "angular",
        id: id.value,
        viewId: options.viewId,
        vertex: { x: stackX, y: baseY },
        startAngleRad: startRad,
        endAngleRad: endRad,
        arcRadiusMm,
        valueDeg,
        origin,
      };
    }
    default:
      return null;
  }
}

/** Exported for the workbench's recovery summary (constraint-id vocabulary). */
export function dimensionalConstraintIdsOf(
  document: CadDocument,
): readonly string[] {
  const ids: string[] = [];
  for (const sketch of document.sketches) {
    const parsed = parseSketch(sketch.sketch);
    if (!parsed.ok) continue;
    for (const constraint of parsed.value.constraints) {
      if (DIMENSIONAL_CONSTRAINT_KINDS.has(constraint.kind)) {
        ids.push(constraint.id);
      }
    }
  }
  return ids;
}
