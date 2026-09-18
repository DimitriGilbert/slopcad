/**
 * Renderer-neutral semantic projection assertions (Phase 11.1): the shared
 * vocabulary tests use to judge a rendered projection's geometry — the
 * GPU-independent correctness evidence the development plan designates as
 * primary. Mirrors the kernel test-utils discipline on the other side of the
 * projection boundary: structural validity, tolerance-based numeric
 * comparison, and never pixel output or golden triangle-buffer equality
 * (positions are compared within tolerance against a same-source
 * expectation, not as a cross-kernel fixture).
 *
 * The helpers are framework-free: they throw descriptive `Error`s on
 * violation and return silently on success, so they work under any test
 * runner and compose with `expect(() => …).toThrow()` styles.
 *
 * Tolerances and what covers them:
 *
 * - {@link DEFAULT_PROJECTION_LINEAR_TOLERANCE_MM} (1e-6): positions, bounds,
 *   and camera linear fields. Projection buffers pass the kernel's float64
 *   soup through unchanged, so same-source comparisons are exact up to
 *   serialization noise; 1e-6 absorbs that without masking real drift.
 * - Camera `fovDeg` compares in degrees with the same numeric default
 *   (1e-6°) — deterministic cameras are data, and degree-level float noise
 *   is far above it.
 * - Indices compare exactly: index buffers carry no metric, so there is no
 *   meaningful distance between them and the documented tolerance is zero.
 * - Validity is winding-agnostic: triangle orientation is kernel-dependent
 *   and deliberately unchecked (see the projection module header).
 */

import {
  type RenderBounds,
  type RenderCamera,
  type RenderObject,
  type RenderProjection,
  parseRenderCamera,
  parseRenderObjectId,
  RENDER_NORMAL_UNIT_TOLERANCE,
} from "./projection";

/** Default absolute tolerance (mm) for positions, bounds, and camera fields. */
export const DEFAULT_PROJECTION_LINEAR_TOLERANCE_MM = 1e-6;

/** Options of {@link assertRenderObjectValid} and {@link assertProjectionValid}. */
export interface RenderObjectValidityOptions {
  /**
   * Absolute tolerance (mm) for the bounds self-containment check; default
   * 1e-6.
   */
  readonly toleranceMm?: number;
  /** Whether at least one triangle is required; default `true`. */
  readonly requireTriangles?: boolean;
}

/**
 * Asserts a render object is structurally contract-valid: well-formed id,
 * flat arrays with lengths divisible by 3, finite coordinates, indices
 * inside the vertex range, normals (when present) paired and unit within
 * the kernel tolerance, at least one triangle unless waived, and every
 * vertex inside the object's own bounds — the projection-specific
 * self-consistency check, since render bounds are computed from positions.
 * Winding is never checked.
 */
