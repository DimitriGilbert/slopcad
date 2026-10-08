/**
 * The SimResultStore contract (ROADMAP-SIM Phase 61c, law S7's persistence
 * half): runs persist keyed to `document_version` with compact binary
 * payloads, through ONE interface with two first-class backends —
 * server (drizzle + tRPC, `./sim-result-store-server`) and local
 * (IndexedDB, `./sim-result-store-local`) — where client-only use is a
 * MODE, not a degradation: the local backend is not a cache or a fallback,
 * it is the same contract with no server dependency at all.
 *
 * sim-core stays runtime-dependency-free, so everything a backend needs
 * from its world is INJECTED here as a structural seam: the server backend
 * receives a client with exactly the simulations router's three-procedure
 * surface (`SimResultServerClient` — a tRPC client slice or a
 * `createCallerFactory` caller satisfies it once NOT_FOUND is mapped to
 * null by the adapter, the type-only glue the app layer owns), and the
 * local backend receives a storage seam (`./sim-result-store-local`) whose
 * real IndexedDB adapter stays thin. This module itself carries only the
 * shared wire contract and the parsers that enforce it: every run a store
 * hands back has been re-parsed against the result model — a store
 * response is as untrusted as any other boundary crossing, and a record
 * that fails declines `sim/result-record-malformed`, never a guess.
 *
 * Backend selection: the store has its OWN preference vocabulary
 * (`server` | `local`) — deliberately not the scenario record's
 * `backend` field, which selects SOLVER providers (cpu/gpu, law S2/S5)
 * and must not be overloaded with a second meaning. A consumer that asks
 * for a backend calls {@link selectSimResultStore}; `local` is the
 * everywhere-default, `server` declines loudly when no server client was
 * provided.
 */

import type { SimQualitativeFlag } from "./regime";
import type { SimError } from "./errors";
import type { SimParseResult } from "./result";
import type {
  SimHistorySeries,
  SimResult,
  SimResultStatus,
  SimResultSummary,
  SimServedBackend,
} from "./sim-result";

import { simError, SIM_ERROR_CODES } from "./errors";
import { simFail, simOk } from "./result";
import { SIM_QUALITATIVE_FLAGS } from "./regime";
import { decodeSimBase64Strict, encodeSimBase64 } from "./sim-base64";
import {
  decodeSimResultPayload,
  encodeSimResultPayload,
  SIM_RESULT_STATUSES,
  SIM_RESULT_SUMMARY_VERSION,
} from "./sim-result";

// ---------------------------------------------------------------------------
// Structural bounds (the input budget every parser enforces)
// ---------------------------------------------------------------------------

/** The most quantities one summary may carry (bounded before JSON size). */
export const SIM_RESULT_SUMMARY_MAX_QUANTITIES = 1024;

/** The most history series one run may carry. */
export const SIM_RESULT_MAX_HISTORIES = 256;

/** The most samples one history series may carry. */
export const SIM_HISTORY_MAX_SAMPLES = 1_000_000;

/** The longest label (quantity/series name or unit, failure code). */
export const SIM_RESULT_LABEL_MAX_LENGTH = 255;

/** The longest failure message a summary may carry. */
export const SIM_RESULT_FAILURE_MESSAGE_MAX_LENGTH = 4096;

/** The run-id budget — the worker id payload pattern, pinned to the same rule. */
export const SIM_RESULT_RUN_ID_MAX_LENGTH = 64;

const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** The scenario-snapshot hash's canonical form: djb2's 8 lowercase hex digits. */
const SNAPSHOT_HASH_PATTERN = /^[0-9a-f]{8}$/;

/** Canonical UTC ISO timestamps (what `Date.prototype.toISOString` emits). */
const ISO_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

function isPlainRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}

function recordMalformed(
  message: string,
  input: unknown,
): SimParseResult<never, SimError> {
  return simFail(
    simError(SIM_ERROR_CODES.resultRecordMalformed, message, input),
  );
}

