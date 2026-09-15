import { describe, expect, it } from "vitest";

import {
  add,
  addValues,
  angle,
  area,
  type AnyDimensionalValue,
  CONVERSION_TOLERANCE,
  convert,
  type DimensionalArithmeticFailure,
  DimensionalArithmeticValidationError,
  DIMENSIONAL_ERROR_CODES,
  type DimensionalOperation,
  dimensionless,
  DimensionalValueValidationError,
  divide,
  divideValues,
  equalQuantity,
  isDiagnosticCode,
  length,
  type LengthValue,
  multiply,
  multiplyValues,
  parseDimensionalValue,
  type ParseResult,
  serializeDimensionalValue,
  subtract,
  subtractValues,
  toCanonical,
  UNIT_ERROR_CODES,
  valueIn,
  volume,
} from "./index";

type DynamicOp = (
  left: AnyDimensionalValue,
  right: AnyDimensionalValue,
) => ParseResult<AnyDimensionalValue, DimensionalArithmeticFailure>;

function expectClose(actual: number, expected: number): void {
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(
    CONVERSION_TOLERANCE * Math.max(1, Math.abs(expected)),
  );
}

describe("dimensional constructors", () => {
  it("keeps the unit and magnitude it was given", () => {
    expect(length(25.4, "in")).toEqual({
      dimension: "length",
      unit: "in",
      value: 25.4,
    });
    expect(angle(90, "deg")).toEqual({
      dimension: "angle",
      unit: "deg",
      value: 90,
    });
    expect(area(2, "in2")).toEqual({
      dimension: "area",
      unit: "in2",
      value: 2,
    });
    expect(volume(1, "cm3")).toEqual({
      dimension: "volume",
      unit: "cm3",
      value: 1,
    });
    expect(length(-5)).toEqual({
      dimension: "length",
      unit: "mm",
      value: -5,
    });
  });

  it("defaults to the canonical unit of each dimension", () => {
    expect(length(10)).toEqual({ dimension: "length", unit: "mm", value: 10 });
    expect(angle(Math.PI)).toEqual({
      dimension: "angle",
      unit: "rad",
      value: Math.PI,
    });
    expect(area(5)).toEqual({ dimension: "area", unit: "mm2", value: 5 });
    expect(volume(2)).toEqual({ dimension: "volume", unit: "mm3", value: 2 });
    expect(dimensionless(3)).toEqual({
      dimension: "dimensionless",
      unit: "1",
      value: 3,
    });
  });

  it("rejects non-finite magnitudes", () => {
    for (const magnitude of [Number.NaN, Infinity, -Infinity]) {
      expect(() => length(magnitude)).toThrowError(
        DimensionalValueValidationError,
      );
      expect(() => angle(magnitude, "deg")).toThrowError(
        DimensionalValueValidationError,
      );
      expect(() => area(magnitude, "in2")).toThrowError(
        DimensionalValueValidationError,
      );
      expect(() => volume(magnitude)).toThrowError(
        DimensionalValueValidationError,
      );
      expect(() => dimensionless(magnitude)).toThrowError(
        DimensionalValueValidationError,
      );
    }
    let thrown: unknown;
    try {
      length(Number.NaN, "mm");
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(DimensionalValueValidationError);
    if (thrown instanceof DimensionalValueValidationError) {
      expect(thrown.error.code).toBe("value/non-finite-magnitude");
      expect(thrown.error.input).toBe(Number.NaN);
    }
  });
});

describe("unit conversion", () => {
  it("converts between length units correctly within tolerance", () => {
    expect(convert(length(1, "m"), "mm").value).toBe(1000);
    expect(convert(length(1, "cm"), "mm").value).toBe(10);
    expectClose(convert(length(1, "in"), "mm").value, 25.4);
    expectClose(convert(length(2.5, "in"), "mm").value, 63.5);
    expectClose(convert(length(1, "m"), "in").value, 1000 / 25.4);
  });

  it("converts between angle units correctly within tolerance", () => {
    expectClose(convert(angle(180, "deg"), "rad").value, Math.PI);
    expectClose(convert(angle(90, "deg"), "rad").value, Math.PI / 2);
    expectClose(convert(angle(1, "rad"), "deg").value, 180 / Math.PI);
  });

  it("converts between area and volume units correctly within tolerance", () => {
    expectClose(convert(area(1, "in2"), "mm2").value, 645.16);
    expectClose(convert(volume(1, "in3"), "mm3").value, 16387.064);
    expect(convert(area(2, "m2"), "mm2").value).toBe(2_000_000);
    expect(convert(volume(1, "m3"), "mm3").value).toBe(1_000_000_000);
    expect(convert(area(1, "cm2"), "mm2").value).toBe(100);
    expect(convert(volume(1, "cm3"), "mm3").value).toBe(1000);
  });

  it("keeps the dimension and target unit of a conversion", () => {
    const result = convert(length(1, "m"), "in");
    expect(result.dimension).toBe("length");
    expect(result.unit).toBe("in");
    expectClose(result.value, 1000 / 25.4);
  });

  it("round-trips every unit through the canonical unit", () => {
    for (const unit of ["mm", "cm", "m", "in"] as const) {
      expectClose(convert(convert(length(7, unit), "mm"), unit).value, 7);
    }
    expectClose(convert(convert(angle(1.5, "deg"), "rad"), "deg").value, 1.5);
    expectClose(convert(convert(area(3, "in2"), "mm2"), "in2").value, 3);
    expectClose(
      convert(convert(volume(0.5, "cm3"), "mm3"), "cm3").value,
      0.5,
    );
  });

  it("rejects units of another dimension at compile time and runtime", () => {
    expect(() =>
      // @ts-expect-error — "deg" is not a length unit
      convert(length(1), "deg"),
    ).toThrowError(DimensionalValueValidationError);
    expect(() =>
      // @ts-expect-error — "mm3" is not an angle unit
      valueIn(angle(1), "mm3"),
    ).toThrowError(DimensionalValueValidationError);
  });

  it("rejects conversions that overflow to a non-finite magnitude", () => {
    expect(() =>
      convert(length(Number.MAX_VALUE, "m"), "mm"),
    ).toThrowError(DimensionalValueValidationError);
  });
});

describe("same-dimension arithmetic", () => {
  it("adds lengths across units and returns the canonical unit", () => {
    const result = add(length(1, "m"), length(500, "mm"));
    expect(result.dimension).toBe("length");
    expect(result.unit).toBe("mm");
    expect(result.value).toBe(1500);
  });

  it("subtracts lengths across units", () => {
    const result = subtract(length(1, "m"), length(750, "mm"));
    expect(result.unit).toBe("mm");
    expect(result.value).toBe(250);
  });

  it("adds and subtracts angles, areas, volumes, and dimensionless values", () => {
    expect(add(angle(90, "deg"), angle(90, "deg")).unit).toBe("rad");
    expectClose(add(angle(90, "deg"), angle(90, "deg")).value, Math.PI);
    expect(subtract(area(1, "cm2"), area(50, "mm2")).value).toBe(50);
    expect(add(volume(1, "cm3"), volume(500, "mm3")).value).toBe(1500);
    expect(subtract(dimensionless(10), dimensionless(4)).value).toBe(6);
  });

  it("returns values that compose with further arithmetic", () => {
    const width = toCanonical(length(2, "m"));
    const total: LengthValue = add(width, length(1));
    expect(total.value).toBe(2001);
  });
});

describe("derived-dimension arithmetic", () => {
  it("multiplies two lengths into an area", () => {
    expect(multiply(length(10), length(10))).toEqual({
      dimension: "area",
      unit: "mm2",
      value: 100,
    });
  });

  it("multiplies an area and a length into a volume in either order", () => {
    expect(multiply(area(20), length(5))).toEqual({
      dimension: "volume",
      unit: "mm3",
      value: 100,
    });
    expect(multiply(length(5), area(20))).toEqual({
      dimension: "volume",
      unit: "mm3",
      value: 100,
    });
  });

  it("divides a length by a length into a dimensionless value", () => {
    expect(divide(length(2000), length(1, "m"))).toEqual({
      dimension: "dimensionless",
      unit: "1",
      value: 2,
    });
  });

  it("divides areas and volumes back down to simpler dimensions", () => {
    expect(divide(area(100), length(10))).toEqual({
      dimension: "length",
      unit: "mm",
      value: 10,
    });
    expect(divide(volume(1000), area(100))).toEqual({
      dimension: "length",
      unit: "mm",
      value: 10,
    });
    expect(divide(volume(1000), length(10))).toEqual({
      dimension: "area",
      unit: "mm2",
      value: 100,
    });
    expect(divide(area(4, "cm2"), area(1, "cm2")).value).toBe(4);
  });

  it("scales values with dimensionless factors", () => {
    expect(multiply(length(2, "m"), dimensionless(3))).toEqual({
      dimension: "length",
      unit: "mm",
      value: 6000,
    });
    expect(multiply(dimensionless(0.5), area(4, "cm2"))).toEqual({
      dimension: "area",
      unit: "mm2",
      value: 200,
    });
    expect(divide(length(3, "m"), dimensionless(4))).toEqual({
      dimension: "length",
      unit: "mm",
      value: 750,
    });
    expect(multiply(dimensionless(2), dimensionless(3)).value).toBe(6);
  });
});

describe("incompatible dimensional arithmetic", () => {
  it("rejects length + angle at compile time and falls back to a structured runtime error", () => {
    expect(() =>
      // @ts-expect-error — an angle cannot be added to a length
      add(length(1), angle(45, "deg")),
    ).toThrowError(DimensionalArithmeticValidationError);
  });

  it("rejects every mixed-dimension operation at compile time", () => {
    expect(() =>
      // @ts-expect-error — an angle cannot be subtracted from a length
      subtract(length(1), angle(1, "rad")),
    ).toThrowError(DimensionalArithmeticValidationError);
    expect(() =>
      // @ts-expect-error — a length cannot be multiplied by an angle
      multiply(length(1), angle(1, "rad")),
    ).toThrowError(DimensionalArithmeticValidationError);
    expect(() =>
      // @ts-expect-error — a length cannot be divided by an angle
      divide(length(1), angle(1, "rad")),
    ).toThrowError(DimensionalArithmeticValidationError);
  });

  it("reports incompatible dynamic operations with structured failures", () => {
    const cases: readonly {
      op: DynamicOp;
      operation: DimensionalOperation;
      left: AnyDimensionalValue;
      right: AnyDimensionalValue;
    }[] = [
      { op: addValues, operation: "add", left: length(1), right: angle(90, "deg") },
      { op: subtractValues, operation: "subtract", left: area(1), right: length(1) },
      { op: multiplyValues, operation: "multiply", left: length(1), right: angle(1, "rad") },
      { op: divideValues, operation: "divide", left: dimensionless(1), right: length(1) },
    ];
    for (const { op, operation, left, right } of cases) {
      const result = op(left, right);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("arithmetic/incompatible-dimensions");
        expect(result.error.operation).toBe(operation);
        expect(result.error.left).toBe(left.dimension);
        expect(result.error.right).toBe(right.dimension);
      }
    }
  });

  it("rejects derived dimensions outside the supported algebra", () => {
    for (const result of [
      multiplyValues(area(1), area(1)),
      multiplyValues(angle(1, "rad"), angle(1, "rad")),
      multiplyValues(volume(1), length(1)),
      divideValues(length(1), area(1)),
      divideValues(area(1), volume(1)),
      divideValues(dimensionless(1), angle(1, "rad")),
    ]) {
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("arithmetic/incompatible-dimensions");
      }
    }
  });

  it("rejects division by zero with a structured failure", () => {
    const result = divideValues(length(1, "m"), length(0));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("arithmetic/division-by-zero");
      expect(result.error.operation).toBe("divide");
    }
    expect(() => divide(length(1), length(0, "mm"))).toThrowError(
      DimensionalArithmeticValidationError,
    );
    expect(divideValues(dimensionless(1), dimensionless(0)).ok).toBe(false);
  });

  it("rejects arithmetic that overflows to a non-finite result", () => {
    const result = addValues(
      length(Number.MAX_VALUE, "m"),
      length(Number.MAX_VALUE, "m"),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("arithmetic/non-finite-result");
    }
  });
});

