/**
 * Sketch entities: the parametric geometry a sketch is made of.
 *
 * Parameterization (the solver's unknowns, all in workplane coordinates —
 * lengths in mm, angles in radians):
 *
 * - `point`   — `(x, y)`: 2 unknowns.
 * - `line`    — `(x1, y1, x2, y2)`: two endpoints, 4 unknowns.
 * - `circle`  — `(cx, cy, radius)`: center + radius, 3 unknowns (radius > 0).
 * - `arc`     — `(cx, cy, radius, startAngle, endAngle)`: center, radius, and
 *   the CCW sweep from start to end angle, 5 unknowns. Angles are
 *   canonicalized to [0, 2π) on construction; the sweep is
 *   `(end − start) mod 2π ∈ (0, 2π)` — zero sweep is degenerate and rejected.
 * - `rectangle` — composed of exactly 4 referenced line entities, in edge
 *   order (bottom, right, top, left for a CCW chain): 0 unknowns of its own.
 *   Its integrity rule is enforced by the solver: it compiles to implicit
 *   coincidences chaining each edge's end to the next edge's start (cyclically)
 *   plus `e0 ∥ e2`, `e1 ∥ e3`, `e0 ⊥ e1` — leaving the rectangle exactly
 *   x, y, width, height, rotation (5 degrees of freedom) as expected.
 * - `ellipse` — `(cx, cy, radiusX, radiusY, rotation)`: center, the two
 *   semi-axes (mm, > 0), and the rotation of the radiusX axis from workplane
 *   +x (rad), 5 unknowns. The curve is
 *   `center + R(rotation)·(radiusX·cos t, radiusY·sin t)`, t ∈ [0, 2π); a
 *   circle is the `radiusX = radiusY, rotation = 0` special case, kept as its
 *   own kind for the solver's radius constraints. Point targets: `center`
 *   only (a full ellipse has no distinguished start/end).
 * - `ellipticalArc` — `(cx, cy, radiusX, radiusY, rotation, startAngle,
 *   endAngle)`: the same ellipse parameterization with a CCW parametric sweep
 *   from `startAngle` to `endAngle` (both canonicalized to [0, 2π), sweep in
 *   (0, 2π)), 7 unknowns. Point targets: `center`, `start`, `end` (on the
 *   curve at the start/end parameters — NOT the circle-style polar angles:
 *   the parametric point at t is the local `(radiusX·cos t, radiusY·sin t)`
 *   rotated by `rotation`).
 * - `spline` — `{ flavor, points }`: every stored point contributes its two
 *   coordinates as unknowns (2N unknowns for N points).
 *   - `flavor: "control"`: the points are the control points of a chained
 *     cubic Bézier (a polybezier, the SVG `C…C…` form): N must satisfy
 *     N ≥ 4 and (N − 1) mod 3 = 0 — segment k spans stored points
 *     `3k … 3k+3`, consecutive segments share their junction point, and the
 *     curve passes through every third point (indices 0, 3, 6, …). The
 *     interior points are tangent handles; the end tangents are along
 *     `points[1] − points[0]` and `points[N−1] − points[N−2]`.
 *   - `flavor: "interpolated"`: the points are fit points the curve passes
 *     through (N ≥ 2, consecutive points distinct); the curve is the uniform
 *     Catmull-Rom spline with clamped (duplicated-endpoint) end conditions,
 *     evaluated exactly through its per-span cubic Bézier equivalent
 *     (`b1 = Pᵢ + (Pᵢ₊₁ − Pᵢ₋₁)/6`, `b2 = Pᵢ₊₁ − (Pᵢ₊₂ − Pᵢ)/6`).
 *   Point targets: `start` (points[0]) and `end` (points[N−1]) only — no
 *   `center`. See the solver docs in `residuals.ts` for the pinned solving
 *   subset (endpoint point-target rows and point-on-spline projection;
 *   other constraint kinds on spline operands decline with
 *   `sketch/constraint-unsupported`).
 * - `polygon` — a regular n-gon `(cx, cy, radius, sides, rotation, fit)`:
 *   center, radius (mm, > 0), side count (integer, ≥ 3 — a discrete
 *   parameter, NOT a solver unknown), the first-vertex rotation (rad), and
 *   `fit`: `"inscribed"` (vertices on the circle of `radius` — the
 *   circumradius) or `"circumscribed"` (edges tangent to the circle of
 *   `radius` — the inradius/apothem; the circumradius becomes
 *   `radius / cos(π/n)`). 4 unknowns (cx, cy, radius, rotation) — a regular
 *   polygon has exactly the placement/size/turn freedoms. Point targets:
 *   `center` only.
 * - `slot` — a stadium/obround boundary with two variants:
 *   - `variant: "straight"`: `(x1, y1, x2, y2, radius)` — the two cap
 *     centers (distinct) and the cap radius (mm, > 0); the boundary is two
 *     semicircular caps joined by two parallel tangent lines, 5 unknowns.
 *   - `variant: "arc3"`: `(x1, y1, x2, y2, x3, y3, radius)` — the slot's
 *     CENTERLINE is the arc through the three points (start, through, end —
 *     not collinear, all distinct); `radius` (mm, > 0) is the cap radius
 *     (half the slot width); the boundary is the two arcs offset from the
 *     centerline arc by ±radius plus the two π-sweep end caps centered at
 *     (x1, y1) and (x3, y3), 7 unknowns. The centerline arc's radius must
 *     exceed `radius` (the inner offset must stay positive).
 *   Point targets: `start`/`end` are the cap centers ((x1, y1), (x2, y2) for
 *   `straight`; (x1, y1), (x3, y3) for `arc3`); `center` is the cap-center
 *   midpoint for `straight` and the through point (x2, y2) for `arc3`.
 *
 * The `construction` flag marks construction geometry. Construction entities
 * participate in solving identically to real geometry — the flag is a
 * modeling/display concern, not a solver concern.
 *
 * The `fixed` flag pins an entity: its parameters become constants during
 * solving (the standard CAD "fix" pin). Every constraint kind in this domain
 * relates entities to each other, so without a pin a closed sketch always
 * keeps its rigid-body translation free; fixing one entity (conventionally a
 * construction point at the workplane origin) is how sketches become fully
 * constrained. A constraint that contradicts a fixed entity's stored
 * geometry is diagnosed like any other conflict.
 *
 * Serialization follows the house style: fixed key order, strict parse of
 * known fields, unknown fields ignored, `formatVersion` on the sketch
 * envelope rather than per entity.
 */

import { type ParseResult, fail, ok } from "@slopcad/cad-core";

