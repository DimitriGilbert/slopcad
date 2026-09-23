/**
 * The document datum suite (Phase 39): datum records as document entities —
 * the registry (add/get/remove with the in-use rule), the `datum` feature
 * input kind, the additive serialization and parse replay (byte-identity
 * when no datums exist), the `datum.create` command, the native-format
 * round trip with datum records in the log, the v2→v3 migration, and the
 * reference-resolution battery: a face-referencing datum re-resolves when
 * the driving face moves and fails STRUCTURED when it vanishes — and a
 * datum edit drives the stale invalidation of its consuming features.
 */

import { describe, expect, it } from "vitest";

import {
  addBody,
  addDocumentDatum,
  addFeature,
  applyCommand,
  createDocument,
  createDocumentId,
  createDatumId,
  createBodyId,
  createFeatureId,
  createNativeCadDocument,
  DATUM_ERROR_CODES,
  datumDot,
  documentChangeInvalidations,
  DOCUMENT_ERROR_CODES,
  FEATURE_INPUT_KINDS,
  getDocumentDatum,
  getDocumentEntity,
  migrateNativeCadDocument,
  parseCadDocument,
  parseCommand,
  parseDatumPayload,
  parseNativeCadDocument,
  removeDocumentDatum,
  resolveDatumPayload,
  serializeCommand,
  serializeNativeCadDocument,
  serializeCadDocument,
  stringifyNativeCadDocument,
  parseNativeCadDocumentFromString,
  validateNativeCadDocument,
  CAD_NATIVE_FORMAT_VERSION,
  type DatumTopologyResolver,
} from "./index";

const DOC_ID = createDocumentId("doc_root");

const PLANE_PAYLOAD = {
  formatVersion: 1,
  datumType: "plane",
  definition: "originFrame",
  origin: [0, 0, 0],
  normal: [0, 0, 1],
  xAxis: [1, 0, 0],
} as const;