describe("numeric extraction and canonical form", () => {
  it("extracts magnitudes in any unit of the value's dimension", () => {
    expect(valueIn(length(1, "m"), "mm")).toBe(1000);
    expectClose(valueIn(angle(90, "deg"), "rad"), Math.PI / 2);
    expectClose(valueIn(volume(1, "cm3"), "m3"), 0.000001);
  });

  it("normalizes values to the canonical unit", () => {
    expect(toCanonical(length(1, "m"))).toEqual({
      dimension: "length",
      unit: "mm",
      value: 1000,
    });
    expect(toCanonical(angle(180, "deg")).unit).toBe("rad");
    expect(toCanonical(dimensionless(2))).toEqual(dimensionless(2));
  });
});

describe("quantity equality", () => {
  it("treats equal quantities in different units as equal", () => {
    expect(equalQuantity(length(1000), length(1, "m"))).toBe(true);
    expect(equalQuantity(angle(360, "deg"), angle(2 * Math.PI, "rad"))).toBe(
      true,
    );
    expect(equalQuantity(area(1, "in2"), area(645.16, "mm2"))).toBe(true);
  });

  it("distinguishes unequal quantities and different dimensions", () => {
    expect(equalQuantity(length(1), length(1, "m"))).toBe(false);
    expect(equalQuantity(length(1), angle(1, "rad"))).toBe(false);
    expect(equalQuantity(dimensionless(1), angle(1, "rad"))).toBe(false);
  });
});

