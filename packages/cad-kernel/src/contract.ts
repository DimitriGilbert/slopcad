/**
 * The kernel-independent geometry contract (Phase 8): the operations, input
 * and output types every geometry kernel backend must implement. The fake
 * kernel (`./fake-kernel`) is the reference implementation; the Phase 9
 * Manifold adapter implements the same interface, and the shared contract
 * suite (`./contract-suite`) judges any implementation.
 *
 * ## Units
 *
 * Inputs are grounded in cad-core's {@link AnyDimensionalValue} family: every
 * length input is a `LengthValue`, so the unit registry in cad-core stays the
 * single source of truth and callers may pass any length unit (`mm`, `cm`,
 * `m`, `in`). Kernels convert to canonical millimetres internally.
 *
 * Outputs are plain numbers in the registry's canonical units — bounds in
 * millimetres, volume in cubic millimetres — because outputs are kernel
 * *measurements*, already normalized; converting them to another unit is a
 * cad-core concern, and canonical numbers keep results JSON-safe and
 * directly comparable across kernels.
 *
 * ## Placement conventions (canonical mm)
 *
 * - `box`: min corner at the origin; occupies `[0,width] × [0,depth] ×
 *   [0,height]`.
 * - `sphere`: centred at the origin; `x²+y²+z² ≤ radius²`.
 * - `cylinder`: circular cross-section centred on the z axis; occupies
 *   `x²+y² ≤ radius²`, `0 ≤ z ≤ height`.
 * - `cone`: frustum on the z axis; radius `bottomRadius` at `z = 0`
 *   interpolating linearly to `topRadius` at `z = height` (`topRadius` 0 is
 *   a sharp cone).
 *
 * The origin/`z = 0` footing (rather than the spike's origin-centred
 * Manifold primitives, `centered = true`) is deliberate: a primitive's
 * bounds read straight off its inputs and placing one inside an assembly is
 * a plain `transform` offset — no `width/2` half-extent bookkeeping at every
 * call site — which keeps bounds semantics and regeneration placements
 * composable from parameters alone. `transform`'s optional rotation (Phase
 * 21.1) turns a solid about an axis through the world origin before the
 * translation applies, so placements compose rigidly: parametric offsets
 * stay translations, and orientation changes are an explicit rotation.
 *
 * ## Solid semantics
 *
 * Operations are pure functions of their inputs: the same inputs produce the
 * same measurements and tessellation on every call. A solid may be *empty*
 * (e.g. a subtraction that removes everything, or an intersection of
 * disjoint operands): `volume` of an empty solid is `0`, `tessellate`
 * returns an empty soup (zero triangles), and `bounds` fails with
 * `kernel/bounds-empty` because an empty set has no bounding box.
 *
 * Every operation reports failure as a structured {@link KernelError} —
 * never a throw, never `NaN`/`Infinity` in outputs.
 */

import type { AngleValue, LengthValue, ParseFailure, ParseResult } from "@slopcad/cad-core";
import type { KernelBackendId } from "./backend-ids";
import type { KernelCapabilities } from "./capabilities";
import type { KernelSolid } from "./opaque";
export type { KernelSolid } from "./opaque";

/** Stable failure codes produced when a kernel operation rejects input. */
export const KERNEL_ERROR_CODES = {
  /** A length input was non-positive (or a cone's top radius negative). */
  invalidLength: "kernel/invalid-length",
  /**
   * A rotation input was degenerate: a zero or non-finite axis vector, or a
   * non-finite angle. Also the structured rejection a non-rotation-capable
   * kernel may use when `transform` carries a rotation.
   */
  invalidRotation: "kernel/invalid-rotation",
  /** A boolean operand list was malformed (wrong operand count). */
  invalidOperands: "kernel/invalid-operands",
  /** A handle was not minted by this kernel instance (foreign or forged). */
  solidNotOwned: "kernel/solid-not-owned",
  /** Bounds were requested of an empty solid, which has no bounding box. */
  boundsEmpty: "kernel/bounds-empty",
} as const;

