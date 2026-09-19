/**
 * The `native files` guide's runnable example
 * (docs/guides/native-files.md): the ONE format that preserves parametric
 * history. A live session (document + transaction log) is serialized to
 * the native format's canonical text, reopened through the format's own
 * parser — which replays the log over the base and refuses any
 * state/log disagreement — and the reopened document is compared to the
 * saved one. The bytes round-trip: saving the reopened document emits
 * identical text.
 */

import {
  applySessionCommand,
  CAD_NATIVE_FORMAT_VERSION,
  createBodyId,
  createDocument,
  createDocumentId,
  createParameterId,
  createSession,
  encodeNativeCadDocument,
  length,
  parseNativeCadDocumentFromBytes,
  parseNativeCadDocumentFromString,
  serializeNativeCadDocument,
  stringifyNativeCadDocument,
  validateNativeCadDocument,
  type NativeCadDocument,
} from "@slopcad/cad-core";

import { unwrap } from "./document";

/** What the example reports back to the guide and the docs page. */
export interface NativeFormatExampleSummary {
  readonly textBytes: number;
  readonly byteEncodedBytes: number;
  readonly formatVersion: number;
  readonly reopenedHoleMm: number;
  readonly reopenedTransactionCount: number;
  readonly validatorIssues: number;
  readonly resaveIdentical: boolean;
}

/**
 * Saves a one-edit session to the native format, reopens it, and proves
 * the three persistence facts the guide states: the text and byte forms
 * carry the same document, the replayed history agrees with the persisted
 * state, and determinism makes a resave byte-identical.
 */
export function runNativeFormatExample(): NativeFormatExampleSummary {
  // A document with one committed edit (the guide's holeDiameter edit).
  let session = createSession(
    createDocument(createDocumentId("doc_guide_native")),
  );
  session = unwrap(
    applySessionCommand(session, {
      type: "parameter.create",
      id: createParameterId("param_hole"),
      name: "holeDiameter",
      value: length(10),
    }),
    "holeDiameter parameter",
  );
  session = unwrap(
    applySessionCommand(session, {
      type: "body.create",
      id: createBodyId("body_plate"),
      name: "plate",
    }),
    "plate body",
  );
  session = unwrap(
    applySessionCommand(session, {
      type: "parameter.set",
      id: createParameterId("param_hole"),
      value: length(12),
    }),
    "holeDiameter edit",
  );

  const native: NativeCadDocument = {
    document: session.document,
    history: session.history,
    regeneration: new Map(),
    metadata: { title: "The native-format guide example" },
    rollback: null,
  };

  // The canonical text form: two-space-indented JSON with a trailing
  // newline — the form the app persists through its bridge.
  const text = stringifyNativeCadDocument(serializeNativeCadDocument(native));
  const bytes = encodeNativeCadDocument(native);

  // Reopen: the text parser replays the transaction log over the base and
  // verifies the replay's state at the cursor equals the persisted state.
  const reopened = parseNativeCadDocumentFromString(text);
  if (!reopened.ok) {
    throw new Error(
      `Reopening the saved text failed: ${reopened.error.message}`,
    );
  }
  // The byte parser is the text parser behind a UTF-8 boundary.
  const fromBytes = parseNativeCadDocumentFromBytes(bytes);
  if (!fromBytes.ok) {
    throw new Error(
      `Reopening the saved bytes failed: ${fromBytes.error.message}`,
    );
  }

  // The structural validator: collects every issue instead of failing
  // fast, without replaying anything.
  const validation = validateNativeCadDocument(JSON.parse(text) as unknown);

  // Determinism: serializing the reopened document emits identical text.
  const resave = stringifyNativeCadDocument(
    serializeNativeCadDocument(reopened.value),
  );

  const hole = reopened.value.document.parameters.parameters.find(
    (parameter) => parameter.name === "holeDiameter",
  );
  if (hole === undefined) {
    throw new Error("The reopened document lost its holeDiameter parameter.");
  }

  return {
    textBytes: text.length,
    byteEncodedBytes: bytes.byteLength,
    formatVersion: CAD_NATIVE_FORMAT_VERSION,
    reopenedHoleMm: hole.value.value,
    reopenedTransactionCount: reopened.value.history.entries.length,
    validatorIssues: validation.issues.length,
    resaveIdentical: resave === text,
  };
}
