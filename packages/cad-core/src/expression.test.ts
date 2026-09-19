import { describe, expect, it } from "vitest";

import {
  type BinaryOperator,
  BINARY_OPERATORS,
  type ExpressionFunction,
  type ExpressionNode,
  EXPRESSION_AST_ERROR_CODES,
  EXPRESSION_FUNCTIONS,
  EXPRESSION_NODE_KINDS,
  extractExpressionDependencies,
  isBinaryOperator,
  isExpressionFunction,
  MAX_EXPRESSION_DEPTH,
  MAX_EXPRESSION_IDENTIFIER_LENGTH,
  parseExpression,
  parseExpressionAst,
  printExpression,
} from "./index";

const num = (value: number): ExpressionNode => ({ kind: "number", value });
const unit = (
  value: number,
  unit: "mm" | "deg" | "in" | "mm2",
): ExpressionNode => ({
  kind: "unitLiteral",
  value,
  unit,
});
const id = (name: string): ExpressionNode => ({ kind: "identifier", name });
const neg = (operand: ExpressionNode): ExpressionNode => ({
  kind: "unary",
  operator: "-",
  operand,
});
const bin = (
  operator: BinaryOperator,
  left: ExpressionNode,
  right: ExpressionNode,
): ExpressionNode => ({ kind: "binary", operator, left, right });
const call = (
  callee: ExpressionFunction,
  ...args: ExpressionNode[]
): ExpressionNode => ({ kind: "call", callee, args });

describe("expression grammar constants", () => {
  it("pins the V1 function set and binary operators", () => {
    expect(EXPRESSION_FUNCTIONS).toEqual(["sqrt", "min", "max"]);
    expect(BINARY_OPERATORS).toEqual(["+", "-", "*", "/", "%", "^"]);
    expect(EXPRESSION_NODE_KINDS).toEqual([
      "number",
      "unitLiteral",
      "identifier",
      "unary",
      "binary",
      "call",
    ]);
  });

  it("type-guards functions and operators", () => {
    expect(isExpressionFunction("sqrt")).toBe(true);
    expect(isExpressionFunction("avg")).toBe(false);
    expect(isBinaryOperator("%")).toBe(true);
    expect(isBinaryOperator("|")).toBe(false);
  });
});

