/**
 * The combustion engine behind the Phase 61 `SimEngine` contract (Phase
 * 68c, the sim-dynamics adapter precedent): ONE `run` call turns a
 * COMPILED combustion scenario into a persisted-shape
 * {@link SimResult}, mode-locked on the compiled stance.
 *
 * - **ENGINE mode** — the 0D Otto cycle (the named deliverable): the
 *   compiled SI stance maps onto {@link runOttoCycle}'s scenario (the
 *   Phase 67 slider-crank seam consumed through the 68b geometry door),
 *   the optional sweep rides `ottoCycleSweep`, and the finalized result
 *   carries the P-vs-crank-angle trace as HISTORY series plus the
 *   indicated and brake families side by side as projected quantities
 *   (IMEP the gas-path truth; the loss family — exhaust enthalpy and
 *   wall/coolant — beside them; the Livengood–Wu knock report). One
 *   preview round publishes the pressure trace as a HISTORY GRID block
 *   (extent [samples, 1, 1], unit-indexed — the dynamics dissipation
 *   block's discipline), bitwise the values the finalized histories
 *   carry. No spatial field: the 0D chamber has none, and the result
 *   never fabricates one.
 * - **STOVE mode** — fire in the Phase 65 domain (the "stove with
 *   fire"): the 68b reactor burns the chamber charge with wall loss
 *   through the wetted solid–fluid interface (h·A per metre of the
 *   slab's depth, the per-metre convention the 65 solve speaks), and
 *   the 65 implicit conduction march — driven over `@slopcad/sim-thermal`'s
 *   exported FVM pieces, the `sim-flow` CHT engine's own precedent —
 *   consumes the reactor's progress-variable wall heat as a
 *   volumetric source on the wetted wall cells, area-weighted. The
 *   chamber's equilibrium gas state (the 68a HP products) reports
 *   beside the fire's own history. The coupling is ONE-WAY and frozen
 *   — the reactor's wall temperature is the authored constant, never
 *   the marching wall — the honest lockstep limit stated here, with
 *   the 68b reactor's own honest-h(t) seam the future two-way door.
 *
 * Determinism is the whole stance (law S2): no clock reads, no
 * randomness, a fixed emission schedule — the same compiled problem
 * produces the bitwise-identical result and notification stream every
 * time. Non-premixed (spray) combustion never reaches this adapter
 * (the compile door's stove/engine mode vocabulary locks it out
 * first), and the library doors this adapter consumes — the cycle,
 * the reactor, the sweeps — decline it with
 * `sim/combustion-mode-unsupported`, never approximated.
 */

import {
  type CompiledSimCombustion,
  type CompiledSimCombustionEngine,
  type CompiledSimCombustionStove,
  type SimEngine,
  type SimEngineFieldChunk,
  type SimEngineProgress,
  type SimEngineRequest,
  type SimError,
  SIM_ERROR_CODES,
  type SimHistorySeries,
  type SimParseResult,
  type SimResult,
  type SimResultSummary,
  SIM_RESULT_SUMMARY_VERSION,
  type SimScenarioKind,
  projectSimResult,
  simError,
  simFail,
  simOk,
  splitSimFieldBlock,
} from "@slopcad/sim-core";
import type { ThermalProblem } from "@slopcad/sim-thermal";
import {
  assembleThermalSystem,
  solveThermalSystem,
  thermalBoundaryFluxLedger,
  thermalCellCapacityJPerK,
  thermalCellGrid,
  thermalExposedFaces,
  thermalPublishPreview,
  thermalSolidMaterialFromRecord,
  type ThermalSolidMaterial,
} from "@slopcad/sim-thermal";

import { adiabaticFlame } from "./flame";
import { displacementM3 } from "./engine-geometry";
import { ottoCycleSweep, type OttoSweepResult } from "./engine-sweeps";
import {
  runOttoCycle,
  type OttoCycleResult,
  type OttoCycleScenario,
} from "./engine-cycle";
import { lowerHeatingValueJPerKg } from "./gas-properties";
import { premixedFuelAirInlet } from "./inlet";
import { runConstantVolumeReactor } from "./reactor";
import { getSpecies } from "./thermo-data";

/** The combustion engine's stable id (the worker host's routing key). */
export const COMBUSTION_SIM_ENGINE_ID = "combustion-0d-cpu-reference";

/** The scenario kinds this engine solves. */
export const COMBUSTION_SUPPORTED_KINDS: readonly SimScenarioKind[] = [
  "combustion",
];

