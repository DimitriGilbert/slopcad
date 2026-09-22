/**
 * Section clipping state → three.js clipping planes (Phase 46): the
 * deterministic bridge from a document's section display records to the
 * render-level clipping the viewport applies. Pure — the same section
 * state always yields planes with the same numbers, so the clipped
 * raster is a function of state alone (the byte-determinism law).
 *
 * ## Direction convention
 *
 * A section record keeps `keepSide: +1` = keep the normal's side. three.js
 * clips a fragment when `plane.distanceToPoint(p) < 0` — it KEEPS the
 * half-space the plane's normal points into — so a record maps to the
 * plane `{ normal: keepSide·n̂, constant: −keepSide·n̂·o }` exactly. A
 * zero/non-finite normal names no plane and is skipped (the record is
 * inert, never a crash).
 *
 * ## The plane budget
 *
 * The viewport carries at most {@link SECTION_CLIP_PLANE_LIMIT} planes
 * (the roadmap's "up to 3"); records beyond the budget are ignored, in
 * record order — a documented limit, not an error. The clipping BOX is
 * the six-plane composition of its min/max corners (every axis keeps its
 * inside half-space), appended by the caller when one is active.
 */

import { Plane, Vector3 } from "three";

/** How many section clip planes the viewport applies at once. */
export const SECTION_CLIP_PLANE_LIMIT = 3;

/** One section record's clipping form: a plane and its kept side. */
export interface SectionClipPlane {
  /** The plane's world origin (mm). */
  readonly origin: readonly [number, number, number];
  /** The plane's normal (any finite non-zero vector; normalized here). */
  readonly normal: readonly [number, number, number];
  /** `+1` keeps the normal's side, `−1` the opposite. */
  readonly keepSide: 1 | -1;
}

/** The planes {@link clippingPlanesOf} produces (three.js `Plane[]`). */
export type SectionClipPlanes = Plane[];

/** An axis-aligned clipping box by its min/max corners (mm). */
export interface SectionClipBox {
  readonly min: readonly [number, number, number];
  readonly max: readonly [number, number, number];
}

const scratchNormal = new Vector3();

/**
 * Maps section records to three.js clipping planes — at most
 * {@link SECTION_CLIP_PLANE_LIMIT}, in record order, skipping records
 * whose normal names no plane. The returned array (and every Plane in
 * it) is freshly built, so callers can hand it straight to material
 * `clippingPlanes` without aliasing shared state.
 */
export function clippingPlanesOf(
  sections: readonly SectionClipPlane[],
): Plane[] {
  const planes: Plane[] = [];
  for (const section of sections) {
    if (planes.length >= SECTION_CLIP_PLANE_LIMIT) break;
    const n = section.normal;
    const squared = n[0] * n[0] + n[1] * n[1] + n[2] * n[2];
    if (
      !Number.isFinite(squared) ||
      squared === 0 ||
      !Number.isFinite(n[0]) ||
      !Number.isFinite(n[1]) ||
      !Number.isFinite(n[2])
    ) {
      continue;
    }
    const magnitude = Math.sqrt(squared);
    const ux = (section.keepSide * n[0]) / magnitude;
    const uy = (section.keepSide * n[1]) / magnitude;
    const uz = (section.keepSide * n[2]) / magnitude;
    scratchNormal.set(ux, uy, uz);
    planes.push(
      new Plane().setFromNormalAndCoplanarPoint(
        scratchNormal,
        new Vector3(section.origin[0], section.origin[1], section.origin[2]),
      ),
    );
  }
  return planes;
}

/**
 * Maps a clipping box to its six planes — each axis keeps its inside
 * half-space (min planes point +axis, max planes point −axis), so the
 * intersection of the six kept half-spaces is exactly the closed box.
 * A degenerate box (any min ≥ max component) yields no planes (inert,
 * never an inside-out clip).
 */
export function clippingBoxPlanesOf(box: SectionClipBox): Plane[] {
  for (let axis = 0; axis < 3; axis += 1) {
    const lo = box.min[axis];
    const hi = box.max[axis];
    if (lo === undefined || hi === undefined || !(lo < hi)) return [];
  }
  const axes: readonly (readonly [number, number, number])[] = [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ];
  const planes: Plane[] = [];
  for (const axis of axes) {
    planes.push(
      new Plane().setFromNormalAndCoplanarPoint(
        new Vector3(axis[0], axis[1], axis[2]),
        new Vector3(box.min[0], box.min[1], box.min[2]),
      ),
    );
    planes.push(
      new Plane().setFromNormalAndCoplanarPoint(
        new Vector3(-axis[0], -axis[1], -axis[2]),
        new Vector3(box.max[0], box.max[1], box.max[2]),
      ),
    );
  }
  return planes;
}
