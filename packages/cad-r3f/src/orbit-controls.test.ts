/**
 * Unit tests for the user camera's orbit math: the seed must reproduce
 * the exact view it was built from (takeover without a jump), the
 * gestures must move the camera the CAD conventions promise, every clamp
 * must hold, and the whole module must be deterministic — the same seed
 * and the same gestures always produce the same numbers.
 */

import { describe, expect, it } from "vitest";
import type { RenderCamera } from "@slopcad/cad-core";

import {
  CAD_ORBIT_DISTANCE_MAX_MM,
  CAD_ORBIT_DISTANCE_MIN_MM,
  CAD_ORBIT_KEY_STEP_DEG,
  CAD_ORBIT_MAX_ELEVATION_DEG,
  CAD_ORBIT_MIN_ELEVATION_DEG,
  createOrbitState,
  orbitByKeys,
  orbitByPixels,
  orbitPosition,
  orbitSnapshot,
  panByPixels,
  sceneCameraStateFromSpec,
  zoomByWheel,
  type OrbitState,
} from "./orbit-controls";

/** The render fixture's deterministic camera (z-up CAD world). */
const FIXTURE_CAMERA: RenderCamera = {
  kind: "perspective",
  position: [44, -30, 47],
  target: [15, 10, 5],
  up: [0, 0, 1],
  fovDeg: 40,
};

/** A seed matching the fixture camera framed in a 520px-tall viewport. */
function seedFixture(viewportHeight = 520): {
  position: readonly [number, number, number];
  target: readonly [number, number, number];
  up: readonly [number, number, number];
  verticalFovRad: number;
  viewportHeight: number;
} {
  // The fixture camera's 40° vertical fov, in radians.
  return {
    position: FIXTURE_CAMERA.position,
    target: FIXTURE_CAMERA.target,
    up: FIXTURE_CAMERA.up,
    verticalFovRad: (40 * Math.PI) / 180,
    viewportHeight,
  };
}

describe("orbit state seeding", () => {
  it("reproduces the seeded view exactly — takeover never jumps", () => {
    const state = createOrbitState(seedFixture());
    const [x, y, z] = orbitPosition(state);
    expect(x).toBeCloseTo(FIXTURE_CAMERA.position[0], 9);
    expect(y).toBeCloseTo(FIXTURE_CAMERA.position[1], 9);
    expect(z).toBeCloseTo(FIXTURE_CAMERA.position[2], 9);
  });

  it("is deterministic: the same seed yields the identical decomposition", () => {
    const first = createOrbitState(seedFixture());
    const second = createOrbitState(seedFixture());
    expect(orbitPosition(first)).toEqual(orbitPosition(second));
    expect(orbitSnapshot(first, "spec", "perspective")).toEqual(
      orbitSnapshot(second, "spec", "perspective"),
    );
  });

  it("seeds the elevation above the ground plane for a z-up camera", () => {
    const state = createOrbitState(seedFixture());
    const elevationDeg = (state.elevationRad * 180) / Math.PI;
    // The fixture eye sits 42mm above its target over a ~65mm distance.
    expect(elevationDeg).toBeGreaterThan(30);
    expect(elevationDeg).toBeLessThan(50);
  });

  it("throws on a degenerate seed (eye on target, zero up)", () => {
    expect(() =>
      createOrbitState({
        ...seedFixture(),
        position: FIXTURE_CAMERA.target,
      }),
    ).toThrow(RangeError);
    expect(() => createOrbitState({ ...seedFixture(), up: [0, 0, 0] })).toThrow(
      RangeError,
    );
  });
});

