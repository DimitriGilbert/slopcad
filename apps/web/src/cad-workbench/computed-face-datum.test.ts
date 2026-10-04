/**
 * The computed-body face resolution tests (the sketch-on-face fix for
 * computed bodies): a face picked on a COMPUTED body — a boolean cavity
 * floor, a hole-modified face, a pad union's face — resolves against the
 * body's SETTLED COMPUTED MESH (the same synthetic-face grouping the
 * picker addresses), keyed by the recorded face normal plus the same-
 * normal ordinal. Pins:
 *
 * - the classification scoping: only computed-classified bodies enter the
 *   settled scene's face source — a plain extrusion never does, so its
 *   caps resolution is unreachable by the computed path;
 * - the ordinal contract: the slot-cavity box's three +z faces (two top
 *   rims, one cavity floor) address deterministically by same-normal
 *   ordinal, and re-derivation reproduces planes and ordinals exactly;
 * - the honest refusals: no settled scene, no aligned face, and an
 *   out-of-range ordinal all fail structured — never a guessed plane;
 * - the resolver ordering: a pad-union body's datum resolves through the
 *   body's TRUE computed faces (z = 10), not the pad extrusion's caps
 *   (z = 15) the old path would have matched;
 * - the scene threading: `documentSceneBodies` carries the source into
 *   the datum-anchored extrude's placement (the standoff stands on the
 *   cavity floor), and without the source that request honestly refuses.
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
  createRenderProjection,
  createSketchDocumentId,
  length,
  projectTessellation,
  type BodyId,
  type CadDocument,
  type DatumId,
  type ParameterId,
  type RenderObject,
  type RenderProjection,
  type SketchDocumentId,
} from "@slopcad/cad-core";
import {
  createLineEntity,
  createSketch,
  createSketchEntityId,
  serializeSketch as serializeSketchDomain,
} from "@slopcad/cad-sketch";

import {
  computedFaceOrdinalOfObject,
  computedFacePlanesOfObject,
  resolveSessionDatumPlane,
} from "./datum";
import {
  computedFacePickOrdinal,
  documentPadSceneRequest,
  hasComputedAnchoredExtrude,
  sceneOperandOfBody,
  sessionComputedFacesOf,
} from "./extrude";
import { documentSceneBodies } from "./document-scene";

// -- The mesh fixtures -------------------------------------------------------

/** Accumulates an indexed triangle soup out of corner-ordered rectangles. */
class MeshBuilder {
  readonly positions: number[] = [];
  readonly indices: number[] = [];

  /**
   * One rectangle as two triangles: corners in order around the perimeter
   * (origin, origin+u, origin+u+v, origin+v) — the consistent winding
   * keeps every coplanar triangle's geometric normal pointing the SAME
   * way, so the face's mean normal never cancels. (Delta arithmetic —
   * use only with exact-representative edges; the prism below emits its
   * slanted quads through {@link quad} with explicit shared corners.)
   */
  rect(
    origin: readonly [number, number, number],
    u: readonly [number, number, number],
    v: readonly [number, number, number],
  ): void {
    const corner = (
      du: number,
      dv: number,
    ): readonly [number, number, number] => [
      origin[0] + du * u[0] + dv * v[0],
      origin[1] + du * u[1] + dv * v[1],
      origin[2] + du * u[2] + dv * v[2],
    ];
    this.quad(corner(0, 0), corner(1, 0), corner(1, 1), corner(0, 1));
  }

