/**
 * Typed dimensional values: quantities that pair a magnitude with a
 * dimension and unit from {@link ./units}.
 *
 * A value is an immutable record `{ dimension, unit, value }` where `value`
 * is the magnitude expressed in `unit`. All arithmetic converts operands to
 * the canonical unit of their dimension (mm, rad, mm2, mm3, unity) and
 * returns results in the canonical unit, so numerics are deterministic and
 * unit-independent.
 *
 * Dimensional correctness is enforced twice: statically, through per-
 * dimension types and per-combination overloads (`length + angle` does not
 * compile), and dynamically, because every operation re-validates at runtime
 * and reports structured failures with stable `arithmetic/*` codes — never
 * silent coercion, `NaN`, or `Infinity` leakage. Dynamic paths where the
 * dimension is not statically known (parsed documents, parameter lookups)
 * use the `*Values` variants, which return a {@link ParseResult} instead of
 * throwing. Serialization is canonical: equal quantities always serialize to
 * identical bytes, and parsing accepts any valid unit of the dimension.
 *
 * Expressions and parameters (Phase 5) build directly on this module:
 * `value.dimension`/`unitDimension` inspect the dimension, `valueIn`
 * extracts magnitudes, and `toCanonical` normalizes before storage.
 */

import { type ParseFailure, type ParseResult, fail, ok } from "./result";
import {
  type AngleUnit,
  type AnyUnit,
  type AreaUnit,
  CANONICAL_UNITS,
  CONVERSION_TOLERANCE,
  type Dimension,
  DIMENSIONLESS_UNIT,
  DIMENSIONS,
  factorToCanonical,
  isAngleUnit,
  isAreaUnit,
  isDimension,
  isLengthUnit,
  isUnitToken,
  isVolumeUnit,
  type LengthUnit,
  type UnitOf,
  unitDimension,
  UNIT_ERROR_CODES,
  type VolumeUnit,
} from "./units";

/**
 * Stable failure codes produced when input is rejected as a dimensional
 * value or an operation is rejected as dimensionally invalid. The `unit/*`
 * entries share the unit registry's codes so one failure domain covers a
 * unit rejected anywhere.
 */
export const DIMENSIONAL_ERROR_CODES = {
  notARecord: "value/not-a-record",
  unknownDimension: "value/unknown-dimension",
  unitNotAString: UNIT_ERROR_CODES.notAString,
  unitUnknown: UNIT_ERROR_CODES.unknown,
  unitDimensionMismatch: "value/unit-dimension-mismatch",
  invalidMagnitude: "value/invalid-magnitude",
  nonFiniteMagnitude: "value/non-finite-magnitude",
  incompatibleDimensions: "arithmetic/incompatible-dimensions",
  divisionByZero: "arithmetic/division-by-zero",
  nonFiniteResult: "arithmetic/non-finite-result",
} as const;

export type DimensionalErrorCode =
  (typeof DIMENSIONAL_ERROR_CODES)[keyof typeof DIMENSIONAL_ERROR_CODES];

/** Structured failure describing why input was rejected as a dimensional value. */
export interface DimensionalParseError extends ParseFailure {
  readonly code: DimensionalErrorCode;
}

/** The four binary dimensional operations. */
export type DimensionalOperation = "add" | "subtract" | "multiply" | "divide";

/** Structured failure describing why a dimensional operation was rejected. */
export interface DimensionalArithmeticFailure extends ParseFailure {
  readonly code:
    | "arithmetic/incompatible-dimensions"
    | "arithmetic/division-by-zero"
    | "arithmetic/non-finite-result";
  /** The operation that was rejected. */
  readonly operation: DimensionalOperation;
  /** The dimension of the left operand. */
  readonly left: Dimension;
  /** The dimension of the right operand. */
  readonly right: Dimension;
}

/** A magnitude of dimension `D` expressed in a unit of that dimension. */
export interface DimensionalValue<D extends Dimension = Dimension> {
  readonly dimension: D;
  readonly unit: UnitOf<D>;
  readonly value: number;
}

