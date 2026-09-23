/**
 * Drawing dimension and annotation entities (Phase 54): the data model the
 * drawings phases render on a sheet — linear/radial/diameter/angular
 * dimensions and note/leader/hole-callout/thread-callout/feature-control-
 * frame annotations — as pure, serializable sheet-space records.
 *
 * ## The parametric-source provenance
 *
 * Every dimension carries an {@link DrawingDimensionOrigin}: either a MODEL
 * origin naming the parameter or sketch constraint its value came from (the
 * parametric-history advantage — the value is derived from the same source
 * the geometry regenerates from, never re-typed), or the `reference` origin
 * for dimensions authored on-view (presented in parentheses, per drafting
 * convention). The provenance is DATA, not decoration: serialization keeps
 * it, so a round-tripped drawing still knows which parameter it points at.
 *
 * ## Determinism
 *
 * Geometry is sheet-space millimetres with angles in radians (the
 * presentation layer converts for text) — every record is a closed-form
 * function of authoring inputs with no layout state, no randomness, no
 * clock. Serialization emits fixed-key-order records (the native-format
 * discipline), and {@link parseDrawingDimension}/{@link
 * parseDrawingAnnotation} validate untrusted input with stable
 * `drawing-annotations/*` failure codes, so identical drawings serialize
 * byte-identically and round-trip exactly.
 *
 * ## Seam (Phase 53 boundary)
 *
 * Entities address their host view by `viewId` (a plain string) — the
 * drawing document model and its real view records are Phase 53's; this
 * module only requires that a view be addressable, so the entities merge
 * into that host additively.
 */

import { type ParseResult, fail, ok } from "./result";

/** A sheet-space point in millimetres (y grows upward, drafting convention). */
export interface DrawingPoint {
  readonly x: number;
  readonly y: number;
}

declare const drawingIdBrand: unique symbol;

/** Identifier of a drawing dimension (e.g. `drdim_depth`). */
export type DrawingDimensionId = string & {
  readonly [drawingIdBrand]: "dimension";
};

/** Identifier of a drawing annotation (e.g. `drann_callout-1`). */
export type DrawingAnnotationId = string & {
  readonly [drawingIdBrand]: "annotation";
};

/** Canonical wire prefixes for the drawing entity ids. */
export const DRAWING_ID_PREFIXES = {
  dimension: "drdim",
  annotation: "drann",
} as const;

const DRAWING_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** Stable failure codes produced when input was rejected as a drawing id. */
export const DRAWING_ID_ERROR_CODES = {
  notAString: "drawing-annotations/id-not-a-string",
  wrongPrefix: "drawing-annotations/id-wrong-prefix",
  invalidPayload: "drawing-annotations/id-invalid-payload",
} as const;

export type DrawingIdErrorCode =
  (typeof DRAWING_ID_ERROR_CODES)[keyof typeof DRAWING_ID_ERROR_CODES];

function parseDrawingIdOfKind<K extends "dimension" | "annotation">(
  prefix: string,
  input: unknown,
): ParseResult<string & { readonly [drawingIdBrand]: K }, DrawingIdParseError> {
  if (typeof input !== "string") {
    return fail({
      code: DRAWING_ID_ERROR_CODES.notAString,
      message: "A drawing entity id must be a string.",
      input,
    });
  }
  const rest = input.slice(prefix.length + 1);
  if (!input.startsWith(`${prefix}_`) || !DRAWING_ID_PATTERN.test(rest)) {
    return fail({
      code: DRAWING_ID_ERROR_CODES.wrongPrefix,
      message: `A drawing entity id must be \`${prefix}_<payload>\` with a valid payload.`,
      input,
    });
  }
  return ok(input as string & { readonly [drawingIdBrand]: K });
}

/** Parses a dimension id (`drdim_<payload>`). */
export function parseDrawingDimensionId(
  input: unknown,
): ParseResult<DrawingDimensionId, DrawingIdParseError> {
  return parseDrawingIdOfKind(DRAWING_ID_PREFIXES.dimension, input);
}

/** Parses an annotation id (`drann_<payload>`). */
export function parseDrawingAnnotationId(
  input: unknown,
): ParseResult<DrawingAnnotationId, DrawingIdParseError> {
  return parseDrawingIdOfKind(DRAWING_ID_PREFIXES.annotation, input);
}

