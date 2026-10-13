/**
 * The local SimResultStore backend (Phase 61c, law S7): the same contract
 * as the server backend over a STORAGE SEAM instead of a router client —
 * client-only use is a MODE, not a degradation, and this backend has no
 * server dependency at all. The seam (`SimResultStorage`) is deliberately
 * minimal — put/get/keys — so the real IndexedDB adapter
 * (`./sim-result-store-idb`) stays thin and unit tests run in plain Node
 * against the in-memory double (`createInMemorySimResultStorage`)
 * implementing the same interface: no DOM, no fake-indexeddb dependency,
 * no environment branching.
 *
 * Records persist as canonical JSON text (summary, histories) plus the
 * verbatim SMR1 payload bytes — the same shapes the server's
 * `simulation_run` row carries — and every read re-parses through the
 * shared contract parsers, exactly like the server path: a corrupt record
 * declines `sim/result-record-malformed`, a storage throw declines
 * `sim/store-unavailable`, and a run is never fabricated.
 *
 * Run ids are minted deterministically by default (`srun_000001`, the
 * 61b id-generator discipline) and advance past ids the storage already
 * holds; `now` is injectable for the same determinism in tests.
 */

import type { SimError } from "./errors";
import type { SimParseResult } from "./result";
import type { SimResultStatus } from "./sim-result";
import type {
  SimResultRunRecord,
  SimResultStore,
  SimStoredResult,
} from "./sim-result-store";

import { simError, SIM_ERROR_CODES } from "./errors";
import { simFail, simOk } from "./result";
import { decodeSimResultPayload, encodeSimResultPayload } from "./sim-result";
import {
  parseSimHistorySeriesList,
  parseSimResultRunRecord,
  parseSimResultSummary,
} from "./sim-result-store";

// ---------------------------------------------------------------------------
// The storage seam
// ---------------------------------------------------------------------------

/** One run as the storage holds it: canonical JSON text plus raw SMR1 bytes. */
export interface SimResultStorageRecord {
  readonly runId: string;
  readonly documentVersionId: string;
  readonly scenarioSnapshotHash: string;
  readonly status: SimResultStatus;
  readonly summaryJson: string;
  readonly historiesJson: string;
  readonly payload: Uint8Array;
  readonly createdAtIso: string;
  readonly updatedAtIso: string;
}

/**
 * The minimal storage seam the local backend needs — open/put/get/keys, the
 * exact surface `./sim-result-store-idb` implements over IndexedDB and the
 * in-memory double implements over a Map. Structural on purpose: any
 * key-value store with byte-faithful values can back the local mode.
 */
export interface SimResultStorage {
  put(record: SimResultStorageRecord): Promise<void>;
  get(runId: string): Promise<SimResultStorageRecord | null>;
  keys(): Promise<readonly string[]>;
}

/**
 * The in-memory storage double: one Map, insertion-ordered, byte-faithful
 * (records are stored as given, cloned defensively on read so a test cannot
 * mutate storage through a returned record). This is the node-env test
 * backend — the same seam, not a simulation of IndexedDB's semantics.
 */
export function createInMemorySimResultStorage(): SimResultStorage {
  const records = new Map<string, SimResultStorageRecord>();
  return {
    put(record) {
      records.set(record.runId, record);
      return Promise.resolve();
    },
    get(runId) {
      const found = records.get(runId);
      return Promise.resolve(
        found === undefined
          ? null
          : { ...found, payload: new Uint8Array(found.payload) },
      );
    },
    keys() {
      return Promise.resolve([...records.keys()]);
    },
  };
}

// ---------------------------------------------------------------------------
// Run-id minting
// ---------------------------------------------------------------------------

/** Width of the zero-padded counter in minted run ids (`srun_000042`). */
const RUN_ID_COUNTER_WIDTH = 6;

/** The minted run id's prefix (the 61b `wrun_` discipline, `s` for store). */
const RUN_ID_PREFIX = "srun_";

/**
 * Creates a deterministic run-id minter — a monotonic counter, no
 * randomness, no clock (the 61b generator's discipline for store ids).
 * Collisions across store instances over one storage are resolved by the
 * backend advancing past taken ids; callers needing global uniqueness
 * inject their own minter (e.g. crypto.randomUUID).
 */
export function createSimResultRunIdMinter(): () => string {
  let counter = 0;
  return () => {
    counter += 1;
    return `${RUN_ID_PREFIX}${String(counter).padStart(RUN_ID_COUNTER_WIDTH, "0")}`;
  };
}

// ---------------------------------------------------------------------------
// The backend
// ---------------------------------------------------------------------------

/** What the local backend needs: the storage seam, plus injectable minters. */
export interface LocalSimResultStoreOptions {
  readonly storage: SimResultStorage;
  /** Run-id minter; defaults to the deterministic `srun_` counter. */
  readonly newRunId?: () => string;
  /** Clock; defaults to the real time. Inject for deterministic tests. */
  readonly now?: () => Date;
}

