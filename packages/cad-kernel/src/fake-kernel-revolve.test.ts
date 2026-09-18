/**
 * The fake kernel's revolve-specific tests (Phase 26.2): the revolution
 * node's semantics — exact Pappus volumes, exact axis-aligned bounds, the
 * sweep-start placement convention, the structured failure taxonomy
 * (crossing vs sweep-angle vs rotation-class), and the canonical mesh's
 * outward winding (every wall normal points away from the axis; caps face
 * away from the solid).
 */

import { describe, expect, it } from "vitest";
import { angle, length } from "@slopcad/cad-core";

import {
  KERNEL_ERROR_CODES,
  tessellationTriangleCount,
  type ProfileRevolveInput,
} from "./contract";
import { createFakeKernel } from "./fake-kernel";
import {
  assertBoundsEqual,
  assertVolumeClose,
  expectKernelFailure,
  unwrapKernelResult,
} from "./test-utils";

/**
 * A rectangle touching the revolve axis: local (0,0)–(30,25) revolved about
 * the local x axis is a full cylinder, radius 25, height 30.
 */
function touchingRectangle(sweepRad: number): ProfileRevolveInput {
  return {
    loop: [
      { kind: "line", start: [0, 0], end: [30, 0] },
      { kind: "line", start: [30, 0], end: [30, 25] },
      { kind: "line", start: [30, 25], end: [0, 25] },
      { kind: "line", start: [0, 25], end: [0, 0] },
    ],
    axis: { point: [0, 0], direction: [1, 0] },
    angle: angle(sweepRad, "rad"),
    placement: {
      rotation: { axis: [0, 0, 1], angle: angle(0) },
      translation: { x: length(0), y: length(0), z: length(0) },
    },
  };
}