describe("printExpression", () => {
  it("prints atoms canonically", () => {
    expect(printExpression(num(42))).toBe("42");
    expect(printExpression(num(2.5))).toBe("2.5");
    expect(printExpression(num(0))).toBe("0");
    expect(printExpression(unit(2.5, "in"))).toBe("2.5in");
    expect(printExpression(unit(45, "deg"))).toBe("45deg");
    expect(printExpression(unit(100, "mm2"))).toBe("100mm2");
    expect(printExpression(id("width"))).toBe("width");
  });

  it("prints unary negation with minimal parentheses", () => {
    expect(printExpression(neg(num(3)))).toBe("-3");
    expect(printExpression(neg(id("x")))).toBe("-x");
    expect(printExpression(neg(neg(num(3))))).toBe("--3");
    expect(printExpression(neg(bin("*", num(2), num(3))))).toBe("-(2 * 3)");
    expect(printExpression(neg(bin("+", num(2), num(3))))).toBe("-(2 + 3)");
    expect(printExpression(neg(bin("^", num(2), num(2))))).toBe("-2 ^ 2");
  });

  it("prints binary operators with left associativity parentheses", () => {
    expect(printExpression(bin("+", id("a"), id("b")))).toBe("a + b");
    expect(printExpression(bin("-", bin("-", id("a"), id("b")), id("c")))).toBe(
      "a - b - c",
    );
    expect(printExpression(bin("-", id("a"), bin("-", id("b"), id("c"))))).toBe(
      "a - (b - c)",
    );
    expect(printExpression(bin("+", id("a"), bin("-", id("b"), id("c"))))).toBe(
      "a + (b - c)",
    );
    expect(printExpression(bin("/", id("a"), bin("/", id("b"), id("c"))))).toBe(
      "a / (b / c)",
    );
    expect(printExpression(bin("*", id("a"), bin("/", id("b"), id("c"))))).toBe(
      "a * (b / c)",
    );
    expect(printExpression(bin("*", bin("/", id("a"), id("b")), id("c")))).toBe(
      "a / b * c",
    );
    expect(printExpression(bin("-", num(10), neg(num(3))))).toBe("10 - -3");
  });

  it("prints exponentiation right-associatively", () => {
    expect(printExpression(bin("^", id("a"), bin("^", id("b"), id("c"))))).toBe(
      "a ^ b ^ c",
    );
    expect(printExpression(bin("^", bin("^", id("a"), id("b")), id("c")))).toBe(
      "(a ^ b) ^ c",
    );
    expect(printExpression(bin("^", num(2), neg(num(3))))).toBe("2 ^ -3");
  });

  it("prints function calls with comma-separated arguments", () => {
    expect(printExpression(call("sqrt", num(9)))).toBe("sqrt(9)");
    expect(printExpression(call("min", id("a"), id("b"), num(0)))).toBe(
      "min(a, b, 0)",
    );
    expect(
      printExpression(bin("*", call("sqrt", unit(9, "mm2")), num(2))),
    ).toBe("sqrt(9mm2) * 2");
    expect(
      printExpression(call("max", call("min", id("a"), id("b")), num(1))),
    ).toBe("max(min(a, b), 1)");
  });

  it("prints magnitudes as decimals the lexer can re-read, never exponents", () => {
    // Everyday magnitudes stay byte-identical to String(value).
    expect(printExpression(num(0.000001))).toBe("0.000001");
    expect(printExpression(num(2 ** 53 - 1))).toBe("9007199254740991");
    // String() would emit 5e-7 here; the V1 number token has no exponent
    // syntax, so the same number prints as an explicit decimal.
    expect(printExpression(num(5e-7))).toBe("0.0000005");
    expect(printExpression(unit(5e-7, "mm"))).toBe("0.0000005mm");
    // 1e21-scale magnitudes and plain integers beyond the safe-integer
    // range: the plain integer forms are not lexable (integers must be
    // safe integers), so the exact decimal form carries a `.0` tail.
    expect(printExpression(num(1e21))).toBe("1000000000000000000000.0");
    expect(printExpression(num(1.5e21))).toBe("1500000000000000000000.0");
    expect(printExpression(num(1e20))).toBe("100000000000000000000.0");
    expect(printExpression(num(2 ** 53))).toBe("9007199254740992.0");
  });

  it("round-trips extreme-magnitude literals through print and re-parse", () => {
    // Revived-from-JSON ASTs can carry any finite magnitude, including the
    // exponential-notation range; their printed form must re-parse to the
    // identical AST (the pinned parse(print(ast)) invariant).
    const extreme: readonly ExpressionNode[] = [
      num(5e-7),
      unit(5e-7, "mm"),
      num(1e21),
      num(1.5e21),
      num(2 ** 53),
    ];
    for (const node of extreme) {
      const printed = printExpression(node);
      expect(printed).not.toContain("e");
      const reparsed = parseExpression(printed);
      expect(reparsed.ok).toBe(true);
      if (!reparsed.ok) continue;
      expect(reparsed.value).toEqual(node);
    }
  });
});

