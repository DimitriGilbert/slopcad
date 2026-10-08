/**
 * The flow-scenario form's tests (Phase 63c): the Formedible CONFIG
 * OBJECT is the product — every schema key has its field, every option
 * list is the Phase 61 vocabulary, the defaults are the demo tunnel, and
 * the mapper turns submitted values into a cad-core scenario draft the
 * document accepts. The component half (the repo's form-test pattern):
 * rendering mounts every field from the config, and submitting delivers
 * the mapped draft through the surface the page wires.
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
  createDocument,
  createDocumentId,
  serializeSimScenario,
  type SimScenarioDraft,
} from "@slopcad/cad-core";

import {
  FLOW_FORM_DEFAULT_VALUES,
  FlowScenarioForm,
  flowScenarioDraftOf,
  flowScenarioFields,
  flowScenarioSchema,
} from "./flow-scenario-form";

afterEach(cleanup);

describe("the flow-scenario form config", () => {
  it("gives every schema key exactly one field, with the Phase 61 vocabularies", () => {
    const schemaKeys = Object.keys(
      flowScenarioSchema.shape,
    ) as readonly (keyof typeof FLOW_FORM_DEFAULT_VALUES)[];
    const fieldNames = flowScenarioFields.map((field) => field.name);
    expect(new Set(fieldNames).size).toBe(fieldNames.length);
    expect([...fieldNames].sort()).toEqual([...schemaKeys].sort());
    const optionValuesOf = (
      name: keyof typeof FLOW_FORM_DEFAULT_VALUES,
    ): readonly string[] => {
      const field = flowScenarioFields.find((entry) => entry.name === name);
      const options = field?.options;
      // The options union's function form (values-dependent options) is
      // not a static list; only the array form carries the vocabulary.
      if (typeof options !== "object" || options === null) return [];
      return options.map((option) =>
        typeof option === "string" ? option : option.value,
      );
    };
    expect(optionValuesOf("fluid")).toEqual(["air", "water", "glycol"]);
    expect(optionValuesOf("southCondition")).toEqual([
      "no-slip",
      "slip",
      "symmetry",
    ]);
    expect(optionValuesOf("backend")).toEqual(["cpu", "gpu"]);
  });

  it("maps the defaults onto a draft the document's add path accepts, with the snapshot-stable record", () => {
    const draft = flowScenarioDraftOf(FLOW_FORM_DEFAULT_VALUES);
    const added = addDocumentSimulation(
      createDocument(createDocumentId("doc_form_test")),
      draft,
    );
    expect(added.ok).toBe(true);
    if (!added.ok) return;
    const scenario = added.value.scenario;
    expect(scenario.kind).toBe("flow");
    expect(scenario.stepBudget).toBe(FLOW_FORM_DEFAULT_VALUES.stepBudget);
    expect(scenario.gridConvergence).toBe(false);
    expect(scenario.conditions).toHaveLength(3);
    const faces = scenario.conditions.map((condition) => condition.face);
    expect(faces).toEqual(["xMin", "yMin", "yMax"]);
    const inlet = scenario.conditions[0];
    expect(inlet?.kind).toBe("velocity-inlet");
    // The serialized record (what crosses to compile) is canonical and
    // snapshot-stable: serializing twice yields identical bytes.
    const first = JSON.stringify(serializeSimScenario(scenario));
    const second = JSON.stringify(serializeSimScenario(scenario));
    expect(second).toBe(first);
  });

  it("maps the pressure outlet and wall-slip branches", () => {
    const draft = flowScenarioDraftOf({
      ...FLOW_FORM_DEFAULT_VALUES,
      outletKind: "pressure",
      outletPressurePa: 12.5,
      northCondition: "slip",
      southCondition: "symmetry",
    });
    const conditions = draft.conditions ?? [];
    expect(conditions.map((condition) => condition.kind)).toContain(
      "pressure-outlet",
    );
    expect(
      conditions.find((condition) => condition.kind === "pressure-outlet"),
    ).toMatchObject({ pressurePa: 12.5 });
    expect(
      conditions.find((condition) => condition.face === "yMax"),
    ).toMatchObject({ kind: "wall", slip: true });
    expect(
      conditions.find((condition) => condition.face === "yMin"),
    ).toMatchObject({ kind: "symmetry" });
  });
});

describe("the FlowScenarioForm component", () => {
  it("renders from the config and submits the mapped draft", async () => {
    const onSubmitted = vi.fn<(draft: SimScenarioDraft) => void>();
    render(<FlowScenarioForm onSubmitScenario={onSubmitted} />);

    // Every field mounted from the config: its label text is in the
    // tree (a radio group's control is a non-labellable container, so
    // the assertion rides the text, not the label-for linkage).
    for (const field of flowScenarioFields) {
      const label = typeof field.label === "string" ? field.label : "";
      const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      expect(
        screen.getAllByText(new RegExp(`^${escaped}$`, "i")).length,
      ).toBeGreaterThan(0);
    }
    // The default name is editable; submission carries it through.
    const nameField = screen.getByLabelText(/scenario name/i);
    if (!(nameField instanceof HTMLInputElement)) {
      throw new Error("the name field is not a text input");
    }
    fireEvent.change(nameField, { target: { value: "renamed-tunnel" } });
    fireEvent.click(screen.getByRole("button", { name: "Save scenario" }));
    await waitFor(() => expect(onSubmitted).toHaveBeenCalledTimes(1));
    const draft = onSubmitted.mock.calls[0]?.[0];
    expect(draft).toBeDefined();
    if (draft === undefined) return;
    expect(draft.name).toBe("renamed-tunnel");
    expect(draft.kind).toBe("flow");
    expect(draft.stepBudget).toBe(FLOW_FORM_DEFAULT_VALUES.stepBudget);
  });
});