/** Structured failure describing why input was rejected as a drawing id. */
export interface DrawingIdParseError {
  readonly code: DrawingIdErrorCode;
  readonly message: string;
  readonly input: unknown;
}

/**
 * Where a dimension's value came from. The `model` origins name the exact
 * parametric source (a feature's parameter or a sketch's constraint); the
 * `reference` origin marks an on-view authored dimension.
 */
export type DrawingDimensionOrigin =
  | {
      readonly source: "model";
      readonly kind: "feature-parameter";
      readonly featureId: string;
      readonly parameterId: string;
      readonly parameterName: string;
    }
  | {
      readonly source: "model";
      readonly kind: "sketch-constraint";
      readonly sketchId: string;
      readonly constraintId: string;
    }
  | { readonly source: "reference" };

/** The linear dimension orientations (drafting vocabulary). */
export const DRAWING_LINEAR_ORIENTATIONS = [
  "aligned",
  "horizontal",
  "vertical",
] as const;

export type DrawingLinearOrientation =
  (typeof DRAWING_LINEAR_ORIENTATIONS)[number];

/** A length dimension measured in millimetres (the canonical sheet unit). */
export type DrawingDimension =
  | {
      /** Two measured points joined by an offset dimension line. */
      readonly kind: "linear";
      readonly id: DrawingDimensionId;
      readonly viewId: string;
      readonly orientation: DrawingLinearOrientation;
      readonly from: DrawingPoint;
      readonly to: DrawingPoint;
      /** Dimension-line offset from the measured geometry (mm). */
      readonly offsetMm: number;
      readonly valueMm: number;
      readonly origin: DrawingDimensionOrigin;
    }
  | {
      /** A center-to-rim radius dimension. */
      readonly kind: "radial";
      readonly id: DrawingDimensionId;
      readonly viewId: string;
      readonly center: DrawingPoint;
      readonly rim: DrawingPoint;
      readonly valueMm: number;
      readonly origin: DrawingDimensionOrigin;
    }
  | {
      /** A through-the-center diameter dimension. */
      readonly kind: "diameter";
      readonly id: DrawingDimensionId;
      readonly viewId: string;
      readonly center: DrawingPoint;
      readonly radiusMm: number;
      /** The across-line direction (rad, deterministic anchor). */
      readonly anchorAngleRad: number;
      readonly valueMm: number;
      readonly origin: DrawingDimensionOrigin;
    }
  | {
      /** An angular dimension swept between two directions from a vertex. */
      readonly kind: "angular";
      readonly id: DrawingDimensionId;
      readonly viewId: string;
      readonly vertex: DrawingPoint;
      readonly startAngleRad: number;
      readonly endAngleRad: number;
      readonly arcRadiusMm: number;
      /** The swept angle in degrees (the presentation unit). */
      readonly valueDeg: number;
      readonly origin: DrawingDimensionOrigin;
    };

/**
 * The pinned ISO 1101 geometric-characteristic subset the feature control
 * frame supports (the roadmap's "pin symbol library scope to ISO subset").
 * The presentation layer maps each to its ISO symbol glyph.
 */
export const GDNT_CHARACTERISTICS = [
  "straightness",
  "flatness",
  "circularity",
  "cylindricity",
  "lineProfile",
  "surfaceProfile",
  "angularity",
  "perpendicularity",
  "parallelism",
  "position",
  "concentricity",
  "symmetry",
  "circularRunout",
  "totalRunout",
] as const;

export type GdntCharacteristic = (typeof GDNT_CHARACTERISTICS)[number];

