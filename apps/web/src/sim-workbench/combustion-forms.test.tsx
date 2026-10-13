/**
 * The combustion forms' tests (Phase 68c, the thermal form's test
 * precedent): the Formedible CONFIG OBJECTS are the product — every
 * schema key has its field, every option list is the phase's
 * vocabulary, the defaults are the two demos (the lit-methane stove
 * and the 0.5 L Otto case with its spark sweep), and the mappers turn
 * submitted values into cad-core scenario drafts the document accepts
 * (with the 68c kind-locked combustion stance). The component half:
 * each form renders every field from its config and submitting
 * delivers the mapped draft through the surface the page wires.
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

import {
  COMBUSTION_ENGINE_DEFAULT_VALUES,
  CombustionEngineForm,
  combustionEngineDraftOf,
  combustionEngineFields,
  combustionEngineSchema,
} from "./combustion-engine-form";
import {
  COMBUSTION_STOVE_DEFAULT_VALUES,
  CombustionStoveForm,
  combustionStoveDraftOf,
  combustionStoveFields,
  combustionStoveSchema,
} from "./combustion-stove-form";
import { simDemoDocument } from "./sim-grid-fixture";

/**
 * The demo document the page voxelizes — its plate body is the body
 * the stove material assignment addresses.
 */
const DEMO_DOCUMENT = simDemoDocument();
const parsedBodyId = parseBodyId(
  DEMO_DOCUMENT.bodies[0]?.id ?? "body_demo_plate",
);
if (!parsedBodyId.ok) {
  throw new Error(
    `The combustion form test's body id fixture is invalid: ${parsedBodyId.error.message}`,
  );
}
const BODY_ID: BodyId = parsedBodyId.value;

afterEach(cleanup);

/** One select field's option values (the thermal form test's reader). */
function optionValuesOf(
  fields: readonly { readonly name: string; readonly options?: unknown }[],
  name: string,
): readonly string[] {
  const field = fields.find((entry) => entry.name === name);
  const options = field?.options;
  if (typeof options !== "object" || options === null) return [];
  const list = options as readonly unknown[];
  return list.map((option) =>
    typeof option === "string"
      ? option
      : String(
          (
            option as {
              readonly value?: unknown;
            }
          ).value,
        ),
  );
}

describe("the combustion stove form config", () => {
  it("gives every schema key exactly one field, with the phase vocabularies", () => {
    const schemaKeys = Object.keys(
      combustionStoveSchema.shape,
    ) as readonly (keyof typeof COMBUSTION_STOVE_DEFAULT_VALUES)[];
    const fieldNames = combustionStoveFields.map((field) => field.name);
    expect(new Set(fieldNames).size).toBe(fieldNames.length);
    expect([...fieldNames].sort()).toEqual([...schemaKeys].sort());
    expect(optionValuesOf(combustionStoveFields, "fuel")).toEqual([
      "CH4",
      "C8H18-ISO",
      "C8H18-N",
    ]);
  });

  it("maps the demo defaults onto a draft the document accepts, snapshot-stable", () => {
    const draft = combustionStoveDraftOf(
      COMBUSTION_STOVE_DEFAULT_VALUES,
      BODY_ID,
    );
    const added = addDocumentSimulation(DEMO_DOCUMENT, draft);
    expect(added.ok).toBe(true);
    if (!added.ok) return;
    const scenario = added.value.scenario;
    expect(scenario.kind).toBe("combustion");
    const stance = scenario.combustion;
    if (stance === undefined || stance.mode !== "stove") {
      throw new Error("the stove stance did not round-trip");
    }
    expect(stance.fuel).toBe("CH4");
    expect(stance.chargeTemperatureK).toBe(1400);
    expect(stance.durationS).toBe(30);
    expect(scenario.conditions).toHaveLength(0);
    expect(scenario.materials).toHaveLength(1);
    const first = JSON.stringify(serializeSimScenario(scenario));
    const second = JSON.stringify(serializeSimScenario(scenario));
    expect(second).toBe(first);
  });
});

