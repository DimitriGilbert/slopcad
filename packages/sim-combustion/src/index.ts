/**
 * Public entry of `@slopcad/sim-combustion`, the thermochemistry
 * foundation package (ROADMAP-SIM Phase 68a): the curated NASA-7
 * species database (NASA Glenn coefficients, NASA TP-2002-211556,
 * cited per species block — see thermo-data.ts), the polynomial
 * evaluator in its exact published dimensionless forms (nasa7.ts),
 * the premixed fuel–air reactant streams with their fuel treatment
 * (inlet.ts), the element-potential Gibbs-minimization equilibrium
 * solver — TP and HP, the CEA formulation over an owned deterministic
 * Newton march with loud iteration-cap declines (equilibrium.ts) —
 * and the adiabatic-flame / fuel–air-table surface with its
 * deterministic CSV projection (flame.ts). The package depends on
 * `@slopcad/sim-core` and (since Phase 68c's stove coupling)
 * `@slopcad/sim-thermal`'s exported FVM doors at runtime — no React,
 * no DOM, no node APIs, never the LBM package (law S2), which is what
 * makes this CPU kernel the test truth
 * (law S5). Phase 68b's 0D reactor and engine cycle build on this
 * foundation; the flow heat-release coupling (68c) consumes it from
 * the sim-flow side.
 *
 * Phase 68b adds: the reduced one-step Arrhenius chemistry and the
 * shared induction-time definition (kinetics.ts), the
 * Metghalchi–Keck laminar flame-speed correlation (flame-speed.ts),
 * the 0D constant-volume reactor with its conservative-by-construction
 * energy audit (reactor.ts), the frozen/equilibrium working-gas
 * property machinery (gas-properties.ts), the slider-crank chamber
 * geometry pinned to the Phase 67 kinematics (engine-geometry.ts),
 * the two-zone 0D Otto closed cycle — Wiebe heat release grounded in
 * the flame-speed correlation, Woschni wall heat, Chen–Flynn brake
 * quantities, the closing energy audit, and the Livengood–Wu knock
 * integral (engine-cycle.ts) — and the compression-ratio /
 * equivalence-ratio / spark-timing sweeps (engine-sweeps.ts).
 *
 * Phase 68c adds the PRODUCT ENGINE behind the Phase 61 SimEngine
 * contract (sim-engine.ts): the combustion kind's two mode-locked
 * adapters — the 0D Otto cycle (the P-vs-crank histories plus the
 * indicated/brake/loss families side by side, the pressure-trace
 * preview round) and the stove with fire (the 68b reactor's
 * progress-variable wall heat coupled into the 65 implicit conduction
 * march over `@slopcad/sim-thermal`'s exported FVM pieces — the CHT
 * engine's own precedent, never the LBM package). The runtime
 * dependency set grows by exactly that: sim-core plus sim-thermal's
 * doors.
 */

export {
  GAS_CONSTANT_J_PER_MOL_K,
  type Nasa7Coefficients,
  type Nasa7Range,
  type Nasa7Species,
  NASA7_STANDARD_STATE_BAR,
  NASA7_T_MAX_K,
  NASA7_T_MIN_K,
  nasa7CpJPerMolK,
  nasa7CpOverR,
  nasa7EnthalpyJPerMol,
  nasa7EntropyJPerMolK,
  nasa7FittedSpanK,
  nasa7GOverRT,
  nasa7HOverRT,
  nasa7SOverR,
} from "./nasa7";
export {
  ATOMIC_WEIGHTS_KG_PER_KMOL,
  type ElementName,
  ELEMENTS,
  EQUILIBRIUM_SPECIES_NAMES,
  FUEL_SPECIES_NAMES,
  getSpecies,
  molecularWeightOf,
  NASA7_SPECIES,
  stoichiometricO2PerMol,
} from "./thermo-data";
export {
  DRY_AIR_MOLE_FRACTIONS,
  type ReactantMixture,
  MAX_EQUIVALENCE_RATIO,
  premixedFuelAirInlet,
} from "./inlet";
export {
  type EquilibriumResiduals,
  type EquilibriumSolution,
  type EquilibriumSolverOptions,
  solveEquilibriumHP,
  solveEquilibriumTP,
} from "./equilibrium";
export {
  type AdiabaticFlameResult,
  adiabaticFlame,
  exportFuelAirTableCsv,
  type FuelAirTable,
  type FuelAirTableRow,
  fuelAirTable,
} from "./flame";
export {
  type BurnedEquilibriumTable,
  buildBurnedEquilibriumTable,
  completeCombustionOf,
  type CompleteCombustionProducts,
  frozenCpJPerKgK,
  frozenCvJPerKgK,
  frozenEnthalpyJPerKg,
  frozenInternalEnergyJPerKg,
  frozenMixture,
  type FrozenMixture,
  frozenTemperatureFromInternalEnergyK,
  lowerHeatingValueJPerKg,
} from "./gas-properties";
export {
  getOneStepKinetics,
  IGNITION_THRESHOLD_FRACTION,
  ignitionDelaySeconds,
  KINETIC_FUEL_NAMES,
  oneStepRateMolPerM3S,
  ONE_STEP_KINETICS,
  type OneStepKinetics,
} from "./kinetics";
export {
  FLAME_SPEED_DILUTION_COEFFICIENT,
  FLAME_SPEED_FUEL_NAMES,
  laminarFlameSpeedMPerS,
  type LaminarFlameSpeedResult,
} from "./flame-speed";
export {
  type ReactorCombustionMode,
  type ReactorRunResult,
  type ReactorSample,
  runConstantVolumeReactor,
  type ReactorWallLoss,
} from "./reactor";
export {
  chamberVolumeM3,
  chamberVolumePerRad,
  chamberWallAreaM2,
  compileSliderCrankGeometry,
  compressionRatioOf,
  displacementM3,
  type SliderCrankGeometry,
  pistonAreaM2,
  pistonPinDistanceM,
  pistonPinTravelPerRad,
} from "./engine-geometry";
export {
  type BrakeFamily,
  type BurnModel,
  CHEN_FLYNN_DEFAULT,
  chenFlynnFmepBar,
  type ChenFlynnFriction,
  type CycleCombustionMode,
  DEFAULT_TURBULENCE_SPEED_MULTIPLIER,
  type EnergyAudit,
  type IndicatedFamily,
  type KnockReport,
  type OttoCycleResult,
  type OttoCycleScenario,
  runOttoCycle,
  type WiebeParameters,
  wiebeBurnedFraction,
  WIEBE_DEFAULT,
  WOSCHNI_C1_CLOSED,
  WOSCHNI_C2_BURNING,
  type CycleWallHeat,
  woschniHeatTransferCoefficientWPerM2K,
} from "./engine-cycle";
export {
  exportOttoSweepCsv,
  type OttoSweepKind,
  ottoCycleSweep,
  type OttoSweepResult,
  type OttoSweepRow,
} from "./engine-sweeps";
export {
  COMBUSTION_PREVIEW_CHUNK_MAX_VALUES,
  COMBUSTION_PRESSURE_TRACE_FIELD_ID,
  COMBUSTION_SIM_ENGINE_ID,
  COMBUSTION_SUPPORTED_KINDS,
  createCombustionSimEngine,
} from "./sim-engine";
