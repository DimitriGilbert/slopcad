/**
 * The drawing save-envelope fixtures (Phase 55 round 2): the ONE seam
 * between the drawing workbench and the native document format. The
 * round-trip pin is the save-envelope call-site guard — a mutation that
 * drops the `drawing` field from the saved payload (or drops the field
 * from the load path's expectations) fails here instead of silently
 * forking Save's output from Load's input. The pre-drawing envelope pin
 * holds the Load-refusal path honest: no drawing field ⇒ `drawing: null`
 * ⇒ the caller refuses, never fabricates an empty sheet.
 */

import { describe, expect, it } from "vitest";
import {
  createBodyId,
  createDrawingViewId,
  createSheetId,
  type DrawingDocument,
} from "@slopcad/cad-core";

import {
  parseDrawingSaveEnvelope,
  serializeDrawingSaveEnvelope,
} from "./drawing-persistence";

const drawing: DrawingDocument = {
  sheets: [
    {
      id: createSheetId("sht_main"),
      size: "A3",
      orientation: "landscape",
      scale: { numerator: 1, denominator: 2 },
      views: [
        {
          id: createDrawingViewId("dwv_front"),
          kind: "front",
          bodyId: createBodyId("body_drawing_plate"),
          x: 148,
          y: 140,
          scale: null,
          alignedTo: null,
        },
      ],
    },
  ],
};

describe("the drawing save envelope", () => {
  it("round-trips the drawing through the native envelope", () => {
    const saved = serializeDrawingSaveEnvelope(drawing);
    expect(saved.ok).toBe(true);
    if (!saved.ok) return;
    // The payload IS the native format's canonical text.
    expect(saved.nativeContent.startsWith("{")).toBe(true);
    const loaded = parseDrawingSaveEnvelope(saved.nativeContent);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    // THE CALL-SITE PIN: the envelope carries the drawing field — a
    // mutation that drops it lands here as `null`, not the authored
    // sheet.
    expect(loaded.drawing).not.toBeNull();
    expect(loaded.drawing).toEqual(drawing);
  });

  it("refuses an envelope that carries no drawing (the pre-drawing form)", () => {
    // An envelope saved WITHOUT the drawing field (the mutation target,
    // or a native document from before drawings existed) must parse OK
    // but report `drawing: null` — the Load path's honest refusal.
    const saved = serializeDrawingSaveEnvelope(drawing);
    expect(saved.ok).toBe(true);
    if (!saved.ok) return;
    const stripped = JSON.parse(saved.nativeContent) as Record<string, unknown>;
    delete stripped.drawing;
    const loaded = parseDrawingSaveEnvelope(JSON.stringify(stripped));
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.drawing).toBeNull();
  });

  it("refuses a payload the native format rejects", () => {
    const loaded = parseDrawingSaveEnvelope("not a native document");
    expect(loaded.ok).toBe(false);
    if (loaded.ok) return;
    expect(loaded.message.length).toBeGreaterThan(0);
  });
});