export function assertRenderObjectValid(
  object: RenderObject,
  options: RenderObjectValidityOptions = {},
): void {
  const {
    toleranceMm = DEFAULT_PROJECTION_LINEAR_TOLERANCE_MM,
    requireTriangles = true,
  } = options;
  const idCheck = parseRenderObjectId(object.id);
  if (!idCheck.ok) {
    throw new Error(
      `Render object id "${object.id}" is not a valid rend_ id: ${idCheck.error.message}`,
    );
  }
  const { positions, indices, normals, bounds } = object;
  if (positions.length % 3 !== 0) {
    throw new Error(
      `Render object positions length ${positions.length} is not divisible by 3.`,
    );
  }
  if (indices.length % 3 !== 0) {
    throw new Error(
      `Render object indices length ${indices.length} is not divisible by 3.`,
    );
  }
  if (requireTriangles && indices.length === 0) {
    throw new Error(
      "Render object is empty but at least one triangle is required.",
    );
  }
  for (let i = 0; i < positions.length; i += 1) {
    const value = positions[i];
    if (value === undefined || !Number.isFinite(value)) {
      throw new Error(
        `Render object position ${i} is not a finite number (got ${String(value)}).`,
      );
    }
  }
  const vertexCount = positions.length / 3;
  for (let i = 0; i < indices.length; i += 1) {
    const index = indices[i];
    if (
      index === undefined ||
      !Number.isInteger(index) ||
      index < 0 ||
      index >= vertexCount
    ) {
      throw new Error(
        `Render object index ${i} is ${String(index)}, outside the vertex range 0..${vertexCount - 1}.`,
      );
    }
  }
  if (normals !== undefined) {
    if (normals.length !== positions.length) {
      throw new Error(
        `Render object normals length ${normals.length} does not match positions length ${positions.length}.`,
      );
    }
    for (let i = 0; i < normals.length; i += 3) {
      const nx = normals[i];
      const ny = normals[i + 1];
      const nz = normals[i + 2];
      if (
        nx === undefined ||
        ny === undefined ||
        nz === undefined ||
        !Number.isFinite(nx) ||
        !Number.isFinite(ny) ||
        !Number.isFinite(nz)
      ) {
        throw new Error(
          `Render object normal ${i / 3} is not a finite vector (got [${String(nx)}, ${String(ny)}, ${String(nz)}]).`,
        );
      }
      const length = Math.hypot(nx, ny, nz);
      if (Math.abs(length - 1) > RENDER_NORMAL_UNIT_TOLERANCE) {
        throw new Error(
          `Render object normal ${i / 3} has length ${length}, not unit within ${RENDER_NORMAL_UNIT_TOLERANCE}.`,
        );
      }
    }
  }
  for (let v = 0; v < positions.length; v += 3) {
    const x = positions[v];
    const y = positions[v + 1];
    const z = positions[v + 2];
    if (x === undefined || y === undefined || z === undefined) continue;
    const [minX, minY, minZ] = bounds.min;
    const [maxX, maxY, maxZ] = bounds.max;
    if (
      x < minX - toleranceMm ||
      x > maxX + toleranceMm ||
      y < minY - toleranceMm ||
      y > maxY + toleranceMm ||
      z < minZ - toleranceMm ||
      z > maxZ + toleranceMm
    ) {
      throw new Error(
        `Render object vertex [${x}, ${y}, ${z}] lies outside its own bounds [${bounds.min.join(", ")}] – [${bounds.max.join(", ")}] within ${toleranceMm} mm.`,
      );
    }
  }
}

/**
 * Asserts a whole projection is valid: the camera passes the contract's own
 * validation ({@link parseRenderCamera}), every object passes
 * {@link assertRenderObjectValid}, and object ids are unique.
 */
export function assertProjectionValid(
  projection: RenderProjection,
  options: RenderObjectValidityOptions = {},
): void {
  const cameraCheck = parseRenderCamera(projection.camera);
  if (!cameraCheck.ok) {
    throw new Error(
      `Projection camera is invalid: ${cameraCheck.error.message}`,
    );
  }
  const seen = new Set<string>();
  for (const object of projection.objects) {
    assertRenderObjectValid(object, options);
    if (seen.has(object.id)) {
      throw new Error(
        `Duplicate render object id "${object.id}" in projection.`,
      );
    }
    seen.add(object.id);
  }
}

/**
 * Asserts two flat position arrays are element-wise equal within an
 * absolute tolerance (mm). The semantic positions check for projections:
 * same length, every component finite and within tolerance. Never a golden
 * cross-kernel comparison — the expectation is a same-source truth.
 */
export function assertPositionsClose(
  actual: readonly number[],
  expected: readonly number[],
  toleranceMm: number = DEFAULT_PROJECTION_LINEAR_TOLERANCE_MM,
): void {
  if (actual.length !== expected.length) {
    throw new Error(
      `Position arrays differ in length: ${actual.length} vs ${expected.length}.`,
    );
  }
  for (let i = 0; i < actual.length; i += 1) {
    const a = actual[i];
    const e = expected[i];
    if (
      a === undefined ||
      e === undefined ||
      !Number.isFinite(a) ||
      !Number.isFinite(e) ||
      Math.abs(a - e) > toleranceMm
    ) {
      throw new Error(
        `Position ${i} (${String(a)}) is not within ${toleranceMm} mm of ${String(e)}.`,
      );
    }
  }
}

/**
 * Asserts two index arrays are exactly equal. Index buffers carry no
 * metric, so the documented tolerance is zero: a projection that claims to
 * pass the kernel soup through must pass it through byte-for-byte.
 */
export function assertIndicesEqual(
  actual: readonly number[],
  expected: readonly number[],
): void {
  if (actual.length !== expected.length) {
    throw new Error(
      `Index arrays differ in length: ${actual.length} vs ${expected.length}.`,
    );
  }
  for (let i = 0; i < actual.length; i += 1) {
    const a = actual[i];
    const e = expected[i];
    if (a !== e) {
      throw new Error(
        `Index ${i} is ${String(a)}, expected exactly ${String(e)} (index buffers have no metric; the tolerance is zero).`,
      );
    }
  }
}

