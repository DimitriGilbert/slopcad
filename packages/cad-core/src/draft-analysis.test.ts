/**
 * Draft analysis tests (Phase 58): the planar-face classification
 * against a pull datum on axis-aligned boxes — the band vocabulary, the
 * fixed color bands, the per-corner class array, and the structured
 * refusals.
 */

import { describe, expect, it } from "vitest";

import {
  analyzeDraft,
  DRAFT_ANALYSIS_ERROR_CODES,
  DRAFT_BAND_COLORS,
  type DraftAnalysisMesh,
} from "./index";

/** The 60×40×12 box soup with per-face normals (the fixture's box). */
function boxMesh(): DraftAnalysisMesh {
  const x = 60;
  const y = 40;
  const z = 12;
  const face = (
    quads: [number, number, number][],
    normal: [number, number, number],
  ): { positions: number[]; normals: number[] } => ({
    positions: quads.flat(),
    normals: quads.flatMap(() => normal),
  });
  const parts = [
    face(
      [
        [0, 0, 0],
        [x, 0, 0],
        [x, y, 0],
        [0, y, 0],
      ],
      [0, 0, -1],
    ),
    face(
      [
        [0, 0, z],
        [x, 0, z],
        [x, y, z],
        [0, y, z],
      ],
      [0, 0, 1],
    ),
    face(
      [
        [0, 0, 0],
        [x, 0, 0],
        [x, 0, z],
        [0, 0, z],
      ],
      [0, -1, 0],
    ),
    face(
      [
        [0, y, 0],
        [x, y, 0],
        [x, y, z],
        [0, y, z],
      ],
      [0, 1, 0],
    ),
    face(
      [
        [0, 0, 0],
        [0, y, 0],
        [0, y, z],
        [0, 0, z],
      ],
      [-1, 0, 0],
    ),
    face(
      [
        [x, 0, 0],
        [x, y, 0],
        [x, y, z],
        [x, 0, z],
      ],
      [1, 0, 0],
    ),
  ];
  const positions: number[] = [];
  const normals: number[] = [];
  for (const part of parts) {
    positions.push(...part.positions);
    normals.push(...part.normals);
  }
  const indices: number[] = [];
  for (let faceIndex = 0; faceIndex < 6; faceIndex += 1) {
    const base = faceIndex * 4;
    indices.push(base, base + 2, base + 1, base, base + 3, base + 2);
  }
  return { positions, indices, normals };
}

describe("draft analysis", () => {
  it("classifies a box against +z pull: positive, negative, four verticals", () => {
    const report = analyzeDraft({ mesh: boxMesh(), pull: [0, 0, 1] });
    expect(report.ok).toBe(true);
    if (!report.ok) return;
    expect(report.value.faces).toHaveLength(6);
    const byClass = { positive: 0, negative: 0, vertical: 0, undercut: 0 };
    for (const face of report.value.faces) {
      byClass[face.classification] += 1;
      expect(face.colorHex).toBe(DRAFT_BAND_COLORS[face.classification]);
    }
    expect(byClass).toEqual({
      positive: 1,
      negative: 1,
      vertical: 4,
      undercut: 0,
    });
    const top = report.value.faces.find((face) => face.normal[2] === 1);
    expect(top?.angleDeg).toBe(0);
    const bottom = report.value.faces.find((face) => face.normal[2] === -1);
    expect(bottom?.angleDeg).toBe(180);
    const side = report.value.faces.find((face) => face.normal[0] === 1);
    expect(side?.angleDeg).toBe(90);
    expect(report.value.cornerClasses).toHaveLength(24);
  });

  it("bands a 45-degree ramp face as an undercut", () => {
    const mesh = boxMesh();
    // Replace the +x face's normals with a 45-degree outward slant.
    const normals = [...mesh.normals];
    for (let corner = 20; corner < 24; corner += 1) {
      normals[corner * 3] = Math.SQRT1_2;
      normals[corner * 3 + 2] = Math.SQRT1_2;
    }
    const rampMesh: DraftAnalysisMesh = { ...mesh, normals };
    const report = analyzeDraft({ mesh: rampMesh, pull: [0, 0, 1] });
    expect(report.ok).toBe(true);
    if (!report.ok) return;
    const slanted = report.value.faces.find(
      (face) => face.normal[0] === Math.SQRT1_2,
    );
    expect(slanted?.classification).toBe("undercut");
    expect(slanted?.angleDeg).toBeCloseTo(45, 9);
  });

  it("the band limit moves the oblique tail: a 45-degree ramp reads positive under an 89-degree limit", () => {
    const mesh = boxMesh();
    // Replace the +x face's normals with a 45-degree outward slant.
    const normals = [...mesh.normals];
    for (let corner = 20; corner < 24; corner += 1) {
      normals[corner * 3] = Math.SQRT1_2;
      normals[corner * 3 + 2] = Math.SQRT1_2;
    }
    const rampMesh: DraftAnalysisMesh = { ...mesh, normals };
    const narrow = analyzeDraft({ mesh: rampMesh, pull: [0, 0, 1] });
    expect(narrow.ok).toBe(true);
    if (!narrow.ok) return;
    const narrowSlant = narrow.value.faces.find(
      (face) => face.normal[0] === Math.SQRT1_2,
    );
    expect(narrowSlant?.classification).toBe("undercut");

    const wide = analyzeDraft({
      mesh: rampMesh,
      pull: [0, 0, 1],
      limitDeg: 89,
    });
    expect(wide.ok).toBe(true);
    if (!wide.ok) return;
    const wideSlant = wide.value.faces.find(
      (face) => face.normal[0] === Math.SQRT1_2,
    );
    expect(wideSlant?.classification).toBe("positive");
  });

  it("refuses degenerate pulls and malformed soups structurally", () => {
    const zeroPull = analyzeDraft({ mesh: boxMesh(), pull: [0, 0, 0] });
    expect(zeroPull).toMatchObject({
      ok: false,
      error: { code: DRAFT_ANALYSIS_ERROR_CODES.pullDegenerate },
    });

    const shortNormals = analyzeDraft({
      mesh: { ...boxMesh(), normals: [0, 0, 1, 0, 0, 1, 0, 0, 1] },
      pull: [0, 0, 1],
    });
    expect(shortNormals).toMatchObject({
      ok: false,
      error: { code: DRAFT_ANALYSIS_ERROR_CODES.malformed },
    });
  });

  it("carries the fixed band colors as data", () => {
    expect(DRAFT_BAND_COLORS.positive).toBe("#3d9a5f");
    expect(DRAFT_BAND_COLORS.negative).toBe("#b3452f");
    expect(DRAFT_BAND_COLORS.vertical).toBe("#3f6fb5");
    expect(DRAFT_BAND_COLORS.undercut).toBe("#c2912f");
  });
});
