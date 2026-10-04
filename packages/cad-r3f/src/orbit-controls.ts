/**
 * The user camera's orbit math — the pure, renderer-free core of the
 * interactive camera controls. The scene camera is spec law until a user
 * gestures; this module is everything a gesture does after that.
 *
 * ## Model
 *
 * One {@link OrbitState} captures the user camera as CAD view controls
 * have always described it: a spherical orbit around a pannable
 * `target` — azimuth (around the pole), elevation (above the ground plane
 * spanned by the pole's perpendiculars), and distance — seeded ONCE from
 * whatever the camera was at the first gesture (the spec camera, on a
 * fresh mount), so taking control never jumps the view. The pole is the
 * seed camera's `up` direction (the CAD z-up convention arrives as data,
 * never hard-coded), and the azimuth reference is a stable perpendicular
 * derived from it, so the same seed always yields the same decomposition.
 *
 * ## The clamps (why each exists)
 *
 * - **Elevation** is clamped just short of the pole in BOTH directions —
 *   the same epsilon each way. A camera exactly on its pole looks along
 *   its own up, and `lookAt` degenerates there, so the window stops just
 *   short of it; inside the window the orbit is free, running through the
 *   horizon and below the ground plane (standard CAD orbit: the model is
 *   visible from underneath). The seed elevation is always inside its
 *   own clamp window — a spec camera seeded outside the documented band
 *   stays reachable exactly where it is, and only user gestures respect
 *   the band — so seeding can never move the view.
 * - **Distance** is clamped well inside the scene's clip planes
 *   (`CAD_SCENE_CAMERA_NEAR_MM`/`FAR`): dolly past the near plane or
 *   behind the far plane renders nothing, and a viewport that lets a user
 *   zoom into nothing is lying.
 *
 * ## Determinism
 *
 * Every input → output here is plain float64 arithmetic on plain data: no
 * render state, no time, no randomness. The R3F wiring
 * (`scene-camera-controls`) only applies these results to a camera
 * between demand frames, so with no user input nothing here ever runs and
 * the boot pixels stay the spec camera's — byte for byte.
 */

import type { RenderCamera, RenderVector3 } from "@slopcad/cad-core";

/** Pointer travel (CSS px) under which a gesture stays a click (a pick). */
export const CAD_ORBIT_DRAG_THRESHOLD_PX = 4;

/**
 * Lowest user-orbit elevation, in degrees: below the horizon by the same
 * margin the maximum stops short of the pole above, so the orbit runs
 * freely under the ground plane and never flips at either pole.
 */
export const CAD_ORBIT_MIN_ELEVATION_DEG = -88;

/** Highest user-orbit elevation (short of the pole flip), in degrees. */
export const CAD_ORBIT_MAX_ELEVATION_DEG = 88;

/** Closest dolly distance, in millimetres (well above the near plane). */
export const CAD_ORBIT_DISTANCE_MIN_MM = 1;

/** Farthest dolly distance, in millimetres (well inside the far plane). */
export const CAD_ORBIT_DISTANCE_MAX_MM = 1500;

/** Wheel-notch dolly factor: `distance *= exp(deltaY * this)`. */
export const CAD_ORBIT_WHEEL_FACTOR = 0.0012;

/** Arrow-key orbit step, in degrees per key press. */
export const CAD_ORBIT_KEY_STEP_DEG = 10;

/**
 * The seed a controller starts from: the camera's current placement plus
 * the viewport it frames (the orbit sensitivity is angular per pixel, so
 * it needs the viewport height and the field of view).
 */
export interface OrbitSeed {
  /** Camera position, millimetres. */
  readonly position: RenderVector3;
  /** Orbit center, millimetres. */
  readonly target: RenderVector3;
  /** The up direction (the orbit pole), normalized by the seed. */
  readonly up: RenderVector3;
  /** Viewport height, CSS pixels (sensitivity reference). */
  readonly viewportHeight: number;
  /** Vertical field of view, radians (perspective and ortho alike). */
  readonly verticalFovRad: number;
}

/**
 * The mutable user-camera state one controller owns. Plain data on
 * purpose: gestures mutate in place (pointer moves arrive at high
 * frequency and allocations are latency the pointer path does not need),
 * and the type stays free of any renderer's classes.
 */
export interface OrbitState {
  /** Orbit center, millimetres. */
  targetX: number;
  targetY: number;
  targetZ: number;
  /** Angle around the pole, radians. */
  azimuthRad: number;
  /** Angle from the ground plane, radians (clamped short of ±90°). */
  elevationRad: number;
  /** Eye distance to the target, millimetres (clamped). */
  distanceMm: number;
  /** The orbit pole (the seed's up), unit length. */
  poleX: number;
  poleY: number;
  poleZ: number;
  /** The azimuth reference (a stable pole perpendicular), unit length. */
  refX: number;
  refY: number;
  refZ: number;
  /** The second pole perpendicular (`pole × ref`), unit length. */
  jRefX: number;
  jRefY: number;
  jRefZ: number;
  /** Vertical field of view, radians (pan scale + sensitivity). */
  verticalFovRad: number;
  /** Viewport height at seed, CSS pixels (sensitivity reference). */
  viewportHeight: number;
  /** The seed's elevation — the elevation clamp always contains it. */
  seedElevationRad: number;
}

