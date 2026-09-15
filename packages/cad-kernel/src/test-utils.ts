/**
 * Kernel-neutral semantic geometry assertions (Phase 8): the shared
 * vocabulary every kernel test suite uses to judge geometry — the fake
 * kernel's suite today, the Phase 9 Manifold adapter's suite, and the
 * cross-kernel suites after it.
 *
 * The rule these utilities enforce, per the development plan: geometry
 * correctness is judged semantically — bounds, volume, containment,
 * structural validity, each within documented tolerances — and NEVER by
 * exact triangle-buffer equality as the sole criterion. No helper here
 * compares positions or index buffers between kernels.
 *
 * The helpers are framework-free: they throw descriptive `Error`s on
 * violation (and return the unwrapped value on success), so they work under
 * any test runner and compose with `expect(() => …).toThrow()` styles.
 *
 * Default tolerances and what covers them:
 *
 * - {@link DEFAULT_BOUNDS_TOLERANCE_MM} (1e-6): exact bounds comparisons.
 *   Primitives and pure translations are analytically exact in every
 *   conforming kernel; 1e-6 absorbs float noise without masking real error.
 * - Relative volume tolerances are chosen by the caller per fixture. Curved
 *   primitives and boolean volumes involve either mesh discretization
 *   (Manifold) or deterministic voxel quadrature (the fake kernel), so the
 *   shared suites use a few percent; exact-capable cases stay tight.
 */

import {
  type KernelBounds,
  type KernelError,
  type KernelResult,
  type Tessellation,
  tessellationTriangleCount,
} from "./contract";

/** Default absolute tolerance (mm) for bounds comparisons. */
export const DEFAULT_BOUNDS_TOLERANCE_MM = 1e-6;

/**
 * Unwraps a successful kernel result, throwing a descriptive error (code +
 * message) on failure. The standard way test code consumes kernel outputs.
 */
export function unwrapKernelResult<T>(
  result: KernelResult<T>,
  label = "kernel operation",
): T {
  if (result.ok) return result.value;
  throw new Error(
    `${label} failed with ${result.error.code}: ${result.error.message}`,
  );
}

/**
 * Asserts that a kernel result failed with exactly the expected code and
 * returns the structured error for further checks. Throws when the
 * operation unexpectedly succeeded or failed differently.
 */
export function expectKernelFailure(
  result: KernelResult<unknown>,
  code: KernelError["code"],
  label = "kernel operation",
): KernelError {
  if (result.ok) {
    throw new Error(
      `${label} was expected to fail with ${code} but succeeded.`,
    );
  }
  if (result.error.code !== code) {
    throw new Error(
      `${label} was expected to fail with ${code} but failed with ${result.error.code}: ${result.error.message}`,
    );
  }
  return result.error;
}

function formatBounds(bounds: KernelBounds): string {
  return `[${bounds.min.join(", ")}] – [${bounds.max.join(", ")}]`;
}

/**
 * Asserts two bounding boxes are equal component-wise within an absolute
 * tolerance (mm). For tight-capable cases (primitives, translations) use the
 * default; conservative boolean containers should use containment instead.
 */
export function assertBoundsEqual(
  actual: KernelBounds,
  expected: KernelBounds,
  toleranceMm: number = DEFAULT_BOUNDS_TOLERANCE_MM,
): void {
  const [aMinX, aMinY, aMinZ] = actual.min;
  const [aMaxX, aMaxY, aMaxZ] = actual.max;
  const [eMinX, eMinY, eMinZ] = expected.min;
  const [eMaxX, eMaxY, eMaxZ] = expected.max;
  if (
    aMinX === undefined ||
    aMinY === undefined ||
    aMinZ === undefined ||
    aMaxX === undefined ||
    aMaxY === undefined ||
    aMaxZ === undefined ||
    eMinX === undefined ||
    eMinY === undefined ||
    eMinZ === undefined ||
    eMaxX === undefined ||
    eMaxY === undefined ||
    eMaxZ === undefined
  ) {
    throw new Error(
      `Malformed bounds: expected ${formatBounds(expected)}, got ${formatBounds(actual)}.`,
    );
  }
  const axes: readonly (readonly [string, number, number])[] = [
    ["x", aMinX, eMinX],
    ["x", aMaxX, eMaxX],
    ["y", aMinY, eMinY],
    ["y", aMaxY, eMaxY],
    ["z", aMinZ, eMinZ],
    ["z", aMaxZ, eMaxZ],
  ];
  for (const [axis, actualValue, expectedValue] of axes) {
    if (Math.abs(actualValue - expectedValue) > toleranceMm) {
      throw new Error(
        `Bounds mismatch beyond ${toleranceMm} mm on ${axis}: expected ${formatBounds(expected)}, got ${formatBounds(actual)}.`,
      );
    }
  }
}

function withinBox(
  point: readonly [number, number, number],
  box: KernelBounds,
  toleranceMm: number,
): boolean {
  for (let axis = 0; axis < 3; axis += 1) {
    const value = point[axis];
    const min = box.min[axis];
    const max = box.max[axis];
    if (value === undefined || min === undefined || max === undefined) {
      return false;
    }
    if (value < min - toleranceMm || value > max + toleranceMm) return false;
  }
  return true;
}

/**
 * Extracts the eight corners of a bounds box, throwing on a malformed
 * (non-3-component) box.
 */
