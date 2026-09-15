import { describe, expect, it } from "vitest";

import {
  type AnyDimensionalValue,
  angle,
  area,
  CONVERSION_TOLERANCE,
  dimensionless,
  evaluateExpression,
  EXPRESSION_EVALUATION_ERROR_CODES,
  type ExpressionEnvironment,
  length,
  parseExpression,
  volume,
} from "./index";

const noParameters: ExpressionEnvironment = () => undefined;

function environmentOf(
  values: Readonly<Record<string, AnyDimensionalValue>>,
): ExpressionEnvironment {
  return (name) => values[name];
}

function evaluate(
  source: string,
  resolve: ExpressionEnvironment = noParameters,
): AnyDimensionalValue {
  const parsed = parseExpression(source);
  expect(parsed.ok).toBe(true);
  if (!parsed.ok) throw new Error(`parse failed for ${source}`);
  const result = evaluateExpression(parsed.value, resolve);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

function expectFailure(
  source: string,
  code: string,
  resolve: ExpressionEnvironment = noParameters,
): void {
  const parsed = parseExpression(source);
  expect(parsed.ok).toBe(true);
  if (!parsed.ok) return;
  const result = evaluateExpression(parsed.value, resolve);
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.error.code).toBe(code);
  expect(result.error.message.length).toBeGreaterThan(0);
}

function expectClose(actual: number, expected: number): void {
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(
    CONVERSION_TOLERANCE * Math.max(1, Math.abs(expected)),
  );
}

describe("evaluateExpression literals and identifiers", () => {
  it("evaluates number literals as dimensionless", () => {
    expect(evaluate("42")).toEqual(dimensionless(42));
    expect(evaluate("2.5")).toEqual(dimensionless(2.5));
  });

  it("evaluates unit literals as canonical quantities", () => {
    expect(evaluate("10mm")).toEqual(length(10));
    expect(evaluate("2.5in")).toEqual(length(63.5));
    const rightAngle = evaluate("90deg");
    expect(rightAngle.dimension).toBe("angle");
    expectClose(rightAngle.value, Math.PI / 2);
    expect(evaluate("100mm2")).toEqual(area(100));
    expect(evaluate("2cm3")).toEqual(volume(2000));
  });

  it("resolves identifiers through the environment", () => {
    const width = length(2.5, "in");
    expect(evaluate("width", environmentOf({ width }))).toEqual(width);
    expect(evaluate("width * 2", environmentOf({ width }))).toEqual(
      length(127),
    );
  });

  it("rejects unknown identifiers", () => {
    expectFailure(
      "height * 2",
      EXPRESSION_EVALUATION_ERROR_CODES.unknownIdentifier,
      environmentOf({ width: length(10) }),
    );
  });
});

describe("evaluateExpression arithmetic", () => {
  it("adds and subtracts same-dimension values", () => {
    expect(evaluate("10mm + 5mm")).toEqual(length(15));
    expect(evaluate("2.5in + 1cm")).toEqual(length(73.5));
    expect(evaluate("10mm - 3cm")).toEqual(length(-20));
    const summed = evaluate("45deg + 45deg");
    expectClose(summed.value, Math.PI / 2);
  });

  it("multiplies through the dimension algebra", () => {
    expect(evaluate("10mm * 10mm")).toEqual(area(100));
    expect(evaluate("2 * 3mm")).toEqual(length(6));
    expect(evaluate("3mm * 2")).toEqual(length(6));
    expect(evaluate("10mm2 * 5mm")).toEqual(volume(50));
  });

  it("divides through the dimension algebra", () => {
    expect(evaluate("100mm2 / 10mm")).toEqual(length(10));
    expect(evaluate("10mm / 2")).toEqual(length(5));
    expect(evaluate("10mm / 100mm")).toEqual(dimensionless(0.1));
  });

  it("negates any dimension", () => {
    expect(evaluate("-(10mm - 3cm)")).toEqual(length(20));
    expect(evaluate("-5mm")).toEqual(length(-5));
    expect(evaluate("--5")).toEqual(dimensionless(5));
  });

  it("combines operators with correct grouping", () => {
    expect(evaluate("(10mm + 5mm) * 2")).toEqual(length(30));
    expect(evaluate("10mm + 5mm * 2")).toEqual(length(20));
    expect(evaluate("100mm2 / 10mm - 1mm")).toEqual(length(9));
  });

  it("rejects dimensionally invalid operations with the arithmetic codes", () => {
    expectFailure(
      "10mm + 45deg",
      "arithmetic/incompatible-dimensions",
    );
    expectFailure(
      "10mm * 45deg",
      "arithmetic/incompatible-dimensions",
    );
    expectFailure("10mm / 0", "arithmetic/division-by-zero");
    expectFailure("10mm / 0mm", "arithmetic/division-by-zero");
    expectFailure("5 / 0", "arithmetic/division-by-zero");
  });
});

