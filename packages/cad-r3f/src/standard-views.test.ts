/**
 * Phase 45 standard-view/commanded-camera math: every fixture pins an
 * ANALYTIC property (direction, distance, framing, round-trip) and every
 * produced camera must pass `parseRenderCamera` — a commanded camera is
 * just another spec the scene's spec-is-law mapping applies verbatim.
 */

import { describe, expect, it } from "vitest";
import { parseRenderCamera } from "@slopcad/cad-core";
import type { RenderBounds, RenderCamera } from "@slopcad/cad-core";

import {
  boundsCenter,
  boundsRadius,
  CAD_STANDARD_VIEW_FOV_DEG,
  CAD_VIEW_FIT_MARGIN,
  fitCameraToBounds,
  framingDistance,
  isoViewCameraOfDirection,
  retargetCamera,
  standardViewCamera,
  standardViewDirection,
  toggleCameraProjection,
  zoomWindowCamera,
} from "./standard-views";

/** A 20×10×6 box centred at (5, 4, 3): analytic everything. */
const BOX: RenderBounds = {
  max: [15, 9, 6],
  min: [-5, -1, 0],
};

const BOX_RADIUS = Math.hypot(20, 10, 6) / 2;
const BOX_CENTER: readonly [number, number, number] = [5, 4, 3];

function expectValidCamera(camera: RenderCamera): void {
  const parsed = parseRenderCamera(camera);
  expect(parsed.ok).toBe(true);
}

describe("standardViewDirection", () => {
  it("third-angle: front from -Y, top from +Z, right from +X, iso from front-top-right", () => {
    expect(standardViewDirection("front", "third-angle")).toEqual([0, -1, 0]);
    expect(standardViewDirection("top", "third-angle")).toEqual([0, 0, 1]);
    expect(standardViewDirection("right", "third-angle")).toEqual([1, 0, 0]);
    expect(standardViewDirection("back", "third-angle")).toEqual([0, 1, 0]);
    expect(standardViewDirection("bottom", "third-angle")).toEqual([0, 0, -1]);
    expect(standardViewDirection("left", "third-angle")).toEqual([-1, 0, 0]);
    const iso = standardViewDirection("iso", "third-angle");
    expect([...iso]).toEqual([
      1 / Math.sqrt(3),
      -1 / Math.sqrt(3),
      1 / Math.sqrt(3),
    ]);
  });

  it("first-angle: every named view identical, iso mirrored to front-top-left", () => {
    for (const view of [
      "front",
      "back",
      "top",
      "bottom",
      "right",
      "left",
    ] as const) {
      expect(standardViewDirection(view, "first-angle")).toEqual(
        standardViewDirection(view, "third-angle"),
      );
    }
    const iso = standardViewDirection("iso", "first-angle");
    expect([...iso]).toEqual([
      -1 / Math.sqrt(3),
      -1 / Math.sqrt(3),
      1 / Math.sqrt(3),
    ]);
  });
});

describe("standardViewCamera", () => {
  it("front view: eye below -Y at the framing distance, target the box center, up +Z", () => {
    const camera = standardViewCamera("front", {
      bounds: BOX,
      convention: "third-angle",
    });
    const expectedDistance =
      (BOX_RADIUS * CAD_VIEW_FIT_MARGIN) /
      Math.sin((CAD_STANDARD_VIEW_FOV_DEG / 2) * (Math.PI / 180));
    expect(camera.kind).toBe("perspective");
    expect(camera.target).toEqual(BOX_CENTER);
    expect(camera.up).toEqual([0, 0, 1]);
    expect(camera.position[0]).toBeCloseTo(BOX_CENTER[0], 9);
    expect(camera.position[1]).toBeCloseTo(BOX_CENTER[1] - expectedDistance, 9);
    expect(camera.position[2]).toBeCloseTo(BOX_CENTER[2], 9);
    expectValidCamera(camera);
  });

  it("top view looks straight down with the model +Y up-screen", () => {
    const camera = standardViewCamera("top", {
      bounds: BOX,
      convention: "third-angle",
    });
    expect(camera.up).toEqual([0, 1, 0]);
    expect(camera.position[0]).toBeCloseTo(BOX_CENTER[0], 9);
    expect(camera.position[1]).toBeCloseTo(BOX_CENTER[1], 9);
    expect(camera.position[2]).toBeGreaterThan(BOX_CENTER[2]);
    expectValidCamera(camera);
  });

  it("iso views are valid under both conventions (never axis-parallel up)", () => {
    expectValidCamera(
      standardViewCamera("iso", { bounds: BOX, convention: "third-angle" }),
    );
    expectValidCamera(
      standardViewCamera("iso", { bounds: BOX, convention: "first-angle" }),
    );
  });
});

