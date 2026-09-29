/**
 * Native emission: the JSX model compiler's one-step bridge onto the
 * canonical native `slopcad` document format (Phase 3).
 *
 * `compileToNative` compiles the element tree through {@link compileModel}
 * (no second parametric representation), folds the emitted transaction's
 * commands over a fresh empty document through `applySessionTransaction` —
 * the session API whose `applyTransaction` folds every command through
 * `applyCommand`, cad-core's sole interpreter — and serializes the
 * resulting session with cad-core's own native serializer
 * (`serializeNativeCadDocument` + `stringifyNativeCadDocument`, the exact
 * pair the workbench's persistence bridge uses). The result is the same
 * canonical, deterministic JSON text the server's `documents.save` route
 * stores as `nativeContent` (validated by `parseNativeCadDocumentFromString`),
 * so an emitted model opens in the workbench unchanged.
 *
 * Before returning, the emission re-parses its own output through the
 * format's full machinery — the replay-and-check parse a load runs — and
 * verifies the parsed document is serialization-equal to the folded one.
 * A caller never receives a string the format would refuse.
 *
 * Determinism: every input is derived from the tree (the compiler's
 * discipline) plus fixed defaults; nothing consults the clock, randomness,
 * or the environment — the same tree (and options) emits the identical
 * string. Domain errors never throw: they return structured failures.
 */

import {
  applySessionTransaction,
  createDocument,
  createSession,
  fail,
  ok,
  parseDocumentId,
  parseNativeCadDocumentFromString,
  serializeCadDocument,
  serializeNativeCadDocument,
  stringifyNativeCadDocument,
  type CadDocument,
  type NativeCadDocument,
  type NativeCadDocumentParseError,
  type ParameterMetadataValue,
  type ParseResult,
  type TransactionError,
} from "@slopcad/cad-core";
import type { ReactElement } from "react";
import type { CadJsxCompileError } from "./compiler";

import { compileModel } from "./compiler";

/**
 * The document id emitted when the caller supplies none: a fixed, valid
 * `doc_…` id, so a bare `compileToNative(root)` stays deterministic.
 */
export const DEFAULT_NATIVE_DOCUMENT_ID = "doc_cadjsx-model";

/**
 * The metadata every emitted document carries: the generator's package
 * name, so a file's provenance is readable in the format's own metadata
 * section (serialized with sorted keys, like all native metadata).
 */
export const NATIVE_EMIT_METADATA: Readonly<
  Record<string, ParameterMetadataValue>
> = Object.freeze({ generator: "@slopcad/cad-jsx" });

/** Stable failure codes produced when native emission is rejected. */
export const NATIVE_EMIT_ERROR_CODES = {
  /** The requested document id is not a valid `doc_…` id. */
  documentIdInvalid: "cadjsx/native-document-id-invalid",
  /** The requested metadata is not JSON-safe native metadata. */
  metadataInvalid: "cadjsx/native-metadata-invalid",
  /**
   * A command failed to apply during the fold (e.g. a feature input that
   * does not resolve in the document the tree built).
   */
  commandFailed: "cadjsx/native-command-failed",
  /**
   * The emitted text failed the emission's own re-parse check — the
   * guarantee this module exists to make; reaching it means the serializer
   * and parser disagree.
   */
  roundTripFailed: "cadjsx/native-round-trip-failed",
} as const;

export type NativeEmitErrorCode =
  (typeof NATIVE_EMIT_ERROR_CODES)[keyof typeof NATIVE_EMIT_ERROR_CODES];

/**
 * Structured failure describing why native emission was rejected. A fold
 * failure carries the offending command's zero-based `index`; `cause`
 * carries the underlying cad-core error (the transaction failure of a
 * `command-failed`, the native-format failure of a metadata or round-trip
 * rejection).
 */
export interface NativeEmitError {
  readonly code: NativeEmitErrorCode;
  readonly message: string;
  readonly input: unknown;
  /** The offending command's zero-based position, for `command-failed`. */
  readonly index?: number;
  readonly cause?: TransactionError | NativeCadDocumentParseError;
}

