import { describe, expect, it } from "vitest";

import {
  type ExpressionNode,
  EXPRESSION_PARSE_ERROR_CODES,
  parseExpression,
  printExpression,
} from "./index";

const num = (value: number): ExpressionNode => ({ kind: "number", value });
const unit = (
  value: number,
  unit: "mm" | "deg" | "in" | "mm2",
): ExpressionNode => ({ kind: "unitLiteral", value, unit });
const id = (name: string): ExpressionNode => ({ kind: "identifier", name });
const neg = (operand: ExpressionNode): ExpressionNode => ({
  kind: "unary",
  operator: "-",
  operand,
});
const bin = (
  operator: "+" | "-" | "*" | "/" | "%" | "^",
  left: ExpressionNode,
  right: ExpressionNode,
): ExpressionNode => ({ kind: "binary", operator, left, right });
const call = (
  callee: "sqrt" | "min" | "max",
  ...args: readonly ExpressionNode[]
): ExpressionNode => ({ kind: "call", callee, args });

function expectAst(source: string, expected: ExpressionNode): void {
  const result = parseExpression(source);
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.value).toEqual(expected);
  expect(Object.isFrozen(result.value)).toBe(true);
}

function expectFailure(source: unknown, code: string): void {
  const result = parseExpression(source);
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.error.code).toBe(code);
  expect(result.error.input).toBe(source);
  expect(result.error.message.length).toBeGreaterThan(0);
  expect(result.error.position).toBeGreaterThanOrEqual(0);
}

describe("parseExpression literals", () => {
  it("parses plain numbers as dimensionless literals", () => {
    expectAst("42", num(42));
    expectAst("2.5", num(2.5));
    expectAst("0", num(0));
    expectAst("007", num(7));
  });

  it("parses attached unit literals for every registered unit family", () => {
    expectAst("10mm", unit(10, "mm"));
    expectAst("2.5in", unit(2.5, "in"));
    expectAst("45deg", unit(45, "deg"));
    expectAst("3.14159rad", {
      kind: "unitLiteral",
      value: 3.14159,
      unit: "rad",
    });
    expectAst("100mm2", unit(100, "mm2"));
    expectAst("2cm3", { kind: "unitLiteral", value: 2, unit: "cm3" });
    expectAst("0.5m", { kind: "unitLiteral", value: 0.5, unit: "m" });
  });

  it("parses identifiers, including underscore-leading names", () => {
    expectAst("width", id("width"));
    expectAst("_draft", id("_draft"));
    expectAst("__proto__", id("__proto__"));
    expectAst("sqrt", id("sqrt"));
  });

  it("tolerates whitespace between but not inside tokens", () => {
    expectAst("  10mm\t+\n5mm  ", bin("+", unit(10, "mm"), unit(5, "mm")));
    expectAst("10mm+5mm", bin("+", unit(10, "mm"), unit(5, "mm")));
  });
});

describe("parseExpression operators", () => {
  it("parses every binary operator", () => {
    expectAst("1 + 2", bin("+", num(1), num(2)));
    expectAst("1 - 2", bin("-", num(1), num(2)));
    expectAst("1 * 2", bin("*", num(1), num(2)));
    expectAst("1 / 2", bin("/", num(1), num(2)));
    expectAst("1 % 2", bin("%", num(1), num(2)));
    expectAst("1 ^ 2", bin("^", num(1), num(2)));
  });

  it("respects standard precedence and left associativity", () => {
    expectAst("2 + 3 * 4", bin("+", num(2), bin("*", num(3), num(4))));
    expectAst("10 - 4 - 3", bin("-", bin("-", num(10), num(4)), num(3)));
    expectAst("8 / 4 / 2", bin("/", bin("/", num(8), num(4)), num(2)));
    expectAst("(2 + 3) * 4", bin("*", bin("+", num(2), num(3)), num(4)));
  });

  it("parses exponentiation right-associatively with a unary exponent slot", () => {
    expectAst("2 ^ 3 ^ 2", bin("^", num(2), bin("^", num(3), num(2))));
    expectAst("2 ^ -3", bin("^", num(2), neg(num(3))));
    expectAst("-2 ^ 2", neg(bin("^", num(2), num(2))));
    expectAst("(-2) ^ 2", bin("^", neg(num(2)), num(2)));
  });

  it("parses unary negation", () => {
    expectAst("-5", neg(num(5)));
    expectAst("--5", neg(neg(num(5))));
    expectAst("-(2 * 3)", neg(bin("*", num(2), num(3))));
    expectAst("10 - -3", bin("-", num(10), neg(num(3))));
    expectAst("-width", neg(id("width")));
  });

  it("parses the pinned function set with strict arity", () => {
    expectAst("sqrt(9)", call("sqrt", num(9)));
    expectAst("sqrt(9mm2)", call("sqrt", unit(9, "mm2")));
    expectAst("min(a, b)", call("min", id("a"), id("b")));
    expectAst("min(a, b, 0)", call("min", id("a"), id("b"), num(0)));
    expectAst(
      "max(min(a, b), 1)",
      call("max", call("min", id("a"), id("b")), num(1)),
    );
    expectAst("-sqrt(4)", neg(call("sqrt", num(4))));
    expectAst("2 * sqrt(9mm2)", bin("*", num(2), call("sqrt", unit(9, "mm2"))));
  });
});

