/**
 * Branded, type-distinct identifiers for the sketch domain: entities and
 * constraints.
 *
 * The wire format follows the cad-core id conventions (`<prefix>_<payload>`,
 * e.g. `skent_wall-start` or `skcon_000042`): plain strings that serialize,
 * compare, and index like strings while the type system prevents mixing the
 * two kinds — or confusing them with cad-core document ids. Sketch ids are
 * scoped to a single sketch and deliberately separate from cad-core's
 * branded ids because sketches live inside features, not beside them.
 */

import { type ParseResult, fail, ok } from "@slopcad/cad-core";

declare const sketchIdBrand: unique symbol;

type BrandedSketchId<K extends SketchIdKind> = string & {
  readonly [sketchIdBrand]: K;
};

/** The two sketch object kinds that carry branded ids. */
export const SKETCH_ID_KINDS = ["entity", "constraint"] as const;

export type SketchIdKind = (typeof SKETCH_ID_KINDS)[number];

/** Identifier of a sketch entity (e.g. `skent_horizon`). */
export type SketchEntityId = BrandedSketchId<"entity">;
/** Identifier of a sketch constraint (e.g. `skcon_000007`). */
export type SketchConstraintId = BrandedSketchId<"constraint">;

type SketchIdTable = {
  entity: SketchEntityId;
  constraint: SketchConstraintId;
};

/** The branded id type of a given id kind. */
export type SketchId<K extends SketchIdKind> = SketchIdTable[K];

/** Canonical wire prefixes; lowercase and case-sensitive. */
export const SKETCH_ID_PREFIXES: Readonly<Record<SketchIdKind, string>> = {
  entity: "skent",
  constraint: "skcon",
};

const PREFIX_TO_KIND: ReadonlyMap<string, SketchIdKind> = new Map(
  SKETCH_ID_KINDS.map((kind) => [SKETCH_ID_PREFIXES[kind], kind] as const),
);

/**
 * Maximum payload length after the `<prefix>_` separator. Payloads may use
 * `A-Z a-z 0-9 . _ -` and must start with an alphanumeric character.
 */
export const SKETCH_ID_MAX_PAYLOAD_LENGTH = 64;

const ID_PAYLOAD_PATTERN = new RegExp(
  `^[A-Za-z0-9][A-Za-z0-9._-]{0,${SKETCH_ID_MAX_PAYLOAD_LENGTH - 1}}$`,
);

/** Stable failure codes produced when an id fails wire-format validation. */
export const SKETCH_ID_ERROR_CODES = {
  notAString: "sketch/id-not-a-string",
  empty: "sketch/id-empty",
  wrongPrefix: "sketch/id-wrong-prefix",
  invalidPayload: "sketch/id-invalid-payload",
} as const;

export type SketchIdErrorCode =
  (typeof SKETCH_ID_ERROR_CODES)[keyof typeof SKETCH_ID_ERROR_CODES];

/** Structured failure describing why input was rejected as a sketch id. */
export interface SketchIdParseError {
  readonly code: SketchIdErrorCode;
  readonly message: string;
  readonly input: unknown;
}

function idError(
  code: SketchIdErrorCode,
  message: string,
  input: unknown,
): SketchIdParseError {
  return { code, message, input };
}

/**
 * Core wire-format validator shared by both kinds. This is the single place
 * where a validated string is trusted as a branded id; the cast only brands
 * input that has already passed the checks above.
 */
