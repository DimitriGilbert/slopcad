/**
 * The drawing save/load envelope (Phase 55 round 2): the ONE seam between
 * the drawing workbench and the native document format. Save serializes
 * the drawing into a minimal native document whose additive-optional
 * `drawing` field carries the document model; Load parses a saved
 * envelope back and reports the drawing — or `null` when the envelope
 * predates drawings, which the caller must refuse honestly (never
 * fabricate an empty drawing).
 *
 * Extracting the call site here gives the envelope a unit surface: a
 * mutation that drops the `drawing` field from the saved payload fails
 * the round-trip fixture instead of silently forking what Save writes
 * from what Load reads.
 */

import {
  createDocument,
  createDocumentId,
  createNativeCadDocument,
  parseNativeCadDocumentFromString,
  serializeNativeCadDocument,
  stringifyNativeCadDocument,
  type DrawingDocument,
} from "@slopcad/cad-core";

/** The fixed document id payload for drawing envelopes (stable across saves). */
const DRAWING_ENVELOPE_DOCUMENT_ID = "doc_drawings";

/** The outcome of building one save envelope. */
export type SaveEnvelopeResult =
  | { readonly ok: true; readonly nativeContent: string }
  | { readonly ok: false; readonly message: string };

/** The outcome of reading one saved envelope. */
export type LoadEnvelopeResult =
  | { readonly ok: true; readonly drawing: DrawingDocument | null }
  | { readonly ok: false; readonly message: string };

/**
 * Builds the saved payload: a minimal native document plus the drawing
 * in its additive-optional envelope field (emitted last, only when a
 * drawing exists — the native format's own serialization discipline).
 */
export function serializeDrawingSaveEnvelope(
  drawing: DrawingDocument,
): SaveEnvelopeResult {
  const created = createNativeCadDocument(
    createDocument(createDocumentId(DRAWING_ENVELOPE_DOCUMENT_ID)),
  );
  if (!created.ok) {
    return { ok: false, message: created.error.message };
  }
  const native = { ...created.value, drawing };
  return {
    ok: true,
    nativeContent: stringifyNativeCadDocument(
      serializeNativeCadDocument(native),
    ),
  };
}

/**
 * Reads a saved payload with the native format's full parse-and-replay
 * check. `drawing: null` means the envelope carries no drawing — the
 * caller refuses rather than showing an empty sheet.
 */
export function parseDrawingSaveEnvelope(
  nativeContent: string,
): LoadEnvelopeResult {
  const parsed = parseNativeCadDocumentFromString(nativeContent);
  if (!parsed.ok) {
    return { ok: false, message: parsed.error.message };
  }
  return { ok: true, drawing: parsed.value.drawing };
}
