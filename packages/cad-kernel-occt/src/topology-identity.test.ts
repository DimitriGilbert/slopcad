/**
 * Phase 22 identity experiments — the committed probes that decided the
 * persistent-reference model (see cad-core's `persistent-reference.ts` and
 * `docs/architecture/adr-persistent-references.md`). These tests work
 * directly against the WASM instance (module-internal, through the runtime
 * brand) because they measure the KERNEL's identity behavior, not the
 * adapter's: `ReplicadShapeHasher.HashCode` face/edge identity across every
 * change class, plus the geometric stability that turned out to be the only
 * cross-regeneration carrier.
 *
 * Each block states its finding as assertions; the model and the ADR cite
 * them. The WASM runtime is initialized once per context (the runtime's
 * memoization), so "fresh kernel" below means a fresh allocation lineage in
 * one process — the regeneration setting the reference model targets.
 */

import { readFileSync } from "node:fs";
import {
  angle,
  createBodyId,
  length,
  type TopologyEntitySnapshot,
} from "@slopcad/cad-core";
import {
  type KernelSolid,
  type ProfileSegmentInput,
  unwrapKernelResult,
} from "@slopcad/cad-kernel";
import { beforeAll, describe, expect, it } from "vitest";
import type { OpenCascadeInstance, TopoDS_Shape } from "replicad-opencascadejs";

import { occtKernelFromRuntime } from "./occt-kernel";
import {
  createOcctRuntime,
  RUNTIME_BRAND,
  type OcctRuntime,
} from "./occt-runtime";
import {
  OCCT_NAME_IDENTITY_SCHEMA,
  OCCT_SHAPE_HASH_UPPER_BOUND,
  occtRankDuplicateNames,
  occtShapeTopology,
} from "./occt-topology";
import { untracked } from "./test-support";

let runtime: OcctRuntime;
let oc: OpenCascadeInstance;

beforeAll(async () => {
  runtime = await createOcctRuntime();
  oc = runtime[RUNTIME_BRAND];
});

// --- shape-building helpers (the kernel's own op sequence, unrolled) ------

function box(width: number, depth: number, height: number): TopoDS_Shape {
  const maker = new oc.BRepPrimAPI_MakeBox(width, depth, height);
  const shape = maker.Shape();
  maker.delete();
  return shape;
}

function cylinderAt(
  radius: number,
  height: number,
  x: number,
  y: number,
): TopoDS_Shape {
  const maker = new oc.BRepPrimAPI_MakeCylinder(radius, height);
  const raw = maker.Shape();
  maker.delete();
  const moved = translated(raw, x, y, 0);
  raw.delete();
  return moved;
}

function translated(
  shape: TopoDS_Shape,
  dx: number,
  dy: number,
  dz: number,
): TopoDS_Shape {
  const vec = new oc.gp_Vec(dx, dy, dz);
  const trsf = new oc.gp_Trsf();
  trsf.SetTranslation(vec);
  vec.delete();
  const op = new oc.BRepBuilderAPI_Transform(shape, trsf, false, true);
  trsf.delete();
  const moved = op.Shape();
  op.delete();
  return moved;
}

function cut(a: TopoDS_Shape, b: TopoDS_Shape): TopoDS_Shape {
  const algo = new oc.BRepAlgoAPI_Cut(a, b);
  const shape = algo.Shape();
  algo.delete();
  return shape;
}

/** The plate-with-hole scene: 30×20×10 plate, ⌀8 bore at (15, 10). */
function plateWithHole(): TopoDS_Shape {
  const plate = box(30, 20, 10);
  const bore = cylinderAt(4, 10, 15, 10);
  const result = cut(plate, bore);
  plate.delete();
  bore.delete();
  return result;
}

// --- measurement helpers ---------------------------------------------------

interface FaceFingerprint {
  readonly hash: number;
  readonly area: number;
  readonly centroid: readonly [number, number, number];
}