export type KernelErrorCode =
  (typeof KERNEL_ERROR_CODES)[keyof typeof KERNEL_ERROR_CODES];

/** Structured failure describing why a kernel operation rejected input. */
export interface KernelError extends ParseFailure {
  readonly code: KernelErrorCode;
}

/**
 * The result shape of every kernel operation: success carries the value,
 * failure carries a structured {@link KernelError}. Built on cad-core's
 * `ParseResult` so kernel failures compose with the rest of the stack's
 * result discipline.
 */
export type KernelResult<T> = ParseResult<T, KernelError>;

/** Input of `createBox`: the box's extents along x, y, z (all positive). */
export interface BoxInput {
  readonly width: LengthValue;
  readonly depth: LengthValue;
  readonly height: LengthValue;
}

/** Input of `createSphere`: the radius (positive). */
export interface SphereInput {
  readonly radius: LengthValue;
}

/** Input of `createCylinder`: the radius (positive) and height (positive). */
export interface CylinderInput {
  readonly radius: LengthValue;
  readonly height: LengthValue;
}

/**
 * Input of `createCone`: the frustum's radii at `z = 0` and `z = height`
 * (`bottomRadius` positive, `topRadius` non-negative — 0 is a sharp cone),
 * and the height (positive).
 */
export interface ConeInput {
  readonly bottomRadius: LengthValue;
  readonly topRadius: LengthValue;
  readonly height: LengthValue;
}

/** Input of `transform`: a translation vector (any finite lengths). */
export interface TranslationInput {
  readonly x: LengthValue;
  readonly y: LengthValue;
  readonly z: LengthValue;
}

/**
 * Input of `transform`'s optional rotation (the Phase 21.1 contract
 * extension that the `transformRotation` capability flag has gated since
 * Phase 8): a rotation about an axis through the world origin.
 *
 * Representation is axis + angle (not Euler angles) because it maps onto
 * every kernel's rigid-transform primitive directly and carries none of
 * Euler's ordering/gimbal ambiguities: `axis` is a dimensionless direction
 * in the canonical right-handed millimetre space — any non-zero finite
 * vector, normalized by the kernel, so callers never pre-normalize — and
 * `angle` is an {@link AngleValue} in any angle unit (canonical radian,
 * positive by the right-hand rule about the axis).
 */
export interface RotationInput {
  readonly axis: readonly [number, number, number];
  readonly angle: AngleValue;
}

/**
 * The full input of `transform`: a translation vector plus an optional
 * rotation. Application order is fixed by the contract: the rotation is
 * applied first, about the world-origin axis, and the translation second,
 * in world space — so the two never interact and each is independently
 * observable in the result's bounds. Rotation is meaningful only for
 * kernels that declare `transformRotation: true`; a kernel that has not
 * declared it must never silently mis-apply a rotation — it rejects the
 * input with `kernel/invalid-rotation` or ignores the field outright
 * (the suite judges rotation only where the flag is set).
 */
export interface TransformInput extends TranslationInput {
  readonly rotation?: RotationInput;
}

/**
 * An axis-aligned bounding box in canonical millimetres. Tight for
 * primitives, and for boolean results a *container* whose tightness is
 * declared by the kernel's `tightBooleanBounds` capability.
 */
export interface KernelBounds {
  readonly min: readonly [number, number, number];
  readonly max: readonly [number, number, number];
}

