/**
 * Spatial (6D) algebra for the mechanism-dynamics reference kernel
 * (Phase 67a, law S2): Featherstone's spatial vectors, spatial forces,
 * and spatial inertias in WORLD-ALIGNED coordinates — the formulation
 * this package fully owns (the Phase 67 ruling: "implement the
 * algorithm you can fully own and pin; document the choice").
 *
 * ## The convention (one, stated once)
 *
 * - A {@link Vec3} is a world (or local — named at each use) 3-vector;
 *   a {@link Mat3} is a ROW-MAJOR 3×3 applied as `M·v`.
 * - A {@link SpatialMotion} is `[angular; linear]` at a frame origin;
 *   a {@link SpatialForce} is `[moment; force]` at the same origin —
 *   the angular/moment-first order of *Rigid Body Dynamics Algorithms*.
 * - Origin shifts are explicit point pairs, never hidden transforms:
 *   the velocity of the body-fixed point at `to` is
 *   `v.lin + v.ang × (to − from)` ({@link shiftMotionTo}); the moment
 *   about `to` of a wrench stated at `from` is `mom + frc × (to − from)`
 *   ({@link shiftForceTo}).
 * - A {@link SpatialInertia} is the `(m, h = m·c, I₀)` form about a
 *   frame origin (c the centre of gravity in that frame, I₀ the
 *   inertia tensor about the ORIGIN — the parallel-axis terms folded
 *   in), because this form is CLOSED under the composite-rigid-body
 *   sum ({@link addSpatialInertia}: masses, first moments, and origin
 *   tensors add componentwise once expressed about the same origin).
 *
 * Determinism: pure fixed-order double arithmetic, no randomness, no
 * clock — identical inputs produce bitwise-identical outputs (the
 * package-wide S2 claim, pinned by the determinism suite).
 */

/** A 3-vector; the frame is named at each use site. */
export type Vec3 = readonly [number, number, number];