function faceFingerprints(shape: TopoDS_Shape): FaceFingerprint[] {
  const out: FaceFingerprint[] = [];
  const explorer = new oc.TopExp_Explorer(
    shape,
    oc.TopAbs_ShapeEnum.TopAbs_FACE,
  );
  while (explorer.More()) {
    const face = explorer.Value();
    const props = new oc.GProp_GProps();
    oc.BRepGProp.SurfaceProperties(face, props, true, false);
    const com = props.CentreOfMass();
    out.push({
      hash: oc.ReplicadShapeHasher.HashCode(face, OCCT_SHAPE_HASH_UPPER_BOUND),
      area: props.Mass(),
      centroid: [com.X(), com.Y(), com.Z()],
    });
    com.delete();
    props.delete();
    explorer.Next();
  }
  explorer.delete();
  return out;
}

function hashesOf(fingerprints: readonly FaceFingerprint[]): Set<number> {
  return new Set(fingerprints.map((fingerprint) => fingerprint.hash));
}

function overlap(
  a: readonly FaceFingerprint[],
  b: readonly FaceFingerprint[],
): number {
  const other = hashesOf(b);
  return a.filter((fingerprint) => other.has(fingerprint.hash)).length;
}

function areasOf(fingerprints: readonly FaceFingerprint[]): number[] {
  return fingerprints.map((fingerprint) => fingerprint.area);
}

describe("experiment (a): rebuild-identical (same feature graph, fresh builds)", () => {
  it("mints a COMPLETELY fresh face-hash set at every rebuild — identity is allocation-derived", () => {
    const build1 = plateWithHole();
    const build2 = plateWithHole();
    const f1 = faceFingerprints(build1);
    const f2 = faceFingerprints(build2);
    // Both are the true plate topology: 7 faces, all distinct hashes.
    expect(f1).toHaveLength(7);
    expect(f2).toHaveLength(7);
    expect(hashesOf(f1).size).toBe(7);
    expect(hashesOf(f2).size).toBe(7);
    // The decisive finding: zero hash survives the rebuild.
    expect(overlap(f1, f2)).toBe(0);
    build1.delete();
    build2.delete();
  });

  it("preserves the area AND centroid sequences bitwise, in the same exploration order", () => {
    const build1 = plateWithHole();
    const build2 = plateWithHole();
    const f1 = faceFingerprints(build1);
    const f2 = faceFingerprints(build2);
    expect(areasOf(f1)).toEqual(areasOf(f2));
    expect(f1.map((f) => f.centroid)).toEqual(f2.map((f) => f.centroid));
    build1.delete();
    build2.delete();
  });

  it("does the same for a plain primitive rebuild (width 30 → 31, topology preserved)", () => {
    const w1 = box(30, 20, 10);
    const w2 = box(31, 20, 10);
    const f1 = faceFingerprints(w1);
    const f2 = faceFingerprints(w2);
    expect(f1).toHaveLength(6);
    expect(overlap(f1, f2)).toBe(0);
    // Same face count, changed geometry: the x-normal faces keep their
    // areas (the box deepens only in x), every other face grows.
    const expected = [200, 200, 310, 310, 620, 620];
    expect(f2.map((f) => f.area).length).toBe(expected.length);
    for (let i = 0; i < expected.length; i += 1) {
      const area = f2[i]?.area;
      const want = expected[i];
      if (area === undefined || want === undefined) {
        throw new Error("Invariant violation: six faces exist.");
      }
      expect(Math.abs(area - want)).toBeLessThanOrEqual(1e-9 * want);
    }
    w1.delete();
    w2.delete();
  });
});

describe("experiment (b): harmless parameter change (translate tweak)", () => {
  it("changes every face hash (location participates) but preserves areas bitwise and shifts centroids exactly", () => {
    const before = plateWithHole();
    const after = translated(before, 5, 0, 0);
    const fb = faceFingerprints(before);
    const fa = faceFingerprints(after);
    expect(overlap(fb, fa)).toBe(0);
    // Areas bitwise equal in exploration order.
    expect(areasOf(fa)).toEqual(areasOf(fb));
    // Every centroid shifted by exactly [5, 0, 0] — so body-relative
    // centroids are rigid-translation-invariant (the repair heuristic's
    // ground).
    for (let i = 0; i < fb.length; i += 1) {
      const from = fb[i];
      const to = fa[i];
      if (from === undefined || to === undefined) {
        throw new Error("Invariant violation: equal-length sequences.");
      }
      expect(to.centroid[0]).toBe(from.centroid[0] + 5);
      expect(to.centroid[1]).toBe(from.centroid[1]);
      expect(to.centroid[2]).toBe(from.centroid[2]);
    }
    before.delete();
    after.delete();
  });
});

