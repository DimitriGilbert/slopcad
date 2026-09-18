/**
 * The workplane → 3D placement transform (Phase 26.1): the extrude feature's
 * bridge from a sketch's 2D home to model space. A profile lives in
 * workplane coordinates; its extrusion is placed by the rotation that maps
 * the canonical local frame (+x, +y, +z) onto the workplane's frame
 * (`xAxis`, `yAxis = normal × xAxis`, `normal`) — expressed as the
 * axis + angle form the kernel contract's placement rotations use — followed
 * by the translation to the workplane origin.
 *
 * The rotation is derived from the frame's rotation matrix (columns = the
 * three basis vectors) by the standard exact-orthogonal conversion: the
 * angle from the trace, the axis from the skew-symmetric part. Deterministic
 * pure math — identical frames always yield identical axis/angle pairs, and
 * the identity frame yields angle 0 with the +z axis (the neutral
 * representation, not a fabricated 2π turn).
 */

import { workplaneBasis, type Workplane } from "./workplane";

/** A dimensionless direction vector in canonical model space. */
export type PlacementAxis = readonly [number, number, number];

/** The axis + angle placement a kernel contract rotation expects. */
export interface WorkplanePlacementRotation {
  readonly axis: PlacementAxis;
  /** Right-hand rotation angle in radians, in [0, π]. */
  readonly angleRad: number;
}

/** The full placement: rotation about the world origin, then translation. */
export interface WorkplanePlacement {
  readonly rotation: WorkplanePlacementRotation;
  readonly translation: {
    readonly x: number;
    readonly y: number;
    readonly z: number;
  };
}

/** The rotation matrix carrying the canonical frame onto the workplane's. */
function frameMatrix(
  workplane: Workplane,
): readonly [
  [number, number, number],
  [number, number, number],
  [number, number, number],
] {
  const { xAxis, yAxis, normal } = workplaneBasis(workplane);
  // Columns: the images of the canonical basis vectors.
  return [
    [xAxis.x, yAxis.x, normal.x],
    [xAxis.y, yAxis.y, normal.y],
    [xAxis.z, yAxis.z, normal.z],
  ];
}

/** The angle in [0, π] of an exact rotation matrix, from its trace. */
function rotationAngle(
  m: readonly (readonly [number, number, number])[],
): number {
  const m00 = m[0]?.[0];
  const m11 = m[1]?.[1];
  const m22 = m[2]?.[2];
  if (m00 === undefined || m11 === undefined || m22 === undefined) {
    throw new Error(
      "Invariant violation: the frame matrix always has nine components.",
    );
  }
  const trace = m00 + m11 + m22;
  const cosine = (trace - 1) / 2;
  const clamped = Math.min(1, Math.max(-1, cosine));
  return Math.acos(clamped);
}

/**
 * Maps a workplane onto its kernel-contract placement: the rotation about
 * the world origin that orients the canonical local frame onto the
 * workplane's basis, plus the translation to the workplane origin. A profile
 * extruded in local coordinates along local +z lands, under this placement,
 * exactly on the sketch's plane extending along the plane normal.
 */
export function workplaneToPlacement(workplane: Workplane): WorkplanePlacement {
  const m = frameMatrix(workplane);
  const angle = rotationAngle(m);
  const sin = Math.sin(angle);
  if (sin === 0) {
    // Angle 0 (identity) or angle π (a 180° turn): the skew-symmetric form
    // degenerates. The 180° case: the axis comes from the diagonal's signs.
    if (angle < Math.PI / 2) {
      return {
        rotation: { axis: [0, 0, 1], angleRad: 0 },
        translation: { ...workplane.origin },
      };
    }
    // Angle π: R = 2nnᵀ − I, so n² = (R + I)/2 diagonal.
    const xx = (m[0][0] + 1) / 2;
    const yy = (m[1][1] + 1) / 2;
    const zz = (m[2][2] + 1) / 2;
    const x = Math.sqrt(Math.max(0, xx));
    const y = Math.sqrt(Math.max(0, yy));
    const z = Math.sqrt(Math.max(0, zz));
    return {
      rotation: { axis: [x, y, z], angleRad: Math.PI },
      translation: { ...workplane.origin },
    };
  }
  const axis: PlacementAxis = [
    (m[2][1] - m[1][2]) / (2 * sin),
    (m[0][2] - m[2][0]) / (2 * sin),
    (m[1][0] - m[0][1]) / (2 * sin),
  ];
  return {
    rotation: { axis, angleRad: angle },
    translation: { ...workplane.origin },
  };
}
