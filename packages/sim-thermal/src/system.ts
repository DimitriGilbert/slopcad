/**
 * The finite-volume assembly (Phase 65a): one cell-centred energy
 * balance per solid voxel cell, in the direct node interpretation of
 * `./grid`. For cell P with neighbours N across its six faces:
 *
 *   Σ_N G_PN·(T_N − T_P) + Σ_b G_b·(T_b − T_P) + q_P'''·V + Σ_neumann flux·A = 0
 *
 * with the standard conservative FVM choices, each stated:
 *
 * - **Interior faces** — the HARMONIC mean conductivity (the series
 *   thermal resistance of the two half-cells; exact for a layered
 *   interface and the conservative default): G = 2·k_P·k_N/(k_P + k_N)·A/d.
 * - **Dirichlet faces** — the half-cell resistance: G = k_P·A/(d/2);
 *   exact for the linear steady profile (the 1D analytic pin).
 * - **Neumann faces** — the flux enters the cell's source, W.
 * - **Convection + radiation to ambient** — the §7.12 equilibrium
 *   boundary: G = (h + h_rad)·A against T_amb, with h_rad either the
 *   FIXED linearized coefficient (solver-friendly, reference-stated) or
 *   the full quartic's TANGENT at the current Picard iterate
 *   (`tangentRadiationBoundary` — exact quartic at the fixed point,
 *   monotone convergence where naive source lagging diverges).
 * - **Enclosure faces** — the uniform-radiosity exchange of `./radiation`
 *   against the lagged T_enc: linearized as a conductance against it,
 *   or the full quartic's tangent against its equivalent environment.
 *
 * The assembled system is the SoA view the solver (`./solver`)
 * iterates and both the steady Picard loop and the implicit backward-Euler
 * march re-assemble per outer iteration / step with fresh tangent
 * radiation — everything is fixed-order float64 arithmetic, so assembly
 * is bitwise deterministic (law S2).
 */

import type { SimDomainFace } from "@slopcad/sim-core";
import type {
  ThermalAmbientSpec,
  ThermalRadiationMode,
  ThermalSurfaceCondition,
} from "./boundaries";
import type { ThermalCellGrid, ThermalExposedFace } from "./grid";

import { thermalExposedFaces } from "./grid";
import {
  enclosureRadiosityTemperatureK,
  linearizedRadiationCoefficientWPerM2K,
  tangentRadiationBoundary,
} from "./radiation";

/** The validated physics bundle every solver mode consumes. */
export interface ThermalProblem {
  readonly grid: ThermalCellGrid;
  /** Per-cell conductivity, W/(m·K) (validated finite ≥ 0 on solid cells). */
  readonly conductivityWPerMK: Float64Array;
  /** Per-cell volumetric heat capacity ρc, J/(m³·K); NaN where absent. */
  readonly volumetricHeatCapacityJPerM3K: Float64Array;
  /** Per-cell material emissivity; NaN where the record carried none. */
  readonly emissivity: Float64Array;
  /** Per-cell volumetric heat source, W/m³ (signed; + heats). */
  readonly sourceWPerM3: Float64Array;
  readonly ambient: ThermalAmbientSpec | undefined;
  readonly faceConditions: Readonly<
    Partial<Record<SimDomainFace, ThermalSurfaceCondition>>
  >;
  readonly radiationMode: ThermalRadiationMode;
  /** The linearized mode's fixed surface-temperature estimate, K. */
  readonly radiationReferenceK: number;
}

/** One enclosure's surface table (the T_enc inputs, in exposed-face order). */
export interface ThermalEnclosureSurfaces {
  readonly id: number;
  readonly surfaces: readonly {
    readonly cell: number;
    readonly areaM2: number;
    readonly emissivity: number;
  }[];
}

