/**
 * Placement transforms (Phase 50): the rigid-transform algebra assembly
 * placements compose with — a rotation (row-major 3×3, orthonormal,
 * determinant +1) plus a translation, in canonical millimetres.
 *
 * ## Determinism is the contract
 *
 * Composition is plain fixed-order arithmetic: no re-orthonormalization,
 * no quaternion detours, no tolerance folding. Two identical placement
 * paths produce bitwise-identical transforms in every kernel and process
 * — the property Phase 51's solver fixtures and Phase 52's animation scrub
 * both stand on. Inputs are validated orthonormal at the boundary (the
 * datum resolver emits Gram-Schmidt frames), and composition of rotations
 * is exactly closed, so nothing inside ever needs to "fix up" a matrix.
 *
 * ## Composition order is the instance path order — outermost first
 *
 * {@link composePlacementTransforms first ∘ second} means "apply `second`
 * to the geometry, then `first`". {@link composePlacementPath} folds a
 * whole occurrence path — `[root, …, leaf]` — as
 * `world = M(path[0]) ∘ M(path[1]) ∘ …`, the FIXED order the assembly ADR
 * pins: the order is a property of the path, never of traversal state.
 */

import { type DatumVec3 } from "./datum";
import { type ParseFailure, type ParseResult, fail, ok } from "./result";

/**
 * A rotation as a ROW-MAJOR 3×3 matrix: `m[row * 3 + column]`. Columns are
 * the placed frame's axes expressed in the parent frame; rows multiply
 * column vectors (`world = m · local + translation`).
 */
export type PlacementRotation = readonly [
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
];

/** A rigid placement transform: rotation plus translation (mm). */
export interface PlacementTransform {
  readonly rotation: PlacementRotation;
  readonly translation: DatumVec3;
}

/** How far a placement rotation may deviate from orthonormal, det +1. */
export const PLACEMENT_ORTHONORMAL_TOLERANCE = 1e-6;

/** The identity transform: geometry passes through unmoved. */
export const IDENTITY_PLACEMENT_TRANSFORM: PlacementTransform = {
  rotation: [1, 0, 0, 0, 1, 0, 0, 0, 1],
  translation: [0, 0, 0],
};

/**
 * Composes two transforms: the result applies `second` first, then
 * `first` (`result(x) = first(second(x))`) — the matrix product
 * `first.rotation · second.rotation` and the matching translation.
 */
export function composePlacementTransforms(
  first: PlacementTransform,
  second: PlacementTransform,
): PlacementTransform {
  const [a0, a1, a2, a3, a4, a5, a6, a7, a8] = first.rotation;
  const [b0, b1, b2, b3, b4, b5, b6, b7, b8] = second.rotation;
  return {
    rotation: [
      a0 * b0 + a1 * b3 + a2 * b6,
      a0 * b1 + a1 * b4 + a2 * b7,
      a0 * b2 + a1 * b5 + a2 * b8,
      a3 * b0 + a4 * b3 + a5 * b6,
      a3 * b1 + a4 * b4 + a5 * b7,
      a3 * b2 + a4 * b5 + a5 * b8,
      a6 * b0 + a7 * b3 + a8 * b6,
      a6 * b1 + a7 * b4 + a8 * b7,
      a6 * b2 + a7 * b5 + a8 * b8,
    ],
    translation: [
      a0 * second.translation[0] +
        a1 * second.translation[1] +
        a2 * second.translation[2] +
        first.translation[0],
      a3 * second.translation[0] +
        a4 * second.translation[1] +
        a5 * second.translation[2] +
        first.translation[1],
      a6 * second.translation[0] +
        a7 * second.translation[1] +
        a8 * second.translation[2] +
        first.translation[2],
    ],
  };
}

/**
 * Folds an occurrence path's transforms — ordered OUTERMOST FIRST, the
 * path order the assembly ADR pins — into the one world transform:
 * `world = M(path[0]) ∘ M(path[1]) ∘ …`. The empty path is the identity
 * (geometry of the root document itself).
 */
export function composePlacementPath(
  transforms: readonly PlacementTransform[],
): PlacementTransform {
  let composed = IDENTITY_PLACEMENT_TRANSFORM;
  for (const transform of transforms) {
    composed = composePlacementTransforms(composed, transform);
  }
  return composed;
}

