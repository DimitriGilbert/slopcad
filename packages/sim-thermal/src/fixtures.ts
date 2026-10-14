/**
 * Shared SI fixtures for the sim-thermal suites (the sim-flow
 * `./fixtures` precedent): analytic occupancy builders for the
 * 1D-rod/shell/cavity pins, serialized material records in the wire
 * form the material door consumes, and a fabricated fluid state with
 * honest thermal fields. Node-env vitest, no network, no React — the
 * law-S2 stance.
 */

import type { SimFluidState, SimOccupancyGrid } from "@slopcad/sim-core";

/** A fabricated air-adjacent fluid at 300 K (the S9 numbers' input). */
export function testFluid(): SimFluidState {
  return {
    fluidId: "test-air",
    temperatureK: 300,
    densityKgPerM3: 1.176,
    dynamicViscosityPaS: 1.846e-5,
    kinematicViscosityM2PerS: 1.846e-5 / 1.176,
    thermalDiffusivityM2PerS: 0.0263 / (1.176 * 1006),
    prandtl: (1.846e-5 * 1006) / 0.0263,
    thermalExpansionPerK: 1 / 300,
    specificHeatJPerKgK: 1006,
    thermalConductivityWPerMK: 0.0263,
    speedOfSoundMPerS: 347.2,
  };
}

/** An occupancy grid from an analytic predicate (inside-or-on → 1), uniform spacing. */
export function analyticGrid(
  shape: readonly [number, number, number],
  spacingM: number,
  insideOrOn: (i: number, j: number, k: number) => boolean,
  name = "test-grid",
): SimOccupancyGrid {
  const [nx, ny, nz] = shape;
  const cells = new Uint8Array(nx * ny * nz);
  for (let k = 0; k < nz; k += 1) {
    for (let j = 0; j < ny; j += 1) {
      for (let i = 0; i < nx; i += 1) {
        cells[i + j * nx + k * nx * ny] = insideOrOn(i, j, k) ? 1 : 0;
      }
    }
  }
  return {
    semantic: "occupancy",
    name,
    shape,
    originM: [0, 0, 0],
    spacingM: [spacingM, spacingM, spacingM],
    cells,
  };
}

/** A solid box occupancy (the inclusive integer box). */
export function boxGrid(
  min: readonly [number, number, number],
  max: readonly [number, number, number],
  spacingM: number,
  name?: string,
): SimOccupancyGrid {
  const shape: [number, number, number] = [max[0], max[1], max[2]];
  return analyticGrid(
    shape,
    spacingM,
    (i, j, k) => i >= (min[0] ?? 0) && j >= (min[1] ?? 0) && k >= (min[2] ?? 0),
    name,
  );
}

/** A hollow shell: solid within the outer box, hollow within the inner box (one enclosure). */
export function shellGrid(
  outer: number,
  innerMin: number,
  innerMax: number,
  spacingM: number,
  name = "test-shell",
): SimOccupancyGrid {
  return analyticGrid(
    [outer, outer, outer],
    spacingM,
    (i, j, k) => {
      const insideCavity =
        i >= innerMin &&
        i <= innerMax &&
        j >= innerMin &&
        j <= innerMax &&
        k >= innerMin &&
        k <= innerMax;
      return !insideCavity;
    },
    name,
  );
}

/** A serialized `DocumentMaterialRecord`-shaped wire object for the material door. */
export function materialWire(fields: {
  readonly id: string;
  readonly name?: string;
  readonly densityGPerCm3: number;
  readonly thermalConductivityWPerMK?: number;
  readonly specificHeatJPerKgK?: number;
  readonly emissivity?: number;
}): unknown {
  return {
    id: fields.id,
    name: fields.name ?? fields.id,
    densityGPerCm3: fields.densityGPerCm3,
    ...(fields.thermalConductivityWPerMK === undefined
      ? {}
      : { thermalConductivityWPerMK: fields.thermalConductivityWPerMK }),
    ...(fields.specificHeatJPerKgK === undefined
      ? {}
      : { specificHeatJPerKgK: fields.specificHeatJPerKgK }),
    ...(fields.emissivity === undefined
      ? {}
      : { emissivity: fields.emissivity }),
  };
}

/** Steel-adjacent: k = 45 W/(m·K), ρ = 7.8 g/cm³, cp = 466 J/(kg·K). */
export const STEEL_WIRE = materialWire({
  id: "mat_steel",
  name: "Steel",
  densityGPerCm3: 7.8,
  thermalConductivityWPerMK: 45,
  specificHeatJPerKgK: 466,
  emissivity: 0.6,
});

/** Copper-adjacent for the two-material harmonic-mean pin: k = 400. */
export const COPPER_WIRE = materialWire({
  id: "mat_copper",
  name: "Copper",
  densityGPerCm3: 8.96,
  thermalConductivityWPerMK: 400,
  specificHeatJPerKgK: 385,
  emissivity: 0.1,
});

/** A uniform per-cell material assignment over every solid cell (1-based index). */
export function uniformMaterialIndex(
  grid: SimOccupancyGrid,
  index: number,
): Uint16Array {
  const assignment = new Uint16Array(grid.cells.length);
  for (let cell = 0; cell < grid.cells.length; cell += 1) {
    assignment[cell] = grid.cells[cell] === 1 ? index : 0;
  }
  return assignment;
}

/**
 * An axis-aligned box triangle soup in the voxelizer's wire form — the
 * sim-flow `./fixtures` builder restated here so this package's engine
 * tests compile the compile door without a cross-package fixture edge
 * (the per-package fixtures precedent). 8 vertices, 12 triangles, the
 * closed box the parity classifier voxelizes exactly at aligned
 * resolutions.
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
