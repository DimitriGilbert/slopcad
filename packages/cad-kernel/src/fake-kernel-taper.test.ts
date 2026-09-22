/**
 * Fake-kernel draft-taper tests (Phase 41): everything the shared contract
 * suite does not prove about the extrusion's optional `taper` — the
 * two-station inset-loft model's EXACT prismatoid volumes (the coverage
 * matrix's reference implementation), the negative widening draft, the
 * direction=−1 footing, the membership and bounds through the model, and
 * the structured `kernel/invalid-taper` battery the shared validator
 * answers with BEFORE any geometry runs.
 */

import { describe, expect, it } from "vitest";
import { angle, length } from "@slopcad/cad-core";

import {
  createFakeKernel,
  expectKernelFailure,
  KERNEL_ERROR_CODES,
  unwrapKernelResult,
} from "./index";

const IDENTITY_PLACEMENT = {
  rotation: { axis: [0, 0, 1] as const, angle: angle(0) },
  translation: { x: length(0), y: length(0), z: length(0) },
};

const RECTANGLE_LOOP = [
  { kind: "line" as const, start: [0, 0] as const, end: [30, 0] as const },
  { kind: "line" as const, start: [30, 0] as const, end: [30, 20] as const },
  { kind: "line" as const, start: [30, 20] as const, end: [0, 20] as const },
  { kind: "line" as const, start: [0, 20] as const, end: [0, 0] as const },
];

const CIRCLE_LOOP = [
  { kind: "circle" as const, center: [0, 0] as const, radius: 5 },
];

/**
 * The prismatoid volume of a W×D rectangle drafted by α over height h:
 * `h·(A0 − P0·H/2 + 4·H²/3)` with `H = h·tan α` — the contract's pinned
 * analytic anchor (the same value the OCCT DraftAngle probe hit at
 * 15-digit agreement).
 */
function rectangleDraftVolume(
  w: number,
  d: number,
  h: number,
  alphaRad: number,
): number {
  const inset = h * Math.tan(alphaRad);
  return h * (w * d - (w + d) * inset + (4 / 3) * inset * inset);
}

