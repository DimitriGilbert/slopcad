/**
 * First-class CAD parameters (Phase 5): named, dimensionally typed values
 * with an optional defining expression and JSON-safe metadata.
 *
 * A {@link Parameter} is an immutable value object. Its dimensional type is
 * carried by its typed value (`parameter.value.dimension`) — one source of
 * truth, never a duplicated field. A parameter either holds a literal value
 * or additionally carries an expression AST that defines it; the cached
 * `value` is what evaluation currently produced (recomputing values is the
 * regeneration pipeline's job, not this module's).
 *
 * Parameters live in a {@link ParameterCollection}, an immutable ordered
 * array with names unique (they are the identifier vocabulary of
 * expressions) and ids unique. Every mutation — add, remove, update value,
 * expression, or metadata — validates its input with a stable
 * `parameter/*` failure code and returns a new collection, leaving the
 * original untouched. Serialization is canonical (values in their canonical
 * unit, fixed key order) and parsing validates untrusted input strictly.
 */

import {
  type AnyDimensionalValue,
  parseDimensionalValue,
  serializeDimensionalValue,
  type SerializedDimensionalValue,
} from "./dimensional";
import {
  type ExpressionNode,
  isExpressionFunction,
  isExpressionIdentifierName,
  parseExpressionAst,
} from "./expression";
import { type ExpressionEnvironment } from "./expression-evaluator";
import { type ParameterId, parseParameterId } from "./ids";
import { type ParseFailure, type ParseResult, fail, ok } from "./result";

/** JSON-safe primitive values allowed in {@link Parameter.metadata}. */
export type ParameterMetadataValue = string | number | boolean | null;

/** Free-form, JSON-safe metadata attached to a parameter. */
export type ParameterMetadata = Readonly<
  Record<string, ParameterMetadataValue>
>;

/** An immutable parameter record; the dimensional type is `value.dimension`. */
export interface Parameter {
  readonly id: ParameterId;
  readonly name: string;
  readonly value: AnyDimensionalValue;
  /** The defining expression, or null for a literal-only parameter. */
  readonly expression: ExpressionNode | null;
  readonly metadata: ParameterMetadata;
}

/** Input accepted by {@link addParameter}. */
export interface ParameterInput {
  readonly id: ParameterId;
  readonly name: string;
  readonly value: AnyDimensionalValue;
  readonly expression?: ExpressionNode | null;
  readonly metadata?: ParameterMetadata;
}

/** Immutable, ordered collection of parameters with unique ids and names. */
export interface ParameterCollection {
  readonly parameters: readonly Parameter[];
}

/** The empty collection; every collection is derived from it immutably. */
export const EMPTY_PARAMETER_COLLECTION: ParameterCollection = Object.freeze({
  parameters: Object.freeze([]),
});

/** Stable failure codes produced when parameter input is rejected. */
export const PARAMETER_ERROR_CODES = {
  malformed: "parameter/malformed",
  idInvalid: "parameter/id-invalid",
  idConflict: "parameter/id-conflict",
  nameInvalid: "parameter/name-invalid",
  nameReserved: "parameter/name-reserved",
  nameConflict: "parameter/name-conflict",
  invalidValue: "parameter/invalid-value",
  invalidExpression: "parameter/invalid-expression",
  invalidMetadata: "parameter/invalid-metadata",
  notFound: "parameter/not-found",
  /** An expression references a name that resolves to no parameter. */
  unknownIdentifier: "parameter/unknown-identifier",
  /** Installing an expression would close a reference cycle. */
  cycle: "parameter/cycle",
} as const;

export type ParameterErrorCode =
  (typeof PARAMETER_ERROR_CODES)[keyof typeof PARAMETER_ERROR_CODES];

/** Structured failure describing why parameter input was rejected. */
export interface ParameterError extends ParseFailure {
  readonly code: ParameterErrorCode;
}

function parameterError(
  code: ParameterErrorCode,
  message: string,
  input: unknown,
): ParameterError {
  return { code, message, input };
}

function isPlainRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}

