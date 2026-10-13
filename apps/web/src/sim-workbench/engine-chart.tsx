/**
 * The published Otto engine charts (Phase 68c): the engine run's own
 * data rendered as the roadmap's named deliverables — the
 * PRESSURE-VS-CRANK-ANGLE trace (fired solid, motored dashed) and the
 * TORQUE CURVE (indicated and brake families both shown) over the
 * sweep axis, with the KNOCK BOUNDARY marked where the spark sweep's
 * Livengood–Wu integral first crosses 1. The fan-chart family's shape
 * (the 63d chart-as-data precedent): deterministic data first
 * (`engineChartOf` — pure extraction from the persisted result's own
 * history series and summary quantities), SVG second (the panel
 * renders polylines over a fixed geometry, `sim-compare`'s mapper),
 * nothing freehand.
 *
 * The chart's honesty is the result's honesty: every span and value
 * comes from the run's own series (never re-derived), the torque pair
 * is computed from the sweep's IMEP/BMEP columns over the run's own
 * displacement quantity, and a result without the engine family
 * declines to `null` — the panel stays absent instead of fabricating a
 * curve.
 */

import type { SimResult } from "@slopcad/sim-core";
import type { ReactElement } from "react";

/** The chart's deterministic geometry, px (the fan/compare panel family). */
const ENGINE_CHART_WIDTH = 256;
const ENGINE_CHART_HEIGHT = 96;

/** One polyline over a shared window, as deterministic data. */
export interface EngineChartSeries {
  readonly key:
    "pressure" | "pressure-motored" | "torque-indicated" | "torque-brake";
  readonly samples: readonly number[];
}

/** The pressure-vs-crank trace (fired and motored, bar). */
export interface EnginePressureTrace {
  readonly crankAngleDeg: readonly number[];
  readonly series: readonly EngineChartSeries[];
  readonly pressureMinBar: number;
  readonly pressureMaxBar: number;
}

/** The torque curve over the sweep axis (indicated + brake, N·m). */
export interface EngineTorqueCurve {
  readonly axisName: string;
  readonly axisUnit: string;
  readonly axisValues: readonly number[];
  readonly series: readonly EngineChartSeries[];
  readonly torqueMinNPerM: number;
  readonly torqueMaxNPerM: number;
  /** The first sweep value whose knock integral crossed 1, when one did. */
  readonly knockBoundary: number | undefined;
}

/** The published engine chart, as deterministic data. */
export interface SimEngineChart {
  readonly trace: EnginePressureTrace;
  readonly torque: EngineTorqueCurve | undefined;
  /** The headline scalars the panel annotates beside the charts. */
  readonly headline: {
    readonly imepPa: number;
    readonly bmepPa: number;
    readonly brakeTorqueNPerM: number;
    readonly brakePowerW: number;
    readonly brakeThermalEfficiency: number;
    readonly indicatedThermalEfficiency: number;
    readonly peakPressureBar: number;
    readonly knockIntegralMax: number;
    readonly wallHeatLossJ: number;
    readonly exhaustEnthalpyJ: number;
    readonly fuelEnergyJ: number;
  };
}

/** Reads one quantity's value off a result's summary. */
function quantityOf(result: SimResult, name: string): number | undefined {
  return result.summary.quantities.find((entry) => entry.name === name)?.value;
}

/** Reads one history series off a result. */
function historyOf(
  result: SimResult,
  name: string,
): { readonly unit: string; readonly samples: readonly number[] } | undefined {
  const series = result.histories.find((entry) => entry.name === name);
  return series === undefined ? undefined : series;
}

/** The y-axis position of a value, px inside the panel's geometry. */
function valueToY(
  min: number,
  max: number,
  value: number,
  height: number,
): number {
  const span = max - min;
  const normalized = span > 0 ? (value - min) / span : 0.5;
  return height - Math.min(1, Math.max(0, normalized)) * height;
}

/** The x-axis position of the i-th of n samples, px. */
function indexToX(index: number, count: number, width: number): number {
  if (count <= 1) return 0;
  return (index / (count - 1)) * width;
}

