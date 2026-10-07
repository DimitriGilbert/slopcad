/**
 * The persistence bridge's open path: the persisted authoring state rides
 * with the content — parsing a native text must surface the rollback
 * marker (the review fix for the reopen path dropping it), the
 * document-level metadata and drawing (the review fix for the model
 * workbench's save appending a version that silently dropped them), and
 * the suppressed-feature set (the review fix for the suppression dying at
 * the file boundary), so the project workbench can restore the same
 * parked, suppressed timeline that was saved and re-save a drawing
 * document without destroying its drawing.
 */

import { describe, expect, it } from "vitest";
import {
  applySessionTransaction,
  createBodyId,
  createDocument,
  createDocumentId,
  createFeatureId,
  createSession,
  createSheetId,
  type CadSession,
  type DrawingDocument,
  type FeatureId,
} from "@slopcad/cad-core";

import {
  type ParsedNativeSession,
  parseNativeTextToSession,
  serializeSessionToNativeText,
} from "./native-document-bridge";

const PAD_FEATURE = createFeatureId("feat_pad");
const PAD_BODY = createBodyId("body_pad");
/** The set-free save: the byte form every pre-field payload carries. */
const NO_SUPPRESSION: ReadonlySet<FeatureId> = new Set();

function requireOk<T>(
  result:
    | { readonly ok: true; readonly value: T }
    | { readonly ok: false; readonly error: { readonly message: string } },
  what: string,
): T {
  if (!result.ok) {
    throw new Error(
      `The bridge test builder rejected ${what}: ${result.error.message}`,
    );
  }
  return result.value;
}

/** A one-feature session: the marker's anchor exists in the document. */
function sessionWithPadFeature(): CadSession {
  const session = createSession(
    createDocument(createDocumentId("doc_bridge_test")),
  );
  return requireOk(
    applySessionTransaction(session, {
      commands: [
        { type: "body.create", id: PAD_BODY, name: "pad" },
        {
          type: "feature.create",
          id: PAD_FEATURE,
          kind: "extrude",
          inputs: [],
          outputs: [PAD_BODY],
        },
      ],
    }),
    "the pad feature commit",
  );
}

function parseOk(
  result: ParsedNativeSession,
): Extract<ParsedNativeSession, { readonly ok: true }> {
  if (!result.ok) {
    throw new Error(`The bridge rejected the saved text: ${result.error}`);
  }
  return result;
}

describe("parseNativeTextToSession surfaces the persisted rollback marker", () => {
  it("returns the marker a saved document carries", () => {
    const session = sessionWithPadFeature();
    const rollback = { afterFeatureId: PAD_FEATURE };
    const parsed = parseOk(
      parseNativeTextToSession(
        serializeSessionToNativeText(
          session,
          new Map(),
          rollback,
          {},
          null,
          NO_SUPPRESSION,
        ),
      ),
    );
    expect(parsed.rollback).toEqual(rollback);
    // The reopen path's other derivations are unchanged by the fix.
    expect(parsed.scene).toBe("extrude");
    expect(parsed.document.features[0]?.id).toBe(PAD_FEATURE);
  });

  it("returns null for a marker-free document (and a stale marker is never even persisted)", () => {
    const session = sessionWithPadFeature();
    const parsed = parseOk(
      parseNativeTextToSession(
        serializeSessionToNativeText(
          session,
          new Map(),
          null,
          {},
          null,
          NO_SUPPRESSION,
        ),
      ),
    );
    expect(parsed.rollback).toBeNull();
    // The serializer's symmetry clamp composes with the bridge: a marker
    // naming a feature the document does not have is omitted at save time,
    // so the open path can never receive one.
    const stale = parseOk(
      parseNativeTextToSession(
        serializeSessionToNativeText(
          session,
          new Map(),
          {
            afterFeatureId: createFeatureId("feat_was_deleted"),
          },
          {},
          null,
          NO_SUPPRESSION,
        ),
      ),
    );
    expect(stale.rollback).toBeNull();
  });

  it("fails structured on text the format's parser rejects", () => {
    const parsed = parseNativeTextToSession("{ not json");
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.error).toContain("valid JSON");
    }
  });
});

