/**
 * The dynamics-scenario form's tests (Phase 67c), the fan form's
 * pattern: the Formedible CONFIG OBJECT is the product — every schema
 * key has its field, the option list is the provider vocabulary, the
 * defaults ARE the slider-crank demo, and the mapper turns submitted
 * values into a cad-core scenario draft the document accepts (a
 * `dynamics` stance, kind-locked, the motor selection branded at the
 * boundary, the step-lattice rule restated).
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

import {
  DYNAMICS_FORM_DEFAULT_VALUES,
  DYNAMICS_PROVIDER_OPTIONS,
  DynamicsScenarioForm,
  dynamicsScenarioDraftOf,
  dynamicsScenarioFields,
  dynamicsScenarioSchema,
} from "./dynamics-scenario-form";
import { sliderCrankDemoDocument } from "./slider-crank-demo";

afterEach(cleanup);

describe("the dynamics-scenario form config", () => {
  it("gives every schema key exactly one field, with the provider vocabulary", () => {
    const schemaKeys = Object.keys(
      dynamicsScenarioSchema.shape,
    ) as readonly (keyof typeof DYNAMICS_FORM_DEFAULT_VALUES)[];
    const fields = dynamicsScenarioFields([
      { value: "mot_slider-demo", label: "slider demo motor" },
    ]);
    const fieldNames = fields.map((field) => field.name);
    expect(new Set(fieldNames).size).toBe(fieldNames.length);
    expect([...fieldNames].sort()).toEqual([...schemaKeys].sort());
    const providerField = fields.find((entry) => entry.name === "provider");
    const options = providerField?.options;
    if (typeof options !== "object" || options === null) {
      throw new Error("the provider field carries no options");
    }
    expect(
      options.map((option) =>
        typeof option === "string" ? option : option.value,
      ),
    ).toEqual(DYNAMICS_PROVIDER_OPTIONS.map((option) => option.value));
  });

  it("defaults to the slider-crank demo on the reference kernel", () => {
    expect(DYNAMICS_FORM_DEFAULT_VALUES.name).toBe("slider-crank");
    expect(DYNAMICS_FORM_DEFAULT_VALUES.provider).toBe("reference");
    expect(DYNAMICS_FORM_DEFAULT_VALUES.timeStepS).toBe(0.001);
    expect(DYNAMICS_FORM_DEFAULT_VALUES.durationS).toBe(2);
    expect(DYNAMICS_FORM_DEFAULT_VALUES.sampleIntervalS).toBe(0.04);
  });

  it("maps the defaults onto a draft the demo document accepts", () => {
    const draft = dynamicsScenarioDraftOf(DYNAMICS_FORM_DEFAULT_VALUES);
    expect(draft.kind).toBe("dynamics");
    if (draft.dynamics === undefined) {
      throw new Error("the draft carries no dynamics stance");
    }
    expect(draft.dynamics.provider).toBeUndefined();
    expect(draft.dynamics.motorJointId).toBeDefined();
    const added = addDocumentSimulation(sliderCrankDemoDocument(), draft);
    expect(added.ok).toBe(true);
  });

  it("declines a march off the step lattice", () => {
    expect(() =>
      dynamicsScenarioDraftOf({
        ...DYNAMICS_FORM_DEFAULT_VALUES,
        sampleIntervalS: 0.0331,
      }),
    ).toThrow(/integer multiple/);
  });

  it("brands the MuJoCo opt-in through the draft", () => {
    const draft = dynamicsScenarioDraftOf({
      ...DYNAMICS_FORM_DEFAULT_VALUES,
      provider: "mujoco",
    });
    expect(draft.dynamics?.provider).toBe("mujoco");
  });
});

describe("the dynamics-scenario form render", () => {
  it("submits the mapped draft through the host callback", async () => {
    const submitted: SimScenarioDraft[] = [];
    const onSubmit = vi.fn((draft: SimScenarioDraft) => {
      submitted.push(draft);
    });
    render(
      <DynamicsScenarioForm
        motorOptions={[
          { value: "mot_slider-demo", label: "slider demo motor" },
        ]}
        submitLabel="Save dynamics scenario"
        onSubmitScenario={onSubmit}
      />,
    );
    const button = screen.getByRole("button", {
      name: "Save dynamics scenario",
    });
    expect(button).toBeDefined();
    fireEvent.click(button);
    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledTimes(1);
    });
    expect(submitted[0]?.kind).toBe("dynamics");
  });
});
