/**
 * Structured CAD diagnostics: severity levels, stable codes, and locations
 * that reference domain objects by their branded ids. Diagnostics are pure
 * data — no UI concepts, no file positions — so every layer above cad-core
 * (regeneration, persistence, viewers, overlays) can render or filter them
 * however it needs.
 */

import { DIMENSIONAL_ERROR_CODES } from "./dimensional";
import { DOCUMENT_ERROR_CODES } from "./document";
import { EXPRESSION_AST_ERROR_CODES } from "./expression";
import { EXPRESSION_EVALUATION_ERROR_CODES } from "./expression-evaluator";
import { EXPRESSION_PARSE_ERROR_CODES } from "./expression-parser";
import { FEATURE_GRAPH_ERROR_CODES } from "./feature-graph";
import { type AnyCadId, ID_ERROR_CODES, ID_GENERATOR_ERROR_CODES, parseAnyCadId } from "./ids";
import { PARAMETER_ERROR_CODES } from "./parameter";
import { type ParseFailure, type ParseResult, fail, ok } from "./result";
import { UNIT_ERROR_CODES } from "./units";

/**
 * Kernel-execution failures (Phase 8): emitted by the feature-executor
 * bridge that lives in `@slopcad/cad-kernel` when it interprets document
 * feature records as kernel operations. The codes are defined here — the
 * diagnostics registry's one source of truth — because diagnostics are
 * cad-core data the bridge must produce, while kernel *operation* failures
 * (`kernel/invalid-length` and friends) stay in the kernel contract.
 */
const KERNEL_EXECUTION_ERROR_CODES = {
  unknownFeatureKind: "kernel/unknown-feature-kind",
  featureInputInvalid: "kernel/feature-input-invalid",
  parameterInvalid: "kernel/parameter-invalid",
  operationFailed: "kernel/operation-failed",
} as const;

/** Severity levels in increasing order of seriousness. */
export const DIAGNOSTIC_SEVERITIES = ["info", "warning", "error", "fatal"] as const;

export type DiagnosticSeverity = (typeof DIAGNOSTIC_SEVERITIES)[number];

const SEVERITY_SET: ReadonlySet<string> = new Set(DIAGNOSTIC_SEVERITIES);

/** Type guard for untrusted severity values. */
export function isDiagnosticSeverity(
  input: unknown,
): input is DiagnosticSeverity {
  return typeof input === "string" && SEVERITY_SET.has(input);
}

/** Numeric rank of each severity; higher means more serious. */
export const DIAGNOSTIC_SEVERITY_ORDER: Readonly<Record<DiagnosticSeverity, number>> =
  Object.freeze({ info: 0, warning: 1, error: 2, fatal: 3 });

/** Compares two severities; negative when `a` is less serious than `b`. */
export function compareSeverities(
  a: DiagnosticSeverity,
  b: DiagnosticSeverity,
): number {
  return DIAGNOSTIC_SEVERITY_ORDER[a] - DIAGNOSTIC_SEVERITY_ORDER[b];
}

/**
 * Registry of stable diagnostic codes, formatted `<domain>/<name>`
 * (e.g. `id/wrong-prefix`). Phase 3 seeds the id-validation domain; later
 * phases append their own domains here so every emitted code is documented
 * in one place. Never rename an existing code — they are persisted data.
 */
