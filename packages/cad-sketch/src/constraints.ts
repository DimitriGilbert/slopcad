/**
 * Sketch constraints: serializable geometric and dimensional relationships
 * between entities, referenced by id.
 *
 * Every constraint is a plain discriminated record: `id`, `kind`, then the
 * kind's operands in a fixed documented order. Sub-parameters select where
 * on an entity a constraint attaches through {@link PointTarget}
 * (`start`/`end`/`center`; arc endpoints are on the arc at its start/end
 * angles, a line's `center` is its midpoint). Dimensional values are cad-core
 * dimensional values — lengths in mm, angles canonicalized to rad on the wire
 * — so unit semantics live in one place.
 *
 * Kinds and their equations (the solver compiles these to residuals):
 *
 * - `coincident(first, second)` — two point targets coincide (2 equations).
 * - `horizontal(line)` — the line's endpoints share y.
 * - `vertical(line)` — the line's endpoints share x.
 * - `parallel(first, second)` — two lines are parallel (either sense).
 * - `perpendicular(first, second)` — two lines meet at 90°.
 * - `distance(first, second, value)` — mm between two point targets; a line's
 *   length is the distance between its start and end.
 * - `angle(first, second, value)` — the angle between two lines' directions,
 *   strictly between 0° and 180° (use parallel/perpendicular at the limits).
 * - `radius(entity, value)` — circle/arc radius, positive.
 * - `diameter(entity, value)` — circle/arc diameter, positive.
 * - `equal(first, second)` — equal lengths (two lines) or equal radii (two
 *   circles/arcs); mixed pairs are rejected as malformed.
 * - `tangent(first, second, variant?)` — a line tangent to a circle/arc
 *   (infinite line, not segment), or two circles/arcs tangent `external`
 *   (default: centers r1+r2 apart) or `internal` (|r1−r2| apart).
 * - `midpoint(point, line)` — the point target sits at the line's midpoint
 *   (2 equations).
 * - `symmetry(first, second, about)` — two point targets symmetric about a
 *   third point (point symmetry), or about a line (midpoint on the line and
 *   the connecting segment perpendicular to it; 2 equations each way).
 */

import {
  type AngleValue,
  type LengthValue,
  type ParseResult,
  fail,
  ok,
  parseDimensionalValue,
  serializeDimensionalValue,
  valueIn,
} from "@slopcad/cad-core";
import type { SketchDiagnostic } from "./diagnostics";
import type { ArcEntity, CircleEntity, LineEntity, SketchEntity } from "./entities";

import { SKETCH_DIAGNOSTIC_CODES } from "./diagnostics";
import {
  type SketchConstraintId,
  type SketchEntityId,
  parseSketchConstraintId,
  parseSketchEntityId,
} from "./sketch-ids";

/** Constraint kinds a sketch can carry. */
export const SKETCH_CONSTRAINT_KINDS = [
  "coincident",
  "horizontal",
  "vertical",
  "parallel",
  "perpendicular",
  "distance",
  "angle",
  "radius",
  "diameter",
  "equal",
  "tangent",
  "midpoint",
  "symmetry",
] as const;

export type SketchConstraintKind = (typeof SKETCH_CONSTRAINT_KINDS)[number];

/** Type guard for untrusted constraint kinds. */
export function isSketchConstraintKind(
  input: unknown,
): input is SketchConstraintKind {
  return (
    typeof input === "string" &&
    (SKETCH_CONSTRAINT_KINDS as readonly string[]).includes(input)
  );
}

/**
 * Where on an entity a constraint attaches. `start`/`end` are a line's or an
 * arc's endpoints (an arc's endpoints lie on the arc at its start/end
 * angles); `center` is a point entity's position, a line's midpoint, or a
 * circle/arc center.
 */
export interface PointTarget {
  readonly entity: SketchEntityId;
  readonly point: "start" | "end" | "center";
}

/** Builds a point target. */
export function pointTarget(
  entity: SketchEntityId,
  point: PointTarget["point"],
): PointTarget {
  return { entity, point };
}

/** Tangency variant for circle/arc pairs. */
export const TANGENT_VARIANTS = ["external", "internal"] as const;

export type TangentVariant = (typeof TANGENT_VARIANTS)[number];

/** Type guard for untrusted tangency variants. */
export function isTangentVariant(input: unknown): input is TangentVariant {
  return (
    typeof input === "string" &&
    (TANGENT_VARIANTS as readonly string[]).includes(input)
  );
}

