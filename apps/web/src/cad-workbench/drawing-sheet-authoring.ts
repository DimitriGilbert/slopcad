/**
 * The drawing sheet's authoring vocabulary (Phase 54): the submissions the
 * Formedible dialogs produce, the action-time validation battery (the
 * structured-hole dialog's discipline), the deterministic seed document,
 * and the reference-dimension authoring that turns a dialog submission
 * into an on-view dimension entity.
 *
 * ## The seed (the parametric-source demo)
 *
 * The sheet page boots ONE deterministic document — a rectangle sketch
 * (60 × 40, the public sketch fixture), a 20 mm extrude whose depth
 * parameter is authored in CENTIMETRES (2 cm — so a recovered dimension
 * proves its value is unit-converted from the same parameter, not
 * re-typed), a 4 mm fillet, and a threaded M8 structured hole — through
 * the domain's own add-ops. No kernel runs: recovery reads records, not
 * geometry (the parametric-history advantage this phase exists to show).
 *
 * ## Determinism
 *
 * Every authored entity gets a fixed id (`drdim_ref-<n>`), a fixed anchor
 * (a deterministic stack on the sheet's left margin), and a fixed value
 * derivation. The validation battery runs BEFORE any state changes and
 * refuses doomed submissions with stable codes.
 */

import {
  addDocumentParameter,
  addDocumentSketch,
  addFeature,
  angle,
  createDocument,
  createDocumentId,
  createFeatureId,
  createParameterId,
  dimensionless,
  length,
  parseDrawingDimensionId,
  type CadDocument,
  type DrawingDimension,
  type DrawingDimensionOrigin,
  type DrawingLinearOrientation,
  type ParameterId,
} from "@slopcad/cad-core";
import { dimensionedRectangleSketch } from "@slopcad/cad-sketch";
import { serializeSketch } from "@slopcad/cad-sketch";
import { structuredHoleRoles } from "@slopcad/cad-kernel";
import type { DrawingSheetTemplate } from "@slopcad/cad-core";
import { drawingSheetTemplateById } from "@slopcad/cad-core";

/** What the template picker submits: the pinned template's id. */
export interface TemplateSubmission {
  readonly templateId: string;
}

/** What the title block form submits: the six fixed fields. */
export interface TitleBlockSubmission {
  readonly title: string;
  readonly author: string;
  readonly material: string;
  readonly mass: string;
  readonly scale: string;
  readonly date: string;
}

/** What the reference-dimension dialog submits. */
export interface ReferenceDimensionSubmission {
  readonly kind: "linear" | "radial" | "diameter" | "angular";
  /** The linear orientation (linear dimensions only). */
  readonly orientation: DrawingLinearOrientation;
  /** The value: millimetres, or degrees for angular dimensions. */
  readonly value: number;
}

/** What the revision form submits: one revision table row. */
export interface RevisionSubmission {
  readonly revision: string;
  readonly description: string;
  readonly author: string;
  readonly date: string;
}

/** The outcome of one submission validation attempt. */
export type AuthoringValidation =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: string; readonly message: string };

/** The default reference-dimension submission: a 25 mm aligned distance. */
export const REFERENCE_DIMENSION_DEFAULTS: ReferenceDimensionSubmission = {
  kind: "linear",
  orientation: "aligned",
  value: 25,
};

/** The default title block submission (all fields open). */
export const TITLE_BLOCK_DEFAULTS: TitleBlockSubmission = {
  title: "Bracket plate",
  author: "",
  material: "AL 6061",
  mass: "",
  scale: "1:2",
  date: "2026-09-23",
};

/**
 * The action-time battery for a template submission: the id must name a
 * pinned template (the picker's contract — the record is never copied).
 */
export function validateTemplateSubmission(
  submission: TemplateSubmission,
): AuthoringValidation {
  if (drawingSheetTemplateById(submission.templateId) === undefined) {
    return {
      ok: false,
      code: "drawing-sheet/unknown-template",
      message: "The template id must name a pinned drawing template.",
    };
  }
  return { ok: true };
}

/** The action-time battery for a reference dimension. */
export function validateReferenceDimensionSubmission(
  submission: ReferenceDimensionSubmission,
): AuthoringValidation {
  if (!Number.isFinite(submission.value) || submission.value <= 0) {
    return {
      ok: false,
      code: "drawing-annotations/invalid-field",
      message: "The dimension value must be a positive finite number.",
    };
  }
  if (submission.kind === "angular" && submission.value >= 360) {
    return {
      ok: false,
      code: "drawing-annotations/invalid-field",
      message: "An angular dimension must sweep less than a full turn.",
    };
  }
  return { ok: true };
}

/** The action-time battery for a revision row. */
export function validateRevisionSubmission(
  submission: RevisionSubmission,
): AuthoringValidation {
  if (submission.revision.trim().length === 0) {
    return {
      ok: false,
      code: "drawing-annotations/missing-field",
      message: "A revision row needs a revision marker.",
    };
  }
  if (submission.description.trim().length === 0) {
    return {
      ok: false,
      code: "drawing-annotations/missing-field",
      message: "A revision row needs a description.",
    };
  }
  return { ok: true };
}

/**
 * Builds the deterministic seed document: rectangle sketch, 2 cm-deep
 * extrude, 4 mm fillet, threaded M8 structured hole.
 */
