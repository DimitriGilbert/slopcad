/**
 * The canonical native `slopcad` document format (Phase 17): ONE persisted
 * serialization that carries the full parametric intent of a CAD session, so
 * a reopened document is the document — same parameters (with their
 * expressions), same feature graph (records plus declared inputs/outputs),
 * same bodies, same undo/redo reach, same regeneration picture, same
 * metadata.
 *
 * ## Format shape (v1, fixed key order)
 *
 * ```
 * {
 *   formatVersion: 1,                          // CAD_NATIVE_FORMAT_VERSION
 *   metadata: { …sorted JSON-safe scalars… },   // document-level metadata
 *   document: SerializedCadDocument,            // state at the history cursor
 *   history: {
 *     base: SerializedCadDocument,              // the document the log starts from
 *     transactions: SerializedCadTransaction[], // the applied transaction log
 *     cursor: number,                           // entries current at save time
 *   },
 *   regeneration: SerializedRegenerationStateMap,
 *   rollback?: { afterFeatureId: string | null }, // Phase 20, optional — see below
 * }
 * ```
 *
 * The substrate sections keep their own `CAD_DOCUMENT_FORMAT_VERSION`
 * stamps and their own parsers; the native envelope carries the single
 * `CAD_NATIVE_FORMAT_VERSION` stamp and evolves on its own schedule.
 *
 * ## The three persistence decisions
 *
 * - **History: the transaction log AND the document state, dual-persisted
 *   with a replay check.** The Phase 7 architecture keeps a snapshot per
 *   commit — snapshots answer "what was the state" — but they are an
 *   in-memory optimization over the log, which answers "how was it
 *   reached" and is the part that survives a file boundary. The format
 *   persists the log (`history.transactions`, all entries including a
 *   pending redo branch, plus the cursor) and the current document state
 *   (`document`). Loading replays the log over `history.base` through the
 *   single `applyTransaction` interpreter — rebuilding every snapshot
 *   exactly, an equivalence Phase 7's history tests already pin — and then
 *   verifies the state the replay reaches at the cursor is
 *   serialization-equal to the persisted `document` section
 *   (`native-format/history-mismatch` otherwise). The state section is the
 *   belt, the log is the braces, and corruption that desynchronizes them
 *   fails structurally instead of loading quietly.
 *
 * - **Regeneration state: persisted as loadable state, not recomputed.**
 *   Regeneration states are NOT a deterministic function of the document:
 *   they record the outcomes of the last executor run, and the executor is
 *   the geometry kernel's call (a feature that failed on the author's
 *   machine may succeed on load). Recomputing them at load time would mean
 *   executing geometry before the document is even visible — exactly what a
 *   persistence format must not require. States and their failure
 *   diagnostics are lightweight domain data and round-trip verbatim; the
 *   next regeneration run overwrites them as usual. A PARKED feature (Phase
 *   20 rollback) persists as plain `stale` — parking is positional, derived
 *   from the marker below, never a stored state, so the regeneration
 *   section keeps its Phase 6.3 four-state vocabulary and files saved with
 *   an active rollback load in readers that predate the marker.
 *
 * - **The rollback point: an optional envelope field, additive-optional.**
 *   The Phase 20 rollback marker is document-level state, so it persists —
 *   as an OPTIONAL `rollback` envelope field (`{ afterFeatureId: string |
 *   null }`, omitted entirely when no marker is set, keeping every pre-
 *   Phase 20 file and serializer byte-identical). Version 1 is retained:
 *   the field is additive-optional in both directions — an old reader (per
 *   the envelope's unknown-field tolerance) ignores it and loads the
 *   document, losing only the marker; a new reader of an old file finds it
 *   absent and treats the document as un-rolled. The field must name a
 *   feature the document section declares (`native-format/rollback-unknown-feature`
 *   otherwise) — the same membership cross-check the regeneration section
 *   has. The marker deliberately persists OUTSIDE the transaction log:
 *   it gates execution, not the document, so there is no command to replay
 *   (see `feature-history.ts`).
 *
 * - **References: stable ones persist, synthetic ones are structurally
 *   absent.** Feature input references (parameters, features, bodies — all
 *   stable ids) persist inside the feature records. Selection state is
 *   session data, not document data (the Phase 12 rule), and its synthetic
 *   face/edge/vertex references are transient by construction — the format
 *   has no field that could carry them, so the transience rule is enforced
 *   by the schema itself rather than by filtering.
 *
 * ## The hard rule: derived kernel objects never become canonical
 *
 * Nothing derived from geometry — meshes, triangles, vertices, positions,
 * solids, kernel objects of any kind — appears in the format. Bodies
 * persist as `{ id, name }` records; geometry is rebuilt from the feature
 * graph by regeneration. The serialized shape is exactly the declared
 * schema at every level, which the tests pin by walking it.
 *
 * ## House conventions
 *
 * Deterministic serialization: fixed key order everywhere (inherited from
 * the substrate serializers, plus sorted metadata keys and canonical
 * dimensional values), so the same document always serializes to identical
 * bytes. Strict parsing with unknown-field tolerance (inherited from the
 * substrate parsers). Version gating through the migration framework
 * (`native-migration.ts`): the current version parses directly, older
 * versions must migrate, future versions are rejected predictably. The
 * validator ({@link validateNativeCadDocument}) checks structural validity
 * WITHOUT replaying the document — pure per-field shape validation plus one
 * set-membership cross-check — and collects every issue it finds, unlike
 * the parser's fail-fast single error.
 */

import { CAD_COMMAND_TYPES, isCadCommandType } from "./command";
import { parseDiagnostic } from "./diagnostics";
import {
  type CadDocument,
  type DocumentError,
  parseCadDocument,
  parseFeatureInputRef,
  parseFeatureKind,
  type SerializedCadDocument,
  serializeCadDocument,
} from "./document";
import { parseDimensionalValue } from "./dimensional";
import {
  isExpressionFunction,
  isExpressionIdentifierName,
  parseExpressionAst,
} from "./expression";
import {
  type FeatureRollbackPoint,
  parseFeatureRollbackShape,
  rollbackZoneBoundary,
} from "./feature-history";
import {
  type DocumentHistory,
  type HistoryEntry,
  currentDocument,
} from "./history";
import {
  CAD_ID_KINDS,
  parseBodyId,
  parseDocumentId,
  parseFeatureId,
  parseParameterId,
  parseReferenceId,
  parseSketchDocumentId,
} from "./ids";
import {
  type NativeMigrationError,
  migrateNativeCadDocument,
  readNativeFormatVersion,
} from "./native-migration";
import { type ParameterError, type ParameterMetadataValue } from "./parameter";
import {
  FEATURE_REGENERATION_STATES,
  type RegenerationError,
  type RegenerationStateMap,
  type SerializedRegenerationStateMap,
  isFeatureRegenerationState,
  parseRegenerationStates,
  serializeRegenerationStates,
} from "./regeneration";
import { type ParseFailure, type ParseResult, fail, ok } from "./result";
import {
  type CadTransaction,
  type SerializedCadTransaction,
  type TransactionError,
  applyTransaction,
  parseTransaction,
  serializeTransaction,
} from "./transaction";
import {
  CAD_DOCUMENT_FORMAT_VERSION,
  CAD_NATIVE_FORMAT_VERSION,
} from "./version";

