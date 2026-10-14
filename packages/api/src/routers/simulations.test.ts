/**
 * Phase 61c persistence tests: the simulations router against the
 * ephemeral migrated database (`createInMemoryDb` — committed migrations,
 * temp file, no network), driven through the REAL router factories with the
 * fixture database injected — and, in the second half, through the sim-core
 * SERVER SimResultStore backend riding the same in-memory caller (the
 * injected `SimResultServerClient` seam exactly as the app layer adapts
 * it). The battery:
 *
 * - round-trip — put persists a run; list enumerates it by document
 *   version; get returns it with the SMR1 payload BYTE-IDENTICAL through
 *   SQLite (base64 in, blob stored, base64 out — decoded bytes compared
 *   byte for byte against what was encoded), the summary and histories
 *   structurally equal, and the row's derived status/hash columns agreeing
 *   with the summary's;
 * - status transitions — completed, failed (with the `sim/*` failure
 *   fields), and cancelled runs all persist and read back their status;
 * - ownership/isolation — user B cannot list, get, or put into user A's
 *   document version (NOT_FOUND, existence not leaked), runs never leak
 *   across document versions, and anonymous callers are UNAUTHORIZED;
 * - input-boundary refusals — a non-canonical base64 payload, a valid-base64
 *   non-SMR1 payload, a malformed summary, malformed histories, and an
 *   over-cap payload are all refused with BAD_REQUEST and leave the store
 *   untouched;
 * - snapshot-hash keying — two runs of the identical scenario share the
 *   scenario-snapshot hash and group together; an authored change to the
 *   scenario changes the hash and groups separately (the Phase 63
 *   comparison surface's provenance key);
 * - the store seam — the server backend over the caller declines
 *   `sim/store-unavailable` when the router refuses (unowned version) and
 *   returns null for an unknown run.
 */

import {
  createDocument,
  createDocumentId,
  createSession,
  type NativeCadDocument,
  serializeNativeCadDocument,
  stringifyNativeCadDocument,
} from "@slopcad/cad-core";
import { createInMemoryDb } from "@slopcad/db";
import { user as userTable } from "@slopcad/db/schema/auth";
import {
  compileSimScenario,
  createServerSimResultStore,
  decodeSimBase64Strict,
  encodeSimBase64,
  encodeSimResultPayload,
  groupSimResultRunsBySnapshotHash,
  SIM_ERROR_CODES,
  SIM_RESULT_SUMMARY_VERSION,
  type CompiledSimScenario,
  type SimResult,
  type SimResultFieldBlock,
  type SimResultServerClient,
  type SimResultStatus,
  type SimResultSummary,
} from "@slopcad/sim-core";
import { describe, expect, it } from "vitest";

import { router, t } from "../index";
import { SIM_RESULT_PAYLOAD_MAX_BASE64_LENGTH } from "../limits";
import { createDocumentsRouter } from "./documents";
import { createProjectsRouter } from "./projects";
import { createSimulationsRouter } from "./simulations";

const ALICE_ID = "user-alice";
const BOB_ID = "user-bob";

/** The session half of the caller context, for one user id. */
function testSession(userId: string) {
  return {
    session: {
      id: `session-${userId}`,
      expiresAt: new Date("2030-01-01T00:00:00.000Z"),
      token: `token-${userId}`,
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      updatedAt: new Date("2026-01-01T00:00:00.000Z"),
      ipAddress: null,
      userAgent: null,
      userId,
    },
    user: {
      id: userId,
      name: userId,
      email: `${userId}@slopcad.test`,
      emailVerified: false,
      image: null,
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    },
  };
}

type FixtureDb = Awaited<ReturnType<typeof createInMemoryDb>>;

function buildSimulationsRouter(db: FixtureDb) {
  return router({
    projects: createProjectsRouter({ db }),
    documents: createDocumentsRouter({ db }),
    simulations: createSimulationsRouter({ db }),
  });
}

/** Caller speaking as one of the fixture users. */
function callerFor(userId: string, db: FixtureDb) {
  return t.createCallerFactory(buildSimulationsRouter(db))({
    auth: null,
    session: testSession(userId),
  });
}

/** Anonymous caller (the UNAUTHORIZED gate). */
function anonymousCaller(db: FixtureDb) {
  return t.createCallerFactory(buildSimulationsRouter(db))({
    auth: null,
    session: null,
  });
}

