/**
 * The reusable CAD component contract (Phase 32.1): the kernel-neutral,
 * serializable metadata every `@slopcad/cad-components` component carries.
 *
 * A component is a parameterized solid builder plus a self-describing
 * definition a registry, catalog UI, or preview renderer can consume
 * WITHOUT executing any geometry:
 *
 * - `parameters` — one {@link ComponentParameterDescriptor} per parameter:
 *   an expression-identifier name (the cad-core parameter-name rules, so a
 *   descriptor maps 1:1 onto a document parameter), a human description,
 *   the value's dimension (canonical unit magnitudes only — the repo's
 *   canonical-mm discipline), the default value, and optional inclusive
 *   min/max bounds plus a UI step hint.
 * - `ports` — the component's references/ports where the component has
 *   them: named, kinded attachment points (`hole`, `boss`, `interface`)
 *   whose positions a component instance resolves from parameter values
 *   (see `CadComponent.ports` in `./cad-component`).
 * - `version` — the component's own semver (MAJOR.MINOR.PATCH); breaking
 *   parameter or geometry semantics bump MAJOR per the registry's contract.
 * - `preview` — what a consumer needs to render a preview card: the stable
 *   body ids the component's bodies project under (the registry keys cards
 *   and rendered scenes by them) and the fixture viewport the component
 *   was authored for.
 * - `contractVersion` — the format version of this contract itself, so a
 *   registry can gate on the metadata dialect it understands.
 *
 * Serialization is canonical (fixed key order, canonical-unit magnitudes)
 * and parsing validates untrusted input strictly on known fields while
 * tolerating unknown ones — a newer definition dialect deserializes
 * without corruption, exactly the worker protocol's parsing philosophy.
 *
 * The contract carries METADATA only: no geometry, no kernel types, no
 * React. Everything here serializes to JSON-safe data and round-trips.
 */

import type {
  AnyDimensionalValue,
  Dimension,
  ParseFailure,
  ParseResult,
} from "@slopcad/cad-core";
import {
  addParameter,
  angle,
  area,
  CANONICAL_UNITS,
  createParameterId,
  dimensionless,
  EMPTY_PARAMETER_COLLECTION,
  fail,
  isDimension,
  isExpressionFunction,
  isExpressionIdentifierName,
  length,
  PARAMETER_ERROR_CODES,
  type Parameter,
  type ParameterCollection,
  type ParameterError,
  type ParameterId,
  type ParameterInput,
  toCanonical,
  volume,
  ok,
} from "@slopcad/cad-core";

/** The format version of this contract itself. */
export const COMPONENT_CONTRACT_VERSION = "1.0";

/** Stable failure codes produced when component-contract input is rejected. */
export const COMPONENT_CONTRACT_ERROR_CODES = {
  /** The input was not a plain object, or a required field was absent. */
  malformed: "component-contract/malformed",
  /** The definition id was not kebab-case (`[a-z][a-z0-9-]*`, ≤ 64 chars). */
  idInvalid: "component-contract/id-invalid",
  /** The component version was not MAJOR.MINOR.PATCH. */
  versionInvalid: "component-contract/version-invalid",
  /** The definition's contract format version is not the one this module speaks. */
  contractVersionMismatch: "component-contract/contract-version-mismatch",
  /** The display name or a text field was absent or not a non-empty string. */
  descriptionInvalid: "component-contract/description-invalid",
  /** A parameter descriptor violated its rules. */
  parameterInvalid: "component-contract/parameter-invalid",
  /** A port descriptor violated its rules, or a port/parameter name collided. */
  portInvalid: "component-contract/port-invalid",
  /** The preview metadata violated its rules. */
  previewInvalid: "component-contract/preview-invalid",
  /** A submitted parameter value named no descriptor (renamed/typo guard). */
  unknownParameter: "component-contract/unknown-parameter",
  /** A submitted value was missing, non-finite, or outside its bounds. */
  parameterOutOfRange: "component-contract/parameter-out-of-range",
} as const;

export type ComponentContractErrorCode =
  (typeof COMPONENT_CONTRACT_ERROR_CODES)[keyof typeof COMPONENT_CONTRACT_ERROR_CODES];