// ---------------------------------------------------------------------------
// The in-memory native document
// ---------------------------------------------------------------------------

/**
 * The full parametric intent of a persisted CAD document: the document at
 * the history cursor, the undo/redo history (base document, committed
 * transaction log with any pending redo branch, cursor), the regeneration
 * state of every feature, and document-level metadata.
 *
 * Invariant: `document` is the document at `history.cursor` —
 * serialization-equal to replaying the log up to it.
 * {@link createNativeCadDocument} establishes the invariant and
 * {@link parseNativeCadDocument} enforces it on untrusted input.
 */
export interface NativeCadDocument {
  /** The document at the history cursor (serialization-equal to the replay). */
  readonly document: CadDocument;
  /** Base document, committed transaction log, and cursor. */
  readonly history: DocumentHistory;
  /** Regeneration state per feature id (loadable state, see module docs). */
  readonly regeneration: RegenerationStateMap;
  /** JSON-safe document-level metadata; serialized with sorted keys. */
  readonly metadata: Readonly<Record<string, ParameterMetadataValue>>;
  /**
   * The Phase 20 rollback marker over the document's feature timeline, or
   * `null` for none. Persisted as the optional envelope `rollback` field
   * (see module docs); parking is derived from it, never stored in states.
   */
  readonly rollback: FeatureRollbackPoint | null;
}

// ---------------------------------------------------------------------------
// Serialized shape
// ---------------------------------------------------------------------------

/** The persisted history section: base document, transaction log, cursor. */
export interface SerializedNativeHistory {
  /** The document the transaction log starts from (the undo floor). */
  readonly base: SerializedCadDocument;
  /**
   * Every committed transaction in order, including entries past the cursor
   * (a pending redo branch survives the file boundary).
   */
  readonly transactions: readonly SerializedCadTransaction[];
  /** How many entries are current at save time (0 = at the base). */
  readonly cursor: number;
}

/** Canonical JSON form of the optional Phase 20 rollback field. */
export interface SerializedFeatureRollbackPoint {
  /** The feature the marker sits after; `null` places it at the very start. */
  readonly afterFeatureId: string | null;
}

/**
 * Canonical JSON form of a native document, in fixed key order:
 * `formatVersion`, `metadata`, `document`, `history`, `regeneration`, and —
 * only when a rollback marker is set — `rollback`. Omitting the field when
 * no marker is set keeps every pre-Phase 20 document's serialization
 * byte-identical.
 */
export interface SerializedNativeCadDocument {
  /** The native envelope's own version stamp ({@link CAD_NATIVE_FORMAT_VERSION}). */
  readonly formatVersion: number;
  /** Document-level metadata, emitted with sorted keys. */
  readonly metadata: Readonly<Record<string, ParameterMetadataValue>>;
  /** The document state at the history cursor. */
  readonly document: SerializedCadDocument;
  /** The applied transaction log and its position. */
  readonly history: SerializedNativeHistory;
  /** Regeneration state per feature (substrate-serialized). */
  readonly regeneration: SerializedRegenerationStateMap;
  /** The rollback marker; present exactly when one is set. */
  readonly rollback?: SerializedFeatureRollbackPoint;
}

// ---------------------------------------------------------------------------
// Failures
// ---------------------------------------------------------------------------

/** Stable failure codes produced when a native document is rejected. */
export const NATIVE_FORMAT_ERROR_CODES = {
  /** The envelope or a required section was not the expected shape. */
  malformed: "native-format/malformed",
  /** The format version was missing or not an integer. */
  versionInvalid: "native-format/version-invalid",
  /**
   * The persisted state and the replayed log disagree, or the log does not
   * replay.
   */
  historyMismatch: "native-format/history-mismatch",
  /** A regeneration state entry names a feature the document does not have. */
  regenerationUnknownFeature: "native-format/regeneration-unknown-feature",
  /** The optional rollback field names a feature the document does not have. */
  rollbackUnknownFeature: "native-format/rollback-unknown-feature",
  /** Document-level metadata was not a plain object of JSON-safe scalars. */
  metadataInvalid: "native-format/metadata-invalid",
} as const;

export type NativeFormatErrorCode =
  (typeof NATIVE_FORMAT_ERROR_CODES)[keyof typeof NATIVE_FORMAT_ERROR_CODES];

/**
 * Structured failure describing why a native document was rejected. `cause`
 * carries the underlying replay failure of a `history-mismatch`, when there
 * is one.
 */
export interface NativeFormatError extends ParseFailure {
  readonly code: NativeFormatErrorCode;
  readonly cause?: TransactionError;
}

function nativeError(
  code: NativeFormatErrorCode,
  message: string,
  input: unknown,
  cause?: TransactionError,
): NativeFormatError {
  return { code, message, input, ...(cause === undefined ? {} : { cause }) };
}

/**
 * Everything {@link parseNativeCadDocument} can fail with: the native
 * layer's own failures plus the substrate failures of every section it
 * delegates to (document, transaction, regeneration) and the migration
 * framework's version-gating failures.
 */
export type NativeCadDocumentParseError =
  | NativeFormatError
  | DocumentError
  | ParameterError
  | TransactionError
  | RegenerationError
  | NativeMigrationError;

// ---------------------------------------------------------------------------
// Construction and serialization
// ---------------------------------------------------------------------------

function isPlainRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}

function isMetadataValue(input: unknown): input is ParameterMetadataValue {
  if (typeof input === "number") return Number.isFinite(input);
  return (
    typeof input === "string" || typeof input === "boolean" || input === null
  );
}

function isNonNegativeInteger(input: unknown): input is number {
  return typeof input === "number" && Number.isInteger(input) && input >= 0;
}

/**
 * Validates untrusted metadata exactly like parameter metadata: a plain
 * object of string, finite number, boolean, or null values, without a
 * `__proto__` key (rejected up front rather than stored on a
 * null-prototype object, matching the parameter module's approach).
 */
function parseNativeMetadata(
  input: unknown,
): ParseResult<
  Readonly<Record<string, ParameterMetadataValue>>,
  NativeFormatError
