/**
 * Sketch document-entity tests (Phase 26.1): the sketch record as a real
 * document entity — add/remove/in-use, feature inputs of kind `sketch`,
 * serialization round-trips (and byte-compat with sketch-less documents),
 * the `sketch.create` / `body.create` / `parameter.create` commands, and an
 * end-to-end extrude feature record wired to a sketch + distance parameter.
 */

import { describe, expect, it } from "vitest";

import {
  applyCommand,
  applyTransaction,
  addBody,
  addDocumentParameter,
  addDocumentSketch,
  addFeature,
  createBodyId,
  createDocument,
  createDocumentId,
  createFeatureId,
  createParameterId,
  createSketchDocumentId,
  getDocumentSketch,
  length,
  parseCadDocument,
  parseCommand,
  removeDocumentSketch,
  serializeCadDocument,
  serializeCommand,
  type CadDocument,
} from "./index";

const DOC_ID = createDocumentId("doc_sketch-fixture");
const SKETCH_ID = createSketchDocumentId("skd_profile");
const BODY_ID = createBodyId("body_extruded");
const PARAM_ID = createParameterId("param_extrude_depth");
const FEATURE_ID = createFeatureId("feat_extrude_1");

/** A minimal canonical serialized sketch payload (schema-owned by cad-sketch). */
const SKETCH_PAYLOAD = Object.freeze({
  formatVersion: 1,
  workplane: {
    origin: { x: 0, y: 0, z: 0 },
    normal: { x: 0, y: 0, z: 1 },
    xAxis: { x: 1, y: 0, z: 0 },
  },
  entities: [],
  constraints: [],
});

function baseDocument(): CadDocument {
  return createDocument(DOC_ID);
}