/** Structured failure describing why contract input was rejected. */
export interface ComponentContractError extends ParseFailure {
  readonly code: ComponentContractErrorCode;
}

function contractError(
  code: ComponentContractErrorCode,
  message: string,
  input: unknown,
): ComponentContractError {
  return { code, message, input };
}

/**
 * One component parameter: canonical-unit magnitude (`mm`, `rad`, … — the
 * cad-core canonical unit of `dimension`), optional inclusive bounds, and
 * an optional UI step hint. The name follows cad-core's parameter-name
 * rules so a descriptor converts 1:1 onto a document parameter.
 */
export interface ComponentParameterDescriptor {
  readonly name: string;
  readonly description: string;
  readonly dimension: Dimension;
  readonly defaultValue: number;
  readonly min?: number;
  readonly max?: number;
  readonly step?: number;
}

/** The kinds a {@link ComponentPortDescriptor} can describe. */
export const COMPONENT_PORT_KINDS = ["hole", "boss", "interface"] as const;

export type ComponentPortKind = (typeof COMPONENT_PORT_KINDS)[number];

/**
 * One named attachment point of the component's interface (its mounting
 * holes, screw bosses, or seating faces), declared where the component
 * has such references. Instances resolve positions per parameter values.
 */
export interface ComponentPortDescriptor {
  readonly name: string;
  readonly description: string;
  readonly kind: ComponentPortKind;
}

/** What a registry/consumer needs to render a component's preview card. */
export interface ComponentPreviewMetadata {
  /** The stable body ids the component's bodies project under, in build order. */
  readonly bodyIds: readonly string[];
  /** The fixture viewport (CSS pixels) the component was authored for. */
  readonly viewport: { readonly widthPx: number; readonly heightPx: number };
}

/** The full self-describing metadata of one reusable CAD component. */
export interface CadComponentDefinition {
  /** The format version of this contract the definition speaks. */
  readonly contractVersion: string;
  /** The registry id: kebab-case, unique per registry. */
  readonly id: string;
  /** The human display name. */
  readonly name: string;
  /**
   * What the component is and how to use it. For components derived from
   * physical hardware this is ALSO the dimension-source disclosure: which
   * board class / motor standard the defaults encode and where those
   * numbers come from.
   */
  readonly description: string;
  /** The component's own semver (MAJOR.MINOR.PATCH). */
  readonly version: string;
  readonly parameters: readonly ComponentParameterDescriptor[];
  /** The component's ports; empty when it declares none. */
  readonly ports: readonly ComponentPortDescriptor[];
  readonly preview: ComponentPreviewMetadata;
}

/** Canonical serialized form (fixed key order, JSON-safe). */
export interface SerializedComponentDefinition {
  readonly contractVersion: string;
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly version: string;
  readonly parameters: readonly {
    readonly name: string;
    readonly description: string;
    readonly dimension: Dimension;
    readonly defaultValue: number;
    readonly min?: number;
    readonly max?: number;
    readonly step?: number;
  }[];
  readonly ports: readonly {
    readonly name: string;
    readonly description: string;
    readonly kind: ComponentPortKind;
  }[];
  readonly preview: {
    readonly bodyIds: readonly string[];
    readonly viewport: {
      readonly widthPx: number;
      readonly heightPx: number;
    };
  };
}

/** Submitted parameter values keyed by descriptor name (canonical magnitudes). */
export type ComponentParameterValues = Readonly<Record<string, number>>;

/**
 * The validated parameter set a component's build may rely on: every
 * declared descriptor name resolves to a finite, in-bounds canonical
 * magnitude, and nothing else was submitted. `get` is the typed read a
 * component's build uses; asking it for a name the definition does not
 * declare is a caller bug and fails loudly, never with a silent NaN.
 */
export interface ResolvedComponentParameters {
  /** The validated canonical magnitude of the named parameter. */
  get(name: string): number;
  /** The descriptor names, in definition order. */
  readonly names: readonly string[];
  /** The validated magnitudes as a plain frozen record (serialization path). */
  readonly values: ComponentParameterValues;
}