/** The polyline points of one series over its own index axis. */
function indexedPolylinePoints(
  samples: readonly number[],
  min: number,
  max: number,
): string {
  const count = samples.length;
  return samples
    .map(
      (sample, index) =>
        `${String(indexToX(index, count, ENGINE_CHART_WIDTH).toFixed(3))},${String(
          valueToY(min, max, sample, ENGINE_CHART_HEIGHT).toFixed(3),
        )}`,
    )
    .join(" ");
}

/** The polyline points of one series over a shared x-axis window. */
function windowedPolylinePoints(
  samples: readonly number[],
  axisValues: readonly number[],
  axisMin: number,
  axisMax: number,
  min: number,
  max: number,
): string {
  const span = axisMax - axisMin;
  return samples
    .map((sample, index) => {
      const axisValue = axisValues[index] ?? axisMin;
      const fraction = span > 0 ? (axisValue - axisMin) / span : 0.5;
      const x = Math.min(1, Math.max(0, fraction)) * ENGINE_CHART_WIDTH;
      return `${String(x.toFixed(3))},${String(
        valueToY(min, max, sample, ENGINE_CHART_HEIGHT).toFixed(3),
      )}`;
    })
    .join(" ");
}

/**
 * Extracts the engine chart from a completed engine-mode combustion
 * run: the pressure trace pair from the run's own histories, the
 * torque curve from the sweep's IMEP/BMEP columns over the run's
 * displacement, and the knock boundary from the sweep's integral
 * column. Any other result — a stove run, a flow run, a failed one —
 * declines to `null`.
 */
