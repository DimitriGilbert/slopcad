/**
 * Section clipping tests (Phase 46): the document section state → three.js
 * plane mapping — the keep-side direction law, the three-plane budget, the
 * inert degenerate normal, and the clipping box's six half-spaces. The
 * empty state maps to NO planes (the boot raster law: unclipped scenes
 * construct byte-identical materials).
 */

import { describe, expect, it } from "vitest";
import { Vector3 } from "three";

import {
  clippingBoxPlanesOf,
  clippingPlanesOf,
  type SectionClipPlane,
  SECTION_CLIP_PLANE_LIMIT,
} from "./section-clipping";

const point = (x: number, y: number, z: number): Vector3 =>
  new Vector3(x, y, z);

describe("section clipping state (Phase 46)", () => {
  it("maps an empty section list to no planes", () => {
    expect(clippingPlanesOf([])).toEqual([]);
  });

  it("keeps the normal's side for +1 and the opposite for -1", () => {
    const [plane] = clippingPlanesOf([
      { origin: [0, 0, 5], normal: [0, 0, 2], keepSide: 1 },
    ]);
    expect(plane).toBeDefined();
    if (plane === undefined) return;
    // A point on the normal's side stays; a point behind clips.
    expect(plane.distanceToPoint(point(0, 0, 6))).toBeGreaterThan(0);
    expect(plane.distanceToPoint(point(0, 0, 4))).toBeLessThan(0);
    const [flipped] = clippingPlanesOf([
      { origin: [0, 0, 5], normal: [0, 0, 2], keepSide: -1 },
    ]);
    if (flipped === undefined) return;
    expect(flipped.distanceToPoint(point(0, 0, 4))).toBeGreaterThan(0);
    expect(flipped.distanceToPoint(point(0, 0, 6))).toBeLessThan(0);
  });

  it("normalizes an unnormalized normal and honors the plane budget", () => {
    const many: SectionClipPlane[] = Array.from(
      { length: SECTION_CLIP_PLANE_LIMIT + 2 },
      (_, i): SectionClipPlane => ({
        origin: [0, 0, i + 1],
        normal: [0, 0, 3],
        keepSide: 1,
      }),
    );
    const planes = clippingPlanesOf(many);
    expect(planes.length).toBe(SECTION_CLIP_PLANE_LIMIT);
    for (const plane of planes) {
      expect(
        Math.hypot(plane.normal.x, plane.normal.y, plane.normal.z),
      ).toBeCloseTo(1, 12);
    }
  });

  it("skips a degenerate normal inertly", () => {
    const planes = clippingPlanesOf([
      { origin: [0, 0, 0], normal: [0, 0, 0], keepSide: 1 },
      { origin: [0, 0, 5], normal: [0, 0, 1], keepSide: 1 },
    ]);
    expect(planes.length).toBe(1);
  });

  it("maps a clipping box to six inside-keeping planes", () => {
    const planes = clippingBoxPlanesOf({ min: [0, 0, 0], max: [10, 10, 10] });
    expect(planes.length).toBe(6);
    for (const plane of planes) {
      // Inside the box is inside every kept half-space.
      expect(plane.distanceToPoint(point(5, 5, 5))).toBeGreaterThan(0);
    }
    // Each face's own outside is behind its own plane: the -x face keeps
    // x ≥ 0, the +x face keeps x ≤ 10.
    for (const plane of planes) {
      if (plane.normal.x === 1) {
        expect(plane.distanceToPoint(point(-1, 5, 5))).toBeLessThan(0);
      }
      if (plane.normal.x === -1) {
        expect(plane.distanceToPoint(point(11, 5, 5))).toBeLessThan(0);
      }
    }
    expect(clippingBoxPlanesOf({ min: [5, 0, 0], max: [5, 10, 10] })).toEqual(
      [],
    );
  });
});
