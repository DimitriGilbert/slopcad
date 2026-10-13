/**
 * Shared macroscopic readouts for the Phase 66b steppers (MRF
 * `./mrf-3d`, resolved rotation `./resolved-rotation-3d`): the pure
 * lattice snapshot, the SI snapshot, and the S4-ready solver fields —
 * the same conversions the 66a CPU stepper performs over ITS state,
 * stated once here for every driver that owns its own state and drives
 * the shared primitives directly. The 66a stepper keeps its private
 * copies (untouched by this phase); the WGSL provider keeps its
 * readback-side twin (`./wgsl-stepper-3d`) because its reads are async
 * — this module is the CPU drivers' one source.
 *
 * One 66b addition: the SI snapshot accepts an optional per-node
 * LATTICE velocity shift (the MRF half-force correction — in the
 * rotating frame the physical velocity is Σf·c/ρ + F/(2ρ), and the
 * MRF stepper's snapshot owes the shifted value, never the raw one).
 */

import type { SolverSimField } from "@slopcad/sim-core";
import type { Lbm3dUnitSystem } from "./lattice-units-3d";
import type { Lbm3dLatticeSnapshot, Lbm3dSISnapshot } from "./stepper-3d";
import type { Lbm3dState } from "./state-3d";

import { D3Q19_Q, D3Q19_VELOCITIES } from "./d3q19";

/** Freshly recomputed macroscopic fields (solid columns zero). */
export interface Lbm3dMacroscopicFields {
  readonly rho: Float64Array;
  readonly ux: Float64Array;
  readonly uy: Float64Array;
  readonly uz: Float64Array;
}

/** An optional per-node lattice velocity shift (MRF's F/(2ρ)). */
export interface Lbm3dVelocityShift {
  readonly dx: Float64Array;
  readonly dy: Float64Array;
  readonly dz: Float64Array;
}

/**
 * Recomputes ρ, u at every FLUID node from the live distributions
 * (solid columns zero) — pure, no divergence check (the advance loop's
 * sentinel owns that; a readout never fabricates a verdict).
 */
export function lbm3dMacroscopicOf(state: Lbm3dState): Lbm3dMacroscopicFields {
  const count = state.nx * state.ny * state.nz;
  const rho = new Float64Array(count);
  const ux = new Float64Array(count);
  const uy = new Float64Array(count);
  const uz = new Float64Array(count);
  const mask = state.solid.solid;
  for (let index = 0; index < mask.length; index += 1) {
    if (mask[index] === 1) continue;
    let sum = 0;
    let mx = 0;
    let my = 0;
    let mz = 0;
    for (let i = 0; i < D3Q19_Q; i += 1) {
      const value = state.f[i]?.[index] ?? 0;
      sum += value;
      mx += value * (D3Q19_VELOCITIES[i]?.[0] ?? 0);
      my += value * (D3Q19_VELOCITIES[i]?.[1] ?? 0);
      mz += value * (D3Q19_VELOCITIES[i]?.[2] ?? 0);
    }
    rho[index] = sum;
    ux[index] = mx / sum;
    uy[index] = my / sum;
    uz[index] = mz / sum;
  }
  return { rho, ux, uy, uz };
}

/** The lattice-unit snapshot (raw Σf·c/ρ velocities, solid columns zero). */
export function lbm3dLatticeSnapshotOf(
  state: Lbm3dState,
  step: number,
): Lbm3dLatticeSnapshot {
  const macro = lbm3dMacroscopicOf(state);
  return {
    step,
    rho: macro.rho,
    ux: macro.ux,
    uy: macro.uy,
    uz: macro.uz,
  };
}

/**
 * The SI snapshot: density, three velocity components (plus the
 * optional lattice shift), and pressure — converted once through the
 * unit closure, `referencePressurePa + (ρ − 1)·pressureFactorPa`.
 */
