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
import { beforeAll, describe, expect, it } from "vitest";
import type { OpenCascadeInstance, TopoDS_Shape } from "replicad-opencascadejs";

import {
  createOcctRuntime,
  RUNTIME_BRAND,
  type OcctRuntime,
} from "./occt-runtime";
import {
  OCCT_SHAPE_HASH_UPPER_BOUND,
  occtShapeTopology,
} from "./occt-topology";

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
