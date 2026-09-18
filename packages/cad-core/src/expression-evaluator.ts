/**
 * Deterministic, dimensionally correct evaluator for expression ASTs.
 *
 * Evaluation walks a frozen {@link ExpressionNode} against an environment —
 * a pure lookup `(name) => value | undefined` supplied by the caller — and
 * returns a canonical-unit {@link AnyDimensionalValue} or a structured
 * failure with a stable code. Nothing executes JavaScript: the evaluator
 * only dispatches over the six AST node kinds.
 *
 * Dimensional semantics (decisions, reusing Phase 4's dimension algebra
 * wherever it applies — never reimplementing it):
 *
 * - `+` `-`: Phase 4 `addValues`/`subtractValues`; same dimension only.
 * - `*` `/`: Phase 4 `multiplyValues`/`divideValues`; results follow the
 *   closed product/quotient tables (`length × length → area`, `area /
 *   length → length`, …). Division by a zero-magnitude divisor is rejected
 *   by Phase 4 with `arithmetic/division-by-zero`.
 * - `%`: same-dimension operands only, result keeps that dimension
 *   (`10.5mm % 3mm → 1.5mm`), computed on canonical magnitudes with
 *   JavaScript remainder semantics. A dimensionless right operand is
 *   rejected because it would make the result unit-dependent; a zero
 *   right operand is rejected as modulo by zero.
 * - `^`: the exponent must be dimensionless. A dimensionless base accepts
 *   any finite exponent. A dimensional base maps through the length-power
 *   algebra (`dimensionless` = L⁰, `length` = L¹, `area` = L², `volume` =
 *   L³): the base power times the exponent must land on a non-negative
 *   integer power at most 3, so `3mm ^ 2 → area`, `9mm2 ^ 0.5 → length`,
 *   `27mm3 ^ (1/3) → length`, and `2mm ^ 4` is rejected (L⁴ is not in the
 *   closed set). `angle` carries no length power, so only the exponents 0
 *   and 1 are accepted for it. Non-real results (`-4 ^ 0.5`) are rejected.
 * - `sqrt`: `x ^ 0.5` through the same algebra, so `sqrt(area) → length`
 *   is supported while `sqrt(length)`, `sqrt(volume)`, and `sqrt(angle)`
 *   are rejected as inexpressible.
 * - `min`/`max`: two or more arguments of the same dimension (units may
 *   differ; comparison is on canonical magnitudes); the extreme argument
 *   wins and is returned in its canonical unit. Ties keep the first
 *   argument.
 * - Unary `-`: any dimension, negated canonical magnitude.
 */

import {
  addValues,
  angle,
  area,
  type AnyDimensionalValue,
  dimensionless,
  divideValues,
  length,
  multiplyValues,
  subtractValues,
  toCanonical,
  valueIn,
  volume,
} from "./dimensional";
import { type ExpressionNode } from "./expression";
import { type ParseFailure, type ParseResult, fail, ok } from "./result";
import {
  type AnyUnit,
  CANONICAL_UNITS,
  type Dimension,
  isAngleUnit,
  isAreaUnit,
  isLengthUnit,
  isVolumeUnit,
} from "./units";

/**
 * Resolves parameter names to their current values. Returns `undefined` for
 * unknown names, which the evaluator rejects with
 * {@link EXPRESSION_EVALUATION_ERROR_CODES.unknownIdentifier}. Implementations
 * must not fall through to prototype chains (scan a collection, or use a
 * `Map`).
 */
export type ExpressionEnvironment = (
  name: string,
) => AnyDimensionalValue | undefined;

/** Stable failure codes produced when evaluation is rejected. */
export const EXPRESSION_EVALUATION_ERROR_CODES = {
  unknownIdentifier: "expression/unknown-identifier",
  moduloIncompatibleDimensions: "expression/modulo-incompatible-dimensions",
  moduloByZero: "expression/modulo-by-zero",
  invalidExponentDimension: "expression/invalid-exponent-dimension",
  invalidExponentValue: "expression/invalid-exponent-value",
  invalidSqrtDimension: "expression/invalid-sqrt-dimension",
  minMaxIncompatibleDimensions: "expression/min-max-incompatible-dimensions",
  nonFiniteResult: "expression/non-finite-result",
  malformedCall: "expression/malformed-call",
} as const;

/**
 * Failure codes of evaluation: the expression-domain codes above plus the
 * three arithmetic codes passed through unchanged when the underlying Phase 4
 * operation rejects its operands.
 */
export type ExpressionEvaluationErrorCode =
  | (typeof EXPRESSION_EVALUATION_ERROR_CODES)[keyof typeof EXPRESSION_EVALUATION_ERROR_CODES]
  | "arithmetic/incompatible-dimensions"
  | "arithmetic/division-by-zero"
  | "arithmetic/non-finite-result";

/** Structured failure describing why an expression was not evaluated. */
export interface ExpressionEvaluationError extends ParseFailure {
  readonly code: ExpressionEvaluationErrorCode;
}

