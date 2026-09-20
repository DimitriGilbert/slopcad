/**
 * The sketch aggregate: a workplane plus its entities and constraints, and
 * the round-trip serialization that carries all three.
 *
 * The envelope is `{ formatVersion, workplane, entities, constraints }` in
 * that fixed key order. Parsing is strict about the version stamp and about
 * cross-references (unique entity/constraint ids, rectangle edges that
 * resolve to line entities, constraint operands that resolve and are of
 * compatible kinds) so anything that leaves this module is structurally
 * sound; the solver still re-validates defensively.
 */

import { type ParseResult, fail, ok } from "@slopcad/cad-core";
import type { SketchEntityId } from "./sketch-ids";
import type { SerializedWorkplane } from "./workplane";

import { SKETCH_DIAGNOSTIC_CODES } from "./diagnostics";
import {
  type SketchConstraint,
  validateConstraintReferences,
} from "./constraints";
import {
  parseSketchConstraint,
  serializeSketchConstraint,
} from "./constraints";
import {
  type SketchEntity,
  parseSketchEntity,
  serializeSketchEntity,
} from "./entities";
import {
  type Workplane,
  parseWorkplane,
  serializeWorkplane,
} from "./workplane";
import {
  type SolvedSketchParameters,
  solvedEntityParametersById,
} from "./solver";

/**
 * Version of the sketch serialization format implemented by this package.
 * It must remain a positive integer and only ever move forward.
 *
 * v2 (Phase 36) added the entity kinds `ellipse`, `ellipticalArc`, `spline`,
 * `polygon`, and `slot`, and the constraint kinds `pointOnEntity`,
 * `collinear`, `horizontalPair`, `verticalPair`, `distanceX`, and
 * `distanceY`. The growth is strictly additive — every v1 payload is a
 * valid v2 payload byte-for-byte except the stamp — so the native-format
 * v1→v2 migration carries old embedded sketches forward by bumping their
 * stamp alone.
 */
export const SKETCH_FORMAT_VERSION = 2;

/** A complete sketch: where it lives and what is in it. */
export interface Sketch {
  readonly workplane: Workplane;
  readonly entities: readonly SketchEntity[];
  readonly constraints: readonly SketchConstraint[];
}

/** Structured failure describing why input was rejected as a sketch. */
export interface SketchError {
  readonly code: string;
  readonly message: string;
  readonly input: unknown;
}

/**
 * The canonical JSON form of a sketch: `formatVersion`, then the workplane,
 * entities (in order), and constraints (in order), each serialized in its own
 * fixed key order.
 */
export interface SerializedSketch {
  readonly formatVersion: number;
  readonly workplane: SerializedWorkplane;
  readonly entities: readonly ReturnType<typeof serializeSketchEntity>[];
  readonly constraints: readonly ReturnType<typeof serializeSketchConstraint>[];
}

function checkUniqueIds<T extends { readonly id: string }>(
  items: readonly T[],
  code: string,
  what: string,
): ParseResult<true, SketchError> {
  const seen = new Set<string>();
  for (const item of items) {
    if (seen.has(item.id)) {
      return fail({
        code,
        message: `Duplicate ${what} id ${item.id}; ids must be unique within a sketch.`,
        input: item.id,
      });
    }
    seen.add(item.id);
  }
  return ok(true);
}

/**
 * Cross-reference validation shared by construction and parsing: unique ids,
 * rectangle edges resolving to distinct line entities, and constraint
 * operands resolving with compatible kinds.
 */