function parseLabel(
  input: unknown,
  what: string,
  maxLength: number,
): SimParseResult<string, SimError> {
  if (
    typeof input !== "string" ||
    input.length === 0 ||
    input.length > maxLength
  ) {
    return recordMalformed(
      `${what} must be a non-empty label of at most ${String(maxLength)} characters.`,
      input,
    );
  }
  return simOk(input);
}

function parseFiniteNumber(
  input: unknown,
  what: string,
): SimParseResult<number, SimError> {
  if (typeof input !== "number" || !Number.isFinite(input)) {
    return recordMalformed(`${what} must be a finite number.`, input);
  }
  return simOk(input);
}

function parseIsoTimestamp(
  input: unknown,
  what: string,
): SimParseResult<string, SimError> {
  if (typeof input !== "string" || !ISO_TIMESTAMP_PATTERN.test(input)) {
    return recordMalformed(
      `${what} must be a canonical UTC ISO timestamp (YYYY-MM-DDTHH:mm:ss[.sss]Z).`,
      input,
    );
  }
  return simOk(input);
}

// ---------------------------------------------------------------------------
// The summary and histories parsers (the wire contract's JSON half)
// ---------------------------------------------------------------------------

/**
 * Parses untrusted input as a {@link SimResultSummary} — the single
 * validation the router's input boundary, the server backend's response
 * boundary, and the local backend's storage boundary all share. Reconstructs
 * the summary with a FIXED key order (so a round-tripped summary
 * re-serializes to identical bytes — the byte-determinism law), frozen.
 */