describe("serialization", () => {
  it("serializes values in the canonical unit in a fixed key order", () => {
    expect(serializeDimensionalValue(length(1, "m"))).toEqual({
      dimension: "length",
      unit: "mm",
      value: 1000,
    });
    expect(serializeDimensionalValue(dimensionless(2.5))).toEqual({
      dimension: "dimensionless",
      unit: "1",
      value: 2.5,
    });
    const angleJson = serializeDimensionalValue(angle(180, "deg"));
    expect(angleJson.unit).toBe("rad");
    expectClose(angleJson.value, Math.PI);
  });

  it("serializes equal quantities to identical bytes", () => {
    expect(JSON.stringify(serializeDimensionalValue(length(1, "m")))).toBe(
      JSON.stringify(serializeDimensionalValue(length(1000, "mm"))),
    );
    expect(JSON.stringify(serializeDimensionalValue(volume(1, "cm3")))).toBe(
      JSON.stringify(serializeDimensionalValue(volume(1000, "mm3"))),
    );
  });

  it("round-trips value → JSON → value", () => {
    const samples: AnyDimensionalValue[] = [
      length(10),
      length(2.5, "in"),
      length(-3, "cm"),
      angle(45, "deg"),
      angle(1.25, "rad"),
      area(645.16),
      area(2, "in2"),
      volume(16387.064),
      volume(1, "cm3"),
      dimensionless(42),
      dimensionless(-0.5),
    ];
    for (const value of samples) {
      const json = JSON.stringify(serializeDimensionalValue(value));
      const revived = parseDimensionalValue(JSON.parse(json));
      expect(revived.ok).toBe(true);
      if (revived.ok) {
        expect(revived.value.dimension).toBe(value.dimension);
        expect(equalQuantity(revived.value, value)).toBe(true);
        expect(JSON.stringify(serializeDimensionalValue(revived.value))).toBe(
          json,
        );
      }
    }
  });

  it("parses any valid unit, not only canonical ones", () => {
    const parsed = parseDimensionalValue({
      dimension: "length",
      unit: "in",
      value: 2.5,
    });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value).toEqual(length(2.5, "in"));
    }
  });

  it("rejects invalid serialized input with stable codes", () => {
    const cases: readonly (readonly [unknown, string])[] = [
      [null, "value/not-a-record"],
      [42, "value/not-a-record"],
      ["length", "value/not-a-record"],
      [{}, "value/unknown-dimension"],
      [{ dimension: "mass", unit: "mm", value: 1 }, "value/unknown-dimension"],
      [{ dimension: "length" }, "unit/not-a-string"],
      [{ dimension: "length", unit: 5, value: 1 }, "unit/not-a-string"],
      [{ dimension: "length", unit: "km", value: 1 }, "unit/unknown"],
      [{ dimension: "length", unit: "deg", value: 1 }, "value/unit-dimension-mismatch"],
      [{ dimension: "angle", unit: "mm", value: 1 }, "value/unit-dimension-mismatch"],
      [{ dimension: "area", unit: "1", value: 1 }, "value/unit-dimension-mismatch"],
      [{ dimension: "volume", unit: "mm2", value: 1 }, "value/unit-dimension-mismatch"],
      [{ dimension: "dimensionless", unit: "mm", value: 1 }, "value/unit-dimension-mismatch"],
      [{ dimension: "length", unit: "mm" }, "value/invalid-magnitude"],
      [{ dimension: "length", unit: "mm", value: "10" }, "value/invalid-magnitude"],
      [{ dimension: "length", unit: "mm", value: Number.NaN }, "value/non-finite-magnitude"],
      [{ dimension: "volume", unit: "m3", value: Infinity }, "value/non-finite-magnitude"],
    ];
    for (const [input, code] of cases) {
      const result = parseDimensionalValue(input);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(code);
        expect(result.error.input).toBe(input);
      }
    }
  });
});

describe("diagnostics registry integration", () => {
  it("registers every unit and dimensional failure code", () => {
    for (const code of [
      ...Object.values(UNIT_ERROR_CODES),
      ...Object.values(DIMENSIONAL_ERROR_CODES),
    ]) {
      expect(isDiagnosticCode(code)).toBe(true);
    }
  });
});
