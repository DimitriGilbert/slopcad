/**
 * Branded, type-distinct identifiers of the sim worker protocol (Phase 61b):
 * request ids correlate a response (or a cancellation) with the request that
 * caused it, and the two session-state ids address what a sim worker session
 * mints — compiled problems (`sim.compile`) and completed runs
 * (`sim.run`) — the wire stand-ins for values that cannot sensibly cross a
 * message boundary whole, exactly as {@link WorkerSolidId} addresses kernel
 * solids in the kernel worker protocol.
 *
 * sim-core depends on nothing at runtime, so the kernel protocol's id
 * discipline (`@slopcad/cad-kernel`'s `worker-ids`) is RESTATED here with
 * its wire formats pinned to the same rules: `<prefix>_<payload>` ids whose
 * payloads use `A-Z a-z 0-9 . _ -`, start alphanumeric, and stay within the
 * same length budget. The `req_` prefix (and its payload pattern) is
 * deliberately IDENTICAL to the kernel's — the two envelopes are
 * byte-compatible at the correlation layer, and a cross-compatibility test
 * pins the formats against drift. The semantic authority is the kernel
 * module; this restatement exists so the sim stack keeps its zero-runtime-
 * dependency stance (`./result` applies the same policy to ParseResult).
 *
 * Uniqueness and correlation safety carry over unchanged: a request id is
 * single-use per channel, enforced by the cancellation ledger
 * (`./sim-worker-cancellation`), and session ids are minted by a
 * deterministic generator so a replayed request sequence assigns identical
 * ids.
 */

/**
 * Sole branding site of the module. A `unique symbol` property keeps id kinds
 * mutually incompatible at the type level while remaining invisible at
 * runtime, so branded ids stay plain serializable strings.
 */
declare const simWorkerIdBrand: unique symbol;

type BrandedSimWorkerId<K extends SimWorkerIdKind> = string & {
  readonly [simWorkerIdBrand]: K;
};

/** The three sim worker id kinds. */
export const SIM_WORKER_ID_KINDS = ["request", "problem", "run"] as const;

export type SimWorkerIdKind = (typeof SIM_WORKER_ID_KINDS)[number];

/** Identifier correlating one request with its response/cancellation. */
export type SimWorkerRequestId = BrandedSimWorkerId<"request">;
/** Identifier of a compiled problem minted by `sim.compile` (`wprob_000001`). */
export type SimProblemId = BrandedSimWorkerId<"problem">;
/** Identifier of a completed run minted by `sim.run` (`wrun_000001`). */
export type SimRunId = BrandedSimWorkerId<"run">;

type SimWorkerIdTable = {
  request: SimWorkerRequestId;
  problem: SimProblemId;
  run: SimRunId;
};

/** The branded id type of a given id kind. */
export type SimWorkerId<K extends SimWorkerIdKind> = SimWorkerIdTable[K];

/**
 * Canonical wire prefixes. The prefix determines the kind of an id on the
 * wire; prefixes are lowercase and case-sensitive. `req` is pinned to the
 * kernel request prefix; `wprob`/`wrun` name the sim session state in the
 * kernel's `wsol` style.
 */
export const SIM_WORKER_ID_PREFIXES: Readonly<Record<SimWorkerIdKind, string>> =
  Object.freeze({
    request: "req",
    problem: "wprob",
    run: "wrun",
  });

/**
 * Maximum length of the payload after the `<prefix>_` separator — the kernel
 * protocol's budget, pinned equal.
 */
export const SIM_WORKER_ID_MAX_PAYLOAD_LENGTH = 64;

const ID_PAYLOAD_PATTERN = new RegExp(
  `^[A-Za-z0-9][A-Za-z0-9._-]{0,${SIM_WORKER_ID_MAX_PAYLOAD_LENGTH - 1}}$`,
);

/** Structured failure describing why input was rejected as a sim worker id. */
export interface SimWorkerIdParseError {
  /** Stable `sim/*` refusal code (`worker/id-*` restated as sim-side data). */
  readonly code: string;
  readonly message: string;
  readonly input: unknown;
}

function idError(
  code: string,
  message: string,
  input: unknown,
): SimWorkerIdParseError {
  return { code, message, input };
}

/**
 * Core wire-format validator shared by all kinds. This is the single place
 * where a validated string is trusted as a branded sim worker id; the cast
 * only brands input that has already passed the checks above.
 */
function parseIdOfKind<K extends SimWorkerIdKind>(
  kind: K,
  input: unknown,
): SimParseIdResult<SimWorkerId<K>> {
  if (typeof input !== "string") {
    return simIdFail(
      idError(
        "sim/worker-id-not-a-string",
        `A ${kind} id must be a string.`,
        input,
      ),
    );
  }
  if (input.length === 0) {
    return simIdFail(
      idError("sim/worker-id-empty", `A ${kind} id must not be empty.`, input),
    );
  }
  const prefix = `${SIM_WORKER_ID_PREFIXES[kind]}_`;
  if (!input.startsWith(prefix)) {
    return simIdFail(
      idError(
        "sim/worker-id-wrong-prefix",
        `A ${kind} id must start with "${prefix}".`,
        input,
      ),
    );
  }
  const payload = input.slice(prefix.length);
  if (!ID_PAYLOAD_PATTERN.test(payload)) {
    return simIdFail(
      idError(
        "sim/worker-id-invalid-payload",
        `The payload of a ${kind} id must be 1-${SIM_WORKER_ID_MAX_PAYLOAD_LENGTH} characters, start alphanumeric, and use only A-Z a-z 0-9 . _ - .`,
        input,
      ),
    );
  }
  return simIdOk(input as SimWorkerId<K>);
}