type EvalOutcome = ParseResult<AnyDimensionalValue, ExpressionEvaluationError>;

type BinaryNode = Extract<ExpressionNode, { kind: "binary" }>;
type CallNode = Extract<ExpressionNode, { kind: "call" }>;

function reject(
  code: ExpressionEvaluationErrorCode,
  message: string,
  node: ExpressionNode,
): EvalOutcome {
  return fail({ code, message, input: node });
}

/** Result dimensions indexed by length power (L⁰ … L³). */
const POWER_DIMENSIONS: readonly Dimension[] = [
  "dimensionless",
  "length",
  "area",
  "volume",
];

/** Length power of each dimension; `angle` carries none. */
const LENGTH_POWERS: Readonly<Record<Exclude<Dimension, "angle">, number>> =
  Object.freeze({ dimensionless: 0, length: 1, area: 2, volume: 3 });

/** Absolute tolerance when a computed length power must be an integer; 1e-9 is safe because valid result powers lie in [0, 3]. */
const POWER_INTEGER_TOLERANCE = 1e-9;

function canonicalMagnitude(value: AnyDimensionalValue): number {
  return valueIn(value, CANONICAL_UNITS[value.dimension]);
}

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

/** Builds a value of the dimension a registered unit measures, in that unit. */
function quantityInUnit(magnitude: number, unit: AnyUnit): AnyDimensionalValue {
  if (isLengthUnit(unit)) return length(magnitude, unit);
  if (isAngleUnit(unit)) return angle(magnitude, unit);
  if (isAreaUnit(unit)) return area(magnitude, unit);
  if (isVolumeUnit(unit)) return volume(magnitude, unit);
  return dimensionless(magnitude);
}

function evaluate(
  node: ExpressionNode,
  resolve: ExpressionEnvironment,
): EvalOutcome {
  switch (node.kind) {
    case "number":
      return ok(dimensionless(node.value));
    case "unitLiteral":
      return ok(toCanonical(quantityInUnit(node.value, node.unit)));
    case "identifier": {
      const value = resolve(node.name);
      if (value === undefined) {
        return reject(
          EXPRESSION_EVALUATION_ERROR_CODES.unknownIdentifier,
          `Unknown identifier "${node.name}".`,
          node,
        );
      }
      return ok(value);
    }
    case "unary": {
      const operand = evaluate(node.operand, resolve);
      if (!operand.ok) return operand;
      return ok(
        canonicalQuantity(
          operand.value.dimension,
          -canonicalMagnitude(operand.value),
        ),
      );
    }
    case "binary":
      return evaluateBinary(node, resolve);
    case "call":
      return evaluateCall(node, resolve);
  }
}

function evaluateBinary(
  node: BinaryNode,
  resolve: ExpressionEnvironment,
): EvalOutcome {
  if (node.operator === "%") {
    return evaluateModulo(node, resolve);
  }
  if (node.operator === "^") {
    return evaluatePower(node, resolve);
  }
  const left = evaluate(node.left, resolve);
  if (!left.ok) return left;
  const right = evaluate(node.right, resolve);
  if (!right.ok) return right;
  const outcome =
    node.operator === "+"
      ? addValues(left.value, right.value)
      : node.operator === "-"
        ? subtractValues(left.value, right.value)
        : node.operator === "*"
          ? multiplyValues(left.value, right.value)
          : divideValues(left.value, right.value);
  if (!outcome.ok) {
    return fail({
      code: outcome.error.code,
      message: outcome.error.message,
      input: node,
    });
  }
  return ok(outcome.value);
}

function evaluateModulo(
  node: BinaryNode,
  resolve: ExpressionEnvironment,
): EvalOutcome {
  const left = evaluate(node.left, resolve);
  if (!left.ok) return left;
  const right = evaluate(node.right, resolve);
  if (!right.ok) return right;
  if (left.value.dimension !== right.value.dimension) {
    return reject(
      EXPRESSION_EVALUATION_ERROR_CODES.moduloIncompatibleDimensions,
      `Cannot take the remainder of a ${left.value.dimension} value by a ${right.value.dimension} value; modulo requires same-dimension operands.`,
      node,
    );
  }
  const divisor = canonicalMagnitude(right.value);
  if (divisor === 0) {
    return reject(
      EXPRESSION_EVALUATION_ERROR_CODES.moduloByZero,
      `Cannot take the remainder by a ${right.value.dimension} value of zero magnitude.`,
      node,
    );
  }
  const magnitude = canonicalMagnitude(left.value) % divisor;
  return ok(canonicalQuantity(left.value.dimension, magnitude));
}