/**
 * The elevation clamp window — the pole-avoidance band, widened as needed
 * to contain the seed by construction (seeding never moves the view).
 */
function elevationClamp(state: OrbitState): {
  readonly min: number;
  readonly max: number;
} {
  return {
    min: Math.min(
      state.seedElevationRad,
      degreesToRad(CAD_ORBIT_MIN_ELEVATION_DEG),
    ),
    max: Math.max(
      state.seedElevationRad,
      degreesToRad(CAD_ORBIT_MAX_ELEVATION_DEG),
    ),
  };
}

function degreesToRad(deg: number): number {
  return (deg * Math.PI) / 180;
}

function normalize3(x: number, y: number, z: number): RenderVector3 {
  const length = Math.hypot(x, y, z);
  if (length === 0 || !Number.isFinite(length)) {
    throw new RangeError("Cannot normalize a zero-length direction.");
  }
  return [x / length, y / length, z / length];
}

function cross3(
  a: readonly [number, number, number],
  b: readonly [number, number, number],
): readonly [number, number, number] {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

/** The camera position the current orbit state describes, millimetres. */
export function orbitPosition(state: OrbitState): RenderVector3 {
  const cosE = Math.cos(state.elevationRad);
  const sinE = Math.sin(state.elevationRad);
  const cosA = Math.cos(state.azimuthRad);
  const sinA = Math.sin(state.azimuthRad);
  return [
    state.targetX +
      state.distanceMm *
        (state.refX * cosA * cosE +
          state.jRefX * sinA * cosE +
          state.poleX * sinE),
    state.targetY +
      state.distanceMm *
        (state.refY * cosA * cosE +
          state.jRefY * sinA * cosE +
          state.poleY * sinE),
    state.targetZ +
      state.distanceMm *
        (state.refZ * cosA * cosE +
          state.jRefZ * sinA * cosE +
          state.poleZ * sinE),
  ];
}

/**
 * Seeds an orbit state from a camera placement. Throws on a degenerate
 * seed (zero up vector, camera exactly on its target) — a controller
 * cannot be built from a view with no orientation.
 */
export function createOrbitState(seed: OrbitSeed): OrbitState {
  const pole = normalize3(seed.up[0], seed.up[1], seed.up[2]);
  // The azimuth reference: a stable pole perpendicular. A world axis
  // least parallel to the pole crosses it; this keeps the decomposition
  // continuous for every sane up (z-up CAD and y-up art cameras alike).
  const hint: readonly [number, number, number] =
    Math.abs(pole[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  const ref = normalize3(...cross3(hint, pole));
  const jRef = normalize3(...cross3(pole, ref));
  const offsetX = seed.position[0] - seed.target[0];
  const offsetY = seed.position[1] - seed.target[1];
  const offsetZ = seed.position[2] - seed.target[2];
  const distance = Math.hypot(offsetX, offsetY, offsetZ);
  if (distance === 0 || !Number.isFinite(distance)) {
    throw new RangeError("An orbit seed needs an eye off its target.");
  }
  const elevation = Math.asin(
    Math.min(
      1,
      Math.max(
        -1,
        (offsetX * pole[0] + offsetY * pole[1] + offsetZ * pole[2]) / distance,
      ),
    ),
  );
  const state: OrbitState = {
    azimuthRad: Math.atan2(
      offsetX * jRef[0] + offsetY * jRef[1] + offsetZ * jRef[2],
      offsetX * ref[0] + offsetY * ref[1] + offsetZ * ref[2],
    ),
    distanceMm: distance,
    elevationRad: elevation,
    jRefX: jRef[0],
    jRefY: jRef[1],
    jRefZ: jRef[2],
    poleX: pole[0],
    poleY: pole[1],
    poleZ: pole[2],
    refX: ref[0],
    refY: ref[1],
    refZ: ref[2],
    seedElevationRad: elevation,
    targetX: seed.target[0],
    targetY: seed.target[1],
    targetZ: seed.target[2],
    verticalFovRad: seed.verticalFovRad,
    viewportHeight: seed.viewportHeight,
  };
  return state;
}

/** The view axis (unit, from eye toward target) of the current state. */
function orbitForward(state: OrbitState): readonly [number, number, number] {
  const [eyeX, eyeY, eyeZ] = orbitPosition(state);
  return normalize3(
    state.targetX - eyeX,
    state.targetY - eyeY,
    state.targetZ - eyeZ,
  );
}

/**
 * Orbits by pointer travel, in CSS pixels: rightward drags swing the view
 * around the pole, downward drags raise the eye — the drag-the-model
 * convention. The elevation lands inside the clamp window, free to run
 * through the horizon and below the ground plane.
 */
export function orbitByPixels(
  state: OrbitState,
  dxPixels: number,
  dyPixels: number,
): void {
  // A full viewport-height drag ≈ one vertical field of view.
  const radiansPerPixel = state.verticalFovRad / state.viewportHeight;
  state.azimuthRad -= dxPixels * radiansPerPixel;
  const clamp = elevationClamp(state);
  state.elevationRad = Math.min(
    clamp.max,
    Math.max(clamp.min, state.elevationRad + dyPixels * radiansPerPixel),
  );
}

/**
 * Dollies by one wheel event's `deltaY`: down dollies out, up dollies in
 * (the browser-zoom convention), exponentially so distance feels
 * constant-rate at every depth. Lands inside the distance clamp.
 */
export function zoomByWheel(state: OrbitState, deltaY: number): void {
  state.distanceMm = Math.min(
    CAD_ORBIT_DISTANCE_MAX_MM,
    Math.max(
      CAD_ORBIT_DISTANCE_MIN_MM,
      state.distanceMm * Math.exp(deltaY * CAD_ORBIT_WHEEL_FACTOR),
    ),
  );
}

/** Arrow-key orbit, in degrees (the keyboard's fixed-step alternative). */
export function orbitByKeys(
  state: OrbitState,
  dxDegrees: number,
  dyDegrees: number,
): void {
  state.azimuthRad -= degreesToRad(dxDegrees);
  const clamp = elevationClamp(state);
  state.elevationRad = Math.min(
    clamp.max,
    Math.max(clamp.min, state.elevationRad + degreesToRad(dyDegrees)),
  );
}

/**
 * Pans by pointer travel, in CSS pixels: the grab-the-model convention —
 * dragging right moves the scene (and so the target) right on screen.
 * The world-per-pixel scale is the target-plane footprint of one pixel,
 * recomputed from the CURRENT distance so pan speed follows zoom.
 */
export function panByPixels(
  state: OrbitState,
  dxPixels: number,
  dyPixels: number,
): void {
  const worldPerPixel =
    (2 * state.distanceMm * Math.tan(state.verticalFovRad / 2)) /
    state.viewportHeight;
  const [fX, fY, fZ] = orbitForward(state);
  const right = normalize3(
    ...cross3([fX, fY, fZ], [state.poleX, state.poleY, state.poleZ]),
  );
  const up = normalize3(
    right[1] * fZ - right[2] * fY,
    right[2] * fX - right[0] * fZ,
    right[0] * fY - right[1] * fX,
  );
  // Screen x is rightward, screen y is downward (CSS pixels).
  const shiftX = -dxPixels * worldPerPixel;
  const shiftY = dyPixels * worldPerPixel;
  state.targetX += right[0] * shiftX + up[0] * shiftY;
  state.targetY += right[1] * shiftX + up[1] * shiftY;
  state.targetZ += right[2] * shiftX + up[2] * shiftY;
}

/** The camera state a viewport publishes on its machine surface. */
export interface SceneCameraStateSnapshot {
  /** The camera SOURCE: `"spec"` (document law) or `"user"` (overlay). */
  readonly mode: "spec" | "user";
  /** The camera's projection kind (the persp/ortho readout). */
  readonly projection: "perspective" | "orthographic";
  /** Angle around the pole, degrees (0–360, normalized). */
  readonly azimuthDeg: number;
  /** Angle from the ground plane, degrees (negative below the horizon). */
  readonly elevationDeg: number;
  /** Eye distance to the target, millimetres. */
  readonly distanceMm: number;
}

/**
 * Reads a snapshot off a state, rounded to a stable precision (the
 * machine surface is for tests and readouts, not float forensics).
 */
export function orbitSnapshot(
  state: OrbitState,
  mode: "spec" | "user",
  projection: "perspective" | "orthographic",
): SceneCameraStateSnapshot {
  const azimuthDeg =
    ((Math.atan2(Math.sin(state.azimuthRad), Math.cos(state.azimuthRad)) *
      180) /
      Math.PI +
      360) %
    360;
  return {
    azimuthDeg: Number(azimuthDeg.toFixed(1)),
    distanceMm: Number(state.distanceMm.toFixed(1)),
    elevationDeg: Number(((state.elevationRad * 180) / Math.PI).toFixed(1)),
    mode,
    projection,
  };
}

/**
 * The snapshot of a spec camera the user has not touched: derived with
 * the same decomposition the controller seeds from, so the published
 * boot numbers are exactly what the first gesture would inherit.
 */
export function sceneCameraStateFromSpec(
  spec: RenderCamera,
  viewportHeight: number,
): SceneCameraStateSnapshot {
  const verticalFovRad =
    spec.kind === "perspective"
      ? (spec.fovDeg * Math.PI) / 180
      : 2 *
        Math.atan(
          spec.viewHeight /
            2 /
            Math.hypot(
              spec.position[0] - spec.target[0],
              spec.position[1] - spec.target[1],
              spec.position[2] - spec.target[2],
            ),
        );
  const state = createOrbitState({
    position: spec.position,
    target: spec.target,
    up: spec.up,
    verticalFovRad,
    viewportHeight,
  });
  return orbitSnapshot(state, "spec", spec.kind);
}
