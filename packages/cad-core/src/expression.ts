/**
 * Serializable expression AST for CAD parameters (Phase 5).
 *
 * An expression is plain data: frozen records assembled from six node kinds
 * (number literal, unit literal, identifier, unary negation, binary operator,
 * function call). Because nodes are plain data with fixed key order, they
 * serialize deterministically (`JSON.stringify` of equal ASTs is identical)
 * and revive through {@link parseExpressionAst}, which validates untrusted
 * input strictly with a stable failure code.
 *
 * The V1 grammar is pinned: identifiers, numbers, attached unit-literal
 * tokens (`10mm`, `45deg`, `2.5in`), the operators `+ - * / % ^`, parentheses,
 * and exactly the functions {@link EXPRESSION_FUNCTIONS}. There is no unicode
 * operator sugar (`width^2`, never `width²`) and nothing here evaluates
 * JavaScript — expressions are parsed, printed, and walked as data only.
 */

import { type ParseFailure, type ParseResult, fail, ok } from "./result";
import { type AnyUnit, isUnitToken } from "./units";

/** The pinned V1 function set; the four basic operations are operators. */
export const EXPRESSION_FUNCTIONS = ["sqrt", "min", "max"] as const;

export type ExpressionFunction = (typeof EXPRESSION_FUNCTIONS)[number];

const FUNCTION_SET: ReadonlySet<string> = new Set(EXPRESSION_FUNCTIONS);

/** Type guard for untrusted function names. */
export function isExpressionFunction(
  input: unknown,
): input is ExpressionFunction {
  return typeof input === "string" && FUNCTION_SET.has(input);
}

/** The pinned V1 binary operators, in canonical printing precedence order. */
export const BINARY_OPERATORS = ["+", "-", "*", "/", "%", "^"] as const;

export type BinaryOperator = (typeof BINARY_OPERATORS)[number];

const OPERATOR_SET: ReadonlySet<string> = new Set(BINARY_OPERATORS);

/** Type guard for untrusted binary operator tokens. */
export function isBinaryOperator(input: unknown): input is BinaryOperator {
  return typeof input === "string" && OPERATOR_SET.has(input);
}

/** Every node kind of the expression AST. */
export const EXPRESSION_NODE_KINDS = [
  "number",
  "unitLiteral",
  "identifier",
  "unary",
  "binary",
  "call",
] as const;

export type ExpressionNodeKind = (typeof EXPRESSION_NODE_KINDS)[number];

/**
 * Maximum number of nodes on any root-to-leaf path of an expression. The
 * parser and the AST validator both enforce it so hostile nested input is
 * rejected with a structured failure instead of overflowing the stack.
 */
export const MAX_EXPRESSION_DEPTH = 128;

/** Maximum length of an identifier (and therefore a parameter name). */
export const MAX_EXPRESSION_IDENTIFIER_LENGTH = 64;

const IDENTIFIER_PATTERN = new RegExp(
  `^[A-Za-z_][A-Za-z0-9_]{0,${MAX_EXPRESSION_IDENTIFIER_LENGTH - 1}}$`,
);

/** Type guard for names usable as expression identifiers. */
export function isExpressionIdentifierName(input: unknown): input is string {
  return typeof input === "string" && IDENTIFIER_PATTERN.test(input);
}

/** A non-negative decimal number literal; dimensionless. */
export interface NumberNode {
  readonly kind: "number";
  readonly value: number;
}

/** A decimal number with an attached unit token, e.g. `10mm` or `45deg`. */
export interface UnitLiteralNode {
  readonly kind: "unitLiteral";
  readonly value: number;
  readonly unit: AnyUnit;
}

/** A reference to a parameter by name, resolved by the evaluator. */
export interface IdentifierNode {
  readonly kind: "identifier";
  readonly name: string;
}

/** Unary negation; the sole unary operator of the V1 grammar. */
export interface UnaryNode {
  readonly kind: "unary";
  readonly operator: "-";
  readonly operand: ExpressionNode;
}

/** A binary operator application. */
export interface BinaryNode {
  readonly kind: "binary";
  readonly operator: BinaryOperator;
  readonly left: ExpressionNode;
  readonly right: ExpressionNode;
}

/** A call to one of the pinned functions. */
export interface CallNode {
  readonly kind: "call";
  readonly callee: ExpressionFunction;
  readonly args: readonly ExpressionNode[];
}

/** Root type of the expression AST. */
export type ExpressionNode =
  | NumberNode
  | UnitLiteralNode
  | IdentifierNode
  | UnaryNode
  | BinaryNode
  | CallNode;