export function seedDrawingDocument(): CadDocument {
  let document = createDocument(createDocumentId("doc_drawing_sheet"));
  const sketchAdded = addDocumentSketch(document, {
    name: "plate profile",
    sketch: serializeSketch(dimensionedRectangleSketch()) as unknown as Record<
      string,
      unknown
    >,
  });
  if (sketchAdded.ok) document = sketchAdded.value.document;

  // The extrude's depth: authored in centimetres on purpose — the
  // recovered dimension carries the same quantity in millimetres.
  let depthId: ParameterId | null = null;
  const depthAdded = addDocumentParameter(document, {
    id: createParameterId("param_depth"),
    name: "depth",
    value: length(2, "cm"),
  });
  if (depthAdded.ok) {
    document = depthAdded.value.document;
    depthId = depthAdded.value.parameter.id;
  }
  if (depthId !== null) {
    const feature = addFeature(document, {
      id: createFeatureId("feat_plate"),
      kind: "extrude",
      inputs: [{ kind: "parameter", id: depthId }],
      outputs: [],
    });
    if (feature.ok) document = feature.value.document;
  }

  // The fillet's radius.
  let radiusId: ParameterId | null = null;
  const radiusAdded = addDocumentParameter(document, {
    id: createParameterId("param_rim"),
    name: "rim",
    value: length(4, "mm"),
  });
  if (radiusAdded.ok) {
    document = radiusAdded.value.document;
    radiusId = radiusAdded.value.parameter.id;
  }
  if (radiusId !== null) {
    const feature = addFeature(document, {
      id: createFeatureId("feat_edge_fillet"),
      kind: "fillet",
      inputs: [{ kind: "parameter", id: radiusId }],
      outputs: [],
    });
    if (feature.ok) document = feature.value.document;
  }

  // The threaded structured hole: the type-directed roles in declared
  // order (the bridge's schema), each riding its own parameter.
  const roles = structuredHoleRoles("threaded", {
    sketchPositions: false,
    datumAxis: false,
  });
  const values: Readonly<Record<string, number>> = {
    type: 5,
    diameter: 8,
    depth: 6,
    tipAngle: 118,
    threadMajor: 8,
    threadPitch: 1.25,
    positionX: 15,
    positionY: 10,
    axis: 3,
    cboreDiameter: 0,
    cboreDepth: 0,
    csinkDiameter: 0,
    csinkAngle: 0,
    taperAngle: 0,
  };
  const inputs: { readonly kind: "parameter"; readonly id: ParameterId }[] = [];
  roles.forEach((role, index) => {
    const raw = values[role.name] ?? 0;
    const added = addDocumentParameter(document, {
      name: `hole_${role.name}`,
      value:
        role.kind === "length"
          ? length(raw, "mm")
          : role.kind === "angle"
            ? angle(raw, "deg")
            : dimensionless(raw),
      id: createParameterId(`param_hole_${String(index)}`),
    });
    if (!added.ok) return;
    document = added.value.document;
    inputs.push({ kind: "parameter", id: added.value.parameter.id });
  });
  if (inputs.length === roles.length) {
    const feature = addFeature(document, {
      id: createFeatureId("feat_hole_1"),
      kind: "hole",
      inputs,
      outputs: [],
    });
    if (feature.ok) document = feature.value.document;
  }
  return document;
}

/** The reference-dimension stack's deterministic anchor (sheet mm). */
export const REFERENCE_DIMENSION_STACK = {
  originXMm: 18,
  originYMm: 150,
  stepMm: 12,
} as const;

/**
 * Authors one reference dimension from a validated submission: fixed id,
 * fixed stack anchor, `reference` provenance (presented in parentheses).
 */
export function referenceDimensionOf(
  submission: ReferenceDimensionSubmission,
  index: number,
): DrawingDimension | null {
  const id = parseDrawingDimensionId(`drdim_ref-${String(index)}`);
  if (!id.ok) return null;
  const origin: DrawingDimensionOrigin = { source: "reference" };
  const x = REFERENCE_DIMENSION_STACK.originXMm;
  const y =
    REFERENCE_DIMENSION_STACK.originYMm -
    index * REFERENCE_DIMENSION_STACK.stepMm;
  const span = submission.value / 2;
  switch (submission.kind) {
    case "linear":
      return {
        kind: "linear",
        id: id.value,
        viewId: "view_front",
        orientation: submission.orientation,
        from: { x, y },
        to:
          submission.orientation === "vertical"
            ? { x, y: y + span }
            : { x: x + span, y },
        offsetMm: 5,
        valueMm: submission.value,
        origin,
      };
    case "radial":
      return {
        kind: "radial",
        id: id.value,
        viewId: "view_front",
        center: { x, y },
        rim: { x: x + span / 2, y: y + span / 2 },
        valueMm: submission.value,
        origin,
      };
    case "diameter":
      return {
        kind: "diameter",
        id: id.value,
        viewId: "view_front",
        center: { x: x + span, y },
        radiusMm: span / 2,
        anchorAngleRad: Math.PI / 4,
        valueMm: submission.value,
        origin,
      };
    case "angular": {
      const rad = (submission.value * Math.PI) / 180;
      return {
        kind: "angular",
        id: id.value,
        viewId: "view_front",
        vertex: { x, y },
        startAngleRad: 0,
        endAngleRad: rad,
        arcRadiusMm: 10,
        valueDeg: submission.value,
        origin,
      };
    }
  }
}

/** Applies a template submission to the sheet's template state. */
export function templateOf(
  submission: TemplateSubmission,
): DrawingSheetTemplate | null {
  return drawingSheetTemplateById(submission.templateId) ?? null;
}
