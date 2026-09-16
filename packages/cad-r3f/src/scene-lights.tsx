/**
 * The fixed light rig of the deterministic CAD scene (Phase 11.3): the
 * Phase 1.6 architecture spike's proven three-light configuration, pinned
 * as documented constants. Positions are directional-light coordinates in
 * the scene's z-up millimetre world (the light shines from the position
 * toward the origin), so the rig is pure direction + intensity data with
 * no ambient environment, no shadows, and nothing clock- or frame-derived:
 * identical geometry always shades to identical pixels.
 */

import type { ReactElement } from "react";

/** Ambient fill applied uniformly, independent of orientation. */
export const CAD_SCENE_AMBIENT_INTENSITY = 1.2;

/**
 * Key light: the spike's main direction (high, +x +y +z), carrying the
 * dominant shading gradient that separates planar faces from the bore wall.
 */
export const CAD_SCENE_KEY_LIGHT_POSITION: [number, number, number] = [
  60, 80, 40,
];
export const CAD_SCENE_KEY_LIGHT_INTENSITY = 2.0;

/**
 * Fill light: the spike's opposing low direction (-x -y -z), keeping faces
 * turned away from the key light legible instead of crushed to black.
 */
export const CAD_SCENE_FILL_LIGHT_POSITION: [number, number, number] = [
  -50, -20, -60,
];
export const CAD_SCENE_FILL_LIGHT_INTENSITY = 0.6;

/**
 * Renders the rig. Deterministic by construction: fixed light kinds, fixed
 * coordinates, fixed intensities, `castShadow` left off (shadow maps are
 * resolution- and bias-dependent state the determinism contract excludes).
 */
export function CadSceneLights(): ReactElement {
  return (
    <>
      <ambientLight intensity={CAD_SCENE_AMBIENT_INTENSITY} />
      <directionalLight
        position={CAD_SCENE_KEY_LIGHT_POSITION}
        intensity={CAD_SCENE_KEY_LIGHT_INTENSITY}
      />
      <directionalLight
        position={CAD_SCENE_FILL_LIGHT_POSITION}
        intensity={CAD_SCENE_FILL_LIGHT_INTENSITY}
      />
    </>
  );
}
