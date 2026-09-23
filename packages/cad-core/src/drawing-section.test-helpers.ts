/**
 * Shared mesh/plane fixtures for the drawing tests: a 10 mm cube's
 * tessellation (the analytic body every section fixture cuts) and the
 * canonical front-view basis vectors.
 */

import type { OverlayMesh } from "./drawing-projection";

/** A 10x10x10 box mesh spanning (0,0,0)..(10,10,10), 12 triangles. */
export function boxMesh(): OverlayMesh {
  // Corners: bit-encoded xyz (bit 0 = x=10, bit 1 = y=10, bit 2 = z=10).
  const corner = (x: number, y: number, z: number): number => x + y * 2 + z * 4;
  const positions: number[] = [];
  for (let i = 0; i < 8; i += 1) {
    positions.push((i & 1) * 10, ((i >> 1) & 1) * 10, ((i >> 2) & 1) * 10);
  }
  const quad = (
    a: number,
    b: number,
    c: number,
    d: number,
  ): [number, number, number][] => [
    [a, b, c],
    [a, c, d],
  ];
  const indices: number[] = [
    // z = 0 and z = 10 faces.
    ...quad(corner(0, 0, 0), corner(1, 0, 0), corner(1, 1, 0), corner(0, 1, 0)),
    ...quad(corner(0, 0, 1), corner(0, 1, 1), corner(1, 1, 1), corner(1, 0, 1)),
    // y = 0 and y = 1 faces.
    ...quad(corner(0, 0, 0), corner(0, 0, 1), corner(1, 0, 1), corner(1, 0, 0)),
    ...quad(corner(0, 1, 0), corner(1, 1, 0), corner(1, 1, 1), corner(0, 1, 1)),
    // x = 0 and x = 1 faces.
    ...quad(corner(0, 0, 0), corner(0, 1, 0), corner(0, 1, 1), corner(0, 0, 1)),
    ...quad(corner(1, 0, 0), corner(1, 0, 1), corner(1, 1, 1), corner(1, 1, 0)),
  ].flat();
  return { positions, indices };
}

/** The canonical front-view basis vectors (eye, up) for section fixtures. */
export const FRONT_EYE_UP: {
  readonly eye: readonly [number, number, number];
  readonly up: readonly [number, number, number];
} = {
  eye: [0, -1, 0],
  up: [0, 0, 1],
};