/** The shared fixture database: migrations + the two fixture users. */
async function createSimulationsFixture() {
  const db = await createInMemoryDb();
  await db.insert(userTable).values([
    { id: ALICE_ID, name: "Alice", email: "alice@slopcad.test" },
    { id: BOB_ID, name: "Bob", email: "bob@slopcad.test" },
  ]);
  return db;
}

/** An empty document serialized exactly the way the Save path will. */
function serializeEmptyDocument(): string {
  const session = createSession(
    createDocument(createDocumentId("doc_sim_fixture")),
  );
  const native: NativeCadDocument = {
    document: session.document,
    history: session.history,
    regeneration: new Map(),
    metadata: {},
    rollback: null,
    drawing: null,
  };
  return stringifyNativeCadDocument(serializeNativeCadDocument(native));
}

/**
 * Creates one owned document with `saves` saved versions, returning the
 * version row ids in save order (v1 first).
 */
async function createOwnedVersions(
  userId: string,
  db: FixtureDb,
  saves = 1,
): Promise<string[]> {
  const caller = callerFor(userId, db);
  const project = await caller.projects.create({ name: "Tunnel studies" });
  const document = await caller.documents.create({
    projectId: project.id,
    name: "carrier",
  });
  for (let save = 0; save < saves; save += 1) {
    await caller.documents.save({
      documentId: document.id,
      nativeContent: serializeEmptyDocument(),
    });
  }
  const versions = await caller.documents.listVersions({
    documentId: document.id,
  });
  if (versions.length !== saves) {
    throw new Error(
      `The fixture document produced ${String(versions.length)} versions where ${String(saves)} were requested.`,
    );
  }
  return versions.map((version) => version.id);
}

/** Creates one owned document and returns its FIRST version's row id. */
async function createOwnedFirstVersion(
  userId: string,
  db: FixtureDb,
): Promise<string> {
  const versions = await createOwnedVersions(userId, db, 1);
  const first = versions[0];
  if (first === undefined) {
    throw new Error("The fixture document save produced no first version.");
  }
  return first;
}

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

/** The put wire input for a fixture result (summary + base64 + histories). */
function fixturePutInput(documentVersionId: string, result: SimResult) {
  return {
    documentVersionId,
    summary: result.summary,
    payloadBase64: encodeSimBase64(fixturePayloadBytes(result)),
    histories: result.histories,
  };
}

/** Byte-for-byte equality (length + every byte). */
function expectBytesEqual(actual: Uint8Array, expected: Uint8Array) {
  expect(actual.byteLength).toBe(expected.byteLength);
  for (let index = 0; index < expected.byteLength; index += 1) {
    expect(actual[index]).toBe(expected[index]);
  }
}

/** Adapts the in-memory caller to the injected server-client seam. */
function toServerClient(userId: string, db: FixtureDb): SimResultServerClient {
  const caller = callerFor(userId, db);
  return {
    list: (input) => caller.simulations.list(input),
    put: (input) => caller.simulations.put(input),
    get: async (input) => {
      try {
        return await caller.simulations.get(input);
      } catch (error) {
        if (
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          (error as { code?: unknown }).code === "NOT_FOUND"
        ) {
          return null;
        }
        throw error;
      }
    },
  };
}

/** A store result's ok-half (the decline path is asserted in its own tests). */
function requireStoreOk<T>(
  result: { readonly ok: true; readonly value: T } | { readonly ok: false },
): T {
  if (!result.ok) {
    throw new Error("The store declined where the test expected a value.");
  }
  return result.value;
}

