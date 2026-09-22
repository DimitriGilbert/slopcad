/**
 * The view cube's geometry (Phase 45): a pure projection of a labeled
 * unit cube through a camera, for an SVG nav widget. No three.js, no
 * DOM — float math that maps each cube face to a screen-space quad plus
 * the depth that orders them, so the widget is a deterministic function
 * of the camera it mirrors (and the same camera always draws the same
 * cube).
 *
 * The cube's faces carry the standard-view labels (F/B/T/Bo/R/L for
 * front/back/top/bottom/right/left in the Z-up CAD frame); a click on a
 * face commands that standard view, and a click on the nearest corner
 * commands the ISO view of that octant.
 */

import type { RenderCamera, RenderVector3 } from "@slopcad/cad-core";

/** The six cube faces: axis sign → standard-view label. */
export type ViewCubeFaceId =
  "front" | "back" | "top" | "bottom" | "right" | "left";

/** One face's 2D quad in widget coordinates (y grows downward, SVG). */
export interface ViewCubeFace {
  readonly id: ViewCubeFaceId;
  /** The quad's corners, widget px, clockwise on screen. */
  readonly points: readonly (readonly [number, number])[];
  /** The projected face center, widget px. */
  readonly center: readonly [number, number];
  /** The face's outward normal depth along the view axis (negative = nearer). */
  readonly depth: number;
}

/** The cube projection: the faces (already painter-ordered) + corners. */
export interface ViewCubeProjection {
  readonly faces: readonly ViewCubeFace[];
  /** The 8 corners, painter-ordered (farthest first). */
  readonly corners: readonly {
    readonly id: string;
    readonly point: readonly [number, number];
    readonly depth: number;
  }[];
  /** The corner nearest the viewer (the ISO-click target), if any. */
  readonly nearestCornerId: string | null;
}

/** Which direction each face's outward normal points (Z-up CAD frame). */
const FACE_NORMALS: Readonly<Record<ViewCubeFaceId, RenderVector3>> =
  Object.freeze({
    back: [0, 1, 0],
    bottom: [0, 0, -1],
    front: [0, -1, 0],
    left: [-1, 0, 0],
    right: [1, 0, 0],
    top: [0, 0, 1],
  });

/** The two in-plane axes that span each face (unit cube corners ±1). */
const FACE_SPANS: Readonly<Record<ViewCubeFaceId, readonly RenderVector3[]>> =
  Object.freeze({
    back: [
      [1, 0, 0],
      [0, 0, 1],
    ],
    bottom: [
      [1, 0, 0],
      [0, 1, 0],
    ],
    front: [
      [1, 0, 0],
      [0, 0, 1],
    ],
    left: [
      [0, 1, 0],
      [0, 0, 1],
    ],
    right: [
      [0, 1, 0],
      [0, 0, 1],
    ],
    top: [
      [1, 0, 0],
      [0, 1, 0],
    ],
  });

function normalize(v: readonly [number, number, number]): RenderVector3 {
  const length = Math.hypot(v[0], v[1], v[2]);
  if (length === 0 || !Number.isFinite(length)) {
    throw new RangeError("Cannot normalize a zero-length direction.");
  }
  return [v[0] / length, v[1] / length, v[2] / length];
}

/**
 * Projects the labeled unit cube through a camera into a
 * `size × size` widget box centered at `(centerX, centerY)` (widget px).
 * The camera's screen axes (the same handedness three's `lookAt` builds
 * — see `standard-views.zoomWindowCamera`) place every cube point; depth
 * is measured along the view axis (negative = nearer the viewer), and the
 * faces come back painter-ordered (farthest first) ready to render.
 */
