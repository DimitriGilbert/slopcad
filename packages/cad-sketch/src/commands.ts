/**
 * Serializable sketch commands (Phase 25): the mutation vocabulary of a
 * sketch, mirroring the cad-core Phase 7 command discipline one domain down.
 * A {@link SketchCommand} is pure data describing ONE supported mutation —
 * create, update, or delete a sketch entity; create or delete a constraint;
 * replace a dimensional constraint's value — and {@link applySketchCommand}
 * is its sole interpreter: a pure, deterministic function of
 * (sketch, command) → next sketch, or a structured failure carrying stable
 * `sketch-command/*` and `sketch/*` codes. Nothing here mutates inputs,
 * consults the clock or randomness, or performs I/O, which is what makes
 * sketch command logs replayable.
 *
 * ## The Phase 25 vocabulary extension (disclosed)
 *
 * This module extends the project's command vocabulary from the five
 * document command types (Phase 7 + the Phase 20 `feature.reorder`) with six
 * sketch command types. The disclosure, per the Phase 20 precedent: sketches
 * are their own serialized aggregate (Phase 24) with their own format
 * version, so the vocabulary grows beside the document vocabulary rather
 * than inside it — a persisted sketch command log carries `formatVersion`
 * `SKETCH_FORMAT_VERSION` and is parsed only by parsers that know these six
 * types (`sketch-command/type-unknown` otherwise); every sketch written
 * before the extension carries none and parses exactly as before. Document
 * commands and sketch commands never mix in one transaction.
 *
 * ## Determinism and integrity
 *
 * Command payloads carry explicit ids (the UI generates them from its own
 * deterministic generator), so applying the same command to the same sketch
 * always yields the same next sketch — a serialized command replays onto the
 * identical state it first produced. Every application re-runs the sketch's
 * structural integrity rules (unique ids, resolvable rectangle edges,
 * well-referenced constraints), so a command can never commit a sketch that
 * parsing would reject. `sketch.entity.delete` refuses while a rectangle
 * edge or a constraint still references the entity — dependents are deleted
 * first (the UI composes one atomic transaction of `sketch.constraint.delete`
 * commands followed by the `sketch.entity.delete`), never silently cascaded.
 *
 * ## Wire format
 *
 * {@link serializeSketchCommand} emits a fixed-shape, fixed-key-order JSON
 * object stamped with {@link SKETCH_FORMAT_VERSION}; {@link
 * parseSketchCommand} validates untrusted input strictly (stable failure
 * codes) and ignores unknown fields so future format versions deserialize
 * without data corruption. Entities and constraints ride their existing
 * canonical serializations ({@link serializeSketchEntity}, {@link
 * serializeSketchConstraint}); dimensional values serialize canonically
 * (canonical unit, canonical magnitude), so a replayed
 * `sketch.dimension.set` stores the equal canonical quantity. The literal
 * form is byte-identical to every payload before bindings; the BOUND form
 * (`parameterId`, no value) binds the dimension to a document parameter
 * whose current value resolves at solve/profile time.
 */

import {
  type LengthValue,
  type ParameterId,
  type ParseResult,
  angle,
  valueIn,
  fail,
  length,
  ok,
  parseDimensionalValue,
  parseParameterId,
  serializeDimensionalValue,
  type SerializedDimensionalValue,
  toCanonical,
  type AngleValue,
} from "@slopcad/cad-core";

import {
  type AngleConstraint,
  type DiameterConstraint,
  type DistanceConstraint,
  type DistanceXConstraint,
  type DistanceYConstraint,
  type RadiusConstraint,
  type SketchConstraint,
  parseSketchConstraint,
  serializeSketchConstraint,
  validateConstraintReferences,
} from "./constraints";
import {
  type SketchEntity,
  parseSketchEntity,
  serializeSketchEntity,
} from "./entities";
import { SKETCH_FORMAT_VERSION, type Sketch } from "./sketch";
import {
  type SketchConstraintId,
  type SketchEntityId,
  parseSketchConstraintId,
  parseSketchEntityId,
} from "./sketch-ids";

