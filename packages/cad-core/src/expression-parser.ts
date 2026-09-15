/**
 * Parser for the pinned V1 expression grammar.
 *
 * Grammar (precedence low to high; `^` is right-associative, all other
 * binary operators left-associative):
 *
 * ```
 * expression := term (('+' | '-') term)*
 * term       := unary (('*' | '/' | '%') unary)*
 * unary      := '-' unary | power
 * power      := primary ('^' unary)?
 * primary    := number | number-unit | identifier
 *             | function '(' expression (',' expression)* ')'
 *             | '(' expression ')'
 * ```
 *
 * Numbers are decimals without exponent notation; unit literals must be
 * attached (`10mm`, `45deg`, `2.5in`), never whitespace-separated. The
 * function set is exactly `sqrt`, `min`, `max`. There is no unicode operator
 * sugar and nothing evaluates JavaScript — lexing and parsing produce frozen
 * AST nodes or structured failures with stable `expression/*` codes, carrying
 * the offending token and its source position. Nesting deeper than
 * {@link MAX_EXPRESSION_DEPTH} is rejected so hostile input cannot overflow
 * the stack.
 */

import {
  type ExpressionFunction,
  type ExpressionNode,
  isExpressionFunction,
  isValidCallArity,
  MAX_EXPRESSION_DEPTH,
} from "./expression";
import { type ParseFailure, type ParseResult, fail, ok } from "./result";
import { type AnyUnit, isUnitToken } from "./units";

/** Stable failure codes produced when source is rejected as an expression. */
export const EXPRESSION_PARSE_ERROR_CODES = {
  empty: "expression/empty",
  unexpectedCharacter: "expression/unexpected-character",
  invalidNumber: "expression/invalid-number",
  unknownUnit: "expression/unknown-unit",
  unexpectedToken: "expression/unexpected-token",
  unexpectedEndOfInput: "expression/unexpected-end-of-input",
  missingClosingParenthesis: "expression/missing-closing-parenthesis",
  unknownFunction: "expression/unknown-function",
  invalidFunctionArity: "expression/invalid-function-arity",
  tooDeep: "expression/too-deep",
} as const;

export type ExpressionParseErrorCode =
  (typeof EXPRESSION_PARSE_ERROR_CODES)[keyof typeof EXPRESSION_PARSE_ERROR_CODES];

/** Structured failure describing why source was rejected as an expression. */
export interface ExpressionParseError extends ParseFailure {
  readonly code: ExpressionParseErrorCode;
  /** Zero-based index of the offending character in the source. */
  readonly position: number;
  /** The offending token, when one was recognized. */
  readonly token?: string;
}

function isDigit(char: string): boolean {
  return char >= "0" && char <= "9";
}

function isIdentifierStart(char: string): boolean {
  return (
    (char >= "A" && char <= "Z") ||
    (char >= "a" && char <= "z") ||
    char === "_"
  );
}

function isIdentifierPart(char: string): boolean {
  return isIdentifierStart(char) || isDigit(char);
}

function isUnitPart(char: string): boolean {
  return /[A-Za-z0-9]/.test(char);
}

function isWhitespace(char: string): boolean {
  return char === " " || char === "\t" || char === "\n" || char === "\r";
}

type Token =
  | {
      readonly type: "number";
      readonly value: number;
      readonly position: number;
    }
  | {
      readonly type: "unitLiteral";
      readonly value: number;
      readonly unit: AnyUnit;
      readonly position: number;
    }
  | {
      readonly type: "identifier";
      readonly name: string;
      readonly position: number;
    }
  | {
      readonly type: "operator";
      readonly lexeme: string;
      readonly position: number;
    };

type LexOutcome = ParseResult<readonly Token[], ExpressionParseError>;

