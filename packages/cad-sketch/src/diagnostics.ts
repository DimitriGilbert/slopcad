/**
 * Structured diagnostics for the sketch domain: severity levels, stable
 * `sketch/*` codes, and references to sketch objects by their branded ids.
 *
 * The shape mirrors cad-core's `Diagnostic` convention (pure data, stable
 * `<domain>/<name>` codes, JSON-safe payload values) but references sketch
 * entity/constraint ids rather than cad-core document ids, so solver
 * diagnostics stay meaningful inside a feature without leaking kernel or
 * solver internals.
 */

import { type ParseResult, isDiagnosticSeverity } from "@slopcad/cad-core";
import type { SketchConstraintId, SketchEntityId } from "./sketch-ids";

import {
  SKETCH_ID_ERROR_CODES,
  SKETCH_ID_GENERATOR_ERROR_CODES,
  parseAnySketchId,
} from "./sketch-ids";

/** Any branded sketch id: an entity or a constraint id. */
export type AnySketchId = SketchEntityId | SketchConstraintId;

/**
 * Registry of stable sketch diagnostic codes, formatted `<domain>/<name>`
 * (e.g. `sketch/constraints-conflicting`). Grouped by origin: identity,
 * workplane, entities, constraints (parse-time), and solver (analysis-time).
 * Never rename an existing code — they are persisted data.
 */
export const SKETCH_DIAGNOSTIC_CODES = {
  idNotAString: SKETCH_ID_ERROR_CODES.notAString,
  idEmpty: SKETCH_ID_ERROR_CODES.empty,
  idWrongPrefix: SKETCH_ID_ERROR_CODES.wrongPrefix,
  idInvalidPayload: SKETCH_ID_ERROR_CODES.invalidPayload,
  idGeneratorExhausted: SKETCH_ID_GENERATOR_ERROR_CODES.exhausted,
  versionUnsupported: "sketch/version-unsupported",
  sketchMalformed: "sketch/malformed",
  workplaneMalformed: "sketch/workplane-malformed",
  workplaneDegenerate: "sketch/workplane-degenerate",
  workplaneNotOrthonormal: "sketch/workplane-not-orthonormal",
  entityMalformed: "sketch/entity-malformed",
  entityUnknownKind: "sketch/entity-unknown-kind",
  entityDuplicateId: "sketch/entity-duplicate-id",
  entityParametersInvalid: "sketch/entity-parameters-invalid",
  rectangleEdgesMalformed: "sketch/rectangle-edges-malformed",
  constraintMalformed: "sketch/constraint-malformed",
  constraintUnknownKind: "sketch/constraint-unknown-kind",
  constraintDuplicateId: "sketch/constraint-duplicate-id",
  constraintValueInvalid: "sketch/constraint-value-invalid",
  constraintReferenceMalformed: "sketch/constraint-reference-malformed",
  underConstrained: "sketch/under-constrained",
  constraintsRedundant: "sketch/constraints-redundant",
  constraintsConflicting: "sketch/constraints-conflicting",
  constraintsUnsatisfiable: "sketch/constraints-unsatisfiable",
  solverNotConverged: "sketch/solver-not-converged",
} as const;

export type SketchDiagnosticCode =
  (typeof SKETCH_DIAGNOSTIC_CODES)[keyof typeof SKETCH_DIAGNOSTIC_CODES];

const CODE_SET: ReadonlySet<string> = new Set(
  Object.values(SKETCH_DIAGNOSTIC_CODES),
);

/** Type guard for untrusted sketch diagnostic codes. */
export function isSketchDiagnosticCode(
  input: unknown,
): input is SketchDiagnosticCode {
  return typeof input === "string" && CODE_SET.has(input);
}

/** Where a sketch diagnostic applies: the entity or constraint it is about. */
export interface SketchDiagnosticLocation {
  /** The entity or constraint id the diagnostic is primarily about. */
  readonly primary: AnySketchId;
  /** Other ids involved in the problem, in a stable order. */
  readonly related?: readonly AnySketchId[];
}

/** JSON-safe primitive values allowed in {@link SketchDiagnostic.data}. */
export type SketchDiagnosticDataValue = string | number | boolean | null;

/**
 * A single structured sketch diagnostic. Every field is plain serializable
 * data, so a diagnostic survives `value → JSON → value` unchanged.
 */
export interface SketchDiagnostic {
  readonly severity: "info" | "warning" | "error";
  readonly code: SketchDiagnosticCode;
  readonly message: string;
  readonly location?: SketchDiagnosticLocation;
  readonly data?: Readonly<Record<string, SketchDiagnosticDataValue>>;
}

/** Structured failure describing why input was rejected as a diagnostic. */
export interface SketchDiagnosticParseError {
  readonly code: "sketch/diagnostic-malformed";
  readonly message: string;
  readonly input: unknown;
}

function isPlainRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}

function isDataValue(input: unknown): input is SketchDiagnosticDataValue {
  if (typeof input === "number") return Number.isFinite(input);
  return (
    typeof input === "string" ||
    typeof input === "boolean" ||
    input === null
  );
}

/**
 * Parses untrusted input (e.g. diagnostics revived from persisted JSON) as a
 * {@link SketchDiagnostic}. Known fields are validated strictly; unknown
 * fields are ignored so future format versions deserialize without data
 * corruption.
 */
export function parseSketchDiagnostic(
  input: unknown,
): ParseResult<SketchDiagnostic, SketchDiagnosticParseError> {
  if (!isPlainRecord(input)) {
    return {
      ok: false,
      error: {
        code: "sketch/diagnostic-malformed",
        message: "A sketch diagnostic must be a plain object.",
        input,
      },
    };
  }
  const { severity, code, message, location, data } = input;
  if (!isDiagnosticSeverity(severity) || severity === "fatal") {
    return {
      ok: false,
      error: {
        code: "sketch/diagnostic-malformed",
        message: "Sketch diagnostic severity must be one of: info, warning, error.",
        input,
      },
    };
  }
  if (!isSketchDiagnosticCode(code)) {
    return {
      ok: false,
      error: {
        code: "sketch/diagnostic-malformed",
        message:
          "Sketch diagnostic code must be one of the codes registered in SKETCH_DIAGNOSTIC_CODES.",
        input,
      },
    };
  }
  if (typeof message !== "string" || message.length === 0) {
    return {
      ok: false,
      error: {
        code: "sketch/diagnostic-malformed",
        message: "Sketch diagnostic message must be a non-empty string.",
        input,
      },
    };
  }
  let parsedLocation: SketchDiagnosticLocation | undefined;
  if (location !== undefined) {
    if (!isPlainRecord(location)) {
      return {
        ok: false,
        error: {
          code: "sketch/diagnostic-malformed",
          message: "Sketch diagnostic location must be a plain object.",
          input,
        },
      };
    }
    const primary = parseAnySketchId(location.primary);
    if (!primary.ok) {
      return {
        ok: false,
        error: {
          code: "sketch/diagnostic-malformed",
          message: `Sketch diagnostic location needs a valid sketch id: ${primary.error.message}`,
          input,
        },
      };
    }
    const { related } = location;
    if (related === undefined) {
      parsedLocation = { primary: primary.value.id };
    } else {
      if (!Array.isArray(related)) {
        return {
          ok: false,
          error: {
            code: "sketch/diagnostic-malformed",
            message: "Sketch diagnostic location.related must be an array of sketch ids.",
            input,
          },
        };
      }
      const relatedIds: AnySketchId[] = [];
      for (const entry of related) {
        const parsed = parseAnySketchId(entry);
        if (!parsed.ok) {
          return {
            ok: false,
            error: {
              code: "sketch/diagnostic-malformed",
              message: `Sketch diagnostic location.related contains an invalid sketch id: ${parsed.error.message}`,
              input,
            },
          };
        }
        relatedIds.push(parsed.value.id);
      }
      parsedLocation = { primary: primary.value.id, related: relatedIds };
    }
  }
  let parsedData: SketchDiagnostic["data"];
  if (data !== undefined) {
    if (!isPlainRecord(data)) {
      return {
        ok: false,
        error: {
          code: "sketch/diagnostic-malformed",
          message:
            "Sketch diagnostic data must be a plain object of string, finite number, boolean, or null values.",
          input,
        },
      };
    }
    const entries: Record<string, SketchDiagnosticDataValue> = {};
    for (const [key, value] of Object.entries(data)) {
      if (!isDataValue(value)) {
        return {
          ok: false,
          error: {
            code: "sketch/diagnostic-malformed",
            message: `Sketch diagnostic data["${key}"] must be a string, finite number, boolean, or null.`,
            input,
          },
        };
      }
      entries[key] = value;
    }
    parsedData = entries;
  }
  return {
    ok: true,
    value: {
      severity,
      code,
      message,
      ...(parsedLocation === undefined ? {} : { location: parsedLocation }),
      ...(parsedData === undefined ? {} : { data: parsedData }),
    },
  };
}

/** Builds a sketch diagnostic with a stable field order. */
export function sketchDiagnostic(
  severity: SketchDiagnostic["severity"],
  code: SketchDiagnosticCode,
  message: string,
  location?: SketchDiagnosticLocation,
  data?: Readonly<Record<string, SketchDiagnosticDataValue>>,
): SketchDiagnostic {
  return {
    severity,
    code,
    message,
    ...(location === undefined ? {} : { location }),
    ...(data === undefined ? {} : { data }),
  };
}