> {
  if (input === undefined || input === null) {
    return ok(Object.freeze({}));
  }
  if (!isPlainRecord(input)) {
    return fail(
      nativeError(
        NATIVE_FORMAT_ERROR_CODES.metadataInvalid,
        "Native document metadata must be a plain object of string, finite number, boolean, or null values.",
        input,
      ),
    );
  }
  const copy: Record<string, ParameterMetadataValue> = {};
  for (const [key, value] of Object.entries(input)) {
    if (key === "__proto__") {
      return fail(
        nativeError(
          NATIVE_FORMAT_ERROR_CODES.metadataInvalid,
          'Native document metadata must not use the "__proto__" key.',
          input,
        ),
      );
    }
    if (!isMetadataValue(value)) {
      return fail(
        nativeError(
          NATIVE_FORMAT_ERROR_CODES.metadataInvalid,
          "Native document metadata values must be strings, finite numbers, booleans, or null.",
          input,
        ),
      );
    }
    copy[key] = value;
  }
  return ok(Object.freeze(copy));
}

/**
 * Starts a native document over the given CAD document: an empty history
 * (the document is its own base), no regeneration states (nothing has
 * executed), no rollback marker, and the given metadata (validated like
 * parameter metadata).
 */
export function createNativeCadDocument(
  document: CadDocument,
  metadata: Readonly<Record<string, ParameterMetadataValue>> = {},
): ParseResult<NativeCadDocument, NativeFormatError> {
  const parsedMetadata = parseNativeMetadata(metadata);
  if (!parsedMetadata.ok) return parsedMetadata;
  return ok(
    Object.freeze({
      document,
      history: Object.freeze({
        base: document,
        entries: Object.freeze([]),
        cursor: 0,
      }),
      regeneration: new Map(),
      metadata: parsedMetadata.value,
      rollback: null,
    }),
  );
}

/**
 * Canonicalizes metadata for serialization: a frozen copy whose keys are in
 * sorted order, so two documents differing only in metadata key insertion
 * order serialize to identical bytes. Callers reach this with validated
 * metadata (the factory and the parser reject `__proto__`), which is what
 * makes the plain-object accumulator safe.
 */
function canonicalMetadata(
  metadata: Readonly<Record<string, ParameterMetadataValue>>,
): Readonly<Record<string, ParameterMetadataValue>> {
  const sorted: Record<string, ParameterMetadataValue> = {};
  for (const key of Object.keys(metadata).sort()) {
    const value = metadata[key];
    if (value !== undefined) sorted[key] = value;
  }
  return Object.freeze(sorted);
}

/**
 * Serializes a native document to its canonical, deterministic JSON form:
 * fixed key order at every level (inherited from the substrate serializers,
 * plus sorted metadata keys), canonical dimensional values, and stable id
 * rendering — the same document always produces the identical value. The
 * optional `rollback` field is emitted (last) exactly when a marker is set,
 * so a marker-free document serializes to the pre-Phase 20 byte form.
 */
export function serializeNativeCadDocument(
  native: NativeCadDocument,
): SerializedNativeCadDocument {
  return {
    formatVersion: CAD_NATIVE_FORMAT_VERSION,
    metadata: canonicalMetadata(native.metadata),
    document: serializeCadDocument(native.document),
    history: {
      base: serializeCadDocument(native.history.base),
      transactions: native.history.entries.map((entry) =>
        serializeTransaction(entry.transaction),
      ),
      cursor: native.history.cursor,
    },
    regeneration: serializeRegenerationStates(native.regeneration),
    ...(native.rollback === null
      ? {}
      : {
          rollback: {
            afterFeatureId: native.rollback.afterFeatureId,
          },
        }),
  };
}

/**
 * Renders the canonical form to the format's byte-stable text encoding:
 * two-space-indented JSON with a trailing newline (diff- and git-friendly;
 * fixtures are committed in exactly this form).
 */
export function stringifyNativeCadDocument(
  serialized: SerializedNativeCadDocument,
): string {
  return `${JSON.stringify(serialized, null, 2)}\n`;
}

/** Encodes a native document straight to the format's UTF-8 bytes. */
export function encodeNativeCadDocument(native: NativeCadDocument): Uint8Array {
  return new TextEncoder().encode(
    stringifyNativeCadDocument(serializeNativeCadDocument(native)),
  );
}

// ---------------------------------------------------------------------------
// Parsing (the full replay)
// ---------------------------------------------------------------------------

/**
 * Parses the current version's sections. The caller has already gated the
 * version and migrated older input to the current version.
 */
function parseCurrentNativeCadDocument(
  input: Record<string, unknown>,
): ParseResult<NativeCadDocument, NativeCadDocumentParseError> {
  const metadata = parseNativeMetadata(input.metadata);
  if (!metadata.ok) return metadata;
  const persisted = parseCadDocument(input.document);
  if (!persisted.ok) return persisted;

  const historyInput = input.history;
  if (!isPlainRecord(historyInput)) {
    return fail(
      nativeError(
        NATIVE_FORMAT_ERROR_CODES.malformed,
        "A native document's history section must be a plain object with base, transactions, and cursor fields.",
        historyInput,
      ),
    );
  }
  const base = parseCadDocument(historyInput.base);
  if (!base.ok) return base;
  if (!Array.isArray(historyInput.transactions)) {
    return fail(
      nativeError(
        NATIVE_FORMAT_ERROR_CODES.malformed,
        "A native document's history transactions must be an array of serialized transactions.",
        historyInput.transactions,
      ),
    );
  }
  const transactions: CadTransaction[] = [];
  for (const entry of historyInput.transactions) {
    const parsed = parseTransaction(entry);
    if (!parsed.ok) return parsed;
    transactions.push(parsed.value);
  }
  const cursor = historyInput.cursor;
  if (!isNonNegativeInteger(cursor) || cursor > transactions.length) {
    return fail(
      nativeError(
        NATIVE_FORMAT_ERROR_CODES.malformed,
        `A native document's history cursor must be an integer between 0 and the transaction count (${String(transactions.length)}).`,
        cursor,
      ),
    );
  }

  // Replay the whole log over the base: every entry's snapshot is rebuilt
  // through the single transaction interpreter, exactly as it was built at
  // authoring time (the equivalence Phase 7's history tests pin), which
  // restores undo and redo — including a pending redo branch past the
  // cursor — with snapshot-exact documents.
  const entries: HistoryEntry[] = [];
  let replayed = base.value;
  for (const transaction of transactions) {
    const applied = applyTransaction(replayed, transaction);
    if (!applied.ok) {
      return fail(
        nativeError(
          NATIVE_FORMAT_ERROR_CODES.historyMismatch,
          `The persisted transaction log does not replay over its base document: ${applied.error.message}`,
          historyInput,
          applied.error,
        ),
      );
    }
    entries.push(Object.freeze({ transaction, document: applied.value }));
    replayed = applied.value;
  }
  const history: DocumentHistory = Object.freeze({
    base: base.value,
    entries: Object.freeze(entries),
    cursor,
  });
  const atCursor = currentDocument(history);

  // The dual-persistence integrity check: the persisted document state must
  // be serialization-equal to what the replayed log reaches at the cursor.
  // Canonical JSON of the canonical serializer is byte-exact for equal
  // documents, so one string comparison settles it.
  const persistedCanonical = JSON.stringify(
    serializeCadDocument(persisted.value),
  );
  const replayedCanonical = JSON.stringify(serializeCadDocument(atCursor));
  if (persistedCanonical !== replayedCanonical) {
    return fail(
      nativeError(
        NATIVE_FORMAT_ERROR_CODES.historyMismatch,
        "The persisted document state disagrees with the state its transaction log replays to at the cursor; the file is internally inconsistent.",
        input,
      ),
    );
  }

  const regeneration = parseRegenerationStates(input.regeneration);
  if (!regeneration.ok) return regeneration;
  for (const id of regeneration.value.keys()) {
    if (!atCursor.features.some((feature) => feature.id === id)) {
      return fail(
        nativeError(
          NATIVE_FORMAT_ERROR_CODES.regenerationUnknownFeature,
          `The regeneration states name feature "${id}", which the document does not have.`,
          input.regeneration,
        ),
      );
    }
  }

  // The optional Phase 20 rollback field: absent means no marker (every
  // pre-Phase 20 file lands here); present, it must parse as a rollback
  // point and name a feature the document at the cursor declares — the same
  // membership cross-check the regeneration section carries.
  let rollback: FeatureRollbackPoint | null = null;
  if (input.rollback !== undefined && input.rollback !== null) {
    const shape = parseFeatureRollbackShape(input.rollback);
    if (!shape.ok) {
      return fail(
        nativeError(
          NATIVE_FORMAT_ERROR_CODES.malformed,
          `The native document's rollback field is invalid: ${shape.error.message}`,
          input.rollback,
        ),
      );
    }
    const boundary = rollbackZoneBoundary(atCursor.features, shape.value);
    if (!boundary.ok) {
      return fail(
        nativeError(
          NATIVE_FORMAT_ERROR_CODES.rollbackUnknownFeature,
          `The native document's rollback field names feature "${String(shape.value.afterFeatureId)}", which the document does not have.`,
          input.rollback,
        ),
      );
    }
    rollback = shape.value;
  }

  return ok(
    Object.freeze({
      document: atCursor,
      history,
      regeneration: regeneration.value,
      metadata: metadata.value,
      rollback,
    }),
  );
}

