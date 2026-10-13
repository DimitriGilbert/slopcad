/**
 * The conjugate-heat-transfer coupled march (Phase 65b's orchestration
 * half): flow, fluid thermal field, and solid conduction advanced in
 * LOCKSTEP at matched physical time, one coupling interval at a time —
 *
 *   1. FLOW — `couplingIntervalSteps` LBM steps with the Boussinesq
 *      force (`./buoyancy`) read from the shared temperature field
 *      every step (Guo forcing in the collision, `./relaxation`);
 *   2. FLUID THERMAL — the passive scalar (`./thermal-scalar`)
 *      substeps to the SAME physical interval Δ under the end-of-
 *      interval velocity snapshot (the documented lag: advection is
 *      frozen within an interval), its interface faces diffusing
 *      against the solid columns frozen at the interval start — the
 *      advection carries the Boussinesq deviation T − T_ref, the
 *      stability statement `./thermal-scalar`'s header derives (the
 *      absolute-kelvin baseline must never meet a velocity
 *      difference; measured, it closed an exponential buoyancy loop);
 *   3. SOLID — the Phase 65a FVM solve over Δ (backward Euler through
 *      the solver's capacity mechanism), its interface exchange the
 *      EXACT joules the scalar accumulated at those faces: what the
 *      fluid gained, the solid's source loses — the conservative
 *      exchange the roadmap's risk note names as the default answer.
 *
 * ## The energy ledger (conservation by construction)
 *
 * The books close identically, per interval and over the run:
 *
 *   fluidΔE + solidΔE ≡ Σdt·(fluid wall fluxes) + Σdt·(solid boundary
 *   fluxes) + Σdt·(solid sources),
 *
 * because every other term cancels pairwise — internal fluid faces
 * carry one flux applied to both cells, and the CHT interface flux is
 * ONE accumulated number subtracted from the solid solve's source.
 * The closure is MEASURED, never assumed: the report's ledger carries
 * the residual, and the closed-domain fixture pins it at solver
 * tolerance (the 65a transient-march discipline, extended across the
 * coupling).
 *
 * ## The solid-side door (consuming the 65a APIs, never reworking them)
 *
 * The 2D lattice mask becomes the 65a conduction grid as the UNIT-
 * DEPTH SLAB `[nx, ny, 1]` with spacing `[dx, dx, 1 m]` — every
 * joule, watt and capacity in this module is PER METRE OF DEPTH, the
 * same convention the flow kernel's forces use (N per metre). The
 * slab's front and back faces are the zMin/zMax domain faces and
 * default adiabatic (the stated 2D boundary); the outer in-plane
 * walls take the authored `solidFaceConditions`. Radiation is OFF in
 * the coupling (the §7.12 equilibrium surfaces are the standalone
 * 65a run door's; a coupled radiating surface is a later phase's
 * honest raise). The system assembles through
 * `assembleThermalSystem` verbatim; the interface faces it leaves at
 * zero conductance are completed NOT as conductances but as the
 * accumulated interface source on the assembled source vector — the
 * frozen-flux explicit exchange whose stability limit is the fluid
 * cell's own row sum, where the harmonic-mean interface conductance
 * is fluid-side-dominated at real material contrasts (the physical
 * reason the stove's steel-versus-air contrast is gentle, pinned by
 * the stability fixture).
 *
 * ## S9 (regime honesty)
 *
 * Prandtl ALWAYS; Rayleigh whenever the buoyancy gate's inputs exist
 * (the 61a ΔT rule: the largest |T − T_ref| over the fixed-temperature
 * walls, scalar and solid faces alike); Reynolds and Mach at the
 * characteristic velocity — the buoyancy velocity scale √(g·β·ΔT·L)
 * the scenario supplies. Flags advisory, never gates — the same
 * `SIM_REGIME_THRESHOLDS` source as every other domain.
 *
 * Determinism (law S2): fixed interval arithmetic, the 63a stepper
 * and the 65a solver's own disciplines underneath, no clocks, no
 * randomness — the same scenario marches bitwise-identically (pinned
 * by test).
 */

