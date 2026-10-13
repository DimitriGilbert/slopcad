/**
 * The flame module (ROADMAP-SIM Phase 68a): the adiabatic flame
 * temperature — the HP equilibrium over a premixed fuel–air inlet —
 * and the fuel–air table, an equivalence-ratio sweep of adiabatic
 * states projected through sim-core's deterministic history-table
 * discipline (CSV export byte-identical across identical runs, law S7).
 * One solve per φ; every row reports its own convergence honesty. The
 * positioning is the roadmap's: engineering-adjacent — equilibrium
 * values from a curated 11-species product set, accuracy bands stated
 * in the tests against published values, not hidden.
 */

import {
  exportSimHistoryCsv,
  simError,
  simFail,
  simOk,
  SIM_ERROR_CODES,
  type SimError,
  type SimHistoryTable,
  type SimParseResult,
} from "@slopcad/sim-core";

import {
  solveEquilibriumHP,
  type EquilibriumSolution,
  type EquilibriumSolverOptions,
} from "./equilibrium";
import { premixedFuelAirInlet } from "./inlet";
import { EQUILIBRIUM_SPECIES_NAMES } from "./thermo-data";

/** An adiabatic flame state: the equilibrium plus its provenance. */
export interface AdiabaticFlameResult {
  readonly fuelName: string;
  readonly equivalenceRatio: number;
  readonly inletTK: number;
  readonly pressureBar: number;
  readonly solution: EquilibriumSolution;
}

/**
 * The adiabatic flame temperature of a premixed fuel–air mixture: the
 * HP equilibrium seeded at the inlet temperature. Declines loudly when
 * the inlet is malformed or the solver misses its discipline.
 */
export function adiabaticFlame(input: {
  readonly fuel: string;
  readonly equivalenceRatio: number;
  readonly inletTK: number;
  readonly pressureBar: number;
  readonly fuelMoles?: number;
  readonly options?: EquilibriumSolverOptions;
}): SimParseResult<AdiabaticFlameResult, SimError> {
  const inlet = premixedFuelAirInlet({
    fuel: input.fuel,
    equivalenceRatio: input.equivalenceRatio,
    inletTK: input.inletTK,
    ...(input.fuelMoles === undefined ? {} : { fuelMoles: input.fuelMoles }),
  });
  if (!inlet.ok) return inlet;
  const solved = solveEquilibriumHP({
    elementTotals: inlet.value.elementTotals,
    targetEnthalpyJ: inlet.value.enthalpyJ,
    pressureBar: input.pressureBar,
    initialTemperatureK: input.inletTK,
    ...(input.options === undefined ? {} : { options: input.options }),
  });
  if (!solved.ok) return solved;
  return simOk({
    fuelName: inlet.value.fuelName,
    equivalenceRatio: inlet.value.equivalenceRatio,
    inletTK: inlet.value.inletTK,
    pressureBar: input.pressureBar,
    solution: solved.value,
  });
}

/** One fuel–air table row: φ, the flame temperature, the majors. */
export interface FuelAirTableRow {
  readonly equivalenceRatio: number;
  readonly adiabaticFlameTemperatureK: number;
  readonly moleFractions: Readonly<Record<string, number>>;
  readonly iterations: number;
}

/** A swept fuel–air table plus its deterministic projection. */
export interface FuelAirTable {
  readonly fuelName: string;
  readonly inletTK: number;
  readonly pressureBar: number;
  readonly rows: readonly FuelAirTableRow[];
  /** The SimHistoryTable projection (CSV export's input). */
  readonly history: SimHistoryTable;
}

/**
 * Sweeps the equivalence ratio from `phiFrom` to `phiTo` (inclusive)
 * in `steps` intervals, one adiabatic solve per row. φ must stay
 * inside the inlet module's (0, 5] bound; steps ≥ 1; from ≠ to is not
 * required (a one-row table is legitimate).
 */
export function fuelAirTable(input: {
  readonly fuel: string;
  readonly phiFrom: number;
  readonly phiTo: number;
  readonly steps: number;
  readonly inletTK: number;
  readonly pressureBar: number;
  readonly fuelMoles?: number;
  readonly options?: EquilibriumSolverOptions;
}): SimParseResult<FuelAirTable, SimError> {
  const { phiFrom, phiTo, steps } = input;
  if (!Number.isFinite(steps) || !Number.isInteger(steps) || steps < 1) {
    return simFail(
      simError(
        SIM_ERROR_CODES.scenarioInvalid,
        `A fuel–air table needs at least 1 interval; it asked for ${String(steps)}.`,
        steps,
      ),
    );
  }
  if (
    !Number.isFinite(phiFrom) ||
    !Number.isFinite(phiTo) ||
    phiFrom <= 0 ||
    phiTo <= 0
  ) {
    return simFail(
      simError(
        SIM_ERROR_CODES.scenarioInvalid,
        `A fuel–air table's equivalence-ratio span must be positive on both ends; it was [${String(phiFrom)}, ${String(phiTo)}].`,
        { phiFrom, phiTo },
      ),
    );
  }
  const rows: FuelAirTableRow[] = [];
  let fuelName = input.fuel;
  for (let step = 0; step <= steps; step += 1) {
    const phi = phiFrom + ((phiTo - phiFrom) * step) / steps;
    const flame = adiabaticFlame({
      fuel: input.fuel,
      equivalenceRatio: phi,
      inletTK: input.inletTK,
      pressureBar: input.pressureBar,
      ...(input.fuelMoles === undefined ? {} : { fuelMoles: input.fuelMoles }),
      ...(input.options === undefined ? {} : { options: input.options }),
    });
    if (!flame.ok) return flame;
    fuelName = flame.value.fuelName;
    rows.push({
      equivalenceRatio: phi,
      adiabaticFlameTemperatureK: flame.value.solution.temperatureK,
      moleFractions: flame.value.solution.moleFractions,
      iterations: flame.value.solution.iterations,
    });
  }
  const history: SimHistoryTable = {
    columns: [
      {
        name: "equivalence-ratio",
        unit: "-",
        samples: rows.map((row) => row.equivalenceRatio),
      },
      {
        name: "adiabatic-flame-temperature",
        unit: "K",
        samples: rows.map((row) => row.adiabaticFlameTemperatureK),
      },
      ...EQUILIBRIUM_SPECIES_NAMES.map((name) => ({
        name: `mole-fraction-${name}`,
        unit: "-",
        samples: rows.map((row) => row.moleFractions[name] ?? 0),
      })),
    ],
  };
  return simOk({
    fuelName,
    inletTK: input.inletTK,
    pressureBar: input.pressureBar,
    rows: Object.freeze(rows),
    history,
  });
}

/** Exports a fuel–air table as deterministic CSV (the S7 discipline). */
export function exportFuelAirTableCsv(
  table: FuelAirTable,
): SimParseResult<string, SimError> {
  return exportSimHistoryCsv(table.history);
}
