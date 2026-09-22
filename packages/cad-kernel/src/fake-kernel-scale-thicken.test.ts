/**
 * Fake-kernel scale and thicken tests (Phase 41): everything the shared
 * contract suite does not prove about the two transform/hollow surfaces —
 * the scale node's exact ×f³ volume, ×f bounds, and ×f² area with
 * orientation-preserving tessellation (including over a voxel-quantized
 * boolean), the closed-hollow node's exact two-surface volume/area over
 * the pristine box and sphere subset, membership through the
 * voxel-quadrature booleans, and the structured declines (non-positive
 * factors, non-leaf targets, walls that meet).
 */

import { describe, expect, it } from "vitest";
import { length } from "@slopcad/cad-core";

import {
  createFakeKernel,
  expectKernelFailure,
  KERNEL_ERROR_CODES,
  unwrapKernelResult,
} from "./index";

function box(kernel: ReturnType<typeof createFakeKernel>) {
  return unwrapKernelResult(
    kernel.createBox({
      width: length(30),
      depth: length(20),
      height: length(10),
    }),
    "createBox",
  );
}

describe("fake kernel scale: the pointwise uniform-scale model", () => {
  it("scales volume by f³, bounds by f, and area by f², about the origin", () => {
    const kernel = createFakeKernel();
    const target = box(kernel);
    const scaled = unwrapKernelResult(
      kernel.transform(target, {
        x: length(0),
        y: length(0),
        z: length(0),
        scale: 2,
      }),
      "scale transform",
    );
    expect(unwrapKernelResult(kernel.volume(scaled), "volume")).toBe(48000);
    expect(unwrapKernelResult(kernel.bounds(scaled), "bounds")).toEqual({
      min: [0, 0, 0],
      max: [60, 40, 20],
    });
    expect(unwrapKernelResult(kernel.area(scaled), "area")).toBe(
      2 * (60 * 40 + 40 * 20 + 60 * 20),
    );
    // Fractional scale: volume exactly f³ of the source.
    const half = unwrapKernelResult(
      kernel.transform(target, {
        x: length(0),
        y: length(0),
        z: length(0),
        scale: 0.5,
      }),
      "half scale",
    );
    expect(unwrapKernelResult(kernel.volume(half), "volume")).toBe(750);
    expect(unwrapKernelResult(kernel.bounds(half), "bounds")).toEqual({
      min: [0, 0, 0],
      max: [15, 10, 5],
    });
  });

  it("scales a voxel-quantized boolean exactly by f³ (no double quantization)", () => {
    const kernel = createFakeKernel();
    const target = box(kernel);
    const tool = unwrapKernelResult(
      kernel.createCylinder({ radius: length(5), height: length(10) }),
      "createCylinder",
    );
    const plate = unwrapKernelResult(
      kernel.subtract(target, [tool]),
      "plate with bore",
    );
    const scaled = unwrapKernelResult(
      kernel.transform(plate, {
        x: length(0),
        y: length(0),
        z: length(0),
        scale: 3,
      }),
      "scaled plate",
    );
    expect(unwrapKernelResult(kernel.volume(scaled), "volume")).toBeCloseTo(
      unwrapKernelResult(kernel.volume(plate), "volume") * 27,
      9,
    );
  });

  it("composes scale with translation (scale about the origin, then shift)", () => {
    const kernel = createFakeKernel();
    const target = box(kernel);
    const moved = unwrapKernelResult(
      kernel.transform(target, {
        x: length(5),
        y: length(0),
        z: length(0),
        scale: 2,
      }),
      "scale + translate",
    );
    // p ↦ s·R·p + t: the box spans [5, 65] in x.
    expect(unwrapKernelResult(kernel.bounds(moved), "bounds")).toEqual({
      min: [5, 0, 0],
      max: [65, 40, 20],
    });
  });

  it("tessellates deterministically with preserved winding and rejects bad factors", () => {
    const kernel = createFakeKernel();
    const target = box(kernel);
    const scaled = unwrapKernelResult(
      kernel.transform(target, {
        x: length(0),
        y: length(0),
        z: length(0),
        scale: 2,
      }),
      "scale",
    );
    const soup = unwrapKernelResult(kernel.tessellate(scaled), "tessellate");
    const again = unwrapKernelResult(
      kernel.tessellate(scaled),
      "tessellate again",
    );
    expect([...soup.indices]).toEqual([...again.indices]);
    // The box's canonical 12 triangles, carried per-corner (36 triples).
    expect(soup.positions.length).toBe(108);
    expect(soup.indices.length).toBe(36);
    // Every non-positive or non-finite factor rejects before geometry.
    expectKernelFailure(
      kernel.transform(target, {
        x: length(0),
        y: length(0),
        z: length(0),
        scale: 0,
      }),
      KERNEL_ERROR_CODES.invalidLength,
    );
    expectKernelFailure(
      kernel.transform(target, {
        x: length(0),
        y: length(0),
        z: length(0),
        scale: -2,
      }),
      KERNEL_ERROR_CODES.invalidLength,
    );
  });

  it("treats a factor of exactly 1 as the identity (no node, plain translation)", () => {
    const kernel = createFakeKernel();
    const target = box(kernel);
    const moved = unwrapKernelResult(
      kernel.transform(target, {
        x: length(1),
        y: length(2),
        z: length(3),
        scale: 1,
      }),
      "identity scale + translation",
    );
    expect(unwrapKernelResult(kernel.volume(moved), "volume")).toBe(6000);
    expect(unwrapKernelResult(kernel.bounds(moved), "bounds")).toEqual({
      min: [1, 2, 3],
      max: [31, 22, 13],
    });
  });
});

