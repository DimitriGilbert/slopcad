/**
 * The fake kernel's helix tests (Phase 40): the analytic screw-solid model
 * — EXACT volume at the derived closed form, EXACT membership through the
 * inverse-screw branch test, exact untapered bounds, the deterministic
 * station soup (byte-determinism), the overlap subset's structured
 * decline, and the translation/isometry behaviors the mirror node family
 * already pins.
 */

import { describe, expect, it } from "vitest";
import { angle, length } from "@slopcad/cad-core";

import { KERNEL_ERROR_CODES, type ProfileSegmentInput } from "./contract";
import { createFakeKernel } from "./fake-kernel";
import { helixProfilePolygon, helixScrewVolume } from "./helix-geometry";
import { isoThreadToolLoop } from "./thread-profile";
import {
  assertBoundsEqual,
  assertVolumeClose,
  expectKernelFailure,
  unwrapKernelResult,
} from "./test-utils";

const identityPlacement = {
  rotation: { axis: [0, 0, 1] as const, angle: angle(0) },
  translation: { x: length(0), y: length(0), z: length(0) },
};

/** A rectangle in meridian coords (u ∈ [u0, u0+w], v centered). */
function rectangle(
  u0: number,
  w: number,
  h: number,
): readonly ProfileSegmentInput[] {
  return [
    { kind: "line", start: [u0, -h / 2], end: [u0 + w, -h / 2] },
    { kind: "line", start: [u0 + w, -h / 2], end: [u0 + w, h / 2] },
    { kind: "line", start: [u0 + w, h / 2], end: [u0, h / 2] },
    { kind: "line", start: [u0, h / 2], end: [u0, -h / 2] },
  ];
}

/** The canonical fixture: rectangle u ∈ [0, 2], height 1.5, R10 P4 × 3. */
function fixtureSpine() {
  return {
    radius: length(10),
    pitch: length(4),
    turns: 3,
    handedness: 1 as const,
    startAngle: angle(0),
  };
}

