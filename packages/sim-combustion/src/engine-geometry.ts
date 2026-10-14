/**
 * The slider-crank chamber geometry (ROADMAP-SIM Phase 68b): the
 * crank-slider linkage formula that turns crank angle into cylinder
 * volume — the Phase 67 kinematics seam, consumed here as the closed
 * form rather than reworked. The piston-pin position along the
 * cylinder axis at crank angle θ (θ = 0 at compression TDC) is the
 * standard linkage expression
 *
 *   x_p(θ) = r·cosθ + √(l² − r²·sin²θ)
 *
 * (crank radius r = stroke/2, rod length l), the identical formula the
 * Phase 67 reference kernel and its `sliderCrankPistonSlideM` closed
 * form assert — pinned BITWISE against that export by the
 * dev-only cross-compatibility suite (`dynamics-cross.test.ts`), the
 * cad-core precedent: the seam is consumed, not duplicated blindly.
 *
 * The volume, its crank derivative (the indicated-torque path), and
 * the wetted wall area (the heat-transfer path) are the three
 * geometric quantities the 0D chamber integrates on.
 */

import {
  simError,
  simFail,
  simOk,
  SIM_ERROR_CODES,
  type SimError,
  type SimParseResult,
} from "@slopcad/sim-core";

/** A slider-crank engine's geometry, SI. */
export interface SliderCrankGeometry {
  /** The cylinder bore, m. */
  readonly boreM: number;
  /** The crank radius, m (half the stroke). */
  readonly crankRadiusM: number;
  /** The connecting-rod length, m (center-to-center). */
  readonly rodLengthM: number;
  /** The clearance volume at TDC, m³. */
  readonly clearanceVolumeM3: number;
}

/**
 * Compiles and validates a geometry: positive bore, positive crank
 * radius, a rod longer than the crank (the linkage's assembly
 * condition l > r), and a positive clearance volume.
 */
export function compileSliderCrankGeometry(input: {
  readonly boreM: number;
  readonly crankRadiusM: number;
  readonly rodLengthM: number;
  readonly clearanceVolumeM3: number;
}): SimParseResult<SliderCrankGeometry, SimError> {
  const { boreM, crankRadiusM, rodLengthM, clearanceVolumeM3 } = input;
  if (
    !Number.isFinite(boreM) ||
    boreM <= 0 ||
    !Number.isFinite(crankRadiusM) ||
    crankRadiusM <= 0 ||
    !Number.isFinite(rodLengthM) ||
    rodLengthM <= crankRadiusM ||
    !Number.isFinite(clearanceVolumeM3) ||
    clearanceVolumeM3 <= 0
  ) {
    return simFail(
      simError(
        SIM_ERROR_CODES.scenarioInvalid,
        `The chamber geometry is malformed: bore ${String(boreM)} m, crank radius ${String(crankRadiusM)} m, rod ${String(rodLengthM)} m, clearance ${String(clearanceVolumeM3)} m³ (need bore > 0, crank radius > 0, rod > crank radius, clearance > 0).`,
        input,
      ),
    );
  }
  return simOk(Object.freeze({ ...input }));
}

/** The piston-pin distance from the crank axis, m, at crank angle θ. */
export function pistonPinDistanceM(
  geometry: SliderCrankGeometry,
  crankAngleRad: number,
): number {
  const r = geometry.crankRadiusM;
  const l = geometry.rodLengthM;
  const sin = Math.sin(crankAngleRad);
  return (
    r * Math.cos(crankAngleRad) +
    Math.sqrt(Math.max(0, l * l - r * r * sin * sin))
  );
}

/**
 * d(x_p)/dθ, the piston-pin travel per radian of crank, m/rad — the
 * lever the gas pressure's torque rides (V′(θ) = −A_p·x_p′(θ)).
 */
export function pistonPinTravelPerRad(
  geometry: SliderCrankGeometry,
  crankAngleRad: number,
): number {
  const r = geometry.crankRadiusM;
  const l = geometry.rodLengthM;
  const sin = Math.sin(crankAngleRad);
  const cos = Math.cos(crankAngleRad);
  const root = Math.sqrt(Math.max(1e-300, l * l - r * r * sin * sin));
  return -r * sin - (r * r * sin * cos) / root;
}

/** The piston crown area, m². */
export function pistonAreaM2(geometry: SliderCrankGeometry): number {
  return (Math.PI * geometry.boreM * geometry.boreM) / 4;
}

/** The displacement (swept) volume, m³: A_p·2r. */
export function displacementM3(geometry: SliderCrankGeometry): number {
  return pistonAreaM2(geometry) * 2 * geometry.crankRadiusM;
}

/** The geometric compression ratio (V_BDC / V_TDC), dimensionless. */
export function compressionRatioOf(geometry: SliderCrankGeometry): number {
  return (
    (geometry.clearanceVolumeM3 + displacementM3(geometry)) /
    geometry.clearanceVolumeM3
  );
}

/**
 * The chamber volume at crank angle θ, m³:
 * V(θ) = V_c + A_p·(x_p(0) − x_p(θ)) — V_c at TDC (θ = 0), V_c + V_d
 * at BDC (θ = ±π).
 */
export function chamberVolumeM3(
  geometry: SliderCrankGeometry,
  crankAngleRad: number,
): number {
  const tdc = pistonPinDistanceM(geometry, 0);
  return (
    geometry.clearanceVolumeM3 +
    pistonAreaM2(geometry) * (tdc - pistonPinDistanceM(geometry, crankAngleRad))
  );
}

/** dV/dθ at crank angle θ, m³/rad (negative through compression). */
export function chamberVolumePerRad(
  geometry: SliderCrankGeometry,
  crankAngleRad: number,
): number {
  return (
    -pistonAreaM2(geometry) * pistonPinTravelPerRad(geometry, crankAngleRad)
  );
}

/**
 * The instantaneous wetted wall area, m²: cylinder head + piston crown
 * (both A_p) plus the liner exposed by the piston's travel from TDC —
 * the standard 0D chamber heat-transfer area.
 */
export function chamberWallAreaM2(
  geometry: SliderCrankGeometry,
  crankAngleRad: number,
): number {
  const tdc = pistonPinDistanceM(geometry, 0);
  const travel = tdc - pistonPinDistanceM(geometry, crankAngleRad);
  // The clearance height: the TDC chamber's mean height over the bore,
  // V_c/A_p — the flat-piston idealization, stated.
  const clearanceHeight = geometry.clearanceVolumeM3 / pistonAreaM2(geometry);
  return (
    2 * pistonAreaM2(geometry) +
    Math.PI * geometry.boreM * (clearanceHeight + travel)
  );
}
