/**
 * Phase 52 motion fixtures: the revolute/slider limit clamps (the motion
 * limit fixtures the block names), the sampled clearance floor's analytic
 * arithmetic, the joint parsing gates, and the drag decline.
 */

import { describe, expect, it } from "vitest";

import {
  applyMotionJoint,
  ASSEMBLY_MOTION_CAPABILITIES,
  ASSEMBLY_MOTION_ERROR_CODES,
  IDENTITY_PLACEMENT_TRANSFORM,
  jointStationParameters,
  motionDragDecline,
  parseAssemblyMotionJoint,
  probeMotionClearance,
  type AssemblyMotionJoint,
  type MotionProbeBounds,
} from "./index";
import { createOccurrenceId } from "./ids";

const SLIDER: AssemblyMotionJoint = {
  occurrenceId: createOccurrenceId("occ_motion_slide"),
  kind: "slider",
  axisOrigin: [0, 0, 0],
  axisDirection: [1, 0, 0],
  limitMin: 0,
  limitMax: 30,
};

const REVOLUTE: AssemblyMotionJoint = {
  occurrenceId: createOccurrenceId("occ_motion_revolute"),
  kind: "revolute",
  axisOrigin: [0, 0, 0],
  axisDirection: [0, 0, 1],
  limitMin: -90,
  limitMax: 90,
};

describe("motion limit fixtures", () => {
  it("a slider inside limits translates along the axis by the parameter", () => {
    const applied = applyMotionJoint(SLIDER, 12.5);
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    expect(applied.value.translation).toEqual([12.5, 0, 0]);
    expect(applied.value.rotation).toEqual(
      IDENTITY_PLACEMENT_TRANSFORM.rotation,
    );
  });

  it("both limit ends clamp hard (the limit fixture)", () => {
    const below = applyMotionJoint(SLIDER, -5);
    expect(below.ok).toBe(true);
    if (!below.ok) return;
    expect(below.value.translation).toEqual([0, 0, 0]);
    const above = applyMotionJoint(SLIDER, 99);
    expect(above.ok).toBe(true);
    if (!above.ok) return;
    expect(above.value.translation).toEqual([30, 0, 0]);
  });

  it("a revolute rotates about the axis; limits clamp in degrees", () => {
    const quarter = applyMotionJoint(REVOLUTE, 90);
    expect(quarter.ok).toBe(true);
    if (!quarter.ok) return;
    // 90° about z: the x basis column maps to +y (row-major columns check).
    const [m0, m1, m2, m3] = quarter.value.rotation;
    expect(m0).toBeCloseTo(0, 9);
    expect(m1).toBeCloseTo(-1, 9);
    expect(m2).toBeCloseTo(0, 9);
    expect(m3).toBeCloseTo(1, 9);
    const clamped = applyMotionJoint(REVOLUTE, 400);
    expect(clamped.ok).toBe(true);
    if (!clamped.ok) return;
    // 400° clamps to the 90° limit — the same matrix as `quarter`.
    expect(clamped.value.rotation).toEqual(quarter.value.rotation);
  });

  it("non-finite parameters refuse with the structured code", () => {
    const refused = applyMotionJoint(SLIDER, Number.POSITIVE_INFINITY);
    expect(refused).toMatchObject({
      ok: false,
      error: { code: ASSEMBLY_MOTION_ERROR_CODES.parameterInvalid },
    });
  });
});

