/**
 * OBJ adapter tests (Phase 56): export determinism and failure discipline,
 * the export → import round-trip (volume and triangle order stable), and
 * the import subset's decline/failure edges. Volume is the exact signed
 * tetrahedral sum — closed-orientation soup, so exact arithmetic where the
 * six-decimal text is exact, and a 1e-6-relative band otherwise.
 */

import { describe, expect, test } from "vitest";
import type { Tessellation } from "@slopcad/cad-kernel";

import { exportObj, OBJ_EXPORT_OBJECT_NAME } from "./obj-export";
import { importObj } from "./obj-import";

const encoder = new TextEncoder();

/** Exact signed volume of a closed, consistently-wound triangle soup. */
function signedVolume(tessellation: Tessellation): number {
  const { positions, indices } = tessellation;
  const at = (i: number): readonly [number, number, number] => [
    positions[i * 3] ?? 0,
    positions[i * 3 + 1] ?? 0,
    positions[i * 3 + 2] ?? 0,
  ];
  let total = 0;
  for (let t = 0; t < indices.length; t += 3) {
    const [ax, ay, az] = at(indices[t] ?? 0);
    const [bx, by, bz] = at(indices[t + 1] ?? 0);
    const [cx, cy, cz] = at(indices[t + 2] ?? 0);
    total +=
      (ax * (by * cz - bz * cy) +
        ay * (bz * cx - bx * cz) +
        az * (bx * cy - by * cx)) /
      6;
  }
  return total;
}

/** A 2×2×2 box centered on the origin: 8 shared corners, 12 triangles. */
function boxSoup(): Tessellation {
  const c = [
    [-1, -1, -1],
    [1, -1, -1],
    [1, 1, -1],
    [-1, 1, -1],
    [-1, -1, 1],
    [1, -1, 1],
    [1, 1, 1],
    [-1, 1, 1],
  ];
  const quads = [
    [0, 3, 2, 1],
    [4, 5, 6, 7],
    [0, 1, 5, 4],
    [2, 3, 7, 6],
    [1, 2, 6, 5],
    [0, 4, 7, 3],
  ];
  const positions = c.flat();
  const indices: number[] = [];
  for (const [a, b, d, e] of quads) {
    indices.push(a ?? 0, b ?? 0, d ?? 0, a ?? 0, d ?? 0, e ?? 0);
  }
  return { positions, indices };
}

describe("OBJ export", () => {
  test("writes deterministic, fixed-format bytes with 1-based faces", () => {
    const tetra: Tessellation = {
      positions: [0, 0, 0, 2, 0, 0, 0, 2, 0, 0, 0, 2],
      indices: [0, 2, 1, 0, 1, 3, 0, 3, 2, 1, 2, 3],
    };
    const first = exportObj(tetra);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const text = new TextDecoder().decode(first.value);
    expect(text).toContain(`o ${OBJ_EXPORT_OBJECT_NAME}`);
    expect(text).toContain("v 0.000000 0.000000 0.000000");
    expect(text).toContain("v 2.000000 0.000000 0.000000");
    expect(text).toContain("f 1 3 2");
    const second = exportObj(tetra);
    expect(
      second.ok &&
        Buffer.from(first.value).equals(Buffer.from(second.value ?? [])),
    ).toBe(true);
  });

  test("normalizes negative zero in the fixed format", () => {
    const soup: Tessellation = {
      positions: [-0, -0.0000001, 1, 1, 0, 0, 0, 1, 0],
      indices: [0, 1, 2],
    };
    const result = exportObj(soup);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const text = new TextDecoder().decode(result.value);
    expect(text).toContain("v 0.000000 0.000000 1.000000");
    expect(text).not.toContain("-0.000000");
  });

  test("rejects empty, malformed, and non-finite soups", () => {
    expect(!exportObj({ positions: [], indices: [] }).ok).toBe(true);
    const misaligned = exportObj({
      positions: [0, 0, 0, 1, 1, 1, 0, 1],
      indices: [0, 1, 2],
    });
    expect(!misaligned.ok && misaligned.error.code).toBe(
      "obj-export/malformed-tessellation",
    );
    const outOfRange = exportObj({
      positions: [0, 0, 0, 1, 0, 0, 0, 1, 0],
      indices: [0, 1, 3],
    });
    expect(!outOfRange.ok && outOfRange.error.code).toBe(
      "obj-export/malformed-tessellation",
    );
    const nonFinite = exportObj({
      positions: [Number.NaN, 0, 0, 1, 0, 0, 0, 1, 0],
      indices: [0, 1, 2],
    });
    expect(!nonFinite.ok && nonFinite.error.code).toBe(
      "obj-export/non-finite-vertex",
    );
  });
});

