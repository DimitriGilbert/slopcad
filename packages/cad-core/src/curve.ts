/**
 * 3D curve entities (Phase 47): the document-resident record of a
 * free-standing curve — an interpolated spline through points, a
 * control-point spline, a helix/spiral (generalizing Phase 40's embedded
 * spine into a first-class entity), or an equation-driven curve evaluated
 * by the expression engine. The ROADMAP's risk ruling is baked into the
 * shape: a curve is a RECORD plus a kernel WIRE, never a body — the
 * payload below is the single schema both sides share (the document stores
 * it verbatim; the kernel contract's `wire` vocabulary consumes it), so
 * there is exactly one source of truth for what a curve IS.
 *
 * ## Kinds and their parametrizations (documented, deterministic)
 *
 * - `interpolated-spline`: a natural cubic spline through the declared
 *   points, chord-length parameterized — the curve passes through every
 *   declared point exactly (the round-trip fixture pins this at the
 *   knots). At least two distinct points.
 * - `control-spline`: a uniform cubic B-spline whose curve APPROACHES the
 *   control polygon (it does not pass through interior poles — the
 *   authoring distinction the two kinds exist to carry). At least two
 *   control points.
 * - `helix`: the Phase 40 spine parametrization verbatim —
 *   `p(t) = R(t)(cos θ(t) x̂ + sin θ(t) ŷ) + h(t) ẑ`, `θ(t) = θ₀ +
 *   H·2π·turns·t`, `h(t) = pitch·turns·t`, `R(t) = radius + taper·t` —
 *   placed at `origin` along `axis` (unit-length; the frame's secondary
 *   axis is derived deterministically). Zero pitch with taper is the flat
 *   spiral; zero pitch AND zero taper is a circle, which rejects (the
 *   planar machinery owns circles).
 * - `equation`: `t ∈ [tMin, tMax]` (dimensionless) with `x`/`y`/`z`
 *   expression sources parsed by the shared expression parser and
 *   evaluated against the environment binding `t` dimensionless; every
 *   coordinate expression must evaluate to a LENGTH (mm magnitude). The
 *   parse and dimension verdicts are part of the record's own validation,
 *   so a bad equation never enters a document.
 *
 * Every payload is JSON-safe in the fixed key orders below — two equal
 * curves serialize to identical bytes (the native format's determinism
 * law). {@link parseSerializedCurve} validates untrusted input with
 * structured codes; {@link curveRecordProblems} carries the semantic
 * battery the document and the kernel validators share.
 */

import {
  type AngleValue,
  type LengthValue,
  type SerializedDimensionalValue,
  dimensionless,
  parseDimensionalValue,
  serializeDimensionalValue,
} from "./dimensional";
import { type ExpressionNode } from "./expression";
import {
  EXPRESSION_EVALUATION_ERROR_CODES,
  evaluateExpression,
} from "./expression-evaluator";
import { parseExpression } from "./expression-parser";
import { type ParseResult, fail, ok } from "./result";
import { factorToCanonical } from "./units";

/** A 3D point in millimetres (the record's canonical length unit). */
export type CurvePoint3 = readonly [number, number, number];

/**
 * The serialized dimensional form shared by every length/angle field of a
 * curve payload: `{ dimension, unit, value }` exactly as
 * {@link serializeDimensionalValue} emits it.
 */
export type CurveDimensional = SerializedDimensionalValue;

/** The interpolated spline payload: points the curve passes through. */
export interface InterpolatedSplinePayload {
  readonly kind: "interpolated-spline";
  readonly points: readonly CurvePoint3[];
}

/** The control-point spline payload: uniform cubic B-spline poles. */
export interface ControlSplinePayload {
  readonly kind: "control-spline";
  readonly points: readonly CurvePoint3[];
}

/** The helix/spiral payload: the Phase 40 spine, placed in 3D. */
export interface HelixCurvePayload {
  readonly kind: "helix";
  readonly radius: CurveDimensional;
  readonly pitch: CurveDimensional;
  readonly turns: number;
  readonly handedness: 1 | -1;
  readonly startAngle: CurveDimensional;
  readonly taper?: CurveDimensional;
  readonly origin?: CurvePoint3;
  readonly axis?: CurvePoint3;
}