function lex(source: string): LexOutcome {
  const reject = (
    code: ExpressionParseErrorCode,
    message: string,
    position: number,
    token?: string,
  ): LexOutcome =>
    fail({
      code,
      message,
      input: source,
      position,
      ...(token === undefined ? {} : { token }),
    });

  const tokens: Token[] = [];
  let index = 0;
  while (index < source.length) {
    const char = source[index];
    if (char === undefined) break;
    if (isWhitespace(char)) {
      index += 1;
      continue;
    }
    const start = index;
    if (isDigit(char)) {
      index += 1;
      while (source[index] !== undefined && isDigit(source[index] as string)) {
        index += 1;
      }
      let isDecimal = false;
      if (source[index] === "." && isDigit(source[index + 1] ?? "")) {
        isDecimal = true;
        index += 1;
        while (
          source[index] !== undefined &&
          isDigit(source[index] as string)
        ) {
          index += 1;
        }
      }
      const digits = source.slice(start, index);
      if (source[index] === "." && !isDecimal) {
        return reject(
          EXPRESSION_PARSE_ERROR_CODES.invalidNumber,
          `The number "${digits}." must have at least one digit after the decimal point.`,
          index,
          digits,
        );
      }
      const magnitude = Number(digits);
      const representable =
        Number.isFinite(magnitude) &&
        (isDecimal || Number.isSafeInteger(magnitude));
      if (!representable) {
        return reject(
          EXPRESSION_PARSE_ERROR_CODES.invalidNumber,
          `The number "${digits}" is not exactly representable; plain integers must be safe integers.`,
          start,
          digits,
        );
      }
      const attached = source[index] ?? "";
      if (attached !== "" && isIdentifierStart(attached)) {
        const unitStart = index;
        index += 1;
        while (
          source[index] !== undefined &&
          isUnitPart(source[index] as string)
        ) {
          index += 1;
        }
        const unitToken = source.slice(unitStart, index);
        if (!isUnitToken(unitToken)) {
          return reject(
            EXPRESSION_PARSE_ERROR_CODES.unknownUnit,
            `Unknown unit "${unitToken}" attached to ${digits}.`,
            unitStart,
            unitToken,
          );
        }
        tokens.push({ type: "unitLiteral", value: magnitude, unit: unitToken, position: start });
        continue;
      }
      tokens.push({ type: "number", value: magnitude, position: start });
      continue;
    }
    if (isIdentifierStart(char)) {
      index += 1;
      while (
        source[index] !== undefined &&
        isIdentifierPart(source[index] as string)
      ) {
        index += 1;
      }
      tokens.push({ type: "identifier", name: source.slice(start, index), position: start });
      continue;
    }
    if ("+-*/%^(),".includes(char)) {
      tokens.push({ type: "operator", lexeme: char, position: start });
      index += 1;
      continue;
    }
    return reject(
      EXPRESSION_PARSE_ERROR_CODES.unexpectedCharacter,
      `Unexpected character "${char}".`,
      start,
      char,
    );
  }
  return ok(tokens);
}

/**
 * Parses untrusted source text as an {@link ExpressionNode} following the
 * pinned V1 grammar. Equal sources always parse to deep-equal frozen ASTs;
 * every malformed input fails with a stable `expression/*` code, the
 * offending token, and its position. Non-string input is rejected rather
 * than coerced.
 */
export function parseExpression(
  source: unknown,
): ParseResult<ExpressionNode, ExpressionParseError> {
  if (typeof source !== "string") {
    return fail({
      code: EXPRESSION_PARSE_ERROR_CODES.empty,
      message: "An expression must be a string.",
      input: source,
      position: 0,
    });
  }
  const tokens = lex(source);
  if (!tokens.ok) return tokens;
  if (tokens.value.length === 0) {
    return fail({
      code: EXPRESSION_PARSE_ERROR_CODES.empty,
      message: "An expression must not be empty.",
      input: source,
      position: 0,
    });
  }
  return new Parser(source, tokens.value).parse();
}

class Parser {
  private readonly source: string;
  private readonly tokens: readonly Token[];
  private cursor = 0;

  constructor(source: string, tokens: readonly Token[]) {
    this.source = source;
    this.tokens = tokens;
  }

  parse(): ParseResult<ExpressionNode, ExpressionParseError> {
    const expression = this.parseAdditive(1);
    if (!expression.ok) return expression;
    const trailing = this.current();
    if (trailing !== undefined) {
      return this.rejectAt(
        trailing,
        EXPRESSION_PARSE_ERROR_CODES.unexpectedToken,
        `Unexpected token "${this.lexeme(trailing)}" after the expression.`,
      );
    }
    return expression;
  }

