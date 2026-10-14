/**
 * Shared SI fixtures for the sim-structural suites (the sim-thermal
 * `./fixtures` precedent): analytic occupancy builders (box, annulus),
 * serialized material records in the wire form the material door
 * consumes, and the per-cell material maps the run door eats. Node-env
 * vitest, no network, no React — the law-S2 stance.
 */

import type { SimOccupancyGrid } from "@slopcad/sim-core";
import type { StructuralRunScenario } from "./run";

/** A serialized steel record — the structural fields complete. */
export const STEEL_WIRE = {
  id: "mat_steel",
  name: "Steel S235",
  densityGPerCm3: 7.85,
  thermalConductivityWPerMK: 50,
  youngsModulusPa: 210e9,
  poissonRatio: 0.3,
  yieldStrengthPa: 250e6,
  thermalExpansionPerK: 1.2e-5,
} as const;

/** A serialized aluminium record (a second material for mixed runs). */
export const ALUMINIUM_WIRE = {
  id: "mat_alu",
  name: "Aluminium 6061",
  densityGPerCm3: 2.7,
  youngsModulusPa: 69e9,
  poissonRatio: 0.33,
  yieldStrengthPa: 275e6,
  thermalExpansionPerK: 2.3e-5,
} as const;

/** An occupancy grid from an analytic predicate (inside → 1). */
export function analyticGrid(
  shape: readonly [number, number, number],
  spacingM: number,
  inside: (i: number, j: number, k: number) => boolean,
  name = "test-grid",
  originM: readonly [number, number, number] = [0, 0, 0],
): SimOccupancyGrid {
  const [nx, ny, nz] = shape;
  const cells = new Uint8Array(nx * ny * nz);
  for (let k = 0; k < nz; k += 1) {
    for (let j = 0; j < ny; j += 1) {
      for (let i = 0; i < nx; i += 1) {
        cells[i + j * nx + k * nx * ny] = inside(i, j, k) ? 1 : 0;
      }
    }
  }
  return {
    semantic: "occupancy",
    name,
    shape,
    originM,
    spacingM: [spacingM, spacingM, spacingM],
    cells,
  };
}

/**
 * A ring (annulus) grid about the z axis through the grid's centre: the
 * predicate speaks the grid's own node positions (`origin + i·h`), the
 * same geometry the mesh derives.
 */
export function ringGrid(
  innerRadiusM: number,
  outerRadiusM: number,
  spacingM: number,
  zCells: number,
): SimOccupancyGrid {
  const halfExtent = Math.ceil(outerRadiusM / spacingM) + 1;
  const nxy = 2 * halfExtent;
  const center = (nxy - 1) * spacingM * 0.5;
  return analyticGrid(
    [nxy, nxy, zCells],
    spacingM,
    (i, j) => {
      const r = Math.hypot(i * spacingM - center, j * spacingM - center);
      return r >= innerRadiusM && r <= outerRadiusM;
    },
    "test-ring",
  );
}

/** A solid box grid of node counts (nx, ny, nz) — the beam family. */
export function boxGrid(
  nx: number,
  ny: number,
  nz: number,
  spacingM: number,
): SimOccupancyGrid {
  return analyticGrid([nx, ny, nz], spacingM, () => true, "test-box");
}

/** The per-cell material map of a grid whose solid cells are one material. */
export function uniformMaterialIndex(grid: SimOccupancyGrid): Uint16Array {
  const index = new Uint16Array(grid.cells.length);
  for (let cell = 0; cell < grid.cells.length; cell += 1) {
    index[cell] = grid.cells[cell] === 1 ? 1 : 0;
  }
  return index;
}

/** A run scenario over a grid with one steel selection, ready to extend. */
export function steelScenario(
  grid: SimOccupancyGrid,
  overrides: Partial<StructuralRunScenario> = {},
): StructuralRunScenario {
  return {
    name: "Test structural run",
    grid,
    materials: [
      {
        id: STEEL_WIRE.id,
        name: STEEL_WIRE.name,
        densityKgPerM3: STEEL_WIRE.densityGPerCm3 * 1000,
        youngsModulusPa: STEEL_WIRE.youngsModulusPa,
        poissonRatio: STEEL_WIRE.poissonRatio,
        yieldStrengthPa: STEEL_WIRE.yieldStrengthPa,
        thermalExpansionPerK: STEEL_WIRE.thermalExpansionPerK,
      },
    ],
    cellMaterialIndex: uniformMaterialIndex(grid),
    ...overrides,
  };
}
