/**
 * Document configurations (Phase 57): named parameter-set rows over the SAME
 * document — parameter overrides, suppressed features, and hidden bodies —
 * evaluated deterministically into an effective document view without
 * duplicating any record (the ADR's representation decision:
 * docs/architecture/adr-configurations.md).
 *
 * A {@link DocumentConfiguration} is an immutable value object holding
 * DELTAS, never copies: an override names a parameter id and the value it
 * takes under the configuration (same dimensional type — a type swap is a
 * modeling error, rejected at build time); the suppressed and hidden lists
 * name feature and body ids of the same document. The document's own
 * parameter values, feature states, and body visibility flags are the
 * BASE (default) configuration; a configuration row is a lens over them.
 * Nothing here forks the document model — the effective view
 * ({@link applyDocumentConfiguration}) is derived data, recomputed on
 * demand, and the regeneration pipeline consumes it exactly where it
 * already consumes authoring state (the suppressed set) and document
 * values.
 *
 * Serialization is canonical (fixed key order, canonical dimensional
 * values, declaration order preserved) and parsing validates untrusted
 * input strictly with stable `configuration/*` failure codes. The CSV
 * parameter-table import/export is byte-deterministic: LF line endings,
 * fixed `name,value,unit` header, parameters in collection order, bare
 * (unquoted) fields — the values are numbers and the names expression
 * identifiers, so no field ever needs quoting.
 */

import type { ParameterCollection } from "./parameter";

import {
  type AnyDimensionalValue,
  parseDimensionalValue,
  serializeDimensionalValue,
  type SerializedDimensionalValue,
} from "./dimensional";
import { isExpressionIdentifierName } from "./expression";
import {
  type BodyId,
  type ConfigurationId,
  type FeatureId,
  parseBodyId,
  parseConfigurationId,
  parseFeatureId,
  type ParameterId,
  parseParameterId,
} from "./ids";
import { type ParseFailure, type ParseResult, fail, ok } from "./result";
import { type AnyUnit, isUnitToken, unitDimension } from "./units";

/** One parameter override row: the parameter and the value it takes here. */
export interface ConfigurationParameterOverride {
  readonly parameterId: ParameterId;
  readonly value: AnyDimensionalValue;
}

/** Input accepted for an override row (typed or untrusted fields). */
export interface ConfigurationParameterOverrideInput {
  readonly parameterId: ParameterId;
  readonly value: AnyDimensionalValue;
}

/**
 * A named configuration row over the document: which parameters take which
 * values, which features are excluded, which bodies are absent — every list
 * referencing ids the SAME document owns (cross-checked at the document
 * layer and at native parse).
 */
export interface DocumentConfiguration {
  readonly id: ConfigurationId;
  /** The configuration's name (1-64 characters; unique in the document). */
  readonly name: string;
  readonly parameterOverrides: readonly ConfigurationParameterOverride[];
  readonly suppressedFeatures: readonly FeatureId[];
  readonly hiddenBodies: readonly BodyId[];
}

/** Input accepted by the document-level {@link addDocumentConfiguration}. */
export interface DocumentConfigurationInput {
  readonly id?: ConfigurationId;
  readonly name: string;
  readonly parameterOverrides?: readonly ConfigurationParameterOverrideInput[];
  readonly suppressedFeatures?: readonly FeatureId[];
  readonly hiddenBodies?: readonly BodyId[];
}

/** Stable failure codes produced when configuration input is rejected. */
export const CONFIGURATION_ERROR_CODES = {
  malformed: "configuration/malformed",
  idInvalid: "configuration/id-invalid",
  nameInvalid: "configuration/name-invalid",
  duplicateId: "configuration/duplicate-id",
  duplicateName: "configuration/duplicate-name",
  overrideInvalid: "configuration/override-invalid",
  overrideDuplicate: "configuration/override-duplicate",
  suppressionInvalid: "configuration/suppression-invalid",
  suppressionDuplicate: "configuration/suppression-duplicate",
  hiddenBodyInvalid: "configuration/hidden-body-invalid",
  hiddenBodyDuplicate: "configuration/hidden-body-duplicate",
  notFound: "configuration/not-found",
  csvMalformed: "configuration/csv-malformed",
} as const;

export type ConfigurationErrorCode =
  (typeof CONFIGURATION_ERROR_CODES)[keyof typeof CONFIGURATION_ERROR_CODES];