  private parseAdditive(
    depth: number,
  ): ParseResult<ExpressionNode, ExpressionParseError> {
    if (this.tooDeep(depth)) return this.tooDeepFailure();
    const first = this.parseMultiplicative(depth);
    if (!first.ok) return first;
    let left = first.value;
    while (true) {
      const operator = this.current();
      if (
        operator?.type !== "operator" ||
        (operator.lexeme !== "+" && operator.lexeme !== "-")
      ) {
        return ok(left);
      }
      this.advance();
      const right = this.parseMultiplicative(depth);
      if (!right.ok) return right;
      left = this.binary(operator.lexeme, left, right.value);
    }
  }

  private parseMultiplicative(
    depth: number,
  ): ParseResult<ExpressionNode, ExpressionParseError> {
    const first = this.parseUnary(depth);
    if (!first.ok) return first;
    let left = first.value;
    while (true) {
      const operator = this.current();
      if (
        operator?.type !== "operator" ||
        (operator.lexeme !== "*" &&
          operator.lexeme !== "/" &&
          operator.lexeme !== "%")
      ) {
        return ok(left);
      }
      this.advance();
      const right = this.parseUnary(depth);
      if (!right.ok) return right;
      left = this.binary(operator.lexeme, left, right.value);
    }
  }

  private parseUnary(
    depth: number,
  ): ParseResult<ExpressionNode, ExpressionParseError> {
    if (this.tooDeep(depth)) return this.tooDeepFailure();
    const token = this.current();
    if (token?.type === "operator" && token.lexeme === "-") {
      this.advance();
      const operand = this.parseUnary(depth + 1);
      if (!operand.ok) return operand;
      return ok(
        Object.freeze({
          kind: "unary",
          operator: "-",
          operand: operand.value,
        }),
      );
    }
    return this.parsePower(depth);
  }

  private parsePower(
    depth: number,
  ): ParseResult<ExpressionNode, ExpressionParseError> {
    const base = this.parsePrimary(depth);
    if (!base.ok) return base;
    const token = this.current();
    if (token?.type === "operator" && token.lexeme === "^") {
      this.advance();
      const exponent = this.parseUnary(depth + 1);
      if (!exponent.ok) return exponent;
      return ok(
        Object.freeze({
          kind: "binary",
          operator: "^",
          left: base.value,
          right: exponent.value,
        }),
      );
    }
    return base;
  }

  private parsePrimary(
    depth: number,
  ): ParseResult<ExpressionNode, ExpressionParseError> {
    const token = this.current();
    if (token === undefined) {
      return this.rejectHere(
        EXPRESSION_PARSE_ERROR_CODES.unexpectedEndOfInput,
        "The expression ended where an operand was expected.",
      );
    }
    if (token.type === "number") {
      this.advance();
      return ok(Object.freeze({ kind: "number", value: token.value }));
    }
    if (token.type === "unitLiteral") {
      this.advance();
      return ok(
        Object.freeze({
          kind: "unitLiteral",
          value: token.value,
          unit: token.unit,
        }),
      );
    }
    if (token.type === "identifier") {
      this.advance();
      const next = this.current();
      if (next?.type === "operator" && next.lexeme === "(") {
        return this.parseCall(token.name, token.position, depth);
      }
      return ok(Object.freeze({ kind: "identifier", name: token.name }));
    }
    if (token.type === "operator" && token.lexeme === "(") {
      this.advance();
      const inner = this.parseAdditive(depth + 1);
      if (!inner.ok) return inner;
      const failure = this.expectClosingParenthesis();
      if (failure !== undefined) return fail(failure);
      return inner;
    }
    return this.rejectAt(
      token,
      EXPRESSION_PARSE_ERROR_CODES.unexpectedToken,
      `Unexpected token "${token.lexeme}" where an operand was expected.`,
    );
  }

