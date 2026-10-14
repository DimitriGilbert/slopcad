/**
 * Phase N2a: history-based names carried through the topology-changing
 * operations — booleans, transforms, fillet, chamfer, shell — against the
 * REAL OpenCascade kernel, resolved through cad-core's reference protocol.
 *
 * - box → fillet(edge) → chamfer(edge of the fillet output): every
 *   reference minted on build 1 resolves `valid` on an identical rebuild
 *   and on a box dimension edit, with the chain itself driven by the
 *   resolved references; the volumes match the analytic values.
 * - a boolean that splits a named face names the pieces `name#i` in a
 *   stable body-relative order; the tool's faces carry its own feature.
 * - a deleted face's reference resolves `missing`; the repair fallback
 *   re-anchors a reference into unnamed output and refuses geometric twins.
 */

import { beforeAll, describe, expect, it } from "vitest";
import {
  addBody,
  addFeature,
  createBodyId,
  createDocument,
  createDocumentId,
  createFeatureId,
  createReferenceId,
  length,
  mintTopologyReference,
  referenceProvenance,
  repairTopologyReference,
  resolveTopologyReference,
  type ReferenceProvenance,
  type TopologyEntityReference,
  type TopologySnapshot,
} from "@slopcad/cad-core";
import { type KernelSolid, unwrapKernelResult } from "@slopcad/cad-kernel";

import { occtKernelFromRuntime } from "./occt-kernel";
import { createOcctRuntime, type OcctRuntime } from "./occt-runtime";
import { untracked } from "./test-support";

let runtime: OcctRuntime;

beforeAll(async () => {
  runtime = await createOcctRuntime();
});

type Kernel = ReturnType<typeof occtKernelFromRuntime>;
type Kind = "face" | "edge" | "vertex";

const body = createBodyId("body_part");
const BOX = "feat_box";
const WALL = "feat_wall";
const FILLET = "feat_fillet";
const CHAMFER = "feat_chamfer";
const SHELL = "feat_shell";

/** Distinct reference ids across the file. */
let referenceCount = 0;