import { SKETCH_DIAGNOSTIC_CODES } from "./diagnostics";
import { type SketchEntityId, parseSketchEntityId } from "./sketch-ids";

/** Entity kinds a sketch can contain. */
export const SKETCH_ENTITY_KINDS = [
  "point",
  "line",
  "circle",
  "arc",
  "rectangle",
  "ellipse",
  "ellipticalArc",
  "spline",
  "polygon",
  "slot",
] as const;

export type SketchEntityKind = (typeof SKETCH_ENTITY_KINDS)[number];

/** Type guard for untrusted entity kinds. */ export function isSketchEntityKind(
  input: unknown,
): input is SketchEntityKind {
  return (
    typeof input === "string" &&
    (SKETCH_ENTITY_KINDS as readonly string[]).includes(input)
  );
}

/** Common fields of every entity. */
interface EntityBase {
  readonly id: SketchEntityId;
  readonly construction: boolean;
  /** Pinned entities keep their stored parameters during solving. */
  readonly fixed: boolean;
}

/** A point entity at `(x, y)` (mm). */
export interface PointEntity extends EntityBase {
  readonly kind: "point";
  readonly x: number;
  readonly y: number;
}

/** A line entity from `(x1, y1)` to `(x2, y2)` (mm). */
export interface LineEntity extends EntityBase {
  readonly kind: "line";
  readonly x1: number;
  readonly y1: number;
  readonly x2: number;
  readonly y2: number;
}

/** A circle entity: center `(cx, cy)` (mm) and `radius` (mm, > 0). */
export interface CircleEntity extends EntityBase {
  readonly kind: "circle";
  readonly cx: number;
  readonly cy: number;
  readonly radius: number;
}

/**
 * An arc entity: center `(cx, cy)`, `radius` (mm, > 0), and the CCW sweep
 * from `startAngle` to `endAngle` (rad, canonicalized to [0, 2π)).
 */
export interface ArcEntity extends EntityBase {
  readonly kind: "arc";
  readonly cx: number;
  readonly cy: number;
  readonly radius: number;
  readonly startAngle: number;
  readonly endAngle: number;
}

/**
 * A rectangle entity composed of four line entities, referenced by id in edge
 * order. The referenced lines carry the geometry; the rectangle carries the
 * integrity rule the solver enforces (see the module docs).
 */
export interface RectangleEntity extends EntityBase {
  readonly kind: "rectangle";
  readonly edges: readonly [
    SketchEntityId,
    SketchEntityId,
    SketchEntityId,
    SketchEntityId,
  ];
}

/**
 * An ellipse entity: center `(cx, cy)`, semi-axes `radiusX`/`radiusY` (mm,
 * both > 0), and the `rotation` of the radiusX axis from workplane +x (rad).
 */
export interface EllipseEntity extends EntityBase {
  readonly kind: "ellipse";
  readonly cx: number;
  readonly cy: number;
  readonly radiusX: number;
  readonly radiusY: number;
  readonly rotation: number;
}

/**
 * An elliptical arc: an ellipse's parameterization with the CCW parametric
 * sweep from `startAngle` to `endAngle` (rad, canonicalized to [0, 2π),
 * sweep in (0, 2π)).
 */
export interface EllipticalArcEntity extends EntityBase {
  readonly kind: "ellipticalArc";
  readonly cx: number;
  readonly cy: number;
  readonly radiusX: number;
  readonly radiusY: number;
  readonly rotation: number;
  readonly startAngle: number;
  readonly endAngle: number;
}

/** The spline flavors: how the stored points define the curve. */
export const SPLINE_FLAVORS = ["control", "interpolated"] as const;

export type SplineFlavor = (typeof SPLINE_FLAVORS)[number];

/** Type guard for untrusted spline flavors. */
export function isSplineFlavor(input: unknown): input is SplineFlavor {
  return (
    typeof input === "string" &&
    (SPLINE_FLAVORS as readonly string[]).includes(input)
  );
}

/** A workplane-space point of a spline (mm). */
export interface SplinePoint {
  readonly x: number;
  readonly y: number;
}

/**
 * A spline entity: a smooth curve through/controlled by its stored points
 * (see the module docs for the two flavors' evaluation rules). Every point
 * contributes two solver unknowns.
 */
export interface SplineEntity extends EntityBase {
  readonly kind: "spline";
  readonly flavor: SplineFlavor;
  readonly points: readonly SplinePoint[];
}

/** How a regular polygon's radius relates to its circle. */
export const POLYGON_FITS = ["inscribed", "circumscribed"] as const;

export type PolygonFit = (typeof POLYGON_FITS)[number];

/** Type guard for untrusted polygon fit modes. */
export function isPolygonFit(input: unknown): input is PolygonFit {
  return (
    typeof input === "string" &&
    (POLYGON_FITS as readonly string[]).includes(input)
  );
}

/**
 * A regular polygon: center, radius, side count (≥ 3, discrete), first-vertex
 * rotation, and whether `radius` is the circumradius (`inscribed` polygon) or
 * the inradius (`circumscribed` polygon).
 */
export interface PolygonEntity extends EntityBase {
  readonly kind: "polygon";
  readonly cx: number;
  readonly cy: number;
  readonly radius: number;
  readonly sides: number;
  readonly rotation: number;
  readonly fit: PolygonFit;
}

/** The slot variants: how the slot's centerline is defined. */
export const SLOT_VARIANTS = ["straight", "arc3"] as const;

export type SlotVariant = (typeof SLOT_VARIANTS)[number];

/** Type guard for untrusted slot variants. */
export function isSlotVariant(input: unknown): input is SlotVariant {
  return (
    typeof input === "string" &&
    (SLOT_VARIANTS as readonly string[]).includes(input)
  );
}

/**
 * A slot (stadium/obround) entity. `straight`: two cap centers + cap radius.
 * `arc3`: the centerline arc through (x1,y1), (x2,y2), (x3,y3) + cap radius
 * (x2/y2 is the through point; x3/y3 the end).
 */
export interface SlotEntity extends EntityBase {
  readonly kind: "slot";
  readonly variant: SlotVariant;
  readonly x1: number;
  readonly y1: number;
  readonly x2: number;
  readonly y2: number;
  /** The centerline arc's END point; present only for `arc3`. */
  readonly x3?: number;
  readonly y3?: number;
  readonly radius: number;
}

/** Union of every sketch entity. */
export type SketchEntity =
  | PointEntity
  | LineEntity
  | CircleEntity
  | ArcEntity
  | RectangleEntity
  | EllipseEntity
  | EllipticalArcEntity
  | SplineEntity
  | PolygonEntity
  | SlotEntity;

