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
 * - `equal(first, second)` — equal lengths (two lines), equal radii (two
 *   circles/arcs), or equal endpoint chords (lines and splines: a spline
 *   counts the distance between its first and last stored point); other
 *   pairs are rejected as malformed.
 * - `tangent(first, second, variant?)` — a line tangent to a circle/arc
 *   (infinite line, not segment), two circles/arcs tangent `external`
 *   (default: centers r1+r2 apart) or `internal` (|r1−r2| apart), a line
 *   tangent to a spline ANYWHERE on the curve (1 equation, the contact
 *   eliminated at a stationary anchor), or two splines joined G1 at
 *   first.end ↔ second.start (3 equations: coincidence plus matching
 *   tangent directions).
 * - `midpoint(point, line)` — the point target sits at the line's midpoint
 *   (2 equations).
 * - `symmetry(first, second, about)` — two point targets symmetric about a
 *   third point (point symmetry), or about a line (midpoint on the line and
 *   the connecting segment perpendicular to it; 2 equations each way).
 * - `pointOnEntity(point, entity)` — the point target lies on the entity's
 *   curve (1 equation). Operand kinds: line (the infinite line, like
 *   tangency), circle, arc (as its full circle — the tangency convention),
 *   ellipse/ellipticalArc (the exact implicit ellipse — arcs participate as
 *   their full ellipse), spline (the frozen-parameter projection onto
 *   the tessellated chord form; see `residuals.ts` for the pinned honesty),
 *   polygon (the boundary perimeter — a stateless per-evaluation min over
 *   the edges), and a straight slot (the stadium boundary — edges plus
 *   gated caps; the arc3 variant stays outside the subset).
 * - `pointOnTangent(point, spline, at?)` — the point target lies on the
 *   line through the spline's `at` end (default `"end"`) along that end's
 *   tangent (1 equation, mm).
 * - `parallel` / `perpendicular` / `angle` accept a spline in place of one
 *   line: the row addresses the spline's END tangent (the `at` operand,
 *   default `"end"`) — direction-only, the line↔line convention; full
 *   contact composes with a point-on/tangency row.
 * - `collinear(first, second)` — two lines lie on one infinite line (2
 *   equations: both endpoints of `second` sit on `first`'s line).
 * - `horizontalPair(first, second)` — two point targets share y (1
 *   equation).
 * - `verticalPair(first, second)` — two point targets share x (1 equation).
 * - `distanceX(first, second, value)` — SIGNED mm from first to second
 *   along workplane x: `x_second − x_first = value` (1 equation; any finite
 *   value — negative and zero included, unlike `distance`).
 * - `distanceY(first, second, value)` — the same along workplane y.
 *
 * ## The spline operand subset (Phase 36 pinned it; Phase 37 closed it)
 *
 * Spline entities accept point-target constraints on their `start`/`end`
 * (coincident, distance, distanceX/Y, horizontalPair/verticalPair,
 * midpoint, symmetry), `pointOnEntity` onto them, the `fixed` pin, and —
 * since Phase 37 — `tangent` (a line anywhere on the curve, or a G1 joint
 * between two splines), `parallel`/`perpendicular`/`angle` against a spline
 * END tangent (the `at` operand), `equal` endpoint chords, and
 * `pointOnTangent`. Still OUTSIDE the scope and declined at validation with
 * `sketch/constraint-unsupported`, never a silent mis-solve: radius and
 * diameter (a spline has no radius parameter), collinear (its meaningful
 * spline reading is `pointOnTangent`), and horizontal/vertical (single-line
 * kinds). Anywhere spline↔spline tangency needs constraint-owned auxiliary
 * solver unknowns and stays a staged design (see
 * `docs/design/spline-constraint-math.md` §1.6).
 */

import {
  type AngleValue,
  type LengthValue,
  type ParameterId,
  type ParseResult,
  fail,
  ok,
  parseDimensionalValue,
  parseParameterId,
  serializeDimensionalValue,
  valueIn,
} from "@slopcad/cad-core";
import type { SketchDiagnostic } from "./diagnostics";
import type {
  ArcEntity,
  CircleEntity,
  LineEntity,
  PolygonEntity,
  SketchEntity,
  SlotEntity,
  SplineEntity,
} from "./entities";

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
  "pointOnEntity",
  "pointOnTangent",
  "collinear",
  "horizontalPair",
  "verticalPair",
  "distanceX",
  "distanceY",
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
 * angles); `center` is a point entity's position, a line's midpoint, a
 * circle/arc center, an ellipse's center, a polygon's center, or a slot's
 * anchor (the cap-center midpoint for `straight`, the through point for
 * `arc3`). New-entity targets: an elliptical arc's `start`/`end` lie on the
 * curve at its start/end PARAMETERS (the parametric point, not a polar
 * angle); a full ellipse's `start` is its major-axis end (the radiusX
 * direction) and `end` its minor-axis end; a spline offers only
 * `start`/`end` (its first/last stored point — the curve passes through
 * both); a polygon's `start`/`end` are its first and second vertices (the
 * first sits at the entity's `rotation`); a slot's `start`/`end` are its
 * cap centers.
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

