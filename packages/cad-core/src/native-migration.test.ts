/**
 * Phase 17 tests: the migration framework — built before any future schema
 * change exists, so the mechanism is proven with synthetic migrations that
 * live HERE ONLY. The synthetic v0→v1 migration (and its v1→v2 continuation)
 * are never registered in production code: an entry in the production
 * registry asserts that real documents in the old shape exist in the wild,
 * which is false today. The tests inject them through the parameterized
 * planning/running functions instead.
 */

import { describe, expect, it } from "vitest";

import {
  createDocument,
  createDocumentId,
  createNativeCadDocument,
  fail,
  migrateNativeCadDocument,
  NATIVE_FORMAT_MIGRATIONS,
  ok,
  parseNativeCadDocument,
  planNativeFormatMigrations,
  readNativeFormatVersion,
  runNativeFormatMigrations,
  serializeNativeCadDocument,
  stringifyNativeCadDocument,
  type NativeFormatMigration,
} from "./index";

function requireOk<T>(
  result:
    | { readonly ok: true; readonly value: T }
    | { readonly ok: false; readonly error: { readonly message: string } },
  what: string,
): T {
  if (!result.ok) {
    throw new Error(`The migration test rejected ${what}: ${result.error.message}`);
  }
  return result.value;
}

function isPlainRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}