export const DIAGNOSTIC_CODES = {
  idNotAString: ID_ERROR_CODES.notAString,
  idEmpty: ID_ERROR_CODES.empty,
  idWrongPrefix: ID_ERROR_CODES.wrongPrefix,
  idInvalidPayload: ID_ERROR_CODES.invalidPayload,
  idGeneratorExhausted: ID_GENERATOR_ERROR_CODES.exhausted,
  unitNotAString: UNIT_ERROR_CODES.notAString,
  unitUnknown: UNIT_ERROR_CODES.unknown,
  valueNotARecord: DIMENSIONAL_ERROR_CODES.notARecord,
  valueUnknownDimension: DIMENSIONAL_ERROR_CODES.unknownDimension,
  valueUnitDimensionMismatch: DIMENSIONAL_ERROR_CODES.unitDimensionMismatch,
  valueInvalidMagnitude: DIMENSIONAL_ERROR_CODES.invalidMagnitude,
  valueNonFiniteMagnitude: DIMENSIONAL_ERROR_CODES.nonFiniteMagnitude,
  arithmeticIncompatibleDimensions:
    DIMENSIONAL_ERROR_CODES.incompatibleDimensions,
  arithmeticDivisionByZero: DIMENSIONAL_ERROR_CODES.divisionByZero,
  arithmeticNonFiniteResult: DIMENSIONAL_ERROR_CODES.nonFiniteResult,
  expressionAstMalformed: EXPRESSION_AST_ERROR_CODES.malformed,
  expressionEmpty: EXPRESSION_PARSE_ERROR_CODES.empty,
  expressionUnexpectedCharacter:
    EXPRESSION_PARSE_ERROR_CODES.unexpectedCharacter,
  expressionInvalidNumber: EXPRESSION_PARSE_ERROR_CODES.invalidNumber,
  expressionUnknownUnit: EXPRESSION_PARSE_ERROR_CODES.unknownUnit,
  expressionUnexpectedToken: EXPRESSION_PARSE_ERROR_CODES.unexpectedToken,
  expressionUnexpectedEndOfInput:
    EXPRESSION_PARSE_ERROR_CODES.unexpectedEndOfInput,
  expressionMissingClosingParenthesis:
    EXPRESSION_PARSE_ERROR_CODES.missingClosingParenthesis,
  expressionUnknownFunction: EXPRESSION_PARSE_ERROR_CODES.unknownFunction,
  expressionInvalidFunctionArity:
    EXPRESSION_PARSE_ERROR_CODES.invalidFunctionArity,
  expressionTooDeep: EXPRESSION_PARSE_ERROR_CODES.tooDeep,
  expressionUnknownIdentifier:
    EXPRESSION_EVALUATION_ERROR_CODES.unknownIdentifier,
  expressionModuloIncompatibleDimensions:
    EXPRESSION_EVALUATION_ERROR_CODES.moduloIncompatibleDimensions,
  expressionModuloByZero: EXPRESSION_EVALUATION_ERROR_CODES.moduloByZero,
  expressionInvalidExponentDimension:
    EXPRESSION_EVALUATION_ERROR_CODES.invalidExponentDimension,
  expressionInvalidExponentValue:
    EXPRESSION_EVALUATION_ERROR_CODES.invalidExponentValue,
  expressionInvalidSqrtDimension:
    EXPRESSION_EVALUATION_ERROR_CODES.invalidSqrtDimension,
  expressionMinMaxIncompatibleDimensions:
    EXPRESSION_EVALUATION_ERROR_CODES.minMaxIncompatibleDimensions,
  expressionNonFiniteResult:
    EXPRESSION_EVALUATION_ERROR_CODES.nonFiniteResult,
  expressionMalformedCall: EXPRESSION_EVALUATION_ERROR_CODES.malformedCall,
  parameterMalformed: PARAMETER_ERROR_CODES.malformed,
  parameterIdInvalid: PARAMETER_ERROR_CODES.idInvalid,
  parameterIdConflict: PARAMETER_ERROR_CODES.idConflict,
  parameterNameInvalid: PARAMETER_ERROR_CODES.nameInvalid,
  parameterNameReserved: PARAMETER_ERROR_CODES.nameReserved,
  parameterNameConflict: PARAMETER_ERROR_CODES.nameConflict,
  parameterInvalidValue: PARAMETER_ERROR_CODES.invalidValue,
  parameterInvalidExpression: PARAMETER_ERROR_CODES.invalidExpression,
  parameterInvalidMetadata: PARAMETER_ERROR_CODES.invalidMetadata,
  parameterNotFound: PARAMETER_ERROR_CODES.notFound,
  documentMalformed: DOCUMENT_ERROR_CODES.malformed,
  documentVersionUnsupported: DOCUMENT_ERROR_CODES.versionUnsupported,
  documentGeneratorStateInvalid: DOCUMENT_ERROR_CODES.generatorStateInvalid,
  documentGeneratorExhausted: DOCUMENT_ERROR_CODES.generatorExhausted,
  documentIdInvalid: DOCUMENT_ERROR_CODES.idInvalid,
  documentIdConflict: DOCUMENT_ERROR_CODES.idConflict,
  documentBodyNameInvalid: DOCUMENT_ERROR_CODES.bodyNameInvalid,
  documentFeatureKindInvalid: DOCUMENT_ERROR_CODES.featureKindInvalid,
  documentInputKindInvalid: DOCUMENT_ERROR_CODES.inputKindInvalid,
  documentInputUnknown: DOCUMENT_ERROR_CODES.inputUnknown,
  documentInputOrderInvalid: DOCUMENT_ERROR_CODES.inputOrderInvalid,
  documentOutputUnknown: DOCUMENT_ERROR_CODES.outputUnknown,
  documentNotFound: DOCUMENT_ERROR_CODES.notFound,
  documentInUse: DOCUMENT_ERROR_CODES.inUse,
  graphCycle: FEATURE_GRAPH_ERROR_CODES.cycle,
  kernelUnknownFeatureKind: KERNEL_EXECUTION_ERROR_CODES.unknownFeatureKind,
  kernelFeatureInputInvalid: KERNEL_EXECUTION_ERROR_CODES.featureInputInvalid,
  kernelParameterInvalid: KERNEL_EXECUTION_ERROR_CODES.parameterInvalid,
  kernelOperationFailed: KERNEL_EXECUTION_ERROR_CODES.operationFailed,
} as const;

export type DiagnosticCode = (typeof DIAGNOSTIC_CODES)[keyof typeof DIAGNOSTIC_CODES];

const CODE_SET: ReadonlySet<string> = new Set(Object.values(DIAGNOSTIC_CODES));

/** Type guard for untrusted diagnostic codes. */
export function isDiagnosticCode(input: unknown): input is DiagnosticCode {
  return typeof input === "string" && CODE_SET.has(input);
}