/** Parses untrusted input as a {@link SimWorkerRequestId}. */
export function parseSimWorkerRequestId(
  input: unknown,
): SimParseIdResult<SimWorkerRequestId> {
  return parseIdOfKind("request", input);
}

/** Parses untrusted input as a {@link SimProblemId}. */
export function parseSimProblemId(
  input: unknown,
): SimParseIdResult<SimProblemId> {
  return parseIdOfKind("problem", input);
}

/** Parses untrusted input as a {@link SimRunId}. */
export function parseSimRunId(input: unknown): SimParseIdResult<SimRunId> {
  return parseIdOfKind("run", input);
}

/** The id-local result pair (ids validate before any envelope exists). */
type SimParseIdResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: SimWorkerIdParseError };

function simIdOk<T>(value: T): SimParseIdResult<T> {
  return { ok: true, value };
}

function simIdFail<T>(error: SimWorkerIdParseError): SimParseIdResult<T> {
  return { ok: false, error };
}

/** Thrown by the `create*` constructors when input violates the wire format. */
export class SimWorkerIdValidationError extends Error {
  readonly error: SimWorkerIdParseError;

  constructor(error: SimWorkerIdParseError) {
    super(error.message);
    this.name = "SimWorkerIdValidationError";
    this.error = error;
  }
}

function requireId<K extends SimWorkerIdKind>(
  kind: K,
  raw: string,
): SimWorkerId<K> {
  const result = parseIdOfKind(kind, raw);
  if (!result.ok) throw new SimWorkerIdValidationError(result.error);
  return result.value;
}

/**
 * Adopts an explicit caller-provided request id exactly as given (`req_…`
 * wire format; never rewritten). Throws {@link SimWorkerIdValidationError} on
 * mismatch. Prefer {@link SimWorkerIdGenerator.nextRequestId} unless ids must
 * be caller-chosen.
 */
export function createSimWorkerRequestId(raw: string): SimWorkerRequestId {
  return requireId("request", raw);
}

/** Serializable per-kind counters of a {@link SimWorkerIdGenerator}. */
export type SimWorkerIdGeneratorState = Readonly<
  Record<SimWorkerIdKind, number>
>;

const DEFAULT_GENERATOR_STATE: SimWorkerIdGeneratorState = Object.freeze({
  request: 0,
  problem: 0,
  run: 0,
});

/** Width of the zero-padded counter in generated ids (`req_000042`). */
const ID_COUNTER_WIDTH = 6;

function normalizeGeneratorState(
  initial: SimWorkerIdGeneratorState,
): Record<SimWorkerIdKind, number> {
  const counters: Record<SimWorkerIdKind, number> = {
    ...DEFAULT_GENERATOR_STATE,
    ...initial,
  };
  for (const kind of SIM_WORKER_ID_KINDS) {
    const count = counters[kind];
    if (!Number.isInteger(count) || count < 0) {
      throw new RangeError(
        `SimWorkerIdGeneratorState.${kind} must be a non-negative integer, received ${String(count)}.`,
      );
    }
  }
  return counters;
}

/**
 * Deterministic mint of request, problem, and run ids for one sim worker
 * channel. Identical starting state always produces identical id sequences
 * (no randomness, no clock); generated ids pass through the wire-format
 * validators, so the generator can never emit an id that would fail to parse.
 */
export interface SimWorkerIdGenerator {
  nextRequestId(): SimWorkerRequestId;
  nextProblemId(): SimProblemId;
  nextRunId(): SimRunId;
  /** Immutable snapshot of the counters; round-trips through JSON. */
  state(): SimWorkerIdGeneratorState;
}

/** Creates a deterministic sim worker id generator. */
export function createSimWorkerIdGenerator(
  initial: SimWorkerIdGeneratorState = DEFAULT_GENERATOR_STATE,
): SimWorkerIdGenerator {
  const counters = normalizeGeneratorState(initial);
  const nextRawId = (kind: SimWorkerIdKind): string => {
    const current = counters[kind];
    if (current >= Number.MAX_SAFE_INTEGER) {
      throw new RangeError(
        `The ${kind} sim worker id counter has reached Number.MAX_SAFE_INTEGER; ids beyond it are outside the generator's contract.`,
      );
    }
    const count = current + 1;
    counters[kind] = count;
    return `${SIM_WORKER_ID_PREFIXES[kind]}_${String(count).padStart(ID_COUNTER_WIDTH, "0")}`;
  };
  return {
    nextRequestId: () => requireId("request", nextRawId("request")),
    nextProblemId: () => requireId("problem", nextRawId("problem")),
    nextRunId: () => requireId("run", nextRawId("run")),
    state: () => Object.freeze({ ...counters }),
  };
}
