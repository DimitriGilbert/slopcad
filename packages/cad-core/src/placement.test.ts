/**
 * Placement transform tests (Phase 50): analytic fixtures for the rigid
 * algebra — composition order, path folding, point/direction application,
 * world bounds, frame construction, and boundary validation. Every
 * expected value is derived by hand from the documented convention
 * (row-major matrices, columns = placed axes, outermost-first paths).
 */

import { describe, expect, it } from "vitest";

import {
  composePlacementPath,
  composePlacementTransforms,
  IDENTITY_PLACEMENT_TRANSFORM,
  parsePlacementTransform,
  PLACEMENT_ORTHONORMAL_TOLERANCE,
  placementTransformBounds,
  placementTransformFromFrame,
  transformPlacementDirection,
  transformPlacementPoint,
  type PlacementTransform,
} from "./index";

/** A pure translation by (x, y, z). */
function translate(x: number, y: number, z: number): PlacementTransform {
  return {
    rotation: [1, 0, 0, 0, 1, 0, 0, 0, 1],
    translation: [x, y, z],
  };
}

/** A pure rotation of `deg` degrees about the z axis (right-handed). */
function rotateZDeg(deg: number): PlacementTransform {
  const r = (deg * Math.PI) / 180;
  const c = Math.cos(r);
  const s = Math.sin(r);
  // Columns are the placed axes: x' = (c, s, 0), y' = (-s, c, 0).
  return { rotation: [c, -s, 0, s, c, 0, 0, 0, 1], translation: [0, 0, 0] };
}

describe("placement transforms", () => {
  it("composes translation then rotation in the documented order", () => {
    // first = rotate 90 deg about z; second = translate (10, 0, 0).
    // first ∘ second: a point is translated first, then rotated.
    const composed = composePlacementTransforms(
      rotateZDeg(90),
      translate(10, 0, 0),
    );
    // (0,0,0) -> translate -> (10,0,0) -> rotate -> (0,10,0).
    expect(transformPlacementPoint(composed, [0, 0, 0])[0]).toBeCloseTo(0, 12);
    expect(transformPlacementPoint(composed, [0, 0, 0])[1]).toBeCloseTo(10, 12);
  });

  it("composes rotations about different axes exactly", () => {
    const aboutX: PlacementTransform = {
      rotation: [1, 0, 0, 0, 0, -1, 0, 1, 0],
      translation: [0, 0, 0],
    };
    const composed = composePlacementTransforms(rotateZDeg(90), aboutX);
    // Local x (1,0,0): aboutX keeps it; rotZ maps it to (0,1,0).
    const x = transformPlacementDirection(composed, [1, 0, 0]);
    expect(x[0]).toBeCloseTo(0, 12);
    expect(x[1]).toBeCloseTo(1, 12);
    expect(x[2]).toBeCloseTo(0, 12);
  });

  it("folds a path OUTERMOST FIRST — the assembly ADR's fixed order", () => {
    // Root occurrence places by +10x; leaf occurrence places by +90deg z.
    const world = composePlacementPath([translate(10, 0, 0), rotateZDeg(90)]);
    // A leaf-local point (1,0,0): leaf rotates it to (0,1,0); root then
    // translates to (10,1,0). The reverse order would give (10,0,0)+rot.
    const p = transformPlacementPoint(world, [1, 0, 0]);
    expect(p[0]).toBeCloseTo(10, 12);
    expect(p[1]).toBeCloseTo(1, 12);
    expect(p[2]).toBeCloseTo(0, 12);
  });

  it("is deterministic: identical paths fold to identical numbers", () => {
    const a = composePlacementPath([
      translate(3.3, 1.1, -2.2),
      rotateZDeg(37),
      translate(-0.5, 0.25, 1),
    ]);
    const b = composePlacementPath([
      translate(3.3, 1.1, -2.2),
      rotateZDeg(37),
      translate(-0.5, 0.25, 1),
    ]);
    expect(a.rotation).toEqual(b.rotation);
    expect(a.translation).toEqual(b.translation);
  });

  it("keeps the empty path and double application exact", () => {
    expect(composePlacementPath([])).toEqual(IDENTITY_PLACEMENT_TRANSFORM);
    const twice = composePlacementPath([
      translate(5, 0, 0),
      translate(5, 0, 0),
    ]);
    expect(twice.translation).toEqual([10, 0, 0]);
  });

  it("bounds transform exactly by the transformed corners", () => {
    const world = placementTransformBounds(
      composePlacementTransforms(translate(100, 0, 0), rotateZDeg(90)),
      [0, 0, 0],
      [10, 20, 5],
    );
    // Local box [0..10]x[0..20]x[0..5] rotated 90deg about z becomes
    // [-20..0]x[0..10]x[0..5], then +100x -> [80..100]x[0..10]x[0..5].
    expect(world.min[0]).toBeCloseTo(80, 12);
    expect(world.max[0]).toBeCloseTo(100, 12);
    expect(world.min[1]).toBeCloseTo(0, 12);
    expect(world.max[1]).toBeCloseTo(10, 12);
    expect(world.max[2]).toBeCloseTo(5, 12);
  });

  it("builds a column-frame rotation from a datum frame", () => {
    const t = placementTransformFromFrame({
      origin: [7, 8, 9],
      xAxis: [0, 1, 0],
      yAxis: [0, 0, 1],
      zAxis: [1, 0, 0],
    });
    // Local x lands on world y.
    const x = transformPlacementDirection(t, [1, 0, 0]);
    expect(x).toEqual([0, 1, 0]);
    const o = transformPlacementPoint(t, [0, 0, 0]);
    expect(o).toEqual([7, 8, 9]);
  });

  it("rejects non-orthonormal rotations and bad shapes structurally", () => {
    expect(parsePlacementTransform(null).ok).toBe(false);
    expect(
      parsePlacementTransform({ rotation: [1, 0, 0], translation: [0, 0, 0] })
        .ok,
    ).toBe(false);
    const sheared: PlacementTransform = {
      rotation: [2, 0, 0, 0, 1, 0, 0, 0, 1],
      translation: [0, 0, 0],
    };
    expect(parsePlacementTransform(sheared).ok).toBe(false);
    const mirrored: PlacementTransform = {
      rotation: [1, 0, 0, 0, 1, 0, 0, 0, -1],
      translation: [0, 0, 0],
    };
    expect(parsePlacementTransform(mirrored).ok).toBe(false);
    expect(
      parsePlacementTransform({
        rotation: [0, -1, 0, 1, 0, 0, 0, 0, 1],
        translation: [Number.NaN, 0, 0],
      }).ok,
    ).toBe(false);
    const parsed = parsePlacementTransform(rotateZDeg(90));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value.rotation.length).toBe(9);
    }
    expect(PLACEMENT_ORTHONORMAL_TOLERANCE).toBeGreaterThan(0);
  });
});
