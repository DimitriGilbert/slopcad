/**
 * OCCT adapter's revolve-specific tests (Phase 26.2): the exact-revolution
 * honesty — `BRepPrimAPI_MakeRevol` turns the analytic profile into exact
 * surfaces of revolution, so straight-profile volumes hit the Pappus value
 * at the exact band (not the mesh kernels' chord band), a circular profile
 * gives the exact torus formula, and partial sweeps carry exact capped
 * bounds.
 */

import { beforeAll, describe, expect, it } from "vitest";
import { angle, length } from "@slopcad/cad-core";
import { type GeometryKernel, KERNEL_ERROR_CODES } from "@slopcad/cad-kernel";
import {
  assertBoundsEqual,
  assertVolumeClose,
  expectKernelFailure,
  unwrapKernelResult,
} from "@slopcad/cad-kernel/test-utils";

import { occtKernelFromRuntime } from "./occt-kernel";
import { createOcctRuntime, type OcctRuntime } from "./occt-runtime";

let runtime: OcctRuntime;
let kernel: GeometryKernel;

beforeAll(async () => {
  runtime = await createOcctRuntime();
  kernel = occtKernelFromRuntime(runtime);
});

const identityPlacement = {
  rotation: { axis: [0, 0, 1] as const, angle: angle(0) },
  translation: { x: length(0), y: length(0), z: length(0) },
};

function touchingRectangleRevolve(
  sweepRad: number,
): Parameters<GeometryKernel["revolve"]>[0] {
  return {
    loop: [
      { kind: "line", start: [0, 0], end: [30, 0] },
      { kind: "line", start: [30, 0], end: [30, 25] },
      { kind: "line", start: [30, 25], end: [0, 25] },
      { kind: "line", start: [0, 25], end: [0, 0] },
    ],
    axis: { point: [0, 0], direction: [1, 0] },
    angle: angle(sweepRad, "rad"),
    placement: identityPlacement,
  };
}

describe("occt revolve (exact revolution)", () => {
  it("revolves an axis-touching rectangle into an exact cylinder", () => {
    const solid = unwrapKernelResult(
      kernel.revolve(touchingRectangleRevolve(Math.PI * 2)),
      "full revolve",
    );
    assertVolumeClose(
      unwrapKernelResult(kernel.volume(solid), "volume"),
      Math.PI * 25 ** 2 * 30,
      1e-9,
    );
    assertBoundsEqual(
      unwrapKernelResult(kernel.bounds(solid), "bounds"),
      { min: [0, -25, -25], max: [30, 25, 25] },
      1e-6,
    );
  });

  it("sweeps a partial revolve with exact Pappus volume and exact capped bounds", () => {
    const solid = unwrapKernelResult(
      kernel.revolve(touchingRectangleRevolve(Math.PI / 2)),
      "quarter revolve",
    );
    assertVolumeClose(
      unwrapKernelResult(kernel.volume(solid), "quarter volume"),
      (Math.PI * 25 ** 2 * 30) / 4,
      1e-9,
    );
    assertBoundsEqual(
      unwrapKernelResult(kernel.bounds(solid), "quarter bounds"),
      { min: [0, 0, 0], max: [30, 25, 25] },
      1e-6,
    );
  });

  it("revolves an off-axis circular profile into an exact torus", () => {
    const solid = unwrapKernelResult(
      kernel.revolve({
        loop: [{ kind: "circle", center: [5, 40], radius: 5 }],
        axis: { point: [0, 0], direction: [1, 0] },
        angle: angle(Math.PI * 2, "rad"),
        placement: identityPlacement,
      }),
      "torus revolve",
    );
    assertVolumeClose(
      unwrapKernelResult(kernel.volume(solid), "torus volume"),
      2 * Math.PI ** 2 * 40 * 5 ** 2,
      1e-9,
    );
  });

  it("places the revolution: rotation first about the world origin, translation second", () => {
    const solid = unwrapKernelResult(
      kernel.revolve({
        loop: touchingRectangleRevolve(Math.PI * 2).loop,
        axis: { point: [0, 0], direction: [1, 0] },
        angle: angle(Math.PI * 2, "rad"),
        placement: {
          rotation: { axis: [0, 0, 1], angle: angle(Math.PI / 2) },
          translation: { x: length(5), y: length(5), z: length(0) },
        },
      }),
      "placed revolve",
    );
    assertBoundsEqual(
      unwrapKernelResult(kernel.bounds(solid), "placed bounds"),
      { min: [-20, 5, -25], max: [30, 35, 25] },
      1e-6,
    );
  });

  it("rejects a crossing profile with the structured axis-crossing code before any OCCT call", () => {
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
        placement: identityPlacement,
      }),
      KERNEL_ERROR_CODES.profileAxisCrossing,
      "crossing revolve",
    );
    expect(failure.message).toContain("crosses");
  });
});
