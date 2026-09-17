/**
 * The shared kernel contract suite (Phase 8): a fixed battery of semantic,
 * deterministic, tolerance-based tests that ANY conforming kernel must pass.
 * The fake kernel (`./fake-kernel`) runs it today (`./contract.test.ts`);
 * the Phase 9 Manifold adapter and every later kernel runs the same suite
 * against its own instance, so "conforming" means one thing everywhere.
 *
 * Judgement is semantic — analytic volumes with documented relative
 * tolerances, exact bounds where geometry is exact, bounds containment
 * where kernels may be conservative, structural tessellation validity,
 * determinism of outputs, and structured error paths. Exact triangle-buffer
 * equality is deliberately absent (the plan forbids it as a sole criterion);
 * the only buffer-level check is determinism: the same solid tessellates to
 * the same bytes.
 *
 * Capability-aware judgment: boolean BOUNDS and axis-aligned boolean VOLUME
 * assertions branch on the kernel's declared capabilities
 * ({@link assertBooleanBounds}, {@link assertBooleanVolume}) — a kernel
 * declaring `tightBooleanBounds: false` is judged by containment of the true
 * result, and one declaring `exactBooleanVolumes: false` by the documented
 * discretization band, never by unconditional exactness.
 *
 * Tolerances:
 * - `CURVED_VOLUME_TOLERANCE` (5% relative): curved primitives and curved
 *   boolean volumes, where mesh discretization (Manifold) or voxel
 *   quadrature (the fake kernel) legitimately deviate from analytic values —
 *   and, per `exactBooleanVolumes: false`, axis-aligned boolean volumes.
 * - `EXACT_VOLUME_TOLERANCE` / `EXACT_BOUNDS_TOLERANCE`: primitive box
 *   volumes and translated bounds — analytic for every conforming kernel —
 *   plus, per the capabilities above, axis-aligned boolean volumes of
 *   `exactBooleanVolumes` kernels and boolean bounds of `tightBooleanBounds`
 *   kernels. In every exact case only float noise is absorbed.
 */

import { describe, expect, it } from "vitest";
import { angle, length } from "@slopcad/cad-core";
import type { AngleValue } from "@slopcad/cad-core";
import type { KernelCapabilities } from "./capabilities";

import {
  type GeometryKernel,
  type KernelBounds,
  KERNEL_ERROR_CODES,
  tessellationTriangleCount,
} from "./contract";
import {
  assertBoundsContain,
  assertBoundsEqual,
  assertTessellationValid,
  assertVolumeClose,
  assertVolumeLessThan,
  expectKernelFailure,
  unwrapKernelResult,
} from "./test-utils";

/** See module docs; relative tolerance for curved/discretized volumes. */
export const CURVED_VOLUME_TOLERANCE = 0.05;
/** See module docs; relative tolerance for analytically exact volumes. */
export const EXACT_VOLUME_TOLERANCE = 1e-9;
/** Absolute mm tolerance for analytically exact bounds comparisons. */
export const EXACT_BOUNDS_TOLERANCE = 1e-9;

/**
 * Asserts a boolean result's bounds honour the kernel's declared
 * `tightBooleanBounds` capability: component-wise equality within
 * {@link EXACT_BOUNDS_TOLERANCE} when the kernel promises tight bounds, and
 * containment of the true result's tight box otherwise — a conservative
 * container may be larger than the true result, never miss it.
 */
export function assertBooleanBounds(
  capabilities: KernelCapabilities,
  actual: KernelBounds,
  tightExpected: KernelBounds,
): void {
  if (capabilities.tightBooleanBounds) {
    assertBoundsEqual(actual, tightExpected, EXACT_BOUNDS_TOLERANCE);
    return;
  }
  assertBoundsContain(actual, tightExpected, EXACT_BOUNDS_TOLERANCE);
}