describe("orbit gestures", () => {
  it("keeps the target and distance fixed while orbiting", () => {
    const state = createOrbitState(seedFixture());
    const distance = state.distanceMm;
    orbitByPixels(state, 120, -80);
    expect(state.targetX).toBe(FIXTURE_CAMERA.target[0]);
    expect(state.targetY).toBe(FIXTURE_CAMERA.target[1]);
    expect(state.targetZ).toBe(FIXTURE_CAMERA.target[2]);
    expect(state.distanceMm).toBe(distance);
    // ...and the eye stays exactly the clamped distance from that target.
    const [x, y, z] = orbitPosition(state);
    expect(
      Math.hypot(x - state.targetX, y - state.targetY, z - state.targetZ),
    ).toBeCloseTo(distance, 6);
  });

  it("changes the view (the orbit actually orbits)", () => {
    const state = createOrbitState(seedFixture());
    const before = orbitPosition(state);
    orbitByPixels(state, 200, 0);
    const after = orbitPosition(state);
    expect(after).not.toEqual(before);
  });

  it("clamps elevation to the documented band", () => {
    const state = createOrbitState(seedFixture());
    orbitByPixels(state, 0, 100_000);
    expect((state.elevationRad * 180) / Math.PI).toBeCloseTo(
      CAD_ORBIT_MAX_ELEVATION_DEG,
      6,
    );
    orbitByPixels(state, 0, -1_000_000);
    expect((state.elevationRad * 180) / Math.PI).toBeCloseTo(
      CAD_ORBIT_MIN_ELEVATION_DEG,
      6,
    );
  });

  it("keeps a below-band seed reachable (seeding never moves the view)", () => {
    // A spec camera seeded below the documented band — nearly under the
    // target, an unusual but legal view: the clamp window must contain
    // it, so the first orbit gesture does not snap the camera.
    const state = createOrbitState({
      ...seedFixture(),
      position: [15.5, 10, -95],
    });
    const seedElevationDeg = (state.elevationRad * 180) / Math.PI;
    expect(seedElevationDeg).toBeLessThan(CAD_ORBIT_MIN_ELEVATION_DEG);
    orbitByPixels(state, 0, 10);
    expect((state.elevationRad * 180) / Math.PI).toBeGreaterThanOrEqual(
      seedElevationDeg - 1e-9,
    );
  });

  it("orbits freely through the horizon and below the ground plane", () => {
    const state = createOrbitState(seedFixture());
    // A long downward stroke: the elevation must pass through the
    // horizon and land well below it — the underside of the model is a
    // first-class viewpoint, not a dead zone.
    orbitByPixels(state, 0, -1_500);
    const elevationDeg = (state.elevationRad * 180) / Math.PI;
    expect(elevationDeg).toBeLessThan(-45);
    expect(elevationDeg).toBeGreaterThanOrEqual(CAD_ORBIT_MIN_ELEVATION_DEG);
    // ...and the eye really is underneath its target (z-up world):
    // below −45°, the vertical drop dominates the horizontal offset.
    const [x, y, z] = orbitPosition(state);
    expect(z).toBeLessThan(state.targetZ);
    expect(Math.hypot(x - state.targetX, y - state.targetY)).toBeLessThan(
      Math.abs(z - state.targetZ),
    );
  });

  it("crosses the horizon continuously — no jump, no flip", () => {
    const state = createOrbitState(seedFixture());
    // Equal strokes must produce equal elevation steps all the way down:
    // the clamp is a boundary, not a discontinuity.
    const radiansPerPixel = state.verticalFovRad / state.viewportHeight;
    const stepPx = 40;
    let previous = state.elevationRad;
    let landedBelow = false;
    for (let step = 0; step < 40; step += 1) {
      orbitByPixels(state, 0, -stepPx);
      const expected = previous - stepPx * radiansPerPixel;
      expect(state.elevationRad).toBeCloseTo(expected, 9);
      if (state.elevationRad < 0) landedBelow = true;
      previous = state.elevationRad;
    }
    expect(landedBelow).toBe(true);
  });

  it("stops just short of the nadir pole (the up-vector never degenerates)", () => {
    const state = createOrbitState(seedFixture());
    orbitByPixels(state, 0, -100_000);
    const elevationDeg = (state.elevationRad * 180) / Math.PI;
    expect(elevationDeg).toBeCloseTo(CAD_ORBIT_MIN_ELEVATION_DEG, 6);
    expect(Math.abs(elevationDeg)).toBeLessThan(90);
    // The keyboard path obeys the same window.
    orbitByKeys(state, 0, -CAD_ORBIT_KEY_STEP_DEG);
    expect((state.elevationRad * 180) / Math.PI).toBeCloseTo(
      CAD_ORBIT_MIN_ELEVATION_DEG,
      6,
    );
  });

  it("orbits in fixed steps from the keyboard", () => {
    const state = createOrbitState(seedFixture());
    const azimuthBefore = state.azimuthRad;
    const elevationBefore = state.elevationRad;
    orbitByKeys(state, CAD_ORBIT_KEY_STEP_DEG, -CAD_ORBIT_KEY_STEP_DEG);
    expect(state.azimuthRad).toBeCloseTo(
      azimuthBefore - (CAD_ORBIT_KEY_STEP_DEG * Math.PI) / 180,
      12,
    );
    expect(state.elevationRad).toBeCloseTo(
      elevationBefore - (CAD_ORBIT_KEY_STEP_DEG * Math.PI) / 180,
      12,
    );
  });
});