describe("evaluateExpression modulo", () => {
  it("keeps the dimension of same-dimension operands", () => {
    expect(evaluate("5mm % 3mm")).toEqual(length(2));
    expect(evaluate("10.5mm % 3mm")).toEqual(length(1.5));
    expect(evaluate("-5mm % 3mm")).toEqual(length(-2));
    expect(evaluate("7 % 3")).toEqual(dimensionless(1));
  });

  it("rejects mixed-dimension and zero-divisor modulo", () => {
    expectFailure(
      "10mm % 3",
      EXPRESSION_EVALUATION_ERROR_CODES.moduloIncompatibleDimensions,
    );
    expectFailure(
      "10mm % 45deg",
      EXPRESSION_EVALUATION_ERROR_CODES.moduloIncompatibleDimensions,
    );
    expectFailure(
      "10mm % 0mm",
      EXPRESSION_EVALUATION_ERROR_CODES.moduloByZero,
    );
  });
});

describe("evaluateExpression exponentiation", () => {
  it("exponentiates dimensionless values with any exponent", () => {
    expect(evaluate("2 ^ 10")).toEqual(dimensionless(1024));
    expectClose(evaluate("2 ^ 0.5").value, Math.SQRT2);
    expect(evaluate("3 ^ 0")).toEqual(dimensionless(1));
  });

  it("maps dimensional bases through the length-power algebra", () => {
    expect(evaluate("3mm ^ 2")).toEqual(area(9));
    expect(evaluate("3mm ^ 3")).toEqual(volume(27));
    expect(evaluate("3mm ^ 1")).toEqual(length(3));
    expect(evaluate("3mm ^ 0")).toEqual(dimensionless(1));
    expect(evaluate("9mm2 ^ 0.5")).toEqual(length(3));
    expectClose(evaluate("27mm3 ^ (1 / 3)").value, 3);
    expectClose(evaluate("8mm3 ^ (2 / 3)").value, 4);
    expectClose(evaluate("4mm2 ^ 1.5").value, 8);
    expect(evaluate("4mm2 ^ 1.5").dimension).toBe("volume");
    expect(evaluate("2rad ^ 1")).toEqual(angle(2));
    const degreesKept = evaluate("2deg ^ 1");
    expect(degreesKept.dimension).toBe("angle");
    expectClose(degreesKept.value, 2 * (Math.PI / 180));
    expect(evaluate("2deg ^ 0")).toEqual(dimensionless(1));
  });

  it("rejects exponents outside the closed dimension algebra", () => {
    expectFailure(
      "2mm ^ 4",
      EXPRESSION_EVALUATION_ERROR_CODES.invalidExponentValue,
    );
    expectFailure(
      "2mm ^ 0.5",
      EXPRESSION_EVALUATION_ERROR_CODES.invalidExponentValue,
    );
    expectFailure(
      "2mm ^ -1",
      EXPRESSION_EVALUATION_ERROR_CODES.invalidExponentValue,
    );
    expectFailure(
      "2mm2 ^ 0.25",
      EXPRESSION_EVALUATION_ERROR_CODES.invalidExponentValue,
    );
    expectFailure(
      "16mm2 ^ 0.25",
      EXPRESSION_EVALUATION_ERROR_CODES.invalidExponentValue,
    );
    expectFailure(
      "2deg ^ 2",
      EXPRESSION_EVALUATION_ERROR_CODES.invalidExponentValue,
    );
  });

  it("requires a dimensionless exponent", () => {
    expectFailure(
      "2mm ^ 10mm",
      EXPRESSION_EVALUATION_ERROR_CODES.invalidExponentDimension,
    );
    expectFailure(
      "2 ^ 10mm",
      EXPRESSION_EVALUATION_ERROR_CODES.invalidExponentDimension,
    );
  });

  it("rejects non-real results", () => {
    expectFailure(
      "(-4) ^ 0.5",
      EXPRESSION_EVALUATION_ERROR_CODES.nonFiniteResult,
    );
    expectFailure(
      "(-8) ^ (1 / 3)",
      EXPRESSION_EVALUATION_ERROR_CODES.nonFiniteResult,
    );
    expectFailure(
      "10 ^ 1000",
      EXPRESSION_EVALUATION_ERROR_CODES.nonFiniteResult,
    );
  });
});