describe("parseExpressionAst", () => {
  const corpus: readonly ExpressionNode[] = [
    num(0),
    num(2.5),
    unit(10, "mm"),
    unit(45, "deg"),
    id("width"),
    neg(num(3)),
    neg(neg(id("x"))),
    bin("%", id("total"), num(3)),
    bin("+", bin("*", num(2), id("width")), unit(1, "mm")),
    bin("^", id("x"), bin("/", num(1), num(2))),
    call("sqrt", unit(9, "mm2")),
    call("min", id("a"), id("b")),
    call("max", neg(id("a")), num(0), call("sqrt", num(4))),
  ];

  it("accepts every node kind and returns an equal frozen node", () => {
    for (const node of corpus) {
      const result = parseExpressionAst(node);
      expect(result.ok).toBe(true);
      if (!result.ok) continue;
      expect(result.value).toEqual(node);
      expect(Object.isFrozen(result.value)).toBe(true);
    }
  });

  it("round-trips nodes through JSON unchanged", () => {
    for (const node of corpus) {
      const revived = JSON.parse(JSON.stringify(node)) as unknown;
      const result = parseExpressionAst(revived);
      expect(result.ok).toBe(true);
      if (!result.ok) continue;
      expect(result.value).toEqual(node);
      expect(JSON.stringify(result.value)).toBe(JSON.stringify(node));
    }
  });

  it("rejects malformed nodes with a stable code", () => {
    const malformed: readonly unknown[] = [
      42,
      null,
      "width",
      [],
      {},
      { kind: "nope" },
      { kind: "number" },
      { kind: "number", value: "10" },
      { kind: "number", value: Number.NaN },
      { kind: "number", value: Infinity },
      { kind: "number", value: -3 },
      { kind: "number", value: -0 },
      { kind: "unitLiteral", value: 10, unit: "pts" },
      { kind: "unitLiteral", value: 10 },
      { kind: "unitLiteral", value: -3, unit: "mm" },
      { kind: "identifier", name: "9lives" },
      { kind: "identifier", name: "with space" },
      {
        kind: "identifier",
        name: "x".repeat(MAX_EXPRESSION_IDENTIFIER_LENGTH + 1),
      },
      { kind: "identifier" },
      { kind: "unary", operator: "+", operand: num(1) },
      { kind: "unary", operator: "-" },
      { kind: "binary", operator: "|", left: num(1), right: num(2) },
      { kind: "binary", operator: "+", left: num(1) },
      { kind: "call", callee: "avg", args: [num(1)] },
      { kind: "call", callee: "sqrt", args: [num(1), num(2)] },
      { kind: "call", callee: "min", args: [num(1)] },
      { kind: "call", callee: "min", args: "nope" },
      { kind: "call", callee: "sqrt" },
    ];
    for (const input of malformed) {
      const result = parseExpressionAst(input);
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.error.code).toBe(EXPRESSION_AST_ERROR_CODES.malformed);
      expect(result.error.message.length).toBeGreaterThan(0);
      expect(result.error.input).toBe(input);
    }
  });

  it("enforces the maximum node depth on hostile nested input", () => {
    const chain = (count: number): ExpressionNode => {
      let node: ExpressionNode = num(1);
      for (let built = 1; built < count; built += 1) node = neg(node);
      return node;
    };
    expect(parseExpressionAst(chain(MAX_EXPRESSION_DEPTH)).ok).toBe(true);
    const tooDeep = parseExpressionAst(chain(MAX_EXPRESSION_DEPTH + 1));
    expect(tooDeep.ok).toBe(false);
  });
});

describe("extractExpressionDependencies", () => {
  it("returns no dependencies for closed expressions", () => {
    expect(extractExpressionDependencies(num(10))).toEqual(new Set());
    expect(
      extractExpressionDependencies(bin("+", unit(10, "mm"), unit(5, "mm"))),
    ).toEqual(new Set());
  });

  it("collects every referenced identifier once", () => {
    expect(extractExpressionDependencies(id("width"))).toEqual(
      new Set(["width"]),
    );
    expect(
      extractExpressionDependencies(
        bin("*", id("width"), bin("+", id("width"), num(2))),
      ),
    ).toEqual(new Set(["width"]));
    expect(
      extractExpressionDependencies(call("max", id("a"), id("b"), id("a"))),
    ).toEqual(new Set(["a", "b"]));
    expect(
      extractExpressionDependencies(neg(bin("-", id("x"), unit(1, "mm")))),
    ).toEqual(new Set(["x"]));
  });

  it("never treats function names as dependencies", () => {
    expect(extractExpressionDependencies(call("sqrt", id("area")))).toEqual(
      new Set(["area"]),
    );
  });
});