const DEFINITION_ID_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;
const SEMVER_PATTERN = /^\d+\.\d+\.\d+$/;

function isPlainObject(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}

function isFiniteNumber(input: unknown): input is number {
  return typeof input === "number" && Number.isFinite(input);
}

function nonEmptyString(input: unknown, max: number): input is string {
  return (
    typeof input === "string" && input.trim().length > 0 && input.length <= max
  );
}

/** A parameter name a cad-core parameter could legally carry. */
export function isComponentParameterName(name: string): boolean {
  return isExpressionIdentifierName(name) && !isExpressionFunction(name);
}

function parseParameterDescriptor(
  input: unknown,
): ParseResult<ComponentParameterDescriptor, ComponentContractError> {
  if (!isPlainObject(input)) {
    return fail(
      contractError(
        COMPONENT_CONTRACT_ERROR_CODES.parameterInvalid,
        "A parameter descriptor must be a plain object.",
        input,
      ),
    );
  }
  const { name, description, dimension, defaultValue, min, max, step } = input;
  if (typeof name !== "string" || !isComponentParameterName(name)) {
    return fail(
      contractError(
        COMPONENT_CONTRACT_ERROR_CODES.parameterInvalid,
        "A parameter name must be usable as a cad-core parameter name (an expression identifier, not a function name).",
        name,
      ),
    );
  }
  if (!nonEmptyString(description, 2000)) {
    return fail(
      contractError(
        COMPONENT_CONTRACT_ERROR_CODES.parameterInvalid,
        `The parameter "${name}" needs a non-empty description (at most 2000 characters).`,
        description,
      ),
    );
  }
  if (!isDimension(dimension)) {
    return fail(
      contractError(
        COMPONENT_CONTRACT_ERROR_CODES.parameterInvalid,
        `The parameter "${name}" carries dimension ${String(dimension)}, which is not one of the cad-core dimensions.`,
        dimension,
      ),
    );
  }
  if (!isFiniteNumber(defaultValue)) {
    return fail(
      contractError(
        COMPONENT_CONTRACT_ERROR_CODES.parameterInvalid,
        `The parameter "${name}" needs a finite default value in its canonical unit (${CANONICAL_UNITS[dimension]}).`,
        defaultValue,
      ),
    );
  }
  if (min !== undefined && !isFiniteNumber(min)) {
    return fail(
      contractError(
        COMPONENT_CONTRACT_ERROR_CODES.parameterInvalid,
        `The parameter "${name}" carries a non-finite min bound.`,
        min,
      ),
    );
  }
  if (max !== undefined && !isFiniteNumber(max)) {
    return fail(
      contractError(
        COMPONENT_CONTRACT_ERROR_CODES.parameterInvalid,
        `The parameter "${name}" carries a non-finite max bound.`,
        max,
      ),
    );
  }
  if (min !== undefined && max !== undefined && min > max) {
    return fail(
      contractError(
        COMPONENT_CONTRACT_ERROR_CODES.parameterInvalid,
        `The parameter "${name}" carries min ${String(min)} above max ${String(max)}.`,
        { max, min },
      ),
    );
  }
  if (step !== undefined && (!isFiniteNumber(step) || step <= 0)) {
    return fail(
      contractError(
        COMPONENT_CONTRACT_ERROR_CODES.parameterInvalid,
        `The parameter "${name}" carries a step hint that is not a positive finite number.`,
        step,
      ),
    );
  }
  if (
    (min !== undefined && defaultValue < min) ||
    (max !== undefined && defaultValue > max)
  ) {
    return fail(
      contractError(
        COMPONENT_CONTRACT_ERROR_CODES.parameterInvalid,
        `The parameter "${name}" default ${String(defaultValue)} falls outside its own [${min === undefined ? "−∞" : String(min)}, ${max === undefined ? "∞" : String(max)}] bounds.`,
        defaultValue,
      ),
    );
  }
  return ok({
    defaultValue,
    description,
    dimension,
    name,
    ...(min !== undefined ? { min } : {}),
    ...(max !== undefined ? { max } : {}),
    ...(step !== undefined ? { step } : {}),
  });
}