/** Structured failure describing why configuration input was rejected. */
export interface ConfigurationError extends ParseFailure {
  readonly code: ConfigurationErrorCode;
}

function configurationError(
  code: ConfigurationErrorCode,
  message: string,
  input: unknown,
): ConfigurationError {
  return { code, message, input };
}

function isPlainRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}

/**
 * The configuration naming rule: 1-64 characters after trimming — the
 * datum naming rule. Names are display labels (unlike parameter names they
 * are not expression identifiers), unique within the document.
 */
export function isValidConfigurationName(name: string): boolean {
  const trimmed = name.trim();
  return trimmed.length >= 1 && trimmed.length <= 64;
}

function parseOverride(
  input: unknown,
): ParseResult<ConfigurationParameterOverride, ConfigurationError> {
  if (!isPlainRecord(input)) {
    return fail(
      configurationError(
        CONFIGURATION_ERROR_CODES.overrideInvalid,
        "A parameter override must be an object with parameterId and value fields.",
        input,
      ),
    );
  }
  const parsedId = parseParameterId(input.parameterId);
  if (!parsedId.ok) {
    return fail(
      configurationError(
        CONFIGURATION_ERROR_CODES.overrideInvalid,
        `A parameter override must carry a valid parameter id: ${parsedId.error.message}`,
        input,
      ),
    );
  }
  const parsedValue = parseDimensionalValue(input.value);
  if (!parsedValue.ok) {
    return fail(
      configurationError(
        CONFIGURATION_ERROR_CODES.overrideInvalid,
        `A parameter override value must be a valid dimensional value: ${parsedValue.error.message}`,
        input,
      ),
    );
  }
  return ok(
    Object.freeze({
      parameterId: parsedId.value,
      value: parsedValue.value,
    }),
  );
}

function parseOverrideList(
  input: unknown,
): ParseResult<readonly ConfigurationParameterOverride[], ConfigurationError> {
  if (input === undefined || input === null) return ok(Object.freeze([]));
  if (!Array.isArray(input)) {
    return fail(
      configurationError(
        CONFIGURATION_ERROR_CODES.overrideInvalid,
        "The parameter overrides must be an array of override rows.",
        input,
      ),
    );
  }
  const overrides: ConfigurationParameterOverride[] = [];
  for (const entry of input) {
    const parsed = parseOverride(entry);
    if (!parsed.ok) return parsed;
    if (overrides.some((row) => row.parameterId === parsed.value.parameterId)) {
      return fail(
        configurationError(
          CONFIGURATION_ERROR_CODES.overrideDuplicate,
          `The parameter "${parsed.value.parameterId}" is overridden more than once; one configuration takes one value per parameter.`,
          input,
        ),
      );
    }
    overrides.push(parsed.value);
  }
  return ok(Object.freeze(overrides));
}

function parseIdList<K extends string>(
  input: unknown,
  kind: "feature" | "body",
  parse: (value: unknown) => ParseResult<K, ParseFailure>,
  invalidCode: ConfigurationErrorCode,
  duplicateCode: ConfigurationErrorCode,
): ParseResult<readonly K[], ConfigurationError> {
  if (input === undefined || input === null) return ok(Object.freeze([]));
  if (!Array.isArray(input)) {
    return fail(
      configurationError(
        invalidCode,
        `The ${kind} list must be an array of ${kind} ids.`,
        input,
      ),
    );
  }
  const ids: K[] = [];
  for (const entry of input) {
    const parsed = parse(entry);
    if (!parsed.ok) {
      return fail(
        configurationError(
          invalidCode,
          `The ${kind} list must carry valid ${kind} ids: ${parsed.error.message}`,
          input,
        ),
      );
    }
    if (ids.includes(parsed.value)) {
      return fail(
        configurationError(
          duplicateCode,
          `The ${kind} id "${parsed.value}" appears more than once.`,
          input,
        ),
      );
    }
    ids.push(parsed.value);
  }
  return ok(Object.freeze(ids));
}

