/**
 * Phase N2b: history-based names through the face ops, patterns, mirror
 * and the remaining builders (pipe shell, ruled loft, draft, thick solid)
 * against the REAL OpenCascade kernel.
 *
 * - every named output reports `occt-name/1` identities with unique names
 *   per kind, and the operation's created faces carry
 *   `<feature>/<role>/<source name>`;
 * - references minted on build 1 resolve `valid` on a rebuild after a box
 *   dimension edit (moveFace, pattern instances);
 * - pattern copies are `<feature>/instance/<i>/…`, mirror copies
 *   `<feature>/mirror/…`, and their fuse keeps every name distinct;
 * - the bridge's split names its covering tool under the feature, so the
 *   cut face is `<feature>/tool/…` and survives a box dimension edit;
 * - two bridge holes on one body name their tools under their own
 *   features, so an edit that reorders them geometrically keeps every
 *   reference on its own hole's face.
 */

import { beforeAll, describe, expect, it } from "vitest";
import {
  addBody,
  addDocumentDatum,
  addDocumentParameter,
  addFeature,
  angle,
  applyCommand,
  type CadDocument,
  createBodyId,
  createDatumId,
  createDocument,
  createDocumentId,
  createFeatureId,
  createParameterId,
  createReferenceId,
  dimensionless,
  initialRegenerationStates,
  length,
  mintTopologyReference,
  referenceProvenance,
  regenerate,
  resolveTopologyReference,
  type ReferenceProvenance,
  type TopologyEntityReference,
  type TopologySnapshot,
} from "@slopcad/cad-core";
import {
  createKernelFeatureExecutor,
  type KernelSolid,
  type ProfilePlacementInput,
  type ProfileSegmentInput,
  unwrapKernelResult,
} from "@slopcad/cad-kernel";

import { occtKernelFromRuntime } from "./occt-kernel";
import { createOcctRuntime, type OcctRuntime } from "./occt-runtime";

let runtime: OcctRuntime;

beforeAll(async () => {
  runtime = await createOcctRuntime();
});

type Kernel = ReturnType<typeof occtKernelFromRuntime>;
type Kind = "face" | "edge" | "vertex";

const body = createBodyId("body_part");
const BOX = "feat_box";

const PLACEMENT: ProfilePlacementInput = {
  rotation: { axis: [0, 0, 1], angle: angle(0, "rad") },
  translation: { x: length(0), y: length(0), z: length(0) },
};

let referenceCount = 0;