/**
 * The values-per-chunk ceiling a preview round splits its block into —
 * the flow/thermal/dynamics engines' framing knob, restated so every
 * domain frames identically.
 */
export const COMBUSTION_PREVIEW_CHUNK_MAX_VALUES = 16384;

/** The engine mode's preview history-grid block (the pressure trace). */
export const COMBUSTION_PRESSURE_TRACE_FIELD_ID = "pressure-trace";

/** The implicit march's solver discipline (the 65 defaults, restated). */
const STOVE_SOLVER_OPTIONS = Object.freeze({
  toleranceK: 1e-10,
  maxIterations: 20_000,
});

const refuse = (
  message: string,
  at: unknown,
): SimParseResult<never, SimError> =>
  simFail(simError(SIM_ERROR_CODES.scenarioInvalid, message, at));

/** One macrotask turn — the cooperative cancellation window. */
function yieldOnce(): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
}

// ---------------------------------------------------------------------------
// The engine mode (the 0D Otto cycle)
// ---------------------------------------------------------------------------

/** Maps the compiled engine stance onto the 68b cycle scenario, SI. */
function ottoScenarioOf(
  stance: CompiledSimCombustionEngine,
): OttoCycleScenario {
  return {
    combustionMode: "premixed",
    fuel: stance.fuel,
    geometry: { ...stance.geometry },
    speedRpm: stance.speedRpm,
    charge: { ...stance.charge },
    spark: {
      timingBTDCDeg: stance.spark.timingBTDCDeg,
      ...(stance.spark.turbulenceSpeedMultiplier === undefined
        ? {}
        : {
            turbulenceSpeedMultiplier: stance.spark.turbulenceSpeedMultiplier,
          }),
    },
    wallHeat:
      stance.wallHeat.mode === "woschni"
        ? {
            mode: "woschni",
            wallTemperatureK: stance.wallHeat.wallTemperatureK,
          }
        : { mode: "adiabatic" },
    ...(stance.friction === undefined ? {} : { friction: stance.friction }),
  };
}

/** The cycle's history table as protocol series (verbatim columns). */
function cycleHistoriesOf(
  cycle: OttoCycleResult,
  sweep: OttoSweepResult | undefined,
): SimHistorySeries[] {
  const series: SimHistorySeries[] = cycle.history.columns.map((column) => ({
    name: column.name,
    unit: column.unit,
    samples: [...column.samples],
  }));
  if (sweep !== undefined) {
    for (const column of sweep.history.columns) {
      series.push({
        name: `sweep:${column.name}`,
        unit: column.unit,
        samples: [...column.samples],
      });
    }
  }
  return series;
}

/** The engine mode's quantities: indicated + brake + loss + knock families. */
function engineQuantitiesOf(
  cycle: OttoCycleResult,
  sweep: OttoSweepResult | undefined,
) {
  const quantities: {
    readonly name: string;
    readonly value: number;
    readonly unit: string;
  }[] = [
    { name: "imep", value: cycle.indicated.imepPa, unit: "Pa" },
    {
      name: "indicated-thermal-efficiency",
      value: cycle.indicated.thermalEfficiency,
      unit: "1",
    },
    { name: "indicated-work", value: cycle.indicated.workJ, unit: "J" },
    { name: "bmep", value: cycle.brake.bmepPa, unit: "Pa" },
    {
      name: "brake-torque",
      value: cycle.brake.torqueNPerM,
      unit: "N*m",
    },
    { name: "brake-power", value: cycle.brake.powerW, unit: "W" },
    {
      name: "brake-thermal-efficiency",
      value: cycle.brake.thermalEfficiency,
      unit: "1",
    },
    { name: "fmep", value: cycle.brake.fmepPa, unit: "Pa" },
    { name: "pmep", value: cycle.brake.pmepPa, unit: "Pa" },
    { name: "friction-work", value: cycle.brake.frictionWorkJ, unit: "J" },
    { name: "wall-heat-loss", value: cycle.audit.wallHeatJ, unit: "J" },
    {
      name: "exhaust-enthalpy",
      value: cycle.audit.exhaustEnthalpyJ,
      unit: "J",
    },
    {
      name: "fuel-chemical-energy",
      value: cycle.audit.fuelChemicalJ,
      unit: "J",
    },
    { name: "audit-residual", value: cycle.audit.residualJ, unit: "J" },
    {
      name: "peak-pressure",
      value: cycle.peak.pressureBar,
      unit: "bar",
    },
    {
      name: "peak-pressure-angle",
      value: cycle.peak.pressureAngleDeg,
      unit: "deg",
    },
    {
      name: "peak-burned-temperature",
      value: cycle.peak.burnedTemperatureK,
      unit: "K",
    },
    { name: "motored-imep", value: cycle.motored.imepPa, unit: "Pa" },
    { name: "knock-integral-max", value: cycle.knock.integralMax, unit: "1" },
    {
      name: "burn-duration",
      value: (cycle.burn.burnDurationRad * 180) / Math.PI,
      unit: "deg",
    },
    {
      name: "compression-ratio",
      value: cycle.compressionRatio,
      unit: "1",
    },
    {
      name: "displacement",
      value: displacementM3(cycle.geometry),
      unit: "m^3",
    },
  ];
  if (cycle.knock.onsetAngleDeg !== undefined) {
    quantities.push({
      name: "knock-onset-angle",
      value: cycle.knock.onsetAngleDeg,
      unit: "deg",
    });
  }
  if (sweep !== undefined && sweep.rows.length > 0) {
    const firstKnockRow = sweep.rows.find((row) => row.knockIntegral >= 1);
    if (firstKnockRow !== undefined) {
      quantities.push({
        name: "sweep-knock-boundary",
        value: firstKnockRow.sweepValue,
        unit:
          sweep.kind === "sparkTiming"
            ? "deg"
            : sweep.kind === "equivalenceRatio"
              ? "1"
              : "1",
      });
    }
  }
  return quantities;
}