function isMetadataValue(input: unknown): input is ParameterMetadataValue {
  if (typeof input === "number") return Number.isFinite(input);
  return (
    typeof input === "string" || typeof input === "boolean" || input === null
  );
}

/** Validates and normalizes a value field, or fails with `invalidValue`. */
function validateValue(
  input: unknown,
): ParseResult<AnyDimensionalValue, ParameterError> {
  const parsed = parseDimensionalValue(input);
  if (!parsed.ok) {
    return fail(
      parameterError(
        PARAMETER_ERROR_CODES.invalidValue,
        `A parameter value must be a valid dimensional value: ${parsed.error.message}`,
        input,
      ),
    );
  }
  return ok(parsed.value);
}

function validateName(name: unknown): ParseResult<string, ParameterError> {
  if (typeof name !== "string" || !isExpressionIdentifierName(name)) {
    return fail(
      parameterError(
        PARAMETER_ERROR_CODES.nameInvalid,
        "A parameter name must start with a letter or underscore, use only letters, digits, and underscores, and be at most 64 characters (it must be usable as an expression identifier).",
        name,
      ),
    );
  }
  if (isExpressionFunction(name)) {
    return fail(
      parameterError(
        PARAMETER_ERROR_CODES.nameReserved,
        `The parameter name "${name}" is reserved by the expression function set.`,
        name,
      ),
    );
  }
  return ok(name);
}

function validateExpression(
  expression: unknown,
): ParseResult<ExpressionNode | null, ParameterError> {
  if (expression === null || expression === undefined) return ok(null);
  const parsed = parseExpressionAst(expression);
  if (!parsed.ok) {
    return fail(
      parameterError(
        PARAMETER_ERROR_CODES.invalidExpression,
        `A parameter expression must be a valid expression AST: ${parsed.error.message}`,
        expression,
      ),
    );
  }
  return ok(parsed.value);
}

function validateMetadata(
  metadata: unknown,
): ParseResult<ParameterMetadata, ParameterError> {
  if (metadata === undefined || metadata === null) {
    return ok(Object.freeze({}));
  }
  if (!isPlainRecord(metadata)) {
    return fail(
      parameterError(
        PARAMETER_ERROR_CODES.invalidMetadata,
        "Parameter metadata must be a plain object of string, finite number, boolean, or null values.",
        metadata,
      ),
    );
  }
  const copy: Record<string, ParameterMetadataValue> = {};
  for (const [key, value] of Object.entries(metadata)) {
    // Rejected up front rather than stored on a null-prototype object: a plain `copy[key] = value` on `__proto__` hits the inherited setter and silently drops the key.
    if (key === "__proto__") {
      return fail(
        parameterError(
          PARAMETER_ERROR_CODES.invalidMetadata,
          'Parameter metadata must not use the "__proto__" key.',
          metadata,
        ),
      );
    }
    if (!isMetadataValue(value)) {
      return fail(
        parameterError(
          PARAMETER_ERROR_CODES.invalidMetadata,
          "Parameter metadata values must be strings, finite numbers, booleans, or null.",
          metadata,
        ),
      );
    }
    copy[key] = value;
  }
  return ok(Object.freeze(copy));
}

/** Validates and freezes a parameter from its (typed or untrusted) fields. */
function buildParameter(
  id: unknown,
  name: unknown,
  value: unknown,
  expression: unknown,
  metadata: unknown,
): ParseResult<Parameter, ParameterError> {
  const parsedId = parseParameterId(id);
  if (!parsedId.ok) {
    return fail(
      parameterError(
        PARAMETER_ERROR_CODES.idInvalid,
        `A parameter id must be a valid parameter id: ${parsedId.error.message}`,
        id,
      ),
    );
  }
  const parsedName = validateName(name);
  if (!parsedName.ok) return parsedName;
  const parsedValue = validateValue(value);
  if (!parsedValue.ok) return parsedValue;
  const parsedExpression = validateExpression(expression);
  if (!parsedExpression.ok) return parsedExpression;
  const parsedMetadata = validateMetadata(metadata);
  if (!parsedMetadata.ok) return parsedMetadata;
  return ok(
    Object.freeze({
      id: parsedId.value,
      name: parsedName.value,
      value: parsedValue.value,
      expression: parsedExpression.value,
      metadata: parsedMetadata.value,
    }),
  );
}