/**
 * Parses untrusted input (e.g. a file revived from persisted JSON) as a
 * {@link NativeCadDocument}. The format version is gated first: the current
 * version parses directly, an older version must reach it through the
 * migration framework (a version gap fails structured, from
 * `native-migration/*`), and a future version is rejected predictably.
 * Every section then parses through its substrate parser (strict fields,
 * unknown fields ignored for forward compatibility); the transaction log is
 * replayed over the base document and checked against the persisted state
 * (`native-format/history-mismatch` on any disagreement), so what comes
 * back is a document whose undo/redo works exactly as it did at save time.
 */
export function parseNativeCadDocument(
  input: unknown,
): ParseResult<NativeCadDocument, NativeCadDocumentParseError> {
  if (!isPlainRecord(input)) {
    return fail(
      nativeError(
        NATIVE_FORMAT_ERROR_CODES.malformed,
        "A native document must be a plain object.",
        input,
      ),
    );
  }
  const version = readNativeFormatVersion(input);
  if (version === null) {
    return fail(
      nativeError(
        NATIVE_FORMAT_ERROR_CODES.versionInvalid,
        `A native document must carry an integer formatVersion (${String(CAD_NATIVE_FORMAT_VERSION)} is the current version; version 0 is pre-history, reachable only through migrations).`,
        input.formatVersion,
      ),
    );
  }
  if (version === CAD_NATIVE_FORMAT_VERSION) {
    return parseCurrentNativeCadDocument(input);
  }
  const migrated = migrateNativeCadDocument(input);
  if (!migrated.ok) return migrated;
  const migratedRecord = migrated.value;
  if (!isPlainRecord(migratedRecord)) {
    return fail(
      nativeError(
        NATIVE_FORMAT_ERROR_CODES.malformed,
        "A migrated native document must remain a plain object.",
        migratedRecord,
      ),
    );
  }
  return parseCurrentNativeCadDocument(migratedRecord);
}

/**
 * Parses the format's text form: invalid JSON fails with a structured
 * `native-format/malformed` carrying the parser's message, and valid JSON
 * continues through {@link parseNativeCadDocument}.
 */
export function parseNativeCadDocumentFromString(
  text: string,
): ParseResult<NativeCadDocument, NativeCadDocumentParseError> {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    return fail(
      nativeError(
        NATIVE_FORMAT_ERROR_CODES.malformed,
        `A native document's text must be valid JSON: ${error instanceof SyntaxError ? error.message : String(error)}`,
        text,
      ),
    );
  }
  return parseNativeCadDocument(value);
}

/**
 * Parses the format's byte form: the bytes must be valid UTF-8 (invalid
 * sequences fail structured) and then parse as the text form.
 */
export function parseNativeCadDocumentFromBytes(
  bytes: Uint8Array,
): ParseResult<NativeCadDocument, NativeCadDocumentParseError> {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    return fail(
      nativeError(
        NATIVE_FORMAT_ERROR_CODES.malformed,
        `A native document's bytes must be valid UTF-8: ${error instanceof Error ? error.message : String(error)}`,
        bytes,
      ),
    );
  }
  return parseNativeCadDocumentFromString(text);
}

// ---------------------------------------------------------------------------
// Validation (structural, no replay)
// ---------------------------------------------------------------------------

/** Stable issue codes reported by {@link validateNativeCadDocument}. */
export const NATIVE_FORMAT_ISSUE_CODES = {
  /** The root was not a plain JSON object. */
  notAnObject: "native-format/not-an-object",
  /** The format version was missing or not a positive integer. */
  versionInvalid: "native-format/version-invalid",
  /** The format version is not the current one (see the migration framework). */
  versionUnsupported: "native-format/version-unsupported",
  /** A known field had the wrong shape, value, or was missing. */
  fieldInvalid: "native-format/field-invalid",
  /** A regeneration state entry names a feature the document section lacks. */
  regenerationUnknownFeature: "native-format/regeneration-unknown-feature",
  /** The rollback field names a feature the document section lacks. */
  rollbackUnknownFeature: "native-format/rollback-unknown-feature",
} as const;

export type NativeFormatIssueCode =
  (typeof NATIVE_FORMAT_ISSUE_CODES)[keyof typeof NATIVE_FORMAT_ISSUE_CODES];

/**
 * One structural finding: a failure-class code, the JSON path of the
 * offending value (e.g. `history.transactions[1].commands[0].kind`), and a
 * human-readable explanation.
 */