/** The pressure trace as one document-space history-grid preview block. */
function pressureTraceBlockOf(
  cycle: OttoCycleResult,
): readonly SimEngineFieldChunk[] {
  const angle = cycle.history.columns[0];
  const pressure = cycle.history.columns[1];
  if (angle === undefined || pressure === undefined) return [];
  const sampleCount = Math.min(angle.samples.length, pressure.samples.length);
  if (sampleCount === 0) return [];
  const block = {
    id: COMBUSTION_PRESSURE_TRACE_FIELD_ID,
    unit: "bar",
    extent: [sampleCount, 1, 1] as const,
    originMm: [0, 0, 0] as const,
    spacingMm: [1, 1, 1] as const,
    dataType: "float64" as const,
    values: pressure.samples.slice(0, sampleCount),
  };
  const chunkCount = Math.max(
    1,
    Math.ceil(block.values.length / COMBUSTION_PREVIEW_CHUNK_MAX_VALUES),
  );
  return [...splitSimFieldBlock(block, chunkCount)];
}

async function runCombustionEngineMode(
  compiled: SimEngineRequest["compiled"],
  stance: CompiledSimCombustionEngine,
  onProgress?: (progress: SimEngineProgress) => void,
  onFieldChunk?: (chunk: SimEngineFieldChunk) => void,
): Promise<SimParseResult<SimResult, SimError>> {
  const sweepSteps = stance.sweep === undefined ? 0 : stance.sweep.steps + 1;
  const totalSteps = 1 + sweepSteps;
  onProgress?.({ step: 0, totalSteps });
  await yieldOnce();
  const scenario = ottoScenarioOf(stance);
  const cycle = runOttoCycle(scenario);
  if (!cycle.ok) return cycle;
  onProgress?.({ step: 1, totalSteps });
  let sweep: OttoSweepResult | undefined;
  if (stance.sweep !== undefined) {
    await yieldOnce();
    const swept = ottoCycleSweep({
      base: scenario,
      kind: stance.sweep.kind,
      from: stance.sweep.from,
      to: stance.sweep.to,
      steps: stance.sweep.steps,
    });
    if (!swept.ok) return swept;
    sweep = swept.value;
    onProgress?.({ step: totalSteps, totalSteps });
  }
  // The one committed preview round: the pressure trace, chunked.
  if (onFieldChunk !== undefined) {
    for (const chunk of pressureTraceBlockOf(cycle.value)) {
      onFieldChunk(chunk);
    }
  }
  const summary: SimResultSummary = {
    schemaVersion: SIM_RESULT_SUMMARY_VERSION,
    scenarioSnapshotHash: compiled.scenarioSnapshotHash,
    status: "completed",
    regime: compiled.regime,
    quantities: engineQuantitiesOf(cycle.value, sweep),
    servedBackend: "cpu",
  };
  return simOk({
    summary,
    fields: [],
    histories: cycleHistoriesOf(cycle.value, sweep),
  });
}

// ---------------------------------------------------------------------------
// The stove mode (fire in the Phase 65 domain)
// ---------------------------------------------------------------------------