/** A minimal current-version document, as revived JSON. */
function currentDocument(): Record<string, unknown> {
  const native = requireOk(
    createNativeCadDocument(createDocument(createDocumentId("doc_migration_test"))),
    "the empty document",
  );
  return JSON.parse(
    stringifyNativeCadDocument(serializeNativeCadDocument(native)),
  ) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Synthetic migrations — TESTS ONLY, never registered in production
// ---------------------------------------------------------------------------

/**
 * The synthetic v0 shape: identical to v1 except document-level metadata was
 * persisted under the key `meta`. The migration renames it; the framework
 * stamps the version.
 */
const SYNTHETIC_V0_TO_V1: NativeFormatMigration = {
  from: 0,
  to: 1,
  migrate: (input) => {
    if (!isPlainRecord(input)) {
      return fail({
        code: "native-migration/migration-failed",
        message: "The synthetic v0 migration needs a plain object.",
        input,
      });
    }
    const record: Record<string, unknown> = { ...input };
    const meta = record.meta;
    delete record.formatVersion;
    delete record.meta;
    return ok({ ...record, metadata: isPlainRecord(meta) ? meta : {} });
  },
};

/** The synthetic v1→v2 continuation: proves steps compose. */
const SYNTHETIC_V1_TO_V2: NativeFormatMigration = {
  from: 1,
  to: 2,
  migrate: (input) => {
    if (!isPlainRecord(input)) {
      return fail({
        code: "native-migration/migration-failed",
        message: "The synthetic v1→v2 migration needs a plain object.",
        input,
      });
    }
    return ok({ ...input, migratedTo: "v2" });
  },
};

/** The production registry stays empty: v1 is the first native format version. */
describe("the production migration registry", () => {
  it("is empty (v1 is the first version; the current chain is the no-op identity)", () => {
    expect(NATIVE_FORMAT_MIGRATIONS).toEqual([]);
  });
});

describe("readNativeFormatVersion", () => {
  it("reads integer versions including pre-history zero", () => {
    expect(readNativeFormatVersion({ formatVersion: 1 })).toBe(1);
    expect(readNativeFormatVersion({ formatVersion: 0 })).toBe(0);
  });

  it("rejects non-objects and malformed stamps", () => {
    for (const input of [
      null,
      [],
      "doc",
      3,
      {},
      { formatVersion: "1" },
      { formatVersion: 1.5 },
      { formatVersion: -1 },
    ]) {
      expect(readNativeFormatVersion(input)).toBeNull();
    }
  });
});

describe("planNativeFormatMigrations", () => {
  it("plans the empty chain for an already-current version", () => {
    expect(planNativeFormatMigrations(1, 1, [SYNTHETIC_V0_TO_V1])).toMatchObject({
      ok: true,
      value: [],
    });
  });

  it("composes registered steps into a continuous chain", () => {
    const registry = [SYNTHETIC_V1_TO_V2, SYNTHETIC_V0_TO_V1];
    const planned = requireOk(
      planNativeFormatMigrations(0, 2, registry),
      "the composed plan",
    );
    expect(planned).toEqual([SYNTHETIC_V0_TO_V1, SYNTHETIC_V1_TO_V2]);
    const partial = requireOk(
      planNativeFormatMigrations(0, 1, registry),
      "the partial plan",
    );
    expect(partial).toEqual([SYNTHETIC_V0_TO_V1]);
  });

  it("fails structured on an unregistered version gap", () => {
    const result = planNativeFormatMigrations(0, 1, []);
    expect(result).toMatchObject({
      ok: false,
      error: { code: "native-migration/no-path" },
    });
    if (!result.ok) {
      expect(result.error.message).toContain("version 0");
    }
    expect(planNativeFormatMigrations(0, 2, [SYNTHETIC_V0_TO_V1])).toMatchObject({
      ok: false,
      error: { code: "native-migration/no-path" },
    });
  });

  it("rejects inconsistent registries", () => {
    const nonAdvancing: NativeFormatMigration = {
      from: 1,
      to: 1,
      migrate: (input) => ok(input),
    };
    expect(planNativeFormatMigrations(1, 2, [nonAdvancing])).toMatchObject({
      ok: false,
      error: { code: "native-migration/registry-invalid" },
    });
    expect(
      planNativeFormatMigrations(0, 2, [
        SYNTHETIC_V0_TO_V1,
        { ...SYNTHETIC_V0_TO_V1, to: 1 },
      ]),
    ).toMatchObject({ ok: false, error: { code: "native-migration/registry-invalid" } });
  });

  it("rejects malformed planning endpoints", () => {
    for (const [from, to] of [[-1, 1], [1.5, 2], [1, 0]] as const) {
      expect(planNativeFormatMigrations(from, to, [])).toMatchObject({
        ok: false,
        error: { code: "native-migration/version-invalid" },
      });
    }
  });
});

describe("runNativeFormatMigrations", () => {
  it("is the identity for the empty chain", () => {
    const document = currentDocument();
    expect(runNativeFormatMigrations(document, [])).toMatchObject({
      ok: true,
      value: document,
    });
  });

  it("transforms content and stamps the version after each step", () => {
    const v0: Record<string, unknown> = {
      ...currentDocument(),
      formatVersion: 0,
      meta: { name: "old" },
    };
    delete v0.metadata;
    const migrated = requireOk(
      runNativeFormatMigrations(v0, [SYNTHETIC_V0_TO_V1]),
      "the synthetic v0→v1 run",
    );
    expect(isPlainRecord(migrated)).toBe(true);
    if (isPlainRecord(migrated)) {
      expect(migrated.formatVersion).toBe(1);
      expect(migrated.metadata).toEqual({ name: "old" });
      expect("meta" in migrated).toBe(false);
    }

    const v2 = requireOk(
      runNativeFormatMigrations(v0, [SYNTHETIC_V0_TO_V1, SYNTHETIC_V1_TO_V2]),
      "the composed run",
    );
    expect(isPlainRecord(v2)).toBe(true);
    if (isPlainRecord(v2)) {
      expect(v2.formatVersion).toBe(2);
      expect(v2.migratedTo).toBe("v2");
      expect(v2.metadata).toEqual({ name: "old" });
    }
  });

  it("propagates a migration's structured failure", () => {
    expect(
      runNativeFormatMigrations("not an object", [SYNTHETIC_V0_TO_V1]),
    ).toMatchObject({ ok: false, error: { code: "native-migration/migration-failed" } });
  });

  it("rejects a migration that returns a non-object", () => {
    const bogus: NativeFormatMigration = {
      from: 0,
      to: 1,
      migrate: () => ok("a string"),
    };
    expect(runNativeFormatMigrations(currentDocument(), [bogus])).toMatchObject({
      ok: false,
      error: { code: "native-migration/migration-invalid" },
    });
  });
});

describe("migrateNativeCadDocument (the production front door)", () => {
  it("returns the current version untouched (the no-op identity chain)", () => {
    const document = currentDocument();
    expect(migrateNativeCadDocument(document)).toMatchObject({
      ok: true,
      value: document,
    });
  });

  it("rejects a future version predictably", () => {
    const document = { ...currentDocument(), formatVersion: 2 };
    const result = migrateNativeCadDocument(document);
    expect(result).toMatchObject({
      ok: false,
      error: { code: "native-migration/version-unsupported" },
    });
    if (!result.ok) {
      expect(result.error.message).toContain("2");
      expect(result.error.message).toContain("1");
    }
  });

  it("fails structured on the empty registry's version gap", () => {
    const v0 = { ...currentDocument(), formatVersion: 0 };
    expect(migrateNativeCadDocument(v0)).toMatchObject({
      ok: false,
      error: { code: "native-migration/no-path" },
    });
  });

  it("rejects an unreadable version", () => {
    for (const input of [null, [], { formatVersion: "1" }]) {
      expect(migrateNativeCadDocument(input)).toMatchObject({
        ok: false,
        error: { code: "native-migration/version-invalid" },
      });
    }
  });
});

// The full end-to-end mechanism proof: a synthetic v0 document (the `meta`
// key shape) runs through the synthetic migration and parses as a current
// native document — content transformed, version stamped, parser satisfied.
describe("the migration mechanism end to end (synthetic, tests only)", () => {
  it("migrates a synthetic v0 document into a parseable current document", () => {
    const v0: Record<string, unknown> = {
      ...currentDocument(),
      formatVersion: 0,
      meta: { name: "old" },
    };
    delete v0.metadata;
    const migrated = requireOk(
      runNativeFormatMigrations(v0, [SYNTHETIC_V0_TO_V1]),
      "the synthetic migration",
    );
    const parsed = requireOk(parseNativeCadDocument(migrated), "the migrated parse");
    expect(parsed.metadata).toEqual({ name: "old" });
  });

  it("keeps the synthetic migration out of the production registry", () => {
    expect(NATIVE_FORMAT_MIGRATIONS).not.toContain(SYNTHETIC_V0_TO_V1);
    const v0 = { ...currentDocument(), formatVersion: 0 };
    expect(migrateNativeCadDocument(v0)).toMatchObject({
      ok: false,
      error: { code: "native-migration/no-path" },
    });
  });
});
