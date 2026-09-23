/**
 * Curvature display tests (Phase 58): the 2D comb's exact-circle pin and
 * structured declines, plus the surface band's welded-vertex
 * classification on planar, cylindrical, and box soups.
 */

import { describe, expect, it } from "vitest";

import {
  CURVATURE_ERROR_CODES,
  sketchCurvatureComb,
  SURFACE_CURVATURE_BAND_COLORS,
  surfaceCurvatureBands,
  type PlanarPath,
} from "./index";

/** Samples a radius-30 circle centred at (110, 20), 25 points. */
function circleSamples(radius = 30): PlanarPath {
  const samples: [number, number][] = [];
  for (let index = 0; index < 25; index += 1) {
    const angle = (2 * Math.PI * index) / 24;
    samples.push([
      110 + radius * Math.cos(angle),
      20 + radius * Math.sin(angle),
    ]);
  }
  return samples;
}

describe("sketch curvature comb", () => {
  it("pins curvature exactly on a circle: kappa = 1/r at every sample", () => {
    const comb = sketchCurvatureComb({
      samples: circleSamples(30),
      scale: 12,
    });
    expect(comb.ok).toBe(true);
    if (!comb.ok) return;
    expect(comb.value.spikes).toHaveLength(23);
    for (const spike of comb.value.spikes) {
      expect(spike.curvature).toBeCloseTo(1 / 30, 9);
    }
    expect(comb.value.maxCurvature).toBeCloseTo(1 / 30, 9);
  });

  it("caps spike lengths and answers zero curvature on a straight path", () => {
    const straight: PlanarPath = [
      [0, 0],
      [10, 0],
      [20, 0],
      [30, 0],
      [40, 0],
    ];
    const comb = sketchCurvatureComb({ samples: straight, scale: 12 });
    expect(comb.ok).toBe(true);
    if (!comb.ok) return;
    for (const spike of comb.value.spikes) {
      expect(spike.curvature).toBe(0);
      expect(spike.tip[0]).toBe(spike.base[0]);
      expect(spike.tip[1]).toBe(spike.base[1]);
    }

    // A tight corner at scale 12 would spike 12 units; the cap holds it
    // at 50 — and the unit-law scale of 4 keeps it under anyway.
    const corner: PlanarPath = [
      [0, 0],
      [1, 0],
      [1, 1],
      [2, 1],
      [3, 1],
    ];
    const capped = sketchCurvatureComb({ samples: corner, scale: 12 });
    expect(capped.ok).toBe(true);
    if (!capped.ok) return;
    for (const spike of capped.value.spikes) {
      const length = Math.hypot(
        spike.tip[0] - spike.base[0],
        spike.tip[1] - spike.base[1],
      );
      expect(length).toBeLessThanOrEqual(50);
    }
  });

  it("refuses too-few samples and coincident points structurally", () => {
    const tooFew = sketchCurvatureComb({
      samples: [
        [0, 0],
        [1, 1],
      ],
      scale: 1,
    });
    expect(tooFew).toMatchObject({
      ok: false,
      error: { code: CURVATURE_ERROR_CODES.malformed },
    });

    const coincident = sketchCurvatureComb({
      samples: [
        [0, 0],
        [0, 0],
        [1, 1],
      ],
      scale: 1,
    });
    expect(coincident).toMatchObject({
      ok: false,
      error: { code: CURVATURE_ERROR_CODES.degenerate },
    });
  });
});