/** A length value (e.g. `length(25.4, "in")`). */
export type LengthValue = DimensionalValue<"length">;
/** An angle value (e.g. `angle(90, "deg")`). */
export type AngleValue = DimensionalValue<"angle">;
/** An area value (e.g. `area(645.16, "mm2")`). */
export type AreaValue = DimensionalValue<"area">;
/** A volume value (e.g. `volume(1, "cm3")`). */
export type VolumeValue = DimensionalValue<"volume">;
/** A dimensionless value (e.g. `dimensionless(42)`). */
export type DimensionlessValue = DimensionalValue<"dimensionless">;

/** Union of every dimensionally typed value; the dynamic-path operand type. */
export type AnyDimensionalValue = DimensionalValue<Dimension>;

/** Thrown by the constructors and converters on invalid magnitude or unit input. */
export class DimensionalValueValidationError extends Error {
  readonly error: DimensionalParseError;

  constructor(error: DimensionalParseError) {
    super(error.message);
    this.name = "DimensionalValueValidationError";
    this.error = error;
  }
}

/** Thrown by the typed arithmetic helpers when a runtime guard trips. */
export class DimensionalArithmeticValidationError extends Error {
  readonly error: DimensionalArithmeticFailure;

  constructor(error: DimensionalArithmeticFailure) {
    super(error.message);
    this.name = "DimensionalArithmeticValidationError";
    this.error = error;
  }
}

function valueError(
  code: DimensionalErrorCode,
  message: string,
  input: unknown,
): DimensionalParseError {
  return { code, message, input };
}

function frozenQuantity<D extends Dimension>(
  dimension: D,
  unit: UnitOf<D>,
  value: number,
): DimensionalValue<D> {
  return Object.freeze({ dimension, unit, value });
}

function requireFiniteMagnitude(magnitude: number): void {
  if (!Number.isFinite(magnitude)) {
    throw new DimensionalValueValidationError(
      valueError(
        DIMENSIONAL_ERROR_CODES.nonFiniteMagnitude,
        `A dimensional value magnitude must be a finite number, received ${String(magnitude)}.`,
        magnitude,
      ),
    );
  }
}

/** Creates a length of `value` `unit` (default `mm`). */
export function length(
  value: number,
  unit: LengthUnit = CANONICAL_UNITS.length,
): LengthValue {
  requireFiniteMagnitude(value);
  return frozenQuantity("length", unit, value);
}

/** Creates an angle of `value` `unit` (default `rad`). */
export function angle(
  value: number,
  unit: AngleUnit = CANONICAL_UNITS.angle,
): AngleValue {
  requireFiniteMagnitude(value);
  return frozenQuantity("angle", unit, value);
}

/** Creates an area of `value` `unit` (default `mm2`). */
export function area(
  value: number,
  unit: AreaUnit = CANONICAL_UNITS.area,
): AreaValue {
  requireFiniteMagnitude(value);
  return frozenQuantity("area", unit, value);
}

/** Creates a volume of `value` `unit` (default `mm3`). */
export function volume(
  value: number,
  unit: VolumeUnit = CANONICAL_UNITS.volume,
): VolumeValue {
  requireFiniteMagnitude(value);
  return frozenQuantity("volume", unit, value);
}

/** Creates a dimensionless value of `value` (unit is always unity). */
export function dimensionless(value: number): DimensionlessValue {
  requireFiniteMagnitude(value);
  return frozenQuantity("dimensionless", DIMENSIONLESS_UNIT, value);
}

/** The magnitude of `value` expressed in the canonical unit of its dimension. */
function canonicalMagnitude(value: AnyDimensionalValue): number {
  return value.value * factorToCanonical(value.unit);
}

function convertedMagnitude(value: AnyDimensionalValue, unit: AnyUnit): number {
  return (
    (value.value * factorToCanonical(value.unit)) / factorToCanonical(unit)
  );
}