/** Structured failure describing why input was rejected as an entity. */
export interface SketchEntityError {
  readonly code: string;
  readonly message: string;
  readonly input: unknown;
}

/** Thrown by the entity builders on invalid parameters. */
export class SketchEntityValidationError extends Error {
  readonly error: SketchEntityError;

  constructor(error: SketchEntityError) {
    super(error.message);
    this.name = "SketchEntityValidationError";
    this.error = error;
  }
}

function entityError(
  code: string,
  message: string,
  input: unknown,
): SketchEntityError {
  return { code, message, input };
}

function requireFinite(name: string, value: number, input: unknown): void {
  if (!Number.isFinite(value)) {
    throw new SketchEntityValidationError(
      entityError(
        SKETCH_DIAGNOSTIC_CODES.entityParametersInvalid,
        `Entity ${name} must be a finite number, received ${String(value)}.`,
        input,
      ),
    );
  }
}

function requirePositiveRadius(radius: number, input: unknown): void {
  if (!(radius > 0)) {
    throw new SketchEntityValidationError(
      entityError(
        SKETCH_DIAGNOSTIC_CODES.entityParametersInvalid,
        `Entity radius must be a positive number of mm, received ${String(radius)}.`,
        input,
      ),
    );
  }
}

const TWO_PI = Math.PI * 2;

/** Canonicalizes an angle into [0, 2π). */
function canonicalAngle(angle: number): number {
  const wrapped = angle % TWO_PI;
  return wrapped < 0 ? wrapped + TWO_PI : wrapped;
}

/**
 * The CCW sweep of an arc in (0, 2π): `end − start` wrapped forward. Entities
 * are constructed and parsed so the sweep can never be zero.
 */
export function arcSweep(entity: ArcEntity): number {
  return canonicalAngle(entity.endAngle - entity.startAngle);
}

/** Optional entity flags accepted by every builder. */
export interface EntityOptions {
  readonly construction?: boolean;
  readonly fixed?: boolean;
}

/** Builds a point entity. */
export function createPointEntity(
  id: SketchEntityId,
  position: { readonly x: number; readonly y: number },
  options: EntityOptions = {},
): PointEntity {
  requireFinite("x", position.x, position);
  requireFinite("y", position.y, position);
  return {
    id,
    kind: "point",
    construction: options.construction ?? false,
    fixed: options.fixed ?? false,
    x: position.x,
    y: position.y,
  };
}

/** Builds a line entity between two workplane points. */
export function createLineEntity(
  id: SketchEntityId,
  start: { readonly x: number; readonly y: number },
  end: { readonly x: number; readonly y: number },
  options: EntityOptions = {},
): LineEntity {
  requireFinite("x1", start.x, start);
  requireFinite("y1", start.y, start);
  requireFinite("x2", end.x, end);
  requireFinite("y2", end.y, end);
  return {
    id,
    kind: "line",
    construction: options.construction ?? false,
    fixed: options.fixed ?? false,
    x1: start.x,
    y1: start.y,
    x2: end.x,
    y2: end.y,
  };
}

/** Builds a circle entity. */
export function createCircleEntity(
  id: SketchEntityId,
  center: { readonly x: number; readonly y: number },
  radius: number,
  options: EntityOptions = {},
): CircleEntity {
  requireFinite("cx", center.x, center);
  requireFinite("cy", center.y, center);
  requireFinite("radius", radius, center);
  requirePositiveRadius(radius, center);
  return {
    id,
    kind: "circle",
    construction: options.construction ?? false,
    fixed: options.fixed ?? false,
    cx: center.x,
    cy: center.y,
    radius,
  };
}

/**
 * Builds an arc entity: CCW sweep from `startAngle` to `endAngle` (rad; both
 * canonicalized to [0, 2π)). The sweep must not be a multiple of 2π.
 */
export function createArcEntity(
  id: SketchEntityId,
  center: { readonly x: number; readonly y: number },
  radius: number,
  startAngle: number,
  endAngle: number,
  options: EntityOptions = {},
): ArcEntity {
  requireFinite("cx", center.x, center);
  requireFinite("cy", center.y, center);
  requireFinite("radius", radius, center);
  requirePositiveRadius(radius, center);
  requireFinite("startAngle", startAngle, { startAngle, endAngle });
  requireFinite("endAngle", endAngle, { startAngle, endAngle });
  if (canonicalAngle(endAngle - startAngle) === 0) {
    throw new SketchEntityValidationError(
      entityError(
        SKETCH_DIAGNOSTIC_CODES.entityParametersInvalid,
        "An arc must sweep a positive angle; a zero (or full 2π-multiple) sweep is degenerate. Split a full circle into arcs or use a circle entity.",
        { startAngle, endAngle },
      ),
    );
  }
  return {
    id,
    kind: "arc",
    construction: options.construction ?? false,
    fixed: options.fixed ?? false,
    cx: center.x,
    cy: center.y,
    radius,
    startAngle: canonicalAngle(startAngle),
    endAngle: canonicalAngle(endAngle),
  };
}

/**
 * Builds a rectangle entity referencing four line entities in edge order.
 * The referenced lines must exist in the same sketch (checked by the sketch
 * layer); this constructor only validates id shape and distinctness.
 */
export function createRectangleEntity(
  id: SketchEntityId,
  edges: readonly [
    SketchEntityId,
    SketchEntityId,
    SketchEntityId,
    SketchEntityId,
  ],
  options: EntityOptions = {},
): RectangleEntity {
  const distinct = new Set<string>(edges);
  if (distinct.size !== 4) {
    throw new SketchEntityValidationError(
      entityError(
        SKETCH_DIAGNOSTIC_CODES.rectangleEdgesMalformed,
        "A rectangle must reference four distinct line entities.",
        edges,
      ),
    );
  }
  return {
    id,
    kind: "rectangle",
    construction: options.construction ?? false,
    fixed: options.fixed ?? false,
    edges: [...edges],
  };
}

/** Minimum side count of a regular polygon. */
export const POLYGON_MIN_SIDES = 3;

/** Maximum side count of a regular polygon (a solver-sane bound). */
export const POLYGON_MAX_SIDES = 128;

function requireSides(sides: number, input: unknown): void {
  if (
    !Number.isInteger(sides) ||
    sides < POLYGON_MIN_SIDES ||
    sides > POLYGON_MAX_SIDES
  ) {
    throw new SketchEntityValidationError(
      entityError(
        SKETCH_DIAGNOSTIC_CODES.polygonSidesInvalid,
        `A polygon's side count must be an integer between ${String(POLYGON_MIN_SIDES)} and ${String(POLYGON_MAX_SIDES)}, received ${String(sides)}.`,
        input,
      ),
    );
  }
}