export interface NativeFormatIssue {
  readonly code: NativeFormatIssueCode;
  readonly path: string;
  readonly message: string;
}

/** The outcome of a structural validation pass. */
export interface NativeDocumentValidation {
  /** True exactly when `issues` is empty. */
  readonly valid: boolean;
  /** The input's format version when one was readable, else null. */
  readonly formatVersion: number | null;
  /** Every finding, in discovery order. */
  readonly issues: readonly NativeFormatIssue[];
}

type Issues = NativeFormatIssue[];

function issue(
  issues: Issues,
  code: NativeFormatIssueCode,
  path: string,
  message: string,
): void {
  issues.push({ code, path, message });
}

/**
 * The body-name limit mirrors the document substrate's rule (1-64
 * characters); the full parse remains the authority, the validator only
 * needs the shape.
 */
const BODY_NAME_MAX_LENGTH = 64;

function validateMetadataShape(
  input: unknown,
  path: string,
  issues: Issues,
): void {
  // Absent metadata parses as the empty record (the parameter module's
  // precedent), so the validator accepts it too — they must agree on what
  // is well-formed.
  if (input === undefined || input === null) return;
  if (!isPlainRecord(input)) {
    issue(
      issues,
      NATIVE_FORMAT_ISSUE_CODES.fieldInvalid,
      path,
      "Metadata must be a plain object of string, finite number, boolean, or null values.",
    );
    return;
  }
  for (const [key, value] of Object.entries(input)) {
    if (key === "__proto__") {
      issue(
        issues,
        NATIVE_FORMAT_ISSUE_CODES.fieldInvalid,
        path,
        'Metadata must not use the "__proto__" key.',
      );
      continue;
    }
    if (!isMetadataValue(value)) {
      issue(
        issues,
        NATIVE_FORMAT_ISSUE_CODES.fieldInvalid,
        `${path}.${key}`,
        "Metadata values must be strings, finite numbers, booleans, or null.",
      );
    }
  }
}

function validateGeneratorState(
  input: unknown,
  path: string,
  issues: Issues,
): void {
  if (!isPlainRecord(input)) {
    issue(
      issues,
      NATIVE_FORMAT_ISSUE_CODES.fieldInvalid,
      path,
      "The id generator state must be a plain object of non-negative integer counters keyed by id kind.",
    );
    return;
  }
  for (const kind of CAD_ID_KINDS) {
    const value = input[kind];
    if (value === undefined) continue;
    if (!isNonNegativeInteger(value)) {
      issue(
        issues,
        NATIVE_FORMAT_ISSUE_CODES.fieldInvalid,
        `${path}.${kind}`,
        `The id generator counter for "${kind}" must be a non-negative integer.`,
      );
    }
  }
}

function validateDimensionalShape(
  input: unknown,
  path: string,
  issues: Issues,
): void {
  const parsed = parseDimensionalValue(input);
  if (!parsed.ok) {
    issue(
      issues,
      NATIVE_FORMAT_ISSUE_CODES.fieldInvalid,
      path,
      `A dimensional value must carry a known dimension, a unit of that dimension, and a finite non-negative magnitude: ${parsed.error.message}`,
    );
  }
}

function validateExpressionShape(
  input: unknown,
  path: string,
  issues: Issues,
): void {
  if (input === null || input === undefined) return;
  const parsed = parseExpressionAst(input);
  if (!parsed.ok) {
    issue(
      issues,
      NATIVE_FORMAT_ISSUE_CODES.fieldInvalid,
      path,
      `An expression must be a valid expression AST: ${parsed.error.message}`,
    );
  }
}

function validateSerializedParameter(
  input: unknown,
  path: string,
  issues: Issues,
): void {
  if (!isPlainRecord(input)) {
    issue(
      issues,
      NATIVE_FORMAT_ISSUE_CODES.fieldInvalid,
      path,
      "A serialized parameter must be a plain object with id, name, value, expression, and metadata fields.",
    );
    return;
  }
  if (!parseParameterId(input.id).ok) {
    issue(
      issues,
      NATIVE_FORMAT_ISSUE_CODES.fieldInvalid,
      `${path}.id`,
      "A parameter id must carry the parameter id prefix and payload rules.",
    );
  }
  if (
    typeof input.name !== "string" ||
    !isExpressionIdentifierName(input.name) ||
    isExpressionFunction(input.name)
  ) {
    issue(
      issues,
      NATIVE_FORMAT_ISSUE_CODES.fieldInvalid,
      `${path}.name`,
      "A parameter name must be an identifier-shaped, non-reserved string.",
    );
  }
  validateDimensionalShape(input.value, `${path}.value`, issues);
  validateExpressionShape(input.expression, `${path}.expression`, issues);
  validateMetadataShape(input.metadata, `${path}.metadata`, issues);
}

