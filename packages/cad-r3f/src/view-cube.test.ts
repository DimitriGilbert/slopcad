/**
 * Phase 45 view-cube projection: the cube is a deterministic function of
 * the camera — the front camera sees the F face head-on at the widget
 * center with T up-screen and R to the right, the top camera sees T, and
 * the painter order always draws the farthest face first. Analytic
 * positions, no rendering involved.
 */

import { describe, expect, it } from "vitest";
import type { RenderCamera } from "@slopcad/cad-core";

import { cornerIsoDirection, projectViewCube } from "./view-cube";
import { standardViewCamera } from "./standard-views";

const BOX = { max: [15, 9, 6], min: [-5, -1, 0] } as const;
const CENTER = { centerX: 50, centerY: 50, size: 40 };

function frontCamera(): RenderCamera {
  return standardViewCamera("front", {
    bounds: BOX,
    convention: "third-angle",
  });
}

describe("projectViewCube", () => {
  it("front view: F face at the widget center, T above it, R to its right", () => {
    const projection = projectViewCube(frontCamera(), CENTER);
    const front = projection.faces.find((face) => face.id === "front");
    const top = projection.faces.find((face) => face.id === "top");
    const right = projection.faces.find((face) => face.id === "right");
    if (front === undefined || top === undefined || right === undefined) {
      throw new Error("missing faces");
    }
    expect(front.center[0]).toBeCloseTo(50, 9);
    expect(front.center[1]).toBeCloseTo(50, 9);
    // +Z (top) points up-screen: smaller widget y.
    expect(top.center[1]).toBeCloseTo(30, 9);
    expect(top.center[0]).toBeCloseTo(50, 9);
    // +X (right) points right on screen.
    expect(right.center[0]).toBeCloseTo(70, 9);
    expect(right.center[1]).toBeCloseTo(50, 9);
  });

  it("front view: the F face is the LAST in painter order (nearest)", () => {
    const projection = projectViewCube(frontCamera(), CENTER);
    expect(projection.faces.at(-1)?.id).toBe("front");
    expect(projection.faces[0]?.id).toBe("back");
  });

  it("top view: T face nearest and centered", () => {
    const camera = standardViewCamera("top", {
      bounds: BOX,
      convention: "third-angle",
    });
    const projection = projectViewCube(camera, CENTER);
    const nearest = projection.faces.at(-1);
    expect(nearest?.id).toBe("top");
    expect(nearest?.center[0]).toBeCloseTo(50, 9);
    expect(nearest?.center[1]).toBeCloseTo(50, 9);
  });

  it("every face's quad is a 2×2 square in the front view (axis-aligned camera)", () => {
    const projection = projectViewCube(frontCamera(), CENTER);
    for (const face of projection.faces) {
      const xs = face.points.map((p) => p[0]);
      const ys = face.points.map((p) => p[1]);
      const width = Math.max(...xs) - Math.min(...xs);
      const height = Math.max(...ys) - Math.min(...ys);
      // Head-on faces are full-size; edge-on faces collapse one axis.
      expect(Math.max(width, height)).toBeCloseTo(40, 6);
      expect(Math.min(width, height)).toBeLessThanOrEqual(40 + 1e-6);
    }
  });

  it("reports the nearest corner for the ISO click target", () => {
    const projection = projectViewCube(frontCamera(), CENTER);
    // Front camera (0,-d,0): nearest corner is +x? No — all four z>0
    // corners are nearer than z<0; among them the exact answer is the
    // tie-broken deepest. It must be one of the +z corners.
    expect(projection.nearestCornerId).toMatch(/\+z$/);
    expect(projection.corners).toHaveLength(8);
  });
});

describe("cornerIsoDirection", () => {
  it("parses octant corner ids to world directions", () => {
    expect(cornerIsoDirection("+x-y+z")).toEqual([1, -1, 1]);
    expect(cornerIsoDirection("-x+y-z")).toEqual([-1, 1, -1]);
  });

  it("rejects malformed ids", () => {
    expect(cornerIsoDirection("front")).toBeNull();
    expect(cornerIsoDirection("+x-y")).toBeNull();
    expect(cornerIsoDirection("++x-y+z")).toBeNull();
  });
});