import {
  type SimDomainFace,
  type SimError,
  type SimFluidState,
  SIM_ERROR_CODES,
  type SimHistorySeries,
  type SimOccupancyGrid,
  type SimParseResult,
  type SimRegimeReport,
  type SolverSimField,
  simError,
  simFail,
  simMach,
  simOk,
  simPrandtl,
  simRayleigh,
  simRegimeReport,
  simReynolds,
} from "@slopcad/sim-core";
import type {
  ThermalProblem,
  ThermalSurfaceCondition,
} from "@slopcad/sim-thermal";
import {
  assembleThermalSystem,
  solveThermalSystem,
  thermalBoundaryFluxLedger,
  thermalCellCapacityJPerK,
  thermalCellGrid,
} from "@slopcad/sim-thermal";
import type { LbmCollisionModel } from "./relaxation";
import type { LbmFaceSpec, LbmStepper } from "./stepper";
import type { LbmSolidMask } from "./state";

import { createLbmStepper } from "./stepper";
import {
  createLbmThermalScalar,
  type LbmThermalFaceCondition,
  type LbmThermalScalar,
} from "./thermal-scalar";

/** The scalar's explicit-substep safety factor default (the 65a precedent). */
export const CHT_SCALAR_SAFETY_DEFAULT = 0.5;

/** The solid CG discipline defaults (the 65a transient precedent). */
export const CHT_SOLID_DEFAULTS = Object.freeze({
  toleranceK: 1e-10,
  maxIterations: 20_000,
});

/** The CHT histories' series names (one sample per interval, t = 0 included). */
export const CHT_HISTORY_SERIES = {
  fluidTemperatureMean: "fluid-temperature-mean",
  fluidSpeedMax: "fluid-speed-max",
  solidTemperatureMean: "solid-temperature-mean",
} as const;

const CHT_HISTORY_UNIT = { temperature: "K", speed: "m/s" } as const;

/** What {@link runChtScenario} consumes — SI at the door, law S4. */
export interface ChtScenario {
  readonly name: string;
  readonly mask: LbmSolidMask;
  /** The lattice cell size, m. */
  readonly cellSizeM: number;
  /** The compiled fluid state (ρ₀, ν, α, k, cp, β — the Phase 61 spine's). */
  readonly fluid: SimFluidState;
  /**
   * The characteristic velocity scale, m/s — for buoyant scenarios the
   * buoyancy velocity √(g·β·ΔT·L): the closure's low-Mach reference.
   */
  readonly characteristicVelocityMPerS: number;
  /** The characteristic lattice velocity (default 0.05). */
  readonly latticeVelocity?: number;
  /** The collision model (default TRT, the stability knob). */
  readonly collision?: LbmCollisionModel;
  /** The four flow face specs (the 63a vocabulary — walls for a cavity). */
  readonly flowFaces: Readonly<
    Record<"west" | "east" | "south" | "north", LbmFaceSpec>
  >;
  /** The four scalar wall conditions (Dirichlet/adiabatic). */
  readonly thermalFaces: Readonly<
    Record<"west" | "east" | "south" | "north", LbmThermalFaceCondition>
  >;
  /** The scenario gravity vector, m/s² (the Phase 61 spine's). */
  readonly gravityMPerS2: readonly [number, number];
  /** The Boussinesq reference temperature T_ref, K — buoyancy's linearization point and the scalar advection's zero. */
  readonly referenceTemperatureK: number;
  /** Per-node solid conductivity, W/(m·K) (read at solid cells). */
  readonly solidConductivityWPerMK: Float64Array;
  /** Per-node solid volumetric heat capacity ρc, J/(m³·K) (solid cells). */
  readonly solidVolumetricHeatCapacityJPerM3K: Float64Array;
  /** Per-node volumetric heat source, W/m³ (signed; + heats a solid). */
  readonly sourceWPerM3?: Float64Array;
  /** Authored conditions on the solid slab's outer domain faces. */
  readonly solidFaceConditions?: Readonly<
    Partial<Record<SimDomainFace, ThermalSurfaceCondition>>
  >;
  /** The uniform initial temperature, K. */
  readonly initialTemperatureK: number;
  /** The characteristic length the S9 numbers are formed with, m. */
  readonly characteristicLengthM: number;
  /** Flow steps per coupling interval (≥ 1). */
  readonly couplingIntervalSteps: number;
  /** Coupling intervals in the run (≥ 1). */
  readonly intervals: number;
  /** The scalar's explicit-substep safety factor (default 0.5). */
  readonly scalarSafetyFactor?: number;
  /** The solid CG residual tolerance, K (default 1e-10). */
  readonly solidToleranceK?: number;
  /** The solid CG iteration cap (default 20 000). */
  readonly solidMaxIterations?: number;
}