describe("fake kernel revolve: exact measures", () => {
  it("revolves an axis-touching rectangle into a cylinder with analytic volume and exact bounds", () => {
    const kernel = createFakeKernel();
    const solid = unwrapKernelResult(
      kernel.revolve(touchingRectangle(Math.PI * 2)),
      "revolve",
    );
    assertVolumeClose(
      unwrapKernelResult(kernel.volume(solid), "cylinder volume"),
      Math.PI * 25 ** 2 * 30,
      1e-9,
    );
    assertBoundsEqual(
      unwrapKernelResult(kernel.bounds(solid), "cylinder bounds"),
      { min: [0, -25, -25], max: [30, 25, 25] },
      1e-9,
    );
  });

  it("sweeps a partial turn into a capped quarter sector with exact volume and bounds", () => {
    const kernel = createFakeKernel();
    const solid = unwrapKernelResult(
      kernel.revolve(touchingRectangle(Math.PI / 2)),
      "revolve",
    );
    assertVolumeClose(
      unwrapKernelResult(kernel.volume(solid), "quarter volume"),
      (Math.PI * 25 ** 2 * 30) / 4,
      1e-9,
    );
    // Sweep starts in the profile plane (+v = +y) toward local +z: the
    // quarter cylinder occupies y ≥ 0, z ≥ 0.
    assertBoundsEqual(
      unwrapKernelResult(kernel.bounds(solid), "quarter bounds"),
      { min: [0, 0, 0], max: [30, 25, 25] },
      1e-9,
    );
  });

  it("scales the volume linearly with the sweep angle (Pappus)", () => {
    const kernel = createFakeKernel();
    const full = unwrapKernelResult(
      kernel.volume(
        unwrapKernelResult(
          kernel.revolve(touchingRectangle(Math.PI * 2)),
          "revolve",
        ),
      ),
      "full",
    );
    const half = unwrapKernelResult(
      kernel.volume(
        unwrapKernelResult(
          kernel.revolve(touchingRectangle(Math.PI)),
          "revolve",
        ),
      ),
      "half",
    );
    expect(half).toBeCloseTo(full / 2, 6);
  });

  it("revolves an off-axis rectangle into a tube whose volume is the Pappus exact value", () => {
    const kernel = createFakeKernel();
    const solid = unwrapKernelResult(
      kernel.revolve({
        loop: [
          { kind: "line", start: [0, 10], end: [30, 10] },
          { kind: "line", start: [30, 10], end: [30, 25] },
          { kind: "line", start: [30, 25], end: [0, 25] },
          { kind: "line", start: [0, 25], end: [0, 10] },
        ],
        axis: { point: [0, 0], direction: [1, 0] },
        angle: angle(Math.PI * 2, "rad"),
        placement: {
          rotation: { axis: [0, 0, 1], angle: angle(0) },
          translation: { x: length(0), y: length(0), z: length(0) },
        },
      }),
      "revolve",
    );
    assertVolumeClose(
      unwrapKernelResult(kernel.volume(solid), "tube volume"),
      2 * Math.PI * 17.5 * (30 * 15),
      1e-9,
    );
    assertBoundsEqual(
      unwrapKernelResult(kernel.bounds(solid), "tube bounds"),
      { min: [0, -25, -25], max: [30, 25, 25] },
      1e-9,
    );
  });

  it("treats a profile on the −v side identically (mirrored profile, same solid)", () => {
    const kernel = createFakeKernel();
    const solid = unwrapKernelResult(
      kernel.revolve({
        loop: [
          { kind: "line", start: [0, -25], end: [30, -25] },
          { kind: "line", start: [30, -25], end: [30, 0] },
          { kind: "line", start: [30, 0], end: [0, 0] },
          { kind: "line", start: [0, 0], end: [0, -25] },
        ],
        axis: { point: [0, 0], direction: [1, 0] },
        angle: angle(Math.PI * 2, "rad"),
        placement: {
          rotation: { axis: [0, 0, 1], angle: angle(0) },
          translation: { x: length(0), y: length(0), z: length(0) },
        },
      }),
      "revolve",
    );
    assertVolumeClose(
      unwrapKernelResult(kernel.volume(solid), "mirrored volume"),
      Math.PI * 25 ** 2 * 30,
      1e-9,
    );
    assertBoundsEqual(
      unwrapKernelResult(kernel.bounds(solid), "mirrored bounds"),
      { min: [0, -25, -25], max: [30, 25, 25] },
      1e-9,
    );
  });

  it("places the revolution: rotation about the world origin first, translation second", () => {
    const kernel = createFakeKernel();
    const solid = unwrapKernelResult(
      kernel.revolve({
        loop: touchingRectangle(Math.PI * 2).loop,
        axis: { point: [0, 0], direction: [1, 0] },
        angle: angle(Math.PI * 2, "rad"),
        placement: {
          rotation: { axis: [0, 0, 1], angle: angle(Math.PI / 2) },
          translation: { x: length(5), y: length(5), z: length(0) },
        },
      }),
      "placed revolve",
    );
    // Local cylinder x ∈ [0,30], y,z ∈ [−25,25]; rotated 90° about z: x,y
    // swap signs — x ∈ [−25,25] × y ∈ [−30,30]… cornerwise x ∈ [−y_old]:
    // the cylinder's local AABB corners map to x ∈ [−25,25], y ∈ [−30,30];
    // the translation shifts both by +5.
    assertBoundsEqual(
      unwrapKernelResult(kernel.bounds(solid), "placed bounds"),
      { min: [-20, 5, -25], max: [30, 35, 25] },
      1e-9,
    );
  });

  it("tessellates deterministically into an outward-wound mesh of the solid", () => {
    const kernel = createFakeKernel();
    const solid = unwrapKernelResult(
      kernel.revolve(touchingRectangle(Math.PI * 2)),
      "revolve",
    );
    const first = unwrapKernelResult(kernel.tessellate(solid), "tessellate");
    const second = unwrapKernelResult(
      kernel.tessellate(solid),
      "tessellate again",
    );
    expect(second).toEqual(first);
    expect(tessellationTriangleCount(first)).toBeGreaterThan(0);

    // Every triangle winds OUTWARD: wall facets (spanning radii) point
    // away from the x axis; the two cap fans point along ±x away from the
    // solid. (Cross products of a wrongly wound triangle invert the sign.)
    const positions = first.positions;
    const indices = first.indices;
    const corner = (index: number): readonly [number, number, number] => [
      positions[index * 3] ?? 0,
      positions[index * 3 + 1] ?? 0,
      positions[index * 3 + 2] ?? 0,
    ];
    for (let t = 0; t < indices.length; t += 3) {
      const i0 = indices[t] ?? 0;
      const i1 = indices[t + 1] ?? 0;
      const i2 = indices[t + 2] ?? 0;
      const [p, q, r] = [corner(i0), corner(i1), corner(i2)];
      const e1: readonly [number, number, number] = [
        q[0] - p[0],
        q[1] - p[1],
        q[2] - p[2],
      ];
      const e2: readonly [number, number, number] = [
        r[0] - p[0],
        r[1] - p[1],
        r[2] - p[2],
      ];
      const n: readonly [number, number, number] = [
        e1[1] * e2[2] - e1[2] * e2[1],
        e1[2] * e2[0] - e1[0] * e2[2],
        e1[0] * e2[1] - e1[1] * e2[0],
      ];
      const cy = (p[1] + q[1] + r[1]) / 3;
      const cz = (p[2] + q[2] + r[2]) / 3;
      if (
        Math.abs(p[0] - 30) < 1e-9 &&
        Math.abs(q[0] - 30) < 1e-9 &&
        Math.abs(r[0] - 30) < 1e-9
      ) {
        expect(n[0]).toBeGreaterThan(0); // end cap faces +x
      } else if (
        Math.abs(p[0]) < 1e-9 &&
        Math.abs(q[0]) < 1e-9 &&
        Math.abs(r[0]) < 1e-9
      ) {
        expect(n[0]).toBeLessThan(0); // start cap faces −x
      } else {
        // Wall facet: normal must point away from the axis (radially).
        const radialDot = n[1] * cy + n[2] * cz;
        expect(radialDot).toBeGreaterThan(0);
      }
    }
  });
});