/** What a symmetry constraint mirrors its operands about. */
export type SymmetryAbout =
  | { readonly type: "point"; readonly point: PointTarget }
  | { readonly type: "line"; readonly entity: SketchEntityId };

interface ConstraintBase {
  readonly id: SketchConstraintId;
}

/** Two point targets must coincide. */
export interface CoincidentConstraint extends ConstraintBase {
  readonly kind: "coincident";
  readonly first: PointTarget;
  readonly second: PointTarget;
}

/** A line's endpoints must share y. */
export interface HorizontalConstraint extends ConstraintBase {
  readonly kind: "horizontal";
  readonly entity: SketchEntityId;
}

/** A line's endpoints must share x. */
export interface VerticalConstraint extends ConstraintBase {
  readonly kind: "vertical";
  readonly entity: SketchEntityId;
}

/** Two lines must be parallel (either sense). */
export interface ParallelConstraint extends ConstraintBase {
  readonly kind: "parallel";
  readonly first: SketchEntityId;
  readonly second: SketchEntityId;
}

/** Two lines must meet at 90°. */
export interface PerpendicularConstraint extends ConstraintBase {
  readonly kind: "perpendicular";
  readonly first: SketchEntityId;
  readonly second: SketchEntityId;
}

/** Two point targets must lie `value` mm apart. */
export interface DistanceConstraint extends ConstraintBase {
  readonly kind: "distance";
  readonly first: PointTarget;
  readonly second: PointTarget;
  readonly value: LengthValue;
}

/** The angle between two lines' directions must equal `value` (0° < θ < 180°). */
export interface AngleConstraint extends ConstraintBase {
  readonly kind: "angle";
  readonly first: SketchEntityId;
  readonly second: SketchEntityId;
  readonly value: AngleValue;
}

/** A circle/arc's radius must equal `value`. */
export interface RadiusConstraint extends ConstraintBase {
  readonly kind: "radius";
  readonly entity: SketchEntityId;
  readonly value: LengthValue;
}

/** A circle/arc's diameter must equal `value`. */
export interface DiameterConstraint extends ConstraintBase {
  readonly kind: "diameter";
  readonly entity: SketchEntityId;
  readonly value: LengthValue;
}

/** Two lines must have equal lengths, or two circles/arcs equal radii. */
export interface EqualConstraint extends ConstraintBase {
  readonly kind: "equal";
  readonly first: SketchEntityId;
  readonly second: SketchEntityId;
}

/**
 * A line must be tangent to a circle/arc, or two circles/arcs must be tangent
 * to each other. Arcs participate as their full circles; endpoint tangency is
 * modeled as tangency plus a coincident constraint on the arc endpoint.
 */
export interface TangentConstraint extends ConstraintBase {
  readonly kind: "tangent";
  readonly first: SketchEntityId;
  readonly second: SketchEntityId;
  /** Circle/arc-pair sense; defaults to `external`. */
  readonly variant: TangentVariant;
}

/** A point target must sit at a line's midpoint. */
export interface MidpointConstraint extends ConstraintBase {
  readonly kind: "midpoint";
  readonly point: PointTarget;
  readonly line: SketchEntityId;
}

/** Two point targets must be symmetric about a point or a line. */
export interface SymmetryConstraint extends ConstraintBase {
  readonly kind: "symmetry";
  readonly first: PointTarget;
  readonly second: PointTarget;
  readonly about: SymmetryAbout;
}

/** Union of every sketch constraint. */
export type SketchConstraint =
  | CoincidentConstraint
  | HorizontalConstraint
  | VerticalConstraint
  | ParallelConstraint
  | PerpendicularConstraint
  | DistanceConstraint
  | AngleConstraint
  | RadiusConstraint
  | DiameterConstraint
  | EqualConstraint
  | TangentConstraint
  | MidpointConstraint
  | SymmetryConstraint;

/** Structured failure describing why input was rejected as a constraint. */
export interface SketchConstraintError {
  readonly code: string;
  readonly message: string;
  readonly input: unknown;
}

/** Thrown by the constraint builders on invalid values. */
export class SketchConstraintValidationError extends Error {
  readonly error: SketchConstraintError;

  constructor(error: SketchConstraintError) {
    super(error.message);
    this.name = "SketchConstraintValidationError";
    this.error = error;
  }
}