describe("wheel dolly", () => {
  it("dollies in on negative deltaY and out on positive", () => {
    const inward = createOrbitState(seedFixture());
    const outward = createOrbitState(seedFixture());
    const distance = inward.distanceMm;
    zoomByWheel(inward, -120);
    zoomByWheel(outward, 120);
    expect(inward.distanceMm).toBeLessThan(distance);
    expect(outward.distanceMm).toBeGreaterThan(distance);
  });

  it("clamps to the documented distance band", () => {
    const state = createOrbitState(seedFixture());
    zoomByWheel(state, -1e9);
    expect(state.distanceMm).toBe(CAD_ORBIT_DISTANCE_MIN_MM);
    zoomByWheel(state, 1e9);
    expect(state.distanceMm).toBe(CAD_ORBIT_DISTANCE_MAX_MM);
  });

  it("is exponential: equal notches at any depth feel equal", () => {
    const near = createOrbitState(seedFixture());
    near.distanceMm = 20;
    const far = createOrbitState(seedFixture());
    far.distanceMm = 400;
    zoomByWheel(near, -120);
    zoomByWheel(far, -120);
    expect(near.distanceMm / 20).toBeCloseTo(far.distanceMm / 400, 9);
  });
});

describe("pan gestures", () => {
  it("moves the target perpendicular to the view axis, not the eye distance", () => {
    const state: OrbitState = createOrbitState(seedFixture());
    const distance = state.distanceMm;
    const eyeBefore = orbitPosition(state);
    panByPixels(state, 100, 50);
    expect(state.distanceMm).toBeCloseTo(distance, 9);
    // The eye translated rigidly with the target.
    const eyeAfter = orbitPosition(state);
    const targetShift: readonly [number, number, number] = [
      state.targetX - FIXTURE_CAMERA.target[0],
      state.targetY - FIXTURE_CAMERA.target[1],
      state.targetZ - FIXTURE_CAMERA.target[2],
    ];
    expect(eyeAfter[0] - eyeBefore[0]).toBeCloseTo(targetShift[0], 9);
    expect(eyeAfter[1] - eyeBefore[1]).toBeCloseTo(targetShift[1], 9);
    expect(eyeAfter[2] - eyeBefore[2]).toBeCloseTo(targetShift[2], 9);
  });

  it("follows the grab-the-model convention: drag right moves the scene right", () => {
    const state = createOrbitState(seedFixture());
    // Camera forward is roughly [-0.45, 0.62, -0.65]; its screen-right
    // axis (forward × pole, normalized) points roughly along +Y in world.
    panByPixels(state, 100, 0);
    // Dragging right shifts the target LEFT along screen-right…
    expect(state.targetY).toBeLessThan(FIXTURE_CAMERA.target[1]);
    // …which is the scene appearing to move right.
  });

  it("scales world-per-pixel with distance (pan speed follows zoom)", () => {
    const near = createOrbitState(seedFixture());
    const far = createOrbitState(seedFixture());
    zoomByWheel(near, -600);
    zoomByWheel(far, 600);
    panByPixels(near, 100, 0);
    panByPixels(far, 100, 0);
    const nearShift = Math.hypot(
      near.targetX - FIXTURE_CAMERA.target[0],
      near.targetY - FIXTURE_CAMERA.target[1],
      near.targetZ - FIXTURE_CAMERA.target[2],
    );
    const farShift = Math.hypot(
      far.targetX - FIXTURE_CAMERA.target[0],
      far.targetY - FIXTURE_CAMERA.target[1],
      far.targetZ - FIXTURE_CAMERA.target[2],
    );
    expect(farShift).toBeGreaterThan(nearShift);
  });
});

describe("the machine-surface snapshot", () => {
  it("reports the boot pose from the spec with stable precision", () => {
    const snapshot = sceneCameraStateFromSpec(FIXTURE_CAMERA, 520);
    expect(snapshot.mode).toBe("spec");
    expect(Number.isFinite(snapshot.azimuthDeg)).toBe(true);
    expect(snapshot.azimuthDeg).toBeGreaterThanOrEqual(0);
    expect(snapshot.azimuthDeg).toBeLessThan(360);
    // Same decomposition as seeding the controller directly.
    const seeded = orbitSnapshot(
      createOrbitState(seedFixture()),
      "spec",
      "perspective",
    );
    expect(snapshot).toEqual(seeded);
  });

  it("rounds snapshot numbers so the surface stays stable", () => {
    const state = createOrbitState(seedFixture());
    orbitByPixels(state, 33, 17);
    const snapshot = orbitSnapshot(state, "user", "perspective");
    expect(snapshot.mode).toBe("user");
    expect(snapshot.azimuthDeg).toBe(Number(snapshot.azimuthDeg.toFixed(1)));
    expect(snapshot.elevationDeg).toBe(
      Number(snapshot.elevationDeg.toFixed(1)),
    );
    expect(snapshot.distanceMm).toBe(Number(snapshot.distanceMm.toFixed(1)));
  });
});