/** Validates and freezes a configuration from its (typed or untrusted) fields. */
export function buildDocumentConfiguration(
  id: unknown,
  name: unknown,
  parameterOverrides: unknown,
  suppressedFeatures: unknown,
  hiddenBodies: unknown,
): ParseResult<DocumentConfiguration, ConfigurationError> {
  const parsedId = parseConfigurationId(id);
  if (!parsedId.ok) {
    return fail(
      configurationError(
        CONFIGURATION_ERROR_CODES.idInvalid,
        `A configuration id must be a valid configuration id: ${parsedId.error.message}`,
        id,
      ),
    );
  }
  if (typeof name !== "string" || !isValidConfigurationName(name)) {
    return fail(
      configurationError(
        CONFIGURATION_ERROR_CODES.nameInvalid,
        "A configuration name must be 1-64 characters (trimmed).",
        name,
      ),
    );
  }
  const overrides = parseOverrideList(parameterOverrides);
  if (!overrides.ok) return overrides;
  const suppressed = parseIdList(
    suppressedFeatures,
    "feature",
    parseFeatureId,
    CONFIGURATION_ERROR_CODES.suppressionInvalid,
    CONFIGURATION_ERROR_CODES.suppressionDuplicate,
  );
  if (!suppressed.ok) return suppressed;
  const hidden = parseIdList(
    hiddenBodies,
    "body",
    parseBodyId,
    CONFIGURATION_ERROR_CODES.hiddenBodyInvalid,
    CONFIGURATION_ERROR_CODES.hiddenBodyDuplicate,
  );
  if (!hidden.ok) return hidden;
  return ok(
    Object.freeze({
      id: parsedId.value,
      name: name.trim(),
      parameterOverrides: overrides.value,
      suppressedFeatures: suppressed.value,
      hiddenBodies: hidden.value,
    }),
  );
}

/** Canonical JSON form of a configuration; fixed key order, additive discipline. */
export interface SerializedDocumentConfiguration {
  readonly id: string;
  readonly name: string;
  readonly parameterOverrides: readonly {
    readonly parameterId: string;
    readonly value: SerializedDimensionalValue;
  }[];
  readonly suppressedFeatures: readonly string[];
  readonly hiddenBodies: readonly string[];
}

/** Serializes a configuration to its canonical, deterministic JSON form. */
export function serializeDocumentConfiguration(
  configuration: DocumentConfiguration,
): SerializedDocumentConfiguration {
  return {
    id: configuration.id,
    name: configuration.name,
    parameterOverrides: configuration.parameterOverrides.map((override) => ({
      parameterId: override.parameterId,
      value: serializeDimensionalValue(override.value),
    })),
    suppressedFeatures: [...configuration.suppressedFeatures],
    hiddenBodies: [...configuration.hiddenBodies],
  };
}

/**
 * Parses untrusted input (e.g. a configuration revived from persisted JSON)
 * as a {@link DocumentConfiguration}. Ids are validated for wire shape;
 * whether they name records the document owns is the caller's (the document
 * and native-format layers') cross-check.
 */
export function parseDocumentConfiguration(
  input: unknown,
): ParseResult<DocumentConfiguration, ConfigurationError> {
  if (!isPlainRecord(input)) {
    return fail(
      configurationError(
        CONFIGURATION_ERROR_CODES.malformed,
        "A serialized configuration must be a plain object with id and name fields.",
        input,
      ),
    );
  }
  return buildDocumentConfiguration(
    input.id,
    input.name,
    input.parameterOverrides,
    input.suppressedFeatures,
    input.hiddenBodies,
  );
}

/**
 * The derived effective view of a document under one configuration: the
 * parameter collection with the configuration's overrides applied (cached
 * values swapped, expressions and everything else untouched — recomputing
 * derived values stays the regeneration pipeline's job), plus the feature
 * ids the executor must skip and the body ids the view omits. Derived data
 * — never persisted, never a second document.
 */
export interface EffectiveDocumentView {
  readonly configurationId: ConfigurationId;
  readonly parameters: ParameterCollection;
  readonly suppressedFeatures: readonly FeatureId[];
  readonly hiddenBodies: readonly BodyId[];
}

/** Returns the configuration with the given id, or undefined. */
export function getDocumentConfiguration(
  configurations: readonly DocumentConfiguration[],
  id: ConfigurationId,
): DocumentConfiguration | undefined {
  return configurations.find((configuration) => configuration.id === id);
}

/**
 * Evaluates one configuration into its effective document view. Fails
 * structurally when the configuration does not exist, when an override
 * names a parameter the document does not have, or when an override's
 * value carries a different dimensional type than the parameter it
 * overrides (a length configuration cannot turn a parameter into an angle).
 * The base parameter values not overridden ride through untouched.
 */