export function parseSimResultSummary(
  input: unknown,
): SimParseResult<SimResultSummary, SimError> {
  if (!isPlainRecord(input)) {
    return recordMalformed("A result summary must be a plain object.", input);
  }
  if (input.schemaVersion !== SIM_RESULT_SUMMARY_VERSION) {
    return recordMalformed(
      `A result summary must carry schemaVersion ${String(SIM_RESULT_SUMMARY_VERSION)}.`,
      input.schemaVersion,
    );
  }
  if (
    typeof input.scenarioSnapshotHash !== "string" ||
    !SNAPSHOT_HASH_PATTERN.test(input.scenarioSnapshotHash)
  ) {
    return recordMalformed(
      "A result summary's scenarioSnapshotHash must be 8 lowercase hex digits (the snapshot hash's canonical form).",
      input.scenarioSnapshotHash,
    );
  }
  if (
    typeof input.status !== "string" ||
    !SIM_RESULT_STATUSES.includes(input.status as SimResultStatus)
  ) {
    return recordMalformed(
      `A result summary's status must be one of: ${SIM_RESULT_STATUSES.join(", ")}.`,
      input.status,
    );
  }
  const status = input.status as SimResultStatus;
  if (!isPlainRecord(input.regime)) {
    return recordMalformed(
      "A result summary must carry a regime report object.",
      input.regime,
    );
  }
  const regimeSource = input.regime;
  const regimeNumbers: Record<string, number> = {};
  for (const key of ["reynolds", "mach", "prandtl", "rayleigh"] as const) {
    const value = regimeSource[key];
    if (value === undefined) continue;
    const parsed = parseFiniteNumber(value, `A regime report's ${key} number`);
    if (!parsed.ok) return parsed;
    regimeNumbers[key] = parsed.value;
  }
  if (!Array.isArray(regimeSource.qualitative)) {
    return recordMalformed(
      "A regime report's qualitative flags must be an array.",
      regimeSource.qualitative,
    );
  }
  const qualitative: SimQualitativeFlag[] = [];
  for (const flag of regimeSource.qualitative) {
    if (
      typeof flag !== "string" ||
      !SIM_QUALITATIVE_FLAGS.includes(flag as SimQualitativeFlag)
    ) {
      return recordMalformed(
        `A regime report's qualitative flags must come from: ${SIM_QUALITATIVE_FLAGS.join(", ")}.`,
        flag,
      );
    }
    qualitative.push(flag as SimQualitativeFlag);
  }
  if (!Array.isArray(input.quantities)) {
    return recordMalformed(
      "A result summary's quantities must be an array.",
      input.quantities,
    );
  }
  if (input.quantities.length > SIM_RESULT_SUMMARY_MAX_QUANTITIES) {
    return recordMalformed(
      `A result summary carries more than ${String(SIM_RESULT_SUMMARY_MAX_QUANTITIES)} quantities.`,
      input.quantities.length,
    );
  }
  const quantities: {
    readonly name: string;
    readonly value: number;
    readonly unit: string;
  }[] = [];
  for (const entry of input.quantities) {
    if (!isPlainRecord(entry)) {
      return recordMalformed(
        "A projected quantity must be a plain object with name, value, and unit fields.",
        entry,
      );
    }
    const name = parseLabel(
      entry.name,
      "A quantity's name",
      SIM_RESULT_LABEL_MAX_LENGTH,
    );
    if (!name.ok) return name;
    const value = parseFiniteNumber(
      entry.value,
      `The quantity "${name.value}"'s value`,
    );
    if (!value.ok) return value;
    const unit = parseLabel(
      entry.unit,
      `The quantity "${name.value}"'s unit`,
      SIM_RESULT_LABEL_MAX_LENGTH,
    );
    if (!unit.ok) return unit;
    quantities.push({
      name: name.value,
      value: value.value,
      unit: unit.value,
    });
  }
  let failureCode: string | undefined;
  if (input.failureCode !== undefined) {
    const parsed = parseLabel(
      input.failureCode,
      "A summary's failure code",
      SIM_RESULT_LABEL_MAX_LENGTH,
    );
    if (!parsed.ok) return parsed;
    failureCode = parsed.value;
  }
  let servedBackend: SimServedBackend | undefined;
  if (input.servedBackend !== undefined) {
    if (input.servedBackend !== "cpu" && input.servedBackend !== "gpu") {
      return recordMalformed(
        'A result summary\'s servedBackend must be "cpu" or "gpu".',
        input.servedBackend,
      );
    }
    servedBackend = input.servedBackend;
  }
  let failureMessage: string | undefined;
  if (input.failureMessage !== undefined) {
    const parsed = parseLabel(
      input.failureMessage,
      "A summary's failure message",
      SIM_RESULT_FAILURE_MESSAGE_MAX_LENGTH,
    );
    if (!parsed.ok) return parsed;
    failureMessage = parsed.value;
  }
  if (
    status === "failed" &&
    (failureCode === undefined || failureMessage === undefined)
  ) {
    return recordMalformed(
      "A failed run's summary must carry both a failure code and a failure message.",
      input,
    );
  }
  return simOk(
    Object.freeze({
      schemaVersion: SIM_RESULT_SUMMARY_VERSION,
      scenarioSnapshotHash: input.scenarioSnapshotHash,
      status,
      regime: Object.freeze({
        ...(regimeNumbers.reynolds === undefined
          ? {}
          : { reynolds: regimeNumbers.reynolds }),
        ...(regimeNumbers.mach === undefined
          ? {}
          : { mach: regimeNumbers.mach }),
        ...(regimeNumbers.prandtl === undefined
          ? {}
          : { prandtl: regimeNumbers.prandtl }),
        ...(regimeNumbers.rayleigh === undefined
          ? {}
          : { rayleigh: regimeNumbers.rayleigh }),
        qualitative: Object.freeze(qualitative),
      }),
      quantities: Object.freeze(quantities),
      ...(servedBackend === undefined ? {} : { servedBackend }),
      ...(failureCode === undefined ? {} : { failureCode }),
      ...(failureMessage === undefined ? {} : { failureMessage }),
    }),
  );
}

/**
 * Parses untrusted input as a run's histories — the same contract the
 * summary parser holds, for the {@link SimHistorySeries} list. Reconstructs
 * frozen, fixed-key-order series.
 */
