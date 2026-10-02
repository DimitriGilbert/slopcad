/**
 * The viewer document pipeline: a REAL native document (the workbench
 * session through the persistence bridge's serializer) loads with an
 * honest summary — the variable split the variables form will render, the
 * metadata title when present, the document id when not — and garbage
 * refuses with the format parser's own message.
 */

import { describe, expect, it } from "vitest";

import { createCadWorkbenchSession } from "../cad-workbench/session";
import { serializeSessionToNativeText } from "../cad-projects/native-document-bridge";
import {
  loadViewerDocument,
  summarizeViewerParameters,
  viewerDocumentTitle,
} from "./viewer-document";

const session = createCadWorkbenchSession();
const nativeText = serializeSessionToNativeText(session, new Map(), null);

describe("loadViewerDocument", () => {
  it("loads the workbench session's native text with the honest split", () => {
    const load = loadViewerDocument(nativeText);
    expect(load.ok).toBe(true);
    if (!load.ok) return;
    // The boot document: holeDiameter, translate x/y/z, rotate_z literal;
    // volumeHint and boreRadius expression-driven.
    expect(load.summary.literalParameters).toBe(5);
    expect(load.summary.expressionParameters).toBe(2);
    expect(load.summary.features).toBe(2);
    expect(load.summary.bodies).toBe(1);
  });

  it("falls back to the document id when no metadata title exists", () => {
    const load = loadViewerDocument(nativeText);
    expect(load.ok).toBe(true);
    if (!load.ok) return;
    expect(load.summary.title).toBe(load.parsed.document.id);
    expect(viewerDocumentTitle(load.parsed)).toBe(load.parsed.document.id);
  });

  it("surfaces the format parser's refusal for garbage text", () => {
    const load = loadViewerDocument("{ not a document");
    expect(load.ok).toBe(false);
    if (load.ok) return;
    expect(load.error.length).toBeGreaterThan(0);
  });

  it("surfaces the parser's refusal for a structurally wrong document", () => {
    const load = loadViewerDocument(JSON.stringify({ formatVersion: 999 }));
    expect(load.ok).toBe(false);
  });
});

describe("summarizeViewerParameters", () => {
  it("counts literals and expressions apart", () => {
    const load = loadViewerDocument(nativeText);
    if (!load.ok) throw new Error("the fixture document must load");
    const split = summarizeViewerParameters(
      load.parsed.document.parameters.parameters,
    );
    expect(split).toEqual({ literal: 5, expression: 2 });
  });

  it("an empty document carries zero variables", () => {
    const split = summarizeViewerParameters([]);
    expect(split).toEqual({ literal: 0, expression: 0 });
  });
});