function isComponentPortKind(input: unknown): input is ComponentPortKind {
  return (
    typeof input === "string" &&
    COMPONENT_PORT_KINDS.includes(input as ComponentPortKind)
  );
}

function parsePortDescriptor(
  input: unknown,
): ParseResult<ComponentPortDescriptor, ComponentContractError> {
  if (!isPlainObject(input)) {
    return fail(
      contractError(
        COMPONENT_CONTRACT_ERROR_CODES.portInvalid,
        "A port descriptor must be a plain object.",
        input,
      ),
    );
  }
  const { name, description, kind } = input;
  if (typeof name !== "string" || !isComponentParameterName(name)) {
    return fail(
      contractError(
        COMPONENT_CONTRACT_ERROR_CODES.portInvalid,
        "A port name must be an expression identifier, like a parameter name.",
        name,
      ),
    );
  }
  if (!nonEmptyString(description, 2000)) {
    return fail(
      contractError(
        COMPONENT_CONTRACT_ERROR_CODES.portInvalid,
        `The port "${name}" needs a non-empty description (at most 2000 characters).`,
        description,
      ),
    );
  }
  if (!isComponentPortKind(kind)) {
    return fail(
      contractError(
        COMPONENT_CONTRACT_ERROR_CODES.portInvalid,
        `The port "${name}" carries kind ${String(kind)}, which is not one of: ${COMPONENT_PORT_KINDS.join(", ")}.`,
        kind,
      ),
    );
  }
  return ok({ description, kind, name });
}

function parsePreviewMetadata(
  input: unknown,
): ParseResult<ComponentPreviewMetadata, ComponentContractError> {
  if (!isPlainObject(input)) {
    return fail(
      contractError(
        COMPONENT_CONTRACT_ERROR_CODES.previewInvalid,
        "The preview metadata must be a plain object.",
        input,
      ),
    );
  }
  const { bodyIds, viewport } = input;
  if (
    !Array.isArray(bodyIds) ||
    bodyIds.length === 0 ||
    !bodyIds.every((id) => nonEmptyString(id, 64))
  ) {
    return fail(
      contractError(
        COMPONENT_CONTRACT_ERROR_CODES.previewInvalid,
        "The preview metadata needs a non-empty bodyIds list of short non-empty strings.",
        bodyIds,
      ),
    );
  }
  if (new Set(bodyIds).size !== bodyIds.length) {
    return fail(
      contractError(
        COMPONENT_CONTRACT_ERROR_CODES.previewInvalid,
        "The preview bodyIds must be unique (one stable id per projected body).",
        bodyIds,
      ),
    );
  }
  if (!isPlainObject(viewport)) {
    return fail(
      contractError(
        COMPONENT_CONTRACT_ERROR_CODES.previewInvalid,
        "The preview metadata needs a viewport object.",
        viewport,
      ),
    );
  }
  const { widthPx, heightPx } = viewport;
  const sizeOk = (value: unknown): value is number =>
    isFiniteNumber(value) &&
    Number.isInteger(value) &&
    value >= 64 &&
    value <= 8192;
  if (!sizeOk(widthPx) || !sizeOk(heightPx)) {
    return fail(
      contractError(
        COMPONENT_CONTRACT_ERROR_CODES.previewInvalid,
        "The preview viewport needs integer width/height in [64, 8192] CSS pixels.",
        viewport,
      ),
    );
  }
  return ok({
    bodyIds: Object.freeze([...bodyIds] as string[]),
    viewport: { heightPx, widthPx },
  });
}

/**
 * Validates untrusted input as a component definition. Strict on the known
 * fields; tolerant of unknown fields (a newer definition dialect
 * deserializes without corruption), exactly the worker protocol's parsing
 * philosophy.
 */