/** The command types of the sketch mutation vocabulary (Phase 25). */
export const SKETCH_COMMAND_TYPES = [
  "sketch.entity.create",
  "sketch.entity.update",
  "sketch.entity.delete",
  "sketch.constraint.create",
  "sketch.constraint.delete",
  "sketch.dimension.set",
] as const;

export type SketchCommandType = (typeof SKETCH_COMMAND_TYPES)[number];

const COMMAND_TYPE_SET: ReadonlySet<string> = new Set(SKETCH_COMMAND_TYPES);

/** Type guard for untrusted sketch command type values. */
export function isSketchCommandType(
  input: unknown,
): input is SketchCommandType {
  return typeof input === "string" && COMMAND_TYPE_SET.has(input);
}

/** The constraint kinds that carry an editable dimensional value. */
export const DIMENSIONAL_CONSTRAINT_KINDS = [
  "distance",
  "angle",
  "radius",
  "diameter",
  "distanceX",
  "distanceY",
] as const;

export type DimensionalConstraintKind =
  (typeof DIMENSIONAL_CONSTRAINT_KINDS)[number];

/** Type guard for the dimensional constraint kinds. */
export function isDimensionalConstraintKind(
  input: unknown,
): input is DimensionalConstraintKind {
  return (DIMENSIONAL_CONSTRAINT_KINDS as readonly string[]).includes(
    input as string,
  );
}

/**
 * The dimensional constraint shapes: distance/angle/radius/diameter, the
 * kinds {@link SketchCommand}'s `sketch.dimension.set` addresses. Narrowing
 * the whole record (not just the kind tag) lets the interpreter spread the
 * replacement value in typed.
 */
export type DimensionalConstraint =
  | DistanceConstraint
  | AngleConstraint
  | RadiusConstraint
  | DiameterConstraint
  | DistanceXConstraint
  | DistanceYConstraint;

/** Type guard narrowing a constraint to the dimensional shapes. */
export function isDimensionalConstraint(
  constraint: SketchConstraint,
): constraint is DimensionalConstraint {
  return isDimensionalConstraintKind(constraint.kind);
}

/**
 * One supported sketch mutation, as pure serializable data. `entity.create`
 * adds a record; `entity.update` wholesale-replaces the record with the
 * same id; `entity.delete` removes it (refused while referenced);
 * `constraint.create` adds a constraint (references validated);
 * `constraint.delete` removes one; and `dimension.set` replaces a
 * dimensional constraint's value with the given length (mm) or angle (rad)
 * canonical magnitude — or, in its bound form, binds the dimension to a
 * document parameter (the literal commit on a bound constraint unbinds it).
 */
export type SketchCommand =
  | {
      readonly type: "sketch.entity.create";
      readonly entity: SketchEntity;
    }
  | {
      readonly type: "sketch.entity.update";
      readonly entity: SketchEntity;
    }
  | {
      readonly type: "sketch.entity.delete";
      readonly entityId: SketchEntityId;
    }
  | {
      readonly type: "sketch.constraint.create";
      readonly constraint: SketchConstraint;
    }
  | {
      readonly type: "sketch.constraint.delete";
      readonly constraintId: SketchConstraintId;
    }
  | {
      readonly type: "sketch.dimension.set";
      readonly constraintId: SketchConstraintId;
      /** The replacement dimensional value (length or angle, canonical). */
      readonly value: LengthValue | AngleValue;
    }
  | {
      readonly type: "sketch.dimension.set";
      readonly constraintId: SketchConstraintId;
      /**
       * The document parameter the dimension becomes BOUND to: its value
       * resolves from a caller-supplied parameter lookup at solve/profile
       * time (see `dimension-bindings.ts`), so the parameter's edits
       * re-drive the sketch. The constraint's stored literal is untouched
       * (it stays the last literal the dimension held).
       */
      readonly parameterId: ParameterId;
    };