/** A resolved exposed face — the ONE rule assembly and audit share. */
export type ResolvedThermalFace =
  | { readonly kind: "dirichlet"; readonly temperatureK: number }
  | { readonly kind: "neumann"; readonly fluxWPerM2: number }
  | {
      readonly kind: "ambient";
      readonly heatTransferCoefficientWPerM2K: number;
      readonly ambientTemperatureK: number;
      readonly emissivityOverride: number | undefined;
    }
  | { readonly kind: "enclosure"; readonly enclosure: number }
  | { readonly kind: "adiabatic" };

/**
 * Resolves one exposed face's condition: enclosure faces always take the
 * §7.12 enclosure exchange; a domain-box face takes the condition
 * authored for that face when one exists, else the ambient default; any
 * other exterior face takes the ambient default; a face with neither an
 * authored condition nor an ambient spec is adiabatic (the stated
 * symmetry boundary, never a silent gap).
 */
export function resolveThermalFace(
  face: ThermalExposedFace,
  ambient: ThermalAmbientSpec | undefined,
  faceConditions: Readonly<
    Partial<Record<SimDomainFace, ThermalSurfaceCondition>>
  >,
): ResolvedThermalFace {
  if (face.kind === "enclosure") {
    return { kind: "enclosure", enclosure: face.enclosure };
  }
  if (face.kind === "domain") {
    const condition: ThermalSurfaceCondition | undefined =
      faceConditions[domainFaceOf(face)];
    if (condition !== undefined) {
      return conditionToResolved(condition);
    }
  }
  if (ambient === undefined) return { kind: "adiabatic" };
  return {
    kind: "ambient",
    heatTransferCoefficientWPerM2K: ambient.heatTransferCoefficientWPerM2K,
    ambientTemperatureK: ambient.ambientTemperatureK,
    emissivityOverride: undefined,
  };
}

/** The domain face a grid-boundary exposed face addresses. */
function domainFaceOf(face: ThermalExposedFace): SimDomainFace {
  const axisName = face.axis === 0 ? "x" : face.axis === 1 ? "y" : "z";
  return face.sign < 0 ? `${axisName}Min` : `${axisName}Max`;
}

function conditionToResolved(
  condition: ThermalSurfaceCondition,
): ResolvedThermalFace {
  return condition.kind === "fixed-temperature"
    ? { kind: "dirichlet", temperatureK: condition.temperatureK }
    : condition.kind === "heat-flux"
      ? { kind: "neumann", fluxWPerM2: condition.fluxWPerM2 }
      : {
          kind: "ambient",
          heatTransferCoefficientWPerM2K:
            condition.heatTransferCoefficientWPerM2K,
          ambientTemperatureK: condition.ambientTemperatureK,
          emissivityOverride: condition.emissivity,
        };
}

/** The assembled linear system view (SoA; per-cell × 6 faces, fixed direction order). */
export interface AssembledThermalSystem {
  readonly cellCount: number;
  readonly solid: Uint8Array;
  /** 6·cells conductances, W/K: interior faces (pair with faceNeighbor) and boundary faces (with faceRefT). */
  readonly faceG: Float64Array;
  /** 6·cells: the solid neighbour's cell index, or −1 for a boundary face. */
  readonly faceNeighbor: Int32Array;
  /** 6·cells: the boundary face's reference temperature, K (0 on interior faces). */
  readonly faceRefT: Float64Array;
  /** Per-cell fixed source, W: q'''·V + Neumann fluxes (radiation rides the boundary faces). */
  readonly sourceW: Float64Array;
  /** Per-cell Σ faceG — the diagonal before any capacity term, W/K. */
  readonly diagonalBaseWPerK: Float64Array;
  /** The enclosure surface tables the lagged T_enc values were built from. */
  readonly enclosures: readonly ThermalEnclosureSurfaces[];
  /** The lagged enclosure temperature per enclosure id, K (NaN when the enclosure does not exchange). */
  readonly enclosureTemperatureK: readonly number[];
}

/** What one assembly call needs beyond the problem: the lagging state. */
export interface ThermalAssemblyState {
  /** The current temperature field — the Picard lag for full-mode radiation and T_enc. */
  readonly iterateK: Float64Array;
}