export function parseComponentDefinition(
  input: unknown,
): ParseResult<CadComponentDefinition, ComponentContractError> {
  if (!isPlainObject(input)) {
    return fail(
      contractError(
        COMPONENT_CONTRACT_ERROR_CODES.malformed,
        "A component definition must be a plain object.",
        input,
      ),
    );
  }
  const {
    contractVersion,
    id,
    name,
    description,
    version,
    parameters,
    ports,
    preview,
  } = input;
  if (contractVersion !== COMPONENT_CONTRACT_VERSION) {
    return fail(
      contractError(
        COMPONENT_CONTRACT_ERROR_CODES.contractVersionMismatch,
        `The definition speaks contract version ${String(contractVersion)}; this module speaks ${COMPONENT_CONTRACT_VERSION}.`,
        contractVersion,
      ),
    );
  }
  if (typeof id !== "string" || !DEFINITION_ID_PATTERN.test(id)) {
    return fail(
      contractError(
        COMPONENT_CONTRACT_ERROR_CODES.idInvalid,
        "A component id must be kebab-case ([a-z][a-z0-9-]*, at most 64 characters).",
        id,
      ),
    );
  }
  if (!nonEmptyString(name, 200)) {
    return fail(
      contractError(
        COMPONENT_CONTRACT_ERROR_CODES.descriptionInvalid,
        "A component needs a non-empty display name (at most 200 characters).",
        name,
      ),
    );
  }
  if (!nonEmptyString(description, 4000)) {
    return fail(
      contractError(
        COMPONENT_CONTRACT_ERROR_CODES.descriptionInvalid,
        "A component needs a non-empty description (at most 4000 characters); physical components document their dimension sources here.",
        description,
      ),
    );
  }
  if (typeof version !== "string" || !SEMVER_PATTERN.test(version)) {
    return fail(
      contractError(
        COMPONENT_CONTRACT_ERROR_CODES.versionInvalid,
        'A component version must be MAJOR.MINOR.PATCH (e.g. "1.0.0").',
        version,
      ),
    );
  }
  if (!Array.isArray(parameters) || parameters.length === 0) {
    return fail(
      contractError(
        COMPONENT_CONTRACT_ERROR_CODES.parameterInvalid,
        "A parametric component declares at least one parameter.",
        parameters,
      ),
    );
  }
  const parsedParameters: ComponentParameterDescriptor[] = [];
  const parameterNames = new Set<string>();
  for (const descriptor of parameters) {
    const parsed = parseParameterDescriptor(descriptor);
    if (!parsed.ok) return parsed;
    if (parameterNames.has(parsed.value.name)) {
      return fail(
        contractError(
          COMPONENT_CONTRACT_ERROR_CODES.parameterInvalid,
          `Two parameters share the name "${parsed.value.name}".`,
          descriptor,
        ),
      );
    }
    parameterNames.add(parsed.value.name);
    parsedParameters.push(parsed.value);
  }
  if (!Array.isArray(ports)) {
    return fail(
      contractError(
        COMPONENT_CONTRACT_ERROR_CODES.portInvalid,
        "The ports field must be an array (possibly empty).",
        ports,
      ),
    );
  }
  const parsedPorts: ComponentPortDescriptor[] = [];
  const portNames = new Set<string>();
  for (const descriptor of ports) {
    const parsed = parsePortDescriptor(descriptor);
    if (!parsed.ok) return parsed;
    if (portNames.has(parsed.value.name)) {
      return fail(
        contractError(
          COMPONENT_CONTRACT_ERROR_CODES.portInvalid,
          `Two ports share the name "${parsed.value.name}".`,
          descriptor,
        ),
      );
    }
    portNames.add(parsed.value.name);
    parsedPorts.push(parsed.value);
  }
  const parsedPreview = parsePreviewMetadata(preview);
  if (!parsedPreview.ok) return parsedPreview;
  return ok({
    contractVersion,
    description,
    id,
    name,
    parameters: Object.freeze(parsedParameters),
    ports: Object.freeze(parsedPorts),
    preview: parsedPreview.value,
    version,
  });
}

/**
 * Canonical serialized form of a definition: fixed key order, canonical
 * unit magnitudes, JSON-safe — the bytes a registry stores and a consumer
 * parses back through {@link parseComponentDefinition}.
 */