export function parseSimHistorySeriesList(
  input: unknown,
): SimParseResult<readonly SimHistorySeries[], SimError> {
  if (!Array.isArray(input)) {
    return recordMalformed("A run's histories must be an array.", input);
  }
  if (input.length > SIM_RESULT_MAX_HISTORIES) {
    return recordMalformed(
      `A run carries more than ${String(SIM_RESULT_MAX_HISTORIES)} history series.`,
      input.length,
    );
  }
  const histories: {
    readonly name: string;
    readonly unit: string;
    readonly samples: readonly number[];
  }[] = [];
  for (const entry of input) {
    if (!isPlainRecord(entry)) {
      return recordMalformed(
        "A history series must be a plain object with name, unit, and samples fields.",
        entry,
      );
    }
    const name = parseLabel(
      entry.name,
      "A history series' name",
      SIM_RESULT_LABEL_MAX_LENGTH,
    );
    if (!name.ok) return name;
    const unit = parseLabel(
      entry.unit,
      `The history "${name.value}"'s unit`,
      SIM_RESULT_LABEL_MAX_LENGTH,
    );
    if (!unit.ok) return unit;
    if (!Array.isArray(entry.samples)) {
      return recordMalformed(
        `The history "${name.value}"'s samples must be an array.`,
        entry.samples,
      );
    }
    if (entry.samples.length > SIM_HISTORY_MAX_SAMPLES) {
      return recordMalformed(
        `The history "${name.value}" carries more than ${String(SIM_HISTORY_MAX_SAMPLES)} samples.`,
        entry.samples.length,
      );
    }
    const samples: number[] = [];
    for (const sample of entry.samples) {
      const parsed = parseFiniteNumber(
        sample,
        `The history "${name.value}"'s samples`,
      );
      if (!parsed.ok) return parsed;
      samples.push(parsed.value);
    }
    histories.push({
      name: name.value,
      unit: unit.value,
      samples: Object.freeze(samples),
    });
  }
  return simOk(Object.freeze(histories));
}

// ---------------------------------------------------------------------------
// The run record (list/get metadata) and its parser
// ---------------------------------------------------------------------------