  private parseCall(
    calleeName: string,
    calleePosition: number,
    depth: number,
  ): ParseResult<ExpressionNode, ExpressionParseError> {
    if (this.tooDeep(depth)) return this.tooDeepFailure();
    if (!isExpressionFunction(calleeName)) {
      return fail({
        code: EXPRESSION_PARSE_ERROR_CODES.unknownFunction,
        message: `Unknown function "${calleeName}"; the function set is exactly sqrt, min, max.`,
        input: this.source,
        position: calleePosition,
        token: calleeName,
      });
    }
    const callee: ExpressionFunction = calleeName;
    const opening = this.current();
    if (opening?.type !== "operator" || opening.lexeme !== "(") {
      return this.rejectHere(
        EXPRESSION_PARSE_ERROR_CODES.unexpectedToken,
        `Expected "(" after "${callee}".`,
      );
    }
    this.advance();
    const args: ExpressionNode[] = [];
    if (!this.isOperator(")")) {
      while (true) {
        const arg = this.parseAdditive(depth + 1);
        if (!arg.ok) return arg;
        args.push(arg.value);
        if (!this.isOperator(",")) break;
        this.advance();
      }
    }
    const failure = this.expectClosingParenthesis();
    if (failure !== undefined) return fail(failure);
    if (!isValidCallArity(callee, args.length)) {
      return fail({
        code: EXPRESSION_PARSE_ERROR_CODES.invalidFunctionArity,
        message:
          callee === "sqrt"
            ? "sqrt takes exactly one argument."
            : `${callee} takes at least two arguments.`,
        input: this.source,
        position: calleePosition,
        token: callee,
      });
    }
    return ok(
      Object.freeze({
        kind: "call",
        callee,
        args: Object.freeze(args),
      }),
    );
  }

  private expectClosingParenthesis(): ExpressionParseError | undefined {
    if (this.isOperator(")")) {
      this.advance();
      return undefined;
    }
    const token = this.current();
    if (token === undefined) {
      return {
        code: EXPRESSION_PARSE_ERROR_CODES.missingClosingParenthesis,
        message: 'The expression ended before the required ")".',
        input: this.source,
        position: this.source.length,
      };
    }
    return {
      code: EXPRESSION_PARSE_ERROR_CODES.missingClosingParenthesis,
      message: `Expected ")" but found "${this.lexeme(token)}".`,
      input: this.source,
      position: token.position,
      token: this.lexeme(token),
    };
  }

  private binary(
    operator: "+" | "-" | "*" | "/" | "%",
    left: ExpressionNode,
    right: ExpressionNode,
  ): ExpressionNode {
    return Object.freeze({ kind: "binary", operator, left, right });
  }

  private tooDeep(depth: number): boolean {
    return depth > MAX_EXPRESSION_DEPTH;
  }

  private tooDeepFailure(): ParseResult<ExpressionNode, ExpressionParseError> {
    return this.rejectHere(
      EXPRESSION_PARSE_ERROR_CODES.tooDeep,
      `An expression may nest at most ${MAX_EXPRESSION_DEPTH} levels.`,
    );
  }

  private current(): Token | undefined {
    return this.tokens[this.cursor];
  }

  private isOperator(lexeme: string): boolean {
    const token = this.current();
    return token?.type === "operator" && token.lexeme === lexeme;
  }

  private advance(): void {
    this.cursor += 1;
  }

  private lexeme(token: Token): string {
    switch (token.type) {
      case "number":
        return String(token.value);
      case "unitLiteral":
        return `${String(token.value)}${token.unit}`;
      case "identifier":
        return token.name;
      case "operator":
        return token.lexeme;
    }
  }

  private rejectAt(
    token: Token,
    code: ExpressionParseErrorCode,
    message: string,
  ): ParseResult<ExpressionNode, ExpressionParseError> {
    return fail({
      code,
      message,
      input: this.source,
      position: token.position,
      token: this.lexeme(token),
    });
  }

  private rejectHere(
    code: ExpressionParseErrorCode,
    message: string,
  ): ParseResult<ExpressionNode, ExpressionParseError> {
    const token = this.current();
    return fail({
      code,
      message,
      input: this.source,
      position: token?.position ?? this.source.length,
      ...(token === undefined ? {} : { token: this.lexeme(token) }),
    });
  }
}
