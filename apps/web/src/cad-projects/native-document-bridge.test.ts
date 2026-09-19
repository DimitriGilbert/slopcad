/**
 * The persistence bridge's open path: the rollback marker rides with the
 * persisted content — parsing a native text that carries a marker must
 * surface it (the review fix for the reopen path dropping it), so the
 * project workbench can restore the same parked timeline that was saved.
 */

import { describe, expect, it } from "vitest";
import {
  applySessionTransaction,
  createBodyId,
  createDocument,
  createDocumentId,
  createFeatureId,
  createSession,
  type CadSession,
} from "@slopcad/cad-core";

import {
  type ParsedNativeSession,
  parseNativeTextToSession,
  serializeSessionToNativeText,
} from "./native-document-bridge";

const PAD_FEATURE = createFeatureId("feat_pad");
const PAD_BODY = createBodyId("body_pad");

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
        serializeSessionToNativeText(session, new Map(), rollback),
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
        serializeSessionToNativeText(session, new Map(), null),
      ),
    );
    expect(parsed.rollback).toBeNull();
    // The serializer's symmetry clamp composes with the bridge: a marker
    // naming a feature the document does not have is omitted at save time,
    // so the open path can never receive one.
    const stale = parseOk(
      parseNativeTextToSession(
        serializeSessionToNativeText(session, new Map(), {
          afterFeatureId: createFeatureId("feat_was_deleted"),
        }),
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