function constraintError(
  code: string,
  message: string,
  input: unknown,
): SketchConstraintError {
  return { code, message, input };
}

const DEGREES_STRAIGHT = 180;

function requirePositiveLength(
  kind: SketchConstraintKind,
  value: LengthValue,
): void {
  if (!(valueIn(value, "mm") > 0)) {
    throw new SketchConstraintValidationError(
      constraintError(
        SKETCH_DIAGNOSTIC_CODES.constraintValueInvalid,
        `A ${kind} constraint value must be strictly positive mm, received ${String(valueIn(value, "mm"))} mm.`,
        value,
      ),
    );
  }
}

function requireOpenAngle(
  kind: SketchConstraintKind,
  value: AngleValue,
): void {
  const degrees = valueIn(value, "deg");
  if (!(degrees > 0 && degrees < DEGREES_STRAIGHT)) {
    throw new SketchConstraintValidationError(
      constraintError(
        SKETCH_DIAGNOSTIC_CODES.constraintValueInvalid,
        `An ${kind} constraint value must be strictly between 0° and 180° (use parallel or perpendicular at the limits), received ${String(degrees)}°.`,
        value,
      ),
    );
  }
}

/** Builds a coincident constraint between two point targets. */
export function createCoincidentConstraint(
  id: SketchConstraintId,
  first: PointTarget,
  second: PointTarget,
): CoincidentConstraint {
  return { id, kind: "coincident", first, second };
}

/** Builds a horizontal constraint on a line. */
export function createHorizontalConstraint(
  id: SketchConstraintId,
  entity: SketchEntityId,
): HorizontalConstraint {
  return { id, kind: "horizontal", entity };
}

/** Builds a vertical constraint on a line. */
export function createVerticalConstraint(
  id: SketchConstraintId,
  entity: SketchEntityId,
): VerticalConstraint {
  return { id, kind: "vertical", entity };
}

/** Builds a parallel constraint between two lines. */
export function createParallelConstraint(
  id: SketchConstraintId,
  first: SketchEntityId,
  second: SketchEntityId,
): ParallelConstraint {
  return { id, kind: "parallel", first, second };
}

/** Builds a perpendicular constraint between two lines. */
export function createPerpendicularConstraint(
  id: SketchConstraintId,
  first: SketchEntityId,
  second: SketchEntityId,
): PerpendicularConstraint {
  return { id, kind: "perpendicular", first, second };
}

/**
 * Builds a distance constraint: `value` mm between two point targets. A
 * line's length is the distance between its start and end.
 */
export function createDistanceConstraint(
  id: SketchConstraintId,
  first: PointTarget,
  second: PointTarget,
  value: LengthValue,
): DistanceConstraint {
  requirePositiveLength("distance", value);
  return { id, kind: "distance", first, second, value };
}

/** Builds an angle constraint between two lines (0° < θ < 180°). */
export function createAngleConstraint(
  id: SketchConstraintId,
  first: SketchEntityId,
  second: SketchEntityId,
  value: AngleValue,
): AngleConstraint {
  requireOpenAngle("angle", value);
  return { id, kind: "angle", first, second, value };
}

/** Builds a radius constraint on a circle or arc. */
export function createRadiusConstraint(
  id: SketchConstraintId,
  entity: SketchEntityId,
  value: LengthValue,
): RadiusConstraint {
  requirePositiveLength("radius", value);
  return { id, kind: "radius", entity, value };
}

/** Builds a diameter constraint on a circle or arc. */
export function createDiameterConstraint(
  id: SketchConstraintId,
  entity: SketchEntityId,
  value: LengthValue,
): DiameterConstraint {
  requirePositiveLength("diameter", value);
  return { id, kind: "diameter", entity, value };
}

/** Builds an equal constraint: equal lengths (lines) or radii (circles/arcs). */
export function createEqualConstraint(
  id: SketchConstraintId,
  first: SketchEntityId,
  second: SketchEntityId,
): EqualConstraint {
  return { id, kind: "equal", first, second };
}

/**
 * Builds a tangent constraint. `variant` selects the circle/arc-pair sense
 * and defaults to `external`.
 */
export function createTangentConstraint(
  id: SketchConstraintId,
  first: SketchEntityId,
  second: SketchEntityId,
  variant: TangentVariant = "external",
): TangentConstraint {
  return { id, kind: "tangent", first, second, variant };
}

