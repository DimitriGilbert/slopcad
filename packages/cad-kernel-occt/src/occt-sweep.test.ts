/**
 * OCCT adapter's sweep-specific tests (Phase 26.3): the exact-pipe honesty
 * — `BRepOffsetAPI_MakePipeShell` over the exact profile and spine wires
 * gives straight spines the prism volume, arc spines the Pappus value, a
 * closed circular spine the exact torus, and offset profiles the exact
 * centroid distance, all at the exact band; the shared validation battery
 * rejects before any engine call.
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

/** The 6×4 rectangular section centred on the path. */
function sectionLoop() {
  return [
    { kind: "line", start: [-3, -2], end: [3, -2] } as const,
    { kind: "line", start: [3, -2], end: [3, 2] } as const,
    { kind: "line", start: [3, 2], end: [-3, 2] } as const,
    { kind: "line", start: [-3, 2], end: [-3, -2] } as const,
  ];
}

/** The CCW quarter-arc bend of radius 30 from the origin along +z. */
function quarterArcPath() {
  return [
    {
      kind: "arc",
      center: [-30, 0],
      radius: 30,
      startAngle: angle(0),
      endAngle: angle(Math.PI / 2),
    },
  ] as const;
}

describe("occt sweep (exact pipe)", () => {
  it("sweeps a straight spine into the exact offset prism", () => {
    const solid = unwrapKernelResult(
      kernel.sweep({
        loop: [{ kind: "circle", center: [10, 5], radius: 3 }],
        path: [{ kind: "line", start: [0, 0], end: [0, 40] }],
        placement: identityPlacement,
      }),
      "straight sweep",
    );
    // The probe result, pinned: area × length exactly.
    assertVolumeClose(
      unwrapKernelResult(kernel.volume(solid), "offset cylinder volume"),
      Math.PI * 9 * 40,
      1e-9,
    );
    assertBoundsEqual(
      unwrapKernelResult(kernel.bounds(solid), "offset cylinder bounds"),
      { min: [7, 2, 0], max: [13, 8, 40] },
      1e-6,
    );
  });

  it("sweeps the quarter-arc bend at the exact Pappus volume, offset included", () => {
    const centered = unwrapKernelResult(
      kernel.sweep({
        loop: sectionLoop(),
        path: quarterArcPath(),
        placement: identityPlacement,
      }),
      "centered bend",
    );
    assertVolumeClose(
      unwrapKernelResult(kernel.volume(centered), "centered volume"),
      (Math.PI / 2) * 30 * 24,
      1e-9,
    );
    // Centroid 2 mm toward the bend's outside: d̄ = 32 exactly.
    const offset = unwrapKernelResult(
      kernel.sweep({
        loop: [
          { kind: "line", start: [-1, -2], end: [5, -2] },
          { kind: "line", start: [5, -2], end: [5, 2] },
          { kind: "line", start: [5, 2], end: [-1, 2] },
          { kind: "line", start: [-1, 2], end: [-1, -2] },
        ],
        path: quarterArcPath(),
        placement: identityPlacement,
      }),
      "offset bend",
    );
    assertVolumeClose(
      unwrapKernelResult(kernel.volume(offset), "offset volume"),
      (Math.PI / 2) * 32 * 24,
      1e-9,
    );
  });

  it("sweeps the clockwise bend into the mirrored partial torus", () => {
    const solid = unwrapKernelResult(
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
      "clockwise bend",
    );
    assertVolumeClose(
      unwrapKernelResult(kernel.volume(solid), "clockwise volume"),
      (Math.PI / 2) * 30 * 24,
      1e-9,
    );
    assertBoundsEqual(
      unwrapKernelResult(kernel.bounds(solid), "clockwise bounds"),
      { min: [-3, -2, 0], max: [30, 2, 33] },
      1e-6,
    );
  });

  it("sweeps the closed circular spine into the exact torus", () => {
    const solid = unwrapKernelResult(
      kernel.sweep({
        loop: [{ kind: "circle", center: [0, 0], radius: 3 }],
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
      "torus sweep",
    );
    assertVolumeClose(
      unwrapKernelResult(kernel.volume(solid), "torus volume"),
      2 * Math.PI ** 2 * 30 * 9,
      1e-9,
    );
  });

  it("sweeps a curved profile along the bend at the exact Pappus volume", () => {
    const solid = unwrapKernelResult(
      kernel.sweep({
        loop: [{ kind: "circle", center: [0, 0], radius: 4 }],
        path: quarterArcPath(),
        placement: identityPlacement,
      }),
      "curved profile sweep",
    );
    // (π/2)·30·(π·16) — the exact partial torus over the analytic disc.
    assertVolumeClose(
      unwrapKernelResult(kernel.volume(solid), "curved volume"),
      (Math.PI / 2) * 30 * Math.PI * 16,
      1e-9,
    );
  });

  it("sweeps a G1 chain at the summed exact volume and placed bounds", () => {
    const solid = unwrapKernelResult(
      kernel.sweep({
        loop: sectionLoop(),
        path: [
          { kind: "line", start: [0, 0], end: [0, 20] },
          {
            kind: "arc",
            center: [-30, 20],
            radius: 30,
            startAngle: angle(0),
            endAngle: angle(Math.PI / 2),
          },
          { kind: "line", start: [-30, 50], end: [-50, 50] },
        ],
        placement: identityPlacement,
      }),
      "chained sweep",
    );
    assertVolumeClose(
      unwrapKernelResult(kernel.volume(solid), "chain volume"),
      24 * 20 + (Math.PI / 2) * 30 * 24 + 24 * 20,
      1e-9,
    );
    assertBoundsEqual(
      unwrapKernelResult(kernel.bounds(solid), "chain bounds"),
      { min: [-50, -2, 0], max: [3, 2, 53] },
      1e-6,
    );
    // The same chain rotated 90° about z and translated: the composed
    // placement maps local x → world −y, z → world x… bounds shift by the
    // rotation first, then the translation.
    const placed = unwrapKernelResult(
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
      unwrapKernelResult(kernel.bounds(placed), "placed bounds"),
      { min: [3, 2, 0], max: [7, 8, 20] },
      1e-6,
    );
  });

  it("rejects the structured battery before any engine call", () => {
    expectKernelFailure(
      kernel.sweep({
        loop: sectionLoop(),
        path: [{ kind: "line", start: [0, 0], end: [10, 40] }],
        placement: identityPlacement,
      }),
      KERNEL_ERROR_CODES.invalidPath,
      "oblique attachment",
    );
    expectKernelFailure(
      kernel.sweep({
        loop: sectionLoop(),
        path: [
          { kind: "line", start: [0, 0], end: [0, 20] },
          { kind: "line", start: [0, 20], end: [20, 20] },
        ],
        placement: identityPlacement,
      }),
      KERNEL_ERROR_CODES.invalidPath,
      "tangent kink",
    );
    const crossing = expectKernelFailure(
      kernel.sweep({
        loop: [
          { kind: "line", start: [-35, -2], end: [5, -2] },
          { kind: "line", start: [5, -2], end: [5, 2] },
          { kind: "line", start: [5, 2], end: [-35, 2] },
          { kind: "line", start: [-35, 2], end: [-35, -2] },
        ],
        path: quarterArcPath(),
        placement: identityPlacement,
      }),
      KERNEL_ERROR_CODES.sweepSelfIntersecting,
      "tight bend pinch",
    );
    expect(crossing.message).toContain("pinch");
  });
});