/** Stable failure codes produced when sketch command input is rejected. */
export const SKETCH_COMMAND_ERROR_CODES = {
  malformed: "sketch-command/malformed",
  versionUnsupported: "sketch-command/version-unsupported",
  typeUnknown: "sketch-command/type-unknown",
  entityUnknown: "sketch-command/entity-unknown",
  entityDuplicate: "sketch-command/entity-duplicate",
  entityReferenced: "sketch-command/entity-referenced",
  constraintUnknown: "sketch-command/constraint-unknown",
  constraintDuplicate: "sketch-command/constraint-duplicate",
  notDimensional: "sketch-command/constraint-not-dimensional",
  dimensionMismatch: "sketch-command/dimension-mismatch",
  integrity: "sketch-command/integrity",
  nothingToUndo: "sketch-command/nothing-to-undo",
  nothingToRedo: "sketch-command/nothing-to-redo",
} as const;

export type SketchCommandErrorCode =
  (typeof SKETCH_COMMAND_ERROR_CODES)[keyof typeof SKETCH_COMMAND_ERROR_CODES];

/** Structured failure describing why a sketch command was rejected. */
export interface SketchCommandError {
  readonly code: SketchCommandErrorCode;
  readonly message: string;
  readonly input: unknown;
}

function commandError(
  code: SketchCommandErrorCode,
  message: string,
  input: unknown,
): SketchCommandError {
  return { code, message, input };
}

function indexById<T extends { readonly id: string }>(
  items: readonly T[],
): Map<string, T> {
  return new Map(items.map((item) => [item.id, item]));
}

/** Whether any rectangle edge or constraint references `entityId`. */
function entityReferencedBy(
  sketch: Sketch,
  entityId: SketchEntityId,
): string | null {
  for (const entity of sketch.entities) {
    if (entity.kind !== "rectangle") continue;
    if (entity.edges.includes(entityId)) {
      return `rectangle ${entity.id} references it as an edge`;
    }
  }
  for (const constraint of sketch.constraints) {
    if (constraintReferencesEntity(constraint, entityId)) {
      return `constraint ${constraint.id} (${constraint.kind}) references it`;
    }
  }
  return null;
}

/** Whether the constraint's operands mention `entityId`. */
function constraintReferencesEntity(
  constraint: SketchConstraint,
  entityId: SketchEntityId,
): boolean {
  switch (constraint.kind) {
    case "coincident":
      return (
        constraint.first.entity === entityId ||
        constraint.second.entity === entityId
      );
    case "horizontal":
    case "vertical":
    case "radius":
    case "diameter":
      return constraint.entity === entityId;
    case "parallel":
    case "perpendicular":
    case "equal":
    case "tangent":
    case "collinear":
      return constraint.first === entityId || constraint.second === entityId;
    case "pointOnEntity":
      return (
        constraint.point.entity === entityId || constraint.entity === entityId
      );
    case "pointOnTangent":
      return (
        constraint.point.entity === entityId || constraint.spline === entityId
      );
    case "horizontalPair":
    case "verticalPair":
    case "distanceX":
    case "distanceY":
      return (
        constraint.first.entity === entityId ||
        constraint.second.entity === entityId
      );
    case "distance":
      return (
        constraint.first.entity === entityId ||
        constraint.second.entity === entityId
      );
    case "angle":
      return constraint.first === entityId || constraint.second === entityId;
    case "midpoint":
      return (
        constraint.point.entity === entityId || constraint.line === entityId
      );
    case "symmetry": {
      if (
        constraint.first.entity === entityId ||
        constraint.second.entity === entityId
      ) {
        return true;
      }
      return constraint.about.type === "point"
        ? constraint.about.point.entity === entityId
        : constraint.about.entity === entityId;
    }
  }
}