/** Builds a midpoint constraint: the point target sits at the line's midpoint. */
export function createMidpointConstraint(
  id: SketchConstraintId,
  point: PointTarget,
  line: SketchEntityId,
): MidpointConstraint {
  return { id, kind: "midpoint", point, line };
}

/** Builds a symmetry constraint about a point target. */
export function createSymmetryAboutPointConstraint(
  id: SketchConstraintId,
  first: PointTarget,
  second: PointTarget,
  about: PointTarget,
): SymmetryConstraint {
  return { id, kind: "symmetry", first, second, about: { type: "point", point: about } };
}

/** Builds a symmetry constraint about a line. */
export function createSymmetryAboutLineConstraint(
  id: SketchConstraintId,
  first: PointTarget,
  second: PointTarget,
  about: SketchEntityId,
): SymmetryConstraint {
  return { id, kind: "symmetry", first, second, about: { type: "line", entity: about } };
}

function isPlainRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}

function parsePointTarget(
  input: unknown,
): ParseResult<PointTarget, SketchConstraintError> {
  if (!isPlainRecord(input)) {
    return fail(
      constraintError(
        SKETCH_DIAGNOSTIC_CODES.constraintMalformed,
        "A point target must be a plain object with entity and point fields.",
        input,
      ),
    );
  }
  const entity = parseSketchEntityId(input.entity);
  if (!entity.ok) {
    return fail(
      constraintError(
        SKETCH_DIAGNOSTIC_CODES.constraintMalformed,
        `A point target needs a valid entity id: ${entity.error.message}`,
        input,
      ),
    );
  }
  const { point } = input;
  if (
    point !== "start" &&
    point !== "end" &&
    point !== "center"
  ) {
    return fail(
      constraintError(
        SKETCH_DIAGNOSTIC_CODES.constraintMalformed,
        'A point target point must be one of: "start", "end", "center".',
        input,
      ),
    );
  }
  return ok({ entity: entity.value, point });
}

function parseEntityField(
  name: string,
  input: unknown,
  whole: unknown,
): ParseResult<SketchEntityId, SketchConstraintError> {
  const parsed = parseSketchEntityId(input);
  if (!parsed.ok) {
    return fail(
      constraintError(
        SKETCH_DIAGNOSTIC_CODES.constraintMalformed,
        `Constraint ${name} must be a valid entity id: ${parsed.error.message}`,
        whole,
      ),
    );
  }
  return parsed;
}

function parsePositiveLengthValue(
  kind: SketchConstraintKind,
  input: unknown,
): ParseResult<LengthValue, SketchConstraintError> {
  const parsed = parseDimensionalValue(input);
  if (!parsed.ok) {
    return fail(
      constraintError(
        SKETCH_DIAGNOSTIC_CODES.constraintMalformed,
        `A ${kind} constraint value must be a serialized dimensional value: ${parsed.error.message}`,
        input,
      ),
    );
  }
  const value = parsed.value;
  if (value.dimension !== "length") {
    return fail(
      constraintError(
        SKETCH_DIAGNOSTIC_CODES.constraintValueInvalid,
        `A ${kind} constraint value must be a length, received dimension "${value.dimension}".`,
        input,
      ),
    );
  }
  if (!(valueIn(value, "mm") > 0)) {
    return fail(
      constraintError(
        SKETCH_DIAGNOSTIC_CODES.constraintValueInvalid,
        `A ${kind} constraint value must be strictly positive mm, received ${String(valueIn(value, "mm"))} mm.`,
        input,
      ),
    );
  }
  return ok(value as LengthValue);
}

function parseOpenAngleValue(
  input: unknown,
): ParseResult<AngleValue, SketchConstraintError> {
  const parsed = parseDimensionalValue(input);
  if (!parsed.ok) {
    return fail(
      constraintError(
        SKETCH_DIAGNOSTIC_CODES.constraintMalformed,
        `An angle constraint value must be a serialized dimensional value: ${parsed.error.message}`,
        input,
      ),
    );
  }
  const value = parsed.value;
  if (value.dimension !== "angle") {
    return fail(
      constraintError(
        SKETCH_DIAGNOSTIC_CODES.constraintValueInvalid,
        `An angle constraint value must be an angle, received dimension "${value.dimension}".`,
        input,
      ),
    );
  }
  const degrees = valueIn(value, "deg");
  if (!(degrees > 0 && degrees < DEGREES_STRAIGHT)) {
    return fail(
      constraintError(
        SKETCH_DIAGNOSTIC_CODES.constraintValueInvalid,
        `An angle constraint value must be strictly between 0° and 180° (use parallel or perpendicular at the limits), received ${String(degrees)}°.`,
        input,
      ),
    );
  }
  return ok(value as AngleValue);
}