/** A drawing annotation: notes, leaders, callouts, and GD&T frames. */
export type DrawingAnnotation =
  | {
      /** A free text note anchored on the sheet. */
      readonly kind: "note";
      readonly id: DrawingAnnotationId;
      readonly viewId: string;
      readonly anchor: DrawingPoint;
      readonly text: string;
    }
  | {
      /** A leader from a target tip to an elbow with attached text. */
      readonly kind: "leader";
      readonly id: DrawingAnnotationId;
      readonly viewId: string;
      readonly tip: DrawingPoint;
      readonly elbow: DrawingPoint;
      readonly text: string;
    }
  | {
      /** A hole callout (Phase 42 hole data): diameter + optional depth. */
      readonly kind: "holeCallout";
      readonly id: DrawingAnnotationId;
      readonly viewId: string;
      readonly tip: DrawingPoint;
      readonly elbow: DrawingPoint;
      readonly diameterMm: number;
      readonly depthMm: number | null;
    }
  | {
      /** A thread callout (Phase 40 data): the ISO designation + depth. */
      readonly kind: "threadCallout";
      readonly id: DrawingAnnotationId;
      readonly viewId: string;
      readonly tip: DrawingPoint;
      readonly elbow: DrawingPoint;
      readonly designation: string;
      readonly depthMm: number | null;
    }
  | {
      /** A GD&T feature control frame (ISO 1101 subset). */
      readonly kind: "featureControlFrame";
      readonly id: DrawingAnnotationId;
      readonly viewId: string;
      readonly anchor: DrawingPoint;
      readonly characteristic: GdntCharacteristic;
      /** The tolerance band (mm). */
      readonly toleranceMm: number;
      readonly datumRefs: readonly string[];
    };

/** Stable failure codes produced when entity input fails validation. */
export const DRAWING_ANNOTATIONS_ERROR_CODES = {
  notAnObject: "drawing-annotations/not-an-object",
  unknownKind: "drawing-annotations/unknown-kind",
  missingField: "drawing-annotations/missing-field",
  invalidField: "drawing-annotations/invalid-field",
  unknownCharacteristic: "drawing-annotations/unknown-characteristic",
  unknownOrientation: "drawing-annotations/unknown-orientation",
} as const;

export type DrawingAnnotationsErrorCode =
  (typeof DRAWING_ANNOTATIONS_ERROR_CODES)[keyof typeof DRAWING_ANNOTATIONS_ERROR_CODES];

/** Structured failure describing why entity input was rejected. */
export interface DrawingAnnotationsParseError {
  readonly code: DrawingAnnotationsErrorCode;
  readonly message: string;
  readonly input: unknown;
}

function isPoint(value: unknown): value is DrawingPoint {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as DrawingPoint).x === "number" &&
    typeof (value as DrawingPoint).y === "number"
  );
}

function pointOr(
  value: unknown,
  input: unknown,
  field: string,
): ParseResult<DrawingPoint, DrawingAnnotationsParseError> {
  if (!isPoint(value)) {
    return fail({
      code: DRAWING_ANNOTATIONS_ERROR_CODES.invalidField,
      message: `The \`${field}\` field must be an {x, y} point in millimetres.`,
      input,
    });
  }
  return ok({ x: value.x, y: value.y });
}

function numberField(
  record: Record<string, unknown>,
  key: string,
): ParseResult<number, DrawingAnnotationsParseError> {
  const value = record[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fail({
      code: DRAWING_ANNOTATIONS_ERROR_CODES.missingField,
      message: `The \`${key}\` field must be a finite number.`,
      input: record,
    });
  }
  return ok(value);
}

function stringField(
  record: Record<string, unknown>,
  key: string,
): ParseResult<string, DrawingAnnotationsParseError> {
  const value = record[key];
  if (typeof value !== "string") {
    return fail({
      code: DRAWING_ANNOTATIONS_ERROR_CODES.missingField,
      message: `The \`${key}\` field must be a string.`,
      input: record,
    });
  }
  return ok(value);
}

function originFromSerialized(
  value: unknown,
): DrawingDimensionOrigin | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  if (record.source === "reference") return { source: "reference" };
  if (record.source === "model" && record.kind === "feature-parameter") {
    if (
      typeof record.featureId === "string" &&
      typeof record.parameterId === "string" &&
      typeof record.parameterName === "string"
    ) {
      return {
        source: "model",
        kind: "feature-parameter",
        featureId: record.featureId,
        parameterId: record.parameterId,
        parameterName: record.parameterName,
      };
    }
    return undefined;
  }
  if (record.source === "model" && record.kind === "sketch-constraint") {
    if (
      typeof record.sketchId === "string" &&
      typeof record.constraintId === "string"
    ) {
      return {
        source: "model",
        kind: "sketch-constraint",
        sketchId: record.sketchId,
        constraintId: record.constraintId,
      };
    }
  }
  return undefined;
}

