/**
 * Phase 59 web-layer unit coverage: the view session's lighting/quality
 * reducers and the snapshot export's camera-series math (pure, fixed
 * framing, step 0 = the current view).
 */

import { describe, expect, it } from "vitest";

import {
  createViewportViewSession,
  sessionWithLightRig,
  sessionWithRenderQuality,
} from "./viewport-view";
import { isometricSeriesCameras, turntableCameras } from "./snapshot-export";

const BASE = {
  fovDeg: 40,
  kind: "perspective" as const,
  position: [40, -30, 40] as [number, number, number],
  target: [15, 10, 5] as [number, number, number],
  up: [0, 0, 1] as [number, number, number],
};

const BOUNDS = { max: [30, 20, 10] as const, min: [0, 0, 0] as const };

describe("the viewport view session", () => {
  it("boots studio + standard, the pinned-baseline state", () => {
    const session = createViewportViewSession();
    expect(session.lightRig).toBe("studio");
    expect(session.renderQuality).toBe("standard");
  });

  it("the lighting and quality writers replace only their field", () => {
    const session = sessionWithRenderQuality(
      sessionWithLightRig(createViewportViewSession(), "inspection"),
      "quality",
    );
    expect(session.lightRig).toBe("inspection");
    expect(session.renderQuality).toBe("quality");
    expect(session.displayMode).toBe("shaded");
    expect(session.userCamera).toBeNull();
  });
});

describe("turntableCameras", () => {
  it("step 0 is the current camera; targets and distance are preserved", () => {
    const cameras = turntableCameras(BASE, 4, 90);
    expect(cameras).toHaveLength(4);
    const first = cameras[0];
    const third = cameras[2];
    if (first === undefined || third === undefined) {
      throw new Error("unreachable: the series is length 4");
    }
    expect(first.position).toEqual(BASE.position);
    expect(third.target).toEqual(BASE.target);
    const distance = (camera: (typeof cameras)[number]): number =>
      Math.hypot(
        camera.position[0] - camera.target[0],
        camera.position[1] - camera.target[1],
        camera.position[2] - camera.target[2],
      );
    const baseDistance = distance(BASE);
    for (const camera of cameras) {
      expect(distance(camera)).toBeCloseTo(baseDistance, 6);
    }
  });

  it("a 180-degree step mirrors the eye about the target on z", () => {
    const half = turntableCameras(BASE, 2, 180)[1];
    if (half === undefined) throw new Error("unreachable: index 1 of 2");
    expect(half.position[2]).toBeCloseTo(BASE.position[2], 6);
    expect(half.position[0] - BASE.target[0]).toBeCloseTo(
      -(BASE.position[0] - BASE.target[0]),
      6,
    );
  });
});

describe("isometricSeriesCameras", () => {
  it("emits the four standard views", () => {
    const cameras = isometricSeriesCameras(BOUNDS, "third-angle");
    expect(cameras).toHaveLength(4);
    for (const camera of cameras) {
      expect(camera.kind).toBe("perspective");
    }
  });
});