/**
 * Asserts an axis-aligned boolean result's volume honours the kernel's
 * declared `exactBooleanVolumes` capability: agreement within
 * {@link EXACT_VOLUME_TOLERANCE} when the kernel computes boolean volumes
 * exactly, and the documented discretization band
 * ({@link CURVED_VOLUME_TOLERANCE}) otherwise, where voxel or mesh
 * quadrature legitimately deviates on quantized boundaries.
 */
export function assertBooleanVolume(
  capabilities: KernelCapabilities,
  actualMm3: number,
  expectedMm3: number,
): void {
  assertVolumeClose(
    actualMm3,
    expectedMm3,
    capabilities.exactBooleanVolumes
      ? EXACT_VOLUME_TOLERANCE
      : CURVED_VOLUME_TOLERANCE,
  );
}

function box(kernel: GeometryKernel, w: number, d: number, h: number) {
  return unwrapKernelResult(
    kernel.createBox({
      width: length(w),
      depth: length(d),
      height: length(h),
    }),
    "createBox",
  );
}

function translatedBox(
  kernel: GeometryKernel,
  w: number,
  d: number,
  h: number,
  dx: number,
  dy: number,
  dz: number,
) {
  const solid = box(kernel, w, d, h);
  return unwrapKernelResult(
    kernel.transform(solid, { x: length(dx), y: length(dy), z: length(dz) }),
    "transform",
  );
}

/**
 * Registers the kernel contract suite against a factory that creates a
 * FRESH kernel instance per test (ownership semantics are per instance, so
 * tests never share state). `label` names the suite in reports.
 */