export function lbm3dSISnapshotOf(
  state: Lbm3dState,
  step: number,
  units: Lbm3dUnitSystem,
  referencePressurePa: number,
  velocityShift?: Lbm3dVelocityShift,
): Lbm3dSISnapshot {
  const macro = lbm3dMacroscopicOf(state);
  const count = macro.rho.length;
  const densityKgPerM3 = new Float64Array(count);
  const velocityXMPerS = new Float64Array(count);
  const velocityYMPerS = new Float64Array(count);
  const velocityZMPerS = new Float64Array(count);
  const pressurePa = new Float64Array(count);
  for (let index = 0; index < count; index += 1) {
    const rho = macro.rho[index] ?? 0;
    densityKgPerM3[index] = rho * units.densityFactor;
    velocityXMPerS[index] =
      ((macro.ux[index] ?? 0) + (velocityShift?.dx[index] ?? 0)) *
      units.velocityFactor;
    velocityYMPerS[index] =
      ((macro.uy[index] ?? 0) + (velocityShift?.dy[index] ?? 0)) *
      units.velocityFactor;
    velocityZMPerS[index] =
      ((macro.uz[index] ?? 0) + (velocityShift?.dz[index] ?? 0)) *
      units.velocityFactor;
    pressurePa[index] =
      referencePressurePa + (rho - 1) * units.pressureFactorPa;
  }
  return {
    step,
    densityKgPerM3,
    velocityXMPerS,
    velocityYMPerS,
    velocityZMPerS,
    pressurePa,
  };
}

/**
 * The S4-ready solver fields (velocity-x/y/z, speed, pressure) from a
 * macroscopic readout — the 66a stepper's own field set, labels, and
 * units (the document-space unit labels are the POST-projection ones,
 * the sim-core grid precedent), with the optional lattice velocity
 * shift applied before conversion.
 */
export function lbm3dSolverFieldsOf(
  macro: Lbm3dMacroscopicFields,
  extent: readonly [number, number, number],
  units: Lbm3dUnitSystem,
  referencePressurePa: number,
  originM: readonly [number, number, number],
  velocityShift?: Lbm3dVelocityShift,
): readonly SolverSimField[] {
  const [nx, ny, nz] = extent;
  const dx = units.cellSizeM;
  const velocityValuesX: number[] = [];
  const velocityValuesY: number[] = [];
  const velocityValuesZ: number[] = [];
  const speedValues: number[] = [];
  const pressureValues: number[] = [];
  for (let index = 0; index < macro.rho.length; index += 1) {
    const vx =
      ((macro.ux[index] ?? 0) + (velocityShift?.dx[index] ?? 0)) *
      units.velocityFactor;
    const vy =
      ((macro.uy[index] ?? 0) + (velocityShift?.dy[index] ?? 0)) *
      units.velocityFactor;
    const vz =
      ((macro.uz[index] ?? 0) + (velocityShift?.dz[index] ?? 0)) *
      units.velocityFactor;
    velocityValuesX.push(vx);
    velocityValuesY.push(vy);
    velocityValuesZ.push(vz);
    speedValues.push(Math.sqrt(vx * vx + vy * vy + vz * vz));
    pressureValues.push(
      referencePressurePa +
        ((macro.rho[index] ?? 0) - 1) * units.pressureFactorPa,
    );
  }
  const geometry = {
    extent: [nx, ny, nz] as const,
    originM: [originM[0] ?? 0, originM[1] ?? 0, originM[2] ?? 0] as const,
    spacingM: [dx, dx, dx] as const,
    dataType: "float32" as const,
  };
  return [
    {
      id: "velocity-x",
      unit: "mm/s",
      dimension: "velocity",
      values: velocityValuesX,
      ...geometry,
    },
    {
      id: "velocity-y",
      unit: "mm/s",
      dimension: "velocity",
      values: velocityValuesY,
      ...geometry,
    },
    {
      id: "velocity-z",
      unit: "mm/s",
      dimension: "velocity",
      values: velocityValuesZ,
      ...geometry,
    },
    {
      id: "speed",
      unit: "mm/s",
      dimension: "velocity",
      values: speedValues,
      ...geometry,
    },
    {
      id: "pressure",
      unit: "Pa",
      dimension: "pressure",
      values: pressureValues,
      ...geometry,
    },
  ];
}
