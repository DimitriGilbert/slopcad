/**
 * The session datum resolver's tests (Phase 39): the analytic extrude-cap
 * resolution (the sketch-on-face anchor), the moved-face re-derivation
 * (the depth edit moves the datum plane — geometry follows), the
 * structured invalidity when the driving feature vanishes, the pad
 * composition scene request, and the scene face pick of a synthetic
 * selection reference.
 */

import { describe, expect, it } from "vitest";
import {
  addBody,
  addDocumentDatum,
  addDocumentParameter,
  addFeature,
  applyCommand,
  createBodyId,
  createDatumId,
  createDocument,
  createDocumentId,
  createFeatureId,
  createParameterId,
  createSketchDocumentId,
  length,
  type CadDocument,
} from "@slopcad/cad-core";
import {
  createLineEntity,
  createSketch,
  createSketchEntityId,
  serializeSketch as serializeSketchDomain,
} from "@slopcad/cad-sketch";

import { documentPadSceneRequest } from "./extrude";
import { resolveSessionDatumPlane } from "./datum";

const skdId = createSketchDocumentId("skd_base");
const pDepth = createParameterId("param_base_depth");
const bBase = createBodyId("body_base");
const fBase = createFeatureId("feat_base");
const dtmFace = createDatumId("dtm_face");

/** A 20x15 rectangle sketch (four lines) on the given plane origin (mm). */
function rectangleSketch(originZ = 0) {
  const created = createSketch(
    {
      origin: { x: 0, y: 0, z: originZ },
      normal: { x: 0, y: 0, z: 1 },
      xAxis: { x: 1, y: 0, z: 0 },
    },
    [
      createLineEntity(
        createSketchEntityId("skent_l1"),
        { x: 0, y: 0 },
        { x: 20, y: 0 },
      ),
      createLineEntity(
        createSketchEntityId("skent_l2"),
        { x: 20, y: 0 },
        { x: 20, y: 15 },
      ),
      createLineEntity(
        createSketchEntityId("skent_l3"),
        { x: 20, y: 15 },
        { x: 0, y: 15 },
      ),
      createLineEntity(
        createSketchEntityId("skent_l4"),
        { x: 0, y: 15 },
        { x: 0, y: 0 },
      ),
    ],
    [],
  );
  if (!created.ok) throw new Error(created.error.message);
  return created.value;
}

function sketchPayload(originZ = 0): Record<string, unknown> {
  return serializeSketchDomain(rectangleSketch(originZ)) as unknown as Record<
    string,
    unknown
  >;
}

function faceDatumPayload(depth: number): Record<string, unknown> {
  return {
    formatVersion: 1,
    datumType: "plane",
    definition: "faceOffset",
    reference: {
      kind: "sessionFace",
      bodyId: bBase,
      faceNormal: [0, 0, depth > 0 ? 1 : -1],
    },
    normalAtDefinition: [0, 0, 1],
    offsetMm: 0,
  };
}

/** The base document: one 20x15 rectangle extruded `depth` mm along +z. */
function baseDocument(depth: number): CadDocument {
  let document = createDocument(createDocumentId("doc_session_datum"));
  const addedSketch = (() => {
    const command = {
      type: "sketch.create",
      id: skdId,
      name: "base sketch",
      sketch: sketchPayload(),
    } as const;
    const applied = applyCommand(document, command);
    if (!applied.ok) throw new Error(applied.error.message);
    return applied.value;
  })();
  document = addedSketch;
  for (const [id, name, value] of [
    [pDepth, "baseDepth", length(depth)],
  ] as const) {
    const added = addDocumentParameter(document, { id, name, value });
    if (!added.ok) throw new Error(added.error.message);
    document = added.value.document;
  }
  for (const body of [{ id: bBase, name: "base" }]) {
    const added = addBody(document, body);
    if (!added.ok) throw new Error(added.error.message);
    document = added.value.document;
  }
  const withFeature = addFeature(document, {
    id: fBase,
    kind: "extrude",
    inputs: [
      { kind: "sketch", id: skdId },
      { kind: "parameter", id: pDepth },
    ],
    outputs: [bBase],
  });
  if (!withFeature.ok) throw new Error(withFeature.error.message);
  return withFeature.value.document;
}