function parseSymmetryAbout(
  input: unknown,
): ParseResult<SymmetryAbout, SketchConstraintError> {
  if (!isPlainRecord(input)) {
    return fail(
      constraintError(
        SKETCH_DIAGNOSTIC_CODES.constraintMalformed,
        "A symmetry constraint about must be a plain object with type point or line.",
        input,
      ),
    );
  }
  if (input.type === "point") {
    const point = parsePointTarget(input.point);
    if (!point.ok) return point;
    return ok({ type: "point", point: point.value });
  }
  if (input.type === "line") {
    const entity = parseEntityField("about line", input.entity, input);
    if (!entity.ok) return entity;
    return ok({ type: "line", entity: entity.value });
  }
  return fail(
    constraintError(
      SKETCH_DIAGNOSTIC_CODES.constraintMalformed,
      'A symmetry about type must be "point" or "line".',
      input,
    ),
  );
}

/**
 * Parses untrusted input (e.g. a constraint revived from persisted JSON) as a
 * {@link SketchConstraint}. Known fields are validated strictly (dimensional
 * values must be of the right dimension and in range); unknown fields are
 * ignored so future format versions deserialize without data corruption.
 */
export function parseSketchConstraint(
  input: unknown,
): ParseResult<SketchConstraint, SketchConstraintError> {
  if (!isPlainRecord(input)) {
    return fail(
      constraintError(
        SKETCH_DIAGNOSTIC_CODES.constraintMalformed,
        "A serialized sketch constraint must be a plain object.",
        input,
      ),
    );
  }
  const id = parseSketchConstraintId(input.id);
  if (!id.ok) {
    return fail(
      constraintError(
        SKETCH_DIAGNOSTIC_CODES.constraintMalformed,
        `Sketch constraint needs a valid constraint id: ${id.error.message}`,
        input,
      ),
    );
  }
  if (!isSketchConstraintKind(input.kind)) {
    return fail(
      constraintError(
        SKETCH_DIAGNOSTIC_CODES.constraintUnknownKind,
        `Constraint kind must be one of: ${SKETCH_CONSTRAINT_KINDS.join(", ")}.`,
        input,
      ),
    );
  }
  switch (input.kind) {
    case "coincident": {
      const first = parsePointTarget(input.first);
      if (!first.ok) return first;
      const second = parsePointTarget(input.second);
      if (!second.ok) return second;
      return ok({ id: id.value, kind: "coincident", first: first.value, second: second.value });
    }
    case "horizontal":
    case "vertical": {
      const entity = parseEntityField("entity", input.entity, input);
      if (!entity.ok) return entity;
      return ok({ id: id.value, kind: input.kind, entity: entity.value });
    }
    case "parallel":
    case "perpendicular": {
      const first = parseEntityField("first", input.first, input);
      if (!first.ok) return first;
      const second = parseEntityField("second", input.second, input);
      if (!second.ok) return second;
      return ok({ id: id.value, kind: input.kind, first: first.value, second: second.value });
    }
    case "distance": {
      const first = parsePointTarget(input.first);
      if (!first.ok) return first;
      const second = parsePointTarget(input.second);
      if (!second.ok) return second;
      const value = parsePositiveLengthValue("distance", input.value);
      if (!value.ok) return value;
      return ok({
        id: id.value,
        kind: "distance",
        first: first.value,
        second: second.value,
        value: value.value,
      });
    }
    case "angle": {
      const first = parseEntityField("first", input.first, input);
      if (!first.ok) return first;
      const second = parseEntityField("second", input.second, input);
      if (!second.ok) return second;
      const value = parseOpenAngleValue(input.value);
      if (!value.ok) return value;
      return ok({
        id: id.value,
        kind: "angle",
        first: first.value,
        second: second.value,
        value: value.value,
      });
    }
    case "radius":
    case "diameter": {
      const entity = parseEntityField("entity", input.entity, input);
      if (!entity.ok) return entity;
      const value = parsePositiveLengthValue(input.kind, input.value);
      if (!value.ok) return value;
      return ok({
        id: id.value,
        kind: input.kind,
        entity: entity.value,
        value: value.value,
      });
    }
    case "equal": {
      const first = parseEntityField("first", input.first, input);
      if (!first.ok) return first;
      const second = parseEntityField("second", input.second, input);
      if (!second.ok) return second;
      return ok({ id: id.value, kind: "equal", first: first.value, second: second.value });
    }
    case "tangent": {
      const first = parseEntityField("first", input.first, input);
      if (!first.ok) return first;
      const second = parseEntityField("second", input.second, input);
      if (!second.ok) return second;
      const variant = input.variant === undefined ? "external" : input.variant;
      if (!isTangentVariant(variant)) {
        return fail(
          constraintError(
            SKETCH_DIAGNOSTIC_CODES.constraintMalformed,
            'A tangent constraint variant must be "external" or "internal".',
            input,
          ),
        );
      }
      return ok({
        id: id.value,
        kind: "tangent",
        first: first.value,
        second: second.value,
        variant,
      });
    }
    case "midpoint": {
      const point = parsePointTarget(input.point);
      if (!point.ok) return point;
      const line = parseEntityField("line", input.line, input);
      if (!line.ok) return line;
      return ok({ id: id.value, kind: "midpoint", point: point.value, line: line.value });
    }
    case "symmetry": {
      const first = parsePointTarget(input.first);
      if (!first.ok) return first;
      const second = parsePointTarget(input.second);
      if (!second.ok) return second;
      const about = parseSymmetryAbout(input.about);
      if (!about.ok) return about;
      return ok({
        id: id.value,
        kind: "symmetry",
        first: first.value,
        second: second.value,
        about: about.value,
      });
    }
  }
}

