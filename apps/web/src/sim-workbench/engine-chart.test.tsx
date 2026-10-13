/**
 * The engine charts' tests (Phase 68c, the fan chart's test
 * precedent): the deterministic extraction is the product — the
 * pressure trace pair from the run's own histories, the torque curve
 * pair from the sweep's IMEP/BMEP columns over the run's own
 * displacement, the knock boundary from the sweep's integral column,
 * and the declines (a stove run, a result without the family). The
 * panel half: both SVGs render their polylines from the deterministic
 * data, with the knock boundary's marker line aboard.
 */

import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { SimResult } from "@slopcad/sim-core";

import { EngineChartPanel, engineChartOf } from "./engine-chart";

afterEach(cleanup);

/** A completed engine-mode result carrying the chart family. */
function engineResult(): SimResult {
  return {
    summary: {
      schemaVersion: 1,
      scenarioSnapshotHash: "hash",
      status: "completed",
      regime: { qualitative: [] },
      quantities: [
        { name: "imep", value: 1.2e6, unit: "Pa" },
        { name: "bmep", value: 1.0e6, unit: "Pa" },
        { name: "brake-torque", value: 40, unit: "N*m" },
        { name: "brake-power", value: 6000, unit: "W" },
        { name: "brake-thermal-efficiency", value: 0.33, unit: "1" },
        { name: "indicated-thermal-efficiency", value: 0.38, unit: "1" },
        { name: "peak-pressure", value: 60, unit: "bar" },
        { name: "knock-integral-max", value: 5, unit: "1" },
        { name: "wall-heat-loss", value: 300, unit: "J" },
        { name: "exhaust-enthalpy", value: 700, unit: "J" },
        { name: "fuel-chemical-energy", value: 1800, unit: "J" },
        { name: "displacement", value: 0.0005, unit: "m^3" },
      ],
    },
    fields: [],
    histories: [
      { name: "crank-angle", unit: "deg", samples: [-180, -90, 0, 90, 180] },
      { name: "pressure", unit: "bar", samples: [1, 15, 60, 20, 2] },
      { name: "pressure-motored", unit: "bar", samples: [1, 8, 18, 8, 1] },
      { name: "knock-integral", unit: "1", samples: [0, 1, 3, 5, 5] },
      {
        name: "sweep:spark-timing-btdc",
        unit: "deg",
        samples: [10, 20, 30, 40],
      },
      {
        name: "sweep:imep",
        unit: "Pa",
        samples: [1.1e6, 1.2e6, 1.25e6, 1.2e6],
      },
      {
        name: "sweep:bmep",
        unit: "Pa",
        samples: [0.9e6, 1.0e6, 1.05e6, 1.0e6],
      },
      { name: "sweep:knock-integral", unit: "1", samples: [0.5, 2, 6, 20] },
    ],
  };
}

/** The same result without the sweep series (the no-sweep branch). */
function noSweepResult(): SimResult {
  const result = engineResult();
  return {
    ...result,
    histories: result.histories.filter(
      (series) => !series.name.startsWith("sweep:"),
    ),
  };
}

describe("the engine chart extraction", () => {
  it("extracts the trace pair, the torque curve, and the knock boundary", () => {
    const chart = engineChartOf(engineResult());
    if (chart === null) throw new Error("the chart declined a valid result");
    expect(chart.trace.series.map((series) => series.key)).toEqual([
      "pressure",
      "pressure-motored",
    ]);
    expect(chart.trace.crankAngleDeg.length).toBe(5);
    expect(chart.trace.pressureMaxBar).toBe(60);
    const torque = chart.torque;
    if (torque === undefined) throw new Error("the torque curve declined");
    expect(torque.axisName).toBe("sparkTiming");
    expect(torque.axisUnit).toBe("deg");
    // Torque = MEP · V_d / 4π: the indicated pair from IMEP (the
    // 0.5 L demo's own displacement class, m³).
    const indicatedFirst = torque.series[0]?.samples[0] ?? 0;
    expect(indicatedFirst).toBeCloseTo((1.1e6 * 0.0005) / (4 * Math.PI), 6);
    // The brake pair sits strictly below the indicated pair.
    expect(torque.series[1]?.samples[0] ?? 0).toBeLessThan(indicatedFirst);
    // The knock boundary: the FIRST swept advance whose integral ≥ 1.
    expect(torque.knockBoundary).toBe(20);
    expect(chart.headline.imepPa).toBe(1.2e6);
    expect(chart.headline.brakeThermalEfficiency).toBeLessThan(
      chart.headline.indicatedThermalEfficiency,
    );
  });

  it("carries no torque curve when the run did not sweep", () => {
    const chart = engineChartOf(noSweepResult());
    if (chart === null) throw new Error("the chart declined a valid result");
    expect(chart.torque).toBeUndefined();
    expect(chart.trace.series.length).toBe(2);
  });

  it("declines results without the engine family", () => {
    const stoveIsh: SimResult = {
      summary: {
        schemaVersion: 1,
        scenarioSnapshotHash: "hash",
        status: "completed",
        regime: { qualitative: [] },
        quantities: [{ name: "max-temperature", value: 300, unit: "K" }],
      },
      fields: [],
      histories: [
        { name: "time", unit: "s", samples: [0, 1] },
        { name: "fire:progress", unit: "1", samples: [0, 1] },
      ],
    };
    expect(engineChartOf(stoveIsh)).toBeNull();
  });
});

describe("the EngineChartPanel component", () => {
  it("renders both SVGs' polylines and the knock marker from the data", () => {
    const chart = engineChartOf(engineResult());
    if (chart === null) throw new Error("the chart declined a valid result");
    const { container } = render(<EngineChartPanel chart={chart} />);
    const panel = container.querySelector(
      "[data-testid='workbench-sim-engine-chart']",
    );
    if (panel === null) throw new Error("the panel did not render");
    const polylines = panel.querySelectorAll("polyline[data-series]");
    expect(polylines.length).toBe(4);
    const keys = [...polylines].map((line) => line.getAttribute("data-series"));
    expect(keys).toContain("pressure");
    expect(keys).toContain("pressure-motored");
    expect(keys).toContain("torque-indicated");
    expect(keys).toContain("torque-brake");
    expect(
      panel.querySelectorAll("line[data-marker='knock-boundary']").length,
    ).toBe(1);
    // Every polyline carries deterministic point data.
    for (const line of polylines) {
      const points = line.getAttribute("points") ?? "";
      expect(points.length).toBeGreaterThan(0);
      expect(points).toMatch(/^[\d.,\s-]+$/);
    }
  });
});