export function projectViewCube(
  camera: RenderCamera,
  options: {
    readonly centerX: number;
    readonly centerY: number;
    readonly size: number;
  },
): ViewCubeProjection {
  const half = options.size / 2;
  const viewAxis = normalize([
    camera.target[0] - camera.position[0],
    camera.target[1] - camera.position[1],
    camera.target[2] - camera.position[2],
  ]);
  const up = normalize([camera.up[0], camera.up[1], camera.up[2]]);
  const right: RenderVector3 = [
    viewAxis[1] * up[2] - viewAxis[2] * up[1],
    viewAxis[2] * up[0] - viewAxis[0] * up[2],
    viewAxis[0] * up[1] - viewAxis[1] * up[0],
  ];
  const screenUp: RenderVector3 = [
    right[1] * viewAxis[2] - right[2] * viewAxis[1],
    right[2] * viewAxis[0] - right[0] * viewAxis[2],
    right[0] * viewAxis[1] - right[1] * viewAxis[0],
  ];
  // One cube point (±1 per axis) → widget px + view-axis depth.
  const project = (
    p: readonly [number, number, number],
  ): readonly [number, number, number] => [
    options.centerX +
      (p[0] * right[0] + p[1] * right[1] + p[2] * right[2]) * half,
    options.centerY -
      (p[0] * screenUp[0] + p[1] * screenUp[1] + p[2] * screenUp[2]) * half,
    p[0] * viewAxis[0] + p[1] * viewAxis[1] + p[2] * viewAxis[2],
  ];

  const faces: ViewCubeFace[] = [];
  for (const id of Object.keys(FACE_NORMALS) as ViewCubeFaceId[]) {
    const n = FACE_NORMALS[id];
    const spans = FACE_SPANS[id];
    if (n === undefined || spans === undefined || spans.length !== 2) {
      throw new Error(`The view-cube face table is incomplete for "${id}".`);
    }
    const maybeA = spans[0];
    const maybeB = spans[1];
    if (maybeA === undefined || maybeB === undefined) {
      throw new Error(`The view-cube face table is incomplete for "${id}".`);
    }
    const a: readonly [number, number, number] = maybeA;
    const b: readonly [number, number, number] = maybeB;
    const corner = (
      sa: number,
      sb: number,
    ): readonly [number, number, number] => [
      n[0] + a[0] * sa + b[0] * sb,
      n[1] + a[1] * sa + b[1] * sb,
      n[2] + a[2] * sa + b[2] * sb,
    ];
    const quad: readonly (readonly [number, number])[] = [
      corner(-1, -1),
      corner(1, -1),
      corner(1, 1),
      corner(-1, 1),
    ]
      .map((c) => project(c))
      .map((r) => [r[0], r[1]] as const);
    const projectedCenter = project(n);
    faces.push({
      center: [projectedCenter[0], projectedCenter[1]],
      depth: projectedCenter[2],
      id,
      points: quad,
    });
  }
  faces.sort((x, y) => y.depth - x.depth);

  const cornerPoints: readonly (readonly [number, number, number])[] = [
    [-1, -1, -1],
    [1, -1, -1],
    [-1, 1, -1],
    [1, 1, -1],
    [-1, -1, 1],
    [1, -1, 1],
    [-1, 1, 1],
    [1, 1, 1],
  ];
  const cornerIds: readonly string[] = [
    "-x-y-z",
    "+x-y-z",
    "-x+y-z",
    "+x+y-z",
    "-x-y+z",
    "+x-y+z",
    "-x+y+z",
    "+x+y+z",
  ];
  const projectedCorners: readonly {
    readonly id: string;
    readonly point: readonly [number, number];
    readonly depth: number;
  }[] = cornerIds
    .map((id, index) => {
      const p = cornerPoints[index];
      if (p === undefined) {
        throw new Error("The view-cube corner table is misaligned.");
      }
      const r = project(p);
      return { depth: r[2], id, point: [r[0], r[1]] as const };
    })
    .sort((x, y) => y.depth - x.depth);

  return {
    corners: projectedCorners,
    faces,
    nearestCornerId: projectedCorners.at(-1)?.id ?? null,
  };
}

/**
 * The ISO view direction of a cube corner id (`"+x-y+z"`-style): the
 * octant the clicked corner lives in, as a world direction — the
 * view-cube corner click composes {@link isoViewCameraOfDirection} with
 * it. Returns `null` for a malformed id.
 */
export function cornerIsoDirection(cornerId: string): RenderVector3 | null {
  if (!/^[+-][xyz][+-][xyz][+-][xyz]$/.test(cornerId)) return null;
  const parts = cornerId.match(/[+-][xyz]/g);
  if (parts === null || parts.length !== 3) return null;
  const direction: [number, number, number] = [0, 0, 0];
  for (const part of parts) {
    const sign = part[0] === "+" ? 1 : -1;
    const axis = part[1];
    if (axis === "x") direction[0] = sign;
    else if (axis === "y") direction[1] = sign;
    else direction[2] = sign;
  }
  return direction;
}