/** The stove mode's collected march state (the histories' material). */
interface StoveCollector {
  readonly timeS: number[];
  readonly fireProgress: number[];
  readonly fireGasTemperatureK: number[];
  readonly fireWallHeatRateWPerM: number[];
  readonly temperatureMaxK: number[];
  readonly temperatureMeanK: number[];
  readonly temperatureMinK: number[];
}

/**
 * Runs the stove-with-fire: the reactor phase (the fire's burn history
 * with its wall loss through the chamber interface), then the 65-family
 * implicit march whose per-interval volumetric source is the reactor's
 * wall heat over the wetted wall cells, then the equilibrium gas state
 * (the 68a HP products) beside the projections.
 */
async function runCombustionStoveMode(
  compiled: SimEngineRequest["compiled"],
  stance: CompiledSimCombustionStove,
  occupancySlice: SimEngineRequest["compiled"]["occupancySlice"],
  onProgress?: (progress: SimEngineProgress) => void,
  onFieldChunk?: (chunk: SimEngineFieldChunk) => void,
): Promise<SimParseResult<SimResult, SimError>> {
  if (occupancySlice === undefined) {
    return refuse(
      "A stove-mode combustion run needs the compile's voxelized solids and material map: compile with the bodies' tessellations and the material records (the geometry-aware compile door) — the fire couples through the solid–fluid interface, and this engine refuses to fabricate one.",
      compiled.name,
    );
  }
  // The per-metre slab (the 65b convention): the slice's cells at their
  // own lateral spacing with a unit third axis.
  const slab = {
    semantic: "occupancy" as const,
    name: `${compiled.name}-fire-slab`,
    shape: [
      occupancySlice.shape[0] ?? 1,
      occupancySlice.shape[1] ?? 1,
      1,
    ] as const,
    originM: [
      occupancySlice.originM[0] ?? 0,
      occupancySlice.originM[1] ?? 0,
      occupancySlice.originM[2] ?? 0,
    ] as const,
    spacingM: [
      occupancySlice.spacingM[0] ?? 1,
      occupancySlice.spacingM[1] ?? 1,
      1,
    ] as const,
    cells: occupancySlice.cells,
  };
  const classified = thermalCellGrid(slab);
  if (!classified.ok) return classified;
  const grid = classified.value;
  const cellCount = grid.nx * grid.ny * grid.nz;

  // The materials, re-validated through the 65 door.
  const materials: ThermalSolidMaterial[] = [];
  for (const entry of stance.materials) {
    const parsed = thermalSolidMaterialFromRecord(entry.record);
    if (!parsed.ok) return parsed;
    materials.push(parsed.value);
  }
  if (materials.length === 0) {
    return refuse(
      "A stove-mode combustion run needs at least one resolved material record.",
      stance.materials,
    );
  }
  const conductivityWPerMK = new Float64Array(cellCount);
  const volumetricHeatCapacityJPerM3K = new Float64Array(cellCount);
  const emissivity = new Float64Array(cellCount).fill(Number.NaN);
  for (let cell = 0; cell < cellCount; cell += 1) {
    if (grid.solid[cell] !== 1) continue;
    const material = materials[(stance.materialIndex[cell] ?? 0) - 1];
    if (material === undefined) {
      return refuse(
        "The compiled material map addresses no material on a solid cell.",
        stance.materialIndex[cell],
      );
    }
    conductivityWPerMK[cell] = material.thermalConductivityWPerMK;
    if (material.volumetricHeatCapacityJPerM3K !== undefined) {
      volumetricHeatCapacityJPerM3K[cell] =
        material.volumetricHeatCapacityJPerM3K;
    }
    if (material.emissivity !== undefined) {
      emissivity[cell] = material.emissivity;
    }
  }

  // The chamber interface: every exposed solid face wets the fire (the
  // fluid region IS the firebox — the sealed statement's honest coarse
  // geometry). The wetted area per cell drives the area-weighted source.
  const exposedFaces = thermalExposedFaces(grid);
  if (exposedFaces.length === 0) {
    return refuse(
      "The voxelized solids expose no face to the fluid — the fire has no wall to heat, and the run declines instead of solving a sealed solid.",
      slab.shape,
    );
  }
  const wettedAreaByCell = new Float64Array(cellCount);
  let wettedAreaM2PerM = 0;
  for (const face of exposedFaces) {
    const cell = face.cell;
    wettedAreaByCell[cell] = (wettedAreaByCell[cell] ?? 0) + face.areaM2;
    wettedAreaM2PerM += face.areaM2;
  }

  // The charge: the chamber volume per metre of depth filled with the
  // authored premixed state. The reactor's fuel-mole basis is scaled so
  // its ideal-gas vessel volume equals the chamber (the one coupling
  // convention, stated: the 0D fire is the chamber's own gas).
  let fluidCells = 0;
  for (let cell = 0; cell < cellCount; cell += 1) {
    if (grid.solid[cell] !== 1) fluidCells += 1;
  }
  if (fluidCells === 0) {
    return refuse(
      "The voxelized solids fill the whole slice — there is no chamber for the fire, and the run declines instead of burning inside a solid.",
      slab.shape,
    );
  }
  const fluidVolumeM3PerM = fluidCells * grid.cellVolumeM3;
  const perMoleInlet = premixedFuelAirInlet({
    fuel: stance.fuel,
    equivalenceRatio: stance.equivalenceRatio,
    inletTK: stance.chargeTemperatureK,
  });
  if (!perMoleInlet.ok) return perMoleInlet;
  let basisMoles = 0;
  for (const moles of Object.values(perMoleInlet.value.species)) {
    basisMoles += moles;
  }
  const targetMoles =
    (stance.chargePressureBar * 1e5 * fluidVolumeM3PerM) /
    (8.31446261815324 * stance.chargeTemperatureK);
  const fuelMoles = targetMoles / Math.max(basisMoles, 1e-12);

  // The fire: the 68b reactor with wall loss through the wetted area at
  // the authored wall temperature — its progress-variable history IS
  // the fire the march consumes. The march resolution is the reactor's
  // own default (4000 RK4 steps, the 68b suite's ladder fixture's
  // measured band: the wall-heat integral at 4000 steps sits within
  // 0.005% of the 8000/16000 refinements — every ladder rung from 1000
  // steps upward within 0.02%), with its samples landing on the
  // march's cadence.
  const sampleCount = Math.round(stance.durationS / stance.sampleIntervalS);
  const reactorSteps = 4000;
  const reactor = runConstantVolumeReactor({
    combustionMode: "premixed",
    fuel: stance.fuel,
    equivalenceRatio: stance.equivalenceRatio,
    initialTK: stance.chargeTemperatureK,
    pressureBar: stance.chargePressureBar,
    fuelMoles,
    durationS: stance.durationS,
    steps: reactorSteps,
    samplesOut: Math.max(1, Math.floor(reactorSteps / sampleCount)),
    wall: {
      temperatureK: stance.wallTemperatureK,
      areaM2: wettedAreaM2PerM,
      heatTransferCoefficientWPerM2K: stance.wallConvectionWPerM2K,
    },
  });
  if (!reactor.ok) return reactor;
  const fire = reactor.value;

  // The chamber's equilibrium gas state (the 68a HP products): the
  // adiabatic flame of the same charge — the fire's ceiling gas state.
  const flame = adiabaticFlame({
    fuel: stance.fuel,
    equivalenceRatio: stance.equivalenceRatio,
    inletTK: stance.chargeTemperatureK,
    pressureBar: stance.chargePressureBar,
  });
  if (!flame.ok) return flame;

  // The 65-family implicit march over the FVM pieces (the CHT engine's
  // own precedent): per sample interval, the reactor's wall heat over
  // that interval enters the wetted cells area-weighted.
  const problem: ThermalProblem = {
    grid,
    conductivityWPerMK,
    volumetricHeatCapacityJPerM3K,
    emissivity,
    sourceWPerM3: new Float64Array(cellCount),
    ambient: {
      heatTransferCoefficientWPerM2K: stance.ambientConvectionWPerM2K,
      ambientTemperatureK: stance.initialTemperatureK,
    },
    faceConditions: {},
    radiationMode: stance.radiationMode,
    radiationReferenceK: stance.initialTemperatureK,
  };
  const capacityJPerK = thermalCellCapacityJPerK(problem);
  for (let cell = 0; cell < cellCount; cell += 1) {
    if (grid.solid[cell] === 1 && !((capacityJPerK[cell] ?? 0) > 0)) {
      return refuse(
        "The fire march needs ρc on every solid cell; a material record without specific heat cannot march.",
        cell,
      );
    }
  }
  const temperatureK = new Float64Array(cellCount).fill(
    stance.initialTemperatureK,
  );
  const collector: StoveCollector = {
    timeS: [],
    fireProgress: [],
    fireGasTemperatureK: [],
    fireWallHeatRateWPerM: [],
    temperatureMaxK: [],
    temperatureMeanK: [],
    temperatureMinK: [],
  };
  const sampleField = (): void => {
    let max = Number.NEGATIVE_INFINITY;
    let min = Number.POSITIVE_INFINITY;
    let sum = 0;
    let count = 0;
    for (let cell = 0; cell < cellCount; cell += 1) {
      if (grid.solid[cell] !== 1) continue;
      const value = temperatureK[cell] ?? 0;
      if (value > max) max = value;
      if (value < min) min = value;
      sum += value;
      count += 1;
    }
    collector.temperatureMaxK.push(max);
    collector.temperatureMeanK.push(
      count > 0 ? sum / count : stance.initialTemperatureK,
    );
    collector.temperatureMinK.push(min);
  };
  const fireSamples = fire.samples;
  let fireIndex = 0;
  collector.timeS.push(0);
  const firstFire = fireSamples[0];
  collector.fireProgress.push(firstFire?.progress ?? 0);
  collector.fireGasTemperatureK.push(
    firstFire?.temperatureK ?? stance.chargeTemperatureK,
  );
  collector.fireWallHeatRateWPerM.push(0);
  sampleField();

  let sourceLedgerJPerM = 0;
  let boundaryLedgerJPerM = 0;
  const stored0 = storedEnergyJPerM(capacityJPerK, temperatureK, grid);
  // The reactor's cumulative wall heat at an instant, J/m: linear
  // interpolation between its recorded samples, pinned to the audit's
  // own final value at the march's end — so the interval ledger
  // telescopes onto the reactor's wall-heat audit (the identity the
  // stove test pins), and the interval heat is SIGNED (a charge colder
  // than its wall draws heat from the solid — booked, never clamped
  // away: a clamp here would silently break the ledger).
  const cumulativeWallHeatAt = (timeS: number): number => {
    if (timeS >= stance.durationS) return fire.audit.wallHeatRemovedJ;
    for (let index = 1; index < fireSamples.length; index += 1) {
      const upper = fireSamples[index];
      if (upper !== undefined && upper.timeS >= timeS) {
        const lower = fireSamples[index - 1];
        if (lower === undefined) return upper.wallHeatRemovedJ;
        const spanS = upper.timeS - lower.timeS;
        const fraction = spanS > 0 ? (timeS - lower.timeS) / spanS : 0;
        return (
          lower.wallHeatRemovedJ +
          fraction * (upper.wallHeatRemovedJ - lower.wallHeatRemovedJ)
        );
      }
    }
    return fire.audit.wallHeatRemovedJ;
  };
  onProgress?.({ step: 0, totalSteps: sampleCount });
  await yieldOnce();
  for (let interval = 0; interval < sampleCount; interval += 1) {
    const tFrom = interval * stance.sampleIntervalS;
    const tTo = (interval + 1) * stance.sampleIntervalS;
    // The fire series' own walk: the last recorded sample at or before
    // the interval's start, advanced once more when a sample lands
    // inside the interval (the histories' piecewise source).
    while (
      fireIndex + 1 < fireSamples.length &&
      (fireSamples[fireIndex + 1]?.timeS ?? tTo) <= tFrom
    ) {
      fireIndex += 1;
    }
    const next = fireSamples[fireIndex + 1];
    if (next !== undefined && next.timeS <= tTo) {
      fireIndex += 1;
    }
    // The reactor's wall heat over this interval: the interpolated
    // cumulative differenced at the interval's own boundaries.
    const intervalHeatJPerM =
      cumulativeWallHeatAt(tTo) - cumulativeWallHeatAt(tFrom);
    const rateWPerM = intervalHeatJPerM / stance.sampleIntervalS;
    // The backward-Euler capacity terms at the interval's step-start field.
    const before = Float64Array.from(temperatureK);
    const system = assembleThermalSystem(problem, { iterateK: before });
    const sourceW = Float64Array.from(system.sourceW);
    for (let cell = 0; cell < cellCount; cell += 1) {
      const area = wettedAreaByCell[cell] ?? 0;
      if (area <= 0) continue;
      // Area-weighted deposit: this cell's share of the wetted interface.
      sourceW[cell] =
        (sourceW[cell] ?? 0) + (rateWPerM * area) / wettedAreaM2PerM;
    }
    const solved = solveWithCapacity(
      { ...system, sourceW },
      temperatureK,
      capacityJPerK,
      before,
      stance.sampleIntervalS,
    );
    if (!solved.ok) return solved;
    sourceLedgerJPerM += intervalHeatJPerM;
    // The boundary books at the post-solve state (backward Euler's
    // balance holds there — the CHT engine's own row).
    const ledger = thermalBoundaryFluxLedger({ problem, temperatureK });
    boundaryLedgerJPerM +=
      stance.sampleIntervalS *
      (ledger.convectionOutW +
        ledger.radiationOutW +
        ledger.dirichletNetW -
        ledger.neumannInW);
    const sample = fireSamples[Math.min(fireIndex + 1, fireSamples.length - 1)];
    collector.timeS.push(tTo);
    collector.fireProgress.push(sample?.progress ?? fire.finalProgress);
    collector.fireGasTemperatureK.push(
      sample?.temperatureK ?? fire.peakTemperatureK,
    );
    collector.fireWallHeatRateWPerM.push(rateWPerM);
    sampleField();
    onProgress?.({ step: interval + 1, totalSteps: sampleCount });
    await yieldOnce();
  }
  // The one committed preview round: the temperature block (the 62
  // overlay family), published through the 65 engine's own chunker.
  const fieldValues: number[] = [];
  for (let cell = 0; cell < cellCount; cell += 1) {
    fieldValues.push(
      grid.solid[cell] === 1
        ? (temperatureK[cell] ?? stance.initialTemperatureK)
        : stance.initialTemperatureK,
    );
  }
  const temperatureField = {
    id: "temperature",
    unit: "K",
    extent: [grid.nx, grid.ny, grid.nz] as const,
    originM: slab.originM,
    spacingM: slab.spacingM,
    dataType: "float64" as const,
    values: fieldValues,
    dimension: "temperature" as const,
  } as const;
  if (onFieldChunk !== undefined) {
    thermalPublishPreview([temperatureField], onFieldChunk);
  }
  const projected = projectSimResult({
    scalars: [],
    fields: [temperatureField],
  });
  if (!projected.ok) return projected;

  // The fire's energy facts: the fuel mass per metre and its LHV.
  const fuelRecord = getSpecies(stance.fuel);
  if (fuelRecord === undefined) {
    return refuse(
      `The fuel "${stance.fuel}" is not in the curated NASA-7 database.`,
      stance.fuel,
    );
  }
  const lhv = lowerHeatingValueJPerKg(stance.fuel);
  if (!lhv.ok) return lhv;
  // The fuel mass per metre: the chamber's fuel moles (the per-mol-fuel
  // basis scaled by fuelMoles, the chamber's own charge) on the fuel's
  // molecular weight.
  const fuelMassKgPerM =
    (fuelMoles * fuelRecord.molecularWeightKgPerKmol) / 1000;
  const fuelEnergyJPerM = fuelMassKgPerM * lhv.value;
  const stored = storedEnergyJPerM(capacityJPerK, temperatureK, grid);
  const histories: SimHistorySeries[] = [
    { name: "time", unit: "s", samples: [...collector.timeS] },
    { name: "fire:progress", unit: "1", samples: [...collector.fireProgress] },
    {
      name: "fire:gas-temperature",
      unit: "K",
      samples: [...collector.fireGasTemperatureK],
    },
    {
      name: "fire:wall-heat-rate",
      unit: "W/m",
      samples: [...collector.fireWallHeatRateWPerM],
    },
    {
      name: "temperature-max",
      unit: "K",
      samples: [...collector.temperatureMaxK],
    },
    {
      name: "temperature-mean",
      unit: "K",
      samples: [...collector.temperatureMeanK],
    },
    {
      name: "temperature-min",
      unit: "K",
      samples: [...collector.temperatureMinK],
    },
  ];
  const quantities: {
    readonly name: string;
    readonly value: number;
    readonly unit: string;
  }[] = [
    {
      name: "adiabatic-flame-temperature",
      value: flame.value.solution.temperatureK,
      unit: "K",
    },
    {
      name: "fire-peak-gas-temperature",
      value: fire.peakTemperatureK,
      unit: "K",
    },
    { name: "fire-final-progress", value: fire.finalProgress, unit: "1" },
    {
      name: "fire-released-energy",
      value: fuelEnergyJPerM * fire.finalProgress,
      unit: "J/m",
    },
    {
      name: "fire-wall-heat",
      value: fire.audit.wallHeatRemovedJ,
      unit: "J/m",
    },
    {
      name: "fire-wetted-area",
      value: wettedAreaM2PerM,
      unit: "m^2/m",
    },
    {
      name: "max-temperature",
      value: collector.temperatureMaxK.at(-1) ?? stance.initialTemperatureK,
      unit: "K",
    },
    {
      name: "mean-temperature",
      value: collector.temperatureMeanK.at(-1) ?? stance.initialTemperatureK,
      unit: "K",
    },
    {
      name: "min-temperature",
      value: collector.temperatureMinK.at(-1) ?? stance.initialTemperatureK,
      unit: "K",
    },
    { name: "fire-source-energy", value: sourceLedgerJPerM, unit: "J/m" },
    { name: "boundary-heat-out", value: boundaryLedgerJPerM, unit: "J/m" },
    {
      name: "stored-energy",
      value: stored - stored0,
      unit: "J/m",
    },
    {
      name: "energy-closure",
      value: sourceLedgerJPerM - boundaryLedgerJPerM - (stored - stored0),
      unit: "J/m",
    },
    { name: "march-steps", value: sampleCount, unit: "1" },
    { name: "physical-duration", value: stance.durationS, unit: "s" },
  ];
  const summary: SimResultSummary = {
    schemaVersion: SIM_RESULT_SUMMARY_VERSION,
    scenarioSnapshotHash: compiled.scenarioSnapshotHash,
    status: "completed",
    regime: compiled.regime,
    quantities,
    servedBackend: "cpu",
  };
  return simOk({
    summary,
    fields: projected.value.fields,
    histories,
  });
}