/**
 * Arity contract of the V1 function set: `sqrt` takes exactly one argument,
 * `min` and `max` take at least two (a minimum of one value is meaningless).
 */
export function isValidCallArity(
  callee: ExpressionFunction,
  argCount: number,
): boolean {
  if (callee === "sqrt") return argCount === 1;
  return argCount >= 2;
}

/** Stable failure code produced when input is rejected as an expression AST. */
export const EXPRESSION_AST_ERROR_CODES = {
  malformed: "expression/ast-malformed",
} as const;

export type ExpressionAstErrorCode =
  (typeof EXPRESSION_AST_ERROR_CODES)[keyof typeof EXPRESSION_AST_ERROR_CODES];

/** Structured failure describing why input was rejected as an expression AST. */
export interface ExpressionAstError extends ParseFailure {
  readonly code: ExpressionAstErrorCode;
}

function astError(message: string, input: unknown): ExpressionAstError {
  return { code: EXPRESSION_AST_ERROR_CODES.malformed, message, input };
}

function isPlainRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}

/**
 * A literal magnitude usable in `number` and `unitLiteral` nodes: finite,
 * non-negative, and never negative zero, so printing always round-trips
 * (printing never emits a leading minus; negation is a unary node).
 */
function isLiteralMagnitude(input: unknown): input is number {
  return (
    typeof input === "number" &&
    Number.isFinite(input) &&
    input >= 0 &&
    !Object.is(input, -0)
  );
}

function validateNode(
  input: unknown,
  depth: number,
): ParseResult<ExpressionNode, ExpressionAstError> {
  if (depth > MAX_EXPRESSION_DEPTH) {
    return fail(
      astError(
        `An expression AST may nest at most ${MAX_EXPRESSION_DEPTH} nodes on one path.`,
        input,
      ),
    );
  }
  if (!isPlainRecord(input)) {
    return fail(
      astError("An expression AST node must be a plain object.", input),
    );
  }
  const { kind } = input;
  if (kind === "number") {
    const { value } = input;
    if (!isLiteralMagnitude(value)) {
      return fail(
        astError(
          "A number node value must be a finite non-negative number.",
          input,
        ),
      );
    }
    return ok(freeze({ kind, value }));
  }
  if (kind === "unitLiteral") {
    const { value, unit } = input;
    if (!isLiteralMagnitude(value)) {
      return fail(
        astError(
          "A unit literal node value must be a finite non-negative number.",
          input,
        ),
      );
    }
    if (!isUnitToken(unit)) {
      return fail(
        astError(
          "A unit literal node unit must be a token from the unit registry.",
          input,
        ),
      );
    }
    return ok(freeze({ kind, value, unit }));
  }
  if (kind === "identifier") {
    const { name } = input;
    if (!isExpressionIdentifierName(name)) {
      return fail(
        astError(
          `An identifier node name must match ^[A-Za-z_][A-Za-z0-9_]{0,${MAX_EXPRESSION_IDENTIFIER_LENGTH - 1}}$.`,
          input,
        ),
      );
    }
    return ok(freeze({ kind, name }));
  }
  if (kind === "unary") {
    const { operator, operand } = input;
    if (operator !== "-") {
      return fail(astError('A unary node operator must be "-".', input));
    }
    const parsedOperand = validateNode(operand, depth + 1);
    if (!parsedOperand.ok) return parsedOperand;
    return ok(freeze({ kind, operator, operand: parsedOperand.value }));
  }
  if (kind === "binary") {
    const { operator, left, right } = input;
    if (!isBinaryOperator(operator)) {
      return fail(
        astError(
          `A binary node operator must be one of: ${BINARY_OPERATORS.join(", ")}.`,
          input,
        ),
      );
    }
    const parsedLeft = validateNode(left, depth + 1);
    if (!parsedLeft.ok) return parsedLeft;
    const parsedRight = validateNode(right, depth + 1);
    if (!parsedRight.ok) return parsedRight;
    return ok(
      freeze({
        kind,
        operator,
        left: parsedLeft.value,
        right: parsedRight.value,
      }),
    );
  }
  if (kind === "call") {
    const { callee, args } = input;
    if (!isExpressionFunction(callee)) {
      return fail(
        astError(
          `A call node callee must be one of: ${EXPRESSION_FUNCTIONS.join(", ")}.`,
          input,
        ),
      );
    }
    if (!Array.isArray(args)) {
      return fail(
        astError("A call node args field must be an array of nodes.", input),
      );
    }
    if (!isValidCallArity(callee, args.length)) {
      return fail(
        astError(
          callee === "sqrt"
            ? "sqrt takes exactly one argument."
            : `${callee} takes at least two arguments.`,
          input,
        ),
      );
    }
    const parsedArgs: ExpressionNode[] = [];
    for (const arg of args) {
      const parsed = validateNode(arg, depth + 1);
      if (!parsed.ok) return parsed;
      parsedArgs.push(parsed.value);
    }
    return ok(freeze({ kind, callee, args: Object.freeze(parsedArgs) }));
  }
  return fail(
    astError(
      `An expression AST node kind must be one of: ${EXPRESSION_NODE_KINDS.join(", ")}.`,
      input,
    ),
  );
}

