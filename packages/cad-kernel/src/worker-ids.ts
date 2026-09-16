/**
 * Branded, type-distinct identifiers of the worker protocol (Phase 10.1):
 * request ids correlate a response (or a cancellation) with the request that
 * caused it, and solid ids address the solids a worker session mints when it
 * executes kernel operations — the wire stand-in for the in-process opaque
 * `KernelSolid` handle, which cannot cross a message boundary.
 *
 * Every id is a plain string in a documented wire format (`<prefix>_<payload>`,
 * e.g. `req_000042` or `wsol_clamp-pad`) so ids serialize, compare, and index
 * like strings while the type system prevents accidentally mixing kinds — a
 * {@link WorkerRequestId} is not assignable where a {@link WorkerSolidId} is
 * expected, and a bare string is not assignable where either is expected.
 * This mirrors cad-core's id discipline, with one worker-specific rule:
 *
 * ## Uniqueness and correlation safety
 *
 * A request id is single-use per client↔worker channel. Once a responder has
 * seen a request id (refused, running, or answered), a second request bearing
 * it must be rejected with `worker/duplicate-request` (enforced by the
 * cancellation ledger in `./worker-cancellation`) — otherwise a late response
 * could be correlated with the wrong request. The {@link WorkerIdGenerator}
 * mints ids from a monotonic counter, which is unique per channel by
 * construction; callers that prefer their own payloads (e.g. UUIDs) pass them
 * through the wire-format validators via the `create*` constructors.
 */

import { type ParseResult, fail, ok } from "@slopcad/cad-core";

/**
 * Sole branding site of the module. A `unique symbol` property keeps id kinds
 * mutually incompatible at the type level while remaining invisible at
 * runtime, so branded ids stay plain serializable strings.
 */
declare const workerIdBrand: unique symbol;

type BrandedWorkerId<K extends WorkerIdKind> = string & {
  readonly [workerIdBrand]: K;
};

/** The two worker id kinds. */
export const WORKER_ID_KINDS = ["request", "solid"] as const;

export type WorkerIdKind = (typeof WORKER_ID_KINDS)[number];

/** Identifier correlating one request with its response/cancellation. */
export type WorkerRequestId = BrandedWorkerId<"request">;
/** Identifier of a solid minted by a worker session (e.g. `wsol_000007`). */
export type WorkerSolidId = BrandedWorkerId<"solid">;

type WorkerIdTable = {
  request: WorkerRequestId;
  solid: WorkerSolidId;
};

/** The branded id type of a given id kind. */
export type WorkerId<K extends WorkerIdKind> = WorkerIdTable[K];

/**
 * Canonical wire prefixes. The prefix determines the kind of an id on the
 * wire; prefixes are lowercase and case-sensitive.
 */
export const WORKER_ID_PREFIXES: Readonly<Record<WorkerIdKind, string>> = {
  request: "req",
  solid: "wsol",
};

const PREFIX_TO_KIND: ReadonlyMap<string, WorkerIdKind> = new Map(
  WORKER_ID_KINDS.map((kind) => [WORKER_ID_PREFIXES[kind], kind] as const),
);

/**
 * Maximum length of the payload after the `<prefix>_` separator. Payloads may
 * use `A-Z a-z 0-9 . _ -` and must start with an alphanumeric character, so
 * caller-supplied ids (e.g. UUID bytes) stay readable while remaining safe as
 * object keys.
 */
export const WORKER_ID_MAX_PAYLOAD_LENGTH = 64;

const ID_PAYLOAD_PATTERN = new RegExp(
  `^[A-Za-z0-9][A-Za-z0-9._-]{0,${WORKER_ID_MAX_PAYLOAD_LENGTH - 1}}$`,
);

/** Stable failure codes produced when an id fails wire-format validation. */
export const WORKER_ID_ERROR_CODES = {
  notAString: "worker/id-not-a-string",
  empty: "worker/id-empty",
  wrongPrefix: "worker/id-wrong-prefix",
  invalidPayload: "worker/id-invalid-payload",
} as const;

export type WorkerIdErrorCode =
  (typeof WORKER_ID_ERROR_CODES)[keyof typeof WORKER_ID_ERROR_CODES];

/** Structured failure describing why input was rejected as a worker id. */
export interface WorkerIdParseError {
  readonly code: WorkerIdErrorCode;
  readonly message: string;
  readonly input: unknown;
}

function idError(
  code: WorkerIdErrorCode,
  message: string,
  input: unknown,
): WorkerIdParseError {
  return { code, message, input };
}