/**
 * Asserts two bounding boxes are equal component-wise within an absolute
 * tolerance (mm) — every min/max component finite and within tolerance.
 */
export function assertBoundsClose(
  actual: RenderBounds,
  expected: RenderBounds,
  toleranceMm: number = DEFAULT_PROJECTION_LINEAR_TOLERANCE_MM,
): void {
  const axes: readonly (readonly [string, number, number])[] = [
    ["x", actual.min[0], expected.min[0]],
    ["x", actual.max[0], expected.max[0]],
    ["y", actual.min[1], expected.min[1]],
    ["y", actual.max[1], expected.max[1]],
    ["z", actual.min[2], expected.min[2]],
    ["z", actual.max[2], expected.max[2]],
  ];
  for (const [axis, actualValue, expectedValue] of axes) {
    if (
      !Number.isFinite(actualValue) ||
      !Number.isFinite(expectedValue) ||
      Math.abs(actualValue - expectedValue) > toleranceMm
    ) {
      throw new Error(
        `Bounds mismatch beyond ${toleranceMm} mm on ${axis}: expected [${expected.min.join(", ")}] – [${expected.max.join(", ")}], got [${actual.min.join(", ")}] – [${actual.max.join(", ")}].`,
      );
    }
  }
}

/** Options of {@link assertCameraClose}. */
export interface CameraComparisonOptions {
  /** Tolerance (mm) for position, target, up, and orthographic view size; default 1e-6. */
  readonly linearToleranceMm?: number;
  /** Tolerance (degrees) for the perspective fov; default 1e-6. */
  readonly fovToleranceDeg?: number;
}

function compareCameraVector(
  actual: readonly [number, number, number],
  expected: readonly [number, number, number],
  field: string,
  tolerance: number,
): void {
  const [ax, ay, az] = actual;
  const [ex, ey, ez] = expected;
  const components: readonly (readonly [string, number, number])[] = [
    ["x", ax, ex],
    ["y", ay, ey],
    ["z", az, ez],
  ];
  for (const [axis, a, e] of components) {
    if (
      !Number.isFinite(a) ||
      !Number.isFinite(e) ||
      Math.abs(a - e) > tolerance
    ) {
      throw new Error(
        `Camera ${field} component ${axis} (${a}) is not within ${tolerance} of ${e}.`,
      );
    }
  }
}

function compareCameraScalar(
  actual: number,
  expected: number,
  field: string,
  tolerance: number,
): void {
  if (
    !Number.isFinite(actual) ||
    !Number.isFinite(expected) ||
    Math.abs(actual - expected) > tolerance
  ) {
    throw new Error(
      `Camera ${field} (${actual}) is not within ${tolerance} of ${expected}.`,
    );
  }
}

/**
 * Asserts two camera specs describe the same camera within tolerance: same
 * kind, then position/target/up component-wise within the linear tolerance,
 * and fov (degrees, perspective) or view size (mm, orthographic) within
 * their tolerances. This is the deterministic-camera check for visual test
 * evidence — the camera is data, compared numerically, never implied by
 * pixels.
 */
export function assertCameraClose(
  actual: RenderCamera,
  expected: RenderCamera,
  options: CameraComparisonOptions = {},
): void {
  const {
    linearToleranceMm = DEFAULT_PROJECTION_LINEAR_TOLERANCE_MM,
    fovToleranceDeg = DEFAULT_PROJECTION_LINEAR_TOLERANCE_MM,
  } = options;
  if (actual.kind !== expected.kind) {
    throw new Error(
      `Camera kind mismatch: ${actual.kind} vs ${expected.kind}.`,
    );
  }
  compareCameraVector(
    actual.position,
    expected.position,
    "position",
    linearToleranceMm,
  );
  compareCameraVector(
    actual.target,
    expected.target,
    "target",
    linearToleranceMm,
  );
  compareCameraVector(actual.up, expected.up, "up", linearToleranceMm);
  if (actual.kind === "perspective" && expected.kind === "perspective") {
    compareCameraScalar(
      actual.fovDeg,
      expected.fovDeg,
      "fovDeg",
      fovToleranceDeg,
    );
    return;
  }
  if (actual.kind === "orthographic" && expected.kind === "orthographic") {
    compareCameraScalar(
      actual.viewWidth,
      expected.viewWidth,
      "viewWidth",
      linearToleranceMm,
    );
    compareCameraScalar(
      actual.viewHeight,
      expected.viewHeight,
      "viewHeight",
      linearToleranceMm,
    );
  }
}