function freeze<T extends object>(node: T): T {
  return Object.freeze(node);
}

/**
 * Parses untrusted input (e.g. an expression revived from persisted JSON) as
 * an {@link ExpressionNode}. Every field is validated strictly and the result
 * is a frozen, canonically ordered node, so validation doubles as
 * normalization: equal ASTs always serialize to identical bytes afterwards.
 */
export function parseExpressionAst(
  input: unknown,
): ParseResult<ExpressionNode, ExpressionAstError> {
  const result = validateNode(input, 1);
  if (!result.ok) return fail({ ...result.error, input });
  return result;
}

/**
 * Printing precedence, higher binds tighter: additive 1, multiplicative 2,
 * unary negation 3, exponentiation 4, atoms 5. Exponentiation is
 * right-associative; every other binary operator is left-associative.
 */
const PRECEDENCE_ADDITIVE = 1;
const PRECEDENCE_MULTIPLICATIVE = 2;
const PRECEDENCE_UNARY = 3;
const PRECEDENCE_POWER = 4;
const PRECEDENCE_ATOM = 5;

function operatorPrecedence(operator: BinaryOperator): number {
  if (operator === "+" || operator === "-") return PRECEDENCE_ADDITIVE;
  if (operator === "^") return PRECEDENCE_POWER;
  return PRECEDENCE_MULTIPLICATIVE;
}

function nodePrecedence(node: ExpressionNode): number {
  switch (node.kind) {
    case "number":
    case "unitLiteral":
    case "identifier":
    case "call":
      return PRECEDENCE_ATOM;
    case "unary":
      return PRECEDENCE_UNARY;
    case "binary":
      return operatorPrecedence(node.operator);
  }
}

/**
 * A decimal-only rendering of a finite magnitude. The V1 number token has no
 * exponent syntax, so the exponential forms `String` emits below 1e-6 and at
 * or above 1e21 are expanded to the same number written as a plain decimal
 * (`5e-7` → `0.0000005`, `1e+21` → `1000000000000000000000.0`), and plain
 * integers beyond the safe-integer range — which the lexer refuses as
 * integers — gain a `.0` decimal tail. Everyday magnitudes (plain decimals
 * and safe integers) print byte-identically to `String(value)`.
 */
function formatMagnitude(value: number): string {
  const text = String(value);
  if (text.includes("e")) return expandExponential(text);
  if (!text.includes(".") && !Number.isSafeInteger(value)) {
    return `${text}.0`;
  }
  return text;
}

/**
 * Expands `String(value)`'s exponential form into the same number as a plain
 * decimal: the digit string is unchanged, only the decimal point moves. An
 * expansion that lands on a whole number keeps a `.0` tail unless the result
 * is a safe integer (every double `String` renders exponentially at 1e21 and
 * above is beyond the safe-integer range, so the tail is the norm there).
 */
function expandExponential(text: string): string {
  const match = /^(-?)(\d+)(?:\.(\d+))?e([+-]\d+)$/.exec(text);
  if (match === null) return text;
  const sign = match[1] ?? "";
  const integer = match[2] ?? "0";
  const fraction = match[3] ?? "";
  const exponent = Number(match[4] ?? "0");
  const digits = `${integer}${fraction}`;
  const point = integer.length + exponent;
  const body =
    point <= 0
      ? `0.${"0".repeat(-point)}${digits}`
      : point >= digits.length
        ? `${digits}${"0".repeat(point - digits.length)}`
        : `${digits.slice(0, point)}.${digits.slice(point)}`;
  if (body.includes(".")) return `${sign}${body}`;
  return Number.isSafeInteger(Number(`${sign}${body}`))
    ? `${sign}${body}`
    : `${sign}${body}.0`;
}