describe("experiment (c): topology-preserving boolean re-run", () => {
  it("produces a fresh hash set for the same boolean — no cross-run identity", () => {
    const run1 = plateWithHole();
    const plate = box(30, 20, 10);
    const bore = cylinderAt(4, 10, 15, 10);
    const run2 = cut(plate, bore);
    plate.delete();
    bore.delete();
    const f1 = faceFingerprints(run1);
    const f2 = faceFingerprints(run2);
    expect(overlap(f1, f2)).toBe(0);
    expect(areasOf(f1)).toEqual(areasOf(f2));
    run1.delete();
    run2.delete();
  });
});

describe("experiment (d): topology-CHANGING operation (a new subtract splitting faces)", () => {
  // A wall (2×20×4 at x ∈ [14,16], z ∈ [6,10]) cut from the plate splits
  // the top face into two and trims the y-normal faces; the x-normal faces
  // and the bottom face are untouched.
  function splitPlate(): {
    readonly before: readonly FaceFingerprint[];
    readonly after: readonly FaceFingerprint[];
    readonly beforeShape: TopoDS_Shape;
    readonly afterShape: TopoDS_Shape;
  } {
    const beforeShape = plateWithHole();
    const before = faceFingerprints(beforeShape);
    const wall = translated(box(2, 20, 4), 14, 0, 6);
    const afterShape = cut(beforeShape, wall);
    wall.delete();
    const after = faceFingerprints(afterShape);
    return { before, after, beforeShape, afterShape };
  }

  it("keeps identity of untouched faces within the live lineage (3 of 7 survive)", () => {
    const { before, after, beforeShape, afterShape } = splitPlate();
    expect(after).toHaveLength(14);
    expect(overlap(before, after)).toBe(3);
    beforeShape.delete();
    afterShape.delete();
  });

  it("invalidates the touched faces explicitly — their hashes vanish from the result", () => {
    const { before, after, beforeShape, afterShape } = splitPlate();
    const afterHashes = hashesOf(after);
    const vanished = before.filter(
      (fingerprint) => !afterHashes.has(fingerprint.hash),
    );
    // The top face (area 600 minus the bore's 251.3 footprint region
    // measured ≈ 549.73) and both trimmed y-normal faces are gone.
    expect(vanished).toHaveLength(4);
    const topArea = 600 - Math.PI * 4 * 4;
    expect(
      vanished.some(
        (fingerprint) => Math.abs(fingerprint.area - topArea) < 1e-9,
      ),
    ).toBe(true);
    beforeShape.delete();
    afterShape.delete();
  });

  it("mints fresh identity for new faces (11 fresh hashes appear)", () => {
    const { before, after, beforeShape, afterShape } = splitPlate();
    const beforeHashes = hashesOf(before);
    const fresh = after.filter(
      (fingerprint) => !beforeHashes.has(fingerprint.hash),
    );
    expect(fresh).toHaveLength(11);
    // The two halves of the split top face are among them: fresh faces at
    // z ≈ 10, equal in area to each other (within last-ulp drift).
    const halves = fresh.filter(
      (fingerprint) => Math.abs(fingerprint.centroid[2] - 10) < 1e-9,
    );
    expect(halves).toHaveLength(2);
    const [first, second] = halves;
    if (first === undefined || second === undefined) {
      throw new Error("Invariant violation: two halves exist.");
    }
    expect(Math.abs(first.area - second.area)).toBeLessThanOrEqual(1e-9);
    expect(first.hash).not.toBe(second.hash);
    beforeShape.delete();
    afterShape.delete();
  });
});

