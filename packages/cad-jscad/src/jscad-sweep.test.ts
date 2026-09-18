/**
 * JSCAD adapter's sweep-specific tests (Phase 26.3): the station-loft
 * honesty — a straight path lofts the exact prism (a two-station loft),
 * curved paths sit inside the documented station band of the Pappus
 * values, the closed ring closes its walls without caps, and the shared
 * validation battery answers the structured codes.
 */

import { describe, expect, it } from "vitest";
import { angle, length } from "@slopcad/cad-core";
import {
  KERNEL_ERROR_CODES,
  type ProfileSweepInput,
} from "@slopcad/cad-kernel";
import {
  assertBoundsEqual,
  assertTessellationValid,
  assertVolumeClose,
  expectKernelFailure,
  unwrapKernelResult,
} from "@slopcad/cad-kernel/test-utils";

import { createJscadKernel } from "./jscad-kernel";

const identityPlacement = {
  rotation: { axis: [0, 0, 1] as const, angle: angle(0) },
  translation: { x: length(0), y: length(0), z: length(0) },
};

/** The 6×4 rectangular section centred on the path. */
function sectionLoop(): ProfileSweepInput["loop"] {
  return [
    { kind: "line", start: [-3, -2], end: [3, -2] },
    { kind: "line", start: [3, -2], end: [3, 2] },
    { kind: "line", start: [3, 2], end: [-3, 2] },
    { kind: "line", start: [-3, 2], end: [-3, -2] },
  ];
}

/** The CCW quarter-arc bend of radius 30 from the origin along +z. */
function quarterArcPath(): ProfileSweepInput["path"] {
  return [
    {
      kind: "arc",
      center: [-30, 0],
      radius: 30,
      startAngle: angle(0),
      endAngle: angle(Math.PI / 2),
    },
  ];
}

describe("jscad sweep (station loft)", () => {
  it("lofts a straight path into the exact prism", () => {
    const kernel = createJscadKernel();
    const solid = unwrapKernelResult(
      kernel.sweep({
        loop: sectionLoop(),
        path: [{ kind: "line", start: [0, 0], end: [0, 40] }],
        placement: identityPlacement,
      }),
      "straight sweep",
    );
    assertVolumeClose(
      unwrapKernelResult(kernel.volume(solid), "straight volume"),
      24 * 40,
      1e-9,
    );
    assertBoundsEqual(
      unwrapKernelResult(kernel.bounds(solid), "straight bounds"),
      { min: [-3, -2, 0], max: [3, 2, 40] },
      1e-9,
    );
  });

  it("lofts the bend inside the documented station band", () => {
    const kernel = createJscadKernel();
    const solid = unwrapKernelResult(
      kernel.sweep({
        loop: sectionLoop(),
        path: quarterArcPath(),
        placement: identityPlacement,
      }),
      "bend sweep",
    );
    assertVolumeClose(
      unwrapKernelResult(kernel.volume(solid), "bend volume"),
      (Math.PI / 2) * 30 * 24,
      0.05,
    );
    assertBoundsEqual(
      unwrapKernelResult(kernel.bounds(solid), "bend bounds"),
      { min: [-30, -2, 0], max: [3, 2, 33] },
      0.05,
    );
    const soup = unwrapKernelResult(kernel.tessellate(solid), "bend soup");
    assertTessellationValid(soup, {
      bounds: { min: [-30, -2, 0], max: [3, 2, 33] },
      toleranceMm: 0.05,
    });
  });

  it("lofts the closed ring and the clockwise mirror inside the band", () => {
    const kernel = createJscadKernel();
    const ring = unwrapKernelResult(
      kernel.sweep({
        loop: sectionLoop(),
        path: [
          {
            kind: "arc",
            center: [-30, 0],
            radius: 30,
            startAngle: angle(0),
            endAngle: angle(Math.PI * 2),
          },
        ],
        placement: identityPlacement,
      }),
      "ring sweep",
    );
    assertVolumeClose(
      unwrapKernelResult(kernel.volume(ring), "ring volume"),
      Math.PI * 2 * 30 * 24,
      0.05,
    );
    const mirrored = unwrapKernelResult(
      kernel.sweep({
        loop: sectionLoop(),
        path: [
          {
            kind: "arc",
            center: [30, 0],
            radius: 30,
            startAngle: angle(Math.PI),
            endAngle: angle(Math.PI / 2),
          },
        ],
        placement: identityPlacement,
      }),
      "clockwise sweep",
    );
    assertVolumeClose(
      unwrapKernelResult(kernel.volume(mirrored), "clockwise volume"),
      (Math.PI / 2) * 30 * 24,
      0.05,
    );
  });

  it("places the loft with the composed rotation-then-translation", () => {
    const kernel = createJscadKernel();
    const solid = unwrapKernelResult(
      kernel.sweep({
        loop: sectionLoop(),
        path: [{ kind: "line", start: [0, 0], end: [0, 20] }],
        placement: {
          rotation: { axis: [0, 0, 1], angle: angle(Math.PI / 2) },
          translation: { x: length(5), y: length(5), z: length(0) },
        },
      }),
      "placed sweep",
    );
    assertBoundsEqual(
      unwrapKernelResult(kernel.bounds(solid), "placed bounds"),
      { min: [3, 2, 0], max: [7, 8, 20] },
      1e-6,
    );
  });

  it("answers the structured path codes", () => {
    const kernel = createJscadKernel();
    expectKernelFailure(
      kernel.sweep({
        loop: sectionLoop(),
        path: [],
        placement: identityPlacement,
      }),
      KERNEL_ERROR_CODES.invalidPath,
      "empty path",
    );
    expectKernelFailure(
      kernel.sweep({
        loop: sectionLoop(),
        path: [{ kind: "line", start: [0, 0], end: [0, 0] }],
        placement: identityPlacement,
      }),
      KERNEL_ERROR_CODES.invalidPath,
      "zero-length path",
    );
    expectKernelFailure(
      kernel.sweep({
        loop: sectionLoop(),
        path: [
          { kind: "line", start: [0, 0], end: [0, 40] },
          {
            kind: "arc",
            center: [-15, 40],
            radius: 15,
            startAngle: angle(0),
            endAngle: angle(Math.PI),
          },
          { kind: "line", start: [-30, 40], end: [-30, 20] },
          {
            kind: "arc",
            center: [-15, 20],
            radius: 15,
            startAngle: angle(Math.PI),
            endAngle: angle((3 * Math.PI) / 2),
          },
          { kind: "line", start: [-15, 5], end: [15, 5] },
        ],
        placement: identityPlacement,
      }),
      KERNEL_ERROR_CODES.pathSelfIntersecting,
      "horseshoe whose return leg crosses the entry leg",
    );
    expectKernelFailure(
      kernel.sweep({
        loop: [],
        path: quarterArcPath(),
        placement: identityPlacement,
      }),
      KERNEL_ERROR_CODES.invalidProfile,
      "empty profile",
    );
  });

  it("builds identical sweeps in fresh kernel instances", () => {
    const build = (): readonly number[] => {
      const kernel = createJscadKernel();
      const solid = unwrapKernelResult(
        kernel.sweep({
          loop: sectionLoop(),
          path: quarterArcPath(),
          placement: identityPlacement,
        }),
        "sweep",
      );
      return unwrapKernelResult(kernel.tessellate(solid), "soup").positions;
    };
    const first = build();
    const second = build();
    expect(second).toEqual(first);
    expect(first.length).toBeGreaterThan(0);
  });
});
