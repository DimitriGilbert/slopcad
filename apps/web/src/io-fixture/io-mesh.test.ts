/**
 * Unit tests for the /io fixture's mesh helpers: the divergence-theorem
 * volume, the bounds, the fitted camera's determinism and framing, and the
 * imported-mesh projection assembly — including round trips through BOTH
 * cad-io export/import adapter pairs, so the page's math is proven against
 * the exact bytes the browser workflow will carry.
 */

import { describe, expect, it } from "vitest";
import { exportStlBinary, exportThreeMf, importStl, importThreeMf } from "@slopcad/cad-io";
import type { Tessellation } from "@slopcad/cad-kernel";

import {
  buildImportedMeshState,
  fitCameraToBounds,
  meshBounds,
  meshSignedVolume,
} from "./io-mesh";

/** A unit cube as an indexed soup (outward winding, 12 triangles). */
function unitCube(flippedWinding = false): Tessellation {
  const positions = [
    0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 0, 0, 1, 1, 0, 1, 1, 1, 1, 0, 1, 1,
  ];
  const faces: readonly (readonly [number, number, number])[] = [
    [0, 2, 1], [0, 3, 2], // bottom (−z)
    [4, 5, 6], [4, 6, 7], // top (+z)
    [0, 1, 5], [0, 5, 4], // front (−y)
    [2, 3, 7], [2, 7, 6], // back (+y)
    [0, 4, 7], [0, 7, 3], // left (−x)
    [1, 2, 6], [1, 6, 5], // right (+x)
  ];
  const indices: number[] = [];
  for (const face of faces) {
    if (flippedWinding) {
      indices.push(face[0], face[2], face[1]);
    } else {
      indices.push(face[0], face[1], face[2]);
    }
  }
  return { positions, indices };
}

describe("meshSignedVolume", () => {
  it("reads the unit cube's volume as exactly 1, winding-independently", () => {
    expect(meshSignedVolume(unitCube())).toBeCloseTo(1, 12);
    expect(meshSignedVolume(unitCube(true))).toBeCloseTo(1, 12);
  });
});

describe("meshBounds", () => {
  it("returns the soup's axis-aligned bounds", () => {
    expect(meshBounds(unitCube())).toEqual({
      min: [0, 0, 0],
      max: [1, 1, 1],
    });
  });
});

describe("fitCameraToBounds", () => {
  const bounds = { min: [0, 0, 0], max: [30, 20, 10] } as const;

  it("is deterministic: identical bounds produce an identical camera", () => {
    expect(fitCameraToBounds(bounds)).toEqual(fitCameraToBounds(bounds));
  });

  it("targets the bounds centre along the home-view direction at the framing distance", () => {
    const camera = fitCameraToBounds(bounds);
    if (camera.kind !== "perspective") {
      throw new Error("the fitted camera must be perspective");
    }
    expect(camera.fovDeg).toBe(40);
    expect(camera.target).toEqual([15, 10, 5]);
    expect(camera.up).toEqual([0, 0, 1]);
    const offset: [number, number, number] = [
      camera.position[0] - camera.target[0],
      camera.position[1] - camera.target[1],
      camera.position[2] - camera.target[2],
    ];
    // Direction: the render fixture's (29, −40, 42) eye offset, normalized.
    const length = Math.hypot(...offset);
    expect(offset[0] / length).toBeCloseTo(29 / Math.hypot(29, 40, 42), 12);
    expect(offset[1] / length).toBeCloseTo(-40 / Math.hypot(29, 40, 42), 12);
    expect(offset[2] / length).toBeCloseTo(42 / Math.hypot(29, 40, 42), 12);
    // Distance: the bounding-sphere fit through the vertical fov, plus margin.
    const radius = Math.hypot(30, 20, 10) / 2;
    const expectedDistance = (radius / Math.sin((20 * Math.PI) / 180)) * 1.05;
    expect(length).toBeCloseTo(expectedDistance, 9);
  });
});

describe("buildImportedMeshState", () => {
  it("projects the soup under the imported-mesh body id with the fitted camera", () => {
    const state = buildImportedMeshState(unitCube());
    expect(state.triangles).toBe(12);
    expect(state.volume).toBeCloseTo(1, 12);
    expect(state.bounds).toEqual({ min: [0, 0, 0], max: [1, 1, 1] });
    expect(state.projection.objects).toHaveLength(1);
    expect(state.projection.objects[0]?.bodyId).toBe("body_imported_mesh");
    expect(state.projection.camera).toEqual(fitCameraToBounds(meshBounds(unitCube())));
  });

  it("survives the STL round trip within float32 tolerance", () => {
    const exported = exportStlBinary(unitCube());
    if (!exported.ok) throw new Error(`STL export failed: ${exported.error.message}`);
    const imported = importStl(exported.value);
    if (!imported.ok) throw new Error(`STL import failed: ${imported.error.message}`);
    const state = buildImportedMeshState(imported.value.tessellation);
    expect(state.triangles).toBe(12);
    expect(state.volume).toBeCloseTo(1, 6);
  });

  it("survives the 3MF round trip losslessly", () => {
    const exported = exportThreeMf(unitCube(), { title: "unit cube" });
    if (!exported.ok) throw new Error(`3MF export failed: ${exported.error.message}`);
    const imported = importThreeMf(exported.value);
    if (!imported.ok) throw new Error(`3MF import failed: ${imported.error.message}`);
    expect(imported.value.metadata.title).toBe("unit cube");
    const state = buildImportedMeshState(imported.value.tessellation);
    expect(state.triangles).toBe(12);
    expect(state.volume).toBeCloseTo(1, 12);
  });
});
