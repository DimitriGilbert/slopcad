/**
 * Standard views and camera commands (Phase 45): the pure, renderer-free
 * math behind navigation — standard view cameras, fit-to-bounds, the
 * perspective/orthographic toggle, zoom-window, and look-at. Every
 * function is plain float64 arithmetic over plain data and every result
 * is a structurally valid {@link RenderCamera} (they pass
 * `parseRenderCamera`; the unit tests pin that), so a commanded camera is
 * just another spec the scene's spec-is-law mapping applies verbatim.
 *
 * ## Conventions (documented once, used everywhere)
 *
 * - Model space is the CAD Z-up, right-handed millimetre frame the whole
 *   repo renders in: +X right, +Y back (away from the front viewer), +Z up.
 * - **Third angle** (the default): FRONT views from −Y, TOP from +Z with
 *   the model's +Y pointing up-screen, RIGHT from +X, and the standard
 *   ISO corner is front-top-right `(+X, −Y, +Z)`.
 * - **First angle**: every named view's CONTENT is identical (first vs
 *   third angle differ in drawing-sheet ARRANGEMENT, not in what any one
 *   view shows); the convention's visible viewport effect is the ISO
 *   corner — front-top-LEFT `(−X, −Y, +Z)` — mirroring the projection
 *   arrangement the drawings phase will inherit (see
 *   `docs/architecture/adr-user-camera-overlay.md`).
 * - Distances derive from the bounds' bounding SPHERE, so a fit frames
 *   the model from every direction, not just the axis it happens to view
 *   along: `radius = half-diagonal`, `distance = radius / sin(fov/2)`
 *   with a margin factor.
 */

import type {
  RenderBounds,
  RenderCamera,
  RenderVector3,
} from "@slopcad/cad-core";

/** The projection-arrangement convention (see the module doc). */
export type ViewAngleConvention = "first-angle" | "third-angle";

/** The named standard views; `iso` follows the angle convention. */
export type StandardViewId =
  "front" | "back" | "top" | "bottom" | "right" | "left" | "iso";

/**
 * Fraction of the framing distance kept as empty margin around the model
 * (1.0 would touch the bounds sphere exactly at the field-of-view edge).
 */
export const CAD_VIEW_FIT_MARGIN = 1.1;

/** The vertical field of view of standard-view cameras, degrees. */
export const CAD_STANDARD_VIEW_FOV_DEG = 40;

/** The unit view direction of one standard view under one convention. */
export function standardViewDirection(
  view: StandardViewId,
  convention: ViewAngleConvention,
): RenderVector3 {
  switch (view) {
    case "front":
      return [0, -1, 0];
    case "back":
      return [0, 1, 0];
    case "top":
      return [0, 0, 1];
    case "bottom":
      return [0, 0, -1];
    case "right":
      return [1, 0, 0];
    case "left":
      return [-1, 0, 0];
    case "iso":
      // Front-top-right in third angle; the mirrored front-top-left in
      // first angle (the convention's visible effect — module doc).
      return convention === "third-angle"
        ? normalize([1, -1, 1])
        : normalize([-1, -1, 1]);
  }
}

/** The camera up direction of one standard view. */
function standardViewUp(view: StandardViewId): RenderVector3 {
  if (view === "top") return [0, 1, 0];
  if (view === "bottom") return [0, -1, 0];
  // Every side view and both ISO corners keep the CAD up.
  return [0, 0, 1];
}

function normalize(v: readonly [number, number, number]): RenderVector3 {
  const length = Math.hypot(v[0], v[1], v[2]);
  if (length === 0 || !Number.isFinite(length)) {
    throw new RangeError("Cannot normalize a zero-length direction.");
  }
  return [v[0] / length, v[1] / length, v[2] / length];
}

/** The center of a bounds box. */
export function boundsCenter(
  bounds: RenderBounds,
): readonly [number, number, number] {
  return [
    (bounds.min[0] + bounds.max[0]) / 2,
    (bounds.min[1] + bounds.max[1]) / 2,
    (bounds.min[2] + bounds.max[2]) / 2,
  ];
}