/** The equation-driven curve payload: parameter range + expressions. */
export interface EquationCurvePayload {
  readonly kind: "equation";
  readonly tMin: number;
  readonly tMax: number;
  readonly x: string;
  readonly y: string;
  readonly z: string;
}

/** The canonical serialized curve payload (JSON-safe, fixed key orders). */
export type SerializedCurve =
  | InterpolatedSplinePayload
  | ControlSplinePayload
  | HelixCurvePayload
  | EquationCurvePayload;

/** Stable failure codes produced when a curve payload is rejected. */
export const CURVE_ERROR_CODES = {
  notAnObject: "curve/not-an-object",
  unknownKind: "curve/unknown-kind",
  invalidPoints: "curve/invalid-points",
  invalidHelixField: "curve/invalid-helix-field",
  invalidPlacement: "curve/invalid-placement",
  invalidParameterRange: "curve/invalid-parameter-range",
  invalidExpressionSource: "curve/invalid-expression-source",
  expressionNotLength: "curve/expression-not-length",
} as const;

export type CurveErrorCode =
  (typeof CURVE_ERROR_CODES)[keyof typeof CURVE_ERROR_CODES];

/** Structured failure describing why a curve payload was rejected. */
export interface CurveParseError {
  readonly code: CurveErrorCode;
  readonly message: string;
  readonly input: unknown;
}

function curveError(
  code: CurveErrorCode,
  message: string,
  input: unknown,
): ParseResult<never, CurveParseError> {
  return fail({ code, message, input });
}

function isPlainRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}

function isFiniteNumber(input: unknown): input is number {
  return typeof input === "number" && Number.isFinite(input);
}

/**
 * The millimetre magnitude of a serialized length field. The payload's
 * dimension was validated as `length` at parse time, so the dimensional
 * round trip always succeeds; a malformed value still answers `NaN`, which
 * every caller's finiteness battery rejects.
 */
function lengthFieldMm(field: CurveDimensional): number {
  const parsed = parseDimensionalValue(field);
  if (!parsed.ok || parsed.value.dimension !== "length") return Number.NaN;
  return parsed.value.value * factorToCanonical(parsed.value.unit);
}

function parsePoint3(
  input: unknown,
  field: string,
): ParseResult<CurvePoint3, CurveParseError> {
  if (!Array.isArray(input) || input.length !== 3) {
    return curveError(
      CURVE_ERROR_CODES.invalidPoints,
      `The curve field "${field}" must be an array of exactly three finite numbers.`,
      input,
    );
  }
  const values: number[] = [];
  for (const component of input) {
    if (!isFiniteNumber(component)) {
      return curveError(
        CURVE_ERROR_CODES.invalidPoints,
        `The curve field "${field}" must contain only finite numbers.`,
        input,
      );
    }
    values.push(component);
  }
  const x = values[0];
  const y = values[1];
  const z = values[2];
  if (x === undefined || y === undefined || z === undefined) {
    return curveError(
      CURVE_ERROR_CODES.invalidPoints,
      `The curve field "${field}" must contain exactly three components.`,
      input,
    );
  }
  return ok([x, y, z]);
}

function parsePointList(
  input: unknown,
  field: string,
): ParseResult<readonly CurvePoint3[], CurveParseError> {
  if (!Array.isArray(input) || input.length < 2) {
    return curveError(
      CURVE_ERROR_CODES.invalidPoints,
      `The curve field "${field}" must be an array of at least two [x, y, z] points.`,
      input,
    );
  }
  const points: CurvePoint3[] = [];
  for (const entry of input) {
    const point = parsePoint3(entry, field);
    if (!point.ok) return point;
    points.push(point.value);
  }
  return ok(points);
}