/** Options for {@link compileToNative}; every field has a deterministic default. */
export interface CompileToNativeOptions {
  /**
   * The emitted document's id (the `doc_…` wire format); defaults to
   * {@link DEFAULT_NATIVE_DOCUMENT_ID}.
   */
  readonly documentId?: string;
  /**
   * The emitted document's metadata (JSON-safe scalars, the native
   * format's rule); defaults to {@link NATIVE_EMIT_METADATA}.
   */
  readonly metadata?: Readonly<Record<string, ParameterMetadataValue>>;
}

function emitError(
  code: NativeEmitErrorCode,
  message: string,
  input: unknown,
  extra?: {
    readonly index?: number;
    readonly cause?: TransactionError | NativeCadDocumentParseError;
  },
): NativeEmitError {
  return {
    code,
    message,
    input,
    ...(extra?.index === undefined ? {} : { index: extra.index }),
    ...(extra?.cause === undefined ? {} : { cause: extra.cause }),
  };
}

/**
 * Compiles a JSX model all the way to the native `slopcad` document
 * format's canonical text: compile → fold over a fresh empty document →
 * serialize → re-parse self-check. The returned string is what the
 * server's save path stores and the workbench's bridge reads — two-space-
 * indented JSON with a trailing newline, byte-stable for the same tree
 * and options. Pure; never throws for domain errors.
 */
export function compileToNative(
  root: ReactElement<unknown>,
  options: CompileToNativeOptions = {},
): ParseResult<string, CadJsxCompileError | NativeEmitError> {
  const documentId = options.documentId ?? DEFAULT_NATIVE_DOCUMENT_ID;
  const parsedId = parseDocumentId(documentId);
  if (!parsedId.ok) {
    return fail(
      emitError(
        NATIVE_EMIT_ERROR_CODES.documentIdInvalid,
        `The requested document id is not a valid document id: ${parsedId.error.message}`,
        documentId,
      ),
    );
  }

  const compiled = compileModel(root);
  if (!compiled.ok) return compiled;

  // The fold: a fresh empty document, the session's single commit path —
  // applySessionTransaction folds every command through applyCommand and
  // records the entry, which is exactly the dual-persisted history the
  // native serializer writes (the same route the workbench saves through).
  const session = createSession(createDocument(parsedId.value));
  const applied = applySessionTransaction(session, compiled.value);
  if (!applied.ok) {
    return fail(
      emitError(
        NATIVE_EMIT_ERROR_CODES.commandFailed,
        `The compiled transaction does not apply to a fresh document (command ${applied.error.index} failed): ${applied.error.message}`,
        compiled.value,
        { index: applied.error.index, cause: applied.error },
      ),
    );
  }

  const native: NativeCadDocument = {
    document: applied.value.document,
    history: applied.value.history,
    regeneration: new Map(),
    metadata: options.metadata ?? NATIVE_EMIT_METADATA,
    rollback: null,
    drawing: null,
  };
  const text = stringifyNativeCadDocument(serializeNativeCadDocument(native));

  // The self-check: the emitted text must survive the format's own full
  // parse (the replay-and-check a load runs) and the parsed document must
  // be serialization-equal to the folded one. The parser's error carries
  // the classification (metadata shape, replay disagreement, …).
  const reparsed = parseNativeCadDocumentFromString(text);
  if (!reparsed.ok) {
    const cause = reparsed.error;
    return fail(
      emitError(
        cause.code === "native-format/metadata-invalid"
          ? NATIVE_EMIT_ERROR_CODES.metadataInvalid
          : NATIVE_EMIT_ERROR_CODES.roundTripFailed,
        `The emitted native document failed its own re-parse check: ${cause.message}`,
        text,
        { cause },
      ),
    );
  }
  if (!serializationEqual(applied.value.document, reparsed.value.document)) {
    return fail(
      emitError(
        NATIVE_EMIT_ERROR_CODES.roundTripFailed,
        "The emitted native document re-parses to a different document than the one the fold built.",
        text,
      ),
    );
  }

  return ok(text);
}

/** Canonical-JSON document equality: byte-exact for equal documents. */
function serializationEqual(left: CadDocument, right: CadDocument): boolean {
  return (
    JSON.stringify(serializeCadDocument(left)) ===
    JSON.stringify(serializeCadDocument(right))
  );
}