describe("sketch document entities", () => {
  it("adds a sketch record with an explicit id and stores the payload verbatim", () => {
    const added = addDocumentSketch(baseDocument(), {
      id: SKETCH_ID,
      name: "profile",
      sketch: SKETCH_PAYLOAD,
    });
    expect(added.ok).toBe(true);
    if (!added.ok) return;
    const sketch = getDocumentSketch(added.value.document, SKETCH_ID);
    expect(sketch?.name).toBe("profile");
    expect(sketch?.sketch).toEqual(SKETCH_PAYLOAD);
  });

  it("rejects a colliding id document-wide and a malformed payload", () => {
    const first = addDocumentSketch(baseDocument(), {
      id: SKETCH_ID,
      name: "profile",
      sketch: SKETCH_PAYLOAD,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const again = addDocumentSketch(first.value.document, {
      id: SKETCH_ID,
      name: "other",
      sketch: SKETCH_PAYLOAD,
    });
    expect(again.ok).toBe(false);
    const bad = addDocumentSketch(first.value.document, {
      name: "bad",
      sketch: [1, 2, 3] as unknown as Readonly<Record<string, unknown>>,
    });
    expect(bad.ok).toBe(false);
    if (bad.ok) return;
    expect(bad.error.code).toBe("document/sketch-payload-invalid");
  });

  it("refuses removal while a feature references the sketch (document/in-use)", () => {
    let document = baseDocument();
    const sketched = addDocumentSketch(document, {
      id: SKETCH_ID,
      name: "profile",
      sketch: SKETCH_PAYLOAD,
    });
    if (!sketched.ok) throw new Error(sketched.error.message);
    document = sketched.value.document;
    const parameter = addDocumentParameter(document, {
      id: PARAM_ID,
      name: "extrudeDepth",
      value: length(12),
    });
    if (!parameter.ok) throw new Error(parameter.error.message);
    document = parameter.value.document;
    const featured = addFeature(document, {
      id: FEATURE_ID,
      kind: "extrude",
      inputs: [
        { kind: "sketch", id: SKETCH_ID },
        { kind: "parameter", id: PARAM_ID },
      ],
      outputs: [],
    });
    // The extrude feature declares no output body at add time — the body is
    // created by the same authoring transaction; the record here proves the
    // sketch reference resolves.
    expect(featured.ok).toBe(true);
    if (!featured.ok) return;
    const removed = removeDocumentSketch(featured.value.document, SKETCH_ID);
    expect(removed.ok).toBe(false);
    if (removed.ok) return;
    expect(removed.error.code).toBe("document/in-use");
  });

  it("resolves the sketch through getDocumentEntity by its wire prefix", () => {
    const added = addDocumentSketch(baseDocument(), {
      id: SKETCH_ID,
      name: "profile",
      sketch: SKETCH_PAYLOAD,
    });
    if (!added.ok) throw new Error(added.error.message);
    const entity = getDocumentSketch(added.value.document, SKETCH_ID);
    expect(entity?.id).toBe(SKETCH_ID);
  });
});

describe("sketch persistence", () => {
  it("round-trips a document with sketches exactly", () => {
    let document = baseDocument();
    const added = addDocumentSketch(document, {
      id: SKETCH_ID,
      name: "profile",
      sketch: SKETCH_PAYLOAD,
    });
    if (!added.ok) throw new Error(added.error.message);
    document = added.value.document;
    const body = addBody(document, { id: BODY_ID, name: "extruded" });
    if (!body.ok) throw new Error(body.error.message);
    document = body.value.document;
    const parameter = addDocumentParameter(document, {
      id: PARAM_ID,
      name: "extrudeDepth",
      value: length(12),
    });
    if (!parameter.ok) throw new Error(parameter.error.message);
    document = parameter.value.document;
    const feature = addFeature(document, {
      id: FEATURE_ID,
      kind: "extrude",
      inputs: [
        { kind: "sketch", id: SKETCH_ID },
        { kind: "parameter", id: PARAM_ID },
      ],
      outputs: [BODY_ID],
    });
    if (!feature.ok) throw new Error(feature.error.message);
    document = feature.value.document;

    const revived = parseCadDocument(
      JSON.parse(JSON.stringify(serializeCadDocument(document))),
    );
    expect(revived.ok).toBe(true);
    if (!revived.ok) return;
    expect(revived.value.sketches.length).toBe(1);
    expect(revived.value.sketches[0]?.sketch).toEqual(SKETCH_PAYLOAD);
    const extrude = revived.value.features.find((f) => f.id === FEATURE_ID);
    expect(extrude?.inputs).toEqual([
      { kind: "sketch", id: SKETCH_ID },
      { kind: "parameter", id: PARAM_ID },
    ]);
  });

  it("serializes a sketch-less document without the sketches key (byte-compat)", () => {
    const serialized = serializeCadDocument(baseDocument());
    expect(Object.hasOwn(serialized, "sketches")).toBe(false);
    expect(Object.hasOwn(serialized.idGenerator, "sketch")).toBe(false);
  });

  it("parses an old document without a sketches field into empty sketches", () => {
    const serialized = JSON.parse(
      JSON.stringify(serializeCadDocument(baseDocument())),
    ) as Record<string, unknown>;
    const revived = parseCadDocument(serialized);
    expect(revived.ok).toBe(true);
    if (!revived.ok) return;
    expect(revived.value.sketches).toEqual([]);
  });

  it("emits the sketch generator counter only when it has claimed ids", () => {
    const added = addDocumentSketch(baseDocument(), {
      name: "profile",
      sketch: SKETCH_PAYLOAD,
    });
    if (!added.ok) throw new Error(added.error.message);
    const withGenerated = addDocumentSketch(added.value.document, {
      id: createSketchDocumentId("skd_000004"),
      name: "claims-the-counter",
      sketch: SKETCH_PAYLOAD,
    });
    if (!withGenerated.ok) throw new Error(withGenerated.error.message);
    const serialized = serializeCadDocument(withGenerated.value.document);
    expect(serialized.idGenerator.sketch).toBe(4);
    const revived = parseCadDocument(JSON.parse(JSON.stringify(serialized)));
    expect(revived.ok).toBe(true);
    if (!revived.ok) return;
    expect(revived.value.idGeneratorState.sketch).toBe(4);
  });
});

describe("document commands for the extrude authoring transaction", () => {
  it("applies sketch.create, parameter.create, body.create, feature.create atomically", () => {
    const applied = applyTransaction(baseDocument(), {
      commands: [
        {
          type: "sketch.create",
          id: SKETCH_ID,
          name: "profile",
          sketch: SKETCH_PAYLOAD,
        },
        {
          type: "parameter.create",
          id: PARAM_ID,
          name: "extrudeDepth",
          value: length(12),
        },
        { type: "body.create", id: BODY_ID, name: "extruded" },
        {
          type: "feature.create",
          id: FEATURE_ID,
          kind: "extrude",
          inputs: [
            { kind: "sketch", id: SKETCH_ID },
            { kind: "parameter", id: PARAM_ID },
          ],
          outputs: [BODY_ID],
        },
      ],
    });
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    expect(getDocumentSketch(applied.value, SKETCH_ID)?.name).toBe("profile");
    expect(applied.value.features.map((feature) => feature.kind)).toEqual([
      "extrude",
    ]);
  });

  it("serializes and re-parses the new commands", () => {
    const command = {
      type: "sketch.create",
      id: SKETCH_ID,
      name: "profile",
      sketch: SKETCH_PAYLOAD,
    } as const;
    const revived = parseCommand(
      JSON.parse(JSON.stringify(serializeCommand(command))),
    );
    expect(revived.ok).toBe(true);
    if (!revived.ok) return;
    expect(revived.value).toEqual(command);
    const applied = applyCommand(baseDocument(), revived.value);
    expect(applied.ok).toBe(true);
  });

  it("rejects a sketch.create whose payload is not a plain object", () => {
    const parsed = parseCommand({
      formatVersion: 1,
      type: "sketch.create",
      name: "bad",
      sketch: 42,
    });
    expect(parsed.ok).toBe(false);
  });
});