describe("evaluateExpression functions", () => {
  it("square roots dimensionless and area values", () => {
    expect(evaluate("sqrt(9)")).toEqual(dimensionless(3));
    expect(evaluate("sqrt(9mm2)")).toEqual(length(3));
    expect(evaluate("sqrt(0mm2)")).toEqual(length(0));
  });

  it("rejects square roots outside the dimension algebra", () => {
    expectFailure(
      "sqrt(4mm)",
      EXPRESSION_EVALUATION_ERROR_CODES.invalidSqrtDimension,
    );
    expectFailure(
      "sqrt(8mm3)",
      EXPRESSION_EVALUATION_ERROR_CODES.invalidSqrtDimension,
    );
    expectFailure(
      "sqrt(45deg)",
      EXPRESSION_EVALUATION_ERROR_CODES.invalidSqrtDimension,
    );
    expectFailure(
      "sqrt(-4)",
      EXPRESSION_EVALUATION_ERROR_CODES.nonFiniteResult,
    );
  });

  it("extremes same-dimension arguments by canonical magnitude", () => {
    expect(evaluate("min(2.5in, 50mm)")).toEqual(length(50));
    expect(evaluate("max(90deg, 1rad)").value).toBeGreaterThan(1.57);
    expect(evaluate("max(1rad, 90deg)").value).toBeGreaterThan(1.57);
    expect(evaluate("min(10mm, 5mm, 7mm)")).toEqual(length(5));
    expect(evaluate("max(1, 2, 3)")).toEqual(dimensionless(3));
    expect(evaluate("max(10mm2, 0.5cm2)")).toEqual(area(50));
  });

  it("rejects min/max over mixed dimensions", () => {
    expectFailure(
      "min(10mm, 45deg)",
      EXPRESSION_EVALUATION_ERROR_CODES.minMaxIncompatibleDimensions,
    );
    expectFailure(
      "max(1, 10mm, 2)",
      EXPRESSION_EVALUATION_ERROR_CODES.minMaxIncompatibleDimensions,
    );
  });

  it("composes functions and operators", () => {
    const table = environmentOf({
      plateArea: area(900),
      margin: length(3),
    });
    expect(evaluate("sqrt(plateArea) - margin", table)).toEqual(length(27));
    expect(evaluate("min(sqrt(plateArea), 100mm) * 2", table)).toEqual(
      length(60),
    );
  });
});

describe("evaluateExpression safety and determinism", () => {
  it("never executes JavaScript: hostile sources fail to parse or resolve", () => {
    const hostile = [
      "process.exit(1)",
      "`process.exit(1)`",
      "${process.exit(1)}",
      "new Function('return 1')()",
      "constructor.constructor('return 1')()",
      "__defineGetter__(1)",
    ];
    for (const source of hostile) {
      expect(parseExpression(source).ok).toBe(false);
    }
    const bare = parseExpression("process");
    expect(bare.ok).toBe(true);
    if (!bare.ok) return;
    const result = evaluateExpression(bare.value, noParameters);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(
      EXPRESSION_EVALUATION_ERROR_CODES.unknownIdentifier,
    );
    expect(result.error.input).toEqual({ kind: "identifier", name: "process" });
  });

  it("returns equal results for repeated evaluation of the same input", () => {
    const first = evaluate("min(2.5in, 50mm) + sqrt(16mm2)");
    const second = evaluate("min(2.5in, 50mm) + sqrt(16mm2)");
    expect(first).toEqual(second);
  });

  it("evaluates the unity unit token as dimensionless", () => {
    const unity = evaluateExpression(
      { kind: "unitLiteral", value: 5, unit: "1" },
      noParameters,
    );
    expect(unity.ok).toBe(true);
    if (!unity.ok) return;
    expect(unity.value).toEqual(dimensionless(5));
  });

  it("rejects hand-built call nodes that violate their arity contract", () => {
    const badSqrt = evaluateExpression(
      { kind: "call", callee: "sqrt", args: [] },
      noParameters,
    );
    expect(badSqrt.ok).toBe(false);
    if (badSqrt.ok) return;
    expect(badSqrt.error.code).toBe(
      EXPRESSION_EVALUATION_ERROR_CODES.malformedCall,
    );
    const badMin = evaluateExpression(
      { kind: "call", callee: "min", args: [{ kind: "number", value: 1 }] },
      noParameters,
    );
    expect(badMin.ok).toBe(false);
    if (badMin.ok) return;
    expect(badMin.error.code).toBe(
      EXPRESSION_EVALUATION_ERROR_CODES.malformedCall,
    );
  });
});