/** Re-checks the sketch's structural integrity after a mutation. */
function integrityProblem(sketch: Sketch): SketchCommandError | null {
  const entityIds = new Set<string>();
  for (const entity of sketch.entities) {
    if (entityIds.has(entity.id)) {
      return commandError(
        SKETCH_COMMAND_ERROR_CODES.integrity,
        `Duplicate entity id ${entity.id}; ids must be unique within a sketch.`,
        entity.id,
      );
    }
    entityIds.add(entity.id);
  }
  const constraintIds = new Set<string>();
  for (const constraint of sketch.constraints) {
    if (constraintIds.has(constraint.id)) {
      return commandError(
        SKETCH_COMMAND_ERROR_CODES.integrity,
        `Duplicate constraint id ${constraint.id}; ids must be unique within a sketch.`,
        constraint.id,
      );
    }
    constraintIds.add(constraint.id);
  }
  const byId = indexById(sketch.entities);
  for (const entity of sketch.entities) {
    if (entity.kind !== "rectangle") continue;
    for (const edge of entity.edges) {
      const target = byId.get(edge);
      if (target === undefined || target.kind !== "line") {
        return commandError(
          SKETCH_COMMAND_ERROR_CODES.integrity,
          `Rectangle ${entity.id} edge ${edge} must resolve to a line entity.`,
          entity,
        );
      }
    }
  }
  for (const constraint of sketch.constraints) {
    const diagnostic = validateConstraintReferences(
      constraint,
      sketch.entities,
    );
    if (diagnostic !== null) {
      return commandError(
        SKETCH_COMMAND_ERROR_CODES.integrity,
        diagnostic.message,
        constraint,
      );
    }
  }
  return null;
}

/**
 * Applies a sketch command to a sketch, returning the next sketch or a
 * structured failure. Pure and deterministic: the same command on the same
 * sketch always produces the same result, and the input sketch is never
 * modified. Referential integrity is re-validated at this boundary even
 * though the command is typed, so smuggled input fails structurally instead
 * of corrupting state.
 */