/**
 * Builds an ellipse entity: center, semi-axes (both > 0), and the rotation
 * of the radiusX axis from workplane +x (rad).
 */
export function createEllipseEntity(
  id: SketchEntityId,
  center: { readonly x: number; readonly y: number },
  radiusX: number,
  radiusY: number,
  rotation: number,
  options: EntityOptions = {},
): EllipseEntity {
  requireFinite("cx", center.x, center);
  requireFinite("cy", center.y, center);
  requireFinite("radiusX", radiusX, { radiusX, radiusY });
  requireFinite("radiusY", radiusY, { radiusX, radiusY });
  if (!(radiusX > 0) || !(radiusY > 0)) {
    throw new SketchEntityValidationError(
      entityError(
        SKETCH_DIAGNOSTIC_CODES.entityParametersInvalid,
        `An ellipse's semi-axes must both be positive mm, received ${String(radiusX)} and ${String(radiusY)}.`,
        { radiusX, radiusY },
      ),
    );
  }
  requireFinite("rotation", rotation, { rotation });
  return {
    id,
    kind: "ellipse",
    construction: options.construction ?? false,
    fixed: options.fixed ?? false,
    cx: center.x,
    cy: center.y,
    radiusX,
    radiusY,
    rotation: canonicalAngle(rotation),
  };
}

/**
 * Builds an elliptical arc: the CCW parametric sweep from `startAngle` to
 * `endAngle` over the ellipse's parameterization. The sweep must not be a
 * multiple of 2π (a full ellipse is the `ellipse` kind).
 */
export function createEllipticalArcEntity(
  id: SketchEntityId,
  center: { readonly x: number; readonly y: number },
  radiusX: number,
  radiusY: number,
  rotation: number,
  startAngle: number,
  endAngle: number,
  options: EntityOptions = {},
): EllipticalArcEntity {
  const ellipse = createEllipseEntity(
    id,
    center,
    radiusX,
    radiusY,
    rotation,
    options,
  );
  requireFinite("startAngle", startAngle, { startAngle, endAngle });
  requireFinite("endAngle", endAngle, { startAngle, endAngle });
  if (canonicalAngle(endAngle - startAngle) === 0) {
    throw new SketchEntityValidationError(
      entityError(
        SKETCH_DIAGNOSTIC_CODES.entityParametersInvalid,
        "An elliptical arc must sweep a positive parametric angle; a zero (or full 2π-multiple) sweep is degenerate. Use an ellipse entity for the full curve.",
        { startAngle, endAngle },
      ),
    );
  }
  return {
    ...ellipse,
    kind: "ellipticalArc",
    startAngle: canonicalAngle(startAngle),
    endAngle: canonicalAngle(endAngle),
  };
}

function splinePointProblem(
  flavor: SplineFlavor,
  points: readonly SplinePoint[],
): string | null {
  if (points.length < 2) {
    return "a spline needs at least two points";
  }
  for (const point of points) {
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) {
      return "every spline point must be finite";
    }
  }
  if (flavor === "control") {
    if (points.length < 4 || (points.length - 1) % 3 !== 0) {
      return "a control-point spline's point count must be 4, 7, 10, … (three new points per extra Bézier segment)";
    }
    const segments = (points.length - 1) / 3;
    for (let k = 0; k < segments; k += 1) {
      const a = points[3 * k];
      const b = points[3 * k + 3];
      if (a === undefined || b === undefined) continue;
      if (a.x === b.x && a.y === b.y) {
        return `Bézier segment ${String(k + 1)} has coincident endpoints; a spline segment must have positive length`;
      }
    }
    return null;
  }
  for (let i = 0; i + 1 < points.length; i += 1) {
    const a = points[i];
    const b = points[i + 1];
    if (a === undefined || b === undefined) continue;
    if (a.x === b.x && a.y === b.y) {
      return "consecutive fit points must be distinct";
    }
  }
  return null;
}

/**
 * Builds a spline entity. `control` points must number 4, 7, 10, … (a cubic
 * Bézier chain); `interpolated` points (≥ 2, consecutive distinct) are fit
 * points the curve passes through.
 */
export function createSplineEntity(
  id: SketchEntityId,
  flavor: SplineFlavor,
  points: readonly SplinePoint[],
  options: EntityOptions = {},
): SplineEntity {
  if (!isSplineFlavor(flavor)) {
    throw new SketchEntityValidationError(
      entityError(
        SKETCH_DIAGNOSTIC_CODES.entityMalformed,
        'A spline flavor must be "control" or "interpolated".',
        flavor,
      ),
    );
  }
  const problem = splinePointProblem(flavor, points);
  if (problem !== null) {
    throw new SketchEntityValidationError(
      entityError(
        SKETCH_DIAGNOSTIC_CODES.splinePointsMalformed,
        `${problem} (flavor "${flavor}").`,
        points,
      ),
    );
  }
  return {
    id,
    kind: "spline",
    construction: options.construction ?? false,
    fixed: options.fixed ?? false,
    flavor,
    points: points.map((point) => ({ x: point.x, y: point.y })),
  };
}

/** Builds a regular polygon entity (see {@link PolygonEntity}). */
export function createPolygonEntity(
  id: SketchEntityId,
  center: { readonly x: number; readonly y: number },
  radius: number,
  sides: number,
  rotation: number,
  fit: PolygonFit,
  options: EntityOptions = {},
): PolygonEntity {
  requireFinite("cx", center.x, center);
  requireFinite("cy", center.y, center);
  requireFinite("radius", radius, { radius });
  requirePositiveRadius(radius, { radius });
  requireSides(sides, { sides });
  requireFinite("rotation", rotation, { rotation });
  if (!isPolygonFit(fit)) {
    throw new SketchEntityValidationError(
      entityError(
        SKETCH_DIAGNOSTIC_CODES.entityMalformed,
        'A polygon fit must be "inscribed" or "circumscribed".',
        fit,
      ),
    );
  }
  return {
    id,
    kind: "polygon",
    construction: options.construction ?? false,
    fixed: options.fixed ?? false,
    cx: center.x,
    cy: center.y,
    radius,
    sides,
    rotation: canonicalAngle(rotation),
    fit,
  };
}

/**
 * Builds a straight slot: two distinct cap centers and the cap radius
 * (mm, > 0). The boundary is two semicircular caps joined by parallel
 * tangent lines.
 */