describe("surface curvature bands", () => {
  it("classifies a planar quad's welded vertices as flat", () => {
    const report = surfaceCurvatureBands({
      positions: [0, 0, 0, 10, 0, 0, 10, 10, 0, 0, 10, 0],
      normals: [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1],
    });
    expect(report.ok).toBe(true);
    if (!report.ok) return;
    expect(report.value.weldedVertices).toBe(4);
    expect(report.value.census.map((entry) => entry.vertices)).toEqual([
      4, 0, 0,
    ]);
    expect(report.value.census[0]?.colorHex).toBe(
      SURFACE_CURVATURE_BAND_COLORS.flat,
    );
  });

  it("classifies a faceted open tube's welded vertices as curved", () => {
    // Radius 20, height 40, 24 sectors, FACETED shading: every quad's
    // corners carry the quad's mid-sector radial normal, so a welded seam
    // vertex holds two normals 15 degrees apart — inside the curved band.
    const sectors = 24;
    const positions: number[] = [];
    const normals: number[] = [];
    for (let sector = 0; sector < sectors; sector += 1) {
      const angle0 = (2 * Math.PI * sector) / sectors;
      const angle1 = (2 * Math.PI * (sector + 1)) / sectors;
      const mid = (angle0 + angle1) / 2;
      const normal = [Math.cos(mid), Math.sin(mid), 0];
      for (const angle of [angle0, angle1]) {
        positions.push(
          20 * Math.cos(angle),
          20 * Math.sin(angle),
          0,
          20 * Math.cos(angle),
          20 * Math.sin(angle),
          40,
        );
        normals.push(...normal, ...normal);
      }
    }
    const report = surfaceCurvatureBands({ positions, normals });
    expect(report.ok).toBe(true);
    if (!report.ok) return;
    const flat = report.value.census.find((entry) => entry.band === "flat");
    const curved = report.value.census.find((entry) => entry.band === "curved");
    const sharp = report.value.census.find((entry) => entry.band === "sharp");
    // The open seam ends (angle 0 and angle 2π do not weld — sin(2π) is
    // not exactly 0) each hold one quad's normal: 4 flat vertices.
    expect(flat?.vertices).toBe(4);
    expect(curved?.vertices).toBe(46);
    expect(sharp?.vertices).toBe(0);
    expect(report.value.weldedVertices).toBe(50);
  });

  it("reads a smooth-shaded soup honestly: normals already aligned, band flat", () => {
    // The SAME tube with per-corner radial (smooth-shaded) normals: the
    // submitted normals carry no face-to-face deviation, so the mesh band
    // reads flat — the documented honesty of the estimator.
    const sectors = 24;
    const positions: number[] = [];
    const normals: number[] = [];
    for (let sector = 0; sector < sectors; sector += 1) {
      const angle0 = (2 * Math.PI * sector) / sectors;
      const angle1 = (2 * Math.PI * (sector + 1)) / sectors;
      for (const angle of [angle0, angle1]) {
        positions.push(
          20 * Math.cos(angle),
          20 * Math.sin(angle),
          0,
          20 * Math.cos(angle),
          20 * Math.sin(angle),
          40,
        );
        normals.push(
          Math.cos(angle),
          Math.sin(angle),
          0,
          Math.cos(angle),
          Math.sin(angle),
          0,
        );
      }
    }
    const report = surfaceCurvatureBands({ positions, normals });
    expect(report.ok).toBe(true);
    if (!report.ok) return;
    const flat = report.value.census.find((entry) => entry.band === "flat");
    expect(flat?.vertices).toBe(report.value.weldedVertices);
  });

  it("classifies a box's welded corners as sharp", () => {
    // Six faces, four corners each, per-face normals: every welded
    // vertex meets three mutually-90-degree normals.
    const positions: number[] = [];
    const normals: number[] = [];
    const faceNormal: [number, number, number][] = [
      [0, 0, -1],
      [0, 0, 1],
      [0, -1, 0],
      [0, 1, 0],
      [-1, 0, 0],
      [1, 0, 0],
    ];
    const faceCorners: [number, number, number][][] = [];
    const x = 60;
    const y = 40;
    const z = 12;
    faceCorners.push(
      [
        [0, 0, 0],
        [x, 0, 0],
        [x, y, 0],
        [0, y, 0],
      ],
      [
        [0, 0, z],
        [x, 0, z],
        [x, y, z],
        [0, y, z],
      ],
      [
        [0, 0, 0],
        [x, 0, 0],
        [x, 0, z],
        [0, 0, z],
      ],
      [
        [0, y, 0],
        [x, y, 0],
        [x, y, z],
        [0, y, z],
      ],
      [
        [0, 0, 0],
        [0, y, 0],
        [0, y, z],
        [0, 0, z],
      ],
      [
        [x, 0, 0],
        [x, y, 0],
        [x, y, z],
        [x, 0, z],
      ],
    );
    faceCorners.forEach((corners, faceIndex) => {
      for (const corner of corners) {
        positions.push(...corner);
        normals.push(...(faceNormal[faceIndex] ?? [0, 0, 1]));
      }
    });
    const report = surfaceCurvatureBands({ positions, normals });
    expect(report.ok).toBe(true);
    if (!report.ok) return;
    expect(report.value.weldedVertices).toBe(8);
    const sharp = report.value.census.find((entry) => entry.band === "sharp");
    expect(sharp?.vertices).toBe(8);
  });

  it("refuses mismatched corner arrays structurally", () => {
    const bad = surfaceCurvatureBands({
      positions: [0, 0, 0],
      normals: [0, 0, 1, 0, 0, 1],
    });
    expect(bad).toMatchObject({
      ok: false,
      error: { code: CURVATURE_ERROR_CODES.malformed },
    });
  });
});
