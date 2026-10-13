/**
 * The real IndexedDB adapter of the local store's storage seam (Phase 61c,
 * law S7): thin by design — open (with the one upgrade that creates the
 * single object store), put, get, keys, and nothing else. The domain logic
 * (canonical JSON, parsers, declines, ordering) lives in the backend
 * (`./sim-result-store-local`), which is why this module can stay this
 * small and why the in-memory double exercises the exact same seam in
 * node-env unit tests.
 *
 * The IndexedDB surfaces here are STRUCTURAL interfaces, not DOM types —
 * sim-core typechecks under any `lib` configuration (the
 * `./sim-web-transport` precedent), and the real `indexedDB`, `IDBDatabase`,
 * `IDBObjectStore`, `IDBRequest`, and `IDBTransaction` satisfy them at
 * runtime in every browser. The factory acquires the global `indexedDB`
 * lazily and declines loudly (throws — there is no silent memory fallback;
 * the caller chooses an in-memory or server backend explicitly) when the
 * host has none.
 */

import type {
  SimResultStorage,
  SimResultStorageRecord,
} from "./sim-result-store-local";

/** A request whose result is read only inside its success callback. */
export interface SimIdbRequest<T> {
  readonly result: T;
  onsuccess: (() => void) | null;
  onerror: (() => void) | null;
}

/** An open request additionally drives the version upgrade. */
export interface SimIdbOpenRequest<T> extends SimIdbRequest<T> {
  onupgradeneeded: (() => void) | null;
}

/** The object-store surface the seam needs (put/get/getAllKeys only). */
export interface SimIdbObjectStore {
  put(value: unknown, key: string): SimIdbRequest<unknown>;
  get(key: string): SimIdbRequest<unknown>;
  getAllKeys(): SimIdbRequest<readonly unknown[]>;
}

/** A transaction: one store handle, plus completion for write durability. */
export interface SimIdbTransaction {
  objectStore(name: string): SimIdbObjectStore;
  oncomplete: (() => void) | null;
  onerror: (() => void) | null;
  onabort: (() => void) | null;
}

/** The database surface the seam needs. */
export interface SimIdbDatabase {
  readonly objectStoreNames: { contains(name: string): boolean };
  createObjectStore(name: string): SimIdbObjectStore;
  transaction(
    storeName: string,
    mode: "readonly" | "readwrite",
  ): SimIdbTransaction;
}

/** The factory surface: `open` is all the adapter ever calls on it. */
export interface SimIdbFactory {
  open(name: string, version: number): SimIdbOpenRequest<SimIdbDatabase>;
}

/** The database and store the adapter owns. */
const DB_NAME = "slopcad-sim-results";
const DB_VERSION = 1;
const STORE_NAME = "runs";

/** Resolves one request into a promise (result read on success only). */
function requestAsPromise<T>(request: SimIdbRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => {
      resolve(request.result);
    };
    request.onerror = () => {
      reject(new Error("An IndexedDB request failed."));
    };
  });
}

/** Resolves a transaction's completion (write durability). */
function transactionAsPromise(transaction: SimIdbTransaction): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => {
      resolve();
    };
    transaction.onerror = () => {
      reject(new Error("An IndexedDB transaction failed."));
    };
    transaction.onabort = () => {
      reject(new Error("An IndexedDB transaction aborted."));
    };
  });
}

/** Acquires the host's IndexedDB factory, or throws the loud decline. */
function requireGlobalIdbFactory(): SimIdbFactory {
  const scope = globalThis as typeof globalThis & {
    readonly indexedDB?: unknown;
  };
  const factory = scope.indexedDB;
  if (
    typeof factory !== "object" ||
    factory === null ||
    typeof (factory as SimIdbFactory).open !== "function"
  ) {
    throw new Error(
      "This host exposes no IndexedDB; the local sim-result backend needs it (choose the in-memory storage double or the server backend explicitly — there is no silent fallback).",
    );
  }
  return factory as SimIdbFactory;
}

/** The shallow shape check a stored value must pass to be a record. */
function isSimResultStorageRecord(
  input: unknown,
): input is SimResultStorageRecord {
  if (typeof input !== "object" || input === null) return false;
  const record = input as Record<string, unknown>;
  return (
    typeof record.runId === "string" &&
    typeof record.documentVersionId === "string" &&
    typeof record.scenarioSnapshotHash === "string" &&
    typeof record.status === "string" &&
    typeof record.summaryJson === "string" &&
    typeof record.historiesJson === "string" &&
    record.payload instanceof Uint8Array &&
    typeof record.createdAtIso === "string" &&
    typeof record.updatedAtIso === "string"
  );
}

/**
 * Opens (and upgrades on first use) the sim-results database and returns the
 * storage-seam implementation over it. The optional factory parameter is
 * the same structural seam for hosts that pass their own; browsers need
 * none — the global is acquired lazily. A stored value that is present but
 * not record-shaped throws (corruption is loud, never "absent"); deep
 * validation stays the backend's job.
 */
export async function createIndexedDbSimResultStorage(
  factory: SimIdbFactory = requireGlobalIdbFactory(),
): Promise<SimResultStorage> {
  const openRequest = factory.open(DB_NAME, DB_VERSION);
  openRequest.onupgradeneeded = () => {
    const database = openRequest.result;
    if (!database.objectStoreNames.contains(STORE_NAME)) {
      database.createObjectStore(STORE_NAME);
    }
  };
  const db = await requestAsPromise(openRequest);
  return {
    async put(record) {
      const transaction = db.transaction(STORE_NAME, "readwrite");
      const store = transaction.objectStore(STORE_NAME);
      await requestAsPromise(store.put(record, record.runId));
      await transactionAsPromise(transaction);
    },
    async get(runId) {
      const transaction = db.transaction(STORE_NAME, "readonly");
      const store = transaction.objectStore(STORE_NAME);
      const value = await requestAsPromise(store.get(runId));
      if (value === undefined) return null;
      if (!isSimResultStorageRecord(value)) {
        throw new Error(
          `The locally stored value under run id "${runId}" is not a sim-result storage record.`,
        );
      }
      return value;
    },
    async keys() {
      const transaction = db.transaction(STORE_NAME, "readonly");
      const store = transaction.objectStore(STORE_NAME);
      const keys = await requestAsPromise(store.getAllKeys());
      return keys.filter((key): key is string => typeof key === "string");
    },
  };
}
