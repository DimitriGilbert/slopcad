/**
 * The 3D rotation vocabulary (Phase 66b): the axis/Ω compilation every
 * rotating-machinery door shares — MRF (`./mrf-3d`), resolved rotation
 * (`./resolved-rotation-3d`), and the torque integration
 * (`./torque-3d`). SI at the door (law S4): the axis is authored as a
 * point plus an unnormalized direction in the solver's SI frame; the
 * compile converts the point to LATTICE cells once, against the same
 * origin and cell size the 66a stepper config owns, normalizes the
 * direction, and every module derives Ω's lattice form
 * Ω_lat = Ω_SI·dt — radians per lattice step, the per-revolution
 * substep currency (a step advances the geometry or the frame by
 * exactly Ω_lat).
 *
 * The rotation MARKER (`Lbm3dRotationMarker`) is the routing honesty of
 * the phase: a config that carries it belongs to one of the rotating
 * doors, and every static door — the 66a CPU stepper and its WGSL
 * provider — refuses it loudly instead of silently running the
 * rotation-free physics on a rotating scenario (the MRF/resolved paths
 * are CPU-oracle-only in 66b; the WGSL provider's refusal states that).
 */

import {
  type SimError,
  SIM_ERROR_CODES,
  type SimParseResult,
  simError,
  simFail,
  simOk,
} from "@slopcad/sim-core";

/** The rotating-machinery kinds a config can mark itself with. */
export const LBM3D_ROTATION_KINDS = ["mrf", "resolved-rotation"] as const;

export type Lbm3dRotationKind = (typeof LBM3D_ROTATION_KINDS)[number];

/**
 * The marker a rotating config carries so every static door refuses it
 * by value, not by guesswork: structurally an MRF config satisfies the
 * static stepper's type, and without this field a misrouted config
 * would compute the wrong physics silently.
 */
export interface Lbm3dRotationMarker {
  readonly kind: Lbm3dRotationKind;
}

/** A rotation axis authored in the solver's SI frame (law S4's door). */
export interface Lbm3dRotationAxisSpec {
  /** One point on the axis, metres (same frame as `originM`). */
  readonly pointM: readonly [number, number, number];
  /** The axis direction, unnormalized, non-zero. */
  readonly direction: readonly [number, number, number];
}

/** A compiled rotation axis: lattice cells + a unit direction. */
export interface Lbm3dRotationAxis {
  /** The axis point in lattice cells (node coordinates). */
  readonly pointLattice: readonly [number, number, number];
  /** The unit direction (normalized at compile, deterministically). */
  readonly direction: readonly [number, number, number];
}

/**
 * Compiles an SI axis into the lattice frame — the one conversion site
 * for rotation geometry (origin and cell size come from the stepper
 * config whose lattice this axis lives in). Refuses non-finite points
 * and a zero (or non-finite) direction.
 */
export function lbm3dCompileAxis(
  spec: Lbm3dRotationAxisSpec,
  originM: readonly [number, number, number],
  cellSizeM: number,
): SimParseResult<Lbm3dRotationAxis, SimError> {
  const refuse = (
    message: string,
    at: unknown,
  ): SimParseResult<never, SimError> =>
    simFail(simError(SIM_ERROR_CODES.scenarioInvalid, message, at));
  if (
    !Array.isArray(spec.pointM) ||
    spec.pointM.length !== 3 ||
    spec.pointM.some(
      (value) => typeof value !== "number" || !Number.isFinite(value),
    )
  ) {
    return refuse(
      "A rotation axis point must be a triple of finite metres.",
      spec.pointM,
    );
  }
  if (
    !Array.isArray(spec.direction) ||
    spec.direction.length !== 3 ||
    spec.direction.some(
      (value) => typeof value !== "number" || !Number.isFinite(value),
    )
  ) {
    return refuse(
      "A rotation axis direction must be a triple of finite numbers.",
      spec.direction,
    );
  }
  const [dx, dy, dz] = spec.direction;
  const norm = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (!(norm > 0)) {
    return refuse(
      "A rotation axis direction must be non-zero.",
      spec.direction,
    );
  }
  if (!(cellSizeM > 0) || !Number.isFinite(cellSizeM)) {
    return refuse(
      "A rotation axis compiles against a positive finite cell size.",
      cellSizeM,
    );
  }
  return simOk({
    pointLattice: [
      (spec.pointM[0] - originM[0]) / cellSizeM,
      (spec.pointM[1] - originM[1]) / cellSizeM,
      (spec.pointM[2] - originM[2]) / cellSizeM,
    ],
    direction: [dx / norm, dy / norm, dz / norm],
  });
}

/** Ω in lattice units: radians advanced per lattice step. */
export function lbm3dOmegaLattice(
  omegaRadPerS: number,
  timeStepS: number,
): number {
  return omegaRadPerS * timeStepS;
}

/** Steps one revolution takes at a lattice angular rate (2π/|Ω_lat|). */
export function lbm3dStepsPerRevolution(omegaLattice: number): number {
  return (2 * Math.PI) / Math.abs(omegaLattice);
}

/**
 * The perpendicular distance from a lattice node to the axis line —
 * the lever-arm/radius currency of the torque integration and the
 * rotating-zone geometry.
 */
export function lbm3dPerpendicularRadius(
  axis: Lbm3dRotationAxis,
  x: number,
  y: number,
  z: number,
): number {
  const rx = x - axis.pointLattice[0];
  const ry = y - axis.pointLattice[1];
  const rz = z - axis.pointLattice[2];
  const [ex, ey, ez] = axis.direction;
  const along = rx * ex + ry * ey + rz * ez;
  const px = rx - along * ex;
  const py = ry - along * ey;
  const pz = rz - along * ez;
  return Math.sqrt(px * px + py * py + pz * pz);
}