/** The provenance every reference below is minted under. */
function provenance(): ReferenceProvenance {
  let document = createDocument(createDocumentId("doc_history_naming"));
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

function boxOf(
  kernel: Kernel,
  featureId: string,
  width: number,
  depth: number,
  height: number,
  at: readonly [number, number, number] = [0, 0, 0],
): KernelSolid {
  const raw = unwrapKernelResult(
    kernel.createBox({
      featureId,
      width: length(width),
      depth: length(depth),
      height: length(height),
    }),
    "createBox",
  );
  if (at.every((value) => value === 0)) return raw;
  return unwrapKernelResult(
    kernel.transform(raw, {
      x: length(at[0]),
      y: length(at[1]),
      z: length(at[2]),
    }),
    "transform",
  );
}

function snapshotOf(
  kernel: Kernel,
  solid: KernelSolid,
  regeneration: number,
): TopologySnapshot {
  return unwrapKernelResult(
    kernel.topologySnapshot(solid, { bodyId: body, regeneration }),
    "topologySnapshot",
  );
}

function entityNamed(snapshot: TopologySnapshot, kind: Kind, name: string) {
  const entity = snapshot.entities.find(
    (candidate) =>
      candidate.kind === kind && candidate.identity?.data.name === name,
  );
  if (entity === undefined) throw new Error(`no ${kind} named ${name}`);
  return entity;
}

function namesOf(snapshot: TopologySnapshot, kind: Kind): string[] {
  return snapshot.entities
    .filter((entity) => entity.kind === kind)
    .map((entity) => String(entity.identity?.data.name));
}

function expectAllNamed(snapshot: TopologySnapshot): void {
  for (const entity of snapshot.entities) {
    expect(entity.identity?.schema).toBe("occt-name/1");
  }
  for (const kind of ["face", "edge", "vertex"] as const) {
    const names = namesOf(snapshot, kind);
    expect(new Set(names).size).toBe(names.length);
  }
}

function mint(
  snapshot: TopologySnapshot,
  kind: Kind,
  name: string,
): TopologyEntityReference {
  const minted = mintTopologyReference(
    snapshot,
    entityNamed(snapshot, kind, name).ordinal,
    provenance(),
    { id: createReferenceId(`ref_${String((referenceCount += 1))}`), kind },
  );
  if (!minted.ok) throw new Error(minted.error.message);
  return minted.value;
}

/** The reference's resolved state and ordinal against `snapshot`. */
function resolve(
  reference: TopologyEntityReference,
  snapshot: TopologySnapshot,
): { state: string; ordinal: number | undefined } {
  const resolved = resolveTopologyReference(reference, snapshot);
  if (!resolved.ok) throw new Error(resolved.error.message);
  return {
    state: resolved.value.validity.state,
    ordinal: resolved.value.validity.ordinal,
  };
}

/** The ordinal a VALID reference resolves to (the chain's own input). */
function ordinalOf(
  reference: TopologyEntityReference,
  snapshot: TopologySnapshot,
): number {
  const resolved = resolve(reference, snapshot);
  expect(resolved.state).toBe("valid");
  if (resolved.ordinal === undefined) throw new Error("no ordinal");
  return resolved.ordinal;
}

function volumeOf(kernel: Kernel, solid: KernelSolid): number {
  return unwrapKernelResult(kernel.volume(solid), "volume");
}

// --- box → fillet → chamfer ------------------------------------------------

const FILLET_EDGE = `${BOX}/+X|${BOX}/+Z`;
const CHAMFER_EDGE = `${BOX}/+Z|${BOX}/-X`;
const FILLET_FACE = `${FILLET}/fillet/${FILLET_EDGE}`;
const CHAMFER_FACE = `${CHAMFER}/chamfer/${CHAMFER_EDGE}`;
const RADIUS = 2;
const DISTANCE = 1;

interface Chain {
  readonly box: TopologySnapshot;
  readonly filleted: TopologySnapshot;
  readonly chamfered: TopologySnapshot;
  readonly volume: number;
}

/** The chain, its edge inputs resolved from the given references. */
function chain(
  kernel: Kernel,
  regeneration: number,
  dimensions: readonly [number, number, number],
  inputs?: {
    readonly filletEdge: TopologyEntityReference;
    readonly chamferEdge: TopologyEntityReference;
  },
): Chain {
  const box = boxOf(kernel, BOX, ...dimensions);
  const boxSnapshot = snapshotOf(kernel, box, regeneration);
  const filletEdge =
    inputs === undefined
      ? entityNamed(boxSnapshot, "edge", FILLET_EDGE).ordinal
      : ordinalOf(inputs.filletEdge, boxSnapshot);
  const filleted = unwrapKernelResult(
    kernel.fillet({
      featureId: FILLET,
      target: box,
      edges: [filletEdge],
      radius: length(RADIUS),
    }),
    "fillet",
  );
  const filletedSnapshot = snapshotOf(kernel, filleted, regeneration);
  const chamferEdge =
    inputs === undefined
      ? entityNamed(filletedSnapshot, "edge", CHAMFER_EDGE).ordinal
      : ordinalOf(inputs.chamferEdge, filletedSnapshot);
  const chamfered = unwrapKernelResult(
    kernel.chamfer({
      featureId: CHAMFER,
      target: filleted,
      edges: [chamferEdge],
      distance: length(DISTANCE),
    }),
    "chamfer",
  );
  return {
    box: boxSnapshot,
    filleted: filletedSnapshot,
    chamfered: snapshotOf(kernel, chamfered, regeneration),
    volume: volumeOf(kernel, chamfered),
  };
}

/** W·D·H − r²(1−π/4)·D − d²/2·D: both cut edges run along y. */
function chainVolume(width: number, depth: number, height: number): number {
  return (
    width * depth * height -
    RADIUS * RADIUS * (1 - Math.PI / 4) * depth -
    ((DISTANCE * DISTANCE) / 2) * depth
  );
}

describe("Phase N2a: box → fillet → chamfer", () => {
  it("names the fillet and chamfer faces after their feature and edge", () => {
    const kernel = occtKernelFromRuntime(runtime);
    const built = chain(kernel, 1, [30, 20, 10]);
    expectAllNamed(built.filleted);
    expectAllNamed(built.chamfered);
    expect(namesOf(built.filleted, "face").sort()).toEqual(
      [
        `${BOX}/+X`,
        `${BOX}/+Y`,
        `${BOX}/+Z`,
        `${BOX}/-X`,
        `${BOX}/-Y`,
        `${BOX}/-Z`,
        FILLET_FACE,
      ].sort(),
    );
    expect(namesOf(built.chamfered, "face")).toContain(CHAMFER_FACE);
    expect(namesOf(built.chamfered, "face")).toHaveLength(8);
    expect(
      entityNamed(built.chamfered, "face", FILLET_FACE).geometry
        .cylinderRadiusMm,
    ).toBeCloseTo(RADIUS);
    // The chamfer face spans d·√2 by the edge length.
    expect(
      entityNamed(built.chamfered, "face", CHAMFER_FACE).geometry.areaMm2,
    ).toBeCloseTo(DISTANCE * Math.SQRT2 * 20, 9);
    expect(
      Math.abs(built.volume - chainVolume(30, 20, 10)) / built.volume,
    ).toBeLessThan(1e-9);
  });

  it("keeps every reference valid across a rebuild and a box dimension edit", () => {
    const kernel = occtKernelFromRuntime(runtime);
    const first = chain(kernel, 1, [30, 20, 10]);
    const inputs = {
      filletEdge: mint(first.box, "edge", FILLET_EDGE),
      chamferEdge: mint(first.filleted, "edge", CHAMFER_EDGE),
    };
    const references = [
      ...namesOf(first.chamfered, "face").map((name) =>
        mint(first.chamfered, "face", name),
      ),
      ...namesOf(first.chamfered, "edge").map((name) =>
        mint(first.chamfered, "edge", name),
      ),
      ...namesOf(first.chamfered, "vertex").map((name) =>
        mint(first.chamfered, "vertex", name),
      ),
    ];
    expect(references.length).toBeGreaterThan(20);
    for (const [regeneration, dimensions] of [
      [2, [30, 20, 10]],
      [3, [42, 26, 14]],
    ] as const) {
      const rebuilt = chain(kernel, regeneration, dimensions, inputs);
      expectAllNamed(rebuilt.chamfered);
      for (const reference of references) {
        expect(resolve(reference, rebuilt.chamfered).state).toBe("valid");
      }
      expect(
        Math.abs(
          rebuilt.volume -
            chainVolume(dimensions[0], dimensions[1], dimensions[2]),
        ) / rebuilt.volume,
      ).toBeLessThan(1e-9);
    }
  });
});

// --- booleans and transforms ------------------------------------------------

/** The plate minus a full-depth wall at x ∈ [at, at+2], z ∈ [6, 10]. */
function slotted(kernel: Kernel, width: number, at: number): KernelSolid {
  return unwrapKernelResult(
    kernel.subtract(boxOf(kernel, BOX, width, 20, 10), [
      boxOf(kernel, WALL, 2, 20, 4, [at, 0, 6]),
    ]),
    "subtract",
  );
}

describe("Phase N2a: booleans and transforms", () => {
  it("names a split face's pieces name#i in a stable body-relative order", () => {
    const kernel = occtKernelFromRuntime(runtime);
    for (const [width, at] of [
      [30, 14],
      [30, 14],
      [40, 10],
    ] as const) {
      const snapshot = snapshotOf(kernel, slotted(kernel, width, at), 1);
      expectAllNamed(snapshot);
      const faces = namesOf(snapshot, "face");
      expect(faces).not.toContain(`${BOX}/+Z`);
      const left = entityNamed(snapshot, "face", `${BOX}/+Z#0`);
      const right = entityNamed(snapshot, "face", `${BOX}/+Z#1`);
      expect(left.geometry.centroidAbsoluteMm?.[0]).toBeCloseTo(at / 2);
      expect(right.geometry.centroidAbsoluteMm?.[0]).toBeCloseTo(
        (at + 2 + width) / 2,
      );
      // The tool's surviving faces carry the tool's own feature: the slot
      // walls and floor; its deleted faces' names are gone.
      expect(faces).toEqual(
        expect.arrayContaining([`${WALL}/-X`, `${WALL}/+X`, `${WALL}/-Z`]),
      );
      expect(faces).not.toContain(`${WALL}/+Z`);
      expect(faces).toHaveLength(10);
    }
  });

  it("carries names through a fuse and a transform unchanged", () => {
    const kernel = occtKernelFromRuntime(runtime);
    const fused = unwrapKernelResult(
      kernel.union([
        boxOf(kernel, BOX, 30, 20, 10),
        boxOf(kernel, WALL, 10, 10, 10, [25, 5, 5]),
      ]),
      "union",
    );
    const before = snapshotOf(kernel, fused, 1);
    expectAllNamed(before);
    const moved = unwrapKernelResult(
      kernel.transform(fused, {
        x: length(7),
        y: length(-3),
        z: length(2),
      }),
      "transform",
    );
    const after = snapshotOf(kernel, moved, 2);
    expectAllNamed(after);
    for (const kind of ["face", "edge", "vertex"] as const) {
      expect(namesOf(after, kind).sort()).toEqual(namesOf(before, kind).sort());
    }
    for (const name of namesOf(before, "face")) {
      expect(entityNamed(after, "face", name).geometry.areaMm2).toBeCloseTo(
        entityNamed(before, "face", name).geometry.areaMm2 ?? Number.NaN,
        9,
      );
    }
  });
});

// --- deletion and the repair fallback ---------------------------------------

describe("Phase N2a: deleted faces, unnamed output, repair", () => {
  it("drops a shell's removed face (missing) and names its inner walls and rim", () => {
    const kernel = occtKernelFromRuntime(runtime);
    const box = boxOf(kernel, BOX, 30, 20, 10);
    const boxSnapshot = snapshotOf(kernel, box, 1);
    const top = mint(boxSnapshot, "face", `${BOX}/+Z`);
    const side = mint(boxSnapshot, "face", `${BOX}/+X`);
    const shelled = unwrapKernelResult(
      kernel.shell({
        featureId: SHELL,
        target: box,
        faces: [entityNamed(boxSnapshot, "face", `${BOX}/+Z`).ordinal],
        thickness: length(2),
      }),
      "shell",
    );
    const snapshot = snapshotOf(kernel, shelled, 2);
    expectAllNamed(snapshot);
    expect(resolve(top, snapshot).state).toBe("missing");
    expect(resolve(side, snapshot).state).toBe("valid");
    const kept = ["+X", "-X", "+Y", "-Y", "-Z"].map((role) => `${BOX}/${role}`);
    expect(namesOf(snapshot, "face").sort()).toEqual(
      [
        ...kept,
        ...kept.map((name) => `${SHELL}/inner/${name}`),
        `${SHELL}/rim/${BOX}/+Z`,
      ].sort(),
    );
    expect(
      entityNamed(snapshot, "face", `${SHELL}/inner/${BOX}/-Z`).geometry
        .areaMm2,
    ).toBeCloseTo(26 * 16, 9);
    expect(
      entityNamed(snapshot, "face", `${SHELL}/rim/${BOX}/+Z`).geometry.areaMm2,
    ).toBeCloseTo(600 - 26 * 16, 9);
    expect(volumeOf(kernel, shelled)).toBeCloseTo(6000 - 26 * 16 * 8, 9);
  });

  it("resolves a face a cut deletes missing", () => {
    const kernel = occtKernelFromRuntime(runtime);
    const wall = snapshotOf(
      kernel,
      boxOf(kernel, WALL, 2, 20, 4, [14, 0, 6]),
      1,
    );
    const wallTop = mint(wall, "face", `${WALL}/+Z`);
    const wallSide = mint(wall, "face", `${WALL}/-X`);
    const snapshot = snapshotOf(kernel, slotted(kernel, 30, 14), 2);
    expect(resolve(wallTop, snapshot).state).toBe("missing");
    expect(resolve(wallSide, snapshot).state).toBe("valid");
  });

  it("re-anchors a reference into unnamed output by an explicit repair", () => {
    const kernel = occtKernelFromRuntime(runtime);
    const named = snapshotOf(kernel, boxOf(kernel, BOX, 30, 20, 10), 1);
    const top = mint(named, "face", `${BOX}/+Z`);
    const unnamed = snapshotOf(
      kernel,
      untracked(kernel, boxOf(kernel, BOX, 30, 20, 10)),
      2,
    );
    expect(unnamed.entities[0]?.identity?.schema).toBe("occt-shape-hash-v1");
    const missing = resolveTopologyReference(top, unnamed);
    if (!missing.ok) throw new Error(missing.error.message);
    expect(missing.value.validity.state).toBe("missing");
    const repaired = repairTopologyReference(missing.value, unnamed);
    if (!repaired.ok) throw new Error(repaired.error.message);
    expect(repaired.value.validity.state).toBe("repaired");
    expect(repaired.value.validity.repair?.strategy).toBe("geometric-reattach");
    const anchored = unnamed.entities.find(
      (entity) =>
        entity.kind === "face" &&
        entity.ordinal === repaired.value.validity.ordinal,
    );
    expect(anchored?.geometry.centroidAbsoluteMm?.[2]).toBeCloseTo(10);
    expect(anchored?.geometry.areaMm2).toBeCloseTo(600, 9);
  });

  it("refuses to repair onto geometric twins", () => {
    const kernel = occtKernelFromRuntime(runtime);
    const named = snapshotOf(kernel, boxOf(kernel, BOX, 30, 20, 10), 1);
    const top = mint(named, "face", `${BOX}/+Z`);
    // Two disjoint 30×20 plates: the upper plate's top keeps the
    // reference's ABSOLUTE centroid, the 24 mm plate below (z ∈
    // [−30.8, −6.8]) puts its top at the reference's BODY-RELATIVE
    // centroid (the union's centre of mass sits at z = −11.8) — two
    // equal-area candidates, each matching one anchoring. Neither plate is
    // the referenced feature's output, so the name is absent and the
    // reference falls back to the repair (a BREP round trip would split
    // the two solids apart on import).
    const twins = snapshotOf(
      kernel,
      unwrapKernelResult(
        kernel.union([
          boxOf(kernel, "feat_upper", 30, 20, 10),
          boxOf(kernel, WALL, 30, 20, 24, [0, 0, -30.8]),
        ]),
        "union",
      ),
      2,
    );
    const missing = resolveTopologyReference(top, twins);
    if (!missing.ok) throw new Error(missing.error.message);
    expect(missing.value.validity.state).toBe("missing");
    const repaired = repairTopologyReference(missing.value, twins);
    expect(repaired.ok).toBe(false);
    if (repaired.ok) return;
    expect(repaired.error.code).toBe("reference/repair-ambiguous");
  });
});