  /**
   * One rectangle from EXPLICIT corners — adjacent quads pass the very
   * same arrays, so shared mesh edges carry bit-identical positions (the
   * synthetic-face adjacency keys on exact position equality).
   */
  quad(
    c0: readonly [number, number, number],
    c1: readonly [number, number, number],
    c2: readonly [number, number, number],
    c3: readonly [number, number, number],
  ): void {
    const base = this.positions.length / 3;
    for (const corner of [c0, c1, c2, c3]) {
      this.positions.push(corner[0], corner[1], corner[2]);
    }
    this.indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
}

/**
 * A 20×20×10 block with a full-y SLOT cavity (x ∈ [5,15], sunk 4 mm from
 * the top, floor at z = 6) — the boolean cavity's stand-in. Triangle emit
 * order fixes the synthetic-face ordinals:
 *
 * | face             | normal | synthetic ordinal | same-normal (+z) ordinal |
 * |------------------|--------|-------------------|--------------------------|
 * | outer bottom     | -z     | 0                 | —                        |
 * | outer wall +x    | +x     | 1                 | —                        |
 * | outer wall -x    | -x     | 2                 | —                        |
 * | outer wall +y    | +y     | 3                 | —                        |
 * | outer wall -y    | -y     | 4                 | —                        |
 * | cavity wall x=5  | +x     | 5                 | —                        |
 * | cavity wall x=15 | -x     | 6                 | —                        |
 * | left top rim     | +z     | 7                 | 0                        |
 * | CAVITY FLOOR     | +z     | 8                 | 1                        |
 * | right top rim    | +z     | 9                 | 2                        |
 */
function hollowSlotMesh(): MeshBuilder {
  const mesh = new MeshBuilder();
  mesh.rect([0, 0, 0], [0, 20, 0], [20, 0, 0]); // outer bottom, -z
  mesh.rect([20, 0, 10], [0, 0, -10], [0, 20, 0]); // outer wall, +x
  mesh.rect([0, 0, 0], [0, 0, 10], [0, 20, 0]); // outer wall, -x
  mesh.rect([0, 20, 0], [0, 0, 10], [20, 0, 0]); // outer wall, +y
  mesh.rect([0, 0, 10], [0, 0, -10], [20, 0, 0]); // outer wall, -y
  mesh.rect([5, 0, 10], [0, 0, -4], [0, 20, 0]); // cavity wall x=5, +x
  mesh.rect([15, 0, 6], [0, 0, 4], [0, 20, 0]); // cavity wall x=15, -x
  mesh.rect([0, 0, 10], [5, 0, 0], [0, 20, 0]); // left top rim, +z
  mesh.rect([5, 0, 6], [10, 0, 0], [0, 20, 0]); // cavity floor, +z
  mesh.rect([15, 0, 10], [5, 0, 0], [0, 20, 0]); // right top rim, +z
  return mesh;
}

/**
 * The pad union's TRUE geometry (an L-shape): base 20×20×10 with a
 * 10×10×5 post at the x∈[0,10], y∈[0,10] corner. The top ring at z = 10
 * tiles as two rectangles whose shared boundary is only a PARTIAL mesh
 * edge (the group rule unions exact position-pair edges), so the ring is
 * two faces — with the post top at z = 15 that is three +z faces,
 * same-normal ordinals 0/1/2. The pad extrusion's caps path would match
 * +z at z = 15 — the discriminating plane this mesh pins the ordering
 * against.
 */
function padUnionMesh(): MeshBuilder {
  const mesh = new MeshBuilder();
  mesh.rect([0, 0, 0], [0, 20, 0], [20, 0, 0]); // bottom, -z
  mesh.rect([20, 0, 10], [0, 0, -10], [0, 20, 0]); // wall, +x
  mesh.rect([0, 0, 0], [0, 0, 10], [0, 20, 0]); // wall, -x
  mesh.rect([0, 20, 0], [0, 0, 10], [20, 0, 0]); // wall, +y
  mesh.rect([0, 0, 10], [0, 0, -10], [20, 0, 0]); // wall, -y
  mesh.rect([10, 0, 10], [0, 0, 5], [0, 10, 0]); // post wall, +x
  mesh.rect([0, 0, 15], [10, 0, 0], [0, 10, 0]); // post top, +z
  mesh.rect([0, 10, 10], [0, 0, 5], [10, 0, 0]); // post wall, +y
  mesh.rect([0, 10, 10], [20, 0, 0], [0, 10, 0]); // ring back band, +z
  mesh.rect([10, 0, 10], [10, 0, 0], [0, 10, 0]); // ring right block, +z
  return mesh;
}

/** A plain 20×20×10 box (the base extrusion's stand-in mesh). */
function boxMesh(): MeshBuilder {
  const mesh = new MeshBuilder();
  mesh.rect([0, 0, 0], [0, 20, 0], [20, 0, 0]);
  mesh.rect([20, 0, 10], [0, 0, -10], [0, 20, 0]);
  mesh.rect([0, 0, 0], [0, 0, 10], [0, 20, 0]);
  mesh.rect([0, 20, 0], [0, 0, 10], [20, 0, 0]);
  mesh.rect([0, 0, 10], [0, 0, -10], [20, 0, 0]);
  mesh.rect([0, 0, 10], [20, 0, 0], [0, 20, 0]); // top, +z
  return mesh;
}

/**
 * A 16-gon prism (r = 10, h = 10): the side wall's 16 quads share exact
 * edges and turn 22.5° per segment (< the 30° grouping threshold), so
 * they group as ONE synthetic face whose mean normal cancels — the
 * curved face a planar datum can never anchor on. The caps are the only
 * planar faces (+z top, -z bottom).
 */
function prismMesh(): MeshBuilder {
  const mesh = new MeshBuilder();
  const segments = 16;
  const rim = (index: number): readonly [number, number, number] => {
    const t = (2 * Math.PI * index) / segments;
    return [10 * Math.cos(t), 10 * Math.sin(t), 0];
  };
  // Top cap (+z): a fan around the center, CCW seen from above.
  for (let index = 0; index < segments; index += 1) {
    const a = rim(index);
    const b = rim(index + 1);
    const base = mesh.positions.length / 3;
    mesh.positions.push(0, 0, 10, a[0], a[1], 10, b[0], b[1], 10);
    mesh.indices.push(base, base + 1, base + 2);
  }
  // Bottom cap (-z): the reversed fan.
  for (let index = 0; index < segments; index += 1) {
    const a = rim(index);
    const b = rim(index + 1);
    const base = mesh.positions.length / 3;
    mesh.positions.push(0, 0, 0, b[0], b[1], 0, a[0], a[1], 0);
    mesh.indices.push(base, base + 1, base + 2);
  }
  // Side quads, outward winding, SHARED explicit corners (the adjacent
  // quads pass the very same rim arrays — exact position adjacency).
  for (let index = 0; index < segments; index += 1) {
    const a = rim(index);
    const b = rim(index + 1);
    mesh.quad(
      [a[0], a[1], 10],
      [a[0], a[1], 0],
      [b[0], b[1], 0],
      [b[0], b[1], 10],
    );
  }
  return mesh;
}

function renderObjectOf(bodyId: BodyId, mesh: MeshBuilder): RenderObject {
  const projected = projectTessellation(bodyId, {
    positions: mesh.positions,
    indices: mesh.indices,
  });
  if (!projected.ok) throw new Error(projected.error.message);
  return projected.value;
}

const testCamera = {
  kind: "perspective" as const,
  position: [60, -60, 60] as const,
  target: [10, 10, 5] as const,
  up: [0, 0, 1] as const,
  fovDeg: 50,
};

function projectionOf(objects: readonly RenderObject[]): RenderProjection {
  const assembled = createRenderProjection(objects, testCamera);
  if (!assembled.ok) throw new Error(assembled.error.message);
  return assembled.value;
}

// -- The document fixtures ---------------------------------------------------

const skdBase = createSketchDocumentId("skd_cfd_base");

/** A 20x15 rectangle sketch (four lines) on the z = `originZ` plane. */
function rectangleSketchPayload(originZ = 0): Record<string, unknown> {
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
  return serializeSketchDomain(created.value) as unknown as Record<
    string,
    unknown
  >;
}

/** Adds a sketch record; throws on refusal (fixtures stay honest). */
function addSketch(
  document: CadDocument,
  id: SketchDocumentId,
  originZ = 0,
): CadDocument {
  const applied = applyCommand(document, {
    type: "sketch.create",
    id,
    name: "fixture sketch",
    sketch: rectangleSketchPayload(originZ),
  });
  if (!applied.ok) throw new Error(applied.error.message);
  return applied.value;
}

function addLengthParameter(
  document: CadDocument,
  name: string,
  value: number,
): { document: CadDocument; parameterId: ParameterId } {
  const parameterId = createParameterId(`param_cfd_${name}`);
  const added = addDocumentParameter(document, {
    id: parameterId,
    name,
    value: length(value),
  });
  if (!added.ok) throw new Error(added.error.message);
  return { document: added.value.document, parameterId };
}

/** Adds a body record; throws on refusal. */
function addBodyRecord(document: CadDocument, id: BodyId): CadDocument {
  const added = addBody(document, { id, name: id });
  if (!added.ok) throw new Error(added.error.message);
  return added.value.document;
}

/** Adds an extrude feature; throws on refusal. */
function addExtrudeFeature(
  document: CadDocument,
  featureId: string,
  sketchId: SketchDocumentId,
  parameterId: ParameterId,
  bodyId: BodyId,
  datumId?: DatumId,
): CadDocument {
  const added = addFeature(document, {
    id: createFeatureId(featureId),
    kind: "extrude",
    inputs: [
      { kind: "sketch", id: sketchId },
      { kind: "parameter", id: parameterId },
      ...(datumId === undefined
        ? []
        : [{ kind: "datum" as const, id: datumId }]),
    ],
    outputs: [bodyId],
  });
  if (!added.ok) throw new Error(added.error.message);
  return added.value.document;
}

interface BooleanDocument {
  readonly document: CadDocument;
  readonly bBase: BodyId;
  readonly bTool: BodyId;
  readonly bCut: BodyId;
}

/**
 * The hollowed block: a base extrusion, a tool extrusion, and the
 * subtract whose output body is the COMPUTED body the fixtures pick on.
 */
function booleanDocument(): BooleanDocument {
  const bBase = createBodyId("body_cfd_base");
  const bTool = createBodyId("body_cfd_tool");
  const bCut = createBodyId("body_cfd_cut");
  const featBase = createFeatureId("feat_cfd_base");
  let document = createDocument(createDocumentId("doc_computed_face_datum"));
  document = addSketch(document, skdBase);
  const baseDepth = addLengthParameter(document, "baseDepth", 10);
  document = baseDepth.document;
  const toolDepth = addLengthParameter(document, "toolDepth", 4);
  document = toolDepth.document;
  document = addBodyRecord(document, bBase);
  document = addBodyRecord(document, bTool);
  document = addBodyRecord(document, bCut);
  document = addExtrudeFeature(
    document,
    "feat_cfd_base",
    skdBase,
    baseDepth.parameterId,
    bBase,
  );
  const skdTool = createSketchDocumentId("skd_cfd_tool");
  document = addSketch(document, skdTool, 6);
  document = addExtrudeFeature(
    document,
    "feat_cfd_tool",
    skdTool,
    toolDepth.parameterId,
    bTool,
  );
  const subtract = addFeature(document, {
    id: createFeatureId("feat_cfd_cut"),
    kind: "subtract",
    inputs: [
      { kind: "feature", id: featBase },
      { kind: "feature", id: createFeatureId("feat_cfd_tool") },
    ],
    outputs: [bCut],
  });
  if (!subtract.ok) throw new Error(subtract.error.message);
  document = subtract.value.document;
  return { document, bBase, bTool, bCut };
}

/** The settled scene of the boolean document: base box + hollowed cut. */
function booleanScene(fixture: BooleanDocument): RenderProjection {
  return projectionOf([
    renderObjectOf(fixture.bBase, boxMesh()),
    renderObjectOf(fixture.bCut, hollowSlotMesh()),
  ]);
}

/** A +z cavity-floor face reference payload at the given ordinal. */
function floorReference(
  bodyId: BodyId,
  ordinal: number,
): Record<string, unknown> {
  return {
    kind: "sessionFace",
    bodyId,
    faceNormal: [0, 0, 1],
    faceOrdinal: ordinal,
  };
}

function faceDatumPayload(
  reference: Record<string, unknown>,
): Record<string, unknown> {
  return {
    formatVersion: 1,
    datumType: "plane",
    definition: "faceOffset",
    reference,
    normalAtDefinition: [0, 0, 1],
    offsetMm: 0,
  };
}

function addDatum(
  document: CadDocument,
  id: DatumId,
  reference: Record<string, unknown>,
): CadDocument {
  const added = addDocumentDatum(document, {
    id,
    name: "cavity floor",
    datum: faceDatumPayload(reference),
  });
  if (!added.ok) throw new Error(added.error.message);
  return added.value.document;
}

// -- The tests ---------------------------------------------------------------

describe("computed-body face resolution (sketch-on-face on computed solids)", () => {
  it("classifies the boolean output as computed and lists its faces; the plain extrusion stays out of the source", () => {
    const fixture = booleanDocument();
    expect(sceneOperandOfBody(fixture.document, fixture.bCut)).toEqual({
      kind: "computed",
      bodyId: fixture.bCut,
    });
    expect(sceneOperandOfBody(fixture.document, fixture.bBase)?.kind).toBe(
      "extrude",
    );
    const source = sessionComputedFacesOf(
      fixture.document,
      booleanScene(fixture),
    );
    expect(source).not.toBeNull();
    if (source === null) return;
    expect(source.planesOf(fixture.bCut)).toHaveLength(10);
    // The scoping contract: the plain extrusions never enter the source,
    // so their datum resolution can never take the computed path.
    expect(source.planesOf(fixture.bBase)).toBeUndefined();
    expect(source.planesOf(fixture.bTool)).toBeUndefined();
  });

  it("resolves a datum anchored on the cavity floor (same-normal ordinal 1) to the floor plane", () => {
    const fixture = booleanDocument();
    const dtmFloor = createDatumId("dtm_cfd_floor");
    const document = addDatum(
      fixture.document,
      dtmFloor,
      floorReference(fixture.bCut, 1),
    );
    const source = sessionComputedFacesOf(document, booleanScene(fixture));
    expect(source).not.toBeNull();
    if (source === null) return;
    const plane = resolveSessionDatumPlane(document, dtmFloor, source);
    expect(plane.ok).toBe(true);
    if (!plane.ok) return;
    // The floor sits 4 mm down from the 10 mm top: z = 6, +z into the
    // cavity — the standoff's sketch plane.
    expect(plane.origin[2]).toBeCloseTo(6, 9);
    expect(plane.normal[0]).toBeCloseTo(0, 9);
    expect(plane.normal[1]).toBeCloseTo(0, 9);
    expect(plane.normal[2]).toBeCloseTo(1, 9);
    // The origin rides the face anchor (on the floor, inside the cavity).
    expect(plane.origin[0]).toBeGreaterThan(5);
    expect(plane.origin[0]).toBeLessThan(15);
    expect(plane.origin[1]).toBeGreaterThan(0);
    expect(plane.origin[1]).toBeLessThan(20);
  });

  it("without the settled scene the same reference refuses structured — never a guess", () => {
    const fixture = booleanDocument();
    const dtmFloor = createDatumId("dtm_cfd_floor");
    const document = addDatum(
      fixture.document,
      dtmFloor,
      floorReference(fixture.bCut, 1),
    );
    const failed = resolveSessionDatumPlane(document, dtmFloor);
    expect(failed.ok).toBe(false);
    if (failed.ok) return;
    expect(failed.error.code).toBe("datum/reference-invalid");
    expect(failed.error.message).toContain("no resolvable extrude faces");
  });

  it("a hole-modified face resolves the same way (the hole output is computed-classified)", () => {
    // The hole's output is its OWN body (the workbench's holed-body
    // commit), whose only producer is the hole feature — computed-classified;
    // the fixtures reuse the slot mesh as the holed body's settled geometry.
    const bHoleBase = createBodyId("body_cfd_hole_base");
    const bHoled = createBodyId("body_cfd_holed");
    let document = createDocument(createDocumentId("doc_cfd_hole"));
    document = addSketch(document, skdBase);
    const depth = addLengthParameter(document, "holeBaseDepth", 10);
    document = depth.document;
    document = addBodyRecord(document, bHoleBase);
    document = addBodyRecord(document, bHoled);
    document = addExtrudeFeature(
      document,
      "feat_cfd_hole_base",
      skdBase,
      depth.parameterId,
      bHoleBase,
    );
    const holed = addFeature(document, {
      id: createFeatureId("feat_cfd_hole"),
      kind: "hole",
      inputs: [{ kind: "feature", id: createFeatureId("feat_cfd_hole_base") }],
      outputs: [bHoled],
    });
    if (!holed.ok) throw new Error(holed.error.message);
    document = holed.value.document;
    expect(sceneOperandOfBody(document, bHoled)?.kind).toBe("computed");
    const dtmHoleFace = createDatumId("dtm_cfd_hole_face");
    document = addDatum(document, dtmHoleFace, floorReference(bHoled, 1));
    const source = sessionComputedFacesOf(
      document,
      projectionOf([renderObjectOf(bHoled, hollowSlotMesh())]),
    );
    expect(source).not.toBeNull();
    if (source === null) return;
    const plane = resolveSessionDatumPlane(document, dtmHoleFace, source);
    expect(plane.ok).toBe(true);
    if (!plane.ok) return;
    expect(plane.origin[2]).toBeCloseTo(6, 9);
    expect(plane.normal[2]).toBeCloseTo(1, 9);
  });

  it("a face with no aligned planar candidate refuses (a curved anchor, never a guess)", () => {
    // The prism's only planar faces are the ±z caps; a reference normal
    // pointing at the grouped curved wall aligns with neither — the
    // honest structured refusal.
    const bPrismBase = createBodyId("body_cfd_prism_base");
    const bPrism = createBodyId("body_cfd_prism");
    let document = createDocument(createDocumentId("doc_cfd_prism"));
    document = addSketch(document, skdBase);
    const depth = addLengthParameter(document, "prismDepth", 10);
    document = depth.document;
    document = addBodyRecord(document, bPrismBase);
    document = addBodyRecord(document, bPrism);
    document = addExtrudeFeature(
      document,
      "feat_cfd_prism_base",
      skdBase,
      depth.parameterId,
      bPrismBase,
    );
    const turned = addFeature(document, {
      id: createFeatureId("feat_cfd_prism_cut"),
      kind: "subtract",
      inputs: [{ kind: "feature", id: createFeatureId("feat_cfd_prism_base") }],
      outputs: [bPrism],
    });
    if (!turned.ok) throw new Error(turned.error.message);
    document = turned.value.document;
    expect(sceneOperandOfBody(document, bPrism)?.kind).toBe("computed");
    const dtmCurved = createDatumId("dtm_cfd_curved");
    document = addDatum(document, dtmCurved, {
      kind: "sessionFace",
      bodyId: bPrism,
      faceNormal: [1, 0, 0],
      faceOrdinal: 0,
    });
    const source = sessionComputedFacesOf(
      document,
      projectionOf([renderObjectOf(bPrism, prismMesh())]),
    );
    expect(source).not.toBeNull();
    if (source === null) return;
    expect(source.planesOf(bPrism)).toHaveLength(2);
    const failed = resolveSessionDatumPlane(document, dtmCurved, source);
    expect(failed.ok).toBe(false);
    if (failed.ok) return;
    expect(failed.error.code).toBe("datum/reference-invalid");
    expect(failed.error.message).toContain("no planar face matching");
  });

  it("an out-of-range same-normal ordinal refuses (the computed topology changed)", () => {
    const fixture = booleanDocument();
    const dtmGone = createDatumId("dtm_cfd_gone");
    const document = addDatum(
      fixture.document,
      dtmGone,
      floorReference(fixture.bCut, 3),
    );
    const source = sessionComputedFacesOf(document, booleanScene(fixture));
    expect(source).not.toBeNull();
    if (source === null) return;
    const failed = resolveSessionDatumPlane(document, dtmGone, source);
    expect(failed.ok).toBe(false);
    if (failed.ok) return;
    expect(failed.error.code).toBe("datum/reference-invalid");
    expect(failed.error.message).toContain("same-normal ordinal 3");
  });

  it("a negative or non-integer ordinal is an invalid reference", () => {
    const fixture = booleanDocument();
    const source = sessionComputedFacesOf(
      fixture.document,
      booleanScene(fixture),
    );
    expect(source).not.toBeNull();
    if (source === null) return;
    for (const ordinal of [-1, 0.5]) {
      const dtmBad = createDatumId(`dtm_cfd_bad${String(ordinal)}`);
      const document = addDatum(
        fixture.document,
        dtmBad,
        floorReference(fixture.bCut, ordinal),
      );
      const failed = resolveSessionDatumPlane(document, dtmBad, source);
      expect(failed.ok).toBe(false);
      if (failed.ok) continue;
      expect(failed.error.code).toBe("datum/reference-invalid");
    }
  });

  it("the pick ordinal addresses the face deterministically (same mesh, same planes, same ordinals)", () => {
    const object = renderObjectOf(
      createBodyId("body_cfd_ord"),
      hollowSlotMesh(),
    );
    const first = computedFacePlanesOfObject(object);
    const second = computedFacePlanesOfObject(object);
    expect(first).toEqual(second);
    // The three +z faces in synthetic-ordinal order: rims at 0/2, the
    // cavity floor at 1.
    expect(computedFaceOrdinalOfObject(object, 7)).toBe(0);
    expect(computedFaceOrdinalOfObject(object, 8)).toBe(1);
    expect(computedFaceOrdinalOfObject(object, 9)).toBe(2);
    const floorPlane = first[8];
    expect(floorPlane).toBeDefined();
    if (floorPlane === undefined) return;
    expect(floorPlane.origin[2]).toBeCloseTo(6, 9);
    expect(floorPlane.normal[2]).toBeCloseTo(1, 9);
    // Digest: deterministic across derivations of the same scene.
    const fixture = booleanDocument();
    const scene = booleanScene(fixture);
    const digestA = sessionComputedFacesOf(fixture.document, scene)?.digest;
    const digestB = sessionComputedFacesOf(fixture.document, scene)?.digest;
    expect(digestA).toBeDefined();
    expect(digestA).toBe(digestB);
  });

  it("the pick ordinal is null for a plain extrusion — its reference stays ordinal-free", () => {
    const fixture = booleanDocument();
    const scene = booleanScene(fixture);
    expect(
      computedFacePickOrdinal(fixture.document, scene, {
        kind: "face",
        bodyId: fixture.bBase,
        faceIndex: 5,
      }),
    ).toBeNull();
    expect(
      computedFacePickOrdinal(fixture.document, scene, {
        kind: "face",
        bodyId: fixture.bCut,
        faceIndex: 8,
      }),
    ).toBe(1);
  });

  it("a pad-union body's datum resolves through the TRUE computed faces, not the pad's caps", () => {
    const bBase = createBodyId("body_cfd_pad_base");
    const bPad = createBodyId("body_cfd_pad");
    let document = createDocument(createDocumentId("doc_cfd_pad_order"));
    document = addSketch(document, skdBase);
    const baseDepth = addLengthParameter(document, "padBaseDepth", 10);
    document = baseDepth.document;
    const padDepth = addLengthParameter(document, "padDepth", 5);
    document = padDepth.document;
    const skdPad = createSketchDocumentId("skd_cfd_pad");
    document = addSketch(document, skdPad, 10);
    document = addBodyRecord(document, bBase);
    document = addBodyRecord(document, bPad);
    document = addExtrudeFeature(
      document,
      "feat_cfd_pad_base",
      skdBase,
      baseDepth.parameterId,
      bBase,
    );
    // The pad is datum-anchored (the composition's own gate) on the base's
    // front cap — the fixture only needs the composition to CLASSIFY.
    const dtmAnchor = createDatumId("dtm_cfd_pad_anchor");
    document = addDatum(document, dtmAnchor, {
      kind: "sessionFace",
      bodyId: bBase,
      faceNormal: [0, 0, 1],
    });
    document = addExtrudeFeature(
      document,
      "feat_cfd_pad",
      skdPad,
      padDepth.parameterId,
      bPad,
      dtmAnchor,
    );
    expect(sceneOperandOfBody(document, bPad)?.kind).toBe("computed");

    // The pad body's settled mesh is the TRUE union (the L-shape). The
    // datum anchors on same-normal ordinal 2 of the +z faces (a ring
    // strip at z = 10) — the caps path would match +z at z = 15 instead.
    const dtmRing = createDatumId("dtm_cfd_ring");
    document = addDatum(document, dtmRing, floorReference(bPad, 2));
    const source = sessionComputedFacesOf(
      document,
      projectionOf([renderObjectOf(bPad, padUnionMesh())]),
    );
    expect(source).not.toBeNull();
    if (source === null) return;
    const plane = resolveSessionDatumPlane(document, dtmRing, source);
    expect(plane.ok).toBe(true);
    if (!plane.ok) return;
    expect(plane.origin[2]).toBeCloseTo(10, 9);
    expect(plane.normal[2]).toBeCloseTo(1, 9);
  });

  it("hasComputedAnchoredExtrude gates on computed-anchored datums only", () => {
    // A datum on the computed body, no extrude consumes it yet: closed.
    const fixture = booleanDocument();
    const dtmFloor = createDatumId("dtm_cfd_follow");
    let document = addDatum(
      fixture.document,
      dtmFloor,
      floorReference(fixture.bCut, 1),
    );
    expect(hasComputedAnchoredExtrude(document)).toBe(false);
    // A datum-anchored extrude on the computed body opens the gate.
    const depth = addLengthParameter(document, "standoffDepth", 6);
    document = depth.document;
    const skdPost = createSketchDocumentId("skd_cfd_standoff");
    document = addSketch(document, skdPost, 6);
    const bPost = createBodyId("body_cfd_post");
    document = addBodyRecord(document, bPost);
    document = addExtrudeFeature(
      document,
      "feat_cfd_post",
      skdPost,
      depth.parameterId,
      bPost,
      dtmFloor,
    );
    expect(hasComputedAnchoredExtrude(document)).toBe(true);

    // The same shape anchored on a PLAIN extrusion (the s07 datum) keeps
    // the gate closed — established flows keep their dispatch rhythm.
    const plain = booleanDocument();
    const dtmPlain = createDatumId("dtm_cfd_plain");
    let plainDocument = addDatum(plain.document, dtmPlain, {
      kind: "sessionFace",
      bodyId: plain.bBase,
      faceNormal: [0, 0, 1],
    });
    const plainDepth = addLengthParameter(plainDocument, "plainDepth", 5);
    plainDocument = plainDepth.document;
    const bPlainPost = createBodyId("body_cfd_plain_post");
    plainDocument = addBodyRecord(plainDocument, bPlainPost);
    plainDocument = addExtrudeFeature(
      plainDocument,
      "feat_cfd_plain_post",
      skdBase,
      plainDepth.parameterId,
      bPlainPost,
      dtmPlain,
    );
    expect(hasComputedAnchoredExtrude(plainDocument)).toBe(false);
  });

  it("documentSceneBodies threads the source: the standoff rides the floor plane; without it the request refuses", () => {
    const fixture = booleanDocument();
    const dtmFloor = createDatumId("dtm_cfd_scene");
    let document = addDatum(
      fixture.document,
      dtmFloor,
      floorReference(fixture.bCut, 1),
    );
    const depth = addLengthParameter(document, "sceneStandoffDepth", 6);
    document = depth.document;
    const skdPost = createSketchDocumentId("skd_cfd_scene_post");
    document = addSketch(document, skdPost, 6);
    const bPost = createBodyId("body_cfd_scene_post");
    document = addBodyRecord(document, bPost);
    document = addExtrudeFeature(
      document,
      "feat_cfd_scene_post",
      skdPost,
      depth.parameterId,
      bPost,
      dtmFloor,
    );

    const source = sessionComputedFacesOf(document, booleanScene(fixture));
    expect(source).not.toBeNull();
    if (source === null) return;
    // The computed-anchor decline: the standoff does NOT form the two-
    // extrude pad composition (unioning it over the first extrude would
    // erase the pocket) — it renders as its own body beside the shell.
    expect(documentPadSceneRequest(document, source)).toBeNull();
    const bodies = documentSceneBodies(document, new Set(), null, source);
    const postScene = bodies.find((body) => body.bodyId === bPost);
    expect(postScene).toBeDefined();
    if (postScene === undefined) return;
    expect(postScene.scene.kind).toBe("extrude");
    if (postScene.scene.kind !== "extrude") return;
    // The datum override: the placement sits ON the cavity floor (z = 6).
    expect(postScene.scene.request.placement.translation.z.value).toBeCloseTo(
      6,
      9,
    );

    // Without the source, the datum refuses and the standoff's scene
    // request is null — the honest fallback, never a fabricated plane.
    const unthreaded = documentSceneBodies(document, new Set(), null);
    expect(unthreaded.find((body) => body.bodyId === bPost)).toBeUndefined();
    // The boolean body itself still renders in both passes.
    expect(bodies.find((body) => body.bodyId === fixture.bCut)).toBeDefined();
  });
});