/** Applies the transform to a point (rotation, then translation). */
export function transformPlacementPoint(
  transform: PlacementTransform,
  point: DatumVec3,
): DatumVec3 {
  const [x, y, z] = point;
  const m = transform.rotation;
  const t = transform.translation;
  return [
    m[0] * x + m[1] * y + m[2] * z + t[0],
    m[3] * x + m[4] * y + m[5] * z + t[1],
    m[6] * x + m[7] * y + m[8] * z + t[2],
  ];
}

/**
 * Applies the transform's ROTATION to a direction (no translation — a
 * direction has no position). Rigid transforms keep directions unit.
 */
export function transformPlacementDirection(
  transform: PlacementTransform,
  direction: DatumVec3,
): DatumVec3 {
  const [x, y, z] = direction;
  const m = transform.rotation;
  return [
    m[0] * x + m[1] * y + m[2] * z,
    m[3] * x + m[4] * y + m[5] * z,
    m[6] * x + m[7] * y + m[8] * z,
  ];
}

/**
 * The world-space AABB of a local AABB under a rigid transform — exact,
 * not iterated: rotating the box's EIGHT CORNERS and re-reducing gives the
 * tight bounds of the rotated box (a rotation maps the box to a parallelepiped
 * whose axis-aligned extent is attained at the transformed corners).
 */
export function placementTransformBounds(
  transform: PlacementTransform,
  min: DatumVec3,
  max: DatumVec3,
): { readonly min: DatumVec3; readonly max: DatumVec3 } {
  let outMinX = Number.POSITIVE_INFINITY;
  let outMinY = Number.POSITIVE_INFINITY;
  let outMinZ = Number.POSITIVE_INFINITY;
  let outMaxX = Number.NEGATIVE_INFINITY;
  let outMaxY = Number.NEGATIVE_INFINITY;
  let outMaxZ = Number.NEGATIVE_INFINITY;
  for (const x of [min[0], max[0]]) {
    for (const y of [min[1], max[1]]) {
      for (const z of [min[2], max[2]]) {
        const [wx, wy, wz] = transformPlacementPoint(transform, [x, y, z]);
        outMinX = Math.min(outMinX, wx);
        outMinY = Math.min(outMinY, wy);
        outMinZ = Math.min(outMinZ, wz);
        outMaxX = Math.max(outMaxX, wx);
        outMaxY = Math.max(outMaxY, wy);
        outMaxZ = Math.max(outMaxZ, wz);
      }
    }
  }
  return { min: [outMinX, outMinY, outMinZ], max: [outMaxX, outMaxY, outMaxZ] };
}

/**
 * Builds the transform that maps the UNIT frame into a resolved datum
 * frame: the rotation's columns are the frame's axes (x, y, z) and the
 * translation is its origin. A `cSys` datum resolves to exactly this
 * shape; a plane resolves through its (origin, normal, xAxis) frame.
 */
export function placementTransformFromFrame(frame: {
  readonly origin: DatumVec3;
  readonly xAxis: DatumVec3;
  readonly yAxis: DatumVec3;
  readonly zAxis: DatumVec3;
}): PlacementTransform {
  const [xx, xy, xz] = frame.xAxis;
  const [yx, yy, yz] = frame.yAxis;
  const [zx, zy, zz] = frame.zAxis;
  // Columns are the axes: row-major entries m[r*3+c] = axis_c[r].
  return {
    rotation: [xx, yx, zx, xy, yy, zy, xz, yz, zz],
    translation: [...frame.origin],
  };
}

/**
 * The rigid transform of a rotation by `angleRad` (right-hand rule) about
 * the axis line through `origin` along the UNIT `direction` — the pure
 * algebra the circular component pattern, the mirror placement, and the
 * motion joints share (one source; the callers resolve unit-ness). Pure
 * arithmetic (Rodrigues' formula folded into the 3x3), bitwise-deterministic
 * for identical inputs.
 */
