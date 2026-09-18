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
import type { AngleValue, LengthValue } from "@slopcad/cad-core";
import type { KernelCapabilities } from "./capabilities";

import {
  type GeometryKernel,
  type KernelBounds,
  KERNEL_ERROR_CODES,
  type ProfileExtrudeInput,
  type ProfileLoftInput,
  type ProfileLoftSectionInput,
  type ProfilePlacementInput,
  type ProfileRevolveInput,
  type ProfileSweepInput,
  type Tessellation,
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
 * The divergence-theorem sum over a tessellation's triangles
 * (`Σ det(p₀, p₁, p₂) / 6`): positive ≈ the solid's volume for an
 * outward-wound closed soup, negative for an inside-out one. The mirror
 * fixtures use it as the kernel-neutral WINDING judge — a naive
 * vertex-only reflection inverts facet orientation and this sum's sign
 * with it.
 */
export function signedSoupVolume(soup: Tessellation): number {
  const { positions, indices } = soup;
  let sum = 0;
  for (let t = 0; t < indices.length; t += 3) {
    const i0 = indices[t];
    const i1 = indices[t + 1];
    const i2 = indices[t + 2];
    if (i0 === undefined || i1 === undefined || i2 === undefined) continue;
    const ax = positions[i0 * 3];
    const ay = positions[i0 * 3 + 1];
    const az = positions[i0 * 3 + 2];
    const bx = positions[i1 * 3];
    const by = positions[i1 * 3 + 1];
    const bz = positions[i1 * 3 + 2];
    const cx = positions[i2 * 3];
    const cy = positions[i2 * 3 + 1];
    const cz = positions[i2 * 3 + 2];
    if (
      ax === undefined ||
      ay === undefined ||
      az === undefined ||
      bx === undefined ||
      by === undefined ||
      bz === undefined ||
      cx === undefined ||
      cy === undefined ||
      cz === undefined
    ) {
      continue;
    }
    sum +=
      (ax * (by * cz - bz * cy) -
        ay * (bx * cz - bz * cx) +
        az * (bx * cy - by * cx)) /
      6;
  }
  return sum;
}

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

/** A closed CCW rectangle loop at (x0,y0) with the given extents. */
function rectangleLoop(
  x0: number,
  y0: number,
  w: number,
  h: number,
): ProfileExtrudeInput["loop"] {
  return [
    { kind: "line", start: [x0, y0], end: [x0 + w, y0] },
    { kind: "line", start: [x0 + w, y0], end: [x0 + w, y0 + h] },
    { kind: "line", start: [x0 + w, y0 + h], end: [x0, y0 + h] },
    { kind: "line", start: [x0, y0 + h], end: [x0, y0] },
  ];
}

function identityPlacement(): ProfilePlacementInput {
  return {
    rotation: { axis: [0, 0, 1], angle: angle(0) },
    translation: { x: length(0), y: length(0), z: length(0) },
  };
}

function rectangleExtrude(
  x0: number,
  y0: number,
  w: number,
  h: number,
  height: number,
  direction: 1 | -1,
): ProfileExtrudeInput {
  return {
    loop: rectangleLoop(x0, y0, w, h),
    height: length(height),
    direction,
    placement: identityPlacement(),
  };
}

/**
 * Bounds tolerance for extrusions under non-identity placements: rotation
 * introduces float noise in mesh-backed kernels (Manifold's transform
 * composes cos/sin of the angle), so placed bounds absorb 1e-6 mm rather
 * than the exact-band 1e-9 that identity placements still meet.
 */
const EXTRUDE_PLACED_BOUNDS_TOLERANCE = 1e-6;

/**
 * Bounds tolerance for revolves on mesh kernels: the chord fan puts its
 * vertices ON the true radius, but the per-axis extreme may fall between
 * vertices — for the 63-chord full turn an odd segment count leaves the
 * far side up to 1 − cos(π/63) ≈ 0.124% short (measured 0.031 mm on the
 * radius-25 probe fixture; probed on Manifold and JSCAD). OCCT and the
 * fake kernel are exact and sit far inside the same band.
 */
const REVOLVE_CHORD_BOUNDS_TOLERANCE_MM = 0.05;

/**
 * A rectangle touching the revolve axis: local (0,0)–(30,25) revolved
 * about the local x axis — a full cylinder (radius 25, length 30), the
 * canonical revolve fixture.
 */
function rectangleRevolve(
  sweepRad: number,
  placement: ProfilePlacementInput = identityPlacement(),
): ProfileRevolveInput {
  return {
    loop: rectangleLoop(0, 0, 30, 25),
    axis: { point: [0, 0], direction: [1, 0] },
    angle: angle(sweepRad),
    placement,
  };
}

/**
 * The edge-addressed fixtures' per-kernel ordinals (Phases 26.5-26.6): the
 * suite judges shared SEMANTICS, but edge ordinals are the kernel's own
 * snapshot-style addresses — there is no cross-kernel ordinal convention
 * (OCCT's exploration order and the fake kernel's documented box-edge
 * table differ by design), so each edge-cutting kernel's registration
 * (fillet and chamfer alike) supplies its own addresses into a fresh
 * `box(30, 20, 10)`.
 *
 * - `cornerEdge`: ordinals addressing ONE vertical edge (length 10 along
 *   z, the box's corner at x = 30, y = 20 up to the kernel's symmetry —
 *   every vertical corner of that box is equivalent for the fixtures'
 *   volumes and bounds).
 * - `oppositeEdges`: ordinals of TWO DISJOINT vertical edges (opposite
 *   corners — their removed regions do not interact, which is what makes
 *   the summed volume analytic).
 */
export interface KernelBoxEdgeSuiteHint {
  readonly cornerEdge: readonly number[];
  readonly oppositeEdges: readonly [number, number];
}

/**
 * The shell fixtures' per-kernel face ordinal (Phase 26.7): like the edge
 * hints above, face ordinals are the kernel's own snapshot-style
 * addresses — no cross-kernel ordinal convention exists — so each
 * shell-capable kernel's registration supplies its own address of one
 * face of a fresh `box(30, 20, 10)`. The ordinal must address a face
 * NORMAL TO THE 10 mm EXTENT (a z face of the fixture box): the fixtures'
 * analytic expectations below are the cavity values of that opening, and
 * the too-thick battery's thickness (12 mm) crosses that extent's wall.
 */
export interface KernelBoxFaceSuiteHint {
  /** Ordinal addressing ONE z face of the fixture box. */
  readonly openFace: number;
}

/** Per-kernel suite options. */
export interface KernelContractSuiteOptions {
  /**
   * REQUIRED when the kernel declares `fillet: true` (the fillet fixtures
   * throw on its absence — a registration that promises fillet without
   * addresses cannot judge them); ignored otherwise.
   */
  readonly fillet?: KernelBoxEdgeSuiteHint;
  /**
   * REQUIRED when the kernel declares `chamfer: true` (the chamfer
   * fixtures throw on its absence, exactly like the fillet hint above);
   * ignored otherwise.
   */
  readonly chamfer?: KernelBoxEdgeSuiteHint;
  /**
   * REQUIRED when the kernel declares `shell: true` (the shell fixtures
   * throw on its absence, exactly like the fillet hint above); ignored
   * otherwise.
   */
  readonly shell?: KernelBoxFaceSuiteHint;
}

/**
 * The fillet fixtures' analytic expectations, shared by every
 * fillet-capable kernel: a box corner-edge fillet removes one
 * prism-quadrant per edge — cross-section `r²(1 − π/4)`, the edge's
 * length long — so the volumes below are exact for both the OCCT BREP
 * fillet (probed 0 relative error) and the fake kernel's analytic model.
 */

/** The corner fillet's removed volume on the fixture box (r = 3, L = 10). */
const CORNER_FILLET_VOLUME_MM3 = 9 * (1 - Math.PI / 4) * 10;

/** Each opposite-pair fillet's removed volume (r = 2, L = 10). */
const PAIR_FILLET_VOLUME_MM3 = 4 * (1 - Math.PI / 4) * 10;

/**
 * The chamfer fixtures' analytic expectations, shared by every
 * chamfer-capable kernel: a box corner-edge chamfer removes one corner
 * PRISM per edge — the right-isoceles cross-section `d²/2` (the symmetric
 * distance cuts d along both adjacent faces), the edge's length long — so
 * the volumes below are exact for both the OCCT BREP chamfer (probed
 * 0 relative error) and the fake kernel's analytic model.
 */

/** The corner chamfer's removed volume on the fixture box (d = 3, L = 10). */
const CORNER_CHAMFER_VOLUME_MM3 = ((3 * 3) / 2) * 10;

/** Each opposite-pair chamfer's removed volume (d = 2, L = 10). */
const PAIR_CHAMFER_VOLUME_MM3 = ((2 * 2) / 2) * 10;

/**
 * The shell fixtures' analytic expectations, shared by every
 * shell-capable kernel: opening a `box(30, 20, 10)` at one z face removes
 * the inset cavity `(30−2t)(20−2t)(10−t)` — uniform thickness t walls,
 * open at the removed face — so the volumes below are exact for both the
 * OCCT BREP hollow (probed 0 relative error at both thicknesses) and the
 * fake kernel's analytic open-box model.
 */

/** The one-face shell's removed cavity on the fixture box (t = 2). */
const OPEN_FACE_SHELL_CAVITY_T2_MM3 = (30 - 4) * (20 - 4) * (10 - 2);

/** The one-face shell's removed cavity on the fixture box (t = 3). */
const OPEN_FACE_SHELL_CAVITY_T3_MM3 = (30 - 6) * (20 - 6) * (10 - 3);

/**
 * Registers the kernel contract suite against a factory that creates a
 * FRESH kernel instance per test (ownership semantics are per instance, so
 * tests never share state). `label` names the suite in reports.
 */
export function defineKernelContractSuite(
  createKernel: () => GeometryKernel,
  label: string,
  options: KernelContractSuiteOptions = {},
): void {
  const filletHint = options.fillet;
  const chamferHint = options.chamfer;
  const shellHint = options.shell;
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

    it("extrudes a rectangular profile: exact volume and bounds along +z", () => {
      const kernel = createKernel();
      const solid = unwrapKernelResult(
        kernel.extrude(rectangleExtrude(10, 10, 20, 15, 10, 1)),
        "extrude",
      );
      assertVolumeClose(
        unwrapKernelResult(kernel.volume(solid), "extrude volume"),
        20 * 15 * 10,
        EXACT_VOLUME_TOLERANCE,
      );
      assertBoundsEqual(
        unwrapKernelResult(kernel.bounds(solid), "extrude bounds"),
        { min: [10, 10, 0], max: [30, 25, 10] },
        EXTRUDE_PLACED_BOUNDS_TOLERANCE,
      );
      const first = unwrapKernelResult(kernel.tessellate(solid), "tessellate");
      assertTessellationValid(first, {
        bounds: { min: [10, 10, 0], max: [30, 25, 10] },
      });
      const second = unwrapKernelResult(kernel.tessellate(solid), "tessellate");
      expect(second).toEqual(first);
    });

    it("extrudes in the negative direction below the profile plane", () => {
      const kernel = createKernel();
      const solid = unwrapKernelResult(
        kernel.extrude(rectangleExtrude(10, 10, 20, 15, 10, -1)),
        "extrude",
      );
      assertVolumeClose(
        unwrapKernelResult(kernel.volume(solid), "negative extrude volume"),
        20 * 15 * 10,
        EXACT_VOLUME_TOLERANCE,
      );
      assertBoundsEqual(
        unwrapKernelResult(kernel.bounds(solid), "negative extrude bounds"),
        { min: [10, 10, -10], max: [30, 25, 0] },
        EXTRUDE_PLACED_BOUNDS_TOLERANCE,
      );
    });

    it("places the extrusion: rotation first about the world origin, then translation", () => {
      const kernel = createKernel();
      const placement: ProfilePlacementInput = {
        rotation: { axis: [0, 0, 1], angle: angle(Math.PI / 2) },
        translation: { x: length(5), y: length(5), z: length(0) },
      };
      const solid = unwrapKernelResult(
        kernel.extrude({
          loop: rectangleLoop(10, 10, 20, 15),
          height: length(10),
          direction: 1,
          placement,
        }),
        "placed extrude",
      );
      // Local corners (10,10)…(30,25) rotated 90° about z span x ∈ [-25,-10],
      // y ∈ [10,30]; translating by (5,5,0) shifts both.
      assertBoundsEqual(
        unwrapKernelResult(kernel.bounds(solid), "placed bounds"),
        { min: [-20, 15, 0], max: [-5, 35, 10] },
        EXTRUDE_PLACED_BOUNDS_TOLERANCE,
      );
      assertVolumeClose(
        unwrapKernelResult(kernel.volume(solid), "placed volume"),
        20 * 15 * 10,
        EXACT_VOLUME_TOLERANCE,
      );
    });

    it("extrudes a circular profile within the curved band, exact for analytic kernels", () => {
      const kernel = createKernel();
      const solid = unwrapKernelResult(
        kernel.extrude({
          loop: [{ kind: "circle", center: [0, 0], radius: 4 }],
          height: length(10),
          direction: 1,
          placement: identityPlacement(),
        }),
        "circle extrude",
      );
      assertVolumeClose(
        unwrapKernelResult(kernel.volume(solid), "circle extrude volume"),
        Math.PI * 4 ** 2 * 10,
        CURVED_VOLUME_TOLERANCE,
      );
      assertTessellationValid(
        unwrapKernelResult(kernel.tessellate(solid), "circle extrude soup"),
        {},
      );
    });

    it("rejects degenerate profiles with kernel/invalid-profile", () => {
      const kernel = createKernel();
      expectKernelFailure(
        kernel.extrude({
          loop: [],
          height: length(10),
          direction: 1,
          placement: identityPlacement(),
        }),
        KERNEL_ERROR_CODES.invalidProfile,
        "empty loop",
      );
      expectKernelFailure(
        kernel.extrude({
          loop: rectangleLoop(0, 0, 10, 10).slice(0, 3),
          height: length(10),
          direction: 1,
          placement: identityPlacement(),
        }),
        KERNEL_ERROR_CODES.invalidProfile,
        "open loop",
      );
      expectKernelFailure(
        kernel.extrude({
          loop: [
            { kind: "line", start: [0, 0], end: [0, 0] },
            { kind: "line", start: [0, 0], end: [10, 0] },
            { kind: "line", start: [10, 0], end: [10, 10] },
            { kind: "line", start: [10, 10], end: [0, 0] },
          ],
          height: length(10),
          direction: 1,
          placement: identityPlacement(),
        }),
        KERNEL_ERROR_CODES.invalidProfile,
        "zero-length line",
      );
      expectKernelFailure(
        kernel.extrude(rectangleExtrude(0, 0, 10, 10, 0, 1)),
        KERNEL_ERROR_CODES.invalidLength,
        "zero height",
      );
    });

    it("rejects degenerate placement rotations with kernel/invalid-rotation", () => {
      const kernel = createKernel();
      expectKernelFailure(
        kernel.extrude({
          loop: rectangleLoop(0, 0, 10, 10),
          height: length(10),
          direction: 1,
          placement: {
            rotation: { axis: [0, 0, 0], angle: angle(1) },
            translation: { x: length(0), y: length(0), z: length(0) },
          },
        }),
        KERNEL_ERROR_CODES.invalidRotation,
        "zero axis placement rotation",
      );
    });

    it("revolves an axis-touching rectangle into a cylinder within the curved band", () => {
      const kernel = createKernel();
      const solid = unwrapKernelResult(
        kernel.revolve(rectangleRevolve(Math.PI * 2)),
        "full revolve",
      );
      // Pappus: 2π·d̄·A = 2π·(25/2)·(30·25) = π·25²·30 — the exact cylinder
      // volume. OCCT reaches it exactly; mesh kernels sit in the chord band
      // (measured ≈0.166% deficit at the shared 63-chord resolution).
      assertVolumeClose(
        unwrapKernelResult(kernel.volume(solid), "cylinder volume"),
        Math.PI * 25 ** 2 * 30,
        CURVED_VOLUME_TOLERANCE,
      );
      // Chords keep vertices on the true radius; per-axis extremes may fall
      // between them (see REVOLVE_CHORD_BOUNDS_TOLERANCE_MM's derivation).
      assertBoundsEqual(
        unwrapKernelResult(kernel.bounds(solid), "cylinder bounds"),
        { min: [0, -25, -25], max: [30, 25, 25] },
        REVOLVE_CHORD_BOUNDS_TOLERANCE_MM,
      );
      const first = unwrapKernelResult(
        kernel.tessellate(solid),
        "revolve soup",
      );
      assertTessellationValid(first, {
        bounds: { min: [0, -25, -25], max: [30, 25, 25] },
        toleranceMm: REVOLVE_CHORD_BOUNDS_TOLERANCE_MM,
      });
      const second = unwrapKernelResult(
        kernel.tessellate(solid),
        "revolve soup again",
      );
      expect(second).toEqual(first);
    });

    it("sweeps a partial revolve with the Pappus-proportional volume and capped bounds", () => {
      const kernel = createKernel();
      const solid = unwrapKernelResult(
        kernel.revolve(rectangleRevolve(Math.PI / 2)),
        "quarter revolve",
      );
      // V = θ·d̄·A — exactly one quarter of the full turn's volume.
      assertVolumeClose(
        unwrapKernelResult(kernel.volume(solid), "quarter volume"),
        (Math.PI * 25 ** 2 * 30) / 4,
        CURVED_VOLUME_TOLERANCE,
      );
      // The sweep starts in the profile plane and runs toward local +z, so
      // the quarter cylinder occupies y ≥ 0, z ≥ 0.
      assertBoundsEqual(
        unwrapKernelResult(kernel.bounds(solid), "quarter bounds"),
        { min: [0, 0, 0], max: [30, 25, 25] },
        REVOLVE_CHORD_BOUNDS_TOLERANCE_MM,
      );
      const soup = unwrapKernelResult(kernel.tessellate(solid), "quarter soup");
      assertTessellationValid(soup, {
        bounds: { min: [0, 0, 0], max: [30, 25, 25] },
        toleranceMm: REVOLVE_CHORD_BOUNDS_TOLERANCE_MM,
      });
    });

    it("rejects invalid revolve input: crossing profiles, bad angles, degenerate axes", () => {
      const kernel = createKernel();
      // The crossing battery is the Phase 26.2 heart: material strictly on
      // both sides of the axis is rejected STRUCTUREDLY by every kernel
      // before its geometry (Manifold would silently clip the negative
      // side; JSCAD silently caps it).
      expectKernelFailure(
        kernel.revolve({
          loop: rectangleLoop(0, -10, 30, 25),
          axis: { point: [0, 0], direction: [1, 0] },
          angle: angle(Math.PI * 2),
          placement: identityPlacement(),
        }),
        KERNEL_ERROR_CODES.profileAxisCrossing,
        "profile crossing the axis",
      );
      expectKernelFailure(
        kernel.revolve(rectangleRevolve(0)),
        KERNEL_ERROR_CODES.invalidSweepAngle,
        "zero sweep",
      );
      expectKernelFailure(
        kernel.revolve(rectangleRevolve(Math.PI * 2 + 0.1)),
        KERNEL_ERROR_CODES.invalidSweepAngle,
        "over-full sweep",
      );
      expectKernelFailure(
        kernel.revolve(rectangleRevolve(-0.5)),
        KERNEL_ERROR_CODES.invalidSweepAngle,
        "negative sweep",
      );
      expectKernelFailure(
        kernel.revolve({
          loop: rectangleLoop(0, 0, 30, 25),
          axis: { point: [0, 0], direction: [0, 0] },
          angle: angle(Math.PI * 2),
          placement: identityPlacement(),
        }),
        KERNEL_ERROR_CODES.invalidRotation,
        "degenerate axis direction",
      );
      expectKernelFailure(
        kernel.revolve({ ...rectangleRevolve(Math.PI * 2), loop: [] }),
        KERNEL_ERROR_CODES.invalidProfile,
        "empty loop",
      );
      // Touching stays legal: the on-axis edge (the cylinder fixture) and a
      // profile on the −v side must both be accepted.
      const negative = unwrapKernelResult(
        kernel.revolve({
          loop: rectangleLoop(0, -25, 30, 25),
          axis: { point: [0, 0], direction: [1, 0] },
          angle: angle(Math.PI * 2),
          placement: identityPlacement(),
        }),
        "negative-side revolve",
      );
      assertVolumeClose(
        unwrapKernelResult(kernel.volume(negative), "negative-side volume"),
        Math.PI * 25 ** 2 * 30,
        CURVED_VOLUME_TOLERANCE,
      );
    });

    // -----------------------------------------------------------------
    // Sweep (Phase 26.3). Semantic judgement is gated on the `sweep`
    // capability; a kernel that has not declared it owes exactly one
    // thing — the structured `kernel/unsupported-operation` answer, never
    // a silent approximation.
    // -----------------------------------------------------------------

    /** The sweep fixture's rectangular section, centred on the path: 6 × 4. */
    function sweepSectionLoop(): ProfileExtrudeInput["loop"] {
      return rectangleLoop(-3, -2, 6, 4);
    }

    function straightSweepPath(height: number): ProfileSweepInput["path"] {
      return [{ kind: "line", start: [0, 0], end: [0, height] }];
    }

    /**
     * The quarter-arc bend fixture: a CCW arc of radius 30 starting at the
     * origin along +z, curving toward −x (centre (−30, 0)).
     */
    function quarterArcSweepPath(): ProfileSweepInput["path"] {
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

    it("sweeps a straight path into the extrude-equivalent prism, or answers unsupported honestly", () => {
      const kernel = createKernel();
      const input: ProfileSweepInput = {
        loop: sweepSectionLoop(),
        path: straightSweepPath(40),
        placement: identityPlacement(),
      };
      if (!kernel.capabilities.sweep) {
        // The honesty contract for engines without a sweep primitive: the
        // structured unsupported answer, even for perfectly valid input.
        expectKernelFailure(
          kernel.sweep(input),
          KERNEL_ERROR_CODES.unsupportedOperation,
          "sweep on a kernel without the sweep capability",
        );
        return;
      }
      const solid = unwrapKernelResult(kernel.sweep(input), "straight sweep");
      // Straight-edge profile, straight path: exact everywhere (the
      // extrude equivalence is definitional — Cavalieri both ways).
      assertVolumeClose(
        unwrapKernelResult(kernel.volume(solid), "straight sweep volume"),
        6 * 4 * 40,
        EXACT_VOLUME_TOLERANCE,
      );
      assertBoundsEqual(
        unwrapKernelResult(kernel.bounds(solid), "straight sweep bounds"),
        { min: [-3, -2, 0], max: [3, 2, 40] },
        EXTRUDE_PLACED_BOUNDS_TOLERANCE,
      );
      const extruded = unwrapKernelResult(
        kernel.extrude({
          loop: sweepSectionLoop(),
          height: length(40),
          direction: 1,
          placement: identityPlacement(),
        }),
        "extrude equivalence",
      );
      assertVolumeClose(
        unwrapKernelResult(kernel.volume(solid), "sweep volume"),
        unwrapKernelResult(kernel.volume(extruded), "extrude volume"),
        EXACT_VOLUME_TOLERANCE,
      );
      const first = unwrapKernelResult(kernel.tessellate(solid), "sweep soup");
      assertTessellationValid(first, {
        bounds: { min: [-3, -2, 0], max: [3, 2, 40] },
      });
      const second = unwrapKernelResult(kernel.tessellate(solid), "again");
      expect(second).toEqual(first);
    });

    it("sweeps a circular-arc path into the Pappus partial torus within the curved band", () => {
      const kernel = createKernel();
      if (!kernel.capabilities.sweep) return;
      const solid = unwrapKernelResult(
        kernel.sweep({
          loop: sweepSectionLoop(),
          path: quarterArcSweepPath(),
          placement: identityPlacement(),
        }),
        "quarter-arc sweep",
      );
      // Pappus: V = θ·d̄·A with the centroid on the path (d̄ = 30):
      // (π/2)·30·24 — OCCT and the fake kernel reach it exactly; the
      // station-lofting mesh kernel sits in the documented band.
      assertVolumeClose(
        unwrapKernelResult(kernel.volume(solid), "quarter torus volume"),
        (Math.PI / 2) * 30 * 24,
        CURVED_VOLUME_TOLERANCE,
      );
      // The quarter tube spans x ∈ [−30, 3], z ∈ [0, 33] (the outer radius
      // 33 at the far cap, the axis plane x = −30 at the sweep end); mesh
      // kernels carry the station band.
      assertBoundsEqual(
        unwrapKernelResult(kernel.bounds(solid), "quarter torus bounds"),
        { min: [-30, -2, 0], max: [3, 2, 33] },
        REVOLVE_CHORD_BOUNDS_TOLERANCE_MM,
      );
      const soup = unwrapKernelResult(kernel.tessellate(solid), "torus soup");
      assertTessellationValid(soup, {
        bounds: { min: [-30, -2, 0], max: [3, 2, 33] },
        toleranceMm: REVOLVE_CHORD_BOUNDS_TOLERANCE_MM,
      });
    });

    it("sweeps a full-circle path into the Pappus torus within the curved band", () => {
      const kernel = createKernel();
      if (!kernel.capabilities.sweep) return;
      const solid = unwrapKernelResult(
        kernel.sweep({
          loop: sweepSectionLoop(),
          path: [
            {
              kind: "arc",
              center: [-30, 0],
              radius: 30,
              startAngle: angle(0),
              endAngle: angle(Math.PI * 2),
            },
          ],
          placement: identityPlacement(),
        }),
        "closed ring sweep",
      );
      // V = 2π·d̄·A = 2π·30·24 — the torus volume, exact where promised.
      assertVolumeClose(
        unwrapKernelResult(kernel.volume(solid), "torus volume"),
        Math.PI * 2 * 30 * 24,
        CURVED_VOLUME_TOLERANCE,
      );
      assertBoundsEqual(
        unwrapKernelResult(kernel.bounds(solid), "torus bounds"),
        { min: [-63, -2, -33], max: [3, 2, 33] },
        REVOLVE_CHORD_BOUNDS_TOLERANCE_MM,
      );
    });

    it("sweeps a G1 line-arc-line chain with the summed analytic volume", () => {
      const kernel = createKernel();
      if (!kernel.capabilities.sweep) return;
      const solid = unwrapKernelResult(
        kernel.sweep({
          loop: sweepSectionLoop(),
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
          placement: identityPlacement(),
        }),
        "chained sweep",
      );
      // A·20 + θ·R·A + A·20 — Cavalieri, Pappus, Cavalieri.
      assertVolumeClose(
        unwrapKernelResult(kernel.volume(solid), "chain volume"),
        24 * 20 + (Math.PI / 2) * 30 * 24 + 24 * 20,
        CURVED_VOLUME_TOLERANCE,
      );
      // Prism (x ∈ [−3,3], z ∈ [0,20]) ∪ quarter torus (x ∈ [−30,3],
      // z ∈ [20,53]) ∪ prism (x ∈ [−50,−30], z ∈ [47,53]).
      assertBoundsEqual(
        unwrapKernelResult(kernel.bounds(solid), "chain bounds"),
        { min: [-50, -2, 0], max: [3, 2, 53] },
        REVOLVE_CHORD_BOUNDS_TOLERANCE_MM,
      );
    });

    it("rejects invalid sweep input: profile, path structure, self-crossing, pinch", () => {
      const kernel = createKernel();
      if (!kernel.capabilities.sweep) return;
      const section = sweepSectionLoop();
      // Profile failures stay on the profile code.
      expectKernelFailure(
        kernel.sweep({
          loop: [],
          path: straightSweepPath(40),
          placement: identityPlacement(),
        }),
        KERNEL_ERROR_CODES.invalidProfile,
        "empty profile loop",
      );
      expectKernelFailure(
        kernel.sweep({
          loop: section,
          path: straightSweepPath(40),
          placement: {
            rotation: { axis: [0, 0, 0], angle: angle(1) },
            translation: { x: length(0), y: length(0), z: length(0) },
          },
        }),
        KERNEL_ERROR_CODES.invalidRotation,
        "zero-axis placement rotation",
      );
      // Path structural battery: empty, not from the origin, oblique
      // attachment, degenerate segment, open chain, kink.
      expectKernelFailure(
        kernel.sweep({
          loop: section,
          path: [],
          placement: identityPlacement(),
        }),
        KERNEL_ERROR_CODES.invalidPath,
        "empty path",
      );
      expectKernelFailure(
        kernel.sweep({
          loop: section,
          path: [{ kind: "line", start: [5, 0], end: [5, 40] }],
          placement: identityPlacement(),
        }),
        KERNEL_ERROR_CODES.invalidPath,
        "path not starting at the origin",
      );
      expectKernelFailure(
        kernel.sweep({
          loop: section,
          path: [{ kind: "line", start: [0, 0], end: [10, 40] }],
          placement: identityPlacement(),
        }),
        KERNEL_ERROR_CODES.invalidPath,
        "oblique attachment (initial tangent not +z)",
      );
      expectKernelFailure(
        kernel.sweep({
          loop: section,
          path: [{ kind: "line", start: [0, 0], end: [0, 0] }],
          placement: identityPlacement(),
        }),
        KERNEL_ERROR_CODES.invalidPath,
        "zero-length path",
      );
      expectKernelFailure(
        kernel.sweep({
          loop: section,
          path: [
            { kind: "line", start: [0, 0], end: [0, 20] },
            { kind: "line", start: [0, 25], end: [0, 40] },
          ],
          placement: identityPlacement(),
        }),
        KERNEL_ERROR_CODES.invalidPath,
        "open chain (gap between segments)",
      );
      expectKernelFailure(
        kernel.sweep({
          loop: section,
          path: [
            { kind: "line", start: [0, 0], end: [0, 20] },
            { kind: "line", start: [0, 20], end: [20, 20] },
          ],
          placement: identityPlacement(),
        }),
        KERNEL_ERROR_CODES.invalidPath,
        "tangent kink at a joint",
      );
      expectKernelFailure(
        kernel.sweep({
          loop: section,
          path: [
            {
              kind: "arc",
              center: [-30, 0],
              radius: 30,
              startAngle: angle(0.5),
              endAngle: angle(0.5),
            },
          ],
          placement: identityPlacement(),
        }),
        KERNEL_ERROR_CODES.invalidPath,
        "zero-sweep arc",
      );
      // A G1 horseshoe whose return leg crosses the entry leg: the chord
      // polyline crossing, detected at resolution by every kernel.
      expectKernelFailure(
        kernel.sweep({
          loop: section,
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
          placement: identityPlacement(),
        }),
        KERNEL_ERROR_CODES.pathSelfIntersecting,
        "self-crossing path",
      );
      // The tight bend: a section wider than the arc's radius pinches
      // through the bend axis — the exact per-arc crossing detection.
      expectKernelFailure(
        kernel.sweep({
          loop: rectangleLoop(-35, -2, 40, 4),
          path: quarterArcSweepPath(),
          placement: identityPlacement(),
        }),
        KERNEL_ERROR_CODES.sweepSelfIntersecting,
        "profile crossing the bend axis",
      );
      // The mirrored family stays legal: a right-bending (clockwise) arc
      // path must sweep the mirrored partial torus.
      const mirrored = unwrapKernelResult(
        kernel.sweep({
          loop: section,
          path: [
            {
              kind: "arc",
              center: [30, 0],
              radius: 30,
              startAngle: angle(Math.PI),
              endAngle: angle(Math.PI / 2),
            },
          ],
          placement: identityPlacement(),
        }),
        "clockwise arc sweep",
      );
      assertVolumeClose(
        unwrapKernelResult(kernel.volume(mirrored), "clockwise arc volume"),
        (Math.PI / 2) * 30 * 24,
        CURVED_VOLUME_TOLERANCE,
      );
    });

    // -----------------------------------------------------------------
    // Loft (Phase 26.4). Semantic judgement is gated on the `loft`
    // capability; a kernel that has not declared it owes exactly the
    // structured `kernel/unsupported-operation` answer, never a silent
    // approximation. The pinned fixtures are the ruled-morph cases every
    // implementing kernel agrees on (the prism identity, the frustum
    // family, piecewise multi-station); the twisted case is deliberately
    // NOT pinned here — skew walls diverge between ruled-surface and
    // flat-wall kernels (probed), so it lives in each kernel's own suite.
    // -----------------------------------------------------------------

    /** A centred square section of the given side (4 chord vertices). */
    function loftSquareSection(
      side: number,
      z: number,
    ): ProfileLoftSectionInput {
      const h = side / 2;
      return { loop: rectangleLoop(-h, -h, side, side), z: length(z) };
    }

    it("lofts identical sections into the extrude-equivalent prism, or answers unsupported honestly", () => {
      const kernel = createKernel();
      const input: ProfileLoftInput = {
        sections: [loftSquareSection(6, 0), loftSquareSection(6, 40)],
        placement: identityPlacement(),
      };
      if (!kernel.capabilities.loft) {
        // The honesty contract for engines without a loft primitive: the
        // structured unsupported answer, even for perfectly valid input.
        expectKernelFailure(
          kernel.loft(input),
          KERNEL_ERROR_CODES.unsupportedOperation,
          "loft on a kernel without the loft capability",
        );
        return;
      }
      const solid = unwrapKernelResult(kernel.loft(input), "prism loft");
      // Identical sections: the prismatic loft IS the extrusion — the
      // identity is definitional (Simpson over a constant area).
      assertVolumeClose(
        unwrapKernelResult(kernel.volume(solid), "prism loft volume"),
        36 * 40,
        EXACT_VOLUME_TOLERANCE,
      );
      assertBoundsEqual(
        unwrapKernelResult(kernel.bounds(solid), "prism loft bounds"),
        { min: [-3, -3, 0], max: [3, 3, 40] },
        EXTRUDE_PLACED_BOUNDS_TOLERANCE,
      );
      const extruded = unwrapKernelResult(
        kernel.extrude({
          loop: rectangleLoop(-3, -3, 6, 6),
          height: length(40),
          direction: 1,
          placement: identityPlacement(),
        }),
        "extrude equivalence",
      );
      assertVolumeClose(
        unwrapKernelResult(kernel.volume(solid), "loft volume"),
        unwrapKernelResult(kernel.volume(extruded), "extrude volume"),
        EXACT_VOLUME_TOLERANCE,
      );
      const first = unwrapKernelResult(kernel.tessellate(solid), "loft soup");
      assertTessellationValid(first, {
        bounds: { min: [-3, -3, 0], max: [3, 3, 40] },
      });
      const second = unwrapKernelResult(kernel.tessellate(solid), "again");
      expect(second).toEqual(first);
    });

    it("lofts concentric circles into the conical frustum within the curved band", () => {
      const kernel = createKernel();
      if (!kernel.capabilities.loft) return;
      const solid = unwrapKernelResult(
        kernel.loft({
          sections: [
            {
              loop: [{ kind: "circle", center: [0, 0], radius: 6 }],
              z: length(0),
            },
            {
              loop: [{ kind: "circle", center: [0, 0], radius: 3 }],
              z: length(10),
            },
          ],
          placement: identityPlacement(),
        }),
        "frustum loft",
      );
      // The frustum family's exact value; OCCT reaches it exactly, the
      // chord-polygon kernels sit inside the documented chord band.
      assertVolumeClose(
        unwrapKernelResult(kernel.volume(solid), "frustum volume"),
        (Math.PI * 10 * (36 + 18 + 9)) / 3,
        CURVED_VOLUME_TOLERANCE,
      );
      // Chord vertices sit ON the true radius at the axis crossings; the
      // per-axis extremes may fall between them (the revolve band).
      assertBoundsEqual(
        unwrapKernelResult(kernel.bounds(solid), "frustum bounds"),
        { min: [-6, -6, 0], max: [6, 6, 10] },
        REVOLVE_CHORD_BOUNDS_TOLERANCE_MM,
      );
      const soup = unwrapKernelResult(kernel.tessellate(solid), "frustum soup");
      assertTessellationValid(soup, {
        bounds: { min: [-6, -6, 0], max: [6, 6, 10] },
        toleranceMm: REVOLVE_CHORD_BOUNDS_TOLERANCE_MM,
      });
    });

    it("lofts three stations piecewise: a prism span then a similar-square frustum span", () => {
      const kernel = createKernel();
      if (!kernel.capabilities.loft) return;
      const solid = unwrapKernelResult(
        kernel.loft({
          sections: [
            loftSquareSection(10, 0),
            loftSquareSection(10, 10),
            loftSquareSection(5, 20),
          ],
          placement: identityPlacement(),
        }),
        "multi-station loft",
      );
      // Piecewise semantics: span 1 is the prism A·h (100·10); span 2 the
      // similar-squares frustum h/3·(B₁+B₂+√(B₁B₂)) = 10/6·(100+4·56.25+25).
      // Straight edges everywhere: exact for every implementing kernel.
      assertVolumeClose(
        unwrapKernelResult(kernel.volume(solid), "multi-station volume"),
        100 * 10 + (10 / 6) * (100 + 4 * 56.25 + 25),
        EXACT_VOLUME_TOLERANCE,
      );
      assertBoundsEqual(
        unwrapKernelResult(kernel.bounds(solid), "multi-station bounds"),
        { min: [-5, -5, 0], max: [5, 5, 20] },
        EXTRUDE_PLACED_BOUNDS_TOLERANCE,
      );
      // The same composition every profile op pins: rotation about the
      // world origin FIRST (90° about z maps the local (10,10)–(30,25)
      // footprint onto x ∈ [−25,−10], y ∈ [10,30]), translation second.
      const placed = unwrapKernelResult(
        kernel.loft({
          sections: [
            { loop: rectangleLoop(10, 10, 20, 15), z: length(0) },
            { loop: rectangleLoop(10, 10, 20, 15), z: length(20) },
          ],
          placement: {
            rotation: { axis: [0, 0, 1], angle: angle(Math.PI / 2) },
            translation: { x: length(5), y: length(5), z: length(0) },
          },
        }),
        "placed loft",
      );
      assertBoundsEqual(
        unwrapKernelResult(kernel.bounds(placed), "placed bounds"),
        { min: [-20, 15, 0], max: [-5, 35, 20] },
        EXTRUDE_PLACED_BOUNDS_TOLERANCE,
      );
    });

    it("rejects invalid loft collections with the structured battery", () => {
      const kernel = createKernel();
      if (!kernel.capabilities.loft) return;
      // Count floor: the boolean operand-list convention.
      expectKernelFailure(
        kernel.loft({ sections: [], placement: identityPlacement() }),
        KERNEL_ERROR_CODES.invalidOperands,
        "empty section list",
      );
      expectKernelFailure(
        kernel.loft({
          sections: [loftSquareSection(6, 0)],
          placement: identityPlacement(),
        }),
        KERNEL_ERROR_CODES.invalidOperands,
        "single section",
      );
      // Member validity: the shared per-loop battery, index-named.
      expectKernelFailure(
        kernel.loft({
          sections: [
            { loop: rectangleLoop(0, 0, 10, 10).slice(0, 3), z: length(0) },
            loftSquareSection(10, 10),
          ],
          placement: identityPlacement(),
        }),
        KERNEL_ERROR_CODES.invalidProfile,
        "open member loop",
      );
      expectKernelFailure(
        kernel.loft({
          sections: [
            {
              loop: [
                { kind: "line", start: [0, 0], end: [10, 0] },
                { kind: "line", start: [10, 0], end: [20, 0] },
                { kind: "line", start: [20, 0], end: [10, 0] },
                { kind: "line", start: [10, 0], end: [0, 0] },
              ],
              z: length(0),
            },
            loftSquareSection(10, 10),
          ],
          placement: identityPlacement(),
        }),
        KERNEL_ERROR_CODES.invalidProfile,
        "zero-area member loop",
      );
      // The 26.4 compatibility core: chord vertex counts must match —
      // engines handed a mismatch would each invent their own
      // correspondence (JSCAD repartitions to the LCM, OCCT re-origins),
      // silently building different solids from one input.
      expectKernelFailure(
        kernel.loft({
          sections: [
            loftSquareSection(10, 0),
            {
              loop: [{ kind: "circle", center: [0, 0], radius: 5 }],
              z: length(10),
            },
          ],
          placement: identityPlacement(),
        }),
        KERNEL_ERROR_CODES.loftIncompatibleProfiles,
        "square-to-circle vertex-count mismatch",
      );
      // Station ordering: strictly increasing along the list.
      expectKernelFailure(
        kernel.loft({
          sections: [loftSquareSection(6, 0), loftSquareSection(6, 0)],
          placement: identityPlacement(),
        }),
        KERNEL_ERROR_CODES.loftUnorderedStations,
        "equal stations",
      );
      expectKernelFailure(
        kernel.loft({
          sections: [loftSquareSection(6, 10), loftSquareSection(6, 5)],
          placement: identityPlacement(),
        }),
        KERNEL_ERROR_CODES.loftUnorderedStations,
        "fold-back stations",
      );
      expectKernelFailure(
        kernel.loft({
          sections: [loftSquareSection(6, 0), loftSquareSection(6, 10)],
          placement: {
            rotation: { axis: [0, 0, 0], angle: angle(1) },
            translation: { x: length(0), y: length(0), z: length(0) },
          },
        }),
        KERNEL_ERROR_CODES.invalidRotation,
        "zero-axis placement rotation",
      );
    });

    // Fillet (Phase 26.5). Semantic judgement is gated on the `fillet`
    // capability, exactly like sweep and loft before it: a kernel declaring
    // `fillet: false` must answer EVERY call — valid input included — with
    // the structured unsupported code, and the fixtures' per-kernel edge
    // ordinals come from the registration's hint.
    it("fillets a box corner edge to the analytic volume, or answers unsupported honestly", () => {
      const kernel = createKernel();
      const target = box(kernel, 30, 20, 10);
      if (!kernel.capabilities.fillet) {
        // The honesty contract for engines without a fillet primitive:
        // even perfectly legal input answers unsupported, never a bad
        // approximation.
        expectKernelFailure(
          kernel.fillet({ target, edges: [0], radius: length(3) }),
          KERNEL_ERROR_CODES.unsupportedOperation,
          "fillet on a kernel without the fillet capability",
        );
        expectKernelFailure(
          kernel.fillet({ target, edges: [999], radius: length(0) }),
          KERNEL_ERROR_CODES.unsupportedOperation,
          "fillet stays unsupported for malformed input too",
        );
        return;
      }
      if (filletHint === undefined) {
        throw new Error(
          "Suite misuse: a kernel declaring fillet: true must register its fillet edge-ordinal hint.",
        );
      }
      const solid = unwrapKernelResult(
        kernel.fillet({
          target,
          edges: filletHint.cornerEdge,
          radius: length(3),
        }),
        "corner fillet",
      );
      assertVolumeClose(
        unwrapKernelResult(kernel.volume(solid), "corner fillet volume"),
        30 * 20 * 10 - CORNER_FILLET_VOLUME_MM3,
        EXACT_VOLUME_TOLERANCE,
      );
      assertBoundsEqual(
        unwrapKernelResult(kernel.bounds(solid), "corner fillet bounds"),
        { min: [0, 0, 0], max: [30, 20, 10] },
        EXACT_BOUNDS_TOLERANCE,
      );
      const first = unwrapKernelResult(kernel.tessellate(solid), "fillet soup");
      assertTessellationValid(first, {
        bounds: { min: [0, 0, 0], max: [30, 20, 10] },
      });
      expect(tessellationTriangleCount(first)).toBeGreaterThan(0);
      const second = unwrapKernelResult(
        kernel.tessellate(solid),
        "fillet soup",
      );
      expect(second).toEqual(first);
    });

    it("fillets two disjoint edges with the exact summed removal", () => {
      const kernel = createKernel();
      if (!kernel.capabilities.fillet) return;
      if (filletHint === undefined) {
        throw new Error(
          "Suite misuse: a kernel declaring fillet: true must register its fillet edge-ordinal hint.",
        );
      }
      const target = box(kernel, 30, 20, 10);
      const solid = unwrapKernelResult(
        kernel.fillet({
          target,
          edges: [...filletHint.oppositeEdges],
          radius: length(2),
        }),
        "opposite-pair fillet",
      );
      assertVolumeClose(
        unwrapKernelResult(kernel.volume(solid), "opposite-pair volume"),
        30 * 20 * 10 - 2 * PAIR_FILLET_VOLUME_MM3,
        EXACT_VOLUME_TOLERANCE,
      );
    });

    it("rejects invalid fillet input with the structured battery", () => {
      const kernel = createKernel();
      if (!kernel.capabilities.fillet) return;
      if (filletHint === undefined) {
        throw new Error(
          "Suite misuse: a kernel declaring fillet: true must register its fillet edge-ordinal hint.",
        );
      }
      const target = box(kernel, 30, 20, 10);
      const radius = length(3);
      // Radius semantics: strictly positive, validated before any engine
      // call (probed: a zero radius throws inside OCCT's WASM boundary —
      // it must never get there).
      expectKernelFailure(
        kernel.fillet({
          target,
          edges: filletHint.cornerEdge,
          radius: length(0),
        }),
        KERNEL_ERROR_CODES.invalidLength,
        "zero radius",
      );
      expectKernelFailure(
        kernel.fillet({
          target,
          edges: filletHint.cornerEdge,
          radius: length(-1),
        }),
        KERNEL_ERROR_CODES.invalidLength,
        "negative radius",
      );
      // Edge-address structure: at least one well-formed ordinal, no
      // duplicates.
      expectKernelFailure(
        kernel.fillet({ target, edges: [], radius }),
        KERNEL_ERROR_CODES.invalidOperands,
        "empty edge list",
      );
      expectKernelFailure(
        kernel.fillet({
          target,
          edges: [...filletHint.cornerEdge, ...filletHint.cornerEdge],
          radius,
        }),
        KERNEL_ERROR_CODES.invalidOperands,
        "duplicate ordinal",
      );
      expectKernelFailure(
        kernel.fillet({ target, edges: [1.5], radius }),
        KERNEL_ERROR_CODES.invalidOperands,
        "non-integer ordinal",
      );
      // A well-formed ordinal that names nothing in the target's snapshot
      // numbering is the stale-reference signature.
      expectKernelFailure(
        kernel.fillet({ target, edges: [999], radius }),
        KERNEL_ERROR_CODES.filletEdgeUnknown,
        "unknown ordinal",
      );
      // A radius the selected edges cannot carry is the engine's own
      // structured failure (probed: OCCT answers IsDone = false, no throw;
      // the fake kernel's fit check rejects before construction).
      expectKernelFailure(
        kernel.fillet({
          target,
          edges: filletHint.cornerEdge,
          radius: length(25),
        }),
        KERNEL_ERROR_CODES.filletFailed,
        "oversized radius",
      );
    });

    // Chamfer (Phase 26.6). The fillet discipline verbatim: a kernel
    // declaring `chamfer: false` answers EVERY call — valid input included
    // — with the structured unsupported code, and the fixtures' per-kernel
    // edge ordinals come from the registration's hint.
    it("chamfers a box corner edge to the analytic prism volume, or answers unsupported honestly", () => {
      const kernel = createKernel();
      const target = box(kernel, 30, 20, 10);
      if (!kernel.capabilities.chamfer) {
        // The honesty contract for engines without a chamfer primitive:
        // even perfectly legal input answers unsupported, never a bad
        // approximation.
        expectKernelFailure(
          kernel.chamfer({ target, edges: [0], distance: length(3) }),
          KERNEL_ERROR_CODES.unsupportedOperation,
          "chamfer on a kernel without the chamfer capability",
        );
        expectKernelFailure(
          kernel.chamfer({ target, edges: [999], distance: length(0) }),
          KERNEL_ERROR_CODES.unsupportedOperation,
          "chamfer stays unsupported for malformed input too",
        );
        return;
      }
      if (chamferHint === undefined) {
        throw new Error(
          "Suite misuse: a kernel declaring chamfer: true must register its chamfer edge-ordinal hint.",
        );
      }
      const solid = unwrapKernelResult(
        kernel.chamfer({
          target,
          edges: chamferHint.cornerEdge,
          distance: length(3),
        }),
        "corner chamfer",
      );
      assertVolumeClose(
        unwrapKernelResult(kernel.volume(solid), "corner chamfer volume"),
        30 * 20 * 10 - CORNER_CHAMFER_VOLUME_MM3,
        EXACT_VOLUME_TOLERANCE,
      );
      assertBoundsEqual(
        unwrapKernelResult(kernel.bounds(solid), "corner chamfer bounds"),
        { min: [0, 0, 0], max: [30, 20, 10] },
        EXACT_BOUNDS_TOLERANCE,
      );
      const first = unwrapKernelResult(
        kernel.tessellate(solid),
        "chamfer soup",
      );
      assertTessellationValid(first, {
        bounds: { min: [0, 0, 0], max: [30, 20, 10] },
      });
      expect(tessellationTriangleCount(first)).toBeGreaterThan(0);
      const second = unwrapKernelResult(
        kernel.tessellate(solid),
        "chamfer soup",
      );
      expect(second).toEqual(first);
    });

    it("chamfers two disjoint edges with the exact summed removal", () => {
      const kernel = createKernel();
      if (!kernel.capabilities.chamfer) return;
      if (chamferHint === undefined) {
        throw new Error(
          "Suite misuse: a kernel declaring chamfer: true must register its chamfer edge-ordinal hint.",
        );
      }
      const target = box(kernel, 30, 20, 10);
      const solid = unwrapKernelResult(
        kernel.chamfer({
          target,
          edges: [...chamferHint.oppositeEdges],
          distance: length(2),
        }),
        "opposite-pair chamfer",
      );
      assertVolumeClose(
        unwrapKernelResult(
          kernel.volume(solid),
          "opposite-pair chamfer volume",
        ),
        30 * 20 * 10 - 2 * PAIR_CHAMFER_VOLUME_MM3,
        EXACT_VOLUME_TOLERANCE,
      );
    });

    it("rejects invalid chamfer input with the structured battery", () => {
      const kernel = createKernel();
      if (!kernel.capabilities.chamfer) return;
      if (chamferHint === undefined) {
        throw new Error(
          "Suite misuse: a kernel declaring chamfer: true must register its chamfer edge-ordinal hint.",
        );
      }
      const target = box(kernel, 30, 20, 10);
      const distance = length(3);
      // Distance semantics: strictly positive, validated before any engine
      // call (probed: OCCT answers IsDone = false for a zero distance —
      // the structured rejection keeps even that from the engine).
      expectKernelFailure(
        kernel.chamfer({
          target,
          edges: chamferHint.cornerEdge,
          distance: length(0),
        }),
        KERNEL_ERROR_CODES.invalidLength,
        "zero distance",
      );
      expectKernelFailure(
        kernel.chamfer({
          target,
          edges: chamferHint.cornerEdge,
          distance: length(-1),
        }),
        KERNEL_ERROR_CODES.invalidLength,
        "negative distance",
      );
      // Edge-address structure: at least one well-formed ordinal, no
      // duplicates.
      expectKernelFailure(
        kernel.chamfer({ target, edges: [], distance }),
        KERNEL_ERROR_CODES.invalidOperands,
        "empty edge list",
      );
      expectKernelFailure(
        kernel.chamfer({
          target,
          edges: [...chamferHint.cornerEdge, ...chamferHint.cornerEdge],
          distance,
        }),
        KERNEL_ERROR_CODES.invalidOperands,
        "duplicate ordinal",
      );
      expectKernelFailure(
        kernel.chamfer({ target, edges: [1.5], distance }),
        KERNEL_ERROR_CODES.invalidOperands,
        "non-integer ordinal",
      );
      // A well-formed ordinal that names nothing in the target's snapshot
      // numbering is the stale-reference signature.
      expectKernelFailure(
        kernel.chamfer({ target, edges: [999], distance }),
        KERNEL_ERROR_CODES.chamferEdgeUnknown,
        "unknown ordinal",
      );
      // A distance the selected edges cannot carry is the engine's own
      // structured failure (probed: OCCT answers IsDone = false at exactly
      // the smaller adjacent extent — 20 mm here — no throw; the fake
      // kernel's fit check rejects before construction).
      expectKernelFailure(
        kernel.chamfer({
          target,
          edges: chamferHint.cornerEdge,
          distance: length(25),
        }),
        KERNEL_ERROR_CODES.chamferFailed,
        "oversized distance",
      );
    });

    // Shell (Phase 26.7). The sweep/loft/fillet/chamfer discipline on the
    // FACE-addressed operation: a kernel declaring `shell: false` answers
    // EVERY call — valid input included — with the structured unsupported
    // code, and the fixtures' per-kernel face ordinal comes from the
    // registration's hint.
    it("shells a box open at one face to the analytic volume, or answers unsupported honestly", () => {
      const kernel = createKernel();
      const target = box(kernel, 30, 20, 10);
      if (!kernel.capabilities.shell) {
        // The honesty contract for engines without a hollowing primitive:
        // even perfectly legal input answers unsupported, never a bad
        // approximation.
        expectKernelFailure(
          kernel.shell({ target, faces: [0], thickness: length(2) }),
          KERNEL_ERROR_CODES.unsupportedOperation,
          "shell on a kernel without the shell capability",
        );
        expectKernelFailure(
          kernel.shell({ target, faces: [999], thickness: length(0) }),
          KERNEL_ERROR_CODES.unsupportedOperation,
          "shell stays unsupported for malformed input too",
        );
        return;
      }
      if (shellHint === undefined) {
        throw new Error(
          "Suite misuse: a kernel declaring shell: true must register its shell face-ordinal hint.",
        );
      }
      const solid = unwrapKernelResult(
        kernel.shell({
          target,
          faces: [shellHint.openFace],
          thickness: length(2),
        }),
        "one-face shell",
      );
      assertVolumeClose(
        unwrapKernelResult(kernel.volume(solid), "one-face shell volume"),
        30 * 20 * 10 - OPEN_FACE_SHELL_CAVITY_T2_MM3,
        EXACT_VOLUME_TOLERANCE,
      );
      // The walls own the outer boundary (only interior material became
      // the cavity): the shell's tight AABB is exactly the box's.
      assertBoundsEqual(
        unwrapKernelResult(kernel.bounds(solid), "one-face shell bounds"),
        { min: [0, 0, 0], max: [30, 20, 10] },
        EXACT_BOUNDS_TOLERANCE,
      );
      const first = unwrapKernelResult(kernel.tessellate(solid), "shell soup");
      assertTessellationValid(first, {
        bounds: { min: [0, 0, 0], max: [30, 20, 10] },
      });
      expect(tessellationTriangleCount(first)).toBeGreaterThan(0);
      const second = unwrapKernelResult(kernel.tessellate(solid), "shell soup");
      expect(second).toEqual(first);
    });

    it("re-shells the same opening at another thickness to its own analytic volume", () => {
      const kernel = createKernel();
      if (!kernel.capabilities.shell) return;
      if (shellHint === undefined) {
        throw new Error(
          "Suite misuse: a kernel declaring shell: true must register its shell face-ordinal hint.",
        );
      }
      // The thickness parameterization: the same opening at t = 3 removes
      // its own cavity — the regeneration drive behind a `parameter.set`
      // on the wall thickness.
      const target = box(kernel, 30, 20, 10);
      const solid = unwrapKernelResult(
        kernel.shell({
          target,
          faces: [shellHint.openFace],
          thickness: length(3),
        }),
        "re-shelled opening",
      );
      assertVolumeClose(
        unwrapKernelResult(kernel.volume(solid), "re-shelled volume"),
        30 * 20 * 10 - OPEN_FACE_SHELL_CAVITY_T3_MM3,
        EXACT_VOLUME_TOLERANCE,
      );
    });

    it("rejects invalid shell input with the structured battery", () => {
      const kernel = createKernel();
      if (!kernel.capabilities.shell) return;
      if (shellHint === undefined) {
        throw new Error(
          "Suite misuse: a kernel declaring shell: true must register its shell face-ordinal hint.",
        );
      }
      const target = box(kernel, 30, 20, 10);
      const thickness = length(2);
      // Thickness semantics: strictly positive, validated before any engine
      // call (probed: a zero thickness is the one input OCCT's
      // MakeThickSolidByJoin answers IsDone = false for).
      expectKernelFailure(
        kernel.shell({
          target,
          faces: [shellHint.openFace],
          thickness: length(0),
        }),
        KERNEL_ERROR_CODES.invalidLength,
        "zero thickness",
      );
      expectKernelFailure(
        kernel.shell({
          target,
          faces: [shellHint.openFace],
          thickness: length(-1),
        }),
        KERNEL_ERROR_CODES.invalidLength,
        "negative thickness",
      );
      // Face-address structure: at least one well-formed ordinal, no
      // duplicates.
      expectKernelFailure(
        kernel.shell({ target, faces: [], thickness }),
        KERNEL_ERROR_CODES.invalidOperands,
        "empty face list",
      );
      expectKernelFailure(
        kernel.shell({
          target,
          faces: [shellHint.openFace, shellHint.openFace],
          thickness,
        }),
        KERNEL_ERROR_CODES.invalidOperands,
        "duplicate ordinal",
      );
      expectKernelFailure(
        kernel.shell({ target, faces: [1.5], thickness }),
        KERNEL_ERROR_CODES.invalidOperands,
        "non-integer ordinal",
      );
      // A well-formed ordinal that names nothing in the target's snapshot
      // numbering is the stale-reference signature.
      expectKernelFailure(
        kernel.shell({ target, faces: [999], thickness }),
        KERNEL_ERROR_CODES.shellFaceUnknown,
        "unknown ordinal",
      );
      // Too-thick walls are the structured shell failure (probed: the
      // engine itself never declines them — OCCT silently returns the
      // pristine target past the collapse, so the adapter's post-condition
      // is the refusal; the fake kernel's fit check rejects before
      // construction).
      expectKernelFailure(
        kernel.shell({
          target,
          faces: [shellHint.openFace],
          thickness: length(12),
        }),
        KERNEL_ERROR_CODES.shellFailed,
        "walls meeting",
      );
    });

    // Mirror (Phase 26.9). Semantic judgement is gated on the `mirror`
    // capability like every sibling above; the fixtures pin the isometry
    // (identical volume), the reflected bounds (hand-derivable interval
    // flips), and the OUTWARD WINDING of the reflected soup — the failure
    // mode a naive vertex-only reflection would produce (an inside-out
    // solid) reads as a NEGATIVE signed volume of the tessellation, so the
    // divergence-theorem sum over the soup is the kernel-neutral judge.
    it("mirrors a box across a world axis plane to identical volume, reflected bounds, and outward winding — or answers unsupported honestly", () => {
      const kernel = createKernel();
      const target = box(kernel, 30, 20, 10);
      if (!kernel.capabilities.mirror) {
        // The honesty contract for engines without a reflection: even
        // perfectly legal input answers unsupported, never a bad
        // approximation.
        expectKernelFailure(
          kernel.mirror(target, { axis: "x", offset: length(0) }),
          KERNEL_ERROR_CODES.unsupportedOperation,
          "mirror on a kernel without the mirror capability",
        );
        return;
      }
      const solid = unwrapKernelResult(
        kernel.mirror(target, { axis: "x", offset: length(0) }),
        "x-plane mirror",
      );
      // Isometry: the volume is untouched, exactly.
      assertVolumeClose(
        unwrapKernelResult(kernel.volume(solid), "mirrored volume"),
        30 * 20 * 10,
        EXACT_VOLUME_TOLERANCE,
      );
      // Reflected bounds: x ∈ [0, 30] flips to [−30, 0]; y and z unchanged.
      assertBoundsEqual(
        unwrapKernelResult(kernel.bounds(solid), "mirrored bounds"),
        { min: [-30, 0, 0], max: [0, 20, 10] },
        EXACT_BOUNDS_TOLERANCE,
      );
      // Winding: the soup's signed volume (divergence theorem over its
      // triangles) must stay POSITIVE — an inside-out reflection would
      // measure −6000 here. The box's planar faces make the sum exact on
      // every kernel; half the true volume is a generous positive floor.
      const soup = unwrapKernelResult(kernel.tessellate(solid), "mirror soup");
      assertTessellationValid(soup, {
        bounds: { min: [-30, 0, 0], max: [0, 20, 10] },
      });
      expect(tessellationTriangleCount(soup)).toBeGreaterThan(0);
      expect(signedSoupVolume(soup)).toBeGreaterThan((30 * 20 * 10) / 2);
      // Triangle count is preserved: a reflection moves vertices, it never
      // re-tessellates.
      const before = unwrapKernelResult(
        kernel.tessellate(target),
        "target soup",
      );
      expect(tessellationTriangleCount(soup)).toBe(
        tessellationTriangleCount(before),
      );
      const second = unwrapKernelResult(kernel.tessellate(solid), "again");
      expect(second).toEqual(soup);
    });

    it("mirrors across an offset plane and composes the double reflection into a translation", () => {
      const kernel = createKernel();
      if (!kernel.capabilities.mirror) return;
      const target = box(kernel, 30, 20, 10);
      // Offset plane: y ∈ [0, 20] through the plane y = 5 flips to
      // [2·5 − 20, 2·5 − 0] = [−10, 10]; every finite offset is legal,
      // negative included (a plane at y = −7 flips it to [−34, −14]).
      const offsetMirrored = unwrapKernelResult(
        kernel.mirror(target, { axis: "y", offset: length(5) }),
        "offset mirror",
      );
      assertBoundsEqual(
        unwrapKernelResult(kernel.bounds(offsetMirrored), "offset bounds"),
        { min: [0, -10, 0], max: [30, 10, 10] },
        EXACT_BOUNDS_TOLERANCE,
      );
      const negativeMirrored = unwrapKernelResult(
        kernel.mirror(target, { axis: "y", offset: length(-7) }),
        "negative-offset mirror",
      );
      assertBoundsEqual(
        unwrapKernelResult(kernel.bounds(negativeMirrored), "negative bounds"),
        { min: [0, -34, 0], max: [30, -14, 10] },
        EXACT_BOUNDS_TOLERANCE,
      );
      // Double reflection: two parallel mirrors compose to the translation
      // by 2·(o₂ − o₁) — x@0 then x@5 nets x ↦ x + 10.
      const once = unwrapKernelResult(
        kernel.mirror(target, { axis: "x", offset: length(0) }),
        "first mirror",
      );
      const twice = unwrapKernelResult(
        kernel.mirror(once, { axis: "x", offset: length(5) }),
        "second mirror",
      );
      assertBoundsEqual(
        unwrapKernelResult(kernel.bounds(twice), "double-mirror bounds"),
        { min: [10, 0, 0], max: [40, 20, 10] },
        EXACT_BOUNDS_TOLERANCE,
      );
      assertVolumeClose(
        unwrapKernelResult(kernel.volume(twice), "double-mirror volume"),
        30 * 20 * 10,
        EXACT_VOLUME_TOLERANCE,
      );
    });

    it("rejects a non-finite mirror offset with kernel/invalid-length and mirrors emptiness", () => {
      const kernel = createKernel();
      if (!kernel.capabilities.mirror) return;
      const target = box(kernel, 30, 20, 10);
      const nanOffset: LengthValue = {
        dimension: "length",
        unit: "mm",
        value: Number.NaN,
      };
      expectKernelFailure(
        kernel.mirror(target, { axis: "z", offset: nanOffset }),
        KERNEL_ERROR_CODES.invalidLength,
        "NaN offset mirror",
      );
      // The empty solid mirrors to the empty solid: volume 0, empty soup,
      // structured bounds failure.
      const left = box(kernel, 10, 10, 10);
      const right = translatedBox(kernel, 10, 10, 10, 50, 0, 0);
      const empty = unwrapKernelResult(
        kernel.intersect([left, right]),
        "intersect",
      );
      const mirrored = unwrapKernelResult(
        kernel.mirror(empty, { axis: "x", offset: length(3) }),
        "empty mirror",
      );
      assertVolumeClose(
        unwrapKernelResult(kernel.volume(mirrored), "empty mirrored volume"),
        0,
        EXACT_VOLUME_TOLERANCE,
      );
      expect(
        tessellationTriangleCount(
          unwrapKernelResult(kernel.tessellate(mirrored), "empty soup"),
        ),
      ).toBe(0);
      expectKernelFailure(
        kernel.bounds(mirrored),
        KERNEL_ERROR_CODES.boundsEmpty,
        "bounds of mirrored empty solid",
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
