/**
 * The published fan performance chart (Phase 66c): the motor-driven
 * fan run's own data rendered as the roadmap's named deliverable — the
 * fan curve T_load(ω) with the motor line and the FOUND operating
 * point superimposed. The 63d comparison-chart family's shape:
 * deterministic data first (`fanChartOf` — pure extraction from the
 * persisted result's history pair and summary quantities), SVG second
 * (the panel renders polylines over a fixed geometry, `sim-compare`'s
 * `simCurvePolylinePoints` mapper), nothing freehand.
 *
 * The chart's honesty is the result's honesty: the ladder span and the
 * series lengths come from the run's own quantities, the operating
 * point is the solve's found pair (never re-derived), and a result
 * without the motor-driven family declines to `null` — the panel stays
 * absent instead of fabricating a curve.
 */

import type { SimResult } from "@slopcad/sim-core";
import type { ReactElement } from "react";

import { simCurvePolylinePoints } from "./sim-compare";

/** The chart's deterministic geometry, px (the compare panel's family). */
const FAN_CHART_WIDTH = 256;
const FAN_CHART_HEIGHT = 96;

/** One torque-speed polyline over the run's uniform ω ladder. */
export interface FanChartSeries {
  readonly key: "load" | "motor";
  /** The series' samples, N·m at the ladder's uniform ω rungs. */
  readonly samples: readonly number[];
}

/** The published fan performance chart, as deterministic data. */
export interface SimFanChart {
  /** The ladder's span, rad/s (the x-axis domain, from the run). */
  readonly ladderMinRadPerS: number;
  readonly ladderMaxRadPerS: number;
  readonly series: readonly FanChartSeries[];
  /** The shared torque window both curves and the point render over. */
  readonly torqueMinNPerM: number;
  readonly torqueMaxNPerM: number;
  /** The FOUND operating point (the solve's own pair, superimposed). */
  readonly operatingOmegaRadPerS: number;
  readonly operatingTorqueNPerM: number;
  /** The headline scalars the panel annotates beside the curve. */
  readonly headline: {
    readonly operatingRpm: number;
    readonly bladePassFrequencyHz: number;
    readonly airflowM3PerS: number;
    readonly pressureRisePa: number;
    readonly fanReynoldsTip: number;
    /** The S9 qualitative flags the run's regime record carries. */
    readonly flags: readonly string[];
  };
}

/** Reads one quantity's value off a result's summary. */
function quantityOf(result: SimResult, name: string): number | undefined {
  return result.summary.quantities.find((entry) => entry.name === name)?.value;
}

/**
 * Extracts the fan chart from a completed motor-driven run: the load
 * and motor history pair over the ladder span the summary carries, the
 * operating point from the solve's own quantities. Any other result —
 * a 2D tunnel, a fixed-rpm run, a failed one — declines to `null`.
 */
export function fanChartOf(result: SimResult): SimFanChart | null {
  if (result.summary.status !== "completed") return null;
  const load = result.histories.find((series) => series.name === "load-torque");
  const motor = result.histories.find(
    (series) => series.name === "motor-torque",
  );
  const ladderMin = quantityOf(result, "ladder-min-speed");
  const ladderMax = quantityOf(result, "ladder-max-speed");
  const omega = quantityOf(result, "operating-speed");
  const torque = quantityOf(result, "operating-torque");
  const rpm = quantityOf(result, "operating-rpm");
  const bpf = quantityOf(result, "blade-pass-frequency");
  const airflow = quantityOf(result, "airflow");
  const deltaP = quantityOf(result, "pressure-rise");
  const reynolds = quantityOf(result, "fan-reynolds-tip");
  if (
    load === undefined ||
    motor === undefined ||
    ladderMin === undefined ||
    ladderMax === undefined ||
    omega === undefined ||
    torque === undefined ||
    rpm === undefined ||
    bpf === undefined ||
    airflow === undefined ||
    deltaP === undefined ||
    reynolds === undefined
  ) {
    return null;
  }
  const values = [...load.samples, ...motor.samples, 0, torque];
  const torqueMin = Math.min(...values);
  const torqueMax = Math.max(...values);
  return {
    ladderMinRadPerS: ladderMin,
    ladderMaxRadPerS: ladderMax,
    series: [
      { key: "load", samples: [...load.samples] },
      { key: "motor", samples: [...motor.samples] },
    ],
    torqueMinNPerM: torqueMin,
    torqueMaxNPerM: torqueMax === torqueMin ? torqueMin + 1 : torqueMax,
    operatingOmegaRadPerS: omega,
    operatingTorqueNPerM: torque,
    headline: {
      operatingRpm: rpm,
      bladePassFrequencyHz: bpf,
      airflowM3PerS: airflow,
      pressureRisePa: deltaP,
      fanReynoldsTip: reynolds,
      flags: [...result.summary.regime.qualitative],
    },
  };
}