export function applySketchCommand(
  sketch: Sketch,
  command: SketchCommand,
): ParseResult<Sketch, SketchCommandError> {
  switch (command.type) {
    case "sketch.entity.create": {
      const entity = command.entity;
      if (indexById(sketch.entities).has(entity.id)) {
        return fail(
          commandError(
            SKETCH_COMMAND_ERROR_CODES.entityDuplicate,
            `Entity ${entity.id} already exists; ids must be unique within a sketch.`,
            entity.id,
          ),
        );
      }
      const next: Sketch = {
        ...sketch,
        entities: [...sketch.entities, entity],
      };
      const problem = integrityProblem(next);
      if (problem !== null) return fail(problem);
      return ok(next);
    }
    case "sketch.entity.update": {
      const entity = command.entity;
      const existing = indexById(sketch.entities).get(entity.id);
      if (existing === undefined) {
        return fail(
          commandError(
            SKETCH_COMMAND_ERROR_CODES.entityUnknown,
            `Entity ${entity.id} does not exist; update needs an existing entity.`,
            entity.id,
          ),
        );
      }
      const next: Sketch = {
        ...sketch,
        entities: sketch.entities.map((candidate) =>
          candidate.id === entity.id ? entity : candidate,
        ),
      };
      const problem = integrityProblem(next);
      if (problem !== null) return fail(problem);
      return ok(next);
    }
    case "sketch.entity.delete": {
      const entityId = command.entityId;
      if (!indexById(sketch.entities).has(entityId)) {
        return fail(
          commandError(
            SKETCH_COMMAND_ERROR_CODES.entityUnknown,
            `Entity ${entityId} does not exist; delete needs an existing entity.`,
            entityId,
          ),
        );
      }
      const reference = entityReferencedBy(sketch, entityId);
      if (reference !== null) {
        return fail(
          commandError(
            SKETCH_COMMAND_ERROR_CODES.entityReferenced,
            `Entity ${entityId} cannot be deleted while ${reference}; delete the dependents first.`,
            entityId,
          ),
        );
      }
      return ok({
        ...sketch,
        entities: sketch.entities.filter((entity) => entity.id !== entityId),
      });
    }
    case "sketch.constraint.create": {
      const constraint = command.constraint;
      if (indexById(sketch.constraints).has(constraint.id)) {
        return fail(
          commandError(
            SKETCH_COMMAND_ERROR_CODES.constraintDuplicate,
            `Constraint ${constraint.id} already exists; ids must be unique within a sketch.`,
            constraint.id,
          ),
        );
      }
      const diagnostic = validateConstraintReferences(
        constraint,
        sketch.entities,
      );
      if (diagnostic !== null) {
        return fail(
          commandError(
            SKETCH_COMMAND_ERROR_CODES.integrity,
            diagnostic.message,
            constraint,
          ),
        );
      }
      return ok({
        ...sketch,
        constraints: [...sketch.constraints, constraint],
      });
    }
    case "sketch.constraint.delete": {
      const constraintId = command.constraintId;
      if (!indexById(sketch.constraints).has(constraintId)) {
        return fail(
          commandError(
            SKETCH_COMMAND_ERROR_CODES.constraintUnknown,
            `Constraint ${constraintId} does not exist; delete needs an existing constraint.`,
            constraintId,
          ),
        );
      }
      return ok({
        ...sketch,
        constraints: sketch.constraints.filter(
          (constraint) => constraint.id !== constraintId,
        ),
      });
    }
    case "sketch.dimension.set": {
      const constraint = indexById(sketch.constraints).get(
        command.constraintId,
      );
      if (constraint === undefined) {
        return fail(
          commandError(
            SKETCH_COMMAND_ERROR_CODES.constraintUnknown,
            `Constraint ${command.constraintId} does not exist; dimension.set needs an existing constraint.`,
            command.constraintId,
          ),
        );
      }
      if (!isDimensionalConstraint(constraint)) {
        return fail(
          commandError(
            SKETCH_COMMAND_ERROR_CODES.notDimensional,
            `Constraint ${constraint.id} is a ${constraint.kind} constraint and carries no dimensional value; dimension.set needs a ${DIMENSIONAL_CONSTRAINT_KINDS.join("/")} constraint.`,
            constraint,
          ),
        );
      }
      // The BOUND form: the dimension follows a document parameter from now
      // on (its value resolves from the caller's environment at solve time).
      // The stored literal is untouched — it remains the last literal the
      // dimension held. Re-binding to the same parameter is an idempotent
      // replace.
      if ("parameterId" in command) {
        const updated: SketchConstraint = {
          ...constraint,
          parameterId: command.parameterId,
        };
        return ok({
          ...sketch,
          constraints: sketch.constraints.map((candidate) =>
            candidate.id === updated.id ? updated : candidate,
          ),
        });
      }
      let updated: SketchConstraint;
      if (constraint.kind === "angle") {
        if (command.value.dimension !== "angle") {
          return fail(
            commandError(
              SKETCH_COMMAND_ERROR_CODES.dimensionMismatch,
              `Constraint ${constraint.id} carries an angle value; dimension.set received ${command.value.dimension}.`,
              command.value,
            ),
          );
        }
        const replacement = toCanonical(command.value);
        const degrees = valueIn(replacement, "deg");
        if (!(degrees > 0 && degrees < 180)) {
          return fail(
            commandError(
              SKETCH_COMMAND_ERROR_CODES.integrity,
              `Constraint ${constraint.id} replacement value ${String(degrees)}° is out of range; an angle must be strictly between 0° and 180°.`,
              command.value,
            ),
          );
        }
        // A literal commit unbinds: the canonical literal shape never
        // carries the binding field — rebuild the record explicitly.
        updated = {
          id: constraint.id,
          kind: "angle",
          first: constraint.first,
          second: constraint.second,
          value: replacement,
          ...(constraint.at === undefined ? {} : { at: constraint.at }),
        };
      } else {
        if (command.value.dimension !== "length") {
          return fail(
            commandError(
              SKETCH_COMMAND_ERROR_CODES.dimensionMismatch,
              `Constraint ${constraint.id} carries a length value; dimension.set received ${command.value.dimension}.`,
              command.value,
            ),
          );
        }
        const replacement = toCanonical(command.value);
        const magnitude = valueIn(replacement, "mm");
        // distanceX/distanceY are SIGNED first→second separations (any
        // finite mm); the other length dimensions stay strictly positive.
        const signedKind =
          constraint.kind === "distanceX" || constraint.kind === "distanceY";
        if (!(signedKind ? Number.isFinite(magnitude) : magnitude > 0)) {
          return fail(
            commandError(
              SKETCH_COMMAND_ERROR_CODES.integrity,
              signedKind
                ? `Constraint ${constraint.id} replacement value must be a finite number of mm (signed).`
                : `Constraint ${constraint.id} replacement value must be strictly positive mm.`,
              command.value,
            ),
          );
        }
        switch (constraint.kind) {
          case "distance":
            updated = {
              id: constraint.id,
              kind: "distance",
              first: constraint.first,
              second: constraint.second,
              value: replacement,
            };
            break;
          case "radius":
          case "diameter":
            updated = {
              id: constraint.id,
              kind: constraint.kind,
              entity: constraint.entity,
              value: replacement,
            };
            break;
          case "distanceX":
          case "distanceY":
            updated = {
              id: constraint.id,
              kind: constraint.kind,
              first: constraint.first,
              second: constraint.second,
              value: replacement,
            };
            break;
        }
      }
      return ok({
        ...sketch,
        constraints: sketch.constraints.map((candidate) =>
          candidate.id === updated.id ? updated : candidate,
        ),
      });
    }
  }
}