function cornersOf(
  bounds: KernelBounds,
): readonly (readonly [number, number, number])[] {
  const [minX, minY, minZ] = bounds.min;
  const [maxX, maxY, maxZ] = bounds.max;
  if (
    minX === undefined ||
    minY === undefined ||
    minZ === undefined ||
    maxX === undefined ||
    maxY === undefined ||
    maxZ === undefined
  ) {
    throw new Error(`Malformed bounds ${formatBounds(bounds)}.`);
  }
  return [
    [minX, minY, minZ],
    [maxX, minY, minZ],
    [minX, maxY, minZ],
    [minX, minY, maxZ],
    [maxX, maxY, minZ],
    [maxX, minY, maxZ],
    [minX, maxY, maxZ],
    [maxX, maxY, maxZ],
  ];
}

/**
 * Asserts that `outer` contains `inner` — every corner of `inner` lies
 * inside `outer`, component-wise, within a tolerance (mm). This is the
 * semantic bounds check for conservative containers (e.g. a kernel without
 * tight boolean bounds returning a containing box).
 */
export function assertBoundsContain(
  outer: KernelBounds,
  inner: KernelBounds,
  toleranceMm: number = DEFAULT_BOUNDS_TOLERANCE_MM,
): void {
  const outside = cornersOf(inner).filter(
    (corner) => !withinBox(corner, outer, toleranceMm),
  );
  if (outside.length > 0) {
    throw new Error(
      `Bounds ${formatBounds(outer)} do not contain inner bounds ${formatBounds(inner)} within ${toleranceMm} mm; violating corners: ${outside.map((corner) => `[${corner.join(", ")}]`).join("; ")}.`,
    );
  }
}

/**
 * Asserts a volume (mm³) matches an expectation within a relative tolerance:
 * `|actual − expected| ≤ relativeTolerance × |expected|` (with a 1e-9
 * absolute floor for expected ≈ 0, e.g. empty solids).
 */
export function assertVolumeClose(
  actualMm3: number,
  expectedMm3: number,
  relativeTolerance: number,
): void {
  const allowance = Math.max(relativeTolerance * Math.abs(expectedMm3), 1e-9);
  if (Math.abs(actualMm3 - expectedMm3) > allowance) {
    throw new Error(
      `Volume ${actualMm3} mm³ is not within ${relativeTolerance * 100}% of the expected ${expectedMm3} mm³ (allowance ±${allowance}).`,
    );
  }
}

/**
 * Asserts an ordering relation between volumes (mm³): `lesser < greater`.
 * Callers must ensure the fixtures differ by a meaningful margin (boolean
 * gaps, not float noise) — the relation is strict.
 */
export function assertVolumeLessThan(
  lesserMm3: number,
  greaterMm3: number,
): void {
  if (!(lesserMm3 < greaterMm3)) {
    throw new Error(
      `Expected volume ${lesserMm3} mm³ to be strictly less than ${greaterMm3} mm³.`,
    );
  }
}

/** Options of {@link assertTessellationValid}. */
export interface TessellationValidityOptions {
  /**
   * When provided, every vertex must lie within this box ± tolerance —
   * the soup must not exceed the solid's bounds.
   */
  readonly bounds?: KernelBounds;
  /** Absolute tolerance (mm) for the bounds check; default 1e-6. */
  readonly toleranceMm?: number;
  /** Whether at least one triangle is required; default `true`. */
  readonly requireTriangles?: boolean;
}

/**
 * Asserts a tessellation is structurally contract-valid: flat arrays with
 * lengths divisible by 3, every index inside the vertex range, finite
 * coordinates, non-degenerate structure (no NaN), optionally non-empty and
 * within bounds. This is the validity half of the semantic rule — combined
 * with bounds/volume assertions it forms the full correctness criterion.
 */
export function assertTessellationValid(
  tessellation: Tessellation,
  options: TessellationValidityOptions = {},
): void {
  const {
    bounds,
    toleranceMm = DEFAULT_BOUNDS_TOLERANCE_MM,
    requireTriangles = true,
  } = options;
  const { positions, indices } = tessellation;
  if (positions.length % 3 !== 0) {
    throw new Error(
      `Tessellation positions length ${positions.length} is not divisible by 3.`,
    );
  }
  if (indices.length % 3 !== 0) {
    throw new Error(
      `Tessellation indices length ${indices.length} is not divisible by 3.`,
    );
  }
  const vertexCount = positions.length / 3;
  if (requireTriangles && tessellationTriangleCount(tessellation) === 0) {
    throw new Error(
      "Tessellation is empty but at least one triangle is required.",
    );
  }
  for (let i = 0; i < positions.length; i += 1) {
    const value = positions[i];
    if (value === undefined || !Number.isFinite(value)) {
      throw new Error(
        `Tessellation position ${i} is not a finite number (got ${String(value)}).`,
      );
    }
  }
  for (let i = 0; i < indices.length; i += 1) {
    const index = indices[i];
    if (
      index === undefined ||
      !Number.isInteger(index) ||
      index < 0 ||
      index >= vertexCount
    ) {
      throw new Error(
        `Tessellation index ${i} is ${String(index)}, outside the vertex range 0..${vertexCount - 1}.`,
      );
    }
  }
  if (bounds !== undefined) {
    for (let v = 0; v < positions.length; v += 3) {
      const x = positions[v];
      const y = positions[v + 1];
      const z = positions[v + 2];
      if (x === undefined || y === undefined || z === undefined) continue;
      if (!withinBox([x, y, z], bounds, toleranceMm)) {
        throw new Error(
          `Tessellation vertex [${x}, ${y}, ${z}] lies outside the bounds ${formatBounds(bounds)} within ${toleranceMm} mm.`,
        );
      }
    }
  }
}