function serializePointTarget(target: PointTarget): Readonly<Record<string, unknown>> {
  return { entity: target.entity, point: target.point };
}

/**
 * Canonical JSON form of a constraint: `id`, `kind`, then operands in the
 * fixed documented order; dimensional values serialized canonically (mm/rad).
 */
export function serializeSketchConstraint(
  constraint: SketchConstraint,
): Readonly<Record<string, unknown>> {
  switch (constraint.kind) {
    case "coincident":
      return {
        id: constraint.id,
        kind: constraint.kind,
        first: serializePointTarget(constraint.first),
        second: serializePointTarget(constraint.second),
      };
    case "horizontal":
    case "vertical":
      return { id: constraint.id, kind: constraint.kind, entity: constraint.entity };
    case "parallel":
    case "perpendicular":
    case "equal":
      return {
        id: constraint.id,
        kind: constraint.kind,
        first: constraint.first,
        second: constraint.second,
      };
    case "distance":
      return {
        id: constraint.id,
        kind: constraint.kind,
        first: serializePointTarget(constraint.first),
        second: serializePointTarget(constraint.second),
        value: serializeDimensionalValue(constraint.value),
      };
    case "angle":
      return {
        id: constraint.id,
        kind: constraint.kind,
        first: constraint.first,
        second: constraint.second,
        value: serializeDimensionalValue(constraint.value),
      };
    case "radius":
    case "diameter":
      return {
        id: constraint.id,
        kind: constraint.kind,
        entity: constraint.entity,
        value: serializeDimensionalValue(constraint.value),
      };
    case "tangent":
      return {
        id: constraint.id,
        kind: constraint.kind,
        first: constraint.first,
        second: constraint.second,
        variant: constraint.variant,
      };
    case "midpoint":
      return {
        id: constraint.id,
        kind: constraint.kind,
        point: serializePointTarget(constraint.point),
        line: constraint.line,
      };
    case "symmetry": {
      const about =
        constraint.about.type === "point"
          ? { type: "point", point: serializePointTarget(constraint.about.point) }
          : { type: "line", entity: constraint.about.entity };
      return {
        id: constraint.id,
        kind: constraint.kind,
        first: serializePointTarget(constraint.first),
        second: serializePointTarget(constraint.second),
        about,
      };
    }
  }
}

function isLine(entity: SketchEntity): entity is LineEntity {
  return entity.kind === "line";
}

function isCircular(
  entity: SketchEntity,
): entity is CircleEntity | ArcEntity {
  return entity.kind === "circle" || entity.kind === "arc";
}