/**
 * Parses one dimension from untrusted input. The serialized form is the
 * parse's exact output shape (fixed key order is a serialization concern,
 * not a parsing one), so parse(serialize(d)) equals d.
 */
export function parseDrawingDimension(
  input: unknown,
): ParseResult<DrawingDimension, DrawingAnnotationsParseError> {
  if (typeof input !== "object" || input === null) {
    return fail({
      code: DRAWING_ANNOTATIONS_ERROR_CODES.notAnObject,
      message: "A drawing dimension must be an object.",
      input,
    });
  }
  const record = input as Record<string, unknown>;
  const id = parseDrawingDimensionId(record.id);
  if (!id.ok) {
    return fail({
      code: DRAWING_ANNOTATIONS_ERROR_CODES.invalidField,
      message: "The dimension's `id` must be a `drdim_<payload>` string.",
      input,
    });
  }
  const viewId = record.viewId;
  if (typeof viewId !== "string" || viewId.length === 0) {
    return fail({
      code: DRAWING_ANNOTATIONS_ERROR_CODES.missingField,
      message: "The dimension's `viewId` must be a non-empty string.",
      input,
    });
  }
  const origin = originFromSerialized(record.origin);
  if (origin === undefined) {
    return fail({
      code: DRAWING_ANNOTATIONS_ERROR_CODES.invalidField,
      message: "The dimension's `origin` must be a known provenance record.",
      input,
    });
  }
  switch (record.kind) {
    case "linear": {
      if (
        typeof record.orientation !== "string" ||
        !DRAWING_LINEAR_ORIENTATIONS.includes(
          record.orientation as DrawingLinearOrientation,
        )
      ) {
        return fail({
          code: DRAWING_ANNOTATIONS_ERROR_CODES.unknownOrientation,
          message:
            "The linear dimension's `orientation` must be aligned, horizontal, or vertical.",
          input,
        });
      }
      const from = pointOr(record.from, input, "from");
      if (!from.ok) return from;
      const to = pointOr(record.to, input, "to");
      if (!to.ok) return to;
      const offsetMm = numberField(record, "offsetMm");
      if (!offsetMm.ok) return offsetMm;
      const valueMm = numberField(record, "valueMm");
      if (!valueMm.ok) return valueMm;
      return ok({
        kind: "linear",
        id: id.value,
        viewId,
        orientation: record.orientation as DrawingLinearOrientation,
        from: from.value,
        to: to.value,
        offsetMm: offsetMm.value,
        valueMm: valueMm.value,
        origin,
      });
    }
    case "radial": {
      const center = pointOr(record.center, input, "center");
      if (!center.ok) return center;
      const rim = pointOr(record.rim, input, "rim");
      if (!rim.ok) return rim;
      const valueMm = numberField(record, "valueMm");
      if (!valueMm.ok) return valueMm;
      return ok({
        kind: "radial",
        id: id.value,
        viewId,
        center: center.value,
        rim: rim.value,
        valueMm: valueMm.value,
        origin,
      });
    }
    case "diameter": {
      const center = pointOr(record.center, input, "center");
      if (!center.ok) return center;
      const radiusMm = numberField(record, "radiusMm");
      if (!radiusMm.ok) return radiusMm;
      const anchorAngleRad = numberField(record, "anchorAngleRad");
      if (!anchorAngleRad.ok) return anchorAngleRad;
      const valueMm = numberField(record, "valueMm");
      if (!valueMm.ok) return valueMm;
      return ok({
        kind: "diameter",
        id: id.value,
        viewId,
        center: center.value,
        radiusMm: radiusMm.value,
        anchorAngleRad: anchorAngleRad.value,
        valueMm: valueMm.value,
        origin,
      });
    }
    case "angular": {
      const vertex = pointOr(record.vertex, input, "vertex");
      if (!vertex.ok) return vertex;
      const startAngleRad = numberField(record, "startAngleRad");
      if (!startAngleRad.ok) return startAngleRad;
      const endAngleRad = numberField(record, "endAngleRad");
      if (!endAngleRad.ok) return endAngleRad;
      const arcRadiusMm = numberField(record, "arcRadiusMm");
      if (!arcRadiusMm.ok) return arcRadiusMm;
      const valueDeg = numberField(record, "valueDeg");
      if (!valueDeg.ok) return valueDeg;
      return ok({
        kind: "angular",
        id: id.value,
        viewId,
        vertex: vertex.value,
        startAngleRad: startAngleRad.value,
        endAngleRad: endAngleRad.value,
        arcRadiusMm: arcRadiusMm.value,
        valueDeg: valueDeg.value,
        origin,
      });
    }
    default:
      return fail({
        code: DRAWING_ANNOTATIONS_ERROR_CODES.unknownKind,
        message:
          "A drawing dimension's `kind` must be linear, radial, diameter, or angular.",
        input,
      });
  }
}