/** Wraps a storage call's throw as the structured store-unavailable decline. */
async function callStorage<T>(
  operation: string,
  run: () => Promise<T>,
): Promise<SimParseResult<T, SimError>> {
  try {
    return { ok: true, value: await run() };
  } catch (error) {
    return {
      ok: false,
      error: simError(
        SIM_ERROR_CODES.storeUnavailable,
        `The local result storage failed during ${operation}: ${error instanceof Error ? error.message : String(error)}`,
        undefined,
      ),
    };
  }
}

/** Parses storage JSON text to unknown, declining on non-JSON text. */
function parseStorageJson(
  text: string,
  what: string,
): SimParseResult<unknown, SimError> {
  try {
    const value: unknown = JSON.parse(text);
    return simOk(value);
  } catch {
    return simFail(
      simError(
        SIM_ERROR_CODES.resultRecordMalformed,
        `${what} is not valid JSON.`,
        text,
      ),
    );
  }
}

/** Reconstructs a run record from a storage record (no payload decode). */
function storageRecordToRunRecord(
  record: SimResultStorageRecord,
): SimParseResult<SimResultRunRecord, SimError> {
  const summaryJson = parseStorageJson(
    record.summaryJson,
    "A stored run's summary",
  );
  if (!summaryJson.ok) return summaryJson;
  return parseSimResultRunRecord({
    id: record.runId,
    documentVersionId: record.documentVersionId,
    scenarioSnapshotHash: record.scenarioSnapshotHash,
    status: record.status,
    summary: summaryJson.value,
    createdAt: record.createdAtIso,
    updatedAt: record.updatedAtIso,
  });
}

/** Builds the local-backed store over the storage seam. */
export function createLocalSimResultStore(
  options: LocalSimResultStoreOptions,
): SimResultStore {
  const storage = options.storage;
  const newRunId = options.newRunId ?? createSimResultRunIdMinter();
  const now = options.now ?? (() => new Date());
  return {
    async put(documentVersionId, result) {
      const summary = parseSimResultSummary(result.summary);
      if (!summary.ok) return summary;
      const histories = parseSimHistorySeriesList(result.histories);
      if (!histories.ok) return histories;
      const payload = encodeSimResultPayload(result.fields);
      if (!payload.ok) return payload;
      let runId = newRunId();
      for (;;) {
        const taken = await callStorage("a put's id check", () =>
          storage.get(runId),
        );
        if (!taken.ok) return taken;
        if (taken.value === null) break;
        runId = newRunId();
      }
      const stamp = now().toISOString();
      const record: SimResultStorageRecord = {
        runId,
        documentVersionId,
        scenarioSnapshotHash: summary.value.scenarioSnapshotHash,
        status: summary.value.status,
        summaryJson: JSON.stringify(summary.value),
        historiesJson: JSON.stringify(histories.value),
        payload: payload.value,
        createdAtIso: stamp,
        updatedAtIso: stamp,
      };
      const written = await callStorage("a run put", () => storage.put(record));
      if (!written.ok) return written;
      return simOk(
        Object.freeze({
          id: runId,
          documentVersionId,
          scenarioSnapshotHash: summary.value.scenarioSnapshotHash,
          status: summary.value.status,
          summary: summary.value,
          createdAt: stamp,
          updatedAt: stamp,
        }),
      );
    },
    async list(documentVersionId) {
      const keys = await callStorage("a run list", () => storage.keys());
      if (!keys.ok) return keys;
      const records: SimResultRunRecord[] = [];
      for (const key of keys.value) {
        const found = await callStorage("a run list's read", () =>
          storage.get(key),
        );
        if (!found.ok) return found;
        // A key vanishing between keys() and get() is absence, not
        // corruption — skip it, decline nothing.
        if (found.value === null) continue;
        if (found.value.documentVersionId !== documentVersionId) continue;
        const parsed = storageRecordToRunRecord(found.value);
        if (!parsed.ok) return parsed;
        records.push(parsed.value);
      }
      records.sort((a, b) => {
        if (a.createdAt !== b.createdAt) {
          return a.createdAt < b.createdAt ? -1 : 1;
        }
        return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
      });
      return simOk(Object.freeze(records));
    },
    async get(
      runId,
    ): Promise<SimParseResult<SimStoredResult | null, SimError>> {
      const found = await callStorage("a run get", () => storage.get(runId));
      if (!found.ok) return found;
      if (found.value === null) {
        return simOk(null);
      }
      const record = storageRecordToRunRecord(found.value);
      if (!record.ok) return record;
      const historiesJson = parseStorageJson(
        found.value.historiesJson,
        "A stored run's histories",
      );
      if (!historiesJson.ok) return historiesJson;
      const histories = parseSimHistorySeriesList(historiesJson.value);
      if (!histories.ok) return histories;
      const fields = decodeSimResultPayload(found.value.payload);
      if (!fields.ok) return fields;
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
    },
  };
}