describe("experiment (e): serialization round trip (BREP string, same process)", () => {
  it("destroys every hash while preserving areas to last-ulp precision", () => {
    const shape = plateWithHole();
    const text = oc.BRepToolsWrapper.Write(shape);
    const readBack = oc.BRepToolsWrapper.Read(text);
    const original = faceFingerprints(shape);
    const roundTripped = faceFingerprints(readBack);
    expect(overlap(original, roundTripped)).toBe(0);
    const sortedOriginal = [...areasOf(original)].sort((a, b) => a - b);
    const sortedRound = [...areasOf(roundTripped)].sort((a, b) => a - b);
    expect(sortedRound.length).toBe(sortedOriginal.length);
    for (let i = 0; i < sortedOriginal.length; i += 1) {
      const a = sortedOriginal[i];
      const b = sortedRound[i];
      if (a === undefined || b === undefined) {
        throw new Error("Invariant violation: equal-length sequences.");
      }
      expect(Math.abs(a - b)).toBeLessThanOrEqual(1e-12 * Math.max(1, a));
    }
    readBack.delete();
    shape.delete();
  });

  it("does NOT preserve exploration order across serialization — order is no identity key", () => {
    const shape = plateWithHole();
    const text = oc.BRepToolsWrapper.Write(shape);
    const readBack = oc.BRepToolsWrapper.Read(text);
    const original = areasOf(faceFingerprints(shape));
    const roundTripped = areasOf(faceFingerprints(readBack));
    expect(roundTripped).not.toEqual(original);
    readBack.delete();
    shape.delete();
  });

  it("shows the same cross-process: the committed fixture's hashes are fresh, its areas match", () => {
    // fixtures/plate-with-hole.brep was written by a DIFFERENT process
    // (the Phase 21.5 fixture script) — a genuine cross-process identity
    // probe without spawning one.
    const fixtureBytes = readFileSync(
      new URL("../fixtures/plate-with-hole.brep", import.meta.url),
    );
    const fixtureShape = oc.BRepToolsWrapper.Read(
      new TextDecoder().decode(fixtureBytes),
    );
    const fresh = plateWithHole();
    const fixtureFingerprints = faceFingerprints(fixtureShape);
    const freshFingerprints = faceFingerprints(fresh);
    expect(overlap(fixtureFingerprints, freshFingerprints)).toBe(0);
    const sortedFixture = [...areasOf(fixtureFingerprints)].sort(
      (a, b) => a - b,
    );
    const sortedFresh = [...areasOf(freshFingerprints)].sort((a, b) => a - b);
    for (let i = 0; i < sortedFixture.length; i += 1) {
      const a = sortedFixture[i];
      const b = sortedFresh[i];
      if (a === undefined || b === undefined) {
        throw new Error("Invariant violation: equal-length sequences.");
      }
      expect(Math.abs(a - b)).toBeLessThanOrEqual(1e-12 * Math.max(1, a));
    }
    fixtureShape.delete();
    fresh.delete();
  });
});

describe("experiment (f): symmetric split — geometric twins", () => {
  it("produces two equal-area top faces with distinct centroids and distinct hashes", () => {
    const symmetric = box(20, 20, 10);
    const wall = translated(box(2, 20, 4), 9, 0, 6);
    const split = cut(symmetric, wall);
    wall.delete();
    symmetric.delete();
    const tops = faceFingerprints(split).filter(
      (fingerprint) => Math.abs(fingerprint.centroid[2] - 10) < 1e-9,
    );
    expect(tops).toHaveLength(2);
    const [first, second] = tops;
    if (first === undefined || second === undefined) {
      throw new Error("Invariant violation: two top faces exist.");
    }
    expect(first.area).toBe(second.area);
    expect(first.hash).not.toBe(second.hash);
    // Mirrored about the body centre — equal area, distinguishable by
    // body-relative position, which is exactly what the repair heuristic
    // keys on.
    expect(first.centroid[0] + second.centroid[0]).toBeCloseTo(20);
    split.delete();
  });
});

describe("experiment (g): one TShape explored twice — real identity collision", () => {
  it("yields the same hash for every repeated occurrence", () => {
    const compound = new oc.TopoDS_Compound();
    const builder = new oc.TopoDS_Builder();
    builder.MakeCompound(compound);
    const shared = box(10, 10, 10);
    builder.Add(compound, shared);
    builder.Add(compound, shared);
    builder.delete();
    const fingerprints = faceFingerprints(compound);
    expect(fingerprints).toHaveLength(12);
    expect(hashesOf(fingerprints).size).toBe(6);
    shared.delete();
    compound.delete();
  });
});