/**
 * Parses one annotation from untrusted input (the same fixed shape its
 * serializer emits, so parse(serialize(a)) equals a).
 */
export function parseDrawingAnnotation(
  input: unknown,
): ParseResult<DrawingAnnotation, DrawingAnnotationsParseError> {
  if (typeof input !== "object" || input === null) {
    return fail({
      code: DRAWING_ANNOTATIONS_ERROR_CODES.notAnObject,
      message: "A drawing annotation must be an object.",
      input,
    });
  }
  const record = input as Record<string, unknown>;
  const id = parseDrawingAnnotationId(record.id);
  if (!id.ok) {
    return fail({
      code: DRAWING_ANNOTATIONS_ERROR_CODES.invalidField,
      message: "The annotation's `id` must be a `drann_<payload>` string.",
      input,
    });
  }
  const viewId = record.viewId;
  if (typeof viewId !== "string" || viewId.length === 0) {
    return fail({
      code: DRAWING_ANNOTATIONS_ERROR_CODES.missingField,
      message: "The annotation's `viewId` must be a non-empty string.",
      input,
    });
  }
  const tipElbow = (): ParseResult<
    [DrawingPoint, DrawingPoint],
    DrawingAnnotationsParseError
  > => {
    const tip = pointOr(record.tip, input, "tip");
    if (!tip.ok) return tip;
    const elbow = pointOr(record.elbow, input, "elbow");
    if (!elbow.ok) return elbow;
    return ok([tip.value, elbow.value]);
  };
  const optionalDepth = (): number | null => {
    const raw = record.depthMm;
    if (raw === null || raw === undefined) return null;
    return typeof raw === "number" && Number.isFinite(raw) ? raw : null;
  };
  switch (record.kind) {
    case "note": {
      const anchor = pointOr(record.anchor, input, "anchor");
      if (!anchor.ok) return anchor;
      const text = stringField(record, "text");
      if (!text.ok) return text;
      return ok({
        kind: "note",
        id: id.value,
        viewId,
        anchor: anchor.value,
        text: text.value,
      });
    }
    case "leader": {
      const tips = tipElbow();
      if (!tips.ok) return tips;
      const text = stringField(record, "text");
      if (!text.ok) return text;
      return ok({
        kind: "leader",
        id: id.value,
        viewId,
        tip: tips.value[0],
        elbow: tips.value[1],
        text: text.value,
      });
    }
    case "holeCallout": {
      const tips = tipElbow();
      if (!tips.ok) return tips;
      const diameterMm = numberField(record, "diameterMm");
      if (!diameterMm.ok) return diameterMm;
      return ok({
        kind: "holeCallout",
        id: id.value,
        viewId,
        tip: tips.value[0],
        elbow: tips.value[1],
        diameterMm: diameterMm.value,
        depthMm: optionalDepth(),
      });
    }
    case "threadCallout": {
      const tips = tipElbow();
      if (!tips.ok) return tips;
      const designation = stringField(record, "designation");
      if (!designation.ok) return designation;
      return ok({
        kind: "threadCallout",
        id: id.value,
        viewId,
        tip: tips.value[0],
        elbow: tips.value[1],
        designation: designation.value,
        depthMm: optionalDepth(),
      });
    }
    case "featureControlFrame": {
      const anchor = pointOr(record.anchor, input, "anchor");
      if (!anchor.ok) return anchor;
      if (
        typeof record.characteristic !== "string" ||
        !GDNT_CHARACTERISTICS.includes(
          record.characteristic as GdntCharacteristic,
        )
      ) {
        return fail({
          code: DRAWING_ANNOTATIONS_ERROR_CODES.unknownCharacteristic,
          message:
            "The feature control frame's `characteristic` must be a pinned ISO 1101 subset member.",
          input,
        });
      }
      const toleranceMm = numberField(record, "toleranceMm");
      if (!toleranceMm.ok) return toleranceMm;
      const rawDatumRefs = record.datumRefs;
      if (!Array.isArray(rawDatumRefs)) {
        return fail({
          code: DRAWING_ANNOTATIONS_ERROR_CODES.invalidField,
          message: "The `datumRefs` field must be an array of strings.",
          input,
        });
      }
      const datumRefs: string[] = [];
      for (const entry of rawDatumRefs) {
        if (typeof entry !== "string") {
          return fail({
            code: DRAWING_ANNOTATIONS_ERROR_CODES.invalidField,
            message: "The `datumRefs` field must be an array of strings.",
            input,
          });
        }
        datumRefs.push(entry);
      }
      return ok({
        kind: "featureControlFrame",
        id: id.value,
        viewId,
        anchor: anchor.value,
        characteristic: record.characteristic as GdntCharacteristic,
        toleranceMm: toleranceMm.value,
        datumRefs,
      });
    }
    default:
      return fail({
        code: DRAWING_ANNOTATIONS_ERROR_CODES.unknownKind,
        message:
          "A drawing annotation's `kind` must be note, leader, holeCallout, threadCallout, or featureControlFrame.",
        input,
      });
  }
}