describe("simulations router", () => {
  it("round-trips a run with byte-identical payload, summary, and histories", async () => {
    const db = await createSimulationsFixture();
    const alice = callerFor(ALICE_ID, db);
    const versionId = await createOwnedFirstVersion(ALICE_ID, db);
    const compiled = compileFixture(2);
    const result = fixtureResult(compiled, "completed");

    const put = await alice.simulations.put(fixturePutInput(versionId, result));
    expect(put.documentVersionId).toBe(versionId);
    expect(put.status).toBe("completed");
    expect(put.scenarioSnapshotHash).toBe(compiled.scenarioSnapshotHash);
    expect(put.summary.quantities).toEqual(result.summary.quantities);
    expect(put.createdAt).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/,
    );

    const listed = await alice.simulations.list({
      documentVersionId: versionId,
    });
    expect(listed).toHaveLength(1);
    expect(listed[0]?.id).toBe(put.id);
    expect(listed[0]?.summary.scenarioSnapshotHash).toBe(
      compiled.scenarioSnapshotHash,
    );

    const fetched = await alice.simulations.get({ runId: put.id });
    expect(fetched.id).toBe(put.id);
    expect(fetched.summary).toEqual(result.summary);
    expect(fetched.histories).toEqual(result.histories);
    const bytes = decodeSimBase64Strict(fetched.payloadBase64);
    expect(bytes).not.toBeNull();
    expectBytesEqual(bytes ?? new Uint8Array(0), fixturePayloadBytes(result));
  });

  it("persists completed, failed, and cancelled runs with their statuses", async () => {
    const db = await createSimulationsFixture();
    const alice = callerFor(ALICE_ID, db);
    const versionId = await createOwnedFirstVersion(ALICE_ID, db);
    const compiled = compileFixture(2);

    for (const status of ["completed", "failed", "cancelled"] as const) {
      const put = await alice.simulations.put(
        fixturePutInput(versionId, fixtureResult(compiled, status)),
      );
      expect(put.status).toBe(status);
      const fetched = await alice.simulations.get({ runId: put.id });
      expect(fetched.status).toBe(status);
      if (status === "failed") {
        expect(fetched.summary.failureCode).toBe(
          SIM_ERROR_CODES.backendUnavailable,
        );
        expect(fetched.summary.failureMessage).toBeDefined();
      } else {
        expect(fetched.summary.failureCode).toBeUndefined();
      }
    }

    const listed = await alice.simulations.list({
      documentVersionId: versionId,
    });
    expect(listed.map((run) => run.status)).toEqual([
      "completed",
      "failed",
      "cancelled",
    ]);
  });

  it("keys runs by the scenario-snapshot hash: identical scenarios group, changed ones do not", async () => {
    const db = await createSimulationsFixture();
    const alice = callerFor(ALICE_ID, db);
    const versionId = await createOwnedFirstVersion(ALICE_ID, db);

    const sameA = compileFixture(2);
    const sameB = compileFixture(2);
    const changed = compileFixture(4);
    expect(sameB.scenarioSnapshotHash).toBe(sameA.scenarioSnapshotHash);
    expect(changed.scenarioSnapshotHash).not.toBe(sameA.scenarioSnapshotHash);

    await alice.simulations.put(
      fixturePutInput(versionId, fixtureResult(sameA, "completed")),
    );
    await alice.simulations.put(
      fixturePutInput(versionId, fixtureResult(sameB, "completed")),
    );
    await alice.simulations.put(
      fixturePutInput(versionId, fixtureResult(changed, "completed")),
    );

    const listed = await alice.simulations.list({
      documentVersionId: versionId,
    });
    const groups = groupSimResultRunsBySnapshotHash(listed);
    expect(groups.size).toBe(2);
    expect(groups.get(sameA.scenarioSnapshotHash)).toHaveLength(2);
    expect(groups.get(changed.scenarioSnapshotHash)).toHaveLength(1);
  });

  it("scopes every procedure to the owning user and the document version", async () => {
    const db = await createSimulationsFixture();
    const versions = await createOwnedVersions(ALICE_ID, db, 2);
    const versionId = versions[0];
    const secondVersionId = versions[1];
    if (versionId === undefined || secondVersionId === undefined) {
      throw new Error("The fixture document did not produce two versions.");
    }
    const bobVersionId = await createOwnedFirstVersion(BOB_ID, db);
    const compiled = compileFixture(2);
    const alice = callerFor(ALICE_ID, db);
    const bob = callerFor(BOB_ID, db);

    const put = await alice.simulations.put(
      fixturePutInput(versionId, fixtureResult(compiled, "completed")),
    );

    // B cannot see, read, or write into A's version (existence not leaked).
    await expect(
      bob.simulations.list({ documentVersionId: versionId }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(bob.simulations.get({ runId: put.id })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(
      bob.simulations.put(
        fixturePutInput(versionId, fixtureResult(compiled, "completed")),
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    // A's runs stay keyed to their version: v1's run does not appear in
    // v2's list (and B's own version stays empty of A's runs by scope).
    const secondList = await alice.simulations.list({
      documentVersionId: secondVersionId,
    });
    expect(secondList).toEqual([]);
    const bobList = await bob.simulations.list({
      documentVersionId: bobVersionId,
    });
    expect(bobList).toEqual([]);

    // Anonymous callers are rejected outright.
    await expect(
      anonymousCaller(db).simulations.list({ documentVersionId: versionId }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(
      anonymousCaller(db).simulations.get({ runId: put.id }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(
      anonymousCaller(db).simulations.put(
        fixturePutInput(versionId, fixtureResult(compiled, "completed")),
      ),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("refuses invalid payloads, summaries, and histories without storing", async () => {
    const db = await createSimulationsFixture();
    const alice = callerFor(ALICE_ID, db);
    const versionId = await createOwnedFirstVersion(ALICE_ID, db);
    const compiled = compileFixture(2);
    const good = fixturePutInput(
      versionId,
      fixtureResult(compiled, "completed"),
    );

    // Non-canonical base64 (embedded whitespace) — refused before any decode.
    await expect(
      alice.simulations.put({ ...good, payloadBase64: " U01SMQ==" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    // Canonical base64 of non-SMR1 bytes — refused by the SMR1 decoder.
    await expect(
      alice.simulations.put({
        ...good,
        payloadBase64: encodeSimBase64(
          new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]),
        ),
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    // Malformed summary: wrong schema version.
    await expect(
      alice.simulations.put({
        ...good,
        summary: { ...good.summary, schemaVersion: 99 },
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    // Malformed summary: a status outside the vocabulary.
    await expect(
      alice.simulations.put({
        ...good,
        summary: { ...good.summary, status: "running" },
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    // Malformed histories: a sample is not a number.
    await expect(
      alice.simulations.put({
        ...good,
        histories: [{ name: "drag", unit: "N", samples: [1, "fast", 2] }],
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    // Over-cap payload: one character past the input boundary's cap.
    await expect(
      alice.simulations.put({
        ...good,
        payloadBase64: "A".repeat(SIM_RESULT_PAYLOAD_MAX_BASE64_LENGTH + 1),
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    // The store is untouched by every refusal above.
    expect(
      await alice.simulations.list({ documentVersionId: versionId }),
    ).toEqual([]);
  });
});

describe("server SimResultStore over the in-memory router", () => {
  it("puts, lists, and gets runs through the injected client seam", async () => {
    const db = await createSimulationsFixture();
    const versionId = await createOwnedFirstVersion(ALICE_ID, db);
    const store = createServerSimResultStore({
      client: toServerClient(ALICE_ID, db),
    });
    const compiled = compileFixture(2);
    const result = fixtureResult(compiled, "completed");

    const put = requireStoreOk(await store.put(versionId, result));
    expect(put.documentVersionId).toBe(versionId);

    const listed = requireStoreOk(await store.list(versionId));
    expect(listed.map((run) => run.id)).toEqual([put.id]);

    const fetched = requireStoreOk(await store.get(put.id));
    if (fetched === null) throw new Error("The stored run vanished on get.");
    expect(fetched.result.summary).toEqual(result.summary);
    expect(fetched.result.fields).toEqual(result.fields);
    expect(fetched.result.histories).toEqual(result.histories);
    const reencoded = encodeSimResultPayload(fetched.result.fields);
    expect(reencoded.ok).toBe(true);
    if (reencoded.ok) {
      expectBytesEqual(reencoded.value, fixturePayloadBytes(result));
    }

    // An unknown run is null, not a decline.
    const missing = requireStoreOk(await store.get("srun_does_not_exist"));
    expect(missing).toBeNull();
  });

  it("declines store-unavailable when the router refuses, keeping the decline structured", async () => {
    const db = await createSimulationsFixture();
    await createOwnedFirstVersion(ALICE_ID, db);
    const store = createServerSimResultStore({
      client: toServerClient(BOB_ID, db),
    });
    const compiled = compileFixture(2);

    // Bob owns nothing; the router's NOT_FOUND surfaces as the store's
    // structured store-unavailable decline, never a fabricated run.
    const refused = await store.put(
      "version-that-bob-does-not-own",
      fixtureResult(compiled, "completed"),
    );
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.error.code).toBe(SIM_ERROR_CODES.storeUnavailable);
    }
  });
});
