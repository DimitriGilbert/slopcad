/**
 * The ground furniture of the deterministic CAD scene (Phase 11.3): the
 * z = 0 ground grid, the world axes, and the origin marker, in the scene's
 * z-up millimetre world (the ground plane is z = 0; the grid lies in it).
 *
 * ## Coplanarity discipline (the z-fighting rules)
 *
 * A model resting on the ground occupies the positive octant, so scene
 * furniture that naively ran along the origin planes would rasterize
 * coplanar with model faces — equal-depth fragments flickering in the
 * output. Every element here is dodged by a documented constant:
 *
 * - the grid sits `CAD_SCENE_GRID_DROP_MM` below z = 0, so a model's bottom
 *   face is never coplanar with grid lines (for kernels whose winding is
 *   unspecified, a bottom face may be front-facing rather than culled);
 * - the horizontal axes lie in the model's face planes (x = 0 / y = 0) but
 *   `CAD_SCENE_AXIS_CLEARANCE_MM` below the ground, outside the faces' z
 *   extent, so they read as painted on the ground just outside the model;
 * - the vertical axis leans diagonally outside both vertical face planes by
 *   the same clearance, keeping it visible beside a model that occupies the
 *   origin corner.
 *
 * All geometry is generated from the constants below — no randomness, no
 * per-frame work, no disposal churn (`args` arrays are module-stable so R3F
 * never reconstructs the helpers across renders).
 */

import { useMemo } from "react";
import * as THREE from "three";
import type { ReactElement } from "react";
import type { RenderVector3 } from "@slopcad/cad-core";

/** Full width of the square ground grid, in millimetres. */
export const CAD_SCENE_GRID_SIZE_MM = 80;

/** Grid cells along one side: 80 / 16 = a 5 mm minor cell. */
export const CAD_SCENE_GRID_DIVISIONS = 16;

/** How far below z = 0 the grid sits (see the coplanarity rules above). */
export const CAD_SCENE_GRID_DROP_MM = 0.1;

/** Minor grid line color (gray-700, tuned for the scene's dark background). */
export const CAD_SCENE_GRID_COLOR = "#374151";

/** Major (centre-line) grid color, one step lighter than the minor lines. */
export const CAD_SCENE_GRID_CENTER_COLOR = "#4b5563";

/** Length of each world axis through the origin, in millimetres. */
export const CAD_SCENE_AXIS_LENGTH_MM = 60;

/** Dodge distance keeping axes out of every model-occupiable plane. */
export const CAD_SCENE_AXIS_CLEARANCE_MM = 0.3;

/** Axis colors follow the red/green/blue = X/Y/Z viewport convention. */
export const CAD_SCENE_AXIS_X_COLOR = "#ef4444";
export const CAD_SCENE_AXIS_Y_COLOR = "#22c55e";
export const CAD_SCENE_AXIS_Z_COLOR = "#3b82f6";

/** Radius of the origin marker octahedron, in millimetres. */
export const CAD_SCENE_ORIGIN_MARKER_RADIUS_MM = 0.9;

/** Origin marker color (light gray, independent of the light rig). */
export const CAD_SCENE_ORIGIN_MARKER_COLOR = "#e5e7eb";

/** Module-stable gridHelper args, so R3F never reconstructs across renders. */
const GRID_HELPER_ARGS: ConstructorParameters<typeof THREE.GridHelper> = [
  CAD_SCENE_GRID_SIZE_MM,
  CAD_SCENE_GRID_DIVISIONS,
  CAD_SCENE_GRID_CENTER_COLOR,
  CAD_SCENE_GRID_COLOR,
];

/** Module-stable octahedron args for the origin marker. */
const ORIGIN_MARKER_ARGS: ConstructorParameters<
  typeof THREE.OctahedronGeometry
> = [CAD_SCENE_ORIGIN_MARKER_RADIUS_MM, 0];

/**
 * Builds the world-axes line geometry: one segment per axis through the
 * origin, dodged per the coplanarity rules, with per-vertex colors carrying
 * each axis's convention color (two vertices per axis, one draw call).
 */
export function createAxesGeometry(): THREE.BufferGeometry {
  const clearance = CAD_SCENE_AXIS_CLEARANCE_MM;
  const length = CAD_SCENE_AXIS_LENGTH_MM;
  const positions = new Float32Array([
    -length,
    0,
    -clearance,
    length,
    0,
    -clearance,
    0,
    -length,
    -clearance,
    0,
    length,
    -clearance,
    -clearance,
    -clearance,
    -clearance,
    -clearance,
    -clearance,
    length,
  ]);
  const axisColors = [
    new THREE.Color(CAD_SCENE_AXIS_X_COLOR),
    new THREE.Color(CAD_SCENE_AXIS_Y_COLOR),
    new THREE.Color(CAD_SCENE_AXIS_Z_COLOR),
  ];
  const colors = new Float32Array(18);
  for (let axis = 0; axis < axisColors.length; axis += 1) {
    const color = axisColors[axis];
    if (color === undefined) {
      throw new Error(`Axis ${axis} has no convention color.`);
    }
    for (let vertex = 0; vertex < 2; vertex += 1) {
      const offset = (axis * 2 + vertex) * 3;
      colors[offset] = color.r;
      colors[offset + 1] = color.g;
      colors[offset + 2] = color.b;
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  return geometry;
}

/**
 * Renders the ground furniture. `target` is the projection camera's target:
 * the grid centres on its xy so the framed model always stands over the
 * grid's centre lines, while the axes and origin marker stay at the world
 * origin — their meaning, not the camera's.
 */
export function CadSceneGround({
  target,
}: {
  target: RenderVector3;
}): ReactElement {
  const axesGeometry = useMemo(createAxesGeometry, []);
  return (
    <>
      <gridHelper
        args={GRID_HELPER_ARGS}
        rotation-x={Math.PI / 2}
        position={[target[0], target[1], -CAD_SCENE_GRID_DROP_MM]}
      />
      <lineSegments geometry={axesGeometry}>
        <lineBasicMaterial vertexColors />
      </lineSegments>
      <mesh>
        <octahedronGeometry args={ORIGIN_MARKER_ARGS} />
        <meshBasicMaterial color={CAD_SCENE_ORIGIN_MARKER_COLOR} />
      </mesh>
    </>
  );
}
