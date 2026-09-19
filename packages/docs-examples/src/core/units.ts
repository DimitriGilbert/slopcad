/**
 * The `units` guide's runnable example (docs/guides/units.md): the
 * dimensional-value surface — building length/angle/volume values in
 * whatever unit the author wrote, converting between units, parsing the
 * serialized wire form (the `{dimension, unit, value}` record) and the
 * author-facing string form (the expression engine's unit literals:
 * `"0.5in"`), and the arithmetic that keeps dimensions honest
 * (`mm + mm` stays length, `mm × mm` is area).
 */

import {
  angle,
  area,
  convert,
  divide,
  EMPTY_PARAMETER_COLLECTION,
  evaluateExpression,
  length,
  multiply,
  parameterEnvironment,
  parseDimensionalValue,
  parseExpression,
  serializeDimensionalValue,
  valueIn,
  volume,
} from "@slopcad/cad-core";

/** What the example reports back to the guide and the docs page. */
export interface UnitsExampleSummary {
  readonly inchInMm: number;
  readonly degreeInRadian: number;
  readonly parsedMm: number;
  readonly parsedInchCanonicalMm: number;
  readonly parsedAngleCanonicalRad: number;
  readonly expressionLiteralMm: number;
  readonly serializedRoundTrip: string;
  readonly boxVolumeMm3: number;
  readonly boxVolumeInIn3: number;
  readonly lengthOverLength: number;
}

/** The facts the units guide states, computed by the real API. */
export function runUnitsExample(): UnitsExampleSummary {
  // Values are built in the author's unit and carry their dimension; the
  // magnitude stays in the author's unit until a reader converts it.
  const plateWidth = length(2, "in");
  const plateDepth = length(40);
  const plateHeight = length(5);

  // `valueIn` reads a value in any unit of its dimension.
  const inchInMm = valueIn(length(1, "in"), "mm");
  const degreeInRadian = valueIn(angle(1, "deg"), "rad");

  // The serialized wire form: the `{dimension, unit, value}` record a
  // parameter or worker message carries.
  const parsed = parseDimensionalValue({
    dimension: "length",
    unit: "mm",
    value: 12.5,
  });
  if (!parsed.ok) {
    throw new Error(`Parsing the mm record failed: ${parsed.error.message}`);
  }
  const parsedInch = parseDimensionalValue({
    dimension: "length",
    unit: "in",
    value: 0.5,
  });
  if (!parsedInch.ok) {
    throw new Error(
      `Parsing the inch record failed: ${parsedInch.error.message}`,
    );
  }
  const parsedAngle = parseDimensionalValue({
    dimension: "angle",
    unit: "deg",
    value: 30,
  });
  if (!parsedAngle.ok) {
    throw new Error(
      `Parsing the deg record failed: ${parsedAngle.error.message}`,
    );
  }

  // The author-facing string form is the expression engine's unit
  // literals — the same syntax a parameter expression accepts.
  const expression = parseExpression("0.5in");
  if (!expression.ok) {
    throw new Error(
      `Parsing the unit literal failed: ${expression.error.message}`,
    );
  }
  const evaluated = evaluateExpression(
    expression.value,
    parameterEnvironment(EMPTY_PARAMETER_COLLECTION),
  );
  if (!evaluated.ok) {
    throw new Error(
      `Evaluating the unit literal failed: ${evaluated.error.message}`,
    );
  }
  const literalMm = valueIn(evaluated.value, "mm");

  // Serialization normalizes to the canonical unit: same value in, same
  // triple out, every call.
  const serialized = serializeDimensionalValue(parsed.value);

  // Dimensioned arithmetic: multiply three lengths step by step —
  // length × length is area, area × length is volume. Operands convert
  // to canonical units, so the inch-wide plate participates directly.
  const footprint = multiply(plateWidth, plateDepth);
  const footprintDimension: string = footprint.dimension;
  if (footprintDimension !== "area") {
    throw new Error(
      `length × length should be area, got ${footprintDimension}`,
    );
  }
  const boxVolume = multiply(area(footprint.value, "mm2"), plateHeight);
  const volumeDimension: string = boxVolume.dimension;
  if (volumeDimension !== "volume") {
    throw new Error(`area × length should be volume, got ${volumeDimension}`);
  }

  // Dividing a length by a length yields a dimensionless number.
  const ratio = divide(plateDepth, plateHeight);

  return {
    inchInMm,
    degreeInRadian,
    parsedMm: parsed.value.value,
    parsedInchCanonicalMm: valueIn(parsedInch.value, "mm"),
    parsedAngleCanonicalRad: valueIn(parsedAngle.value, "rad"),
    expressionLiteralMm: literalMm,
    serializedRoundTrip: `${String(serialized.value)} ${serialized.unit}`,
    boxVolumeMm3: boxVolume.value,
    boxVolumeInIn3: valueIn(convert(volume(boxVolume.value), "in3"), "in3"),
    lengthOverLength: ratio.value,
  };
}
