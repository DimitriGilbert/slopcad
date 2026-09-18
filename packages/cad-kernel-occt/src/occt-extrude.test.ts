/**
 * OCCT adapter's extrude-specific tests (Phase 26.1): the exact-prism
 * honesty — curved profiles keep analytic volumes (a circle prism is an
 * exact cylinder, judged at the exact band, not the mesh kernels' curved
 * band), the negative direction sweeps toward −z, and the placement composes
 * rotation-then-translation like `transform`.
 */

import { beforeAll, describe, it } from "vitest";
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

function rectLoop(
  x0: number,
  y0: number,
  w: number,
  h: number,
): Parameters<GeometryKernel["extrude"]>[0]["loop"] {
  return [
    { kind: "line", start: [x0, y0], end: [x0 + w, y0] },
    { kind: "line", start: [x0 + w, y0], end: [x0 + w, y0 + h] },
    { kind: "line", start: [x0 + w, y0 + h], end: [x0, y0 + h] },
    { kind: "line", start: [x0, y0 + h], end: [x0, y0] },
  ];
}

const identityPlacement = {
  rotation: { axis: [0, 0, 1] as const, angle: angle(0) },
  translation: { x: length(0), y: length(0), z: length(0) },
};

describe("occt extrude (exact prism)", () => {
  it("extrudes a rectangle with exact volume and bounds", () => {
    const solid = unwrapKernelResult(
      kernel.extrude({
        loop: rectLoop(10, 10, 20, 15),
        height: length(10),
        direction: 1,
        placement: identityPlacement,
      }),
      "rectangle extrude",
    );
    assertVolumeClose(
      unwrapKernelResult(kernel.volume(solid), "volume"),
      20 * 15 * 10,
      1e-9,
    );
    assertBoundsEqual(
      unwrapKernelResult(kernel.bounds(solid), "bounds"),
      { min: [10, 10, 0], max: [30, 25, 10] },
      1e-9,
    );
  });

  it("keeps the EXACT band for a circular profile (analytic cylinder, no chord fan)", () => {
    const solid = unwrapKernelResult(
      kernel.extrude({
        loop: [{ kind: "circle", center: [0, 0], radius: 20 }],
        height: length(10),
        direction: 1,
        placement: identityPlacement,
      }),
      "circle extrude",
    );
    assertVolumeClose(
      unwrapKernelResult(kernel.volume(solid), "cylinder volume"),
      Math.PI * 20 ** 2 * 10,
      1e-9,
    );
    assertBoundsEqual(
      unwrapKernelResult(kernel.bounds(solid), "cylinder bounds"),
      { min: [-20, -20, 0], max: [20, 20, 10] },
      1e-9,
    );
  });

  it("trims an arc profile exactly (a half-round rod: rectangle + half disc)", () => {
    // Rectangle from (-10,0) to (10,10) with a half-disc of radius 10 on top
    // (arc from angle 0 at (10,0)... actually a semicircular slat: rectangle
    // 20 wide, 10 tall, topped by the arc of radius 10 centered (0,10)).
    const solid = unwrapKernelResult(
      kernel.extrude({
        loop: [
          { kind: "line", start: [-10, 0], end: [10, 0] },
          { kind: "line", start: [10, 0], end: [10, 10] },
          {
            kind: "arc",
            center: [0, 10],
            radius: 10,
            startAngle: angle(0),
            endAngle: angle(Math.PI),
          },
          { kind: "line", start: [-10, 10], end: [-10, 0] },
        ],
        height: length(8),
        direction: 1,
        placement: identityPlacement,
      }),
      "slat extrude",
    );
    const analytic = 20 * 10 * 8 + ((Math.PI * 10 ** 2) / 2) * 8;
    assertVolumeClose(
      unwrapKernelResult(kernel.volume(solid), "slat volume"),
      analytic,
      1e-9,
    );
  });

  it("extrudes the negative direction to z ∈ [-h, 0]", () => {
    const solid = unwrapKernelResult(
      kernel.extrude({
        loop: rectLoop(0, 0, 10, 10),
        height: length(4),
        direction: -1,
        placement: identityPlacement,
      }),
      "negative extrude",
    );
    assertBoundsEqual(
      unwrapKernelResult(kernel.bounds(solid), "negative bounds"),
      { min: [0, 0, -4], max: [10, 10, 0] },
      1e-9,
    );
  });

  it("places the prism rotation-first, then translation (transform order)", () => {
    const solid = unwrapKernelResult(
      kernel.extrude({
        loop: rectLoop(0, 0, 10, 20),
        height: length(5),
        direction: 1,
        placement: {
          rotation: { axis: [0, 0, 1], angle: angle(Math.PI / 2) },
          translation: { x: length(3), y: length(4), z: length(0) },
        },
      }),
      "rotated extrude",
    );
    assertBoundsEqual(
      unwrapKernelResult(kernel.bounds(solid), "rotated bounds"),
      { min: [-17, 4, 0], max: [3, 14, 5] },
      1e-9,
    );
  });

  it("rejects structural profile failures with kernel/invalid-profile", () => {
    expectKernelFailure(
      kernel.extrude({
        loop: [],
        height: length(10),
        direction: 1,
        placement: identityPlacement,
      }),
      KERNEL_ERROR_CODES.invalidProfile,
      "empty loop",
    );
    expectKernelFailure(
      kernel.extrude({
        loop: rectLoop(0, 0, 10, 10).slice(0, 3),
        height: length(10),
        direction: 1,
        placement: identityPlacement,
      }),
      KERNEL_ERROR_CODES.invalidProfile,
      "open loop",
    );
    expectKernelFailure(
      kernel.extrude({
        loop: [
          { kind: "line", start: [0, 0], end: [5, 0] },
          {
            kind: "arc",
            center: [5, 0],
            radius: 5,
            startAngle: angle(Math.PI),
            endAngle: angle(Math.PI),
          },
        ],
        height: length(2),
        direction: 1,
        placement: identityPlacement,
      }),
      KERNEL_ERROR_CODES.invalidProfile,
      "zero-sweep arc",
    );
  });
});
