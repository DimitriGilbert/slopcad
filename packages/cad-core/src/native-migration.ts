/**
 * The native format migration framework (Phase 17), built before any future
 * schema change exists so the first real migration lands on proven rails.
 *
 * A {@link NativeFormatMigration} owns ONE version step: it receives the
 * whole persisted document at its `from` version (as revived JSON — plain
 * data, no domain objects) and returns the same document transformed for its
 * `to` version. The framework owns everything else:
 *
 * - {@link planNativeFormatMigrations} validates a registry and composes a
 *   continuous chain from a source version to a target version; a missing
 *   step is a structured `native-migration/no-path` failure that names the
 *   version the chain got stuck on, never a guess or a silent skip.
 * - {@link runNativeFormatMigrations} threads a document through a planned
 *   chain, stamping the top-level `formatVersion` after every step so a
 *   migration transforms content only, never version bookkeeping.
 * - {@link migrateNativeCadDocument} is the front door used by
 *   `parseNativeCadDocument`: a document already at the current version is
 *   the identity (the empty chain — no migration ever runs), a version from
 *   the future is rejected predictably (`native-migration/version-unsupported`,
 *   naming both versions), and an older version must reach the current one
 *   through the registered chain.
 *
 * The production registry ({@link NATIVE_FORMAT_MIGRATIONS}) is empty: v1 is
 * the first native format version, so the only supported input version and
 * the current version coincide and the applied chain is always the empty
 * chain. The mechanism itself is real and exercised — composition, gap
 * failures, version gating, and the stamping contract are all proven by the
 * tests, which inject synthetic migrations (a v0→v1 test shape and a v1→v2
 * continuation) through the parameterized planning/running functions. Those
 * synthetic migrations exist in tests ONLY and are never registered in
 * production code: a migration in the production registry asserts that real
 * documents in the old shape exist in the wild, which is false today.
 */

import { type ParseFailure, type ParseResult, fail, ok } from "./result";
import { CAD_NATIVE_FORMAT_VERSION } from "./version";

/** Stable failure codes produced by the migration framework. */
export const NATIVE_MIGRATION_ERROR_CODES = {
  /** The input's format version was missing or not a positive integer. */
  versionInvalid: "native-migration/version-invalid",
  /** The input's format version is newer than the current version. */
  versionUnsupported: "native-migration/version-unsupported",
  /** The registry itself is inconsistent (duplicate or non-advancing steps). */
  registryInvalid: "native-migration/registry-invalid",
  /** No continuous chain of registered migrations reaches the target. */
  noPath: "native-migration/no-path",
  /** A migration returned something that is not a plain JSON object. */
  migrationInvalid: "native-migration/migration-invalid",
  /** A registered migration applied itself and failed. */
  migrationFailed: "native-migration/migration-failed",
} as const;

export type NativeMigrationErrorCode =
  (typeof NATIVE_MIGRATION_ERROR_CODES)[keyof typeof NATIVE_MIGRATION_ERROR_CODES];

/** Structured failure describing why a migration was refused. */
export interface NativeMigrationError extends ParseFailure {
  readonly code: NativeMigrationErrorCode;
}

function migrationError(
  code: NativeMigrationErrorCode,
  message: string,
  input: unknown,
): NativeMigrationError {
  return { code, message, input };
}

/**
 * One registered version step: `migrate` receives the whole persisted
 * document (plain revived JSON at version `from`) and returns it transformed
 * for version `to`. Migrations transform content only — the framework
 * stamps `formatVersion` — and must be pure deterministic functions.
 */
export interface NativeFormatMigration {
  readonly from: number;
  readonly to: number;
  readonly migrate: (
    input: unknown,
  ) => ParseResult<unknown, NativeMigrationError>;
}

/**
 * The production migration registry, ordered or not — planning walks it by
 * version, not position. Currently empty because v1 is the first native
 * format version; the first future schema change appends its real step here
 * (and bumps `CAD_NATIVE_FORMAT_VERSION`), which is the only edit a future
 * migration requires.
 */
export const NATIVE_FORMAT_MIGRATIONS: readonly NativeFormatMigration[] =
  Object.freeze([]);

function isPlainRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}

function isNonNegativeInteger(input: unknown): input is number {
  return typeof input === "number" && Number.isInteger(input) && input >= 0;
}

function isPositiveInteger(input: unknown): input is number {
  return typeof input === "number" && Number.isInteger(input) && input >= 1;
}

/**
 * Reads a document's top-level `formatVersion`, or null when it is not a
 * plain object carrying an integer version. Version 0 is readable: it is
 * pre-history — no released version, but a legal migration source, which is
 * exactly the shape the framework's mechanism tests exercise (a synthetic
 * v0→v1 step that exists in tests only).
 */
export function readNativeFormatVersion(input: unknown): number | null {
  if (!isPlainRecord(input)) return null;
  return isNonNegativeInteger(input.formatVersion) ? input.formatVersion : null;
}

