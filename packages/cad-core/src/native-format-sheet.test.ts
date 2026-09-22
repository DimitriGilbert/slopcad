/**
 * Phase 48 native-format round-trip with SHEET bodies: the document's
 * additive `kind: "sheet"` body field persists through the native
 * envelope's substrate verbatim — a sheet-body document serializes,
 * parses, and re-serializes to identical bytes, a solid-only document
 * stays byte-identical to its pre-flag form (the additive-collection
 * precedent the migration decision documents), and an unknown kind value
 * fails structurally instead of loading as a silent solid.
 */

import { describe, expect, it } from "vitest";

import {
  addBody,
  addFeature,
  createBodyId,
  createDocument,
  createDocumentId,
  createFeatureId,
  parseCadDocument,
  serializeCadDocument,
} from "./index";

describe("native format sheet bodies (Phase 48)", () => {
  it("round-trips a sheet body's kind through serialize and parse", () => {
    let document = createDocument(createDocumentId("doc_sheet"));
    const sheetBody = addBody(document, {
      id: createBodyId("body_wall"),
      name: "wall",
      kind: "sheet",
    });
    if (!sheetBody.ok) throw new Error(sheetBody.error.message);
    document = sheetBody.value.document;
    const solidBody = addBody(document, {
      id: createBodyId("body_block"),
      name: "block",
    });
    if (!solidBody.ok) throw new Error(solidBody.error.message);
    document = solidBody.value.document;
    const feature = addFeature(document, {
      id: createFeatureId("feat_wall"),
      kind: "extrude-surface",
      inputs: [],
      outputs: [createBodyId("body_wall")],
    });
    if (!feature.ok) throw new Error(feature.error.message);
    document = feature.value.document;

    const serialized = serializeCadDocument(document);
    const wire = JSON.parse(JSON.stringify(serialized)) as {
      bodies: Array<{ id: string; kind?: string }>;
    };
    expect(wire.bodies[0]?.kind).toBe("sheet");
    expect(wire.bodies[1]?.kind).toBeUndefined();
    const parsed = parseCadDocument(wire);
    if (!parsed.ok) throw new Error(parsed.error.message);
    expect(parsed.value.bodies[0]?.kind).toBe("sheet");
    expect(parsed.value.bodies[1]?.kind).toBeUndefined();
    // Byte-determinism: the re-serialization is identical.
    expect(JSON.stringify(serializeCadDocument(parsed.value))).toBe(
      JSON.stringify(serialized),
    );
  });

  it("keeps a solid-only document byte-identical (the field never rides)", () => {
    const document = createDocument(createDocumentId("doc_solid_only"));
    const body = addBody(document, { name: "block" });
    if (!body.ok) throw new Error(body.error.message);
    const serialized = serializeCadDocument(body.value.document);
    const wire = JSON.stringify(serialized);
    expect(wire).not.toContain('"kind"');
  });

  it("rejects an unknown body kind structurally", () => {
    const document = createDocument(createDocumentId("doc_bad_kind"));
    const body = addBody(document, { name: "block" });
    if (!body.ok) throw new Error(body.error.message);
    const serialized = JSON.parse(
      JSON.stringify(serializeCadDocument(body.value.document)),
    ) as { bodies: Array<Record<string, unknown>> };
    serialized.bodies[0]!.kind = "wire";
    const parsed = parseCadDocument(serialized);
    expect(parsed.ok).toBe(false);
  });
});