function parseIdOfKind<K extends SketchIdKind>(
  kind: K,
  input: unknown,
): ParseResult<SketchId<K>, SketchIdParseError> {
  if (typeof input !== "string") {
    return fail(
      idError(
        SKETCH_ID_ERROR_CODES.notAString,
        `A sketch ${kind} id must be a string.`,
        input,
      ),
    );
  }
  if (input.length === 0) {
    return fail(
      idError(
        SKETCH_ID_ERROR_CODES.empty,
        `A sketch ${kind} id must not be empty.`,
        input,
      ),
    );
  }
  const prefix = `${SKETCH_ID_PREFIXES[kind]}_`;
  if (!input.startsWith(prefix)) {
    return fail(
      idError(
        SKETCH_ID_ERROR_CODES.wrongPrefix,
        `A sketch ${kind} id must start with "${prefix}".`,
        input,
      ),
    );
  }
  const payload = input.slice(prefix.length);
  if (!ID_PAYLOAD_PATTERN.test(payload)) {
    return fail(
      idError(
        SKETCH_ID_ERROR_CODES.invalidPayload,
        `The payload of a sketch ${kind} id must be 1-${SKETCH_ID_MAX_PAYLOAD_LENGTH} characters, start alphanumeric, and use only A-Z a-z 0-9 . _ - .`,
        input,
      ),
    );
  }
  return ok(input as SketchId<K>);
}

/** Parses untrusted input as a {@link SketchEntityId}. */
export function parseSketchEntityId(
  input: unknown,
): ParseResult<SketchEntityId, SketchIdParseError> {
  return parseIdOfKind("entity", input);
}

/** Parses untrusted input as a {@link SketchConstraintId}. */
export function parseSketchConstraintId(
  input: unknown,
): ParseResult<SketchConstraintId, SketchIdParseError> {
  return parseIdOfKind("constraint", input);
}

/** Parses untrusted input as a sketch id of either kind, classified by prefix. */
export function parseAnySketchId(
  input: unknown,
): ParseResult<
  { kind: SketchIdKind; id: SketchId<SketchIdKind> },
  SketchIdParseError
> {
  if (typeof input !== "string") {
    return fail(
      idError(
        SKETCH_ID_ERROR_CODES.notAString,
        "A sketch id must be a string.",
        input,
      ),
    );
  }
  if (input.length === 0) {
    return fail(idError(SKETCH_ID_ERROR_CODES.empty, "A sketch id must not be empty.", input));
  }
  const separator = input.indexOf("_");
  if (separator <= 0) {
    return fail(
      idError(
        SKETCH_ID_ERROR_CODES.wrongPrefix,
        `A sketch id must start with one of: ${SKETCH_ID_KINDS.map(
          (kind) => `"${SKETCH_ID_PREFIXES[kind]}_"`,
        ).join(", ")}.`,
        input,
      ),
    );
  }
  const kind = PREFIX_TO_KIND.get(input.slice(0, separator));
  if (kind === undefined) {
    return fail(
      idError(
        SKETCH_ID_ERROR_CODES.wrongPrefix,
        `Unknown sketch id prefix "${input.slice(0, separator + 1)}"; expected one of: ${SKETCH_ID_KINDS.map(
          (known) => `"${SKETCH_ID_PREFIXES[known]}_"`,
        ).join(", ")}.`,
        input,
      ),
    );
  }
  const parsed =
    kind === "entity" ? parseSketchEntityId(input) : parseSketchConstraintId(input);
  if (!parsed.ok) return parsed;
  return ok({ kind, id: parsed.value });
}

/** Thrown by the `create*Id` constructors when input violates the wire format. */
export class SketchIdValidationError extends Error {
  readonly error: SketchIdParseError;

  constructor(error: SketchIdParseError) {
    super(error.message);
    this.name = "SketchIdValidationError";
    this.error = error;
  }
}

function requireId<K extends SketchIdKind>(kind: K, raw: string): SketchId<K> {
  const result = parseIdOfKind(kind, raw);
  if (!result.ok) throw new SketchIdValidationError(result.error);
  return result.value;
}

/**
 * Adopts an explicit user-provided entity id exactly as given
 * (`skent_…` wire format). Throws {@link SketchIdValidationError} on mismatch.
 */
export function createSketchEntityId(raw: string): SketchEntityId {
  return requireId("entity", raw);
}