/**
 * Which end of a spline a constraint attaches to. End tangents are the
 * meaningful anchor for direction constraints on splines: a spline's
 * tangent sweeps all directions along the curve, so an "anywhere"
 * direction-only constraint would be vacuous.
 */
export const SPLINE_END_SELECTIONS = ["start", "end"] as const;

export type SplineEndSelection = (typeof SPLINE_END_SELECTIONS)[number];

/** Type guard for untrusted spline end selections. */
export function isSplineEndSelection(
  input: unknown,
): input is SplineEndSelection {
  return (
    typeof input === "string" &&
    (SPLINE_END_SELECTIONS as readonly string[]).includes(input)
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

/**
 * Two lines must be parallel (either sense), or a line's direction must be
 * parallel to a spline's END tangent (the cross product, sign-blind).
 */
export interface ParallelConstraint extends ConstraintBase {
  readonly kind: "parallel";
  readonly first: SketchEntityId;
  readonly second: SketchEntityId;
  /**
   * The spline operand's end whose tangent the row addresses (present only
   * when an operand is a spline; `"end"` when absent).
   */
  readonly at?: SplineEndSelection;
}

/**
 * Two lines must meet at 90°, or a line's direction must be perpendicular
 * to a spline's END tangent (direction-only — full contact composes this
 * with a contact row, the same layering the line↔line kind implies).
 */
export interface PerpendicularConstraint extends ConstraintBase {
  readonly kind: "perpendicular";
  readonly first: SketchEntityId;
  readonly second: SketchEntityId;
  /** The spline operand's end whose tangent the row addresses; `"end"`. */
  readonly at?: SplineEndSelection;
}

/**
 * Two point targets must lie `value` mm apart.
 *
 * ## The parameter binding (all six dimensional kinds)
 *
 * A dimensional constraint carries an optional `parameterId`: when present
 * the constraint is BOUND to a document parameter and its effective value
 * resolves from a caller-supplied parameter lookup at solve/profile time
 * (see `dimension-bindings.ts`) instead of from the stored literal. The
 * stored `value` remains and always satisfies the kind's range rules — it
 * is the literal the constraint last held (its authoring value or the last
 * literal set), kept so the serialized record stays a self-contained v2
 * payload. Absent `parameterId` = the plain literal constraint, exactly as
 * every sketch before bindings serialized.
 */
export interface DistanceConstraint extends ConstraintBase {
  readonly kind: "distance";
  readonly first: PointTarget;
  readonly second: PointTarget;
  readonly value: LengthValue;
  /** The document parameter the dimension is bound to, when bound. */
  readonly parameterId?: ParameterId;
}

/**
 * The angle between two lines' directions must equal `value` (0° < θ <
 * 180°) — or, with a spline operand, the angle between the line's direction
 * and the spline's END tangent (the same unsigned [0°, 180°] convention).
 */
export interface AngleConstraint extends ConstraintBase {
  readonly kind: "angle";
  readonly first: SketchEntityId;
  readonly second: SketchEntityId;
  readonly value: AngleValue;
  /** The spline operand's end whose tangent the row addresses; `"end"`. */
  readonly at?: SplineEndSelection;
  /** The document parameter the dimension is bound to, when bound. */
  readonly parameterId?: ParameterId;
}

/**
 * A radial entity's radius must equal `value`: a circle's or arc's own
 * radius, a polygon's authored radius (circumradius when `inscribed`,
 * inradius when `circumscribed`), or a slot's cap radius.
 */
export interface RadiusConstraint extends ConstraintBase {
  readonly kind: "radius";
  readonly entity: SketchEntityId;
  readonly value: LengthValue;
  /** The document parameter the dimension is bound to, when bound. */
  readonly parameterId?: ParameterId;
}

/** A radial entity's diameter must equal `value` (2× the radius). */
export interface DiameterConstraint extends ConstraintBase {
  readonly kind: "diameter";
  readonly entity: SketchEntityId;
  readonly value: LengthValue;
  /** The document parameter the dimension is bound to, when bound. */
  readonly parameterId?: ParameterId;
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
 *
 * Spline operands (Phase 37): `tangent(line, spline)` is ANYWHERE tangency —
 * the contact slides along the curve, codimension 1 like line↔circle. Two
 * splines form a G1 JOINT: the first operand's end coincides with the
 * second's start and the end/start tangents share direction (codimension 3).
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

/**
 * A point target must lie on an entity's curve: line (infinite line),
 * circle, arc (as its full circle), ellipse/ellipticalArc (the exact
 * implicit ellipse), spline (frozen-parameter projection — see the
 * module's spline scope note), polygon (the boundary — a stateless
 * per-evaluation min over the perimeter segments), or a STRAIGHT slot (the
 * stadium boundary — edges plus gated semicircular caps). The arc3 slot
 * variant stays outside the solving subset.
 */
export interface PointOnEntityConstraint extends ConstraintBase {
  readonly kind: "pointOnEntity";
  readonly point: PointTarget;
  readonly entity: SketchEntityId;
}

/**
 * A point target must lie on the line through a spline's end along that
 * end's tangent — "collinear with the spline's end tangent" (mm, the
 * point-on-line scale). For the control flavor this is literally
 * collinearity with the first/last tangent-handle pair.
 */
export interface PointOnTangentConstraint extends ConstraintBase {
  readonly kind: "pointOnTangent";
  readonly point: PointTarget;
  readonly spline: SketchEntityId;
  /** Which end's tangent line; defaults to `"end"`. */
  readonly at: SplineEndSelection;
}

/** Two lines must lie on one infinite line. */
export interface CollinearConstraint extends ConstraintBase {
  readonly kind: "collinear";
  readonly first: SketchEntityId;
  readonly second: SketchEntityId;
}

/** Two point targets must share y. */
export interface HorizontalPairConstraint extends ConstraintBase {
  readonly kind: "horizontalPair";
  readonly first: PointTarget;
  readonly second: PointTarget;
}

/** Two point targets must share x. */
export interface VerticalPairConstraint extends ConstraintBase {
  readonly kind: "verticalPair";
  readonly first: PointTarget;
  readonly second: PointTarget;
}
/**
 * Signed workplane-x separation of two point targets:
 * `x_second − x_first = value` (any finite mm, negative and zero included).
 */
export interface DistanceXConstraint extends ConstraintBase {
  readonly kind: "distanceX";
  readonly first: PointTarget;
  readonly second: PointTarget;
  readonly value: LengthValue;
  /** The document parameter the dimension is bound to, when bound. */
  readonly parameterId?: ParameterId;
}

/**
 * Signed workplane-y separation of two point targets:
 * `y_second − y_first = value` (any finite mm, negative and zero included).
 */
export interface DistanceYConstraint extends ConstraintBase {
  readonly kind: "distanceY";
  readonly first: PointTarget;
  readonly second: PointTarget;
  readonly value: LengthValue;
  /** The document parameter the dimension is bound to, when bound. */
  readonly parameterId?: ParameterId;
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
  | SymmetryConstraint
  | PointOnEntityConstraint
  | PointOnTangentConstraint
  | CollinearConstraint
  | HorizontalPairConstraint
  | VerticalPairConstraint
  | DistanceXConstraint
  | DistanceYConstraint;

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

function requireOpenAngle(kind: SketchConstraintKind, value: AngleValue): void {
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

/**
 * Signed dimensional values (`distanceX`/`distanceY`): any finite mm —
 * negative and zero are legal (the separation is signed first→second),
 * non-finite is not.
 */
function requireFiniteSignedLength(
  kind: SketchConstraintKind,
  value: LengthValue,
): void {
  if (!Number.isFinite(valueIn(value, "mm"))) {
    throw new SketchConstraintValidationError(
      constraintError(
        SKETCH_DIAGNOSTIC_CODES.constraintValueInvalid,
        `A ${kind} constraint value must be a finite number of mm, received ${String(valueIn(value, "mm"))}.`,
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

/**
 * Builds a parallel constraint between two lines, or between a line and a
 * spline's end tangent (`at`, default `"end"`).
 */
export function createParallelConstraint(
  id: SketchConstraintId,
  first: SketchEntityId,
  second: SketchEntityId,
  at?: SplineEndSelection,
): ParallelConstraint {
  return at === undefined
    ? { id, kind: "parallel", first, second }
    : { id, kind: "parallel", first, second, at };
}

/**
 * Builds a perpendicular constraint between two lines, or between a line
 * and a spline's end tangent (`at`, default `"end"`).
 */
export function createPerpendicularConstraint(
  id: SketchConstraintId,
  first: SketchEntityId,
  second: SketchEntityId,
  at?: SplineEndSelection,
): PerpendicularConstraint {
  return at === undefined
    ? { id, kind: "perpendicular", first, second }
    : { id, kind: "perpendicular", first, second, at };
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

/**
 * Builds an angle constraint between two lines, or between a line and a
 * spline's end tangent (`at`, default `"end"`); 0° < θ < 180°.
 */
export function createAngleConstraint(
  id: SketchConstraintId,
  first: SketchEntityId,
  second: SketchEntityId,
  value: AngleValue,
  at?: SplineEndSelection,
): AngleConstraint {
  requireOpenAngle("angle", value);
  return at === undefined
    ? { id, kind: "angle", first, second, value }
    : { id, kind: "angle", first, second, value, at };
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
  return {
    id,
    kind: "symmetry",
    first,
    second,
    about: { type: "point", point: about },
  };
}

/** Builds a symmetry constraint about a line. */
export function createSymmetryAboutLineConstraint(
  id: SketchConstraintId,
  first: PointTarget,
  second: PointTarget,
  about: SketchEntityId,
): SymmetryConstraint {
  return {
    id,
    kind: "symmetry",
    first,
    second,
    about: { type: "line", entity: about },
  };
}

/** Builds a point-on-entity constraint (see {@link PointOnEntityConstraint}). */
export function createPointOnEntityConstraint(
  id: SketchConstraintId,
  point: PointTarget,
  entity: SketchEntityId,
): PointOnEntityConstraint {
  return { id, kind: "pointOnEntity", point, entity };
}

/**
 * Builds a point-on-end-tangent constraint: the point target lies on the
 * line through the spline's `at` end along that end's tangent.
 */
export function createPointOnTangentConstraint(
  id: SketchConstraintId,
  point: PointTarget,
  spline: SketchEntityId,
  at: SplineEndSelection = "end",
): PointOnTangentConstraint {
  return { id, kind: "pointOnTangent", point, spline, at };
}

/** Builds a collinear constraint between two lines. */
export function createCollinearConstraint(
  id: SketchConstraintId,
  first: SketchEntityId,
  second: SketchEntityId,
): CollinearConstraint {
  return { id, kind: "collinear", first, second };
}

/** Builds a horizontal point-pair constraint (two point targets share y). */
export function createHorizontalPairConstraint(
  id: SketchConstraintId,
  first: PointTarget,
  second: PointTarget,
): HorizontalPairConstraint {
  return { id, kind: "horizontalPair", first, second };
}

/** Builds a vertical point-pair constraint (two point targets share x). */
export function createVerticalPairConstraint(
  id: SketchConstraintId,
  first: PointTarget,
  second: PointTarget,
): VerticalPairConstraint {
  return { id, kind: "verticalPair", first, second };
}

/** Builds a signed distanceX constraint (any finite mm, first→second). */
export function createDistanceXConstraint(
  id: SketchConstraintId,
  first: PointTarget,
  second: PointTarget,
  value: LengthValue,
): DistanceXConstraint {
  requireFiniteSignedLength("distanceX", value);
  return { id, kind: "distanceX", first, second, value };
}

/** Builds a signed distanceY constraint (any finite mm, first→second). */
export function createDistanceYConstraint(
  id: SketchConstraintId,
  first: PointTarget,
  second: PointTarget,
  value: LengthValue,
): DistanceYConstraint {
  requireFiniteSignedLength("distanceY", value);
  return { id, kind: "distanceY", first, second, value };
}

/**
 * The document parameter a dimensional constraint is bound to, or `null`
 * when the constraint is a plain literal (or not dimensional at all). The
 * one read seam for the binding — the solver's compile step refuses
 * constraints where this is non-null (bindings resolve before solving, see
 * `dimension-bindings.ts`), and presentation/command layers branch on it.
 */
export function boundDimensionParameterId(
  constraint: SketchConstraint,
): ParameterId | null {
  switch (constraint.kind) {
    case "distance":
      return constraint.parameterId ?? null;
    case "angle":
      return constraint.parameterId ?? null;
    case "radius":
      return constraint.parameterId ?? null;
    case "diameter":
      return constraint.parameterId ?? null;
    case "distanceX":
      return constraint.parameterId ?? null;
    case "distanceY":
      return constraint.parameterId ?? null;
    default:
      return null;
  }
}

/**
 * Parses a serialized constraint's optional `parameterId` binding field:
 * absent means "no binding"; a present value must be a valid parameter id.
 */
function parseOptionalParameterBinding(
  input: unknown,
  whole: unknown,
): ParseResult<ParameterId | undefined, SketchConstraintError> {
  if (input === undefined) return ok(undefined);
  const parsed = parseParameterId(input);
  if (!parsed.ok) {
    return fail(
      constraintError(
        SKETCH_DIAGNOSTIC_CODES.constraintMalformed,
        `A constraint's parameter binding must be a valid parameter id: ${parsed.error.message}`,
        whole,
      ),
    );
  }
  return ok(parsed.value);
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
  if (point !== "start" && point !== "end" && point !== "center") {
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

/**
 * Parses a direction constraint's optional spline-end operand: absent means
 * `"end"`; a present value must name an end.
 */
function parseOptionalSplineEnd(
  input: unknown,
  whole: unknown,
): ParseResult<SplineEndSelection | undefined, SketchConstraintError> {
  if (input === undefined) return ok(undefined);
  if (!isSplineEndSelection(input)) {
    return fail(
      constraintError(
        SKETCH_DIAGNOSTIC_CODES.constraintMalformed,
        'A constraint\'s spline end operand must be "start" or "end".',
        whole,
      ),
    );
  }
  return ok(input);
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

function parseSignedLengthValue(
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
  if (!Number.isFinite(valueIn(value, "mm"))) {
    return fail(
      constraintError(
        SKETCH_DIAGNOSTIC_CODES.constraintValueInvalid,
        `A ${kind} constraint value must be a finite number of mm, received ${String(valueIn(value, "mm"))}.`,
        input,
      ),
    );
  }
  return ok(value as LengthValue);
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
      return ok({
        id: id.value,
        kind: "coincident",
        first: first.value,
        second: second.value,
      });
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
      const at = parseOptionalSplineEnd(input.at, input);
      if (!at.ok) return at;
      return at.value === undefined
        ? ok({
            id: id.value,
            kind: input.kind,
            first: first.value,
            second: second.value,
          })
        : ok({
            id: id.value,
            kind: input.kind,
            first: first.value,
            second: second.value,
            at: at.value,
          });
    }
    case "distance": {
      const first = parsePointTarget(input.first);
      if (!first.ok) return first;
      const second = parsePointTarget(input.second);
      if (!second.ok) return second;
      const value = parsePositiveLengthValue("distance", input.value);
      if (!value.ok) return value;
      const parameterId = parseOptionalParameterBinding(
        input.parameterId,
        input,
      );
      if (!parameterId.ok) return parameterId;
      return ok({
        id: id.value,
        kind: "distance",
        first: first.value,
        second: second.value,
        value: value.value,
        ...(parameterId.value === undefined
          ? {}
          : { parameterId: parameterId.value }),
      });
    }
    case "angle": {
      const first = parseEntityField("first", input.first, input);
      if (!first.ok) return first;
      const second = parseEntityField("second", input.second, input);
      if (!second.ok) return second;
      const value = parseOpenAngleValue(input.value);
      if (!value.ok) return value;
      const at = parseOptionalSplineEnd(input.at, input);
      if (!at.ok) return at;
      const parameterId = parseOptionalParameterBinding(
        input.parameterId,
        input,
      );
      if (!parameterId.ok) return parameterId;
      return ok({
        id: id.value,
        kind: "angle",
        first: first.value,
        second: second.value,
        value: value.value,
        ...(at.value === undefined ? {} : { at: at.value }),
        ...(parameterId.value === undefined
          ? {}
          : { parameterId: parameterId.value }),
      });
    }
    case "radius":
    case "diameter": {
      const entity = parseEntityField("entity", input.entity, input);
      if (!entity.ok) return entity;
      const value = parsePositiveLengthValue(input.kind, input.value);
      if (!value.ok) return value;
      const parameterId = parseOptionalParameterBinding(
        input.parameterId,
        input,
      );
      if (!parameterId.ok) return parameterId;
      return ok({
        id: id.value,
        kind: input.kind,
        entity: entity.value,
        value: value.value,
        ...(parameterId.value === undefined
          ? {}
          : { parameterId: parameterId.value }),
      });
    }
    case "equal": {
      const first = parseEntityField("first", input.first, input);
      if (!first.ok) return first;
      const second = parseEntityField("second", input.second, input);
      if (!second.ok) return second;
      return ok({
        id: id.value,
        kind: "equal",
        first: first.value,
        second: second.value,
      });
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
      return ok({
        id: id.value,
        kind: "midpoint",
        point: point.value,
        line: line.value,
      });
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
    case "pointOnEntity": {
      const point = parsePointTarget(input.point);
      if (!point.ok) return point;
      const entity = parseEntityField("entity", input.entity, input);
      if (!entity.ok) return entity;
      return ok({
        id: id.value,
        kind: "pointOnEntity",
        point: point.value,
        entity: entity.value,
      });
    }
    case "pointOnTangent": {
      const point = parsePointTarget(input.point);
      if (!point.ok) return point;
      const spline = parseEntityField("spline", input.spline, input);
      if (!spline.ok) return spline;
      const at = parseOptionalSplineEnd(
        input.at === undefined ? "end" : input.at,
        input,
      );
      if (!at.ok) return at;
      const end = at.value ?? "end";
      return ok({
        id: id.value,
        kind: "pointOnTangent",
        point: point.value,
        spline: spline.value,
        at: end,
      });
    }
    case "collinear": {
      const first = parseEntityField("first", input.first, input);
      if (!first.ok) return first;
      const second = parseEntityField("second", input.second, input);
      if (!second.ok) return second;
      return ok({
        id: id.value,
        kind: "collinear",
        first: first.value,
        second: second.value,
      });
    }
    case "horizontalPair":
    case "verticalPair": {
      const first = parsePointTarget(input.first);
      if (!first.ok) return first;
      const second = parsePointTarget(input.second);
      if (!second.ok) return second;
      return ok({
        id: id.value,
        kind: input.kind,
        first: first.value,
        second: second.value,
      });
    }
    case "distanceX":
    case "distanceY": {
      const first = parsePointTarget(input.first);
      if (!first.ok) return first;
      const second = parsePointTarget(input.second);
      if (!second.ok) return second;
      const value = parseSignedLengthValue(input.kind, input.value);
      if (!value.ok) return value;
      const parameterId = parseOptionalParameterBinding(
        input.parameterId,
        input,
      );
      if (!parameterId.ok) return parameterId;
      return ok({
        id: id.value,
        kind: input.kind,
        first: first.value,
        second: second.value,
        value: value.value,
        ...(parameterId.value === undefined
          ? {}
          : { parameterId: parameterId.value }),
      });
    }
  }
}

function serializePointTarget(
  target: PointTarget,
): Readonly<Record<string, unknown>> {
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
      return {
        id: constraint.id,
        kind: constraint.kind,
        entity: constraint.entity,
      };
    case "parallel":
    case "perpendicular":
      return constraint.at === undefined
        ? {
            id: constraint.id,
            kind: constraint.kind,
            first: constraint.first,
            second: constraint.second,
          }
        : {
            id: constraint.id,
            kind: constraint.kind,
            first: constraint.first,
            second: constraint.second,
            at: constraint.at,
          };
    case "equal":
      return {
        id: constraint.id,
        kind: constraint.kind,
        first: constraint.first,
        second: constraint.second,
      };
    case "distance":
      return constraint.parameterId === undefined
        ? {
            id: constraint.id,
            kind: constraint.kind,
            first: serializePointTarget(constraint.first),
            second: serializePointTarget(constraint.second),
            value: serializeDimensionalValue(constraint.value),
          }
        : {
            id: constraint.id,
            kind: constraint.kind,
            first: serializePointTarget(constraint.first),
            second: serializePointTarget(constraint.second),
            value: serializeDimensionalValue(constraint.value),
            parameterId: constraint.parameterId,
          };
    case "angle":
      return constraint.at === undefined
        ? constraint.parameterId === undefined
          ? {
              id: constraint.id,
              kind: constraint.kind,
              first: constraint.first,
              second: constraint.second,
              value: serializeDimensionalValue(constraint.value),
            }
          : {
              id: constraint.id,
              kind: constraint.kind,
              first: constraint.first,
              second: constraint.second,
              value: serializeDimensionalValue(constraint.value),
              parameterId: constraint.parameterId,
            }
        : constraint.parameterId === undefined
          ? {
              id: constraint.id,
              kind: constraint.kind,
              first: constraint.first,
              second: constraint.second,
              value: serializeDimensionalValue(constraint.value),
              at: constraint.at,
            }
          : {
              id: constraint.id,
              kind: constraint.kind,
              first: constraint.first,
              second: constraint.second,
              value: serializeDimensionalValue(constraint.value),
              at: constraint.at,
              parameterId: constraint.parameterId,
            };
    case "radius":
    case "diameter":
      return constraint.parameterId === undefined
        ? {
            id: constraint.id,
            kind: constraint.kind,
            entity: constraint.entity,
            value: serializeDimensionalValue(constraint.value),
          }
        : {
            id: constraint.id,
            kind: constraint.kind,
            entity: constraint.entity,
            value: serializeDimensionalValue(constraint.value),
            parameterId: constraint.parameterId,
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
          ? {
              type: "point",
              point: serializePointTarget(constraint.about.point),
            }
          : { type: "line", entity: constraint.about.entity };
      return {
        id: constraint.id,
        kind: constraint.kind,
        first: serializePointTarget(constraint.first),
        second: serializePointTarget(constraint.second),
        about,
      };
    }
    case "pointOnEntity":
      return {
        id: constraint.id,
        kind: constraint.kind,
        point: serializePointTarget(constraint.point),
        entity: constraint.entity,
      };
    case "pointOnTangent":
      return {
        id: constraint.id,
        kind: constraint.kind,
        point: serializePointTarget(constraint.point),
        spline: constraint.spline,
        at: constraint.at,
      };
    case "collinear":
      return {
        id: constraint.id,
        kind: constraint.kind,
        first: constraint.first,
        second: constraint.second,
      };
    case "horizontalPair":
    case "verticalPair":
      return {
        id: constraint.id,
        kind: constraint.kind,
        first: serializePointTarget(constraint.first),
        second: serializePointTarget(constraint.second),
      };
    case "distanceX":
    case "distanceY":
      return constraint.parameterId === undefined
        ? {
            id: constraint.id,
            kind: constraint.kind,
            first: serializePointTarget(constraint.first),
            second: serializePointTarget(constraint.second),
            value: serializeDimensionalValue(constraint.value),
          }
        : {
            id: constraint.id,
            kind: constraint.kind,
            first: serializePointTarget(constraint.first),
            second: serializePointTarget(constraint.second),
            value: serializeDimensionalValue(constraint.value),
            parameterId: constraint.parameterId,
          };
  }
}

function isLine(entity: SketchEntity): entity is LineEntity {
  return entity.kind === "line";
}

function isCircular(entity: SketchEntity): entity is CircleEntity | ArcEntity {
  return entity.kind === "circle" || entity.kind === "arc";
}

/**
 * Entity kinds the `radius`/`diameter` constraints dimension: circles and
 * arcs (their own radius), polygons (the authored radius — circumradius
 * when `inscribed`, inradius when `circumscribed`), and slots (the cap
 * radius both variants carry).
 */
function isRadial(
  entity: SketchEntity,
): entity is CircleEntity | ArcEntity | PolygonEntity | SlotEntity {
  return (
    entity.kind === "circle" ||
    entity.kind === "arc" ||
    entity.kind === "polygon" ||
    entity.kind === "slot"
  );
}

function isSpline(entity: SketchEntity): entity is SplineEntity {
  return entity.kind === "spline";
}

/**
 * Entity kinds `pointOnEntity` accepts: line (infinite line), circle, arc
 * (as their full circle), ellipse/ellipticalArc (the implicit ellipse),
 * spline (frozen-parameter projection), polygon (the boundary perimeter),
 * and a STRAIGHT slot (the stadium boundary). The arc3 slot variant stays
 * outside the subset until the straight-slot row has fixture coverage.
 */
function pointOnEntityKindProblem(entity: SketchEntity): string | null {
  switch (entity.kind) {
    case "line":
    case "circle":
    case "arc":
    case "ellipse":
    case "ellipticalArc":
    case "spline":
    case "polygon":
      return null;
    case "slot":
      return entity.variant === "straight"
        ? null
        : "an arc3 slot's boundary arcs are not yet a pointOnEntity operand; constrain the straight variant";
    case "point":
      return "a point has no curve to lie on (use coincident)";
    case "rectangle":
      return "a rectangle has no curve of its own; constrain its edge lines";
  }
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
    case "ellipse":
    case "ellipticalArc":
    case "polygon":
    case "slot":
      return null;
    case "spline":
      return target.point === "center"
        ? 'a spline has no "center"; it offers "start" and "end" (its first/last stored point)'
        : null;
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
/**
 * Constraint kinds still outside the spline solving scope (module docs): a
 * spline operand on one of these declines with
 * `sketch/constraint-unsupported` instead of the malformed-reference
 * failure — the constraint is well-formed; the solver surface does not
 * reach splines for it. (Phase 37 moved tangent, equal, parallel,
 * perpendicular, and angle into the supported pairs; these kinds have no
 * spline meaning at all — a spline has no radius parameter, `collinear`
 * reduces to the end-tangent row `pointOnTangent` carries, and
 * horizontal/vertical address single lines.)
 */
const SPLINE_SCOPE_UNSUPPORTED: ReadonlySet<SketchConstraintKind> =
  new Set<SketchConstraintKind>([
    "radius",
    "diameter",
    "collinear",
    "horizontal",
    "vertical",
  ]);

/** The entity ids a constraint's operands mention, in operand order. */
function constraintEntityOperands(
  constraint: SketchConstraint,
): readonly SketchEntityId[] {
  switch (constraint.kind) {
    case "coincident":
    case "distance":
    case "distanceX":
    case "distanceY":
    case "horizontalPair":
    case "verticalPair":
      return [constraint.first.entity, constraint.second.entity];
    case "symmetry":
      return constraint.about.type === "point"
        ? [
            constraint.first.entity,
            constraint.second.entity,
            constraint.about.point.entity,
          ]
        : [
            constraint.first.entity,
            constraint.second.entity,
            constraint.about.entity,
          ];
    case "midpoint":
      return [constraint.point.entity, constraint.line];
    case "horizontal":
    case "vertical":
    case "radius":
    case "diameter":
      return [constraint.entity];
    case "parallel":
    case "perpendicular":
    case "angle":
    case "equal":
    case "tangent":
    case "collinear":
      return [constraint.first, constraint.second];
    case "pointOnEntity":
      return [constraint.point.entity, constraint.entity];
    case "pointOnTangent":
      return [constraint.point.entity, constraint.spline];
  }
}

export function validateConstraintReferences(
  constraint: SketchConstraint,
  entities: readonly SketchEntity[],
): SketchDiagnostic | null {
  const byId = new Map<string, SketchEntity>(
    entities.map((entity) => [entity.id, entity]),
  );
  if (SPLINE_SCOPE_UNSUPPORTED.has(constraint.kind)) {
    const splineOperand = constraintEntityOperands(constraint).find(
      (operand) => {
        const entity = byId.get(operand);
        return entity !== undefined && isSpline(entity);
      },
    );
    if (splineOperand !== undefined) {
      return {
        severity: "error",
        code: SKETCH_DIAGNOSTIC_CODES.constraintUnsupported,
        message: `Constraint ${constraint.id} (${constraint.kind}) references spline ${splineOperand}; spline solving covers endpoint point-targets, point-on-spline, line tangency, end-tangent direction constraints, and endpoint-chord equality, and ${constraint.kind} on a spline operand is outside that subset.`,
        location: { primary: constraint.id, related: [splineOperand] },
      };
    }
  }
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
    return isLine(entity)
      ? null
      : `${name} must reference a line, found ${entity.kind}`;
  };
  const requireRadialOperand = (
    name: string,
    id: SketchEntityId,
  ): string | null => {
    const entity = find(id);
    if (entity === undefined) return `${name} references missing entity ${id}`;
    return isRadial(entity)
      ? null
      : `${name} must reference a circle, arc, polygon, or slot, found ${entity.kind}`;
  };
  /**
   * The direction constraints' pair rule: two lines, or a line and a
   * spline's end tangent. Two splines have no direction pair — a spline's
   * tangent sweeps all directions along the curve, so an anywhere
   * direction-only constraint on two splines is vacuous.
   */
  const directionPairProblem = (
    first: SketchEntityId,
    second: SketchEntityId,
  ): string | null => {
    const a = find(first);
    const b = find(second);
    if (a === undefined) return `first references missing entity ${first}`;
    if (b === undefined) return `second references missing entity ${second}`;
    const pairOk =
      (a.kind === "line" && b.kind === "line") ||
      (a.kind === "line" && b.kind === "spline") ||
      (a.kind === "spline" && b.kind === "line");
    if (pairOk) return null;
    if (a.kind === "spline" && b.kind === "spline") {
      return `operands must be two lines, or a line and a spline's end tangent; two splines have no direction pair (a spline's tangent sweeps all directions along the curve, so an anywhere direction-only constraint on two splines is vacuous), found ${a.kind} and ${b.kind}`;
    }
    return `operands must be two lines, or a line and a spline's end tangent, found ${a.kind} and ${b.kind}`;
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
      problem = directionPairProblem(constraint.first, constraint.second);
      break;
    case "distance":
      problem = checkTarget(constraint.first) ?? checkTarget(constraint.second);
      break;
    case "angle":
      problem = directionPairProblem(constraint.first, constraint.second);
      break;
    case "radius":
    case "diameter":
      problem = requireRadialOperand("entity", constraint.entity);
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
      const lengthOperand = (entity: SketchEntity): boolean =>
        entity.kind === "line" || entity.kind === "spline";
      if (lengthOperand(first) && lengthOperand(second)) break;
      problem = `equal must reference two lines (equal lengths), two circles/arcs (equal radii), or lines and splines (a spline counts its endpoint chord), found ${first.kind} and ${second.kind}`;
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
        (isCircular(first) && isCircular(second)) ||
        (isLine(first) && isSpline(second)) ||
        (isSpline(first) && isLine(second)) ||
        (isSpline(first) && isSpline(second));
      problem = pairsOk
        ? null
        : `tangent must reference a line and a circle/arc, two circles/arcs, a line and a spline (anywhere tangency), or two splines (a G1 joint), found ${first.kind} and ${second.kind}`;
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
    case "pointOnEntity": {
      problem = checkTarget(constraint.point);
      if (problem === null) {
        const entity = find(constraint.entity);
        if (entity === undefined) {
          problem = `entity references missing entity ${constraint.entity}`;
        } else {
          problem = pointOnEntityKindProblem(entity);
        }
      }
      break;
    }
    case "pointOnTangent": {
      problem = checkTarget(constraint.point);
      if (problem === null) {
        const spline = find(constraint.spline);
        if (spline === undefined) {
          problem = `spline references missing entity ${constraint.spline}`;
        } else if (!isSpline(spline)) {
          problem = `spline must reference a spline, found ${spline.kind}`;
        }
      }
      break;
    }
    case "collinear":
      problem =
        requireLine("first", constraint.first) ??
        requireLine("second", constraint.second);
      break;
    case "horizontalPair":
    case "verticalPair":
    case "distanceX":
    case "distanceY":
      problem = checkTarget(constraint.first) ?? checkTarget(constraint.second);
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