/**
 * An ordered batch of sketch commands applied atomically — the sketch
 * counterpart of a cad-core transaction: either every command lands, in
 * order, or the failure propagates and nothing happened.
 */
export interface SketchTransaction {
  readonly commands: readonly SketchCommand[];
}

/**
 * Applies a transaction atomically: commands run in order through the single
 * command interpreter; on any failure the input sketch is returned from
 * untouched.
 */
export function applySketchTransaction(
  sketch: Sketch,
  transaction: SketchTransaction,
): ParseResult<Sketch, SketchCommandError> {
  let current = sketch;
  for (const command of transaction.commands) {
    const applied = applySketchCommand(current, command);
    if (!applied.ok) return applied;
    current = applied.value;
  }
  return ok(current);
}

// ---------------------------------------------------------------------------
// Wire format
// ---------------------------------------------------------------------------

/** Canonical JSON form of a sketch command, discriminated by `type`. */
export type SerializedSketchCommand =
  | {
      readonly formatVersion: number;
      readonly type: "sketch.entity.create" | "sketch.entity.update";
      readonly entity: Readonly<Record<string, unknown>>;
    }
  | {
      readonly formatVersion: number;
      readonly type: "sketch.entity.delete";
      readonly entityId: string;
    }
  | {
      readonly formatVersion: number;
      readonly type: "sketch.constraint.create";
      readonly constraint: Readonly<Record<string, unknown>>;
    }
  | {
      readonly formatVersion: number;
      readonly type: "sketch.constraint.delete";
      readonly constraintId: string;
    }
  | {
      readonly formatVersion: number;
      readonly type: "sketch.dimension.set";
      readonly constraintId: string;
      readonly value: SerializedDimensionalValue;
    }
  | {
      readonly formatVersion: number;
      readonly type: "sketch.dimension.set";
      readonly constraintId: string;
      /** The bound form's document parameter id (no literal value). */
      readonly parameterId: string;
    };