export function serializeComponentDefinition(
  definition: CadComponentDefinition,
): SerializedComponentDefinition {
  return {
    contractVersion: definition.contractVersion,
    description: definition.description,
    id: definition.id,
    name: definition.name,
    parameters: definition.parameters.map((parameter) => ({
      defaultValue: parameter.defaultValue,
      description: parameter.description,
      dimension: parameter.dimension,
      name: parameter.name,
      ...(parameter.max !== undefined ? { max: parameter.max } : {}),
      ...(parameter.min !== undefined ? { min: parameter.min } : {}),
      ...(parameter.step !== undefined ? { step: parameter.step } : {}),
    })),
    ports: definition.ports.map((port) => ({
      description: port.description,
      kind: port.kind,
      name: port.name,
    })),
    preview: {
      bodyIds: [...definition.preview.bodyIds],
      viewport: {
        heightPx: definition.preview.viewport.heightPx,
        widthPx: definition.preview.viewport.widthPx,
      },
    },
    version: definition.version,
  };
}

/**
 * The descriptor's default magnitudes, keyed by name — a component's
 * canonical starting parameter set.
 */
export function defaultParameterValues(
  definition: CadComponentDefinition,
): ComponentParameterValues {
  const values: Record<string, number> = {};
  for (const parameter of definition.parameters) {
    values[parameter.name] = parameter.defaultValue;
  }
  return Object.freeze(values);
}

/**
 * The named parameter's submitted magnitude when it is a finite number,
 * otherwise the descriptor's default — the METADATA-VIEW read (port
 * callouts, preview cards) that must stay total before any build runs.
 * The build path never uses this: `resolveComponentParameters` is its
 * gate, and it refuses malformed values instead of substituting.
 */
export function parameterValueOrDefault(
  definition: CadComponentDefinition,
  values: ComponentParameterValues,
  name: string,
): number {
  const submitted = values[name];
  if (typeof submitted === "number" && Number.isFinite(submitted)) {
    return submitted;
  }
  return defaultParameterValues(definition)[name] ?? 0;
}

/**
 * Validates submitted values against a definition's descriptors: every
 * descriptor name present and finite within its inclusive bounds, and NO
 * unknown names (a renamed/typo'd key must fail loudly, never silently
 * fall back to a default — the registry's versioning depends on it).
 * Returns the frozen, validated set a component build may rely on.
 */
export function resolveComponentParameters(
  definition: CadComponentDefinition,
  values: ComponentParameterValues,
): ParseResult<ResolvedComponentParameters, ComponentContractError> {
  const resolved: Record<string, number> = {};
  for (const parameter of definition.parameters) {
    const value = values[parameter.name];
    if (!isFiniteNumber(value)) {
      return fail(
        contractError(
          COMPONENT_CONTRACT_ERROR_CODES.parameterOutOfRange,
          `The parameter "${parameter.name}" needs a finite number (${CANONICAL_UNITS[parameter.dimension]}).`,
          value,
        ),
      );
    }
    if (
      (parameter.min !== undefined && value < parameter.min) ||
      (parameter.max !== undefined && value > parameter.max)
    ) {
      return fail(
        contractError(
          COMPONENT_CONTRACT_ERROR_CODES.parameterOutOfRange,
          `The parameter "${parameter.name}" = ${String(value)} falls outside its [${parameter.min === undefined ? "−∞" : String(parameter.min)}, ${parameter.max === undefined ? "∞" : String(parameter.max)}] bounds.`,
          value,
        ),
      );
    }
    resolved[parameter.name] = value;
  }
  const known = new Set(definition.parameters.map((p) => p.name));
  for (const name of Object.keys(values)) {
    if (!known.has(name)) {
      return fail(
        contractError(
          COMPONENT_CONTRACT_ERROR_CODES.unknownParameter,
          `"${name}" names no parameter of component "${definition.id}" — every submitted value must address a declared descriptor.`,
          name,
        ),
      );
    }
  }
  const frozen = Object.freeze(resolved);
  const names = Object.freeze(definition.parameters.map((p) => p.name));
  return ok({
    get(name: string): number {
      const value = frozen[name];
      if (value === undefined) {
        throw new Error(
          `"${name}" is not a parameter of component "${definition.id}" (unreachable through a resolved set — the caller asked for an undeclared name).`,
        );
      }
      return value;
    },
    names,
    values: frozen,
  });
}