describe("experiment (j): occurrence exploration (the snapshot's dedupe ground)", () => {
  it("explores every solid edge twice (once per adjacent face) with the same hash", () => {
    const shape = plateWithHole();
    const hashes: number[] = [];
    const explorer = new oc.TopExp_Explorer(
      shape,
      oc.TopAbs_ShapeEnum.TopAbs_EDGE,
    );
    while (explorer.More()) {
      hashes.push(
        oc.ReplicadShapeHasher.HashCode(
          explorer.Value(),
          OCCT_SHAPE_HASH_UPPER_BOUND,
        ),
      );
      explorer.Next();
    }
    explorer.delete();
    expect(hashes).toHaveLength(30);
    expect(new Set(hashes).size).toBe(15);
    shape.delete();
  });

  it("collapses occurrences in the produced snapshot: 15 distinct edges, 7 faces", () => {
    const shape = plateWithHole();
    const entities = occtShapeTopology(oc, shape, ["face", "edge", "vertex"]);
    const faces = entities.filter((entity) => entity.kind === "face");
    const edges = entities.filter((entity) => entity.kind === "edge");
    const vertices = entities.filter((entity) => entity.kind === "vertex");
    expect(faces).toHaveLength(7);
    expect(edges).toHaveLength(15);
    // Exactly 10 distinct vertex identities: the 8 box corners plus ONE
    // seam vertex per bore circle (each periodic circle edge carries a
    // single vertex, shared with the bore wall's seam edge — collapsed by
    // identity like every repeated occurrence).
    expect(vertices).toHaveLength(10);
    const edgeIdentityCounts = new Set(
      edges.map((entity) => JSON.stringify(entity.identity?.data)),
    );
    expect(edgeIdentityCounts.size).toBe(15);
    shape.delete();
  });
});

// --- Phase N1: history-based names (through the kernel adapter) -----------

type Kernel = ReturnType<typeof occtKernelFromRuntime>;

const namingBody = createBodyId("body_named");

function namedEntities(
  kernel: Kernel,
  solid: KernelSolid,
): readonly TopologyEntitySnapshot[] {
  return unwrapKernelResult(
    kernel.topologySnapshot(solid, { bodyId: namingBody, regeneration: 0 }),
    "topologySnapshot",
  ).entities;
}

/** `kind` → the entity names in snapshot order. */
function namesByKind(
  entities: readonly TopologyEntitySnapshot[],
): Record<string, string[]> {
  const out: Record<string, string[]> = { face: [], edge: [], vertex: [] };
  for (const entity of entities) {
    expect(entity.identity?.schema).toBe(OCCT_NAME_IDENTITY_SCHEMA);
    const name = entity.identity?.data.name;
    expect(typeof name).toBe("string");
    out[entity.kind]?.push(String(name));
  }
  return out;
}

function expectUniquePerKind(names: Record<string, string[]>): void {
  for (const list of Object.values(names)) {
    expect(new Set(list).size).toBe(list.length);
  }
}

/** The named entity's absolute centroid (or point). */
function positionOf(
  entities: readonly TopologyEntitySnapshot[],
  kind: string,
  name: string,
): readonly number[] {
  const entity = entities.find(
    (candidate) =>
      candidate.kind === kind && candidate.identity?.data.name === name,
  );
  const position =
    entity?.geometry.centroidAbsoluteMm ?? entity?.geometry.pointAbsoluteMm;
  if (position === undefined) throw new Error(`no ${kind} named ${name}`);
  return position;
}

/** The named face's cylindrical radius (undefined off a cylinder). */
function cylinderRadiusOf(
  entities: readonly TopologyEntitySnapshot[],
  name: string,
): number | undefined {
  const entity = entities.find(
    (candidate) =>
      candidate.kind === "face" && candidate.identity?.data.name === name,
  );
  if (entity === undefined) throw new Error(`no face named ${name}`);
  return entity.geometry.cylinderRadiusMm;
}

function expectCloseVector(
  actual: readonly number[],
  expected: readonly number[],
): void {
  expect(actual).toHaveLength(expected.length);
  expected.forEach((value, index) => {
    expect(actual[index]).toBeCloseTo(value);
  });
}

function boxSolid(
  kernel: Kernel,
  width: number,
  depth: number,
  height: number,
): KernelSolid {
  return unwrapKernelResult(
    kernel.createBox({
      featureId: "feat_box",
      width: length(width),
      depth: length(depth),
      height: length(height),
    }),
    "createBox",
  );
}

function rectangle(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): ProfileSegmentInput[] {
  return [
    { kind: "line", start: [x0, y0], end: [x1, y0] },
    { kind: "line", start: [x1, y0], end: [x1, y1] },
    { kind: "line", start: [x1, y1], end: [x0, y1] },
    { kind: "line", start: [x0, y1], end: [x0, y0] },
  ];
}