describe("fake kernel helixSweep (the analytic screw solid)", () => {
  it("measures the exact screw volume at the derived closed form", () => {
    const kernel = createFakeKernel();
    const solid = unwrapKernelResult(
      kernel.helixSweep({
        loop: rectangle(0, 2, 1.5),
        spine: fixtureSpine(),
        placement: identityPlacement,
      }),
      "helixSweep",
    );
    // V = 2π·turns·A·d̄ = 2π·3·3·11 — EXACT (no quadrature anywhere).
    assertVolumeClose(
      unwrapKernelResult(kernel.volume(solid), "screw volume"),
      2 * Math.PI * 3 * 3 * 11,
      1e-9,
    );
    assertBoundsEqual(
      unwrapKernelResult(kernel.bounds(solid), "screw bounds"),
      { min: [-12, -12, -0.75], max: [12, 12, 12.75] },
      1e-9,
    );
  });

  it("classifies membership exactly (the inverse-screw branch test)", () => {
    const kernel = createFakeKernel();
    const solid = unwrapKernelResult(
      kernel.helixSweep({
        loop: rectangle(0, 2, 1.5),
        spine: fixtureSpine(),
        placement: identityPlacement,
      }),
      "helixSweep",
    );
    // The fake kernel's boolean volumes route through `contains` (voxel
    // quadrature), so intersecting with boxes that cover material and
    // empty space respectively exercises the classification both ways:
    // near θ = 0, z = 0 the screw solid carries the profile's material
    // (radius band [10, 12]); half a pitch higher at the same angle it
    // does not.
    const boxAt = (z: number) =>
      unwrapKernelResult(
        kernel.transform(
          unwrapKernelResult(
            kernel.createBox({
              width: length(4),
              depth: length(4),
              height: length(1),
            }),
            "probe box",
          ),
          { x: length(9), y: length(-2), z: length(z) },
        ),
        "moved probe box",
      );
    const material = unwrapKernelResult(
      kernel.intersect([solid, boxAt(-0.5)]),
      "material probe",
    );
    expect(
      unwrapKernelResult(kernel.volume(material), "material probe volume"),
    ).toBeGreaterThan(0);
    const empty = unwrapKernelResult(
      kernel.intersect([solid, boxAt(1.5)]),
      "empty probe",
    );
    expect(unwrapKernelResult(kernel.volume(empty), "empty probe volume")).toBe(
      0,
    );
  });

  it("tessellates deterministically (the byte-determinism pin)", () => {
    const kernel = createFakeKernel();
    const solid = unwrapKernelResult(
      kernel.helixSweep({
        loop: rectangle(0, 2, 1.5),
        spine: fixtureSpine(),
        placement: identityPlacement,
      }),
      "helixSweep",
    );
    const first = unwrapKernelResult(kernel.tessellate(solid), "soup");
    const second = unwrapKernelResult(kernel.tessellate(solid), "again");
    expect(second).toEqual(first);
    // The station rule is one per 0.1 rad of swept angle: 189 stations ×
    // 4 wall quads + 2 caps × 2 triangles = 1514 triangles.
    expect(first.indices.length / 3).toBe(
      Math.ceil((6 * Math.PI) / 0.1) * 4 * 2 + 4,
    );
    // A second identical call mints a second handle whose soup is
    // byte-identical — the reference determinism the real kernels are
    // judged against.
    const twin = unwrapKernelResult(
      kernel.helixSweep({
        loop: rectangle(0, 2, 1.5),
        spine: fixtureSpine(),
        placement: identityPlacement,
      }),
      "twin helixSweep",
    );
    expect(unwrapKernelResult(kernel.tessellate(twin), "twin soup")).toEqual(
      first,
    );
  });

  it("translates the screw solid isometrically", () => {
    const kernel = createFakeKernel();
    const solid = unwrapKernelResult(
      kernel.helixSweep({
        loop: rectangle(0, 2, 1.5),
        spine: fixtureSpine(),
        placement: identityPlacement,
      }),
      "helixSweep",
    );
    const moved = unwrapKernelResult(
      kernel.transform(solid, { x: length(5), y: length(-2), z: length(7) }),
      "translate",
    );
    assertVolumeClose(
      unwrapKernelResult(kernel.volume(moved), "moved volume"),
      2 * Math.PI * 3 * 3 * 11,
      1e-9,
    );
    assertBoundsEqual(
      unwrapKernelResult(kernel.bounds(moved), "moved bounds"),
      { min: [-7, -14, 6.25], max: [17, 10, 19.75] },
      1e-9,
    );
  });

  it("declines overlapping turns with the structured subset code", () => {
    const kernel = createFakeKernel();
    expectKernelFailure(
      kernel.helixSweep({
        loop: rectangle(0, 2, 5),
        spine: { ...fixtureSpine(), pitch: length(4) },
        placement: identityPlacement,
      }),
      KERNEL_ERROR_CODES.helixTurnOverlap,
      "overlapping turns",
    );
    // A single turn of the same profile is fine (no overlap possible).
    const single = unwrapKernelResult(
      kernel.helixSweep({
        loop: rectangle(0, 2, 5),
        spine: { ...fixtureSpine(), turns: 1 },
        placement: identityPlacement,
      }),
      "single turn",
    );
    assertVolumeClose(
      unwrapKernelResult(kernel.volume(single), "single-turn volume"),
      2 * Math.PI * 1 * 10 * 11,
      1e-9,
    );
  });

  it("runs the shared battery before any geometry", () => {
    const kernel = createFakeKernel();
    expectKernelFailure(
      kernel.helixSweep({
        loop: rectangle(0, 2, 1.5),
        spine: { ...fixtureSpine(), pitch: length(0) },
        placement: identityPlacement,
      }),
      KERNEL_ERROR_CODES.invalidHelix,
      "flat circle",
    );
    expectKernelFailure(
      kernel.helixSweep({
        loop: rectangle(-12, 2, 1.5),
        spine: fixtureSpine(),
        placement: identityPlacement,
      }),
      KERNEL_ERROR_CODES.profileAxisCrossing,
      "axis crossing",
    );
  });

  it("measures the ISO thread tool at its derived trapezoid volume", () => {
    const kernel = createFakeKernel();
    const loop = isoThreadToolLoop({ pitchMm: 1, mode: "external" });
    const spine = {
      radius: length(3),
      pitch: length(1),
      turns: 6,
      handedness: 1 as const,
      startAngle: angle(0),
    };
    const tool = unwrapKernelResult(
      kernel.helixSweep({ loop, spine, placement: identityPlacement }),
      "thread tool",
    );
    const derived = helixScrewVolume(helixProfilePolygon(loop), {
      radiusMm: 3,
      pitchMm: 1,
      turns: 6,
      handedness: 1,
      startAngleRad: 0,
      taperMm: 0,
    });
    assertVolumeClose(
      unwrapKernelResult(kernel.volume(tool), "tool volume"),
      derived,
      1e-9,
    );
    // The hand-derived anchor: A = 45√3/256, centroid radius
    // 3 − (depth/3)·(2w_in + w_out)/(w_in + w_out).
    const depth = (5 * Math.sqrt(3)) / 16;
    const centroid = 3 - (depth / 3) * ((2 * 0.25 + 0.875) / (0.25 + 0.875));
    assertVolumeClose(
      derived,
      2 * Math.PI * 6 * ((45 * Math.sqrt(3)) / 256) * centroid,
      1e-9,
    );
  });
});