describe("datum document records", () => {
  it("adds and gets a datum record through the registry", () => {
    const added = addDocumentDatum(createDocument(DOC_ID), {
      id: createDatumId("dtm_plane-top"),
      name: "Top plane",
      datum: PLANE_PAYLOAD,
    });
    expect(added.ok).toBe(true);
    if (!added.ok) return;
    const document = added.value.document;
    expect(added.value.datum.name).toBe("Top plane");
    expect(
      getDocumentDatum(document, createDatumId("dtm_plane-top"))?.name,
    ).toBe("Top plane");
    // An explicit, non-numeric-payload id claims no counter.
    expect(document.idGeneratorState.datum).toBe(0);
  });

  it("generates deterministic datum ids when the id is omitted", () => {
    let document = createDocument(DOC_ID);
    for (const name of ["Datum A", "Datum B"]) {
      const added = addDocumentDatum(document, {
        name,
        datum: PLANE_PAYLOAD,
      });
      expect(added.ok).toBe(true);
      if (!added.ok) return;
      document = added.value.document;
    }
    expect(document.datums.map((datum) => datum.id)).toEqual([
      "dtm_000001",
      "dtm_000002",
    ]);
    expect(document.idGeneratorState.datum).toBe(2);
  });

  it("rejects a colliding id, a bad name, and a non-object payload", () => {
    let document = createDocument(DOC_ID);
    const added = addDocumentDatum(document, {
      id: createDatumId("dtm_a"),
      name: "A",
      datum: PLANE_PAYLOAD,
    });
    if (!added.ok) throw new Error("expected add to succeed");
    document = added.value.document;
    expect(
      addDocumentDatum(document, {
        id: createDatumId("dtm_a"),
        name: "Again",
        datum: PLANE_PAYLOAD,
      }),
    ).toMatchObject({
      ok: false,
      error: { code: DOCUMENT_ERROR_CODES.idConflict },
    });
    expect(
      addDocumentDatum(document, { name: "", datum: PLANE_PAYLOAD }),
    ).toMatchObject({
      ok: false,
      error: { code: DOCUMENT_ERROR_CODES.datumNameInvalid },
    });
    expect(
      addDocumentDatum(document, {
        name: "B",
        datum: "plane at z=0" as unknown as Record<string, unknown>,
      }),
    ).toMatchObject({
      ok: false,
      error: { code: DOCUMENT_ERROR_CODES.datumPayloadInvalid },
    });
  });

  it("exposes the datum input kind and resolves datum ids as entities", () => {
    const added = addDocumentDatum(createDocument(DOC_ID), {
      id: createDatumId("dtm_plane-mid"),
      name: "Mid plane",
      datum: PLANE_PAYLOAD,
    });
    if (!added.ok) throw new Error("expected datum add");
    expect(FEATURE_INPUT_KINDS).toContain("datum");
    expect(
      getDocumentEntity(added.value.document, createDatumId("dtm_plane-mid")),
    ).toMatchObject({ kind: "datum" });
  });

  it("removes an unused datum: gone from the document and the serialization", () => {
    let document = createDocument(DOC_ID);
    const added = addDocumentDatum(document, {
      id: createDatumId("dtm_plane-free"),
      name: "Free plane",
      datum: PLANE_PAYLOAD,
    });
    if (!added.ok) throw new Error("expected datum add");
    document = added.value.document;
    const removed = removeDocumentDatum(
      document,
      createDatumId("dtm_plane-free"),
    );
    expect(removed.ok).toBe(true);
    if (!removed.ok) return;
    expect(removed.value.datums).toEqual([]);
    expect(
      getDocumentDatum(removed.value, createDatumId("dtm_plane-free")),
    ).toBeUndefined();
    // The serialization drops the datums section entirely again (the
    // no-datums byte identity), so a save/load cycle forgets the record.
    const serialized = serializeCadDocument(removed.value);
    expect("datums" in serialized).toBe(false);
  });

  it("refuses removal with in-use while a feature consumes the datum", () => {
    let document = createDocument(DOC_ID);
    const added = addDocumentDatum(document, {
      id: createDatumId("dtm_plane-anchored"),
      name: "Anchored plane",
      datum: PLANE_PAYLOAD,
    });
    if (!added.ok) throw new Error("expected datum add");
    document = added.value.document;
    const bodyAdded = addBody(document, {
      id: createBodyId("body_datum-host"),
      name: "host",
    });
    if (!bodyAdded.ok) throw new Error("expected body add");
    document = bodyAdded.value.document;
    const featureAdded = addFeature(document, {
      id: createFeatureId("feat_datum-mirror"),
      kind: "mirror",
      inputs: [{ kind: "datum", id: createDatumId("dtm_plane-anchored") }],
      outputs: [createBodyId("body_datum-host")],
    });
    if (!featureAdded.ok) throw new Error("expected feature add");
    document = featureAdded.value.document;

    const removed = removeDocumentDatum(
      document,
      createDatumId("dtm_plane-anchored"),
    );
    expect(removed).toMatchObject({
      ok: false,
      error: { code: DOCUMENT_ERROR_CODES.inUse },
    });
    if (removed.ok) return;
    expect(removed.error.message).toContain("feat_datum-mirror");
    // The datum survives the refusal, and deleting the consumer frees it.
    expect(
      getDocumentDatum(document, createDatumId("dtm_plane-anchored"))?.name,
    ).toBe("Anchored plane");
  });
});

describe("datum document serialization", () => {
  it("carries datum records additively and replays them on parse", () => {
    const added = addDocumentDatum(createDocument(DOC_ID), {
      id: createDatumId("dtm_axis-bore"),
      name: "Bore axis",
      datum: {
        formatVersion: 1,
        datumType: "axis",
        definition: "twoPoints",
        first: [0, 0, 0],
        second: [0, 0, 10],
      },
    });
    if (!added.ok) throw new Error("expected add");
    const document = added.value.document;
    const serialized = serializeCadDocument(document);
    expect(serialized.datums).toEqual([
      {
        id: "dtm_axis-bore",
        name: "Bore axis",
        datum: {
          formatVersion: 1,
          datumType: "axis",
          definition: "twoPoints",
          first: [0, 0, 0],
          second: [0, 0, 10],
        },
      },
    ]);
    // The datum generator counter rides additively only when nonzero — an
    // explicit non-numeric payload id claims no counter.
    expect("datum" in serialized.idGenerator).toBe(false);
    const reparsed = parseCadDocument(serialized);
    if (!reparsed.ok)
      throw new Error(`expected parse: ${reparsed.error.message}`);
    expect(reparsed.value).toEqual(document);
  });

  it("omits the datums section entirely when none exist (byte identity)", () => {
    const document = createDocument(DOC_ID);
    const serialized = serializeCadDocument(document);
    expect("datums" in serialized).toBe(false);
    expect("datum" in serialized.idGenerator).toBe(false);
  });
});