export function createStraightSlotEntity(
  id: SketchEntityId,
  start: { readonly x: number; readonly y: number },
  end: { readonly x: number; readonly y: number },
  radius: number,
  options: EntityOptions = {},
): SlotEntity {
  requireFinite("x1", start.x, start);
  requireFinite("y1", start.y, start);
  requireFinite("x2", end.x, end);
  requireFinite("y2", end.y, end);
  requireFinite("radius", radius, { radius });
  requirePositiveRadius(radius, { radius });
  if (start.x === end.x && start.y === end.y) {
    throw new SketchEntityValidationError(
      entityError(
        SKETCH_DIAGNOSTIC_CODES.slotGeometryInvalid,
        "A straight slot's cap centers must be distinct; a zero-length centerline is degenerate (use a circle).",
        { start, end },
      ),
    );
  }
  return {
    id,
    kind: "slot",
    construction: options.construction ?? false,
    fixed: options.fixed ?? false,
    variant: "straight",
    x1: start.x,
    y1: start.y,
    x2: end.x,
    y2: end.y,
    radius,
  };
}

/**
 * Builds a 3-point-arc slot: the centerline arc through `start`, `through`,
 * and `end` (three distinct, non-collinear points), with end caps of
 * `radius` (mm, > 0). The centerline arc's radius must exceed `radius` so
 * the inner offset arc stays positive.
 */
export function createArc3SlotEntity(
  id: SketchEntityId,
  start: { readonly x: number; readonly y: number },
  through: { readonly x: number; readonly y: number },
  end: { readonly x: number; readonly y: number },
  radius: number,
  options: EntityOptions = {},
): SlotEntity {
  requireFinite("x1", start.x, start);
  requireFinite("y1", start.y, start);
  requireFinite("x2", through.x, through);
  requireFinite("y2", through.y, through);
  requireFinite("x3", end.x, end);
  requireFinite("y3", end.y, end);
  requireFinite("radius", radius, { radius });
  requirePositiveRadius(radius, { radius });
  const distinct =
    (start.x !== through.x || start.y !== through.y) &&
    (through.x !== end.x || through.y !== end.y) &&
    (start.x !== end.x || start.y !== end.y);
  if (!distinct) {
    throw new SketchEntityValidationError(
      entityError(
        SKETCH_DIAGNOSTIC_CODES.slotGeometryInvalid,
        "A 3-point-arc slot's three centerline points must be distinct.",
        { start, through, end },
      ),
    );
  }
  const circumcircle = circumcircleOf(start, through, end);
  if (circumcircle === null) {
    throw new SketchEntityValidationError(
      entityError(
        SKETCH_DIAGNOSTIC_CODES.slotGeometryInvalid,
        "A 3-point-arc slot's centerline points must not be collinear — the centerline is an arc (a straight centerline is the straight slot).",
        { start, through, end },
      ),
    );
  }
  if (!(circumcircle.radius > radius)) {
    throw new SketchEntityValidationError(
      entityError(
        SKETCH_DIAGNOSTIC_CODES.slotGeometryInvalid,
        `A 3-point-arc slot's centerline arc radius (${circumcircle.radius.toFixed(6)} mm) must exceed its cap radius (${String(radius)} mm); the inner offset arc would otherwise invert.`,
        { start, through, end, radius },
      ),
    );
  }
  return {
    id,
    kind: "slot",
    construction: options.construction ?? false,
    fixed: options.fixed ?? false,
    variant: "arc3",
    x1: start.x,
    y1: start.y,
    x2: through.x,
    y2: through.y,
    x3: end.x,
    y3: end.y,
    radius,
  };
}

/**
 * The circumcircle of three points, or `null` when they are collinear (or
 * numerically degenerate): its center and radius, plus the direction
 * (signed sweep) of the arc start → through → end.
 */
export function circumcircleOf(
  a: { readonly x: number; readonly y: number },
  b: { readonly x: number; readonly y: number },
  c: { readonly x: number; readonly y: number },
): {
  readonly cx: number;
  readonly cy: number;
  readonly radius: number;
  /** +1 when b lies CCW of the a→c chord (CCW arc), −1 when CW. */
  readonly ccw: 1 | -1;
} | null {
  const d = 2 * (a.x * (b.y - c.y) + b.x * (c.y - a.y) + c.x * (a.y - b.y));
  if (d === 0 || !Number.isFinite(d)) return null;
  const ux =
    ((a.x * a.x + a.y * a.y) * (b.y - c.y) +
      (b.x * b.x + b.y * b.y) * (c.y - a.y) +
      (c.x * c.x + c.y * c.y) * (a.y - b.y)) /
    d;
  const uy =
    ((a.x * a.x + a.y * a.y) * (c.x - b.x) +
      (b.x * b.x + b.y * b.y) * (a.x - c.x) +
      (c.x * c.x + c.y * c.y) * (b.x - a.x)) /
    d;
  const radius = Math.hypot(a.x - ux, a.y - uy);
  if (!Number.isFinite(radius) || radius === 0) return null;
  const cross = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  return { cx: ux, cy: uy, radius, ccw: cross > 0 ? 1 : -1 };
}

/**
 * The slot's cap-center "start" point (the boundary walk's first cap
 * center) in workplane mm — the point-target `start` anchor.
 */
export function slotStartPoint(entity: SlotEntity): SplinePoint {
  return { x: entity.x1, y: entity.y1 };
}

/**
 * The slot's "end" cap center: (x2, y2) for `straight`, (x3, y3) for `arc3`.
 */
export function slotEndPoint(entity: SlotEntity): SplinePoint {
  if (entity.variant === "straight") return { x: entity.x2, y: entity.y2 };
  return { x: entity.x3 ?? entity.x2, y: entity.y3 ?? entity.y2 };
}

function isPlainRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}

/** Packs exactly four validated ids into the rectangle edge tuple. */
function toEdgeQuad(
  ids: readonly SketchEntityId[],
):
  [SketchEntityId, SketchEntityId, SketchEntityId, SketchEntityId] | undefined {
  if (ids.length !== 4) return undefined;
  const [a, b, c, d] = ids;
  if (
    a === undefined ||
    b === undefined ||
    c === undefined ||
    d === undefined
  ) {
    return undefined;
  }
  return [a, b, c, d];
}

/**
 * Canonical JSON form of an entity: `id`, `kind`, `construction`, then the
 * kind's parameters in the fixed documented order.
 */
export type SerializedSketchEntity = Readonly<Record<string, unknown>>;