describe("fake kernel thicken: the analytic closed-hollow model", () => {
  it("hollows the box to the exact closed shell: volume, area, bounds", () => {
    const kernel = createFakeKernel();
    const target = box(kernel);
    const solid = unwrapKernelResult(
      kernel.thicken({ target, thickness: length(2) }),
      "box thicken",
    );
    // W·D·H − (W−2t)(D−2t)(H−2t) = 6000 − 26·16·6.
    expect(unwrapKernelResult(kernel.volume(solid), "volume")).toBe(
      6000 - 2496,
    );
    // Both surfaces: the outer 2(wd+dh+wh) plus the inner at the inset.
    expect(unwrapKernelResult(kernel.area(solid), "area")).toBe(
      2 * (30 * 20 + 20 * 10 + 30 * 10) + 2 * (26 * 16 + 16 * 6 + 26 * 6),
    );
    expect(unwrapKernelResult(kernel.bounds(solid), "bounds")).toEqual({
      min: [0, 0, 0],
      max: [30, 20, 10],
    });
  });

  it("hollows the sphere to the exact closed shell", () => {
    const kernel = createFakeKernel();
    const target = unwrapKernelResult(
      kernel.createSphere({ radius: length(10) }),
      "createSphere",
    );
    const solid = unwrapKernelResult(
      kernel.thicken({ target, thickness: length(2) }),
      "sphere thicken",
    );
    expect(unwrapKernelResult(kernel.volume(solid), "volume")).toBeCloseTo(
      (4 / 3) * Math.PI * (1000 - 512),
      9,
    );
    expect(unwrapKernelResult(kernel.area(solid), "area")).toBeCloseTo(
      4 * Math.PI * (100 + 64),
      9,
    );
  });

  it("classifies the cavity as void through the voxel-quadrature booleans", () => {
    const kernel = createFakeKernel();
    const target = box(kernel);
    const solid = unwrapKernelResult(
      kernel.thicken({ target, thickness: length(2) }),
      "box thicken",
    );
    const core = unwrapKernelResult(
      kernel.createBox({
        width: length(20),
        depth: length(10),
        height: length(4),
      }),
      "core probe",
    );
    const coreCentered = unwrapKernelResult(
      kernel.transform(core, { x: length(5), y: length(5), z: length(3) }),
      "core placement",
    );
    const intersection = unwrapKernelResult(
      kernel.intersect([solid, coreCentered]),
      "core intersection",
    );
    expect(unwrapKernelResult(kernel.volume(intersection), "volume")).toBe(0);
  });

  it("declines the subset and the degenerate thickness structurally", () => {
    const kernel = createFakeKernel();
    // A non-leaf target: the plate-with-bore boolean.
    const plate = unwrapKernelResult(
      kernel.subtract(box(kernel), [
        unwrapKernelResult(
          kernel.createCylinder({ radius: length(5), height: length(10) }),
          "bore",
        ),
      ]),
      "plate",
    );
    expectKernelFailure(
      kernel.thicken({ target: plate, thickness: length(1) }),
      KERNEL_ERROR_CODES.unsupportedOperation,
    );
    // Walls that meet: 2t ≥ the box's smallest extent (10).
    expectKernelFailure(
      kernel.thicken({ target: box(kernel), thickness: length(5) }),
      KERNEL_ERROR_CODES.thickenFailed,
    );
    expectKernelFailure(
      kernel.thicken({ target: box(kernel), thickness: length(0) }),
      KERNEL_ERROR_CODES.invalidLength,
    );
  });
});
