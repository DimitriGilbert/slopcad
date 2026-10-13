/**
 * The thermal-scenario form's tests (Phase 65c, the flow form's test
 * precedent): the Formedible CONFIG OBJECT is the product — every
 * schema key has its field, every option list is the phase's
 * vocabulary, the defaults are the demo stove, and the mapper turns
 * submitted values into a cad-core scenario draft the document accepts
 * (with the 65c kind-locked thermal stance). The component half: the
 * form renders every field from the config and submitting delivers the
 * mapped draft through the surface the page wires.
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
  parseBodyId,
  serializeSimScenario,
  type BodyId,
  type SimScenarioDraft,
} from "@slopcad/cad-core";

import { simDemoDocument } from "./sim-grid-fixture";
import {
  THERMAL_FORM_DEFAULT_VALUES,
  ThermalScenarioForm,
  thermalScenarioDraftOf,
  thermalScenarioFields,
  thermalScenarioSchema,
} from "./thermal-scenario-form";

/**
 * The demo document the page voxelizes — its plate body is the body
 * the material assignment addresses (the document's own cross-check:
 * an assignment naming no live body declines).
 */
const DEMO_DOCUMENT = simDemoDocument();
const parsedBodyId = parseBodyId(
  DEMO_DOCUMENT.bodies[0]?.id ?? "body_demo_plate",
);
if (!parsedBodyId.ok) {
  throw new Error(
    `The thermal form test's body id fixture is invalid: ${parsedBodyId.error.message}`,
  );
}
const BODY_ID: BodyId = parsedBodyId.value;

afterEach(cleanup);

describe("the thermal-scenario form config", () => {
  it("gives every schema key exactly one field, with the phase vocabularies", () => {
    const schemaKeys = Object.keys(
      thermalScenarioSchema.shape,
    ) as readonly (keyof typeof THERMAL_FORM_DEFAULT_VALUES)[];
    const fieldNames = thermalScenarioFields.map((field) => field.name);
    expect(new Set(fieldNames).size).toBe(fieldNames.length);
    expect([...fieldNames].sort()).toEqual([...schemaKeys].sort());
    const optionValuesOf = (
      name: keyof typeof THERMAL_FORM_DEFAULT_VALUES,
    ): readonly string[] => {
      const field = thermalScenarioFields.find((entry) => entry.name === name);
      const options = field?.options;
      if (typeof options !== "object" || options === null) return [];
      return options.map((option) =>
        typeof option === "string" ? option : option.value,
      );
    };
    expect(optionValuesOf("fluid")).toEqual(["air", "water", "glycol"]);
    expect(optionValuesOf("radiationMode")).toEqual([
      "off",
      "linearized",
      "full",
    ]);
    expect(optionValuesOf("solveMode")).toEqual(["steady", "transient"]);
  });

  it("maps the sealed defaults onto a draft the document accepts, snapshot-stable", () => {
    const draft = thermalScenarioDraftOf(THERMAL_FORM_DEFAULT_VALUES, BODY_ID);
    const added = addDocumentSimulation(DEMO_DOCUMENT, draft);
    expect(added.ok).toBe(true);
    if (!added.ok) return;
    const scenario = added.value.scenario;
    expect(scenario.kind).toBe("thermal");
    expect(scenario.thermal).toBeDefined();
    if (scenario.thermal === undefined) return;
    // The sealed stance: no face conditions (the equilibrium boundary
    // covers every exposed face) and no transient budget.
    expect(scenario.conditions).toHaveLength(0);
    expect(scenario.thermal.solveMode).toBe("steady");
    expect(scenario.thermal.cht).toBe(false);
    expect(scenario.thermal.radiationMode).toBe("linearized");
    expect(scenario.thermal.durationS).toBeUndefined();
    expect(scenario.materials).toHaveLength(1);
    // The serialized record is canonical and snapshot-stable.
    const first = JSON.stringify(serializeSimScenario(scenario));
    const second = JSON.stringify(serializeSimScenario(scenario));
    expect(second).toBe(first);
  });

  it("maps the coupled branch: room walls at ambient plus the transient budget", () => {
    const draft = thermalScenarioDraftOf(
      {
        ...THERMAL_FORM_DEFAULT_VALUES,
        solveMode: "transient",
        cht: true,
        durationS: 120,
        sampleIntervalS: 10,
      },
      BODY_ID,
    );
    const added = addDocumentSimulation(DEMO_DOCUMENT, {
      ...draft,
      name: "stove-coupled",
    });
    expect(added.ok).toBe(true);
    if (!added.ok) return;
    const scenario = added.value.scenario;
    if (scenario.thermal === undefined) return;
    expect(scenario.thermal.cht).toBe(true);
    expect(scenario.thermal.solveMode).toBe("transient");
    expect(scenario.thermal.durationS).toBe(120);
    expect(scenario.thermal.sampleIntervalS).toBe(10);
    // The four lateral walls at the ambient temperature.
    expect(scenario.conditions).toHaveLength(4);
    for (const condition of scenario.conditions) {
      expect(condition.kind).toBe("fixed-temperature");
      if (condition.kind === "fixed-temperature") {
        expect(condition.temperatureK).toBe(
          THERMAL_FORM_DEFAULT_VALUES.initialTemperatureK,
        );
      }
    }
  });
});

describe("the ThermalScenarioForm component", () => {
  it("renders from the config and submits the mapped draft", async () => {
    const onSubmitted = vi.fn<(draft: SimScenarioDraft) => void>();
    render(
      <ThermalScenarioForm bodyId={BODY_ID} onSubmitScenario={onSubmitted} />,
    );

    for (const field of thermalScenarioFields) {
      const label = typeof field.label === "string" ? field.label : "";
      const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      expect(
        screen.getAllByText(new RegExp(`^${escaped}$`, "i")).length,
      ).toBeGreaterThan(0);
    }
    const nameField = screen.getByLabelText(/scenario name/i);
    if (!(nameField instanceof HTMLInputElement)) {
      throw new Error("the name field is not a text input");
    }
    fireEvent.change(nameField, { target: { value: "stove-renamed" } });
    fireEvent.click(
      screen.getByRole("button", { name: "Save thermal scenario" }),
    );
    await waitFor(() => expect(onSubmitted).toHaveBeenCalledTimes(1));
    const draft = onSubmitted.mock.calls[0]?.[0];
    expect(draft).toBeDefined();
    if (draft === undefined) return;
    expect(draft.name).toBe("stove-renamed");
    expect(draft.kind).toBe("thermal");
    expect(draft.thermal?.solveMode).toBe("steady");
    expect(draft.materials?.[0]?.bodyId).toBe(BODY_ID);
  });
});
