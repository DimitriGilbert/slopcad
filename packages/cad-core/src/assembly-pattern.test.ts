/**
 * Phase 52 component pattern and mirror placement fixtures: instance
 * counts, analytic transform arithmetic (linear steps, circular chord
 * geometry, the mirror reflection's closed form), the handedness decision,
 * and the structured declines.
 */

import { describe, expect, it } from "vitest";

import {
  ASSEMBLY_PATTERN_CAPABILITIES,
  ASSEMBLY_PATTERN_ERROR_CODES,
  IDENTITY_PLACEMENT_TRANSFORM,
  axisRotationTransform,
  mirrorGeometryDecline,
  resolveCircularOccurrencePattern,
  resolveLinearOccurrencePattern,
  resolveMirroredOccurrencePlacement,
  resolvePathOccurrencePattern,
  type PlacementTransform,
} from "./index";

const IDENTITY = IDENTITY_PLACEMENT_TRANSFORM;

/** A seed placement: 90° about z, translated to (10, 0, 5). */
const SEED: PlacementTransform = {
  rotation: [0, -1, 0, 1, 0, 0, 0, 0, 1],
  translation: [10, 0, 5],
};

describe("linear component patterns", () => {
  it("generates exactly `count` placements stepped along the direction", () => {
    const resolved = resolveLinearOccurrencePattern({
      seed: IDENTITY,
      direction: [1, 0, 0],
      count: 4,
      spacingMm: 25,
    });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.value).toHaveLength(4);
    expect(resolved.value[0]?.translation).toEqual([25, 0, 0]);
    expect(resolved.value[1]?.translation).toEqual([50, 0, 0]);
    expect(resolved.value[3]?.translation).toEqual([100, 0, 0]);
    for (const placement of resolved.value) {
      expect(placement.rotation).toEqual(IDENTITY.rotation);
    }
  });

  it("steps from the SEED's placement, preserving its orientation", () => {
    const resolved = resolveLinearOccurrencePattern({
      seed: SEED,
      direction: [0, 0, 1],
      count: 2,
      spacingMm: 7.5,
    });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.value[0]?.translation).toEqual([10, 0, 12.5]);
    expect(resolved.value[1]?.translation).toEqual([10, 0, 20]);
    expect(resolved.value[0]?.rotation).toEqual(SEED.rotation);
  });

  it("refuses non-unit directions, non-positive spacing, and bad counts", () => {
    const nonUnit = resolveLinearOccurrencePattern({
      seed: IDENTITY,
      direction: [2, 0, 0],
      count: 2,
      spacingMm: 10,
    });
    expect(nonUnit).toMatchObject({
      ok: false,
      error: { code: ASSEMBLY_PATTERN_ERROR_CODES.directionInvalid },
    });
    const zeroSpacing = resolveLinearOccurrencePattern({
      seed: IDENTITY,
      direction: [0, 1, 0],
      count: 2,
      spacingMm: 0,
    });
    expect(zeroSpacing).toMatchObject({
      ok: false,
      error: { code: ASSEMBLY_PATTERN_ERROR_CODES.spacingInvalid },
    });
    const zeroCount = resolveLinearOccurrencePattern({
      seed: IDENTITY,
      direction: [0, 1, 0],
      count: 0,
      spacingMm: 10,
    });
    expect(zeroCount).toMatchObject({
      ok: false,
      error: { code: ASSEMBLY_PATTERN_ERROR_CODES.countInvalid },
    });
    const overLimit = resolveLinearOccurrencePattern({
      seed: IDENTITY,
      direction: [0, 1, 0],
      count: 1001,
      spacingMm: 10,
    });
    expect(overLimit).toMatchObject({
      ok: false,
      error: { code: ASSEMBLY_PATTERN_ERROR_CODES.countInvalid },
    });
  });
});

describe("circular component patterns", () => {
  /** A seed placed 25 mm out along +x (the rotation's probe point). */
  const RADIAL_SEED: PlacementTransform = {
    rotation: [1, 0, 0, 0, 1, 0, 0, 0, 1],
    translation: [25, 0, 0],
  };

  it("generates count placements rotated about the axis, seed composed", () => {
    const resolved = resolveCircularOccurrencePattern({
      seed: RADIAL_SEED,
      axisOrigin: [0, 0, 0],
      axisDirection: [0, 0, 1],
      count: 6,
      angleStepDeg: 60,
    });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.value).toHaveLength(6);
    // 60° about z moves the seed at (25, 0, 0) to (12.5, 21.6506…).
    const first = resolved.value[0];
    expect(first?.translation[0]).toBeCloseTo(12.5, 9);
    expect(first?.translation[1]).toBeCloseTo(25 * Math.sin(Math.PI / 3), 9);
    // The sixth step is the full turn: back at the start.
    const sixth = resolved.value[5];
    expect(sixth?.translation[0]).toBeCloseTo(25, 9);
    expect(sixth?.translation[1]).toBeCloseTo(0, 9);
  });

  it("rotates about an OFFSET axis line, not the world origin", () => {
    const resolved = resolveCircularOccurrencePattern({
      seed: RADIAL_SEED,
      axisOrigin: [10, 0, 0],
      axisDirection: [0, 0, 1],
      count: 1,
      angleStepDeg: 90,
    });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    // The probe point (25, 0, 0) is 15 from the axis; 90° moves it to
    // (10, 15, 0).
    expect(resolved.value[0]?.translation[0]).toBeCloseTo(10, 9);
    expect(resolved.value[0]?.translation[1]).toBeCloseTo(15, 9);
  });

  it("composes the seed's rotation rigidly (an offset seed rides along)", () => {
    const resolved = resolveCircularOccurrencePattern({
      seed: SEED,
      axisOrigin: [0, 0, 0],
      axisDirection: [0, 0, 1],
      count: 1,
      angleStepDeg: 180,
    });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    // 180° about z negates x and y of the seed's translation (10, 0, 5).
    expect(resolved.value[0]?.translation[0]).toBeCloseTo(-10, 9);
    expect(resolved.value[0]?.translation[1]).toBeCloseTo(0, 9);
    expect(resolved.value[0]?.translation[2]).toBeCloseTo(5, 9);
  });

  it("refuses a zero step and a non-unit axis", () => {
    const zeroStep = resolveCircularOccurrencePattern({
      seed: IDENTITY,
      axisOrigin: [0, 0, 0],
      axisDirection: [0, 0, 1],
      count: 3,
      angleStepDeg: 0,
    });
    expect(zeroStep).toMatchObject({
      ok: false,
      error: { code: ASSEMBLY_PATTERN_ERROR_CODES.stepInvalid },
    });
    const nonUnit = resolveCircularOccurrencePattern({
      seed: IDENTITY,
      axisOrigin: [0, 0, 0],
      axisDirection: [0, 0, 2],
      count: 3,
      angleStepDeg: 30,
    });
    expect(nonUnit).toMatchObject({
      ok: false,
      error: { code: ASSEMBLY_PATTERN_ERROR_CODES.axisInvalid },
    });
  });
});

