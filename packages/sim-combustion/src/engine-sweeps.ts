/**
 * The 0D engine-cycle sweeps (ROADMAP-SIM Phase 68b): efficiency
 * trends against compression ratio, air–fuel ratio (equivalence
 * ratio), and spark timing — sweeps as DATA, projected through
 * sim-core's deterministic history-table discipline (CSV export
 * byte-identical across identical runs, law S7) exactly like the 68a
 * fuel–air table. One full cycle run per row; a row's decline fails
 * the sweep loudly (never a silently skipped point). The
 * compression-ratio and spark-timing sweeps share one charge
 * composition, so the burned-zone equilibrium property table is
 * identical across their rows; the equivalence-ratio sweep rebuilds
 * it per row (a richer or leaner charge is a different equilibrium).
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
  runOttoCycle,
  type OttoCycleResult,
  type OttoCycleScenario,
} from "./engine-cycle";

/** The sweep axes the cycle exposes. */
export type OttoSweepKind =
  "compressionRatio" | "equivalenceRatio" | "sparkTiming";

/** One sweep row: the axis value plus the trend quantities. */
export interface OttoSweepRow {
  readonly sweepValue: number;
  readonly imepPa: number;
  readonly indicatedThermalEfficiency: number;
  readonly bmepPa: number;
  readonly brakeThermalEfficiency: number;
  readonly fmepPa: number;
  readonly knockIntegral: number;
  readonly peakPressureBar: number;
  /** The derived burn duration, degrees crank. */
  readonly burnDurationDeg: number;
}

/** A swept cycle study plus its deterministic projection. */
export interface OttoSweepResult {
  readonly kind: OttoSweepKind;
  readonly rows: readonly OttoSweepRow[];
  readonly history: SimHistoryTable;
  /** The full per-row cycle results (heavy; the trend data is `rows`). */
  readonly cycles: readonly OttoCycleResult[];
}

function withSweepValue(
  base: OttoCycleScenario,
  kind: OttoSweepKind,
  value: number,
): OttoCycleScenario {
  switch (kind) {
    case "compressionRatio":
      return {
        ...base,
        geometry: { ...base.geometry, compressionRatio: value },
      };
    case "equivalenceRatio":
      return {
        ...base,
        charge: { ...base.charge, equivalenceRatio: value },
      };
    case "sparkTiming":
      return {
        ...base,
        spark: { ...base.spark, timingBTDCDeg: value },
      };
  }
}

/**
 * Sweeps the axis from `from` to `to` (inclusive) in `steps`
 * intervals, one cycle run per row. Declines propagate: a malformed
 * axis or a row the cycle declines (an over-rich charge, a flame-speed
 * refusal) fails the sweep naming the row's value.
 */
export function ottoCycleSweep(input: {
  readonly base: OttoCycleScenario;
  readonly kind: OttoSweepKind;
  readonly from: number;
  readonly to: number;
  readonly steps: number;
}): SimParseResult<OttoSweepResult, SimError> {
  const { kind, from, to, steps } = input;
  if (!Number.isInteger(steps) || steps < 1) {
    return simFail(
      simError(
        SIM_ERROR_CODES.scenarioInvalid,
        `A cycle sweep needs at least 1 interval; it asked for ${String(steps)}.`,
        steps,
      ),
    );
  }
  if (!Number.isFinite(from) || !Number.isFinite(to)) {
    return simFail(
      simError(
        SIM_ERROR_CODES.scenarioInvalid,
        `A cycle sweep's span must be finite on both ends; it was [${String(from)}, ${String(to)}].`,
        { from, to },
      ),
    );
  }
  const rows: OttoSweepRow[] = [];
  const cycles: OttoCycleResult[] = [];
  for (let step = 0; step <= steps; step += 1) {
    const value = from + ((to - from) * step) / steps;
    const run = runOttoCycle(withSweepValue(input.base, kind, value));
    if (!run.ok) {
      return simFail(
        simError(
          run.error.code,
          `The ${kind} sweep declined at ${String(value)}: ${run.error.message}`,
          { sweepValue: value, kind },
        ),
      );
    }
    cycles.push(run.value);
    rows.push({
      sweepValue: value,
      imepPa: run.value.indicated.imepPa,
      indicatedThermalEfficiency: run.value.indicated.thermalEfficiency,
      bmepPa: run.value.brake.bmepPa,
      brakeThermalEfficiency: run.value.brake.thermalEfficiency,
      fmepPa: run.value.brake.fmepPa,
      knockIntegral: run.value.knock.integralMax,
      peakPressureBar: run.value.peak.pressureBar,
      burnDurationDeg: (run.value.burn.burnDurationRad * 180) / Math.PI,
    });
  }
  const history: SimHistoryTable = {
    columns: [
      {
        name: kind === "sparkTiming" ? "spark-timing-btdc" : kind,
        unit:
          kind === "equivalenceRatio"
            ? "-"
            : kind === "sparkTiming"
              ? "deg"
              : "-",
        samples: rows.map((row) => row.sweepValue),
      },
      { name: "imep", unit: "Pa", samples: rows.map((r) => r.imepPa) },
      {
        name: "indicated-thermal-efficiency",
        unit: "-",
        samples: rows.map((r) => r.indicatedThermalEfficiency),
      },
      { name: "bmep", unit: "Pa", samples: rows.map((r) => r.bmepPa) },
      {
        name: "brake-thermal-efficiency",
        unit: "-",
        samples: rows.map((r) => r.brakeThermalEfficiency),
      },
      { name: "fmep", unit: "Pa", samples: rows.map((r) => r.fmepPa) },
      {
        name: "knock-integral",
        unit: "-",
        samples: rows.map((r) => r.knockIntegral),
      },
      {
        name: "peak-pressure",
        unit: "bar",
        samples: rows.map((r) => r.peakPressureBar),
      },
      {
        name: "burn-duration",
        unit: "deg",
        samples: rows.map((r) => r.burnDurationDeg),
      },
    ],
  };
  return simOk({ kind, rows: Object.freeze(rows), history, cycles });
}

/** Exports a cycle sweep as deterministic CSV (the S7 discipline). */
export function exportOttoSweepCsv(
  sweep: OttoSweepResult,
): SimParseResult<string, SimError> {
  return exportSimHistoryCsv(sweep.history);
}
