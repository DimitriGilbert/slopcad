/**
 * The light rig of the deterministic CAD scene: the Phase 11.3 pinned
 * three-light configuration, since Phase 59 one named rig (`"studio"`) in
 * the `lighting.ts` data table. The default render mounts the studio rig
 * verbatim — fixed light kinds, fixed directional coordinates, fixed
 * intensities, `castShadow` off — so the pinned baselines' bytes are
 * exactly the pre-preset scene's bytes. Selecting another rig swaps the
 * same pure data in; every rig is deterministic given state (no ambient
 * environment, no shadows, nothing clock- or frame-derived).
 */

import type { ReactElement } from "react";

import { CAD_LIGHT_RIG_STUDIO, type CadLightRig } from "./lighting";
import {
  CAD_QUALITY_SHADOW_BIAS,
  CAD_QUALITY_SHADOW_CAMERA_EXTENT_MM,
  CAD_QUALITY_SHADOW_MAP_SIZE,
  CAD_QUALITY_SHADOW_NORMAL_BIAS,
} from "./render-quality";

/** Ambient fill applied uniformly, independent of orientation (the studio rig's). */
export const CAD_SCENE_AMBIENT_INTENSITY = CAD_LIGHT_RIG_STUDIO.ambient;

/**
 * Key light: the spike's main direction (high, +x +y +z), carrying the
 * dominant shading gradient that separates planar faces from the bore wall.
 */
export const CAD_SCENE_KEY_LIGHT_POSITION: [number, number, number] = [
  60, 80, 40,
];
export const CAD_SCENE_KEY_LIGHT_INTENSITY = CAD_LIGHT_RIG_STUDIO.key.intensity;

/**
 * Fill light: the spike's opposing low direction (-x -y -z), keeping faces
 * turned away from the key light legible instead of crushed to black.
 */
export const CAD_SCENE_FILL_LIGHT_POSITION: [number, number, number] = [
  -50, -20, -60,
];
export const CAD_SCENE_FILL_LIGHT_INTENSITY =
  CAD_LIGHT_RIG_STUDIO.fill.intensity;

/**
 * Renders one rig. Deterministic by construction: fixed light kinds, fixed
 * coordinates, fixed intensities. `shadowKey` (quality mode only) turns
 * the key light into the fixed soft-shadow caster — OFF in every default
 * render, so the boot raster law holds.
 */
export function CadSceneLights({
  rig = CAD_LIGHT_RIG_STUDIO,
  shadowKey = false,
}: {
  readonly rig?: CadLightRig;
  readonly shadowKey?: boolean;
} = {}): ReactElement {
  return (
    <>
      <ambientLight intensity={rig.ambient} />
      <directionalLight
        castShadow={shadowKey}
        intensity={rig.key.intensity}
        position={[...rig.key.position]}
        {...(shadowKey
          ? {
              "shadow-mapSize-height": CAD_QUALITY_SHADOW_MAP_SIZE,
              "shadow-mapSize-width": CAD_QUALITY_SHADOW_MAP_SIZE,
              "shadow-camera-left": -CAD_QUALITY_SHADOW_CAMERA_EXTENT_MM,
              "shadow-camera-right": CAD_QUALITY_SHADOW_CAMERA_EXTENT_MM,
              "shadow-camera-top": CAD_QUALITY_SHADOW_CAMERA_EXTENT_MM,
              "shadow-camera-bottom": -CAD_QUALITY_SHADOW_CAMERA_EXTENT_MM,
              "shadow-camera-near": 1,
              "shadow-camera-far": 1000,
              "shadow-bias": CAD_QUALITY_SHADOW_BIAS,
              "shadow-normalBias": CAD_QUALITY_SHADOW_NORMAL_BIAS,
            }
          : {})}
      />
      <directionalLight
        intensity={rig.fill.intensity}
        position={[...rig.fill.position]}
      />
    </>
  );
}