function conflict(
  code: "parameter/id-conflict" | "parameter/name-conflict",
  message: string,
  input: ParameterInput,
): ParseResult<ParameterCollection, ParameterError> {
  return fail(parameterError(code, message, input));
}

/**
 * Adds a parameter to a copy of the collection. The input is validated
 * (identifier-shaped, non-reserved unique name; valid dimensional value;
 * optional valid expression; JSON-safe metadata) and the original collection
 * is never mutated. Fails with `idConflict`/`nameConflict` on duplicates.
 */
export function addParameter(
  collection: ParameterCollection,
  input: ParameterInput,
): ParseResult<ParameterCollection, ParameterError> {
  const parameter = buildParameter(
    input.id,
    input.name,
    input.value,
    input.expression ?? null,
    input.metadata,
  );
  if (!parameter.ok) return parameter;
  const { id, name } = parameter.value;
  const existingById = collection.parameters.find((p) => p.id === id);
  if (existingById !== undefined) {
    return conflict(
      PARAMETER_ERROR_CODES.idConflict,
      `A parameter with id "${id}" already exists.`,
      input,
    );
  }
  const existingByName = collection.parameters.find((p) => p.name === name);
  if (existingByName !== undefined) {
    return conflict(
      PARAMETER_ERROR_CODES.nameConflict,
      `A parameter named "${name}" already exists (id "${existingByName.id}").`,
      input,
    );
  }
  return ok(
    Object.freeze({
      parameters: Object.freeze([...collection.parameters, parameter.value]),
    }),
  );
}

/** Removes the parameter with the given id; fails with `notFound` if absent. */
export function removeParameter(
  collection: ParameterCollection,
  id: ParameterId,
): ParseResult<ParameterCollection, ParameterError> {
  const remaining = collection.parameters.filter((p) => p.id !== id);
  if (remaining.length === collection.parameters.length) {
    return fail(
      parameterError(
        PARAMETER_ERROR_CODES.notFound,
        `No parameter with id "${id}" exists.`,
        id,
      ),
    );
  }
  return ok(Object.freeze({ parameters: Object.freeze(remaining) }));
}

/** Returns the parameter with the given id, or undefined. */
export function getParameter(
  collection: ParameterCollection,
  id: ParameterId,
): Parameter | undefined {
  return collection.parameters.find((p) => p.id === id);
}

/** Returns the parameter with the given name, or undefined. */
export function findParameterByName(
  collection: ParameterCollection,
  name: string,
): Parameter | undefined {
  return collection.parameters.find((p) => p.name === name);
}

function replaceParameter(
  collection: ParameterCollection,
  id: ParameterId,
  replace: (parameter: Parameter) => ParseResult<Parameter, ParameterError>,
): ParseResult<ParameterCollection, ParameterError> {
  const index = collection.parameters.findIndex((p) => p.id === id);
  if (index < 0) {
    return fail(
      parameterError(
        PARAMETER_ERROR_CODES.notFound,
        `No parameter with id "${id}" exists.`,
        id,
      ),
    );
  }
  const current = collection.parameters[index];
  if (current === undefined) {
    return fail(
      parameterError(
        PARAMETER_ERROR_CODES.notFound,
        `No parameter with id "${id}" exists.`,
        id,
      ),
    );
  }
  const updated = replace(current);
  if (!updated.ok) return updated;
  const parameters = [...collection.parameters];
  parameters[index] = updated.value;
  return ok(Object.freeze({ parameters: Object.freeze(parameters) }));
}

/**
 * Replaces the parameter's current value with a valid dimensional value.
 * The stored value is the cache of the last evaluation; recomputation is the
 * regeneration pipeline's concern.
 */
export function updateParameterValue(
  collection: ParameterCollection,
  id: ParameterId,
  value: AnyDimensionalValue,
): ParseResult<ParameterCollection, ParameterError> {
  return replaceParameter(collection, id, (parameter) => {
    const parsed = validateValue(value);
    if (!parsed.ok) return parsed;
    return ok(Object.freeze({ ...parameter, value: parsed.value }));
  });
}