/**
 * Core wire-format validator shared by both kinds. This is the single place
 * where a validated string is trusted as a branded worker id; the cast only
 * brands input that has already passed the checks above.
 */
function parseIdOfKind<K extends WorkerIdKind>(
  kind: K,
  input: unknown,
): ParseResult<WorkerId<K>, WorkerIdParseError> {
  if (typeof input !== "string") {
    return fail(
      idError(
        WORKER_ID_ERROR_CODES.notAString,
        `A ${kind} id must be a string.`,
        input,
      ),
    );
  }
  if (input.length === 0) {
    return fail(
      idError(
        WORKER_ID_ERROR_CODES.empty,
        `A ${kind} id must not be empty.`,
        input,
      ),
    );
  }
  const prefix = `${WORKER_ID_PREFIXES[kind]}_`;
  if (!input.startsWith(prefix)) {
    return fail(
      idError(
        WORKER_ID_ERROR_CODES.wrongPrefix,
        `A ${kind} id must start with "${prefix}".`,
        input,
      ),
    );
  }
  const payload = input.slice(prefix.length);
  if (!ID_PAYLOAD_PATTERN.test(payload)) {
    return fail(
      idError(
        WORKER_ID_ERROR_CODES.invalidPayload,
        `The payload of a ${kind} id must be 1-${WORKER_ID_MAX_PAYLOAD_LENGTH} characters, start alphanumeric, and use only A-Z a-z 0-9 . _ - .`,
        input,
      ),
    );
  }
  return ok(input as WorkerId<K>);
}

/** Parses untrusted input as a {@link WorkerRequestId}. */
export function parseWorkerRequestId(
  input: unknown,
): ParseResult<WorkerRequestId, WorkerIdParseError> {
  return parseIdOfKind("request", input);
}

/** Parses untrusted input as a {@link WorkerSolidId}. */
export function parseWorkerSolidId(
  input: unknown,
): ParseResult<WorkerSolidId, WorkerIdParseError> {
  return parseIdOfKind("solid", input);
}

/**
 * An id of any worker kind together with the kind it was recognized as;
 * useful where the expected kind is not statically known.
 */
export interface ParsedWorkerId<K extends WorkerIdKind = WorkerIdKind> {
  readonly kind: K;
  readonly id: WorkerId<K>;
}

/** Parses untrusted input as a worker id of any kind, classified by prefix. */
export function parseAnyWorkerId(
  input: unknown,
): ParseResult<ParsedWorkerId, WorkerIdParseError> {
  if (typeof input !== "string") {
    return fail(
      idError(
        WORKER_ID_ERROR_CODES.notAString,
        "A worker id must be a string.",
        input,
      ),
    );
  }
  if (input.length === 0) {
    return fail(
      idError(
        WORKER_ID_ERROR_CODES.empty,
        "A worker id must not be empty.",
        input,
      ),
    );
  }
  const separator = input.indexOf("_");
  if (separator <= 0) {
    return fail(
      idError(
        WORKER_ID_ERROR_CODES.wrongPrefix,
        `A worker id must start with one of: ${WORKER_ID_KINDS.map(
          (kind) => `"${WORKER_ID_PREFIXES[kind]}_"`,
        ).join(", ")}.`,
        input,
      ),
    );
  }
  const kind = PREFIX_TO_KIND.get(input.slice(0, separator));
  if (kind === undefined) {
    return fail(
      idError(
        WORKER_ID_ERROR_CODES.wrongPrefix,
        `Unknown worker id prefix "${input.slice(0, separator + 1)}"; expected one of: ${WORKER_ID_KINDS.map(
          (known) => `"${WORKER_ID_PREFIXES[known]}_"`,
        ).join(", ")}.`,
        input,
      ),
    );
  }
  const parsed = parseIdOfKind(kind, input);
  if (!parsed.ok) return parsed;
  return ok({ kind, id: parsed.value });
}

/** Thrown by the `create*` constructors when input violates the wire format. */
export class WorkerIdValidationError extends Error {
  readonly error: WorkerIdParseError;

  constructor(error: WorkerIdParseError) {
    super(error.message);
    this.name = "WorkerIdValidationError";
    this.error = error;
  }
}

function requireId<K extends WorkerIdKind>(kind: K, raw: string): WorkerId<K> {
  const result = parseIdOfKind(kind, raw);
  if (!result.ok) throw new WorkerIdValidationError(result.error);
  return result.value;
}