function validateSerializedCadDocumentShape(
  input: unknown,
  path: string,
  issues: Issues,
): void {
  if (!isPlainRecord(input)) {
    issue(
      issues,
      NATIVE_FORMAT_ISSUE_CODES.fieldInvalid,
      path,
      "A serialized CAD document must be a plain object with formatVersion, id, idGenerator, parameters, bodies, and features fields.",
    );
    return;
  }
  if (input.formatVersion !== CAD_DOCUMENT_FORMAT_VERSION) {
    issue(
      issues,
      NATIVE_FORMAT_ISSUE_CODES.fieldInvalid,
      `${path}.formatVersion`,
      `A serialized CAD document section must carry the substrate formatVersion ${String(CAD_DOCUMENT_FORMAT_VERSION)}.`,
    );
  }
  if (!parseDocumentId(input.id).ok) {
    issue(
      issues,
      NATIVE_FORMAT_ISSUE_CODES.fieldInvalid,
      `${path}.id`,
      "A document id must carry the document id prefix and payload rules.",
    );
  }
  validateGeneratorState(input.idGenerator, `${path}.idGenerator`, issues);
  if (
    !isPlainRecord(input.parameters) ||
    !Array.isArray(input.parameters.parameters)
  ) {
    issue(
      issues,
      NATIVE_FORMAT_ISSUE_CODES.fieldInvalid,
      `${path}.parameters`,
      "A serialized parameter collection must be a plain object with a parameters array.",
    );
  } else {
    input.parameters.parameters.forEach((entry, index) => {
      validateSerializedParameter(
        entry,
        `${path}.parameters.parameters[${String(index)}]`,
        issues,
      );
    });
  }
  if (!Array.isArray(input.bodies)) {
    issue(
      issues,
      NATIVE_FORMAT_ISSUE_CODES.fieldInvalid,
      `${path}.bodies`,
      "The serialized bodies must be an array.",
    );
  } else {
    input.bodies.forEach((entry, index) => {
      const bodyPath = `${path}.bodies[${String(index)}]`;
      if (!isPlainRecord(entry)) {
        issue(
          issues,
          NATIVE_FORMAT_ISSUE_CODES.fieldInvalid,
          bodyPath,
          "A serialized body must be a plain object with id and name fields.",
        );
        return;
      }
      if (!parseBodyId(entry.id).ok) {
        issue(
          issues,
          NATIVE_FORMAT_ISSUE_CODES.fieldInvalid,
          `${bodyPath}.id`,
          "A body id must carry the body id prefix and payload rules.",
        );
      }
      if (
        typeof entry.name !== "string" ||
        entry.name.length < 1 ||
        entry.name.length > BODY_NAME_MAX_LENGTH
      ) {
        issue(
          issues,
          NATIVE_FORMAT_ISSUE_CODES.fieldInvalid,
          `${bodyPath}.name`,
          "A body name must be a string of 1-64 characters.",
        );
      }
    });
  }
  if (!Array.isArray(input.features)) {
    issue(
      issues,
      NATIVE_FORMAT_ISSUE_CODES.fieldInvalid,
      `${path}.features`,
      "The serialized features must be an array.",
    );
  } else {
    input.features.forEach((entry, index) => {
      const featurePath = `${path}.features[${String(index)}]`;
      if (!isPlainRecord(entry)) {
        issue(
          issues,
          NATIVE_FORMAT_ISSUE_CODES.fieldInvalid,
          featurePath,
          "A serialized feature must be a plain object with id, kind, inputs, and outputs fields.",
        );
        return;
      }
      if (!parseFeatureId(entry.id).ok) {
        issue(
          issues,
          NATIVE_FORMAT_ISSUE_CODES.fieldInvalid,
          `${featurePath}.id`,
          "A feature id must carry the feature id prefix and payload rules.",
        );
      }
      if (!parseFeatureKind(entry.kind).ok) {
        issue(
          issues,
          NATIVE_FORMAT_ISSUE_CODES.fieldInvalid,
          `${featurePath}.kind`,
          "A feature kind must be 1-64 characters, start with a letter, and use only letters, digits, dots, underscores, and hyphens.",
        );
      }
      if (!Array.isArray(entry.inputs)) {
        issue(
          issues,
          NATIVE_FORMAT_ISSUE_CODES.fieldInvalid,
          `${featurePath}.inputs`,
          "Feature inputs must be an array of input references.",
        );
      } else {
        entry.inputs.forEach((ref, refIndex) => {
          if (!parseFeatureInputRef(ref).ok) {
            issue(
              issues,
              NATIVE_FORMAT_ISSUE_CODES.fieldInvalid,
              `${featurePath}.inputs[${String(refIndex)}]`,
              "A feature input must carry a known kind and the matching id.",
            );
          }
        });
      }
      if (!Array.isArray(entry.outputs)) {
        issue(
          issues,
          NATIVE_FORMAT_ISSUE_CODES.fieldInvalid,
          `${featurePath}.outputs`,
          "Feature outputs must be an array of body ids.",
        );
      } else {
        entry.outputs.forEach((id, idIndex) => {
          if (!parseBodyId(id).ok) {
            issue(
              issues,
              NATIVE_FORMAT_ISSUE_CODES.fieldInvalid,
              `${featurePath}.outputs[${String(idIndex)}]`,
              "A feature output must be a valid body id.",
            );
          }
        });
      }
    });
  }
}

/** Validates a create-command's display name (a non-empty string). */
function validateNameShape(
  input: unknown,
  path: string,
  type: string,
  issues: Issues,
): void {
  if (typeof input !== "string" || input.length === 0) {
    issue(
      issues,
      NATIVE_FORMAT_ISSUE_CODES.fieldInvalid,
      path,
      `A ${type} command needs a non-empty name string.`,
    );
  }
}

/** Validates an opaque create-command payload (any plain object). */
function validateRecordShape(
  input: unknown,
  path: string,
  message: string,
  issues: Issues,
): void {
  if (!isPlainRecord(input)) {
    issue(issues, NATIVE_FORMAT_ISSUE_CODES.fieldInvalid, path, message);
  }
}