/**
 * Assembles the system at the given lagging state: interior conductances
 * first (row-major cells, fixed direction order), then the enclosure
 * temperatures from the iterate, then every exposed face's boundary
 * terms under the problem's radiation mode. Pure and deterministic.
 */
export function assembleThermalSystem(
  problem: ThermalProblem,
  state: ThermalAssemblyState,
): AssembledThermalSystem {
  const { grid } = problem;
  const cellCount = grid.nx * grid.ny * grid.nz;
  const faceG = new Float64Array(cellCount * 6);
  const faceNeighbor = new Int32Array(cellCount * 6).fill(-1);
  const faceRefT = new Float64Array(cellCount * 6);
  const sourceW = new Float64Array(cellCount);
  const diagonalBaseWPerK = new Float64Array(cellCount);
  const iterate = state.iterateK;
  const [dx, dy, dz] = grid.spacingM;
  const sx = dx ?? 1;
  const sy = dy ?? 1;
  const sz = dz ?? 1;
  const { nx, ny, nz, solid } = grid;
  const cellAt = (i: number, j: number, k: number): number =>
    i + j * nx + k * nx * ny;
  const strideFor = (axis: number): number =>
    axis === 0 ? 1 : axis === 1 ? nx : nx * ny;

  // --- Interior faces: harmonic-mean conductances ----------------------------
  for (let k = 0; k < nz; k += 1) {
    for (let j = 0; j < ny; j += 1) {
      for (let i = 0; i < nx; i += 1) {
        const cell = cellAt(i, j, k);
        if (solid[cell] !== 1) continue;
        const kP = problem.conductivityWPerMK[cell] ?? 0;
        for (let axis = 0; axis < 3; axis += 1) {
          const coordinate = axis === 0 ? i : axis === 1 ? j : k;
          const extent = axis === 0 ? nx : axis === 1 ? ny : nz;
          const area = axis === 0 ? sy * sz : axis === 1 ? sx * sz : sx * sy;
          const distance = axis === 0 ? sx : axis === 1 ? sy : sz;
          for (const sign of [-1, 1] as const) {
            const next = coordinate + sign;
            if (next < 0 || next >= extent) continue;
            const neighbour = cell + sign * strideFor(axis);
            if (solid[neighbour] !== 1) continue;
            const kN = problem.conductivityWPerMK[neighbour] ?? 0;
            const sum = kP + kN;
            const harmonic = sum > 0 ? (2 * kP * kN) / sum : 0;
            const slot = cell * 6 + axis * 2 + (sign < 0 ? 0 : 1);
            faceG[slot] = (harmonic * area) / distance;
            faceNeighbor[slot] = neighbour;
          }
        }
      }
    }
  }

  // --- The enclosure surface tables and their lagged T_enc -------------------
  const exposed = thermalExposedFaces(grid);
  const surfacesByEnclosure = new Map<
    number,
    { cell: number; areaM2: number; emissivity: number }[]
  >();
  for (const face of exposed) {
    if (face.kind !== "enclosure") continue;
    const emissivity = problem.emissivity[face.cell] ?? Number.NaN;
    const table = surfacesByEnclosure.get(face.enclosure) ?? [];
    table.push({
      cell: face.cell,
      areaM2: face.areaM2,
      emissivity: Number.isNaN(emissivity) ? 0 : emissivity,
    });
    surfacesByEnclosure.set(face.enclosure, table);
  }
  const enclosureIds = [...surfacesByEnclosure.keys()].sort((a, b) => a - b);
  const enclosures: ThermalEnclosureSurfaces[] = [];
  const enclosureTemperatureK: number[] = [];
  for (const id of enclosureIds) {
    const surfaces = surfacesByEnclosure.get(id) ?? [];
    enclosures.push({ id, surfaces });
    enclosureTemperatureK[id] = enclosureRadiosityTemperatureK(
      surfaces.map((surface) => ({
        areaM2: surface.areaM2,
        emissivity: surface.emissivity,
        temperatureK: iterate[surface.cell] ?? 0,
      })),
    );
  }

  // --- Sources and boundary faces ---------------------------------------------
  const volume = grid.cellVolumeM3;
  for (let cell = 0; cell < cellCount; cell += 1) {
    if (solid[cell] === 1) {
      sourceW[cell] = (problem.sourceWPerM3[cell] ?? 0) * volume;
    }
  }
  for (const face of exposed) {
    const resolved = resolveThermalFace(
      face,
      problem.ambient,
      problem.faceConditions,
    );
    const slot = face.cell * 6 + face.direction;
    const distance = face.axis === 0 ? sx : face.axis === 1 ? sy : sz;
    const cellK = problem.conductivityWPerMK[face.cell] ?? 0;
    switch (resolved.kind) {
      case "dirichlet": {
        faceG[slot] = (2 * cellK * face.areaM2) / distance;
        faceRefT[slot] = resolved.temperatureK;
        break;
      }
      case "neumann": {
        sourceW[face.cell] =
          (sourceW[face.cell] ?? 0) + resolved.fluxWPerM2 * face.areaM2;
        break;
      }
      case "ambient": {
        // The equilibrium boundary: convection against T_amb plus the
        // §7.12 radiation, combined into one conductance/reference pair
        // (the area-weighted environment of the two parallel channels).
        const gConv = resolved.heatTransferCoefficientWPerM2K * face.areaM2;
        let gRad = 0;
        let radiationEnvironmentK = resolved.ambientTemperatureK;
        if (problem.radiationMode !== "off") {
          const emissivity =
            resolved.emissivityOverride ??
            problem.emissivity[face.cell] ??
            Number.NaN;
          if (!Number.isNaN(emissivity)) {
            if (problem.radiationMode === "linearized") {
              gRad =
                linearizedRadiationCoefficientWPerM2K(
                  emissivity,
                  problem.radiationReferenceK,
                  resolved.ambientTemperatureK,
                ) * face.areaM2;
            } else {
              const tangent = tangentRadiationBoundary(
                emissivity,
                iterate[face.cell] ?? problem.radiationReferenceK,
                resolved.ambientTemperatureK,
              );
              gRad = tangent.coefficientWPerM2K * face.areaM2;
              radiationEnvironmentK = tangent.environmentK;
            }
          }
        }
        const total = gConv + gRad;
        faceG[slot] = total;
        faceRefT[slot] =
          total > 0
            ? (gConv * resolved.ambientTemperatureK +
                gRad * radiationEnvironmentK) /
              total
            : resolved.ambientTemperatureK;
        break;
      }
      case "enclosure": {
        if (problem.radiationMode !== "off") {
          const emissivity = problem.emissivity[face.cell] ?? Number.NaN;
          const tEnc = enclosureTemperatureK[resolved.enclosure] ?? Number.NaN;
          if (!Number.isNaN(emissivity) && !Number.isNaN(tEnc)) {
            if (problem.radiationMode === "linearized") {
              faceG[slot] =
                linearizedRadiationCoefficientWPerM2K(
                  emissivity,
                  problem.radiationReferenceK,
                  tEnc,
                ) * face.areaM2;
              faceRefT[slot] = tEnc;
            } else {
              const tangent = tangentRadiationBoundary(
                emissivity,
                iterate[face.cell] ?? problem.radiationReferenceK,
                tEnc,
              );
              faceG[slot] = tangent.coefficientWPerM2K * face.areaM2;
              faceRefT[slot] = tangent.environmentK;
            }
          }
        }
        break;
      }
      case "adiabatic":
        break;
    }
  }

  for (let cell = 0; cell < cellCount; cell += 1) {
    if (solid[cell] !== 1) continue;
    let sum = 0;
    for (let direction = 0; direction < 6; direction += 1) {
      sum += faceG[cell * 6 + direction] ?? 0;
    }
    diagonalBaseWPerK[cell] = sum;
  }

  return {
    cellCount,
    solid,
    faceG,
    faceNeighbor,
    faceRefT,
    sourceW,
    diagonalBaseWPerK,
    enclosures,
    enclosureTemperatureK,
  };
}