describe("fake kernel revolve: structured failures", () => {
  it("rejects a profile crossing the axis with kernel/profile-axis-crossing", () => {
    const kernel = createFakeKernel();
    const failure = expectKernelFailure(
      kernel.revolve({
        loop: [
          { kind: "line", start: [0, -10], end: [30, -10] },
          { kind: "line", start: [30, -10], end: [30, 25] },
          { kind: "line", start: [30, 25], end: [0, 25] },
          { kind: "line", start: [0, 25], end: [0, -10] },
        ],
        axis: { point: [0, 0], direction: [1, 0] },
        angle: angle(Math.PI * 2, "rad"),
        placement: {
          rotation: { axis: [0, 0, 1], angle: angle(0) },
          translation: { x: length(0), y: length(0), z: length(0) },
        },
      }),
      KERNEL_ERROR_CODES.profileAxisCrossing,
      "crossing revolve",
    );
    expect(failure.message).toContain("crosses");
  });

  it("rejects zero and over-full sweep angles with kernel/invalid-sweep-angle", () => {
    const kernel = createFakeKernel();
    expectKernelFailure(
      kernel.revolve(touchingRectangle(0)),
      KERNEL_ERROR_CODES.invalidSweepAngle,
      "zero sweep",
    );
    expectKernelFailure(
      kernel.revolve(touchingRectangle(Math.PI * 2 + 0.1)),
      KERNEL_ERROR_CODES.invalidSweepAngle,
      "over-full sweep",
    );
    expectKernelFailure(
      kernel.revolve(touchingRectangle(-1)),
      KERNEL_ERROR_CODES.invalidSweepAngle,
      "negative sweep",
    );
  });

  it("rejects a degenerate axis direction with kernel/invalid-rotation", () => {
    const kernel = createFakeKernel();
    const input = touchingRectangle(Math.PI * 2);
    expectKernelFailure(
      kernel.revolve({ ...input, axis: { point: [0, 0], direction: [0, 0] } }),
      KERNEL_ERROR_CODES.invalidRotation,
      "zero direction",
    );
  });

  it("rejects malformed profiles with kernel/invalid-profile", () => {
    const kernel = createFakeKernel();
    const input = touchingRectangle(Math.PI * 2);
    expectKernelFailure(
      kernel.revolve({ ...input, loop: [] }),
      KERNEL_ERROR_CODES.invalidProfile,
      "empty loop",
    );
    expectKernelFailure(
      kernel.revolve({ ...input, loop: input.loop.slice(0, 3) }),
      KERNEL_ERROR_CODES.invalidProfile,
      "open loop",
    );
  });

  it("rejects a loop that closes but encloses no radial material with kernel/invalid-profile", () => {
    const kernel = createFakeKernel();
    // A zero-area "loop" along the axis itself: closes, but bounds no face.
    expectKernelFailure(
      kernel.revolve({
        loop: [
          { kind: "line", start: [0, 0], end: [30, 0] },
          { kind: "line", start: [30, 0], end: [30, 0] },
        ],
        axis: { point: [0, 0], direction: [1, 0] },
        angle: angle(Math.PI * 2, "rad"),
        placement: {
          rotation: { axis: [0, 0, 1], angle: angle(0) },
          translation: { x: length(0), y: length(0), z: length(0) },
        },
      }),
      KERNEL_ERROR_CODES.invalidProfile,
      "degenerate loop",
    );
  });
});

/** The shared contract-suite shape of the fake kernel keeps working. */
describe("fake kernel revolve: contract-suite kernel identity", () => {
  it("exposes the same revolve through the standard factory", () => {
    const kernel = createFakeKernel();
    const solid = unwrapKernelResult(
      kernel.revolve(touchingRectangle(Math.PI)),
      "revolve",
    );
    assertVolumeClose(
      unwrapKernelResult(kernel.volume(solid), "volume"),
      (Math.PI * 25 ** 2 * 30) / 2,
      1e-9,
    );
  });
});