describe("the model workbench's load/save cycle preserves drawing and metadata", () => {
  /** One A4 landscape sheet at 1:1 — the minimal drawing a save carries. */
  const drawing: DrawingDocument = {
    sheets: [
      {
        id: createSheetId("sht_sheet-1"),
        size: "A4",
        orientation: "landscape",
        scale: { numerator: 1, denominator: 1 },
        views: [],
      },
    ],
  };
  const metadata = { revision: 3, reviewed: true, title: "Bracket drawing" };

  it("a document with metadata, a drawing, and suppression survives a load/save cycle byte-preserving", () => {
    // SAVE: a document whose native text carries a drawing, metadata, and
    // a suppressed feature — the combined payload (exactly what a session
    // with a drawing open and one suppressed timeline chip writes).
    const saved = serializeSessionToNativeText(
      sessionWithPadFeature(),
      new Map(),
      null,
      metadata,
      drawing,
      new Set([PAD_FEATURE]),
    );
    // LOAD (the model workbench's Open — the Open links route every
    // document there): the parse must surface all three fields.
    const parsed = parseOk(parseNativeTextToSession(saved));
    expect(parsed.metadata).toEqual(metadata);
    expect(parsed.drawing).toEqual(drawing);
    expect(parsed.suppressedFeatures).toEqual(new Set([PAD_FEATURE]));
    // SAVE again (the model workbench's Save re-serializes the parsed
    // session with the held extras and the restored set): byte-identical,
    // so the appended version carries everything forward instead of
    // rewriting the drawing to `null` or dropping the suppression — the
    // only reachable copy is never destroyed.
    const resaved = serializeSessionToNativeText(
      parsed.session,
      new Map(),
      parsed.rollback,
      parsed.metadata,
      parsed.drawing,
      parsed.suppressedFeatures,
    );
    expect(resaved).toBe(saved);
  });

  it("a document persisted without extras parses back to empty metadata and a null drawing", () => {
    const parsed = parseOk(
      parseNativeTextToSession(
        serializeSessionToNativeText(
          sessionWithPadFeature(),
          new Map(),
          null,
          {},
          null,
          NO_SUPPRESSION,
        ),
      ),
    );
    expect(parsed.metadata).toEqual({});
    expect(parsed.drawing).toBeNull();
  });
});

describe("the persisted suppressed-feature set survives the file boundary", () => {
  it("a suppressed feature round-trips and re-saves byte-identical", () => {
    // SAVE: the engine's current suppressed set (the timeline chip's
    // suppress action held one feature).
    const saved = serializeSessionToNativeText(
      sessionWithPadFeature(),
      new Map(),
      null,
      {},
      null,
      new Set([PAD_FEATURE]),
    );
    // LOAD (the project workbench's open path): the parse surfaces the
    // set for `engine.setSuppressed` to restore — the suppression that
    // used to die at this boundary.
    const parsed = parseOk(parseNativeTextToSession(saved));
    expect(parsed.suppressedFeatures).toEqual(new Set([PAD_FEATURE]));
    // SAVE again (the reopened session restores the set and re-serializes
    // it): byte-identical.
    const resaved = serializeSessionToNativeText(
      parsed.session,
      new Map(),
      parsed.rollback,
      parsed.metadata,
      parsed.drawing,
      parsed.suppressedFeatures,
    );
    expect(resaved).toBe(saved);
  });

  it("a set-free save stays byte-identical to the pre-field format and parses to an empty set", () => {
    const saved = serializeSessionToNativeText(
      sessionWithPadFeature(),
      new Map(),
      null,
      {},
      null,
      NO_SUPPRESSION,
    );
    // The additive-optional discipline: nothing to persist means no key,
    // so every pre-field payload is byte-unchanged by the fix.
    expect(saved).not.toContain("suppressedFeatures");
    const parsed = parseOk(parseNativeTextToSession(saved));
    expect(parsed.suppressedFeatures.size).toBe(0);
  });

  it("a stale suppressed id never persists (the rollback clamp's mirror)", () => {
    // The engine's set is page-level state an undo can outlive; the
    // format's serializer clamps ids the document no longer declares, so
    // the save never carries a feature the file's own timeline lacks.
    const saved = serializeSessionToNativeText(
      sessionWithPadFeature(),
      new Map(),
      null,
      {},
      null,
      new Set([PAD_FEATURE, createFeatureId("feat_was_deleted")]),
    );
    const parsed = parseOk(parseNativeTextToSession(saved));
    expect(parsed.suppressedFeatures).toEqual(new Set([PAD_FEATURE]));
  });
});