/** Serializes an entity to its canonical JSON form. */
export function serializeSketchEntity(
  entity: SketchEntity,
): SerializedSketchEntity {
  switch (entity.kind) {
    case "point":
      return {
        id: entity.id,
        kind: entity.kind,
        construction: entity.construction,
        fixed: entity.fixed,
        x: entity.x,
        y: entity.y,
      };
    case "line":
      return {
        id: entity.id,
        kind: entity.kind,
        construction: entity.construction,
        fixed: entity.fixed,
        x1: entity.x1,
        y1: entity.y1,
        x2: entity.x2,
        y2: entity.y2,
      };
    case "circle":
      return {
        id: entity.id,
        kind: entity.kind,
        construction: entity.construction,
        fixed: entity.fixed,
        cx: entity.cx,
        cy: entity.cy,
        radius: entity.radius,
      };
    case "arc":
      return {
        id: entity.id,
        kind: entity.kind,
        construction: entity.construction,
        fixed: entity.fixed,
        cx: entity.cx,
        cy: entity.cy,
        radius: entity.radius,
        startAngle: entity.startAngle,
        endAngle: entity.endAngle,
      };
    case "rectangle":
      return {
        id: entity.id,
        kind: entity.kind,
        construction: entity.construction,
        fixed: entity.fixed,
        edges: [...entity.edges],
      };
    case "ellipse":
      return {
        id: entity.id,
        kind: entity.kind,
        construction: entity.construction,
        fixed: entity.fixed,
        cx: entity.cx,
        cy: entity.cy,
        radiusX: entity.radiusX,
        radiusY: entity.radiusY,
        rotation: entity.rotation,
      };
    case "ellipticalArc":
      return {
        id: entity.id,
        kind: entity.kind,
        construction: entity.construction,
        fixed: entity.fixed,
        cx: entity.cx,
        cy: entity.cy,
        radiusX: entity.radiusX,
        radiusY: entity.radiusY,
        rotation: entity.rotation,
        startAngle: entity.startAngle,
        endAngle: entity.endAngle,
      };
    case "spline":
      return {
        id: entity.id,
        kind: entity.kind,
        construction: entity.construction,
        fixed: entity.fixed,
        flavor: entity.flavor,
        points: entity.points.map((point) => ({ x: point.x, y: point.y })),
      };
    case "polygon":
      return {
        id: entity.id,
        kind: entity.kind,
        construction: entity.construction,
        fixed: entity.fixed,
        cx: entity.cx,
        cy: entity.cy,
        radius: entity.radius,
        sides: entity.sides,
        rotation: entity.rotation,
        fit: entity.fit,
      };
    case "slot":
      return {
        id: entity.id,
        kind: entity.kind,
        construction: entity.construction,
        fixed: entity.fixed,
        variant: entity.variant,
        x1: entity.x1,
        y1: entity.y1,
        x2: entity.x2,
        y2: entity.y2,
        ...(entity.variant === "arc3"
          ? {
              x3: requireArc3Field(entity, "x3"),
              y3: requireArc3Field(entity, "y3"),
            }
          : {}),
        radius: entity.radius,
      };
  }
}

/**
 * The arc3 slot's `x3`/`y3`: always present on entities that passed the
 * builders/parse (an invariant, not a caller concern) — a missing field is a
 * structural corruption that must fail loudly, never serialize as a default.
 */
function requireArc3Field(entity: SlotEntity, field: "x3" | "y3"): number {
  const value = field === "x3" ? entity.x3 : entity.y3;
  if (value === undefined) {
    throw new RangeError(
      `Arc3 slot ${entity.id} is missing its ${field} field; arc3 slots always carry x1..y3.`,
    );
  }
  return value;
}

function parseFlag(
  name: string,
  input: unknown,
): ParseResult<boolean, SketchEntityError> {
  if (input === undefined) return ok(false);
  if (typeof input === "boolean") return ok(input);
  return fail(
    entityError(
      SKETCH_DIAGNOSTIC_CODES.entityMalformed,
      `Entity ${name} must be a boolean.`,
      input,
    ),
  );
}

function parseFiniteNumber(
  name: string,
  input: unknown,
  whole: unknown,
): ParseResult<number, SketchEntityError> {
  if (typeof input !== "number") {
    return fail(
      entityError(
        SKETCH_DIAGNOSTIC_CODES.entityMalformed,
        `Entity ${name} must be a number.`,
        whole,
      ),
    );
  }
  if (!Number.isFinite(input)) {
    return fail(
      entityError(
        SKETCH_DIAGNOSTIC_CODES.entityParametersInvalid,
        `Entity ${name} must be a finite number, received ${String(input)}.`,
        whole,
      ),
    );
  }
  return ok(input);
}

/**
 * Parses untrusted input (e.g. an entity revived from persisted JSON) as a
 * {@link SketchEntity}. Known fields are validated strictly against the same
 * rules the builders enforce (positive radii, positive arc sweep, four
 * distinct rectangle edge ids); unknown fields are ignored so future format
 * versions deserialize without data corruption. Unlike the builders, angles
 * are adopted verbatim so round-trips stay exact — canonicalization happened
 * at construction time and serialization never emits non-canonical angles.
 */
