/**
 * The thermal boundary vocabulary (Phase 65a, the boundary-completeness
 * half): the three authored surface conditions the compile boundary
 * already speaks — Dirichlet (fixed temperature), Neumann (fixed heat
 * flux), convection to ambient with optional radiation — plus the
 * ambient default spec that completes EVERY remaining exposed face.
 * The completeness rule this package enforces at its problem door:
 *
 * - a face on the domain box boundary takes the condition authored for
 *   that domain face, when one exists;
 * - any other exposed exterior face (a body surface facing the domain's
 *   air) takes the scenario's ambient spec — the equilibrium boundary
 *   (§7.12): convection with h from the per-scenario field plus the
 *   Stefan–Boltzmann loss to T_amb under the problem's radiation mode;
 * - an exposed face with NEITHER an authored condition nor an ambient
 *   spec is adiabatic (the thermal symmetry plane — a legitimate,
 *   stated boundary, never a silent gap);
 * - enclosure faces (cavity walls) always take the §7.12 grey-diffuse
 *   enclosure exchange (`./radiation`); no authored condition reaches
 *   inside a cavity in this phase.
 *
 * The radiation MODE is a per-problem solver stance (off / linearized /
 * full — the roadmap's "standard linearized option for solver
 * friendliness"); the per-surface EMISSIVITY resolves at the problem
 * door from the condition's authored override or the material record's
 * Phase 61 field, declining loudly when neither exists.
 */

import type { SimDomainFace } from "@slopcad/sim-core";

/** The Stefan–Boltzmann treatments a problem may request for its radiating surfaces. */
export const THERMAL_RADIATION_MODES = ["off", "linearized", "full"] as const;

/** The Stefan–Boltzmann treatment a problem requests for its radiating surfaces. */
export type ThermalRadiationMode = (typeof THERMAL_RADIATION_MODES)[number];

/**
 * The ambient default — the equilibrium boundary's convection half plus
 * its radiation reference temperature (h per scenario field, §7.12).
 */
export interface ThermalAmbientSpec {
  /** The convection coefficient h, W/(m²·K); finite ≥ 0. */
  readonly heatTransferCoefficientWPerM2K: number;
  /** The ambient fluid temperature the surface exchanges with, K. */
  readonly ambientTemperatureK: number;
}

/** An authored surface condition (SI at this door, the compiled shapes). */
export type ThermalSurfaceCondition =
  | {
      /** Dirichlet: the fixed wall temperature, K. */
      readonly kind: "fixed-temperature";
      readonly temperatureK: number;
    }
  | {
      /** Neumann: the fixed heat flux, W/m², POSITIVE INTO the solid. */
      readonly kind: "heat-flux";
      readonly fluxWPerM2: number;
    }
  | {
      /** Convection to this condition's own ambient (§7.12 equilibrium). */
      readonly kind: "convection-ambient";
      readonly heatTransferCoefficientWPerM2K: number;
      readonly ambientTemperatureK: number;
      /** The per-surface emissivity override; defaults to the material's. */
      readonly emissivity?: number;
    };

/** One condition entry, addressed to a domain face (the compiled shape). */
export type ThermalFaceConditionEntry = ThermalSurfaceCondition & {
  readonly face: SimDomainFace;
};