function checkSketchIntegrity(
  entities: readonly SketchEntity[],
  constraints: readonly SketchConstraint[],
): SketchError | null {
  const entityIds = checkUniqueIds(
    entities,
    SKETCH_DIAGNOSTIC_CODES.entityDuplicateId,
    "entity",
  );
  if (!entityIds.ok) return entityIds.error;
  const constraintIds = checkUniqueIds(
    constraints,
    SKETCH_DIAGNOSTIC_CODES.constraintDuplicateId,
    "constraint",
  );
  if (!constraintIds.ok) return constraintIds.error;
  const byId = new Map<string, SketchEntity>(
    entities.map((entity) => [entity.id, entity]),
  );
  for (const entity of entities) {
    if (entity.kind !== "rectangle") continue;
    for (const edge of entity.edges) {
      const target = byId.get(edge);
      if (target === undefined) {
        return {
          code: SKETCH_DIAGNOSTIC_CODES.rectangleEdgesMalformed,
          message: `Rectangle ${entity.id} references missing edge entity ${edge}.`,
          input: entity,
        };
      }
      if (target.kind !== "line") {
        return {
          code: SKETCH_DIAGNOSTIC_CODES.rectangleEdgesMalformed,
          message: `Rectangle ${entity.id} edge ${edge} must reference a line entity, found ${target.kind}.`,
          input: entity,
        };
      }
    }
  }
  for (const constraint of constraints) {
    const diagnostic = validateConstraintReferences(constraint, entities);
    if (diagnostic !== null) {
      return {
        code: diagnostic.code,
        message: diagnostic.message,
        input: constraint,
      };
    }
  }
  return null;
}

/**
 * Creates a sketch from already-parsed parts, enforcing the structural
 * integrity rules (unique ids, resolvable rectangle edges, well-referenced
 * constraints).
 */
export function createSketch(
  workplane: Workplane,
  entities: readonly SketchEntity[],
  constraints: readonly SketchConstraint[],
): ParseResult<Sketch, SketchError> {
  const problem = checkSketchIntegrity(entities, constraints);
  if (problem !== null) return fail(problem);
  return ok({ workplane, entities, constraints });
}

/** Serializes a sketch to its canonical JSON form. */
export function serializeSketch(sketch: Sketch): SerializedSketch {
  return {
    formatVersion: SKETCH_FORMAT_VERSION,
    workplane: serializeWorkplane(sketch.workplane),
    entities: sketch.entities.map(serializeSketchEntity),
    constraints: sketch.constraints.map(serializeSketchConstraint),
  };
}

function isPlainRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}

/**
 * Parses untrusted input (e.g. a sketch revived from persisted JSON) as a
 * {@link Sketch}. The format version must match {@link
 * SKETCH_FORMAT_VERSION} exactly (`sketch/version-unsupported` otherwise);
 * parts are parsed strictly, cross-references are validated, and unknown
 * envelope fields are ignored. Round-trip is exact: parsing the output of
 * {@link serializeSketch} yields a sketch that serializes to identical JSON.
 */
export function parseSketch(input: unknown): ParseResult<Sketch, SketchError> {
  if (!isPlainRecord(input)) {
    return fail({
      code: SKETCH_DIAGNOSTIC_CODES.sketchMalformed,
      message: "A serialized sketch must be a plain object.",
      input,
    });
  }
  const { formatVersion } = input;
  if (
    typeof formatVersion !== "number" ||
    !Number.isInteger(formatVersion) ||
    formatVersion !== SKETCH_FORMAT_VERSION
  ) {
    return fail({
      code: SKETCH_DIAGNOSTIC_CODES.versionUnsupported,
      message: `A serialized sketch must carry formatVersion ${SKETCH_FORMAT_VERSION}; received ${String(formatVersion)}.`,
      input,
    });
  }
  const workplane = parseWorkplane(input.workplane);
  if (!workplane.ok) return fail(workplane.error);
  const rawEntities = input.entities;
  if (!Array.isArray(rawEntities)) {
    return fail({
      code: SKETCH_DIAGNOSTIC_CODES.entityMalformed,
      message: "A serialized sketch's entities must be an array.",
      input,
    });
  }
  const entities: SketchEntity[] = [];
  for (const rawEntity of rawEntities) {
    const parsed = parseSketchEntity(rawEntity);
    if (!parsed.ok) return fail(parsed.error);
    entities.push(parsed.value);
  }
  const rawConstraints = input.constraints;
  if (!Array.isArray(rawConstraints)) {
    return fail({
      code: SKETCH_DIAGNOSTIC_CODES.constraintMalformed,
      message: "A serialized sketch's constraints must be an array.",
      input,
    });
  }
  const constraints: SketchConstraint[] = [];
  for (const rawConstraint of rawConstraints) {
    const parsed = parseSketchConstraint(rawConstraint);
    if (!parsed.ok) return fail(parsed.error);
    constraints.push(parsed.value);
  }
  const problem = checkSketchIntegrity(entities, constraints);
  if (problem !== null) return fail(problem);
  return ok({ workplane: workplane.value, entities, constraints });
}

