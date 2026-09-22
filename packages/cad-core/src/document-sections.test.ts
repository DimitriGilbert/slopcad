/**
 * Section display record tests (Phase 46): the additive document
 * collection — add/order/limit, the display toggle, and the canonical
 * serialization's additive law (absent when empty, so pre-section
 * documents round-trip byte-identically; present records round-trip
 * exactly).
 */

import { describe, expect, it } from "vitest";

import {
  addDocumentSection,
  createDocument,
  createDocumentId,
  createSectionId,
  DOCUMENT_SECTION_LIMIT,
  getDocumentSection,
  parseCadDocument,
  serializeCadDocument,
  setDocumentSectionEnabled,
} from "./index";

const MID_PLANE = {
  name: "mid-height",
  origin: [0, 0, 5] as const,
  normal: [0, 0, 1] as const,
  keepSide: 1 as const,
  enabled: false,
};

describe("document section display records (Phase 46)", () => {
  it("adds a record with an explicit id and reads it back", () => {
    const document = createDocument(createDocumentId("doc_sections"));
    const id = createSectionId("sec_mid");
    const added = addDocumentSection(document, { id, ...MID_PLANE });
    expect(added.ok).toBe(true);
    if (!added.ok) return;
    const record = getDocumentSection(added.value.document, id);
    expect(record?.name).toBe("mid-height");
    expect(record?.enabled).toBe(false);
    expect(record?.origin).toEqual([0, 0, 5]);
  });

  it("enforces the record budget with a structured refusal", () => {
    let document = createDocument(createDocumentId("doc_sections_limit"));
    for (let index = 0; index < DOCUMENT_SECTION_LIMIT; index += 1) {
      const added = addDocumentSection(document, {
        name: `section-${String(index)}`,
        origin: [0, 0, index + 1],
        normal: [0, 0, 1],
        keepSide: 1,
        enabled: false,
      });
      expect(added.ok).toBe(true);
      if (added.ok) document = added.value.document;
    }
    const refused = addDocumentSection(document, {
      name: "one-too-many",
      origin: [0, 0, 0],
      normal: [0, 0, 1],
      keepSide: 1,
      enabled: false,
    });
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.error.code).toBe("document/section-limit-exceeded");
    }
  });

  it("refuses a zero normal and a malformed name structurally", () => {
    const document = createDocument(createDocumentId("doc_sections_bad"));
    const zeroNormal = addDocumentSection(document, {
      name: "bad-plane",
      origin: [0, 0, 0],
      normal: [0, 0, 0],
      keepSide: 1,
      enabled: false,
    });
    expect(zeroNormal.ok).toBe(false);
    const badName = addDocumentSection(document, {
      name: "",
      origin: [0, 0, 0],
      normal: [0, 0, 1],
      keepSide: 1,
      enabled: false,
    });
    expect(badName.ok).toBe(false);
  });

  it("flips the display toggle without losing the record", () => {
    let document = createDocument(createDocumentId("doc_sections_toggle"));
    const added = addDocumentSection(document, { ...MID_PLANE });
    expect(added.ok).toBe(true);
    if (!added.ok) return;
    document = added.value.document;
    const id = added.value.section.id;
    const flipped = setDocumentSectionEnabled(document, id, true);
    expect(flipped.ok).toBe(true);
    if (flipped.ok) {
      expect(getDocumentSection(flipped.value, id)?.enabled).toBe(true);
      expect(flipped.value.sections.length).toBe(1);
    }
    const missing = setDocumentSectionEnabled(
      document,
      createSectionId("sec_none"),
      true,
    );
    expect(missing.ok).toBe(false);
  });

  it("serializes additively and round-trips exactly", () => {
    const empty = createDocument(createDocumentId("doc_sections_ser"));
    const emptyForm = serializeCadDocument(empty);
    expect("sections" in emptyForm).toBe(false);
    const added = addDocumentSection(empty, { ...MID_PLANE, enabled: true });
    expect(added.ok).toBe(true);
    if (!added.ok) return;
    const withSection = serializeCadDocument(added.value.document);
    expect("sections" in withSection).toBe(true);
    const parsed = parseCadDocument(JSON.parse(JSON.stringify(withSection)));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value.sections.length).toBe(1);
      expect(parsed.value.sections[0]?.enabled).toBe(true);
      expect(parsed.value.sections[0]?.name).toBe("mid-height");
    }
  });
});