export function engineChartOf(result: SimResult): SimEngineChart | null {
  if (result.summary.status !== "completed") return null;
  const angle = historyOf(result, "crank-angle");
  const pressure = historyOf(result, "pressure");
  const motored = historyOf(result, "pressure-motored");
  if (angle === undefined || pressure === undefined || motored === undefined) {
    return null;
  }
  const imep = quantityOf(result, "imep");
  const bmep = quantityOf(result, "bmep");
  const brakeTorque = quantityOf(result, "brake-torque");
  const brakePower = quantityOf(result, "brake-power");
  const brakeEfficiency = quantityOf(result, "brake-thermal-efficiency");
  const indicatedEfficiency = quantityOf(
    result,
    "indicated-thermal-efficiency",
  );
  const peakPressure = quantityOf(result, "peak-pressure");
  const knockIntegralMax = quantityOf(result, "knock-integral-max");
  const wallHeatLossJ = quantityOf(result, "wall-heat-loss");
  const exhaustEnthalpyJ = quantityOf(result, "exhaust-enthalpy");
  const fuelEnergyJ = quantityOf(result, "fuel-chemical-energy");
  if (
    imep === undefined ||
    bmep === undefined ||
    brakeTorque === undefined ||
    brakePower === undefined ||
    brakeEfficiency === undefined ||
    indicatedEfficiency === undefined ||
    peakPressure === undefined ||
    knockIntegralMax === undefined ||
    wallHeatLossJ === undefined ||
    exhaustEnthalpyJ === undefined ||
    fuelEnergyJ === undefined
  ) {
    return null;
  }
  const sampleCount = Math.min(
    angle.samples.length,
    pressure.samples.length,
    motored.samples.length,
  );
  const pressureValues = [
    ...pressure.samples.slice(0, sampleCount),
    ...motored.samples.slice(0, sampleCount),
  ];
  const pressureMin = Math.min(...pressureValues);
  const pressureMaxRaw = Math.max(...pressureValues);
  const trace: EnginePressureTrace = {
    crankAngleDeg: angle.samples.slice(0, sampleCount),
    series: [
      { key: "pressure", samples: pressure.samples.slice(0, sampleCount) },
      {
        key: "pressure-motored",
        samples: motored.samples.slice(0, sampleCount),
      },
    ],
    pressureMinBar: pressureMin,
    pressureMaxBar:
      pressureMaxRaw === pressureMin ? pressureMin + 1 : pressureMaxRaw,
  };

  // The torque curve: the sweep's IMEP/BMEP columns over the run's own
  // displacement (torque = MEP · V_d / 4π, the four-stroke convention).
  const displacement = quantityOf(result, "displacement");
  const sweepAxisNames: readonly {
    readonly kind: string;
    readonly axis: string;
    readonly unit: string;
  }[] = [
    { kind: "compressionRatio", axis: "sweep:compressionRatio", unit: "1" },
    { kind: "equivalenceRatio", axis: "sweep:equivalenceRatio", unit: "1" },
    { kind: "sparkTiming", axis: "sweep:spark-timing-btdc", unit: "deg" },
  ];
  let torque: EngineTorqueCurve | undefined;
  if (displacement !== undefined) {
    for (const candidate of sweepAxisNames) {
      const axis = historyOf(result, candidate.axis);
      const imepSweep = historyOf(result, "sweep:imep");
      const bmepSweep = historyOf(result, "sweep:bmep");
      const knockSweep = historyOf(result, "sweep:knock-integral");
      if (
        axis === undefined ||
        imepSweep === undefined ||
        bmepSweep === undefined ||
        knockSweep === undefined
      ) {
        continue;
      }
      const rows = Math.min(
        axis.samples.length,
        imepSweep.samples.length,
        bmepSweep.samples.length,
        knockSweep.samples.length,
      );
      const indicatedTorque = imepSweep.samples
        .slice(0, rows)
        .map((mep) => (mep * displacement) / (4 * Math.PI));
      const brakeTorqueSeries = bmepSweep.samples
        .slice(0, rows)
        .map((mep) => (mep * displacement) / (4 * Math.PI));
      const values = [...indicatedTorque, ...brakeTorqueSeries];
      const min = Math.min(...values);
      const maxRaw = Math.max(...values);
      let knockBoundary: number | undefined;
      for (let index = 0; index < rows; index += 1) {
        if ((knockSweep.samples[index] ?? 0) >= 1) {
          knockBoundary = axis.samples[index];
          break;
        }
      }
      torque = {
        axisName: candidate.kind,
        axisUnit: candidate.unit,
        axisValues: axis.samples.slice(0, rows),
        series: [
          { key: "torque-indicated", samples: indicatedTorque },
          { key: "torque-brake", samples: brakeTorqueSeries },
        ],
        torqueMinNPerM: min,
        torqueMaxNPerM: maxRaw === min ? min + 1 : maxRaw,
        knockBoundary,
      };
      break;
    }
  }

  return {
    trace,
    torque,
    headline: {
      imepPa: imep,
      bmepPa: bmep,
      brakeTorqueNPerM: brakeTorque,
      brakePowerW: brakePower,
      brakeThermalEfficiency: brakeEfficiency,
      indicatedThermalEfficiency: indicatedEfficiency,
      peakPressureBar: peakPressure,
      knockIntegralMax,
      wallHeatLossJ,
      exhaustEnthalpyJ,
      fuelEnergyJ,
    },
  };
}

/** The stroke color of one series key. */
const SERIES_STROKE: Readonly<Record<EngineChartSeries["key"], string>> = {
  pressure: "#1d4ed8",
  "pressure-motored": "#b91c1c",
  "torque-indicated": "#1d4ed8",
  "torque-brake": "#111827",
};

/** Whether a series renders dashed (the motored twin, the brake line). */
function seriesDashed(key: EngineChartSeries["key"]): boolean {
  return key === "pressure-motored" || key === "torque-brake";
}

/**
 * The engine chart panel: the pressure trace (fired solid blue, the
 * motored twin dashed red) and, when the run swept, the torque curve
 * (indicated solid blue, brake dashed black) with the knock boundary's
 * vertical marker, plus the headline annotations — all from the
 * deterministic {@link SimEngineChart}.
 */