function validateCommandShape(
  input: unknown,
  path: string,
  issues: Issues,
): void {
  if (!isPlainRecord(input)) {
    issue(
      issues,
      NATIVE_FORMAT_ISSUE_CODES.fieldInvalid,
      path,
      "A serialized command must be a plain object.",
    );
    return;
  }
  const { type } = input;
  if (!isCadCommandType(type)) {
    issue(
      issues,
      NATIVE_FORMAT_ISSUE_CODES.fieldInvalid,
      `${path}.type`,
      `A command type must be one of: ${CAD_COMMAND_TYPES.join(", ")}.`,
    );
    return;
  }
  if (type === "parameter.set") {
    if (!parseParameterId(input.id).ok) {
      issue(
        issues,
        NATIVE_FORMAT_ISSUE_CODES.fieldInvalid,
        `${path}.id`,
        "A parameter.set command needs a valid parameter id.",
      );
    }
    validateDimensionalShape(input.value, `${path}.value`, issues);
    return;
  }
  if (type === "parameter.create") {
    // The id is optional on create (the domain mints one when absent).
    if (input.id !== undefined && !parseParameterId(input.id).ok) {
      issue(
        issues,
        NATIVE_FORMAT_ISSUE_CODES.fieldInvalid,
        `${path}.id`,
        "A parameter.create command's optional id must be a valid parameter id.",
      );
    }
    validateNameShape(input.name, `${path}.name`, "parameter.create", issues);
    validateDimensionalShape(input.value, `${path}.value`, issues);
    return;
  }
  if (type === "body.create") {
    if (input.id !== undefined && !parseBodyId(input.id).ok) {
      issue(
        issues,
        NATIVE_FORMAT_ISSUE_CODES.fieldInvalid,
        `${path}.id`,
        "A body.create command's optional id must be a valid body id.",
      );
    }
    validateNameShape(input.name, `${path}.name`, "body.create", issues);
    return;
  }
  if (type === "sketch.create") {
    if (input.id !== undefined && !parseSketchDocumentId(input.id).ok) {
      issue(
        issues,
        NATIVE_FORMAT_ISSUE_CODES.fieldInvalid,
        `${path}.id`,
        "A sketch.create command's optional id must be a valid sketch id.",
      );
    }
    validateNameShape(input.name, `${path}.name`, "sketch.create", issues);
    validateRecordShape(
      input.sketch,
      `${path}.sketch`,
      "A sketch.create command's sketch payload must be a plain object.",
      issues,
    );
    return;
  }
  if (type === "reference.create") {
    if (input.id !== undefined && !parseReferenceId(input.id).ok) {
      issue(
        issues,
        NATIVE_FORMAT_ISSUE_CODES.fieldInvalid,
        `${path}.id`,
        "A reference.create command's optional id must be a valid reference id.",
      );
    }
    validateNameShape(input.name, `${path}.name`, "reference.create", issues);
    validateRecordShape(
      input.reference,
      `${path}.reference`,
      "A reference.create command's reference payload must be a plain object.",
      issues,
    );
    return;
  }
  if (type === "feature.delete") {
    if (!parseFeatureId(input.id).ok) {
      issue(
        issues,
        NATIVE_FORMAT_ISSUE_CODES.fieldInvalid,
        `${path}.id`,
        "A feature.delete command needs a valid feature id.",
      );
    }
    return;
  }
  if (type === "feature.reorder") {
    if (!parseFeatureId(input.id).ok) {
      issue(
        issues,
        NATIVE_FORMAT_ISSUE_CODES.fieldInvalid,
        `${path}.id`,
        "A feature.reorder command needs a valid feature id.",
      );
    }
    if (
      input.afterFeatureId !== null &&
      !parseFeatureId(input.afterFeatureId).ok
    ) {
      issue(
        issues,
        NATIVE_FORMAT_ISSUE_CODES.fieldInvalid,
        `${path}.afterFeatureId`,
        "A feature.reorder command's afterFeatureId must be null or a valid feature id.",
      );
    }
    return;
  }
  if (input.id === undefined) {
    if (type === "feature.update") {
      issue(
        issues,
        NATIVE_FORMAT_ISSUE_CODES.fieldInvalid,
        `${path}.id`,
        "A feature.update command needs a valid feature id.",
      );
    }
  } else if (!parseFeatureId(input.id).ok) {
    issue(
      issues,
      NATIVE_FORMAT_ISSUE_CODES.fieldInvalid,
      `${path}.id`,
      `A ${type} command's id must be a valid feature id.`,
    );
  }
  if (!parseFeatureKind(input.kind).ok) {
    issue(
      issues,
      NATIVE_FORMAT_ISSUE_CODES.fieldInvalid,
      `${path}.kind`,
      "A feature command's kind must be a valid feature kind string.",
    );
  }
  if (!Array.isArray(input.inputs)) {
    issue(
      issues,
      NATIVE_FORMAT_ISSUE_CODES.fieldInvalid,
      `${path}.inputs`,
      "A feature command's inputs must be an array of input references.",
    );
  } else {
    input.inputs.forEach((ref, refIndex) => {
      if (!parseFeatureInputRef(ref).ok) {
        issue(
          issues,
          NATIVE_FORMAT_ISSUE_CODES.fieldInvalid,
          `${path}.inputs[${String(refIndex)}]`,
          "A feature command input must carry a known kind and the matching id.",
        );
      }
    });
  }
  if (!Array.isArray(input.outputs)) {
    issue(
      issues,
      NATIVE_FORMAT_ISSUE_CODES.fieldInvalid,
      `${path}.outputs`,
      "A feature command's outputs must be an array of body ids.",
    );
  } else {
    input.outputs.forEach((id, idIndex) => {
      if (!parseBodyId(id).ok) {
        issue(
          issues,
          NATIVE_FORMAT_ISSUE_CODES.fieldInvalid,
          `${path}.outputs[${String(idIndex)}]`,
          "A feature command output must be a valid body id.",
        );
      }
    });
  }
}

function validateHistoryShape(
  input: unknown,
  path: string,
  issues: Issues,
): void {
  if (!isPlainRecord(input)) {
    issue(
      issues,
      NATIVE_FORMAT_ISSUE_CODES.fieldInvalid,
      path,
      "The history section must be a plain object with base, transactions, and cursor fields.",
    );
    return;
  }
  validateSerializedCadDocumentShape(input.base, `${path}.base`, issues);
  let transactionCount = 0;
  if (!Array.isArray(input.transactions)) {
    issue(
      issues,
      NATIVE_FORMAT_ISSUE_CODES.fieldInvalid,
      `${path}.transactions`,
      "The history transactions must be an array of serialized transactions.",
    );
  } else {
    transactionCount = input.transactions.length;
    input.transactions.forEach((entry, index) => {
      const transactionPath = `${path}.transactions[${String(index)}]`;
      if (!isPlainRecord(entry)) {
        issue(
          issues,
          NATIVE_FORMAT_ISSUE_CODES.fieldInvalid,
          transactionPath,
          "A serialized transaction must be a plain object with formatVersion and commands fields.",
        );
        return;
      }
      if (entry.formatVersion !== CAD_DOCUMENT_FORMAT_VERSION) {
        issue(
          issues,
          NATIVE_FORMAT_ISSUE_CODES.fieldInvalid,
          `${transactionPath}.formatVersion`,
          `A serialized transaction must carry the substrate formatVersion ${String(CAD_DOCUMENT_FORMAT_VERSION)}.`,
        );
      }
      if (!Array.isArray(entry.commands)) {
        issue(
          issues,
          NATIVE_FORMAT_ISSUE_CODES.fieldInvalid,
          `${transactionPath}.commands`,
          "A serialized transaction's commands must be an array.",
        );
        return;
      }
      entry.commands.forEach((command, commandIndex) => {
        validateCommandShape(
          command,
          `${transactionPath}.commands[${String(commandIndex)}]`,
          issues,
        );
      });
    });
  }
  const cursor = input.cursor;
  if (
    typeof cursor !== "number" ||
    !Number.isInteger(cursor) ||
    cursor < 0 ||
    cursor > transactionCount
  ) {
    issue(
      issues,
      NATIVE_FORMAT_ISSUE_CODES.fieldInvalid,
      `${path}.cursor`,
      `The history cursor must be an integer between 0 and the transaction count (${String(transactionCount)}).`,
    );
  }
}