export function defineKernelContractSuite(
  createKernel: () => GeometryKernel,
  label: string,
): void {
  describe(`kernel contract: ${label}`, () => {
    it("declares a backend id and fully-formed boolean capability flags", () => {
      const kernel = createKernel();
      const flags = Object.values(kernel.capabilities);
      expect(flags.length).toBeGreaterThan(0);
      for (const flag of flags) expect(typeof flag).toBe("boolean");
      expect(kernel.id.length).toBeGreaterThan(0);
    });

    it("creates a box with exact analytic volume and bounds", () => {
      const kernel = createKernel();
      const solid = box(kernel, 30, 20, 10);
      assertVolumeClose(
        unwrapKernelResult(kernel.volume(solid), "volume"),
        30 * 20 * 10,
        EXACT_VOLUME_TOLERANCE,
      );
      assertBoundsEqual(
        unwrapKernelResult(kernel.bounds(solid), "bounds"),
        { min: [0, 0, 0], max: [30, 20, 10] },
        EXACT_BOUNDS_TOLERANCE,
      );
    });

    it("creates curved primitives with volumes within mesh tolerance", () => {
      const kernel = createKernel();
      const sphere = unwrapKernelResult(
        kernel.createSphere({ radius: length(10) }),
        "createSphere",
      );
      assertVolumeClose(
        unwrapKernelResult(kernel.volume(sphere), "sphere volume"),
        (4 / 3) * Math.PI * 10 ** 3,
        CURVED_VOLUME_TOLERANCE,
      );
      const cylinder = unwrapKernelResult(
        kernel.createCylinder({ radius: length(4), height: length(10) }),
        "createCylinder",
      );
      assertVolumeClose(
        unwrapKernelResult(kernel.volume(cylinder), "cylinder volume"),
        Math.PI * 4 ** 2 * 10,
        CURVED_VOLUME_TOLERANCE,
      );
      const sharpCone = unwrapKernelResult(
        kernel.createCone({
          bottomRadius: length(4),
          topRadius: length(0),
          height: length(10),
        }),
        "createCone",
      );
      assertVolumeClose(
        unwrapKernelResult(kernel.volume(sharpCone), "sharp cone volume"),
        (Math.PI * 4 ** 2 * 10) / 3,
        CURVED_VOLUME_TOLERANCE,
      );
      const frustum = unwrapKernelResult(
        kernel.createCone({
          bottomRadius: length(4),
          topRadius: length(2),
          height: length(10),
        }),
        "createCone",
      );
      assertVolumeClose(
        unwrapKernelResult(kernel.volume(frustum), "frustum volume"),
        (Math.PI * 10 * (4 ** 2 + 4 * 2 + 2 ** 2)) / 3,
        CURVED_VOLUME_TOLERANCE,
      );
    });

    it("tessellates primitives into valid indexed soup within bounds, deterministically", () => {
      const kernel = createKernel();
      const solid = box(kernel, 30, 20, 10);
      const first = unwrapKernelResult(kernel.tessellate(solid), "tessellate");
      assertTessellationValid(first, {
        bounds: { min: [0, 0, 0], max: [30, 20, 10] },
      });
      expect(tessellationTriangleCount(first)).toBeGreaterThan(0);
      // Optional kernel normals stay optional (tessellation-only kernels
      // omit them), but when present they pair with positions one-for-one;
      // finiteness and unit length are judged inside the validity helper.
      if (first.normals !== undefined) {
        expect(first.normals.length).toBe(first.positions.length);
      }
      const second = unwrapKernelResult(kernel.tessellate(solid), "tessellate");
      expect(second).toEqual(first);
    });

    it("translates solids: bounds shift exactly, volume and triangle count are preserved", () => {
      const kernel = createKernel();
      const solid = box(kernel, 30, 20, 10);
      const moved = unwrapKernelResult(
        kernel.transform(solid, { x: length(5), y: length(-2), z: length(7) }),
        "transform",
      );
      assertBoundsEqual(
        unwrapKernelResult(kernel.bounds(moved), "translated bounds"),
        { min: [5, -2, 7], max: [35, 18, 17] },
        EXACT_BOUNDS_TOLERANCE,
      );
      assertVolumeClose(
        unwrapKernelResult(kernel.volume(moved), "translated volume"),
        30 * 20 * 10,
        EXACT_VOLUME_TOLERANCE,
      );
      const before = unwrapKernelResult(kernel.tessellate(solid), "tessellate");
      const after = unwrapKernelResult(kernel.tessellate(moved), "tessellate");
      expect(tessellationTriangleCount(after)).toBe(
        tessellationTriangleCount(before),
      );
      assertTessellationValid(after, {
        bounds: { min: [5, -2, 7], max: [35, 18, 17] },
      });
    });

    it("rotates solids exactly, rotation before translation, when transformRotation is declared", () => {
      // Rotation judgement is flag-gated: a kernel that has not declared
      // `transformRotation` owes no rotation semantics (it must reject or
      // ignore the field — never silently mis-apply it), so there is
      // nothing to judge here for translation-only kernels.
      const kernel = createKernel();
      if (!kernel.capabilities.transformRotation) return;
      const solid = box(kernel, 20, 10, 5);
      const quarterTurn = unwrapKernelResult(
        kernel.transform(solid, {
          x: length(0),
          y: length(0),
          z: length(0),
          rotation: { axis: [0, 0, 1], angle: angle(90, "deg") },
        }),
        "rotate",
      );
      assertBoundsEqual(
        unwrapKernelResult(kernel.bounds(quarterTurn), "rotated bounds"),
        { min: [-10, 0, 0], max: [0, 20, 5] },
        EXACT_BOUNDS_TOLERANCE,
      );
      assertVolumeClose(
        unwrapKernelResult(kernel.volume(quarterTurn), "rotated volume"),
        20 * 10 * 5,
        EXACT_VOLUME_TOLERANCE,
      );
      // The combined transform pins the application order: rotating
      // 20×10×5 by 90° about z then translating by (5, 5, 0) spans
      // x ∈ [-5, 5], y ∈ [5, 25] — translating first would span
      // x ∈ [-15, -5].
      const combined = unwrapKernelResult(
        kernel.transform(solid, {
          x: length(5),
          y: length(5),
          z: length(0),
          rotation: { axis: [0, 0, 1], angle: angle(Math.PI / 2) },
        }),
        "rotate and translate",
      );
      assertBoundsEqual(
        unwrapKernelResult(kernel.bounds(combined), "combined bounds"),
        { min: [-5, 5, 0], max: [5, 25, 5] },
        EXACT_BOUNDS_TOLERANCE,
      );
      const before = unwrapKernelResult(kernel.tessellate(solid), "tessellate");
      const after = unwrapKernelResult(
        kernel.tessellate(quarterTurn),
        "tessellate",
      );
      expect(tessellationTriangleCount(after)).toBe(
        tessellationTriangleCount(before),
      );
    });

    it("rejects degenerate rotations with kernel/invalid-rotation when transformRotation is declared", () => {
      const kernel = createKernel();
      if (!kernel.capabilities.transformRotation) return;
      const solid = box(kernel, 10, 10, 10);
      expectKernelFailure(
        kernel.transform(solid, {
          x: length(0),
          y: length(0),
          z: length(0),
          rotation: { axis: [0, 0, 0], angle: angle(1) },
        }),
        KERNEL_ERROR_CODES.invalidRotation,
        "zero axis rotation",
      );
      const nanAngle: AngleValue = {
        dimension: "angle",
        unit: "rad",
        value: Number.NaN,
      };
      expectKernelFailure(
        kernel.transform(solid, {
          x: length(0),
          y: length(0),
          z: length(0),
          rotation: { axis: [0, 0, 1], angle: nanAngle },
        }),
        KERNEL_ERROR_CODES.invalidRotation,
        "NaN angle rotation",
      );
    });

    it("subtracts an interior cylinder from a box (plate with hole) with correct semantics", () => {
      const kernel = createKernel();
      const plate = box(kernel, 30, 20, 10);
      const bore = unwrapKernelResult(
        kernel.createCylinder({ radius: length(4), height: length(10) }),
        "createCylinder",
      );
      const placedBore = unwrapKernelResult(
        kernel.transform(bore, { x: length(15), y: length(10), z: length(0) }),
        "transform",
      );
      const result = unwrapKernelResult(
        kernel.subtract(plate, [placedBore]),
        "subtract",
      );
      const analytic = 30 * 20 * 10 - Math.PI * 4 ** 2 * 10;
      assertVolumeClose(
        unwrapKernelResult(kernel.volume(result), "plate volume"),
        analytic,
        CURVED_VOLUME_TOLERANCE,
      );
      assertVolumeLessThan(
        unwrapKernelResult(kernel.volume(result), "plate volume"),
        unwrapKernelResult(kernel.volume(plate), "box volume"),
      );
      assertBooleanBounds(
        kernel.capabilities,
        unwrapKernelResult(kernel.bounds(result), "plate bounds"),
        { min: [0, 0, 0], max: [30, 20, 10] },
      );
      const soup = unwrapKernelResult(kernel.tessellate(result), "tessellate");
      assertTessellationValid(soup, {
        bounds: { min: [0, 0, 0], max: [30, 20, 10] },
      });
    });

    it("unions disjoint boxes: volume is the sum within tolerance", () => {
      const kernel = createKernel();
      const left = box(kernel, 10, 10, 10);
      const right = translatedBox(kernel, 10, 10, 10, 30, 0, 0);
      const union = unwrapKernelResult(kernel.union([left, right]), "union");
      assertBooleanVolume(
        kernel.capabilities,
        unwrapKernelResult(kernel.volume(union), "union volume"),
        2 * 10 ** 3,
      );
      assertBooleanBounds(
        kernel.capabilities,
        unwrapKernelResult(kernel.bounds(union), "union bounds"),
        { min: [0, 0, 0], max: [40, 10, 10] },
      );
      assertTessellationValid(
        unwrapKernelResult(kernel.tessellate(union), "union tessellation"),
        { bounds: { min: [0, 0, 0], max: [40, 10, 10] } },
      );
    });

    it("intersects overlapping boxes: volume is the overlap within tolerance", () => {
      const kernel = createKernel();
      const big = box(kernel, 20, 20, 10);
      const small = translatedBox(kernel, 10, 10, 10, 5, 5, 0);
      const result = unwrapKernelResult(
        kernel.intersect([big, small]),
        "intersect",
      );
      assertBooleanVolume(
        kernel.capabilities,
        unwrapKernelResult(kernel.volume(result), "intersection volume"),
        10 * 10 * 10,
      );
    });

    it("intersects disjoint solids into an empty result with structured bounds failure", () => {
      const kernel = createKernel();
      const left = box(kernel, 10, 10, 10);
      const right = translatedBox(kernel, 10, 10, 10, 50, 0, 0);
      const empty = unwrapKernelResult(
        kernel.intersect([left, right]),
        "intersect",
      );
      assertVolumeClose(
        unwrapKernelResult(kernel.volume(empty), "empty volume"),
        0,
        EXACT_VOLUME_TOLERANCE,
      );
      expectKernelFailure(
        kernel.bounds(empty),
        KERNEL_ERROR_CODES.boundsEmpty,
        "bounds of empty solid",
      );
      const soup = unwrapKernelResult(
        kernel.tessellate(empty),
        "tessellate of empty solid",
      );
      expect(tessellationTriangleCount(soup)).toBe(0);
    });

    it("subtracts a solid from itself into an empty result", () => {
      const kernel = createKernel();
      const solid = box(kernel, 10, 10, 10);
      const empty = unwrapKernelResult(
        kernel.subtract(solid, [solid]),
        "subtract",
      );
      assertVolumeClose(
        unwrapKernelResult(kernel.volume(empty), "self-subtract volume"),
        0,
        EXACT_VOLUME_TOLERANCE,
      );
    });

    it("rejects non-positive lengths with kernel/invalid-length", () => {
      const kernel = createKernel();
      expectKernelFailure(
        kernel.createBox({
          width: length(0),
          depth: length(1),
          height: length(1),
        }),
        KERNEL_ERROR_CODES.invalidLength,
        "zero-width box",
      );
      expectKernelFailure(
        kernel.createSphere({ radius: length(-5) }),
        KERNEL_ERROR_CODES.invalidLength,
        "negative sphere radius",
      );
      expectKernelFailure(
        kernel.createCylinder({ radius: length(4), height: length(0) }),
        KERNEL_ERROR_CODES.invalidLength,
        "zero-height cylinder",
      );
      expectKernelFailure(
        kernel.createCone({
          bottomRadius: length(4),
          topRadius: length(-1),
          height: length(10),
        }),
        KERNEL_ERROR_CODES.invalidLength,
        "negative cone top radius",
      );
    });

    it("rejects malformed boolean operand lists with kernel/invalid-operands", () => {
      const kernel = createKernel();
      const solid = box(kernel, 10, 10, 10);
      expectKernelFailure(
        kernel.union([solid]),
        KERNEL_ERROR_CODES.invalidOperands,
        "single-operand union",
      );
      expectKernelFailure(
        kernel.intersect([solid]),
        KERNEL_ERROR_CODES.invalidOperands,
        "single-operand intersect",
      );
      expectKernelFailure(
        kernel.subtract(solid, []),
        KERNEL_ERROR_CODES.invalidOperands,
        "no-tool subtract",
      );
    });

    it("rejects solids minted by another kernel instance with kernel/solid-not-owned", () => {
      const mine = createKernel();
      const other = createKernel();
      const foreign = box(other, 10, 10, 10);
      expectKernelFailure(
        mine.bounds(foreign),
        KERNEL_ERROR_CODES.solidNotOwned,
        "foreign bounds",
      );
      expectKernelFailure(
        mine.union([box(mine, 10, 10, 10), foreign]),
        KERNEL_ERROR_CODES.solidNotOwned,
        "foreign union operand",
      );
      expectKernelFailure(
        mine.transform(foreign, { x: length(1), y: length(1), z: length(1) }),
        KERNEL_ERROR_CODES.solidNotOwned,
        "foreign transform",
      );
    });
  });
}
