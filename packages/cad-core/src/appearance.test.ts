/**
 * Phase 59 appearance unit coverage: the record's validation gate, the
 * library's shape, the document round-trip (body records ride appearance
 * additively — a recordless document serializes byte-identically to its
 * pre-appearance form), and the projection resolver's identity fast path.
 */

import { describe, expect, it } from "vitest";

import {
  APPEARANCE_ERROR_CODES,
  APPEARANCE_LIBRARY,
  type Appearance,
  BODY_FACE_APPEARANCE_LIMIT,
  createDocumentId,
  createDocument,
  createRenderObjectId,
  createBodyId,
  addBody,
  parseAppearance,
  parseCadDocument,
  projectTessellation,
  serializeAppearance,
  serializeCadDocument,
  updateBody,
  withBodyAppearances,
  type RenderProjection,
} from "./index";
import { createRenderProjection } from "./projection";

const STEEL_ENTRY = APPEARANCE_LIBRARY[0];
if (STEEL_ENTRY === undefined) throw new Error("the library is never empty");
const BRASS_ENTRY = APPEARANCE_LIBRARY[1];
if (BRASS_ENTRY === undefined) throw new Error("the library is never empty");
const STEEL: Appearance = STEEL_ENTRY.appearance;

describe("parseAppearance", () => {
  it("accepts a valid record and freezes it", () => {
    const parsed = parseAppearance({
      baseColor: "#aabdd6",
      metalness: 0.5,
      roughness: 0.25,
    });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value).toEqual({
        baseColor: "#aabdd6",
        metalness: 0.5,
        roughness: 0.25,
      });
      expect(Object.isFrozen(parsed.value)).toBe(true);
    }
  });

  it("accepts a known procedural texture name", () => {
    const parsed = parseAppearance({
      baseColor: "#2a2d33",
      metalness: 0.2,
      roughness: 0.6,
      texture: "checker",
    });
    expect(parsed.ok).toBe(true);
  });

  it("refuses a non-hex base color with the color code", () => {
    const parsed = parseAppearance({
      baseColor: "red",
      metalness: 0,
      roughness: 0,
    });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.error.code).toBe(APPEARANCE_ERROR_CODES.colorInvalid);
    }
  });

  it("refuses out-of-range scalars and unknown textures", () => {
    const rough = parseAppearance({
      baseColor: "#aabdd6",
      metalness: 0,
      roughness: 1.5,
    });
    expect(rough.ok).toBe(false);
    const texture = parseAppearance({
      baseColor: "#aabdd6",
      metalness: 0,
      roughness: 0,
      texture: "wood.png",
    });
    expect(texture.ok).toBe(false);
    if (!texture.ok) {
      expect(texture.error.code).toBe(APPEARANCE_ERROR_CODES.textureUnknown);
    }
  });

  it("round-trips through serializeAppearance", () => {
    const record = { baseColor: "#c8a24a", metalness: 0.9, roughness: 0.3 };
    expect(serializeAppearance(record)).toEqual(record);
  });
});