/**
 * One resolved port instance: the port's declared identity plus the
 * position (canonical millimetres, component-local coordinates), the
 * port's access axis (1 = x, 2 = y, 3 = z), and the characteristic
 * diameter where the port has one (holes and bosses).
 */
export interface ComponentPortInstance {
  readonly name: string;
  readonly kind: ComponentPortKind;
  readonly position: readonly [number, number, number];
  readonly axis: 1 | 2 | 3;
  readonly diameter?: number;
}

/**
 * Converts a definition's parameter descriptors (plus current values)
 * into a cad-core parameter collection — the exact mechanism the
 * workbench's parameter panel speaks. Each descriptor becomes one literal
 * parameter whose metadata carries the descriptor's bounds, step hint,
 * and description, so panel/registry consumers read everything from the
 * domain's own parameter records.
 */
export function componentParameterCollection(
  definition: CadComponentDefinition,
  values: ComponentParameterValues,
): ParseResult<ParameterCollection, ParameterError> {
  const resolved = resolveComponentParameters(definition, values);
  if (!resolved.ok) {
    // The caller submitted values that fail the definition's own contract;
    // surface it under the domain's parameter-error shape.
    return fail({
      code: PARAMETER_ERROR_CODES.malformed,
      input: resolved.error.input,
      message: resolved.error.message,
    });
  }
  let collection = EMPTY_PARAMETER_COLLECTION;
  for (const descriptor of definition.parameters) {
    const metadata: Record<string, string | number | boolean | null> = {
      componentId: definition.id,
      description: descriptor.description,
    };
    if (descriptor.min !== undefined) metadata.min = descriptor.min;
    if (descriptor.max !== undefined) metadata.max = descriptor.max;
    if (descriptor.step !== undefined) metadata.step = descriptor.step;
    const input: ParameterInput = {
      id: parameterIdOf(definition, descriptor.name),
      metadata,
      name: descriptor.name,
      value: canonicalValue(
        descriptor.dimension,
        resolved.value.get(descriptor.name),
      ),
    };
    const added = addParameter(collection, input);
    if (!added.ok) return added;
    collection = added.value;
  }
  return { ok: true, value: collection };
}

/**
 * The canonical parameter values behind a cad-core parameter collection
 * produced by {@link componentParameterCollection} — the apply path's
 * read-back (panel edit → values → rebuild). Stored values ride in their
 * authored unit, so each one is normalized through `toCanonical` before
 * it is handed back: an edit authored as `length(6, "cm")` reads back as
 * the canonical 60, never the authored-unit magnitude 6.
 */
export function parameterValuesOfCollection(
  definition: CadComponentDefinition,
  collection: ParameterCollection,
): ComponentParameterValues {
  const values: Record<string, number> = {};
  for (const descriptor of definition.parameters) {
    const parameter = collection.parameters.find(
      (candidate) => candidate.name === descriptor.name,
    );
    values[descriptor.name] = parameter
      ? toCanonical(parameter.value).value
      : descriptor.defaultValue;
  }
  return Object.freeze(values);
}

/** The parameters of a collection that belong to one component definition. */
export function componentParametersOfCollection(
  definition: CadComponentDefinition,
  collection: ParameterCollection,
): readonly Parameter[] {
  const names = new Set(definition.parameters.map((p) => p.name));
  return collection.parameters.filter((parameter) => names.has(parameter.name));
}

/** The canonical-unit value of `dimension` at `magnitude`. */
function canonicalValue(
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

function parameterIdOf(
  definition: CadComponentDefinition,
  parameterName: string,
): ParameterId {
  // The payload after the `param_` prefix is capped at the id format's 64
  // characters; a pathological id+name pair truncates, and a resulting
  // collision surfaces as the collection's structured id-conflict failure.
  return createParameterId(
    `param_${`${definition.id}_${parameterName}`.slice(0, 64)}`,
  );
}