/** The fixed-key-order serialized form of a dimension origin. */
export type SerializedDrawingDimensionOrigin =
  | {
      readonly source: "model";
      readonly kind: "feature-parameter";
      readonly featureId: string;
      readonly parameterId: string;
      readonly parameterName: string;
    }
  | {
      readonly source: "model";
      readonly kind: "sketch-constraint";
      readonly sketchId: string;
      readonly constraintId: string;
    }
  | { readonly source: "reference" };

/** The fixed-key-order serialized form of a dimension. */
export type SerializedDrawingDimension =
  | {
      readonly kind: "linear";
      readonly id: DrawingDimensionId;
      readonly viewId: string;
      readonly orientation: DrawingLinearOrientation;
      readonly from: DrawingPoint;
      readonly to: DrawingPoint;
      readonly offsetMm: number;
      readonly valueMm: number;
      readonly origin: SerializedDrawingDimensionOrigin;
    }
  | {
      readonly kind: "radial";
      readonly id: DrawingDimensionId;
      readonly viewId: string;
      readonly center: DrawingPoint;
      readonly rim: DrawingPoint;
      readonly valueMm: number;
      readonly origin: SerializedDrawingDimensionOrigin;
    }
  | {
      readonly kind: "diameter";
      readonly id: DrawingDimensionId;
      readonly viewId: string;
      readonly center: DrawingPoint;
      readonly radiusMm: number;
      readonly anchorAngleRad: number;
      readonly valueMm: number;
      readonly origin: SerializedDrawingDimensionOrigin;
    }
  | {
      readonly kind: "angular";
      readonly id: DrawingDimensionId;
      readonly viewId: string;
      readonly vertex: DrawingPoint;
      readonly startAngleRad: number;
      readonly endAngleRad: number;
      readonly arcRadiusMm: number;
      readonly valueDeg: number;
      readonly origin: SerializedDrawingDimensionOrigin;
    };

/** The fixed-key-order serialized form of an annotation. */
export type SerializedDrawingAnnotation =
  | {
      readonly kind: "note";
      readonly id: DrawingAnnotationId;
      readonly viewId: string;
      readonly anchor: DrawingPoint;
      readonly text: string;
    }
  | {
      readonly kind: "leader";
      readonly id: DrawingAnnotationId;
      readonly viewId: string;
      readonly tip: DrawingPoint;
      readonly elbow: DrawingPoint;
      readonly text: string;
    }
  | {
      readonly kind: "holeCallout";
      readonly id: DrawingAnnotationId;
      readonly viewId: string;
      readonly tip: DrawingPoint;
      readonly elbow: DrawingPoint;
      readonly diameterMm: number;
      readonly depthMm: number | null;
    }
  | {
      readonly kind: "threadCallout";
      readonly id: DrawingAnnotationId;
      readonly viewId: string;
      readonly tip: DrawingPoint;
      readonly elbow: DrawingPoint;
      readonly designation: string;
      readonly depthMm: number | null;
    }
  | {
      readonly kind: "featureControlFrame";
      readonly id: DrawingAnnotationId;
      readonly viewId: string;
      readonly anchor: DrawingPoint;
      readonly characteristic: GdntCharacteristic;
      readonly toleranceMm: number;
      readonly datumRefs: readonly string[];
    };