export function EngineChartPanel({
  chart,
}: {
  readonly chart: SimEngineChart;
}): ReactElement {
  const torque = chart.torque;
  const knockX =
    torque !== undefined &&
    torque.knockBoundary !== undefined &&
    torque.axisValues.length > 1
      ? (() => {
          const min = torque.axisValues[0] ?? 0;
          const max = torque.axisValues[torque.axisValues.length - 1] ?? 0;
          const span = max - min;
          if (span <= 0) return undefined;
          return (
            Math.min(1, Math.max(0, (torque.knockBoundary ?? 0) - min) / span) *
            ENGINE_CHART_WIDTH
          );
        })()
      : undefined;
  return (
    <div className="space-y-1" data-testid="workbench-sim-engine-chart">
      <svg
        width={ENGINE_CHART_WIDTH}
        height={ENGINE_CHART_HEIGHT}
        viewBox={`0 0 ${String(ENGINE_CHART_WIDTH)} ${String(ENGINE_CHART_HEIGHT)}`}
        role="img"
        aria-label="Cylinder pressure versus crank angle: the fired trace with the motored twin"
      >
        {chart.trace.series.map((series) => (
          <polyline
            key={series.key}
            data-series={series.key}
            fill="none"
            stroke={SERIES_STROKE[series.key]}
            strokeWidth={series.key === "pressure" ? 1.5 : 1}
            strokeDasharray={seriesDashed(series.key) ? "4 2" : undefined}
            points={indexedPolylinePoints(
              series.samples,
              chart.trace.pressureMinBar,
              chart.trace.pressureMaxBar,
            )}
          />
        ))}
      </svg>
      <p className="font-mono text-[10px]">
        P–θ (blue) · motored (dashed red) ·{" "}
        {String(chart.trace.crankAngleDeg.length)} samples
      </p>
      {torque === undefined ? null : (
        <>
          <svg
            width={ENGINE_CHART_WIDTH}
            height={ENGINE_CHART_HEIGHT}
            viewBox={`0 0 ${String(ENGINE_CHART_WIDTH)} ${String(ENGINE_CHART_HEIGHT)}`}
            role="img"
            aria-label={`Torque versus the ${torque.axisName} sweep: indicated and brake families`}
          >
            {torque.series.map((series) => (
              <polyline
                key={series.key}
                data-series={series.key}
                fill="none"
                stroke={SERIES_STROKE[series.key]}
                strokeWidth={series.key === "torque-indicated" ? 1.5 : 1}
                strokeDasharray={seriesDashed(series.key) ? "4 2" : undefined}
                points={windowedPolylinePoints(
                  series.samples,
                  torque.axisValues,
                  torque.axisValues[0] ?? 0,
                  torque.axisValues[torque.axisValues.length - 1] ?? 0,
                  torque.torqueMinNPerM,
                  torque.torqueMaxNPerM,
                )}
              />
            ))}
            {knockX === undefined ? null : (
              <line
                data-marker="knock-boundary"
                x1={knockX}
                y1={0}
                x2={knockX}
                y2={ENGINE_CHART_HEIGHT}
                stroke="#b91c1c"
                strokeWidth={1}
                strokeDasharray="2 2"
              />
            )}
          </svg>
          <p className="font-mono text-[10px]">
            torque vs {torque.axisName} ({torque.axisUnit}) · indicated (blue) ·
            brake (dashed)
            {torque.knockBoundary === undefined
              ? ""
              : ` · knock boundary ${String(torque.knockBoundary)}`}
          </p>
        </>
      )}
      <p
        className="font-mono text-[10px]"
        data-testid="workbench-sim-engine-chart-headline"
      >
        IMEP {(chart.headline.imepPa / 1e5).toFixed(2)} bar · BMEP{" "}
        {(chart.headline.bmepPa / 1e5).toFixed(2)} bar · T_br{" "}
        {chart.headline.brakeTorqueNPerM.toFixed(1)} N·m · P_br{" "}
        {chart.headline.brakePowerW.toFixed(0)} W · η_i{" "}
        {(chart.headline.indicatedThermalEfficiency * 100).toFixed(1)}% · η_b{" "}
        {(chart.headline.brakeThermalEfficiency * 100).toFixed(1)}% · p_max{" "}
        {chart.headline.peakPressureBar.toFixed(1)} bar · knock ∫{" "}
        {chart.headline.knockIntegralMax.toFixed(1)}
      </p>
      <p className="font-mono text-[10px]">
        fuel {chart.headline.fuelEnergyJ.toFixed(0)} J = brake + wall{" "}
        {chart.headline.wallHeatLossJ.toFixed(0)} J + exhaust{" "}
        {chart.headline.exhaustEnthalpyJ.toFixed(0)} J (+ friction)
      </p>
    </div>
  );
}
