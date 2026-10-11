/**
 * Shared SI fixtures for the sim-flow suites: a fabricated fluid state
 * (only ρ₀ and ν are load-bearing for the kernel; the thermal fields
 * fill the `SimFluidState` shape honestly) and an analytic-occupancy
 * builder for the box/circle pins. Node-env vitest, no network, no
 * React — the law-S2 stance.
 */

import type { SimFluidState } from "@slopcad/sim-core";

/** A fabricated fluid at 300 K with the given ρ₀ (kg/m³) and ν (m²/s). */
export function testFluid(
  densityKgPerM3: number,
  kinematicViscosityM2PerS: number,
): SimFluidState {
  return {
    fluidId: "test-fluid",
    temperatureK: 300,
    densityKgPerM3,
    dynamicViscosityPaS: densityKgPerM3 * kinematicViscosityM2PerS,
    kinematicViscosityM2PerS,
    thermalDiffusivityM2PerS: kinematicViscosityM2PerS / 0.7,
    prandtl: 0.7,
    thermalExpansionPerK: 1 / 300,
    specificHeatJPerKgK: 1000,
    thermalConductivityWPerMK: 0.026,
    speedOfSoundMPerS: 347,
  };
}

/**
 * An analytic occupancy array: 1 exactly where the closed predicate
 * holds (inside-or-on — the voxelizer's classification convention).
 */
export function analyticOccupancy(
  nx: number,
  ny: number,
  insideOrOn: (x: number, y: number) => boolean,
): Uint8Array {
  const cells = new Uint8Array(nx * ny);
  for (let y = 0; y < ny; y += 1) {
    for (let x = 0; x < nx; x += 1) {
      cells[x + y * nx] = insideOrOn(x, y) ? 1 : 0;
    }
  }
  return cells;
}

/**
 * The 3D analytic occupancy (Phase 66a): 1 exactly where the closed
 * predicate holds, in the d3q19 layout contract's value order
 * (`x + y·nx + z·nx·ny`, x-fastest) — the same convention
 * `analyticOccupancy` pins for 2D, with the third axis appended.
 */
export function analyticOccupancy3d(
  nx: number,
  ny: number,
  nz: number,
  insideOrOn: (x: number, y: number, z: number) => boolean,
): Uint8Array {
  const cells = new Uint8Array(nx * ny * nz);
  for (let z = 0; z < nz; z += 1) {
    for (let y = 0; y < ny; y += 1) {
      for (let x = 0; x < nx; x += 1) {
        cells[x + y * nx + z * nx * ny] = insideOrOn(x, y, z) ? 1 : 0;
      }
    }
  }
  return cells;
}

/**
 * A watertight axis-aligned box as the voxelizer's tessellation wire
 * form (8 vertices, 12 triangles, no normals) — the engine-adapter
 * contract fixtures' obstacle: an aligned box voxelizes exactly, so the
 * compiled occupancy slice pins analytically.
 */
export function boxTessellationWire(
  min: readonly [number, number, number],
  max: readonly [number, number, number],
): { readonly positions: number[]; readonly indices: number[] } {
  const [x0, y0, z0] = min;
  const [x1, y1, z1] = max;
  return {
    positions: [
      x0,
      y0,
      z0,
      x1,
      y0,
      z0,
      x1,
      y1,
      z0,
      x0,
      y1,
      z0,
      x0,
      y0,
      z1,
      x1,
      y0,
      z1,
      x1,
      y1,
      z1,
      x0,
      y1,
      z1,
    ],
    indices: [
      0,
      1,
      2,
      0,
      2,
      3, // z0 face
      4,
      5,
      6,
      4,
      6,
      7, // z1 face
      0,
      1,
      5,
      0,
      5,
      4, // y0 face
      3,
      2,
      6,
      3,
      6,
      7, // y1 face
      0,
      3,
      7,
      0,
      7,
      4, // x0 face
      1,
      2,
      6,
      1,
      6,
      5, // x1 face
    ],
  };
}

/**
 * Several box soups merged into ONE tessellation wire (Phase 66c): the
 * positions concatenate in order and each part's indices rebase by the
 * running vertex offset — the multi-body obstacles the 3D engine's
 * contract fixtures voxelize (the fan demo's hub + cross-bars).
 */
export function mergedTessellationWire(
  parts: readonly {
    readonly positions: readonly number[];
    readonly indices: readonly number[];
  }[],
): { readonly positions: number[]; readonly indices: number[] } {
  const positions: number[] = [];
  const indices: number[] = [];
  for (const part of parts) {
    const offset = positions.length / 3;
    positions.push(...part.positions);
    for (const index of part.indices) {
      indices.push(index + offset);
    }
  }
  return { positions, indices };
}
