/**
 * Phase 61c store tests (law S7): the SimResultStore's contract exercised
 * where each backend lives —
 *
 * - the LOCAL backend over the in-memory storage seam (put → list → get,
 *   with the SMR1 payload byte-identical through storage and the summary
 *   and histories structurally equal);
 * - snapshot-hash keying — two runs of the identical scenario hash group
 *   together, an authored change separates them;
 * - run-id minting — deterministic by default, and a second store over the
 *   same storage advances past taken ids instead of overwriting;
 * - declines — a corrupt stored record declines
 *   `sim/result-record-malformed`, a throwing storage declines
 *   `sim/store-unavailable`, and an invalid run never reaches storage;
 * - the SERVER backend over a hand-rolled fake client (the seam sim-core
 *   actually sees — no tRPC import), including the throw-translation and
 *   malformed-response declines;
 * - backend selection — absent preference is local (the mode, not a
 *   fallback), `server` is honored when provided, and `server` without an
 *   implementation declines loudly.
 *
 * The router-backed half of the server backend is pinned in
 * `packages/api/src/routers/simulations.test.ts` against the real drizzle
 * store; these suites keep sim-core itself testable with zero dependencies.
 */

import { describe, expect, it } from "vitest";

import { SIM_ERROR_CODES } from "./errors";
import { decodeSimBase64Strict } from "./sim-base64";
import {
  createInMemorySimResultStorage,
  createLocalSimResultStore,
  createSimResultRunIdMinter,
} from "./sim-result-store-local";
import {
  encodeSimResultPutWireInput,
  groupSimResultRunsBySnapshotHash,
  parseSimResultSummary,
  selectSimResultStore,
  type SimResultRunRecord,
  type SimResultRunWire,
  type SimResultServerClient,
} from "./sim-result-store";
import { createServerSimResultStore } from "./sim-result-store-server";
import {
  encodeSimResultPayload,
  SIM_RESULT_SUMMARY_VERSION,
  type SimResult,
  type SimResultFieldBlock,
  type SimResultStatus,
  type SimResultSummary,
} from "./sim-result";
import { compileSimScenario, type CompiledSimScenario } from "./units";

/** The serialized wind-tunnel scenario fixture (the compile door's input). */
function fixtureScenario(resolutionMm: number): unknown {
  return {
    id: "sim_tunnel",
    name: "tunnel",
    kind: "flow",
    domain: {
      kind: "explicit",
      min: [-50, -25, -25],
      max: [150, 25, 25],
      resolutionMm,
    },
    conditions: [
      {
        kind: "velocity-inlet",
        face: "xMin",
        speedMPerS: 8,
        direction: [1, 0, 0],
      },
      { kind: "pressure-outlet", face: "xMax", pressurePa: 0 },
      { kind: "wall", face: "yMin", slip: false },
      { kind: "wall", face: "yMax", slip: false },
    ],
    fluid: "air",
    materials: [],
    gravityMPerS2: [0, -9.80665, 0],
  };
}

/** Compiles the scenario fixture, failing the test process on refusal. */
function compileFixture(resolutionMm: number): CompiledSimScenario {
  const compiled = compileSimScenario({
    scenario: fixtureScenario(resolutionMm),
  });
  if (!compiled.ok) {
    throw new Error(
      `The fixture scenario did not compile: ${compiled.error.message}`,
    );
  }
  return compiled.value;
}

/** Two field blocks — one float32, one float64 — exercising both widths. */
function fixtureBlocks(): SimResultFieldBlock[] {
  return [
    {
      id: "velocity-magnitude",
      unit: "mm/s",
      extent: [2, 2, 1],
      originMm: [-50, -25, -25],
      spacingMm: [2, 2, 2],
      dataType: "float32",
      values: [0.5, 1.5, 2.5, 3.5],
    },
    {
      id: "pressure",
      extent: [2, 1, 1],
      originMm: [-50, -25, -25],
      spacingMm: [2, 2, 2],
      dataType: "float64",
      values: [101325.25, 101325.5],
    },
  ];
}

/** A run for the compiled fixture with the requested terminal status. */
function fixtureResult(
  compiled: CompiledSimScenario,
  status: SimResultStatus,
): SimResult {
  const summary: SimResultSummary = {
    schemaVersion: SIM_RESULT_SUMMARY_VERSION,
    scenarioSnapshotHash: compiled.scenarioSnapshotHash,
    status,
    regime: compiled.regime,
    quantities: [{ name: "drag-force", value: 12.5, unit: "N" }],
    ...(status === "failed"
      ? {
          failureCode: SIM_ERROR_CODES.backendUnavailable,
          failureMessage: "The fixture's failure fields ride a failed run.",
        }
      : {}),
  };
  return {
    summary,
    fields: fixtureBlocks(),
    histories: [{ name: "drag", unit: "N", samples: [1, 1.5, 2] }],
  };
}