/** One persisted run's metadata: identity, provenance, status, timestamps. */
export interface SimResultRunRecord {
  readonly id: string;
  readonly documentVersionId: string;
  readonly scenarioSnapshotHash: string;
  readonly status: SimResultStatus;
  readonly summary: SimResultSummary;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * Parses untrusted input as a {@link SimResultRunRecord}, cross-checking the
 * derived columns against the summary they were derived from (hash and
 * status must agree — the integrity pin the insert path guarantees and every
 * read path re-verifies).
 */
export function parseSimResultRunRecord(
  input: unknown,
): SimParseResult<SimResultRunRecord, SimError> {
  if (!isPlainRecord(input)) {
    return recordMalformed("A run record must be a plain object.", input);
  }
  if (
    typeof input.id !== "string" ||
    !RUN_ID_PATTERN.test(input.id) ||
    input.id.length > SIM_RESULT_RUN_ID_MAX_LENGTH
  ) {
    return recordMalformed(
      "A run record's id must match [A-Za-z0-9][A-Za-z0-9._-]{0,63}.",
      input.id,
    );
  }
  if (
    typeof input.documentVersionId !== "string" ||
    input.documentVersionId.length === 0 ||
    input.documentVersionId.length > SIM_RESULT_RUN_ID_MAX_LENGTH
  ) {
    return recordMalformed(
      "A run record's documentVersionId must be a non-empty id of at most 64 characters.",
      input.documentVersionId,
    );
  }
  const summary = parseSimResultSummary(input.summary);
  if (!summary.ok) return summary;
  if (input.scenarioSnapshotHash !== summary.value.scenarioSnapshotHash) {
    return recordMalformed(
      "A run record's scenarioSnapshotHash disagrees with its summary's (the derived column and its source must agree).",
      input.scenarioSnapshotHash,
    );
  }
  if (input.status !== summary.value.status) {
    return recordMalformed(
      "A run record's status disagrees with its summary's (the derived column and its source must agree).",
      input.status,
    );
  }
  const createdAt = parseIsoTimestamp(
    input.createdAt,
    "A run record's createdAt",
  );
  if (!createdAt.ok) return createdAt;
  const updatedAt = parseIsoTimestamp(
    input.updatedAt,
    "A run record's updatedAt",
  );
  if (!updatedAt.ok) return updatedAt;
  return simOk(
    Object.freeze({
      id: input.id,
      documentVersionId: input.documentVersionId,
      scenarioSnapshotHash: summary.value.scenarioSnapshotHash,
      status: summary.value.status,
      summary: summary.value,
      createdAt: createdAt.value,
      updatedAt: updatedAt.value,
    }),
  );
}

// ---------------------------------------------------------------------------
// The store contract
// ---------------------------------------------------------------------------

/** A full stored run: the record plus the decoded {@link SimResult}. */
export interface SimStoredResult {
  readonly record: SimResultRunRecord;
  readonly result: SimResult;
}

/**
 * The law-S7 store: put persists one run against a document version (the
 * backend mints the run id and timestamps and returns the record), list
 * enumerates a version's runs chronologically (payloads excluded — a list
 * is metadata plus summaries), and get fetches one full run. `null` from
 * get means "no such run"; every failure declines structured `sim/*`.
 */
export interface SimResultStore {
  put(
    documentVersionId: string,
    result: SimResult,
  ): Promise<SimParseResult<SimResultRunRecord, SimError>>;
  list(
    documentVersionId: string,
  ): Promise<SimParseResult<readonly SimResultRunRecord[], SimError>>;
  get(runId: string): Promise<SimParseResult<SimStoredResult | null, SimError>>;
}

/**
 * Groups a version's runs by their scenario-snapshot hash — the §7.11
 * provenance keying the Phase 63 comparison surface addresses: runs of the
 * identical scenario share a hash (comparable runs), an authored change to
 * the scenario changes the hash (a different group). Insertion order of
 * groups and of runs within a group follows the input (a store's list is
 * chronological).
 */
export function groupSimResultRunsBySnapshotHash(
  runs: readonly SimResultRunRecord[],
): ReadonlyMap<string, readonly SimResultRunRecord[]> {
  const groups = new Map<string, SimResultRunRecord[]>();
  for (const run of runs) {
    const bucket = groups.get(run.scenarioSnapshotHash);
    if (bucket === undefined) {
      groups.set(run.scenarioSnapshotHash, [run]);
    } else {
      bucket.push(run);
    }
  }
  return groups;
}

// ---------------------------------------------------------------------------
// The server wire contract (the simulations router's surface, as types)
// ---------------------------------------------------------------------------

/** The put wire input: the run's content with the payload as base64 text. */
export interface SimResultPutWireInput {
  readonly documentVersionId: string;
  readonly summary: SimResultSummary;
  readonly payloadBase64: string;
  readonly histories: readonly SimHistorySeries[];
}

/** The get wire output: the record plus the payload (base64) and histories. */
export interface SimResultRunWire extends SimResultRunRecord {
  readonly payloadBase64: string;
  readonly histories: readonly SimHistorySeries[];
}

/**
 * The injected server-client seam: exactly the simulations router's three
 * procedures. A tRPC client slice (or a `createCallerFactory` caller's
 * `simulations`) satisfies it structurally once the adapter maps the
 * router's NOT_FOUND on `get` to `null` — the app layer owns that mapping
 * (type-only glue; sim-core never imports a tRPC runtime).
 */
export interface SimResultServerClient {
  list(input: {
    readonly documentVersionId: string;
  }): Promise<readonly SimResultRunRecord[]>;
  get(input: { readonly runId: string }): Promise<SimResultRunWire | null>;
  put(input: SimResultPutWireInput): Promise<SimResultRunRecord>;
}

/**
 * Encodes a run's content to its put wire form: the summary and histories
 * are validated and canonically reconstructed here (so what crosses the
 * wire re-serializes deterministically), and the field blocks encode to
 * strict base64 SMR1 bytes.
 */
export function encodeSimResultPutWireInput(
  documentVersionId: string,
  result: SimResult,
): SimParseResult<SimResultPutWireInput, SimError> {
  const summary = parseSimResultSummary(result.summary);
  if (!summary.ok) return summary;
  const histories = parseSimHistorySeriesList(result.histories);
  if (!histories.ok) return histories;
  const encoded = encodeSimResultPayload(result.fields);
  if (!encoded.ok) return encoded;
  return simOk(
    Object.freeze({
      documentVersionId,
      summary: summary.value,
      payloadBase64: encodeSimBase64(encoded.value),
      histories: histories.value,
    }),
  );
}

/**
 * Decodes a get wire output to a full stored run: the record parses, the
 * base64 decodes strictly, the SMR1 payload decodes to field blocks, and
 * the histories parse — every layer refusing `sim/*`-structured.
 */
export function decodeSimResultRunWire(
  input: unknown,
): SimParseResult<SimStoredResult, SimError> {
  if (!isPlainRecord(input)) {
    return recordMalformed("A stored run must be a plain object.", input);
  }
  const record = parseSimResultRunRecord(input);
  if (!record.ok) return record;
  if (typeof input.payloadBase64 !== "string") {
    return recordMalformed(
      "A stored run's payload must be base64 text.",
      input.payloadBase64,
    );
  }
  const bytes = decodeSimBase64Strict(input.payloadBase64);
  if (bytes === null) {
    return recordMalformed(
      "A stored run's payload is not canonical base64.",
      input.payloadBase64,
    );
  }
  const fields = decodeSimResultPayload(bytes);
  if (!fields.ok) return fields;
  const histories = parseSimHistorySeriesList(input.histories);
  if (!histories.ok) return histories;
  return simOk(
    Object.freeze({
      record: record.value,
      result: Object.freeze({
        summary: record.value.summary,
        fields: fields.value,
        histories: histories.value,
      }),
    }),
  );
}

// ---------------------------------------------------------------------------
// Backend selection
// ---------------------------------------------------------------------------

/** The store's own backend vocabulary (law S7's two first-class modes). */
export const SIM_RESULT_STORE_BACKENDS = ["server", "local"] as const;

export type SimResultStoreBackend = (typeof SIM_RESULT_STORE_BACKENDS)[number];

/** The implementations a consumer offers the selector. */
export interface SelectSimResultStoreOptions {
  /** The server-backed store; may be absent (a client-only host). */
  readonly server?: SimResultStore;
  /** The local-backed store; required — it is the everywhere-mode. */
  readonly local: SimResultStore;
}

/**
 * Resolves the store a consumer asked for. An absent preference selects
 * `local` (the mode with no dependencies); `server` without a server
 * implementation declines `sim/store-unavailable` loudly — the honest
 * refusal, never a silent local fallback that would masquerade as the
 * server mode. The scenario record's own `backend` field (cpu/gpu) selects
 * SOLVER providers and is intentionally NOT consulted here.
 */
export function selectSimResultStore(
  preference: SimResultStoreBackend | undefined,
  options: SelectSimResultStoreOptions,
): SimParseResult<SimResultStore, SimError> {
  const backend = preference ?? "local";
  if (backend === "local") {
    return simOk(options.local);
  }
  const server = options.server;
  if (server === undefined) {
    return simFail(
      simError(
        SIM_ERROR_CODES.storeUnavailable,
        "A server-backed SimResultStore was preferred, but no server client was provided on this host; the local backend is a mode, not a fallback, and the preference is honored loudly.",
        preference,
      ),
    );
  }
  return simOk(server);
}