function parseCurveDimensional(
  input: unknown,
  field: string,
  wantDimension: "length" | "angle",
): ParseResult<CurveDimensional, CurveParseError> {
  const parsed = parseDimensionalValue(input);
  if (!parsed.ok || parsed.value.dimension !== wantDimension) {
    return curveError(
      CURVE_ERROR_CODES.invalidHelixField,
      `The curve field "${field}" must be a serialized ${wantDimension} dimensional value.`,
      input,
    );
  }
  return ok(serializeDimensionalValue(parsed.value));
}

/**
 * Parses untrusted input as a {@link SerializedCurve}. Every field is
 * validated strictly with a stable failure code; unknown extra fields are
 * ignored so future format versions deserialize without corruption (the
 * datum discipline).
 */
export function parseSerializedCurve(
  input: unknown,
): ParseResult<SerializedCurve, CurveParseError> {
  if (!isPlainRecord(input)) {
    return curveError(
      CURVE_ERROR_CODES.notAnObject,
      "A curve payload must be a plain object.",
      input,
    );
  }
  if (input.kind === "interpolated-spline" || input.kind === "control-spline") {
    const points = parsePointList(input.points, `${input.kind}.points`);
    if (!points.ok) return points;
    return ok({ kind: input.kind, points: points.value });
  }
  if (input.kind === "helix") {
    const radius = parseCurveDimensional(
      input.radius,
      "helix.radius",
      "length",
    );
    if (!radius.ok) return radius;
    const pitch = parseCurveDimensional(input.pitch, "helix.pitch", "length");
    if (!pitch.ok) return pitch;
    const startAngle = parseCurveDimensional(
      input.startAngle,
      "helix.startAngle",
      "angle",
    );
    if (!startAngle.ok) return startAngle;
    const turns = input.turns;
    if (!isFiniteNumber(turns) || turns <= 0) {
      return curveError(
        CURVE_ERROR_CODES.invalidHelixField,
        "The helix turns must be a positive finite number.",
        input.turns,
      );
    }
    if (input.handedness !== 1 && input.handedness !== -1) {
      return curveError(
        CURVE_ERROR_CODES.invalidHelixField,
        "The helix handedness must be +1 (right) or −1 (left).",
        input.handedness,
      );
    }
    let taper: CurveDimensional | undefined;
    if (input.taper !== undefined) {
      const parsedTaper = parseCurveDimensional(
        input.taper,
        "helix.taper",
        "length",
      );
      if (!parsedTaper.ok) return parsedTaper;
      taper = parsedTaper.value;
    }
    let origin: CurvePoint3 | undefined;
    if (input.origin !== undefined) {
      const parsedOrigin = parsePoint3(input.origin, "helix.origin");
      if (!parsedOrigin.ok) return parsedOrigin;
      origin = parsedOrigin.value;
    }
    let axis: CurvePoint3 | undefined;
    if (input.axis !== undefined) {
      const parsedAxis = parsePoint3(input.axis, "helix.axis");
      if (!parsedAxis.ok) return parsedAxis;
      axis = parsedAxis.value;
    }
    return ok({
      kind: "helix",
      radius: radius.value,
      pitch: pitch.value,
      turns,
      handedness: input.handedness,
      startAngle: startAngle.value,
      ...(taper === undefined ? {} : { taper }),
      ...(origin === undefined ? {} : { origin }),
      ...(axis === undefined ? {} : { axis }),
    });
  }
  if (input.kind === "equation") {
    const tMin = input.tMin;
    const tMax = input.tMax;
    if (!isFiniteNumber(tMin) || !isFiniteNumber(tMax) || !(tMax > tMin)) {
      return curveError(
        CURVE_ERROR_CODES.invalidParameterRange,
        "The equation parameter range must satisfy tMax > tMin with finite values.",
        input.tMin,
      );
    }
    const sources: Partial<Record<"x" | "y" | "z", string>> = {};
    for (const field of ["x", "y", "z"] as const) {
      const source = input[field];
      if (typeof source !== "string" || source.trim().length === 0) {
        return curveError(
          CURVE_ERROR_CODES.invalidExpressionSource,
          `The equation curve's "${field}" expression must be a non-empty string.`,
          source,
        );
      }
      const parsed = parseExpression(source);
      if (!parsed.ok) {
        return curveError(
          CURVE_ERROR_CODES.invalidExpressionSource,
          `The equation curve's "${field}" expression does not parse: ${parsed.error.message}`,
          source,
        );
      }
      sources[field] = source;
    }
    const x = sources.x;
    const y = sources.y;
    const z = sources.z;
    if (x === undefined || y === undefined || z === undefined) {
      return curveError(
        CURVE_ERROR_CODES.invalidExpressionSource,
        "The equation curve's coordinate expressions could not be read.",
        input,
      );
    }
    return ok({ kind: "equation", tMin, tMax, x, y, z });
  }
  return curveError(
    CURVE_ERROR_CODES.unknownKind,
    "A curve payload must carry one of the known curve kinds.",
    input.kind,
  );
}