/** Half the bounds box diagonal — the bounding-sphere radius (fit math). */
export function boundsRadius(bounds: RenderBounds): number {
  return (
    Math.hypot(
      bounds.max[0] - bounds.min[0],
      bounds.max[1] - bounds.min[1],
      bounds.max[2] - bounds.min[2],
    ) / 2
  );
}

/** The distance a camera with this vertical FOV frames a radius at. */
export function framingDistance(
  radius: number,
  fovDeg: number,
  margin: number,
): number {
  if (radius <= 0) return margin;
  return (radius * margin) / Math.sin(((fovDeg / 2) * Math.PI) / 180);
}

/**
 * The ISO camera of an arbitrary octant direction (the view-cube corner
 * click): the same framing math as {@link standardViewCamera} with the
 * CAD up, aimed from `direction` (normalized by this function; throws on
 * a zero-length or view-parallel direction — a degenerate octant has no
 * camera).
 */
export function isoViewCameraOfDirection(
  direction: RenderVector3,
  options: {
    readonly bounds: RenderBounds;
    readonly fovDeg?: number;
  },
): RenderCamera {
  const fovDeg = options.fovDeg ?? CAD_STANDARD_VIEW_FOV_DEG;
  const unit = normalize([direction[0], direction[1], direction[2]]);
  const center = boundsCenter(options.bounds);
  const distance = framingDistance(
    boundsRadius(options.bounds),
    fovDeg,
    CAD_VIEW_FIT_MARGIN,
  );
  return {
    fovDeg,
    kind: "perspective",
    position: [
      center[0] + unit[0] * distance,
      center[1] + unit[1] * distance,
      center[2] + unit[2] * distance,
    ],
    target: [center[0], center[1], center[2]],
    up: [0, 0, 1],
  };
}

/**
 * The perspective camera of one standard view over one bounds box: eye
 * along the view direction at the framing distance, target the box
 * center, up the view's convention up. Throws on a degenerate box (zero
 * diagonal) — a view of nothing has no honest camera.
 */
export function standardViewCamera(
  view: StandardViewId,
  options: {
    readonly bounds: RenderBounds;
    readonly convention: ViewAngleConvention;
    readonly fovDeg?: number;
  },
): RenderCamera {
  if (view === "iso") {
    return isoViewCameraOfDirection(
      standardViewDirection("iso", options.convention),
      options,
    );
  }
  const fovDeg = options.fovDeg ?? CAD_STANDARD_VIEW_FOV_DEG;
  const direction = standardViewDirection(view, options.convention);
  const center = boundsCenter(options.bounds);
  const distance = framingDistance(
    boundsRadius(options.bounds),
    fovDeg,
    CAD_VIEW_FIT_MARGIN,
  );
  return {
    fovDeg,
    kind: "perspective",
    position: [
      center[0] + direction[0] * distance,
      center[1] + direction[1] * distance,
      center[2] + direction[2] * distance,
    ],
    target: [center[0], center[1], center[2]],
    up: standardViewUp(view),
  };
}

/**
 * Fit-to-bounds of the CURRENT view: keeps the camera's direction and up,
 * re-centers on the bounds, and sets the framing — perspective distance
 * from the (unchanged) FOV, orthographic view volume from the bounds
 * sphere and the viewport's aspect (the spec-authored volume rule:
 * `viewWidth/viewHeight` are authored per viewport, so the caller supplies
 * the aspect it renders at).
 */