describe("fake kernel draft taper: the two-station inset model", () => {
  it("drafts the rectangle to the exact prismatoid volume with tight bounds", () => {
    const kernel = createFakeKernel();
    const alpha = (5 * Math.PI) / 180;
    const solid = unwrapKernelResult(
      kernel.extrude({
        loop: RECTANGLE_LOOP,
        height: length(10),
        direction: 1,
        placement: IDENTITY_PLACEMENT,
        taper: angle(alpha),
      }),
      "tapered extrude",
    );
    expect(unwrapKernelResult(kernel.volume(solid), "volume")).toBeCloseTo(
      rectangleDraftVolume(30, 20, 10, alpha),
      9,
    );
    // Tight bounds: the base footprint at z=0, the inset footprint at the
    // top — the z span is exactly the height.
    expect(unwrapKernelResult(kernel.bounds(solid), "bounds")).toEqual({
      min: [0, 0, 0],
      max: [30, 20, 10],
    });
    // Membership, judged through the voxel-quadrature booleans (the shell
    // test's cross-check): the top corner the draft removes intersects
    // empty, while the same corner at the base is full material.
    const cornerBox = () =>
      unwrapKernelResult(
        kernel.createBox({
          width: length(0.5),
          depth: length(0.5),
          height: length(0.5),
        }),
        "corner probe",
      );
    const atCorner = (z: number) =>
      unwrapKernelResult(
        kernel.transform(cornerBox(), {
          x: length(29.3),
          y: length(19.3),
          z: length(z),
        }),
        "corner placement",
      );
    const topCorner = unwrapKernelResult(
      kernel.intersect([solid, atCorner(9.3)]),
      "top corner intersection",
    );
    expect(unwrapKernelResult(kernel.volume(topCorner), "volume")).toBe(0);
    const baseCorner = unwrapKernelResult(
      kernel.intersect([solid, atCorner(0.2)]),
      "base corner intersection",
    );
    expect(unwrapKernelResult(kernel.volume(baseCorner), "volume")).toBeCloseTo(
      0.125,
      6,
    );
  });

  it("widens on the negative draft and keeps the base at the profile plane", () => {
    const kernel = createFakeKernel();
    const alpha = (-3 * Math.PI) / 180;
    const solid = unwrapKernelResult(
      kernel.extrude({
        loop: RECTANGLE_LOOP,
        height: length(10),
        direction: 1,
        placement: IDENTITY_PLACEMENT,
        taper: angle(alpha),
      }),
      "widening extrude",
    );
    const h = 10 * Math.tan(-alpha);
    expect(unwrapKernelResult(kernel.volume(solid), "volume")).toBeCloseTo(
      10 * (600 + (100 * h) / 2 + (4 / 3) * h * h),
      9,
    );
    // The widening grows the footprint by h on every side (each wall moves
    // out by the inset distance once).
    expect(unwrapKernelResult(kernel.bounds(solid), "bounds")).toEqual({
      min: [-h, -h, 0],
      max: [30 + h, 20 + h, 10],
    });
  });

  it("drafts the negative direction below the profile plane with the same volume", () => {
    const kernel = createFakeKernel();
    const alpha = (5 * Math.PI) / 180;
    const down = unwrapKernelResult(
      kernel.extrude({
        loop: RECTANGLE_LOOP,
        height: length(10),
        direction: -1,
        placement: IDENTITY_PLACEMENT,
        taper: angle(alpha),
      }),
      "downward tapered extrude",
    );
    expect(unwrapKernelResult(kernel.volume(down), "volume")).toBeCloseTo(
      rectangleDraftVolume(30, 20, 10, alpha),
      9,
    );
    expect(unwrapKernelResult(kernel.bounds(down), "bounds")).toEqual({
      min: [0, 0, -10],
      max: [30, 20, 0],
    });
  });

  it("drafts the circle to the chord-banded cone frustum", () => {
    const kernel = createFakeKernel();
    const alpha = (3 * Math.PI) / 180;
    const solid = unwrapKernelResult(
      kernel.extrude({
        loop: CIRCLE_LOOP,
        height: length(10),
        direction: 1,
        placement: IDENTITY_PLACEMENT,
        taper: angle(alpha),
      }),
      "tapered circle extrude",
    );
    const r2 = 5 - 10 * Math.tan(alpha);
    const frustum = (Math.PI * 10 * (25 + 5 * r2 + r2 * r2)) / 3;
    // The chord-polygon frustum sits inside the documented curved band
    // (the same ~0.17% class the mesh circle prism carries).
    const volume = unwrapKernelResult(kernel.volume(solid), "volume");
    expect(Math.abs(volume - frustum) / frustum).toBeLessThan(0.002);
  });

  it("answers the degenerate battery with kernel/invalid-taper before geometry", () => {
    const kernel = createFakeKernel();
    // At or beyond ±π/2.
    expectKernelFailure(
      kernel.extrude({
        loop: RECTANGLE_LOOP,
        height: length(10),
        direction: 1,
        placement: IDENTITY_PLACEMENT,
        taper: angle(Math.PI / 2),
      }),
      KERNEL_ERROR_CODES.invalidTaper,
    );
    // A taper whose far inset collapses the 30×20 rectangle (tan α ≥ 1).
    expectKernelFailure(
      kernel.extrude({
        loop: RECTANGLE_LOOP,
        height: length(20),
        direction: 1,
        placement: IDENTITY_PLACEMENT,
        taper: angle((46 * Math.PI) / 180),
      }),
      KERNEL_ERROR_CODES.invalidTaper,
    );
  });

  it("keeps the plain prism byte-identical when the taper is absent or zero", () => {
    const kernel = createFakeKernel();
    const input = {
      loop: RECTANGLE_LOOP,
      height: length(10),
      direction: 1 as const,
      placement: IDENTITY_PLACEMENT,
    };
    const plain = unwrapKernelResult(kernel.extrude(input), "plain");
    const zero = unwrapKernelResult(
      kernel.extrude({ ...input, taper: angle(0) }),
      "zero taper",
    );
    expect(unwrapKernelResult(kernel.volume(zero), "volume")).toBe(
      unwrapKernelResult(kernel.volume(plain), "volume"),
    );
    expect(unwrapKernelResult(kernel.volume(plain), "volume")).toBe(6000);
  });
});
