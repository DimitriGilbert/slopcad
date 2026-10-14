/**
 * The 0D homogeneous reactor (ROADMAP-SIM Phase 68b): a constant-volume
 * vessel (the combustion bomb) integrating a premixed charge on the
 * one-step Westbrook–Dryer kinetics with the kinetic-energy-state
 * discipline the prior-art input named — the march's STATE is the
 * total internal energy U (J) plus the reaction extent λ (mol on the
 * charge basis), and temperature/pressure are DERIVED by inverting
 * that state, so the energy audit identity
 *
 *   U(t) + Q_removed(t) = U(0)
 *
 * holds by construction (float summation and nothing else) in both the
 * adiabatic variant and the wall-loss variant (Newton cooling through
 * a caller-supplied h·A and wall temperature — the Phase 68c CHT
 * coupling's seam, which will supply honest h(t) from the flow solve).
 *
 * The composition is TRANSPORTED STATE, the researched failure mode's
 * fix: species ride the extent λ (fuel and oxygen consumed to frozen
 * complete-combustion products, oxidizer-limited on rich mixtures), so
 * the heat released is exactly the chemical energy of the fuel that is
 * actually present in the vessel — a vessel with no fuel heats not at
 * all, a vessel with half the fuel releases half the energy. A
 * combustionMode of anything but premixed declines loudly (spray is
 * declined at every level, the roadmap's §6 boundary).
 *
 * The RK4 march is fixed-count over a caller-chosen duration; the
 * audit residual is reported with the run — the test truth pins it at
 * the float-summation floor.
 */

import {
  simError,
  simFail,
  simOk,
  SIM_ERROR_CODES,
  type SimError,
  type SimHistoryTable,
  type SimParseResult,
} from "@slopcad/sim-core";

import {
  completeCombustionOf,
  frozenInternalEnergyJPerKg,
  frozenMixture,
  frozenTemperatureFromInternalEnergyK,
} from "./gas-properties";
import { premixedFuelAirInlet } from "./inlet";
import {
  getOneStepKinetics,
  IGNITION_THRESHOLD_FRACTION,
  oneStepRateMolPerM3S,
} from "./kinetics";
import { GAS_CONSTANT_J_PER_MOL_K } from "./nasa7";
import { getSpecies, stoichiometricO2PerMol } from "./thermo-data";

/** The combustion modes the reactor door understands. */
export type ReactorCombustionMode = "premixed";

/** The wall-loss boundary: Newton cooling with constant h and T_wall. */
export interface ReactorWallLoss {
  /** The wall temperature, K. */
  readonly temperatureK: number;
  /** The wetted heat-transfer area, m². */
  readonly areaM2: number;
  /** The convective coefficient, W/(m²·K). */
  readonly heatTransferCoefficientWPerM2K: number;
}

/** One reactor history sample. */
export interface ReactorSample {
  readonly timeS: number;
  readonly temperatureK: number;
  readonly pressureBar: number;
  /** The reaction extent over its reachable maximum, [0, 1]. */
  readonly progress: number;
  /** The cumulative wall heat removed, J (zero when adiabatic). */
  readonly wallHeatRemovedJ: number;
}

/** The reactor run's outputs with its by-construction audit. */
export interface ReactorRunResult {
  readonly fuel: string;
  readonly equivalenceRatio: number;
  readonly initialTK: number;
  readonly pressure0Bar: number;
  readonly samples: readonly ReactorSample[];
  readonly history: SimHistoryTable;
  /** The audit identity's terms and residual — conserving by construction. */
  readonly audit: {
    readonly initialInternalEnergyJ: number;
    readonly finalInternalEnergyJ: number;
    readonly wallHeatRemovedJ: number;
    /** U₀ − (U_end + Q_removed): the float-summation residual, ≈ 0. */
    readonly residualJ: number;
  };
  /**
   * Time to the shared induction threshold (the same 5%-of-reachable
   * definition the Livengood–Wu knock integral uses); undefined when
   * the run ends before crossing.
   */
  readonly ignitionDelayS: number | undefined;
  readonly finalProgress: number;
  /** The true maximum temperature over EVERY march step, K (not just the decimated recorded samples). */
  readonly peakTemperatureK: number;
  /** The true maximum pressure over EVERY march step, bar (not just the decimated recorded samples). */
  readonly peakPressureBar: number;
  readonly adiabatic: boolean;
}