function requireUnitOfDimension(
  value: AnyDimensionalValue,
  unit: AnyUnit,
): void {
  if (unitDimension(unit) !== value.dimension) {
    throw new DimensionalValueValidationError(
      valueError(
        DIMENSIONAL_ERROR_CODES.unitDimensionMismatch,
        `Unit "${unit}" does not measure dimension "${value.dimension}".`,
        unit,
      ),
    );
  }
}

/**
 * Converts a value into another unit of the same dimension. The dimension
 * never changes; a unit of another dimension is a compile-time error and a
 * runtime structured error.
 */
export function convert<D extends Dimension>(
  value: DimensionalValue<D>,
  unit: UnitOf<D>,
): DimensionalValue<D> {
  requireUnitOfDimension(value, unit);
  const magnitude = convertedMagnitude(value, unit);
  requireFiniteMagnitude(magnitude);
  return frozenQuantity(value.dimension, unit, magnitude);
}

/**
 * Extracts the magnitude of `value` expressed in `unit`, without building a
 * new value — the primary numeric-extraction path for expressions and
 * parameters. A unit of another dimension is a compile-time error and a
 * runtime structured error.
 */
export function valueIn<D extends Dimension>(
  value: DimensionalValue<D>,
  unit: UnitOf<D>,
): number {
  requireUnitOfDimension(value, unit);
  const magnitude = convertedMagnitude(value, unit);
  requireFiniteMagnitude(magnitude);
  return magnitude;
}

/** Normalizes a value to the canonical unit of its dimension, preserving its dimension type. */
export function toCanonical(value: LengthValue): LengthValue;
export function toCanonical(value: AngleValue): AngleValue;
export function toCanonical(value: AreaValue): AreaValue;
export function toCanonical(value: VolumeValue): VolumeValue;
export function toCanonical(value: DimensionlessValue): DimensionlessValue;
export function toCanonical(value: AnyDimensionalValue): AnyDimensionalValue;
export function toCanonical(value: AnyDimensionalValue): AnyDimensionalValue {
  return convert(value, CANONICAL_UNITS[value.dimension]);
}

/**
 * Compares two values as physical quantities: same dimension and magnitudes
 * equal within {@link CONVERSION_TOLERANCE} once converted to their
 * canonical unit. Values of different dimensions are never equal.
 */
export function equalQuantity(
  a: AnyDimensionalValue,
  b: AnyDimensionalValue,
): boolean {
  if (a.dimension !== b.dimension) return false;
  const left = canonicalMagnitude(a);
  const right = canonicalMagnitude(b);
  return (
    Math.abs(left - right) <=
    CONVERSION_TOLERANCE * Math.max(1, Math.abs(left), Math.abs(right))
  );
}

/**
 * The result dimension of a product, or `null` when the closed dimension
 * algebra has no representation for it. Supported products: scaling by a
 * dimensionless value, `length × length → area`, and
 * `area/length × length → volume`.
 */
function productDimension(a: Dimension, b: Dimension): Dimension | null {
  if (a === "dimensionless") return b;
  if (b === "dimensionless") return a;
  if (a === "length" && b === "length") return "area";
  if (a === "length" && b === "area") return "volume";
  if (a === "area" && b === "length") return "volume";
  return null;
}

/**
 * The result dimension of a quotient, or `null` when unsupported.
 * Supported quotients: dividing by a dimensionless value, same-dimension
 * division to a dimensionless ratio, and `area/length → length`,
 * `volume/length → area`, `volume/area → length`.
 */
function quotientDimension(a: Dimension, b: Dimension): Dimension | null {
  if (b === "dimensionless") return a;
  if (a === b) return "dimensionless";
  if (a === "area" && b === "length") return "length";
  if (a === "volume" && b === "length") return "area";
  if (a === "volume" && b === "area") return "length";
  return null;
}