/** A row-major 3×3 matrix, applied as `M·v`. */
export type Mat3 = readonly [
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

/** Vector sum. */
export function add3(a: Vec3, b: Vec3): Vec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

/** Vector difference. */
export function sub3(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

/** Vector negation. */
export function neg3(a: Vec3): Vec3 {
  return [-a[0], -a[1], -a[2]];
}

/** Scalar multiplication. */
export function scale3(a: Vec3, s: number): Vec3 {
  return [a[0] * s, a[1] * s, a[2] * s];
}

/** Dot product. */
export function dot3(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

/** Cross product a × b. */
export function cross3(a: Vec3, b: Vec3): Vec3 {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

/** Euclidean norm. */
export function norm3(a: Vec3): number {
  return Math.sqrt(a[0] * a[0] + a[1] * a[1] + a[2] * a[2]);
}

/** The 3×3 identity. */
export const IDENTITY_MAT3: Mat3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];

/** Matrix product A·B (row-major). */
export function mulMat3(a: Mat3, b: Mat3): Mat3 {
  const a00 = a[0];
  const a01 = a[1];
  const a02 = a[2];
  const a10 = a[3];
  const a11 = a[4];
  const a12 = a[5];
  const a20 = a[6];
  const a21 = a[7];
  const a22 = a[8];
  const b00 = b[0];
  const b01 = b[1];
  const b02 = b[2];
  const b10 = b[3];
  const b11 = b[4];
  const b12 = b[5];
  const b20 = b[6];
  const b21 = b[7];
  const b22 = b[8];
  return [
    a00 * b00 + a01 * b10 + a02 * b20,
    a00 * b01 + a01 * b11 + a02 * b21,
    a00 * b02 + a01 * b12 + a02 * b22,
    a10 * b00 + a11 * b10 + a12 * b20,
    a10 * b01 + a11 * b11 + a12 * b21,
    a10 * b02 + a11 * b12 + a12 * b22,
    a20 * b00 + a21 * b10 + a22 * b20,
    a20 * b01 + a21 * b11 + a22 * b21,
    a20 * b02 + a21 * b12 + a22 * b22,
  ];
}

/** Matrix–vector product M·v. */
export function mulMat3Vec(m: Mat3, v: Vec3): Vec3 {
  return [
    m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
    m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
    m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
  ];
}

/** Matrix transpose. */
export function transposeMat3(m: Mat3): Mat3 {
  return [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]];
}

/** Matrix sum. */
export function addMat3(a: Mat3, b: Mat3): Mat3 {
  return [
    a[0] + b[0],
    a[1] + b[1],
    a[2] + b[2],
    a[3] + b[3],
    a[4] + b[4],
    a[5] + b[5],
    a[6] + b[6],
    a[7] + b[7],
    a[8] + b[8],
  ];
}

/** Matrix scaled by a constant. */
export function scaleMat3(m: Mat3, s: number): Mat3 {
  return [
    m[0] * s,
    m[1] * s,
    m[2] * s,
    m[3] * s,
    m[4] * s,
    m[5] * s,
    m[6] * s,
    m[7] * s,
    m[8] * s,
  ];
}

/** Rodrigues rotation about a UNIT axis by an angle in radians. */
export function rotationAboutUnitAxis(axis: Vec3, angle: number): Mat3 {
  const [x, y, z] = axis;
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const t = 1 - c;
  return [
    t * x * x + c,
    t * x * y - s * z,
    t * x * z + s * y,
    t * x * y + s * z,
    t * y * y + c,
    t * y * z - s * x,
    t * x * z - s * y,
    t * y * z + s * x,
    t * z * z + c,
  ];
}

/** The skew (cross-product) matrix of a vector: `skew(a)·v = a × v`. */
export function skewMat3(a: Vec3): Mat3 {
  return [0, -a[2], a[1], a[2], 0, -a[0], -a[1], a[0], 0];
}

/**
 * The exponential map exp([v]×): the rotation matrix of the rotation
 * vector `v` (axis `v/|v|`, angle `|v|`). The small-angle branch keeps
 * the first two series terms — the exact restatement of the mate
 * solver's `rotationVectorToMatrix` (pinned bitwise against it by the
 * cross-compat suite; identical inputs, identical arithmetic order).
 */
export function expRotation(v: Vec3): Mat3 {
  const theta = Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
  const k = skewMat3(v);
  if (theta < 1e-8) {
    const s = 1 - (theta * theta) / 6;
    const c = 0.5 - (theta * theta) / 24;
    return [
      1 + s * k[0] + c * (k[0] * k[0] + k[1] * k[3] + k[2] * k[6]),
      s * k[1] + c * (k[0] * k[1] + k[1] * k[4] + k[2] * k[7]),
      s * k[2] + c * (k[0] * k[2] + k[1] * k[5] + k[2] * k[8]),
      s * k[3] + c * (k[3] * k[0] + k[4] * k[3] + k[5] * k[6]),
      1 + s * k[4] + c * (k[3] * k[1] + k[4] * k[4] + k[5] * k[7]),
      s * k[5] + c * (k[3] * k[2] + k[4] * k[5] + k[5] * k[8]),
      s * k[6] + c * (k[6] * k[0] + k[7] * k[3] + k[8] * k[6]),
      s * k[7] + c * (k[6] * k[1] + k[7] * k[4] + k[8] * k[7]),
      1 + s * k[8] + c * (k[6] * k[2] + k[7] * k[5] + k[8] * k[8]),
    ];
  }
  const s = Math.sin(theta) / theta;
  const c = (1 - Math.cos(theta)) / (theta * theta);
  return [
    1 + s * k[0] + c * (k[0] * k[0] + k[1] * k[3] + k[2] * k[6]),
    s * k[1] + c * (k[0] * k[1] + k[1] * k[4] + k[2] * k[7]),
    s * k[2] + c * (k[0] * k[2] + k[1] * k[5] + k[2] * k[8]),
    s * k[3] + c * (k[3] * k[0] + k[4] * k[3] + k[5] * k[6]),
    1 + s * k[4] + c * (k[3] * k[1] + k[4] * k[4] + k[5] * k[7]),
    s * k[5] + c * (k[3] * k[2] + k[4] * k[5] + k[5] * k[8]),
    s * k[6] + c * (k[6] * k[0] + k[7] * k[3] + k[8] * k[6]),
    s * k[7] + c * (k[6] * k[1] + k[7] * k[4] + k[8] * k[7]),
    1 + s * k[8] + c * (k[6] * k[2] + k[7] * k[5] + k[8] * k[8]),
  ];
}

/**
 * Wraps a rotation vector into the |v| ≤ π branch of the exponential
 * map (Exp is 2π-periodic along its own direction): `v′ = v·(1 − 2π/|v|)`
 * when |v| > π — the same rotation exactly, kept away from the map's
 * argument-growth precision loss. Deterministic, applied post-step.
 */
export function wrapRotationVector(v: Vec3): Vec3 {
  const theta = norm3(v);
  if (theta <= Math.PI) return v;
  const scale = 1 - (2 * Math.PI) / theta;
  return [v[0] * scale, v[1] * scale, v[2] * scale];
}

/** A rigid transform: `world = R·local + t` (R row-major, applied to locals). */
export interface SpatialTransform {
  readonly r: Mat3;
  readonly t: Vec3;
}

/** Composes two transforms: `(a ∘ b)(x) = a(b(x))` — b first. */
export function composeTransforms(
  a: SpatialTransform,
  b: SpatialTransform,
): SpatialTransform {
  return { r: mulMat3(a.r, b.r), t: add3(mulMat3Vec(a.r, b.t), a.t) };
}

/** The identity transform. */
export const IDENTITY_TRANSFORM: SpatialTransform = {
  r: IDENTITY_MAT3,
  t: [0, 0, 0],
};

/** A pure-translation transform by `t`. */
export function translationTransform(t: Vec3): SpatialTransform {
  return { r: IDENTITY_MAT3, t };
}

/** A spatial motion vector `[angular; linear]` at a stated origin. */
export interface SpatialMotion {
  readonly ang: Vec3;
  readonly lin: Vec3;
}

/** A spatial force vector `[moment; force]` at a stated origin. */
export interface SpatialForce {
  readonly mom: Vec3;
  readonly frc: Vec3;
}

/** Motion cross product a ×̂ b: `[a.ang × b.ang; a.ang × b.lin]`. */
export function motionCross(a: SpatialMotion, b: SpatialMotion): SpatialMotion {
  return { ang: cross3(a.ang, b.ang), lin: cross3(a.ang, b.lin) };
}

/** Force cross product a ×̂* f: `[a.ang × f.mom; a.ang × f.frc]`. */
export function forceCross(a: SpatialMotion, f: SpatialForce): SpatialForce {
  return { mom: cross3(a.ang, f.mom), frc: cross3(a.ang, f.frc) };
}

/**
 * Shifts a motion vector's origin from world point `from` to `to`: the
 * linear part becomes the velocity of the body-fixed point at `to`.
 */
export function shiftMotionTo(
  v: SpatialMotion,
  from: Vec3,
  to: Vec3,
): SpatialMotion {
  return { ang: v.ang, lin: add3(v.lin, cross3(v.ang, sub3(to, from))) };
}

/**
 * Shifts a wrench's origin from world point `from` to `to`: the moment
 * becomes the moment about `to` (`mom + frc × (to − from)`).
 */
export function shiftForceTo(
  f: SpatialForce,
  from: Vec3,
  to: Vec3,
): SpatialForce {
  return { mom: add3(f.mom, cross3(f.frc, sub3(to, from))), frc: f.frc };
}

/**
 * Spatial inertia in the `(m, h, I₀)` form about a frame origin: mass,
 * first moment `h = m·c` (c the COG in the frame), and the inertia
 * tensor I₀ ABOUT THE ORIGIN (parallel-axis terms folded). This form is
 * closed under addition (the composite-rigid-body sum) and under the
 * world-frame product {@link mulSpatialInertia}.
 */
export interface SpatialInertia {
  /** Mass, kg (> 0 for a real body). */
  readonly m: number;
  /** First moment m·c, kg·m (c the COG in this frame). */
  readonly h: Vec3;
  /** Inertia tensor about the ORIGIN, kg·m² (I_c + m·K(c) below). */
  readonly i0: Mat3;
}

/** The parallel-axis kernel K(c) = |c|²E − c·cᵀ (symmetric, PSD). */
function parallelAxisKernel(c: Vec3): Mat3 {
  const cc = c[0] * c[0] + c[1] * c[1] + c[2] * c[2];
  return [
    cc - c[0] * c[0],
    -c[0] * c[1],
    -c[0] * c[2],
    -c[1] * c[0],
    cc - c[1] * c[1],
    -c[1] * c[2],
    -c[2] * c[0],
    -c[2] * c[1],
    cc - c[2] * c[2],
  ];
}

/**
 * Builds the spatial inertia of a body from its mass, its COG `c` in
 * the frame, and its inertia tensor `ic` ABOUT THE COG:
 * `I₀ = ic + m·K(c)` (the parallel-axis theorem for skew axes).
 */
export function spatialInertiaAboutOrigin(
  m: number,
  c: Vec3,
  ic: Mat3,
): SpatialInertia {
  return {
    m,
    h: scale3(c, m),
    i0: addMat3(ic, scaleMat3(parallelAxisKernel(c), m)),
  };
}

/** The composite-rigid-body sum (both inertias about the SAME origin). */
export function addSpatialInertia(
  a: SpatialInertia,
  b: SpatialInertia,
): SpatialInertia {
  return {
    m: a.m + b.m,
    h: add3(a.h, b.h),
    i0: addMat3(a.i0, b.i0),
  };
}

/** Rotates an inertia's coordinates by `R` (local frame → world frame). */
export function rotateSpatialInertia(
  I: SpatialInertia,
  r: Mat3,
): SpatialInertia {
  return {
    m: I.m,
    h: mulMat3Vec(r, I.h),
    i0: mulMat3(r, mulMat3(I.i0, transposeMat3(r))),
  };
}

/**
 * Shifts an inertia's origin BY the world vector `t` (the new origin
 * sits at old + t): `c′ = c − t`, `I₀′ = I₀ + m·(K(c′) − K(c))`.
 */
export function shiftSpatialInertia(
  I: SpatialInertia,
  t: Vec3,
): SpatialInertia {
  const cOld = scale3(I.h, 1 / I.m);
  const cNew = sub3(cOld, t);
  return {
    m: I.m,
    h: scale3(cNew, I.m),
    i0: addMat3(
      I.i0,
      scaleMat3(
        addMat3(
          parallelAxisKernel(cNew),
          scaleMat3(parallelAxisKernel(cOld), -1),
        ),
        I.m,
      ),
    ),
  };
}

/**
 * The spatial inertia product: the spatial force that answers a spatial
 * motion, about the same origin — `moment = I₀·ω + h × v` and
 * `force = m·v + ω × h` (the kinetic-energy dual of `[ω; v]`).
 */
export function mulSpatialInertia(
  I: SpatialInertia,
  v: SpatialMotion,
): SpatialForce {
  return {
    mom: add3(mulMat3Vec(I.i0, v.ang), cross3(I.h, v.lin)),
    frc: add3(scale3(v.lin, I.m), cross3(v.ang, I.h)),
  };
}

/** A + B on spatial forces (same origin). */
export function addSpatialForce(
  a: SpatialForce,
  b: SpatialForce,
): SpatialForce {
  return { mom: add3(a.mom, b.mom), frc: add3(a.frc, b.frc) };
}

/** A + B on spatial motions (same origin). */
export function addSpatialMotion(
  a: SpatialMotion,
  b: SpatialMotion,
): SpatialMotion {
  return { ang: add3(a.ang, b.ang), lin: add3(a.lin, b.lin) };
}