/** The measured conservation audit — the ledger discipline's report. */
export interface ChtEnergyLedger {
  /** ρ₀cpV·Σ(T_end − T_0) over fluid cells, J/m. */
  readonly fluidChangeJPerM: number;
  /** ρcV·Σ(T_end − T_0) over solid cells, J/m. */
  readonly solidChangeJPerM: number;
  /** Σdt·Q over the scalar's domain-wall faces (positive = into fluid), J/m. */
  readonly fluidBoundaryInJPerM: number;
  /** Σdt·(Dirichlet + Neumann) over the solid's outer faces, J/m. */
  readonly solidBoundaryInJPerM: number;
  /** Σdt·q'''V over solid cells (the authored sources), J/m. */
  readonly solidSourceJPerM: number;
  /** fluidChange + solidChange − boundaries − sources ≈ 0 (measured). */
  readonly closureJPerM: number;
}

/** One completed (or honestly diverged) coupled run. */
export interface ChtRunReport {
  readonly scenarioName: string;
  readonly regime: SimRegimeReport;
  readonly steps: number;
  readonly intervals: number;
  readonly physicalDurationS: number;
  readonly diverged: boolean;
  /** Which leg froze (the honest record of what happened). */
  readonly divergence: { readonly flow: boolean; readonly thermal: boolean };
  readonly grid: {
    readonly nx: number;
    readonly ny: number;
    readonly cellSizeM: number;
    readonly timeStepS: number;
  };
  readonly temperature: {
    readonly fluidMeanK: number;
    readonly fluidMinK: number;
    readonly fluidMaxK: number;
    readonly solidMeanK: number | null;
  };
  /**
   * The flow velocity/pressure fields plus the shared temperature
   * field (S4-ready); empty on a diverged run — no fabricated fields.
   */
  readonly fields: readonly SolverSimField[];
  readonly histories: readonly SimHistorySeries[];
  readonly ledger: ChtEnergyLedger;
}

function fail(message: string, at: unknown): SimParseResult<never, SimError> {
  return simFail(simError(SIM_ERROR_CODES.scenarioInvalid, message, at));
}

/** Σ ρcV·(T − T_initial) over solid cells — the stored-energy measure, J/m. */
function solidStoredJPerM(
  capacityJPerK: Float64Array,
  temperatureK: Float64Array,
  initialK: number,
  mask: LbmSolidMask,
): number {
  let total = 0;
  for (let index = 0; index < mask.solid.length; index += 1) {
    if (mask.solid[index] !== 1) continue;
    total +=
      (capacityJPerK[index] ?? 0) * ((temperatureK[index] ?? 0) - initialK);
  }
  return total;
}

/**
 * The ΔT scale of the 61a rule: the largest |T − T_ref| over every
 * fixed-temperature wall the scenario authors — the scalar's four
 * faces and the solid slab's outer faces alike. None authored → the
 * buoyancy gate stays closed (Ra absent, Pr still reported).
 */
function deltaTemperatureScaleK(scenario: ChtScenario): number | undefined {
  const candidates: number[] = [];
  for (const face of [
    scenario.thermalFaces.west,
    scenario.thermalFaces.east,
    scenario.thermalFaces.south,
    scenario.thermalFaces.north,
  ] as const) {
    if (face.kind === "fixed-temperature") candidates.push(face.temperatureK);
  }
  for (const condition of Object.values(scenario.solidFaceConditions ?? {})) {
    if (condition?.kind === "fixed-temperature") {
      candidates.push(condition.temperatureK);
    }
  }
  if (candidates.length === 0) return undefined;
  let scale = 0;
  for (const value of candidates) {
    const magnitude = Math.abs(value - scenario.referenceTemperatureK);
    if (magnitude > scale) scale = magnitude;
  }
  return scale;
}

