/**
 * Deterministic camera mapping (Phase 11.3): turns the renderer-neutral
 * {@link RenderCamera} spec — plain position/target/up data carrying either
 * a perspective `fovDeg` or an orthographic `viewWidth`/`viewHeight` — into
 * the three.js camera a CAD scene renders through. The spec is law: the
 * mapped camera never reframes, recenters, or distance-fits on its own, so
 * the same projection always produces the same view matrices.
 *
 * ## Mapping decisions
 *
 * - Position, up, and target copy the spec verbatim; orientation comes from
 *   `lookAt`, applied after `up` so the spec's up wins (a view-parallel up
 *   is already rejected upstream by `parseRenderCamera`).
 * - Perspective: `fovDeg` is the vertical field of view (three stores fov in
 *   degrees); the aspect ratio is supplied per viewport by the caller and
 *   re-applied on resize.
 * - Orthographic: the frustum is exactly the spec's view volume —
 *   `viewWidth`/`viewHeight` millimetres centred on the view axis. The
 *   viewport maps that volume directly (no aspect correction, no fit), so a
 *   viewport whose aspect differs from `viewWidth / viewHeight` stretches
 *   the image; specs are authored for their viewport.
 * - Clip planes are scene-wide documented constants, not spec data: the
 *   near plane trades millimetre-scale depth precision (CAD-part distances
 *   are tens of millimetres) against far-plane range.
 *
 * {@link applySceneCamera} mutates a camera in place so a stable instance
 * can follow spec changes without reconstruction churn in a mounted scene.
 */

import * as THREE from "three";
import type { RenderCamera } from "@slopcad/cad-core";

/**
 * Near clip plane in millimetres, shared by both camera kinds. An order of
 * magnitude below the smallest feature CAD scenes resolve, leaving deep
 * precision headroom across the 24-bit depth buffer.
 */
export const CAD_SCENE_CAMERA_NEAR_MM = 0.1;

/**
 * Far clip plane in millimetres, shared by both camera kinds: two orders of
 * magnitude above the largest scene extent a fixed viewport resolves.
 */
export const CAD_SCENE_CAMERA_FAR_MM = 2000;

/** A three.js camera mapped from a {@link RenderCamera} spec. */
export type SceneCamera = THREE.PerspectiveCamera | THREE.OrthographicCamera;

/**
 * Applies one spec (and viewport aspect) to an existing scene camera:
 * projection parameters first, then position/up/`lookAt` (up before
 * `lookAt`, so the spec's up governs the roll), then world-matrix and
 * projection-matrix updates. Throws a `TypeError` when the camera instance's
 * kind does not match the spec's kind — a silent mismatch would render a
 * frustum nobody authored.
 */
export function applySceneCamera(
  camera: SceneCamera,
  spec: RenderCamera,
  aspect: number,
): void {
  if (spec.kind === "perspective") {
    if (!(camera instanceof THREE.PerspectiveCamera)) {
      throw new TypeError(
        "A perspective render camera spec requires a PerspectiveCamera scene camera.",
      );
    }
    camera.fov = spec.fovDeg;
    camera.aspect = aspect;
  } else {
    if (!(camera instanceof THREE.OrthographicCamera)) {
      throw new TypeError(
        "An orthographic render camera spec requires an OrthographicCamera scene camera.",
      );
    }
    camera.left = -spec.viewWidth / 2;
    camera.right = spec.viewWidth / 2;
    camera.top = spec.viewHeight / 2;
    camera.bottom = -spec.viewHeight / 2;
  }
  camera.near = CAD_SCENE_CAMERA_NEAR_MM;
  camera.far = CAD_SCENE_CAMERA_FAR_MM;
  camera.position.set(spec.position[0], spec.position[1], spec.position[2]);
  camera.up.set(spec.up[0], spec.up[1], spec.up[2]);
  camera.lookAt(spec.target[0], spec.target[1], spec.target[2]);
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld();
}

/**
 * Builds a scene camera from a spec: the camera kind follows the spec's
 * kind, and {@link applySceneCamera} fills in every parameter, so this and
 * the update path can never drift apart.
 */
export function createSceneCamera(
  spec: RenderCamera,
  aspect: number,
): SceneCamera {
  const camera: SceneCamera =
    spec.kind === "perspective"
      ? new THREE.PerspectiveCamera(
          spec.fovDeg,
          aspect,
          CAD_SCENE_CAMERA_NEAR_MM,
          CAD_SCENE_CAMERA_FAR_MM,
        )
      : new THREE.OrthographicCamera(
          -1,
          1,
          1,
          -1,
          CAD_SCENE_CAMERA_NEAR_MM,
          CAD_SCENE_CAMERA_FAR_MM,
        );
  applySceneCamera(camera, spec, aspect);
  return camera;
}