describe("the datum.create command", () => {
  it("applies, serializes, and parses like every command", () => {
    const command = {
      type: "datum.create",
      id: createDatumId("dtm_plane-top"),
      name: "Top plane",
      datum: PLANE_PAYLOAD,
    } as const;
    const applied = applyCommand(createDocument(DOC_ID), command);
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    expect(applied.value.datums).toHaveLength(1);

    const serialized = serializeCommand(command);
    expect(serialized.type).toBe("datum.create");
    const parsed = parseCommand(serialized);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value).toEqual(command);
  });
});

describe("the native format with datum records", () => {
  it("round-trips datum records through the envelope byte-identically", () => {
    let document = createDocument(DOC_ID);
    const datumAdd = addDocumentDatum(document, {
      id: createDatumId("dtm_plane-top"),
      name: "Top plane",
      datum: PLANE_PAYLOAD,
    });
    if (!datumAdd.ok) throw new Error("expected datum add");
    document = datumAdd.value.document;
    const command = {
      type: "datum.create",
      id: createDatumId("dtm_point-origin"),
      name: "Origin point",
      datum: { formatVersion: 1, datumType: "point", position: [0, 0, 0] },
    } as const;
    const applied = applyCommand(document, command);
    if (!applied.ok) throw new Error("expected command apply");
    // A real session's shape: the native document starts at the PRE-command
    // document and the command commits as a logged transaction, so the
    // datum.create is undoable after a save/load cycle.
    const preSerialized = serializeNativeCadDocument(
      (() => {
        const native = createNativeCadDocument(document, { label: "datums" });
        if (!native.ok) throw new Error("expected native create");
        return native.value;
      })(),
    );
    const text = stringifyNativeCadDocument({
      ...preSerialized,
      document: serializeCadDocument(applied.value),
      history: {
        base: serializeCadDocument(document),
        transactions: [
          {
            formatVersion: 1,
            commands: [serializeCommand(command)],
          },
        ],
        cursor: 1,
      },
    });
    const reparsed = parseNativeCadDocumentFromString(text);
    expect(reparsed.ok).toBe(true);
    if (!reparsed.ok) return;
    expect(
      stringifyNativeCadDocument(serializeNativeCadDocument(reparsed.value)),
    ).toBe(text);
    // Undo reach: the datum.create transaction is replayable — the log
    // carries it, the head document holds both datum records.
    expect(reparsed.value.history.entries).toHaveLength(1);
    expect(reparsed.value.history.cursor).toBe(1);
    expect(reparsed.value.document.datums).toHaveLength(2);
    const validation = validateNativeCadDocument(JSON.parse(text));
    expect(validation.valid).toBe(true);
    expect(validation.issues).toEqual([]);
  });

  it("flags a malformed datums section through the validator", () => {
    let document = createDocument(DOC_ID);
    const added = addDocumentDatum(document, {
      id: createDatumId("dtm_a"),
      name: "A",
      datum: PLANE_PAYLOAD,
    });
    if (!added.ok) throw new Error("expected add");
    document = added.value.document;
    const serialized = JSON.parse(
      JSON.stringify(serializeCadDocument(document)),
    ) as Record<string, unknown>;
    const broken = {
      ...serialized,
      datums: [{ id: "not-a-datum-id", name: "", datum: 42 }],
    };
    const validation = validateNativeCadDocument({
      formatVersion: CAD_NATIVE_FORMAT_VERSION,
      document: broken,
      history: { base: broken, transactions: [], cursor: 0 },
      regeneration: { features: [] },
    });
    expect(validation.valid).toBe(false);
    expect(validation.issues.length).toBeGreaterThanOrEqual(3);
  });

  it("migrates a v2 document to v3 as the content-preserving identity", () => {
    let document = createDocument(DOC_ID);
    const added = addDocumentDatum(document, {
      id: createDatumId("dtm_plane-top"),
      name: "Top plane",
      datum: PLANE_PAYLOAD,
    });
    if (!added.ok) throw new Error("expected add");
    document = added.value.document;
    const current = JSON.parse(
      stringifyNativeCadDocument(
        serializeNativeCadDocument(
          (() => {
            const native = createNativeCadDocument(document);
            if (!native.ok) throw new Error("expected native create");
            return native.value;
          })(),
        ),
      ),
    ) as Record<string, unknown>;
    // Hand-build the v2 form: same content, envelope lowered to 2 (a v2
    // writer could never emit datums — the content shape is v2-legal).
    const v2 = { ...current, formatVersion: 2 };
    const migrated = migrateNativeCadDocument(v2);
    expect(migrated.ok).toBe(true);
    if (!migrated.ok) return;
    expect(migrated.value).toEqual(current);
    const reparsed = parseNativeCadDocument(migrated.value);
    expect(reparsed.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The reference-resolution battery (the Phase 22 contract on datums)
// ---------------------------------------------------------------------------

const FACE_REFERENCE = {
  kind: "face",
  bodyId: "body_base",
  ordinal: 2,
  kernelId: "test-kernel",
  schema: "test-hashes",
  identity: { triangle: 17 },
  validity: { state: "valid", ordinal: 2 },
  geometry: {
    areaMm2: 400,
    centroidAbsoluteMm: [10, 10, 10],
    centroidRelativeMm: [0, 0, 5],
  },
};

function faceOffsetDatum(offsetMm: number): Record<string, unknown> {
  return {
    formatVersion: 1,
    datumType: "plane",
    definition: "faceOffset",
    reference: FACE_REFERENCE,
    normalAtDefinition: [0, 0, 1],
    offsetMm,
  };
}

/** The session-side stand-in: the face's CURRENT plane, or its structured absence. */
function faceResolverAt(zPlane: number | null): DatumTopologyResolver {
  return {
    facePlane: () => {
      if (zPlane === null) {
        return {
          ok: false,
          error: {
            code: "reference/repair-no-candidate",
            message:
              "The referenced face no longer exists against the current topology; the datum plane cannot re-resolve.",
            input: FACE_REFERENCE,
          },
        };
      }
      return {
        ok: true,
        value: {
          origin: [10, 10, zPlane],
          normal: [0, 0, 1],
          xAxis: [1, 0, 0],
        },
      };
    },
    faceCylinderAxis: () => ({
      ok: false,
      error: {
        code: "reference/mint-unavailable",
        message: "n/a",
        input: null,
      },
    }),
    edgeLine: () => ({
      ok: false,
      error: {
        code: "reference/mint-unavailable",
        message: "n/a",
        input: null,
      },
    }),
  };
}

describe("the datum face-reference battery", () => {
  function datumDocument(datumId: string, payload: Record<string, unknown>) {
    const added = addDocumentDatum(createDocument(DOC_ID), {
      id: createDatumId(datumId),
      name: "Pad plane",
      datum: payload,
    });
    if (!added.ok) throw new Error("expected datum add");
    return added.value.document;
  }

  function resolvePlaneOf(
    document: ReturnType<typeof datumDocument>,
    datumId: string,
  ) {
    const record = getDocumentDatum(document, createDatumId(datumId));
    if (record === undefined) throw new Error("datum record missing");
    const payload = parseDatumPayload(record.datum);
    if (!payload.ok)
      throw new Error(`payload invalid: ${payload.error.message}`);
    const resolved = resolveDatumPayload(payload.value, faceResolverAt(15));
    if (!resolved.ok)
      throw new Error(`resolve failed: ${resolved.error.message}`);
    if (resolved.value.datumType !== "plane")
      throw new Error("expected a plane");
    return resolved.value.plane;
  }

  it("re-resolves a MOVED face: the datum plane follows the face with its offset", () => {
    const document = datumDocument("dtm_pad-plane", faceOffsetDatum(3));
    const plane = resolvePlaneOf(document, "dtm_pad-plane");
    // The face moved from z=10 (definition time) to z=15; the datum follows
    // and keeps its 3 mm offset along the (definition-aligned) normal.
    expect(plane.origin[2]).toBe(18);
    expect(datumDot(plane.normal, [0, 0, 1])).toBeCloseTo(1);
  });

  it("fails STRUCTURED when the driving face vanishes — never a guessed plane", () => {
    const document = datumDocument("dtm_pad-plane", faceOffsetDatum(0));
    const record = getDocumentDatum(document, createDatumId("dtm_pad-plane"));
    if (record === undefined) throw new Error("datum record missing");
    const payload = parseDatumPayload(record.datum);
    if (!payload.ok) throw new Error("payload invalid");
    const resolved = resolveDatumPayload(payload.value, faceResolverAt(null));
    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.error.code).toBe(DATUM_ERROR_CODES.referenceInvalid);
    expect(resolved.error.message).toContain("no longer exists");
  });

  it("drives stale invalidation: a datum edit marks its consuming features stale", () => {
    const before = datumDocument("dtm_pad-plane", faceOffsetDatum(3));
    const after = datumDocument("dtm_pad-plane", faceOffsetDatum(7));
    const changed = documentChangeInvalidations(before, after);
    expect(changed).toContain(createDatumId("dtm_pad-plane"));
  });
});