export function axisRotationTransform(
  origin: DatumVec3,
  direction: DatumVec3,
  angleRad: number,
): PlacementTransform {
  const [ux, uy, uz] = direction;
  const c = Math.cos(angleRad);
  const s = Math.sin(angleRad);
  const t = 1 - c;
  // R = I·c + (u×)·s + uuᵀ·t, row-major.
  const rotation: PlacementRotation = [
    c + ux * ux * t,
    ux * uy * t - uz * s,
    ux * uz * t + uy * s,
    uy * ux * t + uz * s,
    c + uy * uy * t,
    uy * uz * t - ux * s,
    uz * ux * t - uy * s,
    uz * uy * t + ux * s,
    c + uz * uz * t,
  ];
  const aboutOrigin: PlacementTransform = { rotation, translation: [0, 0, 0] };
  const toOrigin: PlacementTransform = {
    rotation: [1, 0, 0, 0, 1, 0, 0, 0, 1],
    translation: [-origin[0], -origin[1], -origin[2]],
  };
  const fromOrigin: PlacementTransform = {
    rotation: [1, 0, 0, 0, 1, 0, 0, 0, 1],
    translation: [origin[0], origin[1], origin[2]],
  };
  // T(origin) ∘ R ∘ T(−origin) — rotate about the LINE, not the origin point.
  return composePlacementTransforms(
    fromOrigin,
    composePlacementTransforms(aboutOrigin, toOrigin),
  );
}

/**
 * Validates untrusted input as a placement transform (the projection and
 * native-parse boundaries): nine finite rotation entries whose columns are
 * unit and whose determinant is +1 within {@link PLACEMENT_ORTHONORMAL_TOLERANCE},
 * and a finite translation triple. `null`/`undefined` is NOT the identity —
 * callers decide optionality; this validates a transform that is present.
 */
export function parsePlacementTransform(
  input: unknown,
): ParseResult<PlacementTransform, ParseFailure> {
  const malformed = (
    detail: unknown,
  ): ParseResult<PlacementTransform, ParseFailure> =>
    fail({
      code: "placement/malformed",
      message:
        "A placement transform must carry a row-major 3x3 orthonormal rotation (det +1) and a finite translation triple.",
      input: detail,
    });
  if (
    typeof input !== "object" ||
    input === null ||
    !("rotation" in input) ||
    !("translation" in input)
  ) {
    return malformed(input);
  }
  const record = input as { rotation?: unknown; translation?: unknown };
  const { rotation, translation } = record;
  if (!Array.isArray(rotation) || rotation.length !== 9) {
    return malformed(input);
  }
  // The cast keeps the entries `unknown` (never the `any` Array.isArray
  // narrows to), so each component narrows through its own check below.
  const entries = rotation as readonly unknown[];
  if (
    entries.some(
      (entry) => typeof entry !== "number" || !Number.isFinite(entry),
    )
  ) {
    return malformed(input);
  }
  if (!Array.isArray(translation) || translation.length !== 3) {
    return malformed(input);
  }
  const tEntries = translation as readonly unknown[];
  if (
    tEntries.some(
      (entry) => typeof entry !== "number" || !Number.isFinite(entry),
    )
  ) {
    return malformed(input);
  }
  // `entries` is now nine validated finite numbers; the tuple view lets the
  // matrix math below index without undefined-narrowing noise.
  const [m0, m1, m2, m3, m4, m5, m6, m7, m8] = entries as [
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  const columnUnit = (a: number, b: number, c: number): boolean =>
    Math.abs(Math.hypot(a, b, c) - 1) <= PLACEMENT_ORTHONORMAL_TOLERANCE;
  if (
    !columnUnit(m0, m3, m6) ||
    !columnUnit(m1, m4, m7) ||
    !columnUnit(m2, m5, m8)
  ) {
    return malformed(input);
  }
  const det =
    m0 * (m4 * m8 - m5 * m7) -
    m1 * (m3 * m8 - m5 * m6) +
    m2 * (m3 * m7 - m4 * m6);
  if (Math.abs(det - 1) > PLACEMENT_ORTHONORMAL_TOLERANCE) {
    return malformed(input);
  }
  const [tx, ty, tz] = tEntries as [number, number, number];
  return ok({
    rotation: [m0, m1, m2, m3, m4, m5, m6, m7, m8],
    translation: [tx, ty, tz],
  });
}
