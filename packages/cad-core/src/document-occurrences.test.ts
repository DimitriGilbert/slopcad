/**
 * Document occurrence tests (Phase 50): CRUD discipline, additive
 * serialization (byte-identical for occurrence-free documents), native
 * round-trip, and the v3→v4 identity migration.
 */

import { describe, expect, it } from "vitest";

import {
  addBody,
  addOccurrence,
  CAD_NATIVE_FORMAT_VERSION,
  createDocument,
  createDocumentId,
  createNativeCadDocument,
  createOccurrenceId,
  DOCUMENT_ERROR_CODES,
  getOccurrence,
  parseCadDocument,
  parseNativeCadDocumentFromString,
  removeOccurrence,
  serializeCadDocument,
  stringifyNativeCadDocument,
  serializeNativeCadDocument,
  updateOccurrence,
  type CadDocument,
} from "./index";

const DOC_ID = createDocumentId("doc_occ");

/** The first body id of a document (tests index through this one guard). */
function firstBodyIdOf(document: CadDocument) {
  const body = document.bodies[0];
  if (body === undefined) throw new Error("expected a body");
  return body.id;
}

function docWithBody() {
  let document = createDocument(DOC_ID);
  const added = addBody(document, { name: "Plate" });
  if (!added.ok) throw new Error("expected body add");
  document = added.value.document;
  const body = document.bodies[0];
  if (body === undefined) throw new Error("expected a body");
  return { document, bodyId: body.id };
}

describe("occurrence records", () => {
  it("adds, reads, updates, and removes occurrences with generated ids", () => {
    const base = docWithBody().document;
    const added = addOccurrence(base, {
      name: "Bolt",
      source: { kind: "body", bodyId: firstBodyIdOf(base) },
      placement: { kind: "offset", translation: [10, 0, 0] },
      bomFlag: "purchased",
    });
    expect(added.ok).toBe(true);
    if (!added.ok) return;
    const { document, occurrence } = added.value;
    expect(occurrence.id).toMatch(/^occ_/);
    expect(occurrence.bomFlag).toBe("purchased");
    expect(getOccurrence(document, occurrence.id)).toBe(occurrence);

    const flagged = updateOccurrence(document, occurrence.id, {
      bomFlag: "phantom",
      placement: { kind: "identity" },
    });
    expect(flagged.ok).toBe(true);
    if (!flagged.ok) return;
    expect(getOccurrence(flagged.value, occurrence.id)?.bomFlag).toBe(
      "phantom",
    );
    expect(getOccurrence(flagged.value, occurrence.id)?.placement).toEqual({
      kind: "identity",
    });

    const removed = removeOccurrence(flagged.value, occurrence.id);
    expect(removed.ok).toBe(true);
    if (!removed.ok) return;
    expect(removed.value.occurrences).toHaveLength(0);
  });

  it("validates names, unknown body sources, missing datum anchors, and flags", () => {
    const { document: base, bodyId } = docWithBody();
    expect(
      addOccurrence(base, {
        name: "",
        source: { kind: "body", bodyId },
      }),
    ).toMatchObject({
      ok: false,
      error: { code: DOCUMENT_ERROR_CODES.occurrenceNameInvalid },
    });
    expect(
      addOccurrence(base, {
        name: "Ghost",
        source: {
          kind: "body",
          bodyId: createOccurrenceId("occ_none") as never,
        },
      }).ok,
    ).toBe(false);
    expect(
      addOccurrence(base, {
        name: "Ghost",
        source: { kind: "document", documentId: "" },
      }),
    ).toMatchObject({
      ok: false,
      error: { code: DOCUMENT_ERROR_CODES.occurrenceSourceInvalid },
    });
    expect(
      addOccurrence(base, {
        name: "Anchored",
        source: { kind: "body", bodyId },
        placement: {
          kind: "datum",
          datumId: createOccurrenceId("occ_dtm") as never,
        },
      }),
    ).toMatchObject({
      ok: false,
      error: { code: DOCUMENT_ERROR_CODES.occurrencePlacementInvalid },
    });
    expect(
      addOccurrence(base, {
        name: "Flagged",
        source: { kind: "body", bodyId },
        bomFlag: "kit" as never,
      }),
    ).toMatchObject({
      ok: false,
      error: { code: DOCUMENT_ERROR_CODES.occurrenceBomFlagInvalid },
    });
    const added = addOccurrence(base, {
      name: "Bolt",
      source: { kind: "body", bodyId },
    });
    if (!added.ok) throw new Error("expected add");
    expect(
      removeOccurrence(added.value.document, createOccurrenceId("occ_absent")),
    ).toMatchObject({
      ok: false,
      error: { code: DOCUMENT_ERROR_CODES.notFound },
    });
  });

  it("round-trips occurrences through document serialization and back", () => {
    const { document: base, bodyId } = docWithBody();
    const added = addOccurrence(base, {
      id: createOccurrenceId("occ_bolt"),
      name: "Bolt",
      source: { kind: "body", bodyId },
      placement: { kind: "offset", translation: [1, 2, 3] },
    });
    if (!added.ok) throw new Error("expected add");
    const document = added.value.document;
    const revived = parseCadDocument(
      JSON.parse(JSON.stringify(serializeCadDocument(document))),
    );
    expect(revived.ok).toBe(true);
    if (!revived.ok) return;
    expect(revived.value.occurrences[0]?.source).toEqual({
      kind: "body",
      bodyId,
    });
    expect(revived.value.occurrences[0]?.placement).toEqual({
      kind: "offset",
      translation: [1, 2, 3],
    });
    expect(revived.value.occurrences[0]?.bomFlag).toBeUndefined();
  });

  it("keeps occurrence-free documents byte-identical (additive wire)", () => {
    const base = docWithBody().document;
    const serialized = serializeCadDocument(base);
    expect(serialized).not.toHaveProperty("occurrences");
    expect(serialized.idGenerator).not.toHaveProperty("occurrence");
  });

  it("stamps v4 native documents, parses them back, and migrates v3 identity", () => {
    const base = docWithBody().document;
    const added = addOccurrence(base, {
      name: "Bolt",
      source: { kind: "body", bodyId: firstBodyIdOf(base) },
    });
    if (!added.ok) throw new Error("expected add");
    const native = createNativeCadDocument(added.value.document);
    if (!native.ok) throw new Error("expected native document");
    const text = stringifyNativeCadDocument(
      serializeNativeCadDocument(native.value),
    );
    expect((JSON.parse(text) as { formatVersion: number }).formatVersion).toBe(
      CAD_NATIVE_FORMAT_VERSION,
    );
    const reparsed = parseNativeCadDocumentFromString(text);
    expect(reparsed.ok).toBe(true);
    if (!reparsed.ok) return;
    expect(reparsed.value.document.occurrences).toHaveLength(1);
    // The migration registry carries the v3→v4 identity: a genuine v3
    // envelope (pre-occurrence content) walks forward content-unchanged.
    const v3 = JSON.parse(text) as {
      formatVersion: number;
      document: Record<string, unknown>;
      history: { base: Record<string, unknown> };
    };
    v3.formatVersion = CAD_NATIVE_FORMAT_VERSION - 1;
    delete v3.document.occurrences;
    delete (v3.document.idGenerator as Record<string, unknown>).occurrence;
    delete v3.history.base.occurrences;
    delete (v3.history.base.idGenerator as Record<string, unknown>).occurrence;
    const migrated = parseNativeCadDocumentFromString(JSON.stringify(v3));
    expect(migrated.ok).toBe(true);
    if (!migrated.ok) return;
    expect(migrated.value.document.occurrences).toHaveLength(0);
  });
});