function operate(
  operation: DimensionalOperation,
  a: AnyDimensionalValue,
  b: AnyDimensionalValue,
  resultDimension: Dimension | null,
  combine: (left: number, right: number) => number,
): ParseResult<AnyDimensionalValue, DimensionalArithmeticFailure> {
  const operands = { left: a, right: b };
  const rejected = (
    code: DimensionalArithmeticFailure["code"],
    message: string,
  ): ParseResult<AnyDimensionalValue, DimensionalArithmeticFailure> =>
    fail({
      code,
      message,
      input: operands,
      operation,
      left: a.dimension,
      right: b.dimension,
    });
  if (resultDimension === null) {
    return rejected(
      DIMENSIONAL_ERROR_CODES.incompatibleDimensions,
      `Cannot ${operation} a ${a.dimension} value with a ${b.dimension} value: the dimension algebra has no result dimension for that combination.`,
    );
  }
  if (operation === "divide" && canonicalMagnitude(b) === 0) {
    return rejected(
      DIMENSIONAL_ERROR_CODES.divisionByZero,
      `Cannot divide by a ${b.dimension} value of zero magnitude.`,
    );
  }
  const magnitude = combine(canonicalMagnitude(a), canonicalMagnitude(b));
  if (!Number.isFinite(magnitude)) {
    return rejected(
      DIMENSIONAL_ERROR_CODES.nonFiniteResult,
      `The ${operation} of the given operands overflows to a non-finite magnitude.`,
    );
  }
  return ok(canonicalQuantity(resultDimension, magnitude));
}

/** Builds a value of `dimension` whose magnitude is already canonical. */
function canonicalQuantity(
  dimension: Dimension,
  magnitude: number,
): AnyDimensionalValue {
  switch (dimension) {
    case "length":
      return length(magnitude);
    case "angle":
      return angle(magnitude);
    case "area":
      return area(magnitude);
    case "volume":
      return volume(magnitude);
    case "dimensionless":
      return dimensionless(magnitude);
  }
}

/**
 * Adds two values of any dimensions, reporting dimension mismatches as
 * structured failures. Use {@link add} when the dimensions are statically
 * known.
 */
export function addValues(
  a: AnyDimensionalValue,
  b: AnyDimensionalValue,
): ParseResult<AnyDimensionalValue, DimensionalArithmeticFailure> {
  return operate(
    "add",
    a,
    b,
    a.dimension === b.dimension ? a.dimension : null,
    (left, right) => left + right,
  );
}

/**
 * Subtracts two values of any dimensions, reporting dimension mismatches as
 * structured failures. Use {@link subtract} when the dimensions are
 * statically known.
 */
export function subtractValues(
  a: AnyDimensionalValue,
  b: AnyDimensionalValue,
): ParseResult<AnyDimensionalValue, DimensionalArithmeticFailure> {
  return operate(
    "subtract",
    a,
    b,
    a.dimension === b.dimension ? a.dimension : null,
    (left, right) => left - right,
  );
}

/**
 * Multiplies two values, deriving the result dimension
 * (`length × length → area`, `area × length → volume`, dimensionless
 * scaling). Combinations outside the dimension algebra fail with
 * `arithmetic/incompatible-dimensions`.
 */
export function multiplyValues(
  a: AnyDimensionalValue,
  b: AnyDimensionalValue,
): ParseResult<AnyDimensionalValue, DimensionalArithmeticFailure> {
  return operate(
    "multiply",
    a,
    b,
    productDimension(a.dimension, b.dimension),
    (left, right) => left * right,
  );
}

/**
 * Divides two values, deriving the result dimension (`length / length →
 * dimensionless`, `area / length → length`, `volume / area → length`).
 * Division by a zero-magnitude divisor fails with
 * `arithmetic/division-by-zero`.
 */
export function divideValues(
  a: AnyDimensionalValue,
  b: AnyDimensionalValue,
): ParseResult<AnyDimensionalValue, DimensionalArithmeticFailure> {
  return operate(
    "divide",
    a,
    b,
    quotientDimension(a.dimension, b.dimension),
    (left, right) => left / right,
  );
}