/** The fixture run's encoded SMR1 bytes (byte-identity comparisons use this). */
function fixturePayloadBytes(result: SimResult): Uint8Array {
  const encoded = encodeSimResultPayload(result.fields);
  if (!encoded.ok) {
    throw new Error(
      `The fixture fields did not encode: ${encoded.error.message}`,
    );
  }
  return encoded.value;
}

/** Byte-for-byte equality (length + every byte). */
function expectBytesEqual(actual: Uint8Array, expected: Uint8Array) {
  expect(actual.byteLength).toBe(expected.byteLength);
  for (let index = 0; index < expected.byteLength; index += 1) {
    expect(actual[index]).toBe(expected[index]);
  }
}

/** A deterministic clock for the local backend (stable timestamps). */
function fixedClock(): () => Date {
  let ticks = 0;
  return () => {
    ticks += 1;
    return new Date(Date.UTC(2026, 9, 8, 12, 0, 0, ticks));
  };
}

describe("parseSimResultSummary (the servedBackend marker, Phase 64b)", () => {
  it("round-trips the honest backend record and keeps fixed key order", () => {
    const compiled = compileFixture(4);
    const parsed = parseSimResultSummary({
      schemaVersion: SIM_RESULT_SUMMARY_VERSION,
      scenarioSnapshotHash: compiled.scenarioSnapshotHash,
      status: "completed",
      regime: compiled.regime,
      quantities: [{ name: "drag-force", value: 1, unit: "N" }],
      servedBackend: "cpu",
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.servedBackend).toBe("cpu");
    // Byte-determinism: the round-tripped summary re-serializes
    // identically (the parser's fixed key order).
    const again = parseSimResultSummary(
      JSON.parse(JSON.stringify(parsed.value)),
    );
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(JSON.stringify(again.value)).toBe(JSON.stringify(parsed.value));
  });

  it("keeps pre-64b summaries (no marker) valid and declines foreign values", () => {
    const compiled = compileFixture(4);
    const base = {
      schemaVersion: SIM_RESULT_SUMMARY_VERSION,
      scenarioSnapshotHash: compiled.scenarioSnapshotHash,
      status: "completed",
      regime: compiled.regime,
      quantities: [],
    };
    const without = parseSimResultSummary(base);
    expect(without.ok).toBe(true);
    if (!without.ok) return;
    expect(without.value.servedBackend).toBeUndefined();
    const foreign = parseSimResultSummary({ ...base, servedBackend: "tpu" });
    expect(foreign.ok).toBe(false);
    if (foreign.ok) return;
    expect(foreign.error.message).toContain("servedBackend");
  });
});

describe("local SimResultStore (in-memory seam)", () => {
  it("puts, lists, and gets a run with byte-identical payload", async () => {
    const storage = createInMemorySimResultStorage();
    const store = createLocalSimResultStore({
      storage,
      now: fixedClock(),
    });
    const compiled = compileFixture(2);
    const result = fixtureResult(compiled, "completed");

    const put = await store.put("version-1", result);
    expect(put.ok).toBe(true);
    if (!put.ok) return;
    expect(put.value.id).toMatch(/^srun_[0-9]{6}$/);
    expect(put.value.documentVersionId).toBe("version-1");
    expect(put.value.scenarioSnapshotHash).toBe(compiled.scenarioSnapshotHash);
    expect(put.value.createdAt).toBe(put.value.updatedAt);

    const listed = await store.list("version-1");
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    expect(listed.value.map((run) => run.id)).toEqual([put.value.id]);

    const fetched = await store.get(put.value.id);
    expect(fetched.ok).toBe(true);
    if (!fetched.ok) return;
    expect(fetched.value).not.toBeNull();
    const stored = fetched.value;
    if (stored === null) return;
    expect(stored.record.id).toBe(put.value.id);
    expect(stored.result.summary).toEqual(result.summary);
    expect(stored.result.fields).toEqual(result.fields);
    expect(stored.result.histories).toEqual(result.histories);
    // Byte-identity: what came back re-encodes to the exact bytes stored.
    const reencoded = encodeSimResultPayload(stored.result.fields);
    expect(reencoded.ok).toBe(true);
    if (reencoded.ok) {
      expectBytesEqual(reencoded.value, fixturePayloadBytes(result));
    }

    // An unknown run is null; another version's list is empty.
    const missing = await store.get("srun_999999");
    expect(missing.ok && missing.value === null).toBe(true);
    const other = await store.list("version-2");
    expect(other.ok && other.value.length === 0).toBe(true);
  });

  it("groups runs by scenario-snapshot hash: identical scenarios together, changed ones apart", async () => {
    const storage = createInMemorySimResultStorage();
    const store = createLocalSimResultStore({
      storage,
      now: fixedClock(),
    });
    const sameA = compileFixture(2);
    const sameB = compileFixture(2);
    const changed = compileFixture(4);
    expect(sameB.scenarioSnapshotHash).toBe(sameA.scenarioSnapshotHash);
    expect(changed.scenarioSnapshotHash).not.toBe(sameA.scenarioSnapshotHash);

    for (const compiled of [sameA, sameB, changed]) {
      const put = await store.put(
        "version-1",
        fixtureResult(compiled, "completed"),
      );
      expect(put.ok).toBe(true);
    }
    const listed = await store.list("version-1");
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    const groups = groupSimResultRunsBySnapshotHash(listed.value);
    expect(groups.size).toBe(2);
    expect(groups.get(sameA.scenarioSnapshotHash)).toHaveLength(2);
    expect(groups.get(changed.scenarioSnapshotHash)).toHaveLength(1);
  });

  it("mints deterministic ids and advances past ids the storage already holds", async () => {
    expect(createSimResultRunIdMinter()()).toBe("srun_000001");
    expect(createSimResultRunIdMinter()()).toBe("srun_000001");

    const storage = createInMemorySimResultStorage();
    const compiled = compileFixture(2);
    // Two store INSTANCES over one storage: both minters start at 1, but
    // the second store must advance past the first's taken id instead of
    // overwriting it.
    const first = await createLocalSimResultStore({
      storage,
      now: fixedClock(),
    }).put("version-1", fixtureResult(compiled, "completed"));
    expect(first.ok).toBe(true);
    const second = await createLocalSimResultStore({
      storage,
      now: fixedClock(),
    }).put("version-1", fixtureResult(compiled, "cancelled"));
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.value.id).not.toBe(first.value.id);

    const listed = await createLocalSimResultStore({ storage }).list(
      "version-1",
    );
    expect(listed.ok && listed.value.length === 2).toBe(true);
  });

  it("declines structured on corrupt stored records and storage failures", async () => {
    const compiled = compileFixture(2);
    const result = fixtureResult(compiled, "completed");

    // An invalid run never reaches storage (declined before any write).
    const guard = createInMemorySimResultStorage();
    const invalidSummary: unknown = {
      ...result.summary,
      status: "running",
    };
    const invalid = await createLocalSimResultStore({ storage: guard }).put(
      "version-1",
      { ...result, summary: invalidSummary as SimResultSummary },
    );
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) {
      expect(invalid.error.code).toBe(SIM_ERROR_CODES.resultRecordMalformed);
    }
    expect(await guard.keys()).toEqual([]);

    // A corrupt summary in storage declines result-record-malformed on get.
    const corruptStorage = createInMemorySimResultStorage();
    await corruptStorage.put({
      runId: "srun_000001",
      documentVersionId: "version-1",
      scenarioSnapshotHash: "0a1b2c3d",
      status: "completed",
      summaryJson: '{"schemaVersion":99}',
      historiesJson: "[]",
      payload: fixturePayloadBytes(result),
      createdAtIso: "2026-10-08T12:00:00.001Z",
      updatedAtIso: "2026-10-08T12:00:00.001Z",
    });
    const corrupt = await createLocalSimResultStore({
      storage: corruptStorage,
    }).get("srun_000001");
    expect(corrupt.ok).toBe(false);
    if (!corrupt.ok) {
      expect(corrupt.error.code).toBe(SIM_ERROR_CODES.resultRecordMalformed);
    }

    // A storage throw declines store-unavailable — never a fabricated run.
    const throwingStorage = {
      ...createInMemorySimResultStorage(),
      keys(): Promise<readonly string[]> {
        return Promise.reject(new Error("storage exploded"));
      },
    };
    const unavailable = await createLocalSimResultStore({
      storage: throwingStorage,
    }).list("version-1");
    expect(unavailable.ok).toBe(false);
    if (!unavailable.ok) {
      expect(unavailable.error.code).toBe(SIM_ERROR_CODES.storeUnavailable);
    }
  });
});

