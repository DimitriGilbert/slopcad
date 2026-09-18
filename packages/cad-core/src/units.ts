/**
 * Dimension and unit registry for dimensional CAD values.
 *
 * Dimensions form a closed set (`length`, `angle`, `area`, `volume`,
 * `dimensionless`) and every dimension has one canonical unit used as the
 * internal representation and by arithmetic results and serialization:
 * millimetre (`mm`) for length, radian (`rad`) for angle, square millimetre
 * (`mm2`) for area, cubic millimetre (`mm3`) for volume, and unity (`1`) for
 * dimensionless values. Angle is deliberately modelled as its own dimension
 * so a length can never be combined with an angle by accident.
 *
 * Conversion factors to the canonical unit are exact decimal definitions —
 * `1 in = 25.4 mm` (international inch), `180 deg = π rad` — evaluated in
 * IEEE-754 double precision, so every conversion is correct within
 * {@link CONVERSION_TOLERANCE} relative error.
 */

import { type ParseResult, fail, ok } from "./result";

/** The dimensions a dimensional value can carry. */
export const DIMENSIONS = [
  "length",
  "angle",
  "area",
  "volume",
  "dimensionless",
] as const;

export type Dimension = (typeof DIMENSIONS)[number];

const DIMENSION_SET: ReadonlySet<string> = new Set(DIMENSIONS);

/** Type guard for untrusted dimension values. */
export function isDimension(input: unknown): input is Dimension {
  return typeof input === "string" && DIMENSION_SET.has(input);
}

/** Length units required by CAD workflows (`in` is the international inch). */
export const LENGTH_UNITS = ["mm", "cm", "m", "in"] as const;

export type LengthUnit = (typeof LENGTH_UNITS)[number];

/** Angle units required by CAD workflows. */
export const ANGLE_UNITS = ["deg", "rad"] as const;

export type AngleUnit = (typeof ANGLE_UNITS)[number];

/** Area units, derived from the length units (token `mm2` reads mm²). */
export const AREA_UNITS = ["mm2", "cm2", "m2", "in2"] as const;

export type AreaUnit = (typeof AREA_UNITS)[number];

/** Volume units, derived from the length units (token `mm3` reads mm³). */
export const VOLUME_UNITS = ["mm3", "cm3", "m3", "in3"] as const;

export type VolumeUnit = (typeof VOLUME_UNITS)[number];

/** Sole unit of the dimensionless dimension: unity. */
export const DIMENSIONLESS_UNIT = "1" as const;

export type DimensionlessUnit = typeof DIMENSIONLESS_UNIT;

/** Every unit token known to the registry. */
export type AnyUnit =
  LengthUnit | AngleUnit | AreaUnit | VolumeUnit | DimensionlessUnit;

/** The units of a given dimension. */
export type UnitOf<D extends Dimension> = D extends "length"
  ? LengthUnit
  : D extends "angle"
    ? AngleUnit
    : D extends "area"
      ? AreaUnit
      : D extends "volume"
        ? VolumeUnit
        : DimensionlessUnit;

/**
 * The canonical unit of each dimension — the internal representation every
 * arithmetic result uses and serialization emits.
 */
export const CANONICAL_UNITS = {
  length: "mm",
  angle: "rad",
  area: "mm2",
  volume: "mm3",
  dimensionless: DIMENSIONLESS_UNIT,
} as const satisfies Readonly<Record<Dimension, AnyUnit>>;

/**
 * Maximum relative error of any unit conversion, and the comparison
 * tolerance used for quantity equality. Conversions multiply by exact
 * decimal factors in double precision, so actual error stays many orders
 * of magnitude below this bound.
 */
export const CONVERSION_TOLERANCE = 1e-9;

/**
 * Exact decimal factors from each unit to the canonical unit of its
 * dimension: mm for length, rad for angle (`180 deg = π rad`), mm² for area,
 * and mm³ for volume (`1 in = 25.4 mm` exactly, so `1 in² = 645.16 mm²`).
 */
const FACTORS_TO_CANONICAL: Readonly<Record<AnyUnit, number>> = Object.freeze({
  mm: 1,
  cm: 10,
  m: 1000,
  in: 25.4,
  deg: Math.PI / 180,
  rad: 1,
  mm2: 1,
  cm2: 100,
  m2: 1_000_000,
  in2: 645.16,
  mm3: 1,
  cm3: 1000,
  m3: 1_000_000_000,
  in3: 16387.064,
  [DIMENSIONLESS_UNIT]: 1,
});