/**
 * Serializes a dimension into its fixed-key-order record: every kind
 * constructs its literal explicitly, so the byte order never depends on how
 * the record was authored or parsed.
 */
export function serializeDrawingDimension(
  dimension: DrawingDimension,
): SerializedDrawingDimension {
  const head = {
    id: dimension.id,
    viewId: dimension.viewId,
  };
  switch (dimension.kind) {
    case "linear":
      return {
        kind: "linear",
        id: head.id,
        viewId: head.viewId,
        orientation: dimension.orientation,
        from: { x: dimension.from.x, y: dimension.from.y },
        to: { x: dimension.to.x, y: dimension.to.y },
        offsetMm: dimension.offsetMm,
        valueMm: dimension.valueMm,
        origin: dimension.origin,
      };
    case "radial":
      return {
        kind: "radial",
        id: head.id,
        viewId: head.viewId,
        center: { x: dimension.center.x, y: dimension.center.y },
        rim: { x: dimension.rim.x, y: dimension.rim.y },
        valueMm: dimension.valueMm,
        origin: dimension.origin,
      };
    case "diameter":
      return {
        kind: "diameter",
        id: head.id,
        viewId: head.viewId,
        center: { x: dimension.center.x, y: dimension.center.y },
        radiusMm: dimension.radiusMm,
        anchorAngleRad: dimension.anchorAngleRad,
        valueMm: dimension.valueMm,
        origin: dimension.origin,
      };
    case "angular":
      return {
        kind: "angular",
        id: head.id,
        viewId: head.viewId,
        vertex: { x: dimension.vertex.x, y: dimension.vertex.y },
        startAngleRad: dimension.startAngleRad,
        endAngleRad: dimension.endAngleRad,
        arcRadiusMm: dimension.arcRadiusMm,
        valueDeg: dimension.valueDeg,
        origin: dimension.origin,
      };
  }
}

/** Serializes an annotation into its fixed-key-order record (same law). */
export function serializeDrawingAnnotation(
  annotation: DrawingAnnotation,
): SerializedDrawingAnnotation {
  const head = {
    id: annotation.id,
    viewId: annotation.viewId,
  };
  switch (annotation.kind) {
    case "note":
      return {
        kind: "note",
        id: head.id,
        viewId: head.viewId,
        anchor: { x: annotation.anchor.x, y: annotation.anchor.y },
        text: annotation.text,
      };
    case "leader":
      return {
        kind: "leader",
        id: head.id,
        viewId: head.viewId,
        tip: { x: annotation.tip.x, y: annotation.tip.y },
        elbow: { x: annotation.elbow.x, y: annotation.elbow.y },
        text: annotation.text,
      };
    case "holeCallout":
      return {
        kind: "holeCallout",
        id: head.id,
        viewId: head.viewId,
        tip: { x: annotation.tip.x, y: annotation.tip.y },
        elbow: { x: annotation.elbow.x, y: annotation.elbow.y },
        diameterMm: annotation.diameterMm,
        depthMm: annotation.depthMm,
      };
    case "threadCallout":
      return {
        kind: "threadCallout",
        id: head.id,
        viewId: head.viewId,
        tip: { x: annotation.tip.x, y: annotation.tip.y },
        elbow: { x: annotation.elbow.x, y: annotation.elbow.y },
        designation: annotation.designation,
        depthMm: annotation.depthMm,
      };
    case "featureControlFrame":
      return {
        kind: "featureControlFrame",
        id: head.id,
        viewId: head.viewId,
        anchor: { x: annotation.anchor.x, y: annotation.anchor.y },
        characteristic: annotation.characteristic,
        toleranceMm: annotation.toleranceMm,
        datumRefs: [...annotation.datumRefs],
      };
  }
}