export function fitCameraToBounds(
  camera: RenderCamera,
  options: {
    readonly bounds: RenderBounds;
    readonly aspect: number;
    readonly margin?: number;
  },
): RenderCamera {
  const center = boundsCenter(options.bounds);
  const radius = boundsRadius(options.bounds);
  const margin = options.margin ?? CAD_VIEW_FIT_MARGIN;
  const direction = normalize([
    camera.position[0] - camera.target[0],
    camera.position[1] - camera.target[1],
    camera.position[2] - camera.target[2],
  ]);
  const distance =
    camera.kind === "perspective"
      ? framingDistance(radius, camera.fovDeg, margin)
      : Math.max(radius * margin, CAD_VIEW_FIT_MARGIN);
  const position: RenderVector3 = [
    center[0] + direction[0] * distance,
    center[1] + direction[1] * distance,
    center[2] + direction[2] * distance,
  ];
  if (camera.kind === "perspective") {
    return { ...camera, position, target: center };
  }
  // The orthographic volume: the sphere's footprint in view-height units,
  // width-following so the volume matches the viewport it will fill.
  const viewHeight = 2 * radius * margin;
  return {
    ...camera,
    position,
    target: center,
    viewHeight,
    viewWidth: viewHeight * options.aspect,
  };
}

/**
 * Look-at: re-targets keeping the view DIRECTION, up, and distance — the
 * same pose aimed at a new center (the selection look-at command).
 */
export function retargetCamera(
  camera: RenderCamera,
  target: RenderVector3,
): RenderCamera {
  const direction = normalize([
    camera.position[0] - camera.target[0],
    camera.position[1] - camera.target[1],
    camera.position[2] - camera.target[2],
  ]);
  const distance = Math.hypot(
    camera.position[0] - camera.target[0],
    camera.position[1] - camera.target[1],
    camera.position[2] - camera.target[2],
  );
  return {
    ...camera,
    position: [
      target[0] + direction[0] * distance,
      target[1] + direction[1] * distance,
      target[2] + direction[2] * distance,
    ],
    target: [target[0], target[1], target[2]],
  };
}

/**
 * Perspective ⇄ orthographic at the same pose. Perspective → ortho: the
 * view volume is the target-plane footprint of the perspective frustum
 * (`2·distance·tan(fov/2)`), width from the viewport aspect. Ortho →
 * perspective: the inverse — the FOV whose target-plane footprint equals
 * the orthographic view height at the same distance.
 */
export function toggleCameraProjection(
  camera: RenderCamera,
  aspect: number,
): RenderCamera {
  const distance = Math.hypot(
    camera.position[0] - camera.target[0],
    camera.position[1] - camera.target[1],
    camera.position[2] - camera.target[2],
  );
  if (distance === 0) {
    throw new RangeError("A projection toggle needs an eye off its target.");
  }
  if (camera.kind === "perspective") {
    const viewHeight =
      2 * distance * Math.tan(((camera.fovDeg / 2) * Math.PI) / 180);
    return {
      kind: "orthographic",
      position: camera.position,
      target: camera.target,
      up: camera.up,
      viewHeight,
      viewWidth: viewHeight * aspect,
    };
  }
  const fovRad = 2 * Math.atan(camera.viewHeight / 2 / distance);
  return {
    fovDeg: (fovRad * 180) / Math.PI,
    kind: "perspective",
    position: camera.position,
    target: camera.target,
    up: camera.up,
  };
}

/** A viewport rectangle in CSS pixels (the zoom-window drag). */
export interface ViewportRect {
  /** Left edge, CSS px. */
  readonly x: number;
  /** Top edge, CSS px. */
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * Zoom-window: the camera after zooming into a dragged rectangle. The
 * zoom factor is the LARGER of the rect's width/height ratios (so the
 * whole rect is guaranteed inside the framed view — the "cover" rule);
 * the new center is the world point under the rect's center, taken on
 * the plane through the current target perpendicular to the view axis
 * (zoom keeps depth; it never dollies). Perspective tightens by
 * shortening the distance, orthography by shrinking the view volume —
 * each is the honest zoom of its kind.
 */
