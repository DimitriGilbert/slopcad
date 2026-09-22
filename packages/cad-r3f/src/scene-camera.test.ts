/**
 * Unit tests for the Phase 11.3 deterministic camera mapping: the spec's
 * projection parameters, position, up, and target must arrive in the three
 * camera verbatim (this is the "same camera spec → same view matrices"
 * guarantee the screenshot fixtures stand on), and the update path must be
 * indistinguishable from the build path.
 */

import * as THREE from "three";
import { describe, expect, it } from "vitest";
import type { RenderCamera } from "@slopcad/cad-core";

import {
  CAD_SCENE_CAMERA_FAR_MM,
  CAD_SCENE_CAMERA_NEAR_MM,
  applySceneCamera,
  createSceneCamera,
  sceneCameraToSpec,
} from "./scene-camera";

const PERSPECTIVE: RenderCamera = {
  kind: "perspective",
  position: [50, 37, 53],
  target: [15, 10, 5],
  up: [0, 0, 1],
  fovDeg: 40,
};

const ORTHOGRAPHIC: RenderCamera = {
  kind: "orthographic",
  position: [15, 10, 100],
  target: [15, 10, 5],
  up: [0, 1, 0],
  viewWidth: 60,
  viewHeight: 40,
};

/** The normalized view direction a correctly aimed camera must face. */
function expectedViewDirection(spec: RenderCamera): THREE.Vector3 {
  return new THREE.Vector3(
    spec.target[0] - spec.position[0],
    spec.target[1] - spec.position[1],
    spec.target[2] - spec.position[2],
  ).normalize();
}

describe("scene camera mapping", () => {
  it("builds a perspective camera from the spec with the documented clip planes", () => {
    const camera = createSceneCamera(PERSPECTIVE, 1.5);
    if (!(camera instanceof THREE.PerspectiveCamera)) {
      throw new Error("A perspective spec must map to a PerspectiveCamera.");
    }
    expect(camera.fov).toBe(40);
    expect(camera.aspect).toBe(1.5);
    expect(camera.near).toBe(CAD_SCENE_CAMERA_NEAR_MM);
    expect(camera.far).toBe(CAD_SCENE_CAMERA_FAR_MM);
  });

  it("places and aims the camera exactly as the spec prescribes", () => {
    const camera = createSceneCamera(PERSPECTIVE, 1.5);
    expect(camera.position.toArray()).toEqual(PERSPECTIVE.position);
    expect(camera.up.toArray()).toEqual(PERSPECTIVE.up);
    const direction = camera.getWorldDirection(new THREE.Vector3());
    expect(
      direction.distanceTo(expectedViewDirection(PERSPECTIVE)),
    ).toBeLessThan(1e-9);
  });

  it("builds an orthographic frustum directly from the spec view volume", () => {
    const camera = createSceneCamera(ORTHOGRAPHIC, 1.5);
    if (!(camera instanceof THREE.OrthographicCamera)) {
      throw new Error(
        "An orthographic spec must map to an OrthographicCamera.",
      );
    }
    expect(camera.left).toBe(-30);
    expect(camera.right).toBe(30);
    expect(camera.top).toBe(20);
    expect(camera.bottom).toBe(-20);
    expect(camera.near).toBe(CAD_SCENE_CAMERA_NEAR_MM);
    expect(camera.far).toBe(CAD_SCENE_CAMERA_FAR_MM);
    const direction = camera.getWorldDirection(new THREE.Vector3());
    expect(
      direction.distanceTo(expectedViewDirection(ORTHOGRAPHIC)),
    ).toBeLessThan(1e-9);
  });

  it("re-applies a changed spec onto the same camera instance", () => {
    const camera = createSceneCamera(PERSPECTIVE, 1.5);
    const moved: RenderCamera = {
      kind: "perspective",
      position: [0, 0, 50],
      target: [0, 0, 0],
      up: [0, 1, 0],
      fovDeg: 60,
    };
    applySceneCamera(camera, moved, 2);
    if (!(camera instanceof THREE.PerspectiveCamera)) {
      throw new Error("A perspective spec must map to a PerspectiveCamera.");
    }
    expect(camera.fov).toBe(60);
    expect(camera.aspect).toBe(2);
    expect(camera.position.toArray()).toEqual(moved.position);
    const direction = camera.getWorldDirection(new THREE.Vector3());
    expect(direction.distanceTo(expectedViewDirection(moved))).toBeLessThan(
      1e-9,
    );
  });

  it("reads a scene camera back as a spec that re-applies identically (round-trip)", () => {
    for (const spec of [PERSPECTIVE, ORTHOGRAPHIC]) {
      const camera = createSceneCamera(spec, 1.25);
      const readBack = sceneCameraToSpec(camera, spec.target);
      expect(readBack.kind).toBe(spec.kind);
      expect(readBack.position).toEqual(spec.position);
      expect(readBack.up).toEqual(spec.up);
      expect(readBack.target).toEqual(spec.target);
      if (spec.kind === "perspective" && readBack.kind === "perspective") {
        expect(readBack.fovDeg).toBeCloseTo(spec.fovDeg, 9);
      }
      if (spec.kind === "orthographic" && readBack.kind === "orthographic") {
        expect(readBack.viewWidth).toBeCloseTo(spec.viewWidth, 9);
        expect(readBack.viewHeight).toBeCloseTo(spec.viewHeight, 9);
      }
      // The law: apply(read-back) reproduces the same placement.
      const again = createSceneCamera(readBack, 1.25);
      expect(again.position.toArray()).toEqual(camera.position.toArray());
    }
  });

  it("refuses a spec whose kind does not match the camera instance", () => {
    const camera = createSceneCamera(PERSPECTIVE, 1.5);
    expect(() => applySceneCamera(camera, ORTHOGRAPHIC, 1.5)).toThrow(
      TypeError,
    );
    const orthoCamera = createSceneCamera(ORTHOGRAPHIC, 1.5);
    expect(() => applySceneCamera(orthoCamera, PERSPECTIVE, 1.5)).toThrow(
      TypeError,
    );
  });
});