export function parseSketchEntity(
  input: unknown,
): ParseResult<SketchEntity, SketchEntityError> {
  if (!isPlainRecord(input)) {
    return fail(
      entityError(
        SKETCH_DIAGNOSTIC_CODES.entityMalformed,
        "A serialized sketch entity must be a plain object.",
        input,
      ),
    );
  }
  const id = parseSketchEntityId(input.id);
  if (!id.ok) {
    return fail(
      entityError(
        SKETCH_DIAGNOSTIC_CODES.entityMalformed,
        `Sketch entity needs a valid entity id: ${id.error.message}`,
        input,
      ),
    );
  }
  if (!isSketchEntityKind(input.kind)) {
    return fail(
      entityError(
        SKETCH_DIAGNOSTIC_CODES.entityUnknownKind,
        `Entity kind must be one of: ${SKETCH_ENTITY_KINDS.join(", ")}.`,
        input,
      ),
    );
  }
  const construction = parseFlag("construction", input.construction);
  if (!construction.ok) return construction;
  const fixed = parseFlag("fixed", input.fixed);
  if (!fixed.ok) return fixed;
  switch (input.kind) {
    case "point": {
      const x = parseFiniteNumber("x", input.x, input);
      if (!x.ok) return x;
      const y = parseFiniteNumber("y", input.y, input);
      if (!y.ok) return y;
      return ok({
        id: id.value,
        kind: "point",
        construction: construction.value,
        fixed: fixed.value,
        x: x.value,
        y: y.value,
      });
    }
    case "line": {
      const x1 = parseFiniteNumber("x1", input.x1, input);
      if (!x1.ok) return x1;
      const y1 = parseFiniteNumber("y1", input.y1, input);
      if (!y1.ok) return y1;
      const x2 = parseFiniteNumber("x2", input.x2, input);
      if (!x2.ok) return x2;
      const y2 = parseFiniteNumber("y2", input.y2, input);
      if (!y2.ok) return y2;
      return ok({
        id: id.value,
        kind: "line",
        construction: construction.value,
        fixed: fixed.value,
        x1: x1.value,
        y1: y1.value,
        x2: x2.value,
        y2: y2.value,
      });
    }
    case "circle":
    case "arc": {
      const cx = parseFiniteNumber("cx", input.cx, input);
      if (!cx.ok) return cx;
      const cy = parseFiniteNumber("cy", input.cy, input);
      if (!cy.ok) return cy;
      const radius = parseFiniteNumber("radius", input.radius, input);
      if (!radius.ok) return radius;
      if (!(radius.value > 0)) {
        return fail(
          entityError(
            SKETCH_DIAGNOSTIC_CODES.entityParametersInvalid,
            `Entity radius must be a positive number of mm, received ${String(radius.value)}.`,
            input,
          ),
        );
      }
      if (input.kind === "circle") {
        return ok({
          id: id.value,
          kind: "circle",
          construction: construction.value,
          fixed: fixed.value,
          cx: cx.value,
          cy: cy.value,
          radius: radius.value,
        });
      }
      const startAngle = parseFiniteNumber(
        "startAngle",
        input.startAngle,
        input,
      );
      if (!startAngle.ok) return startAngle;
      const endAngle = parseFiniteNumber("endAngle", input.endAngle, input);
      if (!endAngle.ok) return endAngle;
      if (canonicalAngle(endAngle.value - startAngle.value) === 0) {
        return fail(
          entityError(
            SKETCH_DIAGNOSTIC_CODES.entityParametersInvalid,
            "An arc must sweep a positive angle; a zero (or full 2π-multiple) sweep is degenerate.",
            input,
          ),
        );
      }
      return ok({
        id: id.value,
        kind: "arc",
        construction: construction.value,
        fixed: fixed.value,
        cx: cx.value,
        cy: cy.value,
        radius: radius.value,
        startAngle: startAngle.value,
        endAngle: endAngle.value,
      });
    }
    case "rectangle": {
      const { edges } = input;
      if (!Array.isArray(edges)) {
        return fail(
          entityError(
            SKETCH_DIAGNOSTIC_CODES.rectangleEdgesMalformed,
            "A rectangle's edges must be an array of four line entity ids.",
            input,
          ),
        );
      }
      const edgeIds: SketchEntityId[] = [];
      for (const edge of edges) {
        const parsed = parseSketchEntityId(edge);
        if (!parsed.ok) {
          return fail(
            entityError(
              SKETCH_DIAGNOSTIC_CODES.rectangleEdgesMalformed,
              `Rectangle edges must be valid entity ids: ${parsed.error.message}`,
              input,
            ),
          );
        }
        edgeIds.push(parsed.value);
      }
      const quad = toEdgeQuad(edgeIds);
      if (quad === undefined) {
        return fail(
          entityError(
            SKETCH_DIAGNOSTIC_CODES.rectangleEdgesMalformed,
            "A rectangle must reference exactly four line entities.",
            input,
          ),
        );
      }
      if (new Set<string>(quad).size !== 4) {
        return fail(
          entityError(
            SKETCH_DIAGNOSTIC_CODES.rectangleEdgesMalformed,
            "A rectangle must reference four distinct line entities.",
            input,
          ),
        );
      }
      return ok({
        id: id.value,
        kind: "rectangle",
        construction: construction.value,
        fixed: fixed.value,
        edges: quad,
      });
    }
    case "ellipse":
    case "ellipticalArc": {
      const cx = parseFiniteNumber("cx", input.cx, input);
      if (!cx.ok) return cx;
      const cy = parseFiniteNumber("cy", input.cy, input);
      if (!cy.ok) return cy;
      const radiusX = parseFiniteNumber("radiusX", input.radiusX, input);
      if (!radiusX.ok) return radiusX;
      const radiusY = parseFiniteNumber("radiusY", input.radiusY, input);
      if (!radiusY.ok) return radiusY;
      if (!(radiusX.value > 0) || !(radiusY.value > 0)) {
        return fail(
          entityError(
            SKETCH_DIAGNOSTIC_CODES.entityParametersInvalid,
            `An ellipse's semi-axes must both be positive mm, received ${String(radiusX.value)} and ${String(radiusY.value)}.`,
            input,
          ),
        );
      }
      const rotation = parseFiniteNumber("rotation", input.rotation, input);
      if (!rotation.ok) return rotation;
      if (input.kind === "ellipse") {
        return ok({
          id: id.value,
          kind: "ellipse",
          construction: construction.value,
          fixed: fixed.value,
          cx: cx.value,
          cy: cy.value,
          radiusX: radiusX.value,
          radiusY: radiusY.value,
          rotation: rotation.value,
        });
      }
      const startAngle = parseFiniteNumber(
        "startAngle",
        input.startAngle,
        input,
      );
      if (!startAngle.ok) return startAngle;
      const endAngle = parseFiniteNumber("endAngle", input.endAngle, input);
      if (!endAngle.ok) return endAngle;
      if (canonicalAngle(endAngle.value - startAngle.value) === 0) {
        return fail(
          entityError(
            SKETCH_DIAGNOSTIC_CODES.entityParametersInvalid,
            "An elliptical arc must sweep a positive parametric angle; a zero (or full 2π-multiple) sweep is degenerate. Use an ellipse entity for the full curve.",
            input,
          ),
        );
      }
      return ok({
        id: id.value,
        kind: "ellipticalArc",
        construction: construction.value,
        fixed: fixed.value,
        cx: cx.value,
        cy: cy.value,
        radiusX: radiusX.value,
        radiusY: radiusY.value,
        rotation: rotation.value,
        startAngle: startAngle.value,
        endAngle: endAngle.value,
      });
    }
    case "spline": {
      if (!isSplineFlavor(input.flavor)) {
        return fail(
          entityError(
            SKETCH_DIAGNOSTIC_CODES.entityMalformed,
            'A spline flavor must be "control" or "interpolated".',
            input,
          ),
        );
      }
      const flavor = input.flavor;
      if (!Array.isArray(input.points)) {
        return fail(
          entityError(
            SKETCH_DIAGNOSTIC_CODES.splinePointsMalformed,
            "A spline's points must be an array of {x, y} objects.",
            input,
          ),
        );
      }
      const points: SplinePoint[] = [];
      for (const entry of input.points as unknown[]) {
        const isRecord =
          typeof entry === "object" && entry !== null && !Array.isArray(entry);
        const raw: Record<string, unknown> = isRecord
          ? (entry as Record<string, unknown>)
          : {};
        const x = parseFiniteNumber("spline point x", raw.x, input);
        if (!x.ok) return x;
        const y = parseFiniteNumber("spline point y", raw.y, input);
        if (!y.ok) return y;
        points.push({ x: x.value, y: y.value });
      }
      const problem = splinePointProblem(flavor, points);
      if (problem !== null) {
        return fail(
          entityError(
            SKETCH_DIAGNOSTIC_CODES.splinePointsMalformed,
            `${problem} (flavor "${flavor}").`,
            input,
          ),
        );
      }
      return ok({
        id: id.value,
        kind: "spline",
        construction: construction.value,
        fixed: fixed.value,
        flavor,
        points,
      });
    }
    case "polygon": {
      const cx = parseFiniteNumber("cx", input.cx, input);
      if (!cx.ok) return cx;
      const cy = parseFiniteNumber("cy", input.cy, input);
      if (!cy.ok) return cy;
      const radius = parseFiniteNumber("radius", input.radius, input);
      if (!radius.ok) return radius;
      if (!(radius.value > 0)) {
        return fail(
          entityError(
            SKETCH_DIAGNOSTIC_CODES.entityParametersInvalid,
            `Entity radius must be a positive number of mm, received ${String(radius.value)}.`,
            input,
          ),
        );
      }
      if (
        typeof input.sides !== "number" ||
        !Number.isInteger(input.sides) ||
        input.sides < POLYGON_MIN_SIDES ||
        input.sides > POLYGON_MAX_SIDES
      ) {
        return fail(
          entityError(
            SKETCH_DIAGNOSTIC_CODES.polygonSidesInvalid,
            `A polygon's side count must be an integer between ${String(POLYGON_MIN_SIDES)} and ${String(POLYGON_MAX_SIDES)}, received ${String(input.sides)}.`,
            input,
          ),
        );
      }
      const rotation = parseFiniteNumber("rotation", input.rotation, input);
      if (!rotation.ok) return rotation;
      if (!isPolygonFit(input.fit)) {
        return fail(
          entityError(
            SKETCH_DIAGNOSTIC_CODES.entityMalformed,
            'A polygon fit must be "inscribed" or "circumscribed".',
            input,
          ),
        );
      }
      return ok({
        id: id.value,
        kind: "polygon",
        construction: construction.value,
        fixed: fixed.value,
        cx: cx.value,
        cy: cy.value,
        radius: radius.value,
        sides: input.sides,
        rotation: rotation.value,
        fit: input.fit,
      });
    }
    case "slot": {
      if (!isSlotVariant(input.variant)) {
        return fail(
          entityError(
            SKETCH_DIAGNOSTIC_CODES.entityMalformed,
            'A slot variant must be "straight" or "arc3".',
            input,
          ),
        );
      }
      const variant = input.variant;
      const x1 = parseFiniteNumber("x1", input.x1, input);
      if (!x1.ok) return x1;
      const y1 = parseFiniteNumber("y1", input.y1, input);
      if (!y1.ok) return y1;
      const x2 = parseFiniteNumber("x2", input.x2, input);
      if (!x2.ok) return x2;
      const y2 = parseFiniteNumber("y2", input.y2, input);
      if (!y2.ok) return y2;
      const radius = parseFiniteNumber("radius", input.radius, input);
      if (!radius.ok) return radius;
      if (!(radius.value > 0)) {
        return fail(
          entityError(
            SKETCH_DIAGNOSTIC_CODES.entityParametersInvalid,
            `Entity radius must be a positive number of mm, received ${String(radius.value)}.`,
            input,
          ),
        );
      }
      const start = { x: x1.value, y: y1.value };
      if (variant === "straight") {
        if (x1.value === x2.value && y1.value === y2.value) {
          return fail(
            entityError(
              SKETCH_DIAGNOSTIC_CODES.slotGeometryInvalid,
              "A straight slot's cap centers must be distinct; a zero-length centerline is degenerate (use a circle).",
              input,
            ),
          );
        }
        return ok({
          id: id.value,
          kind: "slot",
          construction: construction.value,
          fixed: fixed.value,
          variant,
          x1: x1.value,
          y1: y1.value,
          x2: x2.value,
          y2: y2.value,
          radius: radius.value,
        });
      }
      const x3 = parseFiniteNumber("x3", input.x3, input);
      if (!x3.ok) return x3;
      const y3 = parseFiniteNumber("y3", input.y3, input);
      if (!y3.ok) return y3;
      const through = { x: x2.value, y: y2.value };
      const end = { x: x3.value, y: y3.value };
      const distinct =
        (start.x !== through.x || start.y !== through.y) &&
        (through.x !== end.x || through.y !== end.y) &&
        (start.x !== end.x || start.y !== end.y);
      if (!distinct) {
        return fail(
          entityError(
            SKETCH_DIAGNOSTIC_CODES.slotGeometryInvalid,
            "A 3-point-arc slot's three centerline points must be distinct.",
            input,
          ),
        );
      }
      const circumcircle = circumcircleOf(start, through, end);
      if (circumcircle === null) {
        return fail(
          entityError(
            SKETCH_DIAGNOSTIC_CODES.slotGeometryInvalid,
            "A 3-point-arc slot's centerline points must not be collinear — the centerline is an arc (a straight centerline is the straight slot).",
            input,
          ),
        );
      }
      if (!(circumcircle.radius > radius.value)) {
        return fail(
          entityError(
            SKETCH_DIAGNOSTIC_CODES.slotGeometryInvalid,
            `A 3-point-arc slot's centerline arc radius (${circumcircle.radius.toFixed(6)} mm) must exceed its cap radius (${String(radius.value)} mm); the inner offset arc would otherwise invert.`,
            input,
          ),
        );
      }
      return ok({
        id: id.value,
        kind: "slot",
        construction: construction.value,
        fixed: fixed.value,
        variant,
        x1: x1.value,
        y1: y1.value,
        x2: x2.value,
        y2: y2.value,
        x3: x3.value,
        y3: y3.value,
        radius: radius.value,
      });
    }
  }
}
