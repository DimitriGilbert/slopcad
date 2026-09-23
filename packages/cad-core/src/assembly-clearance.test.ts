/**
 * Assembly clearance measurement tests (Phase 58): the sampled
 * vertex-triangle minimum between placed occurrences — exact distances on
 * axis-aligned box fixtures, placement application, structured refusals,
 * and the report's fixed pair order.
 */

import { describe, expect, it } from "vitest";

import {
  ASSEMBLY_CLEARANCE_ERROR_CODES,
  checkAssemblyClearances,
  CLEARANCE_PRECISION,
  createBodyId,
  createOccurrenceId,
  IDENTITY_PLACEMENT_TRANSFORM,
  type ClearanceInstance,
  type ClearanceMesh,
} from "./index";

/** The unit box soup: six quad faces triangulated, 24 corners. */
function unitBoxMesh(): ClearanceMesh {
  const corner = (x: number, y: number, z: number): number[] => [x, y, z];
  const face = (
    a: number[],
    b: number[],
    c: number[],
    d: number[],
  ): number[] => [...a, ...b, ...c, ...d];
  const positions: number[] = [
    ...face(corner(0, 0, 0), corner(1, 0, 0), corner(1, 1, 0), corner(0, 1, 0)),
    ...face(corner(0, 0, 1), corner(1, 0, 1), corner(1, 1, 1), corner(0, 1, 1)),
    ...face(corner(0, 0, 0), corner(1, 0, 0), corner(1, 0, 1), corner(0, 0, 1)),
    ...face(corner(0, 1, 0), corner(1, 1, 0), corner(1, 1, 1), corner(0, 1, 1)),
    ...face(corner(0, 0, 0), corner(0, 1, 0), corner(0, 1, 1), corner(0, 0, 1)),
    ...face(corner(1, 0, 0), corner(1, 1, 0), corner(1, 1, 1), corner(1, 0, 1)),
  ];
  const indices: number[] = [];
  for (let faceIndex = 0; faceIndex < 6; faceIndex += 1) {
    const base = faceIndex * 4;
    indices.push(base, base + 2, base + 1, base, base + 3, base + 2);
  }
  return { positions, indices };
}

function translate(
  x: number,
  y: number,
  z: number,
): ClearanceInstance["transform"] {
  return {
    rotation: IDENTITY_PLACEMENT_TRANSFORM.rotation,
    translation: [x, y, z],
  };
}

function instance(
  label: string,
  transform: ClearanceInstance["transform"],
): ClearanceInstance {
  return {
    path: [createOccurrenceId(`occ_${label}`)],
    bodyId: createBodyId(`body_${label}`),
    transform,
    mesh: unitBoxMesh(),
  };
}

describe("assembly clearance", () => {
  it("measures the exact face-to-face gap between two unit boxes", () => {
    const report = checkAssemblyClearances({
      instances: [
        instance("a", translate(0, 0, 0)),
        instance("b", translate(11, 0, 0)),
      ],
      pairs: [[0, 1]],
    });
    expect(report.ok).toBe(true);
    if (!report.ok) return;
    expect(report.value.clearances).toHaveLength(1);
    const clearance = report.value.clearances[0];
    expect(clearance?.distance).toBe(10);
    expect(clearance?.firstPath).toEqual([createOccurrenceId("occ_a")]);
    expect(clearance?.secondPath).toEqual([createOccurrenceId("occ_b")]);
    expect(report.value.precision).toBe(CLEARANCE_PRECISION);
    // Every pair samples both soups: 12 triangles each.
    expect(report.value.sampledTriangles).toBe(24);
  });

  it("measures zero for touching boxes and applies placements", () => {
    const report = checkAssemblyClearances({
      instances: [
        instance("touch_a", translate(0, 0, 0)),
        instance("touch_b", translate(1, 0, 0)),
        instance("far", translate(0, 0, 101)),
      ],
      pairs: [
        [0, 1],
        [0, 2],
      ],
    });
    expect(report.ok).toBe(true);
    if (!report.ok) return;
    const [touching, placed] = report.value.clearances;
    expect(touching?.distance).toBe(0);
    // The far instance sits 100 above the unit box's top face.
    expect(placed?.distance).toBe(100);
    expect(placed?.secondPath).toEqual([createOccurrenceId("occ_far")]);
  });

  it("measures an offset corner's edge distance (non-axis gap)", () => {
    // Box B offset by 1 in both x and y: the closest features are the
    // vertical edges; the sampled minimum is sqrt(2) ≈ 1.41421356.
    const report = checkAssemblyClearances({
      instances: [
        instance("c", translate(0, 0, 0)),
        instance("d", translate(2, 2, 0)),
      ],
      pairs: [[0, 1]],
    });
    expect(report.ok).toBe(true);
    if (!report.ok) return;
    expect(report.value.clearances[0]?.distance).toBeCloseTo(Math.SQRT2, 9);
  });

  it("walks pairs in the caller's fixed order", () => {
    const instances = [
      instance("p0", translate(0, 0, 0)),
      instance("p1", translate(5, 0, 0)),
      instance("p2", translate(10, 0, 0)),
    ];
    const report = checkAssemblyClearances({
      instances,
      pairs: [
        [1, 2],
        [0, 1],
      ],
    });
    expect(report.ok).toBe(true);
    if (!report.ok) return;
    expect(report.value.clearances.map((c) => c.distance)).toEqual([4, 4]);
    expect(report.value.clearances[0]?.secondPath).toEqual([
      createOccurrenceId("occ_p2"),
    ]);
  });

  it("refuses malformed meshes, paths, and pairs structurally", () => {
    const badPath = checkAssemblyClearances({
      instances: [
        {
          ...instance("anon", translate(0, 0, 0)),
          path: [],
        },
      ],
      pairs: [],
    });
    expect(badPath).toMatchObject({
      ok: false,
      error: { code: ASSEMBLY_CLEARANCE_ERROR_CODES.malformed },
    });

    const badIndices = checkAssemblyClearances({
      instances: [
        {
          ...instance("m", translate(0, 0, 0)),
          mesh: { positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], indices: [0, 1, 7] },
        },
      ],
      pairs: [],
    });
    expect(badIndices).toMatchObject({
      ok: false,
      error: { code: ASSEMBLY_CLEARANCE_ERROR_CODES.malformed },
    });

    const badPair = checkAssemblyClearances({
      instances: [
        instance("x", translate(0, 0, 0)),
        instance("y", translate(5, 0, 0)),
      ],
      pairs: [[0, 0]],
    });
    expect(badPair).toMatchObject({
      ok: false,
      error: { code: ASSEMBLY_CLEARANCE_ERROR_CODES.empty },
    });

    const outOfRangePair = checkAssemblyClearances({
      instances: [
        instance("x", translate(0, 0, 0)),
        instance("y", translate(5, 0, 0)),
      ],
      pairs: [[0, 9]],
    });
    expect(outOfRangePair).toMatchObject({
      ok: false,
      error: { code: ASSEMBLY_CLEARANCE_ERROR_CODES.empty },
    });
  });
});