describe("mirror components (placement mirroring)", () => {
  it("reflects the position across the plane and stays rigid (det +1)", () => {
    const mirrored = resolveMirroredOccurrencePlacement({
      seed: SEED,
      planeOrigin: [0, 0, 0],
      planeNormal: [1, 0, 0],
    });
    expect(mirrored.ok).toBe(true);
    if (!mirrored.ok) return;
    // x reflects: (10, 0, 5) → (−10, 0, 5).
    expect(mirrored.value.translation).toEqual([-10, 0, 5]);
    // det(R') = +1 within the placement tolerance.
    const [a, b, c, d, e, f, g, h, i] = mirrored.value.rotation;
    const det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
    expect(det).toBeCloseTo(1, 9);
  });

  it("mirrors across an OFFSET plane with a diagonal normal", () => {
    // Plane z = 10 with normal (0, 0, 1): the seed at z=0 mirrors to z=20.
    const mirrored = resolveMirroredOccurrencePlacement({
      seed: IDENTITY,
      planeOrigin: [0, 0, 10],
      planeNormal: [0, 0, 1],
    });
    expect(mirrored.ok).toBe(true);
    if (!mirrored.ok) return;
    expect(mirrored.value.translation).toEqual([0, 0, 20]);
  });

  it("a seed ON the plane mirrors to itself", () => {
    const mirrored = resolveMirroredOccurrencePlacement({
      seed: IDENTITY,
      planeOrigin: [0, 0, 0],
      planeNormal: [0, 1, 0],
    });
    expect(mirrored.ok).toBe(true);
    if (!mirrored.ok) return;
    expect(mirrored.value.translation).toEqual([0, 0, 0]);
    // The identity rotation through S·R·F lands on diag(1, −1, −1)... in
    // the plane frame's z-flip form: still orthonormal with det +1.
    const [a, b, c, d, e, f, g, h, i] = mirrored.value.rotation;
    const det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
    expect(det).toBeCloseTo(1, 9);
    expect(a).toBeCloseTo(1, 9);
    expect(e).toBeCloseTo(-1, 9);
    expect(i).toBeCloseTo(-1, 9);
  });

  it("refuses a non-unit plane normal", () => {
    const mirrored = resolveMirroredOccurrencePlacement({
      seed: IDENTITY,
      planeOrigin: [0, 0, 0],
      planeNormal: [0, 1, 1],
    });
    expect(mirrored).toMatchObject({
      ok: false,
      error: { code: ASSEMBLY_PATTERN_ERROR_CODES.planeInvalid },
    });
  });

  it("declines mirrored GEOMETRY with the structured code", () => {
    const declined = mirrorGeometryDecline({
      seed: IDENTITY,
      planeNormal: [1, 0, 0],
    });
    expect(declined).toMatchObject({
      ok: false,
      error: { code: ASSEMBLY_PATTERN_ERROR_CODES.mirrorGeometryUnsupported },
    });
    expect(ASSEMBLY_PATTERN_CAPABILITIES.mirroredGeometry).toBe(false);
    expect(ASSEMBLY_PATTERN_CAPABILITIES.mirrorPlacement).toBe(true);
  });
});

describe("path-driven patterns decline", () => {
  it("refuses with the structured unsupported code and capability flag", () => {
    const declined = resolvePathOccurrencePattern({
      kind: "path",
      seed: IDENTITY,
    });
    expect(declined).toMatchObject({
      ok: false,
      error: { code: ASSEMBLY_PATTERN_ERROR_CODES.pathUnsupported },
    });
    expect(ASSEMBLY_PATTERN_CAPABILITIES.pathDriven).toBe(false);
  });
});

describe("axis rotation algebra (shared)", () => {
  it("is the identity at angle 0 and a half-turn negates the radial axes", () => {
    const zero = axisRotationTransform([1, 2, 3], [0, 0, 1], 0);
    expect(zero.translation).toEqual([0, 0, 0]);
    const half = axisRotationTransform([0, 0, 0], [0, 0, 1], Math.PI);
    // A point (5, 0, 0) under the half-turn lands at (−5, 0, 0).
    const rotated = [
      half.rotation[0] * 5,
      half.rotation[3] * 5,
      half.rotation[6] * 5,
    ];
    expect(rotated[0]).toBeCloseTo(-5, 9);
    expect(rotated[1]).toBeCloseTo(0, 9);
    expect(rotated[2]).toBeCloseTo(0, 9);
  });
});
