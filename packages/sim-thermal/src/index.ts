/**
 * Public entry of `@slopcad/sim-thermal`, the FVM conduction domain
 * package (ROADMAP-SIM Phase 65a): the cell-centred energy balance over
 * the Phase 62a voxel cells with per-cell materials from the extended
 * `DocumentMaterialRecord` (k always; ρc for the transient march;
 * emissivity for §7.12), the deterministic implicit steady solve
 * (Jacobi-preconditioned CG with a residual-driven discipline and loud
 * iteration-cap
 * declines, Picard-lagged radiation) and the explicit/implicit
 * transient march (stability-disciplined dt from the diffusivity row
 * sum), the boundary completeness set — Dirichlet, Neumann,
 * convection-to-ambient with the per-scenario h, surface-to-ambient
 * Stefan–Boltzmann (full quartic and the standard linearized option),
 * and the grey-diffuse uniform-radiosity enclosure exchange — the
 * energy-conservation audit, the S9 regime wiring (Prandtl always,
 * Rayleigh under the 61a ΔT magnitude rule), and the run driver +
 * SimResult seam that projects through the one S4 boundary. The
 * package depends on `@slopcad/sim-core` alone at runtime — no React,
 * no DOM, no node APIs (law S2), which is what makes this CPU kernel
 * the test truth (law S5). The conjugate coupling to the flow field
 * (Boussinesq buoyancy, conservative interpolation at fluid–solid
 * voxels) is Phase 65b's, on top of these doors.
 */

export {
  type ThermalSolidMaterial,
  thermalSolidMaterialFromRecord,
} from "./material";
export {
  type ThermalCellGrid,
  type ThermalExposedFace,
  THERMAL_FACE_DIRECTIONS,
  thermalCellGrid,
  thermalDomainFaceOfDirection,
  thermalExposedFaces,
  thermalFaceAreaM2,
} from "./grid";
export {
  type ThermalAmbientSpec,
  type ThermalFaceConditionEntry,
  type ThermalRadiationMode,
  type ThermalSurfaceCondition,
  THERMAL_RADIATION_MODES,
} from "./boundaries";
export {
  STEFAN_BOLTZMANN_W_PER_M2_K4,
  type EnclosureRadiositySurface,
  enclosureNetExchangeW,
  enclosureRadiosityTemperatureK,
  linearizedRadiationCoefficientWPerM2K,
  stefanBoltzmannFluxWPerM2,
} from "./radiation";
export {
  type AssembledThermalSystem,
  type ResolvedThermalFace,
  type ThermalAssemblyState,
  type ThermalEnclosureSurfaces,
  type ThermalProblem,
  assembleThermalSystem,
  resolveThermalFace,
} from "./system";
export {
  type ThermalSolverCapacity,
  type ThermalSolverOptions,
  type ThermalSolverOutcome,
  solveThermalSystem,
  thermalSolverOptionsProblem,
} from "./solver";
export {
  type ThermalBoundaryFluxLedger,
  type ThermalEnclosureFacts,
  thermalBoundaryFluxLedger,
  thermalEnclosureFacts,
} from "./audit";
export {
  THERMAL_STEADY_DEFAULTS,
  type ResolvedThermalSteadySpec,
  type ThermalSteadyOutcome,
  type ThermalSteadySpec,
  resolveThermalSteadySpec,
  solveThermalSteady,
} from "./steady";
export {
  THERMAL_HISTORY_SERIES_NAMES,
  THERMAL_HISTORY_UNIT,
  THERMAL_TRANSIENT_DEFAULTS,
  type ResolvedThermalTransientSpec,
  type ThermalTransientOutcome,
  type ThermalTransientSpec,
  marchThermalTransient,
  resolveThermalTransientSpec,
  thermalCellCapacityJPerK,
  thermalExplicitStabilityTimeStepS,
} from "./transient";
export {
  type ThermalRunGridFacts,
  type ThermalRunReport,
  type ThermalRunScenario,
  type ThermalRunTemperatures,
  runThermalScenario,
  thermalRunSimResult,
} from "./run";
export {
  THERMAL_PREVIEW_CHUNK_MAX_VALUES,
  THERMAL_SIM_ENGINE_ID,
  THERMAL_SUPPORTED_KINDS,
  createThermalSimEngine,
  thermalPublishPreview,
} from "./engine";