const AT_ORIGIN = {
  rotation: { axis: [0, 0, 1] as const, angle: angle(0) },
  translation: { x: length(0), y: length(0), z: length(0) },
};

function extrudeSolid(
  kernel: Kernel,
  loop: readonly ProfileSegmentInput[],
  height: number,
): KernelSolid {
  return unwrapKernelResult(
    kernel.extrude({
      featureId: "feat_pad",
      loop,
      height: length(height),
      direction: 1,
      placement: {
        rotation: { axis: [1, 0, 0], angle: angle(30, "deg") },
        translation: { x: length(4), y: length(-2), z: length(9) },
      },
    }),
    "extrude",
  );
}

function revolveSolid(
  kernel: Kernel,
  loop: readonly ProfileSegmentInput[],
  degrees: number,
): KernelSolid {
  return unwrapKernelResult(
    kernel.revolve({
      featureId: "feat_turn",
      loop,
      axis: { point: [0, 0], direction: [0, 1] },
      angle: angle(degrees, "deg"),
      placement: AT_ORIGIN,
    }),
    "revolve",
  );
}

describe("Phase N1: history-based names replace the allocation hash", () => {
  it("names box faces by their box-frame role, prefixed by the feature id", () => {
    const kernel = occtKernelFromRuntime(runtime);
    const entities = namedEntities(kernel, boxSolid(kernel, 30, 20, 10));
    const names = namesByKind(entities);
    expect([...(names.face ?? [])].sort()).toEqual(
      ["+X", "+Y", "+Z", "-X", "-Y", "-Z"].map((role) => `feat_box/${role}`),
    );
    expect(positionOf(entities, "face", "feat_box/+X")[0]).toBeCloseTo(30);
    expect(positionOf(entities, "face", "feat_box/-X")[0]).toBeCloseTo(0);
    expect(positionOf(entities, "face", "feat_box/+Y")[1]).toBeCloseTo(20);
    expect(positionOf(entities, "face", "feat_box/-Y")[1]).toBeCloseTo(0);
    expect(positionOf(entities, "face", "feat_box/+Z")[2]).toBeCloseTo(10);
    expect(positionOf(entities, "face", "feat_box/-Z")[2]).toBeCloseTo(0);
    // Derived names: an edge is the sorted pair of its faces, a vertex the
    // sorted set of its three faces.
    expect(names.edge).toContain("feat_box/+X|feat_box/+Z");
    expect(names.vertex).toContain("feat_box/+X&feat_box/+Y&feat_box/+Z");
    expect(names.edge).toHaveLength(12);
    expect(names.vertex).toHaveLength(8);
    expectUniquePerKind(names);
  });

  it("produces identical names on identical rebuilds and across dimension edits (box)", () => {
    const kernel = occtKernelFromRuntime(runtime);
    const first = namesByKind(
      namedEntities(kernel, boxSolid(kernel, 30, 20, 10)),
    );
    const again = namesByKind(
      namedEntities(kernel, boxSolid(kernel, 30, 20, 10)),
    );
    expect(again).toEqual(first);
    const resized = namedEntities(kernel, boxSolid(kernel, 31, 25, 12.5));
    expect(namesByKind(resized)).toEqual(first);
    expect(
      positionOf(resized, "vertex", "feat_box/+X&feat_box/+Y&feat_box/+Z"),
    ).toEqual([31, 25, 12.5]);
  });

  it("names cylinder, cone and sphere faces start/end/lateral/surface, dimension-free", () => {
    const kernel = occtKernelFromRuntime(runtime);
    const cylinder = (radius: number, height: number) =>
      namedEntities(
        kernel,
        unwrapKernelResult(
          kernel.createCylinder({
            featureId: "feat_post",
            radius: length(radius),
            height: length(height),
          }),
          "createCylinder",
        ),
      );
    const small = cylinder(5, 10);
    const names = namesByKind(small);
    expect([...(names.face ?? [])].sort()).toEqual([
      "feat_post/end",
      "feat_post/lateral",
      "feat_post/start",
    ]);
    // The seam lists its one face twice.
    expect(names.edge).toContain("feat_post/lateral|feat_post/lateral");
    expectUniquePerKind(names);
    expect(positionOf(small, "face", "feat_post/end")[2]).toBeCloseTo(10);
    expect(namesByKind(cylinder(5, 10))).toEqual(names);
    expect(namesByKind(cylinder(7.5, 3))).toEqual(names);

    const cone = (bottom: number, top: number, height: number) =>
      namesByKind(
        namedEntities(
          kernel,
          unwrapKernelResult(
            kernel.createCone({
              featureId: "feat_tip",
              bottomRadius: length(bottom),
              topRadius: length(top),
              height: length(height),
            }),
            "createCone",
          ),
        ),
      );
    const frustum = cone(5, 2, 10);
    expect([...(frustum.face ?? [])].sort()).toEqual([
      "feat_tip/end",
      "feat_tip/lateral",
      "feat_tip/start",
    ]);
    expectUniquePerKind(frustum);
    expect(cone(8, 3, 4)).toEqual(frustum);
    const sharp = cone(5, 0, 10);
    expect([...(sharp.face ?? [])].sort()).toEqual([
      "feat_tip/lateral",
      "feat_tip/start",
    ]);
    expectUniquePerKind(sharp);
  });

  it("orders duplicate derived names by body-relative geometry (the sphere's two poles)", () => {
    const kernel = occtKernelFromRuntime(runtime);
    const sphere = (radius: number) =>
      namedEntities(
        kernel,
        unwrapKernelResult(
          kernel.createSphere({
            featureId: "feat_ball",
            radius: length(radius),
          }),
          "createSphere",
        ),
      );
    const entities = sphere(5);
    const names = namesByKind(entities);
    expect(names.face).toEqual(["feat_ball/surface"]);
    // Both poles touch only the one face: the base name repeats and ranks
    // by body-relative position — `#0` the lower pole, `#1` the upper.
    expect([...(names.vertex ?? [])].sort()).toEqual([
      "feat_ball/surface#0",
      "feat_ball/surface#1",
    ]);
    expect(
      positionOf(entities, "vertex", "feat_ball/surface#0")[2],
    ).toBeCloseTo(-5);
    expect(
      positionOf(entities, "vertex", "feat_ball/surface#1")[2],
    ).toBeCloseTo(5);
    expectUniquePerKind(names);
    expect(namesByKind(sphere(12))).toEqual(names);
  });

  it("refuses to guess when no geometry separates duplicates: tied entities share one name", () => {
    expect(
      occtRankDuplicateNames(
        ["a", "b", "a", "a"],
        [
          [0, 0, 1],
          [9, 9, 9],
          [0, 0, -1],
          [0, 0, 1],
        ],
      ),
    ).toEqual(["a#1", "b", "a#0", "a#1"]);
  });

  it("names extrude sides by profile segment and caps start/end, through the placement", () => {
    const kernel = occtKernelFromRuntime(runtime);
    const entities = namedEntities(
      kernel,
      extrudeSolid(kernel, rectangle(0, 0, 10, 5), 7),
    );
    const names = namesByKind(entities);
    // `extrudeSolid`'s placement: 30° about world x, then (4, -2, 9).
    const cos = Math.cos(Math.PI / 6);
    const sin = Math.sin(Math.PI / 6);
    const placed = ([x, y, z]: readonly [number, number, number]) => [
      x + 4,
      y * cos - z * sin - 2,
      y * sin + z * cos + 9,
    ];
    // Each name sits on its own face: the caps on the local z = 0 and
    // z = height planes, side/<i> on segment i swept up the height.
    expectCloseVector(
      positionOf(entities, "face", "feat_pad/start"),
      placed([5, 2.5, 0]),
    );
    expectCloseVector(
      positionOf(entities, "face", "feat_pad/end"),
      placed([5, 2.5, 7]),
    );
    expectCloseVector(
      positionOf(entities, "face", "feat_pad/side/0"),
      placed([5, 0, 3.5]),
    );
    expectCloseVector(
      positionOf(entities, "face", "feat_pad/side/1"),
      placed([10, 2.5, 3.5]),
    );
    expectCloseVector(
      positionOf(entities, "face", "feat_pad/side/2"),
      placed([5, 5, 3.5]),
    );
    expectCloseVector(
      positionOf(entities, "face", "feat_pad/side/3"),
      placed([0, 2.5, 3.5]),
    );
    expect([...(names.face ?? [])].sort()).toEqual([
      "feat_pad/end",
      "feat_pad/side/0",
      "feat_pad/side/1",
      "feat_pad/side/2",
      "feat_pad/side/3",
      "feat_pad/start",
    ]);
    expect(names.edge).toHaveLength(12);
    expect(names.vertex).toHaveLength(8);
    expectUniquePerKind(names);
    // Rebuilt identically and with every dimension edited: same names.
    expect(
      namesByKind(
        namedEntities(kernel, extrudeSolid(kernel, rectangle(0, 0, 10, 5), 7)),
      ),
    ).toEqual(names);
    expect(
      namesByKind(
        namedEntities(kernel, extrudeSolid(kernel, rectangle(-3, 1, 22, 9), 2)),
      ),
    ).toEqual(names);
    const circle = namesByKind(
      namedEntities(
        kernel,
        extrudeSolid(
          kernel,
          [{ kind: "circle", center: [0, 0], radius: 4 }],
          3,
        ),
      ),
    );
    expect([...(circle.face ?? [])].sort()).toEqual([
      "feat_pad/end",
      "feat_pad/side/0",
      "feat_pad/start",
    ]);
    expectUniquePerKind(circle);
  });

  it("names revolve sides by segment, caps only on a partial sweep, dimension-free", () => {
    const kernel = occtKernelFromRuntime(runtime);
    const partial = namesByKind(
      namedEntities(kernel, revolveSolid(kernel, rectangle(2, 0, 12, 5), 90)),
    );
    expect([...(partial.face ?? [])].sort()).toEqual([
      "feat_turn/end",
      "feat_turn/side/0",
      "feat_turn/side/1",
      "feat_turn/side/2",
      "feat_turn/side/3",
      "feat_turn/start",
    ]);
    expectUniquePerKind(partial);
    expect(
      namesByKind(
        namedEntities(kernel, revolveSolid(kernel, rectangle(3, 1, 9, 4), 135)),
      ),
    ).toEqual(partial);
    // A full turn rebuilds its planar annuli (no `Generated` history); the
    // vertex circles still pin them to their segments.
    const fullEntities = namedEntities(
      kernel,
      revolveSolid(kernel, rectangle(2, 0, 12, 5), 360),
    );
    const full = namesByKind(fullEntities);
    // The inferred annuli land on their segments: side/0 (y = 0) and
    // side/2 (y = 5) are the planar rings centred on the axis; side/1
    // (x = 12) and side/3 (x = 2) the outer and inner cylinders.
    expectCloseVector(
      positionOf(fullEntities, "face", "feat_turn/side/0"),
      [0, 0, 0],
    );
    expect(cylinderRadiusOf(fullEntities, "feat_turn/side/0")).toBeUndefined();
    expectCloseVector(
      positionOf(fullEntities, "face", "feat_turn/side/2"),
      [0, 5, 0],
    );
    expect(cylinderRadiusOf(fullEntities, "feat_turn/side/2")).toBeUndefined();
    expect(cylinderRadiusOf(fullEntities, "feat_turn/side/1")).toBeCloseTo(12);
    expect(cylinderRadiusOf(fullEntities, "feat_turn/side/3")).toBeCloseTo(2);
    expect([...(full.face ?? [])].sort()).toEqual([
      "feat_turn/side/0",
      "feat_turn/side/1",
      "feat_turn/side/2",
      "feat_turn/side/3",
    ]);
    expectUniquePerKind(full);
    expect(
      namesByKind(
        namedEntities(kernel, revolveSolid(kernel, rectangle(4, 2, 7, 3), 360)),
      ),
    ).toEqual(full);
  });

  it("keeps the legacy hash schema for solids no history names (a BREP import)", () => {
    const kernel = occtKernelFromRuntime(runtime);
    const solid = untracked(kernel, boxSolid(kernel, 3, 3, 3));
    // Phase N2: a transform carries what it is given — here, no names.
    const moved = unwrapKernelResult(
      kernel.transform(solid, {
        x: length(1),
        y: length(0),
        z: length(0),
      }),
      "transform",
    );
    for (const entity of namedEntities(kernel, moved)) {
      expect(entity.identity?.schema).toBe("occt-shape-hash-v1");
      expect(typeof entity.identity?.data.hash).toBe("number");
    }
  });
});