function evaluatePower(
  node: BinaryNode,
  resolve: ExpressionEnvironment,
): EvalOutcome {
  const base = evaluate(node.left, resolve);
  if (!base.ok) return base;
  const exponent = evaluate(node.right, resolve);
  if (!exponent.ok) return exponent;
  if (exponent.value.dimension !== "dimensionless") {
    return reject(
      EXPRESSION_EVALUATION_ERROR_CODES.invalidExponentDimension,
      `An exponent must be dimensionless, received ${exponent.value.dimension}.`,
      node,
    );
  }
  const power = canonicalMagnitude(exponent.value);
  const resultDimension = powerResultDimension(base.value.dimension, power);
  if (resultDimension === null) {
    return reject(
      EXPRESSION_EVALUATION_ERROR_CODES.invalidExponentValue,
      `Raising a ${base.value.dimension} value to the power ${String(power)} has no result dimension in the closed dimension algebra.`,
      node,
    );
  }
  const magnitude = Math.pow(canonicalMagnitude(base.value), power);
  if (!Number.isFinite(magnitude)) {
    return reject(
      EXPRESSION_EVALUATION_ERROR_CODES.nonFiniteResult,
      `Raising the given base to the power ${String(power)} does not produce a finite real magnitude.`,
      node,
    );
  }
  return ok(canonicalQuantity(resultDimension, magnitude));
}

/** The result dimension of `base ^ power`, or null when inexpressible. */
function powerResultDimension(
  base: Dimension,
  power: number,
): Dimension | null {
  if (base === "angle") {
    if (power === 0) return "dimensionless";
    if (power === 1) return "angle";
    return null;
  }
  const resultPower = LENGTH_POWERS[base] * power;
  const rounded = Math.round(resultPower);
  const isInteger = Math.abs(resultPower - rounded) <= POWER_INTEGER_TOLERANCE;
  if (!isInteger || rounded < 0 || rounded > 3) return null;
  return POWER_DIMENSIONS[rounded] ?? null;
}

function evaluateCall(
  node: CallNode,
  resolve: ExpressionEnvironment,
): EvalOutcome {
  if (node.callee === "sqrt") {
    return evaluateSqrt(node, resolve);
  }
  return evaluateExtremum(node, resolve);
}

function evaluateSqrt(
  node: CallNode,
  resolve: ExpressionEnvironment,
): EvalOutcome {
  const operandNode = node.args[0];
  if (node.args.length !== 1 || operandNode === undefined) {
    return rejectMalformedCall(node);
  }
  const operand = evaluate(operandNode, resolve);
  if (!operand.ok) return operand;
  const { dimension } = operand.value;
  const resultDimension = powerResultDimension(dimension, 0.5);
  if (resultDimension === null) {
    return reject(
      EXPRESSION_EVALUATION_ERROR_CODES.invalidSqrtDimension,
      `The square root of a ${dimension} value has no result dimension in the closed dimension algebra; sqrt is defined for dimensionless and area values.`,
      node,
    );
  }
  const magnitude = Math.sqrt(canonicalMagnitude(operand.value));
  if (!Number.isFinite(magnitude)) {
    return reject(
      EXPRESSION_EVALUATION_ERROR_CODES.nonFiniteResult,
      "The square root of the given operand is not a finite real magnitude.",
      node,
    );
  }
  return ok(canonicalQuantity(resultDimension, magnitude));
}

function evaluateExtremum(
  node: CallNode,
  resolve: ExpressionEnvironment,
): EvalOutcome {
  const wantMaximum = node.callee === "max";
  const evaluated: AnyDimensionalValue[] = [];
  for (const arg of node.args) {
    const value = evaluate(arg, resolve);
    if (!value.ok) return value;
    evaluated.push(value.value);
  }
  const first = evaluated[0];
  if (first === undefined || evaluated.length < 2) {
    return rejectMalformedCall(node);
  }
  for (const candidate of evaluated) {
    if (candidate.dimension !== first.dimension) {
      return reject(
        EXPRESSION_EVALUATION_ERROR_CODES.minMaxIncompatibleDimensions,
        `${node.callee} requires arguments of one dimension; received a ${candidate.dimension} argument among ${first.dimension} arguments.`,
        node,
      );
    }
  }
  let winner = first;
  let winnerMagnitude = canonicalMagnitude(winner);
  for (const candidate of evaluated.slice(1)) {
    const candidateMagnitude = canonicalMagnitude(candidate);
    if (
      wantMaximum
        ? candidateMagnitude > winnerMagnitude
        : candidateMagnitude < winnerMagnitude
    ) {
      winner = candidate;
      winnerMagnitude = candidateMagnitude;
    }
  }
  return ok(toCanonical(winner));
}

function rejectMalformedCall(node: CallNode): EvalOutcome {
  return reject(
    EXPRESSION_EVALUATION_ERROR_CODES.malformedCall,
    `A call to ${node.callee} must satisfy its arity contract; the node reached evaluation malformed.`,
    node,
  );
}

/**
 * Evaluates an expression to a canonical-unit dimensional value. The result
 * depends only on the AST and the environment (deterministic); every
 * rejection — unknown identifiers, division by zero, dimensionally invalid
 * operations, non-real results — is a structured failure with a stable code.
 */
export function evaluateExpression(
  node: ExpressionNode,
  resolve: ExpressionEnvironment,
): ParseResult<AnyDimensionalValue, ExpressionEvaluationError> {
  return evaluate(node, resolve);
}