/**
 * Replaces every entity's parameters with solved values, preserving ids,
 * kinds, construction flags, rectangle composition, and order. Every
 * parameter-carrying entity must have an entry in `parameters` (rectangle
 * entities carry none and are passed through); a missing entry throws a
 * {@link SketchEntityValidationError}-style RangeError because it means the
 * solved parameters and the sketch disagree structurally.
 */
export function applySolvedParameters(
  sketch: Sketch,
  parameters: SolvedSketchParameters,
): Sketch {
  const solvedById = solvedEntityParametersById(parameters);
  return {
    ...sketch,
    entities: sketch.entities.map((entity) => {
      const solved = solvedById.get(entity.id);
      if (entity.kind === "rectangle") return entity;
      if (solved === undefined) {
        throw new RangeError(
          `Solved parameters are missing entity ${entity.id}; they must cover every parameter-carrying entity.`,
        );
      }
      switch (solved.kind) {
        case "point":
          return entity.kind === "point"
            ? { ...entity, x: solved.x, y: solved.y }
            : mismatch(entity.id, entity.kind, solved.kind);
        case "line":
          return entity.kind === "line"
            ? {
                ...entity,
                x1: solved.x1,
                y1: solved.y1,
                x2: solved.x2,
                y2: solved.y2,
              }
            : mismatch(entity.id, entity.kind, solved.kind);
        case "circle":
          return entity.kind === "circle"
            ? { ...entity, cx: solved.cx, cy: solved.cy, radius: solved.radius }
            : mismatch(entity.id, entity.kind, solved.kind);
        case "arc":
          return entity.kind === "arc"
            ? {
                ...entity,
                cx: solved.cx,
                cy: solved.cy,
                radius: solved.radius,
                startAngle: solved.startAngle,
                endAngle: solved.endAngle,
              }
            : mismatch(entity.id, entity.kind, solved.kind);
        case "rectangle":
          return mismatch(entity.id, entity.kind, solved.kind);
        case "ellipse":
          return entity.kind === "ellipse"
            ? {
                ...entity,
                cx: solved.cx,
                cy: solved.cy,
                radiusX: solved.radiusX,
                radiusY: solved.radiusY,
                rotation: solved.rotation,
              }
            : mismatch(entity.id, entity.kind, solved.kind);
        case "ellipticalArc":
          return entity.kind === "ellipticalArc"
            ? {
                ...entity,
                cx: solved.cx,
                cy: solved.cy,
                radiusX: solved.radiusX,
                radiusY: solved.radiusY,
                rotation: solved.rotation,
                startAngle: solved.startAngle,
                endAngle: solved.endAngle,
              }
            : mismatch(entity.id, entity.kind, solved.kind);
        case "spline":
          return entity.kind === "spline"
            ? { ...entity, points: solved.points }
            : mismatch(entity.id, entity.kind, solved.kind);
        case "polygon":
          return entity.kind === "polygon"
            ? {
                ...entity,
                cx: solved.cx,
                cy: solved.cy,
                radius: solved.radius,
                rotation: solved.rotation,
              }
            : mismatch(entity.id, entity.kind, solved.kind);
        case "slot":
          return entity.kind === "slot"
            ? {
                ...entity,
                x1: solved.x1,
                y1: solved.y1,
                x2: solved.x2,
                y2: solved.y2,
                ...(solved.x3 === undefined || solved.y3 === undefined
                  ? {}
                  : { x3: solved.x3, y3: solved.y3 }),
                radius: solved.radius,
              }
            : mismatch(entity.id, entity.kind, solved.kind);
      }
    }),
  };
}

function mismatch(
  id: SketchEntityId,
  entityKind: string,
  solvedKind: string,
): never {
  throw new RangeError(
    `Solved parameters for ${id} have kind "${solvedKind}" but the entity has kind "${entityKind}".`,
  );
}