/**
 * An indexed triangle soup in canonical millimetres: `positions` is a flat
 * xyz vertex array and `indices` a flat triangle-vertex-index array. The
 * contract guarantees: lengths divisible by 3, indices within vertex range,
 * finite coordinates, deterministic output for the same solid, and zero
 * triangles exactly for empty solids. It does NOT promise a specific
 * triangulation — correctness criteria are semantic (bounds, volume,
 * validity), never exact buffer equality.
 *
 * `normals` carries optional kernel-computed vertex normals (Phase 9
 * extension): a flat xyz unit-vector array, one normal per position triple,
 * paired index-for-index with `positions`. Kernels that can compute normals
 * honestly provide them — the Manifold adapter emits crease-aware normals
 * (edges sharper than a documented threshold get split normals, so planar
 * faces keep one exact normal and curved surfaces shade smooth); the fake
 * kernel emits the exact per-facet normals of its canonical meshes. Kernels
 * that cannot compute normals omit the field entirely — consumers must
 * treat `undefined` as "compute your own" and never synthesize kernel
 * normals elsewhere. When present, normals are finite, unit length, exactly
 * as long as `positions`, and deterministic with the rest of the soup.
 * Empty solids omit `normals` along with their (empty) positions.
 */
export interface Tessellation {
  readonly positions: readonly number[];
  readonly indices: readonly number[];
  readonly normals?: readonly number[];
}

/** The number of triangles in a tessellation (`indices.length / 3`). */
export function tessellationTriangleCount(tessellation: Tessellation): number {
  return tessellation.indices.length / 3;
}

/**
 * A geometry kernel backend. Handles are owned by the instance that created
 * them; passing a handle to any other instance fails with
 * `kernel/solid-not-owned`. `dispose` releases kernel-side resources for
 * kernels that need explicit cleanup (WASM-backed kernels); for
 * garbage-collected kernels it is a no-op that keeps the contract uniform.
 */
export interface GeometryKernel {
  /** The backend this kernel implements (e.g. `"fake"`, `"manifold"`). */
  readonly id: KernelBackendId;
  /** What this kernel can actually promise; see {@link KernelCapabilities}. */
  readonly capabilities: KernelCapabilities;

  /** Creates an axis-aligned box from the min corner at the origin. */
  createBox(input: BoxInput): KernelResult<KernelSolid>;
  /** Creates a sphere centred at the origin. */
  createSphere(input: SphereInput): KernelResult<KernelSolid>;
  /** Creates a cylinder on the +z axis from `z = 0` to `z = height`. */
  createCylinder(input: CylinderInput): KernelResult<KernelSolid>;
  /** Creates a cone/frustum on the +z axis from `z = 0` to `z = height`. */
  createCone(input: ConeInput): KernelResult<KernelSolid>;

  /** Unions two or more solids. */
  union(operands: readonly KernelSolid[]): KernelResult<KernelSolid>;
  /** Subtracts the tools (at least one) from the target solid. */
  subtract(
    target: KernelSolid,
    tools: readonly KernelSolid[],
  ): KernelResult<KernelSolid>;
  /** Intersects two or more solids; disjoint operands produce an empty solid. */
  intersect(operands: readonly KernelSolid[]): KernelResult<KernelSolid>;

  /**
   * Places a solid: rotates it first (about the world-origin axis of the
   * optional `rotation`, right-handed) and translates it second, in world
   * space. Rotation requires the `transformRotation` capability (Phase 8
   * transform, Phase 21.1 extension).
   */
  transform(
    solid: KernelSolid,
    input: TransformInput,
  ): KernelResult<KernelSolid>;

  /**
   * The solid's axis-aligned bounding box in mm; fails with
   * `kernel/bounds-empty` for an empty solid.
   */
  bounds(solid: KernelSolid): KernelResult<KernelBounds>;
  /** The solid's volume in mm³ (0 for an empty solid). */
  volume(solid: KernelSolid): KernelResult<number>;
  /**
   * A deterministic, valid, indexed triangle soup of the solid (empty for
   * an empty solid). Not promised to be the exact boundary of boolean
   * results — kernels without exact boolean surfaces emit a deterministic
   * candidate soup; semantic truth lives in `volume`/`bounds`.
   */
  tessellate(solid: KernelSolid): KernelResult<Tessellation>;

  /** Releases the handle's kernel-side resources; never fails. */
  dispose(solid: KernelSolid): void;
}