describe("document appearance round-trip", () => {
  it("rides the body record additively: no record, identical bytes", () => {
    const base = addBody(createDocument(createDocumentId("doc_a")), {
      name: "Plate",
    });
    expect(base.ok).toBe(true);
    if (!base.ok) return;
    const plain = serializeCadDocument(base.value.document);
    const revived = parseCadDocument(JSON.parse(JSON.stringify(plain)));
    expect(revived.ok).toBe(true);
    if (revived.ok) {
      expect(serializeCadDocument(revived.value)).toEqual(plain);
      expect(revived.value.bodies[0]?.appearance).toBeUndefined();
    }
  });

  it("assigns through body.update and round-trips the record", () => {
    const base = addBody(createDocument(createDocumentId("doc_a")), {
      name: "Plate",
    });
    if (!base.ok) throw new Error("unreachable");
    const updated = updateBody(base.value.document, base.value.body.id, {
      appearance: { ...STEEL },
      faceAppearances: [{ face: 0, appearance: BRASS_ENTRY.appearance }],
    });
    expect(updated.ok).toBe(true);
    if (!updated.ok) return;
    const serialized = serializeCadDocument(updated.value);
    const first = serialized.bodies[0];
    if (first === undefined) throw new Error("the body was added");
    expect(first.appearance).toEqual(STEEL);
    expect(first.faceAppearances).toEqual([
      { face: 0, appearance: BRASS_ENTRY.appearance },
    ]);
    const revived = parseCadDocument(JSON.parse(JSON.stringify(serialized)));
    expect(revived.ok).toBe(true);
    if (revived.ok) {
      expect(serializeCadDocument(revived.value)).toEqual(serialized);
    }
  });

  it("clears with null and refuses tampered records on parse", () => {
    const base = addBody(createDocument(createDocumentId("doc_a")), {
      name: "Plate",
    });
    if (!base.ok) throw new Error("unreachable");
    const updated = updateBody(base.value.document, base.value.body.id, {
      appearance: { ...STEEL },
    });
    if (!updated.ok) throw new Error("unreachable");
    const cleared = updateBody(updated.value, base.value.body.id, {
      appearance: null,
    });
    expect(cleared.ok).toBe(true);
    if (cleared.ok) {
      expect(cleared.value.bodies[0]?.appearance).toBeUndefined();
    }
    const tampered = JSON.parse(
      JSON.stringify(serializeCadDocument(updated.value)),
    ) as Record<string, unknown>;
    const original = tampered.bodies as readonly Record<string, unknown>[];
    tampered.bodies = [{ ...original[0], appearance: { baseColor: "red" } }];
    const parsed = parseCadDocument(tampered);
    expect(parsed.ok).toBe(false);
  });

  it("enforces the face-override budget", () => {
    const base = addBody(createDocument(createDocumentId("doc_a")), {
      name: "Plate",
    });
    if (!base.ok) throw new Error("unreachable");
    const overrides = Array.from(
      { length: BODY_FACE_APPEARANCE_LIMIT + 1 },
      (_, face) => ({ face, appearance: { ...STEEL } }),
    );
    const updated = updateBody(base.value.document, base.value.body.id, {
      faceAppearances: overrides,
    });
    expect(updated.ok).toBe(false);
  });
});

describe("withBodyAppearances", () => {
  function projectionOf(appearance?: Appearance): {
    projection: RenderProjection;
    bodyId: ReturnType<typeof createBodyId>;
  } {
    const bodyId = createBodyId("body_a");
    const projected = projectTessellation(bodyId, {
      positions: [0, 0, 0, 1, 0, 0, 0, 1, 0],
      indices: [0, 1, 2],
    });
    if (!projected.ok) throw new Error("tessellation refused");
    const object = {
      ...projected.value,
      ...(appearance === undefined ? {} : { appearance }),
    };
    const projection = createRenderProjection([object], {
      kind: "perspective" as const,
      position: [10, -10, 10] as [number, number, number],
      target: [0, 0, 0] as [number, number, number],
      up: [0, 0, 1] as [number, number, number],
      fovDeg: 40,
    });
    if (!projection.ok) throw new Error("projection refused");
    return { projection: projection.value, bodyId };
  }

  it("returns the SAME instance when no body carries a record", () => {
    const { projection } = projectionOf();
    expect(withBodyAppearances(projection, [])).toBe(projection);
  });

  it("attaches the record to the matching object only", () => {
    const bodyId = createBodyId("body_a");
    const { projection } = projectionOf();
    const resolved = withBodyAppearances(projection, [
      { id: bodyId, name: "A", appearance: { ...STEEL } },
      { id: createBodyId("body_b"), name: "B" },
    ]);
    const first = resolved.objects[0];
    expect(first?.appearance).toEqual(STEEL);
    expect(resolved.camera).toBe(projection.camera);
    expect(first === undefined ? "" : createRenderObjectId(bodyId)).toBe(
      first?.id ?? "",
    );
  });
});