function unwrap(
  result: ParseResult<AnyDimensionalValue, DimensionalArithmeticFailure>,
): AnyDimensionalValue {
  if (!result.ok) throw new DimensionalArithmeticValidationError(result.error);
  return result.value;
}

/**
 * Adds two values of the same dimension. Mixed dimensions are a compile-time
 * error; if that guard is bypassed, a structured runtime error is thrown.
 */
export function add(a: LengthValue, b: LengthValue): LengthValue;
export function add(a: AngleValue, b: AngleValue): AngleValue;
export function add(a: AreaValue, b: AreaValue): AreaValue;
export function add(a: VolumeValue, b: VolumeValue): VolumeValue;
export function add(
  a: DimensionlessValue,
  b: DimensionlessValue,
): DimensionlessValue;
export function add(
  a: AnyDimensionalValue,
  b: AnyDimensionalValue,
): AnyDimensionalValue {
  return unwrap(addValues(a, b));
}

/**
 * Subtracts two values of the same dimension. Mixed dimensions are a
 * compile-time error; if that guard is bypassed, a structured runtime error
 * is thrown.
 */
export function subtract(a: LengthValue, b: LengthValue): LengthValue;
export function subtract(a: AngleValue, b: AngleValue): AngleValue;
export function subtract(a: AreaValue, b: AreaValue): AreaValue;
export function subtract(a: VolumeValue, b: VolumeValue): VolumeValue;
export function subtract(
  a: DimensionlessValue,
  b: DimensionlessValue,
): DimensionlessValue;
export function subtract(
  a: AnyDimensionalValue,
  b: AnyDimensionalValue,
): AnyDimensionalValue {
  return unwrap(subtractValues(a, b));
}

/**
 * Multiplies two values into the derived dimension (`length × length →
 * area`, `area × length → volume`, dimensionless scaling stays in the
 * dimension). Unsupported products are a compile-time error; if that guard
 * is bypassed, a structured runtime error is thrown.
 */
export function multiply(a: LengthValue, b: LengthValue): AreaValue;
export function multiply(a: AreaValue, b: LengthValue): VolumeValue;
export function multiply(a: LengthValue, b: AreaValue): VolumeValue;
export function multiply<D extends Dimension>(
  a: DimensionalValue<D>,
  b: DimensionlessValue,
): DimensionalValue<D>;
export function multiply<D extends Dimension>(
  a: DimensionlessValue,
  b: DimensionalValue<D>,
): DimensionalValue<D>;
export function multiply(
  a: AnyDimensionalValue,
  b: AnyDimensionalValue,
): AnyDimensionalValue {
  return unwrap(multiplyValues(a, b));
}

/**
 * Divides two values into the derived dimension (`length / length →
 * dimensionless`, `area / length → length`, `volume / area → length`,
 * dividing by a dimensionless value stays in the dimension). Unsupported
 * quotients are a compile-time error; a zero-magnitude divisor throws a
 * structured runtime error, as does a bypassed dimension guard.
 */
export function divide(a: LengthValue, b: LengthValue): DimensionlessValue;
export function divide(a: AngleValue, b: AngleValue): DimensionlessValue;
export function divide(a: AreaValue, b: AreaValue): DimensionlessValue;
export function divide(a: VolumeValue, b: VolumeValue): DimensionlessValue;
export function divide(a: AreaValue, b: LengthValue): LengthValue;
export function divide(a: VolumeValue, b: LengthValue): AreaValue;
export function divide(a: VolumeValue, b: AreaValue): LengthValue;
export function divide<D extends Dimension>(
  a: DimensionalValue<D>,
  b: DimensionlessValue,
): DimensionalValue<D>;
export function divide(
  a: AnyDimensionalValue,
  b: AnyDimensionalValue,
): AnyDimensionalValue {
  return unwrap(divideValues(a, b));
}