describe("isoViewCameraOfDirection", () => {
  it("frames from the given octant at the same analytic distance", () => {
    const camera = isoViewCameraOfDirection([-1, -1, 1], { bounds: BOX });
    const expectedDistance = framingDistance(
      BOX_RADIUS,
      CAD_STANDARD_VIEW_FOV_DEG,
      CAD_VIEW_FIT_MARGIN,
    );
    expect(camera.up).toEqual([0, 0, 1]);
    const offset: readonly [number, number, number] = [
      camera.position[0] - BOX_CENTER[0],
      camera.position[1] - BOX_CENTER[1],
      camera.position[2] - BOX_CENTER[2],
    ];
    expect(Math.hypot(...offset)).toBeCloseTo(expectedDistance, 9);
    expect(offset[0] / offset[1]).toBeCloseTo(1, 9);
    expectValidCamera(camera);
  });

  it("throws on a zero-length direction", () => {
    expect(() => isoViewCameraOfDirection([0, 0, 0], { bounds: BOX })).toThrow(
      RangeError,
    );
  });
});

describe("bounds helpers", () => {
  it("center and radius of the analytic box", () => {
    expect(boundsCenter(BOX)).toEqual(BOX_CENTER);
    expect(boundsRadius(BOX)).toBeCloseTo(BOX_RADIUS, 12);
  });
});

describe("fitCameraToBounds", () => {
  const FRONT: RenderCamera = {
    fovDeg: 50,
    kind: "perspective",
    position: [0, -120, 40],
    target: [0, 0, 0],
    up: [0, 0, 1],
  };

  it("keeps direction and up, re-centers, sets the analytic perspective distance", () => {
    const fitted = fitCameraToBounds(FRONT, { aspect: 2, bounds: BOX });
    if (fitted.kind !== "perspective") throw new Error("kind changed");
    expect(fitted.fovDeg).toBe(50);
    expect(fitted.up).toEqual([0, 0, 1]);
    expect(fitted.target).toEqual(BOX_CENTER);
    const expected = framingDistance(BOX_RADIUS, 50, CAD_VIEW_FIT_MARGIN);
    expect(
      Math.hypot(
        fitted.position[0] - BOX_CENTER[0],
        fitted.position[1] - BOX_CENTER[1],
        fitted.position[2] - BOX_CENTER[2],
      ),
    ).toBeCloseTo(expected, 9);
    // Direction preserved: still viewing along +Y.
    expect(fitted.position[1]).toBeLessThan(BOX_CENTER[1]);
    expectValidCamera(fitted);
  });

  it("orthographic fit sizes the view volume from the sphere and aspect", () => {
    const ortho: RenderCamera = {
      kind: "orthographic",
      position: [0, -100, 0],
      target: [0, 0, 0],
      up: [0, 0, 1],
      viewHeight: 80,
      viewWidth: 160,
    };
    const fitted = fitCameraToBounds(ortho, { aspect: 2, bounds: BOX });
    if (fitted.kind !== "orthographic") throw new Error("kind changed");
    expect(fitted.viewHeight).toBeCloseTo(
      2 * BOX_RADIUS * CAD_VIEW_FIT_MARGIN,
      9,
    );
    expect(fitted.viewWidth).toBeCloseTo(fitted.viewHeight * 2, 9);
    expect(fitted.target).toEqual(BOX_CENTER);
    expectValidCamera(fitted);
  });
});

describe("retargetCamera", () => {
  it("keeps direction, up, and distance while re-aiming", () => {
    const camera: RenderCamera = {
      fovDeg: 40,
      kind: "perspective",
      position: [30, -40, 0],
      target: [0, 0, 0],
      up: [0, 0, 1],
    };
    const moved = retargetCamera(camera, [10, 5, 2]);
    const before: readonly [number, number, number] = [30, -40, 0];
    const after: readonly [number, number, number] = [
      moved.position[0] - 10,
      moved.position[1] - 5,
      moved.position[2] - 2,
    ];
    const scale = after[0] / before[0];
    expect(after[1]).toBeCloseTo(before[1] * scale, 9);
    expect(after[2]).toBeCloseTo(before[2] * scale, 9);
    expect(moved.up).toEqual(camera.up);
    expectValidCamera(moved);
  });
});