/**
 * Plans the continuous migration chain that carries a document from `from`
 * to `to` through the given registry, or fails structurally. An empty chain
 * (`from === to`) is success — the identity. A registry with duplicate
 * `from` versions or a step that does not advance (`to <= from`) is rejected
 * with `native-migration/registry-invalid`; a gap the chain cannot cross is
 * rejected with `native-migration/no-path`, naming the version the walk
 * stuck at and the registered steps.
 */
export function planNativeFormatMigrations(
  from: number,
  to: number,
  registry: readonly NativeFormatMigration[],
): ParseResult<readonly NativeFormatMigration[], NativeMigrationError> {
  if (!isNonNegativeInteger(from) || !isPositiveInteger(to)) {
    return fail(
      migrationError(
        NATIVE_MIGRATION_ERROR_CODES.versionInvalid,
        `Migration planning needs a non-negative integer source and a positive integer target, received from ${String(from)} to ${String(to)}.`,
        { from, to },
      ),
    );
  }
  const byFrom = new Map<number, NativeFormatMigration>();
  for (const migration of registry) {
    if (
      !isNonNegativeInteger(migration.from) ||
      !isPositiveInteger(migration.to) ||
      migration.to <= migration.from
    ) {
      return fail(
        migrationError(
          NATIVE_MIGRATION_ERROR_CODES.registryInvalid,
          `A migration must advance from a non-negative integer version to a strictly greater positive one; the entry ${String(migration.from)} → ${String(migration.to)} does not.`,
          migration,
        ),
      );
    }
    if (byFrom.has(migration.from)) {
      return fail(
        migrationError(
          NATIVE_MIGRATION_ERROR_CODES.registryInvalid,
          `The registry carries more than one migration from version ${String(migration.from)}; a version has exactly one outgoing step.`,
          registry,
        ),
      );
    }
    byFrom.set(migration.from, migration);
  }
  const chain: NativeFormatMigration[] = [];
  let current = from;
  while (current !== to) {
    const step = byFrom.get(current);
    if (step === undefined) {
      const registered = registry
        .map((entry) => `${String(entry.from)}→${String(entry.to)}`)
        .join(", ");
      return fail(
        migrationError(
          NATIVE_MIGRATION_ERROR_CODES.noPath,
          `No registered migration starts at version ${String(current)} (registered steps: ${registered.length > 0 ? registered : "none"}), so version ${String(from)} cannot reach ${String(to)}.`,
          { from, to, stuckAt: current },
        ),
      );
    }
    chain.push(step);
    current = step.to;
  }
  return ok(Object.freeze(chain));
}

/**
 * Threads a document through a planned chain: each migration transforms the
 * content, then the framework stamps the top-level `formatVersion` with the
 * step's `to` version. A migration that fails propagates its structured
 * error; one that returns a non-plain-object is rejected with
 * `native-migration/migration-invalid` (a versioned document is always a
 * plain JSON object). The empty chain is the identity — the input is
 * returned untouched.
 */
export function runNativeFormatMigrations(
  input: unknown,
  chain: readonly NativeFormatMigration[],
): ParseResult<unknown, NativeMigrationError> {
  let current = input;
  for (const migration of chain) {
    const migrated = migration.migrate(current);
    if (!migrated.ok) return migrated;
    if (!isPlainRecord(migrated.value)) {
      return fail(
        migrationError(
          NATIVE_MIGRATION_ERROR_CODES.migrationInvalid,
          `The migration ${String(migration.from)} → ${String(migration.to)} returned a non-object; a migrated document must stay a plain JSON object.`,
          migrated.value,
        ),
      );
    }
    current = { ...migrated.value, formatVersion: migration.to };
  }
  return ok(current);
}

/**
 * Migrates untrusted input to the current native format version. A document
 * already at the current version is returned untouched (the empty chain —
 * the no-op identity); an older version is planned and run through
 * {@link NATIVE_FORMAT_MIGRATIONS}; a newer version is rejected predictably
 * with `native-migration/version-unsupported`, naming both the document's
 * version and the current one; an unreadable version is
 * `native-migration/version-invalid`.
 */
export function migrateNativeCadDocument(
  input: unknown,
): ParseResult<unknown, NativeMigrationError> {
  const version = readNativeFormatVersion(input);
  if (version === null) {
    return fail(
      migrationError(
        NATIVE_MIGRATION_ERROR_CODES.versionInvalid,
        "A native document must be a plain object carrying an integer formatVersion.",
        input,
      ),
    );
  }
  if (version === CAD_NATIVE_FORMAT_VERSION) return ok(input);
  if (version > CAD_NATIVE_FORMAT_VERSION) {
    return fail(
      migrationError(
        NATIVE_MIGRATION_ERROR_CODES.versionUnsupported,
        `A native document carries formatVersion ${String(version)}, newer than the supported version ${String(CAD_NATIVE_FORMAT_VERSION)}; future versions are rejected predictably rather than misread.`,
        version,
      ),
    );
  }
  const chain = planNativeFormatMigrations(
    version,
    CAD_NATIVE_FORMAT_VERSION,
    NATIVE_FORMAT_MIGRATIONS,
  );
  if (!chain.ok) return chain;
  return runNativeFormatMigrations(input, chain.value);
}