/**
 * Where a diagnostic applies: the domain object it is about, identified by
 * its branded id, plus any other ids involved in the problem. Referencing
 * domain ids (rather than UI or file positions) keeps diagnostics meaningful
 * across viewports, sessions, and serialized documents.
 */
export interface DiagnosticLocation {
  readonly primary: AnyCadId;
  readonly related?: readonly AnyCadId[];
}

/** JSON-safe primitive values allowed in {@link Diagnostic.data}. */
export type DiagnosticDataValue = string | number | boolean | null;

/**
 * A single structured CAD diagnostic. Every field is plain serializable data,
 * so a diagnostic survives `value → JSON → value` unchanged.
 */
export interface Diagnostic {
  readonly severity: DiagnosticSeverity;
  readonly code: DiagnosticCode;
  readonly message: string;
  readonly location: DiagnosticLocation;
  readonly data?: Readonly<Record<string, DiagnosticDataValue>>;
}

/** Failure code carried by {@link DiagnosticParseError}. */
export type DiagnosticParseErrorCode = "diagnostic/malformed";

/** Structured failure describing why input was rejected as a diagnostic. */
export interface DiagnosticParseError extends ParseFailure {
  readonly code: DiagnosticParseErrorCode;
}

function malformed(message: string, input: unknown): DiagnosticParseError {
  return { code: "diagnostic/malformed", message, input };
}

function isPlainRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}

function isDataValue(input: unknown): input is DiagnosticDataValue {
  if (typeof input === "number") return Number.isFinite(input);
  return (
    typeof input === "string" ||
    typeof input === "boolean" ||
    input === null
  );
}

function parseLocation(
  input: unknown,
): ParseResult<DiagnosticLocation, DiagnosticParseError> {
  if (!isPlainRecord(input)) {
    return fail(
      malformed("A diagnostic location must be a plain object.", input),
    );
  }
  const primary = parseAnyCadId(input.primary);
  if (!primary.ok) {
    return fail(
      malformed(
        `A diagnostic location needs a valid primary CAD id: ${primary.error.message}`,
        input,
      ),
    );
  }
  const { related } = input;
  if (related === undefined) {
    return ok({ primary: primary.value.id });
  }
  if (!Array.isArray(related)) {
    return fail(
      malformed("Diagnostic location.related must be an array of CAD ids.", input),
    );
  }
  const relatedIds: AnyCadId[] = [];
  for (const entry of related) {
    const parsed = parseAnyCadId(entry);
    if (!parsed.ok) {
      return fail(
        malformed(
          `Diagnostic location.related contains an invalid CAD id: ${parsed.error.message}`,
          input,
        ),
      );
    }
    relatedIds.push(parsed.value.id);
  }
  return ok({ primary: primary.value.id, related: relatedIds });
}

function parseDataField(
  data: unknown,
): ParseResult<Readonly<Record<string, DiagnosticDataValue>>, DiagnosticParseError> {
  if (!isPlainRecord(data)) {
    return fail(
      malformed(
        "Diagnostic data must be a plain object of string, finite number, boolean, or null values.",
        data,
      ),
    );
  }
  const parsedData: Record<string, DiagnosticDataValue> = {};
  for (const [key, value] of Object.entries(data)) {
    if (!isDataValue(value)) {
      return fail(
        malformed(
          `Diagnostic data["${key}"] must be a string, finite number, boolean, or null.`,
          data,
        ),
      );
    }
    parsedData[key] = value;
  }
  return ok(parsedData);
}

/**
 * Parses untrusted input (e.g. diagnostics revived from persisted JSON) as a
 * {@link Diagnostic}. Known fields are validated strictly; unknown fields are
 * ignored so future format versions deserialize without data corruption. The
 * returned value is canonical: it deep-equals its JSON round-trip.
 */
export function parseDiagnostic(
  input: unknown,
): ParseResult<Diagnostic, DiagnosticParseError> {
  if (!isPlainRecord(input)) {
    return fail(malformed("A diagnostic must be a plain object.", input));
  }
  const { severity, code, message, location, data } = input;
  if (!isDiagnosticSeverity(severity)) {
    return fail(
      malformed(
        `Diagnostic severity must be one of: ${DIAGNOSTIC_SEVERITIES.join(", ")}.`,
        input,
      ),
    );
  }
  if (!isDiagnosticCode(code)) {
    return fail(
      malformed(
        "Diagnostic code must be one of the codes registered in DIAGNOSTIC_CODES.",
        input,
      ),
    );
  }
  if (typeof message !== "string" || message.length === 0) {
    return fail(
      malformed("Diagnostic message must be a non-empty string.", input),
    );
  }
  const parsedLocation = parseLocation(location);
  if (!parsedLocation.ok) return parsedLocation;
  if (data === undefined) {
    return ok({ severity, code, message, location: parsedLocation.value });
  }
  const parsedData = parseDataField(data);
  if (!parsedData.ok) return parsedData;
  return ok({
    severity,
    code,
    message,
    location: parsedLocation.value,
    data: parsedData.value,
  });
}