/** The stored thermal energy of the solid field above its initial value, J/m. */
function storedEnergyJPerM(
  capacityJPerK: Float64Array,
  temperatureK: Float64Array,
  grid: { readonly solid: Uint8Array },
): number {
  let stored = 0;
  for (let cell = 0; cell < temperatureK.length; cell += 1) {
    if (grid.solid[cell] !== 1) continue;
    stored += (capacityJPerK[cell] ?? 0) * (temperatureK[cell] ?? 0);
  }
  return stored;
}

/** One implicit interval solve with the backward-Euler capacity terms. */
function solveWithCapacity(
  system: ReturnType<typeof assembleThermalSystem>,
  temperatureK: Float64Array,
  capacityJPerK: Float64Array,
  before: Float64Array,
  intervalS: number,
): SimParseResult<true, SimError> {
  const solved = solveThermalSystem(
    system,
    temperatureK,
    {
      diagonalWPerK: new Float64Array(system.cellCount).map(
        (_, cell) => (capacityJPerK[cell] ?? 0) / intervalS,
      ),
      sourceW: new Float64Array(system.cellCount).map(
        (_, cell) =>
          ((capacityJPerK[cell] ?? 0) / intervalS) * (before[cell] ?? 0),
      ),
    },
    STOVE_SOLVER_OPTIONS,
  );
  if (!solved.ok) return solved;
  return simOk(true);
}