/** Serializes a sketch command to its canonical, deterministic JSON form. */
export function serializeSketchCommand(
  command: SketchCommand,
): SerializedSketchCommand {
  switch (command.type) {
    case "sketch.entity.create":
    case "sketch.entity.update":
      return {
        formatVersion: SKETCH_FORMAT_VERSION,
        type: command.type,
        entity: serializeSketchEntity(command.entity),
      };
    case "sketch.entity.delete":
      return {
        formatVersion: SKETCH_FORMAT_VERSION,
        type: command.type,
        entityId: command.entityId,
      };
    case "sketch.constraint.create":
      return {
        formatVersion: SKETCH_FORMAT_VERSION,
        type: command.type,
        constraint: serializeSketchConstraint(command.constraint),
      };
    case "sketch.constraint.delete":
      return {
        formatVersion: SKETCH_FORMAT_VERSION,
        type: command.type,
        constraintId: command.constraintId,
      };
    case "sketch.dimension.set":
      return "parameterId" in command
        ? {
            formatVersion: SKETCH_FORMAT_VERSION,
            type: command.type,
            constraintId: command.constraintId,
            parameterId: command.parameterId,
          }
        : {
            formatVersion: SKETCH_FORMAT_VERSION,
            type: command.type,
            constraintId: command.constraintId,
            value: serializeDimensionalValue(command.value),
          };
  }
}

function isPlainRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}

/**
 * Parses untrusted input (e.g. a command revived from persisted JSON) as a
 * {@link SketchCommand}. Known fields are validated strictly — format
 * version, command type, ids, entities, constraints, dimensional values —
 * while unknown fields are ignored so future format versions deserialize
 * without data corruption.
 */