/**
 * Renders an AST to canonical expression source: minimal parentheses (only
 * where precedence or associativity requires them), fixed `", "` argument
 * separators, and no whitespace beyond single spaces around binary
 * operators. `parse(print(ast))` always deep-equals `ast`, so printing is a
 * deterministic serialization of the AST.
 */
export function printExpression(node: ExpressionNode): string {
  const print = (current: ExpressionNode): string => {
    switch (current.kind) {
      case "number":
        return formatMagnitude(current.value);
      case "unitLiteral":
        return `${formatMagnitude(current.value)}${current.unit}`;
      case "identifier":
        return current.name;
      case "unary": {
        const operand = print(current.operand);
        const needsParens = nodePrecedence(current.operand) < PRECEDENCE_UNARY;
        return `-${needsParens ? `(${operand})` : operand}`;
      }
      case "binary": {
        const precedence = operatorPrecedence(current.operator);
        const left = print(current.left);
        const right = print(current.right);
        // Parenthesize a child only when its printed form would not reparse
        // as one operand in the child's grammar slot: the left slot of a
        // left-associative operator accepts operands of equal precedence,
        // the right slot does not; exponentiation is right-associative, its
        // left slot is a primary and its right slot a unary expression.
        const leftNeedsParens =
          current.operator === "^"
            ? nodePrecedence(current.left) < PRECEDENCE_ATOM
            : nodePrecedence(current.left) < precedence;
        const rightNeedsParens =
          current.operator === "^"
            ? nodePrecedence(current.right) < PRECEDENCE_UNARY
            : nodePrecedence(current.right) <= precedence;
        return `${leftNeedsParens ? `(${left})` : left} ${
          current.operator
        } ${rightNeedsParens ? `(${right})` : right}`;
      }
      case "call":
        return `${current.callee}(${current.args.map(print).join(", ")})`;
    }
  };
  return print(node);
}

/**
 * The set of parameter names an expression references: every identifier node,
 * deduplicated. Function callees are structurally distinct from identifiers,
 * so `sqrt(area)` depends only on `area`.
 */
export function extractExpressionDependencies(
  node: ExpressionNode,
): ReadonlySet<string> {
  const names = new Set<string>();
  const walk = (current: ExpressionNode): void => {
    switch (current.kind) {
      case "number":
      case "unitLiteral":
        return;
      case "identifier":
        names.add(current.name);
        return;
      case "unary":
        walk(current.operand);
        return;
      case "binary":
        walk(current.left);
        walk(current.right);
        return;
      case "call":
        for (const arg of current.args) walk(arg);
        return;
    }
  };
  walk(node);
  return names;
}

/**
 * A pure, structural identifier rename: every identifier node whose `name`
 * equals `from` is replaced by one carrying `to`; every other node keeps its
 * identity where nothing below it changed, so an AST with no matching
 * identifier renames to ITSELF (callers can compare by reference to skip
 * work). A rename to the same name (`from === to`) is the identity outright:
 * the node returns untouched, so even matching identifiers keep referential
 * identity on the no-op. Function names never match: a call's `callee` is a
 * structurally distinct field pinned to the reserved function set, while the
 * rename targets identifier NODES only — and parameter names are validated
 * non-reserved, so a parameter name and a callee can never even collide as
 * strings.
 */
export function renameExpressionIdentifier(
  node: ExpressionNode,
  from: string,
  to: string,
): ExpressionNode {
  if (from === to) return node;
  switch (node.kind) {
    case "number":
    case "unitLiteral":
      return node;
    case "identifier":
      return node.name === from
        ? Object.freeze({ kind: "identifier", name: to })
        : node;
    case "unary": {
      const operand = renameExpressionIdentifier(node.operand, from, to);
      return operand === node.operand
        ? node
        : Object.freeze({ kind: "unary", operator: node.operator, operand });
    }
    case "binary": {
      const left = renameExpressionIdentifier(node.left, from, to);
      const right = renameExpressionIdentifier(node.right, from, to);
      return left === node.left && right === node.right
        ? node
        : Object.freeze({
            kind: "binary",
            operator: node.operator,
            left,
            right,
          });
    }
    case "call": {
      let changed = false;
      const args = node.args.map((arg) => {
        const renamed = renameExpressionIdentifier(arg, from, to);
        changed = changed || renamed !== arg;
        return renamed;
      });
      return changed
        ? Object.freeze({ kind: "call", callee: node.callee, args })
        : node;
    }
  }
}
