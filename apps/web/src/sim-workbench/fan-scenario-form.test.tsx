/**
 * The fan-scenario form's tests (Phase 66c), the flow form's pattern:
 * the Formedible CONFIG OBJECT is the product — every schema key has
 * its field, the option lists are the roadmap vocabularies, the
 * defaults ARE the motor-driven fan demo, and the mapper turns
 * submitted values into a cad-core scenario draft the document accepts
 * (a flow3d stance, kind-locked, the motor selection branded at the
 * boundary). The fan chart's extraction is pinned beside it: the
 * published chart is deterministic data off a completed motor-driven
 * result, and anything else declines to null.
 */

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  addDocumentSimulation,
  type SimScenarioDraft,
} from "@slopcad/cad-core";
import type { SimResult } from "@slopcad/sim-core";

import {
  FAN_FORM_DEFAULT_VALUES,
  FanScenarioForm,
  fanScenarioDraftOf,
  fanScenarioFields,
  fanScenarioSchema,
} from "./fan-scenario-form";
import { FanChartPanel, fanChartOf } from "./fan-chart";
import { addFanDemoScenario, fanDemoDocument } from "./fan-demo";

afterEach(cleanup);

describe("the fan-scenario form config", () => {
  it("gives every schema key exactly one field, with the roadmap vocabularies", () => {
    const schemaKeys = Object.keys(
      fanScenarioSchema.shape,
    ) as readonly (keyof typeof FAN_FORM_DEFAULT_VALUES)[];
    const fields = fanScenarioFields([
      { value: "mot_fan-demo", label: "fan demo motor" },
    ]);
    const fieldNames = fields.map((field) => field.name);
    expect(new Set(fieldNames).size).toBe(fieldNames.length);
    expect([...fieldNames].sort()).toEqual([...schemaKeys].sort());
    const optionValuesOf = (
      name: keyof typeof FAN_FORM_DEFAULT_VALUES,
    ): readonly string[] => {
      const field = fields.find((entry) => entry.name === name);
      const options = field?.options;
      if (typeof options !== "object" || options === null) return [];
      return options.map((option) =>
        typeof option === "string" ? option : option.value,
      );
    };
    expect(optionValuesOf("fluid")).toEqual(["air", "water", "glycol"]);
    expect(optionValuesOf("rotationKind")).toEqual([
      "mrf",
      "resolved-rotation",
    ]);
    expect(optionValuesOf("rpmMode")).toEqual(["motor", "fixed"]);
    expect(optionValuesOf("motorId")).toEqual(["mot_fan-demo"]);
  });

  it("defaults ARE the motor-driven fan demo", () => {
    expect(FAN_FORM_DEFAULT_VALUES.name).toBe("fan-in-tube");
    expect(FAN_FORM_DEFAULT_VALUES.rpmMode).toBe("motor");
    expect(FAN_FORM_DEFAULT_VALUES.rotationKind).toBe("mrf");
    expect(FAN_FORM_DEFAULT_VALUES.motorId).toBe("mot_fan-demo");
    expect(FAN_FORM_DEFAULT_VALUES.bladeCount).toBe(4);
  });

  it("maps the defaults onto a draft the demo document accepts", () => {
    const draft = fanScenarioDraftOf(FAN_FORM_DEFAULT_VALUES);
    const document = fanDemoDocument();
    const added = addDocumentSimulation(document, draft);
    if (!added.ok) throw new Error(added.error.message);
    expect(added.value.scenario.kind).toBe("flow");
    expect(added.value.scenario.flow3d?.rotation?.rpmMode).toBe("motor");
    expect(added.value.scenario.motorId).toBe("mot_fan-demo");
    // The demo scenario helper and the form defaults agree.
    const helper = addFanDemoScenario(fanDemoDocument());
    expect(helper.scenarioName).toBe(added.value.scenario.name);
  });

  it("fixed mode omits the motor and carries the authored rate", () => {
    const draft = fanScenarioDraftOf({
      ...FAN_FORM_DEFAULT_VALUES,
      rpmMode: "fixed",
      fixedRpm: 120,
    });
    expect(draft.motorId).toBeUndefined();
    expect(draft.flow3d?.rotation?.fixedRpm).toBe(120);
    const added = addDocumentSimulation(fanDemoDocument(), draft);
    if (!added.ok) throw new Error(added.error.message);
    expect(added.value.scenario.flow3d?.rotation?.rpmMode).toBe("fixed");
  });

  it("renders every field and submits the mapped draft", async () => {
    const submitted = vi.fn<(draft: SimScenarioDraft) => void>();
    render(
      <FanScenarioForm
        motorOptions={[{ value: "mot_fan-demo", label: "fan demo motor" }]}
        onSubmitScenario={submitted}
      />,
    );
    expect(screen.getByLabelText(/scenario name/i)).toBeDefined();
    expect(screen.getByLabelText(/blade count/i)).toBeDefined();
    await waitFor(() => {
      fireEvent.click(screen.getByRole("button", { name: "Save scenario" }));
    });
    await waitFor(() => {
      expect(submitted).toHaveBeenCalledTimes(1);
    });
    const draft = submitted.mock.calls[0]?.[0];
    expect(draft?.kind).toBe("flow");
    expect(draft?.flow3d?.rotation?.kind).toBe("mrf");
  });
});