function validateRegenerationShape(
  input: unknown,
  path: string,
  issues: Issues,
  featureIds: ReadonlySet<string>,
): void {
  if (!isPlainRecord(input)) {
    issue(
      issues,
      NATIVE_FORMAT_ISSUE_CODES.fieldInvalid,
      path,
      "The regeneration section must be a plain object with a features array.",
    );
    return;
  }
  if (input.formatVersion !== CAD_DOCUMENT_FORMAT_VERSION) {
    issue(
      issues,
      NATIVE_FORMAT_ISSUE_CODES.fieldInvalid,
      `${path}.formatVersion`,
      `The regeneration section must carry the substrate formatVersion ${String(CAD_DOCUMENT_FORMAT_VERSION)}.`,
    );
  }
  if (!Array.isArray(input.features)) {
    issue(
      issues,
      NATIVE_FORMAT_ISSUE_CODES.fieldInvalid,
      `${path}.features`,
      "The regeneration states must be an array of feature entries.",
    );
    return;
  }
  const seen = new Set<string>();
  input.features.forEach((entry, index) => {
    const entryPath = `${path}.features[${String(index)}]`;
    if (!isPlainRecord(entry)) {
      issue(
        issues,
        NATIVE_FORMAT_ISSUE_CODES.fieldInvalid,
        entryPath,
        "A regeneration state entry must be a plain object with id, state, and diagnostics fields.",
      );
      return;
    }
    const parsedId = parseFeatureId(entry.id);
    if (!parsedId.ok) {
      issue(
        issues,
        NATIVE_FORMAT_ISSUE_CODES.fieldInvalid,
        `${entryPath}.id`,
        "A regeneration state entry needs a valid feature id.",
      );
      return;
    }
    if (seen.has(parsedId.value)) {
      issue(
        issues,
        NATIVE_FORMAT_ISSUE_CODES.fieldInvalid,
        entryPath,
        `The regeneration states contain the feature "${parsedId.value}" twice.`,
      );
    }
    seen.add(parsedId.value);
    if (!isFeatureRegenerationState(entry.state)) {
      issue(
        issues,
        NATIVE_FORMAT_ISSUE_CODES.fieldInvalid,
        `${entryPath}.state`,
        `A regeneration state must be one of: ${FEATURE_REGENERATION_STATES.join(", ")}.`,
      );
      return;
    }
    const state = entry.state;
    if (!Array.isArray(entry.diagnostics)) {
      issue(
        issues,
        NATIVE_FORMAT_ISSUE_CODES.fieldInvalid,
        `${entryPath}.diagnostics`,
        "Regeneration state diagnostics must be an array of diagnostics.",
      );
    } else {
      let diagnosticCount = 0;
      entry.diagnostics.forEach((diagnostic, diagnosticIndex) => {
        const diagnosticPath = `${entryPath}.diagnostics[${String(diagnosticIndex)}]`;
        if (!parseDiagnostic(diagnostic).ok) {
          issue(
            issues,
            NATIVE_FORMAT_ISSUE_CODES.fieldInvalid,
            diagnosticPath,
            "A regeneration diagnostic must carry a registered severity, code, message, and id-addressed location.",
          );
        }
        diagnosticCount += 1;
      });
      if ((state === "failed") !== diagnosticCount > 0) {
        issue(
          issues,
          NATIVE_FORMAT_ISSUE_CODES.fieldInvalid,
          entryPath,
          "A failed regeneration state must carry at least one diagnostic, and only a failed state may carry diagnostics.",
        );
      }
    }
    if (!featureIds.has(parsedId.value)) {
      issue(
        issues,
        NATIVE_FORMAT_ISSUE_CODES.regenerationUnknownFeature,
        entryPath,
        `The regeneration states name feature "${parsedId.value}", which the document section does not have.`,
      );
    }
  });
}

/** The feature ids named by a document section, when its shape allows reading them. */
function collectFeatureIds(input: unknown): ReadonlySet<string> {
  const ids = new Set<string>();
  if (isPlainRecord(input) && Array.isArray(input.features)) {
    for (const entry of input.features) {
      if (isPlainRecord(entry) && typeof entry.id === "string") {
        ids.add(entry.id);
      }
    }
  }
  return ids;
}

/**
 * Validates the optional Phase 20 rollback field's shape: absent or null
 * means no marker (pre-Phase 20 files carry neither); otherwise the field
 * must parse as a rollback point (plain object, `afterFeatureId` null or a
 * valid feature id — the same shape the history module parses) and, when
 * the document section's shape allows reading its features, must name one
 * of them (the membership cross-check).
 */
function validateRollbackShape(
  input: unknown,
  path: string,
  issues: Issues,
  featureIds: ReadonlySet<string>,
): void {
  if (input === undefined || input === null) return;
  const shape = parseFeatureRollbackShape(input);
  if (!shape.ok) {
    issue(
      issues,
      NATIVE_FORMAT_ISSUE_CODES.fieldInvalid,
      path,
      `The rollback field must be a plain object whose afterFeatureId is null or a valid feature id: ${shape.error.message}`,
    );
    return;
  }
  const anchor = shape.value.afterFeatureId;
  if (anchor !== null && !featureIds.has(anchor)) {
    issue(
      issues,
      NATIVE_FORMAT_ISSUE_CODES.rollbackUnknownFeature,
      `${path}.afterFeatureId`,
      `The rollback field names feature "${anchor}", which the document section does not have.`,
    );
  }
}

/**
 * Validates untrusted input against the native format's structure — fast
 * fail on malformed input, WITHOUT replaying the document. Every check is a
 * pure per-field shape validation through the substrate's own value parsers
 * (ids, kinds, dimensional values, expression ASTs, diagnostics), plus one
 * set-membership cross-check (regeneration entries and the rollback field
 * must name features the document section declares). Inter-entity integrity
 * — references resolving, duplicate ids, the log replaying, the state
 * matching the replay — is the full parse's job, deliberately out of scope
 * here. Unlike the parser's fail-fast single error, the validator collects
 * every issue it finds, each carrying a failure-class code and a JSON path.
 *
 * Version gating: a readable but non-current version stops the pass with a
 * single `native-format/version-unsupported` issue — the structure of a
 * foreign version is not this version's to judge.
 */
export function validateNativeCadDocument(
  input: unknown,
): NativeDocumentValidation {
  const issues: Issues = [];
  if (!isPlainRecord(input)) {
    issue(
      issues,
      NATIVE_FORMAT_ISSUE_CODES.notAnObject,
      "$",
      "A native document must be a plain JSON object.",
    );
    return { valid: false, formatVersion: null, issues: Object.freeze(issues) };
  }
  const version = readNativeFormatVersion(input);
  if (version === null) {
    issue(
      issues,
      NATIVE_FORMAT_ISSUE_CODES.versionInvalid,
      "formatVersion",
      `A native document must carry an integer formatVersion (${String(CAD_NATIVE_FORMAT_VERSION)} is the current version; version 0 is pre-history, reachable only through migrations).`,
    );
    return { valid: false, formatVersion: null, issues: Object.freeze(issues) };
  }
  if (version !== CAD_NATIVE_FORMAT_VERSION) {
    issue(
      issues,
      NATIVE_FORMAT_ISSUE_CODES.versionUnsupported,
      "formatVersion",
      `A native document carries formatVersion ${String(version)}; the current version is ${String(CAD_NATIVE_FORMAT_VERSION)}. Older versions must be migrated; newer versions are unsupported.`,
    );
    return {
      valid: false,
      formatVersion: version,
      issues: Object.freeze(issues),
    };
  }
  validateMetadataShape(input.metadata, "metadata", issues);
  validateSerializedCadDocumentShape(input.document, "document", issues);
  validateHistoryShape(input.history, "history", issues);
  validateRegenerationShape(
    input.regeneration,
    "regeneration",
    issues,
    collectFeatureIds(input.document),
  );
  validateRollbackShape(
    input.rollback,
    "rollback",
    issues,
    collectFeatureIds(input.document),
  );
  return {
    valid: issues.length === 0,
    formatVersion: version,
    issues: Object.freeze(issues),
  };
}