async function runCombustionEngine(
  request: SimEngineRequest,
  onProgress?: (progress: SimEngineProgress) => void,
  onFieldChunk?: (chunk: SimEngineFieldChunk) => void,
): Promise<SimParseResult<SimResult, SimError>> {
  const compiled = request.compiled;
  if (!COMBUSTION_SUPPORTED_KINDS.includes(compiled.kind)) {
    return simFail(
      simError(
        SIM_ERROR_CODES.scenarioKindUnsupported,
        `The combustion engine does not solve the "${compiled.kind}" scenario kind (it solves combustion; structural is Phase 69's carve).`,
        compiled.kind,
      ),
    );
  }
  if (compiled.backend === "gpu") {
    return simFail(
      simError(
        SIM_ERROR_CODES.backendUnavailable,
        'The scenario prefers the "gpu" backend, but the combustion domain ships the CPU reference kernel only — there is no GPU provider to route to, and the engine declines the preference loudly instead of silently ignoring it.',
        compiled.backend,
      ),
    );
  }
  const stance: CompiledSimCombustion | undefined = compiled.combustion;
  if (stance === undefined) {
    return refuse(
      "A combustion run needs the compile's combustion products (the mode-locked stance): compile through the geometry-aware compile door.",
      compiled.name,
    );
  }
  if (stance.mode === "engine") {
    return runCombustionEngineMode(compiled, stance, onProgress, onFieldChunk);
  }
  return runCombustionStoveMode(
    compiled,
    stance,
    compiled.occupancySlice,
    onProgress,
    onFieldChunk,
  );
}

/** The deterministic combustion engine (law S2's CPU oracle adapter). */
export function createCombustionSimEngine(): SimEngine {
  return {
    id: COMBUSTION_SIM_ENGINE_ID,
    supportedKinds: COMBUSTION_SUPPORTED_KINDS,
    backend: "cpu",
    run: (request, onProgress, onFieldChunk) =>
      runCombustionEngine(request, onProgress, onFieldChunk),
  };
}
