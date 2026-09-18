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

/** Union of every sketch entity. */
export type SketchEntity =
  PointEntity | LineEntity | CircleEntity | ArcEntity | RectangleEntity;

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
  }
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
  }
}