describe("joint parsing gates", () => {
  it("accepts a valid joint and normalizes the axis direction", () => {
    const parsed = parseAssemblyMotionJoint({
      occurrenceId: "occ_motion_gate",
      kind: "revolute",
      axisOrigin: [1, 2, 3],
      axisDirection: [0, 0, 5],
      limitMin: 0,
      limitMax: 360,
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.axisDirection).toEqual([0, 0, 1]);
    expect(parsed.value.limitMax).toBe(360);
  });

  it("refuses bad kinds, empty ranges, zero axes, and bad ids", () => {
    const badKind = parseAssemblyMotionJoint({
      occurrenceId: "occ_motion_gate",
      kind: "ball",
      axisOrigin: [0, 0, 0],
      axisDirection: [0, 0, 1],
      limitMin: 0,
      limitMax: 1,
    });
    expect(badKind).toMatchObject({
      ok: false,
      error: { code: ASSEMBLY_MOTION_ERROR_CODES.jointMalformed },
    });
    const emptyRange = parseAssemblyMotionJoint({
      occurrenceId: "occ_motion_gate",
      kind: "slider",
      axisOrigin: [0, 0, 0],
      axisDirection: [0, 0, 1],
      limitMin: 5,
      limitMax: 5,
    });
    expect(emptyRange).toMatchObject({
      ok: false,
      error: { code: ASSEMBLY_MOTION_ERROR_CODES.jointMalformed },
    });
    const zeroAxis = parseAssemblyMotionJoint({
      occurrenceId: "occ_motion_gate",
      kind: "slider",
      axisOrigin: [0, 0, 0],
      axisDirection: [0, 0, 0],
      limitMin: 0,
      limitMax: 5,
    });
    expect(zeroAxis).toMatchObject({
      ok: false,
      error: { code: ASSEMBLY_MOTION_ERROR_CODES.jointMalformed },
    });
    const badId = parseAssemblyMotionJoint({
      occurrenceId: "body_not_an_occurrence",
      kind: "slider",
      axisOrigin: [0, 0, 0],
      axisDirection: [0, 0, 1],
      limitMin: 0,
      limitMax: 5,
    });
    expect(badId).toMatchObject({
      ok: false,
      error: { code: ASSEMBLY_MOTION_ERROR_CODES.jointMalformed },
    });
  });
});

describe("station sampling", () => {
  it("samples uniformly across the limits, both ends inclusive", () => {
    const stations = jointStationParameters(REVOLUTE, 5);
    expect(stations.ok).toBe(true);
    if (!stations.ok) return;
    expect(stations.value).toEqual([-90, -45, 0, 45, 90]);
  });

  it("refuses fewer than two stations", () => {
    const refused = jointStationParameters(REVOLUTE, 1);
    expect(refused).toMatchObject({
      ok: false,
      error: { code: ASSEMBLY_MOTION_ERROR_CODES.probeInvalid },
    });
  });
});

describe("the clearance-floor probe", () => {
  /** The moving box: 20×10×10 centered on the origin (x ∈ [−10, 10]). */
  const MOVING_BOUNDS: MotionProbeBounds = {
    min: [-10, -5, -5],
    max: [10, 5, 5],
  };

  it("positive floor far away, zero at contact, flagged stations recorded", () => {
    // The stationary box starts 5 mm past the moving box's +x face and the
    // slider moves the moving box +x up to 30: it lands overlapping.
    const probe = probeMotionClearance({
      joint: SLIDER,
      stationCount: 4,
      movingBounds: MOVING_BOUNDS,
      movingTransform: IDENTITY_PLACEMENT_TRANSFORM,
      stationaryBounds: { min: [15, -5, -5], max: [45, 5, 5] },
      contactFloorMm: 0,
    });
    expect(probe.ok).toBe(true);
    if (!probe.ok) return;
    expect(probe.value.samples).toHaveLength(4);
    // Station 0 (parameter 0): boxes are 5 apart on x (10 → 15).
    expect(probe.value.samples[0]?.clearanceMm).toBeCloseTo(5, 9);
    // Station 1 (parameter 10): the moving box spans x [0, 20] — overlap.
    expect(probe.value.samples[1]?.clearanceMm).toBeCloseTo(0, 9);
    // Station 3 (parameter 30): the moving box spans x [20, 40] — overlap.
    expect(probe.value.samples[3]?.clearanceMm).toBeCloseTo(0, 9);
    expect(probe.value.flaggedStations).toEqual([10, 20, 30]);
    expect(probe.value.minClearanceMm).toBeCloseTo(0, 9);
  });

  it("a clear sweep flags nothing", () => {
    const probe = probeMotionClearance({
      joint: SLIDER,
      stationCount: 3,
      movingBounds: MOVING_BOUNDS,
      movingTransform: IDENTITY_PLACEMENT_TRANSFORM,
      stationaryBounds: { min: [100, -5, -5], max: [130, 5, 5] },
      contactFloorMm: 0,
    });
    expect(probe.ok).toBe(true);
    if (!probe.ok) return;
    expect(probe.value.flaggedStations).toEqual([]);
    // The tightest station (parameter 30) leaves the boxes 60 apart on x.
    expect(probe.value.minClearanceMm).toBeCloseTo(60, 9);
  });

  it("declines joint-driven drag with the pending-mates code", () => {
    const declined = motionDragDecline({ occurrenceId: "occ_motion_revolute" });
    expect(declined).toMatchObject({
      ok: false,
      error: { code: ASSEMBLY_MOTION_ERROR_CODES.dragUnsupported },
    });
    expect(ASSEMBLY_MOTION_CAPABILITIES.dragDriven).toBe(false);
    expect(ASSEMBLY_MOTION_CAPABILITIES.parameterDriven).toBe(true);
    expect(ASSEMBLY_MOTION_CAPABILITIES.exactInterference).toBe(false);
  });
});