describe("the combustion engine form config", () => {
  it("gives every schema key exactly one field, with the phase vocabularies", () => {
    const schemaKeys = Object.keys(
      combustionEngineSchema.shape,
    ) as readonly (keyof typeof COMBUSTION_ENGINE_DEFAULT_VALUES)[];
    const fieldNames = combustionEngineFields.map((field) => field.name);
    expect(new Set(fieldNames).size).toBe(fieldNames.length);
    expect([...fieldNames].sort()).toEqual([...schemaKeys].sort());
    // The engine subset: the fuels with a published flame-speed fit.
    expect(optionValuesOf(combustionEngineFields, "fuel")).toEqual([
      "C8H18-ISO",
      "C8H18-N",
    ]);
  });

  it("maps the demo Otto case onto a draft the document accepts, with the sweep aboard", () => {
    const draft = combustionEngineDraftOf(COMBUSTION_ENGINE_DEFAULT_VALUES);
    const added = addDocumentSimulation(DEMO_DOCUMENT, draft);
    expect(added.ok).toBe(true);
    if (!added.ok) return;
    const scenario = added.value.scenario;
    expect(scenario.kind).toBe("combustion");
    const stance = scenario.combustion;
    if (stance === undefined || stance.mode !== "engine") {
      throw new Error("the engine stance did not round-trip");
    }
    expect(stance.geometry.boreMm).toBe(86);
    expect(stance.geometry.compressionRatio).toBe(10);
    expect(stance.wallHeat.mode).toBe("woschni");
    // The friction default rides as the record's absence (the published
    // correlation, one checkbox away).
    expect(stance.friction).toBeUndefined();
    expect(stance.sweep?.kind).toBe("sparkTiming");
    expect(stance.sweep?.from).toBe(10);
    expect(stance.sweep?.to).toBe(50);
    expect(scenario.conditions).toHaveLength(0);
  });

  it("maps the FMEP override branch when the checkbox is set", () => {
    const draft = combustionEngineDraftOf({
      ...COMBUSTION_ENGINE_DEFAULT_VALUES,
      overrideFmep: true,
      fmepA: 0.5,
    });
    const added = addDocumentSimulation(DEMO_DOCUMENT, draft);
    expect(added.ok).toBe(true);
    if (!added.ok) return;
    const stance = added.value.scenario.combustion;
    if (stance === undefined || stance.mode !== "engine") return;
    expect(stance.friction?.aBar).toBe(0.5);
    expect(stance.friction?.pumpingMepBar).toBe(0.2);
  });

  it("maps the no-sweep branch", () => {
    const draft = combustionEngineDraftOf({
      ...COMBUSTION_ENGINE_DEFAULT_VALUES,
      sweepKind: "none",
    });
    const added = addDocumentSimulation(DEMO_DOCUMENT, draft);
    expect(added.ok).toBe(true);
    if (!added.ok) return;
    const stance = added.value.scenario.combustion;
    if (stance === undefined || stance.mode !== "engine") return;
    expect(stance.sweep).toBeUndefined();
  });
});

describe("the combustion form components", () => {
  it("the stove form renders from the config and submits the mapped draft", async () => {
    const onSubmitted = vi.fn<(draft: SimScenarioDraft) => void>();
    render(
      <CombustionStoveForm bodyId={BODY_ID} onSubmitScenario={onSubmitted} />,
    );
    for (const field of combustionStoveFields) {
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
    fireEvent.change(nameField, { target: { value: "stove-fire-renamed" } });
    fireEvent.click(screen.getByRole("button", { name: "Save fire scenario" }));
    await waitFor(() => expect(onSubmitted).toHaveBeenCalledTimes(1));
    const draft = onSubmitted.mock.calls[0]?.[0];
    expect(draft).toBeDefined();
    if (draft === undefined) return;
    expect(draft.name).toBe("stove-fire-renamed");
    expect(draft.kind).toBe("combustion");
    expect(draft.combustion?.mode).toBe("stove");
  });

  it("the engine form renders from the config and submits the mapped draft", async () => {
    const onSubmitted = vi.fn<(draft: SimScenarioDraft) => void>();
    render(<CombustionEngineForm onSubmitScenario={onSubmitted} />);
    const nameField = screen.getByLabelText(/scenario name/i);
    if (!(nameField instanceof HTMLInputElement)) {
      throw new Error("the name field is not a text input");
    }
    fireEvent.change(nameField, { target: { value: "otto-renamed" } });
    fireEvent.click(
      screen.getByRole("button", { name: "Save engine scenario" }),
    );
    await waitFor(() => expect(onSubmitted).toHaveBeenCalledTimes(1));
    const draft = onSubmitted.mock.calls[0]?.[0];
    expect(draft).toBeDefined();
    if (draft === undefined) return;
    expect(draft.name).toBe("otto-renamed");
    expect(draft.combustion?.mode).toBe("engine");
  });
});