export function applyDocumentConfiguration(
  document: { readonly parameters: ParameterCollection },
  configurations: readonly DocumentConfiguration[],
  id: ConfigurationId,
): ParseResult<EffectiveDocumentView, ConfigurationError> {
  const configuration = getDocumentConfiguration(configurations, id);
  if (configuration === undefined) {
    return fail(
      configurationError(
        CONFIGURATION_ERROR_CODES.notFound,
        `No configuration with id "${id}" exists.`,
        id,
      ),
    );
  }
  let parameters = document.parameters;
  for (const override of configuration.parameterOverrides) {
    const target = parameters.parameters.find(
      (parameter) => parameter.id === override.parameterId,
    );
    if (target === undefined) {
      return fail(
        configurationError(
          CONFIGURATION_ERROR_CODES.overrideInvalid,
          `The configuration "${configuration.name}" overrides parameter "${override.parameterId}", which the document does not have.`,
          override,
        ),
      );
    }
    if (target.value.dimension !== override.value.dimension) {
      return fail(
        configurationError(
          CONFIGURATION_ERROR_CODES.overrideInvalid,
          `The configuration "${configuration.name}" overrides parameter "${override.parameterId}" with a ${override.value.dimension} value, but the parameter is a ${target.value.dimension}.`,
          override,
        ),
      );
    }
    const updated = parameters.parameters.map((parameter) =>
      parameter.id === override.parameterId
        ? Object.freeze({ ...parameter, value: override.value })
        : parameter,
    );
    parameters = Object.freeze({
      parameters: Object.freeze(updated),
    });
  }
  return ok(
    Object.freeze({
      configurationId: configuration.id,
      parameters,
      suppressedFeatures: configuration.suppressedFeatures,
      hiddenBodies: configuration.hiddenBodies,
    }),
  );
}

// ---------------------------------------------------------------------------
// Parameter-table CSV (byte-deterministic)
// ---------------------------------------------------------------------------

/** The fixed CSV header row of the parameter table dialect. */
export const PARAMETER_TABLE_CSV_HEADER = "name,value,unit" as const;

/**
 * Serializes the document's parameter table as deterministic CSV: LF line
 * endings, the fixed `name,value,unit` header, one row per parameter in
 * collection order, values as bare JSON-grade number strings in the
 * parameter's stored unit. Identical documents always produce identical
 * bytes.
 */
export function serializeParameterTableCsv(document: {
  readonly parameters: ParameterCollection;
}): string {
  const lines: string[] = [PARAMETER_TABLE_CSV_HEADER];
  for (const parameter of document.parameters.parameters) {
    lines.push(
      `${parameter.name},${String(parameter.value.value)},${parameter.value.unit}`,
    );
  }
  return `${lines.join("\n")}\n`;
}

/** One parsed CSV row: the parameter name and the quantity it takes. */
export interface CsvParameterRow {
  readonly name: string;
  readonly value: number;
  /** The row's unit token, already validated against the unit table. */
  readonly unit: AnyUnit;
}

/**
 * Parses the parameter-table CSV dialect strictly: the exact header, one
 * `name,value,unit` triple per line, LF (or CRLF, tolerated on input)
 * endings, a final newline, no quoting (the dialect never needs it — names
 * are expression identifiers and values are numbers), no empty or duplicate
 * rows. Names must be expression-identifier-shaped and units must be known
 * unit tokens; the value must be a finite number. Matching rows to
 * parameters and applying them is {@link overridesFromCsvRows}.
 */