describe("OBJ import", () => {
  test("round-trips the box: same triangles, same volume", () => {
    const soup = boxSoup();
    const exported = exportObj(soup);
    expect(exported.ok).toBe(true);
    if (!exported.ok) return;
    const imported = importObj(exported.value);
    expect(imported.ok).toBe(true);
    if (!imported.ok) return;
    expect(imported.value.name).toBe(OBJ_EXPORT_OBJECT_NAME);
    expect(imported.value.units).toBe("mm");
    expect(imported.value.declined).toEqual([]);
    expect(imported.value.tessellation.indices).toEqual(soup.indices);
    expect(imported.value.tessellation.positions).toEqual(soup.positions);
    expect(signedVolume(imported.value.tessellation)).toBeCloseTo(8, 6);
  });

  test("fans a quad face and resolves negative indices exactly", () => {
    const result = importObj(
      encoder.encode("v 0 0 0\nv 1 0 0\nv 1 1 0\nv 0 1 0\nf -4 -3 -2 -1\n"),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.tessellation.indices).toEqual([0, 1, 2, 0, 2, 3]);
  });

  test("reads i/j, i//k, i/j/k slots as positions only", () => {
    const result = importObj(
      encoder.encode(
        "vt 0 0\nvn 0 0 1\nv 0 0 0\nv 1 0 0\nv 0 1 0\nf 1/1 2/1 3/1\nf 1//1 2//1 3//1\nf 1/1/1 2/1/1 3/1/1\n",
      ),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.tessellation.indices).toHaveLength(9);
    expect(result.value.declined).toEqual([
      { keyword: "vt", reason: "keyword-out-of-subset" },
      { keyword: "vn", reason: "keyword-out-of-subset" },
    ]);
  });

  test("records the first object name and declines the second", () => {
    const result = importObj(
      encoder.encode("o first\ng second\nv 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n"),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.name).toBe("first");
    expect(result.value.declined).toEqual([
      { keyword: "g", reason: "keyword-out-of-subset" },
    ]);
  });

  test("rejects empty, binary, geometry-free, and defective files", () => {
    expect(!importObj(new Uint8Array()).ok).toBe(true);
    const binary = importObj(encoder.encode("v 1 0 0\n\x00\x01binary\n"));
    expect(!binary.ok && binary.error.code).toBe(
      "obj-import/binary-unsupported",
    );
    const geometryFree = importObj(
      encoder.encode("# just a comment\nmtllib none.mtl\n"),
    );
    expect(!geometryFree.ok && geometryFree.error.code).toBe(
      "obj-import/not-obj",
    );
    const rationalWeight = importObj(
      encoder.encode("v 0 0 0 2\nv 1 0 0\nv 0 1 0\nf 1 2 3\n"),
    );
    expect(!rationalWeight.ok && rationalWeight.error.code).toBe(
      "obj-import/rational-vertex",
    );
    const outOfRange = importObj(
      encoder.encode("v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 9\n"),
    );
    expect(!outOfRange.ok && outOfRange.error.code).toBe(
      "obj-import/index-out-of-range",
    );
    const shortFace = importObj(encoder.encode("v 0 0 0\nv 1 0 0\nf 1 2\n"));
    expect(!shortFace.ok && shortFace.error.code).toBe("obj-import/syntax");
  });
});