export function zoomWindowCamera(
  camera: RenderCamera,
  options: {
    readonly rect: ViewportRect;
    readonly viewport: { readonly width: number; readonly height: number };
  },
): RenderCamera {
  if (options.viewport.width <= 0 || options.viewport.height <= 0) {
    throw new RangeError("Zoom window needs a non-empty viewport.");
  }
  if (options.rect.width <= 0 || options.rect.height <= 0) {
    throw new RangeError("Zoom window needs a non-empty rectangle.");
  }
  const factor = Math.max(
    options.rect.width / options.viewport.width,
    options.rect.height / options.viewport.height,
  );
  const viewAxis = normalize([
    camera.target[0] - camera.position[0],
    camera.target[1] - camera.position[1],
    camera.target[2] - camera.position[2],
  ]);
  // The camera's screen axes in world space — the same handedness the
  // three.js `lookAt` builds: right = viewAxis × up, screenUp = right ×
  // viewAxis (verified on the front view: viewAxis +Y, up +Z → right +X,
  // screenUp +Z).
  const up = normalize([camera.up[0], camera.up[1], camera.up[2]]);
  const right = normalize([
    viewAxis[1] * up[2] - viewAxis[2] * up[1],
    viewAxis[2] * up[0] - viewAxis[0] * up[2],
    viewAxis[0] * up[1] - viewAxis[1] * up[0],
  ]);
  const screenUp: RenderVector3 = [
    right[1] * viewAxis[2] - right[2] * viewAxis[1],
    right[2] * viewAxis[0] - right[0] * viewAxis[2],
    right[0] * viewAxis[1] - right[1] * viewAxis[0],
  ];
  const rectCenterX = options.rect.x + options.rect.width / 2;
  const rectCenterY = options.rect.y + options.rect.height / 2;
  // NDC-style offsets along the screen axes: x rightward, y upward
  // (screen y grows downward, hence the flip).
  const ndcX = (2 * rectCenterX) / options.viewport.width - 1;
  const ndcY = 1 - (2 * rectCenterY) / options.viewport.height;
  // The world-per-NDC-unit scale at the target plane, per camera kind.
  const distance = Math.hypot(
    camera.position[0] - camera.target[0],
    camera.position[1] - camera.target[1],
    camera.position[2] - camera.target[2],
  );
  const planeHalfHeight =
    camera.kind === "perspective"
      ? distance * Math.tan(((camera.fovDeg / 2) * Math.PI) / 180)
      : camera.viewHeight / 2;
  const shiftX = ndcX * planeHalfHeight;
  const shiftY = ndcY * planeHalfHeight;
  const newTarget: RenderVector3 = [
    camera.target[0] + right[0] * shiftX + screenUp[0] * shiftY,
    camera.target[1] + right[1] * shiftX + screenUp[1] * shiftY,
    camera.target[2] + right[2] * shiftX + screenUp[2] * shiftY,
  ];
  if (camera.kind === "perspective") {
    return retargetAndDolly(camera, newTarget, distance * factor);
  }
  const scaled: RenderCamera = {
    ...camera,
    position: alongAxis(camera, newTarget, distance),
    target: newTarget,
    viewHeight: camera.viewHeight * factor,
    viewWidth: camera.viewWidth * factor,
  };
  return scaled;
}

/** Re-aims at `target` keeping the view axis, then sets the distance. */
function retargetAndDolly(
  camera: RenderCamera,
  target: RenderVector3,
  distance: number,
): RenderCamera {
  return {
    ...camera,
    position: alongAxis(camera, target, distance),
    target: [target[0], target[1], target[2]],
  };
}

/** The eye point at `distance` behind `target` along the current view axis. */
function alongAxis(
  camera: RenderCamera,
  target: RenderVector3,
  distance: number,
): RenderVector3 {
  const viewAxis = normalize([
    camera.target[0] - camera.position[0],
    camera.target[1] - camera.position[1],
    camera.target[2] - camera.position[2],
  ]);
  return [
    target[0] - viewAxis[0] * distance,
    target[1] - viewAxis[1] * distance,
    target[2] - viewAxis[2] * distance,
  ];
}
