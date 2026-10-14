/**
 * The hex mesh (Phase 69a): the occupancy → element mapping's geometry
 * pins — one element per occupied node, conforming shared corners, the
 * domain-face node lists, and the numbering's determinism (law S2).
 */

import { describe, expect, it } from "vitest";

import {
  STRUCTURAL_FACE_BITS,
  structuralDomainFaceNodes,
  structuralHexMesh,
} from "./mesh";
import { analyticGrid, boxGrid } from "./fixtures";

describe("structuralHexMesh", () => {
  it("hosts one element per occupied node with conforming corner sharing", () => {
    const meshResult = structuralHexMesh(boxGrid(2, 2, 2, 0.005));
    expect(meshResult.ok).toBe(true);
    if (!meshResult.ok) return;
    const mesh = meshResult.value;
    expect(mesh.elementCount).toBe(8);
    // A full 2×2×2 node box meshes to 3×3×3 = 27 corner nodes (each
    // corner shared by its surrounding elements — no duplicates).
    expect(mesh.nodeCount).toBe(27);
    const distinct = new Set<number>(mesh.elementNode);
    expect(distinct.size).toBe(mesh.nodeCount);

    // Two elements at 6-adjacent nodes share exactly one face's 4 nodes.
    const mesh2 = structuralHexMesh(boxGrid(2, 1, 1, 0.005));
    expect(mesh2.ok).toBe(true);
    if (!mesh2.ok) return;
    expect(mesh2.value.elementCount).toBe(2);
    // 2×1×1 nodes → 3×2×2 = 12 corner nodes.
    expect(mesh2.value.nodeCount).toBe(12);
    const first = new Set<number>(
      Array.from(mesh2.value.elementNode.subarray(0, 8)),
    );
    const second = new Set<number>(
      Array.from(mesh2.value.elementNode.subarray(8, 16)),
    );
    let shared = 0;
    for (const node of second) {
      if (first.has(node)) shared += 1;
    }
    expect(shared).toBe(4);
  });

  it("spans the half-cell fringe: origin − h/2 to origin + (n − ½)·h", () => {
    const meshResult = structuralHexMesh(boxGrid(3, 1, 1, 0.002));
    expect(meshResult.ok).toBe(true);
    if (!meshResult.ok) return;
    const positions = meshResult.value.nodePositionM;
    const xs = new Set<number>();
    for (let node = 0; node < meshResult.value.nodeCount; node += 1) {
      xs.add(positions[node * 3] ?? Number.NaN);
    }
    // x node positions: −0.001, 0.001, 0.003, 0.005 — the physical bar
    // is exactly n·h = 0.006 long.
    expect(xs.size).toBe(4);
    expect(xs.has(-0.001)).toBe(true);
    expect(xs.has(0.005)).toBe(true);
  });

  it("carries the domain-face mask bits and lists the face nodes", () => {
    const meshResult = structuralHexMesh(boxGrid(2, 2, 2, 0.005));
    expect(meshResult.ok).toBe(true);
    if (!meshResult.ok) return;
    const mesh = meshResult.value;
    // The xMin face plane of a full box: a 3×3 node patch = 9 nodes.
    const xMin = structuralDomainFaceNodes(mesh, "xMin");
    expect(xMin.length).toBe(9);
    for (const node of xMin) {
      expect((mesh.nodeFaceMask[node] ?? 0) & STRUCTURAL_FACE_BITS.xMin).toBe(
        STRUCTURAL_FACE_BITS.xMin,
      );
    }
    // A face the body does not reach lists nothing.
    const partial = structuralHexMesh(
      analyticGrid([4, 4, 4], 0.005, (i) => i < 2, "test-partial"),
    );
    expect(partial.ok).toBe(true);
    if (!partial.ok) return;
    expect(structuralDomainFaceNodes(partial.value, "xMax")).toEqual([]);
    // The solid spans 2×4×4 nodes: its xMin face plane carries
    // 1 × 5 × 5 = 25 mesh nodes (the corner lattice's y-z patch).
    expect(structuralDomainFaceNodes(partial.value, "xMin").length).toBe(25);
  });

  it("numbers the identical grid identically every time", () => {
    const first = structuralHexMesh(boxGrid(3, 3, 2, 0.004));
    const second = structuralHexMesh(boxGrid(3, 3, 2, 0.004));
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(Array.from(first.value.elementNode)).toEqual(
      Array.from(second.value.elementNode),
    );
    expect(Array.from(first.value.nodePositionM)).toEqual(
      Array.from(second.value.nodePositionM),
    );
    expect(Array.from(first.value.elementOfGridNode)).toEqual(
      Array.from(second.value.elementOfGridNode),
    );
  });

  it("declines an all-void grid and honors the grid door's refusals", () => {
    const empty = structuralHexMesh(
      analyticGrid([2, 2, 2], 0.005, () => false, "test-empty"),
    );
    expect(empty.ok).toBe(false);
    if (!empty.ok) {
      expect(empty.error.message).toContain("no solid nodes");
    }
    const malformed = structuralHexMesh({
      semantic: "occupancy",
      name: "test-bad",
      shape: [2, 2, 2],
      originM: [0, 0, 0],
      spacingM: [0.005, 0.005, 0.005],
      cells: new Uint8Array(4).fill(1),
    });
    expect(malformed.ok).toBe(false);
  });
});
