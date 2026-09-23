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
  applyCommand,
  createBodyId,
  createDocument,
  createDocumentId,
  createFeatureId,
  parseCadDocument,
  serializeCadDocument,
  updateBody,
  APPEARANCE_LIBRARY,
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

describe("the sheet kind survives body.update (Phase 59 regression pins)", () => {
  // The pre-59 drop class: `updateBody` REBUILDS the body record from the
  // update's carried fields, so a rebuild that forgets the record-identity
  // `kind` would silently convert every sheet body to a solid on the first
  // rename or appearance edit. These pins go red mechanically if the kind
  // spread ever drops from the rebuild.
  function documentWithSheet(): {
    document: ReturnType<typeof createDocument>;
    sheetId: ReturnType<typeof createBodyId>;
    solidId: ReturnType<typeof createBodyId>;
  } {
    let document = createDocument(createDocumentId("doc_sheet_updates"));
    const sheet = addBody(document, {
      id: createBodyId("body_sheet_update"),
      name: "wall",
      kind: "sheet",
    });
    if (!sheet.ok) throw new Error(sheet.error.message);
    document = sheet.value.document;
    const solid = addBody(document, {
      id: createBodyId("body_solid_update"),
      name: "block",
    });
    if (!solid.ok) throw new Error(solid.error.message);
    document = solid.value.document;
    return {
      document,
      sheetId: sheet.value.body.id,
      solidId: solid.value.body.id,
    };
  }

  it("keeps the sheet kind through a rename (direct call and the body.update command)", () => {
    const { document, sheetId, solidId } = documentWithSheet();
    const renamed = updateBody(document, sheetId, { name: "bulkhead" });
    expect(renamed.ok).toBe(true);
    if (!renamed.ok) return;
    expect(renamed.value.bodies.find((body) => body.id === sheetId)?.kind).toBe(
      "sheet",
    );
    // The unrelated solid stays solid — the kind never smuggles across.
    expect(
      renamed.value.bodies.find((body) => body.id === solidId)?.kind,
    ).toBeUndefined();
    // The same through the command surface (body.update rides updateBody).
    const viaCommand = applyCommand(renamed.value, {
      type: "body.update",
      id: sheetId,
      name: "skin",
    });
    expect(viaCommand.ok).toBe(true);
    if (!viaCommand.ok) return;
    expect(
      viaCommand.value.bodies.find((body) => body.id === sheetId)?.kind,
    ).toBe("sheet");
  });

  it("keeps the sheet kind through appearance assignment and clearing", () => {
    const { document, sheetId } = documentWithSheet();
    const painted = updateBody(document, sheetId, {
      appearance: { ...APPEARANCE_LIBRARY[1]!.appearance },
      faceAppearances: [
        { face: 0, appearance: { ...APPEARANCE_LIBRARY[0]!.appearance } },
      ],
    });
    expect(painted.ok).toBe(true);
    if (!painted.ok) return;
    const paintedBody = painted.value.bodies.find(
      (body) => body.id === sheetId,
    );
    expect(paintedBody?.kind).toBe("sheet");
    expect(paintedBody?.appearance).toEqual(APPEARANCE_LIBRARY[1]!.appearance);
    const cleared = updateBody(painted.value, sheetId, {
      appearance: null,
      faceAppearances: null,
    });
    expect(cleared.ok).toBe(true);
    if (!cleared.ok) return;
    const clearedBody = cleared.value.bodies.find(
      (body) => body.id === sheetId,
    );
    expect(clearedBody?.kind).toBe("sheet");
    expect(clearedBody?.appearance).toBeUndefined();
    expect(clearedBody?.faceAppearances).toBeUndefined();
  });

  it("renames an updated sheet body and the kind still rides the native serialization", () => {
    const { document, sheetId, solidId } = documentWithSheet();
    const updated = updateBody(document, sheetId, {
      name: "panel",
      appearance: { ...APPEARANCE_LIBRARY[2]!.appearance },
    });
    expect(updated.ok).toBe(true);
    if (!updated.ok) return;
    const serialized = serializeCadDocument(updated.value);
    expect(serialized.bodies.find((body) => body.id === sheetId)?.kind).toBe(
      "sheet",
    );
    expect(
      serialized.bodies.find((body) => body.id === solidId)?.kind,
    ).toBeUndefined();
  });
});