function targetKindProblem(
  target: PointTarget,
  entity: SketchEntity,
): string | null {
  switch (entity.kind) {
    case "point":
    case "circle":
      return target.point === "center"
        ? null
        : `a ${entity.kind} only offers its "center"`;
    case "line":
    case "arc":
      return null;
    case "rectangle":
      return "a rectangle has no point targets; constrain its edge lines";
  }
}

/**
 * Validates that a constraint's entity references resolve against the given
 * entity list and that operand kinds are compatible with the constraint
 * kind (the checks documented on each constraint interface). Returns a
 * malformed-reference diagnostic, or `null` when the references are valid.
 * The solver runs the same validation so it can reject malformed input with
 * structured diagnostics instead of throwing.
 */
export function validateConstraintReferences(
  constraint: SketchConstraint,
  entities: readonly SketchEntity[],
): SketchDiagnostic | null {
  const byId = new Map<string, SketchEntity>(
    entities.map((entity) => [entity.id, entity]),
  );
  const find = (id: SketchEntityId): SketchEntity | undefined => byId.get(id);
  const checkTarget = (target: PointTarget): string | null => {
    const entity = find(target.entity);
    if (entity === undefined) {
      return `references missing entity ${target.entity}`;
    }
    return targetKindProblem(target, entity);
  };
  const requireLine = (name: string, id: SketchEntityId): string | null => {
    const entity = find(id);
    if (entity === undefined) return `${name} references missing entity ${id}`;
    return isLine(entity) ? null : `${name} must reference a line, found ${entity.kind}`;
  };
  const requireCircular = (name: string, id: SketchEntityId): string | null => {
    const entity = find(id);
    if (entity === undefined) return `${name} references missing entity ${id}`;
    return isCircular(entity)
      ? null
      : `${name} must reference a circle or arc, found ${entity.kind}`;
  };
  let problem: string | null = null;
  switch (constraint.kind) {
    case "coincident":
      problem = checkTarget(constraint.first) ?? checkTarget(constraint.second);
      break;
    case "horizontal":
    case "vertical":
      problem = requireLine("entity", constraint.entity);
      break;
    case "parallel":
    case "perpendicular":
      problem =
        requireLine("first", constraint.first) ??
        requireLine("second", constraint.second);
      break;
    case "distance":
      problem = checkTarget(constraint.first) ?? checkTarget(constraint.second);
      break;
    case "angle":
      problem =
        requireLine("first", constraint.first) ??
        requireLine("second", constraint.second);
      break;
    case "radius":
    case "diameter":
      problem = requireCircular("entity", constraint.entity);
      break;
    case "equal": {
      const first = find(constraint.first);
      const second = find(constraint.second);
      if (first === undefined || second === undefined) {
        problem = `equal references missing entity ${
          first === undefined ? constraint.first : constraint.second
        }`;
        break;
      }
      if (isLine(first) && isLine(second)) break;
      if (isCircular(first) && isCircular(second)) break;
      problem = `equal must reference two lines (equal lengths) or two circles/arcs (equal radii), found ${first.kind} and ${second.kind}`;
      break;
    }
    case "tangent": {
      const first = find(constraint.first);
      const second = find(constraint.second);
      if (first === undefined || second === undefined) {
        problem = `tangent references missing entity ${
          first === undefined ? constraint.first : constraint.second
        }`;
        break;
      }
      const pairsOk =
        (isLine(first) && isCircular(second)) ||
        (isCircular(first) && isLine(second)) ||
        (isCircular(first) && isCircular(second));
      problem = pairsOk
        ? null
        : `tangent must reference a line and a circle/arc, or two circles/arcs, found ${first.kind} and ${second.kind}`;
      break;
    }
    case "midpoint":
      problem =
        checkTarget(constraint.point) ?? requireLine("line", constraint.line);
      break;
    case "symmetry":
      problem = checkTarget(constraint.first) ?? checkTarget(constraint.second);
      if (problem === null) {
        problem =
          constraint.about.type === "point"
            ? checkTarget(constraint.about.point)
            : requireLine("about", constraint.about.entity);
      }
      break;
  }
  return problem === null ? null : referenceDiagnostic(constraint, problem);
}

function referenceDiagnostic(
  constraint: SketchConstraint,
  problem: string,
): SketchDiagnostic {
  return {
    severity: "error",
    code: SKETCH_DIAGNOSTIC_CODES.constraintReferenceMalformed,
    message: `Constraint ${constraint.id} (${constraint.kind}) ${problem}.`,
    location: { primary: constraint.id },
  };
}