/** The x-axis position of a speed, px inside the panel's geometry. */
function speedToX(chart: SimFanChart, omegaRadPerS: number): number {
  const span = chart.ladderMaxRadPerS - chart.ladderMinRadPerS;
  const fraction =
    span > 0 ? (omegaRadPerS - chart.ladderMinRadPerS) / span : 0.5;
  return Math.min(FAN_CHART_WIDTH, Math.max(0, fraction * FAN_CHART_WIDTH));
}

/** The y-axis position of a torque, px inside the panel's geometry. */
function torqueToY(chart: SimFanChart, torqueNPerM: number): number {
  const span = chart.torqueMaxNPerM - chart.torqueMinNPerM;
  const normalized =
    span > 0 ? (torqueNPerM - chart.torqueMinNPerM) / span : 0.5;
  return (
    FAN_CHART_HEIGHT - Math.min(1, Math.max(0, normalized)) * FAN_CHART_HEIGHT
  );
}

/**
 * The fan performance chart panel: the fan curve (solid blue) with the
 * motor line (dashed red) and the operating point superimposed (the
 * crosshair marker), plus the headline annotations — all from the
 * deterministic {@link SimFanChart}.
 */
export function FanChartPanel({
  chart,
}: {
  readonly chart: SimFanChart;
}): ReactElement {
  const pointX = speedToX(chart, chart.operatingOmegaRadPerS);
  const pointY = torqueToY(chart, chart.operatingTorqueNPerM);
  return (
    <div className="space-y-1" data-testid="workbench-sim-fan-chart">
      <svg
        width={FAN_CHART_WIDTH}
        height={FAN_CHART_HEIGHT}
        viewBox={`0 0 ${String(FAN_CHART_WIDTH)} ${String(FAN_CHART_HEIGHT)}`}
        role="img"
        aria-label="Fan performance chart: the fan load curve with the motor line and the operating point superimposed"
      >
        {chart.series.map((series) => (
          <polyline
            key={series.key}
            data-series={series.key}
            fill="none"
            stroke={series.key === "load" ? "#1d4ed8" : "#b91c1c"}
            strokeWidth={series.key === "load" ? 1.5 : 1}
            strokeDasharray={series.key === "motor" ? "4 2" : undefined}
            points={simCurvePolylinePoints(
              series.samples,
              chart.torqueMinNPerM,
              chart.torqueMaxNPerM,
              FAN_CHART_WIDTH,
              FAN_CHART_HEIGHT,
            )}
          />
        ))}
        {/* The operating point, superimposed: a crosshair marker. */}
        <g data-marker="operating-point">
          <circle
            cx={pointX}
            cy={pointY}
            r={3}
            fill="none"
            stroke="#111827"
            strokeWidth={1.5}
          />
          <line
            x1={pointX - 6}
            y1={pointY}
            x2={pointX + 6}
            y2={pointY}
            stroke="#111827"
            strokeWidth={1}
          />
          <line
            x1={pointX}
            y1={pointY - 6}
            x2={pointX}
            y2={pointY + 6}
            stroke="#111827"
            strokeWidth={1}
          />
        </g>
      </svg>
      <p className="font-mono text-[10px]">
        fan curve (blue) · motor line (dashed) · operating point ×
      </p>
      <p
        className="font-mono text-[10px]"
        data-testid="workbench-sim-fan-chart-headline"
      >
        {chart.headline.operatingRpm.toFixed(2)} rpm ·{" "}
        {chart.headline.bladePassFrequencyHz.toFixed(3)} Hz BPF · Q{" "}
        {(chart.headline.airflowM3PerS * 1e6).toFixed(2)} cm³/s · ΔP{" "}
        {chart.headline.pressureRisePa.toFixed(4)} Pa · Re_tip{" "}
        {chart.headline.fanReynoldsTip.toFixed(1)}
        {chart.headline.flags.length === 0
          ? ""
          : ` · ${chart.headline.flags.join(", ")}`}
      </p>
    </div>
  );
}