/**
 * Runs one coupled CHT scenario to its interval budget. Every decline
 * is loud and structured: the flow door's own refusals ride through,
 * the scalar's and the solid solver's likewise, and this door adds
 * the coupling-shape checks (interval counts, per-node array shapes,
 * the ρc-on-every-solid-cell requirement the implicit solid march
 * needs).
 */
export function runChtScenario(
  scenario: ChtScenario,
): SimParseResult<ChtRunReport, SimError> {
  const { mask } = scenario;
  const count = mask.nx * mask.ny;
  if (typeof scenario.name !== "string" || scenario.name.length === 0) {
    return fail("A CHT scenario must carry a non-empty name.", scenario.name);
  }
  if (
    !Number.isInteger(scenario.couplingIntervalSteps) ||
    scenario.couplingIntervalSteps < 1
  ) {
    return fail(
      `A CHT scenario's coupling interval must be a positive integer of flow steps, received ${String(scenario.couplingIntervalSteps)}.`,
      scenario.couplingIntervalSteps,
    );
  }
  if (!Number.isInteger(scenario.intervals) || scenario.intervals < 1) {
    return fail(
      `A CHT scenario's interval count must be a positive integer, received ${String(scenario.intervals)}.`,
      scenario.intervals,
    );
  }
  for (const [name, field] of [
    ["solid conductivity", scenario.solidConductivityWPerMK],
    [
      "solid volumetric heat capacity",
      scenario.solidVolumetricHeatCapacityJPerM3K,
    ],
    ["volumetric source", scenario.sourceWPerM3],
  ] as const) {
    if (field === undefined) continue;
    if (!(field instanceof Float64Array) || field.length !== count) {
      return fail(
        `A CHT scenario's ${name} array must be a Float64Array of exactly ${String(count)} values, received ${String(field.length)}.`,
        field.length,
      );
    }
  }
  for (let index = 0; index < count; index += 1) {
    if (mask.solid[index] !== 1) continue;
    const k = scenario.solidConductivityWPerMK[index] ?? 0;
    if (!Number.isFinite(k) || k < 0) {
      return fail(
        `A CHT scenario's solid conductivities must be finite ≥ 0, received ${String(k)} at node ${String(index)}.`,
        index,
      );
    }
    const rhoC =
      scenario.solidVolumetricHeatCapacityJPerM3K[index] ?? Number.NaN;
    if (!Number.isFinite(rhoC) || rhoC <= 0) {
      return fail(
        `The coupled solid march needs ρc on every solid cell (the implicit capacity), and node ${String(index)} carries ${String(rhoC)} J/(m³·K).`,
        index,
      );
    }
  }
  const gravity = scenario.gravityMPerS2;
  if (
    !Number.isFinite(gravity[0]) ||
    !Number.isFinite(gravity[1]) ||
    !Number.isFinite(scenario.referenceTemperatureK) ||
    scenario.referenceTemperatureK <= 0
  ) {
    return fail(
      "A CHT scenario needs a finite gravity vector and a positive finite reference temperature for the Boussinesq coupling.",
      { gravity, referenceTemperatureK: scenario.referenceTemperatureK },
    );
  }

  // --- The three solvers, one shared temperature field -------------------
  const scalarCreated = createLbmThermalScalar({
    mask,
    cellSizeM: scenario.cellSizeM,
    referenceDensityKgPerM3: scenario.fluid.densityKgPerM3,
    referenceTemperatureK: scenario.referenceTemperatureK,
    specificHeatJPerKgK: scenario.fluid.specificHeatJPerKgK,
    thermalConductivityWPerMK: scenario.fluid.thermalConductivityWPerMK,
    solidConductivityWPerMK: scenario.solidConductivityWPerMK,
    initialTemperatureK: scenario.initialTemperatureK,
    west: scenario.thermalFaces.west,
    east: scenario.thermalFaces.east,
    south: scenario.thermalFaces.south,
    north: scenario.thermalFaces.north,
  });
  if (!scalarCreated.ok) return scalarCreated;
  const scalar: LbmThermalScalar = scalarCreated.value;
  const stepperCreated = createLbmStepper({
    mask,
    fluid: scenario.fluid,
    cellSizeM: scenario.cellSizeM,
    characteristicVelocityMPerS: scenario.characteristicVelocityMPerS,
    ...(scenario.latticeVelocity === undefined
      ? {}
      : { latticeVelocity: scenario.latticeVelocity }),
    ...(scenario.collision === undefined
      ? {}
      : { collision: scenario.collision }),
    west: scenario.flowFaces.west,
    east: scenario.flowFaces.east,
    south: scenario.flowFaces.south,
    north: scenario.flowFaces.north,
    buoyancy: {
      gravityMPerS2: gravity,
      thermalExpansionPerK: scenario.fluid.thermalExpansionPerK,
      referenceTemperatureK: scenario.referenceTemperatureK,
      temperatureK: scalar.temperatureK,
    },
  });
  if (!stepperCreated.ok) return stepperCreated;
  const stepper: LbmStepper = stepperCreated.value;

  // --- The solid problem (the 65a door, unit-depth slab) -----------------
  const gridInput: SimOccupancyGrid = {
    semantic: "occupancy",
    name: `${scenario.name}-solid-slab`,
    shape: [mask.nx, mask.ny, 1],
    originM: [0, 0, 0],
    spacingM: [scenario.cellSizeM, scenario.cellSizeM, 1],
    cells: mask.solid,
  };
  const gridCreated = thermalCellGrid(gridInput);
  if (!gridCreated.ok) return gridCreated;
  const grid = gridCreated.value;
  const problem: ThermalProblem = {
    grid,
    conductivityWPerMK: scenario.solidConductivityWPerMK,
    volumetricHeatCapacityJPerM3K: scenario.solidVolumetricHeatCapacityJPerM3K,
    emissivity: new Float64Array(count).fill(Number.NaN),
    sourceWPerM3: scenario.sourceWPerM3 ?? new Float64Array(count),
    ambient: undefined,
    faceConditions: scenario.solidFaceConditions ?? {},
    radiationMode: "off",
    radiationReferenceK: scenario.initialTemperatureK,
  };
  const solidCapacityJPerK = thermalCellCapacityJPerK(problem);
  const solverOptions = {
    toleranceK: scenario.solidToleranceK ?? CHT_SOLID_DEFAULTS.toleranceK,
    maxIterations:
      scenario.solidMaxIterations ?? CHT_SOLID_DEFAULTS.maxIterations,
  };
  const scalarSafety = scenario.scalarSafetyFactor ?? CHT_SCALAR_SAFETY_DEFAULT;

  // --- The S9 report (compile-time honesty, the sim-core source) ---------
  const deltaT = deltaTemperatureScaleK(scenario);
  const gravityMagnitude = Math.hypot(gravity[0], gravity[1]);
  const regime: SimRegimeReport = simRegimeReport({
    reynolds: simReynolds(
      scenario.fluid.densityKgPerM3,
      scenario.characteristicVelocityMPerS,
      scenario.characteristicLengthM,
      scenario.fluid.dynamicViscosityPaS,
    ),
    mach: simMach(
      scenario.characteristicVelocityMPerS,
      scenario.fluid.speedOfSoundMPerS,
    ),
    prandtl: simPrandtl(
      scenario.fluid.dynamicViscosityPaS,
      scenario.fluid.specificHeatJPerKgK,
      scenario.fluid.thermalConductivityWPerMK,
    ),
    ...(deltaT === undefined
      ? {}
      : {
          rayleigh: simRayleigh(
            gravityMagnitude,
            scenario.fluid.thermalExpansionPerK,
            deltaT,
            scenario.characteristicLengthM,
            scenario.fluid.kinematicViscosityM2PerS,
            scenario.fluid.thermalDiffusivityM2PerS,
          ),
        }),
  });

  // --- The coupled march --------------------------------------------------
  const dtFlow = stepper.meta.units.timeStepS;
  const intervalS = scenario.couplingIntervalSteps * dtFlow;
  const fluidMeanSamples: number[] = [];
  const fluidSpeedMaxSamples: number[] = [];
  const solidMeanSamples: number[] = [];
  let solidCellCount = 0;
  for (let index = 0; index < count; index += 1) {
    if (mask.solid[index] === 1) solidCellCount += 1;
  }
  let flowDiverged = false;
  let thermalDiverged = false;
  let completedIntervals = 0;
  let solidBoundaryLedgerJPerM = 0;
  let solidSourceLedgerJPerM = 0;

  const sample = (): void => {
    let fluidSum = 0;
    let fluidCount = 0;
    let speedMax = 0;
    const snapshot = stepper.snapshotSI();
    for (let index = 0; index < count; index += 1) {
      if (mask.solid[index] === 1) continue;
      fluidSum += scalar.temperatureK[index] ?? 0;
      fluidCount += 1;
      const vx = snapshot.velocityXMPerS[index] ?? 0;
      const vy = snapshot.velocityYMPerS[index] ?? 0;
      const speed = Math.sqrt(vx * vx + vy * vy);
      if (speed > speedMax) speedMax = speed;
    }
    let solidSum = 0;
    for (let index = 0; index < count; index += 1) {
      if (mask.solid[index] !== 1) continue;
      solidSum += scalar.temperatureK[index] ?? 0;
    }
    fluidMeanSamples.push(fluidCount > 0 ? fluidSum / fluidCount : Number.NaN);
    fluidSpeedMaxSamples.push(speedMax);
    if (solidCellCount > 0) solidMeanSamples.push(solidSum / solidCellCount);
  };

  sample();
  const fluidEnergy0 = scalar.fluidEnergyJPerM(scenario.initialTemperatureK);
  const solidEnergy0 = solidStoredJPerM(
    solidCapacityJPerK,
    scalar.temperatureK,
    scenario.initialTemperatureK,
    mask,
  );

  for (let interval = 0; interval < scenario.intervals; interval += 1) {
    if (flowDiverged || thermalDiverged) break;
    const exchangeBefore = scalar.interfaceExchangeJPerM();

    // 1. Flow: the interval's buoyant steps.
    stepper.run(scenario.couplingIntervalSteps);
    if (stepper.diverged) {
      flowDiverged = true;
      break;
    }

    // 2. Fluid thermal: substeps to the same physical interval under
    // the end-of-interval velocity snapshot.
    const velocities = stepper.snapshotSI();
    const stable = scalar.stabilityTimeStepS(
      velocities.velocityXMPerS,
      velocities.velocityYMPerS,
      scalarSafety,
    );
    const substeps = Math.max(1, Math.ceil(intervalS / stable));
    const dtScalar = intervalS / substeps;
    for (let substep = 0; substep < substeps; substep += 1) {
      scalar.advance(
        dtScalar,
        velocities.velocityXMPerS,
        velocities.velocityYMPerS,
      );
      if (scalar.diverged) {
        thermalDiverged = true;
        break;
      }
    }
    if (thermalDiverged) break;

    // 3. Solid: the 65a implicit solve over the interval, fed the
    // exact interface joules the scalar accumulated.
    const solidBefore = Float64Array.from(scalar.temperatureK);
    const system = assembleThermalSystem(problem, { iterateK: solidBefore });
    const exchangeAfter = scalar.interfaceExchangeJPerM();
    const sourceW = Float64Array.from(system.sourceW);
    for (let cell = 0; cell < count; cell += 1) {
      if (mask.solid[cell] !== 1) continue;
      const exchanged =
        (exchangeAfter[cell] ?? 0) - (exchangeBefore[cell] ?? 0);
      if (exchanged === 0) continue;
      // Positive exchange left the solid into the fluid: the source
      // hands exactly those joules back over the interval.
      sourceW[cell] = (sourceW[cell] ?? 0) - exchanged / intervalS;
    }
    const solved = solveThermalSystem(
      { ...system, sourceW },
      scalar.temperatureK,
      {
        diagonalWPerK: new Float64Array(count).map(
          (_, cell) => (solidCapacityJPerK[cell] ?? 0) / intervalS,
        ),
        sourceW: new Float64Array(count).map(
          (_, cell) =>
            ((solidCapacityJPerK[cell] ?? 0) / intervalS) *
            (solidBefore[cell] ?? 0),
        ),
      },
      solverOptions,
    );
    if (!solved.ok) return solved;
    completedIntervals += 1;

    // 4. The solid's boundary books, at the post-solve state (backward
    // Euler's balance holds there — the same row the solver converged).
    const solidLedger = thermalBoundaryFluxLedger({
      problem,
      temperatureK: scalar.temperatureK,
    });
    solidBoundaryLedgerJPerM +=
      intervalS * (solidLedger.dirichletNetW + solidLedger.neumannInW);
    solidSourceLedgerJPerM += intervalS * solidLedger.sourceW;
    sample();
  }

  // --- The books -----------------------------------------------------------
  const fluidChange =
    scalar.fluidEnergyJPerM(scenario.initialTemperatureK) - fluidEnergy0;
  const solidChange =
    solidStoredJPerM(
      solidCapacityJPerK,
      scalar.temperatureK,
      scenario.initialTemperatureK,
      mask,
    ) - solidEnergy0;
  const fluidBoundaryIn = scalar.boundaryEnergyInJPerM;
  const ledger: ChtEnergyLedger = {
    fluidChangeJPerM: fluidChange,
    solidChangeJPerM: solidChange,
    fluidBoundaryInJPerM: fluidBoundaryIn,
    solidBoundaryInJPerM: solidBoundaryLedgerJPerM,
    solidSourceJPerM: solidSourceLedgerJPerM,
    closureJPerM:
      fluidChange +
      solidChange -
      fluidBoundaryIn -
      solidBoundaryLedgerJPerM -
      solidSourceLedgerJPerM,
  };

  const diverged = flowDiverged || thermalDiverged;
  const steps = stepper.step;
  const histories: SimHistorySeries[] = [
    {
      name: CHT_HISTORY_SERIES.fluidTemperatureMean,
      unit: CHT_HISTORY_UNIT.temperature,
      samples: fluidMeanSamples,
    },
    {
      name: CHT_HISTORY_SERIES.fluidSpeedMax,
      unit: CHT_HISTORY_UNIT.speed,
      samples: fluidSpeedMaxSamples,
    },
  ];
  if (solidCellCount > 0) {
    histories.push({
      name: CHT_HISTORY_SERIES.solidTemperatureMean,
      unit: CHT_HISTORY_UNIT.temperature,
      samples: solidMeanSamples,
    });
  }

  let fluidMin = Number.POSITIVE_INFINITY;
  let fluidMax = Number.NEGATIVE_INFINITY;
  let fluidSum = 0;
  let fluidCount = 0;
  for (let index = 0; index < count; index += 1) {
    if (mask.solid[index] === 1) continue;
    const value = scalar.temperatureK[index] ?? 0;
    if (value < fluidMin) fluidMin = value;
    if (value > fluidMax) fluidMax = value;
    fluidSum += value;
    fluidCount += 1;
  }
  let solidSum = 0;
  for (let index = 0; index < count; index += 1) {
    if (mask.solid[index] === 1) solidSum += scalar.temperatureK[index] ?? 0;
  }

  const dx = scenario.cellSizeM;
  const temperatureField: SolverSimField = {
    id: "temperature",
    unit: "K",
    extent: [mask.nx, mask.ny, 1],
    originM: [0, 0, 0],
    spacingM: [dx, dx, dx],
    dataType: "float64",
    values: Array.from(scalar.temperatureK),
    dimension: "temperature",
  };

  return simOk({
    scenarioName: scenario.name,
    regime,
    steps,
    intervals: completedIntervals,
    physicalDurationS: steps * dtFlow,
    diverged,
    divergence: { flow: flowDiverged, thermal: thermalDiverged },
    grid: {
      nx: mask.nx,
      ny: mask.ny,
      cellSizeM: dx,
      timeStepS: dtFlow,
    },
    temperature: {
      fluidMeanK: fluidCount > 0 ? fluidSum / fluidCount : Number.NaN,
      fluidMinK: fluidMin,
      fluidMaxK: fluidMax,
      solidMeanK: solidCellCount > 0 ? solidSum / solidCellCount : null,
    },
    fields: diverged ? [] : [...stepper.solverFields(), temperatureField],
    histories,
    ledger,
  });
}