describe("server SimResultStore (injected client seam)", () => {
  /** A fake client standing in for the adapted tRPC slice. */
  function fakeServerClient(): SimResultServerClient & {
    readonly stored: Map<string, SimResultRunWire>;
  } {
    const stored = new Map<string, SimResultRunWire>();
    let counter = 0;
    const client: SimResultServerClient = {
      list({ documentVersionId }) {
        return Promise.resolve(
          [...stored.values()].filter(
            (run) => run.documentVersionId === documentVersionId,
          ),
        );
      },
      get({ runId }) {
        return Promise.resolve(stored.get(runId) ?? null);
      },
      put(input) {
        const summary = parseSimResultSummary(input.summary);
        if (!summary.ok) {
          return Promise.reject(
            new Error(`summary refused: ${summary.error.message}`),
          );
        }
        counter += 1;
        const record: SimResultRunRecord = {
          id: `uuid-${String(counter).padStart(4, "0")}`,
          documentVersionId: input.documentVersionId,
          scenarioSnapshotHash: summary.value.scenarioSnapshotHash,
          status: summary.value.status,
          summary: summary.value,
          createdAt: "2026-10-08T12:00:00.001Z",
          updatedAt: "2026-10-08T12:00:00.001Z",
        };
        const wire: SimResultRunWire = {
          ...record,
          payloadBase64: input.payloadBase64,
          histories: input.histories,
        };
        stored.set(record.id, wire);
        return Promise.resolve(record);
      },
    };
    return { ...client, stored };
  }

  it("round-trips a run through the client seam with byte-identical payload", async () => {
    const fake = fakeServerClient();
    const store = createServerSimResultStore({ client: fake });
    const compiled = compileFixture(2);
    const result = fixtureResult(compiled, "completed");

    const put = await store.put("version-1", result);
    expect(put.ok).toBe(true);
    if (!put.ok) return;
    // The wire input the client received is exactly the canonical encoding.
    const wire = encodeSimResultPutWireInput("version-1", result);
    expect(wire.ok).toBe(true);
    if (wire.ok) {
      const sent = fake.stored.get(put.value.id);
      expect(sent?.payloadBase64).toBe(wire.value.payloadBase64);
      expect(decodeSimBase64Strict(sent?.payloadBase64 ?? "")).not.toBeNull();
    }

    const fetched = await store.get(put.value.id);
    expect(fetched.ok).toBe(true);
    if (!fetched.ok) return;
    expect(fetched.value?.result.fields).toEqual(result.fields);
    const reencoded = encodeSimResultPayload(
      fetched.value?.result.fields ?? [],
    );
    expect(reencoded.ok).toBe(true);
    if (reencoded.ok) {
      expectBytesEqual(reencoded.value, fixturePayloadBytes(result));
    }
    const missing = await store.get("uuid_9999");
    expect(missing.ok && missing.value === null).toBe(true);
  });

  it("translates client throws to store-unavailable and garbage to result-record-malformed", async () => {
    const refusing: SimResultServerClient = {
      list: () => Promise.reject(new Error("offline")),
      get: () => Promise.reject(new Error("offline")),
      put: () => Promise.reject(new Error("offline")),
    };
    const store = createServerSimResultStore({ client: refusing });
    const compiled = compileFixture(2);
    const refused = await store.put(
      "version-1",
      fixtureResult(compiled, "completed"),
    );
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.error.code).toBe(SIM_ERROR_CODES.storeUnavailable);
    }

    const garbage: SimResultServerClient = {
      list: () => Promise.resolve([]),
      get: () =>
        Promise.resolve({ nonsense: true } as unknown as SimResultRunWire),
      put: () => Promise.reject(new Error("unreachable in this test")),
    };
    const garbageStore = createServerSimResultStore({ client: garbage });
    const malformed = await garbageStore.get("uuid-0001");
    expect(malformed.ok).toBe(false);
    if (!malformed.ok) {
      expect(malformed.error.code).toBe(SIM_ERROR_CODES.resultRecordMalformed);
    }
  });
});