// ---------------------------------------------------------------------------
// The fan chart's deterministic extraction
// ---------------------------------------------------------------------------

/** A completed motor-driven result carrying the chart family. */
function chartResult(): SimResult {
  return {
    summary: {
      schemaVersion: 1,
      scenarioSnapshotHash: "hash",
      status: "completed",
      regime: { qualitative: ["low-reynolds-fan"] },
      quantities: [
        { name: "operating-speed", value: 4.5, unit: "rad/s" },
        { name: "operating-rpm", value: 43, unit: "Hz" },
        { name: "operating-torque", value: 2e-9, unit: "N*m" },
        { name: "blade-pass-frequency", value: 2.87, unit: "Hz" },
        { name: "airflow", value: 1.5e-5, unit: "m^3/s" },
        { name: "pressure-rise", value: 0.002, unit: "Pa" },
        { name: "fan-reynolds-tip", value: 40, unit: "1" },
        { name: "ladder-min-speed", value: 2, unit: "rad/s" },
        { name: "ladder-max-speed", value: 8, unit: "rad/s" },
      ],
    },
    fields: [],
    histories: [
      { name: "load-torque", unit: "N*m", samples: [1e-9, 2e-9, 3e-9, 4e-9] },
      { name: "motor-torque", unit: "N*m", samples: [3e-9, 2e-9, 1e-9, 0] },
    ],
  };
}

describe("the fan chart extraction", () => {
  it("extracts the curve pair, the found point, and the headline", () => {
    const chart = fanChartOf(chartResult());
    if (chart === null) throw new Error("the chart declined a valid result");
    expect(chart.series.map((series) => series.key)).toEqual(["load", "motor"]);
    expect(chart.ladderMinRadPerS).toBe(2);
    expect(chart.ladderMaxRadPerS).toBe(8);
    expect(chart.operatingOmegaRadPerS).toBe(4.5);
    expect(chart.operatingTorqueNPerM).toBe(2e-9);
    expect(chart.headline.operatingRpm).toBe(43);
    expect(chart.headline.flags).toEqual(["low-reynolds-fan"]);
    // Deterministic: the same result extracts the identical chart.
    expect(fanChartOf(chartResult())).toEqual(chart);
  });

  it("declines results without the motor-driven family", () => {
    const tunnel: SimResult = {
      summary: {
        schemaVersion: 1,
        scenarioSnapshotHash: "hash",
        status: "completed",
        regime: { qualitative: [] },
        quantities: [{ name: "steps", value: 10, unit: "1" }],
      },
      fields: [],
      histories: [],
    };
    expect(fanChartOf(tunnel)).toBeNull();
    const failed = chartResult();
    const failedResult = {
      ...failed,
      summary: { ...failed.summary, status: "failed" as const },
    };
    expect(fanChartOf(failedResult)).toBeNull();
  });

  it("renders the panel with both curves and the operating marker", () => {
    const chart = fanChartOf(chartResult());
    if (chart === null) throw new Error("unreachable: checked above");
    render(<FanChartPanel chart={chart} />);
    const panel = screen.getByTestId("workbench-sim-fan-chart");
    expect(panel.querySelectorAll("polyline[data-series]")).toHaveLength(2);
    expect(
      panel.querySelector('g[data-marker="operating-point"]'),
    ).not.toBeNull();
    expect(
      screen.getByTestId("workbench-sim-fan-chart-headline").textContent,
    ).toContain("43.00 rpm");
  });
});