/** Helper for building a helix payload from units-typed values. */
export function helixCurvePayload(input: {
  readonly radius: LengthValue;
  readonly pitch: LengthValue;
  readonly turns: number;
  readonly handedness: 1 | -1;
  readonly startAngle: AngleValue;
  readonly taper?: LengthValue;
  readonly origin?: CurvePoint3;
  readonly axis?: CurvePoint3;
}): HelixCurvePayload {
  return {
    kind: "helix",
    radius: serializeDimensionalValue(input.radius),
    pitch: serializeDimensionalValue(input.pitch),
    turns: input.turns,
    handedness: input.handedness,
    startAngle: serializeDimensionalValue(input.startAngle),
    ...(input.taper === undefined
      ? {}
      : { taper: serializeDimensionalValue(input.taper) }),
    ...(input.origin === undefined ? {} : { origin: input.origin }),
    ...(input.axis === undefined ? {} : { axis: input.axis }),
  };
}

/**
 * One semantic problem of a structurally parsed curve (the battery the
 * document validator and the kernel validators share): a stable machine
 * code plus a human sentence.
 */
export interface CurveProblem {
  readonly code: CurveErrorCode;
  readonly message: string;
}

function distance3(a: CurvePoint3, b: CurvePoint3): number {
  const dx = a[0] - b[0];
  const dy = a[1] - b[1];
  const dz = a[2] - b[2];
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/** The minimum spacing two curve points must keep to be distinct (mm). */
export const CURVE_POINT_MIN_SPACING_MM = 1e-9;

/**
 * The semantic battery: distinct-point spacing for the spline kinds, the
 * Phase 40 helix degeneracy rules (positive radius everywhere, not both
 * pitch and taper zero), the axis's non-zero length, and — for equation
 * curves — that every coordinate expression parses once more and evaluates
 * to a LENGTH at both range endpoints (the dimension verdict; `t` is the
 * only binding). Returns `null` when the curve is problem-free.
 */
export function curveRecordProblems(curve: SerializedCurve): CurveProblem[] {
  const problems: CurveProblem[] = [];
  if (curve.kind === "interpolated-spline" || curve.kind === "control-spline") {
    for (let index = 1; index < curve.points.length; index += 1) {
      const previous = curve.points[index - 1];
      const current = curve.points[index];
      if (previous === undefined || current === undefined) continue;
      if (distance3(previous, current) < CURVE_POINT_MIN_SPACING_MM) {
        problems.push({
          code: CURVE_ERROR_CODES.invalidPoints,
          message: `The ${curve.kind} has points ${String(index - 1)} and ${String(index)} closer than ${String(CURVE_POINT_MIN_SPACING_MM)} mm; curve points must be distinct.`,
        });
      }
    }
    return problems;
  }
  if (curve.kind === "helix") {
    const radiusMm = lengthFieldMm(curve.radius);
    const pitchMm = lengthFieldMm(curve.pitch);
    const taperMm = curve.taper === undefined ? 0 : lengthFieldMm(curve.taper);
    if (!(radiusMm > 0) || !(radiusMm + taperMm > 0)) {
      problems.push({
        code: CURVE_ERROR_CODES.invalidHelixField,
        message:
          "The helix radius must stay strictly positive over the whole spine (radius and radius+taper both > 0).",
      });
    }
    if (pitchMm === 0 && taperMm === 0) {
      problems.push({
        code: CURVE_ERROR_CODES.invalidHelixField,
        message:
          "A helix with zero pitch and zero taper is a circle; the planar curve machinery owns circles.",
      });
    }
    if (curve.axis !== undefined) {
      const norm = Math.sqrt(
        curve.axis[0] * curve.axis[0] +
          curve.axis[1] * curve.axis[1] +
          curve.axis[2] * curve.axis[2],
      );
      if (!(norm > 0)) {
        problems.push({
          code: CURVE_ERROR_CODES.invalidPlacement,
          message:
            "The helix axis must be a non-zero vector; it is normalized internally.",
        });
      }
    }
    return problems;
  }
  const bindings: readonly [string, string][] = [
    ["x", curve.x],
    ["y", curve.y],
    ["z", curve.z],
  ];
  // The dimension verdict must hold along the whole range; the endpoints
  // plus the midpoint are the sampled witnesses (the length dimension is
  // structural in the AST, so three witnesses decide it for every
  // well-formed expression the parser accepts).
  for (const [field, source] of bindings) {
    const parsed = parseExpression(source);
    if (!parsed.ok) {
      problems.push({
        code: CURVE_ERROR_CODES.invalidExpressionSource,
        message: `The equation curve's "${field}" expression does not parse: ${parsed.error.message}`,
      });
      continue;
    }
    for (const t of [curve.tMin, (curve.tMin + curve.tMax) / 2, curve.tMax]) {
      const outcome = evaluateExpression(parsed.value, (name) =>
        name === "t" ? dimensionless(t) : undefined,
      );
      if (!outcome.ok) {
        problems.push({
          code: CURVE_ERROR_CODES.expressionNotLength,
          message: `The equation curve's "${field}" expression fails at t = ${String(t)}: ${outcome.error.message}`,
        });
        break;
      }
      if (outcome.value.dimension !== "length") {
        problems.push({
          code: CURVE_ERROR_CODES.expressionNotLength,
          message: `The equation curve's "${field}" expression must evaluate to a length; it evaluates to a ${outcome.value.dimension}.`,
        });
        break;
      }
    }
  }
  return problems;
}

/**
 * The parsed ASTs of an equation curve's coordinate expressions, for
 * consumers that evaluate at many parameters without re-parsing (the
 * kernel's station walk). Assumes {@link curveRecordProblems} accepted the
 * curve; a parse failure here is impossible for a problem-free record.
 */
export interface EquationCurveAst {
  readonly x: ExpressionNode;
  readonly y: ExpressionNode;
  readonly z: ExpressionNode;
}

/** Parses an equation curve's expressions (see {@link EquationCurveAst}). */
export function parseEquationCurveAst(
  curve: EquationCurvePayload,
): ParseResult<EquationCurveAst, CurveParseError> {
  const parsed: Partial<Record<"x" | "y" | "z", ExpressionNode>> = {};
  for (const field of ["x", "y", "z"] as const) {
    const source = curve[field];
    const outcome = parseExpression(source);
    if (!outcome.ok) {
      return curveError(
        CURVE_ERROR_CODES.invalidExpressionSource,
        `The equation curve's "${field}" expression does not parse: ${outcome.error.message}`,
        source,
      );
    }
    parsed[field] = outcome.value;
  }
  const x = parsed.x;
  const y = parsed.y;
  const z = parsed.z;
  if (x === undefined || y === undefined || z === undefined) {
    return curveError(
      CURVE_ERROR_CODES.invalidExpressionSource,
      "The equation curve ASTs could not be prepared.",
      curve,
    );
  }
  return ok({ x, y, z });
}

/** Exposed for the evaluator-binding contract the kernel reuses. */
export const CURVE_EQUATION_IDENTIFIER = "t";

/** The evaluator error code surfaced for an unknown equation identifier. */
export const CURVE_EQUATION_UNKNOWN_IDENTIFIER =
  EXPRESSION_EVALUATION_ERROR_CODES.unknownIdentifier;