/**
 * Sets or clears (null) the parameter's defining expression. Setting an
 * expression does not recompute the stored value and does not check for
 * reference cycles — use the parameter graph for that.
 */
export function updateParameterExpression(
  collection: ParameterCollection,
  id: ParameterId,
  expression: ExpressionNode | null,
): ParseResult<ParameterCollection, ParameterError> {
  return replaceParameter(collection, id, (parameter) => {
    const parsed = validateExpression(expression);
    if (!parsed.ok) return parsed;
    return ok(Object.freeze({ ...parameter, expression: parsed.value }));
  });
}

/** Replaces the parameter's metadata wholesale. */
export function updateParameterMetadata(
  collection: ParameterCollection,
  id: ParameterId,
  metadata: ParameterMetadata,
): ParseResult<ParameterCollection, ParameterError> {
  return replaceParameter(collection, id, (parameter) => {
    const parsed = validateMetadata(metadata);
    if (!parsed.ok) return parsed;
    return ok(Object.freeze({ ...parameter, metadata: parsed.value }));
  });
}

/** Canonical JSON form of a parameter; values serialize in canonical units. */
export interface SerializedParameter {
  readonly id: string;
  readonly name: string;
  readonly value: SerializedDimensionalValue;
  readonly expression: ExpressionNode | null;
  readonly metadata: ParameterMetadata;
}

/** Serializes a parameter to its canonical, deterministic JSON form. */
export function serializeParameter(parameter: Parameter): SerializedParameter {
  return {
    id: parameter.id,
    name: parameter.name,
    value: serializeDimensionalValue(parameter.value),
    expression: parameter.expression,
    metadata: parameter.metadata,
  };
}

/** Canonical JSON form of a parameter collection. */
export interface SerializedParameterCollection {
  readonly parameters: readonly SerializedParameter[];
}

/** Serializes a collection, preserving order. */
export function serializeParameterCollection(
  collection: ParameterCollection,
): SerializedParameterCollection {
  return {
    parameters: collection.parameters.map(serializeParameter),
  };
}

/**
 * Parses untrusted input (e.g. a parameter revived from persisted JSON) as a
 * {@link Parameter}. Known fields are validated strictly; unknown fields are
 * ignored so future format versions deserialize without data corruption.
 */
export function parseParameter(
  input: unknown,
): ParseResult<Parameter, ParameterError> {
  if (!isPlainRecord(input)) {
    return fail(
      parameterError(
        PARAMETER_ERROR_CODES.malformed,
        "A serialized parameter must be a plain object with id, name, and value fields.",
        input,
      ),
    );
  }
  return buildParameter(
    input.id,
    input.name,
    input.value,
    input.expression,
    input.metadata,
  );
}

/**
 * Parses untrusted input as a {@link ParameterCollection}, enforcing
 * duplicate-free ids and names, and returning an immutable collection in
 * the persisted order.
 */
export function parseParameterCollection(
  input: unknown,
): ParseResult<ParameterCollection, ParameterError> {
  if (!isPlainRecord(input) || !Array.isArray(input.parameters)) {
    return fail(
      parameterError(
        PARAMETER_ERROR_CODES.malformed,
        "A serialized parameter collection must be a plain object with a parameters array.",
        input,
      ),
    );
  }
  let collection: ParameterCollection = EMPTY_PARAMETER_COLLECTION;
  for (const entry of input.parameters) {
    const parsed = parseParameter(entry);
    if (!parsed.ok) return parsed;
    const added = addParameter(collection, parsed.value);
    if (!added.ok) return added;
    collection = added.value;
  }
  return ok(collection);
}

/**
 * An {@link ExpressionEnvironment} backed by the collection: parameter names
 * resolve to their current values. Resolution scans the collection (never a
 * prototype chain), so names like `__proto__` resolve to undefined.
 */
export function parameterEnvironment(
  collection: ParameterCollection,
): ExpressionEnvironment {
  return (name) => findParameterByName(collection, name)?.value;
}