/**
 * Adopts an explicit caller-provided request id exactly as given (`req_…`
 * wire format; never rewritten). Throws {@link WorkerIdValidationError} on
 * mismatch. Prefer {@link WorkerIdGenerator.nextRequestId} unless ids must be
 * caller-chosen.
 */
export function createWorkerRequestId(raw: string): WorkerRequestId {
  return requireId("request", raw);
}

/**
 * Adopts an explicit worker-session solid id exactly as given (`wsol_…` wire
 * format). Throws {@link WorkerIdValidationError} on mismatch.
 */
export function createWorkerSolidId(raw: string): WorkerSolidId {
  return requireId("solid", raw);
}

/** Serializable per-kind counters of a {@link WorkerIdGenerator}. */
export type WorkerIdGeneratorState = Readonly<Record<WorkerIdKind, number>>;

/**
 * Stable failure code carried by {@link WorkerIdGeneratorExhaustedError} when
 * the generator refuses to emit an id past the exact-integer range.
 */
export const WORKER_ID_GENERATOR_ERROR_CODES = {
  exhausted: "worker/id-generator-exhausted",
} as const;

export type WorkerIdGeneratorErrorCode =
  (typeof WORKER_ID_GENERATOR_ERROR_CODES)[keyof typeof WORKER_ID_GENERATOR_ERROR_CODES];

/**
 * Thrown by the {@link WorkerIdGenerator} methods when a kind's counter is
 * already at Number.MAX_SAFE_INTEGER — float64 counters stop being exact
 * there, and continuing would let rounding re-emit an id the generator already
 * produced. The exhausted counter is left untouched; other kinds keep
 * emitting.
 */
export class WorkerIdGeneratorExhaustedError extends Error {
  readonly code: WorkerIdGeneratorErrorCode;
  readonly kind: WorkerIdKind;

  constructor(kind: WorkerIdKind) {
    super(
      `The ${kind} worker id counter has reached Number.MAX_SAFE_INTEGER (${Number.MAX_SAFE_INTEGER}); ids beyond it are outside the generator's contract.`,
    );
    this.name = "WorkerIdGeneratorExhaustedError";
    this.code = WORKER_ID_GENERATOR_ERROR_CODES.exhausted;
    this.kind = kind;
  }
}

/** Deterministic mint of request and solid ids for one worker channel. */
export interface WorkerIdGenerator {
  nextRequestId(): WorkerRequestId;
  nextSolidId(): WorkerSolidId;
  /** Immutable snapshot of the counters; round-trips through JSON. */
  state(): WorkerIdGeneratorState;
}

const DEFAULT_GENERATOR_STATE: WorkerIdGeneratorState = Object.freeze({
  request: 0,
  solid: 0,
});

/** Width of the zero-padded counter in generated ids (`req_000042`). */
const ID_COUNTER_WIDTH = 6;

function normalizeGeneratorState(
  initial: WorkerIdGeneratorState,
): Record<WorkerIdKind, number> {
  const counters: Record<WorkerIdKind, number> = {
    ...DEFAULT_GENERATOR_STATE,
    ...initial,
  };
  for (const kind of WORKER_ID_KINDS) {
    const count = counters[kind];
    if (!Number.isInteger(count) || count < 0) {
      throw new RangeError(
        `WorkerIdGeneratorState.${kind} must be a non-negative integer, received ${String(count)}.`,
      );
    }
  }
  return counters;
}

/**
 * Creates a deterministic worker id generator. Identical starting state always
 * produces identical id sequences (no randomness, no clock), so a worker
 * session replayed from a persisted {@link WorkerIdGeneratorState} mints the
 * same solid ids. Generated ids pass through the wire-format validators, so
 * the generator can never emit an id that would fail to parse.
 */
export function createWorkerIdGenerator(
  initial: WorkerIdGeneratorState = DEFAULT_GENERATOR_STATE,
): WorkerIdGenerator {
  const counters = normalizeGeneratorState(initial);
  const nextRawId = (kind: WorkerIdKind): string => {
    const current = counters[kind];
    if (current >= Number.MAX_SAFE_INTEGER) {
      throw new WorkerIdGeneratorExhaustedError(kind);
    }
    const count = current + 1;
    counters[kind] = count;
    return `${WORKER_ID_PREFIXES[kind]}_${String(count).padStart(ID_COUNTER_WIDTH, "0")}`;
  };
  return {
    nextRequestId: () => requireId("request", nextRawId("request")),
    nextSolidId: () => requireId("solid", nextRawId("solid")),
    state: () => Object.freeze({ ...counters }),
  };
}