/**
 * Adopts an explicit user-provided constraint id exactly as given
 * (`skcon_…` wire format). Throws {@link SketchIdValidationError} on mismatch.
 */
export function createSketchConstraintId(raw: string): SketchConstraintId {
  return requireId("constraint", raw);
}

/** Stable failure code carried by {@link SketchIdGeneratorExhaustedError}. */
export const SKETCH_ID_GENERATOR_ERROR_CODES = {
  exhausted: "sketch/id-generator-exhausted",
} as const;

export type SketchIdGeneratorErrorCode =
  (typeof SKETCH_ID_GENERATOR_ERROR_CODES)[keyof typeof SKETCH_ID_GENERATOR_ERROR_CODES];

/**
 * Thrown by the generator's methods when a counter is already at
 * Number.MAX_SAFE_INTEGER, so float64 rounding can never make it re-emit an
 * id it already produced. The exhausted counter is left untouched.
 */
export class SketchIdGeneratorExhaustedError extends Error {
  readonly code: SketchIdGeneratorErrorCode;
  readonly kind: SketchIdKind;

  constructor(kind: SketchIdKind) {
    super(
      `The sketch ${kind} id counter has reached Number.MAX_SAFE_INTEGER (${Number.MAX_SAFE_INTEGER}); ids beyond it are outside the generator's contract.`,
    );
    this.name = "SketchIdGeneratorExhaustedError";
    this.code = SKETCH_ID_GENERATOR_ERROR_CODES.exhausted;
    this.kind = kind;
  }
}

/**
 * Serializable per-kind counters of a {@link SketchIdGenerator}. Persisting
 * this state lets a reloaded sketch resume id generation without collisions.
 */
export type SketchIdGeneratorState = Readonly<Record<SketchIdKind, number>>;

/** Deterministic generator of sketch-scoped ids. */
export interface SketchIdGenerator {
  nextEntityId(): SketchEntityId;
  nextConstraintId(): SketchConstraintId;
  /** Immutable snapshot of the counters; round-trips through JSON. */
  state(): SketchIdGeneratorState;
}

const DEFAULT_GENERATOR_STATE: SketchIdGeneratorState = Object.freeze({
  entity: 0,
  constraint: 0,
});

/** Width of the zero-padded counter in generated ids (`skcon_000042`). */
const ID_COUNTER_WIDTH = 6;

function normalizeGeneratorState(
  initial: SketchIdGeneratorState,
): Record<SketchIdKind, number> {
  const counters: Record<SketchIdKind, number> = {
    ...DEFAULT_GENERATOR_STATE,
    ...initial,
  };
  for (const kind of SKETCH_ID_KINDS) {
    const count = counters[kind];
    if (!Number.isInteger(count) || count < 0) {
      throw new RangeError(
        `SketchIdGeneratorState.${kind} must be a non-negative integer, received ${String(count)}.`,
      );
    }
  }
  return counters;
}

/**
 * Creates a deterministic sketch id generator: identical starting state
 * always produces identical id sequences (no randomness, no clock), which
 * keeps command replay and sketch regeneration reproducible.
 */
export function createSketchIdGenerator(
  initial: SketchIdGeneratorState = DEFAULT_GENERATOR_STATE,
): SketchIdGenerator {
  const counters = normalizeGeneratorState(initial);
  const nextRawId = (kind: SketchIdKind): string => {
    const current = counters[kind];
    if (current >= Number.MAX_SAFE_INTEGER) {
      throw new SketchIdGeneratorExhaustedError(kind);
    }
    const count = current + 1;
    counters[kind] = count;
    return `${SKETCH_ID_PREFIXES[kind]}_${String(count).padStart(ID_COUNTER_WIDTH, "0")}`;
  };
  return {
    nextEntityId: () => requireId("entity", nextRawId("entity")),
    nextConstraintId: () => requireId("constraint", nextRawId("constraint")),
    state: () => Object.freeze({ ...counters }),
  };
}