export function parseParameterTableCsv(
  input: string,
): ParseResult<readonly CsvParameterRow[], ConfigurationError> {
  if (input.charCodeAt(0) === 0xfeff) {
    return fail(
      configurationError(
        CONFIGURATION_ERROR_CODES.csvMalformed,
        "The CSV must not carry a byte-order mark.",
        input.slice(0, 16),
      ),
    );
  }
  // CRLF is tolerated on input (Windows editors); the dialect's own bytes
  // are always LF.
  const lf = input.replace(/\r\n/g, "\n");
  const normalized = lf.endsWith("\n") ? lf : `${lf}\n`;
  const lines = normalized.split("\n");
  // split leaves a trailing "" after the final newline — drop it.
  lines.pop();
  if (lines.length === 0 || lines[0] !== PARAMETER_TABLE_CSV_HEADER) {
    return fail(
      configurationError(
        CONFIGURATION_ERROR_CODES.csvMalformed,
        `The CSV must start with the exact header "${PARAMETER_TABLE_CSV_HEADER}".`,
        lines[0],
      ),
    );
  }
  const rows: CsvParameterRow[] = [];
  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line === undefined) break;
    if (line.trim().length === 0) {
      return fail(
        configurationError(
          CONFIGURATION_ERROR_CODES.csvMalformed,
          `The CSV must not carry empty rows (line ${String(index + 1)}).`,
          line,
        ),
      );
    }
    const fields = line.split(",");
    if (fields.length !== 3) {
      return fail(
        configurationError(
          CONFIGURATION_ERROR_CODES.csvMalformed,
          `Every CSV row must have exactly three fields, name,value,unit (line ${String(index + 1)}).`,
          line,
        ),
      );
    }
    const [name, rawValue, unit] = fields;
    if (
      name === undefined ||
      rawValue === undefined ||
      unit === undefined ||
      !isExpressionIdentifierName(name)
    ) {
      return fail(
        configurationError(
          CONFIGURATION_ERROR_CODES.csvMalformed,
          `The CSV name field must be a valid parameter name — letters, digits, underscores, starting with a letter or underscore (line ${String(index + 1)}).`,
          line,
        ),
      );
    }
    const value = Number(rawValue);
    if (rawValue.trim().length === 0 || !Number.isFinite(value)) {
      return fail(
        configurationError(
          CONFIGURATION_ERROR_CODES.csvMalformed,
          `The CSV value field must be a finite number (line ${String(index + 1)}).`,
          line,
        ),
      );
    }
    if (!isUnitToken(unit)) {
      return fail(
        configurationError(
          CONFIGURATION_ERROR_CODES.csvMalformed,
          `The CSV unit field must be a known unit token (line ${String(index + 1)}).`,
          line,
        ),
      );
    }
    if (rows.some((row) => row.name === name)) {
      return fail(
        configurationError(
          CONFIGURATION_ERROR_CODES.csvMalformed,
          `The CSV must not carry duplicate rows for "${name}" (line ${String(index + 1)}).`,
          line,
        ),
      );
    }
    rows.push(Object.freeze({ name, value, unit }));
  }
  return ok(Object.freeze(rows));
}

/**
 * Matches parsed CSV rows against a parameter collection and produces the
 * override rows they imply (parameter id plus the dimensional value the
 * row's unit implies). Fails structurally for a row naming a parameter the
 * collection does not have and for a row whose unit carries a different
 * dimensional type than its parameter. The unit token implies the
 * dimension, so the row needs no dimension column.
 */
export function overridesFromCsvRows(
  collection: ParameterCollection,
  rows: readonly CsvParameterRow[],
): ParseResult<readonly ConfigurationParameterOverride[], ConfigurationError> {
  const overrides: ConfigurationParameterOverride[] = [];
  for (const row of rows) {
    const target = collection.parameters.find(
      (parameter) => parameter.name === row.name,
    );
    if (target === undefined) {
      return fail(
        configurationError(
          CONFIGURATION_ERROR_CODES.notFound,
          `The CSV row names parameter "${row.name}", which the document does not have.`,
          row,
        ),
      );
    }
    const dimension = unitDimension(row.unit);
    const parsed = parseDimensionalValue({
      dimension,
      unit: row.unit,
      value: row.value,
    });
    if (!parsed.ok) {
      return fail(
        configurationError(
          CONFIGURATION_ERROR_CODES.overrideInvalid,
          `The CSV row for "${row.name}" does not form a valid ${target.value.dimension} value.`,
          row,
        ),
      );
    }
    if (parsed.value.dimension !== target.value.dimension) {
      return fail(
        configurationError(
          CONFIGURATION_ERROR_CODES.overrideInvalid,
          `The CSV row for "${row.name}" carries a ${parsed.value.dimension} value, but the parameter is a ${target.value.dimension}.`,
          row,
        ),
      );
    }
    overrides.push(
      Object.freeze({ parameterId: target.id, value: parsed.value }),
    );
  }
  return ok(Object.freeze(overrides));
}