/**
 * Canonical, deterministic JSON form of a dimensional value. Serialization
 * always emits the canonical unit and the canonical magnitude in the fixed
 * key order `dimension`, `unit`, `value`, so two equal quantities always
 * produce identical bytes regardless of the units they were built with.
 * Parsing ({@link parseDimensionalValue}) accepts any valid unit of the
 * dimension, not only canonical ones.
 */
export interface SerializedDimensionalValue {
  readonly dimension: Dimension;
  readonly unit: AnyUnit;
  readonly value: number;
}

/** Serializes a value to its canonical JSON form. */
export function serializeDimensionalValue(
  value: AnyDimensionalValue,
): SerializedDimensionalValue {
  const canonical = toCanonical(value);
  return {
    dimension: canonical.dimension,
    unit: canonical.unit,
    value: canonical.value,
  };
}

function isPlainRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}

/** Builds a value from already-validated fields, or `undefined` when the unit does not measure the dimension. */
function constructValue(
  dimension: Dimension,
  magnitude: number,
  unit: AnyUnit,
): AnyDimensionalValue | undefined {
  switch (dimension) {
    case "length":
      return isLengthUnit(unit) ? length(magnitude, unit) : undefined;
    case "angle":
      return isAngleUnit(unit) ? angle(magnitude, unit) : undefined;
    case "area":
      return isAreaUnit(unit) ? area(magnitude, unit) : undefined;
    case "volume":
      return isVolumeUnit(unit) ? volume(magnitude, unit) : undefined;
    case "dimensionless":
      return unit === DIMENSIONLESS_UNIT ? dimensionless(magnitude) : undefined;
  }
}

/**
 * Parses untrusted input (e.g. a dimensional value revived from persisted
 * JSON) as an {@link AnyDimensionalValue}. Every field is validated
 * strictly with a stable failure code; unknown extra fields are ignored so
 * future format versions deserialize without data corruption.
 */
export function parseDimensionalValue(
  input: unknown,
): ParseResult<AnyDimensionalValue, DimensionalParseError> {
  if (!isPlainRecord(input)) {
    return fail(
      valueError(
        DIMENSIONAL_ERROR_CODES.notARecord,
        "A serialized dimensional value must be a plain object with dimension, unit, and value fields.",
        input,
      ),
    );
  }
  const { dimension, unit, value } = input;
  if (!isDimension(dimension)) {
    return fail(
      valueError(
        DIMENSIONAL_ERROR_CODES.unknownDimension,
        `A dimensional value dimension must be one of: ${DIMENSIONS.join(", ")}.`,
        input,
      ),
    );
  }
  if (typeof unit !== "string") {
    return fail(
      valueError(
        DIMENSIONAL_ERROR_CODES.unitNotAString,
        "A dimensional value unit must be a string.",
        input,
      ),
    );
  }
  if (!isUnitToken(unit)) {
    return fail(
      valueError(
        DIMENSIONAL_ERROR_CODES.unitUnknown,
        `Unknown unit "${unit}".`,
        input,
      ),
    );
  }
  if (typeof value !== "number") {
    return fail(
      valueError(
        DIMENSIONAL_ERROR_CODES.invalidMagnitude,
        "A dimensional value magnitude must be a number.",
        input,
      ),
    );
  }
  if (!Number.isFinite(value)) {
    return fail(
      valueError(
        DIMENSIONAL_ERROR_CODES.nonFiniteMagnitude,
        `A dimensional value magnitude must be a finite number, received ${String(value)}.`,
        input,
      ),
    );
  }
  const constructed = constructValue(dimension, value, unit);
  if (constructed === undefined) {
    return fail(
      valueError(
        DIMENSIONAL_ERROR_CODES.unitDimensionMismatch,
        `Unit "${unit}" does not measure dimension "${dimension}".`,
        input,
      ),
    );
  }
  return ok(constructed);
}