function provenance(): ReferenceProvenance {
  let document = createDocument(createDocumentId("doc_history_builders"));
  const added = addBody(document, { id: body, name: "Part" });
  if (!added.ok) throw new Error(added.error.message);
  document = added.value.document;
  const box = addFeature(document, {
    id: createFeatureId(BOX),
    kind: "box",
    inputs: [],
    outputs: [body],
  });
  if (!box.ok) throw new Error(box.error.message);
  const result = referenceProvenance(box.value.document, body);
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

function boxOf(kernel: Kernel, width: number): KernelSolid {
  return unwrapKernelResult(
    kernel.createBox({
      featureId: BOX,
      width: length(width),
      depth: length(20),
      height: length(10),
    }),
    "createBox",
  );
}

function rectangle(width: number, depth: number): ProfileSegmentInput[] {
  const corners: [number, number][] = [
    [0, 0],
    [width, 0],
    [width, depth],
    [0, depth],
  ];
  return corners.map((start, index) => ({
    kind: "line",
    start,
    end: corners[(index + 1) % corners.length] ?? start,
  }));
}

function snapshotOf(
  kernel: Kernel,
  solid: KernelSolid,
  regeneration = 1,
): TopologySnapshot {
  return unwrapKernelResult(
    kernel.topologySnapshot(solid, { bodyId: body, regeneration }),
    "topologySnapshot",
  );
}

function namesOf(snapshot: TopologySnapshot, kind: Kind): string[] {
  return snapshot.entities
    .filter((entity) => entity.kind === kind)
    .map((entity) => String(entity.identity?.data.name));
}

/** Every entity named `occt-name/1`, names unique per kind; the faces. */
function namedFaces(snapshot: TopologySnapshot): string[] {
  for (const entity of snapshot.entities) {
    expect(entity.identity?.schema).toBe("occt-name/1");
  }
  for (const kind of ["face", "edge", "vertex"] as const) {
    const names = namesOf(snapshot, kind);
    expect(new Set(names).size).toBe(names.length);
  }
  return namesOf(snapshot, "face");
}

function faceOrdinal(snapshot: TopologySnapshot, name: string): number {
  const entity = snapshot.entities.find(
    (candidate) =>
      candidate.kind === "face" && candidate.identity?.data.name === name,
  );
  if (entity === undefined) throw new Error(`no face named ${name}`);
  return entity.ordinal;
}

function mint(
  snapshot: TopologySnapshot,
  name: string,
): TopologyEntityReference {
  const minted = mintTopologyReference(
    snapshot,
    faceOrdinal(snapshot, name),
    provenance(),
    {
      id: createReferenceId(`ref_builders_${String((referenceCount += 1))}`),
      kind: "face",
    },
  );
  if (!minted.ok) throw new Error(minted.error.message);
  return minted.value;
}

function stateOf(
  reference: TopologyEntityReference,
  snapshot: TopologySnapshot,
): string {
  const resolved = resolveTopologyReference(reference, snapshot);
  if (!resolved.ok) throw new Error(resolved.error.message);
  return resolved.value.validity.state;
}

function volumeOf(kernel: Kernel, solid: KernelSolid): number {
  return unwrapKernelResult(kernel.volume(solid), "volume");
}

describe("moveFace / replaceFace", () => {
  function movedTop(kernel: Kernel, width: number, distance: number) {
    const box = boxOf(kernel, width);
    const top = faceOrdinal(snapshotOf(kernel, box), `${BOX}/+Z`);
    return unwrapKernelResult(
      kernel.moveFace({
        featureId: "feat_move",
        target: box,
        face: top,
        direction: [0, 0, 1],
        distance: length(distance),
      }),
      "moveFace",
    );
  }

  it("keeps the moved face's name and names the swept walls by edge", () => {
    const kernel = occtKernelFromRuntime(runtime);
    const moved = movedTop(kernel, 30, 5);
    expect(volumeOf(kernel, moved)).toBeCloseTo(30 * 20 * 15, 6);
    const faces = namedFaces(snapshotOf(kernel, moved));
    expect(faces).toContain(`${BOX}/+Z`);
    expect(faces).toContain(`feat_move/side/${BOX}/+X|${BOX}/+Z`);
    expect(faces).not.toContain(`feat_move/base/${BOX}/+Z`);
  });

  it("names an inward move and survives a box dimension edit", () => {
    const kernel = occtKernelFromRuntime(runtime);
    const first = snapshotOf(kernel, movedTop(kernel, 30, -4), 1);
    namedFaces(first);
    const top = mint(first, `${BOX}/+Z`);
    const side = mint(first, `${BOX}/+X`);
    const edited = movedTop(kernel, 42, -4);
    expect(volumeOf(kernel, edited)).toBeCloseTo(42 * 20 * 6, 6);
    const second = snapshotOf(kernel, edited, 2);
    namedFaces(second);
    expect(stateOf(top, second)).toBe("valid");
    expect(stateOf(side, second)).toBe("valid");
  });

  it("names the parallel and the oblique replace", () => {
    const kernel = occtKernelFromRuntime(runtime);
    const box = boxOf(kernel, 30);
    const top = faceOrdinal(snapshotOf(kernel, box), `${BOX}/+Z`);
    const parallel = unwrapKernelResult(
      kernel.replaceFace({
        featureId: "feat_replace",
        target: box,
        face: top,
        plane: {
          origin: { x: length(0), y: length(0), z: length(7) },
          normal: [0, 0, 1],
        },
      }),
      "replaceFace",
    );
    expect(volumeOf(kernel, parallel)).toBeCloseTo(30 * 20 * 7, 6);
    expect(namedFaces(snapshotOf(kernel, parallel))).toContain(`${BOX}/+Z`);
    const oblique = unwrapKernelResult(
      kernel.replaceFace({
        featureId: "feat_replace",
        target: box,
        face: top,
        plane: {
          origin: { x: length(15), y: length(10), z: length(8) },
          normal: [0.2, 0, 1],
        },
      }),
      "replaceFace",
    );
    expect(namedFaces(snapshotOf(kernel, oblique))).toContain(
      `feat_replace/plane/${BOX}/+Z`,
    );
  });
});

describe("thicken / draft", () => {
  it("names the cavity walls after the faces they offset", () => {
    const kernel = occtKernelFromRuntime(runtime);
    const hollow = unwrapKernelResult(
      kernel.thicken({
        featureId: "feat_thicken",
        target: boxOf(kernel, 30),
        thickness: length(2),
      }),
      "thicken",
    );
    expect(volumeOf(kernel, hollow)).toBeCloseTo(30 * 20 * 10 - 26 * 16 * 6, 6);
    const faces = namedFaces(snapshotOf(kernel, hollow));
    expect(faces).toHaveLength(12);
    expect(faces).toContain(`${BOX}/+X`);
    expect(faces).toContain(`feat_thicken/inner/${BOX}/+X`);
  });

  it("keeps every face's name through the draft", () => {
    const kernel = occtKernelFromRuntime(runtime);
    const plain = unwrapKernelResult(
      kernel.extrude({
        featureId: "feat_plain",
        loop: rectangle(30, 20),
        height: length(10),
        direction: 1,
        placement: PLACEMENT,
      }),
      "extrude",
    );
    const tapered = unwrapKernelResult(
      kernel.extrude({
        featureId: "feat_plain",
        loop: rectangle(30, 20),
        height: length(10),
        direction: 1,
        placement: PLACEMENT,
        taper: angle(5, "deg"),
      }),
      "extrude",
    );
    expect(volumeOf(kernel, tapered)).toBeLessThan(volumeOf(kernel, plain));
    expect([...namedFaces(snapshotOf(kernel, tapered))].sort()).toEqual(
      [...namedFaces(snapshotOf(kernel, plain))].sort(),
    );
  });
});

describe("sweep / loft", () => {
  it("names the pipe walls by segment and its caps", () => {
    const kernel = occtKernelFromRuntime(runtime);
    const swept = unwrapKernelResult(
      kernel.sweep({
        featureId: "feat_sweep",
        loop: rectangle(6, 4),
        path: [{ kind: "line", start: [0, 0], end: [0, 30] }],
        placement: PLACEMENT,
      }),
      "sweep",
    );
    expect(volumeOf(kernel, swept)).toBeCloseTo(6 * 4 * 30, 6);
    const faces = namedFaces(snapshotOf(kernel, swept));
    expect(faces).toHaveLength(6);
    expect(faces).toContain("feat_sweep/start");
    expect(faces).toContain("feat_sweep/end");
    expect(
      faces.filter((name) => name.startsWith("feat_sweep/side/")),
    ).toHaveLength(4);
  });

  it("names each span's ruled walls and keeps them across an edit", () => {
    const kernel = occtKernelFromRuntime(runtime);
    const loftOf = (width: number) =>
      unwrapKernelResult(
        kernel.loft({
          featureId: "feat_loft",
          sections: [
            { loop: rectangle(width, 10), z: length(0) },
            { loop: rectangle(10, 10), z: length(8) },
            { loop: rectangle(width, 10), z: length(16) },
          ],
          placement: PLACEMENT,
        }),
        "loft",
      );
    const first = namedFaces(snapshotOf(kernel, loftOf(20)));
    expect(first).toHaveLength(10);
    expect(first).toContain("feat_loft/start");
    expect(first).toContain("feat_loft/end");
    expect(
      first.filter((name) => name.startsWith("feat_loft/side/0/")),
    ).toHaveLength(4);
    expect(
      first.filter((name) => name.startsWith("feat_loft/side/1/")),
    ).toHaveLength(4);
    const edited = namedFaces(snapshotOf(kernel, loftOf(26)));
    expect([...edited].sort()).toEqual([...first].sort());
  });
});

describe("pattern instances / mirror", () => {
  function patterned(kernel: Kernel, width: number): KernelSolid {
    const seed = boxOf(kernel, width);
    const copies = [1, 2].map((index) =>
      unwrapKernelResult(
        kernel.transform(seed, {
          x: length(index * (width + 10)),
          y: length(0),
          z: length(0),
          instance: { featureId: "feat_pattern", index },
        }),
        "transform",
      ),
    );
    return unwrapKernelResult(kernel.union([seed, ...copies]), "union");
  }

  it("names each copy under its instance and survives a dimension edit", () => {
    const kernel = occtKernelFromRuntime(runtime);
    const first = snapshotOf(kernel, patterned(kernel, 30), 1);
    const faces = namedFaces(first);
    expect(faces).toHaveLength(18);
    expect(faces).toContain(`${BOX}/+X`);
    expect(faces).toContain(`feat_pattern/instance/2/${BOX}/+X`);
    const reference = mint(first, `feat_pattern/instance/1/${BOX}/-X`);
    const second = snapshotOf(kernel, patterned(kernel, 36), 2);
    namedFaces(second);
    expect(stateOf(reference, second)).toBe("valid");
  });

  it("names the mirror copy under the feature", () => {
    const kernel = occtKernelFromRuntime(runtime);
    const seed = boxOf(kernel, 30);
    const mirrored = unwrapKernelResult(
      kernel.mirror(seed, {
        axis: "x",
        offset: length(-5),
        featureId: "feat_mirror",
      }),
      "mirror",
    );
    const union = unwrapKernelResult(kernel.union([seed, mirrored]), "union");
    const faces = namedFaces(snapshotOf(kernel, union));
    expect(faces).toHaveLength(12);
    expect(faces).toContain(`feat_mirror/mirror/${BOX}/+X`);
  });

  it("names a featureless mirror copy under the operation's own name", () => {
    const kernel = occtKernelFromRuntime(runtime);
    const seed = boxOf(kernel, 30);
    const mirrored = unwrapKernelResult(
      kernel.mirror(seed, { axis: "x", offset: length(-5) }),
      "mirror",
    );
    const union = unwrapKernelResult(kernel.union([seed, mirrored]), "union");
    const faces = namedFaces(snapshotOf(kernel, union));
    expect(faces).toHaveLength(12);
    expect(new Set(faces).size).toBe(12);
    expect(faces).toContain(`${BOX}/+X`);
    expect(faces).toContain(`mirror/mirror/${BOX}/+X`);
  });
});

describe("split (bridge)", () => {
  const pWidth = createParameterId("param_names_split_w");
  const pDepth = createParameterId("param_names_split_d");
  const pHeight = createParameterId("param_names_split_h");
  const pSide = createParameterId("param_names_split_side");
  const bSplit = createBodyId("body_names_split");
  const fSplitBox = createFeatureId("feat_names_split_box");
  const fSplit = createFeatureId("feat_names_split");
  const dPlane = createDatumId("dtm_names_split_plane");

  /** A w × 20 × 10 box split at mid-height, keeping the +z half. */
  function splitDocument(): CadDocument {
    let document = createDocument(createDocumentId("doc_names_split"));
    const datum = addDocumentDatum(document, {
      id: dPlane,
      name: "split plane",
      datum: {
        formatVersion: 1,
        datumType: "plane",
        definition: "originFrame",
        origin: [0, 0, 5],
        normal: [0, 0, 1],
        xAxis: [1, 0, 0],
      },
    });
    if (!datum.ok) throw new Error(datum.error.message);
    document = datum.value.document;
    for (const [id, name, value] of [
      [pWidth, "boxWidth", length(30)],
      [pDepth, "boxDepth", length(20)],
      [pHeight, "boxHeight", length(10)],
      [pSide, "splitSide", dimensionless(1)],
    ] as const) {
      const added = addDocumentParameter(document, { id, name, value });
      if (!added.ok) throw new Error(added.error.message);
      document = added.value.document;
    }
    const added = addBody(document, { id: bSplit, name: "split" });
    if (!added.ok) throw new Error(added.error.message);
    document = added.value.document;
    for (const feature of [
      {
        id: fSplitBox,
        kind: "box",
        inputs: [
          { kind: "parameter", id: pWidth },
          { kind: "parameter", id: pDepth },
          { kind: "parameter", id: pHeight },
        ],
        outputs: [bSplit],
      },
      {
        id: fSplit,
        kind: "split",
        inputs: [
          { kind: "feature", id: fSplitBox },
          { kind: "datum", id: dPlane },
          { kind: "parameter", id: pSide },
        ],
        outputs: [bSplit],
      },
    ] as const) {
      const addedFeature = addFeature(document, feature);
      if (!addedFeature.ok) throw new Error(addedFeature.error.message);
      document = addedFeature.value.document;
    }
    return document;
  }

  /** Regenerates the document on a fresh OCCT kernel: the split solid. */
  function runSplit(document: CadDocument) {
    const kernel = occtKernelFromRuntime(runtime);
    const bridge = createKernelFeatureExecutor(kernel, {
      document,
      bodies: new Map(),
      profiles: () => ({
        ok: false,
        error: {
          code: "document/not-found",
          message: "the split resolves no sketches",
          input: null,
        },
      }),
    });
    const run = regenerate({
      features: document.features,
      states: initialRegenerationStates(document.features),
      suppressed: [],
      execute: bridge.executor,
    });
    if (!run.ok) throw new Error(run.error.message);
    expect(run.value.executed).toEqual([fSplitBox, fSplit]);
    const solid = bridge.solidOf(bSplit);
    if (solid === undefined) throw new Error("the split body has no solid");
    return { kernel, solid };
  }

  it("names the cut face under the split's tool and survives a width edit", () => {
    const document = splitDocument();
    const first = runSplit(document);
    expect(volumeOf(first.kernel, first.solid)).toBeCloseTo(30 * 20 * 5, 6);
    const firstSnapshot = snapshotOf(first.kernel, first.solid, 1);
    const faces = namedFaces(firstSnapshot);
    expect(faces).toHaveLength(6);
    expect(faces).toContain(`${fSplitBox}/+Z`);
    expect(faces).not.toContain(`${fSplitBox}/-Z`);
    const cut = faces.filter((name) => name.startsWith(`${fSplit}/tool/`));
    expect(cut).toEqual([`${fSplit}/tool/start`]);
    const cutReference = mint(firstSnapshot, `${fSplit}/tool/start`);
    const sideReference = mint(firstSnapshot, `${fSplitBox}/+X`);
    const edited = applyCommand(document, {
      type: "parameter.set",
      id: pWidth,
      value: length(42),
    });
    if (!edited.ok) throw new Error(edited.error.message);
    const second = runSplit(edited.value);
    expect(volumeOf(second.kernel, second.solid)).toBeCloseTo(42 * 20 * 5, 6);
    const secondSnapshot = snapshotOf(second.kernel, second.solid, 2);
    expect([...namedFaces(secondSnapshot)].sort()).toEqual([...faces].sort());
    expect(stateOf(cutReference, secondSnapshot)).toBe("valid");
    expect(stateOf(sideReference, secondSnapshot)).toBe("valid");
  });
});

describe("hole tools (bridge)", () => {
  const pWidth = createParameterId("param_names_holes_w");
  const pDepth = createParameterId("param_names_holes_d");
  const pHeight = createParameterId("param_names_holes_h");
  const pDiameter = createParameterId("param_names_holes_diameter");
  const pHoleDepth = createParameterId("param_names_holes_depth");
  const pAx = createParameterId("param_names_holes_a_x");
  const pBx = createParameterId("param_names_holes_b_x");
  const pY = createParameterId("param_names_holes_y");
  const pAxis = createParameterId("param_names_holes_axis");
  const bHoles = createBodyId("body_names_holes");
  const fHolesBox = createFeatureId("feat_names_holes_box");
  const fHoleA = createFeatureId("feat_names_hole_a");
  const fHoleB = createFeatureId("feat_names_hole_b");

  /** A 30 × 20 × 10 box with two blind Ø4 × 4 holes on its top face. */
  function holesDocument(): CadDocument {
    let document = createDocument(createDocumentId("doc_names_holes"));
    for (const [id, name, value] of [
      [pWidth, "boxWidth", length(30)],
      [pDepth, "boxDepth", length(20)],
      [pHeight, "boxHeight", length(10)],
      [pDiameter, "holeDiameter", length(4)],
      [pHoleDepth, "holeDepth", length(4)],
      [pAx, "holeAX", length(8)],
      [pBx, "holeBX", length(20)],
      [pY, "holeY", length(10)],
      [pAxis, "holeAxis", dimensionless(3)],
    ] as const) {
      const added = addDocumentParameter(document, { id, name, value });
      if (!added.ok) throw new Error(added.error.message);
      document = added.value.document;
    }
    const added = addBody(document, { id: bHoles, name: "holes" });
    if (!added.ok) throw new Error(added.error.message);
    document = added.value.document;
    const holeOf = (
      id: typeof fHoleA,
      target: typeof fHolesBox,
      x: typeof pAx,
    ) =>
      ({
        id,
        kind: "hole",
        inputs: [
          { kind: "feature", id: target },
          { kind: "parameter", id: pDiameter },
          { kind: "parameter", id: pHoleDepth },
          { kind: "parameter", id: x },
          { kind: "parameter", id: pY },
          { kind: "parameter", id: pAxis },
        ],
        outputs: [bHoles],
      }) as const;
    for (const feature of [
      {
        id: fHolesBox,
        kind: "box",
        inputs: [
          { kind: "parameter", id: pWidth },
          { kind: "parameter", id: pDepth },
          { kind: "parameter", id: pHeight },
        ],
        outputs: [bHoles],
      } as const,
      holeOf(fHoleA, fHolesBox, pAx),
      holeOf(fHoleB, fHoleA, pBx),
    ]) {
      const addedFeature = addFeature(document, feature);
      if (!addedFeature.ok) throw new Error(addedFeature.error.message);
      document = addedFeature.value.document;
    }
    return document;
  }

  /** Regenerates the document on a fresh OCCT kernel: the holed solid. */
  function runHoles(document: CadDocument) {
    const kernel = occtKernelFromRuntime(runtime);
    const bridge = createKernelFeatureExecutor(kernel, {
      document,
      bodies: new Map(),
      profiles: () => ({
        ok: false,
        error: {
          code: "document/not-found",
          message: "holes resolve no sketches",
          input: null,
        },
      }),
    });
    const run = regenerate({
      features: document.features,
      states: initialRegenerationStates(document.features),
      suppressed: [],
      execute: bridge.executor,
    });
    if (!run.ok) throw new Error(run.error.message);
    expect(run.value.executed).toEqual([fHolesBox, fHoleA, fHoleB]);
    const solid = bridge.solidOf(bHoles);
    if (solid === undefined) throw new Error("the holed body has no solid");
    return { kernel, solid };
  }

  /** The body-relative x of the face a reference resolves to. */
  function resolvedX(
    reference: TopologyEntityReference,
    snapshot: TopologySnapshot,
  ): number {
    const resolved = resolveTopologyReference(reference, snapshot);
    if (!resolved.ok) throw new Error(resolved.error.message);
    expect(resolved.value.validity.state).toBe("valid");
    const entity = snapshot.entities.find(
      (candidate) =>
        candidate.kind === "face" &&
        candidate.ordinal === resolved.value.validity.ordinal,
    );
    const x = entity?.geometry.centroidRelativeMm?.[0];
    if (x === undefined) throw new Error("the resolved face has no centroid");
    return x;
  }

  it("names each hole's faces under its own feature across a reordering edit", () => {
    const document = holesDocument();
    const holeVolume = Math.PI * 2 ** 2 * 4;
    const first = runHoles(document);
    expect(volumeOf(first.kernel, first.solid)).toBeCloseTo(
      30 * 20 * 10 - 2 * holeVolume,
      6,
    );
    const firstSnapshot = snapshotOf(first.kernel, first.solid, 1);
    const faces = namedFaces(firstSnapshot);
    const toolFaces = (feature: string) =>
      faces.filter((name) => name.startsWith(`${feature}/tool/`)).sort();
    const aFaces = toolFaces(fHoleA);
    const bFaces = toolFaces(fHoleB);
    expect(aFaces.length).toBeGreaterThan(0);
    expect(bFaces).toEqual(
      aFaces.map((name) => name.replace(`${fHoleA}/`, `${fHoleB}/`)),
    );
    expect(faces.some((name) => name.startsWith("extrude/"))).toBe(false);
    const wallName = (feature: string) =>
      toolFaces(feature).find((name) => name.includes("/side/")) ?? "";
    const aWall = mint(firstSnapshot, wallName(fHoleA));
    const bWall = mint(firstSnapshot, wallName(fHoleB));
    expect(resolvedX(aWall, firstSnapshot)).toBeLessThan(0);
    expect(resolvedX(bWall, firstSnapshot)).toBeGreaterThan(0);

    // Hole A moves from x = 8 past hole B (x = 20) to x = 26: the walls'
    // geometric order swaps, their feature-scoped names do not.
    const edited = applyCommand(document, {
      type: "parameter.set",
      id: pAx,
      value: length(26),
    });
    if (!edited.ok) throw new Error(edited.error.message);
    const second = runHoles(edited.value);
    const secondSnapshot = snapshotOf(second.kernel, second.solid, 2);
    expect([...namedFaces(secondSnapshot)].sort()).toEqual([...faces].sort());
    const movedA = resolvedX(aWall, secondSnapshot);
    const keptB = resolvedX(bWall, secondSnapshot);
    expect(movedA).toBeGreaterThan(keptB);
    expect(movedA - keptB).toBeCloseTo(6, 6);
  });
});
