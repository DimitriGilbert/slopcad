/**
 * The joint model the dynamics kernel owns (Phase 67a): every
 * `JOINT_KINDS` member of the document's joint vocabulary plus the
 * kernel-internal `free` root joint, each reduced to a DOF LAYOUT —
 * which rotational axes and which translational directions the kind
 * grants, in a pinned generalized-coordinate order — and the FREE
 * TRANSFORM the granted motion produces.
 *
 * ## The chain convention (mates.ts, restated)
 *
 * A joint connects a base (parent) occurrence and a mobilized (child)
 * occurrence. In the base's local coordinates the joint frame is the
 * origin `o` (metres) and — for axis-bearing kinds — the unit axis `a`;
 * the joint's frame shares the base's orientation (the translation-only
 * conjugation of `jointMotionTransform`). The child's placement
 * composes as
 *
 *   W_child = W_base ∘ T(o) ∘ Free(q) ∘ B
 *
 * with `B` the child's placement relative to the joint frame at the
 * ZERO station (derived from the initial placements: `B = T(−o) ∘
 * W_child(0)` in base-local coordinates) and `Free(q)` the kind's
 * granted motion: rotation about / translation along the granted
 * directions. `rigid` grants nothing; the kernel's `free` root joint
 * sits at the WORLD origin with `B = W_root(0)` and grants every DOF.
 *
 * ## The pinned DOF order and velocity meaning
 *
 * Rotational DOFs first, translational DOFs second, each in the layout
 * tables below. A rotational DOF's generalized velocity is the relative
 * angular velocity along its axis expressed in the JOINT INPUT frame
 * (the base's coordinates — the "pre-rotation" convention); a ball or
 * free joint's 3-vector rotation state `φ` integrates as `φ ← φ + φ̇·dt`
 * with the orientation recomputed exactly as `exp([φ]×)` — the
 * first-order Lie–Euler scheme (exact for fixed-axis rotation, where
 * the exponential map commutes with itself; O(dt) consistent
 * otherwise), documented as the reference kernel's stated integration.
 */

import {
  cross3,
  expRotation,
  type Mat3,
  rotationAboutUnitAxis,
  type Vec3,
} from "./spatial";

/** The joint kinds the kernel understands: the document vocabulary + the free root. */
export type DynamicsJointKind =
  "rigid" | "revolute" | "slider" | "cylindrical" | "planar" | "ball" | "free";

/**
 * The document joint vocabulary this package restates (cross-compat
 * pinned against `@slopcad/cad-core`'s `JOINT_KINDS`: same members,
 * same order); `free` is kernel-internal and never crosses the wire.
 */
export const DYNAMICS_JOINT_KINDS: readonly DynamicsJointKind[] = [
  "rigid",
  "revolute",
  "slider",
  "cylindrical",
  "planar",
  "ball",
  "free",
];

/** Which physical flavour a generalized DOF's friction fields consume. */
export type DofFlavor = "rotational" | "translational";

/**
 * One joint kind's DOF layout: the unit rotational axes and unit
 * translational directions granted, in the pinned generalized order
 * (rotationals first), all stated in the JOINT INPUT frame's
 * coordinates (the base's for tree joints, the world's for `free`).
 */
export interface JointDofLayout {
  readonly kind: DynamicsJointKind;
  readonly rotational: readonly Vec3[];
  readonly translational: readonly Vec3[];
}

const EX: Vec3 = [1, 0, 0];
const EY: Vec3 = [0, 1, 0];
const EZ: Vec3 = [0, 0, 1];

/**
 * The DOF layout of a joint: `axis` is the unit joint axis (used by the
 * axis-bearing kinds; ignored by `rigid`/`ball`/`free`), `planeFirst`/
 * `planeSecond` the deterministic in-plane basis of a planar joint's
 * normal (the mate solver's auxiliary basis, restated: ⊥ the axis,
 * fixed formula, same output order).
 */