describe("backend selection", () => {
  const localStore = createLocalSimResultStore({
    storage: createInMemorySimResultStorage(),
  });

  it("defaults to local (the mode, not a degradation)", () => {
    const selected = selectSimResultStore(undefined, { local: localStore });
    expect(selected.ok && selected.value === localStore).toBe(true);
    expect(selectSimResultStore("local", { local: localStore }).ok).toBe(true);
  });

  it("honors a server preference when a server store is provided", () => {
    const serverStore = createServerSimResultStore({
      client: fakeMinimalClient(),
    });
    const selected = selectSimResultStore("server", {
      local: localStore,
      server: serverStore,
    });
    expect(selected.ok && selected.value === serverStore).toBe(true);
  });

  it("declines loudly when server is preferred but not provided", () => {
    const selected = selectSimResultStore("server", { local: localStore });
    expect(selected.ok).toBe(false);
    if (!selected.ok) {
      expect(selected.error.code).toBe(SIM_ERROR_CODES.storeUnavailable);
    }
  });
});

/** The smallest client the selector's test needs (never called). */
function fakeMinimalClient(): SimResultServerClient {
  return {
    list: () => Promise.resolve([]),
    get: () => Promise.resolve(null),
    put: () => Promise.reject(new Error("The selector test never puts.")),
  };
}