/** The charge's extent-parameterized frozen chemistry, fixed at setup. */
interface ReactorChemistry {
  readonly fuelName: string;
  /** Initial moles per species on the basis, fuel included. */
  readonly initial: Readonly<Record<string, number>>;
  /** Frozen complete-combustion product moles per mole of fuel burned. */
  readonly productPerFuelMole: Readonly<Record<string, number>>;
  /** Stoichiometric O₂ per mole of fuel. */
  readonly nuO2: number;
  /** The reachable extent, mol on the basis (oxidizer-limited when rich). */
  readonly extentMax: number;
  /** The constant vessel volume, m³ (initial state's ideal-gas volume). */
  readonly volumeM3: number;
  /** The constant charge mass on the basis, kg (mass conservation). */
  readonly basisMassKg: number;
}

function speciesAtExtent(
  chem: ReactorChemistry,
  extent: number,
): Record<string, number> {
  const lambda = Math.min(Math.max(extent, 0), chem.extentMax);
  const species: Record<string, number> = {};
  for (const [name, moles] of Object.entries(chem.initial)) {
    species[name] = moles;
  }
  species[chem.fuelName] = Math.max(
    (chem.initial[chem.fuelName] ?? 0) - lambda,
    0,
  );
  species.O2 = Math.max((chem.initial.O2 ?? 0) - lambda * chem.nuO2, 0);
  for (const [name, perFuelMole] of Object.entries(chem.productPerFuelMole)) {
    species[name] = (species[name] ?? 0) + lambda * perFuelMole;
  }
  return species;
}

/** Total moles on the basis at `extent`. */
function totalMolesAt(chem: ReactorChemistry, extent: number): number {
  let nTot = 0;
  for (const moles of Object.values(speciesAtExtent(chem, extent))) {
    nTot += moles;
  }
  return nTot;
}

/**
 * Runs the constant-volume 0D reactor. The march is RK4 with a fixed
 * `steps` count over `durationS`; the audit identity is exact in the
 * bookkeeping by construction. `samplesOut` decimates the recorded
 * history (every `samplesOut`-th step, the final step always).
 */