export function jointDofLayout(
  kind: DynamicsJointKind,
  axis: Vec3,
  planeFirst: Vec3,
  planeSecond: Vec3,
): JointDofLayout {
  switch (kind) {
    case "rigid":
      return { kind, rotational: [], translational: [] };
    case "revolute":
      return { kind, rotational: [axis], translational: [] };
    case "slider":
      return { kind, rotational: [], translational: [axis] };
    case "cylindrical":
      return { kind, rotational: [axis], translational: [axis] };
    case "planar":
      return {
        kind,
        rotational: [axis],
        translational: [planeFirst, planeSecond],
      };
    case "ball":
      return { kind, rotational: [EX, EY, EZ], translational: [] };
    case "free":
      return {
        kind,
        rotational: [EX, EY, EZ],
        translational: [EX, EY, EZ],
      };
  }
}

/** The DOF count of a layout (rotational first, translational second). */
export function jointDofCount(layout: JointDofLayout): number {
  return layout.rotational.length + layout.translational.length;
}

/** The flavour of each DOF in the pinned order. */
export function jointDofFlavors(layout: JointDofLayout): readonly DofFlavor[] {
  return [
    ...layout.rotational.map(() => "rotational" as const),
    ...layout.translational.map(() => "translational" as const),
  ];
}

/**
 * The free rotation matrix of a joint at station `q`: `exp([φ]×)` for
 * the 3-rotational kinds, a single-axis Rodrigues otherwise, identity
 * when the kind grants no rotation.
 */
export function jointFreeRotation(
  layout: JointDofLayout,
  q: readonly number[],
): Mat3 {
  if (layout.rotational.length === 0) {
    return jointIdentityRotation;
  }
  if (layout.rotational.length === 1) {
    const axis = layout.rotational[0] ?? EZ;
    const angle = q[0] ?? 0;
    return rotationAboutUnitAxis(axis, angle);
  }
  return expRotation([q[0] ?? 0, q[1] ?? 0, q[2] ?? 0]);
}

const jointIdentityRotation: Mat3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];

/**
 * The free translation of a joint at station `q` — the sum of the
 * translational DOFs along their directions, in the joint input frame.
 */
export function jointFreeTranslation(
  layout: JointDofLayout,
  q: readonly number[],
): Vec3 {
  let x = 0;
  let y = 0;
  let z = 0;
  const offset = layout.rotational.length;
  for (let index = 0; index < layout.translational.length; index += 1) {
    const dir = layout.translational[index] ?? EZ;
    const value = q[offset + index] ?? 0;
    x += dir[0] * value;
    y += dir[1] * value;
    z += dir[2] * value;
  }
  return [x, y, z];
}

/**
 * The relative angular velocity (joint-input frame) at rates `q̇` —
 * Σ axis_k·q̇_k over the rotational DOFs. Under the pinned
 * pre-rotation convention this is exactly the first three rows of the
 * joint's motion subspace applied to the rates.
 */
export function jointRelativeAngularVelocity(
  layout: JointDofLayout,
  qd: readonly number[],
): Vec3 {
  let x = 0;
  let y = 0;
  let z = 0;
  for (let index = 0; index < layout.rotational.length; index += 1) {
    const axis = layout.rotational[index] ?? EZ;
    const rate = qd[index] ?? 0;
    x += axis[0] * rate;
    y += axis[1] * rate;
    z += axis[2] * rate;
  }
  return [x, y, z];
}

/** The deterministic in-plane basis of a unit axis (the mate-solver restatement). */
export function auxiliaryBasis(z: Vec3): [Vec3, Vec3] {
  const seed: Vec3 = Math.abs(z[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  const e1raw = cross3(z, seed);
  const len = Math.hypot(e1raw[0], e1raw[1], e1raw[2]);
  const e1: Vec3 = [e1raw[0] / len, e1raw[1] / len, e1raw[2] / len];
  const e2 = cross3(z, e1);
  return [e1, e2];
}