describe("the session datum resolver", () => {
  it("resolves a face-anchored datum to the extrude's front cap", () => {
    let document = baseDocument(10);
    const added = addDocumentDatum(document, {
      id: dtmFace,
      name: "face plane",
      datum: faceDatumPayload(10),
    });
    if (!added.ok) throw new Error(added.error.message);
    document = added.value.document;
    const plane = resolveSessionDatumPlane(document, dtmFace);
    expect(plane.ok).toBe(true);
    if (!plane.ok) return;
    expect(plane.origin).toEqual([0, 0, 10]);
    expect(plane.normal[0]).toBeCloseTo(0);
    expect(plane.normal[1]).toBeCloseTo(0);
    expect(plane.normal[2]).toBeCloseTo(1);
  });

  it("RE-RESOLVES the moved face: the datum follows the depth edit", () => {
    let document = baseDocument(10);
    const added = addDocumentDatum(document, {
      id: dtmFace,
      name: "face plane",
      datum: faceDatumPayload(10),
    });
    if (!added.ok) throw new Error(added.error.message);
    document = added.value.document;
    expect(resolveSessionDatumPlane(document, dtmFace)).toMatchObject({
      ok: true,
      origin: [0, 0, 10],
    });
    // The driving-face edit: the base depth parameter moves 10 → 15, and
    // the datum plane follows the face to the new height.
    const edited = applyCommand(document, {
      type: "parameter.set",
      id: pDepth,
      value: length(15),
    });
    if (!edited.ok) throw new Error(edited.error.message);
    const moved = resolveSessionDatumPlane(edited.value, dtmFace);
    expect(moved.ok).toBe(true);
    if (!moved.ok) return;
    expect(moved.origin).toEqual([0, 0, 15]);
  });

  it("fails STRUCTURED when the driving feature vanishes", () => {
    let document = baseDocument(10);
    const added = addDocumentDatum(document, {
      id: dtmFace,
      name: "face plane",
      datum: faceDatumPayload(10),
    });
    if (!added.ok) throw new Error(added.error.message);
    document = added.value.document;
    // The base extrude is deleted (an undo would do the same): the datum
    // record remains, but its reference no longer resolves — the failure
    // is structured, never a guessed plane.
    const deleted = applyCommand(document, {
      type: "feature.delete",
      id: fBase,
    });
    if (!deleted.ok) throw new Error(deleted.error.message);
    const failed = resolveSessionDatumPlane(deleted.value, dtmFace);
    expect(failed.ok).toBe(false);
    if (failed.ok) return;
    // cad-core's datum layer wraps the seam's refusal as
    // `datum/reference-invalid`, carrying the session's structured reason
    // (no resolvable extrude faces) in the message — the invalidity is
    // named, never a guessed plane.
    expect(failed.error.code).toBe("datum/reference-invalid");
    expect(failed.error.message).toContain("no resolvable extrude faces");
  });

  it("resolves the pad scene composition for a datum-anchored second extrude", () => {
    let document = baseDocument(10);
    const datumAdd = addDocumentDatum(document, {
      id: dtmFace,
      name: "face plane",
      datum: faceDatumPayload(10),
    });
    if (!datumAdd.ok) throw new Error(datumAdd.error.message);
    document = datumAdd.value.document;
    const skdPad = createSketchDocumentId("skd_pad");
    const pPadDepth = createParameterId("param_pad_depth");
    const bPad = createBodyId("body_pad");
    const fPad = createFeatureId("feat_pad");
    const padSketch = (() => {
      const applied = applyCommand(document, {
        type: "sketch.create",
        id: skdPad,
        name: "pad sketch",
        sketch: sketchPayload(10),
      });
      if (!applied.ok) throw new Error(applied.error.message);
      return applied.value;
    })();
    document = padSketch;
    for (const [id, name, value] of [
      [pPadDepth, "padDepth", length(8)],
    ] as const) {
      const added = addDocumentParameter(document, { id, name, value });
      if (!added.ok) throw new Error(added.error.message);
      document = added.value.document;
    }
    const bodyAdd = addBody(document, { id: bPad, name: "pad" });
    if (!bodyAdd.ok) throw new Error(bodyAdd.error.message);
    document = bodyAdd.value.document;
    const padAdd = addFeature(document, {
      id: fPad,
      kind: "extrude",
      inputs: [
        { kind: "sketch", id: skdPad },
        { kind: "parameter", id: pPadDepth },
        { kind: "datum", id: dtmFace },
      ],
      outputs: [bPad],
    });
    if (!padAdd.ok) throw new Error(padAdd.error.message);
    document = padAdd.value.document;

    // The composition: base request from the sketch's own plane, pad
    // request OVERRIDDEN to the datum's re-resolved frame (z = 10).
    const composition = documentPadSceneRequest(document);
    expect(composition).not.toBeNull();
    if (composition === null) return;
    expect(composition.bodyId).toBe(bPad);
    expect(composition.base.distanceMm).toBe(10);
    expect(composition.pad.distanceMm).toBe(8);
    const padZ = composition.pad.placement.translation.z.value;
    expect(padZ).toBeCloseTo(10, 9);
    // The moved face: depth 10 → 15 moves the pad placement with it.
    const edited = applyCommand(document, {
      type: "parameter.set",
      id: pDepth,
      value: length(15),
    });
    if (!edited.ok) throw new Error(edited.error.message);
    const moved = documentPadSceneRequest(edited.value);
    expect(moved).not.toBeNull();
    if (moved === null) return;
    const movedZ = moved.pad.placement.translation.z.value;
    expect(movedZ).toBeCloseTo(15, 9);
  });

  it("declines the composition when the pad is not datum-anchored", () => {
    const document = baseDocument(10);
    expect(documentPadSceneRequest(document)).toBeNull();
  });
});