export function parseSketchCommand(
  input: unknown,
): ParseResult<SketchCommand, SketchCommandError> {
  if (!isPlainRecord(input)) {
    return fail(
      commandError(
        SKETCH_COMMAND_ERROR_CODES.malformed,
        "A serialized sketch command must be a plain object.",
        input,
      ),
    );
  }
  if (input.formatVersion !== SKETCH_FORMAT_VERSION) {
    return fail(
      commandError(
        SKETCH_COMMAND_ERROR_CODES.versionUnsupported,
        `A serialized sketch command must carry formatVersion ${SKETCH_FORMAT_VERSION}.`,
        input.formatVersion,
      ),
    );
  }
  const { type } = input;
  if (!isSketchCommandType(type)) {
    return fail(
      commandError(
        SKETCH_COMMAND_ERROR_CODES.typeUnknown,
        `A sketch command type must be one of: ${SKETCH_COMMAND_TYPES.join(", ")}.`,
        type,
      ),
    );
  }
  switch (type) {
    case "sketch.entity.create": {
      const parsed = parseSketchEntity(input.entity);
      if (!parsed.ok) {
        return fail(
          commandError(
            SKETCH_COMMAND_ERROR_CODES.malformed,
            `A ${type} command needs a valid entity: ${parsed.error.message}`,
            input.entity,
          ),
        );
      }
      return ok(Object.freeze({ type, entity: parsed.value }));
    }
    case "sketch.entity.update": {
      const parsed = parseSketchEntity(input.entity);
      if (!parsed.ok) {
        return fail(
          commandError(
            SKETCH_COMMAND_ERROR_CODES.malformed,
            `A ${type} command needs a valid entity: ${parsed.error.message}`,
            input.entity,
          ),
        );
      }
      return ok(Object.freeze({ type, entity: parsed.value }));
    }
    case "sketch.entity.delete": {
      const parsed = parseSketchEntityId(input.entityId);
      if (!parsed.ok) {
        return fail(
          commandError(
            SKETCH_COMMAND_ERROR_CODES.malformed,
            `A sketch.entity.delete command needs a valid entity id: ${parsed.error.message}`,
            input.entityId,
          ),
        );
      }
      return ok(Object.freeze({ type, entityId: parsed.value }));
    }
    case "sketch.constraint.create": {
      const parsed = parseSketchConstraint(input.constraint);
      if (!parsed.ok) {
        return fail(
          commandError(
            SKETCH_COMMAND_ERROR_CODES.malformed,
            `A sketch.constraint.create command needs a valid constraint: ${parsed.error.message}`,
            input.constraint,
          ),
        );
      }
      return ok(Object.freeze({ type, constraint: parsed.value }));
    }
    case "sketch.constraint.delete": {
      const parsed = parseSketchConstraintId(input.constraintId);
      if (!parsed.ok) {
        return fail(
          commandError(
            SKETCH_COMMAND_ERROR_CODES.malformed,
            `A sketch.constraint.delete command needs a valid constraint id: ${parsed.error.message}`,
            input.constraintId,
          ),
        );
      }
      return ok(Object.freeze({ type, constraintId: parsed.value }));
    }
    case "sketch.dimension.set": {
      const parsedId = parseSketchConstraintId(input.constraintId);
      if (!parsedId.ok) {
        return fail(
          commandError(
            SKETCH_COMMAND_ERROR_CODES.malformed,
            `A sketch.dimension.set command needs a valid constraint id: ${parsedId.error.message}`,
            input.constraintId,
          ),
        );
      }
      // Exactly one of the two forms: the literal value (every payload
      // before bindings carries it) or the parameter binding. Both present
      // is ambiguous and refused; neither is malformed.
      const hasValue = input.value !== undefined;
      const hasParameterId = input.parameterId !== undefined;
      if (hasValue && hasParameterId) {
        return fail(
          commandError(
            SKETCH_COMMAND_ERROR_CODES.malformed,
            "A sketch.dimension.set command carries either a literal value or a parameterId binding, not both.",
            input,
          ),
        );
      }
      if (hasParameterId) {
        const parsedParameterId = parseParameterId(input.parameterId);
        if (!parsedParameterId.ok) {
          return fail(
            commandError(
              SKETCH_COMMAND_ERROR_CODES.malformed,
              `A sketch.dimension.set command needs a valid parameter id binding: ${parsedParameterId.error.message}`,
              input.parameterId,
            ),
          );
        }
        return ok(
          Object.freeze({
            type,
            constraintId: parsedId.value,
            parameterId: parsedParameterId.value,
          }),
        );
      }
      const parsedValue = parseDimensionalValue(input.value);
      if (!parsedValue.ok) {
        return fail(
          commandError(
            SKETCH_COMMAND_ERROR_CODES.malformed,
            `A sketch.dimension.set command needs a valid dimensional value: ${parsedValue.error.message}`,
            input.value,
          ),
        );
      }
      const { value } = parsedValue;
      if (value.dimension !== "length" && value.dimension !== "angle") {
        return fail(
          commandError(
            SKETCH_COMMAND_ERROR_CODES.dimensionMismatch,
            `A sketch.dimension.set value must be a length or an angle, received dimension "${value.dimension}".`,
            input.value,
          ),
        );
      }
      // The parsed value carries a runtime-checked dimension; re-canonize it
      // through the dimension's own constructor so the parsed command stores
      // exactly what an in-memory command stores (canonical unit, canonical
      // magnitude) and replay is byte-exact. Range rules match the constraint
      // builders: strictly positive lengths, open-interval angles.
      const canonical =
        value.dimension === "length"
          ? length(valueIn(value, "mm"))
          : angle(valueIn(value, "rad"));
      const inRange =
        canonical.dimension === "length"
          ? valueIn(canonical, "mm") > 0
          : valueIn(canonical, "deg") > 0 && valueIn(canonical, "deg") < 180;
      if (!inRange) {
        return fail(
          commandError(
            SKETCH_COMMAND_ERROR_CODES.integrity,
            "A sketch.dimension.set value must be strictly positive mm, or an angle strictly between 0° and 180°.",
            input.value,
          ),
        );
      }
      return ok(
        Object.freeze({
          type,
          constraintId: parsedId.value,
          value: canonical,
        }),
      );
    }
  }
}
