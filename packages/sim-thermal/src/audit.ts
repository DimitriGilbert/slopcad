/**
 * The energy-conservation audit (Phase 65a's closed-domain ledger):
 * every boundary flux of the solid region, evaluated from a temperature
 * field under BOTH laws — the law the MARCH used (so the ledger closes
 * on the march's own algebra: the conservation proof) and the full
 * Stefan–Boltzmann quartic (the §7.12 honesty delta: a linearized
 * solve balances its linearized law, and the full-law net states how
 * far that is from the exact quartic — the linearized-vs-full
 * cross-check's number).
 *
 * The steady closure the roadmap pins: at a converged field,
 * sourceW + neumannInW + dirichletNetW − convectionOutW − radiationOutW
 * ≈ 0 to solver tolerance (exact for the "off" and "full" modes; the
 * linearization residual itself in "linearized" mode). The transient
 * closure — Σ dt·(in − out) = Σ ρcV·ΔT — is exact by construction of
 * the march (`./transient` accumulates it substep by substep).
 *
 * The enclosure exchange conserves IDENTICALLY inside each enclosure
 * under the quartic law (Σ q_i = 0 by the T_enc construction,
 * `./radiation`); the audit measures the imbalance with that law so the
 * property is proven, not assumed. The linearized mode's enclosure net
 * carries its own small linearization residual, like every other
 * linearized term.
 */

import type { ThermalProblem } from "./system";

import { resolveThermalFace } from "./system";
import { thermalExposedFaces } from "./grid";
import {
  enclosureNetExchangeW,
  linearizedRadiationCoefficientWPerM2K,
  stefanBoltzmannFluxWPerM2,
} from "./radiation";

/** The boundary flux ledger, all watts, signed as named. */
export interface ThermalBoundaryFluxLedger {
  /** Σ q'''·V over solid cells (signed; + heats). */
  readonly sourceW: number;
  /** Σ flux·A over Neumann faces (signed; + into the solid). */
  readonly neumannInW: number;
  /** Σ (k·A/(d/2))·(T_wall − T_cell) over Dirichlet faces (signed; + into the solid). */
  readonly dirichletNetW: number;
  /** Σ h·A·(T_cell − T_amb) over convection faces (+ = out of the solid). */
  readonly convectionOutW: number;
  /** Σ ε·σ·A·(T⁴ − T_amb⁴) over radiating ambient faces under the MARCH's law (+ = out). */
  readonly radiationOutW: number;
  /**
   * |Σ enclosure net exchange| — 0 identically under the quartic law
   * (the full mode's truth); measured, never assumed.
   */
  readonly enclosureImbalanceW: number;
  /** The march-law closure: in − out (≈ 0 at a converged steady field). */
  readonly netW: number;
  /** The full-quartic law's net on the same field — the linearization honesty delta. */
  readonly fullLawNetW: number;
}

/** The ledger inputs: the problem plus the field to audit. */
export interface ThermalAuditInput {
  readonly problem: ThermalProblem;
  readonly temperatureK: Float64Array;
}

/**
 * Walks every exposed face once, resolving each through the shared
 * boundary rule and evaluating both laws at the given field. Pure and
 * deterministic.
 */
