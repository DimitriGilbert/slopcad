/**
 * Spatial-algebra ground truth (Phase 67a): the identities the kernel's
 * world-aligned formulation rests on — parallel-axis consistency,
 * motion/force origin shifts as inverses, the inertia product's
 * kinetic-energy dual, the exponential map's group structure, and the
 * rotation-vector wrap's pose preservation.
 */

import { describe, expect, it } from "vitest";

import {
  addSpatialInertia,
  cross3,
  dot3,
  expRotation,
  IDENTITY_MAT3,
  mulMat3,
  mulMat3Vec,
  mulSpatialInertia,
  rotateSpatialInertia,
  rotationAboutUnitAxis,
  scale3,
  shiftForceTo,
  shiftMotionTo,
  shiftSpatialInertia,
  spatialInertiaAboutOrigin,
  transposeMat3,
  wrapRotationVector,
  type Mat3,
  type SpatialInertia,
  type Vec3,
} from "./spatial";

function closeTo(a: Vec3, b: Vec3): void {
  expect(a[0]).toBeCloseTo(b[0], 12);
  expect(a[1]).toBeCloseTo(b[1], 12);
  expect(a[2]).toBeCloseTo(b[2], 12);
}

describe("spatial algebra ground truth", () => {
  it("builds the origin inertia by the parallel-axis theorem and shifts it back", () => {
    const m = 2.5;
    const c: Vec3 = [0.03, -0.02, 0.05];
    const ic: Mat3 = [0.004, 0, 0, 0, 0.005, 0, 0, 0, 0.006];
    const about = spatialInertiaAboutOrigin(m, c, ic);
    // Shifting the origin back by +c lands at the COG: I₀' = ic.
    const shifted = shiftSpatialInertia(about, c);
    shifted.i0.forEach((value, index) => {
      expect(value).toBeCloseTo(ic[index] ?? 0, 15);
    });
    closeTo(shifted.h, [0, 0, 0]);
    // Rotating the COG-sited inertia by any rotation leaves it diagonal
    // here only for axis rotations — check the mass and moment carry.
    const r = rotationAboutUnitAxis([0, 1, 0], 0.7);
    const rotated = rotateSpatialInertia(shifted, r);
    expect(rotated.m).toBe(m);
    closeTo(rotated.h, [0, 0, 0]);
  });

  it("makes motion and force shifts inverses of each other", () => {
    const from: Vec3 = [0.1, -0.2, 0.3];
    const to: Vec3 = [-0.4, 0.5, 0.6];
    const motion = { ang: [0.3, 1.2, -0.7] as Vec3, lin: [1, 2, 3] as Vec3 };
    const shifted = shiftMotionTo(motion, from, to);
    const back = shiftMotionTo(shifted, to, from);
    closeTo(back.ang, motion.ang);
    closeTo(back.lin, motion.lin);
    const force = { mom: [0.5, -0.1, 0.2] as Vec3, frc: [2, -3, 4] as Vec3 };
    const shiftedForce = shiftForceTo(force, from, to);
    const backForce = shiftForceTo(shiftedForce, to, from);
    closeTo(backForce.mom, force.mom);
    closeTo(backForce.frc, force.frc);
  });

  it("answers the kinetic-energy dual: v·(I v) is the doubled per-body KE", () => {
    const m = 3;
    const c: Vec3 = [0.05, 0.02, -0.01];
    const ic: Mat3 = [0.002, 0, 0, 0, 0.003, 0, 0, 0, 0.001];
    const inertia: SpatialInertia = spatialInertiaAboutOrigin(m, c, ic);
    const omega: Vec3 = [0.4, -0.3, 0.9];
    const vOrigin: Vec3 = [0.2, 0.5, -0.1];
    const dual = mulSpatialInertia(inertia, { ang: omega, lin: vOrigin });
    const omegaCrossC = cross3(omega, c);
    const vCom: Vec3 = [
      vOrigin[0] + omegaCrossC[0],
      vOrigin[1] + omegaCrossC[1],
      vOrigin[2] + omegaCrossC[2],
    ];
    const kinetic =
      0.5 *
      (m * dot3(vCom, vCom) +
        dot3(omega, [
          ic[0] * omega[0],
          ic[4] * omega[1],
          ic[8] * omega[2],
        ] as Vec3));
    const fromDual = 0.5 * (dot3(omega, dual.mom) + dot3(vOrigin, dual.frc));
    expect(fromDual).toBeCloseTo(kinetic, 12);
  });

  it("keeps the composite-rigid-body sum additive about a shared origin", () => {
    const a = spatialInertiaAboutOrigin(
      2,
      [0.1, 0, 0],
      [0.01, 0, 0, 0, 0.01, 0, 0, 0, 0.01],
    );
    const b = spatialInertiaAboutOrigin(
      3,
      [-0.1, 0.05, 0],
      [0.02, 0, 0, 0, 0.02, 0, 0, 0, 0.02],
    );
    const sum = addSpatialInertia(a, b);
    expect(sum.m).toBe(5);
    closeTo(sum.h, [2 * 0.1 - 3 * 0.1, 3 * 0.05, 0]);
    // Total mass at the mass-weighted COG about the same origin.
    const cog: Vec3 = scale3(sum.h, 1 / sum.m);
    closeTo(cog, [-0.1 / 5, 0.03, 0]);
  });

  it("exponentiates into the rotation group and wraps the rotation vector in place", () => {
    const axis: Vec3 = [0, 0, 1];
    const quarter = expRotation([0, 0, Math.PI / 2]);
    const mapped = mulMat3Vec(quarter, [1, 0, 0]);
    closeTo(mapped, [0, 1, 0]);
    expect(mulMat3(quarter, transposeMat3(quarter))).toEqual(IDENTITY_MAT3);
    // A full turn wraps to the same rotation (2π periodicity along the axis).
    const full: Vec3 = [0, 0, 2 * Math.PI + 0.3];
    const wrapped = wrapRotationVector(full);
    expect(Math.hypot(wrapped[0], wrapped[1], wrapped[2])).toBeLessThanOrEqual(
      Math.PI,
    );
    const rFull = expRotation(full);
    const rWrapped = expRotation(wrapped);
    for (const [index, value] of rFull.entries()) {
      expect(rWrapped[index]).toBeCloseTo(value, 9);
    }
    expect(rotationAboutUnitAxis(axis, 0)).toEqual(IDENTITY_MAT3);
  });
});