export function runConstantVolumeReactor(input: {
  readonly combustionMode: ReactorCombustionMode | "spray" | "non-premixed";
  readonly fuel: string;
  readonly equivalenceRatio: number;
  readonly initialTK: number;
  readonly pressureBar: number;
  readonly fuelMoles?: number;
  readonly durationS: number;
  readonly steps?: number;
  readonly samplesOut?: number;
  readonly wall?: ReactorWallLoss;
}): SimParseResult<ReactorRunResult, SimError> {
  if (input.combustionMode !== "premixed") {
    return simFail(
      simError(
        SIM_ERROR_CODES.combustionModeUnsupported,
        `The 0D reactor models premixed charges only; "${input.combustionMode}" combustion (spray, mixing-controlled, diesel-class) is declined at every level per the roadmap's scope boundary, never approximated.`,
        input.combustionMode,
      ),
    );
  }
  const set = getOneStepKinetics(input.fuel);
  if (!set.ok) return set;
  const inlet = premixedFuelAirInlet({
    fuel: input.fuel,
    equivalenceRatio: input.equivalenceRatio,
    inletTK: input.initialTK,
    ...(input.fuelMoles === undefined ? {} : { fuelMoles: input.fuelMoles }),
  });
  if (!inlet.ok) return inlet;
  const steps = input.steps ?? 4000;
  if (!Number.isInteger(steps) || steps < 4) {
    return simFail(
      simError(
        SIM_ERROR_CODES.scenarioInvalid,
        `The reactor march needs an integer step count ≥ 4; it was ${String(steps)}.`,
        steps,
      ),
    );
  }
  if (!Number.isFinite(input.durationS) || input.durationS <= 0) {
    return simFail(
      simError(
        SIM_ERROR_CODES.scenarioInvalid,
        `The reactor duration must be strictly positive (s); it was ${String(input.durationS)}.`,
        input.durationS,
      ),
    );
  }
  const samplesOut = input.samplesOut ?? Math.max(1, Math.floor(steps / 200));

  const fuelRecord = getSpecies(input.fuel);
  if (fuelRecord === undefined) {
    return simFail(
      simError(
        SIM_ERROR_CODES.scenarioInvalid,
        `The fuel "${input.fuel}" is not in the curated NASA-7 database.`,
        input.fuel,
      ),
    );
  }
  const mix0 = frozenMixture(inlet.value.species);
  if (!mix0.ok) return mix0;
  const n0 = mix0.value.resolved.reduce((s, e) => s + e.moles, 0);
  const volumeM3 =
    (n0 * GAS_CONSTANT_J_PER_MOL_K * input.initialTK) /
    (input.pressureBar * 1e5);
  const nuO2 = stoichiometricO2PerMol(fuelRecord.composition);
  const fuel0 = inlet.value.species[input.fuel] ?? 0;
  const o20 = inlet.value.species.O2 ?? 0;
  const extentMax = Math.min(fuel0, o20 / Math.max(nuO2, 1e-12));
  if (!(extentMax > 0)) {
    return simFail(
      simError(
        SIM_ERROR_CODES.scenarioInvalid,
        "The reactor charge carries no combustible extent: either fuel or oxidizer is absent.",
        input,
      ),
    );
  }
  const wall = input.wall;
  if (
    wall !== undefined &&
    (!Number.isFinite(wall.temperatureK) ||
      wall.temperatureK <= 0 ||
      !Number.isFinite(wall.areaM2) ||
      wall.areaM2 < 0 ||
      !Number.isFinite(wall.heatTransferCoefficientWPerM2K) ||
      wall.heatTransferCoefficientWPerM2K < 0)
  ) {
    return simFail(
      simError(
        SIM_ERROR_CODES.scenarioInvalid,
        "The reactor's wall-loss boundary is malformed (positive wall temperature, non-negative area and coefficient required).",
        wall,
      ),
    );
  }
  // The global step's OWN stoichiometry — products per mole of fuel
  // (the fuel + its stoichiometric oxygen alone), never the whole
  // charge's products: the charge's inerts ride through untouched in
  // `initial`, and re-adding them here would double-count their mass.
  const products = completeCombustionOf({
    [input.fuel]: 1,
    O2: nuO2,
  });
  const chem: ReactorChemistry = {
    fuelName: input.fuel,
    initial: inlet.value.species,
    productPerFuelMole: products.species,
    nuO2,
    extentMax,
    volumeM3,
    basisMassKg: mix0.value.basisMassKg,
  };

  // The march state: U [J] and extent λ [mol on the basis]. The
  // negative CH₄ fuel order diverges at complete depletion, so the
  // extent rides a hair below its reachable maximum (the asymptote is
  // never reached — the composition's practical completion).
  const extentCap = extentMax * 0.9995;
  let uTotal =
    frozenInternalEnergyJPerKg(mix0.value, input.initialTK) * chem.basisMassKg;
  let extent = 0;
  let wallHeatRemovedJ = 0;
  const dt = input.durationS / steps;
  const initialU = uTotal;
  const conductanceWPerK =
    wall === undefined ? 0 : wall.heatTransferCoefficientWPerM2K * wall.areaM2;

  const temperatureAt = (uJ: number, lambda: number): number => {
    const mix = frozenMixture(speciesAtExtent(chem, lambda));
    if (!mix.ok) return input.initialTK;
    return frozenTemperatureFromInternalEnergyK(
      mix.value,
      uJ / chem.basisMassKg,
    );
  };

  const rateOf = (uJ: number, lambda: number): number => {
    // The RK4 STAGE extents clamp to the reachable band: a mid-step
    // stage can overshoot the depletion asymptote (extent + ½·dt·k past
    // its maximum), where the negative fuel order's [fuel]^a sees a
    // negative concentration and returns NaN — the clamped stage
    // evaluates at the cap's own finite rate instead, and the committed
    // update re-caps exactly as before (the march statement unchanged).
    const stageExtent = Math.min(Math.max(lambda, 0), extentCap);
    const tK = temperatureAt(uJ, stageExtent);
    const species = speciesAtExtent(chem, stageExtent);
    const cFuel = (species[chem.fuelName] ?? 0) / volumeM3;
    const cO2 = (species.O2 ?? 0) / volumeM3;
    return oneStepRateMolPerM3S(set.value, tK, cFuel, cO2) * volumeM3;
  };

  const wallLossW = (uJ: number, lambda: number): number => {
    if (wall === undefined) return 0;
    return conductanceWPerK * (temperatureAt(uJ, lambda) - wall.temperatureK);
  };

  const sampleAt = (
    timeS: number,
    uJ: number,
    lambda: number,
    wallQJ: number,
  ): ReactorSample => {
    const tK = temperatureAt(uJ, lambda);
    const nTot = totalMolesAt(chem, lambda);
    const pressureBar = (nTot * GAS_CONSTANT_J_PER_MOL_K * tK) / volumeM3 / 1e5;
    return {
      timeS,
      temperatureK: tK,
      pressureBar,
      progress: Math.min(lambda / extentMax, 1),
      wallHeatRemovedJ: wallQJ,
    };
  };

  const samples: ReactorSample[] = [sampleAt(0, uTotal, extent, 0)];
  let ignitionDelayS: number | undefined;
  const threshold = IGNITION_THRESHOLD_FRACTION * extentMax;
  let peakT = input.initialTK;
  let peakP = input.pressureBar;
  for (let step = 0; step < steps; step += 1) {
    const derivative = (
      uJ: number,
      lambda: number,
    ): readonly [number, number] => {
      const loss = wallLossW(uJ, lambda);
      return [-loss, rateOf(uJ, lambda)];
    };
    const k1 = derivative(uTotal, extent);
    const k2 = derivative(uTotal + 0.5 * dt * k1[0], extent + 0.5 * dt * k1[1]);
    const k3 = derivative(uTotal + 0.5 * dt * k2[0], extent + 0.5 * dt * k2[1]);
    const k4 = derivative(uTotal + dt * k3[0], extent + dt * k3[1]);
    const dU = (dt / 6) * (k1[0] + 2 * k2[0] + 2 * k3[0] + k4[0]);
    const dLambda = (dt / 6) * (k1[1] + 2 * k2[1] + 2 * k3[1] + k4[1]);
    // The state update IS the bookkeeping (the kinetic-energy-state
    // discipline): U changes by exactly −Q̇·dt, and Q_removed
    // accumulates the same term — the audit identity is arithmetic.
    uTotal += dU;
    wallHeatRemovedJ += -dU;
    extent = Math.min(extent + dLambda, extentCap);
    const timeS = (step + 1) * dt;
    if (ignitionDelayS === undefined && extent >= threshold) {
      ignitionDelayS = timeS;
    }
    // The end-of-step state is evaluated EVERY step — the march already
    // pays four temperature inversions per step in the RK4 derivative,
    // so one more is marginal — because the reported peaks are true
    // running maxima over the whole march, not maxima over the decimated
    // recorded samples (the decimation is a history-size knob, never a
    // physics knob; a peak hiding between recorded samples is still the
    // peak).
    const state = sampleAt(timeS, uTotal, extent, wallHeatRemovedJ);
    peakT = Math.max(peakT, state.temperatureK);
    peakP = Math.max(peakP, state.pressureBar);
    if (step % samplesOut === 0 || step === steps - 1) {
      samples.push(state);
    }
  }

  return simOk({
    fuel: input.fuel,
    equivalenceRatio: input.equivalenceRatio,
    initialTK: input.initialTK,
    pressure0Bar: input.pressureBar,
    samples: Object.freeze(samples),
    history: {
      columns: [
        { name: "time", unit: "s", samples: samples.map((s) => s.timeS) },
        {
          name: "temperature",
          unit: "K",
          samples: samples.map((s) => s.temperatureK),
        },
        {
          name: "pressure",
          unit: "bar",
          samples: samples.map((s) => s.pressureBar),
        },
        {
          name: "reaction-progress",
          unit: "-",
          samples: samples.map((s) => s.progress),
        },
        {
          name: "wall-heat-removed",
          unit: "J",
          samples: samples.map((s) => s.wallHeatRemovedJ),
        },
      ],
    },
    audit: {
      initialInternalEnergyJ: initialU,
      finalInternalEnergyJ: uTotal,
      wallHeatRemovedJ,
      residualJ: initialU - (uTotal + wallHeatRemovedJ),
    },
    ignitionDelayS,
    finalProgress: Math.min(extent / extentMax, 1),
    peakTemperatureK: peakT,
    peakPressureBar: peakP,
    adiabatic: wall === undefined,
  });
}