export function thermalBoundaryFluxLedger(
  input: ThermalAuditInput,
): ThermalBoundaryFluxLedger {
  const { problem, temperatureK } = input;
  const { grid } = problem;
  const [dx, dy, dz] = grid.spacingM;
  const spacing = [dx ?? 1, dy ?? 1, dz ?? 1] as const;
  const exposed = thermalExposedFaces(grid);

  const enclosureSurfaces = new Map<
    number,
    { areaM2: number; emissivity: number; temperatureK: number }[]
  >();
  for (const face of exposed) {
    if (face.kind !== "enclosure") continue;
    const emissivity = problem.emissivity[face.cell] ?? Number.NaN;
    const table = enclosureSurfaces.get(face.enclosure) ?? [];
    table.push({
      areaM2: face.areaM2,
      emissivity: Number.isNaN(emissivity) ? 0 : emissivity,
      temperatureK: temperatureK[face.cell] ?? 0,
    });
    enclosureSurfaces.set(face.enclosure, table);
  }

  let sourceW = 0;
  let neumannInW = 0;
  let dirichletNetW = 0;
  let convectionOutW = 0;
  let marchRadiationOutW = 0;
  let fullLawRadiationOutW = 0;

  for (let cell = 0; cell < grid.nx * grid.ny * grid.nz; cell += 1) {
    if (grid.solid[cell] === 1) {
      sourceW += (problem.sourceWPerM3[cell] ?? 0) * grid.cellVolumeM3;
    }
  }

  for (const face of exposed) {
    const resolved = resolveThermalFace(
      face,
      problem.ambient,
      problem.faceConditions,
    );
    const cellK = temperatureK[face.cell] ?? 0;
    const distance = spacing[face.axis] ?? 1;
    switch (resolved.kind) {
      case "dirichlet": {
        const conductance =
          (2 * (problem.conductivityWPerMK[face.cell] ?? 0) * face.areaM2) /
          distance;
        dirichletNetW += conductance * (resolved.temperatureK - cellK);
        break;
      }
      case "neumann": {
        neumannInW += resolved.fluxWPerM2 * face.areaM2;
        break;
      }
      case "ambient": {
        convectionOutW +=
          resolved.heatTransferCoefficientWPerM2K *
          face.areaM2 *
          (cellK - resolved.ambientTemperatureK);
        if (problem.radiationMode !== "off") {
          const emissivity =
            resolved.emissivityOverride ??
            problem.emissivity[face.cell] ??
            Number.NaN;
          if (!Number.isNaN(emissivity)) {
            const quartic =
              stefanBoltzmannFluxWPerM2(
                emissivity,
                cellK,
                resolved.ambientTemperatureK,
              ) * face.areaM2;
            fullLawRadiationOutW += quartic;
            marchRadiationOutW +=
              problem.radiationMode === "linearized"
                ? linearizedRadiationCoefficientWPerM2K(
                    emissivity,
                    problem.radiationReferenceK,
                    resolved.ambientTemperatureK,
                  ) *
                  face.areaM2 *
                  (cellK - resolved.ambientTemperatureK)
                : quartic;
          }
        }
        break;
      }
      case "enclosure":
      case "adiabatic":
        break;
    }
  }

  let enclosureImbalanceW = 0;
  if (problem.radiationMode !== "off") {
    for (const surfaces of enclosureSurfaces.values()) {
      let sum = 0;
      for (const exchange of enclosureNetExchangeW(surfaces)) {
        sum += exchange;
      }
      enclosureImbalanceW += Math.abs(sum);
    }
  }

  const netW =
    sourceW + neumannInW + dirichletNetW - convectionOutW - marchRadiationOutW;
  const fullLawNetW =
    sourceW +
    neumannInW +
    dirichletNetW -
    convectionOutW -
    fullLawRadiationOutW;
  return {
    sourceW,
    neumannInW,
    dirichletNetW,
    convectionOutW,
    radiationOutW: marchRadiationOutW,
    enclosureImbalanceW,
    netW,
    fullLawNetW,
  };
}

/** Per-enclosure report facts for the run report. */
export interface ThermalEnclosureFacts {
  readonly id: number;
  /** The cavity's cell count. */
  readonly cellCount: number;
  /** The total exchanging surface area, m². */
  readonly surfaceAreaM2: number;
  /** The uniform-radiosity enclosure temperature, K (NaN when nothing exchanges). */
  readonly temperatureK: number;
}

/** The enclosure facts of a field: areas, cell counts, and each T_enc. */
export function thermalEnclosureFacts(
  problem: ThermalProblem,
  temperatureK: Float64Array,
): readonly ThermalEnclosureFacts[] {
  const { grid } = problem;
  const cellCounts = new Map<number, number>();
  for (let cell = 0; cell < grid.nx * grid.ny * grid.nz; cell += 1) {
    const enclosure = grid.cavityOf[cell] ?? -1;
    if (enclosure >= 0) {
      cellCounts.set(enclosure, (cellCounts.get(enclosure) ?? 0) + 1);
    }
  }
  const surfacesByEnclosure = new Map<
    number,
    { areaM2: number; emissivity: number; temperatureK: number }[]
  >();
  for (const face of thermalExposedFaces(grid)) {
    if (face.kind !== "enclosure") continue;
    const emissivity = problem.emissivity[face.cell] ?? Number.NaN;
    const table = surfacesByEnclosure.get(face.enclosure) ?? [];
    table.push({
      areaM2: face.areaM2,
      emissivity: Number.isNaN(emissivity) ? 0 : emissivity,
      temperatureK: temperatureK[face.cell] ?? 0,
    });
    surfacesByEnclosure.set(face.enclosure, table);
  }
  const ids = [...surfacesByEnclosure.keys()].sort((a, b) => a - b);
  return ids.map((id) => {
    const surfaces = surfacesByEnclosure.get(id) ?? [];
    let area = 0;
    let weight = 0;
    let quartic = 0;
    for (const surface of surfaces) {
      area += surface.areaM2;
      const w = surface.emissivity * surface.areaM2;
      weight += w;
      quartic += w * surface.temperatureK ** 4;
    }
    return {
      id,
      cellCount: cellCounts.get(id) ?? 0,
      surfaceAreaM2: area,
      temperatureK: weight > 0 ? (quartic / weight) ** 0.25 : Number.NaN,
    };
  });
}