describe("parseExpression malformed input", () => {
  it("rejects empty and whitespace-only sources", () => {
    expectFailure("", EXPRESSION_PARSE_ERROR_CODES.empty);
    expectFailure("   \t\n ", EXPRESSION_PARSE_ERROR_CODES.empty);
  });

  it("rejects non-string input without coercing", () => {
    expectFailure(42, EXPRESSION_PARSE_ERROR_CODES.empty);
    expectFailure(null, EXPRESSION_PARSE_ERROR_CODES.empty);
  });

  it("rejects characters outside the grammar, including unicode sugar", () => {
    expectFailure("width²", EXPRESSION_PARSE_ERROR_CODES.unexpectedCharacter);
    expectFailure("@", EXPRESSION_PARSE_ERROR_CODES.unexpectedCharacter);
    expectFailure("10 $ 2", EXPRESSION_PARSE_ERROR_CODES.unexpectedCharacter);
    expectFailure(".5", EXPRESSION_PARSE_ERROR_CODES.unexpectedCharacter);
    expectFailure("10.5.5", EXPRESSION_PARSE_ERROR_CODES.unexpectedCharacter);
  });

  it("never evaluates arbitrary JavaScript", () => {
    expectFailure(
      "process.exit(1)",
      EXPRESSION_PARSE_ERROR_CODES.unexpectedCharacter,
    );
    expectFailure(
      "`process.exit(1)`",
      EXPRESSION_PARSE_ERROR_CODES.unexpectedCharacter,
    );
    expectFailure(
      "${process.exit(1)}",
      EXPRESSION_PARSE_ERROR_CODES.unexpectedCharacter,
    );
    expectFailure(
      "process['exit'](1)",
      EXPRESSION_PARSE_ERROR_CODES.unexpectedCharacter,
    );
    expectFailure("new Object()", EXPRESSION_PARSE_ERROR_CODES.unexpectedToken);
  });

  it("rejects malformed numbers", () => {
    expectFailure("10.", EXPRESSION_PARSE_ERROR_CODES.invalidNumber);
    expectFailure(
      "9007199254740994",
      EXPRESSION_PARSE_ERROR_CODES.invalidNumber,
    );
  });

  it("rejects unknown units attached to numbers", () => {
    expectFailure("10qq", EXPRESSION_PARSE_ERROR_CODES.unknownUnit);
    expectFailure("10MM", EXPRESSION_PARSE_ERROR_CODES.unknownUnit);
    expectFailure("1e3", EXPRESSION_PARSE_ERROR_CODES.unknownUnit);
    expectFailure("10 foo", EXPRESSION_PARSE_ERROR_CODES.unexpectedToken);
  });

  it("rejects structurally invalid token sequences", () => {
    expectFailure("10mm 5mm", EXPRESSION_PARSE_ERROR_CODES.unexpectedToken);
    expectFailure("10 mm", EXPRESSION_PARSE_ERROR_CODES.unexpectedToken);
    expectFailure("10 + + 2", EXPRESSION_PARSE_ERROR_CODES.unexpectedToken);
    expectFailure("+", EXPRESSION_PARSE_ERROR_CODES.unexpectedToken);
    expectFailure(")", EXPRESSION_PARSE_ERROR_CODES.unexpectedToken);
    expectFailure("min(2,)", EXPRESSION_PARSE_ERROR_CODES.unexpectedToken);
    expectFailure("10mm + 5mm )", EXPRESSION_PARSE_ERROR_CODES.unexpectedToken);
  });

  it("rejects truncation and unbalanced parentheses", () => {
    expectFailure("10 +", EXPRESSION_PARSE_ERROR_CODES.unexpectedEndOfInput);
    expectFailure(
      "(10mm",
      EXPRESSION_PARSE_ERROR_CODES.missingClosingParenthesis,
    );
    expectFailure(
      "(10mm + 5mm",
      EXPRESSION_PARSE_ERROR_CODES.missingClosingParenthesis,
    );
    expectFailure(
      "(10 20)",
      EXPRESSION_PARSE_ERROR_CODES.missingClosingParenthesis,
    );
    expectFailure(
      "sqrt(min(1, 2)",
      EXPRESSION_PARSE_ERROR_CODES.missingClosingParenthesis,
    );
  });

  it("rejects unknown functions and invalid arities", () => {
    expectFailure("avg(1, 2)", EXPRESSION_PARSE_ERROR_CODES.unknownFunction);
    expectFailure("min(1)", EXPRESSION_PARSE_ERROR_CODES.invalidFunctionArity);
    expectFailure("min()", EXPRESSION_PARSE_ERROR_CODES.invalidFunctionArity);
    expectFailure(
      "sqrt(1, 2)",
      EXPRESSION_PARSE_ERROR_CODES.invalidFunctionArity,
    );
  });

  it("rejects pathologically deep nesting with a structured failure", () => {
    const deep = `${"(".repeat(200)}1${")".repeat(200)}`;
    expectFailure(deep, EXPRESSION_PARSE_ERROR_CODES.tooDeep);
    const atLimit = `${"(".repeat(64)}1${")".repeat(64)}`;
    expect(parseExpression(atLimit).ok).toBe(true);
  });

  it("reports the offending token and its position", () => {
    const result = parseExpression("10mm + @5mm");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(
      EXPRESSION_PARSE_ERROR_CODES.unexpectedCharacter,
    );
    expect(result.error.token).toBe("@");
    expect(result.error.position).toBe(7);
  });
});

