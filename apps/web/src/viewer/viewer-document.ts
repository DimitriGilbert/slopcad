/**
 * The viewer document pipeline (Phase — shareable parametric pages): the
 * shared native text → live-session handoff and the small summary the
 * viewer chrome reads. The parse is the persistence bridge's own machinery
 * (full format replay + state/log agreement — never a lenient second
 * parser), so a shared link loads exactly what a saved project loads; the
 * summary exists so the chrome and the tests can speak of the document
 * without reaching into kernel records.
 */

import type { Parameter } from "@slopcad/cad-core";

import {
  parseNativeTextToSession,
  type ParsedNativeSession,
} from "../cad-projects/native-document-bridge";

/** The outcome of loading shared text into the viewer. */
export type ViewerDocumentLoad =
  | {
      readonly ok: true;
      readonly parsed: ParsedNativeOk;
      readonly summary: ViewerDocumentSummary;
    }
  | { readonly ok: false; readonly error: string };

/**
 * The one-line facts the viewer chrome shows beside the part: the display
 * title (the document's stored metadata title when the sharer set one,
 * else the document id) and the variable split the form will render.
 */
export interface ViewerDocumentSummary {
  readonly title: string;
  readonly literalParameters: number;
  readonly expressionParameters: number;
  readonly features: number;
  readonly bodies: number;
}

/** The loaded variant of the bridge's parse (the success side). */
export type ParsedNativeOk = Extract<ParsedNativeSession, { ok: true }>;

/** The display title of a shared document: metadata title, else the id. */
export function viewerDocumentTitle(parsed: ParsedNativeOk): string {
  const title = parsed.metadata.title;
  return typeof title === "string" && title.trim() !== ""
    ? title
    : parsed.document.id;
}

/** The variable split of a document's parameters (literals vs expressions). */
export function summarizeViewerParameters(parameters: readonly Parameter[]): {
  readonly literal: number;
  readonly expression: number;
} {
  let literal = 0;
  let expression = 0;
  for (const parameter of parameters) {
    if (parameter.expression === null) literal += 1;
    else expression += 1;
  }
  return { literal, expression };
}

/** Builds the chrome summary from a parsed shared document. */
export function summarizeViewerDocument(
  parsed: ParsedNativeOk,
): ViewerDocumentSummary {
  const { literal, expression } = summarizeViewerParameters(
    // The document carries the parameters as a collection (the domain's
    // immutable shape); the split reads its array.
    parsed.document.parameters.parameters,
  );
  return {
    title: viewerDocumentTitle(parsed),
    literalParameters: literal,
    expressionParameters: expression,
    features: parsed.document.features.length,
    bodies: parsed.document.bodies.length,
  };
}

/**
 * Loads shared native text: the bridge's parse (verbatim refusals) plus
 * the chrome summary. The caller adopts `parsed.session` through the
 * store's `replaceSession` door and restores `parsed.rollback`.
 */
export function loadViewerDocument(text: string): ViewerDocumentLoad {
  const parsed = parseNativeTextToSession(text);
  if (!parsed.ok) {
    return { ok: false, error: parsed.error };
  }
  return { ok: true, parsed, summary: summarizeViewerDocument(parsed) };
}