describe("toggleCameraProjection", () => {
  it("round-trips through the same pose (footprint equivalence)", () => {
    const persp: RenderCamera = {
      fovDeg: 45,
      kind: "perspective",
      position: [0, -100, 0],
      target: [0, 0, 0],
      up: [0, 0, 1],
    };
    const ortho = toggleCameraProjection(persp, 2);
    if (ortho.kind !== "orthographic") throw new Error("expected ortho");
    expect(ortho.position).toEqual(persp.position);
    const distance = 100;
    expect(ortho.viewHeight).toBeCloseTo(
      2 * distance * Math.tan((45 / 2) * (Math.PI / 180)),
      9,
    );
    expect(ortho.viewWidth).toBeCloseTo(ortho.viewHeight * 2, 9);
    const back = toggleCameraProjection(ortho, 2);
    if (back.kind !== "perspective") throw new Error("expected persp");
    expect(back.fovDeg).toBeCloseTo(45, 9);
    expect(back.position).toEqual(persp.position);
    expectValidCamera(ortho);
    expectValidCamera(back);
  });
});

describe("zoomWindowCamera", () => {
  const FRONT: RenderCamera = {
    fovDeg: 40,
    kind: "perspective",
    position: [0, -100, 0],
    target: [0, 0, 0],
    up: [0, 0, 1],
  };
  const VIEWPORT = { height: 400, width: 800 };

  it("a centered half-size window halves the zoom, target unchanged", () => {
    // 400×200 inside 800×400: both ratios 0.5 → factor 0.5 (cover rule).
    const zoomed = zoomWindowCamera(FRONT, {
      rect: { height: 200, width: 400, x: 200, y: 100 },
      viewport: VIEWPORT,
    });
    if (zoomed.kind !== "perspective") throw new Error("kind changed");
    expect(zoomed.target[0]).toBeCloseTo(0, 9);
    expect(zoomed.target[1]).toBeCloseTo(0, 9);
    expect(zoomed.target[2]).toBeCloseTo(0, 9);
    expect(
      Math.hypot(
        zoomed.position[0] - zoomed.target[0],
        zoomed.position[1] - zoomed.target[1],
        zoomed.position[2] - zoomed.target[2],
      ),
    ).toBeCloseTo(50, 9);
    expectValidCamera(zoomed);
  });

  it("an off-center window re-centers the target on the rect center (screen-right = +X in a front view)", () => {
    // Rect centered at x=600 (right of center), y=200 (middle): the new
    // target moves +X by the target-plane footprint of the offset.
    const zoomed = zoomWindowCamera(FRONT, {
      rect: { height: 200, width: 200, x: 500, y: 100 },
      viewport: VIEWPORT,
    });
    const distance = 100;
    const halfHeight = distance * Math.tan((40 / 2) * (Math.PI / 180));
    // NDC x of rect center = 2*(600/800) - 1 = 0.5
    expect(zoomed.target[0]).toBeCloseTo(0.5 * halfHeight, 9);
    // NDC y = 1 - 2*(200/400) = 0
    expect(zoomed.target[2]).toBeCloseTo(0, 9);
    expectValidCamera(zoomed);
  });

  it("orthographic zoom shrinks the view volume by the factor", () => {
    const ortho: RenderCamera = {
      kind: "orthographic",
      position: [0, -100, 0],
      target: [0, 0, 0],
      up: [0, 0, 1],
      viewHeight: 80,
      viewWidth: 160,
    };
    const zoomed = zoomWindowCamera(ortho, {
      rect: { height: 200, width: 400, x: 200, y: 100 },
      viewport: VIEWPORT,
    });
    if (zoomed.kind !== "orthographic") throw new Error("kind changed");
    expect(zoomed.viewWidth).toBeCloseTo(80, 9);
    expect(zoomed.viewHeight).toBeCloseTo(40, 9);
    expectValidCamera(zoomed);
  });

  it("throws on degenerate inputs", () => {
    expect(() =>
      zoomWindowCamera(FRONT, {
        rect: { height: 0, width: 100, x: 0, y: 0 },
        viewport: VIEWPORT,
      }),
    ).toThrow(RangeError);
  });
});