describe("parseExpression round-trips", () => {
  const corpus: readonly string[] = [
    "42",
    "2.5in",
    "45deg",
    "width",
    "10mm + 5mm",
    "10 - 4 - 3",
    "(2 + 3) * 4",
    "8 / 4 / 2",
    "total % 3",
    "2 ^ 3 ^ 2",
    "2 ^ -3",
    "-2 ^ 2",
    "(-2) ^ 2",
    "-(2 * 3)",
    "--5",
    "sqrt(9mm2)",
    "min(a, b, 0)",
    "max(min(a, b), 1)",
    "width * 2 + 10mm",
    "100mm2 / 10mm - 1mm",
  ];

  it("re-parses printed ASTs to identical ASTs", () => {
    for (const source of corpus) {
      const first = parseExpression(source);
      expect(first.ok).toBe(true);
      if (!first.ok) continue;
      const printed = printExpression(first.value);
      const reparsed = parseExpression(printed);
      expect(reparsed.ok).toBe(true);
      if (!reparsed.ok) continue;
      expect(reparsed.value).toEqual(first.value);
      expect(printExpression(reparsed.value)).toBe(printed);
    }
  });

  it("serializes ASTs deterministically", () => {
    for (const source of corpus) {
      const left = parseExpression(source);
      const right = parseExpression(source);
      expect(left.ok).toBe(true);
      expect(right.ok).toBe(true);
      if (!left.ok || !right.ok) continue;
      expect(JSON.stringify(left.value)).toBe(JSON.stringify(right.value));
    }
  });
});