/**
 * Multiplication factor that converts a magnitude expressed in `unit` into
 * the canonical unit of its dimension.
 */
export function factorToCanonical(unit: AnyUnit): number {
  return FACTORS_TO_CANONICAL[unit];
}

const UNIT_DIMENSIONS: Readonly<Record<AnyUnit, Dimension>> = Object.freeze({
  mm: "length",
  cm: "length",
  m: "length",
  in: "length",
  deg: "angle",
  rad: "angle",
  mm2: "area",
  cm2: "area",
  m2: "area",
  in2: "area",
  mm3: "volume",
  cm3: "volume",
  m3: "volume",
  in3: "volume",
  [DIMENSIONLESS_UNIT]: "dimensionless",
});

/** The dimension a unit token measures. */
export function unitDimension(unit: AnyUnit): Dimension {
  return UNIT_DIMENSIONS[unit];
}

const UNIT_TOKEN_SET: ReadonlySet<string> = new Set(
  Object.keys(UNIT_DIMENSIONS),
);

/** Type guard for untrusted unit tokens. */
export function isUnitToken(input: unknown): input is AnyUnit {
  return typeof input === "string" && UNIT_TOKEN_SET.has(input);
}

const LENGTH_UNIT_SET: ReadonlySet<string> = new Set(LENGTH_UNITS);
const ANGLE_UNIT_SET: ReadonlySet<string> = new Set(ANGLE_UNITS);
const AREA_UNIT_SET: ReadonlySet<string> = new Set(AREA_UNITS);
const VOLUME_UNIT_SET: ReadonlySet<string> = new Set(VOLUME_UNITS);

/** Type guard narrowing a string to a {@link LengthUnit}. */
export function isLengthUnit(unit: string): unit is LengthUnit {
  return LENGTH_UNIT_SET.has(unit);
}

/** Type guard narrowing a string to an {@link AngleUnit}. */
export function isAngleUnit(unit: string): unit is AngleUnit {
  return ANGLE_UNIT_SET.has(unit);
}

/** Type guard narrowing a string to an {@link AreaUnit}. */
export function isAreaUnit(unit: string): unit is AreaUnit {
  return AREA_UNIT_SET.has(unit);
}

/** Type guard narrowing a string to a {@link VolumeUnit}. */
export function isVolumeUnit(unit: string): unit is VolumeUnit {
  return VOLUME_UNIT_SET.has(unit);
}

/** Stable failure codes produced when input is rejected as a unit. */
export const UNIT_ERROR_CODES = {
  notAString: "unit/not-a-string",
  unknown: "unit/unknown",
} as const;

export type UnitErrorCode =
  (typeof UNIT_ERROR_CODES)[keyof typeof UNIT_ERROR_CODES];

/** Structured failure describing why input was rejected as a unit. */
export interface UnitParseError {
  readonly code: UnitErrorCode;
  readonly message: string;
  readonly input: unknown;
}

function unitError(
  code: UnitErrorCode,
  message: string,
  input: unknown,
): UnitParseError {
  return { code, message, input };
}

/** A unit token together with the dimension it measures. */
export interface ParsedUnit {
  readonly unit: AnyUnit;
  readonly dimension: Dimension;
}

/**
 * Parses untrusted input as a unit token of any dimension, classifying it
 * by the registry. Use this at trust boundaries (persisted documents,
 * imported files, expression tokens) before constructing dimensional values.
 */
export function parseUnit(
  input: unknown,
): ParseResult<ParsedUnit, UnitParseError> {
  if (typeof input !== "string") {
    return fail(
      unitError(UNIT_ERROR_CODES.notAString, "A unit must be a string.", input),
    );
  }
  if (!isUnitToken(input)) {
    return fail(
      unitError(
        UNIT_ERROR_CODES.unknown,
        `Unknown unit "${input}"; expected one of: ${[...UNIT_TOKEN_SET].join(", ")}.`,
        input,
      ),
    );
  }
  return ok({ unit: input, dimension: unitDimension(input) });
}
